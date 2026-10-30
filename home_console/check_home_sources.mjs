// Approved Denon source acceptance. No queue-content mutations or playback requests.
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loginForCheck } from './prepare_kiosk_user.mjs';
import { assertOutsideRepository } from './ha_snapshot.mjs';
import { MusicAssistant } from './music_client.mjs';
import assert from 'node:assert/strict';

const { values } = parseArgs({ options: { 'snapshot-dir': { type: 'string' }, apply: { type: 'boolean' }, guardian: { type: 'boolean' } } });
if (!values['snapshot-dir']) throw Error('Specify protected snapshot directory');
if (values.apply || values.guardian) throw Error('Live test paused: resolve the post-test native/HEOS mute discrepancy before another run; inspect v6 evidence.');
const directory = await realpath(resolve(values['snapshot-dir']));
assertOutsideRepository(directory, fileURLToPath(new URL('..', import.meta.url)));
const file = resolve(directory, 'home-denon-source-acceptance-v6.json');
const native = 'media_player.denon_avc_x4700h';
const player = 'media_player.denon_avc_x4700h_3';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
if (values.guardian) await delay(180000);
const auth = await loginForCheck('http://192.168.50.117', JSON.parse(await readFile(resolve(directory, 'pi-kiosk-credentials.json'), 'utf8')));
const credentials = JSON.parse(await readFile(resolve(directory, 'ma-kiosk.json'), 'utf8'));
const ma = new MusicAssistant('http://192.168.50.117:8095', { Authorization: `Bearer ${credentials.token}` });
const queueId = '831600515';
const queueItems = async () => (await ma.command('player_queues/items', { queue_id: queueId, limit: 100, offset: 0 })).map(item => ({ id: item.queue_item_id, uri: item.media_item?.uri }));
const state = entity => auth.client.rest('/api/states/' + entity);
const service = (action, body) => auth.client.rest('/api/services/' + action, { method: 'POST', body, timeoutMs: 45000 });
async function waitFor(predicate, label) {
  for (let i = 0; i < 60; i++) { if (await predicate()) return; await delay(500); }
  throw Error('Timed out: ' + label);
}
async function restore(record) {
  await ma.command('player_queues/stop', { queue_id: queueId });
  assert.deepEqual(await queueItems(), record.before.queue_items);
  if (record.restore_target.native.state === 'on') {
    await service('script/home_console_denon_source', { source: record.restore_target.native.attributes.source });
    await waitFor(async () => (await state(native)).attributes.source === record.restore_target.native.attributes.source, 'original source');
  } else {
    await service('media_player/turn_off', { entity_id: native });
    await waitFor(async () => (await state(native)).state === 'off', 'Denon off restoration');
  }
  await service('media_player/volume_set', { entity_id: native, volume_level: record.restore_target.native.attributes.volume_level });
  await waitFor(async () => (await state(native)).attributes.volume_level === record.restore_target.native.attributes.volume_level, 'original Main Zone volume');
  await service('media_player/volume_mute', { entity_id: native, is_volume_muted: record.restore_target.native.attributes.is_volume_muted });
  await waitFor(async () => {
    const s = await state(native);
    return s.attributes.volume_level === record.restore_target.native.attributes.volume_level
      && s.attributes.is_volume_muted === record.restore_target.native.attributes.is_volume_muted;
  }, 'original volume/mute');
  if ((await state(native)).state !== record.restore_target.native.state) throw Error('Power state restoration mismatch');
  record.restored = true;
  await writeFile(file, JSON.stringify(record, null, 2));
}
let record, guardian;
try {
  if (values.guardian) {
    record = JSON.parse(await readFile(file, 'utf8'));
    if (!record.restored) await restore(record);
  } else {
    const before = { native: await state(native), player: await state(player), queue: await ma.command('player_queues/get', { queue_id: queueId }), queue_items: await queueItems() };
    if (before.native.state !== 'on' || before.queue.state !== 'idle' || before.queue.items !== before.queue_items.length
        || (before.native.state === 'on' && !['TV Audio', 'HEOS Music'].includes(before.native.attributes.source))
        || !Number.isFinite(before.native.attributes.volume_level)
        || typeof before.native.attributes.is_volume_muted !== 'boolean') throw Error('Inspect changed Denon baseline');
    if (!values.apply) console.log(JSON.stringify({ preflight: true, native: 'off', player: 'idle', queue_mutations: false }));
    else {
      const restoreTarget = structuredClone(before);
      record = { utc: new Date().toISOString(), before, restore_target: restoreTarget, cases: [], restored: false };
      await writeFile(file, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      guardian = spawn(process.execPath, [fileURLToPath(import.meta.url), '--snapshot-dir', directory, '--guardian'], { detached: true, stdio: 'ignore', windowsHide: true });
      guardian.unref();
      try {
        await service('media_player/volume_set', { entity_id: native, volume_level: 0 });
        await waitFor(async () => (await state(native)).attributes.volume_level === 0, 'zero Main Zone volume before wake');
        await service('media_player/turn_off', { entity_id: native });
        await waitFor(async () => (await state(native)).state === 'off', 'initial standby');
        await delay(5000);
        for (const source of ['TV Audio', 'HEOS Music']) {
          await service('script/home_console_denon_source', { source });
          await waitFor(async () => [source, ...(source === 'HEOS Music' ? ['NET'] : [])].includes((await state(native)).attributes.source), source);
          if ((await state(native)).attributes.volume_level !== 0) throw Error('Zero Main Zone volume changed');
          record.cases.push({ source, source_verified: true, zero_volume: true });
          await writeFile(file, JSON.stringify(record, null, 2));
        }
        await ma.command('player_queues/stop', { queue_id: queueId });
        assert.deepEqual(await queueItems(), before.queue_items);
        await delay(2000);
        await service('media_player/turn_off', { entity_id: native });
        await waitFor(async () => (await state(native)).state === 'off', 'explicit Off');
        record.off_verified = true;
        record.status = 'passed';
      } catch (error) { record.status = 'failed'; record.failure = error.message; }
      finally {
        await writeFile(file, JSON.stringify(record, null, 2));
        await restore(record);
        guardian.kill();
      }
      console.log(JSON.stringify({ status: record.status, cases: record.cases, off_verified: record.off_verified, restored: record.restored, failure: record.failure }));
    }
  }
} finally { auth.client.close(); await auth.revoke(); }
