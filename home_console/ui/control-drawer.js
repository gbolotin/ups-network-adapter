import { PHOTO_INTERVALS, PHOTO_INTERVAL_KEY, SCREENSAVER_ENABLED_KEY, screensaverEnabled, SCREENSAVER_DELAYS, SCREENSAVER_DELAY_KEY, screensaverDelay, photoInterval, opensDrawer, nightBlankingSettings, setConsoleTheme } from './kiosk-settings.mjs';

class HomeConsoleControlDrawer extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.tablet = /Android/i.test(globalThis.navigator?.userAgent || '');
    this.down = event => {
      if (!this.scope() || event.clientY > 24 || this.hasAttribute('open')) return;
      this.start = { x: event.clientX, y: event.clientY };
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    this.move = event => {
      if (!this.start) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    this.up = event => {
      if (!this.start) return;
      const start = this.start;
      this.start = null;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (opensDrawer(start, { x: event.clientX, y: event.clientY })) this.open();
    };
    this.locationChanged = () => {
      this.hidden = !this.scope();
      if (this.hidden) this.close();
    };
    this.guardTouch = event => {
      if (this.start || (this.scope() && event.touches?.[0]?.clientY <= 24)) event.stopImmediatePropagation();
    };
  }
  scope() { return location.pathname.startsWith('/home-console/') && new URLSearchParams(location.search).has('kiosk'); }
  connectedCallback() {
    this.render();
    this.locationChanged();
    window.addEventListener('pointerdown', this.down, { capture: true, passive: false });
    window.addEventListener('pointermove', this.move, { capture: true, passive: false });
    window.addEventListener('pointerup', this.up, { capture: true, passive: false });
    window.addEventListener('location-changed', this.locationChanged);
    window.addEventListener('popstate', this.locationChanged);
    for (const event of ['touchstart', 'touchmove', 'touchend']) window.addEventListener(event, this.guardTouch, { capture: true, passive: true });
  }
  disconnectedCallback() {
    window.removeEventListener('pointerdown', this.down, true);
    window.removeEventListener('pointermove', this.move, true);
    window.removeEventListener('pointerup', this.up, true);
    window.removeEventListener('location-changed', this.locationChanged);
    window.removeEventListener('popstate', this.locationChanged);
    for (const event of ['touchstart', 'touchmove', 'touchend']) window.removeEventListener(event, this.guardTouch, true);
  }
  open() {
    this.pending = null;
    this.screensaverToggle.checked = screensaverEnabled();
    this.delaySelect.value = String(screensaverDelay());
    this.message.textContent = '';
    this.confirmation.hidden = true;
    this.setAttribute('open', '');
    this.previousFocus = document.activeElement;
    this.closeButton.focus();
    const hass = document.querySelector('home-assistant')?.hass;
    this.themeSelect.disabled = !hass?.themes;
    this.themeSelect.value = hass?.themes.darkMode ? 'dark' : 'light';
    if (!this.tablet) void this.refreshNightBlanking();
  }
  async changeTheme() {
    const root = document.querySelector('home-assistant');
    const previous = root?.hass?.themes.darkMode ? 'dark' : 'light';
    this.themeSelect.disabled = true;
    try {
      const mode = this.themeSelect.value;
      setConsoleTheme(root, mode);
      await new Promise(resolve => setTimeout(resolve, 0));
      if (root.hass.themes.darkMode !== (mode === 'dark')) throw new Error('Theme not applied');
      this.message.textContent = mode === 'dark' ? 'Выбрана тёмная тема.' : 'Выбрана светлая тема.';
    } catch {
      this.themeSelect.value = previous;
      this.message.textContent = 'Не удалось изменить тему.';
    } finally { this.themeSelect.disabled = false; }
  }
  async refreshNightBlanking() {
    if (this.tablet) return;
    this.nightToggle.disabled = true;
    try {
      this.nightToggle.checked = await nightBlankingSettings(document.querySelector('home-assistant')?.hass);
      this.nightConfirmed = this.nightToggle.checked;
      this.nightToggle.disabled = false;
    } catch { this.message.textContent = 'Не удалось прочитать настройку ночного экрана.'; }
  }
  async changeNightBlanking() {
    if (this.tablet) return;
    this.nightToggle.disabled = true;
    try {
      this.nightToggle.checked = await nightBlankingSettings(document.querySelector('home-assistant')?.hass, this.nightToggle.checked);
      this.nightConfirmed = this.nightToggle.checked;
      this.message.textContent = this.nightConfirmed ? 'Ночное гашение включено.' : 'Ночное гашение выключено. Экран останется включённым.';
    } catch {
      this.nightToggle.checked = this.nightConfirmed;
      this.message.textContent = 'Не удалось подтвердить изменение. Проверьте связь с Pi.';
    } finally { this.nightToggle.disabled = false; }
  }
  close() {
    if (this.busy) return;
    this.removeAttribute('open');
    this.pending = null;
    this.previousFocus?.focus();
  }
  prepare(action) {
    if (this.tablet) return;
    this.pending = action;
    this.confirmation.hidden = false;
    this.question.textContent = action === 'shutdown'
      ? 'Выключить Pi? Мониторинг UPS остановится. Для включения потребуется физический доступ.'
      : 'Перезапустить Pi? Экран и мониторинг UPS временно отключатся.';
  }
  async execute() {
    if (this.tablet || this.busy || !['restart', 'shutdown'].includes(this.pending)) return;
    this.busy = true;
    this.confirmButton.disabled = true;
    try {
      const hass = document.querySelector('home-assistant')?.hass;
      if (!hass) throw new Error('HA unavailable');
      await hass.callService('rest_command', 'home_console_pi_power', { action: this.pending });
      this.message.textContent = this.pending === 'restart' ? 'Команда перезапуска отправлена на Pi.' : 'Команда выключения отправлена на Pi.';
      this.confirmation.hidden = true;
    } catch {
      this.message.textContent = 'Команда не подтверждена. Проверьте доступность Pi и Home Assistant.';
    } finally {
      this.busy = false;
      this.confirmButton.disabled = false;
      this.pending = null;
    }
  }
  render() {
    this.shadowRoot.innerHTML = `<style>
      :host{position:fixed;inset:0;z-index:200000;pointer-events:none;font-family:var(--primary-font-family,sans-serif);color:var(--primary-text-color)}
      :host([hidden]){display:none!important}.handle{position:absolute;top:0;left:calc(50% - 48px);width:96px;height:24px;pointer-events:auto;touch-action:none;border:0;background:transparent;padding:0}
      .handle:after{content:'';display:block;width:48px;height:4px;margin:auto;background:var(--secondary-text-color);border-radius:4px;opacity:.65}
      .backdrop{display:none;position:absolute;inset:0;background:#0009;pointer-events:auto}
      .panel{display:none;position:absolute;left:0;right:0;top:0;padding:24px;box-sizing:border-box;background:var(--card-background-color);border-radius:0 0 20px 20px;box-shadow:0 8px 24px #0008;pointer-events:auto;max-height:100%;overflow:auto}
      :host([open]) .backdrop,:host([open]) .panel{display:block}:host([open]) .handle{display:none}
      header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;font-size:24px}button,select{font:inherit;color:inherit;border:1px solid var(--divider-color);border-radius:12px;background:var(--secondary-background-color);min-height:48px;padding:12px 20px}
      button{cursor:pointer}button:focus-visible,select:focus-visible{outline:2px solid var(--primary-color)}button:disabled{opacity:.5}
      .row{display:flex;align-items:center;justify-content:space-between;gap:16px}.power{display:flex;gap:16px;margin-top:24px}.power button{flex:1}.danger{color:var(--error-color,#ef5350)}
      .night-row{margin-top:16px;min-height:48px}.night-row label{flex:1;cursor:pointer}.night-row small{display:block;color:var(--secondary-text-color);font-size:14px;margin-top:4px}.night-row input{width:28px;height:28px;accent-color:var(--primary-color);cursor:pointer}
      .confirmation{margin-top:20px;border-top:1px solid var(--divider-color);padding-top:12px}.confirmation[hidden],.pi-control[hidden]{display:none}.message{margin-top:16px}p{line-height:1.5}
    </style><button class="handle" aria-label="Настройки ${this.tablet ? 'планшета' : 'Pi'}" title="Потяните вниз: настройки ${this.tablet ? 'планшета' : 'Pi'}"></button>
    <div class="backdrop"></div><section class="panel" role="dialog" aria-modal="true" aria-label="Настройки ${this.tablet ? 'планшета' : 'Pi'}">
      <header>Настройки ${this.tablet ? 'планшета' : 'Pi'}<button class="close" aria-label="Закрыть настройки">✕</button></header>
      <div class="row night-row"><label for="screensaver-enabled">Заставка<small>После бездействия</small></label><input id="screensaver-enabled" type="checkbox" role="switch"></div>
      <div class="row night-row"><label for="screensaver-delay">Время до заставки</label><select id="screensaver-delay"></select></div>
      <div class="row night-row"><label for="interval">Смена фотографий</label><select id="interval"></select></div>
      <div class="row night-row pi-control" ${this.tablet ? 'hidden' : ''}><label for="night-blanking">Ночное гашение экрана<small>23:00–07:00 · после 2 минут без касаний</small></label><input id="night-blanking" type="checkbox" role="switch" disabled></div>
      <div class="row night-row"><label for="theme-mode">Тема</label><select id="theme-mode"><option value="light">Светлая</option><option value="dark">Тёмная</option></select></div>
      <div class="power pi-control" ${this.tablet ? 'hidden' : ''}><button class="restart">Перезапустить Pi</button><button class="shutdown danger">Выключить Pi</button></div>
      <div class="confirmation" hidden><p class="question"></p><div class="power"><button class="cancel">Отмена</button><button class="confirm danger">Подтвердить</button></div></div>
      <div class="message" role="status"></div>
    </section>`;
    const select = this.shadowRoot.querySelector('#interval');
    for (const seconds of PHOTO_INTERVALS) {
      const option = document.createElement('option');
      option.value = String(seconds);
      option.textContent = seconds < 60 ? `${seconds} секунд` : `${seconds / 60} мин.`;
      select.append(option);
    }
    try { select.value = String(photoInterval(localStorage.getItem(PHOTO_INTERVAL_KEY))); } catch { select.value = '30'; }
    select.addEventListener('change', () => {
      try {
        localStorage.setItem(PHOTO_INTERVAL_KEY, String(photoInterval(select.value)));
        window.dispatchEvent(new Event('home-console-photo-interval-changed'));
        this.message.textContent = 'Интервал сохранён на этом устройстве.';
      } catch { this.message.textContent = 'Не удалось сохранить интервал.'; }
    });
    for (const [key, selector] of Object.entries({ message: '.message', confirmation: '.confirmation', question: '.question', closeButton: '.close', confirmButton: '.confirm' })) this[key] = this.shadowRoot.querySelector(selector);
    this.delaySelect = this.shadowRoot.querySelector('#screensaver-delay');
    for (const seconds of SCREENSAVER_DELAYS) {
      const option = document.createElement('option');
      option.value = String(seconds);
      option.textContent = seconds < 60 ? `${seconds} сек.` : `${seconds / 60} мин.`;
      this.delaySelect.append(option);
    }
    this.delaySelect.value = String(screensaverDelay());
    this.delaySelect.addEventListener('change', () => {
      try {
        const seconds = Number(this.delaySelect.value);
        if (!SCREENSAVER_DELAYS.includes(seconds)) throw new Error('Invalid delay');
        localStorage.setItem(SCREENSAVER_DELAY_KEY, String(seconds));
        window.dispatchEvent(new Event('home-console-screensaver-changed'));
        this.message.textContent = 'Время до заставки сохранено на этом устройстве.';
      } catch {
        this.delaySelect.value = String(screensaverDelay());
        this.message.textContent = 'Не удалось сохранить время до заставки.';
      }
    });
    this.screensaverToggle = this.shadowRoot.querySelector('#screensaver-enabled');
    this.screensaverToggle.checked = screensaverEnabled();
    this.screensaverToggle.addEventListener('change', () => {
      try {
        localStorage.setItem(SCREENSAVER_ENABLED_KEY, String(this.screensaverToggle.checked));
        window.dispatchEvent(new Event('home-console-screensaver-changed'));
        this.message.textContent = this.screensaverToggle.checked ? 'Заставка включена на этом устройстве.' : 'Заставка отключена на этом устройстве.';
      } catch {
        this.screensaverToggle.checked = screensaverEnabled();
        this.message.textContent = 'Не удалось сохранить настройку заставки.';
      }
    });
    this.nightToggle = this.shadowRoot.querySelector('#night-blanking');
    this.nightToggle.addEventListener('change', () => void this.changeNightBlanking());
    this.themeSelect = this.shadowRoot.querySelector('#theme-mode');
    this.themeSelect.addEventListener('change', () => void this.changeTheme());
    this.closeButton.addEventListener('click', () => this.close());
    this.shadowRoot.querySelector('.backdrop').addEventListener('click', () => this.close());
    this.shadowRoot.querySelector('.handle').addEventListener('click', () => this.open());
    this.shadowRoot.querySelector('.restart').addEventListener('click', () => this.prepare('restart'));
    this.shadowRoot.querySelector('.shutdown').addEventListener('click', () => this.prepare('shutdown'));
    this.shadowRoot.querySelector('.cancel').addEventListener('click', () => { this.pending = null; this.confirmation.hidden = true; });
    this.confirmButton.addEventListener('click', () => void this.execute());
    this.addEventListener('keydown', event => { if (event.key === 'Escape') this.close(); });
    for (const event of ['touchstart', 'touchmove', 'touchend']) this.addEventListener(event, e => { if (this.scope()) e.stopPropagation(); }, { passive: true });
  }
}
if (!customElements.get('home-console-control-drawer')) customElements.define('home-console-control-drawer', HomeConsoleControlDrawer);
if (!document.querySelector('home-console-control-drawer')) document.body.append(document.createElement('home-console-control-drawer'));
