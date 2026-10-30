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
  const wrapper = after.views.find(view => view.path === 'home').cards[0];
  assert.equal(wrapper.type, 'custom:home-console-home-layout');
  const cards = wrapper.card.cards;
  assert.equal(cards[0].type, 'custom:home-console-door-card');
  assert.equal(cards[0].card.entity, 'lock.lock_ultra_17');
  assert.equal(cards[1].type, 'tile');
  assert.equal(cards[1].entity, 'switch.power_plug_cd43');
  cards.splice(0, 2, { type: 'grid', columns: 2, square: false, cards: cards.slice(0, 2) });
  const record = { utc: new Date().toISOString(), before, after, status: 'pending' };
  await writeFile(journal, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
  assert.deepEqual(await ha.command('lovelace/config', { url_path: 'home-console' }), before);
  await ha.command('lovelace/config/save', { url_path: 'home-console', config: after });
  assert.deepEqual(await ha.command('lovelace/config', { url_path: 'home-console' }), after);
  record.status = 'verified';
  await writeFile(journal, JSON.stringify(record, null, 2));
  await writeFile(new URL('../docs/Home_Console_RaspberryPi_Plan/home-console-dashboard.json', import.meta.url), JSON.stringify(sanitizedConfig(after), null, 2) + '\n');
  console.log('Verified: lock and aquarium outlet placed in one row; actions and other cards preserved.');
} finally {
  ha.close();
}
