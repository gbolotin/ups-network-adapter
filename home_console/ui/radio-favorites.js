// Read library stations automatically; only an explicit native button tap starts playback.
class HomeConsoleRadioFavorites extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.generation = 0;
    this.buttons = [];
    this.onlyFavorites = false;
  }

  setConfig(config) {
    if (!config.ma_token || config.player !== 'media_player.denon_avc_x4700h_3') {
      throw new Error('Configure the restricted MA token and verified Denon player');
    }
    this.config = config;
    this.setAttribute('layout', config.layout === 'vertical' ? 'vertical' : 'horizontal');
    this.fingerprint = null;
    if (this.isConnected && this.homeAssistant) void this.refresh();
  }

  set hass(value) {
    const first = !this.homeAssistant;
    this.homeAssistant = value;
    if (first && this.isConnected && this.config) void this.refresh();
  }

  connectedCallback() {
    this.onVisible = () => { if (!document.hidden) void this.refresh(); };
    document.addEventListener('visibilitychange', this.onVisible);
    this.timer = setInterval(this.onVisible, 15000);
    if (this.config && this.homeAssistant) void this.refresh();
  }

  disconnectedCallback() {
    clearInterval(this.timer);
    document.removeEventListener('visibilitychange', this.onVisible);
    this.generation++;
    this.request?.abort();
    this.busy = false;
    this.ingress = null;
  }

  getCardSize() { return 2; }

  async connection(signal) {
    if (this.ingress && Date.now() < this.ingressExpires) return this.ingress;
    const info = await this.homeAssistant.callWS({ type: 'supervisor/api', endpoint: '/addons/d5369777_music_assistant/info', method: 'get' });
    signal.throwIfAborted();
    const url = new URL(info.ingress_entry, location.origin);
    if (info.state !== 'started' || !info.ingress || url.origin !== location.origin || !/^\/api\/hassio_ingress\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname) || url.search || url.hash) throw new Error('MA ingress unavailable');
    const session = await this.homeAssistant.callWS({ type: 'supervisor/api', endpoint: '/ingress/session', method: 'post' });
    signal.throwIfAborted();
    if (!/^[a-zA-Z0-9_-]+$/.test(session.session)) throw new Error('MA ingress unavailable');
    document.cookie = `ingress_session=${session.session};path=/api/hassio_ingress/;SameSite=Strict${location.protocol === 'https:' ? ';Secure' : ''}`;
    this.ingress = url.href.replace(/\/$/, '');
    this.ingressExpires = Date.now() + 240000;
    return this.ingress;
  }

  async refresh() {
    if (this.busy || !this.config || !this.homeAssistant) return;
    this.busy = true;
    const generation = ++this.generation;
    this.request = new AbortController();
    const signal = AbortSignal.any([this.request.signal, AbortSignal.timeout(20000)]);
    try {
      const base = await this.connection(signal);
      const stations = [];
      for (let offset = 0; ; offset += 500) {
        const response = await fetch(`${base}/api`, {
          method: 'POST', credentials: 'same-origin', redirect: 'error', signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.ma_token}` },
          body: JSON.stringify({ message_id: 1, command: 'music/radios/library_items', args: { limit: 500, offset } }),
        });
        if (!response.ok) throw new Error('Favorites unavailable');
        const page = await response.json();
        if (!Array.isArray(page)) throw new Error('Invalid favorites response');
        stations.push(...page.filter(item => item.media_type === 'radio' && item.uri));
        if (page.length < 500) break;
        if (offset >= 9500) throw new Error('Too many favorites');
      }
      signal.throwIfAborted();
      if (generation !== this.generation) return;
      const fingerprint = JSON.stringify(stations.map(item => [item.uri, item.name, item.available, item.favorite, item.metadata?.images]));
      if (fingerprint !== this.fingerprint) {
        this.stations = stations;
        await this.render(stations, generation);
        if (generation === this.generation) this.fingerprint = fingerprint;
      }
    } catch {
      if (generation !== this.generation) return;
      this.ingress = null;
      this.fingerprint = null;
      this.buttons = [];
      this.shadowRoot.textContent = 'Не удалось загрузить станции. Повтор через 15 секунд.';
    } finally {
      if (generation === this.generation) this.busy = false;
    }
  }

  async render(stations, generation) {
    if (generation !== this.generation) return;
    const style = document.createElement('style');
    style.textContent = `
      :host{display:flex;flex-direction:column;min-width:0;gap:8px}
      .filters{display:flex;gap:4px;flex:none}.filters button{flex:1;height:44px;justify-content:center;padding:4px}
      .filters button[aria-pressed=true]{color:var(--primary-color);border-color:var(--primary-color)}
      .station{display:flex;flex:0 0 250px;min-width:0;gap:4px}.station .play{flex:1}
      .station .favorite{flex:0 0 48px;justify-content:center;padding:4px;color:var(--primary-color)}
      .favorite ha-icon{width:28px;height:28px;--mdc-icon-size:28px}
      .stations{display:flex;gap:8px;overflow-x:auto;overflow-y:hidden;padding-bottom:8px;
        touch-action:pan-x pan-y;overscroll-behavior-x:contain;scrollbar-width:thin}
      button{display:flex;flex:0 0 200px;box-sizing:border-box;align-items:center;gap:12px;min-width:0;height:72px;padding:8px 12px;
        background:var(--ha-card-background,var(--card-background-color));color:var(--primary-text-color);
        border:var(--ha-card-border-width,1px) solid var(--ha-card-border-color,var(--divider-color));
        border-radius:var(--ha-card-border-radius,12px);font:inherit;cursor:pointer;text-align:left}
      button:hover{background:var(--secondary-background-color)}
      button:focus-visible{outline:2px solid var(--primary-color);outline-offset:-3px}
      button:disabled{opacity:.5;cursor:default}
      img,ha-icon{width:40px;height:40px;flex:none;object-fit:contain;--mdc-icon-size:40px}
      span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      :host([layout=vertical]){height:100%;min-height:0}
      :host([layout=vertical]) .stations{flex:1;min-height:0;box-sizing:border-box;flex-direction:column;
        overflow-x:hidden;overflow-y:auto;padding-bottom:0;overscroll-behavior-y:contain}
      :host([layout=vertical]) .station{flex:0 0 auto;width:100%}
    `;
    const filters = document.createElement('div');
    filters.className = 'filters';
    this.filterButtons = [false, true].map(favorites => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = favorites ? 'Избранное' : 'Все';
      button.setAttribute('aria-pressed', String(this.onlyFavorites === favorites));
      button.addEventListener('click', () => {
        this.onlyFavorites = favorites;
        void this.render(this.stations || stations, this.generation);
      });
      filters.append(button);
      return button;
    });
    const grid = document.createElement('div');
    grid.className = 'stations';
    grid.tabIndex = 0;
    grid.setAttribute('role', 'region');
    grid.setAttribute('aria-label', 'Радиостанции');
    // Keep the browser's native touch scrolling, but isolate it from dashboard swipe navigation.
    for (const event of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
      for (const region of [grid, filters]) region.addEventListener(event, value => value.stopPropagation(), { passive: true });
    }
    this.favoriteButtons = [];
    const visible = stations.filter(station => !this.onlyFavorites || station.favorite);
    this.buttons = visible.map(station => {
      const row = document.createElement('div');
      row.className = 'station';
      const name = station.name.replace(/^Radio Paradise: /, '').replace(/ \(flac\)$/, '');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'play';
      button.title = station.name;
      button.disabled = station.available === false;
      const fallback = () => {
        const icon = document.createElement('ha-icon');
        icon.setAttribute('icon', 'mdi:radio');
        icon.setAttribute('aria-hidden', 'true');
        return icon;
      };
      const artwork = station.metadata?.images?.find(image => image.type === 'thumb' && image.remotely_accessible && /^https?:\/\//i.test(image.path));
      if (artwork) {
        const image = document.createElement('img');
        image.src = artwork.path;
        image.alt = '';
        image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', () => image.replaceWith(fallback()), { once: true });
        button.append(image);
      } else {
        button.append(fallback());
      }
      const label = document.createElement('span');
      label.textContent = name;
      button.append(label);
      button.addEventListener('click', async () => {
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        try {
          await this.homeAssistant.callService('script', 'home_console_receiver_radio', { media_id: station.uri });
          button.title = station.name;
        } catch {
          button.title = 'Не удалось запустить станцию. Нажмите ещё раз.';
        } finally {
          button.disabled = station.available === false;
          button.setAttribute('aria-busy', 'false');
        }
      });
      const favorite = document.createElement('button');
      favorite.type = 'button';
      favorite.className = 'favorite';
      favorite.title = station.favorite ? 'Убрать из избранного' : 'Добавить в избранное';
      favorite.setAttribute('aria-label', `${favorite.title}: ${station.name}`);
      favorite.setAttribute('aria-pressed', String(Boolean(station.favorite)));
      const heart = document.createElement('ha-icon');
      heart.setAttribute('icon', station.favorite ? 'mdi:heart' : 'mdi:heart-outline');
      favorite.append(heart);
      favorite.addEventListener('click', async () => {
        favorite.disabled = true;
        try {
          const signal = AbortSignal.timeout(20000);
          const base = await this.connection(signal);
          const response = await fetch(`${base}/api`, {
            method: 'POST', credentials: 'same-origin', redirect: 'error', signal,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.ma_token}` },
            body: JSON.stringify({ message_id: 2,
              command: station.favorite ? 'music/favorites/remove_item' : 'music/favorites/add_item',
              args: station.favorite ? { media_type: 'radio', library_item_id: station.item_id || station.uri.split('/').pop() } : { item: station.uri } }),
          });
          if (!response.ok) throw new Error('Favorite update failed');
          const result = await response.text();
          if (result && JSON.parse(result)?.error_code) throw new Error('Favorite update failed');
          this.fingerprint = null;
          await this.refresh();
        } catch {
          favorite.title = 'Не удалось изменить избранное. Нажмите ещё раз.';
        } finally { favorite.disabled = false; }
      });
      this.favoriteButtons.push(favorite);
      row.append(button);
      row.append(favorite);
      grid.append(row);
      return button;
    });
    if (!visible.length) grid.textContent = this.onlyFavorites ? 'Нет избранных радиостанций.' : 'Нет радиостанций в библиотеке.';
    const scrollLeft = this.strip?.scrollLeft || 0;
    const scrollTop = this.strip?.scrollTop || 0;
    this.shadowRoot.replaceChildren(style, filters, grid);
    grid.scrollLeft = scrollLeft;
    grid.scrollTop = scrollTop;
    this.strip = grid;
  }
}

if (!customElements.get('home-console-radio-favorites')) customElements.define('home-console-radio-favorites', HomeConsoleRadioFavorites);
