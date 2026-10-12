'use strict';
// X live chat via the OFFICIAL X Activity API (event: broadcast.chat).
// Works for broadcasts owned by the X user who authorized your app only.
// X POSTs each chat message to this webhook while that user is live.
//
// Env:
//   X_API_SECRET   your app's API Key Secret (consumer secret). Used for the
//                  CRC check and for verifying delivery signatures.
//   X_USER_ID      optional: only accept events for this broadcaster user id.
//   X_DEBUG=1      log the raw body of every delivery (first 800 chars).
//   X_WEBHOOK_INSECURE=1  skip signature verification (see note below).
//
// Wire it in server.js BEFORE app.use(express.json(...)):
//   require('./xwebhook').init({ app, express, normalizeMessage, broadcastMessage, makeSeen });
//
// NOTE: the CRC response and the signature header below follow X's classic
// webhook scheme (HMAC-SHA256 with the consumer secret, base64, "sha256=" prefix).
// I could not confirm the Activity API uses the identical scheme. If X rejects
// the CRC or your deliveries log "bad signature", check the Webhooks guide on
// docs.x.com and tell me what differs.
const crypto = require('crypto');

const firstStr = (...v) => v.find((x) => typeof x === 'string' && x.trim()) || '';
const dbg = (...a) => { if (process.env.X_DEBUG) console.log('[X Webhook][debug]', ...a); };

const hmacB64 = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest('base64');

function safeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// One XAA envelope ({ data: { event_type, payload, includes, ... } }) -> message data or null.
// Field names inside `payload` are matched loosely because the docs only list
// the content ("broadcast_id, message_id, message text, is_subscriber, author block").
function parseChatEvent(d) {
  if (!d || d.event_type !== 'broadcast.chat') return null;
  const p = d.payload || {};
  const text = firstStr(p.text, p.message, p.message_text, p.body, p.chat?.text, p.chat?.message);
  if (!text) return null;

  const a = p.author || p.user || d.includes?.users?.[0] || {};
  const username = firstStr(a.username, a.screen_name, a.handle) || 'unknown';
  const displayName = firstStr(a.name, a.display_name, a.displayName) || username;
  const avatar = firstStr(a.profile_image_url, a.profile_image_url_https, a.profile_image);
  const uuid = firstStr(String(p.message_id || ''), String(p.id || ''), String(d.event_uuid || '')) ||
    `${p.broadcast_id || 'b'}:${username}:${text}`;
  const badges = [];
  if (a.verified || a.is_verified) badges.push({ type: 'verified', label: 'Verified' });
  if (p.is_subscriber) badges.push({ type: 'subscriber', label: 'Subscriber' });
  return { uuid, username, displayName, text, avatar, badges, broadcastId: p.broadcast_id || '' };
}

function init({ app, express, normalizeMessage, broadcastMessage, makeSeen }) {
  const secret = process.env.X_API_SECRET || '';
  const onlyUser = process.env.X_USER_ID || '';
  const insecure = process.env.X_WEBHOOK_INSECURE === '1';
  const isSeen = makeSeen(2000);

  // CRC challenge: X calls this when the webhook is registered and periodically after.
  app.get('/webhooks/x', (req, res) => {
    const crc = req.query.crc_token;
    if (!crc || !secret) return res.status(400).json({ error: 'crc_token or X_API_SECRET missing' });
    res.json({ response_token: `sha256=${hmacB64(String(crc), secret)}` });
  });

  // Deliveries. Raw body is needed for signature verification.
  app.post('/webhooks/x', express.raw({ type: '*/*', limit: '500kb' }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    dbg('delivery:', raw.toString('utf8').slice(0, 800));

    if (!insecure) {
      const given = req.headers['x-twitter-webhooks-signature'] || '';
      const ok = secret && given && safeEq(given, `sha256=${hmacB64(raw, secret)}`);
      if (!ok) {
        console.warn('[X Webhook] Rejected: bad or missing signature (set X_WEBHOOK_INSECURE=1 to test without it)');
        return res.status(401).end();
      }
    }
    res.status(200).end(); // answer fast, then process

    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return; }
    const events = Array.isArray(body?.data) ? body.data : [body?.data || body];
    for (const d of events) {
      if (onlyUser && String(d?.filter?.user_id || '') !== onlyUser) continue;
      const m = parseChatEvent(d);
      if (!m || isSeen(`x-${m.uuid}`)) continue;
      broadcastMessage(normalizeMessage('x', m.displayName || m.username, m.text, m.avatar, `x-${m.uuid}`, m.badges));
    }
  });

  console.log('[X Webhook] Listening at /webhooks/x (official Activity API)');
}

module.exports = { init, parseChatEvent };
