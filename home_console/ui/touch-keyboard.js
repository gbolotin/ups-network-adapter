import { layouts, consoleKeyboardScope, editText } from './keyboard-policy.mjs';

class HomeConsoleTouchKeyboard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.language = 'en';
    try { if (localStorage.getItem('home-console-keyboard-language') === 'ru') this.language = 'ru'; } catch {}
    this.shift = false;
    this.guardTouch = event => event.stopPropagation();
    this.onFocus = event => {
      const input = this.searchInput(event);
      if (input) this.show(input);
      else if (!event.composedPath().includes(this)) this.hide();
    };
    this.onPointer = event => {
      if (event.composedPath().includes(this)) return;
      const input = this.searchInput(event);
      if (input) this.show(input);
      else this.hide();
    };
    this.onLocation = () => { if (!this.scope() || !this.input?.isConnected) this.hide(); };
  }

  scope() { return consoleKeyboardScope(location.pathname, location.search); }

  searchInput(event) {
    if (!this.scope()) return null;
    const path = event.composedPath();
    if (!path.some(node => node.localName === 'ma-browser-card')) return null;
    return path.find(node => node instanceof HTMLInputElement && node.id === 'searchInp' && ['text', 'search'].includes(node.type) && !node.disabled && !node.readOnly) || null;
  }

  connectedCallback() {
    // Custom-element constructors must not add attributes during createElement().
    this.hidden = true;
    for (const event of ['touchstart', 'touchmove', 'touchend']) this.addEventListener(event, this.guardTouch, { passive: true });
    document.addEventListener('focusin', this.onFocus, true);
    document.addEventListener('pointerdown', this.onPointer, true);
    window.addEventListener('location-changed', this.onLocation);
    this.render();
  }

  disconnectedCallback() {
    this.hide();
    for (const event of ['touchstart', 'touchmove', 'touchend']) this.removeEventListener(event, this.guardTouch);
    document.removeEventListener('focusin', this.onFocus, true);
    document.removeEventListener('pointerdown', this.onPointer, true);
    window.removeEventListener('location-changed', this.onLocation);
  }

  show(input) {
    if (this.input !== input) {
      this.hide();
      this.input = input;
      for (const event of ['touchstart', 'touchmove', 'touchend']) input.addEventListener(event, this.guardTouch, { passive: true });
    }
    this.hidden = false;
    this.render();
    input.scrollIntoView({ block: 'nearest' });
  }

  hide() {
    if (this.input) for (const event of ['touchstart', 'touchmove', 'touchend']) this.input.removeEventListener(event, this.guardTouch);
    this.input = null;
    this.hidden = true;
  }

  press(key) {
    const input = this.input;
    if (!input?.isConnected || !this.scope()) { this.hide(); return; }
    if (key === 'Language') {
      this.language = this.language === 'en' ? 'ru' : 'en';
      try { localStorage.setItem('home-console-keyboard-language', this.language); } catch {}
      this.render();
      return;
    }
    if (key === 'Shift') { this.shift = !this.shift; this.render(); return; }
    if (key === 'Hide') { this.hide(); return; }
    if (key === 'Search') {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, composed: true }));
      input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      input.blur();
      this.hide();
      return;
    }
    const edited = editText(input.value, input.selectionStart, input.selectionEnd, key);
    input.value = edited.value;
    input.setSelectionRange(edited.caret, edited.caret);
    if (!['ArrowLeft', 'ArrowRight'].includes(key)) input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: key === 'Backspace' ? 'deleteContentBackward' : 'insertText' }));
    if (this.shift && key.length === 1 && /\p{L}/u.test(key)) { this.shift = false; this.render(); }
  }

  button(label, key, grow = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute('aria-label', label);
    if (grow) button.className = 'space';
    button.addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation(); });
    button.addEventListener('click', () => this.press(key));
    return button;
  }

  render() {
    const style = document.createElement('style');
    style.textContent = ':host{position:fixed;left:0;right:0;bottom:0;z-index:10000;padding:8px;box-sizing:border-box;background:var(--ha-card-background,var(--card-background-color,#202020));color:var(--primary-text-color,#fff);border-top:1px solid var(--divider-color,#666);box-shadow:0 -4px 16px #0006}:host([hidden]){display:none!important}.row{display:flex;gap:4px;margin-bottom:4px}.row:last-child{margin-bottom:0}button{flex:1;min-width:0;min-height:44px;border:1px solid var(--divider-color,#777);border-radius:8px;background:var(--secondary-background-color,#303030);color:inherit;font:inherit;font-size:18px;touch-action:manipulation;cursor:pointer}.space{flex:3}button:active{background:var(--primary-color,#009ac7)}';
    this.shadowRoot.replaceChildren(style);
    this.setAttribute('role', 'group');
    this.setAttribute('aria-label', 'Touch search keyboard');
    layouts[this.language].forEach((letters, index) => {
      const row = document.createElement('div');
      row.className = 'row';
      if (index === 3) row.append(this.button(this.shift ? 'Shift ↑' : 'Shift', 'Shift'));
      for (const letter of Array.from(letters)) {
        const value = this.shift ? letter.toUpperCase() : letter;
        row.append(this.button(value, value));
      }
      if (index === 3) row.append(this.button('⌫', 'Backspace'));
      this.shadowRoot.append(row);
    });
    const controls = document.createElement('div');
    controls.className = 'row';
    controls.append(this.button(this.language === 'en' ? 'EN → RU' : 'RU → EN', 'Language'));
    controls.append(this.button('←', 'ArrowLeft'), this.button('Space', 'Space', true), this.button('→', 'ArrowRight'));
    controls.append(this.button('Clear', 'Clear'), this.button('Search', 'Search'), this.button('Hide', 'Hide'));
    this.shadowRoot.append(controls);
  }
}

if (!customElements.get('home-console-touch-keyboard')) customElements.define('home-console-touch-keyboard', HomeConsoleTouchKeyboard);
if (!document.querySelector('home-console-touch-keyboard')) document.body.append(document.createElement('home-console-touch-keyboard'));
