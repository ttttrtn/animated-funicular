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

const broadcastMessage = (msg) => io.emit('chatMessage', msg);

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
//   {type:'log'|'status'|'message'|'error', ...}
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
// The unofficial transports talk to undocumented endpoints. They work today
// but can break whenever YouTube changes its pages; nothing here is a
// guarantee. All parsing is defensive and every failure keeps its real reason.
// ===========================================================================
const YT_API_KEY = process.env.YOUTUBE_API_KEY || ''; // optional, official Data API v3
const YT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const YT_VIDEO_ID = /^[\w-]{11}$/;
const YT_CHANNEL_ID = /^UC[\w-]{22}$/;
const YT_HANDLE = /^[\p{L}\p{N}._-]{3,30}$/u;
const YT_STREAMS_TAB = 'EgdzdHJlYW1z8gYECgJ6AA%3D%3D'; // "streams" tab of a channel

// Tunables (exported through _test so unit tests can shrink the timings).
const ytCfg = { timeScale: 1, maxChatChecks: 5, maxVideoRetries: 5, fetchTimeoutMs: 10000 };

// --- Errors ----------------------------------------------------------------
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

// --- Input parsing ----------------------------------------------------------
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
    // Legacy /c/Name and /user/Name URLs: best effort, treated as a handle.
    m = u.pathname.match(/^\/(?:c|user)\/([^/]+)/);
    if (m) { const h = safeDecode(m[1]); return YT_HANDLE.test(h) ? [handle(h)] : []; }
    return [];
  }

  if (s.startsWith('@')) return YT_HANDLE.test(s.slice(1)) ? [handle(s.slice(1))] : [];
  if (YT_CHANNEL_ID.test(s)) return [channel(s)];
  if (YT_VIDEO_ID.test(s)) {
    // 11 chars can be a video ID or a short handle. Real IDs usually contain A-Z, "-" or "_".
    return /[A-Z_-]/.test(s) ? [video(s), handle(s)] : [handle(s), video(s)];
  }
  if (YT_HANDLE.test(s)) return [handle(s)];
  return [];
}

// --- HTTP -------------------------------------------------------------------
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

// fetch with timeout (covers the body read), size cap and external abort.
// Never throws anything but YtError.
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

// Race a non-abortable promise (youtubei.js calls) against an abort signal.
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

// Wraps youtubei.js errors so they carry a code (HTTP status when present).
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

// youtubei.js is ESM-only, so it has to be imported dynamically. It is an
// OPTIONAL helper: if it is missing or fails to initialise the server still
// works through the plain-HTTP transports.
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
    if (Date.now() - ytLibWarnAt > 10 * 60000) { // warn once per 10 min, not on every retry
      ytLibWarnAt = Date.now();
      console.warn(`[YouTube] youtubei.js unavailable, continuing without it: ${err?.message || err}`);
    }
    return null;
  }
}

// --- Small caches -----------------------------------------------------------
const ytChannelCache = new Map(); // lowercase handle -> { id, exp }
const ytDeadVideos = new Map();   // videoId -> expiry (known ended / not a livestream)

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

// --- Generic JSON helpers ----------------------------------------------------
// Extracts the first balanced {...} object starting at s[start].
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

// Finds `ytInitialData = {...}` in any of the forms YouTube has used.
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
      try { return JSON.parse(json); } catch { /* try next occurrence */ }
    }
  }
  return null;
}

const ytCfgValue = (html, name) => html.match(new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`))?.[1] || '';

// Walks a JSON tree (iteratively, with a node cap) and collects objects for
// which `pick(node)` returns a value.
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

// --- Continuations ----------------------------------------------------------
// Continuation data can sit in several shapes. Prefer the live-polling kinds;
// "reload" is a last resort; the replay kind means the stream is over.
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

function ytFindLiveChatRenderer(data) {
  const direct = data?.contents?.liveChatRenderer
    || data?.contents?.twoColumnWatchNextResults?.conversationBar?.liveChatRenderer;
  if (direct) return direct;
  const found = ytWalk(data?.contents, (n) => n.liveChatRenderer, 20000);
  return found[0] || null;
}

// --- Chat item parsing ------------------------------------------------------
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
      const icon = String(b.icon?.iconType || '').toLowerCase(); // owner | moderator | verified | verified_artist
      const thumbs = b.customThumbnail?.thumbnails;
      const url = Array.isArray(thumbs) && thumbs.length ? thumbs[thumbs.length - 1]?.url || '' : ''; // member badge image
      return { type: icon || (url ? 'member' : 'badge'), label: b.tooltip || icon || 'Member', url };
    });
}

// One chat item -> { key, message } or null. Returns null for item types
// that are not chat messages (banners, placeholders, viewer engagement...).
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

// Parses a get_live_chat response. Throws YtError for error payloads.
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
  const next = ytExtractContinuation(lcc.continuations);
  if (next?.kind === 'liveChatReplayContinuationData') return { entries, next: null, ended: true, reason: 'replay' };
  return { entries, next, ended: false };
}

// --- Chat start: popout page ------------------------------------------------
const inactive = (code, reason) => ({ status: 'inactive', code, reason });

function ytInactiveFromData(data) {
  let blob = '';
  try { blob = JSON.stringify(data?.contents || {}).slice(0, 30000); } catch {}
  if (/members[- ]only|only (?:available to|for) (?:channel )?members/i.test(blob)) return inactive('MEMBERS_ONLY', 'chat is members-only');
  if (/chat is disabled|chat has been (?:turned off|disabled)|chat is turned off|live chat is disabled/i.test(blob)) return inactive('CHAT_DISABLED', 'chat is disabled for this stream');
  if (/video unavailable|private video|has been removed/i.test(blob)) return inactive('NOT_FOUND', 'video unavailable');
  return inactive('NO_CHAT', 'no live chat on this video');
}

// Pure function (easy to unit test): page response -> active/inactive, or throws YtError.
function ytAnalyzeChatPage(page) {
  const { status, url, text } = page;
  const consent = () => new YtError('CONSENT', 'YouTube served a cookie-consent page instead of the chat');
  if (/consent\.(?:youtube|google)\.com/i.test(url || '')) throw consent();
  if (status === 404 || status === 410) return inactive('NOT_FOUND', 'video not found');
  if (status !== 200) throw ytHttpError(status, 'live chat page');

  const data = ytExtractInitialData(text);
  if (!data) {
    if (/action="https:\/\/consent\.youtube\.com|Before you continue to YouTube/i.test(text || '')) throw consent();
    throw new YtError('BAD_RESPONSE', 'live chat page had no chat data (layout changed or blocked page)');
  }
  const lc = ytFindLiveChatRenderer(data);
  if (!lc) return ytInactiveFromData(data);
  if (lc.isReplay) return inactive('REPLAY', 'only a chat replay (stream ended)');
  const next = ytExtractContinuation(lc.continuations);
  if (!next) return inactive('NO_CHAT', 'chat has no continuation (ended or unavailable)');
  if (next.kind === 'liveChatReplayContinuationData') return inactive('REPLAY', 'only a chat replay (stream ended)');

  const apiKey = ytCfgValue(text, 'INNERTUBE_API_KEY');
  const clientVersion = ytCfgValue(text, 'INNERTUBE_CONTEXT_CLIENT_VERSION') || ytCfgValue(text, 'clientVersion');
  if (!apiKey || !clientVersion) throw new YtError('BAD_RESPONSE', 'live chat page is missing the InnerTube key or client version');
  const visitorData = ytCfgValue(text, 'visitorData') || ytCfgValue(text, 'VISITOR_DATA');

  return {
    status: 'active',
    chat: {
      mode: 'web',
      next,
      apiKey,
      clientVersion,
      visitorData,
      seedKeys: ytActionsToEntries(lc.actions).map((e) => e.key)
    }
  };
}

async function ytPopoutStart(videoId, signal) {
  const page = await ytFetch(`https://www.youtube.com/live_chat?is_popout=1&v=${encodeURIComponent(videoId)}`, {
    headers: ytWebHeaders(),
    signal
  });
  return ytAnalyzeChatPage(page);
}

