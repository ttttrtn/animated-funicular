'use strict';
require('dotenv').config();

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { Server } = require('socket.io');
const { spawn } = require('child_process');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');

if (process.env.TRUST_PROXY) {
  app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
} else if (process.env.RENDER) {
  app.set('trust proxy', 1);
}

// ---------------------------------------------------------------------------
// Auth (HTTP Basic: any username, password = DASHBOARD_PASS)
// ---------------------------------------------------------------------------
let DASHBOARD_PASS = process.env.DASHBOARD_PASS;
if (!DASHBOARD_PASS) {
  DASHBOARD_PASS = crypto.randomBytes(9).toString('base64url');
  console.warn(`[Auth] DASHBOARD_PASS not set. Temporary password for this run: ${DASHBOARD_PASS}`);
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

const AUTH_MAX_FAILS = 10;
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const authFails = new Map();

function authBlocked(ip) {
  const f = authFails.get(ip);
  if (!f) return false;
  if (Date.now() > f.resetAt) { authFails.delete(ip); return false; }
  return f.count >= AUTH_MAX_FAILS;
}
function authFailed(ip) {
  if (authFails.size > 2000) authFails.clear();
  const f = authFails.get(ip);
  if (!f || Date.now() > f.resetAt) authFails.set(ip, { count: 1, resetAt: Date.now() + AUTH_WINDOW_MS });
  else f.count += 1;
}
function requireAuth(req, res, next) {
  if (authBlocked(req.ip)) return res.status(429).send('Too many attempts');
  const [scheme, enc] = String(req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && enc) {
    const pass = Buffer.from(enc, 'base64').toString().split(':').slice(1).join(':');
    if (safeEqual(pass, DASHBOARD_PASS)) return next();
    authFailed(req.ip);
  }
  res.set('WWW-Authenticate', 'Basic realm="Dashboard"').sendStatus(401);
}
// Protected: dashboard page + every /api route. Public: webhook, overlay, icons, static assets.
// Public read-only feed for the stream widget (Synchra runs on another origin).
app.get('/api/chat/recent', (_req, res) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.json(recentChat);
});

app.use((req, res, next) =>
  (req.path.startsWith('/api/') || req.path === '/' || req.path === '/index.html')
    ? requireAuth(req, res, next) : next());

// ---------------------------------------------------------------------------
// State & helpers
// ---------------------------------------------------------------------------
const PLATFORMS = ['instagram', 'soop'];
const activeAdapters = Object.fromEntries(
  PLATFORMS.map((p) => [p, { status: 'disconnected', handle: '', error: '', instance: null, token: null, process: null, retry: null }])
);
const settings = { showChannelIcon: false, channelIconUrl: '' };

function makeSeen(limit) {
  const set = new Set();
  return (id) => {
    if (set.has(id)) return true;
    set.add(id);
    if (set.size > limit) set.delete(set.values().next().value);
    return false;
  };
}

