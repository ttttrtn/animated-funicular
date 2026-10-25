'use strict';
require('dotenv').config();

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const tmi = require('tmi.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');

// Behind Render's proxy req.ip would otherwise be the proxy for everybody,
// which makes the brute-force limiter lock out all users at once.
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
} else if (process.env.RENDER) {
  app.set('trust proxy', 1);
}

// ---------------------------------------------------------------------------
// Auth: password from the environment only. If DASHBOARD_PASS is not set, a
// random one is generated and printed once.
// ---------------------------------------------------------------------------
let DASHBOARD_PASS = process.env.DASHBOARD_PASS;
if (!DASHBOARD_PASS) {
  DASHBOARD_PASS = crypto.randomBytes(9).toString('base64url');
  console.warn(`[Auth] DASHBOARD_PASS not set. Temporary password for this run: ${DASHBOARD_PASS}`);
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

// Simple brute-force limiter for password-protected endpoints.
const AUTH_MAX_FAILS = 10;
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const authFails = new Map(); // ip -> { count, resetAt }

function authBlocked(ip) {
  const f = authFails.get(ip);
  if (!f) return false;
  if (Date.now() > f.resetAt) { authFails.delete(ip); return false; }
  return f.count >= AUTH_MAX_FAILS;
}
function authFailed(ip) {
  if (authFails.size > 2000) {
    const now = Date.now();
    for (const [k, v] of authFails) if (now > v.resetAt) authFails.delete(k);
    if (authFails.size > 2000) authFails.clear();
  }
  const f = authFails.get(ip);
  if (!f || Date.now() > f.resetAt) authFails.set(ip, { count: 1, resetAt: Date.now() + AUTH_WINDOW_MS });
  else f.count += 1;
}

// Small bounded "already seen" set used for de-duplicating chat messages.
function makeSeen(limit) {
  const set = new Set();
  return (id) => {
    if (set.has(id)) return true;
    set.add(id);
    if (set.size > limit) set.delete(set.values().next().value);
    return false;
  };
}

// ---------------------------------------------------------------------------
// Webhooks. These need the RAW request body for signature checking.
// ---------------------------------------------------------------------------
app.post('/webhooks/kick', express.raw({ type: '*/*', limit: '200kb' }), (req, res) => {
  // Add your kick webhook handler here or leave it responsive
  res.sendStatus(200);
});

// ---------------------------------------------------------------------------
// Instagram live chat via Meta webhook
// ---------------------------------------------------------------------------
const IG_VERIFY_TOKEN = process.env.INSTAGRAM_VERIFY_TOKEN || '';
const IG_SECRETS = [process.env.INSTAGRAM_APP_SECRET, process.env.META_APP_SECRET].filter(Boolean);
const igSeen = makeSeen(1000);

app.get('/webhooks/instagram', (req, res) => {
  if (
    IG_VERIFY_TOKEN &&
    req.query['hub.mode'] === 'subscribe' &&
    req.query['hub.verify_token'] === IG_VERIFY_TOKEN
  ) {
    return res.status(200).send(String(req.query['hub.challenge']));
  }
  res.sendStatus(403);
});

app.post('/webhooks/instagram', express.raw({ type: '*/*', limit: '200kb' }), (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const header = String(req.headers['x-hub-signature-256'] || '');
  const ok = IG_SECRETS.some((secret) => {
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
    return header.length === expected.length && crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  });
  if (!ok) return res.sendStatus(403);
  res.sendStatus(200);

  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return; }

  for (const entry of body?.entry || []) {
    const changes = entry.changes || (entry.field ? [{ field: entry.field, value: entry.value }] : []);
    for (const change of changes) {
      if (change.field !== 'live_comments') continue;
      const v = change.value || {};
      const id = v.comment_id || v.id;
      const text = v.text;
      if (!id || !text || igSeen(`instagram-${id}`)) continue;
      const username = v.from?.username || 'instagram';
      try {
        broadcastMessage(normalizeMessage('instagram', username, text, '', `instagram-${id}`));
      } catch (err) {
        console.error('[Instagram Webhook] broadcast failed:', err);
      }
    }
  }
});

