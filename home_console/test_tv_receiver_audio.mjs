import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScripts, tvSourceButtons, TV, DENON, withTvReceiverAudio, wakeAndSelect } from './dashboard.mjs';

test('every TV source button uses the shared script; Off only turns the TV off', () => {
  const grid = tvSourceButtons();
  for (const cell of grid.cards) {
    for (const conditional of cell.cards) {
      const button = conditional.card.card;
      const action = button.tap_action;
      if (button.name === 'Off') {
        assert.equal(action.perform_action, 'media_player.turn_off');
        assert.equal(action.target.entity_id, TV);
      } else {
        assert.equal(action.perform_action, 'script.home_console_tv_source');
        assert.ok(action.data.source);
      }
    }
  }
});

test('TV audio routing follows source selection, avoids repeated ARC commands and confirms feedback', () => {
  const before = wakeAndSelect(TV, ['HDMI 1'], 'TV');
  const saved = structuredClone(before);
  const after = withTvReceiverAudio(before);
  assert.deepEqual(before, saved);
  assert.deepEqual(after.sequence.slice(0, -2), before.sequence);
  assert.deepEqual(after.sequence.at(-2), { action: 'script.home_console_denon_source', data: { source: 'TV Audio' } });
  const route = after.sequence.at(-1);
  assert.match(route.if[0].value_template, /sound_output.*!= 'external_arc'/);
  assert.deepEqual(route.then[0], { action: 'webostv.select_sound_output', data: { entity_id: TV, sound_output: 'external_arc' } });
  assert.equal(route.then[1].continue_on_timeout, false);
  assert.match(route.then[1].wait_template, /sound_output.*== 'external_arc'/);
  assert.equal(buildScripts().home_console_tv_source.sequence.at(-1).then[0].action, 'webostv.select_sound_output');
  assert.throws(() => withTvReceiverAudio(wakeAndSelect(DENON, ['TV Audio'], 'Denon')));
});

test('repeated taps on an active source still select TV Audio on Denon', () => {
  const scripts = buildScripts();
  const action = scripts.home_console_tv_source.sequence.at(-2);
  assert.equal(action.action, 'script.home_console_denon_source');
  assert.equal(action.if, undefined, 'receiver command must not depend on the highlighted source or ARC output');
  const receiver = scripts.home_console_denon_source;
  assert.equal(receiver.sequence.at(-1).action, 'media_player.select_source');
  assert.equal(receiver.sequence.at(-1).target.entity_id, DENON);
  assert.equal(receiver.sequence.at(-1).data.source, '{{ source }}');
  assert.ok(receiver.fields.source.selector.select.options.includes('TV Audio'));
});
