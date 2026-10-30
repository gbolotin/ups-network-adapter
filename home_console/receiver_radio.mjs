// Apply the currently verified MA favorites to Receiver without playing audio.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HomeAssistant } from './ha_client.mjs';
import { MusicAssistant } from './music_client.mjs';
import { denonSourceButtons, receiverRadioButtons, RECEIVER_RADIO } from './dashboard.mjs';
import { sanitizedConfig } from './enable_music.mjs';
import { assertOutsideRepository } from './ha_snapshot.mjs';

const [tokenFile, journal] = process.argv.slice(2);
assert.ok(tokenFile && journal, 'Specify private token and journal paths');
assertOutsideRepository(resolve(journal), fileURLToPath(new URL('..', import.meta.url)));
const credentials = JSON.parse(await readFile(resolve(dirname(journal), 'ma-kiosk.json'), 'utf8'));
const ma = new MusicAssistant('http://192.168.50.117:8095', { Authorization: `Bearer ${credentials.token}` });
const favorites = await ma.command('music/radios/library_items', { favorite: true, limit: 500 });
assert.ok(Array.isArray(favorites) && favorites.length > 0 && favorites.length < 500);
assert.ok(favorites.every(item => item.favorite && item.available && item.media_type === 'radio'));
assert.deepEqual(favorites.map(item => item.uri).sort(), RECEIVER_RADIO.map(item => item.uri).sort(), 'Refresh receiver radio defaults to match current favorites');
const stations = RECEIVER_RADIO.map(station => ({ ...station, name: favorites.find(item => item.uri === station.uri).name.replace(/^Radio Paradise: /, '').replace(/ \(flac\)$/, '') }));
const ha = await HomeAssistant.fromFile('http://192.168.50.117', tokenFile);
try {
  await ha.connect();
  const before = await ha.command('lovelace/config', { url_path: 'home-console' });
  const after = structuredClone(before);
  const receiver = after.views.find(view => view.path === 'receiver').cards[0].cards[0];
  assert.equal(receiver.cards.length, 2);
  assert.equal(receiver.cards[0].card.entity, 'media_player.denon_avc_x4700h');
  assert.equal(receiver.cards[1].cards.length, 3);
  const services = await ha.rest('/api/services');
  assert.ok(services.find(item => item.domain === 'music_assistant')?.services.play_media);
  const denon = await ha.rest('/api/states/media_player.denon_avc_x4700h_3');
  assert.ok(!['unknown', 'unavailable'].includes(denon.state));
  receiver.cards[1] = denonSourceButtons({ includeHeos: false });
  receiver.cards.push(receiverRadioButtons(stations));
  const record = { utc: new Date().toISOString(), before, after, status: 'pending' };
  await writeFile(journal, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
  assert.deepEqual(await ha.command('lovelace/config', { url_path: 'home-console' }), before);
  await ha.command('lovelace/config/save', { url_path: 'home-console', config: after });
  assert.deepEqual(await ha.command('lovelace/config', { url_path: 'home-console' }), after);
  record.status = 'verified';
  await writeFile(journal, JSON.stringify(record, null, 2));
  await writeFile(new URL('../docs/Home_Console_RaspberryPi_Plan/home-console-dashboard.json', import.meta.url), JSON.stringify(sanitizedConfig(after), null, 2) + '\n');
  console.log(JSON.stringify({ verified: true, favorites: stations.map(item => item.name), target: denon.entity_id }));
} finally {
  ha.close();
}
