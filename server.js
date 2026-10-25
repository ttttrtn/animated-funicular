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
// TRUST_PROXY can be a hop count ("1"), or any Express trust-proxy value.
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
const passOk = (given) => safeEqual(given, DASHBOARD_PASS);

// Simple brute-force limiter for the password-protected endpoints.
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
    // Bound memory: drop expired entries first.
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
// Webhooks. These need the RAW request body for signature checking, so they
// must be registered BEFORE the JSON parser below.
// ---------------------------------------------------------------------------
app.post('/webhooks/kick', express.raw({ type: '*/*', limit: '200kb' }), (req, res) => handleKickWebhook(req, res));

// X live chat via the official Activity API (own broadcasts only). Adds
// GET + POST /webhooks/x. The wrapper around broadcastMessage is needed
// because that const is defined further down in this file.
require('./adapters/xwebhook').init({
  app,
  express,
  normalizeMessage,
  makeSeen,
  broadcastMessage: (m) => broadcastMessage(m)
});

// ---------------------------------------------------------------------------
// Instagram live chat via Meta webhook (field: live_comments).
//    env INSTAGRAM_VERIFY_TOKEN = any made-up word (also typed into Meta)
//    env INSTAGRAM_APP_SECRET   = already used for the Instagram login
//    env META_APP_SECRET        = optional, only if Meta signs with a different secret
//    Callback URL in Meta: https://YOUR-HOST/webhooks/instagram
// Comments go through broadcastMessage, so they reach the normal overlay AND
// /api/chat/recent (the Synchra widget).
// ---------------------------------------------------------------------------
const IG_VERIFY_TOKEN = process.env.INSTAGRAM_VERIFY_TOKEN || '';
const IG_SECRETS = [process.env.INSTAGRAM_APP_SECRET, process.env.META_APP_SECRET].filter(Boolean);
const igSeen = makeSeen(1000);

// Meta's "is this really your server?" check
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

