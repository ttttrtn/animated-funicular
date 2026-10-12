'use strict';
// X (Twitter) broadcast live chat. There is no official API for broadcast chat,
// so this follows the same public web flow the X site itself uses (as
// documented by github.com/badlogic/twitter-broadcast-chat):
//   guest token -> broadcast metadata -> chat token -> Periscope chat access
//   token -> WebSocket /chatapi/v1/chatnow.
// No X login is needed; only PUBLIC, currently LIVE broadcasts work.
// Unofficial and undocumented, so X can change it at any time.
//
// Debugging: run the server with X_DEBUG=1 to log every step and raw frames.
const WebSocket = require('ws');

// X's public web-client bearer token (the same one x.com ships to every browser).
const BEARERS = [
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Host fallbacks: X has been migrating twitter.com -> x.com, and either may be
// the one that answers depending on region/rollout.
const GUEST_URLS = [
  'https://api.x.com/1.1/guest/activate.json',
  'https://api.twitter.com/1.1/guest/activate.json'
];
const API_BASES = [
  'https://x.com/i/api/1.1',
  'https://api.x.com/1.1',
  'https://api.twitter.com/1.1'
];
const PSCP_URLS = [
  'https://proxsee-cf.pscp.tv/api/v2/accessChatPublic',
  'https://proxsee.pscp.tv/api/v2/accessChatPublic'
];

const RETRY_MS = 3000;
const MAX_FAILS = 6;
const SHORT_LIVED_MS = 5000; // a socket that closes this fast counts as a failure
const DEBUG = () => Boolean(process.env.X_DEBUG);
const dbg = (...a) => { if (DEBUG()) console.log('[X][debug]', ...a); };

class HttpError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function extractBroadcastId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:/i.test(s) ? s : `https://${s}`);
    const m = u.pathname.match(/^\/i\/broadcasts\/([A-Za-z0-9]+)/);
    if (m) return m[1];
  } catch {}
  return /^[A-Za-z0-9]{8,20}$/.test(s) ? s : null;
}

async function requestJson(url, init = {}) {
  const host = new URL(url).host;
  const res = await fetch(url, {
    ...init,
    headers: { 'user-agent': UA, ...(init.headers || {}) },
    signal: AbortSignal.timeout(12000)
  });
  const text = await res.text();
  if (!res.ok) {
    dbg(`HTTP ${res.status} ${host}`, text.slice(0, 200));
    throw new HttpError(`HTTP ${res.status} for ${host}`, res.status);
  }
  try { return JSON.parse(text); } catch { throw new Error(`Invalid JSON from ${host}`); }
}

// Try each candidate in order; return the first success, else throw the last error.
async function firstOk(candidates, make) {
  let last = null;
  for (const c of candidates) {
    try { return await make(c); } catch (e) { last = e; dbg('fallback after error:', e?.message || e); }
  }
  throw last || new Error('All endpoints failed');
}

let workingBearer = null;
function apiHeaders(bearer, guest) {
  return {
    authorization: `Bearer ${bearer}`,
    accept: 'application/json, text/plain, */*',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    ...(guest ? { 'x-guest-token': guest } : {})
  };
}

async function activateGuest() {
  const order = workingBearer ? [workingBearer] : BEARERS;
  let lastErr = null;
  for (const bearer of order) {
    try {
      const j = await firstOk(GUEST_URLS, (u) => requestJson(u, { method: 'POST', headers: apiHeaders(bearer) }));
      if (j.guest_token) { workingBearer = bearer; return { bearer, guest: j.guest_token }; }
    } catch (e) { lastErr = e; }
  }
  workingBearer = null;
  throw lastErr || new Error('Could not activate an X guest token');
}

const PSCP_HEADERS = {
  accept: '*/*',
  origin: 'https://x.com',
  referer: 'https://x.com/',
  'content-type': 'application/json',
  'x-periscope-user-agent': 'Twitter/m5',
  'x-attempt': '1'
};

