// 4. Kick Chat Adapter (Python Subprocess with Live Console Logs)
function connectKick(slug) {
  disconnectPlatform('kick');
  updatePlatformStatus('kick', 'connecting', slug);
  const cleanSlug = slug.toLowerCase().trim();

  console.log(`[Kick] Spawning Python bridge for channel: ${cleanSlug}`);
  const pythonProc = spawn('python3', [path.join(__dirname, 'python', 'kick_bridge.py'), cleanSlug]);
  activeAdapters.kick.process = pythonProc;

  pythonProc.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach((line) => {
      if (!line.trim()) return;
      try {
        const payload = JSON.parse(line);
        if (payload.type === 'log') {
          console.log(`[Kick Bridge Log] ${payload.message}`);
        } else if (payload.type === 'status') {
          console.log(`[Kick Status] ${payload.status} (${payload.handle})`);
          updatePlatformStatus('kick', payload.status, cleanSlug);
        } else if (payload.type === 'message') {
          broadcastMessage(normalizeMessage('kick', payload.username, payload.message, '', payload.id));
        } else if (payload.type === 'error') {
          console.error(`[Kick Error] ${payload.message}`);
          updatePlatformStatus('kick', 'error', payload.message);
        }
      } catch (e) {
        // Raw print if not strict JSON
        console.log(`[Kick Raw Out] ${line}`);
      }
    });
  });

  pythonProc.stderr.on('data', (data) => {
    console.error(`[Kick Python Stderr] ${data.toString()}`);
  });

  pythonProc.on('close', (code) => {
    console.log(`[Kick] Python bridge process exited with code ${code}`);
    updatePlatformStatus('kick', 'disconnected');
  });
}
