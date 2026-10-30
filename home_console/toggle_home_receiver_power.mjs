// User-selected lock and outlet row layout. Does not send device commands.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HomeAssistant } from './ha_client.mjs';
import { sanitizedConfig } from './enable_music.mjs';
import { assertOutsideRepository } from './ha_snapshot.mjs';
import { fileURLToPath } from 'node:url';

const [tokenFile, journal] = process.argv.slice(2);
assert.ok(tokenFile && journal, 'Specify private token and journal paths');
assertOutsideRepository(resolve(journal), fileURLToPath(new URL('..', import.meta.url)));
const ha = await HomeAssistant.fromFile('http://192.168.50.117', tokenFile);
try {
  await ha.connect();
  const before = await ha.command('lovelace/config', { url_path: 'home-console' });
  const after = structuredClone(before);
  const home = after.views.find(view => view.path === 'home').cards[0];
  const controls = home.card.cards.find(card => card.type === 'custom:home-console-receiver-controls');
  assert.ok(controls, 'Home receiver controls must exist');
  const power = controls.cards[1];
  assert.equal(power.type, 'vertical-stack');
  assert.equal(power.cards.length, 2);
  for (const branch of power.cards) {
    const button = branch.card;
    assert.equal(button.type, 'custom:home-console-active-button');
    assert.equal(button.card.tap_action.perform_action, 'media_player.turn_off');
    assert.equal(button.card.tap_action.target.entity_id, 'media_player.denon_avc_x4700h');
    button.card.tap_action.perform_action = 'media_player.toggle';
    button.card.name = 'Receiver power';
    button.tooltip = '\u0412\u043a\u043b/\u0432\u044b\u043a\u043b \u0440\u0435\u0441\u0438\u0432\u0435\u0440\u0430';
  }
  const record = { utc: new Date().toISOString(), before, after, status: 'pending' };
  await writeFile(journal, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
  assert.deepEqual(await ha.command('lovelace/config', { url_path: 'home-console' }), before);
  await ha.command('lovelace/config/save', { url_path: 'home-console', config: after });
  assert.deepEqual(await ha.command('lovelace/config', { url_path: 'home-console' }), after);
  record.status = 'verified';
  await writeFile(journal, JSON.stringify(record, null, 2));
  await writeFile(new URL('../docs/Home_Console_RaspberryPi_Plan/home-console-dashboard.json', import.meta.url), JSON.stringify(sanitizedConfig(after), null, 2) + '\n');
  console.log('Verified: both Home receiver power branches now toggle the native Denon; other controls preserved.');
} finally {
  ha.close();
}
