import { formatUpsRuntime, formatUpsLoad, formatUpsVoltage, upsVoltageCard } from './ups-format.mjs';

function formattedReading(entity, states) {
  if (['sensor.ups_battery_runtime', 'sensor.connected_ups_battery_runtime'].includes(entity)) return formatUpsRuntime(states?.[entity]);
  if (entity === 'sensor.ups_apc_load') return formatUpsLoad(states?.[entity], states?.['sensor.ups_nominal_real_power']);
  if (entity === 'sensor.connected_ups_load') return formatUpsLoad(states?.[entity], states?.['sensor.connected_ups_nominal_real_power'], states?.['sensor.connected_ups_real_power']);
  if (['sensor.ups_apc_input_voltage', 'sensor.ups_battery_voltage', 'sensor.connected_ups_input_voltage', 'sensor.connected_ups_battery_voltage', 'sensor.connected_ups_output_voltage'].includes(entity)) return formatUpsVoltage(states?.[entity]);
  return null;
}
// Presentation-only wrapper. HA native cards retain readings and more-info actions.
class HomeConsoleUps extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.cards = [];
    this.observers = [];
    this.generation = 0;
    this.decorations = new Map();
    this.cardConfigs = new Map();
  }

  setConfig(config) {
    if (config.cards?.length !== 6 || config.cards[0].type !== 'markdown'
        || !config.cards.slice(1).every(card => card.type === 'tile' && card.entity?.startsWith('sensor.'))) {
      throw new Error('UPS layout requires one status card and five native sensor tiles');
    }
    this.config = config;
    if (this.isConnected) void this.render();
  }

  set hass(value) {
    this.homeAssistant = value;
    for (const [index, card] of this.cards.entries()) {
      const config = upsVoltageCard(this.config.cards[index], value.states);
      if (this.cardConfigs.get(card)?.entity !== config.entity) card.setConfig(config);
      this.cardConfigs.set(card, config);
      card.hass = value;
      void card.updateComplete?.then(() => this.decorations.get(card)?.());
    }
    if (this.powerCard) this.powerCard.hass = value;
    if (this.powerSlot && this.powerIdentity !== value.states['sensor.connected_ups_connected']?.attributes.id) this.powerSlot.hidden = true;
    void this.refreshPower();
  }

  getCardSize() { return 8; }

  connectedCallback() {
    if (this.config) void this.render();
    this.powerTimer = setInterval(() => void this.refreshPower(), 10000);
  }

  disconnectedCallback() {
    this.generation++;
    clearInterval(this.powerTimer);
    for (const observer of this.observers) observer.disconnect();
    this.observers = [];
    this.decorations.clear();
  }

  decorate(card, summary, config) {
    if (!card.shadowRoot) return;
    const apply = () => {
      const current = this.cardConfigs.get(card) || config;
      if (summary) {
        const markdown = card.shadowRoot.querySelector('ha-markdown');
        if (markdown) {
          markdown.style.fontSize = 'var(--ups-body-size)';
          void markdown.updateComplete?.then(() => {
            const root = markdown.shadowRoot;
            if (!markdown.isConnected || !root || root.querySelector('#ups-summary-spacing')) return;
            const spacing = document.createElement('style');
            spacing.id = 'ups-summary-spacing';
            spacing.textContent = 'h2{margin:0 0 8px}p{margin:0;line-height:1.35}';
            root.append(spacing);
          });
        }
      } else {
        const icon = card.shadowRoot.querySelector('ha-tile-icon');
        if (icon) {
          icon.style.setProperty('--mdc-icon-size', '63px');
          icon.style.setProperty('--tile-icon-size', '94.5px');
        }
        if (['sensor.ups_battery_runtime', 'sensor.ups_apc_load', 'sensor.ups_apc_input_voltage', 'sensor.ups_battery_voltage',
          'sensor.connected_ups_battery_runtime', 'sensor.connected_ups_load', 'sensor.connected_ups_input_voltage', 'sensor.connected_ups_battery_voltage', 'sensor.connected_ups_output_voltage'].includes(current.entity)) {
          const info = card.shadowRoot.querySelector('ha-tile-info');
          if (info) {
            const text = formattedReading(current.entity, this.homeAssistant?.states);
            for (const native of info.querySelectorAll('[slot="secondary"]:not([data-ups-formatted])')) {
              native.style.display = text === null ? '' : 'none';
            }
            let formatted = info.querySelector('[data-ups-formatted]');
            if (text === null) {
              formatted?.remove();
            } else {
              if (!formatted) {
                formatted = document.createElement('span');
                formatted.slot = 'secondary';
                formatted.dataset.upsFormatted = '';
                formatted.style.whiteSpace = 'normal';
                info.append(formatted);
              }
              if (formatted.textContent !== text) formatted.textContent = text;
            }
          }
        }
      }
    };
    apply();
    this.decorations.set(card, apply);
    // Templates/lazy native cards may render after the first hass assignment.
    const observer = new MutationObserver(apply);
    observer.observe(card.shadowRoot, { childList: true, subtree: true });
    this.observers.push(observer);
  }

  async refreshPower() {
    if (!this.isConnected || !this.powerSlot || !this.homeAssistant || this.powerBusy
        || Date.now() - (this.lastPowerCheck || 0) < 8000) return;
    const expected = this.homeAssistant.states['sensor.connected_ups_connected']?.attributes.id;
    if (!expected) { this.powerSlot.hidden = true; return; }
    this.lastPowerCheck = Date.now();
    this.powerBusy = true;
    const generation = this.generation;
    try {
      const result = await this.homeAssistant.callWS({ type: 'call_service', domain: 'rest_command',
        service: 'home_console_ups_status', service_data: {}, return_response: true });
      if (!this.isConnected || generation !== this.generation) return;
      const info = result.response?.content;
      if (result.response?.status !== 200 || !info?.can_power_off || info.id !== expected
          || this.homeAssistant.states['sensor.connected_ups_connected']?.attributes.id !== expected) {
        this.powerSlot.hidden = true;
        return;
      }
      if (this.powerIdentity !== expected || !this.powerCard) {
        this.powerCard = this.helpers.createCardElement({ type: 'button', name: 'Выключить выход ИБП',
          icon: 'mdi:power', show_name: true, show_icon: true,
          tap_action: { action: 'perform-action', perform_action: 'rest_command.home_console_ups_off',
            data: { expected_identity: expected }, confirmation: {
              text: `Выключить выход ${info.model}? Все подключённые устройства немедленно потеряют питание. Для включения может потребоваться кнопка на ИБП.`,
            } }, hold_action: { action: 'none' }, double_tap_action: { action: 'none' } });
        this.powerCard.hass = this.homeAssistant;
        this.powerSlot.replaceChildren(this.powerCard);
        this.powerIdentity = expected;
      }
      this.powerSlot.hidden = false;
    } catch { if (generation === this.generation) this.powerSlot.hidden = true; }
    finally { this.powerBusy = false; }
  }

  async render() {
    const generation = ++this.generation;
    for (const observer of this.observers) observer.disconnect();
    this.observers = [];
    this.decorations.clear();
    this.cardConfigs.clear();
    try {
      const helpers = await window.loadCardHelpers();
      this.helpers = helpers;
      if (!this.isConnected || generation !== this.generation) return;
      const style = document.createElement('style');
      style.textContent = `
        :host{display:block;--ups-body-size:calc(var(--ha-font-size-m,14px)*2.625);--ups-heading-size:calc(var(--ha-font-size-xl,20px)*2.625);--ups-value-size:calc(var(--ha-font-size-s,12px)*2.625)}
        .layout{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:auto repeat(3,minmax(117.6px,1fr)) auto;gap:8px;min-height:calc(100svh - var(--ups-chrome,16px));box-sizing:border-box;--ha-card-border-radius:var(--restore-card-border-radius,var(--ha-border-radius-lg,12px));--ha-card-border-width:var(--restore-card-border-width,1px);--ha-card-box-shadow:var(--restore-card-box-shadow,none)}
        .summary{font-size:var(--ups-body-size);grid-column:1/-1;--ha-font-size-xl:var(--ups-heading-size);--ha-font-size-m:var(--ups-body-size)}
        .metric{height:100%;min-height:0;--ha-tile-info-primary-font-size:var(--ups-body-size);--ha-tile-info-secondary-font-size:var(--ups-value-size);--row-height:117.6px}
        .charge{grid-column:1/-1}
        .power{grid-column:1/-1;height:61.6px;--ha-font-size-m:19.6px;--mdc-icon-size:33.6px;--state-icon-color:var(--error-color)}.power[hidden]{display:none}.power>*{display:block;height:100%}
        @media(max-width:430px){.layout{grid-template-columns:minmax(0,1fr);grid-template-rows:auto;min-height:0}.metric{min-height:117.6px}}
      `;
      this.style.setProperty('--ups-chrome', new URLSearchParams(location.search).has('kiosk') ? '16px' : '120px');
      const layout = document.createElement('div');
      layout.className = 'layout';
      this.cards = this.config.cards.map((config, index) => {
        const selected = upsVoltageCard(config, this.homeAssistant?.states);
        const card = helpers.createCardElement(selected);
        this.cardConfigs.set(card, selected);
        card.classList.add(index === 0 ? 'summary' : 'metric');
        if (index === 1) card.classList.add('charge');
        card.hass = this.homeAssistant;
        layout.append(card);
        return card;
      });
      this.powerSlot = document.createElement('div');
      this.powerSlot.className = 'power';
      this.powerSlot.hidden = true;
      this.powerCard = null;
      this.powerIdentity = null;
      this.lastPowerCheck = 0;
      layout.append(this.powerSlot);
      this.shadowRoot.replaceChildren(style, layout);
      void this.refreshPower();
      for (const [index, card] of this.cards.entries()) {
        await customElements.whenDefined(card.localName);
        await card.updateComplete;
        if (!this.isConnected || generation !== this.generation) return;
        this.decorate(card, index === 0, this.config.cards[index]);
      }
    } catch {
      if (generation !== this.generation) return;
      const error = document.createElement('ha-alert');
      error.setAttribute('alert-type', 'error');
      error.textContent = 'UPS layout could not load. Reload this view.';
      this.shadowRoot.replaceChildren(error);
    }
  }
}

if (!customElements.get('home-console-ups')) customElements.define('home-console-ups', HomeConsoleUps);