// --- Chat start: youtubei.js fallback ---------------------------------------
async function ytNextStart(yt, videoId, signal) {
  const res = await ytLib(() => yt.actions.execute('/next', { videoId }), signal);
  const data = res?.data || res;
  const lc = ytFindLiveChatRenderer(data);
  if (!lc) return inactive('NO_CHAT', 'no live chat on this video');
  if (lc.isReplay) return inactive('REPLAY', 'only a chat replay (stream ended)');
  const next = ytExtractContinuation(lc.continuations);
  if (!next || next.kind === 'liveChatReplayContinuationData') return inactive('NO_CHAT', 'chat has no continuation');
  return { status: 'active', chat: { mode: 'innertube', next, seedKeys: ytActionsToEntries(lc.actions).map((e) => e.key) } };
}

// --- Official Data API (optional) -------------------------------------------
async function ytApiJson(url, signal) {
  const r = await ytFetch(url, { headers: { 'X-Goog-Api-Key': YT_API_KEY, Accept: 'application/json' }, signal, maxBytes: 2_000_000 });
  let j = {};
  try { j = JSON.parse(r.text); } catch { /* keep {} */ }
  if (r.status >= 400) {
    const reason = String(j?.error?.errors?.[0]?.reason || '');
    let code = 'HTTP';
    if (r.status === 429) code = 'RATE_LIMIT';
    else if (r.status === 403) code = /liveChatEnded/i.test(reason) ? 'ENDED' : /liveChatDisabled/i.test(reason) ? 'CHAT_DISABLED' : /quota|rateLimit|dailyLimit/i.test(reason) ? 'RATE_LIMIT' : 'FORBIDDEN';
    else if (r.status === 404) code = 'NOT_FOUND';
    else if (r.status >= 500) code = 'SERVER';
    throw new YtError(code, `YouTube API ${r.status}${reason ? ` (${reason})` : ''}: ${String(j?.error?.message || 'error').slice(0, 150)}`, { status: r.status });
  }
  return j;
}

async function ytApiStart(videoId, signal) {
  const j = await ytApiJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${encodeURIComponent(videoId)}`, signal);
  const v = j.items?.[0];
  if (!v) return inactive('NOT_FOUND', 'video not found');
  const liveChatId = v.liveStreamingDetails?.activeLiveChatId;
  if (v.snippet?.liveBroadcastContent !== 'live' || !liveChatId) {
    return inactive(v.liveStreamingDetails?.actualEndTime ? 'REPLAY' : 'NO_CHAT', 'video is not live or has no active chat');
  }
  return { status: 'active', chat: { mode: 'api', liveChatId, next: { token: '', wait: 5000, kind: 'api' }, minWait: 5000, maxWait: 30000, seedKeys: [] } };
}

function ytApiItemToEntry(it) {
  const sn = it?.snippet;
  const au = it?.authorDetails || {};
  if (!sn || !it.id) return null;
  let text = '';
  switch (sn.type) {
    case 'textMessageEvent': text = sn.textMessageDetails?.messageText || sn.displayMessage || ''; if (!text) return null; break;
    case 'superChatEvent': text = `\u{1F4B0} ${sn.superChatDetails?.amountDisplayString || ''} ${sn.superChatDetails?.userComment || ''}`.trim(); break;
    case 'superStickerEvent': text = `\u{1F4B0} ${sn.superStickerDetails?.amountDisplayString || ''} [Super Sticker]`.trim(); break;
    case 'newSponsorEvent': text = '\u2B50 New member'; break;
    case 'memberMilestoneChatEvent': text = `\u2B50 ${sn.memberMilestoneChatDetails?.memberLevelName || 'Member'} ${sn.memberMilestoneChatDetails?.userComment || ''}`.trim(); break;
    case 'membershipGiftingEvent': text = `\u{1F381} Gifted ${sn.membershipGiftingDetails?.giftMembershipsCount || ''} memberships`.replace(/\s+/g, ' ').trim(); break;
    case 'giftMembershipReceivedEvent': text = '\u{1F381} Received a gifted membership'; break;
    default: return null;
  }
  const badges = [];
  if (au.isChatOwner) badges.push({ type: 'owner', label: 'Owner', url: '' });
  if (au.isChatModerator) badges.push({ type: 'moderator', label: 'Moderator', url: '' });
  if (au.isChatSponsor) badges.push({ type: 'member', label: 'Member', url: '' });
  if (au.isVerified) badges.push({ type: 'verified', label: 'Verified', url: '' });
  const key = `youtube-${it.id}`;
  return { key, message: normalizeMessage('youtube', au.displayName || 'Viewer', text, au.profileImageUrl || '', key, badges) };
}

async function ytPollApi(chat, signal) {
  const q = new URLSearchParams({ liveChatId: chat.liveChatId, part: 'snippet,authorDetails', maxResults: '200' });
  if (chat.next.token) q.set('pageToken', chat.next.token);
  const j = await ytApiJson(`https://www.googleapis.com/youtube/v3/liveChat/messages?${q}`, signal);
  const entries = (j.items || []).map((it) => { try { return ytApiItemToEntry(it); } catch { return null; } }).filter(Boolean);
  const next = typeof j.nextPageToken === 'string' && j.nextPageToken
    ? { token: j.nextPageToken, wait: Number(j.pollingIntervalMillis) || 5000, kind: 'api' }
    : null;
  return { entries, next, ended: false };
}

// --- Chat polling over the web / innertube transports -----------------------
async function ytPollWeb(chat, signal) {
  const client = { clientName: 'WEB', clientVersion: chat.clientVersion, hl: 'en', gl: 'US' };
  if (chat.visitorData) client.visitorData = chat.visitorData;
  const r = await ytFetch(`https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${encodeURIComponent(chat.apiKey)}&prettyPrint=false`, {
    method: 'POST',
    headers: ytWebHeaders({
      'Content-Type': 'application/json',
      Origin: 'https://www.youtube.com',
      'X-Youtube-Client-Name': '1',
      'X-Youtube-Client-Version': chat.clientVersion
    }),
    body: JSON.stringify({ context: { client }, continuation: chat.next.token }),
    signal,
    maxBytes: 2_000_000
  });
  if (r.status !== 200) {
    const e = ytHttpError(r.status, 'get_live_chat');
    try { const m = JSON.parse(r.text)?.error?.message; if (m) e.message += `: ${String(m).slice(0, 120)}`; } catch {}
    throw e;
  }
  let data;
  try { data = JSON.parse(r.text); } catch { throw new YtError('PARSE', 'get_live_chat returned invalid JSON'); }
  return ytParseChatResponse(data);
}

const makeYtPollFn = (yt) => async (chat, signal) => {
  if (chat.mode === 'api') return ytPollApi(chat, signal);
  if (chat.mode === 'innertube' && yt) {
    const res = await ytLib(() => yt.actions.execute('/live_chat/get_live_chat', { continuation: chat.next.token }), signal);
    return ytParseChatResponse(res?.data || res);
  }
  return ytPollWeb(chat, signal);
};

// Tries every transport. Returns {status:'active', chat} or {status:'inactive', code, reason};
// throws YtError when no transport could give a definitive answer.
async function ytChatStart(videoId, { yt = null, signal } = {}) {
  const errs = [];
  const note = (label, e) => {
    if (e?.code === 'ABORTED') throw e;
    errs.push(e);
    console.error(`[YouTube] ${label} failed for ${videoId}: ${e?.message || e}`);
  };
  try { return await ytPopoutStart(videoId, signal); } catch (e) { note('Popout chat page', e); }
  if (yt) {
    try { return await ytNextStart(yt, videoId, signal); } catch (e) { note('youtubei.js /next', e); }
  }
  if (YT_API_KEY) {
    try { return await ytApiStart(videoId, signal); } catch (e) { note('Data API', e); }
  }
  const first = errs[0] || new YtError('NETWORK', 'no chat transport available');
  throw new YtError(first.code, errs.map((e) => e?.message || e).join(' | '), { status: first.status });
}

