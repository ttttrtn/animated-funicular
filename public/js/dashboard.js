const socket = io();
const $ = (id) => document.getElementById(id);
const on = (id, ev, fn) => { const el = $(id); if (el) el[ev] = fn; }; // tolerate elements missing from the HTML

const post = async (u, b) => {
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
  if (!r.ok) alert((await r.json().catch(() => ({}))).error || 'Request failed');
  return r;
};

const NAMES = { instagram: 'INSTAGRAM', soop: 'SOOP' };
const status = {};
let saved = {};
try { saved = JSON.parse(localStorage.getItem('chatdash') || '{}'); } catch {}

function render() {
  const cards = $('cards');
  if (!cards) return;
  cards.innerHTML = Object.keys(NAMES).map((p) => `
    <div class="card" id="c-${p}">
      <div class="ch"><img src="/icons/${p}.svg"><h3>${NAMES[p]}</h3>
        <span class="badge disconnected" id="s-${p}">offline</span></div>
      ${p === 'soop' ? `<input type="text" id="h-soop" placeholder="SOOP BJ id" value="${(saved.soop || '').replace(/"/g, '&quot;')}">` : ''}
      <div class="row">
        <button class="btn primary" onclick="conn('${p}')">Connect</button>
        <button class="btn" onclick="disc('${p}')">Disconnect</button>
      </div>
      <input type="number" min="0" placeholder="Viewers (type from the app, 0 = clear)"
             onchange="post('/api/viewers',{platform:'${p}',count:this.value})">
      <div class="err" id="e-${p}"></div>
    </div>`).join('');
  Object.values(status).forEach(paint);
}

function paint(d) {
  const b = $('s-' + d.platform);
  if (!b) return;
  b.textContent = d.status;
  b.className = 'badge ' + d.status;
  $('e-' + d.platform).textContent = d.status === 'error' ? (d.error || d.handle) : '';
}

function conn(p) {
  if (p === 'soop') {
    const h = $('h-soop').value.trim();
    if (!h) return alert('Enter the SOOP BJ id first');
    saved.soop = h;
    localStorage.setItem('chatdash', JSON.stringify(saved));
    return post('/api/connect', { platform: 'soop', handle: h });
  }
  return post('/api/connect', { platform: p });
}
function disc(p) { post('/api/disconnect', { platform: p }); }

on('allBtn', 'onclick', () => { conn('instagram'); if (saved.soop) conn('soop'); });
on('clr', 'onclick', () => { $('feed').innerHTML = ''; });
on('swIcon', 'onchange', (e) => post('/api/settings', { showChannelIcon: e.target.checked }));
on('iconDel', 'onclick', () => fetch('/api/channel-icon', { method: 'DELETE' }));
on('iconFile', 'onchange', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const r = await fetch('/api/channel-icon', { method: 'POST', headers: { 'Content-Type': f.type }, body: f });
  if (!r.ok) alert((await r.json().catch(() => ({}))).error || 'Upload failed');
  e.target.value = '';
});
document.querySelectorAll('[data-copy]').forEach((b) => {
  const label = b.textContent;
  b.onclick = () => {
    navigator.clipboard.writeText(location.origin + b.dataset.copy);
    b.textContent = 'Copied!';
    setTimeout(() => { b.textContent = label; }, 1200);
  };
});

socket.on('statusUpdate', (d) => { status[d.platform] = d; paint(d); });

socket.on('settings', (s) => {
  const u = s.channelIconUrl;
  if ($('iconPrev')) { $('iconPrev').hidden = !u; if (u) $('iconPrev').src = u; }
  if ($('iconDel')) $('iconDel').hidden = !u;
  if ($('swIcon')) $('swIcon').checked = s.showChannelIcon;
});

socket.on('viewerCounts', (v) => {
  const t = Object.values(v).reduce((a, b) => a + b, 0);
  if ($('vc')) $('vc').textContent = Object.keys(v).length ? '👁 ' + t + ' viewers' : '';
});

socket.on('chatMessage', (m) => {
  const f = $('feed');
  if (!f) return;
  const icon = m.channelIcon && $('swIcon')?.checked ? m.channelIcon : '/icons/' + m.platform + '.svg';
  const d = document.createElement('div');
  d.className = 'm';
  d.innerHTML = `<img src="${icon}"><b>${m.username}:</b><span>${m.message}</span><time>${m.timestamp}</time>`;
  f.appendChild(d);
  while (f.children.length > 200) f.firstChild.remove();
  f.scrollTop = f.scrollHeight;
});

render();
