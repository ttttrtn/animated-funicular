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

// Kick webhook needs the RAW body for signature checking, so it must be
// registered before the JSON parser.
app.post('/webhooks/kick', express.raw({ type: '*/*', limit: '200kb' }), (req, res) => handleKickWebhook(req, res));

app.use(express.json({ limit: '10kb' }));
app.get(['/overlay', '/overlay/', '/overlay.html', '/overlay.html/'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'overlay.html'));
});
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
const escapeHtml = (v) =>
  String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Only allow http(s) avatars or local icons (blocks javascript:/data: URLs).
function safeAvatar(url, platform) {
  const fallback = `/icons/${platform}.svg`;
  if (typeof url !== 'string' || !url) return fallback;
  return /^https:\/\//i.test(url) || /^\/[\w./-]+$/.test(url) ? url : fallback;
}

function normalizeMessage(platform, username, message, avatar = '', id = null) {
  const p = platform.toLowerCase();
  return {
    id: id || `${p}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    platform: p,
    username: escapeHtml(username || 'Anonymous'),
    message: escapeHtml(message || ''),
    avatar: safeAvatar(avatar, p),
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

// ---------------------------------------------------------------------------
// 1. YouTube: @handle, channel URL/ID, or video URL/ID.
// Handle/channel: finds the channel's current live stream, re-checks every
// 30 s, and reconnects by itself for the next stream. Errors are retried.
// ---------------------------------------------------------------------------
const YT_RETRY_MS = 30000;
const YT_VIDEO_ID = /^[\w-]{11}$/;
let ytClientPromise = null;

// youtubei.js is ESM-only, so it has to be imported dynamically.
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

const codeErr = (code, message) => Object.assign(new Error(message), { code });

function youTubeTargets(input) {
  const s = String(input || '').trim();
  const handle = (h) => ({ type: 'handle', value: h, label: `@${h}` });
  const video = (v) => ({ type: 'video', value: v, label: v });
  const channel = (c) => ({ type: 'channel', value: c, label: c });
  if (!s) return [];

  if (/^https?:\/\//i.test(s) || /^(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(s)) {
    let u;
    try { u = new URL(/^https?:/i.test(s) ? s : `https://${s}`); } catch { return []; }
    const host = u.hostname.replace(/^(www\.|m\.)/, '');
    if (host === 'youtu.be') {
      const id = u.pathname.slice(1).split('/')[0];
      return YT_VIDEO_ID.test(id) ? [video(id)] : [];
    }
    if (!host.endsWith('youtube.com')) return [];
    const v = u.searchParams.get('v');
    if (v && YT_VIDEO_ID.test(v)) return [video(v)];
    let m = u.pathname.match(/^\/(?:live|embed|shorts)\/([\w-]{11})/);
    if (m) return [video(m[1])];
    m = u.pathname.match(/^\/@([\w.-]+)/);
    if (m) return [handle(m[1])];
    m = u.pathname.match(/^\/channel\/(UC[\w-]{22})/);
    if (m) return [channel(m[1])];
    return [];
  }

  if (s.startsWith('@')) return /^@[\w.-]{3,30}$/.test(s) ? [handle(s.slice(1))] : [];
  if (/^UC[\w-]{22}$/.test(s)) return [channel(s)];
  if (YT_VIDEO_ID.test(s)) {
    // 11 chars can be a video ID or a short handle. Real IDs usually contain A-Z, "-" or "_".
    return /[A-Z_-]/.test(s) ? [video(s), handle(s)] : [handle(s), video(s)];
  }
  if (/^[\w.-]{3,30}$/.test(s)) return [handle(s)];
  return [];
}

const ytFetchHtml = async (url) => {
  const res = await fetch(url, {
    headers: {
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Cookie: 'SOCS=CAI; CONSENT=YES+1'
    },
    signal: AbortSignal.timeout(10000)
  });
  return res.text();
};

async function channelIdFromHandle(yt, handle) {
  try {
    const ep = await yt.resolveURL(`https://www.youtube.com/@${handle}`);
    const id = ep?.payload?.browseId;
    if (id) return id;
  } catch {}
  try {
    const html = await ytFetchHtml(`https://www.youtube.com/@${handle}`);
    const m = html.match(/"(?:channelId|externalId|browseId)":"(UC[\w-]{22})"/);
    if (m) return m[1];
  } catch {}
  return null;
}