// Live comments arrive here
app.post('/webhooks/instagram', express.raw({ type: '*/*', limit: '200kb' }), (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const header = String(req.headers['x-hub-signature-256'] || '');
  const ok = IG_SECRETS.some((secret) => {
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
    return header.length === expected.length && crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  });
  if (!ok) {
    console.warn('[Instagram Webhook] Rejected: bad signature (check INSTAGRAM_APP_SECRET / META_APP_SECRET)');
    return res.sendStatus(403);
  }
  res.sendStatus(200); // answer Meta fast

  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return; }

  for (const entry of body?.entry || []) {
    // Meta uses two slightly different shapes, so both are handled
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

// Uploaded channel icon (kept in memory; raw bytes so it must come before the JSON parser).
const ICON_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
let uploadedIcon = null; // { buf, type, v }
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
app.get(['/overlay', '/overlay/', '/overlay.html', '/overlay.html/'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'overlay.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// State
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const escapeHtml = (v) =>
  String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Only allow http(s) avatars or local icons (blocks javascript:/data: URLs).
function safeAvatar(url, platform) {
  const fallback = `/icons/${platform}.svg`;
  if (typeof url !== 'string' || !url) return fallback;
  return /^https:\/\//i.test(url) || /^\/[\w./-]+$/.test(url) ? url : fallback;
}

// Badges: [{ type, label, url }]. `type` is a lowercase slug the overlay can
// style (broadcaster, owner, moderator, vip, subscriber, member, verified, ...);
// `url` is an https image when the platform provides one, otherwise ''.
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

// Last chat messages from EVERY platform. The Synchra widget reads them from
// GET /api/chat/recent. Usernames and text are stored exactly as broadcast
// (already HTML-escaped by normalizeMessage); the widget decodes them.
const RECENT_CHAT_MAX = 60;
const recentChat = [];

function broadcastMessage(msg) {
  if (msg.platform === 'tiktok' && !settings.tiktokEnabled) return;
  if (msg.platform === 'twitch') { const ic = settings.channelIconUrl || twitchChannelIcon; if (ic) msg.channelIcon = ic; }
  io.emit('chatMessage', msg);
  recentChat.push({ id: msg.id, platform: msg.platform, username: msg.username, message: msg.message, at: Date.now() });
  if (recentChat.length > RECENT_CHAT_MAX) recentChat.splice(0, recentChat.length - RECENT_CHAT_MAX);
}

// For status "error" the message is also sent in `handle` so existing
// dashboards that display `handle` keep working; `error` is the clean field.
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
// Generic Python bridge runner (used by TikTok)
// Bridge protocol: one JSON object per stdout line:
//    {type:'log'|'status'|'message'|'error', ...}
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
      console.log(`[${label} Raw Out] ${line}`);
      return;
    }
    if (!isCurrent()) return;

    switch (p.type) {
      case 'log':
        console.log(`[${label} Bridge] ${p.message}`);
        break;
      case 'status':
        console.log(`[${label} Status] ${p.status} (${p.handle || arg})`);
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
        console.error(`[${label} Error] ${p.message}`);
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
    console.error(`[${label}] Could not start "${PYTHON_BIN}": ${err.message}`);
    if (isCurrent()) updatePlatformStatus(platform, 'error', arg, `Cannot start Python (${err.code || err.message})`);
  });

  proc.on('close', (code, signal) => {
    if (buffer.trim()) { handleLine(buffer); buffer = ''; }
    console.log(`[${label}] Bridge exited (code=${code}, signal=${signal})`);
    if (!isCurrent()) return; // killed by reconnect/disconnect

    adapter.process = null;
    if (adapter.status !== 'error') updatePlatformStatus(platform, 'disconnected');

    if (!fatal && attempt < BRIDGE_MAX_RETRIES) {
      const delay = Math.min(2000 * 2 ** attempt, 60000);
      console.log(`[${label}] Reconnecting in ${delay / 1000}s...`);
      adapter.retry = setTimeout(() => startBridge(platform, script, arg, attempt + 1), delay);
    }
  });
}

// ===========================================================================
// 1. YouTube
//
// Inputs: @handle, channel URL / UC id, watch / live / youtu.be URL, raw id.
//
// Chat transport, tried in this order (each step only runs if the previous
// one failed for a NON-definitive reason such as 403 / consent / timeout):
//   1. "web"       unofficial: public live_chat popout page + InnerTube
//                  live_chat/get_live_chat polling (no API key, no quota).
//   2. "innertube" unofficial: youtubei.js /next + get_live_chat.
//   3. "api"       OFFICIAL: YouTube Data API v3 liveChatMessages.list, only
//                  when YOUTUBE_API_KEY is set. Costs quota (see README note
//                  in the deployment notes): every poll is 5 units.
// ===========================================================================
const YT_API_KEY = process.env.YOUTUBE_API_KEY || '';
const YT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const YT_VIDEO_ID = /^[\w-]{11}$/;
const YT_CHANNEL_ID = /^UC[\w-]{22}$/;
const YT_HANDLE = /^[\p{L}\p{N}._-]{3,30}$/u;
const YT_STREAMS_TAB = 'EgdzdHJlYW1z8gYECgJ6AA%3D%3D';

const ytCfg = { timeScale: 1, maxChatChecks: 8, maxVideoRetries: 5, fetchTimeoutMs: 10000, maxStreams: 5, rescanMs: 90000 };

const YT_PERMANENT = new Set(['NOT_FOUND', 'MEMBERS_ONLY', 'CHAT_DISABLED', 'INVALID_INPUT']);

class YtError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'YtError';
    this.code = code;
    Object.assign(this, extra);
  }
  get permanent() { return YT_PERMANENT.has(this.code); }
}

function ytHttpError(status, what = 'request') {
  const s = Number(status) || 0;
  if (s === 429) return new YtError('RATE_LIMIT', `YouTube rate-limited the ${what} (HTTP 429)`, { status: s });
  if (s === 401 || s === 403) return new YtError('FORBIDDEN', `YouTube refused the ${what} (HTTP ${s}); this server's IP may be blocked`, { status: s });
  if (s === 404 || s === 410) return new YtError('NOT_FOUND', `${what} not found (HTTP ${s})`, { status: s });
  if (s >= 500) return new YtError('SERVER', `YouTube server error on ${what} (HTTP ${s})`, { status: s });
  return new YtError('HTTP', `${what} failed (HTTP ${s})`, { status: s });
}

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

