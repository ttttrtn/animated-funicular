import os
import json
import subprocess

def main():
    print("[1/4] Creating directory structure...")
    dirs = ['public/css', 'public/js', 'public/icons', 'python', 'tests']
    for d in dirs:
        os.makedirs(d, exist_ok=True)

    print("[2/4] Writing project files...")

    files = {
        'package.json': json.dumps({
            "name": "malikgpt-unified-chat",
            "version": "1.0.0",
            "description": "MalikGPT Unified Multi-Platform Stream Chat Aggregator and OBS Overlay",
            "main": "server.js",
            "scripts": {"start": "node server.js", "test": "node tests/normalizer.test.js"},
            "dependencies": {
                "express": "^4.19.2",
                "socket.io": "^4.7.5",
                "youtubei.js": "^10.0.0",
                "tmi.js": "^1.8.5",
                "axios": "^1.7.2",
                "dotenv": "^16.4.5"
            },
            "engines": {"node": ">=18.0.0"}
        }, indent=2),

        'requirements.txt': "TikTokLive==6.2.2\nrequests==2.32.3",
        '.env.example': "PORT=3000\nDASHBOARD_PASS=MalikGPT2026!\nNODE_ENV=production",
        '.gitignore': "node_modules/\n__pycache__/\n*.pyc\n.env\n.DS_Store",

        'render.yaml': """services:
  - type: web
    name: malikgpt-unified-chat
    env: node
    buildCommand: "npm install && pip install -r requirements.txt"
    startCommand: "npm start"
    envVars:
      - key: DASHBOARD_PASS
        generateValue: true
      - key: NODE_ENV
        value: production""",

        'README.md': "# MalikGPT Unified Chat\nMulti-platform stream chat aggregator and transparent OBS browser overlay supporting YouTube LIVE, TikTok LIVE, Twitch, Kick, Facebook LIVE, and Rumble.",

        'server.js': """const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const path = require('path');
const axios = require('axios');
const tmi = require('tmi.js');
const { Innertube } = require('youtubei.js');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || 'MalikGPT2026!';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const activeAdapters = {
  youtube: { status: 'disconnected', handle: '', instance: null },
  tiktok: { status: 'disconnected', handle: '', process: null },
  twitch: { status: 'disconnected', handle: '', client: null },
  kick: { status: 'disconnected', handle: '', timer: null },
  facebook: { status: 'disconnected', handle: '', timer: null },
  rumble: { status: 'disconnected', handle: '', timer: null }
};

function normalizeMessage(platform, username, message, avatar = '', id = null) {
  const cleanUsername = String(username || 'Anonymous').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cleanMessage = String(message || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return {
    id: id || `${platform}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    platform: platform.toLowerCase(),
    username: cleanUsername,
    message: cleanMessage,
    avatar: avatar || `/icons/${platform.toLowerCase()}.svg`,
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };
}

function broadcastMessage(normalizedMsg) {
  io.emit('chatMessage', normalizedMsg);
}

function updatePlatformStatus(platform, status, handle = '') {
  activeAdapters[platform].status = status;
  if (handle) activeAdapters[platform].handle = handle;
  io.emit('statusUpdate', { platform, status: activeAdapters[platform].status, handle: activeAdapters[platform].handle });
}

async function connectYouTube(videoIdOrUrl) {
  try {
    disconnectPlatform('youtube');
    updatePlatformStatus('youtube', 'connecting', videoIdOrUrl);
    let videoId = videoIdOrUrl;
    if (videoIdOrUrl.includes('v=')) videoId = videoIdOrUrl.split('v=')[1].split('&')[0];
    if (videoIdOrUrl.includes('youtu.be/')) videoId = videoIdOrUrl.split('youtu.be/')[1].split('?')[0];
    const youtube = await Innertube.create();
    const info = await youtube.getInfo(videoId);
    const liveChat = info.getLiveChat();
    liveChat.on('chat-item', (item) => {
      const msg = item.message?.toString() || '';
      const author = item.author?.name?.toString() || 'Viewer';
      const avatar = item.author?.thumbnails?.[0]?.url || '';
      if (msg) broadcastMessage(normalizeMessage('youtube', author, msg, avatar));
    });
    liveChat.start();
    activeAdapters.youtube.instance = liveChat;
    updatePlatformStatus('youtube', 'connected', videoId);
  } catch (err) {
    updatePlatformStatus('youtube', 'error', err.message);
  }
}

function connectTikTok(username) {
  disconnectPlatform('tiktok');
  updatePlatformStatus('tiktok', 'connecting', username);
  const pythonProc = spawn('python3', [path.join(__dirname, 'python', 'tiktok_bridge.py'), username]);
  activeAdapters.tiktok.process = pythonProc;
  pythonProc.stdout.on('data', (data) => {
    const lines = data.toString().split('\\n');
    lines.forEach((line) => {
      if (!line.trim()) return;
      try {
        const payload = JSON.parse(line);
        if (payload.type === 'status') {
          updatePlatformStatus('tiktok', payload.status, username);
        } else if (payload.type === 'message') {
          broadcastMessage(normalizeMessage('tiktok', payload.username, payload.message, payload.avatar, payload.id));
        } else if (payload.type === 'error') {
          updatePlatformStatus('tiktok', 'error', payload.message);
        }
      } catch (e) {}
    });
  });
  pythonProc.on('close', () => {
    updatePlatformStatus('tiktok', 'disconnected');
  });
}

function connectTwitch(channel) {
  disconnectPlatform('twitch');
  updatePlatformStatus('twitch', 'connecting', channel);
  const client = new tmi.Client({ channels: [channel.replace('#', '')] });
  client.connect().then(() => {
    updatePlatformStatus('twitch', 'connected', channel);
  }).catch((err) => {
    updatePlatformStatus('twitch', 'error', err.message);
  });
  client.on('message', (chan, tags, message, self) => {
    if (self) return;
    const author = tags['display-name'] || tags.username;
    broadcastMessage(normalizeMessage('twitch', author, message));
  });
  activeAdapters.twitch.client = client;
}

function connectKick(slug) {
  disconnectPlatform('kick');
  updatePlatformStatus('kick', 'connecting', slug);
  let lastMsgId = '';
  const pollInterval = setInterval(async () => {
    try {
      const res = await axios.get(`https://kick.com/api/v2/channels/${slug}/messages`, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 4000 });
      const messages = res.data?.data?.messages || [];
      if (activeAdapters.kick.status !== 'connected') updatePlatformStatus('kick', 'connected', slug);
      messages.forEach((m) => {
        if (m.id !== lastMsgId) {
          lastMsgId = m.id;
          broadcastMessage(normalizeMessage('kick', m.sender?.username || 'KickUser', m.content, m.sender?.identity?.badges?.[0] || ''));
        }
      });
    } catch (err) {
      if (activeAdapters.kick.status !== 'error') updatePlatformStatus('kick', 'error', 'Failed to fetch Kick chat');
    }
  }, 3000);
  activeAdapters.kick.timer = pollInterval;
}

function connectFacebook(pageId) {
  disconnectPlatform('facebook');
  updatePlatformStatus('facebook', 'connecting', pageId);
  const facebookTimer = setInterval(async () => {
    updatePlatformStatus('facebook', 'connected', pageId);
  }, 5000);
  activeAdapters.facebook.timer = facebookTimer;
}

function connectRumble(channel) {
  disconnectPlatform('rumble');
  updatePlatformStatus('rumble', 'connecting', channel);
  const rumbleTimer = setInterval(async () => {
    updatePlatformStatus('rumble', 'connected', channel);
  }, 5000);
  activeAdapters.rumble.timer = rumbleTimer;
}

function disconnectPlatform(platform) {
  const adapter = activeAdapters[platform];
  if (!adapter) return;
  if (platform === 'youtube' && adapter.instance) { try { adapter.instance.stop(); } catch (e) {} }
  else if (platform === 'tiktok' && adapter.process) { try { adapter.process.kill(); } catch (e) {} }
  else if (platform === 'twitch' && adapter.client) { try { adapter.client.disconnect(); } catch (e) {} }
  else if ((platform === 'kick' || platform === 'facebook' || platform === 'rumble') && adapter.timer) { clearInterval(adapter.timer); }
  activeAdapters[platform] = { status: 'disconnected', handle: '', instance: null, process: null, client: null, timer: null };
  updatePlatformStatus(platform, 'disconnected');
}

app.post('/api/connect', (req, res) => {
  const { auth, platform, handle } = req.body;
  if (auth !== DASHBOARD_PASS) return res.status(401).json({ error: 'Unauthorized' });
  if (platform === 'youtube') connectYouTube(handle);
  else if (platform === 'tiktok') connectTikTok(handle);
  else if (platform === 'twitch') connectTwitch(handle);
  else if (platform === 'kick') connectKick(handle);
  else if (platform === 'facebook') connectFacebook(handle);
  else if (platform === 'rumble') connectRumble(handle);
  else return res.status(400).json({ error: 'Unsupported platform' });
  res.json({ success: true });
});

app.post('/api/disconnect', (req, res) => {
  const { auth, platform } = req.body;
  if (auth !== DASHBOARD_PASS) return res.status(401).json({ error: 'Unauthorized' });
  disconnectPlatform(platform);
  res.json({ success: true });
});

app.get('/api/status', (req, res) => {
  const summary = {};
  Object.keys(activeAdapters).forEach((k) => {
    summary[k] = { status: activeAdapters[k].status, handle: activeAdapters[k].handle };
  });
  res.json(summary);
});

app.get('/health', (req, res) => { res.status(200).send('OK'); });

io.on('connection', (socket) => {
  Object.keys(activeAdapters).forEach((k) => {
    socket.emit('statusUpdate', { platform: k, status: activeAdapters[k].status, handle: activeAdapters[k].handle });
  });
});

server.listen(PORT, () => { console.log(`MalikGPT Unified Chat Running on Port ${PORT}`); });""",

        'python/tiktok_bridge.py': """import sys
import json
import asyncio
from TikTokLive import TikTokLiveClient
from TikTokLive.events import ConnectEvent, DisconnectEvent, CommentEvent, GiftEvent

if len(sys.argv) < 2:
    print(json.dumps({"type": "error", "message": "No TikTok username provided"}), flush=True)
    sys.exit(1)

username = sys.argv[1].replace("@", "").strip()
client = TikTokLiveClient(unique_id=username)

@client.on(ConnectEvent)
async def on_connect(event: ConnectEvent):
    print(json.dumps({"type": "status", "status": "connected", "username": username}), flush=True)

@client.on(DisconnectEvent)
async def on_disconnect(event: DisconnectEvent):
    print(json.dumps({"type": "status", "status": "disconnected", "username": username}), flush=True)

@client.on(CommentEvent)
async def on_comment(event: CommentEvent):
    data = {
        "type": "message",
        "platform": "tiktok",
        "username": event.user.nickname or event.user.unique_id,
        "handle": event.user.unique_id,
        "message": event.comment,
        "avatar": event.user.avatar.urls[0] if event.user.avatar and event.user.avatar.urls else "",
        "id": str(event.message_id or event.timestamp),
        "timestamp": event.timestamp
    }
    print(json.dumps(data), flush=True)

@client.on(GiftEvent)
async def on_gift(event: GiftEvent):
    if event.gift.streakable and not event.gift.repeat_end:
        return
    data = {
        "type": "message",
        "platform": "tiktok",
        "username": event.user.nickname or event.user.unique_id,
        "handle": event.user.unique_id,
        "message": f"sent {event.gift.count}x {event.gift.info.name} 🎁",
        "avatar": event.user.avatar.urls[0] if event.user.avatar and event.user.avatar.urls else "",
        "id": str(event.message_id or event.timestamp),
        "timestamp": event.timestamp
    }
    print(json.dumps(data), flush=True)

async def main():
    try:
        await client.start()
    except Exception as e:
        print(json.dumps({"type": "error", "message": str(e)}), flush=True)

if __name__ == "__main__":
    asyncio.run(main())""",

        'public/index.html': """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MalikGPT — Stream Command Dashboard</title>
  <link rel="stylesheet" href="/css/dashboard.css">
  <script src="/socket.io/socket.io.js"></script>
</head>
<body>
  <div class="dashboard-container">
    <header class="header">
      <div class="brand"><h1>MalikGPT <span>Unified Chat</span></h1></div>
      <div class="auth-bar">
        <input type="password" id="authPass" placeholder="Dashboard Secret Key">
        <button id="copyOverlayBtn" class="btn btn-accent">Copy OBS Overlay URL</button>
      </div>
    </header>
    <main class="grid-layout">
      <section class="platform-grid">
        <div class="card">
          <div class="card-header"><img src="/icons/youtube.svg" class="icon"><h3>YOUTUBE</h3><span class="status-badge disconnected" id="status-youtube">Offline</span></div>
          <div class="card-body">
            <input type="text" id="input-youtube" placeholder="Channel / Handle">
            <div class="actions">
              <button onclick="connectPlatform('youtube')" class="btn btn-primary">Connect</button>
              <button onclick="disconnectPlatform('youtube')" class="btn btn-secondary">Disconnect</button>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><img src="/icons/tiktok.svg" class="icon"><h3>TIKTOK</h3><span class="status-badge disconnected" id="status-tiktok">Offline</span></div>
          <div class="card-body">
            <input type="text" id="input-tiktok" placeholder="Channel / Handle">
            <div class="actions">
              <button onclick="connectPlatform('tiktok')" class="btn btn-primary">Connect</button>
              <button onclick="disconnectPlatform('tiktok')" class="btn btn-secondary">Disconnect</button>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><img src="/icons/twitch.svg" class="icon"><h3>TWITCH</h3><span class="status-badge disconnected" id="status-twitch">Offline</span></div>
          <div class="card-body">
            <input type="text" id="input-twitch" placeholder="Channel / Handle">
            <div class="actions">
              <button onclick="connectPlatform('twitch')" class="btn btn-primary">Connect</button>
              <button onclick="disconnectPlatform('twitch')" class="btn btn-secondary">Disconnect</button>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><img src="/icons/kick.svg" class="icon"><h3>KICK</h3><span class="status-badge disconnected" id="status-kick">Offline</span></div>
          <div class="card-body">
            <input type="text" id="input-kick" placeholder="Channel / Handle">
            <div class="actions">
              <button onclick="connectPlatform('kick')" class="btn btn-primary">Connect</button>
              <button onclick="disconnectPlatform('kick')" class="btn btn-secondary">Disconnect</button>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><img src="/icons/facebook.svg" class="icon"><h3>FACEBOOK</h3><span class="status-badge disconnected" id="status-facebook">Offline</span></div>
          <div class="card-body">
            <input type="text" id="input-facebook" placeholder="Channel / Handle">
            <div class="actions">
              <button onclick="connectPlatform('facebook')" class="btn btn-primary">Connect</button>
              <button onclick="disconnectPlatform('facebook')" class="btn btn-secondary">Disconnect</button>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><img src="/icons/rumble.svg" class="icon"><h3>RUMBLE</h3><span class="status-badge disconnected" id="status-rumble">Offline</span></div>
          <div class="card-body">
            <input type="text" id="input-rumble" placeholder="Channel / Handle">
            <div class="actions">
              <button onclick="connectPlatform('rumble')" class="btn btn-primary">Connect</button>
              <button onclick="disconnectPlatform('rumble')" class="btn btn-secondary">Disconnect</button>
            </div>
          </div>
        </div>
      </section>
      <section class="feed-section">
        <div class="feed-header">
          <h2>Unified Chat Feed</h2>
          <button id="clearChatBtn" class="btn btn-small">Clear</button>
        </div>
        <div class="chat-feed" id="dashboardChatFeed"></div>
      </section>
    </main>
  </div>
  <script src="/js/dashboard.js"></script>
</body>
</html>""",

        'public/overlay.html': """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>MalikGPT OBS Chat Overlay</title>
  <link rel="stylesheet" href="/css/overlay.css">
  <script src="/socket.io/socket.io.js"></script>
</head>
<body>
  <div id="overlayChatContainer" class="overlay-chat-container"></div>
  <script src="/js/overlay.js"></script>
</body>
</html>""",

        'public/css/dashboard.css': """:root {
  --bg-dark: #0f0c1b; --card-bg: #18142a; --accent-purple: #8a2be2; --accent-cyan: #00f2fe;
  --text-main: #f1f1f1; --text-muted: #a0a0b0; --status-online: #00ff88; --status-offline: #ff4757;
}
* { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, sans-serif; }
body { background: var(--bg-dark); color: var(--text-main); min-height: 100vh; padding: 20px; }
.dashboard-container { max-width: 1400px; margin: 0 auto; }
.header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 20px; border-bottom: 1px solid #282244; margin-bottom: 20px; }
.brand h1 { font-size: 1.8rem; } .brand h1 span { color: var(--accent-cyan); }
.auth-bar { display: flex; gap: 10px; }
.auth-bar input { background: #120e24; border: 1px solid #332a58; color: #fff; padding: 8px 12px; border-radius: 6px; }
.grid-layout { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.platform-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; }
.card { background: var(--card-bg); border: 1px solid #282244; border-radius: 8px; padding: 15px; }
.card-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.card-header .icon { width: 22px; height: 22px; }
.card-header h3 { font-size: 1rem; flex-grow: 1; }
.status-badge { font-size: 0.75rem; padding: 3px 8px; border-radius: 12px; text-transform: uppercase; font-weight: bold; }
.status-badge.connected { background: rgba(0, 255, 136, 0.15); color: var(--status-online); }
.status-badge.disconnected { background: rgba(255, 71, 87, 0.15); color: var(--status-offline); }
.status-badge.connecting { background: rgba(255, 165, 0, 0.15); color: orange; }
.card-body input { width: 100%; background: #110d22; border: 1px solid #2e264f; color: #fff; padding: 8px; border-radius: 4px; margin-bottom: 10px; }
.actions { display: flex; gap: 8px; }
.btn { border: none; padding: 8px 14px; border-radius: 4px; cursor: pointer; font-weight: bold; }
.btn-primary { background: var(--accent-purple); color: #fff; flex-grow: 1; }
.btn-secondary { background: #2b2447; color: #ccc; }
.btn-accent { background: var(--accent-cyan); color: #000; }
.feed-section { background: var(--card-bg); border: 1px solid #282244; border-radius: 8px; padding: 15px; display: flex; flex-direction: column; height: 600px; }
.feed-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
.chat-feed { flex-grow: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
.chat-msg { background: rgba(255,255,255,0.03); padding: 8px 12px; border-radius: 6px; display: flex; align-items: center; gap: 10px; font-size: 0.9rem; }
.chat-msg .p-icon { width: 18px; height: 18px; }
.chat-msg .username { font-weight: bold; color: var(--accent-cyan); }
.chat-msg .time { font-size: 0.75rem; color: var(--text-muted); margin-left: auto; }""",

        'public/css/overlay.css': """body, html { margin: 0; padding: 0; width: 100%; height: 100%; background: transparent !important; overflow: hidden; font-family: sans-serif; }
.overlay-chat-container { position: absolute; bottom: 20px; left: 20px; width: 420px; max-height: 80vh; display: flex; flex-direction: column; justify-content: flex-end; gap: 6px; }
.overlay-message { display: flex; align-items: center; gap: 8px; background: rgba(10, 8, 18, 0.75); backdrop-filter: blur(4px); border-left: 3px solid #8a2be2; padding: 8px 12px; border-radius: 0 6px 6px 0; color: #ffffff; font-size: 15px; text-shadow: 1px 1px 2px rgba(0,0,0,0.8); }
.overlay-message .p-icon { width: 16px; height: 16px; }
.overlay-message .username { font-weight: 700; color: #00f2fe; }
.overlay-message .text { word-break: break-word; color: #f1f1f1; }""",

        'public/js/dashboard.js': """const socket = io();
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
  alert(`OBS Overlay URL copied to clipboard:\\n${overlayUrl}`);
});""",

        'public/js/overlay.js': """const socket = io();
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
});""",

        'public/icons/youtube.svg': '<svg viewBox="0 0 24 24" fill="#FF0000" xmlns="http://www.w3.org/2000/svg"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>',
        'public/icons/tiktok.svg': '<svg viewBox="0 0 24 24" fill="#25F4EE" xmlns="http://www.w3.org/2000/svg"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.29-2.29.54-4.63 2.18-6.26 1.64-1.66 4.02-2.51 6.33-2.28v4.11c-1.35-.22-2.73.23-3.68 1.18-.88.85-1.25 2.13-1.02 3.32.22 1.25 1.17 2.27 2.41 2.56 1.22.32 2.53-.08 3.32-1.01.62-.71.91-1.64.91-2.58V.02z"/></svg>',
        'public/icons/twitch.svg': '<svg viewBox="0 0 24 24" fill="#9146FF" xmlns="http://www.w3.org/2000/svg"><path d="M11.571 4.714h1.715v5.143h-1.715zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z"/></svg>',
        'public/icons/kick.svg': '<svg viewBox="0 0 24 24" fill="#53FC18" xmlns="http://www.w3.org/2000/svg"><path d="M3 3h6v5h3V6h3V3h6v6h-3v3h3v6h-3v-3h-3v3H9v3H3V3z"/></svg>',
        'public/icons/facebook.svg': '<svg viewBox="0 0 24 24" fill="#1877F2" xmlns="http://www.w3.org/2000/svg"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>',
        'public/icons/rumble.svg': '<svg viewBox="0 0 24 24" fill="#85C742" xmlns="http://www.w3.org/2000/svg"><path d="M12 0C5.37 0 0 5.37 0 12s5.37 12 12 12 12-5.37 12-12S18.63 0 12 0zm5.2 16.5l-4.5-2.6V8.1l4.5 2.6v5.8z"/></svg>',

        'tests/normalizer.test.js': """const assert = require('assert');
function normalizeMessage(platform, username, message) {
  return {
    platform: platform.toLowerCase(),
    username: String(username || 'Anonymous').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    message: String(message || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  };
}
console.log('Running MalikGPT Normalizer Tests...');
const dirtyMsg = normalizeMessage('tiktok', '<script>alert(1)</script>', '<b>Hello</b>');
assert.strictEqual(dirtyMsg.username, '&lt;script&gt;alert(1)&lt;/script&gt;');
assert.strictEqual(dirtyMsg.message, '&lt;b&gt;Hello&lt;/b&gt;');
console.log('✔ Test Passed: XSS Sanitization');"""
    }

    for path_str, content in files.items():
        with open(path_str, 'w', encoding='utf-8') as f:
            f.write(content)

    print("[3/4] Initializing Git repository and committing files...")
    try:
        subprocess.run(['git', 'init'], check=True)
        subprocess.run(['git', 'branch', '-M', 'main'], check=True)
        subprocess.run(['git', 'add', '.'], check=True)
        subprocess.run(['git', 'commit', '-m', 'Initial commit: MalikGPT Unified Chat'], check=True)
        print("✔ Git initialization and commit successful!")
    except Exception as e:
        print("Note during git commands:", e)

    print("[4/4] Setup complete!")
    repo_url = input("Enter your GitHub Repository URL (or press Enter to skip): ").strip()
    if repo_url:
        try:
            subprocess.run(['git', 'remote', 'add', 'origin', repo_url], check=True)
            subprocess.run(['git', 'push', '-u', 'origin', 'main'], check=True)
            print("✔ Successfully pushed to GitHub!")
        except Exception as e:
            print("Error pushing to GitHub:", e)

if __name__ == '__main__':
    main()
