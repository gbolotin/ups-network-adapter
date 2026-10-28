// Bounded cleanup for the explicitly approved Bedroom/Denon transfer acceptance test.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { MusicAssistant } from './music_client.mjs';
import { loginForCheck } from './prepare_kiosk_user.mjs';

const { values } = parseArgs({ options: { 'snapshot-dir': { type: 'string' }, now: { type: 'boolean', default: false } } });
if (!values['snapshot-dir']) throw new Error('Specify the protected --snapshot-dir');
const directory = resolve(values['snapshot-dir']);
if (!values.now) {
  console.log('Transfer-test cleanup armed for 180 seconds.');
  await new Promise(resolve => setTimeout(resolve, 180000));
}
try { await writeFile(resolve(directory, 'music-transfer-cleanup.lock'), 'Cleanup started\n', { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code === 'EEXIST') { console.log('Transfer-test cleanup already handled.'); process.exit(0); } throw error; }
const before = JSON.parse(await readFile(resolve(directory, 'music-transfer-before.json'), 'utf8'));
const owned = JSON.parse(await readFile(resolve(directory, 'music-transfer-owned.json'), 'utf8'));
const credentials = JSON.parse(await readFile(resolve(directory, 'ma-kiosk.json'), 'utf8'));
const ma = new MusicAssistant('http://192.168.50.117:8095', { Authorization: `Bearer ${credentials.token}` });
const auth = await loginForCheck('http://192.168.50.117', JSON.parse(await readFile(resolve(directory, 'pi-kiosk-credentials.json'), 'utf8')));
const record = { completed_utc: null, rooms: [], native_restored: false };
const native = 'media_player.denon_avc_x4700h';
const service = (path, body) => auth.client.rest('/api/services/' + path, { method: 'POST', body });
try {
  // Restore queue contents quietly before restoring the TV input and listening volume.
  await service('media_player/volume_set', { entity_id: native, volume_level: 0 });
  for (const room of before.rooms) {
    const queue = await ma.command('player_queues/get', { queue_id: room.player_id });
    const items = await ma.command('player_queues/items', { queue_id: room.player_id, limit: 100, offset: 0 });
    const originalUris = room.items.map(item => item.media_item?.uri);
    const currentUris = items.map(item => item.media_item?.uri);
    if (JSON.stringify(currentUris) !== JSON.stringify(originalUris)) {
      if (queue.items > items.length || !items.every(item => owned.item_ids.includes(item.queue_item_id))) throw new Error('Another controller changed a queue; preserve its new items');
      if (queue.active && queue.items) await ma.command('player_queues/stop', { queue_id: room.player_id });
      if (queue.items) await ma.command('player_queues/clear', { queue_id: room.player_id, skip_stop: true });
      for (const item of room.items) {
        if (!item.media_item?.uri || !item.media_item?.media_type) throw new Error('Original queue item cannot be restored');
        await service('music_assistant/play_media', { entity_id: room.entity, media_id: item.media_item.uri, media_type: item.media_item.media_type, enqueue: 'add' });
      }
      const restored = await ma.command('player_queues/get', { queue_id: room.player_id });
      if (restored.state !== 'idle') await ma.command('player_queues/stop', { queue_id: room.player_id });
    }
    const restoredItems = await ma.command('player_queues/items', { queue_id: room.player_id, limit: 100, offset: 0 });
    if (JSON.stringify(restoredItems.map(item => item.media_item?.uri)) !== JSON.stringify(originalUris)) throw new Error('Original queue order was not restored');
    record.rooms.push({ entity: room.entity, items: restoredItems.length, original_media_order_restored: true });
  }
} finally {
  try {
    await service('media_player/select_source', { entity_id: native, source: before.native_denon.attributes.source });
    let restoredSource = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      if ((await auth.client.rest('/api/states/' + native)).attributes.source === before.native_denon.attributes.source) { restoredSource = true; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!restoredSource) throw new Error('Receiver source restoration needs attention; volume remains reduced');
    let restoredVolume = false;
    for (let attempt = 0; attempt < 3 && !restoredVolume; attempt++) {
      await service('media_player/volume_set', { entity_id: native, volume_level: before.native_denon.attributes.volume_level });
      for (let poll = 0; poll < 10; poll++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        const state = await auth.client.rest('/api/states/' + native);
        if (state.attributes.source !== before.native_denon.attributes.source) throw new Error('Receiver source changed during restoration');
        if (state.attributes.volume_level === before.native_denon.attributes.volume_level) { restoredVolume = true; break; }
      }
    }
    if (!restoredVolume) throw new Error('Receiver volume restoration could not be verified');
    for (const helper of before.helpers) await service('input_select/select_option', { entity_id: helper.entity_id, option: helper.state });
    record.native_restored = true;
    record.completed_utc = new Date().toISOString();
    await writeFile(resolve(directory, 'music-transfer-cleanup.json'), JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(record));
  } finally { auth.client.close(); await auth.revoke(); }
}
