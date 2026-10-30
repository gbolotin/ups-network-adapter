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
  const receiver = after.views.find(view => view.path === 'receiver').cards[0].cards[0];
  assert.equal(receiver.type, 'custom:home-console-receiver-layout');
  assert.equal(home.type, 'custom:home-console-home-layout');
  const volume = structuredClone(receiver.card.cards[1]);
  assert.equal(volume.card.type, 'custom:home-console-volume-slider');
  volume.card.hide_mute = false;
  const off = structuredClone(receiver.card.cards[2].cards[0]);
  for (const branch of off.cards) {
    assert.equal(branch.card.card.tap_action.target.entity_id, 'media_player.denon_avc_x4700h');
    branch.card.card.icon = 'mdi:audio-video';
    branch.card.logo = 'receiver-off';
  }
  home.card.cards.push({ type: 'custom:home-console-receiver-controls', cards: [volume, off] });
  const record = { utc: new Date().toISOString(), before, after, status: 'pending' };
  await writeFile(journal, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
  assert.deepEqual(await ha.command('lovelace/config', { url_path: 'home-console' }), before);
  await ha.command('lovelace/config/save', { url_path: 'home-console', config: after });
  assert.deepEqual(await ha.command('lovelace/config', { url_path: 'home-console' }), after);
  record.status = 'verified';
  await writeFile(journal, JSON.stringify(record, null, 2));
  await writeFile(new URL('../docs/Home_Console_RaspberryPi_Plan/home-console-dashboard.json', import.meta.url), JSON.stringify(sanitizedConfig(after), null, 2) + '\n');
  console.log('Verified: receiver volume, Mute and combined receiver Off added to Home; original actions preserved.');
} finally {
  ha.close();
}
