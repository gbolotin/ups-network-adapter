// Installs no packages. Applies the approved card/navigation configuration after HACS.
import assert from 'node:assert/strict';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { HomeAssistant } from './ha_client.mjs';
import { MusicAssistant } from './music_client.mjs';
import { assertOutsideRepository } from './ha_snapshot.mjs';
import { buildDashboard, PLAYERS } from './dashboard.mjs';
import { APPROVED, verifyInstalled } from './install_hacs.mjs';

export function visitCards(value, visitor) {
  if (!value || typeof value !== 'object') return;
  visitor(value);
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach(item => visitCards(item, visitor));
    else if (child && typeof child === 'object') visitCards(child, visitor);
  }
}

export function sanitizedConfig(config) {
  const sanitized = structuredClone(config);
  visitCards(sanitized, item => { delete item.ma_token; });
  return sanitized;
}

async function main() {
  const { values } = parseArgs({ options: {
    url: { type: 'string', default: 'http://192.168.50.117' }, 'token-file': { type: 'string' },
    'snapshot-dir': { type: 'string' }, apply: { type: 'boolean', default: false },
  } });
  if (!values['token-file'] || !values['snapshot-dir']) throw new Error('Specify --token-file and --snapshot-dir');
  const directory = await realpath(resolve(values['snapshot-dir']));
  assertOutsideRepository(directory, fileURLToPath(new URL('..', import.meta.url)));
  const maCredentials = JSON.parse(await readFile(resolve(directory, 'ma-kiosk.json'), 'utf8'));
  const direct = new MusicAssistant('http://192.168.50.117:8095', { Authorization: `Bearer ${maCredentials.token}` });
  const me = await direct.command('auth/me');
  if (me.role !== 'user' || me.user_id !== maCredentials.user_id) throw new Error('Expected the restricted kiosk MA identity');
  assert.deepEqual([...me.player_filter].sort(), maCredentials.mapping.map(item => item.player_id).sort());
  assert.deepEqual(maCredentials.mapping.map(item => item.entity).sort(), PLAYERS.map(item => item.entity).sort());
  const ha = await HomeAssistant.fromFile(values.url, values['token-file']);
  try {
    await ha.connect();
    const repositories = await ha.command('hacs/repositories/list', { categories: ['plugin'] });
    for (const approved of APPROVED) {
      const repository = repositories.find(item => item.full_name === approved.repository);
      if (!repository) throw new Error('An approved component is missing');
      verifyInstalled(repository, approved);
    }
    const entries = (await ha.command('config_entries/get')).filter(item => item.domain === 'music_assistant' && item.state === 'loaded');
    if (entries.length !== 1) throw new Error('Expected one loaded MA integration');
    const config = buildDashboard({ music: true, navigation: true, configEntryId: entries[0].entry_id });
    visitCards(config, card => { if (['custom:ma-browser-card', 'custom:home-console-radio-favorites'].includes(card.type)) card.ma_token = maCredentials.token; });
    const metadata = await ha.command('lovelace/dashboards/list');
    const before = { created_utc: new Date().toISOString(), dashboards: [] };
    for (const dashboard of metadata) {
      const existing = await ha.command('lovelace/config', { url_path: dashboard.url_path });
      before.dashboards.push({ metadata: dashboard, config: existing });
    }
    const foundation = JSON.parse(await readFile(resolve(directory, 'foundation-config.json'), 'utf8'));
    assert.deepEqual(before.dashboards.find(item => item.metadata.url_path === 'home-console').config, foundation.dashboard);
    if (!values.apply) {
      console.log(JSON.stringify({ preflight: 'passed', kiosk_role: me.role, allowed_players: me.player_filter.length, ma_cards: 8 }));
      return;
    }
    await writeFile(resolve(directory, 'navigation-before.json'), JSON.stringify(before, null, 2), { flag: 'wx', mode: 0o600 });
    await writeFile(resolve(directory, 'home-console-music-private.json'), JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
    for (const dashboard of before.dashboards) {
      const path = dashboard.metadata.url_path;
      if (path === 'home-console') continue;
      // Keep strategy-generated dashboards generated. Maps are also explicitly ignored by the plugin.
      if (dashboard.config.strategy) continue;
      assert.deepEqual(await ha.command('lovelace/config', { url_path: path }), dashboard.config);
      await ha.command('lovelace/config/save', { url_path: path, config: { ...dashboard.config, swipe_nav: { ...dashboard.config.swipe_nav, enable: false } } });
    }
    assert.deepEqual(await ha.command('lovelace/config', { url_path: 'home-console' }), foundation.dashboard);
    await ha.command('lovelace/config/save', { url_path: 'home-console', config });
    assert.deepEqual(await ha.command('lovelace/config', { url_path: 'home-console' }), config);
    console.log(JSON.stringify({ applied: true, ma_cards: 8, restricted_players: me.player_filter.length, native_home_targets_unchanged: true, pi_cutover: false }));
  } finally {
    ha.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.name === 'AssertionError' ? 'Configuration changed; inspect private snapshots before proceeding' : error.message); process.exitCode = 1; });
}
