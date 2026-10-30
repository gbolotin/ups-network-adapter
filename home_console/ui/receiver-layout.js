// Native Receiver cards: station column, Now Playing column, then volume/Mute/Off.
class HomeConsoleReceiverLayout extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.generation = 0;
    this.resize = () => this.fit();
  }

  setConfig(config) {
    const cards = config.card?.cards;
    if (config.card?.type !== 'vertical-stack' || cards?.length !== 4
        || cards[0].type !== 'media-control' || cards[2].type !== 'grid'
        || ![1, 2].includes(cards[2].cards?.length) || cards[3].type !== 'custom:home-console-radio-favorites') {
      throw new Error('Configure Receiver with Now Playing, volume, source controls and radio favorites');
    }
    this.config = config;
    this.style.setProperty('--receiver-source-count', String(cards[2].cards.length));
    void this.render();
  }

  set hass(value) {
    this.homeAssistant = value;
    for (const card of this.cards || []) card.hass = value;
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

  getCardSize() { return 10; }

  fit() {
    if (!this.isConnected) return;
    this.style.setProperty('--receiver-height', `${Math.max(0, window.innerHeight - this.getBoundingClientRect().top)}px`);
  }

  async render() {
    const generation = ++this.generation;
    const helpers = await window.loadCardHelpers();
    if (generation !== this.generation) return;
    const style = document.createElement('style');
    style.textContent = `
      :host { display:flex; flex-direction:column; gap:8px; min-width:0;
        height:var(--receiver-height,100dvh); box-sizing:border-box; }
      .body { display:grid; grid-template-columns:minmax(240px,28%) minmax(0,1fr);
        gap:8px; flex:1; min-height:0; }
      .media,.radio { display:block; min-width:0; min-height:0; height:100%; }
      .radio { display:flex; }
      .controls { display:grid; grid-template-columns:minmax(0,1fr) repeat(var(--receiver-source-count,1),80px);
        gap:8px; align-items:center; flex:none; min-height:72px;
        --home-console-button-height:72px; --home-console-icon-size:40px; }
      .controls>* { min-width:0; height:auto !important; }
    `;
    const body = document.createElement('div');
    body.className = 'body';
    this.media = helpers.createCardElement(this.config.card.cards[0]);
    this.radio = helpers.createCardElement({ ...this.config.card.cards[3], layout: 'vertical' });
    const volume = structuredClone(this.config.card.cards[1]);
    const volumeCard = volume.type === 'conditional' ? volume.card : volume;
    if (volumeCard.type === 'custom:home-console-volume-slider') volumeCard.hide_mute = false;
    this.volume = helpers.createCardElement(volume);
    this.volume.style.gridColumn = '1';
    this.sources = this.config.card.cards[2].cards.map(config => helpers.createCardElement(config));
    this.sources.forEach((card, index) => { card.style.gridColumn = String(index + 2); });
    this.cards = [this.media, this.radio, this.volume, ...this.sources];
    this.controls = document.createElement('div');
    this.media.classList.add('media');
    this.radio.classList.add('radio');
    this.controls.classList.add('controls');
    for (const card of this.cards) card.hass = this.homeAssistant;
    body.append(this.radio, this.media);
    this.controls.append(this.volume, ...this.sources);
    this.shadowRoot.replaceChildren(style, body, this.controls);
    await this.media.updateComplete;
    if (generation !== this.generation) return;
    const mediaStyle = document.createElement('style');
    mediaStyle.textContent = `
      ha-card { height:100%; }
      .player { height:100%; box-sizing:border-box; display:flex; flex-direction:column;
        justify-content:space-between; }
    `;
    this.media.shadowRoot.append(mediaStyle);
    requestAnimationFrame(this.resize);
  }
}

if (!customElements.get('home-console-receiver-layout')) customElements.define('home-console-receiver-layout', HomeConsoleReceiverLayout);
