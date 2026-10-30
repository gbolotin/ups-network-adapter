// User-selected TV heading removal. Does not send device commands.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { denonSourceButtons } from './dashboard.mjs';
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
  const receiver = after.views.find(view => view.path === 'home').cards[0].cards[2];
  assert.equal(receiver.type, 'vertical-stack');
  assert.equal(receiver.cards.length, 2);
  assert.equal(receiver.cards[1].type, 'grid');
  assert.deepEqual(receiver.cards[1].cards.map(card => card.name), ['Off', 'TV', 'HEOS']);
  receiver.cards[1] = denonSourceButtons();
  const record = { utc: new Date().toISOString(), before, after, status: 'pending' };
  await writeFile(journal, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
  assert.deepEqual(await ha.command('lovelace/config', { url_path: 'home-console' }), before);
  await ha.command('lovelace/config/save', { url_path: 'home-console', config: after });
  assert.deepEqual(await ha.command('lovelace/config', { url_path: 'home-console' }), after);
  record.status = 'verified';
  await writeFile(journal, JSON.stringify(record, null, 2));
  await writeFile(new URL('../docs/Home_Console_RaspberryPi_Plan/home-console-dashboard.json', import.meta.url), JSON.stringify(sanitizedConfig(after), null, 2) + '\n');
  console.log('Verified: Denon source indicators saved and read back.');
} finally {
  ha.close();
}




