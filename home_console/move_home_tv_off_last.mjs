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
  assert.equal(home.type, 'custom:home-console-home-layout');
  const row = home.card.cards.find(card => card.type === 'grid' && card.cards?.length === 8);
  assert.ok(row, 'Expected eight TV buttons');
  const off = row.cards[0];
  assert.equal(off.cards[0].card.card.tap_action.perform_action, 'media_player.turn_off');
  assert.equal(off.cards[0].card.card.tap_action.target.entity_id, 'media_player.lg_webos_tv_oled83c36la');
  row.cards.push(row.cards.shift());
  assert.deepEqual(row.cards.slice(0, 7), before.views.find(view => view.path === 'home').cards[0].card.cards.find(card => card.type === 'grid' && card.cards?.length === 8).cards.slice(1));
  const record = { utc: new Date().toISOString(), before, after, status: 'pending' };
  await writeFile(journal, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
  assert.deepEqual(await ha.command('lovelace/config', { url_path: 'home-console' }), before);
  await ha.command('lovelace/config/save', { url_path: 'home-console', config: after });
  assert.deepEqual(await ha.command('lovelace/config', { url_path: 'home-console' }), after);
  record.status = 'verified';
  await writeFile(journal, JSON.stringify(record, null, 2));
  await writeFile(new URL('../docs/Home_Console_RaspberryPi_Plan/home-console-dashboard.json', import.meta.url), JSON.stringify(sanitizedConfig(after), null, 2) + '\n');
  console.log('Verified: TV Off moved to the end of the Home source row; actions preserved.');
} finally {
  ha.close();
}
