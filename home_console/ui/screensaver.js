import { screensaverMode, upsSupplyState } from './screensaver-policy.mjs';
import { photoInterval, PHOTO_INTERVAL_KEY, screensaverEnabled, screensaverDelay } from './kiosk-settings.mjs';

const PHOTO_FOLDER = 'media-source://media_source/local/Media/PhotoFramePhotos';
class HomeConsoleScreensaver extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.lastActivity = Date.now();
    this.mode = 'hidden';
    this.upsOutage = this.savedUpsOutage();
    this.photos = [];
    this.photoIndex = -1;
    this.photoGeneration = 0;
    this.intervalChanged = () => { this.nextPhotoAt = Date.now() + this.intervalMs(); };
    this.settingChanged = () => { this.lastActivity = Date.now(); if (!screensaverEnabled()) this.hide(); };
    this.onInput = event => {
      if (event.composedPath?.().some(node => node.localName === 'home-console-control-drawer')) return;
      const active = this.mode !== 'hidden';
      if (active || Date.now() < this.swallowUntil) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.swallowUntil = Date.now() + 700;
      }
      this.lastActivity = Date.now();
      if (active) this.hide();
    };
  }

  connectedCallback() {
    this.hidden = true;
    this.render();
    this.bindMotion();
    this.events = ['pointerdown', 'pointerup', 'click', 'touchstart', 'touchend', 'keydown', 'wheel'];
    for (const event of this.events) window.addEventListener(event, this.onInput, { capture: true, passive: false });
    this.timer = setInterval(() => void this.tick(), 1000);
    window.addEventListener('home-console-photo-interval-changed', this.intervalChanged);
    window.addEventListener('home-console-screensaver-changed', this.settingChanged);
  }

  disconnectedCallback() {
    if (this.motionBound) { try { globalThis.fully.bind('onMotion', ''); } catch {} }
    clearInterval(this.timer);
    window.removeEventListener('home-console-photo-interval-changed', this.intervalChanged);
    window.removeEventListener('home-console-screensaver-changed', this.settingChanged);
    for (const event of this.events) window.removeEventListener(event, this.onInput, true);
    this.photoGeneration++;
    if (this.photoObjectUrl) URL.revokeObjectURL(this.photoObjectUrl);
  }

  bindMotion() {
    if (typeof globalThis.fully?.bind !== 'function') return;
    try {
      globalThis.fully.bind('onMotion', "document.querySelector('home-console-screensaver')?.onMotion();");
      this.motionBound = true;
    } catch { this.motionBound = false; }
  }

  onMotion() {
    if (!location.pathname.startsWith('/home-console/') || !new URLSearchParams(location.search).has('kiosk')) return;
    const now = Date.now();
    this.setAttribute('data-last-motion', String(now));
    if (now < (this.motionIgnoreUntil || 0)) return;
    // Fully emits at most once per second. Require sustained movement,
    // rather than a single exposure/lighting change, before dismissing photos.
    if (this.motionPendingAt === undefined || now - this.motionPendingAt > 2500) {
      this.motionPendingAt = now;
      return;
    }
    if (now - this.motionPendingAt < 600) return;
    this.motionPendingAt = undefined;
    this.lastActivity = now;
    this.setAttribute('data-last-motion-accepted', String(now));
    if (this.mode !== 'hidden') this.hide();
  }

  ignoreDisplayMotion() {
    this.motionIgnoreUntil = Date.now() + 2000;
    this.motionPendingAt = undefined;
  }

  hide() {
    this.hidden = true;
    this.mode = 'hidden';
    this.photoGeneration++;
    this.lockNoticeUntil = 0;
    if (this.lockNotice) this.lockNotice.hidden = true;
    if (this.batteryWarning) this.batteryWarning.hidden = true;
  }

  updateLockBattery(value, active) {
    const text = typeof value === 'string' ? value.trim() : '';
    const percent = /^\d+(\.\d+)?$/.test(text) ? Number(text) : NaN;
    const low = Number.isFinite(percent) && percent >= 0 && percent <= 20;
    this.batteryWarning.hidden = !active || !low;
    if (low) this.batteryLevel.textContent = `Батарея замка: ${percent}%`;
  }

  updateLockState(state, active) {
    this.openLockIndicator.hidden = state !== 'unlocked';
    this.setAttribute('data-lock-open', String(state === 'unlocked'));
    // Transitional states retain the last completed position; lost state starts a new baseline.
    if (!state || ['unknown', 'unavailable'].includes(state)) this.lastLockState = undefined;
    if (['locked', 'unlocked'].includes(state)) {
      const changed = this.lastLockState !== undefined && this.lastLockState !== state;
      this.lastLockState = state;
      if (changed && active) {
        this.lockNoticeUntil = Date.now() + 5000;
        this.lockIcon.icon = state === 'locked' ? 'mdi:lock' : 'mdi:lock-open-variant';
        this.lockIcon.style.color = state === 'locked' ? '#66bb6a' : '#ffb74d';
        this.lockLabel.textContent = state === 'locked' ? 'Замок закрыт' : 'Замок открыт';
      }
    }
    this.lockNotice.hidden = !active || !(Date.now() < this.lockNoticeUntil);
  }

  savedUpsOutage() {
    try {
      const saved = JSON.parse(sessionStorage.getItem('home-console-ups-outage'));
      if (saved && typeof saved.url === 'string' && /^\/home-console\/[^/]/.test(saved.url)
          && Number.isFinite(saved.idleMs) && saved.idleMs >= 0) return saved;
    } catch { /* Session storage may be unavailable. */ }
    return null;
  }

  saveUpsOutage() {
    try {
      if (this.upsOutage) sessionStorage.setItem('home-console-ups-outage', JSON.stringify(this.upsOutage));
      else sessionStorage.removeItem('home-console-ups-outage');
    } catch { /* The active page still retains its outage state. */ }
  }

  navigateConsole(url) {
    history.replaceState(history.state, '', url);
    window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace: true } }));
  }

  updateUpsPower(hass) {
    if (!location.pathname.startsWith('/home-console/')) return false;
    const supply = upsSupplyState(hass?.states['sensor.connected_ups_status']?.state);
    if (!this.upsOutage && supply === 'battery') {
      this.upsOutage = { url: location.pathname + location.search + (location.hash || ''),
        idleMs: Math.max(0, Date.now() - this.lastActivity) };
      this.saveUpsOutage();
      document.querySelector('home-console-control-drawer')?.close();
    }
    if (!this.upsOutage) return false;
    if (supply === 'online') {
      const previous = this.upsOutage;
      this.upsOutage = null;
      this.saveUpsOutage();
      this.lastActivity = Date.now() - previous.idleMs;
      this.navigateConsole(previous.url);
      return false;
    }
    // Missing/stale telemetry is not evidence that mains power returned.
    if (this.mode !== 'hidden') this.hide();
    this.lastActivity = Date.now();
    if (location.pathname !== '/home-console/ups') {
      this.navigateConsole('/home-console/ups' + location.search);
    }
    return true;
  }

  async tick() {
    const hass = document.querySelector('home-assistant')?.hass;
    if (this.updateUpsPower(hass)) return;
    const drawerOpen = document.querySelector('home-console-control-drawer')?.hasAttribute('open');
    this.updateLockBattery(hass?.states['sensor.lock_ultra_17_battery']?.state,
      this.mode !== 'hidden' && !document.hidden && !drawerOpen);
    this.updateLockState(hass?.states['lock.lock_ultra_17']?.state,
      this.mode !== 'hidden' && !document.hidden && !drawerOpen);
    if (drawerOpen || !screensaverEnabled()) {
      this.lastActivity = Date.now();
      if (this.mode !== 'hidden') this.hide();
      return;
    }
    this.setAttribute('data-connection', hass ? 'ready' : 'waiting');
    if (!hass) return;
    this.setAttribute('data-idle-seconds', String(Math.floor((Date.now() - this.lastActivity) / 1000)));
    const native = hass.states['media_player.denon_avc_x4700h'];
    const music = hass.states['media_player.denon_avc_x4700h_3'];
    const next = screensaverMode({ pathname: location.pathname, search: location.search,
      idleMs: Date.now() - this.lastActivity, idleTimeoutMs: screensaverDelay() * 1000, nativeState: native?.state || 'unavailable',
      nativeSource: native?.attributes.source, musicState: music?.state });
    if (next === 'hidden') { if (this.mode !== 'hidden') this.hide(); return; }
    if (document.hidden) return;
    const changed = next !== this.mode;
    if (changed) this.ignoreDisplayMotion();
    this.mode = next;
    this.hidden = false;
    this.setAttribute('mode', next);
    this.updateLockBattery(hass.states['sensor.lock_ultra_17_battery']?.state, true);
    const now = new Date();
    this.time.textContent = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    this.date.textContent = now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
    const weather = hass.states['weather.forecast_home'];
    const conditions = { 'partlycloudy': 'Переменная облачность', 'cloudy': 'Облачно', 'sunny': 'Солнечно',
      'clear-night': 'Ясно', 'rainy': 'Дождь', 'pouring': 'Ливень', 'fog': 'Туман', 'windy': 'Ветрено',
      'windy-variant': 'Ветрено, облачно', 'snowy': 'Снег', 'snowy-rainy': 'Дождь со снегом',
      'lightning': 'Гроза', 'lightning-rainy': 'Гроза с дождём', 'hail': 'Град', 'exceptional': 'Особые условия' };
    const icons = { partlycloudy: 'weather-partly-cloudy', cloudy: 'weather-cloudy', sunny: 'weather-sunny',
      'clear-night': 'weather-night', rainy: 'weather-rainy', pouring: 'weather-pouring', fog: 'weather-fog',
      windy: 'weather-windy', 'windy-variant': 'weather-windy-variant', snowy: 'weather-snowy',
      'snowy-rainy': 'weather-snowy-rainy', lightning: 'weather-lightning',
      'lightning-rainy': 'weather-lightning-rainy', hail: 'weather-hail', exceptional: 'alert-circle-outline' };
    const available = weather && !['unknown', 'unavailable'].includes(weather.state);
    const description = available ? conditions[weather.state] || weather.state : 'Погода недоступна';
    this.weather.textContent = available
      ? `${weather.attributes.temperature ?? '—'} ${weather.attributes.temperature_unit || '°C'}\n${description}`
      : 'Погода недоступна';
    this.weatherIcon.hidden = !available;
    this.weatherIcon.icon = `mdi:${icons[weather?.state] || 'weather-cloudy-alert'}`;
    this.weatherIcon.title = description;
    this.weatherIcon.setAttribute('aria-label', description);
    if (next === 'music') {
      if (changed) this.photoGeneration++;
      this.trackTitle.textContent = music.attributes.media_title || 'Denon';
      this.artist.textContent = music.attributes.media_artist || music.attributes.media_album_name || '';
      let artwork = null;
      for (const picture of [music.attributes.entity_picture_local, music.attributes.entity_picture]) {
        if (typeof picture !== 'string' || !picture) continue;
        try {
          const candidate = new URL(picture, location.origin);
          if (candidate.origin === location.origin) { artwork = candidate; break; }
        } catch { /* Ignore malformed metadata and try the next image source. */ }
      }
      if (artwork) {
        if (this.artwork.getAttribute('src') !== artwork.href) { this.ignoreDisplayMotion(); this.artwork.src = artwork.href; }
        this.artwork.hidden = false;
      } else { this.artwork.hidden = true; }
    } else if (!this.photoBusy && (changed || Date.now() >= this.nextPhotoAt)) {
      void this.nextPhoto(hass);
    }
  }

  async nextPhoto(hass) {
    this.photoBusy = true;
    const generation = ++this.photoGeneration;
    this.nextPhotoAt = Date.now() + this.intervalMs();
    try {
      if (!this.photos.length || Date.now() > this.refreshPhotosAt) {
        const folders = [PHOTO_FOLDER];
        const photos = [];
        for (let visited = 0; folders.length && visited < 100; visited++) {
          const result = await hass.callWS({ type: 'media_source/browse_media', media_content_id: folders.shift() });
          for (const item of result.children || []) {
            if (!item.media_content_id?.startsWith(PHOTO_FOLDER + '/')) continue;
            if (item.media_class === 'image') photos.push(item.media_content_id);
            else if (item.can_expand) folders.push(item.media_content_id);
          }
        }
        this.photos = photos.sort(() => Math.random() - .5);
        this.refreshPhotosAt = Date.now() + 300000;
      }
      if (!this.photos.length) throw new Error('No photos');
      this.photoIndex = (this.photoIndex + 1) % this.photos.length;
      const resolved = await hass.callWS({ type: 'media_source/resolve_media', media_content_id: this.photos[this.photoIndex] });
      const url = new URL(resolved.url, location.origin);
      if (url.origin !== location.origin) throw new Error('Unexpected media origin');
      const response = await fetch(url.href, { credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error('Photo unavailable');
      const objectUrl = URL.createObjectURL(await response.blob());
      const image = new Image();
      image.src = objectUrl;
      try { await image.decode(); } catch { URL.revokeObjectURL(objectUrl); throw new Error('Invalid image'); }
      if (generation !== this.photoGeneration || this.mode !== 'photos') { URL.revokeObjectURL(objectUrl); return; }
      const previous = this.photoObjectUrl;
      this.photoObjectUrl = objectUrl;
      this.ignoreDisplayMotion();
      this.photo.src = objectUrl;
      this.photo.hidden = false;
      if (previous) URL.revokeObjectURL(previous);
      this.photoMessage.textContent = '';
    } catch {
      if (generation === this.photoGeneration && !this.photoObjectUrl) this.photoMessage.textContent = 'Фотографии временно недоступны';
    } finally { this.photoBusy = false; }
  }

  intervalMs() {
    try { return photoInterval(localStorage.getItem(PHOTO_INTERVAL_KEY)) * 1000; }
    catch { return 30000; }
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host{position:fixed;inset:0;z-index:100000;display:block;background:#080a0e;color:white;touch-action:none;cursor:pointer;font-family:var(--primary-font-family,sans-serif)}
        :host([hidden]){display:none!important}
        .photo{position:absolute;width:100%;height:100%;object-fit:contain}
        .shade{position:absolute;inset:0;background:linear-gradient(transparent 45%,#000b)}
        .clock{position:absolute;top:32px;left:36px;max-width:calc(100% - 72px)}
        .clock,.weather-display{box-sizing:border-box;padding:12px 16px}
        .open-lock-indicator{position:absolute;top:32px;right:36px;z-index:3;--mdc-icon-size:128px;color:#ffb74d;filter:drop-shadow(1px 0 0 #000) drop-shadow(-1px 0 0 #000) drop-shadow(0 1px 0 #000) drop-shadow(0 -1px 0 #000) drop-shadow(0 2px 4px #000)}
        .open-lock-indicator[hidden]{display:none}
        .time,.date,.weather,.title,.artist,.message{-webkit-text-stroke:3px #000;paint-order:stroke fill;text-shadow:0 2px 4px #000,0 0 8px #000}
        .time{font-size:72px;line-height:1.05;font-weight:300;font-variant-numeric:tabular-nums}.date{font-size:40px;margin-top:8px}.weather{font-size:44px;text-align:right;white-space:pre-line;overflow-wrap:anywhere}
        .weather-display{position:absolute;bottom:32px;right:36px;max-width:calc(100% - 72px);display:flex;align-items:center;gap:24px;text-shadow:0 2px 8px #000}
        .weather-icon{--mdc-icon-size:96px;flex:none;filter:drop-shadow(1px 0 0 #000) drop-shadow(-1px 0 0 #000) drop-shadow(0 1px 0 #000) drop-shadow(0 -1px 0 #000) drop-shadow(0 2px 4px #000)}.weather-icon[hidden]{display:none}
        .music{display:none;position:absolute;inset:200px 36px 160px;align-items:center;gap:40px}
        .artwork{height:100%;max-width:42%;aspect-ratio:1;object-fit:contain;border-radius:16px}
        .track{flex:1;min-width:0}.title{font-size:40px;font-weight:600;overflow-wrap:anywhere}.artist{font-size:28px;margin-top:16px;color:#d0d6e0}
        .message{position:absolute;top:35%;width:100%;text-align:center;color:#aeb8c8;font-size:22px}
        .lock-notice,.battery-warning{position:absolute;inset:0;display:grid;place-content:center;justify-items:center;gap:24px;padding:24px;box-sizing:border-box;background:#080a0e;text-align:center}
        .lock-notice{z-index:2}.battery-warning{z-index:1}
        .battery-warning[hidden]{display:none}.battery-image{--mdc-icon-size:192px;color:#ef5350}.battery-title{font-size:48px}.battery-level{font-size:32px;color:#ffb74d}
        .lock-notice[hidden]{display:none}.lock-icon{--mdc-icon-size:192px}.lock-label{font-size:48px}
        :host([mode=music]) .photo,:host([mode=music]) .message{display:none}
        :host([mode=music]) .music{display:flex}
        :host([mode=music]) .music{inset:16px 24px;gap:24px}
        :host([mode=music]) .artwork{width:min(calc(100dvh - 32px),60vw);height:auto;max-height:100%;max-width:none;flex:none}
        :host([mode=music]) .clock{left:auto;right:36px;text-align:right;z-index:1}
        :host([mode=music]) .weather-display{z-index:1}
        :host([mode=music][data-lock-open=true]) .clock{right:188px}
      </style>
      <img class="photo" alt="" hidden><div class="shade"></div><div class="message"></div>
      <div class="music"><img class="artwork" alt="Обложка" hidden><div class="track"><div class="title"></div><div class="artist"></div></div></div>
      <div class="clock"><div class="time"></div><div class="date"></div></div><ha-icon class="open-lock-indicator" icon="mdi:lock-open-variant" role="img" aria-label="Замок открыт" title="Замок открыт" hidden></ha-icon><div class="weather-display"><ha-icon class="weather-icon" role="img" hidden></ha-icon><span class="weather"></span></div>
      <div class="lock-notice" role="status" aria-live="polite" hidden><ha-icon class="lock-icon" aria-hidden="true"></ha-icon><div class="lock-label"></div></div>
      <div class="battery-warning" role="status" aria-live="polite" hidden><ha-icon class="battery-image" icon="mdi:battery-alert" aria-hidden="true"></ha-icon><div class="battery-title">Заменить батарею в замке</div><div class="battery-level"></div></div>`;
    for (const [key, selector] of Object.entries({ photo: '.photo', photoMessage: '.message', artwork: '.artwork', trackTitle: '.title', artist: '.artist', time: '.time', date: '.date', weather: '.weather', weatherIcon: '.weather-icon', lockNotice: '.lock-notice', lockIcon: '.lock-icon', lockLabel: '.lock-label', openLockIndicator: '.open-lock-indicator', batteryWarning: '.battery-warning', batteryLevel: '.battery-level' })) this[key] = this.shadowRoot.querySelector(selector);
  }
}
if (!customElements.get('home-console-screensaver')) customElements.define('home-console-screensaver', HomeConsoleScreensaver);
if (!document.querySelector('home-console-screensaver')) document.body.append(document.createElement('home-console-screensaver'));
