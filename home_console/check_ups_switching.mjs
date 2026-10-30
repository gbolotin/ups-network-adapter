// Explicit live check: briefly disable only the HA adapter, then always restore it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { HomeAssistant } from './ha_client.mjs';

const { values } = parseArgs({ options: { 'token-file': { type: 'string' }, 'journal': { type: 'string' }, 'ssh-key': { type: 'string' } } });
if (!values['token-file'] || !values.journal || !values['ssh-key']) throw Error('Specify protected token, deployment journal and SSH key');
const deployment = JSON.parse(await readFile(values.journal, 'utf8'));
const script = await readFile(new URL('./check_pi_ups_switching.py', import.meta.url), 'utf8');
const ha = await HomeAssistant.fromFile('http://192.168.50.117', values['token-file']);
const record = { utc: new Date().toISOString(), physical_usb_swap_tested: false };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function liveIdentity() {
  const state = await ha.rest('/api/states/sensor.connected_ups_connected');
  return state.state === 'Eaton 5E 2200 G2';
}
function inspect(offline) {
  return JSON.parse(execFileSync('ssh', ['-i', values['ssh-key'], '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8', 'root@192.168.50.200', 'python3', '-', ...(offline ? ['--offline'] : [])],
    { input: script, encoding: 'utf8', timeout: 45000 }));
}
try {
  await ha.connect();
  assert.equal(await liveIdentity(), true);
  const beforeRegistry = await ha.command('config/entity_registry/list');
  const original = deployment.registry_before.filter(e => e.config_entry_id === deployment.legacy_entry);
  assert.ok(original.length > 0);
  for (const old of original) {
    const now = beforeRegistry.find(e => e.entity_id === old.entity_id);
    assert.equal(now?.platform, 'usb_ups_adapter', `Migrated entity missing: ${old.entity_id}`);
    assert.equal(now?.device_id, old.device_id);
  }
  record.original_entity_ids_preserved = original.length;
  const devices = await ha.command('config/device_registry/list');
  const apc = devices.find(d => d.id === deployment.legacy_device);
  assert.equal(apc.model, 'Back-UPS BX750MI');
  assert.equal((await ha.rest('/api/states/sensor.ups_apc_load')).state, 'unavailable');
  const history = await ha.rest('/api/history/period/2026-10-29T18:00:00Z?filter_entity_id=sensor.ups_apc_load&end_time=2026-10-29T20:00:00Z&minimal_response');
  assert.ok(history[0]?.length > 0, 'Original APC history must remain readable');
  record.original_history_readable = true;
  let disabled = false;
  try {
    // Restore even if the server applies the change but its response is lost.
    disabled = true;
    const result = await ha.command('config_entries/disable', { entry_id: deployment.adapter_entry, disabled_by: 'user' });
    assert.equal(result.require_restart, false);
    record.offline = inspect(true);
    const unavailable = await ha.rest('/api/states');
    assert.ok(unavailable.filter(s => s.entity_id.startsWith('sensor.connected_ups_')).every(s => s.state === 'unavailable'));
  } finally {
    if (disabled) {
      const result = await ha.command('config_entries/disable', { entry_id: deployment.adapter_entry, disabled_by: null });
      assert.equal(result.require_restart, false);
    }
  }
  let ready = false;
  for (let attempt = 0; attempt < 15; attempt++) {
    try { ready = await liveIdentity(); } catch { ready = false; }
    if (ready) break;
    await delay(2000);
  }
  assert.equal(ready, true, 'Adapter did not recover');
  record.online = inspect(false);
  const afterRegistry = await ha.command('config/entity_registry/list');
  for (const old of beforeRegistry.filter(e => e.platform === 'usb_ups_adapter')) {
    const after = afterRegistry.find(e => e.entity_id === old.entity_id);
    assert.equal(after?.unique_id, old.unique_id);
    assert.equal(after?.device_id, old.device_id);
  }
  assert.equal((await ha.rest('/api/states/sensor.ups_apc_load')).state, 'unavailable');
  record.entity_and_device_ids_stable_after_reload = true;
  record.passed = true;
  await writeFile(new URL('../output/ups-switching-validation.json', import.meta.url), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify(record));
} finally { ha.close(); }