function pickLiveVideoId(videos) {
  for (const v of videos || []) {
    const id = v?.video_id || v?.id || v?.content_id;
    if (!YT_VIDEO_ID.test(String(id))) continue;
    const badgeLive = (v?.badges || []).some?.((b) => /LIVE_NOW/i.test(String(b?.style || b?.label || '')));
    if (v?.is_live === true || badgeLive) return id;
  }
  return null;
}

// Fallback: <channel>/live redirects to the current stream when there is one.
async function liveIdFromLivePage(pathPart) {
  try {
    const html = await ytFetchHtml(`https://www.youtube.com/${pathPart}/live`);
    const m = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/);
    if (!m) return null;
    return /"isLiveNow":\s*true|"isLive":\s*true|"isLiveContent":\s*true/.test(html) ? m[1] : null;
  } catch {
    return null;
  }
}

async function findLiveVideoId(yt, t) {
  const livePath = t.type === 'handle' ? `@${t.value}` : `channel/${t.value}`;

  // 1. Scrape the channel's /live page (works without Innertube parsing).
  let id = await liveIdFromLivePage(livePath);
  if (id) { console.log(`[YouTube] ${t.label}: found live video ${id} via /live page`); return id; }

  // 2. Fall back to Innertube channel lookup.
  let channelId = t.value;
  if (t.type === 'handle') {
    channelId = await channelIdFromHandle(yt, t.value);
    if (!channelId) throw codeErr('NOT_FOUND', `YouTube channel @${t.value} not found`);
  }
  try {
    const channel = await yt.getChannel(channelId);
    if (channel.has_live_streams) id = pickLiveVideoId((await channel.getLiveStreams()).videos);
    if (!id) id = pickLiveVideoId(channel.videos);
  } catch (err) {
    console.error('[YouTube] Channel lookup failed:', err?.message || err);
  }
  if (!id) throw codeErr('NOT_LIVE', `${t.label} is not live right now`);
  console.log(`[YouTube] ${t.label}: found live video ${id} via Innertube`);
  return id;
}

// --- Chat parsing (raw InnerTube JSON; avoids the /player endpoint, which
// YouTube blocks with 403 for many server IPs) -------------------------------
const ytText = (t) => {
  if (!t) return '';
  if (t.simpleText) return t.simpleText;
  return (t.runs || []).map((r) => r.text ?? r.emoji?.shortcuts?.[0] ?? r.emoji?.emojiId ?? '').join('');
};

function ytItemToMessage(item, isSeen) {
  const paid = Boolean(item?.liveChatPaidMessageRenderer);
  const r = item?.liveChatTextMessageRenderer || item?.liveChatPaidMessageRenderer;
  if (!r) return null;

  const id = r.id ? `youtube-${r.id}` : null;
  if (id && isSeen(id)) return null;

  let text = ytText(r.message);
  if (paid) text = `\u{1F4B0} ${ytText(r.purchaseAmountText)} ${text}`.trim();
  if (!text) return null;

  return normalizeMessage('youtube', ytText(r.authorName) || 'Viewer', text, r.authorPhoto?.thumbnails?.[0]?.url || '', id);
}

function ytNextContinuation(conts) {
  const c = conts?.[0];
  const d = c?.invalidationContinuationData || c?.timedContinuationData || c?.reloadContinuationData;
  return d?.continuation ? { token: d.continuation, wait: d.timeoutMs } : null;
}

// Gets the first chat continuation from /next (no /player call).
async function ytChatStart(yt, videoId) {
  const res = await yt.actions.execute('/next', { videoId });
  const data = res?.data || res;
  const lc = data?.contents?.twoColumnWatchNextResults?.conversationBar?.liveChatRenderer;
  if (!lc || lc.isReplay) return null;
  return ytNextContinuation(lc.continuations);
}

async function connectYouTube(input) {
  disconnectPlatform('youtube');
  const targets = youTubeTargets(input);
  if (!targets.length) {
    return updatePlatformStatus('youtube', 'error', String(input), 'Use a @handle, channel URL, or video URL/ID');
  }
  const token = Symbol('yt');
  activeAdapters.youtube.token = token;
  updatePlatformStatus('youtube', 'connecting', targets[0].label);
  runYouTube(targets, token, targets[0].label);
}

