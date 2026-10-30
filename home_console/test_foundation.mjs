import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFoundation, resolveNutSensors, verifyBackup } from './apply_foundation.mjs';
import { buildDashboard, buildScripts, buildTvWakeAutomation, DENON, TV, PLAYERS, PLAYER_HELPER } from './dashboard.mjs';
import { assertOutsideRepository, capture } from './ha_snapshot.mjs';

const backup = { backup_id: 'verified', homeassistant_included: true, database_included: true, agents: { 'hassio.local': { size: 1234 } }, failed_addons: [], failed_agent_ids: [], failed_folders: [] };
test('TV wake automation acts only on an explicit request for the mapped native TV', () => {
  const button = 'button.wake_on_lan_verified_tv';
  const automation = buildTvWakeAutomation(button);
  assert.deepEqual(automation.triggers, [{ trigger: 'webostv.turn_on', entity_id: TV }]);
  assert.deepEqual(automation.actions, [{ action: 'button.press', target: { entity_id: button } }]);
  assert.throws(() => buildTvWakeAutomation('switch.other_device'), /verified/);
});
const registry = [
  { entity_id: 'sensor.ups_apc_status_data', platform: 'nut', config_entry_id: 'apc', unique_id: 'APC_ups.status' },
  { entity_id: 'sensor.ups_battery_runtime', platform: 'nut', config_entry_id: 'apc', unique_id: 'APC_battery.runtime', disabled_by: 'integration' },
  { entity_id: 'sensor.ups_battery_voltage', platform: 'nut', config_entry_id: 'apc', unique_id: 'APC_battery.voltage', disabled_by: 'integration' },
  { entity_id: 'sensor.other_runtime', platform: 'nut', config_entry_id: 'other', unique_id: 'other_battery.runtime' },
];

function fakeHa({ existingDashboards = [], failedBackup = false } = {}) {
  const mutations = [];
  return {
    mutations,
    async rest(path, options = {}) {
      if (path === '/api/config') return { version: '2026.10.4' };
      if (path === '/api/states') return [];
      if (options.method === 'POST') { mutations.push({ path, options }); return { result: 'ok' }; }
      throw new Error('HA REST request failed (404)');
    },
    async command(type, parameters) {
      if (type === 'backup/info') return { state: failedBackup ? 'create_backup' : 'idle', backups: [backup] };
      if (type === 'lovelace/dashboards/list') return existingDashboards;
      if (type === 'input_select/list') return [];
      if (type === 'config/entity_registry/list') return registry;
      mutations.push({ type, parameters });
      if (type === 'input_select/create') return { id: parameters.name.toLowerCase().replaceAll(' ', '_') };
      if (type === 'lovelace/dashboards/create') return { id: 'home_console', ...parameters };
      return {};
    },
  };
}

function settings(apply = true) {
  return { snapshot: { config: { version: '2026.10.4' } }, backupId: 'verified', journal: { changes: [] }, saveJournal: async () => {}, apply };
}

test('dry run resolves existing sensor IDs and sends no writes', async () => {
  const ha = fakeHa();
  const result = await applyFoundation(ha, settings(false));
  assert.deepEqual(result.enable_sensors, ['sensor.ups_battery_runtime', 'sensor.ups_battery_voltage']);
  assert.equal(ha.mutations.length, 0);
});

test('failed/in-progress backup blocks every configuration change', async () => {
  const ha = fakeHa({ failedBackup: true });
  await assert.rejects(applyFoundation(ha, settings()), /completed, healthy HA backup/);
  assert.equal(ha.mutations.length, 0);
  assert.throws(() => verifyBackup({ state: 'idle', backups: [{ ...backup, failed_addons: ['music'] }] }, 'verified'));
});

test('existing dashboard blocks creation without overwriting it', async () => {
  const ha = fakeHa({ existingDashboards: [{ url_path: 'home-console' }] });
  await assert.rejects(applyFoundation(ha, settings()), /refusing to overwrite/);
  assert.equal(ha.mutations.length, 0);
});