// Uploaded channel icon
const ICON_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
let uploadedIcon = null;
app.post('/api/channel-icon', express.raw({ type: [...ICON_TYPES], limit: '1mb' }), (req, res) => {
  const type = String(req.headers['content-type'] || '').split(';')[0];
  if (!ICON_TYPES.has(type) || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Upload a PNG, JPG, WEBP or GIF under 1 MB' });
  uploadedIcon = { buf: req.body, type, v: Date.now() };
  settings.channelIconUrl = `/channel-icon?v=${uploadedIcon.v}`;
  io.emit('settings', settings);
  res.json({ success: true, url: settings.channelIconUrl });
});
app.delete('/api/channel-icon', (_req, res) => { uploadedIcon = null; settings.channelIconUrl = ''; io.emit('settings', settings); res.json({ success: true }); });
app.get('/channel-icon', (_req, res) => {
  if (!uploadedIcon) return res.sendStatus(404);
  res.set({ 'Content-Type': uploadedIcon.type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=31536000' }).send(uploadedIcon.buf);
});

app.use(express.json({ limit: '10kb' }));

// ---------------------------------------------------------------------------
// Dashboard API Endpoints (Fixes the button action response)
// ---------------------------------------------------------------------------
app.post('/api/connect', (req, res) => {
  const { platform, handle } = req.body;
  const p = String(platform || '').toLowerCase();
  if (!PLATFORMS.includes(p)) return res.status(400).json({ error: 'Invalid platform' });

  const adapter = activeAdapters[p];
  if (adapter.process) {
    try { adapter.process.kill(); } catch {}
    adapter.process = null;
  }
  clearTimeout(adapter.retry);

  if (p === 'tiktok') {
    if (!handle) return res.status(400).json({ error: 'Handle required' });
    startBridge('tiktok', 'tiktok_bridge.py', handle);
  } else {
    // Connect handler for other platforms
    updatePlatformStatus(p, 'connected', handle);
  }
  res.json({ success: true });
});

app.post('/api/disconnect', (req, res) => {
  const { platform } = req.body;
  const p = String(platform || '').toLowerCase();
  const adapter = activeAdapters[p];
  if (!adapter) return res.status(400).json({ error: 'Invalid platform' });

  if (adapter.process) {
    try { adapter.process.kill(); } catch {}
    adapter.process = null;
  }
  clearTimeout(adapter.retry);
  updatePlatformStatus(p, 'disconnected', '');
  res.json({ success: true });
});

app.post('/api/settings', (req, res) => {
  Object.assign(settings, req.body);
  io.emit('settings', settings);
  res.json({ success: true });
});

app.post('/api/viewers', (req, res) => {
  const { platform, count } = req.body;
  const p = String(platform || '').toLowerCase();
  const n = Number(count);
  if (isNaN(n) || n <= 0) {
    delete viewerCounts[p];
  } else {
    viewerCounts[p] = n;
  }
  io.emit('viewerCounts', viewerCounts);
  res.json({ success: true });
});

app.get(['/overlay', '/overlay/', '/overlay.html', '/overlay.html/'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'overlay.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// State & Helpers
// ---------------------------------------------------------------------------
const PLATFORMS = ['youtube', 'tiktok', 'twitch', 'kick', 'facebook', 'rumble', 'x', 'instagram'];

const blankAdapter = () => ({
  status: 'disconnected',
  handle: '',
  error: '',
  instance: null,
  process: null,
  client: null,
  timer: null,
  retry: null,
  token: null
});

const activeAdapters = Object.fromEntries(PLATFORMS.map((p) => [p, blankAdapter()]));

const escapeHtml = (v) =>
  String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function safeAvatar(url, platform) {
  const fallback = `/icons/${platform}.svg`;
  if (typeof url !== 'string' || !url) return fallback;
  return /^https:\/\//i.test(url) || /^\/[\w./-]+$/.test(url) ? url : fallback;
}

function cleanBadges(list) {
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, 6)
    .map((b) => {
      const o = typeof b === 'string' ? { type: b } : b;
      if (!o || typeof o !== 'object') return null;
      const type = String(o.type || o.name || 'badge').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30) || 'badge';
      const label = escapeHtml(String(o.label || o.text || o.title || type).slice(0, 40));
      const url = typeof o.url === 'string' && (/^https:\/\//i.test(o.url) || /^\/icons\/(?:[\w-]+\/)*[\w-]+\.(?:svg|png|webp|gif|jpg)$/.test(o.url)) ? o.url : '';
      return { type, label, url };
    })
    .filter(Boolean);
}

function normalizeMessage(platform, username, message, avatar = '', id = null, badges = []) {
  const p = platform.toLowerCase();
  return {
    id: id || `${p}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    platform: p,
    username: escapeHtml(username || 'Anonymous'),
    message: escapeHtml(message || ''),
    avatar: safeAvatar(avatar, p),
    badges: cleanBadges(badges),
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };
}

const settings = { showChannelIcon: false, tiktokEnabled: true, channelIconUrl: '' };
let twitchChannelIcon = '';
const viewerCounts = {};

const RECENT_CHAT_MAX = 60;
const recentChat = [];

function broadcastMessage(msg) {
  if (msg.platform === 'tiktok' && !settings.tiktokEnabled) return;
  if (msg.platform === 'twitch') { const ic = settings.channelIconUrl || twitchChannelIcon; if (ic) msg.channelIcon = ic; }
  io.emit('chatMessage', msg);
  recentChat.push({ id: msg.id, platform: msg.platform, username: msg.username, message: msg.message, at: Date.now() });
  if (recentChat.length > RECENT_CHAT_MAX) recentChat.splice(0, recentChat.length - RECENT_CHAT_MAX);
}

function updatePlatformStatus(platform, status, handle = '', error = '') {
  const a = activeAdapters[platform];
  a.status = status;
  if (handle) a.handle = handle;
  a.error = status === 'error' ? error || handle : '';
  io.emit('statusUpdate', snapshot(platform));
}

function snapshot(platform) {
  const a = activeAdapters[platform];
  return { platform, status: a.status, handle: a.status === 'error' ? a.error : a.handle, error: a.error };
}

// ---------------------------------------------------------------------------
// Python Bridge Runner
// ---------------------------------------------------------------------------
const BRIDGE_MAX_RETRIES = 8;

function startBridge(platform, script, arg, attempt = 0) {
  const label = platform[0].toUpperCase() + platform.slice(1);
  const adapter = activeAdapters[platform];
  clearTimeout(adapter.retry);

  updatePlatformStatus(platform, 'connecting', arg);
  console.log(`[${label}] Spawning Python bridge for "${arg}" (attempt ${attempt + 1})`);

  const proc = spawn(PYTHON_BIN, ['-u', path.join(__dirname, 'python', script), arg], {
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  adapter.process = proc;

  const isCurrent = () => activeAdapters[platform].process === proc;
  let fatal = false;
  let buffer = '';

  const handleLine = (line) => {
    if (!line.trim()) return;
    let p;
    try {
      p = JSON.parse(line);
    } catch {
      return;
    }
    if (!isCurrent()) return;

    switch (p.type) {
      case 'log':
        console.log(`[${label} Bridge] ${p.message}`);
        break;
      case 'status':
        if (p.status === 'connected') attempt = 0;
        updatePlatformStatus(platform, p.status, arg);
        break;
      case 'message':
        try {
          broadcastMessage(normalizeMessage(platform, p.username, p.message, p.avatar || '', p.id, p.badges));
        } catch (err) {
          console.error(`[${label}] broadcast failed:`, err);
        }
        break;
      case 'error':
        if (p.fatal) fatal = true;
        updatePlatformStatus(platform, 'error', arg, p.message);
        break;
    }
  };

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop();
    lines.forEach(handleLine);
  });

  proc.stderr.on('data', (d) => console.error(`[${label} Python Stderr] ${d.toString().trimEnd()}`));

  proc.on('error', (err) => {
    if (isCurrent()) updatePlatformStatus(platform, 'error', arg, `Cannot start Python (${err.code || err.message})`);
  });

  proc.on('close', (code, signal) => {
    if (buffer.trim()) { handleLine(buffer); buffer = ''; }
    if (!isCurrent()) return;

    adapter.process = null;
    if (adapter.status !== 'error') updatePlatformStatus(platform, 'disconnected');

    if (!fatal && attempt < BRIDGE_MAX_RETRIES) {
      const delay = Math.min(2000 * 2 ** attempt, 60000);
      adapter.retry = setTimeout(() => startBridge(platform, script, arg, attempt + 1), delay);
    }
  });
}

// Socket connection initialization for clients
io.on('connection', (socket) => {
  for (const p of PLATFORMS) {
    socket.emit('statusUpdate', snapshot(p));
  }
  socket.emit('settings', settings);
  socket.emit('viewerCounts', viewerCounts);
});

server.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
});
