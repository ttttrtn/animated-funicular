const assert = require('assert');
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
console.log('✔ Test Passed: XSS Sanitization');