async function runYouTube(targets, token, label) {
  const adapter = () => activeAdapters.youtube;
  const current = () => adapter().token === token;
  const watching = targets.some((t) => t.type !== 'video');

  const fail = (msg) => {
    console.error(`[YouTube] ${msg}`);
    if (current()) updatePlatformStatus('youtube', 'error', label, msg);
  };
  const retryLater = (why) => {
    if (!current()) return;
    console.log(`[YouTube] ${why}. Checking again in ${YT_RETRY_MS / 1000}s`);
    updatePlatformStatus('youtube', 'connecting', `${label} (${String(why).slice(0, 80)})`);
    clearTimeout(adapter().retry);
    adapter().retry = setTimeout(() => runYouTube(targets, token, label), YT_RETRY_MS);
  };

  try {
    const yt = await getInnertube();
    if (!current()) return;

    // 1. Find a live video ID.
    let videoId = null;
    let notLive = false;
    let lastErr = null;
    for (const t of targets) {
      try {
        videoId = t.type === 'video' ? t.value : await findLiveVideoId(yt, t);
        if (videoId) break;
      } catch (e) {
        lastErr = e;
        if (e.code === 'NOT_LIVE') notLive = true;
      }
    }
    if (!current()) return;
    if (!videoId) {
      if (notLive || watching) return retryLater(lastErr?.message || 'Not live');
      return fail(lastErr?.message || 'YouTube video not found');
    }

    // 2. Get the chat continuation (skips the blocked /player endpoint).
    let next = await ytChatStart(yt, videoId);
    if (!current()) return;
    if (!next) {
      return watching ? retryLater('No live chat yet') : fail('That video has no live chat right now');
    }

    // 3. Poll the chat.
    const isSeen = makeSeen(1000);
    let stopped = false;
    let firstPoll = true; // remember the backlog, do not replay it
    let failures = 0;
    let timer = null;

    const finish = (why, err) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      if (!current()) return;
      adapter().instance = null;
      if (watching) {
        ytClientPromise = null;
        return retryLater(why);
      }
      if (err) return fail(String(err?.message || err));
      updatePlatformStatus('youtube', 'disconnected');
    };

    const poll = async () => {
      if (stopped || !current()) return;
      let delay = 2000;
      try {
        const res = await yt.actions.execute('/live_chat/get_live_chat', { continuation: next.token });
        const data = res?.data || res;
        const lcc = data?.continuationContents?.liveChatContinuation;
        if (!lcc) return finish('Stream ended');

        failures = 0;
        for (const a of lcc.actions || []) {
          const msg = ytItemToMessage(a?.addChatItemAction?.item, isSeen);
          if (msg && !firstPoll) broadcastMessage(msg);
        }
        firstPoll = false;

        const n = ytNextContinuation(lcc.continuations);
        if (!n) return finish('Stream ended');
        next = n;
        delay = Math.min(Math.max(Number(n.wait) || 2000, 1000), 8000);
      } catch (err) {
        failures += 1;
        console.error(`[YouTube] Chat poll failed (${failures}):`, err?.message || err);
        if (failures >= 5) return finish('Chat error', err);
        delay = Math.min(2000 * failures, 10000);
      }
      if (!stopped && current()) timer = setTimeout(poll, delay);
    };

    adapter().instance = { stop: () => { stopped = true; clearTimeout(timer); } };
    console.log(`[YouTube] Connected to live chat of video ${videoId}`);
    updatePlatformStatus('youtube', 'connected', label);
    poll();
  } catch (err) {
    const msg = String(err?.message || err);
    console.error('[YouTube] Connect failed:', msg);
    ytClientPromise = null;
    if (watching) return retryLater(msg);
    fail(msg);
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
// 4. Kick: official API + webhooks.
// Setup: https://kick.com/settings/developer -> create an app, then set
//   env KICK_CLIENT_ID, KICK_CLIENT_SECRET
//   Webhook URL in the Kick app settings: https://YOUR-HOST/webhooks/kick
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

    broadcastMessage(
      normalizeMessage('kick', p.sender?.username, p.content, p.sender?.profile_picture || '', p.message_id ? `kick-${p.message_id}` : null)
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
        if (isSeen(id)) continue;
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
// 6. Facebook: not implemented. Reports that honestly instead of faking it.
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

// ---------------------------------------------------------------------------
// Overlay URL config:
//   /overlay.html?twitch=NAME&kick=NAME&youtube=@HANDLE&tiktok=NAME&rumble=URL
// The overlay page sends these over the socket and the server connects them.
// Reloading the overlay never restarts a platform already running for the same
// value, and changes are rate-limited because this endpoint has no password.
// Optional: set env OVERLAY_KEY and add &key=THAT_VALUE to require it.
// ---------------------------------------------------------------------------
const OVERLAY_PLATFORMS = ['twitch', 'kick', 'youtube', 'tiktok', 'rumble'];
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
