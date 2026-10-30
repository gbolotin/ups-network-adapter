// Scale only Home's cards; native card actions and dialogs remain unchanged.
class HomeConsoleHomeLayout extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.generation = 0;
  }

  setConfig(config) {
    if (config.card?.type !== 'vertical-stack') throw new Error('Configure the Home card stack');
    this.config = config;
    void this.render();
  }

  set hass(value) {
    this.homeAssistant = value;
    if (this.card) this.card.hass = value;
    if (this.controls) this.controls.hass = value;
  }

  getCardSize() { return 10; }

  async render() {
    const generation = ++this.generation;
    const helpers = await window.loadCardHelpers();
    if (generation !== this.generation) return;
    const style = document.createElement('style');
    style.textContent = ':host{display:block;min-width:0;--home-console-button-height:36px;--home-console-icon-size:24px}.scaled{zoom:2}.scaled>*{height:auto!important}';
    const scaled = document.createElement('div');
    scaled.className = 'scaled';
    // HA sliders compare screen coordinates with unscaled clientWidth.
    // Keep interactive receiver controls outside Home's CSS zoom.
    const stack = structuredClone(this.config.card);
    const controls = stack.cards.filter(card => card.type === 'custom:home-console-receiver-controls');
    stack.cards = stack.cards.filter(card => card.type !== 'custom:home-console-receiver-controls');
    this.card = helpers.createCardElement(stack);
    this.card.hass = this.homeAssistant;
    scaled.append(this.card);
    this.controls = controls.length ? helpers.createCardElement(controls[0]) : null;
    if (this.controls) {
      this.controls.hass = this.homeAssistant;
      this.controls.style.marginTop = '16px';
    }
    this.shadowRoot.replaceChildren(style, scaled, ...(this.controls ? [this.controls] : []));
  }
}

if (!customElements.get('home-console-home-layout')) customElements.define('home-console-home-layout', HomeConsoleHomeLayout);

// Home receiver footer: native volume/Mute and the copied native Off action.
class HomeConsoleReceiverControls extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.generation = 0;
  }

  setConfig(config) {
    if (config.cards?.length !== 2) throw new Error('Configure volume and receiver Off');
    this.config = config;
    void this.render();
  }

  set hass(value) {
    this.homeAssistant = value;
    for (const card of this.cards || []) card.hass = value;
  }

  getCardSize() { return 1; }

  async render() {
    const generation = ++this.generation;
    const helpers = await window.loadCardHelpers();
    if (generation !== this.generation) return;
    const style = document.createElement('style');
    style.textContent = ':host{display:grid;grid-template-columns:minmax(0,1fr) 88px;gap:16px;align-items:center;min-width:0;--home-console-button-height:88px;--home-console-icon-size:56px;--feature-height:84px}:host>*{min-width:0}';
    this.cards = this.config.cards.map(config => {
      const card = helpers.createCardElement(config);
      card.hass = this.homeAssistant;
      return card;
    });
    this.shadowRoot.replaceChildren(style, ...this.cards);
  }
}

if (!customElements.get('home-console-receiver-controls')) customElements.define('home-console-receiver-controls', HomeConsoleReceiverControls);
