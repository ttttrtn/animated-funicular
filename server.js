'use strict';
require('dotenv').config();

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const tmi = require('tmi.js');
const { Innertube } = require('youtubei.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');

// ---------------------------------------------------------------------------
// Auth: password comes from the environment only (no hardcoded default).
// If DASHBOARD_PASS is not set, a random one is generated and printed once.
// ---------------------------------------------------------------------------
let DASHBOARD_PASS = process.env.DASHBOARD_PASS;
if (!DASHBOARD_PASS) {
  DASHBOARD_PASS = crypto.randomBytes(9).toString('base64url');
  console.warn(`[Auth] DASHBOARD_PASS not set. Temporary password for this run: ${DASHBOARD_PASS}`);
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const passOk = (given) => crypto.timingSafeEqual(sha(given), sha(DASHBOARD_PASS));

// Kick webhook: needs the RAW body for signature checking, so it must be
// registered before the JSON parser.
app.post('/webhooks/kick', express.raw({ type: '*/*', limit: '200kb' }), (req, res) => handleKickWebhook(req, res));

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const PLATFORMS = ['youtube', 'tiktok', 'twitch', 'kick', 'facebook', 'rumble'];

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
function normalizeMessage(platform, username, message, avatar = '', id = null) {
  const esc = (v) => String(v).replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return {
    id: id || `${platform}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    platform: platform.toLowerCase(),
    username: esc(username || 'Anonymous'),
    message: esc(message || ''),
    avatar: avatar || `/icons/${platform.toLowerCase()}.svg`,
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };
}

function broadcastMessage(msg) {
  io.emit('chatMessage', msg);
}

// For status "error" the message is also sent in `handle` so existing
// dashboards that display `handle` keep working; `error` is the clean field.
function updatePlatformStatus(platform, status, handle = '', error = '') {
  const a = activeAdapters[platform];
  a.status = status;
  if (handle) a.handle = handle;
  a.error = status === 'error' ? error || handle : '';
  io.emit('statusUpdate', {
    platform,
    status,
    handle: status === 'error' ? a.error : a.handle,
    error: a.error
  });
}

function snapshot(platform) {
  const a = activeAdapters[platform];
  return { platform, status: a.status, handle: a.status === 'error' ? a.error : a.handle, error: a.error };
}

// ---------------------------------------------------------------------------
// Generic Python bridge runner (used by TikTok and Kick)
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

  // -u + PYTHONUNBUFFERED: piped Python stdout is block-buffered otherwise.
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
          broadcastMessage(normalizeMessage(platform, p.username, p.message, p.avatar || '', p.id));
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
    buffer = lines.pop(); // keep the unfinished tail for the next chunk
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
    if (!isCurrent()) return; // old process killed by reconnect/disconnect

    adapter.process = null;
    const lastWasError = adapter.status === 'error';
    if (!lastWasError) updatePlatformStatus(platform, 'disconnected');

    if (!fatal && attempt < BRIDGE_MAX_RETRIES) {
      const delay = Math.min(2000 * 2 ** attempt, 60000);
      console.log(`[${label}] Reconnecting in ${delay / 1000}s...`);
      adapter.retry = setTimeout(() => startBridge(platform, script, arg, attempt + 1), delay);
    }
  });
}

// ---------------------------------------------------------------------------
// 1. YouTube
// ---------------------------------------------------------------------------
function parseYouTubeId(input) {
  const s = String(input || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:[?&]v=|youtu\.be\/|\/live\/|\/embed\/)([\w-]{11})/);
  return m ? m[1] : null;
}

async function connectYouTube(input) {
  disconnectPlatform('youtube');
  const videoId = parseYouTubeId(input);
  if (!videoId) return updatePlatformStatus('youtube', 'error', String(input), 'Invalid YouTube video ID or URL');

  const token = Symbol('yt');
  activeAdapters.youtube.token = token;
  updatePlatformStatus('youtube', 'connecting', videoId);

  try {
    const yt = await Innertube.create();
    const info = await yt.getInfo(videoId);
    if (activeAdapters.youtube.token !== token) return; // cancelled meanwhile

    const liveChat = info.getLiveChat();
    const seen = new Set();

    const emit = (item) => {
      const text = item?.message?.toString?.() || '';
      if (!text) return;
      const id = item.id ? `youtube-${item.id}` : null;
      if (id) {
        if (seen.has(id)) return;
        seen.add(id);
        if (seen.size > 1000) seen.delete(seen.values().next().value);
      }
      broadcastMessage(
        normalizeMessage('youtube', item.author?.name?.toString?.() || 'Viewer', text, item.author?.thumbnails?.[0]?.url || '', id)
      );
    };

    // Newer youtubei.js emits 'chat-update'; older versions emitted 'chat-item'.
    liveChat.on('chat-update', (action) => {
      if (activeAdapters.youtube.token !== token) return;
      if (action?.type === 'AddChatItemAction') emit(action.item);
    });
    liveChat.on('chat-item', (item) => {
      if (activeAdapters.youtube.token === token) emit(item);
    });
    liveChat.on('error', (err) => {
      console.error('[YouTube] Live chat error:', err?.message || err);
      if (activeAdapters.youtube.token === token) updatePlatformStatus('youtube', 'error', videoId, String(err?.message || err));
    });
    liveChat.on('end', () => {
      if (activeAdapters.youtube.token === token) updatePlatformStatus('youtube', 'disconnected');
    });

    liveChat.start();
    activeAdapters.youtube.instance = liveChat;
    updatePlatformStatus('youtube', 'connected', videoId);
  } catch (err) {
    console.error('[YouTube] Connect failed:', err?.message || err);
    if (activeAdapters.youtube.token === token) updatePlatformStatus('youtube', 'error', videoId, String(err?.message || err));
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
// ---------------------------------------------------------------------------
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

  client.on('message', (_c, tags, message, self) => {
    if (self || !isCurrent()) return;
    broadcastMessage(normalizeMessage('twitch', tags['display-name'] || tags.username, message, '', tags.id ? `twitch-${tags.id}` : null));
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
// 4. Kick: official API + webhooks (the unofficial websocket is blocked by
// Cloudflare from servers, so the old Python bridge could not connect).
//
// Setup: https://kick.com/settings/developer -> create an app, then set
//   env KICK_CLIENT_ID, KICK_CLIENT_SECRET
//   Webhook URL in the Kick app settings: https://YOUR-HOST/webhooks/kick
// ---------------------------------------------------------------------------
const KICK_CLIENT_ID = process.env.KICK_CLIENT_ID;
const KICK_CLIENT_SECRET = process.env.KICK_CLIENT_SECRET;
const KICK_API = 'https://api.kick.com/public/v1';
let kickToken = { value: null, exp: 0 };
let kickPublicKeyPem = null;
const kickSeen = new Set();

async function kickAppToken(force = false) {
  if (!force && kickToken.value && Date.now() < kickToken.exp - 60000) return kickToken.value;
  const res = await fetch('https://id.kick.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: KICK_CLIENT_ID,
      client_secret: KICK_CLIENT_SECRET
    })
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
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401 && !retried) return kickApi(method, pathAndQuery, body, true);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Kick API ${method} ${pathAndQuery.split('?')[0]} -> ${res.status}: ${j.message || j.error || 'error'}`);
  return j;
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
    activeAdapters.kick.instance = { broadcasterId, slug: clean };
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

function kickSignatureValid(headers, rawBody, pem) {
  const id = headers['kick-event-message-id'];
  const ts = headers['kick-event-message-timestamp'];
  const sig = headers['kick-event-signature'];
  if (!id || !ts || !sig) return false;
  const key = crypto.createPublicKey(pem);
  const data = Buffer.from(`${id}.${ts}.${rawBody.toString('utf8')}`);
  // Handles both RSA (SHA-256) and Ed25519 keys.
  const algo = key.asymmetricKeyType === 'ed25519' ? null : 'RSA-SHA256';
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

    const eventType = req.headers['kick-event-type'];
    const msgId = req.headers['kick-event-message-id'];
    if (eventType !== 'chat.message.sent') return;
    if (kickSeen.has(msgId)) return;
    kickSeen.add(msgId);
    if (kickSeen.size > 1000) kickSeen.delete(kickSeen.values().next().value);

    const p = JSON.parse(raw.toString('utf8'));
    const active = activeAdapters.kick.instance;
    if (!active || Number(p.broadcaster?.user_id) !== active.broadcasterId) return;

    broadcastMessage(
      normalizeMessage('kick', p.sender?.username, p.content, p.sender?.profile_picture || '', p.message_id ? `kick-${p.message_id}` : null)
    );
  } catch (err) {
    console.error('[Kick Webhook] Error:', err);
    if (!res.headersSent) res.status(200).end();
  }
}

// ---------------------------------------------------------------------------
// 6. Rumble: official Live Stream API (polled). Works for YOUR OWN channel only
// and only while you are live. Get the URL at rumble.com/account/livestream-api
// (it contains your secret key). Paste the full URL (or just the key) into the
// dashboard, or put it in env RUMBLE_API_URL and type "env" as the handle.
// The URL/key is never stored in the status `handle`, so it is not broadcast
// to overlay viewers or shown by /api/status.
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

  const seen = new Set();
  let firstPoll = true;
  let failures = 0;
  let wasLive = null;
  const current = () => activeAdapters.rumble.token === token;

  const poll = async () => {
    if (!current()) return;
    let delay = RUMBLE_POLL_MS;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
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
        if (seen.has(id)) continue;
        seen.add(id);
        if (seen.size > 2000) seen.delete(seen.values().next().value);
        if (firstPoll) continue; // existing backlog: remember it, do not replay it
        if (!m.text && !m._rant) continue;

        let text = m.text || '';
        if (m._rant) {
          const dollars = m.amount_dollars ?? (m.amount_cents != null ? m.amount_cents / 100 : null);
          text = `\u{1F4B0} Rant${dollars != null ? ` $${Number(dollars).toFixed(2)}` : ''}${text ? `: ${text}` : ''}`;
        }
        broadcastMessage(normalizeMessage('rumble', m.username, text, '', id));
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
// 5. Facebook: not implemented. The old version showed a fake
// "connected" status every 5 s, which was misleading, so they now report it.
// ---------------------------------------------------------------------------
function connectUnsupported(platform, handle) {
  disconnectPlatform(platform);
  updatePlatformStatus(platform, 'error', String(handle || ''), `${platform} chat is not implemented yet`);
}

// ---------------------------------------------------------------------------
// Disconnect
// ---------------------------------------------------------------------------
function disconnectPlatform(platform, { silent = false } = {}) {
  const a = activeAdapters[platform];
  if (!a) return;

  clearTimeout(a.retry);
  clearInterval(a.timer);
  try { a.instance?.stop?.(); } catch {}
  try { a.process?.kill('SIGTERM'); } catch {}
  try { a.client?.disconnect?.().catch?.(() => {}); } catch {}

  activeAdapters[platform] = blankAdapter();
  if (!silent) updatePlatformStatus(platform, 'disconnected');
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
function requireAuth(req, res, next) {
  const given = req.body?.auth;
  if (typeof given !== 'string' || !passOk(given)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

const connectors = {
  youtube: connectYouTube,
  tiktok: connectTikTok,
  twitch: connectTwitch,
  kick: connectKick,
  facebook: (h) => connectUnsupported('facebook', h),
  rumble: connectRumble
};

app.post('/api/connect', requireAuth, (req, res) => {
  const { platform, handle } = req.body;
  const connect = Object.prototype.hasOwnProperty.call(connectors, platform) ? connectors[platform] : null;
  if (!connect) return res.status(400).json({ error: 'Unsupported platform' });
  if (typeof handle !== 'string' || !handle.trim() || handle.length > 200) {
    return res.status(400).json({ error: 'Missing or invalid handle' });
  }
  Promise.resolve(connect(handle.trim())).catch((err) => console.error(`[${platform}] connect crashed:`, err));
  res.json({ success: true });
});

app.post('/api/disconnect', requireAuth, (req, res) => {
  const { platform } = req.body;
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

io.on('connection', (socket) => {
  PLATFORMS.forEach((p) => socket.emit('statusUpdate', snapshot(p)));
});

// ---------------------------------------------------------------------------
// Start / shutdown
// ---------------------------------------------------------------------------
server.listen(PORT, () => console.log(`MalikGPT Unified Chat live on port ${PORT}`));

function shutdown() {
  console.log('Shutting down, stopping adapters...');
  PLATFORMS.forEach((p) => disconnectPlatform(p, { silent: true }));
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (err) => console.error('[Unhandled rejection]', err));
