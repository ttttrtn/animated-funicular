const socket = io();
const P = { youtube:'YouTube', twitch:'Twitch', kick:'Kick', tiktok:'TikTok', facebook:'Facebook', rumble:'Rumble', x:'X', instagram:'Instagram' };
const hint = { youtube:'@handle or channel URL', twitch:'channel name', kick:'channel slug', tiktok:'username (live)', facebook:'live video / page', rumble:'live URL', x:'broadcast URL', instagram:'@name' };
const $ = (id) => document.getElementById(id);
let saved = JSON.parse(localStorage.getItem('mgpt') || '{"added":["twitch","kick","youtube"],"handles":{}}');
const store = () => localStorage.setItem('mgpt', JSON.stringify(saved));
const post = (u, b) => fetch(u, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(b || {}) });
const status = {};

function render() {
  $('addSel').innerHTML = Object.keys(P).filter(p => !saved.added.includes(p)).map(p => `<option value="${p}">${P[p]}</option>`).join('') || '<option disabled>All added</option>';
  $('cards').innerHTML = saved.added.map(p => `
    <div class="card" id="c-${p}"><div class="ch"><img src="/icons/${p}.svg"><h3>${P[p].toUpperCase()}</h3>
      <span class="badge disconnected" id="s-${p}">offline</span><button class="x" title="Remove" onclick="removeP('${p}')">✕</button></div>
      <input type="text" id="h-${p}" placeholder="${hint[p]}" value="${(saved.handles[p]||'').replace(/"/g,'&quot;')}">
      <div class="row">${['twitch','kick','youtube','instagram'].includes(p) ? `<button class="btn" onclick="location.href='/auth/${p}'">Log in</button>` : ''}
      <button class="btn primary" onclick="conn('${p}')">Connect</button><button class="btn" onclick="disc('${p}')">Disconnect</button></div>
      ${['twitch','kick'].includes(p) ? '' : `<input type="number" min="0" placeholder="Viewers (type from the app, 0 = clear)" onchange="post('/api/viewers',{platform:'${p}',count:this.value})">`}
      <div class="err" id="e-${p}"></div></div>`).join('');
  saved.added.forEach(p => status[p] && paint(status[p]));
}
function paint(d) {
  const b = $('s-' + d.platform); if (!b) return;
  b.textContent = d.status; b.className = 'badge ' + d.status;
  $('e-' + d.platform).textContent = d.status === 'error' ? (d.error || d.handle) : '';
  if (d.status === 'connected' && d.handle && !$('h-' + d.platform).value) $('h-' + d.platform).value = d.handle;
}
function conn(p) { const h = $('h-' + p).value.trim(); if (!h) return alert('Enter a channel first'); saved.handles[p] = h; store(); post('/api/connect', { platform:p, handle:h }); }
function disc(p) { post('/api/disconnect', { platform:p }); }
function removeP(p) { disc(p); saved.added = saved.added.filter(x => x !== p); store(); render(); }
$('addBtn').onclick = () => { const v = $('addSel').value; if (P[v] && !saved.added.includes(v)) { saved.added.push(v); store(); render(); } };
$('allBtn').onclick = () => saved.added.forEach(p => saved.handles[p] && !(p === 'tiktok' && !$('swTikTok').checked) && conn(p));
$('swIcon').onchange = (e) => post('/api/settings', { showChannelIcon: e.target.checked });
$('swTikTok').onchange = (e) => post('/api/settings', { tiktokEnabled: e.target.checked });
$('clr').onclick = () => $('feed').innerHTML = '';
document.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => { const u = location.origin + b.dataset.copy; navigator.clipboard.writeText(u); b.textContent = 'Copied!'; setTimeout(() => b.textContent = b.textContent === 'Copied!' ? 'Copy ' + b.dataset.copy.slice(1,-5) : '', 1200); });

socket.on('statusUpdate', d => { status[d.platform] = d; if (d.status !== 'disconnected' && !saved.added.includes(d.platform) && P[d.platform]) { saved.added.push(d.platform); store(); render(); } paint(d); });
$('iconFile').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; const r = await fetch('/api/channel-icon', { method:'POST', headers:{'Content-Type': f.type}, body: f }); if (!r.ok) alert((await r.json().catch(() => ({}))).error || 'Upload failed'); e.target.value = ''; };
$('iconDel').onclick = () => fetch('/api/channel-icon', { method:'DELETE' });
socket.on('settings', s => { const u = s.channelIconUrl; $('iconPrev').hidden = $('iconDel').hidden = !u; if (u) $('iconPrev').src = u; $('swIcon').checked = s.showChannelIcon; $('swTikTok').checked = s.tiktokEnabled; });
socket.on('viewerCounts', v => { const t = Object.values(v).reduce((a, b) => a + b, 0); $('vc').textContent = Object.keys(v).length ? '👁 ' + t + ' viewers' : ''; });
socket.on('chatMessage', m => {
  const f = $('feed'), d = document.createElement('div'); d.className = 'm';
  d.innerHTML = `<img src="${m.channelIcon && $('swIcon').checked ? m.channelIcon : '/icons/' + m.platform + '.svg'}"><b>${m.username}:</b><span>${m.message}</span><time>${m.timestamp}</time>`;
  f.appendChild(d); while (f.children.length > 200) f.firstChild.remove(); f.scrollTop = f.scrollHeight;
});
(() => { const q = new URLSearchParams(location.search); const p = q.get('linked'), n = q.get('name');
  if (p && n && P[p]) { if (!saved.added.includes(p)) saved.added.push(p); saved.handles[p] = n; store(); history.replaceState({}, '', '/'); } })();
render();
