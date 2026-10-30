// Creates the built-in dashboard foundation only. No HACS installs or Pi cutover.
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { HomeAssistant } from './ha_client.mjs';
import { assertOutsideRepository } from './ha_snapshot.mjs';
import { buildDashboard, buildScripts, PLAYERS, PLAYER_HELPER, TRANSFER_HELPER } from './dashboard.mjs';

export function resolveNutSensors(registry, configEntryId) {
  function find(suffix) {
    const matches = registry.filter(entity => entity.platform === 'nut' && entity.config_entry_id === configEntryId && entity.unique_id.endsWith(`_${suffix}`));
    if (matches.length !== 1) throw new Error(`Expected exactly one NUT ${suffix} entity for the verified UPS`);
    return matches[0];
  }
  return { runtime: find('battery.runtime'), voltage: find('battery.voltage') };
}

export function verifyBackup(info, id) {
  const backup = info.backups.find(item => item.backup_id === id);
  if (info.state !== 'idle' || !backup || !backup.homeassistant_included || !backup.database_included ||
      !backup.agents['hassio.local']?.size || backup.failed_addons.length || backup.failed_agent_ids.length || backup.failed_folders.length) {
    throw new Error('A completed, healthy HA backup on hassio.local is required');
  }
}

export async function applyFoundation(ha, { snapshot, backupId, journal, saveJournal, apply = false }) {
  if (snapshot.config.version !== '2026.10.4') throw new Error('Review the APIs before applying to a different HA version');
  const config = await ha.rest('/api/config');
  if (config.version !== snapshot.config.version) throw new Error('HA version changed after the snapshot');
  verifyBackup(await ha.command('backup/info'), backupId);
  const dashboards = await ha.command('lovelace/dashboards/list');
  if (dashboards.some(item => item.url_path === 'home-console')) throw new Error('Home Console already exists; refusing to overwrite it');
  const helpers = await ha.command('input_select/list');
  const states = await ha.rest('/api/states');
  const scripts = buildScripts();
  if (states.some(item => item.entity_id.startsWith('script.') && item.state === 'on')) throw new Error('Wait for active HA scripts to finish before saving scripts');
  if (helpers.some(item => ['pi_console_player', 'pi_console_transfer_source'].includes(item.id)) ||
      states.some(item => [PLAYER_HELPER, TRANSFER_HELPER, ...Object.keys(scripts).map(id => `script.${id}`)].includes(item.entity_id))) {
    throw new Error('A console helper or script already exists; refusing to overwrite it');
  }
  // Check actual config keys as well: a disabled script may not have a state.
  for (const id of Object.keys(scripts)) {
    try {
      await ha.rest(`/api/config/script/config/${id}`);
    } catch (error) {
      if (error.message === 'HA REST request failed (404)') continue;
      throw error;
    }
    throw new Error(`Script config ${id} already exists; refusing to overwrite it`);
  }
  const registry = await ha.command('config/entity_registry/list');
  const nutEntries = registry.filter(item => item.entity_id === 'sensor.ups_apc_status_data' && item.platform === 'nut');
  if (nutEntries.length !== 1) throw new Error('Cannot identify the confirmed APC NUT integration');
  const sensors = resolveNutSensors(registry, nutEntries[0].config_entry_id);
  for (const sensor of Object.values(sensors)) {
    if (sensor.disabled_by && sensor.disabled_by !== 'integration') throw new Error('A required NUT sensor was explicitly disabled by a user');
  }
  const dashboard = buildDashboard({ runtimeEntity: sensors.runtime.entity_id, voltageEntity: sensors.voltage.entity_id });
  const preview = { dashboard, scripts, enable_sensors: Object.values(sensors).map(item => item.entity_id), players: PLAYERS };
  if (!apply) return preview;

  // The write-ahead journal makes partial progress recoverable after an API failure.
  async function change(operation, request, perform) {
    const entry = { operation, request, status: 'pending' };
    journal.changes.push(entry);
    await saveJournal(journal);
    const result = await perform();
    entry.result = result;
    entry.status = 'completed';
    await saveJournal(journal);
    return result;
  }
  for (const sensor of Object.values(sensors)) {
    if (sensor.disabled_by) {
      await change('enable_sensor', { entity_id: sensor.entity_id, previous_disabled_by: sensor.disabled_by }, () => ha.command('config/entity_registry/update', { entity_id: sensor.entity_id, disabled_by: null }));
    }
  }
  for (const [name, entityId] of [['Pi console player', PLAYER_HELPER], ['Pi console transfer source', TRANSFER_HELPER]]) {
    const result = await change('create_helper', { entity_id: entityId }, () => ha.command('input_select/create', {
      name, icon: 'mdi:speaker-multiple', options: PLAYERS.map(player => player.entity),
      // No "initial": first option is the setup default; HA restores subsequent selections.
    }));
    if (`input_select.${result.id}` !== entityId) throw new Error('HA generated an unexpected helper ID; inspect the journal before proceeding');
    await change('hide_helper_from_generated_dashboards', { entity_id: entityId, previous_hidden_by: null }, () => ha.command('config/entity_registry/update', { entity_id: entityId, hidden_by: 'user' }));
  }
  for (const [id, body] of Object.entries(scripts)) {
    await change('create_script', { id }, () => ha.rest(`/api/config/script/config/${id}`, { method: 'POST', body }));
  }
  const metadata = await change('create_dashboard', { url_path: 'home-console' }, () => ha.command('lovelace/dashboards/create', {
    url_path: 'home-console', title: 'Home Console', icon: 'mdi:monitor-dashboard',
    show_in_sidebar: true, require_admin: false,
  }));
  journal.dashboard_id = metadata.id;
  await saveJournal(journal);
  await change('save_dashboard', { url_path: 'home-console' }, () => ha.command('lovelace/config/save', { url_path: 'home-console', config: dashboard }));
  return preview;
}

async function main() {
  const { values } = parseArgs({ options: {
    url: { type: 'string', default: 'http://192.168.50.117' }, 'token-file': { type: 'string' },
    'snapshot-dir': { type: 'string' }, 'backup-id': { type: 'string' }, apply: { type: 'boolean', default: false },
  } });
  if (!values['token-file'] || !values['snapshot-dir'] || !values['backup-id']) throw new Error('Specify --token-file, --snapshot-dir, and --backup-id');
  const directory = await realpath(resolve(values['snapshot-dir']));
  assertOutsideRepository(directory, resolve(fileURLToPath(new URL('..', import.meta.url))));
  const snapshot = JSON.parse(await readFile(resolve(directory, 'ha-before.json'), 'utf8'));
  const journalPath = resolve(directory, 'foundation-journal.json');
  const journal = { created_utc: new Date().toISOString(), backup_id: values['backup-id'], changes: [] };
  if (values.apply) await writeFile(journalPath, JSON.stringify(journal, null, 2), { flag: 'wx', mode: 0o600 });
  const ha = await HomeAssistant.fromFile(values.url, values['token-file']);
  try {
    await ha.connect();
    const preview = await applyFoundation(ha, {
      snapshot, backupId: values['backup-id'], journal, apply: values.apply,
      saveJournal: data => writeFile(journalPath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }),
    });
    await writeFile(resolve(directory, 'foundation-config.json'), JSON.stringify(preview, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ applied: values.apply, views: preview.dashboard.views.map(item => item.path), sensors: preview.enable_sensors, custom_dependencies_installed: false, pi_cutover: false }));
  } finally {
    ha.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