const escapeHtml = (v) =>
  String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function normalizeMessage(platform, username, message, avatar = '', id = null) {
  const p = platform.toLowerCase();
  return {
    id: id || `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    platform: p,
    username: escapeHtml(username || 'Anonymous'),
    message: escapeHtml(message || ''),
    avatar: /^https:\/\//i.test(avatar) ? avatar : `/icons/${p}.svg`,
    badges: [],
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };
}

const RECENT_CHAT_MAX = 60;
const recentChat = [];

function broadcastMessage(msg) {
  const ic = settings.channelIconUrl;
  if (ic) msg.channelIcon = ic;
  io.emit('chatMessage', msg);
  recentChat.push({ id: msg.id, platform: msg.platform, username: msg.username, message: msg.message, at: Date.now() });
  if (recentChat.length > RECENT_CHAT_MAX) recentChat.splice(0, recentChat.length - RECENT_CHAT_MAX);
}

function snapshot(platform) {
  const a = activeAdapters[platform];
  return { platform, status: a.status, handle: a.status === 'error' ? a.error : a.handle, error: a.error };
}

function updatePlatformStatus(platform, status, handle = '', error = '') {
  const a = activeAdapters[platform];
  a.status = status;
  if (handle) a.handle = handle;
  a.error = status === 'error' ? error || handle : '';
  io.emit('statusUpdate', snapshot(platform));
}

function disconnectPlatform(p) {
  const a = activeAdapters[p];
  if (!a) return;
  clearTimeout(a.retry);
  if (a.process) { const proc = a.process; a.process = null; try { proc.kill(); } catch {} }
  if (a.instance?.stop) { try { a.instance.stop(); } catch {} }
  a.instance = null;
  a.token = null;
}

// Runs a Python bridge that prints JSON lines; auto-retries with backoff.
const BRIDGE_MAX_RETRIES = 8;
function startBridge(platform, script, arg, attempt = 0) {
  const a = activeAdapters[platform];
  clearTimeout(a.retry);
  updatePlatformStatus(platform, 'connecting', arg);
  console.log(`[${platform}] starting bridge for "${arg}" (attempt ${attempt + 1})`);

  const proc = spawn(PYTHON_BIN, ['-u', path.join(__dirname, 'python', script), arg], {
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  a.process = proc;
  const isCurrent = () => a.process === proc;
  let fatal = false;
  let buffer = '';

  const handleLine = (line) => {
    let p;
    try { p = JSON.parse(line); } catch { return; }
    if (!isCurrent()) return;
    if (p.type === 'log') console.log(`[${platform} bridge] ${p.message}`);
    else if (p.type === 'status') { if (p.status === 'connected') attempt = 0; updatePlatformStatus(platform, p.status, arg); }
    else if (p.type === 'message') broadcastMessage(normalizeMessage(platform, p.username, p.message, p.avatar || '', p.id || null));
    else if (p.type === 'error') { if (p.fatal) fatal = true; updatePlatformStatus(platform, 'error', arg, p.message); }
  };

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop();
    lines.forEach(handleLine);
  });
  proc.stderr.on('data', (d) => console.error(`[${platform} stderr] ${d.toString().trimEnd()}`));
  proc.on('error', (err) => {
    if (isCurrent()) { fatal = true; updatePlatformStatus(platform, 'error', arg, `Cannot start Python (${err.code || err.message})`); }
  });
  proc.on('close', () => {
    if (buffer.trim()) { handleLine(buffer); buffer = ''; }
    if (!isCurrent()) return;
    a.process = null;
    if (a.status !== 'error') updatePlatformStatus(platform, 'disconnected');
    if (!fatal && attempt < BRIDGE_MAX_RETRIES) {
      a.retry = setTimeout(() => startBridge(platform, script, arg, attempt + 1), Math.min(2000 * 2 ** attempt, 60000));
    }
  });
}

const igSeen = makeSeen(1000); // shared by webhook + poller so nothing shows twice
const instagram = require('./instagram').init({
  activeAdapters, updatePlatformStatus, normalizeMessage, broadcastMessage, disconnectPlatform, seen: igSeen
});

// ---------------------------------------------------------------------------
// Instagram webhook (optional, needs raw body for signature check)
// ---------------------------------------------------------------------------
const IG_VERIFY_TOKEN = process.env.INSTAGRAM_VERIFY_TOKEN || '';
const IG_SECRETS = [process.env.INSTAGRAM_APP_SECRET, process.env.META_APP_SECRET].filter(Boolean);

app.get('/webhooks/instagram', (req, res) => {
  if (IG_VERIFY_TOKEN && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === IG_VERIFY_TOKEN) {
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
      if (!id || !v.text || igSeen(`instagram-${id}`)) continue;
      broadcastMessage(normalizeMessage('instagram', v.from?.username || 'instagram', v.text, '', `instagram-${id}`));
    }
  }
});

// ---------------------------------------------------------------------------
// Channel icon upload
// ---------------------------------------------------------------------------
const ICON_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
let uploadedIcon = null;

app.post('/api/channel-icon', express.raw({ type: [...ICON_TYPES], limit: '1mb' }), (req, res) => {
  const type = String(req.headers['content-type'] || '').split(';')[0];
  if (!ICON_TYPES.has(type) || !Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ error: 'Upload a PNG, JPG, WEBP or GIF under 1 MB' });
  }
  uploadedIcon = { buf: req.body, type, v: Date.now() };
  settings.channelIconUrl = `/channel-icon?v=${uploadedIcon.v}`;
  io.emit('settings', settings);
  res.json({ success: true, url: settings.channelIconUrl });
});
app.delete('/api/channel-icon', (_req, res) => {
  uploadedIcon = null;
  settings.channelIconUrl = '';
  io.emit('settings', settings);
  res.json({ success: true });
});
app.get('/channel-icon', (_req, res) => {
  if (!uploadedIcon) return res.sendStatus(404);
  res.set({ 'Content-Type': uploadedIcon.type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=31536000' })
    .send(uploadedIcon.buf);
});

// ---------------------------------------------------------------------------
// Dashboard API
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '10kb' }));

app.post('/api/connect', (req, res) => {
  const p = String(req.body?.platform || '').toLowerCase();
  if (p === 'instagram') {
    instagram.connectInstagram();
  } else if (p === 'soop') {
    const handle = String(req.body?.handle || '').trim().slice(0, 60);
    if (!/^[\w.-]+$/.test(handle)) return res.status(400).json({ error: 'Enter the SOOP BJ id (letters/numbers)' });
    disconnectPlatform('soop');
    startBridge('soop', 'soop_bridge.py', handle);
  } else {
    return res.status(400).json({ error: 'Unsupported platform' });
  }
  res.json({ success: true });
});

app.post('/api/disconnect', (req, res) => {
  const p = String(req.body?.platform || '').toLowerCase();
  if (!activeAdapters[p]) return res.status(400).json({ error: 'Invalid platform' });
  disconnectPlatform(p);
  updatePlatformStatus(p, 'disconnected', '');
  res.json({ success: true });
});

app.post('/api/settings', (req, res) => {
  const { showChannelIcon } = req.body || {};
  if (typeof showChannelIcon === 'boolean') settings.showChannelIcon = showChannelIcon;
  io.emit('settings', settings);
  res.json({ success: true });
});

const viewerCounts = {};
app.post('/api/viewers', (req, res) => {
  const p = String(req.body?.platform || '').toLowerCase();
  if (!PLATFORMS.includes(p)) return res.status(400).json({ error: 'Invalid platform' });
  const n = Number(req.body?.count);
  if (!Number.isFinite(n) || n <= 0) delete viewerCounts[p];
  else viewerCounts[p] = Math.floor(n);
  io.emit('viewerCounts', viewerCounts);
  res.json({ success: true });
});

app.get(['/overlay', '/overlay/', '/overlay.html', '/overlay.html/'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'overlay.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  for (const p of PLATFORMS) socket.emit('statusUpdate', snapshot(p));
  socket.emit('settings', settings);
  socket.emit('viewerCounts', viewerCounts);
});

server.listen(PORT, () => console.log(`[Server] Running on port ${PORT}`));
