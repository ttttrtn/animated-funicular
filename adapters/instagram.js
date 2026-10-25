'use strict';
// Instagram Live chat, OFFICIAL API only (your own lives, professional account).
//   GET /{ig-user-id}/live_media  then  GET /{live-media-id}/comments
// Needs INSTAGRAM_ACCESS_TOKEN (and optionally INSTAGRAM_USER_ID, default "me").
// No browser, Chrome, or Puppeteer is used. Whatever handle is entered in the
// dashboard is ignored; the connection always uses the official API.

const OFFICIAL_GRAPH = 'https://graph.instagram.com';
const LIVE_POLL_MS = 3000;   // polling comments while live
const IDLE_POLL_MS = 15000;  // looking for a live

function init(ctx, opts = {}) {
  const { activeAdapters, updatePlatformStatus, normalizeMessage, broadcastMessage, makeSeen, disconnectPlatform } = ctx;

  async function connectInstagram() {
    disconnectPlatform('instagram');
    if (!process.env.INSTAGRAM_ACCESS_TOKEN) {
      return updatePlatformStatus('instagram', 'error', 'official', 'Set INSTAGRAM_ACCESS_TOKEN (Instagram API with Instagram Login) in the server environment');
    }
    const symbol = Symbol('instagram');
    activeAdapters.instagram.token = symbol;
    updatePlatformStatus('instagram', 'connecting', 'official');
    runOfficial(symbol);
  }

  function runOfficial(symbol) {
    const current = () => activeAdapters.instagram.token === symbol;
    const token = process.env.INSTAGRAM_ACCESS_TOKEN;
    const igUser = process.env.INSTAGRAM_USER_ID || 'me';
    const base = opts.officialBase || OFFICIAL_GRAPH;
    const isSeen = makeSeen(1000);
    let stopped = false;
    let timer = null;
    let liveId = null;
    let wasLive = null;
    let fails = 0;
    const startedAt = Date.now();

    const stop = () => { stopped = true; clearTimeout(timer); };
    activeAdapters.instagram.instance = { stop };
    const alive = () => !stopped && current();

    const get = async (p) => {
      const sep = p.includes('?') ? '&' : '?';
      const r = await fetch(`${base}${p}${sep}access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(12000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) {
        const e = new Error(j.error?.message || `HTTP ${r.status}`);
        e.code = j.error?.code;
        e.fatal = [190, 10, 200].includes(j.error?.code) || r.status === 401 || r.status === 403;
        throw e;
      }
      return j;
    };

    const tick = async () => {
      if (!alive()) return;
      try {
        if (!liveId) {
          const j = await get(`/${encodeURIComponent(igUser)}/live_media?fields=id`);
          liveId = j.data?.[0]?.id || null;
        }
        const live = Boolean(liveId);
        if (live !== wasLive) {
          console.log(`[Instagram] ${live ? `Live ${liveId} found` : 'No live right now'} (official API)`);
          wasLive = live;
          updatePlatformStatus('instagram', live ? 'connected' : 'connecting', live ? 'official' : 'official (not live right now)');
        }
        if (liveId) {
          const j = await get(`/${liveId}/comments?fields=id,text,username,timestamp`);
          fails = 0;
          for (const c of (j.data || []).slice().reverse()) {
            if (!c.text || !c.id) continue;
            const t = Date.parse(c.timestamp || '');
            if (Number.isFinite(t) && t < startedAt - 5000) continue; // posted before we joined
            const id = `instagram-${c.id}`;
            if (isSeen(id)) continue;
            broadcastMessage(normalizeMessage('instagram', c.username || 'Instagram user', c.text, '', id, []));
          }
        }
      } catch (err) {
        fails += 1;
        console.error(`[Instagram] Official API error (${fails}):`, err?.message || err);
        if (err.fatal) {
          updatePlatformStatus('instagram', 'error', 'official', `${err.message} (check INSTAGRAM_ACCESS_TOKEN)`);
          return stop();
        }
        liveId = null; // the live probably ended; look again
        wasLive = null;
      }
      if (alive()) timer = setTimeout(tick, liveId ? LIVE_POLL_MS : IDLE_POLL_MS);
    };
    tick();
  }

  // Kept so a dashboard "log in" button or server code that calls it doesn't break.
  async function openLogin() { return true; }

  return { connectInstagram, openLogin };
}

module.exports = { init };'use strict';
// Instagram Live chat, OFFICIAL API only (your own lives, professional account).
//   GET /{ig-user-id}/live_media  then  GET /{live-media-id}/comments
// Needs INSTAGRAM_ACCESS_TOKEN (and optionally INSTAGRAM_USER_ID, default "me").
// No browser, Chrome, or Puppeteer is used. Whatever handle is entered in the
// dashboard is ignored; the connection always uses the official API.

const OFFICIAL_GRAPH = 'https://graph.instagram.com';
const LIVE_POLL_MS = 3000;   // polling comments while live
const IDLE_POLL_MS = 15000;  // looking for a live

function init(ctx, opts = {}) {
  const { activeAdapters, updatePlatformStatus, normalizeMessage, broadcastMessage, makeSeen, disconnectPlatform } = ctx;

  async function connectInstagram() {
    disconnectPlatform('instagram');
    if (!process.env.INSTAGRAM_ACCESS_TOKEN) {
      return updatePlatformStatus('instagram', 'error', 'official', 'Set INSTAGRAM_ACCESS_TOKEN (Instagram API with Instagram Login) in the server environment');
    }
    const symbol = Symbol('instagram');
    activeAdapters.instagram.token = symbol;
    updatePlatformStatus('instagram', 'connecting', 'official');
    runOfficial(symbol);
  }

  function runOfficial(symbol) {
    const current = () => activeAdapters.instagram.token === symbol;
    const token = process.env.INSTAGRAM_ACCESS_TOKEN;
    const igUser = process.env.INSTAGRAM_USER_ID || 'me';
    const base = opts.officialBase || OFFICIAL_GRAPH;
    const isSeen = makeSeen(1000);
    let stopped = false;
    let timer = null;
    let liveId = null;
    let wasLive = null;
    let fails = 0;
    const startedAt = Date.now();

    const stop = () => { stopped = true; clearTimeout(timer); };
    activeAdapters.instagram.instance = { stop };
    const alive = () => !stopped && current();

    const get = async (p) => {
      const sep = p.includes('?') ? '&' : '?';
      const r = await fetch(`${base}${p}${sep}access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(12000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) {
        const e = new Error(j.error?.message || `HTTP ${r.status}`);
        e.code = j.error?.code;
        e.fatal = [190, 10, 200].includes(j.error?.code) || r.status === 401 || r.status === 403;
        throw e;
      }
      return j;
    };

    const tick = async () => {
      if (!alive()) return;
      try {
        if (!liveId) {
          const j = await get(`/${encodeURIComponent(igUser)}/live_media?fields=id`);
          liveId = j.data?.[0]?.id || null;
        }
        const live = Boolean(liveId);
        if (live !== wasLive) {
          console.log(`[Instagram] ${live ? `Live ${liveId} found` : 'No live right now'} (official API)`);
          wasLive = live;
          updatePlatformStatus('instagram', live ? 'connected' : 'connecting', live ? 'official' : 'official (not live right now)');
        }
        if (liveId) {
          const j = await get(`/${liveId}/comments?fields=id,text,username,timestamp`);
          fails = 0;
          for (const c of (j.data || []).slice().reverse()) {
            if (!c.text || !c.id) continue;
            const t = Date.parse(c.timestamp || '');
            if (Number.isFinite(t) && t < startedAt - 5000) continue; // posted before we joined
            const id = `instagram-${c.id}`;
            if (isSeen(id)) continue;
            broadcastMessage(normalizeMessage('instagram', c.username || 'Instagram user', c.text, '', id, []));
          }
        }
      } catch (err) {
        fails += 1;
        console.error(`[Instagram] Official API error (${fails}):`, err?.message || err);
        if (err.fatal) {
          updatePlatformStatus('instagram', 'error', 'official', `${err.message} (check INSTAGRAM_ACCESS_TOKEN)`);
          return stop();
        }
        liveId = null; // the live probably ended; look again
        wasLive = null;
      }
      if (alive()) timer = setTimeout(tick, liveId ? LIVE_POLL_MS : IDLE_POLL_MS);
    };
    tick();
  }

  // Kept so a dashboard "log in" button or server code that calls it doesn't break.
  async function openLogin() { return true; }

  return { connectInstagram, openLogin };
}

module.exports = { init };
