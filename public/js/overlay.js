const socket = io();
const container = document.getElementById('overlayChatContainer');
const params = new URLSearchParams(window.location.search);
const maxMessages = parseInt(params.get('maxMessages') || '8', 10);
const fontSize = params.get('fontSize') || '20px';
const showBadges = params.get('badges') !== '0'; // add &badges=0 to hide badges

// ---- Connect platforms from the URL ---------------------------------------
// /overlay.html?twitch=NAME&kick=NAME&youtube=@HANDLE&tiktok=NAME&rumble=URL_OR_KEY&x=BROADCAST_URL
// (facebook=... and instagram=@NAME also need the server's OVERLAY_KEY and &key=...)
// (&key=... only if the server has OVERLAY_KEY set; &debug=1 shows connection status)
const config = {};
['twitch', 'kick', 'youtube', 'tiktok', 'rumble', 'x', 'facebook', 'instagram', 'key'].forEach((k) => {
  const v = params.get(k);
  if (v && v.trim()) config[k] = v.trim();
});
// Sent on every (re)connect of the socket. The server ignores repeats for
// platforms that are already running with the same value.
socket.on('connect', () => {
  if (Object.keys(config).length) socket.emit('overlayConnect', config);
});

// ---- Chat rendering ---------------------------------------------------------
// Random bright color per username (same person = same color every time).
function nameColor(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360}, 90%, 65%)`;
}

// The server HTML-escapes text. Turn it back into plain text; we only ever
// insert with textContent, so nothing a viewer types is parsed as HTML.
// (&amp; must be decoded last.)
const decode = (s) =>
  String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

// Last-resort emoji for badges whose image is missing or fails to load.
// Unknown types without an image are not shown.
const BADGE_ICONS = {
  broadcaster: '🎙️',
  owner: '👑',
  moderator: '🔧',
  vip: '💎',
  subscriber: '⭐',
  member: '⭐',
  verified: '✔️',
  founder: '🏅',
  og: '🏅',
  staff: '🛡️',
  admin: '🛡️',
  sidekick: '🛡️',
  sub_gifter: '🎁',
  subgifter: '🎁',
  gifter: '💎',
  fan: '💗',
  fans: '💗'
};

// Badge images: https (Twitch, YouTube, TikTok, Kick custom sub badges) or the
// icons this server hosts itself (/icons/kick/*.svg, /icons/tiktok/*.svg).
const BADGE_URL = /^(https:\/\/|\/icons\/(?:[\w-]+\/)*[\w-]+\.(?:svg|png|webp|gif|jpg)$)/i;

function emojiBadge(type) {
  if (!BADGE_ICONS[type]) return null;
  const el = document.createElement('span');
  el.className = 'badge-icon';
  el.textContent = BADGE_ICONS[type];
  return el;
}

function buildBadges(list) {
  if (!showBadges || !Array.isArray(list) || !list.length) return null;
  const wrap = document.createElement('span');
  wrap.className = 'badges';

  for (const b of list.slice(0, 6)) {
    if (!b) continue;
    const type = String(b.type || '').replace(/[^a-z0-9_-]/g, '');
    const label = decode(b.label || type);
    let el = null;

    if (typeof b.url === 'string' && BADGE_URL.test(b.url)) {
      el = document.createElement('img');
      el.className = 'badge';
      el.src = b.url;
      el.alt = label;
      el.onerror = () => {
        // Image failed: swap in the emoji for that type, or drop it.
        const fallback = emojiBadge(type);
        if (fallback) {
          fallback.title = label;
          if (type) fallback.classList.add(`badge-${type}`);
          el.replaceWith(fallback);
        } else {
          el.remove();
        }
      };
    } else {
      el = emojiBadge(type);
    }

    if (!el) continue;
    el.title = label;
    if (type) el.classList.add(`badge-${type}`);
    wrap.appendChild(el);
  }
  return wrap.children.length ? wrap : null;
}

let showIcon = params.get('channelIcon') === '1';
socket.on('settings', (s) => { if (params.get('channelIcon') === null) showIcon = !!s.showChannelIcon; });
const seen = new Set();
socket.on('chatMessage', (msg) => {
  if (msg.id) {
    if (seen.has(msg.id)) return;
    seen.add(msg.id);
    if (seen.size > 500) seen.delete(seen.values().next().value);
  }

  const row = document.createElement('div');
  row.className = 'overlay-message';
  row.style.fontSize = fontSize;

  const icon = document.createElement('img');
  icon.className = 'p-icon';
  icon.src = `/icons/${String(msg.platform).replace(/[^a-z]/g, '')}.svg`;
  if (showIcon && msg.channelIcon) { icon.src = msg.channelIcon; icon.style.borderRadius = '50%'; }
  icon.onerror = () => icon.remove();

  const badges = buildBadges(msg.badges);

  const name = document.createElement('span');
  name.className = 'username';
  name.style.color = nameColor(msg.username);
  name.textContent = decode(msg.username) + ':';

  const text = document.createElement('span');
  text.className = 'text';
  text.textContent = decode(msg.message);

  row.append(icon);
  if (badges) row.append(badges);
  row.append(name, text);
  container.appendChild(row);
  while (container.children.length > maxMessages) container.removeChild(container.firstChild);
});

// ---- Optional status line (add &debug=1) -------------------------------------
if (params.get('debug') === '1') {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;top:6px;left:8px;font:12px monospace;color:#fff;text-shadow:0 0 3px #000,0 0 3px #000;white-space:pre';
  document.body.appendChild(box);
  const states = {};
  socket.on('statusUpdate', (s) => {
    states[s.platform] = s.status + (s.status === 'error' ? ': ' + decode(s.error || s.handle) : '');
    box.textContent = Object.entries(states).map(([p, v]) => `${p}: ${v}`).join('\n');
  });
}
