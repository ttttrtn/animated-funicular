const socket = io();
socket.on('statusUpdate', (data) => {
  const badge = document.getElementById(`status-${data.platform}`);
  if (badge) { badge.textContent = data.status; badge.className = `status-badge ${data.status}`; }
});
socket.on('chatMessage', (msg) => { appendDashboardMessage(msg); });
function appendDashboardMessage(msg) {
  const feed = document.getElementById('dashboardChatFeed');
  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.innerHTML = `<img src="/icons/${msg.platform}.svg" class="p-icon"><span class="username">${msg.username}:</span><span class="text">${msg.message}</span><span class="time">${msg.timestamp}</span>`;
  feed.appendChild(div);
  feed.scrollTop = feed.scrollHeight;
}
function connectPlatform(platform) {
  const auth = document.getElementById('authPass').value;
  const handle = document.getElementById(`input-${platform}`).value;
  if (!auth) return alert('Please enter Dashboard Secret Key');
  if (!handle) return alert('Please enter channel handle/URL');
  fetch('/api/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auth, platform, handle }) });
}
function disconnectPlatform(platform) {
  const auth = document.getElementById('authPass').value;
  if (!auth) return alert('Please enter Dashboard Secret Key');
  fetch('/api/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auth, platform }) });
}
document.getElementById('clearChatBtn').addEventListener('click', () => { document.getElementById('dashboardChatFeed').innerHTML = ''; });
document.getElementById('copyOverlayBtn').addEventListener('click', () => {
  const overlayUrl = `${window.location.origin}/overlay.html`;
  navigator.clipboard.writeText(overlayUrl);
  alert(`OBS Overlay URL copied to clipboard:\n${overlayUrl}`);
});