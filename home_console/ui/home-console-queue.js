import { selectedTarget, mutationRequest } from './queue-policy.mjs';

class HomeConsoleQueue extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.open = false;
    this.busy = false;
    this.generation = 0;
    this.offset = 0;
    this.items = [];
  }

  setConfig(config) {
    if (!config.player_helper || !config.player_map || !config.ma_token) throw new Error('Configure the Pi helper, verified player mapping, and restricted MA token');
    this.config = config;
    this.targetChanged();
  }

  set hass(hass) {
    this.homeAssistant = hass;
    const target = this.currentTarget();
    if (target?.entity !== this.target?.entity || target?.queueId !== this.target?.queueId) this.targetChanged();
  }

  currentTarget() {
    if (!this.homeAssistant || !this.config) return null;
    const selected = this.homeAssistant.states[this.config.player_helper]?.state;
    return selectedTarget(this.homeAssistant.states, selected, this.config.player_map);
  }

  targetChanged() {
    this.generation++;
    this.request?.abort();
    this.target = this.currentTarget();
    this.queue = null;
    this.items = [];
    this.offset = 0;
    this.busy = false;
    this.message = '';
    this.render();
    if (this.open && this.isConnected) void this.refresh();
  }

  connectedCallback() {
    this.render();
    this.timer = setInterval(() => { if (this.open && !this.busy) void this.refresh(); }, 15000);
    if (this.open) void this.refresh();
  }

  disconnectedCallback() {
    clearInterval(this.timer);
    this.generation++;
    this.request?.abort();
    this.ingress = null;
  }

  async connection(signal) {
    if (this.ingress && Date.now() < this.ingressExpires) return this.ingress;
    const info = await this.supervisor('/addons/d5369777_music_assistant/info', 'get', signal);
    if (signal.aborted) throw new Error('Cancelled');
    const url = new URL(info.ingress_entry, location.origin);
    if (info.state !== 'started' || !info.ingress || url.origin !== location.origin || !/^\/api\/hassio_ingress\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname)) throw new Error('MA ingress unavailable');
    const session = await this.supervisor('/ingress/session', 'post', signal);
    if (signal.aborted || !/^[a-zA-Z0-9_-]+$/.test(session.session)) throw new Error('MA ingress unavailable');
    document.cookie = `ingress_session=${session.session};path=/api/hassio_ingress/;SameSite=Strict${location.protocol === 'https:' ? ';Secure' : ''}`;
    this.ingress = url.href.replace(/\/$/, '');
    this.ingressExpires = Date.now() + 4 * 60 * 1000;
    return this.ingress;
  }

  async supervisor(endpoint, method, parentSignal) {
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(10000)]);
    signal.throwIfAborted();
    let onAbort;
    try {
      return await Promise.race([
        this.homeAssistant.callWS({ type: 'supervisor/api', endpoint, method }),
        new Promise((resolve, reject) => {
          onAbort = () => reject(new Error('Connection timed out or cancelled'));
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async command(command, args, signal) {
    const base = await this.connection(signal);
    const response = await fetch(`${base}/api`, {
      method: 'POST', credentials: 'same-origin', redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.ma_token}` },
      body: JSON.stringify({ message_id: 1, command, args }),
    });
    if (!response.ok) {
      this.ingress = null;
      throw new Error(response.status === 403 ? 'Queue access denied' : 'Queue connection failed');
    }
    return response.json();
  }

  async refresh() {
    if (this.busy || !this.target || !this.open) return;
    this.request?.abort();
    this.request = new AbortController();
    const signal = this.request.signal;
    const generation = this.generation;
    const target = this.target;
    this.busy = true;
    try {
      const queue = await this.command('player_queues/get', { queue_id: target.queueId }, signal);
      if (!queue || queue.queue_id !== target.queueId) throw new Error('Queue unavailable');
      const offset = Math.min(this.offset, Math.max(0, Math.floor((queue.items - 1) / 20) * 20));
      const items = await this.command('player_queues/items', { queue_id: target.queueId, limit: 20, offset }, signal);
      if (generation !== this.generation || signal.aborted) return;
      this.queue = queue;
      this.items = items;
      this.offset = offset;
      this.message = '';
    } catch (error) {
      if (generation !== this.generation || signal.aborted) return;
      this.queue = null;
      this.items = [];
      this.ingress = null;
      this.message = 'Queue unavailable. Check Music Assistant, then refresh.';
    } finally {
      if (generation === this.generation) { this.busy = false; this.render(); }
    }
  }

  async mutate(operation, itemId) {
    if (this.busy) return;
    const target = this.currentTarget();
    if (!target || target.entity !== this.target?.entity || target.queueId !== this.target?.queueId) { this.targetChanged(); return; }
    const generation = this.generation;
    this.request?.abort();
    this.request = new AbortController();
    const signal = this.request.signal;
    this.busy = true;
    this.render();
    try {
      // Another controller or normal playback may have advanced the queue since the last poll.
      const queue = await this.command('player_queues/get', { queue_id: target.queueId }, signal);
      const items = await this.command('player_queues/items', { queue_id: target.queueId, limit: 20, offset: this.offset }, signal);
      if (generation !== this.generation || signal.aborted || this.currentTarget()?.queueId !== target.queueId) return;
      const request = mutationRequest(operation, target, queue, items, this.offset, itemId);
      // Target captured at the tap; a room change never retargets this request.
      await this.command(request.command, request.args, signal);
      if (generation !== this.generation || signal.aborted) return;
      this.message = '';
    } catch {
      if (generation !== this.generation || signal.aborted) return;
      this.message = 'The queue change could not be confirmed. Refresh before retrying.';
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        if (!this.message) await this.refresh();
        else this.render();
      }
    }
  }

  element(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  button(text, action, disabled = false) {
    const button = this.element('button', text);
    button.disabled = disabled;
    button.addEventListener('click', action);
    return button;
  }

  render() {
    if (!this.config || !this.shadowRoot) return;
    this.shadowRoot.replaceChildren();
    const style = this.element('style');
    style.textContent = ':host{display:block}ha-card{padding:12px;color:var(--primary-text-color);background:var(--ha-card-background,var(--card-background-color));border-radius:var(--ha-card-border-radius,12px)}header,.tools,.row{display:flex;align-items:center;gap:8px}header{justify-content:space-between}.title{font-weight:600}.name{flex:1;min-width:0;overflow-wrap:anywhere}.status{padding:8px 0}.rows{max-height:280px;overflow:auto}.row{padding:8px 0;border-top:1px solid var(--divider-color)}.number{min-width:24px}button{min-width:48px;min-height:48px;padding:8px;border:1px solid var(--divider-color);border-radius:8px;background:transparent;color:var(--primary-text-color);font:inherit;cursor:pointer}button:disabled{opacity:.4;cursor:default}.tools{flex-wrap:wrap}.error{color:var(--error-color)}';
    this.shadowRoot.append(style);
    const card = this.element('ha-card');
    // Keep queue input/scroll gestures inside the queue; do not navigate views.
    for (const event of ['touchstart', 'touchmove', 'touchend']) card.addEventListener(event, value => value.stopPropagation(), { passive: true });
    const header = this.element('header');
    header.append(this.element('div', `Queue · ${this.target?.name || 'Selected player unavailable'}`, 'title'));
    header.append(this.button(this.open ? 'Hide queue' : 'Show queue', () => {
      this.open = !this.open;
      if (!this.open) { this.request?.abort(); this.generation++; this.busy = false; }
      this.render();
      if (this.open) void this.refresh();
    }));
    card.append(header);
    if (this.open) {
      const status = this.message || (!this.target ? 'Choose an available control room.' : this.queue ? `${this.queue.items} items · ${this.queue.active ? 'Active MA queue' : 'Inactive MA queue; inspection does not change the current source'}` : 'Loading queue…');
      card.append(this.element('div', status, this.message ? 'status error' : 'status'));
      const rows = this.element('div', undefined, 'rows');
      const current = Number.isInteger(this.queue?.current_index) ? this.queue.current_index : -1;
      this.items.forEach((item, localIndex) => {
        const index = this.offset + localIndex;
        const row = this.element('div', undefined, 'row');
        row.append(this.element('div', String(index + 1), 'number'));
        row.append(this.element('div', `${index === current ? 'Current · ' : ''}${item.media_item?.name || item.name || 'Untitled item'}`, 'name'));
        const blocked = this.busy || index <= current;
        row.append(this.button('↑', () => void this.mutate('up', item.queue_item_id), blocked || index <= current + 1));
        row.append(this.button('↓', () => void this.mutate('down', item.queue_item_id), blocked || index + 1 >= this.queue.items));
        row.append(this.button('Remove', () => void this.mutate('remove', item.queue_item_id), blocked));
        rows.append(row);
      });
      card.append(rows);
      const tools = this.element('div', undefined, 'tools');
      tools.append(this.button('Refresh', () => void this.refresh(), this.busy || !this.target));
      tools.append(this.button('Previous 20', () => { this.offset = Math.max(0, this.offset - 20); void this.refresh(); }, this.busy || !this.queue || this.offset === 0));
      tools.append(this.button('Next 20', () => { this.offset += 20; void this.refresh(); }, this.busy || !this.queue || this.offset + this.items.length >= this.queue.items));
      card.append(tools);
    }
    this.shadowRoot.append(card);
  }

  getCardSize() { return this.open ? 7 : 1; }
}

if (!customElements.get('home-console-queue')) customElements.define('home-console-queue', HomeConsoleQueue);
