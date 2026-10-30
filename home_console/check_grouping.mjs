// Approved temporary Denon/LG membership test. No play or queue-content commands.
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { loginForCheck } from './prepare_kiosk_user.mjs';
import { MusicAssistant } from './music_client.mjs';
import { assertOutsideRepository } from './ha_snapshot.mjs';

const { values } = parseArgs({ options: { 'snapshot-dir': { type: 'string' }, apply: { type: 'boolean' }, guardian: { type: 'boolean' } } });
if (!values['snapshot-dir']) throw Error('Specify protected directory');
const directory = await realpath(resolve(values['snapshot-dir']));
assertOutsideRepository(directory, fileURLToPath(new URL('..', import.meta.url)));
const file = resolve(directory, 'home-grouping-acceptance-v2.json');
const rooms = [
  { id: '831600515', entity: 'media_player.denon_avc_x4700h_3', native: 'media_player.denon_avc_x4700h', script: 'home_console_denon_source' },
  { id: 'up910adb7e', entity: 'media_player.lg_tv_oled83c_2', native: 'media_player.lg_webos_tv_oled83c36la', script: 'home_console_tv_source' },
];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
if (values.guardian) await delay(180000);
const auth = await loginForCheck('http://192.168.50.117', JSON.parse(await readFile(resolve(directory, 'pi-kiosk-credentials.json'), 'utf8')));
const token = JSON.parse(await readFile(resolve(directory, 'ma-kiosk.json'), 'utf8')).token;
const ma = new MusicAssistant('http://192.168.50.117:8095', { Authorization: `Bearer ${token}` });
const state = entity => auth.client.rest('/api/states/' + entity);
const service = (action, body) => auth.client.rest('/api/services/' + action, { method: 'POST', body, timeoutMs: 45000 });
const player = id => ma.command('players/get', { player_id: id });
const queue = id => ma.command('player_queues/get', { queue_id: id });
const items = async id => (await ma.command('player_queues/items', { queue_id: id, limit: 100, offset: 0 })).map(item => ({ id: item.queue_item_id, uri: item.media_item?.uri }));
const save = record => writeFile(file, JSON.stringify(record, null, 2));
async function waitFor(predicate, label) {
  for (let i = 0; i < 30; i++) { if (await predicate()) return; await delay(500); }
  throw Error('Timed out: ' + label);
}
async function volume(entity, desired) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await service('media_player/volume_set', { entity_id: entity, volume_level: desired });
    for (let i = 0; i < 10; i++) {
      const room = rooms.find(room => room.entity === entity);
      const actual = room ? (await player(room.id)).volume_level / 100 : (await state(entity)).attributes.volume_level;
      if (actual === desired) return;
      await delay(500);
    }
  }
  throw Error('Volume readback failed: ' + entity);
}
async function ungroup() {
  const main = await player(rooms[0].id), member = await player(rooms[1].id);
  if (!main.group_childs.length && !member.synced_to && !member.group_childs.length) return;
  if (main.group_childs.some(id => !rooms.some(room => room.id === id))) throw Error('Group gained another member: inspect before cleanup');
  await service('media_player/unjoin', { entity_id: rooms[1].entity });
  await waitFor(async () => !(await player(rooms[0].id)).group_childs.length && !(await player(rooms[1].id)).synced_to, 'temporary ungroup');
}
async function restore(record) {
  await ungroup();
  for (const room of rooms) {
    const before = record.before[room.id];
    await ma.command('player_queues/stop', { queue_id: room.id });
    assert.deepEqual(await items(room.id), before.items);
    await volume(room.entity, before.player.volume_level / 100);
  }
  for (const room of [...rooms].reverse()) {
    const before = record.before[room.id].native;
    await service('script/' + room.script, { source: before.attributes.source });
    await waitFor(async () => (await state(room.native)).attributes.source === before.attributes.source, 'original source');
    await delay(2000);
    await volume(room.native, before.attributes.volume_level);
  }
  record.restored_settings = true;
  record.mute_commands_sent = false;
  record.queue_contents_preserved = true;
  await save(record);
}
let guardian, record;
try {
  if (values.guardian) {
    record = JSON.parse(await readFile(file, 'utf8'));
    if (!record.restored_settings) await restore(record);
  } else {
    const before = {};
    for (const room of rooms) {
      const p = await player(room.id), q = await queue(room.id), native = await state(room.native), list = await items(room.id);
      if (!p.available || p.group_childs.length || p.synced_to || q.state !== 'idle' || q.items !== list.length
          || ['off', 'unknown', 'unavailable'].includes(native.state) || !Number.isFinite(native.attributes.volume_level)) throw Error('Inspect changed baseline');
      before[room.id] = { player: p, queue: q, items: list, native };
    }
    if (!before[rooms[0].id].player.can_group_with.includes(rooms[1].id)) throw Error('Provider does not advertise this pair');
    if (!values.apply) console.log(JSON.stringify({ preflight: true, group_pair: rooms.map(room => room.entity), playback: false }));
    else {
      record = { utc: new Date().toISOString(), before, joined: false, restored_settings: false };
      await writeFile(file, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      guardian = spawn(process.execPath, [fileURLToPath(import.meta.url), '--snapshot-dir', directory, '--guardian'], { detached: true, stdio: 'ignore', windowsHide: true });
      guardian.unref();
      try {
        for (const room of rooms) await volume(room.native, 0);
        // Launch an empty receiver, not media. Inactive Cast volume cannot be set reliably.
        await service('media_player/turn_on', { entity_id: 'media_player.lg_tv_oled83c' });
        await waitFor(async () => !['off', 'unknown', 'unavailable'].includes((await state('media_player.lg_tv_oled83c')).state), 'empty Cast receiver');
        record.empty_cast_receiver_opened = true;
        for (const room of rooms) { await volume(room.entity, 0); await volume(room.native, 0); }
        await service('media_player/join', { entity_id: rooms[0].entity, group_members: [rooms[1].entity] });
        await waitFor(async () => (await player(rooms[0].id)).group_childs.includes(rooms[1].id), 'group membership');
        record.joined = true;
        record.members = (await player(rooms[0].id)).group_childs;
        await save(record);
        await ungroup();
        record.ungrouped = true;
        record.status = 'passed_control_only';
      } catch (error) { record.status = 'failed'; record.failure = error.message; }
      finally { await save(record); await restore(record); guardian.kill(); }
      console.log(JSON.stringify({ status: record.status, joined: record.joined, ungrouped: record.ungrouped, restored: record.restored_settings, queue_contents_preserved: record.queue_contents_preserved, failure: record.failure, audible_sync_tested: false }));
    }
  }
} finally { auth.client.close(); await auth.revoke(); }
