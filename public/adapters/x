'use strict';
// X (Twitter) broadcast live chat. There is no official API for broadcast chat,
// so this follows the same public web flow the X site itself uses (as
// documented by github.com/badlogic/twitter-broadcast-chat):
//   guest token -> broadcast metadata -> chat token -> Periscope chat access
//   token -> WebSocket /chatapi/v1/chatnow.
// No X login is needed; only PUBLIC broadcasts work. Unofficial and undocumented,
// so X can change it at any time.
const WebSocket = require('ws');

// X's public web-client bearer token (the same one x.com ships to every browser).
const BEARERS = [
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const RETRY_MS = 3000;
const MAX_FAILS = 6;
const SHORT_LIVED_MS = 5000; // a socket that closes this fast counts as a failure

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
  const res = await fetch(url, {
    ...init,
    headers: { 'user-agent': UA, ...(init.headers || {}) },
    signal: AbortSignal.timeout(12000)
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(`HTTP ${res.status} for ${new URL(url).host}`, res.status);
  try { return JSON.parse(text); } catch { throw new Error(`Invalid JSON from ${new URL(url).host}`); }
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
      const j = await requestJson('https://api.x.com/1.1/guest/activate.json', { method: 'POST', headers: apiHeaders(bearer) });
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
  const show = await requestJson(
    `https://x.com/i/api/1.1/broadcasts/show.json?ids=${encodeURIComponent(broadcastId)}`,
    { headers: apiHeaders(bearer, guest) }
  );
  const b = show.broadcasts?.[broadcastId];
  const mediaKey = b?.media_key;
  if (!mediaKey) throw new HttpError(`X broadcast ${broadcastId} not found (is it public?)`, 404);
  if (/ENDED|TIMED_OUT/i.test(String(b?.state || ''))) {
    throw Object.assign(new Error('This X broadcast has ended'), { ended: true });
  }

  const status = await requestJson(
    `https://x.com/i/api/1.1/live_video_stream/status/${encodeURIComponent(mediaKey)}?client=web&use_syndication_guest_id=false&cookie_set_host=x.com`,
    { headers: apiHeaders(bearer, guest) }
  );
  if (!status.chatToken) throw new Error('This broadcast has no chat');

  const access = await requestJson('https://proxsee-cf.pscp.tv/api/v2/accessChatPublic', {
    method: 'POST',
    headers: { ...PSCP_HEADERS, 'x-idempotence': `${Date.now()}` },
    body: JSON.stringify({ chat_token: status.chatToken })
  });
  const endpoint = access.endpoint || access.replay_endpoint;
  const accessToken = access.access_token || access.replay_access_token;
  if (!endpoint || !accessToken) throw new Error('Could not resolve the X chat server');
  return { broadcastId, endpoint, accessToken, state: b?.state, title: b?.status };
}

// One chat frame -> normalised message data, or null (not a chat line).
function parseChatFrame(frame, broadcastId) {
  if (!frame || frame.kind !== 1 || !frame.payload) return null;
  let outer;
  try { outer = JSON.parse(frame.payload); } catch { return null; }
  let inner = outer?.body;
  if (typeof inner === 'string') { try { inner = JSON.parse(inner); } catch { return null; } }
  const text = typeof inner?.body === 'string' ? inner.body.trim() : '';
  if (!text) return null;

  const pick = (...v) => v.find((x) => typeof x === 'string' && x) || '';
  const username = pick(inner?.username, outer?.sender?.username) || 'unknown';
  const displayName = pick(inner?.displayName, outer?.sender?.display_name) || username;
  const ts = typeof inner?.timestamp === 'number' ? inner.timestamp : Date.now();
  const uuid = pick(inner?.uuid) || `${broadcastId}:${username}:${ts}:${text}`;
  const avatar = pick(inner?.profileImageURL, inner?.profile_image_url, outer?.sender?.profile_image_url_https, outer?.sender?.profile_image_url);
  const verified = Boolean(inner?.verified || outer?.sender?.verified);
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
      ws = new WebSocket(url, { headers: { Origin: 'https://x.com', 'User-Agent': UA } });
      let openedAt = 0;

      ws.on('open', () => {
        openedAt = Date.now();
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
        let frame;
        try { frame = JSON.parse(String(data)); } catch { return; }
        const m = parseChatFrame(frame, b.broadcastId);
        if (!m || isSeen(`x-${m.uuid}`)) return;
        broadcastMessage(normalizeMessage(
          'x', m.displayName || m.username, m.text, m.avatar, `x-${m.uuid}`,
          m.verified ? [{ type: 'verified', label: 'Verified' }] : []
        ));
      });

      ws.on('error', (err) => console.error('[X] Socket error:', err?.message || err));
      ws.on('close', () => {
        clearInterval(pingTimer);
        if (openedAt && Date.now() - openedAt >= SHORT_LIVED_MS) fails = 0;
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
