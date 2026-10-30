// Presentation-only wrapper; the native HA button owns all actions.
// NVIDIA mark from Simple Icons: https://github.com/simple-icons/simple-icons/blob/develop/icons/nvidia.svg
const NVIDIA_PATH = 'M8.948 8.798v-1.43a6.7 6.7 0 0 1 .424-.018c3.922-.124 6.493 3.374 6.493 3.374s-2.774 3.851-5.75 3.851c-.398 0-.787-.062-1.158-.185v-4.346c1.528.185 1.837.857 2.747 2.385l2.04-1.714s-1.492-1.952-4-1.952a6.016 6.016 0 0 0-.796.035m0-4.735v2.138l.424-.027c5.45-.185 9.01 4.47 9.01 4.47s-4.08 4.964-8.33 4.964c-.37 0-.733-.035-1.095-.097v1.325c.3.035.61.062.91.062 3.957 0 6.82-2.023 9.593-4.408.459.371 2.34 1.263 2.73 1.652-2.633 2.208-8.772 3.984-12.253 3.984-.335 0-.653-.018-.971-.053v1.864H24V4.063zm0 10.326v1.131c-3.657-.654-4.673-4.46-4.673-4.46s1.758-1.944 4.673-2.262v1.237H8.94c-1.528-.186-2.73 1.245-2.73 1.245s.68 2.412 2.739 3.11M2.456 10.9s2.164-3.197 6.5-3.533V6.201C4.153 6.59 0 10.653 0 10.653s2.35 6.802 8.948 7.42v-1.237c-4.84-.6-6.492-5.936-6.492-5.936z';
class HomeConsoleActiveButton extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.generation = 0;
  }

  setConfig(config) {
    if (config.card?.type !== 'button') throw new Error('Active button requires a native button');
    this.config = config;
    this.title = config.tooltip || config.card.name;
    this.toggleAttribute('active', config.active !== false);
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
    const style = document.createElement('style');
    style.textContent = `
      :host { display: block; position:relative; border-radius: var(--ha-card-border-radius, 12px); }
      .logo { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);
        width:var(--home-console-icon-size,32px); height:var(--home-console-icon-size,32px);
        fill:#76b900; pointer-events:none; }
      hui-button-card {
        display: block;
        height: var(--home-console-button-height, 52px);
      }
      :host([active]) hui-button-card {
        --ha-card-background: color-mix(in srgb, var(--primary-color) 28%, var(--card-background-color));
        --ha-card-border-color: var(--primary-color);
        --ha-card-border-width: 1px;
        --ha-card-box-shadow: inset 0 0 0 2px var(--primary-color);
      }
    `;
    this.card = helpers.createCardElement(this.config.card);
    if (this.config.icon_color) this.card.style.setProperty('--state-icon-color', this.config.icon_color);
    this.card.hass = this.homeAssistant;
    this.shadowRoot.replaceChildren(style, this.card);
    if (this.config.logo === 'nvidia') {
      const logo = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      logo.setAttribute('viewBox', '0 0 24 24');
      logo.setAttribute('class', 'logo');
      logo.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', NVIDIA_PATH);
      logo.append(path);
      this.shadowRoot.append(logo);
    }
    if (this.config.logo === 'receiver-off') {
      const power = document.createElement('ha-icon');
      power.setAttribute('icon', 'mdi:power');
      power.setAttribute('aria-hidden', 'true');
      power.style.cssText = 'position:absolute;left:calc(50% + var(--home-console-icon-size,32px)*.12);top:calc(50% + var(--home-console-icon-size,32px)*.02);width:calc(var(--home-console-icon-size,32px)*.65);height:calc(var(--home-console-icon-size,32px)*.65);--mdc-icon-size:calc(var(--home-console-icon-size,32px)*.65);color:var(--error-color,#ef5350);background:var(--card-background-color);border-radius:50%;pointer-events:none';
      this.shadowRoot.append(power);
    }
    const card = this.card;
    await card.updateComplete;
    if (generation !== this.generation || !card.shadowRoot) return;
    const iconStyle = document.createElement('style');
    iconStyle.textContent = `
      ha-card { padding: 0 !important; }
      ha-state-icon {
        width: var(--home-console-icon-size, 32px) !important;
        height: var(--home-console-icon-size, 32px) !important;
        max-height: none !important;
        flex: none !important;
        --mdc-icon-size: var(--home-console-icon-size, 32px);
      }
    `;
    card.shadowRoot.append(iconStyle);
    if (this.config.logo === 'nvidia') iconStyle.textContent += 'ha-state-icon{visibility:hidden}';
  }
}

if (!customElements.get('home-console-active-button')) customElements.define('home-console-active-button', HomeConsoleActiveButton);
