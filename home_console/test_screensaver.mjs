import test from 'node:test';
import assert from 'node:assert/strict';
import { screensaverMode, IDLE_MS, upsSupplyState } from './ui/screensaver-policy.mjs';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const state = { pathname: '/home-console/receiver', search: '?kiosk', idleMs: IDLE_MS,
  nativeState: 'on', nativeSource: 'HEOS Music', musicState: 'playing' };
test('screensaver is limited to idle console kiosk pages', () => {
  assert.equal(screensaverMode(state), 'music');
  assert.equal(screensaverMode({ ...state, search: '' }), 'hidden');
  assert.equal(screensaverMode({ ...state, pathname: '/device/ups' }), 'hidden');
  assert.equal(screensaverMode({ ...state, idleMs: IDLE_MS - 1 }), 'hidden');
});
test('only current Denon music triggers now playing; stale metadata and TV do not', () => {
  for (const musicState of ['idle', 'paused', 'off', 'unavailable', 'unknown']) {
    assert.equal(screensaverMode({ ...state, musicState }), 'photos');
  }
  for (const nativeState of ['off', 'unknown', 'unavailable']) {
    assert.equal(screensaverMode({ ...state, nativeState }), 'photos');
  }
  assert.equal(screensaverMode({ ...state, nativeSource: 'TV Audio' }), 'photos');
  assert.equal(screensaverMode({ ...state, nativeSource: 'NET' }), 'music');
});

