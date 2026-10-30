// Add ARC routing to the live TV source script without executing device commands.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HomeAssistant } from './ha_client.mjs';
import { withTvReceiverAudio, TV } from './dashboard.mjs';
import { assertOutsideRepository } from './ha_snapshot.mjs';

const [tokenFile, journal] = process.argv.slice(2);
assert.ok(tokenFile && journal);
assertOutsideRepository(resolve(journal), fileURLToPath(new URL('..', import.meta.url)));
const ha = await HomeAssistant.fromFile('http://192.168.50.117', tokenFile);
const path = '/api/config/script/config/home_console_tv_source';
try {
  await ha.connect();
  const dashboard = await ha.command('lovelace/config', { url_path: 'home-console' });
  const view = dashboard.views.find(view => view.path === 'tv');
  const actions = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'button') actions.push(value);
    for (const child of Object.values(value)) visit(child);
  }
  visit(view);
  assert.equal(actions.filter(button => button.name !== 'Off').length, 14);
  for (const button of actions) {
    assert.equal(button.tap_action.perform_action, button.name === 'Off' ? 'media_player.turn_off' : 'script.home_console_tv_source');
  }
  const before = await ha.rest(path);
  const alreadyRoutesArc = Array.isArray(before.sequence?.at(-1)?.then)
    && before.sequence.at(-1).then[0]?.action === 'webostv.select_sound_output';
  const base = alreadyRoutesArc ? { ...before, sequence: before.sequence.slice(0, -1) } : before;
  const after = withTvReceiverAudio(base);
  if (alreadyRoutesArc) assert.deepEqual(after.sequence.at(-1), before.sequence.at(-1));
  const denon = await ha.rest('/api/config/script/config/home_console_denon_source');
  assert.ok(denon.fields.source.selector.select.options.includes('TV Audio'));
  assert.equal(denon.sequence.at(-1).action, 'media_player.select_source');
  const record = { utc: new Date().toISOString(), before, after, status: 'pending', live_device_commands_sent: false };
  await writeFile(journal, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
  assert.deepEqual(await ha.rest(path), before);
  await ha.rest(path, { method: 'POST', body: after });
  assert.deepEqual(await ha.rest(path), after);
  const state = await ha.rest('/api/states/script.home_console_tv_source');
  assert.ok(!['unknown', 'unavailable'].includes(state.state));
  record.status = 'verified';
  record.current_tv_sound_output = (await ha.rest('/api/states/' + TV)).attributes.sound_output;
  await writeFile(journal, JSON.stringify(record, null, 2));
  const exported = new URL('../docs/Home_Console_RaspberryPi_Plan/home-console-scripts.json', import.meta.url);
  const scripts = JSON.parse(await readFile(exported, 'utf8'));
  scripts.home_console_tv_source = after;
  await writeFile(exported, JSON.stringify(scripts, null, 2) + '\n');
  console.log(JSON.stringify({ deployed: true, source_buttons: 7, off_unchanged: true, current_output: record.current_tv_sound_output, live_device_commands_sent: false }));
} finally { ha.close(); }
