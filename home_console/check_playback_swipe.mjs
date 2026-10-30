// Quiet, bounded acceptance of real playback while the Pi changes views.
// Default is read-only. Test journals and credentials stay outside the checkout.
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loginForCheck } from './prepare_kiosk_user.mjs';
import { MusicAssistant } from './music_client.mjs';
import { assertOutsideRepository } from './ha_snapshot.mjs';
import { assertOwnedTestQueue } from './playback_test_policy.mjs';

const PLAYER = 'media_player.bedroom_3';
const QUEUE = 'wiim_uuid:FF98F7F4-0EAC-0ED0-8BA0-CFDBFF98F7F4';
const HELPER = 'input_select.pi_console_player';
const { values } = parseArgs({ options: { 'snapshot-dir': { type: 'string' }, apply: { type: 'boolean' }, cleanup: { type: 'boolean' }, guardian: { type: 'boolean' } } });
if (!values['snapshot-dir']) throw new Error('Specify the protected --snapshot-dir');
const directory = await realpath(resolve(values['snapshot-dir']));
assertOutsideRepository(directory, fileURLToPath(new URL('..', import.meta.url)));
const journalPath = resolve(directory, 'pi-playback-swipe.json');
if (values.guardian) await new Promise(resolve => setTimeout(resolve, 120000));
const credentials = JSON.parse(await readFile(resolve(directory, 'ma-kiosk.json'), 'utf8'));
const ma = new MusicAssistant('http://192.168.50.117:8095', { Authorization: `Bearer ${credentials.token}` });
const auth = await loginForCheck('http://192.168.50.117', JSON.parse(await readFile(resolve(directory, 'pi-kiosk-credentials.json'), 'utf8')));
const state = entity => auth.client.rest('/api/states/' + entity);
const service = (action, body) => auth.client.rest('/api/services/' + action, { method: 'POST', body });
const save = record => writeFile(journalPath, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, label) {
  for (let i = 0; i < 30; i++) { if (await predicate()) return; await delay(300); }
  throw new Error('Acceptance timed out: ' + label);
}

async function cleanup(record) {
  if (record.cleaned) return;
  const queue = await ma.command('player_queues/get', { queue_id: QUEUE });
  const items = await ma.command('player_queues/items', { queue_id: QUEUE, limit: 100, offset: 0 });
  assertOwnedTestQueue(queue, items, record.owned_item_ids);
  if (queue.active && queue.items) await ma.command('player_queues/stop', { queue_id: QUEUE });
  if (queue.items) await ma.command('player_queues/clear', { queue_id: QUEUE, skip_stop: true });
  await waitFor(async () => (await ma.command('player_queues/get', { queue_id: QUEUE })).items === 0 && (await state(PLAYER)).state === 'idle', 'original idle/empty queue');
  if ((await state(PLAYER)).attributes.is_volume_muted === true && record.before.player.attributes.is_volume_muted === false) {
    await service('media_player/volume_mute', { entity_id: PLAYER, is_volume_muted: false });
  }
  await waitFor(async () => (await state(PLAYER)).attributes.is_volume_muted === record.before.player.attributes.is_volume_muted, 'original mute state');
  // Stop/clear first. Restore only the zero-volume setting owned by this test.
  if (record.zero_volume_requested && (await state(PLAYER)).attributes.volume_level === 0) {
    await service('media_player/volume_set', { entity_id: PLAYER, volume_level: record.before.player.attributes.volume_level });
    await waitFor(async () => (await state(PLAYER)).attributes.volume_level === record.before.player.attributes.volume_level, 'original volume');
  }
  if ((await state(HELPER)).state === PLAYER) await service('input_select/select_option', { entity_id: HELPER, option: record.before.helper.state });
  const final = await state(PLAYER);
  record.cleaned = { utc: new Date().toISOString(), empty_idle: true, mute_restored: true, helper: (await state(HELPER)).state, volume: final.attributes.volume_level, volume_unchanged: final.attributes.volume_level === record.before.player.attributes.volume_level };
  await save(record);
}

