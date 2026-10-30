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
  const home = after.views.find(view => view.path === 'home');
  let changed = 0;
  function update(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'custom:home-console-active-button'
        && node.card.tap_action?.perform_action === 'media_player.turn_off'
        && node.card.tap_action?.target?.entity_id === 'media_player.lg_webos_tv_oled83c36la') {
      assert.equal(node.card.icon, 'mdi:power');
      node.card.icon = 'mdi:television-off';
      changed++;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(update);
      else if (value && typeof value === 'object') update(value);
    }
  }
  update(home);
  assert.equal(changed, 2, 'Update active and inactive TV Off icons');
  const record = { utc: new Date().toISOString(), before, after, status: 'pending' };
  await writeFile(journal, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
  assert.deepEqual(await ha.command('lovelace/config', { url_path: 'home-console' }), before);
  await ha.command('lovelace/config/save', { url_path: 'home-console', config: after });
  assert.deepEqual(await ha.command('lovelace/config', { url_path: 'home-console' }), after);
  record.status = 'verified';
  await writeFile(journal, JSON.stringify(record, null, 2));
  await writeFile(new URL('../docs/Home_Console_RaspberryPi_Plan/home-console-dashboard.json', import.meta.url), JSON.stringify(sanitizedConfig(after), null, 2) + '\n');
  console.log('Verified: both Home TV Off branches now use television-off; actions preserved.');
} finally {
  ha.close();
}