function ytInactiveError(s) {
  const code = s.code === 'REPLAY' ? 'NOT_LIVE' : s.code;
  const msg = {
    MEMBERS_ONLY: 'This live chat is members-only',
    CHAT_DISABLED: 'Live chat is disabled for this stream',
    NOT_FOUND: 'YouTube video not found',
    NOT_LIVE: 'That video is not live (ended, or only a chat replay)',
    NO_CHAT: 'That video has no live chat right now'
  }[code] || s.reason || 'No live chat';
  return new YtError(code, msg);
}

// --- Poller -----------------------------------------------------------------
// One polling loop per instance: single timer, single in-flight request,
// idempotent start(), stop() aborts the in-flight request and the timer.
function createYtPoller({ chat, pollFn, onEntries, onEnd, seen, maxFailures = 6, log = console }) {
  let stopped = false;
  let running = false;
  let started = false;
  let timer = null;
  let ctrl = null;
  let firstPoll = true; // the first response is the backlog: remember it, do not replay it
  let failures = 0;
  let missing = 0;
  const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

  for (const k of chat.seedKeys || []) seen(k);

  const schedule = (ms) => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(tick, Math.max(0, Math.round(ms * ytCfg.timeScale)));
  };
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    try { ctrl?.abort(); } catch {}
  };
  const end = (reason, err, definitive) => {
    if (stopped) return;
    stop();
    onEnd({ reason, err, definitive });
  };

  async function tick() {
    if (stopped || running) return;
    running = true;
    ctrl = new AbortController();
    let delay = 2000;
    try {
      const r = await pollFn(chat, ctrl.signal);
      if (stopped) return;
      failures = 0;

      const fresh = [];
      for (const e of r?.entries || []) {
        if (e && !seen(e.key)) fresh.push(e.message);
      }
      if (!firstPoll && fresh.length) onEntries(fresh.slice(-100));
      firstPoll = false;

      if (r?.ended) return end('Stream ended', null, true);
      if (r?.next && typeof r.next.token === 'string' && r.next.token) {
        missing = 0;
        chat.next = r.next;
        delay = clamp(Number(r.next.wait) || 2000, chat.minWait ?? 1000, chat.maxWait ?? 10000);
      } else {
        // No continuation: retry the same token a couple of times before deciding the chat is over.
        missing += 1;
        log.warn?.(`[YouTube] Response had no continuation (${missing}/3)`);
        if (missing >= 3) return end('Stream ended', null, true);
        delay = 2000 * missing;
      }
    } catch (err) {
      if (stopped || err?.code === 'ABORTED') return;
      failures += 1;
      log.error?.(`[YouTube] Chat poll failed (${failures}/${maxFailures}): ${err?.message || err}`);
      if (err?.code === 'ENDED') return end('Stream ended', null, true);
      if (err?.permanent) return end(err.message, err, false);
      if (failures >= maxFailures) return end('Chat error', err, false);
      delay = err?.code === 'RATE_LIMIT' || err?.code === 'FORBIDDEN'
        ? Math.min(15000 * failures, 60000)
        : Math.min(2000 * 2 ** (failures - 1), 30000);
    } finally {
      running = false;
    }
    schedule(delay);
  }

  return {
    start() { if (started) return; started = true; tick(); },
    stop,
    get stopped() { return stopped; }
  };
}

// --- Discovering the live video of a channel --------------------------------
function ytRetryDelay(attempt, code) {
  let base;
  if (code === 'RATE_LIMIT' || code === 'FORBIDDEN' || code === 'CONSENT') base = Math.min(60000 * (attempt + 1), 300000);
  else if (code === 'NOT_LIVE') base = [30000, 30000, 45000, 60000][Math.min(attempt, 3)];
  else base = Math.min(10000 * 2 ** attempt, 120000);
  return Math.round(base * (0.9 + Math.random() * 0.2));
}

async function ytChannelIdFromHandle(yt, handle, signal) {
  const key = handle.toLowerCase();
  const hit = ytChannelCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.id;
  let id = null;
  if (yt) {
    try {
      const ep = await ytLib(() => yt.resolveURL(`https://www.youtube.com/@${handle}`), signal);
      id = ep?.payload?.browseId || null;
    } catch (e) { if (e.code === 'ABORTED') throw e; }
  }
  if (!id || !YT_CHANNEL_ID.test(id)) {
    id = null;
    try {
      const p = await ytFetch(`https://www.youtube.com/@${encodeURIComponent(handle)}`, { headers: ytWebHeaders(), signal });
      // Prefer the page's own identity fields over generic "browseId" hits,
      // which can belong to recommended channels.
      id = p.text.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)?.[1]
        || p.text.match(/itemprop="(?:channelId|identifier)" content="(UC[\w-]{22})"/)?.[1]
        || p.text.match(/"externalId":"(UC[\w-]{22})"/)?.[1]
        || p.text.match(/"channelId":"(UC[\w-]{22})"/)?.[1]
        || null;
    } catch (e) { if (e.code === 'ABORTED') throw e; }
  }
  if (id) {
    if (ytChannelCache.size > 50) ytChannelCache.delete(ytChannelCache.keys().next().value);
    ytChannelCache.set(key, { id, exp: Date.now() + 6 * 3600000 });
  }
  return id;
}

// <channel>/live redirects to the current stream when there is one.
async function ytLivePage(pathPart, signal) {
  const p = await ytFetch(`https://www.youtube.com/${pathPart}/live`, { headers: ytWebHeaders(), signal });
  if (/consent\.(?:youtube|google)\.com/i.test(p.url)) throw new YtError('CONSENT', 'YouTube served a cookie-consent page for the /live check');
  if (p.status === 404) throw new YtError('NOT_FOUND', 'YouTube channel not found');
  if (p.status !== 200) throw ytHttpError(p.status, '/live page');
  const id = p.url.match(/[?&]v=([\w-]{11})/)?.[1]
    || p.text.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/)?.[1]
    || null;
  let confirmed = false;
  if (id) {
    const i = p.text.indexOf(`"videoDetails":{"videoId":"${id}"`);
    if (i !== -1) confirmed = /"isLive(?:Now)?":true/.test(p.text.slice(i, i + 4000));
  }
  console.log(`[YouTube] /live page ${pathPart}: HTTP ${p.status}, ${p.text.length} bytes, video ${id || 'none'}${confirmed ? ' (live)' : ''}`);
  return { id, confirmed };
}

// Structural walk of a browse response instead of regexing around ids.
function ytCollectVideos(root) {
  const seen = new Set();
  const list = [];
  ytWalk(root, (n) => {
    let id = null;
    let live = false;
    if (typeof n.videoId === 'string' && (n.thumbnailOverlays || n.badges || n.title)) {
      id = n.videoId;
      live = /BADGE_STYLE_TYPE_LIVE_NOW|"style":"LIVE"|LIVE_NOW/.test(JSON.stringify([n.badges, n.thumbnailOverlays]));
    } else if (typeof n.contentId === 'string' && n.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
      id = n.contentId;
      live = /LIVE_NOW|"text":"LIVE"|"style":"LIVE"/i.test(JSON.stringify(n.contentImage || {}));
    }
    if (id && YT_VIDEO_ID.test(id) && !seen.has(id)) { seen.add(id); list.push({ id, live }); }
    return null;
  });
  return list;
}

