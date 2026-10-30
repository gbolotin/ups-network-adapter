import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard } from './dashboard.mjs';
import { resizeUps } from './resize_ups.mjs';
import { formatUpsRuntime, formatUpsLoad, formatUpsVoltage, upsVoltageCard } from './ui/ups-format.mjs';

test('voltage preserves measured tenths and adds a decimal to whole voltages', () => {
  assert.equal(formatUpsVoltage(runtime('232.4', 'V')), '232.4 V');
  assert.equal(formatUpsVoltage(runtime('232', 'V')), '232.0 V');
  assert.equal(formatUpsVoltage(runtime('13.6', 'V')), '13.6 V');
  for (const value of ['unknown', 'unavailable', '', '-1']) assert.equal(formatUpsVoltage(runtime(value, 'V')), null);
});

test('load watts are explicitly estimated from live rated watts and never from VA', () => {
  assert.equal(formatUpsLoad(runtime('10', '%'), runtime('410', 'W')), '10% · ≈41 W');
  assert.equal(formatUpsLoad(runtime('4', '%'), runtime('410', 'W')), '4% · ≈16 W');
  assert.equal(formatUpsLoad(runtime('0', '%'), runtime('410', 'W')), '0% · ≈0 W');
  for (const rating of [undefined, runtime('unknown', 'W'), runtime('750', 'VA'), runtime('0', 'W')]) {
    assert.equal(formatUpsLoad(runtime('10', '%'), rating), '10% · watts unavailable');
  }
  assert.equal(formatUpsLoad(runtime('unavailable', '%'), runtime('410', 'W')), null);
});

const runtime = (state, unit = 's') => ({ state, attributes: { unit_of_measurement: unit } });
test('connected UPS voltage follows available readings and restores the battery entity on return', () => {
  const card = { type: 'tile', entity: 'sensor.connected_ups_battery_voltage', name: 'Battery voltage', tap_action: { action: 'more-info' } };
  const states = { [card.entity]: runtime('unavailable', 'V'), 'sensor.connected_ups_output_voltage': runtime('229', 'V') };
  const output = upsVoltageCard(card, states);
  assert.equal(output.entity, 'sensor.connected_ups_output_voltage');
  assert.equal(output.name, 'Output voltage');
  assert.deepEqual(output.tap_action, card.tap_action);
  states[card.entity] = runtime('27.2', 'V');
  assert.deepEqual(upsVoltageCard(card, states), card);
  states[card.entity] = runtime('unknown', 'V');
  states['sensor.connected_ups_output_voltage'] = runtime('unavailable', 'V');
  assert.deepEqual(upsVoltageCard(card, states), card);
  assert.equal(card.entity, 'sensor.connected_ups_battery_voltage');
});
test('runtime uses hours/minutes above one hour, minutes/seconds below it', () => {
  for (const [seconds, expected] of [['27000', '7 hours, 30 minutes'], ['754', '12 minutes, 34 seconds'],
    ['3284', '54 minutes, 44 seconds'], ['3600', '1 hour, 0 minutes'], ['3599', '59 minutes, 59 seconds'],
    ['60', '1 minute, 0 seconds'], ['1', '1 second'], ['0', '0 seconds'], ['90061', '25 hours, 1 minute']]) {
    assert.equal(formatUpsRuntime(runtime(seconds)), expected);
  }
  assert.equal(formatUpsRuntime(runtime('7.5', 'h')), '7 hours, 30 minutes');
  assert.equal(formatUpsRuntime(runtime('12.5', 'min')), '12 minutes, 30 seconds');
});

test('runtime preserves native missing and invalid values instead of displaying zero', () => {
  for (const value of ['unavailable', 'unknown', '', ' ', '-1', 'NaN', 'Infinity', '1e30']) {
    assert.equal(formatUpsRuntime(runtime(value)), null);
  }
  assert.equal(formatUpsRuntime(undefined), null);
  assert.equal(formatUpsRuntime(runtime('5', 'V')), null);
});

test('UPS readability preserves native sensor actions and every other view', () => {
  const before = buildDashboard();
  const after = resizeUps(before);
  assert.deepEqual(after.views.slice(1), before.views.slice(1));
  assert.deepEqual(after.views[0].cards[0].cards, [before.views[0].cards[0].cards[0], ...before.views[0].cards[0].cards[1].cards]);
  assert.equal(before.views[0].cards[0].type, 'vertical-stack');
});

test('UPS readability refuses an independently changed card layout', () => {
  const before = buildDashboard();
  before.views[0].cards[0].cards[1].cards.pop();
  assert.throws(() => resizeUps(before), /layout changed/);
});
