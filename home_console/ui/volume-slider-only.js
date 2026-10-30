// Keep native volume behavior; hide presentation outside the slider.
class HomeConsoleVolumeSlider extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.generation = 0;
  }

  setConfig(config) {
    if (config.card?.type !== 'tile' || config.card.features?.[0]?.type !== 'media-player-volume-slider') {
      throw new Error('Volume slider requires a native volume tile');
    }
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
    this.styleRoot(card.shadowRoot, `
      ha-card {
        background: transparent !important;
        border: none !important;
        box-shadow: none !important;
        border-radius: 0 !important;
        --ha-card-background: transparent;
        --ha-card-border-width: 0;
        --ha-card-box-shadow: none;
      }
    `);
    const container = card.shadowRoot.querySelector('ha-tile-container');
    await container.updateComplete;
    this.styleRoot(container.shadowRoot, '.row, .background { display: none !important; }');
    const features = card.shadowRoot.querySelector('hui-card-features');
    await features.updateComplete;
    const feature = features.shadowRoot.querySelector('hui-card-feature');
    await feature.updateComplete;
    const volume = feature.shadowRoot.querySelector('hui-media-player-volume-slider-card-feature');
    await volume.updateComplete;
    if (generation !== this.generation) return;
    if (this.config.hide_mute !== false) {
      this.styleRoot(volume.shadowRoot, '.mute { display: none !important; }');
    }
  }

  styleRoot(root, css) {
    const style = document.createElement('style');
    style.textContent = css;
    root.append(style);
  }
}

if (!customElements.get('home-console-volume-slider')) customElements.define('home-console-volume-slider', HomeConsoleVolumeSlider);
