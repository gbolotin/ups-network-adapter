import test from 'node:test';
import assert from 'node:assert/strict';

test('keyboard creation follows the custom-element constructor attribute restriction', async () => {
  const registry = new Map();
  const appended = [];
  const previous = Object.fromEntries(['HTMLElement', 'customElements', 'document'].map(key => [key, globalThis[key]]));
  class BrowserElement {
    attachShadow() { return {}; }
    set hidden(value) { throw new Error('Custom-element constructor added an attribute'); }
  }
  globalThis.HTMLElement = BrowserElement;
  globalThis.customElements = { get: name => registry.get(name), define: (name, constructor) => registry.set(name, constructor) };
  globalThis.document = {
    querySelector: () => null,
    createElement: name => new (registry.get(name))(),
    body: { append: element => appended.push(element) },
  };
  try {
    await import('./ui/touch-keyboard.js');
    assert.equal(appended.length, 1);
    assert.ok(appended[0] instanceof registry.get('home-console-touch-keyboard'));
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
});