test('foundation creates only scoped configuration and preserves selection after restart', async () => {
  const ha = fakeHa();
  const options = settings();
  await applyFoundation(ha, options);
  const helpers = ha.mutations.filter(item => item.type === 'input_select/create');
  assert.equal(helpers.length, 2);
  assert.equal(helpers[0].parameters.options[0], PLAYERS[0].entity);
  assert.equal('initial' in helpers[0].parameters, false);
  assert.ok(!ha.mutations.some(item => item.path?.startsWith('/api/services/')));
  assert.equal(options.journal.changes.length, 12);
  assert.equal(ha.mutations.filter(item => item.type === 'config/entity_registry/update' && item.parameters.hidden_by === 'user').length, 2);
  assert.ok(options.journal.changes.every(item => item.status === 'completed'));
});

test('partial failure leaves an accurate journal and never creates a dashboard', async () => {
  const ha = fakeHa();
  const rest = ha.rest.bind(ha);
  ha.rest = async (path, options) => {
    if (options?.method === 'POST') throw new Error('script save failed');
    return rest(path, options);
  };
  const options = settings();
  await assert.rejects(applyFoundation(ha, options), /script save failed/);
  assert.equal(options.journal.changes.at(-1).status, 'pending');
  assert.ok(!ha.mutations.some(item => item.type === 'lovelace/dashboards/create'));
});

test('sensor resolution rejects ambiguous mappings and never takes another UPS', () => {
  assert.equal(resolveNutSensors(registry, 'apc').runtime.entity_id, 'sensor.ups_battery_runtime');
  assert.throws(() => resolveNutSensors([...registry, { ...registry[1], entity_id: 'sensor.duplicate' }], 'apc'), /exactly one/);
});

