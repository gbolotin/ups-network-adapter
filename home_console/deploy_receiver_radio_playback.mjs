// Add ARC routing to the live TV source script without executing device commands.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HomeAssistant } from './ha_client.mjs';
import { receiverRadioPlayback } from './dashboard.mjs';
import { assertOutsideRepository } from './ha_snapshot.mjs';

const [tokenFile, journal] = process.argv.slice(2);
assert.ok(tokenFile && journal);
assertOutsideRepository(resolve(journal), fileURLToPath(new URL('..', import.meta.url)));
const ha = await HomeAssistant.fromFile('http://192.168.50.117', tokenFile);
const path = '/api/config/script/config/home_console_receiver_radio';
try {
  await ha.connect();
  const after = receiverRadioPlayback();
  let before = null;
  const services = await ha.rest('/api/services');
  if (services.find(item => item.domain === 'script')?.services.home_console_receiver_radio) before = await ha.rest(path);
  const source = await ha.rest('/api/config/script/config/home_console_denon_source');
  assert.ok(source.fields.source.selector.select.options.includes('HEOS Music'));
  const record = { utc: new Date().toISOString(), before, after, status: 'pending', live_device_commands_sent: false };
  await writeFile(journal, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
  if (before) assert.deepEqual(await ha.rest(path), before);
  await ha.rest(path, { method: 'POST', body: after });
  assert.deepEqual(await ha.rest(path), after);
  const state = await ha.rest('/api/states/script.home_console_receiver_radio');
  assert.ok(!['unknown', 'unavailable'].includes(state.state));
  record.status = 'verified';
  await writeFile(journal, JSON.stringify(record, null, 2));
  const exported = new URL('../docs/Home_Console_RaspberryPi_Plan/home-console-scripts.json', import.meta.url);
  const scripts = JSON.parse(await readFile(exported, 'utf8'));
  scripts.home_console_receiver_radio = after;
  await writeFile(exported, JSON.stringify(scripts, null, 2) + '\n');
  console.log(JSON.stringify({ deployed: true, wake_then_heos_then_play: true, live_device_commands_sent: false }));
} finally { ha.close(); }
