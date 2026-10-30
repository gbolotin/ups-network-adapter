import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HomeAssistant } from './ha_client.mjs';
import { sanitizedConfig } from './enable_music.mjs';
import { assertOutsideRepository } from './ha_snapshot.mjs';

const [tokenFile, journal] = process.argv.slice(2);
assert.ok(tokenFile && journal);
assertOutsideRepository(resolve(journal), fileURLToPath(new URL('..', import.meta.url)));
const credentials = JSON.parse(await readFile(resolve(dirname(journal), 'ma-kiosk.json'), 'utf8'));
const ha = await HomeAssistant.fromFile('http://192.168.50.117', tokenFile);
try {
  await ha.connect();
  const before = await ha.command('lovelace/config', { url_path: 'home-console' });
  const after = structuredClone(before);
  const receiver = after.views.find(view => view.path === 'receiver').cards[0].cards[0];
  assert.equal(receiver.cards.length, 3);
  assert.equal(receiver.cards[2].type, 'grid');
  receiver.cards[2] = { type: 'custom:home-console-radio-favorites', player: 'media_player.denon_avc_x4700h_3', ma_token: credentials.token };
  const record = { utc: new Date().toISOString(), before, after, status: 'pending' };
  await writeFile(journal, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
  assert.deepEqual(await ha.command('lovelace/config', { url_path: 'home-console' }), before);
  await ha.command('lovelace/config/save', { url_path: 'home-console', config: after });
  assert.deepEqual(await ha.command('lovelace/config', { url_path: 'home-console' }), after);
  record.status = 'verified';
  await writeFile(journal, JSON.stringify(record, null, 2));
  await writeFile(new URL('../docs/Home_Console_RaspberryPi_Plan/home-console-dashboard.json', import.meta.url), JSON.stringify(sanitizedConfig(after), null, 2) + '\n');
  console.log('Verified: Receiver now reads live MA favorites, fixed to Denon.');
} finally { ha.close(); }
