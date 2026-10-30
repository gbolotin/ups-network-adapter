// Replace only the TV SHIELD icon. Preserve native actions.
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
  const view = after.views.find(view => view.path === 'tv');
  let count = 0;
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'custom:home-console-active-button' && value.card?.name === 'SHIELD') {
      assert.equal(value.card.icon, 'mdi:android');
      value.card.icon = 'mdi:shield';
      value.logo = 'nvidia';
      count++;
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(view);
  assert.equal(count, 2);
  const record = { utc: new Date().toISOString(), before, after, status: 'pending' };
  await writeFile(journal, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
  assert.deepEqual(await ha.command('lovelace/config', { url_path: 'home-console' }), before);
  await ha.command('lovelace/config/save', { url_path: 'home-console', config: after });
  assert.deepEqual(await ha.command('lovelace/config', { url_path: 'home-console' }), after);
  record.status = 'verified';
  await writeFile(journal, JSON.stringify(record, null, 2));
  await writeFile(new URL('../docs/Home_Console_RaspberryPi_Plan/home-console-dashboard.json', import.meta.url), JSON.stringify(sanitizedConfig(after), null, 2) + '\n');
  console.log('Verified: TV SHIELD displays the NVIDIA mark; native card configuration preserved.');
} finally { ha.close(); }
