const express = require('express');
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
    const lines = data.toString().split('\n');
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

server.listen(PORT, () => { console.log(`MalikGPT Unified Chat Running on Port ${PORT}`); });