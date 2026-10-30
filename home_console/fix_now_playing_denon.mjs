// User-selected TV heading removal. Does not send device commands.
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
  const view = after.views.find(view => view.path === 'now-playing');
  assert.equal(view.cards.length, 1);
  const cards = view.cards[0].cards;
  assert.equal(cards[0].type, 'entities');
  assert.equal(cards[0].entities[0].entity, 'input_select.pi_console_player');
  const denon = cards.find(card => card.type === 'conditional' && card.card?.cards?.[0]?.entity === 'media_player.denon_avc_x4700h_3');
  assert.ok(denon, 'Expected Music Assistant Denon card');
  view.cards[0].cards = [denon.card];
  const record = { utc: new Date().toISOString(), before, after, status: 'pending' };
  await writeFile(journal, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
  assert.deepEqual(await ha.command('lovelace/config', { url_path: 'home-console' }), before);
  await ha.command('lovelace/config/save', { url_path: 'home-console', config: after });
  assert.deepEqual(await ha.command('lovelace/config', { url_path: 'home-console' }), after);
  record.status = 'verified';
  await writeFile(journal, JSON.stringify(record, null, 2));
  await writeFile(new URL('../docs/Home_Console_RaspberryPi_Plan/home-console-dashboard.json', import.meta.url), JSON.stringify(sanitizedConfig(after), null, 2) + '\n');
  console.log('Verified: Now Playing fixed to Denon; selector removed, other views unchanged.');
} finally {
  ha.close();
}








