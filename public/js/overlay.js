const socket = io();
const container = document.getElementById('overlayChatContainer');
const params = new URLSearchParams(window.location.search);
const maxMessages = parseInt(params.get('maxMessages') || '8', 10);
const fontSize = params.get('fontSize') || '15px';

// ---- Connect platforms from the URL ---------------------------------------
// /overlay.html?twitch=NAME&kick=NAME&youtube=@HANDLE&tiktok=NAME&rumble=URL_OR_KEY
// (&key=... only if the server has OVERLAY_KEY set; &debug=1 shows connection status)
const config = {};
['twitch', 'kick', 'youtube', 'tiktok', 'rumble', 'key'].forEach((k) => {
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

// The server escapes < and >. Turn them back into plain text; we only ever
// insert with textContent, so nothing a viewer types is parsed as HTML.
const decode = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

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
  icon.onerror = () => icon.remove();

  const name = document.createElement('span');
  name.className = 'username';
  name.style.color = nameColor(msg.username);
  name.textContent = decode(msg.username) + ':';

  const text = document.createElement('span');
  text.className = 'text';
  text.textContent = decode(msg.message);

  row.append(icon, name, text);
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
