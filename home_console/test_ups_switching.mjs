import test from 'node:test';
import assert from 'node:assert/strict';
import { switchUpsDashboard, UPS_SUMMARY } from './ups_switching.mjs';
import { buildDashboard } from './dashboard.mjs';
import { formatUpsLoad } from './ui/ups-format.mjs';

test('UPS replacement follows the adapter and preserves all other console views', () => {
  const before = buildDashboard();
  const after = switchUpsDashboard(before);
  assert.deepEqual(after.views.slice(1), before.views.slice(1));
  const cards = after.views[0].cards[0].cards;
  assert.equal(cards[0].content, UPS_SUMMARY);
  assert.equal(cards[1].cards[0].entity, 'sensor.connected_ups_battery_charge');
  assert.ok(!JSON.stringify(after.views[0]).includes('sensor.ups_apc'));
  assert.equal(before.views[0].cards[0].cards[1].cards[0].entity, 'sensor.ups_apc_battery_charge');
  assert.deepEqual(switchUpsDashboard(after), after);
});

test('Eaton measured watts take priority; APC falls back to a labelled estimate', () => {
  const state = (state, unit) => ({ state, attributes: { unit_of_measurement: unit } });
  assert.equal(formatUpsLoad(state('10', '%'), state('1200', 'W'), state('107', 'W')), '10% · 107 W');
  assert.equal(formatUpsLoad(state('10', '%'), state('410', 'W'), state('unavailable', 'W')), '10% · ≈41 W');
  assert.equal(formatUpsLoad(state('unavailable', '%'), state('1200', 'W'), state('107', 'W')), null);
});
