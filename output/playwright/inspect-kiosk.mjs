import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

const pages = await fetch('http://127.0.0.1:9222/json/list').then(response => response.json());
const page = pages.find(page => page.type === 'page' && page.url.startsWith('http://127.0.0.1:8080/'));
assert.ok(page, 'PeaNUT page must exist');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
let id = 0;
function call(method, params = {}) {
  const requestId = ++id;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Browser check timed out')), 10000);
    const handler = event => {
      const message = JSON.parse(event.data);
      if (message.id === requestId) {
        clearTimeout(timeout);
        socket.removeEventListener('message', handler);
        message.error ? reject(new Error(message.error.message)) : resolve(message.result);
      }
    };
    socket.addEventListener('message', handler);
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
}
try {
  if (process.argv[2] === 'expire-login') {
    await call('Network.clearBrowserCookies');
    await call('Page.navigate', { url: 'http://127.0.0.1:8080/device/ups' });
    console.log('Kiosk cookies cleared to test automatic login recovery.');
  } else {
    const read = async () => JSON.parse((await call('Runtime.evaluate', {
      expression: 'JSON.stringify({url:location.href,width:innerWidth,height:innerHeight,refresh:localStorage.getItem("refreshInterval"),text:document.body.innerText})',
      returnByValue: true,
    })).result.value);
    const before = await read();
    await new Promise(resolve => setTimeout(resolve, 6500));
    const after = await read();
    const timestamp = state => state.text.match(/Last Updated: ([^\n]+)/)?.[1];
    assert.equal(after.url, 'http://127.0.0.1:8080/device/ups');
    assert.equal(after.width, 1024);
    assert.equal(after.height, 600);
    assert.equal(after.refresh, '5');
    assert.ok(after.text.includes('Back-UPS BX750MI'));
    assert.ok(after.text.includes('Online'));
    assert.ok(timestamp(before) && timestamp(after));
    assert.notEqual(timestamp(before), timestamp(after), 'Dashboard must refresh automatically');
    const { bounds } = await call('Browser.getWindowForTarget', { targetId: page.id });
    assert.equal(bounds.windowState, 'fullscreen');
    const screenshot = await call('Page.captureScreenshot', { format: 'png' });
    writeFileSync('/config/kiosk-preview.png', Buffer.from(screenshot.data, 'base64'));
    console.log(JSON.stringify({ url: after.url, viewport: `${after.width}x${after.height}`, windowState: bounds.windowState, refreshSeconds: after.refresh, timestamps: [timestamp(before), timestamp(after)], status: 'Online', model: 'Back-UPS BX750MI' }));
  }
} finally {
  socket.close();
}