test('idle overlay follows live Denon state, displays HA weather and consumes the wake gesture', async () => {
  let Card;
  let now = 0;
  let enabled = true;
  const nodes = new Map();
  const session = new Map();
  const motionBindings = [];
  const states = {
    'media_player.denon_avc_x4700h': { state: 'on', attributes: { source: 'HEOS Music' } },
    'media_player.denon_avc_x4700h_3': { state: 'idle', attributes: { media_title: 'Old track' } },
    'weather.forecast_home': { state: 'partlycloudy', attributes: { temperature: 22.8, temperature_unit: '°C' } },
    'lock.lock_ultra_17': { state: 'locked' },
    'sensor.lock_ultra_17_battery': { state: '85' },
  };
  const context = vm.createContext({
    screensaverDelay: () => 120, screensaverEnabled: () => enabled, screensaverMode, upsSupplyState, URL, URLSearchParams, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    fully: { bind: (...args) => motionBindings.push(args) },
    window: { dispatchEvent() {} },
    sessionStorage: { getItem: key => session.get(key) ?? null, setItem: (key, value) => session.set(key, value), removeItem: key => session.delete(key) },
    history: { replaceState(state, title, url) { const target = new URL(url, "http://test"); context.location.pathname = target.pathname; context.location.search = target.search; context.location.hash = target.hash; } },
    Date: class extends Date { static now() { return now; } },
    HTMLElement: class {
      attachShadow() { this.shadowRoot = { querySelector(key) { if (!nodes.has(key)) nodes.set(key, { style: {}, setAttribute() {}, getAttribute(name) { return this[name]; } }); return nodes.get(key); } }; }
      setAttribute() {}
    },
    customElements: { get() {}, define(name, cls) { Card = cls; } },
    document: { hidden: false, querySelector(selector) { return selector === 'home-assistant' ? { hass: { states } } : selector === 'home-console-screensaver' ? {} : null; } },
    location: { pathname: '/home-console/receiver', search: '?kiosk', origin: 'http://test' },
  });
  const source = (await readFile(new URL('./ui/screensaver.js', import.meta.url), 'utf8')).replace(/^(import[^\n]+\n)+/, '');
  vm.runInContext(source, context);
  const card = new Card();
  card.render();
  let photos = 0;
  card.nextPhoto = async () => { photos++; };
  now = IDLE_MS;
  await card.tick();
  assert.equal(card.mode, 'photos');
  assert.equal(photos, 1);
  enabled = false;
  await card.tick();
  assert.equal(card.mode, 'hidden', 'disabling dismisses an active screensaver');
  now += IDLE_MS * 2;
  await card.tick();
  assert.equal(card.mode, 'hidden', 'disabled screensaver stays hidden after idle');
  enabled = true;
  card.settingChanged();
  await card.tick();
  assert.equal(card.mode, 'hidden', 'enabling starts a fresh idle period');
  now += IDLE_MS;
  await card.tick();
  assert.equal(card.mode, 'photos');

  assert.equal(card.batteryWarning.hidden, true);
  for (const value of ['20', '10', '0']) {
    states['sensor.lock_ultra_17_battery'].state = value;
    await card.tick();
    assert.equal(card.batteryWarning.hidden, false);
    assert.equal(card.batteryLevel.textContent, `Батарея замка: ${value}%`);
  }
  for (const value of ['20.1', '21', '85', '101', '-1', 'unknown', 'unavailable', '', ' ']) {
    states['sensor.lock_ultra_17_battery'].state = value;
    await card.tick();
    assert.equal(card.batteryWarning.hidden, true, `do not warn for ${JSON.stringify(value)}`);
  }
  states['sensor.lock_ultra_17_battery'].state = '85';
  assert.equal(card.lockNotice.hidden, true, 'initial lock position is not an event');
  assert.equal(card.openLockIndicator.hidden, true);
  states['lock.lock_ultra_17'].state = 'unlocking';
  await card.tick();
  assert.equal(card.lockNotice.hidden, true);
  states['lock.lock_ultra_17'].state = 'unlocked';
  await card.tick();
  assert.equal(card.lockNotice.hidden, false);
  assert.equal(card.lockIcon.icon, 'mdi:lock-open-variant');
  assert.equal(card.lockLabel.textContent, 'Замок открыт');
  assert.equal(card.openLockIndicator.hidden, false);
  now += 4999;
  await card.tick();
  assert.equal(card.lockNotice.hidden, false);
  now++;
  await card.tick();
  assert.equal(card.lockNotice.hidden, true, 'resume screensaver after five seconds');
  assert.equal(card.openLockIndicator.hidden, false, 'open indicator remains after the notice expires');
  states['lock.lock_ultra_17'].state = 'locked';
  await card.tick();
  assert.equal(card.lockNotice.hidden, false);
  assert.equal(card.lockIcon.icon, 'mdi:lock');
  assert.equal(card.lockLabel.textContent, 'Замок закрыт');
  assert.equal(card.openLockIndicator.hidden, true);
  now += 2000;
  states['lock.lock_ultra_17'].state = 'unlocked';
  await card.tick();
  assert.equal(card.lockNoticeUntil, now + 5000, 'latest event restarts the notice');
  states['lock.lock_ultra_17'].state = 'unavailable';
  await card.tick();
  assert.equal(card.openLockIndicator.hidden, true, 'unknown state must not display an open lock');
  states['lock.lock_ultra_17'].state = 'locked';
  const noticeUntil = card.lockNoticeUntil;
  await card.tick();
  assert.equal(card.lockNoticeUntil, noticeUntil, 'recovery does not invent a lock event');
  assert.match(card.weather.textContent, /22.8 °C/);
  assert.equal(card.weather.textContent, '22.8 °C\nПеременная облачность');
  assert.equal(card.weatherIcon.icon, 'mdi:weather-partly-cloudy');
  assert.equal(card.weatherIcon.hidden, false);
  assert.equal(card.weatherIcon.title, 'Переменная облачность');
  states['weather.forecast_home'].state = 'rainy';
  await card.tick();
  assert.equal(card.weatherIcon.icon, 'mdi:weather-rainy');
  assert.equal(card.weather.textContent, '22.8 °C\nДождь');
  states['weather.forecast_home'].state = 'unavailable';
  await card.tick();
  assert.equal(card.weatherIcon.hidden, true);
  assert.equal(card.weather.textContent, 'Погода недоступна');
  states['media_player.denon_avc_x4700h_3'].state = 'playing';
  states['media_player.denon_avc_x4700h_3'].attributes.media_title = 'Current track';
  const music = states['media_player.denon_avc_x4700h_3'];
  music.attributes.entity_picture = 'https://example.com/album.jpg';
  music.attributes.entity_picture_local = '/api/media_player_proxy/media_player.denon_avc_x4700h_3?token=fixture1';
  await card.tick();
  assert.equal(card.mode, 'music');
  assert.equal(card.trackTitle.textContent, 'Current track');
  assert.equal(card.artwork.hidden, false);
  assert.equal(card.artwork.src, 'http://test' + music.attributes.entity_picture_local);
  music.attributes.entity_picture_local = '/api/media_player_proxy/media_player.denon_avc_x4700h_3?token=fixture2';
  await card.tick();
  assert.equal(card.artwork.src, 'http://test' + music.attributes.entity_picture_local, 'refresh the local proxy token');
  delete music.attributes.entity_picture_local;
  await card.tick();
  assert.equal(card.artwork.hidden, true, 'do not load an external URL instead of the HA proxy');
  music.attributes.entity_picture_local = 'http://[';
  music.attributes.entity_picture = '/local/album.jpg';
  await card.tick();
  assert.equal(card.artwork.src, 'http://test/local/album.jpg', 'invalid metadata must not stop updates');
  states['sensor.lock_ultra_17_battery'].state = '15';
  await card.tick();
  assert.equal(card.batteryWarning.hidden, false, 'low battery also replaces music artwork');
  states['media_player.denon_avc_x4700h_3'].state = 'paused';
  await card.tick();
  assert.equal(card.mode, 'photos');
  let prevented = 0;
  const event = { preventDefault() { prevented++; }, stopImmediatePropagation() {} };
  card.onInput(event);
  card.onInput(event);
  assert.equal(prevented, 2);
  assert.equal(card.hidden, true);
  assert.equal(card.lockNotice.hidden, true, 'wake dismisses the lock notice');
  assert.equal(card.batteryWarning.hidden, true, 'touch dismisses battery warning with the screensaver');
  states['lock.lock_ultra_17'].state = 'unlocked';
  await card.tick();
  assert.equal(card.mode, 'hidden');
  assert.equal(card.lockNotice.hidden, true, 'active dashboard does not display notices');
  assert.equal(card.batteryWarning.hidden, true, 'low battery does not interrupt an active dashboard');
  // An outage interrupts a running screensaver and retains its previous view/idle state.
  now += IDLE_MS;
  await card.tick();
  assert.equal(card.mode, 'photos');
  states['sensor.connected_ups_status'] = { state: 'OB DISCHRG' };
  await card.tick();
  assert.equal(context.location.pathname, '/home-console/ups');
  assert.equal(card.mode, 'hidden');
  assert.equal(card.hidden, true);
  const reloaded = new Card();
  assert.equal(reloaded.upsOutage.url, '/home-console/receiver?kiosk', 'reload retains the pre-outage view');
  now += IDLE_MS * 4;
  states['sensor.connected_ups_status'].state = 'unavailable';
  context.location.pathname = '/home-console/home';
  await card.tick();
  assert.equal(context.location.pathname, '/home-console/ups', 'unknown supply must not release the outage');
  assert.equal(card.mode, 'hidden');
  states['sensor.connected_ups_status'].state = 'OL CHRG';
  await card.tick();
  assert.equal(context.location.pathname, '/home-console/receiver');
  assert.equal(card.mode, 'photos', 'restore an already active screensaver only after mains returns');
  assert.equal(card.upsOutage, null);
  card.bindMotion();
  assert.equal(motionBindings[0][0], 'onMotion');
  assert.match(motionBindings[0][1], /onMotion/);
  card.onMotion();
  assert.equal(card.mode, 'photos', 'opening the overlay must not wake it through camera exposure');
  now += 2100;
  card.onMotion();
  assert.equal(card.mode, 'photos', 'one isolated event must not dismiss photos');
  now += 3000;
  card.onMotion();
  assert.equal(card.mode, 'photos', 'separate flashes must not combine into motion');
  now += 1000;
  card.onMotion();
  assert.equal(card.mode, 'hidden', 'sustained camera motion dismisses the photo overlay');
  assert.equal(card.lastActivity, now);
  await card.tick();
  assert.equal(card.mode, 'hidden', 'motion starts a fresh idle period');
  enabled = false;
  states['sensor.connected_ups_status'].state = 'OB LB';
  await card.tick();
  assert.equal(context.location.pathname, '/home-console/ups');
  states['sensor.connected_ups_status'].state = 'OL';
  await card.tick();
  assert.equal(context.location.pathname, '/home-console/receiver');
  assert.equal(card.mode, 'hidden', 'outage recovery preserves the disabled screensaver preference');

});

test('UPS power detection requires explicit NUT flags, with battery taking priority', () => {
  for (const value of ['OB', 'OB DISCHRG', 'OB LB', 'OL OB']) assert.equal(upsSupplyState(value), 'battery');
  for (const value of ['OL', 'OL CHRG']) assert.equal(upsSupplyState(value), 'online');
  for (const value of [undefined, '', 'unknown', 'unavailable', 'BOL', 'LB']) assert.equal(upsSupplyState(value), 'unknown');
});

test('configured screensaver timeout controls activation at the exact boundary', () => {
  for (const seconds of [15, 30, 60, 120, 300, 600, 900, 1800]) {
    assert.equal(screensaverMode({ ...state, idleTimeoutMs: seconds * 1000, idleMs: seconds * 1000 - 1 }), 'hidden');
    assert.equal(screensaverMode({ ...state, idleTimeoutMs: seconds * 1000, idleMs: seconds * 1000 }), 'music');
  }
});
