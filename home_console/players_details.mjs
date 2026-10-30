// User-approved October 28: Players status tiles open native more-info (volume, mute, grouping).
// Changes only the four tile actions; refuses an unexpected layout. Preflight unless --apply.
import assert from 'node:assert/strict';
import { writeFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { HomeAssistant } from './ha_client.mjs';
import { sanitizedConfig } from './enable_music.mjs';
import { assertOutsideRepository } from './ha_snapshot.mjs';
import { DETAILS_ACTIONS, PLAYERS } from './dashboard.mjs';

const ACTION_KEYS = Object.keys(DETAILS_ACTIONS);

export function enablePlayerDetails(before) {
  const after = structuredClone(before);
  const view = after.views?.find(item => item.path === 'players');
  const grid = view?.cards?.[0]?.cards?.[1];
  const tiles = grid?.cards;
  if (!view || view.cards.length !== 1 || grid.type !== 'grid' || tiles?.length !== PLAYERS.length
      || tiles.some((card, index) => card.type !== 'tile' || card.entity !== PLAYERS[index].entity)) {
    throw new Error('Players layout changed; inspect before replacing it');
  }
  for (const card of tiles) {
    const unexpected = ACTION_KEYS.filter(key => card[key] && card[key].action !== 'none' && card[key].action !== DETAILS_ACTIONS[key].action);
    if (unexpected.length) throw new Error(`Unexpected ${card.entity} action: ${unexpected.join(', ')}`);
    Object.assign(card, structuredClone(DETAILS_ACTIONS));
  }
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
    const after = enablePlayerDetails(before);
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    if (!values.apply) { console.log(JSON.stringify({ preflight: true, changed, view: 'players', tiles: PLAYERS.length })); return; }
    if (!changed) { console.log(JSON.stringify({ already_applied: true })); return; }
    const record = { utc: new Date().toISOString(), before, after, status: 'pending' };
    const path = resolve(directory, 'players-details.json');
    await writeFile(path, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
    await ha.command('lovelace/config/save', { url_path: 'home-console', config: after });
    assert.deepEqual(await ha.command('lovelace/config', { url_path: 'home-console' }), after);
    record.status = 'verified';
    await writeFile(path, JSON.stringify(record, null, 2));
    await writeFile(fileURLToPath(new URL('../docs/Home_Console_RaspberryPi_Plan/home-console-dashboard.json', import.meta.url)), JSON.stringify(sanitizedConfig(after), null, 2) + '\n');
    console.log(JSON.stringify({ players_details: true, other_views_unchanged: true }));
  } finally { ha.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
