const socket = io();
const container = document.getElementById('overlayChatContainer');
const params = new URLSearchParams(window.location.search);
const maxMessages = parseInt(params.get('maxMessages') || '8', 10);
const fontSize = params.get('fontSize') || '15px';

// Random bright color per username (same person = same color every time).
function nameColor(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360}, 90%, 65%)`;
}

// The server escapes < and >. Turn them back into plain text; we only ever
// insert with textContent, so nothing a viewer types is parsed as HTML.
const decode = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

socket.on('chatMessage', (msg) => {
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
