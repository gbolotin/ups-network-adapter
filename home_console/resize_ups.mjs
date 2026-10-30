import assert from 'node:assert/strict';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { HomeAssistant } from './ha_client.mjs';
import { sanitizedConfig } from './enable_music.mjs';
import { assertOutsideRepository } from './ha_snapshot.mjs';

export function resizeUps(before) {
  const after = structuredClone(before);
  const view = after.views.find(view => view.path === 'ups');
  const stack = view?.cards?.[0];
  if (!view || view.cards.length !== 1 || stack.type !== 'vertical-stack' || stack.cards.length !== 2
      || stack.cards[0].type !== 'markdown' || stack.cards[1].type !== 'grid'
      || stack.cards[1].cards.length !== 5 || !stack.cards[1].cards.every(card => card.type === 'tile' && card.entity.startsWith('sensor.'))) {
    throw new Error('UPS layout changed; inspect before replacing it');
  }
  view.cards = [{ type: 'custom:home-console-ups', cards: [stack.cards[0], ...stack.cards[1].cards] }];
  return after;
}

async function main() {
  const { values } = parseArgs({ options: { 'token-file': { type: 'string' }, 'snapshot-dir': { type: 'string' }, apply: { type: 'boolean' } } });
  if (!values['token-file'] || !values['snapshot-dir']) throw new Error('Specify protected token file and snapshot directory');
  const directory = await realpath(resolve(values['snapshot-dir']));
  assertOutsideRepository(directory, fileURLToPath(new URL('..', import.meta.url)));
  const ha = await HomeAssistant.fromFile('http://192.168.50.117', values['token-file']);
  try {
    await ha.connect();
    const before = await ha.command('lovelace/config', { url_path: 'home-console' });
    const after = resizeUps(before);
    if (!values.apply) { console.log(JSON.stringify({ preflight: true, changed_view: 'ups', scale: 1.5, native_cards_preserved: 6 })); return; }
    const record = { utc: new Date().toISOString(), before, after, status: 'pending' };
    const path = resolve(directory, 'ups-readability-change.json');
    await writeFile(path, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
    await ha.command('lovelace/config/save', { url_path: 'home-console', config: after });
    assert.deepEqual(await ha.command('lovelace/config', { url_path: 'home-console' }), after);
    record.status = 'verified';
    await writeFile(path, JSON.stringify(record, null, 2));
    await writeFile(fileURLToPath(new URL('../docs/Home_Console_RaspberryPi_Plan/home-console-dashboard.json', import.meta.url)), JSON.stringify(sanitizedConfig(after), null, 2) + '\n');
    console.log(JSON.stringify({ ups_resized: true, other_views_unchanged: true }));
  } finally { ha.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
