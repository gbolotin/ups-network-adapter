// Remove the two Home cards selected by the user; preserve the outlet and all other content.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HomeAssistant } from './ha_client.mjs';
import { sanitizedConfig } from './enable_music.mjs';
import { assertOutsideRepository } from './ha_snapshot.mjs';

export function simplifyAquarium(before) {
  const after = structuredClone(before);
  const cards = after.views?.find(view => view.path === 'home')?.cards?.[0]?.cards;
  const aquarium = cards?.[1];
  assert.equal(aquarium?.type, 'vertical-stack', 'Unexpected aquarium layout');
  assert.equal(aquarium.cards.length, 2);
  assert.equal(aquarium.cards[0].content, '## Aquarium · Office');
  const grid = aquarium.cards[1];
  assert.equal(grid.type, 'grid');
  assert.equal(grid.cards.length, 2);
  assert.equal(grid.cards[0].entity, 'switch.power_plug_cd43');
  assert.equal(grid.cards[1].entity, 'sensor.power_plug_cd43_power');
  cards[1] = grid.cards[0];
  return after;
}

async function main() {
  const [tokenFile, journal] = process.argv.slice(2);
  assert.ok(tokenFile && journal, 'Specify private token file and journal path');
  assertOutsideRepository(resolve(journal), fileURLToPath(new URL('..', import.meta.url)));
  const ha = await HomeAssistant.fromFile('http://192.168.50.117', tokenFile);
  try {
    await ha.connect();
    const before = await ha.command('lovelace/config', { url_path: 'home-console' });
    const after = simplifyAquarium(before);
    const record = { utc: new Date().toISOString(), before, after, status: 'pending' };
    await writeFile(journal, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
    assert.deepEqual(await ha.command('lovelace/config', { url_path: 'home-console' }), before);
    await ha.command('lovelace/config/save', { url_path: 'home-console', config: after });
    assert.deepEqual(await ha.command('lovelace/config', { url_path: 'home-console' }), after);
    record.status = 'verified';
    await writeFile(journal, JSON.stringify(record, null, 2));
    await writeFile(new URL('../docs/Home_Console_RaspberryPi_Plan/home-console-dashboard.json', import.meta.url), JSON.stringify(sanitizedConfig(after), null, 2) + '\n');
    console.log('Verified: aquarium heading and measured power removed; outlet and other cards preserved.');
  } finally {
    ha.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
