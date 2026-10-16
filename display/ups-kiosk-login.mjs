// The debug endpoint is loopback-only. Never log credentials or CDP payloads.
const origin = 'http://127.0.0.1:8080';
const pages = await fetch('http://127.0.0.1:9222/json/list', {
  signal: AbortSignal.timeout(5000),
}).then(response => response.json()).catch(() => null);
// Chromium may still be starting when the timer first runs.
if (!pages) {
  process.exit(0);
}
const page = pages.find(page => page.type === 'page' && page.url.startsWith(`${origin}/login`));
if (!page) {
  process.exit(0);
}
if (!process.env.WEB_USERNAME || !process.env.WEB_PASSWORD) {
  throw new Error('PeaNUT login credentials are unavailable');
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', () => reject(new Error('Cannot connect to kiosk browser')), { once: true });
});
try {
  const result = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Kiosk login timed out')), 8000);
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id === 1) {
        clearTimeout(timeout);
        resolve(message);
      }
    });
  });
  socket.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: {
      expression: `(() => {
        if (location.origin !== ${JSON.stringify(origin)} || location.pathname !== '/login') return false;
        const username = document.querySelector('input[name="username"]');
        const password = document.querySelector('input[name="password"]');
        if (!username || !password) return false;
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(username, ${JSON.stringify(process.env.WEB_USERNAME)});
        set.call(password, ${JSON.stringify(process.env.WEB_PASSWORD)});
        for (const input of [username, password]) {
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        username.form.requestSubmit();
        return true;
      })()`,
      returnByValue: true,
    },
  }));
  const message = await result;
  if (message.error || message.result?.exceptionDetails) {
    throw new Error('Kiosk login could not be submitted');
  }
} finally {
  socket.close();
}