async function bootstrapBroadcast(broadcastId) {
  const { bearer, guest } = await activateGuest();
  dbg('guest token ok');

  const show = await firstOk(API_BASES, (base) =>
    requestJson(`${base}/broadcasts/show.json?ids=${encodeURIComponent(broadcastId)}`,
      { headers: apiHeaders(bearer, guest) }));
  const b = show.broadcasts?.[broadcastId];
  const mediaKey = b?.media_key;
  if (!mediaKey) throw new HttpError(`X broadcast ${broadcastId} not found (is it public?)`, 404);
  dbg('broadcast state:', b?.state, 'media_key:', mediaKey);
  if (/ENDED|TIMED_OUT/i.test(String(b?.state || ''))) {
    throw Object.assign(new Error('This X broadcast has ended'), { ended: true });
  }

  const status = await firstOk(API_BASES, (base) =>
    requestJson(
      `${base}/live_video_stream/status/${encodeURIComponent(mediaKey)}?client=web&use_syndication_guest_id=false&cookie_set_host=x.com`,
      { headers: apiHeaders(bearer, guest) }));
  if (!status.chatToken) throw new Error('This broadcast has no chat');
  dbg('chat token ok');

  const access = await firstOk(PSCP_URLS, (u) =>
    requestJson(u, {
      method: 'POST',
      headers: { ...PSCP_HEADERS, 'x-idempotence': `${Date.now()}` },
      body: JSON.stringify({ chat_token: status.chatToken })
    }));
  const endpoint = access.endpoint || access.replay_endpoint;
  const accessToken = access.access_token || access.replay_access_token;
  if (!endpoint || !accessToken) throw new Error('Could not resolve the X chat server');
  dbg('chat endpoint:', endpoint);
  return { broadcastId, endpoint, accessToken, state: b?.state, title: b?.status };
}

// Parse a JSON string if it is one; pass objects through; else null.
function tryJson(v) {
  if (v && typeof v === 'object') return v;
  if (typeof v !== 'string') return null;
  try { return JSON.parse(v); } catch { return null; }
}

// One chat frame -> normalised message data, or null (not a chat line).
// Tolerant: accepts any frame kind, double-encoded or plain bodies, and several
// field-name variants, but requires both text and a username so that auth acks
// and presence/system frames are ignored.
function parseChatFrame(frame, broadcastId) {
  if (!frame || !frame.payload) return null;
  const outer = tryJson(frame.payload);
  if (!outer) return null;

  let inner = tryJson(outer.body);
  if (!inner) inner = { body: typeof outer.body === 'string' ? outer.body : '' };

  const text = typeof inner.body === 'string' ? inner.body.trim() : '';
  if (!text) return null;

  const sender = outer.sender || inner.sender || {};
  const pick = (...v) => v.find((x) => typeof x === 'string' && x) || '';
  const username = pick(inner.username, sender.username, sender.user_id);
  if (!username) return null;
  const displayName = pick(inner.displayName, inner.display_name, sender.display_name, sender.displayName) || username;
  const ts = typeof inner.timestamp === 'number' ? inner.timestamp : Date.now();
  const uuid = pick(inner.uuid, outer.uuid) || `${broadcastId}:${username}:${ts}:${text}`;
  const avatar = pick(
    inner.profileImageURL, inner.profile_image_url,
    sender.profile_image_url_https, sender.profile_image_url
  );
  const verified = Boolean(inner.verified || sender.verified);
  return { uuid, username, displayName, text, avatar, verified };
}

