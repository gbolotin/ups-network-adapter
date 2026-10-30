import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard, PLAYERS, RECEIVER_RADIO, receiverRadioButtons, receiverRadioPlayback } from './dashboard.mjs';

test('Receiver radio replaces the queue on Denon independently of the selected room', () => {
  const grid = receiverRadioButtons();
  assert.equal(grid.cards.length, 6);
  for (const [index, wrapper] of grid.cards.entries()) {
    assert.deepEqual(wrapper.card.tap_action, {
      action: 'perform-action', perform_action: 'music_assistant.play_media',
      target: { entity_id: PLAYERS[0].entity },
      data: { media_id: RECEIVER_RADIO[index].uri, media_type: 'radio', enqueue: 'replace' },
    });
  }
});

test('Receiver keeps only Off after the volume controls', () => {
  const receiver = buildDashboard().views.find(view => view.path === 'receiver');
  const sources = receiver.cards[0].cards[0].card.cards[2];
  assert.equal(sources.columns, 1);
  assert.deepEqual(sources.cards.map(cell => cell.cards[0].card.card.name), ['Off']);
});

test('Receiver contains the Denon media card and Now Playing is removed', () => {
  const dashboard = buildDashboard();
  assert.equal(dashboard.views.some(view => view.path === 'now-playing'), false);
  const receiver = dashboard.views.find(view => view.path === 'receiver');
  assert.deepEqual(receiver.cards[0].cards[0].card.cards[0], { type: 'media-control', entity: PLAYERS[0].entity });
});

test('live station playback always prepares Denon HEOS before replacing the MA queue', () => {
  const script = receiverRadioPlayback();
  assert.equal(script.mode, 'restart', 'latest station tap replaces a pending request');
  assert.equal(script.sequence[0].then[0].error, true);
  assert.match(script.sequence[0].if[0].value_template, /library:\/\/radio/);
  assert.deepEqual(script.sequence[1], { action: 'script.home_console_denon_source', data: { source: 'HEOS Music' } });
  assert.match(script.sequence[2].wait_template, /HEOS Music/);
  assert.match(script.sequence[2].wait_template, /unavailable/);
  assert.equal(script.sequence[2].continue_on_timeout, false);
  assert.deepEqual(script.sequence[3], {
    action: 'music_assistant.play_media', target: { entity_id: PLAYERS[0].entity },
    data: { media_id: '{{ media_id }}', media_type: 'radio', enqueue: 'replace' },
  });
  assert.equal(script.sequence[3].if, undefined, 'already selected stations still send play_media');
});
