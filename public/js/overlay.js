const socket = io();
const container = document.getElementById('overlayChatContainer');
const urlParams = new URLSearchParams(window.location.search);
const maxMessages = parseInt(urlParams.get('maxMessages') || '8', 10);
const fontSize = urlParams.get('fontSize') || '15px';
socket.on('chatMessage', (msg) => {
  const msgEl = document.createElement('div');
  msgEl.className = 'overlay-message';
  msgEl.style.fontSize = fontSize;
  msgEl.innerHTML = `<img src="/icons/${msg.platform}.svg" class="p-icon"><span class="username">${msg.username}:</span><span class="text">${msg.message}</span>`;
  container.appendChild(msgEl);
  while (container.children.length > maxMessages) { container.removeChild(container.firstChild); }
});