test('lock tile opens details without direct lock actions; native scripts keep fixed targets', () => {
  const dashboard = buildDashboard();
  const home = dashboard.views.find(item => item.path === 'home').cards[0];
  assert.equal(home.type, 'custom:home-console-home-layout');
  const row = home.card.cards[0];
  assert.equal(row.type, 'custom:home-console-door-card');
  assert.equal(row.battery.entity, 'sensor.lock_ultra_17_battery');
  assert.equal(home.card.cards[1].entity, 'switch.power_plug_cd43');
  const lock = row.card;
  assert.equal(lock.type, 'tile');
  assert.equal(lock.entity, 'lock.lock_ultra_17');
  assert.equal(lock.name, 'Front door');
  assert.deepEqual(lock.features, [{ type: 'lock-commands' }]);
  for (const action of ['tap_action', 'icon_tap_action']) assert.equal(lock[action].action, 'more-info');
  for (const action of ['hold_action', 'double_tap_action', 'icon_hold_action', 'icon_double_tap_action']) {
    assert.equal(lock[action].action, 'none');
  }
  assert.ok(!JSON.stringify(dashboard.views.find(item => item.path === 'home')).match(/## \d+ ·/));
  const scripts = buildScripts();
  for (const [id, entity] of [['home_console_denon_source', DENON], ['home_console_tv_source', TV]]) {
    const script = scripts[id];
    assert.equal(script.sequence[1].then.at(-1).target.entity_id, entity);
    if (entity === DENON) assert.deepEqual(script.sequence[1].then[0], { delay: '00:00:05' });
    assert.equal(script.sequence[2].continue_on_timeout, false);
    assert.equal(script.sequence[3].target.entity_id, entity);
    assert.ok(!JSON.stringify(script).includes(PLAYER_HELPER));
  }
});

test('custom music candidate binds each card to exactly one selected player', () => {
  const library = buildDashboard({ music: true, configEntryId: 'verified-ma' }).views.find(item => item.path === 'music-library');
  const cards = library.cards[0].cards.filter(card => card.type === 'conditional');
  for (const [index, conditional] of cards.entries()) {
    assert.equal(conditional.conditions[0].state, PLAYERS[index].entity);
    assert.deepEqual(conditional.card.conditions.map(item => item.state_not), ['unknown', 'unavailable']);
    assert.ok(conditional.card.conditions.every(item => item.entity === PLAYERS[index].entity));
    const card = conditional.card.card;
    assert.deepEqual(card.players, [PLAYERS[index].entity]);
    assert.equal(card.auto_follow, false);
    assert.equal(card.use_app_area, false);
    assert.equal(card.show_all_playing_players, false);
    assert.equal('ma_token' in card, false);
  }
});

test('kiosk swipes suppress competing native gestures and keep mouse navigation disabled', () => {
  const dashboard = buildDashboard({ navigation: true });
  assert.equal(dashboard.swipe_nav.prevent_default, true);
  assert.equal(dashboard.swipe_nav.enable_mouse_swipe, false);
  assert.equal(dashboard.swipe_nav.wrap, true);
  assert.equal('swipe_nav' in buildDashboard(), false);
});

test('player status tiles only open native details and cannot issue player commands directly', () => {
  const players = buildDashboard().views.find(item => item.path === 'players');
  const statuses = players.cards[0].cards[1].cards;
  assert.deepEqual(statuses.map(card => card.entity), PLAYERS.map(player => player.entity));
  for (const card of statuses) {
    for (const action of ['tap_action', 'icon_tap_action']) assert.equal(card[action].action, 'more-info');
    for (const action of ['hold_action', 'double_tap_action', 'icon_hold_action', 'icon_double_tap_action']) {
      assert.equal(card[action].action, 'none');
    }
  }
});

test('snapshot distinguishes generated config and fails on missing dashboard inventory', async () => {
  const ha = fakeHa();
  const original = ha.command.bind(ha);
  ha.command = async (type, parameters) => {
    if (type === 'lovelace/config') throw new Error('HA command lovelace/config failed (config_not_found)');
    return original(type, parameters);
  };
  const snapshot = await capture(ha);
  assert.equal(snapshot.commands['dashboard:lovelace'].success, false);
  assert.match(snapshot.commands['dashboard:lovelace'].error, /config_not_found/);
  ha.command = async () => { throw new Error('connection failed'); };
  await assert.rejects(capture(ha), /Dashboard inventory is required/);
});

test('secret export refuses checkout paths and permits an outside location', () => {
  assert.throws(() => assertOutsideRepository('/repo', '/repo'));
  assert.throws(() => assertOutsideRepository('/repo/private', '/repo'));
  assert.throws(() => assertOutsideRepository('/repo/..private', '/repo'));
  assert.doesNotThrow(() => assertOutsideRepository('/private/backups', '/repo'));
});

test('live Players details upgrade changes only the four status-tile actions', async () => {
  const { enablePlayerDetails } = await import('./players_details.mjs');
  const { readFile } = await import('node:fs/promises');
  const exported = JSON.parse(await readFile(new URL('../docs/Home_Console_RaspberryPi_Plan/home-console-dashboard.json', import.meta.url), 'utf8'));
  const after = enablePlayerDetails(exported);
  const tilesOf = config => config.views.find(view => view.path === 'players').cards[0].cards[1].cards;
  const expected = buildDashboard().views.find(view => view.path === 'players').cards[0].cards[1].cards;
  for (const [index, card] of tilesOf(after).entries()) {
    for (const key of ['tap_action', 'icon_tap_action', 'hold_action', 'double_tap_action', 'icon_hold_action', 'icon_double_tap_action']) {
      assert.deepEqual(card[key], expected[index][key]);
    }
  }
  const strip = config => { const copy = structuredClone(config); for (const card of tilesOf(copy)) for (const key of Object.keys(card)) if (key.endsWith('_action')) delete card[key]; return copy; };
  assert.deepEqual(strip(after), strip(exported));
  assert.deepEqual(enablePlayerDetails(after), after);
  const broken = structuredClone(exported);
  tilesOf(broken).pop();
  assert.throws(() => enablePlayerDetails(broken), /Players layout changed/);
});
