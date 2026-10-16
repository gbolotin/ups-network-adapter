import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('./ups-kiosk-login.mjs', import.meta.url), 'utf8');
const run = new (Object.getPrototypeOf(async function () {}).constructor)(
  'fetch', 'WebSocket', 'process', source,
);
const skipped = new Error('skipped');
const credentials = { WEB_USERNAME: 'admin', WEB_PASSWORD: 'quote" and slash\\ and newline\n' };
let expression;
let socketClosed = false;
class BrowserSocket {
  listeners = new Map();
  constructor() {
    queueMicrotask(() => this.listeners.get('open')?.());
  }
  addEventListener(name, handler) {
    this.listeners.set(name, handler);
  }
  send(payload) {
    expression = JSON.parse(payload).params.expression;
    queueMicrotask(() => this.listeners.get('message')({
      data: JSON.stringify({ id: 1, result: { result: { value: true } } }),
    }));
  }
  close() {
    socketClosed = true;
  }
}
const processStub = { env: credentials, exit: () => { throw skipped; } };
const page = { type: 'page', url: 'http://127.0.0.1:8080/login', webSocketDebuggerUrl: 'ws://127.0.0.1/test' };
await run(async () => ({ json: async () => [page] }), BrowserSocket, processStub);
assert.equal(socketClosed, true);

let submitted = 0;
const username = { dispatchEvent() {}, form: { requestSubmit() { submitted++; } } };
const password = { dispatchEvent() {} };
class Input {
  set value(value) { this.assignedValue = value; }
}
const context = {
  location: { origin: 'http://127.0.0.1:8080', pathname: '/login' },
  document: { querySelector: selector => selector.includes('username') ? username : password },
  HTMLInputElement: Input,
  Event: class {},
};
assert.equal(runInNewContext(expression, context), true);
assert.equal(username.assignedValue, credentials.WEB_USERNAME);
assert.equal(password.assignedValue, credentials.WEB_PASSWORD);
assert.equal(submitted, 1);

context.location.origin = 'http://untrusted.example';
assert.equal(runInNewContext(expression, context), false);
assert.equal(submitted, 1, 'Never submit credentials to another origin');
context.location.origin = 'http://127.0.0.1:8080';
context.location.pathname = '/login-other';
assert.equal(runInNewContext(expression, context), false);
assert.equal(submitted, 1, 'Only submit the actual login form');

for (const pages of [[], [{ ...page, url: 'http://127.0.0.1:8080/device/ups' }]]) {
  await assert.rejects(run(async () => ({ json: async () => pages }), BrowserSocket, processStub), error => error === skipped);
}
await assert.rejects(run(async () => { throw new Error('Browser not ready'); }, BrowserSocket, processStub), error => error === skipped);
await assert.rejects(run(async () => ({ json: async () => [page] }), BrowserSocket, { ...processStub, env: {} }), /credentials are unavailable/);
console.log('Kiosk login checks passed: login, credential escaping, origin/path restrictions, startup and signed-in states.');