let record;
let guardian;
try {
  if (values.cleanup || values.guardian) {
    record = JSON.parse(await readFile(journalPath, 'utf8'));
    await cleanup(record);
    console.log(JSON.stringify({ cleanup_verified: true }));
  } else {
    const before = { player: await state(PLAYER), helper: await state(HELPER), queue: await ma.command('player_queues/get', { queue_id: QUEUE }) };
    if (before.player.state !== 'idle' || before.queue.items !== 0 || typeof before.player.attributes.is_volume_muted !== 'boolean' || before.player.attributes.source !== 'Music Assistant Queue') throw new Error('Inspect the current Bedroom state; this test needs its idle/empty MA baseline');
    if (!values.apply) {
      console.log(JSON.stringify({ preflight: true, test: 'zero-volume Bedroom playback, swipe actual Pi Music Library -> Players -> Radio -> UPS, restore idle/empty/volume/mute/helper', volume: before.player.attributes.volume_level }));
    } else {
      record = { started_utc: new Date().toISOString(), status: 'running', before, owned_item_ids: [], cleaned: null };
      await writeFile(journalPath, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
      guardian = spawn(process.execPath, [fileURLToPath(import.meta.url), '--snapshot-dir', directory, '--guardian'], { detached: true, stdio: 'ignore', windowsHide: true });
      guardian.unref();
      record.zero_volume_requested = true;
      await save(record);
      await service('media_player/volume_set', { entity_id: PLAYER, volume_level: 0 });
      await waitFor(async () => (await state(PLAYER)).attributes.volume_level === 0, 'verified zero volume before playback');
      await service('media_player/volume_mute', { entity_id: PLAYER, is_volume_muted: true });
      await waitFor(async () => (await state(PLAYER)).attributes.is_volume_muted === true, 'verified mute before playback');
      await service('input_select/select_option', { entity_id: HELPER, option: PLAYER });
      await service('script/home_console_radio', { media_id: 'library://radio/52' });
      await waitFor(async () => {
        const items = await ma.command('player_queues/items', { queue_id: QUEUE, limit: 100, offset: 0 });
        if (items.length) { record.owned_item_ids = items.map(item => item.queue_item_id); await save(record); }
        return items.length === 1 && (await ma.command('player_queues/get', { queue_id: QUEUE })).state === 'playing';
      }, 'single owned playing queue item');
      await waitFor(async () => { const s = await state(PLAYER); return s.state === 'playing' && s.attributes.volume_level === 0; }, 'playing at zero volume');
      const result = await promisify(execFile)('ssh', ['-i', resolve(process.env.USERPROFILE, '.ssh/ups_adapter_admin'), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'upsadmin@192.168.50.200', 'sudo -n python3 /var/backups/home-console/20261027T210523Z/operator-stage/check_pi_playback_swipe.py'], { timeout: 45000, windowsHide: true });
      record.pi = JSON.parse(result.stdout);
      const after = await ma.command('player_queues/get', { queue_id: QUEUE });
      if (after.state !== 'playing' || after.current_item?.queue_item_id !== record.owned_item_ids[0] || (await state(PLAYER)).attributes.volume_level !== 0) throw new Error('Playback or zero test volume changed during the swipe');
      record.playback_after = { state: after.state, current_item_id: after.current_item.queue_item_id, items: after.items };
      record.status = 'passed';
      await save(record);
      await cleanup(record);
      console.log(JSON.stringify({ playback_swipe_passed: true, paths: record.pi.paths, restored: record.cleaned }));
    }
  }
} catch (error) {
  if (record && !values.cleanup && !values.guardian) { record.status = 'failed'; record.error = error.message; await save(record); }
  throw error;
} finally {
  try {
    if (record && !record.cleaned && !values.guardian && !values.cleanup) await cleanup(record);
    if (record?.cleaned && guardian?.pid) guardian.kill();
  } finally { auth.client.close(); await auth.revoke(); }
}