function init(ctx) {
  const { activeAdapters, updatePlatformStatus, normalizeMessage, broadcastMessage, makeSeen, disconnectPlatform } = ctx;

  async function connectX(input) {
    disconnectPlatform('x');
    const id = extractBroadcastId(input);
    if (!id) {
      return updatePlatformStatus('x', 'error', String(input), 'Paste an X broadcast URL (x.com/i/broadcasts/...) or its id');
    }
    const token = Symbol('x');
    activeAdapters.x.token = token;
    updatePlatformStatus('x', 'connecting', id);
    run(id, token);
  }

  function run(id, token) {
    const current = () => activeAdapters.x.token === token;
    const isSeen = makeSeen(2000);
    let fails = 0;
    let stopped = false;
    let ws = null;
    let pingTimer = null;
    let retryTimer = null;

    const stop = () => {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      try { ws?.close(); } catch {}
    };
    activeAdapters.x.instance = { stop };

    const openSocket = (b) => new Promise((resolve) => {
      const url = `${b.endpoint.replace(/^http/, 'ws').replace(/\/$/, '')}/chatapi/v1/chatnow`;
      dbg('opening socket', url);
      ws = new WebSocket(url, { headers: { Origin: 'https://x.com', 'User-Agent': UA } });
      let openedAt = 0;
      let framesSeen = 0;
      let msgsSent = 0;

      ws.on('open', () => {
        openedAt = Date.now();
        // 1) authenticate, 2) join the room
        ws.send(JSON.stringify({ payload: JSON.stringify({ access_token: b.accessToken }), kind: 3 }));
        ws.send(JSON.stringify({
          payload: JSON.stringify({ body: JSON.stringify({ room: b.broadcastId }), kind: 1 }),
          kind: 2
        }));
        clearInterval(pingTimer);
        pingTimer = setInterval(() => { try { ws.ping(); } catch {} }, 30000);
        console.log(`[X] Connected to broadcast ${id}${b.title ? ` ("${String(b.title).slice(0, 60)}")` : ''}`);
        if (current()) updatePlatformStatus('x', 'connected', id);
      });

      ws.on('message', (data) => {
        if (!current()) return;
        framesSeen += 1;
        const raw = String(data);
        if (DEBUG()) console.log(`[X][debug] frame #${framesSeen}:`, raw.slice(0, 400));
        let frame;
        try { frame = JSON.parse(raw); } catch { return; }
        const m = parseChatFrame(frame, b.broadcastId);
        if (!m || isSeen(`x-${m.uuid}`)) return;
        msgsSent += 1;
        broadcastMessage(normalizeMessage(
          'x', m.displayName || m.username, m.text, m.avatar, `x-${m.uuid}`,
          m.verified ? [{ type: 'verified', label: 'Verified' }] : []
        ));
      });

      // Handshake rejected (bad/expired token, blocked region, wrong endpoint).
      ws.on('unexpected-response', (_req, res) => {
        console.error(`[X] WebSocket upgrade rejected: HTTP ${res.statusCode}`);
        try { res.resume(); } catch {}
      });
      ws.on('error', (err) => console.error('[X] Socket error:', err?.message || err));
      ws.on('close', (code, reason) => {
        clearInterval(pingTimer);
        const lived = openedAt ? Date.now() - openedAt : 0;
        console.log(`[X] Socket closed (code ${code}${reason?.length ? `, ${String(reason).slice(0, 80)}` : ''}) after ${lived}ms, ${framesSeen} frames, ${msgsSent} chat messages`);
        if (openedAt && lived >= SHORT_LIVED_MS) fails = 0;
        else fails += 1;
        resolve();
      });
    });

    const attempt = async () => {
      if (stopped || !current()) return;
      try {
        const b = await bootstrapBroadcast(id);
        if (stopped || !current()) return;
        await openSocket(b);
      } catch (err) {
        if (err.ended) {
          updatePlatformStatus('x', 'error', id, err.message);
          return stop();
        }
        fails += 1;
        console.error(`[X] Attempt failed (${fails}):`, err?.message || err);
        if (err instanceof HttpError && err.status === 404) {
          updatePlatformStatus('x', 'error', id, String(err.message));
          return stop();
        }
      }
      if (stopped || !current()) return;
      if (fails >= MAX_FAILS) {
        updatePlatformStatus('x', 'error', id, 'Could not stay connected to this X broadcast (is it live and public?)');
        return stop();
      }
      updatePlatformStatus('x', 'connecting', `${id} (reconnecting)`);
      retryTimer = setTimeout(attempt, Math.min(RETRY_MS * 2 ** Math.min(fails, 4), 30000));
    };
    attempt();
  }

  return { connectX };
}

module.exports = { init, extractBroadcastId, parseChatFrame };