async function ytStreamsTabIds(yt, channelId, signal) {
  if (!yt) return [];
  const res = await ytLib(() => yt.actions.execute('/browse', { browseId: channelId, params: YT_STREAMS_TAB }), signal);
  const vids = ytCollectVideos(res?.data || res);
  console.log(`[YouTube] Streams tab ${channelId}: ${vids.length} video(s), ${vids.filter((v) => v.live).length} flagged live`);
  return [...vids.filter((v) => v.live), ...vids.filter((v) => !v.live)].slice(0, 6);
}

async function ytInnertubeChannelIds(yt, channelId, signal) {
  if (!yt) return [];
  const channel = await ytLib(() => yt.getChannel(channelId), signal);
  const out = [];
  const idOf = (v) => v?.video_id || v?.id || v?.content_id;
  const isLive = (v) => v?.is_live === true || (v?.badges || []).some?.((b) => /LIVE_NOW/i.test(String(b?.style || b?.label || '')));
  for (const v of channel.videos || []) if (isLive(v) && YT_VIDEO_ID.test(String(idOf(v)))) out.push({ id: idOf(v), live: true });
  if (channel.has_live_streams) {
    const vids = (await ytLib(() => channel.getLiveStreams(), signal)).videos || [];
    for (const v of vids.slice(0, 6)) if (YT_VIDEO_ID.test(String(idOf(v)))) out.push({ id: idOf(v), live: isLive(v) });
  }
  console.log(`[YouTube] Innertube channel ${channelId}: ${out.length} candidate(s)`);
  return out.sort((a, b) => Number(b.live) - Number(a.live));
}

// RSS feed lists a channel's newest uploads and streams.
async function ytFeedVideoIds(channelId, signal) {
  const r = await ytFetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal,
    maxBytes: 500_000
  });
  if (r.status !== 200) throw ytHttpError(r.status, 'RSS feed');
  const ids = [...r.text.matchAll(/<yt:videoId>([\w-]{11})<\/yt:videoId>/g)].map((m) => m[1]).slice(0, 5);
  console.log(`[YouTube] RSS feed ${channelId}: ${ids.length} video(s)`);
  return ids;
}

