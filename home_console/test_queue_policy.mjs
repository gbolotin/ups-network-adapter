import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedTarget, mutationRequest } from './ui/queue-policy.mjs';
import { sanitizedConfig } from './enable_music.mjs';
import { verifyInstalled, APPROVED } from './install_hacs.mjs';
import { buildUiAssets } from './deploy_ui.mjs';
import { buildScripts } from './dashboard.mjs';

const mapping = { 'media_player.bedroom_3': 'bedroom', 'media_player.denon_avc_x4700h_3': 'denon' };
const states = { 'media_player.bedroom_3': { state: 'idle', attributes: { friendly_name: 'Bedroom' } } };
const target = selectedTarget(states, 'media_player.bedroom_3', mapping);
const queue = { queue_id: 'bedroom', current_index: 1, items: 5 };
const items = ['history', 'current', 'next', 'later', 'last'].map(queue_item_id => ({ queue_item_id }));

test('missing/unavailable/unknown selected player never falls back', () => {
  assert.equal(selectedTarget(states, 'media_player.denon_avc_x4700h_3', mapping), null);
  assert.equal(selectedTarget(states, 'not-allowed', mapping), null);
  for (const state of ['unknown', 'unavailable']) assert.equal(selectedTarget({ 'media_player.bedroom_3': { state } }, 'media_player.bedroom_3', mapping), null);
  assert.equal(target.queueId, 'bedroom');
});

test('queue mutation refuses another room and protects current/history', () => {
  assert.throws(() => mutationRequest('remove', target, { ...queue, queue_id: 'denon' }, items, 0, 'later'));
  for (const id of ['history', 'current']) assert.throws(() => mutationRequest('remove', target, queue, items, 0, id));
  assert.throws(() => mutationRequest('remove', target, queue, items, 0, 'removed'));
});

test('remove and move use stable IDs on the captured selected queue', () => {
  assert.deepEqual(mutationRequest('remove', target, queue, items, 0, 'next'), { command: 'player_queues/delete_item', args: { queue_id: 'bedroom', item_id_or_index: 'next' } });
  assert.deepEqual(mutationRequest('up', target, queue, items, 0, 'later'), { command: 'player_queues/move_item', args: { queue_id: 'bedroom', queue_item_id: 'later', pos_shift: -1 } });
  assert.deepEqual(mutationRequest('down', target, queue, items, 0, 'next'), { command: 'player_queues/move_item', args: { queue_id: 'bedroom', queue_item_id: 'next', pos_shift: 1 } });
});

test('movement cannot cross the current item or the end of a queue', () => {
  assert.throws(() => mutationRequest('up', target, queue, items, 0, 'next'));
  assert.throws(() => mutationRequest('down', target, queue, items, 0, 'last'));
});

test('pagination guards use the absolute queue index', () => {
  const pagedQueue = { queue_id: 'bedroom', current_index: 19, items: 42 };
  const page = [{ queue_item_id: 'twenty' }, { queue_item_id: 'twenty-one' }];
  assert.throws(() => mutationRequest('up', target, pagedQueue, page, 20, 'twenty'));
  assert.equal(mutationRequest('up', target, pagedQueue, page, 20, 'twenty-one').args.pos_shift, -1);
});

test('sanitized exports remove tokens at every card nesting level', () => {
  const original = { views: [{ cards: [{ card: { ma_token: 'private', entity: 'kept' } }] }] };
  const clean = sanitizedConfig(original);
  assert.equal(JSON.stringify(clean).includes('private'), false);
  assert.equal(clean.views[0].cards[0].card.entity, 'kept');
  assert.equal(original.views[0].cards[0].card.ma_token, 'private');
});

test('HACS verification rejects missing installs or unapproved versions', () => {
  assert.throws(() => verifyInstalled({ installed: false, installed_version: APPROVED[0].version }, APPROVED[0]));
  assert.throws(() => verifyInstalled({ installed: true, installed_version: 'v99.0.0' }, APPROVED[0]));
  assert.doesNotThrow(() => verifyInstalled({ installed: true, installed_version: APPROVED[0].version }, APPROVED[0]));
});

test('published hashed modules resolve imports within the same asset set', async () => {
  const { assets, entry } = await buildUiAssets();
  const names = new Set(assets.map(asset => asset.name));
  assert.equal(names.size, 5);
  assert.ok(names.has(entry));
  for (const asset of assets) {
    for (const match of asset.text.matchAll(/(?:from\s+|import\s*)'\.\/([^']+)'/g)) {
      assert.ok(names.has(match[1]), `Missing module ${match[1]}`);
    }
  }
});

test('transfer rejects external playback without an active MA queue', () => {
  const guard = buildScripts().home_console_transfer.sequence[1];
  assert.match(guard.if[0].value_template, /state_attr\(source_player, 'active_queue'\)/);
  assert.equal(guard.then[0].error, true);
});
