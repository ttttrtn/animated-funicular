'use strict';
// Facebook Live chat through the OFFICIAL Graph API.
//   Stream:  GET https://streaming-graph.facebook.com/{live-video-id}/live_comments
//            (Server-Sent Events, developers.facebook.com/docs/graph-api/server-sent-events/endpoints/live-comments)
//   Find live video: GET /{page-id}/live_videos?broadcast_status=["LIVE"]
//
// Setup (once):
//   1. Create an app at developers.facebook.com and add your Page.
//   2. Get a PAGE access token for the Page that is going live
//      (permissions: pages_show_list, pages_read_engagement, pages_read_user_content;
//       "Live Video API" needs App Review for pages you do not administer).
//   3. Put it in the server environment as FACEBOOK_ACCESS_TOKEN.
//
// Handle in the dashboard: "auto" (the token's own Page, finds its live video),
// a Page ID, a live video ID, or a facebook.com video URL.
const DEFAULT_GRAPH = 'https://graph.facebook.com';
const DEFAULT_STREAM = 'https://streaming-graph.facebook.com';
const RETRY_MS = 30000;
const FATAL_CODES = new Set([190, 102, 10, 200, 283, 3, 4, 17, 368]); // token / permission / rate-limit problems

class FbError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
    this.fatal = FATAL_CODES.has(code) || status === 401 || status === 403;
  }
}

function fbErrorFrom(json, status) {
  const e = json?.error || {};
  return new FbError(e.message || `Facebook API HTTP ${status}`, e.code, status);
}

// -> { kind: 'video'|'page'|'numeric', id }
function parseTarget(input) {
  const s = String(input || '').trim();
  if (!s || /^(auto|me)$/i.test(s)) return { kind: 'page', id: 'me' };
  if (/^\d{5,}$/.test(s)) return { kind: 'numeric', id: s };
  if (/facebook\.com|fb\.watch|fb\.com/i.test(s)) {
    const patterns = [/\/videos\/(\d{5,})/, /[?&]v=(\d{5,})/, /\/live\/(\d{5,})/, /\/reel\/(\d{5,})/, /\/posts\/(\d{5,})/];
    for (const re of patterns) {
      const m = s.match(re);
      if (m) return { kind: 'video', id: m[1] };
    }
    return null; // short links (fb.watch) cannot be resolved without a browser
  }
  return /^[\w.-]{3,}$/.test(s) ? { kind: 'page', id: s } : null;
}

// Parses a Server-Sent-Events byte stream; calls onData(jsonObject) per event.
async function readSse(body, onData) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data) continue;
      try { onData(JSON.parse(data)); } catch {}
    }
  }
}

function init(ctx, opts = {}) {
  const { activeAdapters, updatePlatformStatus, normalizeMessage, broadcastMessage, makeSeen, disconnectPlatform } = ctx;
  const GRAPH = opts.graphBase || DEFAULT_GRAPH;
  const STREAM = opts.streamBase || DEFAULT_STREAM;
  const retryMs = opts.retryMs || RETRY_MS;
  const getToken = () => process.env.FACEBOOK_ACCESS_TOKEN || process.env.FACEBOOK_PAGE_TOKEN || '';

  async function graph(pathAndQuery, token) {
    const sep = pathAndQuery.includes('?') ? '&' : '?';
    const res = await fetch(`${GRAPH}${pathAndQuery}${sep}access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(12000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.error) throw fbErrorFrom(j, res.status);
    return j;
  }

  async function liveVideoOfPage(pageId, token) {
    const q = new URLSearchParams({ broadcast_status: JSON.stringify(['LIVE']), fields: 'id,title,status' });
    const j = await graph(`/${encodeURIComponent(pageId)}/live_videos?${q}`, token);
    return j.data?.[0]?.id || null;
  }

  // Returns a live video id, or null when nothing is live right now.
  async function resolveLive(target, token) {
    if (target.kind === 'video') return target.id;
    if (target.kind === 'numeric') {
      try {
        const j = await graph(`/${target.id}?fields=live_status`, token);
        if (j.live_status) return target.id; // it is a video
      } catch (e) {
        if (e.fatal) throw e;
      }
      return liveVideoOfPage(target.id, token); // otherwise treat it as a Page id
    }
    return liveVideoOfPage(target.id, token);
  }

  async function connectFacebook(input) {
    disconnectPlatform('facebook');
    const label = String(input || '').slice(0, 60) || 'auto';
    const token = getToken();
    if (!token) {
      return updatePlatformStatus('facebook', 'error', label, 'Set FACEBOOK_ACCESS_TOKEN (a Page access token) in the server environment');
    }
    const target = parseTarget(input);
    if (!target) {
      return updatePlatformStatus('facebook', 'error', label, 'Use "auto", a Page ID, a live video ID, or a facebook.com video URL');
    }
    const symbol = Symbol('facebook');
    activeAdapters.facebook.token = symbol;
    updatePlatformStatus('facebook', 'connecting', label);
    run(target, token, symbol, label);
  }

  function run(target, token, symbol, label) {
    const current = () => activeAdapters.facebook.token === symbol;
    const isSeen = makeSeen(2000);
    let stopped = false;
    let retryTimer = null;
    let abort = null;

    const stop = () => {
      stopped = true;
      clearTimeout(retryTimer);
      try { abort?.abort(); } catch {}
    };
    activeAdapters.facebook.instance = { stop };

    const retryLater = (why) => {
      if (stopped || !current()) return;
      console.log(`[Facebook] ${why}. Checking again in ${Math.round(retryMs / 1000)}s`);
      updatePlatformStatus('facebook', 'connecting', `${label} (${String(why).slice(0, 80)})`);
      retryTimer = setTimeout(loop, retryMs);
    };

    const loop = async () => {
      if (stopped || !current()) return;
      try {
        const videoId = await resolveLive(target, token);
        if (stopped || !current()) return;
        if (!videoId) return retryLater('Not live right now');

        const startedAt = Date.now();
        abort = new AbortController();
        const q = new URLSearchParams({
          access_token: token,
          comment_rate: 'ten_per_second',
          fields: 'from{name,id},message,created_time'
        });
        const res = await fetch(`${STREAM}/${videoId}/live_comments?${q}`, {
          headers: { Accept: 'text/event-stream' },
          signal: abort.signal
        });
        if (!res.ok) throw fbErrorFrom(await res.json().catch(() => ({})), res.status);

        console.log(`[Facebook] Streaming live comments of video ${videoId}`);
        if (current()) updatePlatformStatus('facebook', 'connected', label);

        await readSse(res.body, (c) => {
          if (!current() || !c?.message) return;
          const created = Date.parse(c.created_time || '');
          if (Number.isFinite(created) && created < startedAt - 5000) return; // backlog from before we joined
          const id = c.id ? `facebook-${c.id}` : null;
          if (id && isSeen(id)) return;
          broadcastMessage(normalizeMessage('facebook', c.from?.name || 'Facebook user', c.message, '', id, []));
        });
        retryLater('Stream ended');
      } catch (err) {
        if (stopped || !current()) return;
        const msg = String(err?.message || err);
        console.error('[Facebook] Error:', msg);
        if (err.fatal) {
          updatePlatformStatus('facebook', 'error', label, `${msg} (check FACEBOOK_ACCESS_TOKEN and its permissions)`);
          return stop();
        }
        retryLater(msg);
      }
    };
    loop();
  }

  return { connectFacebook };
}

module.exports = { init, parseTarget, readSse };