// Optional official API: 2 quota units per check. The key travels in a
// header so it never appears in URLs or error messages.
async function ytApiLiveIds(channelId, signal) {
  if (!YT_API_KEY || !YT_CHANNEL_ID.test(channelId)) return [];
  const pl = await ytApiJson(`https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=8&playlistId=UU${channelId.slice(2)}`, signal);
  const ids = (pl.items || []).map((i) => i.contentDetails?.videoId).filter((x) => YT_VIDEO_ID.test(String(x)));
  if (!ids.length) return [];
  const v = await ytApiJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${ids.join(',')}`, signal);
  const live = (v.items || []).filter((x) => x.snippet?.liveBroadcastContent === 'live').map((x) => x.id);
  console.log(`[YouTube] Data API ${channelId}: ${ids.length} recent upload(s), ${live.length} live`);
  return live;
}

// Staged discovery: cheap, most reliable sources first; later (heavier)
// stages only run if earlier ones produced no verified live chat. At most
// ytCfg.maxChatChecks chat pages are downloaded per discovery run.
// Returns { videoId, chat } or throws YtError.
async function ytFindLive(yt, t, signal) {
  const tried = new Set();
  let checks = 0;
  let lastErr = null;
  let blockedErr = null;
  let sawData = false;
  let channelId = t.type === 'channel' ? t.value : null;
  let channelResolved = t.type === 'channel';
  const pathPart = t.type === 'handle' ? `@${encodeURIComponent(t.value)}` : `channel/${t.value}`;

  const getChannelId = async () => {
    if (!channelResolved) {
      channelId = await ytChannelIdFromHandle(yt, t.value, signal);
      channelResolved = true;
      console.log(`[YouTube] ${t.label}: channel id ${channelId || 'NOT RESOLVED'}`);
    }
    return channelId;
  };

  const verify = async (cands) => {
    for (const c of cands) {
      if (!YT_VIDEO_ID.test(String(c.id)) || tried.has(c.id) || ytIsDead(c.id)) continue;
      if (checks >= ytCfg.maxChatChecks) return null;
      tried.add(c.id);
      checks += 1;
      try {
        const s = await ytChatStart(c.id, { yt, signal });
        sawData = true;
        if (s.status === 'active') {
          console.log(`[YouTube] ${t.label}: active live chat on ${c.id} via ${c.src} (${s.chat.mode})`);
          return { videoId: c.id, chat: s.chat };
        }
        ytMarkDead(c.id, s.code);
        if (s.code === 'MEMBERS_ONLY' || s.code === 'CHAT_DISABLED') blockedErr = ytInactiveError(s);
      } catch (e) {
        if (e.code === 'ABORTED') throw e;
        lastErr = e;
        // Blocked / rate-limited / consent affects every candidate equally: stop hammering.
        if (['RATE_LIMIT', 'FORBIDDEN', 'CONSENT'].includes(e.code)) throw e;
      }
    }
    return null;
  };

  const stages = [
    async () => {
      const r = await ytLivePage(pathPart, signal);
      sawData = true;
      return r.id ? [{ id: r.id, src: '/live page', live: r.confirmed }] : [];
    },
    async () => ((await getChannelId()) ? (await ytApiLiveIds(channelId, signal)).map((id) => ({ id, src: 'Data API' })) : []),
    async () => ((await getChannelId()) ? (await ytStreamsTabIds(yt, channelId, signal)).map((v) => ({ id: v.id, src: 'streams tab', live: v.live })) : []),
    async () => ((await getChannelId()) ? (await ytInnertubeChannelIds(yt, channelId, signal)).map((v) => ({ id: v.id, src: 'Innertube channel', live: v.live })) : []),
    async () => ((await getChannelId()) ? (await ytFeedVideoIds(channelId, signal)).map((id) => ({ id, src: 'RSS feed' })) : [])
  ];

  for (const stage of stages) {
    let cands = [];
    try {
      cands = await stage();
    } catch (e) {
      if (e.code === 'ABORTED' || e.code === 'NOT_FOUND') throw e;
      lastErr = e;
      console.error(`[YouTube] ${t.label}: discovery step failed: ${e?.message || e}`);
    }
    // Confirmed-live candidates are verified first.
    cands.sort((a, b) => Number(!!b.live) - Number(!!a.live));
    const found = await verify(cands);
    if (found) return found;
    if (checks >= ytCfg.maxChatChecks) break;
  }

  if (blockedErr) throw blockedErr;
  if (!sawData && lastErr) throw lastErr; // show the real reason (e.g. 403) instead of "not live"
  throw new YtError('NOT_LIVE', `${t.label} is not live right now`);
}

async function ytStartVideo(yt, videoId, signal) {
  const s = await ytChatStart(videoId, { yt, signal });
  if (s.status === 'active') return { videoId, chat: s.chat };
  ytMarkDead(videoId, s.code);
  throw ytInactiveError(s);
}

// --- Connection lifecycle ---------------------------------------------------
async function connectYouTube(input) {
  disconnectPlatform('youtube'); // stops the previous session, timers and in-flight requests
  const targets = youTubeTargets(input);
  if (!targets.length) {
    return updatePlatformStatus('youtube', 'error', String(input).slice(0, 80), 'Use a @handle, channel URL, or video URL/ID');
  }
  const token = Symbol('yt');
  const session = {
    ctrl: new AbortController(),
    poller: null,
    stop() { this.ctrl.abort(); this.poller?.stop(); }
  };
  const a = activeAdapters.youtube;
  a.token = token;
  a.instance = session;
  const label = targets[0].label;
  console.log(`[YouTube] Connecting: ${targets.map((t) => `${t.type}:${t.value}`).join(', ')}`);
  updatePlatformStatus('youtube', 'connecting', label);
  const ctx = { targets, token, label, session, attempt: 0, watching: targets.some((t) => t.type !== 'video') };
  runYouTube(ctx).catch((err) => {
    console.error('[YouTube] Unexpected failure:', err);
    if (activeAdapters.youtube.token === token) updatePlatformStatus('youtube', 'error', label, String(err?.message || err));
  });
}

const YT_RANK = { NOT_LIVE: 6, NETWORK: 5, TIMEOUT: 5, SERVER: 5, RATE_LIMIT: 5, FORBIDDEN: 5, CONSENT: 5, BAD_RESPONSE: 5, MEMBERS_ONLY: 4, CHAT_DISABLED: 4, NO_CHAT: 3, NOT_FOUND: 1 };
const bestYtError = (errs) => errs.slice().sort((a, b) => (YT_RANK[b.code] || 2) - (YT_RANK[a.code] || 2))[0];

async function runYouTube(ctx) {
  const { targets, token, label, session, watching } = ctx;
  const adapter = () => activeAdapters.youtube;
  const current = () => adapter().token === token && !session.ctrl.signal.aborted;

  const fail = (msg) => {
    console.error(`[YouTube] ${msg}`);
    if (!current()) return;
    session.stop();
    updatePlatformStatus('youtube', 'error', label, msg);
  };

  const retryLater = (err) => {
    if (!current()) return;
    const code = err?.code || 'NOT_LIVE';
    const why = String(err?.message || 'Not live');
    ctx.attempt += 1;
    if (!watching && ctx.attempt > ytCfg.maxVideoRetries) return fail(why);
    const blocked = code === 'MEMBERS_ONLY' || code === 'CHAT_DISABLED';
    const delay = Math.round((blocked ? 300000 : ytRetryDelay(ctx.attempt - 1, code)) * ytCfg.timeScale);
    console.log(`[YouTube] ${why}. Checking again in ${Math.round(delay / 1000)}s`);
    if (blocked || code === 'FORBIDDEN' || code === 'RATE_LIMIT' || code === 'CONSENT') {
      updatePlatformStatus('youtube', 'error', label, why);
    } else {
      updatePlatformStatus('youtube', 'connecting', `${label} (${why.slice(0, 80)})`);
    }
    clearTimeout(adapter().retry);
    adapter().retry = setTimeout(() => {
      runYouTube(ctx).catch((e) => console.error('[YouTube] Retry crashed:', e));
    }, delay);
  };

  const handleFailure = (err) => {
    if (err?.code === 'ABORTED' || !current()) return;
    if (watching) {
      // A typo'd handle will never work; everything else is worth retrying.
      if (err.code === 'NOT_FOUND' && targets.every((t) => t.type !== 'video')) return fail(err.message);
      return retryLater(err);
    }
    if (err.permanent || err.code === 'NOT_LIVE' || err.code === 'NO_CHAT') return fail(err.message);
    return retryLater(err); // transient (network, 403, 5xx...): bounded retries
  };

  try {
    const yt = await getInnertubeSafe();
    if (!current()) return;

    let found = null;
    const errs = [];
    for (const t of targets) {
      try {
        found = t.type === 'video' ? await ytStartVideo(yt, t.value, session.ctrl.signal) : await ytFindLive(yt, t, session.ctrl.signal);
        if (found) break;
      } catch (e) {
        if (e?.code === 'ABORTED') return;
        errs.push(e instanceof YtError ? e : new YtError('NETWORK', String(e?.message || e)));
      }
    }
    if (!current()) return;
    if (!found) return handleFailure(bestYtError(errs) || new YtError('NOT_LIVE', `${label} is not live right now`));

    const seen = makeSeen(1500);
    const poller = createYtPoller({
      chat: found.chat,
      pollFn: makeYtPollFn(yt),
      seen,
      onEntries: (msgs) => {
        if (!current()) return; // an older connection must never broadcast
        for (const m of msgs) {
          try { broadcastMessage(m); } catch (err) { console.error('[YouTube] broadcast failed:', err); }
        }
      },
      onEnd: ({ reason, err, definitive }) => {
        if (!current()) return;
        session.poller = null;
        if (definitive) ytMarkDead(found.videoId, 'REPLAY');
        console.log(`[YouTube] Chat of ${found.videoId} stopped: ${reason}`);
        if (watching) return retryLater(err instanceof YtError ? err : new YtError('NOT_LIVE', reason));
        if (err) return fail(String(err?.message || err));
        updatePlatformStatus('youtube', 'disconnected');
      }
    });
    session.poller = poller;
    ctx.attempt = 0;
    console.log(`[YouTube] Connected to live chat of video ${found.videoId} (${found.chat.mode})`);
    updatePlatformStatus('youtube', 'connected', label);
    poller.start();
  } catch (err) {
    if (err?.code === 'ABORTED') return;
    console.error('[YouTube] Connect failed:', err?.message || err);
    ytClientPromise = null;
    handleFailure(err instanceof YtError ? err : new YtError('NETWORK', String(err?.message || err)));
  }
}

// ---------------------------------------------------------------------------
// 2. TikTok (Python bridge)
// ---------------------------------------------------------------------------
function connectTikTok(username) {
  disconnectPlatform('tiktok');
  const user = String(username || '').replace(/^@/, '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._]{0,39}$/.test(user)) {
    return updatePlatformStatus('tiktok', 'error', String(username), 'Invalid TikTok username');
  }
  startBridge('tiktok', 'tiktok_bridge.py', user);
}

// ---------------------------------------------------------------------------
// 3. Twitch
//
// Badge images: the old https://badges.twitch.tv endpoint was permanently shut
// down (June 2023). Badge images now come from Helix (Get Global / Channel Chat
// Badges), which needs an app access token:
//     env TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET   (dev.twitch.tv/console)
// Without those, the community IVR API (api.ivr.fi) is used as a fallback.
// ---------------------------------------------------------------------------
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const TWITCH_BADGE_TTL_MS = 60 * 60 * 1000; // good result: keep 1 h
const TWITCH_BADGE_FAIL_MS = 60 * 1000;     // failure: retry after 1 min
const twitchBadgeCache = new Map();         // key -> { at, ttl, p }
let twitchTok = { value: null, exp: 0 };

async function twitchAppToken() {
  if (twitchTok.value && Date.now() < twitchTok.exp - 60000) return twitchTok.value;
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials'
    }),
    signal: AbortSignal.timeout(8000)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`Twitch auth failed (${res.status}): ${j.message || 'error'}`);
  twitchTok = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return twitchTok.value;
}

// Helix ({set_id, versions}) and IVR ({setID, versions}) -> { set: { versions: { id: {...} } } }
function normBadgeSets(list) {
  const out = {};
  for (const s of Array.isArray(list) ? list : []) {
    const id = s?.set_id || s?.setID;
    if (!id) continue;
    const versions = {};
    for (const v of s.versions || []) {
      versions[String(v.id ?? v.version)] = {
        title: v.title,
        image_url_1x: v.image_url_1x,
        image_url_2x: v.image_url_2x
      };
    }
    out[id] = { versions };
  }
  return out;
}

async function twitchJson(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function loadTwitchBadges(scope, roomId, login) {
  if (TWITCH_CLIENT_ID && TWITCH_CLIENT_SECRET) {
    try {
      const token = await twitchAppToken();
      const url = scope === 'global'
        ? 'https://api.twitch.tv/helix/chat/badges/global'
        : `https://api.twitch.tv/helix/chat/badges?broadcaster_id=${encodeURIComponent(roomId)}`;
      const j = await twitchJson(url, { Authorization: `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID });
      return normBadgeSets(j.data);
    } catch (err) {
      console.error(`[Twitch] Helix ${scope} badges failed:`, err?.message || err);
      twitchTok = { value: null, exp: 0 };
    }
  }
  // Fallback without credentials (third-party, community run).
  try {
    const url = scope === 'global'
      ? 'https://api.ivr.fi/v2/twitch/badges/global'
      : `https://api.ivr.fi/v2/twitch/badges/channel?login=${encodeURIComponent(login)}`;
    return normBadgeSets(await twitchJson(url, { Accept: 'application/json' }));
  } catch (err) {
    console.error(`[Twitch] IVR ${scope} badges failed:`, err?.message || err);
    return null;
  }
}

function twitchBadgeSets(scope, roomId = '', login = '') {
  const key = scope === 'global' ? 'global' : `channel:${roomId}`;
  const hit = twitchBadgeCache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.p;
  const entry = { at: Date.now(), ttl: TWITCH_BADGE_TTL_MS, p: null };
  entry.p = loadTwitchBadges(scope, roomId, login).then((v) => {
    if (!v) { entry.ttl = TWITCH_BADGE_FAIL_MS; return {}; }
    console.log(`[Twitch] Loaded ${scope} badge sets: ${Object.keys(v).length}`);
    return v;
  });
  twitchBadgeCache.set(key, entry);
  if (twitchBadgeCache.size > 100) twitchBadgeCache.delete(twitchBadgeCache.keys().next().value); // bound memory
  return entry.p;
}

// tags.badges looks like { moderator: '1', subscriber: '12' }.
// Channel sets override global ones (custom sub / bits badges).
async function twitchBadges(tags, login = '') {
  const raw = tags.badges;
  if (!raw || typeof raw !== 'object') return [];
  const room = tags['room-id'];
  const [glob, chan] = await Promise.all([
    twitchBadgeSets('global'),
    room ? twitchBadgeSets('channel', room, login) : {}
  ]);
  return Object.entries(raw).map(([name, version]) => {
    const v = chan[name]?.versions?.[version] || glob[name]?.versions?.[version];
    return { type: name, label: v?.title || name, url: v?.image_url_2x || v?.image_url_1x || '' };
  });
}

async function connectTwitch(channel) {
  disconnectPlatform('twitch');
  const chan = String(channel || '').replace(/^#/, '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,25}$/.test(chan)) {
    return updatePlatformStatus('twitch', 'error', String(channel), 'Invalid Twitch channel');
  }

  updatePlatformStatus('twitch', 'connecting', chan);
  const client = new tmi.Client({ channels: [chan] });
  activeAdapters.twitch.client = client;
  const isCurrent = () => activeAdapters.twitch.client === client;

  client.on('message', async (_c, tags, message, self) => {
    if (self || !isCurrent()) return;
    let badges = [];
    try { badges = await twitchBadges(tags, chan); } catch {}
    if (!isCurrent()) return;
    broadcastMessage(normalizeMessage('twitch', tags['display-name'] || tags.username, message, '', tags.id ? `twitch-${tags.id}` : null, badges));
  });
  client.on('disconnected', () => {
    if (isCurrent() && activeAdapters.twitch.status !== 'error') updatePlatformStatus('twitch', 'disconnected');
  });
  client.on('connected', () => {
    if (isCurrent()) updatePlatformStatus('twitch', 'connected', chan);
  });

  try {
    await client.connect();
  } catch (err) {
    if (isCurrent()) updatePlatformStatus('twitch', 'error', chan, String(err?.message || err));
  }
}

// ---------------------------------------------------------------------------
// 4. Kick: official API + webhooks.
// Setup: https://kick.com/settings/developer -> create an app, then set
//   env KICK_CLIENT_ID, KICK_CLIENT_SECRET
//   Webhook URL in the Kick app settings: https://YOUR-HOST/webhooks/kick
// Kick badges come as { type, text, count? } with no image URL, so the overlay
// has to draw them by `type` (moderator, subscriber, sub_gifter, vip, og, ...).
// ---------------------------------------------------------------------------
const KICK_CLIENT_ID = process.env.KICK_CLIENT_ID;
const KICK_CLIENT_SECRET = process.env.KICK_CLIENT_SECRET;
const KICK_API = 'https://api.kick.com/public/v1';
let kickToken = { value: null, exp: 0 };
let kickPublicKeyPem = null;
const kickSeen = makeSeen(1000);

async function kickAppToken(force = false) {
  if (!force && kickToken.value && Date.now() < kickToken.exp - 60000) return kickToken.value;
  const res = await fetch('https://id.kick.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: KICK_CLIENT_ID,
      client_secret: KICK_CLIENT_SECRET
    }),
    signal: AbortSignal.timeout(10000)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    throw new Error(`Kick auth failed (${res.status}): ${j.error_description || j.error || j.message || 'unknown error'}`);
  }
  kickToken = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return kickToken.value;
}

