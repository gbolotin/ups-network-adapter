// Preserve native tile behavior while removing its outer card decoration.
class HomeConsoleBorderlessTile extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.generation = 0;
  }
  setConfig(config) {
    if (config.card?.type !== 'tile') throw new Error('Configure a native tile');
    this.config = config;
    void this.render();
  }
  set hass(value) {
    this.homeAssistant = value;
    if (this.card) this.card.hass = value;
  }
  getCardSize() { return 1; }
  async render() {
    const generation = ++this.generation;
    const helpers = await window.loadCardHelpers();
    if (generation !== this.generation) return;
    const card = helpers.createCardElement(this.config.card);
    this.card = card;
    card.hass = this.homeAssistant;
    this.shadowRoot.replaceChildren(card);
    await card.updateComplete;
    if (generation !== this.generation) return;
    const style = document.createElement('style');
    style.textContent = 'ha-card{background:transparent!important;border:none!important;box-shadow:none!important}';
    card.shadowRoot.append(style);
  }
}
if (!customElements.get('home-console-borderless-tile')) customElements.define('home-console-borderless-tile', HomeConsoleBorderlessTile);
