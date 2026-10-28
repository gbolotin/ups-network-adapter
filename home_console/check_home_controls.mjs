// Explicitly approved brief aquarium/camera tests. No lock or media-player commands.
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { loginForCheck } from './prepare_kiosk_user.mjs';
import { assertOutsideRepository } from './ha_snapshot.mjs';

const ENTITIES = [
  'switch.power_plug_cd43',
  'switch.chuangmi_sg_1069362690_039c04_motion_detection_p_5_1',
  'switch.chuangmi_sg_1069362690_039c04_human_tracking_p_2_9',
  'switch.chuangmi_sg_1069362690_039c04_on_p_2_1',
];
const { values } = parseArgs({ options: { 'snapshot-dir': { type: 'string' }, apply: { type: 'boolean' }, 'guard-entity': { type: 'string' } } });
if (!values['snapshot-dir'] || (values['guard-entity'] && !ENTITIES.includes(values['guard-entity']))) throw new Error('Specify the protected directory and only a permitted switch');
const directory = await realpath(resolve(values['snapshot-dir']));
assertOutsideRepository(directory, fileURLToPath(new URL('..', import.meta.url)));
const path = resolve(directory, 'home-switch-acceptance.json');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
if (values['guard-entity']) await delay(30000);
const auth = await loginForCheck('http://192.168.50.117', JSON.parse(await readFile(resolve(directory, 'pi-kiosk-credentials.json'), 'utf8')));
const state = entity => auth.client.rest('/api/states/' + entity);
const set = (entity, value) => auth.client.rest('/api/services/switch/turn_' + value, { method: 'POST', body: { entity_id: entity }, timeoutMs: 5000 });
const save = record => writeFile(path, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });

async function waitState(entity, expected, seconds = 8) {
  const deadline = Date.now() + seconds * 1000;
  do {
    if ((await state(entity)).state === expected) return;
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error('Switch readback timed out: ' + entity);
}

async function restore(entity, original) {
  const current = (await state(entity)).state;
  if (current !== original) await set(entity, original);
  await waitState(entity, original);
}

try {
  if (values['guard-entity']) {
    const record = JSON.parse(await readFile(path, 'utf8'));
    const entity = values['guard-entity'];
    if (!record.cases.find(entry => entry.entity === entity)?.restored) {
      await restore(entity, record.before[entity].state);
      console.log(JSON.stringify({ guarded_restore: entity }));
    }
  } else {
    const before = {};
    for (const entity of ENTITIES) {
      before[entity] = await state(entity);
      if (!['on', 'off'].includes(before[entity].state)) throw new Error('Inspect unavailable switch before testing: ' + entity);
    }
    if (!values.apply) {
      console.log(JSON.stringify({ preflight: true, switches: ENTITIES.map(entity => ({ entity, original: before[entity].state, test: before[entity].state === 'on' ? 'off' : 'on' })), media_and_lock_actions: false }));
    } else {
      const record = { utc: new Date().toISOString(), status: 'running', before, cases: [] };
      await writeFile(path, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
      try {
        for (const entity of ENTITIES) {
          if ((await state(entity)).state !== before[entity].state) throw new Error('Switch changed independently; preserve it: ' + entity);
          const original = before[entity].state;
          const target = original === 'on' ? 'off' : 'on';
          const entry = { entity, original, target, started_utc: new Date().toISOString(), restored: false };
          record.cases.push(entry);
          await save(record);
          const guardian = spawn(process.execPath, [fileURLToPath(import.meta.url), '--snapshot-dir', directory, '--guard-entity', entity], { detached: true, stdio: 'ignore', windowsHide: true });
          guardian.unref();
          try {
            await set(entity, target);
            await waitState(entity, target);
            entry.target_verified = true;
            await delay(entity === ENTITIES[0] ? 3000 : 500);
            if (entity === ENTITIES[0]) entry.power_while_on = (await state('sensor.power_plug_cd43_power')).state;
          } finally {
            await restore(entity, original);
            entry.restored = true;
            entry.completed_utc = new Date().toISOString();
            await save(record);
            guardian.kill();
          }
        }
        record.final_states = {};
        for (const entity of ENTITIES) {
          record.final_states[entity] = (await state(entity)).state;
          if (record.final_states[entity] !== before[entity].state) throw new Error('A switch did not retain its original state');
        }
        record.final_aquarium_power = (await state('sensor.power_plug_cd43_power')).state;
        record.status = 'passed';
        await save(record);
        console.log(JSON.stringify({ switch_roundtrips_passed: record.cases.length, cases: record.cases, final_states: record.final_states, final_aquarium_power: record.final_aquarium_power }));
      } catch (error) {
        record.status = 'failed'; record.error = error.message; await save(record); throw error;
      }
    }
  }
} finally { auth.client.close(); await auth.revoke(); }
