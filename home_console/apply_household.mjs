import assert from 'node:assert/strict';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { HomeAssistant } from './ha_client.mjs';
import { assertOutsideRepository } from './ha_snapshot.mjs';
import { buildHouseholdDashboard, buildCameraDashboard, entityReferences } from './household_dashboard.mjs';

function same(actual, expected, message) {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(message);
}

async function main() {
  const { values } = parseArgs({ options: { 'token-file': { type: 'string' }, 'snapshot-dir': { type: 'string' }, apply: { type: 'boolean', default: false } } });
  if (!values['token-file'] || !values['snapshot-dir']) throw new Error('Specify --token-file and --snapshot-dir');
  const directory = await realpath(resolve(values['snapshot-dir']));
  assertOutsideRepository(directory, fileURLToPath(new URL('..', import.meta.url)));
  const before = JSON.parse(await readFile(resolve(directory, 'd9-before.json'), 'utf8'));
  const homeBefore = before.dashboards.find(d => d.metadata.url_path === 'dashboard-new');
  const camerasBefore = before.dashboards.find(d => d.metadata.url_path === 'dashboard-cameras');
  const changes = [
    { before: homeBefore, config: buildHouseholdDashboard() },
    { before: camerasBefore, config: buildCameraDashboard(camerasBefore.config) },
  ];
  const ha = await HomeAssistant.fromFile('http://192.168.50.117', values['token-file']);
  try {
    await ha.connect();
    const metadata = await ha.command('lovelace/dashboards/list');
    const states = await ha.rest('/api/states');
    const availableIds = new Set(states.map(state => state.entity_id));
    for (const change of changes) {
      same(await ha.command('lovelace/config', { url_path: change.before.metadata.url_path }), change.before.config, 'A dashboard changed since the private snapshot');
      same(metadata.find(d => d.url_path === change.before.metadata.url_path), change.before.metadata, 'Dashboard metadata changed since the private snapshot');
      const afterReferences = entityReferences(change.config);
      for (const entity of entityReferences(change.before.config)) assert.ok(afterReferences.has(entity), `A retained entity was lost: ${entity}`);
      for (const entity of afterReferences) assert.ok(availableIds.has(entity), `Resolve the missing entity: ${entity}`);
      assert.ok(!JSON.stringify(change.config).includes('pi_console_'), 'Household views must not use the Pi helper');
    }
    const preferences = await ha.command('frontend/get_user_data');
    const helperBefore = await ha.rest('/api/states/input_select.pi_console_player');
    if (!values.apply) { console.log(JSON.stringify({ preflight: 'passed', dashboards: 2, references_preserved: true, devices_changed: 0 })); }
    else {
      const journalPath = resolve(directory, 'd9-journal.json');
      const journal = { created_utc: new Date().toISOString(), preferences_before: preferences, helper_before: helperBefore.state, changes: [] };
      const save = () => writeFile(journalPath, JSON.stringify(journal, null, 2) + '\n', { mode: 0o600 });
      await writeFile(journalPath, JSON.stringify(journal), { flag: 'wx', mode: 0o600 });
      for (const change of changes) {
        journal.changes.push({ path: change.before.metadata.url_path, status: 'pending' }); await save();
        await ha.command('lovelace/config/save', { url_path: change.before.metadata.url_path, config: change.config });
        same(await ha.command('lovelace/config', { url_path: change.before.metadata.url_path }), change.config, 'Saved dashboard readback differs');
        journal.changes.at(-1).status = 'verified'; await save();
      }
      journal.changes.push({ path: 'dashboard-new', metadata_title: 'Home', status: 'pending' }); await save();
      await ha.command('lovelace/dashboards/update', { dashboard_id: homeBefore.metadata.id, title: 'Home', icon: 'mdi:home' });
      journal.changes.at(-1).status = 'verified';
      same(await ha.command('frontend/get_user_data'), preferences, 'Frontend preferences changed during deployment');
      assert.equal((await ha.rest('/api/states/input_select.pi_console_player')).state, helperBefore.state);
      await save();
      await writeFile(resolve(directory, 'd9-after.json'), JSON.stringify(changes.map(change => ({ path: change.before.metadata.url_path, config: change.config })), null, 2), { flag: 'wx', mode: 0o600 });
      await writeFile('docs/Home_Console_RaspberryPi_Plan/home-console-household.json', JSON.stringify(changes[0].config, null, 2) + '\n');
      console.log(JSON.stringify({ deployed: true, dashboards: 2, existing_urls_preserved: true, preferences_unchanged: true, pi_selection_unchanged: true }));
    }
  } finally { ha.close(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
