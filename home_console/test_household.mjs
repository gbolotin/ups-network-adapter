import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHouseholdDashboard, buildCameraDashboard, entityReferences } from './household_dashboard.mjs';
import { PLAYERS, DENON, TV } from './dashboard.mjs';

test('household music controls use fixed rooms without changing the Pi selector', () => {
  const dashboard = buildHouseholdDashboard();
  assert.equal(JSON.stringify(dashboard).includes('pi_console_'), false);
  const rooms = dashboard.views.find(v => v.path === 'music').sections.slice(0, 4);
  assert.deepEqual(rooms.map(s => s.cards[1].entity), PLAYERS.map(p => p.entity));
  const references = entityReferences(dashboard);
  for (const id of [DENON, TV, 'lock.lock_ultra_17', 'media_player.spotifyplus_gabi']) assert.ok(references.has(id));
  assert.equal(dashboard.swipe_nav.enable, false);
  assert.equal(references.has('media_player.turn_off'), false);
});

test('camera cleanup preserves the feed and every saved-position action', () => {
  const feed = { type: 'custom:webrtc-camera', url: 'private camera configuration' };
  const positions = { type: 'vertical-stack', cards: [{ type: 'button', tap_action: { action: 'perform-action', perform_action: 'number.set_value', target: { entity_id: 'number.camera_position' }, data: { value: 1 } } }] };
  const original = { views: [{ type: 'sections', sections: [{ type: 'grid', cards: [{ type: 'heading', heading: 'Camera' }, feed, positions] }, { type: 'grid', cards: [{ type: 'heading' }] }] }] };
  const after = buildCameraDashboard(original);
  assert.deepEqual(after.views[0].sections[0].cards[1], feed);
  assert.deepEqual(after.views[1].sections[0].cards[1], positions);
  assert.equal(after.views[1].path, 'positions');
  assert.equal(after.views[1].subview, true);
  assert.equal(original.views[0].sections.length, 2);
  assert.ok(entityReferences(after).has('number.camera_position'));
  assert.equal(entityReferences(after).has('number.set_value'), false);
  assert.throws(() => buildCameraDashboard({ views: [] }));
});
