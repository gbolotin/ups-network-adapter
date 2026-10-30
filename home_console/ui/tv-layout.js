// Fill the available viewport while native HA cards retain their device actions.
class HomeConsoleTvLayout extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.generation = 0;
    this.resize = () => this.fit();
  }

  setConfig(config) {
    if (config.card?.type !== 'vertical-stack' || config.card.cards?.[1]?.type !== 'grid') throw new Error('Configure the native TV status and source grid');
    this.config = config;
    void this.render();
  }

  set hass(value) {
    this.homeAssistant = value;
    if (this.card) this.card.hass = value;
  }

  connectedCallback() {
    window.addEventListener('resize', this.resize);
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(document.documentElement);
    this.fit();
  }

  disconnectedCallback() {
    window.removeEventListener('resize', this.resize);
    this.observer?.disconnect();
  }

  getCardSize() { return 8; }

  fit() {
    if (!this.isConnected || !this.card) return;
    const status = this.card.shadowRoot?.querySelector('hui-card');
    const statusHeight = status?.getBoundingClientRect().height || 56;
    const available = window.innerHeight - this.getBoundingClientRect().top - 8;
    const buttonHeight = Math.max(72, Math.floor((available - statusHeight - 16) / 2));
    this.style.setProperty('--home-console-button-height', `${buttonHeight}px`);
    this.style.setProperty('--home-console-icon-size', `${Math.min(80, Math.floor(buttonHeight * .45))}px`);
  }

  async render() {
    const generation = ++this.generation;
    const helpers = await window.loadCardHelpers();
    if (generation !== this.generation) return;
    const style = document.createElement('style');
    style.textContent = ':host{display:block;min-width:0}';
    this.card = helpers.createCardElement(this.config.card);
    this.card.hass = this.homeAssistant;
    this.shadowRoot.replaceChildren(style, this.card);
    await this.card.updateComplete;
    if (generation !== this.generation) return;
    requestAnimationFrame(() => this.fit());
  }
}

if (!customElements.get('home-console-tv-layout')) customElements.define('home-console-tv-layout', HomeConsoleTvLayout);
