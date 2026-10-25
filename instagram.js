'use strict';
// Instagram Live chat via the OFFICIAL API (your own lives, professional account).
//   GET /{ig-user-id}/live_media  ->  GET /{live-media-id}/comments
// Env: INSTAGRAM_ACCESS_TOKEN (required), INSTAGRAM_USER_ID (optional, default "me").

const GRAPH = 'https://graph.instagram.com';
const LIVE_POLL_MS = 3000;   // polling comments while live
const IDLE_POLL_MS = 15000;  // looking for a live

function init(ctx) {
  const { activeAdapters, updatePlatformStatus, normalizeMessage, broadcastMessage, disconnectPlatform, seen } = ctx;

  function connectInstagram() {
    disconnectPlatform('instagram');
    if (!process.env.INSTAGRAM_ACCESS_TOKEN) {
      return updatePlatformStatus('instagram', 'error', 'official', 'Set INSTAGRAM_ACCESS_TOKEN in the server environment');
    }
    const symbol = Symbol('instagram');
    activeAdapters.instagram.token = symbol;
    updatePlatformStatus('instagram', 'connecting', 'official');
    run(symbol);
  }

  function run(symbol) {
    const token = process.env.INSTAGRAM_ACCESS_TOKEN;
    const igUser = process.env.INSTAGRAM_USER_ID || 'me';
    let stopped = false;
    let timer = null;
    let liveId = null;
    let wasLive = null;
    const startedAt = Date.now();

    const stop = () => { stopped = true; clearTimeout(timer); };
    activeAdapters.instagram.instance = { stop };
    const alive = () => !stopped && activeAdapters.instagram.token === symbol;

    const get = async (p) => {
      const sep = p.includes('?') ? '&' : '?';
      const r = await fetch(`${GRAPH}${p}${sep}access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(12000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) {
        const e = new Error(j.error?.message || `HTTP ${r.status}`);
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
          console.log(`[Instagram] ${live ? `Live ${liveId} found` : 'No live right now'}`);
          wasLive = live;
          updatePlatformStatus('instagram', live ? 'connected' : 'connecting', live ? 'official' : 'official (not live right now)');
        }
        if (liveId) {
          const j = await get(`/${liveId}/comments?fields=id,text,username,timestamp`);
          for (const c of (j.data || []).slice().reverse()) {
            if (!c.text || !c.id) continue;
            const t = Date.parse(c.timestamp || '');
            if (Number.isFinite(t) && t < startedAt - 5000) continue; // posted before we joined
            const id = `instagram-${c.id}`;
            if (seen(id)) continue;
            broadcastMessage(normalizeMessage('instagram', c.username || 'Instagram user', c.text, '', id));
          }
        }
      } catch (err) {
        console.error('[Instagram] API error:', err.message || err);
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

  return { connectInstagram };
}

module.exports = { init };
