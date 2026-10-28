// Bounded cleanup for this installation's temporary, originally empty Bedroom queue.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { MusicAssistant } from './music_client.mjs';
import { loginForCheck } from './prepare_kiosk_user.mjs';
import { assertOwnedTestQueue } from './playback_test_policy.mjs';

const { values } = parseArgs({ options: { 'snapshot-dir': { type: 'string' }, now: { type: 'boolean', default: false }, run: { type: 'string' } } });
if (!values['snapshot-dir']) throw new Error('Specify the private --snapshot-dir');
if (values.run && !/^[a-z0-9-]{1,32}$/.test(values.run)) throw new Error('Use a short test-run name');
const directory = resolve(values['snapshot-dir']);
const file = suffix => resolve(directory, values.run ? `bedroom-${values.run}-${suffix}.json` : ({
  before: 'bedroom-before-music-test.json', owned: 'bedroom-test-owned.json', cleanup: 'bedroom-test-cleanup.json',
}[suffix]));
if (!values.now) {
  console.log('Bedroom test cleanup armed for 180 seconds.');
  await new Promise(resolve => setTimeout(resolve, 180000));
}
const lock = resolve(directory, values.run ? `bedroom-${values.run}-cleanup.lock` : 'bedroom-test-cleanup.lock');
try {
  await writeFile(lock, 'Cleanup started\n', { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error.code === 'EEXIST') { console.log('Bedroom test cleanup already handled by its owner.'); process.exit(0); }
  throw error;
}
const before = JSON.parse(await readFile(file('before'), 'utf8'));
const owned = JSON.parse(await readFile(file('owned'), 'utf8'));
const credentials = JSON.parse(await readFile(resolve(directory, 'ma-kiosk.json'), 'utf8'));
if (before.queue.items !== 0 || before.state.state !== 'idle' || before.queue.queue_id !== owned.queue_id) throw new Error('The test baseline is not an idle, empty Bedroom queue');
const ma = new MusicAssistant('http://192.168.50.117:8095', { Authorization: `Bearer ${credentials.token}` });
const queue = await ma.command('player_queues/get', { queue_id: owned.queue_id });
const items = await ma.command('player_queues/items', { queue_id: owned.queue_id, limit: 100, offset: 0 });
assertOwnedTestQueue(queue, items, owned.owned_item_ids);
if (queue.items && queue.active) await ma.command('player_queues/stop', { queue_id: owned.queue_id });
if (queue.items) await ma.command('player_queues/clear', { queue_id: owned.queue_id, skip_stop: true });
const auth = await loginForCheck('http://192.168.50.117', JSON.parse(await readFile(resolve(directory, 'pi-kiosk-credentials.json'), 'utf8')));
try {
  const helper = await auth.client.rest('/api/states/input_select.pi_console_player');
  if (helper.state === 'media_player.bedroom_3') await auth.client.rest('/api/services/input_select/select_option', { method: 'POST', body: { entity_id: helper.entity_id, option: 'media_player.denon_avc_x4700h_3' } });
  const after = await ma.command('player_queues/get', { queue_id: owned.queue_id });
  if (after.items !== 0) throw new Error('Test queue cleanup could not be verified');
  const record = { completed_utc: new Date().toISOString(), queue_empty: true, volume_changed: false, helper_restored_if_still_bedroom: true };
  await writeFile(file('cleanup'), JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(record));
} finally {
  auth.client.close();
  await auth.revoke();
}
