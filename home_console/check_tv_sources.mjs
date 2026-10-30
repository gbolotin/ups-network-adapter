// Explicitly approved TV source acceptance. No playback/queue commands.
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loginForCheck } from './prepare_kiosk_user.mjs';
import { assertOutsideRepository } from './ha_snapshot.mjs';
const { values } = parseArgs({ options: { 'snapshot-dir': { type: 'string' }, apply: { type: 'boolean' }, guardian: { type: 'boolean' } } });
if (!values['snapshot-dir']) throw Error('Specify protected snapshot directory');
if (values.apply || values.guardian) throw Error('Live test paused: source cases passed, but final Denon mute restoration needs physical confirmation.');
const directory = await realpath(resolve(values['snapshot-dir']));
assertOutsideRepository(directory, fileURLToPath(new URL('..', import.meta.url)));
const file = resolve(directory, 'home-tv-source-acceptance.json');
const tv = 'media_player.lg_webos_tv_oled83c36la';
const denon = 'media_player.denon_avc_x4700h';
const wake = 'button.wake_on_lan_a4_36_c7_82_d0_82';
const sources = ['HDMI 1', 'SHIELD Game Console', 'Denon Sound Bar', 'YouTube', 'Plex', 'Netflix', 'Apple TV'];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
if (values.guardian) await delay(300000);
const auth = await loginForCheck('http://192.168.50.117', JSON.parse(await readFile(resolve(directory, 'pi-kiosk-credentials.json'), 'utf8')));
const state = entity => auth.client.rest('/api/states/' + entity);
const service = (action, body) => auth.client.rest('/api/services/' + action, { method: 'POST', body, timeoutMs: 45000 });
const save = record => writeFile(file, JSON.stringify(record, null, 2));
async function waitFor(predicate, label) {
  for (let i = 0; i < 90; i++) { if (await predicate()) return; await delay(500); }
  throw Error('Timed out: ' + label);
}
async function select(source) {
  await service('script/home_console_tv_source', { source });
  await waitFor(async () => (await state(tv)).attributes.source === source, source);
}
async function restoreVolume(entity, volume) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await service('media_player/volume_set', { entity_id: entity, volume_level: volume });
    for (let poll = 0; poll < 10; poll++) {
      if ((await state(entity)).attributes.volume_level === volume) return;
      await delay(500);
    }
  }
  throw Error('Volume restoration failed: ' + entity);
}
async function restore(record) {
  if (['off', 'unknown', 'unavailable'].includes((await state(tv)).state)) {
    await service('button/press', { entity_id: wake });
    await waitFor(async () => !['off', 'unknown', 'unavailable'].includes((await state(tv)).state), 'TV recovery wake');
  }
  await select(record.before.tv.attributes.source);
  await restoreVolume(tv, record.before.tv.attributes.volume_level);
  await service('media_player/volume_mute', { entity_id: tv, is_volume_muted: record.before.tv.attributes.is_volume_muted });
  await service('script/home_console_denon_source', { source: record.before.denon.attributes.source });
  await delay(2000);
  await restoreVolume(denon, record.before.denon.attributes.volume_level);
  await service('media_player/volume_mute', { entity_id: denon, is_volume_muted: record.before.denon.attributes.is_volume_muted });
  await waitFor(async () => {
    const a = await state(tv), b = await state(denon);
    return a.attributes.source === record.before.tv.attributes.source
      && a.attributes.volume_level === record.before.tv.attributes.volume_level
      && a.attributes.is_volume_muted === record.before.tv.attributes.is_volume_muted
      && b.attributes.source === record.before.denon.attributes.source
      && b.attributes.volume_level === record.before.denon.attributes.volume_level
      && b.attributes.is_volume_muted === record.before.denon.attributes.is_volume_muted;
  }, 'original TV/Denon settings');
  record.restored = true;
  await save(record);
}
let record, guardian;
try {
  if (values.guardian) {
    record = JSON.parse(await readFile(file, 'utf8'));
    if (!record.restored) await restore(record);
  } else {
    const before = { tv: await state(tv), denon: await state(denon) };
    for (const s of Object.values(before)) {
      if (['off', 'unknown', 'unavailable'].includes(s.state) || !Number.isFinite(s.attributes.volume_level)
          || typeof s.attributes.is_volume_muted !== 'boolean') throw Error('Inspect changed TV/Denon baseline');
    }
    if (!sources.includes(before.tv.attributes.source) || !['TV Audio', 'HEOS Music'].includes(before.denon.attributes.source)) throw Error('Unsupported restoration source');
    if (!values.apply) console.log(JSON.stringify({ preflight: true, sources }));
    else {
      record = { utc: new Date().toISOString(), before, cases: [], restored: false };
      await writeFile(file, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      guardian = spawn(process.execPath, [fileURLToPath(import.meta.url), '--snapshot-dir', directory, '--guardian'], { detached: true, stdio: 'ignore', windowsHide: true });
      guardian.unref();
      try {
        for (const entity of [tv, denon]) {
          await service('media_player/volume_set', { entity_id: entity, volume_level: 0 });
          await service('media_player/volume_mute', { entity_id: entity, is_volume_muted: true });
          await waitFor(async () => (await state(entity)).attributes.volume_level === 0, 'zero volume ' + entity);
        }
        await service('media_player/turn_off', { entity_id: tv });
        await waitFor(async () => (await state(tv)).state === 'off', 'TV Off with wake configured');
        record.off_verified = true;
        await delay(5000);
        for (const source of sources) {
          await select(source);
          if ((await state(tv)).attributes.volume_level !== 0) throw Error('TV volume changed');
          record.cases.push({ source, verified: true, zero_volume: true });
          await save(record);
        }
        record.status = 'passed';
      } catch (error) { record.status = 'failed'; record.failure = error.message; }
      finally { await save(record); await restore(record); guardian.kill(); }
      console.log(JSON.stringify({ status: record.status, off_verified: record.off_verified, cases: record.cases, restored: record.restored, failure: record.failure }));
    }
  }
} finally { auth.client.close(); await auth.revoke(); }