function youTubeTargets(input) {
  const s = String(input || '').trim().slice(0, 300);
  const handle = (h) => ({ type: 'handle', value: h, label: `@${h}` });
  const video = (v) => ({ type: 'video', value: v, label: v });
  const channel = (c) => ({ type: 'channel', value: c, label: c });
  if (!s) return [];

  if (/^https?:\/\//i.test(s) || /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\//i.test(s)) {
    let u;
    try { u = new URL(/^https?:/i.test(s) ? s : `https://${s}`); } catch { return []; }
    const host = u.hostname.toLowerCase().replace(/^(?:www\.|m\.|music\.)/, '');
    if (host === 'youtu.be') {
      const id = u.pathname.slice(1).split('/')[0];
      return YT_VIDEO_ID.test(id) ? [video(id)] : [];
    }
    if (host !== 'youtube.com') return [];
    const v = u.searchParams.get('v');
    if (v && YT_VIDEO_ID.test(v)) return [video(v)];
    let m = u.pathname.match(/^\/(?:live|embed|shorts)\/([\w-]{11})(?:[/?#]|$)/);
    if (m) return [video(m[1])];
    m = u.pathname.match(/^\/@([^/]+)/);
    if (m) { const h = safeDecode(m[1]); return YT_HANDLE.test(h) ? [handle(h)] : []; }
    m = u.pathname.match(/^\/channel\/(UC[\w-]{22})(?:[/?#]|$)/);
    if (m) return [channel(m[1])];
    m = u.pathname.match(/^\/(?:c|user)\/([^/]+)/);
    if (m) { const h = safeDecode(m[1]); return YT_HANDLE.test(h) ? [handle(h)] : []; }
    return [];
  }

  if (s.startsWith('@')) return YT_HANDLE.test(s.slice(1)) ? [handle(s.slice(1))] : [];
  if (YT_CHANNEL_ID.test(s)) return [channel(s)];
  if (YT_VIDEO_ID.test(s)) {
    return /[A-Z_-]/.test(s) ? [video(s), handle(s)] : [handle(s), video(s)];
  }
  if (YT_HANDLE.test(s)) return [handle(s)];
  return [];
}

const ytWebHeaders = (extra = {}) => ({
  'User-Agent': YT_UA,
  'Accept-Language': 'en-US,en;q=0.9',
  Cookie: 'SOCS=CAI; CONSENT=YES+1',
  ...extra
});

async function ytReadCapped(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') return (await res.text()).slice(0, maxBytes);
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    chunks.push(Buffer.from(value));
    if (n > maxBytes) { try { await reader.cancel(); } catch {} break; }
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function ytFetch(url, { method = 'GET', headers = {}, body, timeout = ytCfg.fetchTimeoutMs, maxBytes = 4_000_000, signal } = {}) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeout);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    const text = await ytReadCapped(res, maxBytes);
    return { status: res.status, url: res.url || url, text };
  } catch (err) {
    if (signal?.aborted) throw new YtError('ABORTED', 'aborted');
    if (timedOut) throw new YtError('TIMEOUT', `YouTube request timed out after ${timeout} ms`);
    if (err instanceof YtError) throw err;
    throw new YtError('NETWORK', `Network error: ${err?.cause?.code || err?.message || err}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function ytAbortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new YtError('ABORTED', 'aborted'));
    const onAbort = () => reject(new YtError('ABORTED', 'aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); }
    );
  });
}

async function ytLib(fn, signal) {
  try {
    return await ytAbortable(Promise.resolve().then(fn), signal);
  } catch (err) {
    if (err instanceof YtError) throw err;
    const msg = String(err?.message || err);
    const status = msg.match(/\b(401|403|404|429|5\d\d)\b/)?.[1];
    if (status) { const e = ytHttpError(status, 'youtubei.js request'); e.message += ` (${msg.slice(0, 120)})`; throw e; }
    throw new YtError('NETWORK', `youtubei.js: ${msg.slice(0, 200)}`);
  }
}

let ytClientPromise = null;
function getInnertube(fresh = false) {
  if (fresh) ytClientPromise = null;
  if (!ytClientPromise) {
    ytClientPromise = import('youtubei.js')
      .then((m) => {
        try { m.Log?.setLevel(m.Log.Level.NONE); } catch {}
        return m.Innertube.create({ retrieve_player: false });
      })
      .catch((err) => { ytClientPromise = null; throw err; });
  }
  return ytClientPromise;
}

let ytLibWarnAt = 0;
async function getInnertubeSafe() {
  try {
    return await getInnertube();
  } catch (err) {
    if (Date.now() - ytLibWarnAt > 10 * 60000) {
      ytLibWarnAt = Date.now();
      console.warn(`[YouTube] youtubei.js unavailable, continuing without it: ${err?.message || err}`);
    }
    return null;
  }
}

const ytDeadVideos = new Map();

function ytMarkDead(id, code) {
  const ttl = code === 'REPLAY' ? 30 * 60000 : code === 'NO_CHAT' || code === 'NOT_FOUND' ? 10 * 60000 : 0;
  if (!ttl) return;
  if (ytDeadVideos.size > 300) {
    const now = Date.now();
    for (const [k, v] of ytDeadVideos) if (v < now) ytDeadVideos.delete(k);
    if (ytDeadVideos.size > 300) ytDeadVideos.delete(ytDeadVideos.keys().next().value);
  }
  ytDeadVideos.set(id, Date.now() + ttl * ytCfg.timeScale);
}
function ytIsDead(id) {
  const exp = ytDeadVideos.get(id);
  if (!exp) return false;
  if (exp < Date.now()) { ytDeadVideos.delete(id); return false; }
  return true;
}

function ytBalancedObject(s, start) {
  if (s[start] !== '{') return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  const end = Math.min(s.length, start + 3_000_000);
  for (let i = start; i < end; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

function ytExtractInitialData(html) {
  if (typeof html !== 'string') return null;
  for (const marker of ['window["ytInitialData"]', 'var ytInitialData', 'ytInitialData']) {
    let from = 0;
    for (;;) {
      const i = html.indexOf(marker, from);
      if (i === -1) break;
      from = i + marker.length;
      const eq = html.slice(from, from + 8).match(/^\s*=\s*/);
      if (!eq) continue;
      const json = ytBalancedObject(html, from + eq[0].length);
      if (!json) continue;
      try { return JSON.parse(json); } catch {}
    }
  }
  return null;
}

function ytWalk(root, pick, cap = 60000) {
  const out = [];
  const stack = [root];
  let n = 0;
  while (stack.length && n++ < cap) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) { for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]); continue; }
    const hit = pick(node);
    if (hit) out.push(hit);
    for (const k of Object.keys(node)) stack.push(node[k]);
  }
  return out;
}

const YT_CONT_KINDS = ['invalidationContinuationData', 'timedContinuationData', 'reloadContinuationData', 'liveChatReplayContinuationData'];

function ytExtractContinuation(conts) {
  if (!Array.isArray(conts)) return null;
  for (const kind of YT_CONT_KINDS) {
    for (const c of conts) {
      const d = c?.[kind];
      if (d && typeof d.continuation === 'string' && d.continuation) {
        return { token: d.continuation, wait: Number(d.timeoutMs) || 0, kind };
      }
    }
  }
  return null;
}

function ytText(t) {
  if (!t) return '';
  if (typeof t === 'string') return t;
  if (typeof t.simpleText === 'string') return t.simpleText;
  if (!Array.isArray(t.runs)) return '';
  return t.runs
    .map((r) => {
      if (typeof r?.text === 'string') return r.text;
      const e = r?.emoji;
      if (!e) return '';
      if (e.isCustomEmoji) return e.shortcuts?.[0] || e.image?.accessibility?.accessibilityData?.label || '';
      return e.emojiId || e.shortcuts?.[0] || '';
    })
    .join('');
}

function ytAvatar(photo) {
  const u = photo?.thumbnails?.[0]?.url;
  if (typeof u !== 'string') return '';
  return u.startsWith('//') ? `https:${u}` : u;
}

function ytBadges(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((b) => b?.liveChatAuthorBadgeRenderer)
    .filter(Boolean)
    .map((b) => {
      const icon = String(b.icon?.iconType || '').toLowerCase();
      const thumbs = b.customThumbnail?.thumbnails;
      const url = Array.isArray(thumbs) && thumbs.length ? thumbs[thumbs.length - 1]?.url || '' : '';
      return { type: icon || (url ? 'member' : 'badge'), label: b.tooltip || icon || 'Member', url };
    });
}

function ytItemToEntry(item) {
  if (!item || typeof item !== 'object') return null;
  let r;
  let text = '';
  let author = '';
  let photo;
  let badgeList;

  if ((r = item.liveChatTextMessageRenderer)) {
    text = ytText(r.message);
    if (!text) return null;
  } else if ((r = item.liveChatPaidMessageRenderer)) {
    text = `\u{1F4B0} ${ytText(r.purchaseAmountText)} ${ytText(r.message)}`.trim();
  } else if ((r = item.liveChatPaidStickerRenderer)) {
    text = `\u{1F4B0} ${ytText(r.purchaseAmountText)} [Super Sticker]`.trim();
  } else if ((r = item.liveChatMembershipItemRenderer)) {
    const head = ytText(r.headerSubtext) || ytText(r.headerPrimaryText) || 'New member';
    text = `\u2B50 ${head} ${ytText(r.message)}`.trim();
  } else if ((r = item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer)) {
    const h = r.header?.liveChatSponsorshipsHeaderRenderer || {};
    text = `\u{1F381} ${ytText(h.primaryText) || 'Gifted memberships'}`.trim();
    author = ytText(h.authorName);
    photo = h.authorPhoto;
    badgeList = h.authorBadges;
  } else if ((r = item.liveChatSponsorshipsGiftRedemptionAnnouncementRenderer)) {
    text = `\u{1F381} ${ytText(r.message) || 'Received a gifted membership'}`.trim();
  } else {
    return null;
  }

  author = author || ytText(r.authorName) || 'Viewer';
  photo = photo || r.authorPhoto;
  badgeList = badgeList || r.authorBadges;
  const key = r.id
    ? `youtube-${r.id}`
    : `youtube-${author}-${r.timestampUsec || ''}-${crypto.createHash('sha1').update(text).digest('hex').slice(0, 10)}`;
  return { key, message: normalizeMessage('youtube', author, text, ytAvatar(photo), key, ytBadges(badgeList)) };
}

function ytActionsToEntries(actions) {
  const out = [];
  if (!Array.isArray(actions)) return out;
  for (const a of actions) {
    const item = a?.addChatItemAction?.item
      || a?.replayChatItemAction?.actions?.find?.((x) => x?.addChatItemAction)?.addChatItemAction?.item;
    if (!item) continue;
    try {
      const e = ytItemToEntry(item);
      if (e) out.push(e);
    } catch (err) {
      console.error('[YouTube] Could not parse a chat item:', err?.message || err);
    }
  }
  return out;
}

function ytParseChatResponse(data) {
  if (!data || typeof data !== 'object') throw new YtError('PARSE', 'get_live_chat returned an unexpected payload');
  if (data.error) {
    const e = ytHttpError(Number(data.error.code) || 0, 'get_live_chat');
    if (data.error.message) e.message += `: ${String(data.error.message).slice(0, 120)}`;
    throw e;
  }
  const lcc = data.continuationContents?.liveChatContinuation;
  if (!lcc) return { entries: [], next: null, ended: false, reason: 'no liveChatContinuation' };
  const entries = ytActionsToEntries(lcc.actions);
  const cont = ytExtractContinuation(lcc.continuations);
  const ended = !cont || cont.kind === 'liveChatReplayContinuationData';
  return {
    entries,
    next: cont?.token || null,
    wait: cont?.wait || 1000,
    ended,
    reason: ended ? 'stream ended / replay' : (cont?.kind || 'ok')
  };
}

server.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
});
