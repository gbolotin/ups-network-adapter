import test from 'node:test';
import assert from 'node:assert/strict';
import { photoInterval, opensDrawer } from './ui/kiosk-settings.mjs';
import { PHOTO_INTERVALS, PHOTO_INTERVAL_KEY, SCREENSAVER_ENABLED_KEY, screensaverEnabled, SCREENSAVER_DELAYS, SCREENSAVER_DELAY_KEY, screensaverDelay } from './ui/kiosk-settings.mjs';
import { nightBlankingSettings, setConsoleTheme } from './ui/kiosk-settings.mjs';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('theme selection uses HA native preferences and preserves compatible custom themes', () => {
  const events = [];
  const root = { hass: { themes: { theme: 'custom', themes: { custom: { modes: { light: {}, dark: {} } } } } }, dispatchEvent(event) { events.push(event); } };
  setConsoleTheme(root, 'dark');
  assert.equal(events[0].type, 'settheme');
  assert.deepEqual(events[0].detail, { dark: true });
  assert.equal(events[0].composed, true);
  setConsoleTheme(root, 'light');
  assert.deepEqual(events[1].detail, { dark: false });
  root.hass.themes.themes.custom = { modes: { light: {} } };
  setConsoleTheme(root, 'dark');
  assert.deepEqual(events[2].detail, { dark: true, theme: 'default' });
  assert.throws(() => setConsoleTheme(root, 'invalid'));
  assert.throws(() => setConsoleTheme(null, 'dark'));
});

test('night blanking reads actual Pi state and requires confirmed boolean responses', async () => {
  const requests = [];
  const hass = { async callWS(request) { requests.push(request); return { response: { status: 200, content: { enabled: request.service_data.enabled ?? true } } }; } };
  assert.equal(await nightBlankingSettings(hass), true);
  assert.equal(await nightBlankingSettings(hass, false), false);
  assert.equal(requests[0].service, 'home_console_pi_screen');
  assert.equal(requests[1].service, 'home_console_pi_set_screen');
  await assert.rejects(nightBlankingSettings(hass, 'false'));
  await assert.rejects(nightBlankingSettings({ async callWS() { return { response: { status: 500, content: { enabled: false } } }; } }));
});
test('photo intervals accept only the available values and safely default', () => {
  for (const value of [5, 10, 15, 30, 60, 120, 300]) assert.equal(photoInterval(String(value)), value);
  for (const value of [null, '', -1, 0, 1, 999, 'bad']) assert.equal(photoInterval(value), 30);
});
test('drawer requires a downward swipe starting at the top edge', () => {
  assert.equal(opensDrawer({ x: 500, y: 10 }, { x: 520, y: 100 }), true);
  assert.equal(opensDrawer({ x: 500, y: 100 }, { x: 520, y: 200 }), false);
  assert.equal(opensDrawer({ x: 500, y: 10 }, { x: 700, y: 80 }), false);
  assert.equal(opensDrawer({ x: 500, y: 10 }, { x: 500, y: 30 }), false);
});
test('power controls wait for confirmation and use only the Pi-specific HA service', async () => {
  let Card;
  const calls = [];
  const nodes = new Map();
  const element = () => ({ append() {}, addEventListener() {}, focus() {} });
  const context = vm.createContext({
    PHOTO_INTERVALS, PHOTO_INTERVAL_KEY, SCREENSAVER_ENABLED_KEY, screensaverEnabled, SCREENSAVER_DELAYS, SCREENSAVER_DELAY_KEY, screensaverDelay, photoInterval, opensDrawer,
    HTMLElement: class {
      attachShadow() { this.shadowRoot = { querySelector(key) { if (!nodes.has(key)) nodes.set(key, element()); return nodes.get(key); } }; }
      addEventListener() {}
    },
    customElements: { get() {}, define(name, cls) { Card = cls; } },
    localStorage: { getItem() { return '30'; } },
    document: { createElement: element, querySelector(selector) { return selector === 'home-assistant' ? { hass: { callService(...args) { calls.push(args); } } } : {}; } },
  });
  vm.runInContext((await readFile(new URL('./ui/control-drawer.js', import.meta.url), 'utf8')).replace(/^import[^\n]+\n/, ''), context);
  const card = new Card();
  card.render();
  await card.execute();
  assert.equal(calls.length, 0);
  card.prepare('restart');
  assert.equal(calls.length, 0);
  assert.equal(card.confirmation.hidden, false);
  await card.execute();
  assert.equal(calls[0][0], 'rest_command');
  assert.equal(calls[0][1], 'home_console_pi_power');
  assert.equal(calls[0][2].action, 'restart');
  assert.equal(card.pending, null);
  card.tablet = true;
  card.render();
  assert.match(card.shadowRoot.innerHTML, /Настройки планшета/);
  assert.match(card.shadowRoot.innerHTML, /power pi-control" hidden/);
  card.prepare('shutdown');
  assert.equal(card.pending, null);
  card.pending = 'shutdown';
  await card.execute();
  await card.changeNightBlanking();
  await card.refreshNightBlanking();
  assert.equal(calls.length, 1, 'tablet cannot operate Pi controls even if invoked directly');
});

test('screensaver defaults on and respects a stored per-device disable', () => {
  assert.equal(screensaverEnabled({ getItem: () => null }), true);
  assert.equal(screensaverEnabled({ getItem: () => 'false' }), false);
  assert.equal(screensaverEnabled({ getItem: () => 'true' }), true);
  assert.equal(screensaverEnabled({ getItem() { throw new Error('Blocked'); } }), true);
});

test('screensaver delay accepts available intervals and defaults to two minutes', () => {
  for (const seconds of SCREENSAVER_DELAYS) assert.equal(screensaverDelay({ getItem: () => String(seconds) }), seconds);
  for (const value of [null, '', 'bad', '-1', '0', 'Infinity', '999']) assert.equal(screensaverDelay({ getItem: () => value }), 120);
  assert.equal(screensaverDelay({ getItem() { throw new Error('Blocked'); } }), 120);
});
