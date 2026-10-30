// Move the selected media card only; keep Receiver's existing volume and radio controls.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HomeAssistant } from './ha_client.mjs';
import { sanitizedConfig } from './enable_music.mjs';
import { assertOutsideRepository } from './ha_snapshot.mjs';

const [tokenFile, journal] = process.argv.slice(2);
assert.ok(tokenFile && journal);
assertOutsideRepository(resolve(journal), fileURLToPath(new URL('..', import.meta.url)));
const ha = await HomeAssistant.fromFile('http://192.168.50.117', tokenFile);
try {
  await ha.connect();
  const before = await ha.command('lovelace/config', { url_path: 'home-console' });
  const after = structuredClone(before);
  assert.ok(!after.views.some(view => view.path === 'tv'));
  const homeIndex = after.views.findIndex(view => view.path === 'home');
  const home = after.views[homeIndex].cards[0];
  assert.equal(home.cards.length, 3);
  const tv = home.cards[2];
  assert.equal(tv.cards[0].entity, 'media_player.lg_webos_tv_oled83c36la');
  assert.equal(tv.cards[1].cards.length, 8);
  tv.cards[1].columns = 4;
  home.cards.splice(2, 1);
  after.views.splice(homeIndex + 1, 0, {
    title: 'TV', path: 'tv', icon: 'mdi:television', panel: true,
    cards: [{ type: 'custom:home-console-tv-layout', card: tv }],
  });
  const record = { utc: new Date().toISOString(), before, after, status: 'pending' };
  await writeFile(journal, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
  assert.deepEqual(await ha.command('lovelace/config', { url_path: 'home-console' }), before);
  await ha.command('lovelace/config/save', { url_path: 'home-console', config: after });
  assert.deepEqual(await ha.command('lovelace/config', { url_path: 'home-console' }), after);
  record.status = 'verified';
  await writeFile(journal, JSON.stringify(record, null, 2));
  await writeFile(new URL('../docs/Home_Console_RaspberryPi_Plan/home-console-dashboard.json', import.meta.url), JSON.stringify(sanitizedConfig(after), null, 2) + '\n');
  console.log('Verified: TV controls moved to a viewport-filling dedicated view.');
} finally { ha.close(); }