async function kickApi(method, pathAndQuery, body, retried = false) {
  const token = await kickAppToken(retried);
  const res = await fetch(KICK_API + pathAndQuery, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000)
  });
  if (res.status === 401 && !retried) return kickApi(method, pathAndQuery, body, true);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Kick API ${method} ${pathAndQuery.split('?')[0]} -> ${res.status}: ${j.message || j.error || 'error'}`);
  return j;
}

// Kick's webhook sends badges as { type, text, count? } without images, and
// Kick's own role badges are bundled inside its website (no public URL). So:
//  - role badges use the icons in public/icons/kick/ (served by this server)
//  - the channel's custom subscriber badges are fetched best-effort from Kick's
//    unofficial website API (may be blocked; falls back to the local icon)
const KICK_ICON_FILES = new Set(['broadcaster', 'moderator', 'vip', 'og', 'founder', 'subscriber', 'staff', 'verified', 'subgifter', 'sidekick']);

function kickBadgeIcon(type, count) {
  const key = String(type || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const k = key === 'owner' ? 'broadcaster' : key === 'mod' ? 'moderator' : key;
  if (k === 'subgifter') {
    const tier = [200, 100, 50, 25].find((t) => Number(count) >= t);
    return `/icons/kick/subgifter${tier || ''}.svg`;
  }
  return KICK_ICON_FILES.has(k) ? `/icons/kick/${k}.svg` : '/icons/kick/unknown.svg';
}

async function kickChannelSubBadges(slug) {
  try {
    const r = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
      headers: { Accept: 'application/json', 'User-Agent': YT_UA },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const list = (j.subscriber_badges || [])
      .map((b) => ({ months: Number(b.months) || 0, url: b.badge_image?.src || '' }))
      .filter((b) => /^https:\/\//i.test(b.url))
      .sort((a, b) => a.months - b.months);
    console.log(`[Kick] ${slug}: ${list.length} custom subscriber badge(s)`);
    return list;
  } catch (err) {
    console.log(`[Kick] Custom sub badges unavailable for ${slug} (${err?.message || err}); using default icons`);
    return [];
  }
}

function kickSubBadgeUrl(list, months) {
  if (!list?.length) return '';
  const m = Number(months) || 0;
  let pick = list[0];
  for (const b of list) if (b.months <= m) pick = b;
  return pick.url;
}

async function connectKick(slug) {
  disconnectPlatform('kick');
  const clean = String(slug || '').toLowerCase().trim().replace(/^@/, '');
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(clean)) {
    return updatePlatformStatus('kick', 'error', String(slug), 'Invalid Kick channel name');
  }
  if (!KICK_CLIENT_ID || !KICK_CLIENT_SECRET) {
    return updatePlatformStatus('kick', 'error', clean, 'Set KICK_CLIENT_ID and KICK_CLIENT_SECRET in the server environment');
  }

  const token = Symbol('kick');
  activeAdapters.kick.token = token;
  updatePlatformStatus('kick', 'connecting', clean);

  try {
    const ch = await kickApi('GET', `/channels?slug=${encodeURIComponent(clean)}`);
    const broadcasterId = Number(ch?.data?.[0]?.broadcaster_user_id);
    if (!broadcasterId) throw new Error(`Kick channel "${clean}" not found`);
    console.log(`[Kick] Channel ${clean} -> broadcaster_user_id ${broadcasterId}`);

    const subs = await kickApi('GET', '/events/subscriptions');
    const exists = (subs.data || []).some(
      (s) => s.event === 'chat.message.sent' && Number(s.broadcaster_user_id) === broadcasterId
    );
    if (!exists) {
      const r = await kickApi('POST', '/events/subscriptions', {
        broadcaster_user_id: broadcasterId,
        events: [{ name: 'chat.message.sent', version: 1 }],
        method: 'webhook'
      });
      const bad = (r.data || []).find((d) => d.error);
      if (bad) throw new Error(`Subscription refused: ${bad.error}`);
      console.log('[Kick] Subscribed to chat.message.sent');
    } else {
      console.log('[Kick] Already subscribed to chat.message.sent');
    }

    if (activeAdapters.kick.token !== token) return; // cancelled meanwhile
    const subBadges = await kickChannelSubBadges(clean);
    if (activeAdapters.kick.token !== token) return;
    activeAdapters.kick.instance = { broadcasterId, slug: clean, subBadges };
    updatePlatformStatus('kick', 'connected', clean);
  } catch (err) {
    console.error('[Kick] Connect failed:', err?.message || err);
    if (activeAdapters.kick.token === token) updatePlatformStatus('kick', 'error', clean, String(err?.message || err));
  }
}

async function getKickPublicKey(refresh = false) {
  if (kickPublicKeyPem && !refresh) return kickPublicKeyPem;
  const j = await kickApi('GET', '/public-key');
  kickPublicKeyPem = j?.data?.public_key;
  if (!kickPublicKeyPem) throw new Error('Kick public key missing in response');
  return kickPublicKeyPem;
}

// The signed payload is `${id}.${timestamp}.${rawBody}`. The body is appended
// as the exact received bytes (no utf8 round-trip) so the signature matches.
function kickSignatureValid(headers, rawBody, pem) {
  const id = headers['kick-event-message-id'];
  const ts = headers['kick-event-message-timestamp'];
  const sig = headers['kick-event-signature'];
  if (!id || !ts || !sig) return false;
  const key = crypto.createPublicKey(pem);
  const data = Buffer.concat([Buffer.from(`${id}.${ts}.`), rawBody]);
  const algo = key.asymmetricKeyType === 'ed25519' ? null : 'RSA-SHA256'; // RSA or Ed25519
  return crypto.verify(algo, data, key, Buffer.from(sig, 'base64'));
}

async function handleKickWebhook(req, res) {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    let ok = false;
    try {
      ok = kickSignatureValid(req.headers, raw, await getKickPublicKey());
      if (!ok) ok = kickSignatureValid(req.headers, raw, await getKickPublicKey(true)); // key rotation
    } catch (err) {
      console.error('[Kick Webhook] Signature check error:', err?.message || err);
    }
    if (!ok) {
      console.warn('[Kick Webhook] Rejected: bad signature');
      return res.status(401).end();
    }

    res.status(200).end(); // answer fast: Kick unsubscribes after failed deliveries

    if (req.headers['kick-event-type'] !== 'chat.message.sent') return;
    if (kickSeen(req.headers['kick-event-message-id'])) return;

    const p = JSON.parse(raw.toString('utf8'));
    const active = activeAdapters.kick.instance;
    if (!active || Number(p.broadcaster?.user_id) !== active.broadcasterId) return;

    const kickBadges = (p.sender?.identity?.badges || []).map((b) => {
      const count = Number.isFinite(b.count) && b.count > 0 ? b.count : 0;
      const isSub = String(b.type).toLowerCase() === 'subscriber';
      return {
        type: b.type,
        label: `${b.text || b.type}${count ? ` ${count}` : ''}`,
        url: (isSub && kickSubBadgeUrl(active.subBadges, count)) || kickBadgeIcon(b.type, count)
      };
    });

    broadcastMessage(
      normalizeMessage('kick', p.sender?.username, p.content, p.sender?.profile_picture || '', p.message_id ? `kick-${p.message_id}` : null, kickBadges)
    );
  } catch (err) {
    console.error('[Kick Webhook] Error:', err);
    if (!res.headersSent) res.status(200).end();
  }
}

// ---------------------------------------------------------------------------
// 5. Rumble: official Live Stream API (polled). Works for YOUR OWN channel
// only and only while you are live. Get the URL at
// rumble.com/account/livestream-api (it contains your secret key). Paste the
// full URL (or just the key) into the dashboard, or put it in env
// RUMBLE_API_URL and type "env" as the handle. The URL/key is never stored in
// the status `handle`, so it is not broadcast to overlay viewers.
// ---------------------------------------------------------------------------
const RUMBLE_POLL_MS = 4000;

function resolveRumbleUrl(input) {
  let v = String(input || '').trim();
  if (v.toLowerCase() === 'env') v = process.env.RUMBLE_API_URL || process.env.RUMBLE_API_KEY || '';
  if (!v) return null;
  try {
    let u;
    if (/^https?:\/\//i.test(v)) {
      u = new URL(v);
    } else if (/^[\w-]{8,}$/.test(v)) {
      u = new URL('https://rumble.com/-livestream-api/get-data');
      u.searchParams.set('key', v);
    } else {
      return null;
    }
    const hostOk = u.hostname === 'rumble.com' || u.hostname.endsWith('.rumble.com');
    return u.protocol === 'https:' && hostOk ? u : null; // blocks requests to other hosts
  } catch {
    return null;
  }
}

async function connectRumble(input) {
  disconnectPlatform('rumble');
  const url = resolveRumbleUrl(input);
  if (!url) {
    return updatePlatformStatus('rumble', 'error', '', 'Paste your Rumble Live Stream API URL (rumble.com/account/livestream-api) or key');
  }

  const token = Symbol('rumble');
  activeAdapters.rumble.token = token;
  updatePlatformStatus('rumble', 'connecting', 'Rumble');

  const isSeen = makeSeen(2000);
  let firstPoll = true;
  let failures = 0;
  let wasLive = null;
  const current = () => activeAdapters.rumble.token === token;

  const poll = async () => {
    if (!current()) return;
    let delay = RUMBLE_POLL_MS;
    try {
      // redirect:'error' keeps the secret key from being forwarded to another host.
      const res = await fetch(url, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(8000) });
      if ([401, 403, 404].includes(res.status)) {
        // Wrong or revoked key: retrying will not help.
        return updatePlatformStatus('rumble', 'error', '', `Rumble rejected the API key (HTTP ${res.status}). Reset it at rumble.com/account/livestream-api`);
      }
      if (!res.ok) throw new Error(`Rumble API returned HTTP ${res.status}`);
      const data = await res.json();
      if (!current()) return;

      failures = 0;
      if (activeAdapters.rumble.status !== 'connected') {
        updatePlatformStatus('rumble', 'connected', data.username || 'Rumble');
      }

      const streams = Array.isArray(data.livestreams) ? data.livestreams : [];
      const stream = streams.find((s) => s?.is_live) || streams[0];
      const live = Boolean(stream?.is_live);
      if (live !== wasLive) {
        console.log(`[Rumble] ${live ? 'Stream is live' : 'No live stream right now (chat only appears while live)'}`);
        wasLive = live;
      }

      const chat = stream?.chat || {};
      const items = [
        ...(chat.recent_messages || []).map((m) => ({ ...m, _rant: false })),
        ...(chat.recent_rants || []).map((m) => ({ ...m, _rant: true }))
      ].sort((a, b) => String(a.created_on || '').localeCompare(String(b.created_on || '')));

      for (const m of items) {
        const id = `rumble-${m._rant ? 'rant-' : ''}${m.id ?? `${m.username}-${m.created_on}-${m.text}`}`;
        if (isSeen(id)) continue;
        if (firstPoll) continue; // existing backlog: remember it, do not replay it
        if (!m.text && !m._rant) continue;

        let text = m.text || '';
        if (m._rant) {
          const dollars = m.amount_dollars ?? (m.amount_cents != null ? m.amount_cents / 100 : null);
          text = `\u{1F4B0} Rant${dollars != null ? ` $${Number(dollars).toFixed(2)}` : ''}${text ? `: ${text}` : ''}`;
        }
        broadcastMessage(normalizeMessage('rumble', m.username, text, '', id, m.badges));
      }
      firstPoll = false;
    } catch (err) {
      failures += 1;
      console.error(`[Rumble] Poll failed (${failures}):`, err?.message || err);
      delay = Math.min(RUMBLE_POLL_MS * 2 ** Math.min(failures, 3), 30000);
      if (failures === 3 && current()) updatePlatformStatus('rumble', 'error', '', `Rumble API unreachable: ${err?.message || err}`);
    }
    if (current()) activeAdapters.rumble.timer = setTimeout(poll, delay);
  };

  poll();
}

// ---------------------------------------------------------------------------
// Disconnect
// ---------------------------------------------------------------------------
function disconnectPlatform(platform, { silent = false } = {}) {
  const a = activeAdapters[platform];
  if (!a) return;

  clearTimeout(a.retry);
  clearTimeout(a.timer);
  try { a.instance?.stop?.(); } catch {}
  try { a.process?.kill('SIGTERM'); } catch {}
  try { a.client?.disconnect?.()?.catch?.(() => {}); } catch {}

  activeAdapters[platform] = blankAdapter();
  if (!silent) updatePlatformStatus(platform, 'disconnected');
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
function requireAuth(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (authBlocked(ip)) return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
  const given = req.body?.auth;
  if (typeof given !== 'string' || !passOk(given)) {
    authFailed(ip);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// X, Facebook and Instagram live in adapters/ (see the comment at the top of each file).
// X chat is also available through the official Activity API webhook (adapters/xwebhook.js).
const adapterCtx = { activeAdapters, updatePlatformStatus, normalizeMessage, broadcastMessage, makeSeen, disconnectPlatform };
const xAdapter = require('./adapters/x').init(adapterCtx);
const fbAdapter = require('./adapters/facebook').init(adapterCtx);
const igAdapter = require('./adapters/instagram').init(adapterCtx);

const connectors = {
  youtube: connectYouTube,
  tiktok: connectTikTok,
  twitch: connectTwitch,
  kick: connectKick,
  facebook: fbAdapter.connectFacebook,
  rumble: connectRumble,
  x: xAdapter.connectX,
  instagram: igAdapter.connectInstagram
};

app.post('/api/connect', requireAuth, (req, res) => {
  const { platform, handle } = req.body || {};
  const connect = Object.prototype.hasOwnProperty.call(connectors, platform) ? connectors[platform] : null;
  if (!connect) return res.status(400).json({ error: 'Unsupported platform' });
  if (typeof handle !== 'string' || !handle.trim() || handle.length > 200) {
    return res.status(400).json({ error: 'Missing or invalid handle' });
  }
  Promise.resolve(connect(handle.trim())).catch((err) => console.error(`[${platform}] connect crashed:`, err));
  res.json({ success: true });
});

// Kept for the dashboard's Instagram login button. Instagram runs in official-API
// mode now, so openLogin does nothing and just reports success.
app.post('/api/instagram/login', requireAuth, (_req, res) => {
  Promise.resolve(igAdapter.openLogin?.())
    .then(() => res.json({ success: true }))
    .catch((err) => res.status(500).json({ error: String(err?.message || err) }));
});

app.post('/api/disconnect', requireAuth, (req, res) => {
  const { platform } = req.body || {};
  if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: 'Unsupported platform' });
  disconnectPlatform(platform);
  res.json({ success: true });
});

app.get('/api/status', (_req, res) => {
  const summary = {};
  PLATFORMS.forEach((p) => {
    const { status, handle, error } = snapshot(p);
    summary[p] = { status, handle, error };
  });
  res.json(summary);
});

app.get('/health', (_req, res) => res.status(200).send('OK'));

// ---------------------------------------------------------------------------
// Overlay URL config:
//   /overlay.html?twitch=NAME&kick=NAME&youtube=@HANDLE&tiktok=NAME&rumble=URL
// The overlay page sends these over the socket and the server connects them.
// Reloading the overlay never restarts a platform already running for the same
// value, and changes are rate-limited because this endpoint has no password.
// Optional: set env OVERLAY_KEY and add &key=THAT_VALUE to require it.
// ---------------------------------------------------------------------------
const OVERLAY_PLATFORMS = ['twitch', 'kick', 'youtube', 'tiktok', 'rumble', 'x', 'facebook', 'instagram'];
// These use server-side credentials or open a window, so they only start from an
// overlay URL when OVERLAY_KEY is set (and the URL carries &key=...).
const OVERLAY_KEY_REQUIRED = new Set(['facebook', 'instagram']);
const OVERLAY_COOLDOWN_MS = 15000;
const overlayState = {}; // platform -> { fp, at }

function applyOverlayConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return;
  if (process.env.OVERLAY_KEY) {
    const given = typeof cfg.key === 'string' ? cfg.key : '';
    if (!safeEqual(given, process.env.OVERLAY_KEY)) return;
  }
  for (const p of OVERLAY_PLATFORMS) {
    const raw = cfg[p];
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 400) continue;
    if (OVERLAY_KEY_REQUIRED.has(p) && !process.env.OVERLAY_KEY) {
      if (!overlayState[`warn-${p}`]) { overlayState[`warn-${p}`] = true; console.warn(`[Overlay] ${p} from the overlay URL is ignored: set OVERLAY_KEY and add &key=... to allow it`); }
      continue;
    }
    const handle = raw.trim();
    const fp = crypto.createHash('sha256').update(handle).digest('hex');
    const prev = overlayState[p];
    const status = activeAdapters[p].status;

    if (prev && prev.fp === fp && (status === 'connecting' || status === 'connected')) continue;
    if (prev && Date.now() - prev.at < OVERLAY_COOLDOWN_MS) continue;

    overlayState[p] = { fp, at: Date.now() };
    console.log(`[Overlay] Connecting ${p} from overlay URL`); // never log the value (Rumble URLs contain a key)
    Promise.resolve(connectors[p](handle)).catch((err) => console.error(`[${p}] connect crashed:`, err));
  }
}

io.on('connection', (socket) => {
  PLATFORMS.forEach((p) => socket.emit('statusUpdate', snapshot(p)));
  socket.on('overlayConnect', applyOverlayConfig);
});

// ---------------------------------------------------------------------------
// Start / shutdown
// ---------------------------------------------------------------------------
function shutdown() {
  console.log('Shutting down, stopping adapters...');
  PLATFORMS.forEach((p) => disconnectPlatform(p, { silent: true }));
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

// Internals exposed for the unit tests (harmless in production).
module.exports = {
  app,
  server,
  io,
  _test: {
    youTubeTargets, ytAnalyzeChatPage, ytParseChatResponse, ytExtractContinuation, ytExtractInitialData,
    ytItemToEntry, ytActionsToEntries, ytFetch, createYtPoller, ytCfg, YtError, ytHttpError,
    ytApiItemToEntry, ytCollectVideos, makeSeen, normalizeMessage, connectYouTube, activeAdapters,
    ytDeadVideos, ytChatStart, ytRetryDelay, disconnectPlatform, kickSignatureValid, resolveRumbleUrl, snapshot
  }
};

if (require.main === module) {
  server.listen(PORT, () => console.log(`MalikGPT Unified Chat live on port ${PORT} [build: platforms-v7]`));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('unhandledRejection', (err) => console.error('[Unhandled rejection]', err));
  process.on('uncaughtException', (err) => console.error('[Uncaught exception]', err));
}
