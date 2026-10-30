import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('favorites refresh adds and removes stations without starting playback', async () => {
  let Card;
  let favorites = [{ uri: 'library://radio/1', name: 'First', favorite: true, media_type: 'radio', available: true }];
  const calls = [];
  const element = tag => ({ tag, children: [], events: {}, append(child) { this.children.push(child); },
    replaceChildren() {}, setAttribute() {}, addEventListener(name, action) { this.events[name] = action; },
    replaceWith(child) { this.replacement = child; } });
  const context = vm.createContext({
    HTMLElement: class { setAttribute(key, value) { this[key] = value; } attachShadow() { this.shadowRoot = element(); } },
    customElements: { get() {}, define(name, card) { Card = card; } },
    document: { createElement: element },
    AbortController, AbortSignal, URL, Date,
    fetch: async (url, options) => {
      const request = JSON.parse(options.body);
      if (request.command !== 'music/radios/library_items') {
        const removing = request.command === 'music/favorites/remove_item';
        assert.ok(removing || request.command === 'music/favorites/add_item');
        const station = favorites.find(item => removing ? item.uri.endsWith('/' + request.args.library_item_id) : item.uri === request.args.item);
        station.favorite = !removing;
        return { ok: true, text: async () => 'null' };
      }
      assert.equal(request.args.favorite, undefined);
      return { ok: true, json: async () => favorites };
    },
  });
  vm.runInContext(await readFile(new URL('./ui/radio-favorites.js', import.meta.url), 'utf8'), context);
  const card = new Card();
  card.setConfig({ ma_token: 'test', player: 'media_player.denon_avc_x4700h_3', layout: 'vertical' });
  assert.equal(card.layout, 'vertical');
  card.hass = { callService(...args) { calls.push(args); } };
  card.connection = async () => 'http://test';
  await card.refresh();
  assert.equal(card.buttons.length, 1);
  let stopped = false;
  card.strip.events.touchmove({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
  card.strip.scrollLeft = 200;
  card.strip.scrollTop = 160;
  favorites = [...favorites, { ...favorites[0], uri: 'library://radio/2', name: 'New favorite' }, { ...favorites[0], favorite: false }];
  await card.refresh();
  assert.equal(card.buttons.length, 3);
  assert.equal(card.strip.scrollLeft, 200);
  assert.equal(card.strip.scrollTop, 160);
  assert.equal(calls.length, 0);
  assert.equal(card.buttons[1].children[0].tag, 'ha-icon');
  favorites[1].metadata = { images: [{ type: 'thumb', remotely_accessible: true, path: 'https://example.com/logo.png' }] };
  await card.refresh();
  const image = card.buttons[1].children[0];
  assert.equal(image.tag, 'img');
  assert.equal(image.src, 'https://example.com/logo.png');
  image.events.error();
  assert.equal(image.replacement.tag, 'ha-icon');
  await card.buttons[1].events.click();
  assert.equal(calls[0][0], 'script');
  assert.equal(calls[0][1], 'home_console_receiver_radio');
  assert.equal(calls[0][2].media_id, 'library://radio/2');
  await card.buttons[1].events.click();
  assert.equal(calls.length, 2, 'repeat taps dispatch the same station again');
  assert.equal(calls[1][2].media_id, 'library://radio/2');
  await card.favoriteButtons[1].events.click();
  assert.equal(favorites[1].favorite, false);
  assert.equal(calls.length, 2);
  await card.favoriteButtons[1].events.click();
  assert.equal(favorites[1].favorite, true);
  card.filterButtons[1].events.click();
  assert.equal(card.buttons.length, 2);
  await card.favoriteButtons[1].events.click();
  assert.equal(card.buttons.length, 1);
  card.filterButtons[0].events.click();
  assert.equal(card.buttons.length, 3);
  assert.equal(calls.length, 2);
  favorites = [];
  await card.refresh();
  assert.equal(card.buttons.length, 0);
});
