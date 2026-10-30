// Place battery status inside the native lock card without replacing its controls.
class HomeConsoleDoorCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.generation = 0;
  }
  setConfig(config) {
    if (config.card?.type !== 'tile' || !config.card.entity?.startsWith('lock.') || config.battery?.type !== 'tile') throw new Error('Configure native lock and battery tiles');
    this.config = config;
    void this.render();
  }
  set hass(value) {
    this.homeAssistant = value;
    for (const card of this.cards || []) card.hass = value;
  }
  getCardSize() { return 2; }
  async render() {
    const generation = ++this.generation;
    const helpers = await window.loadCardHelpers();
    if (generation !== this.generation) return;
    const style = document.createElement('style');
    style.textContent = ':host{display:block;position:relative}.battery{position:absolute;top:0;right:0;width:50%;z-index:1}';
    const lock = helpers.createCardElement(this.config.card);
    const battery = helpers.createCardElement({ type: 'custom:home-console-borderless-tile', card: this.config.battery });
    battery.className = 'battery';
    this.cards = [lock, battery];
    for (const card of this.cards) card.hass = this.homeAssistant;
    this.shadowRoot.replaceChildren(style, lock, battery);
  }
}
if (!customElements.get('home-console-door-card')) customElements.define('home-console-door-card', HomeConsoleDoorCard);
