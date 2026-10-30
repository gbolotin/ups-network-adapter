// Fixed allowlist approved by the user on October 27, 2026. No automatic updates.
import { createHash } from 'node:crypto';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { HomeAssistant } from './ha_client.mjs';
import { assertOutsideRepository } from './ha_snapshot.mjs';
import { verifyBackup } from './apply_foundation.mjs';

export const APPROVED = Object.freeze([
  { repository: 'NemesisRE/kiosk-mode', version: 'v15.0.0', asset: 'kiosk-mode.js', sha256: 'b54c24054c27980faeace330bbf019f3b03e54acfda190573a26026cddbf6cf1' },
  { repository: 'zanna-37/hass-swipe-navigation', version: 'v1.16.1', asset: 'swipe-navigation.js', sha256: 'b2ff77b426145834afee28cf947758fe34d36e0b6330da9d711764bd17e9f148' },
  { repository: 'PMizz13/ma-browser-card', version: 'v3.11.2', asset: 'ma-browser-card.js', sha256: '19c30a9f38e2a03c207b1542c90b4d62126b350875dacd78496ceddf73724d43' },
]);

export function verifyInstalled(repository, approved) {
  if (!repository.installed || repository.installed_version !== approved.version) {
    throw new Error(`Installed version does not match approval for ${approved.repository}`);
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    url: { type: 'string', default: 'http://192.168.50.117' },
    'token-file': { type: 'string' }, 'snapshot-dir': { type: 'string' },
    'backup-id': { type: 'string' }, apply: { type: 'boolean', default: false },
  } });
  if (!values['token-file'] || !values['snapshot-dir'] || !values['backup-id']) {
    throw new Error('Specify --token-file, --snapshot-dir, and --backup-id');
  }
  const directory = await realpath(resolve(values['snapshot-dir']));
  assertOutsideRepository(directory, fileURLToPath(new URL('..', import.meta.url)));
  const before = JSON.parse(await readFile(resolve(directory, 'hacs-before.json'), 'utf8'));
  const record = { created_utc: new Date().toISOString(), approved: APPROVED, operations: [] };
  const journalPath = resolve(directory, 'hacs-install.json');
  if (values.apply) await writeFile(journalPath, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
  const save = () => writeFile(journalPath, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  const ha = await HomeAssistant.fromFile(values.url, values['token-file']);
  try {
    await ha.connect();
    const info = await ha.command('hacs/info');
    if (info.version !== '2.0.5' || info.stage !== 'running' || info.disabled_reason) {
      throw new Error('Review the API before using another HACS version/state');
    }
    verifyBackup(await ha.command('backup/info'), values['backup-id']);
    const repositories = await ha.command('hacs/repositories/list', { categories: ['plugin'] });
    for (const approved of APPROVED) {
      const repository = repositories.find(item => item.full_name === approved.repository);
      if (!repository) throw new Error(`Approved repository is missing from HACS: ${approved.repository}`);
      if (repository.installed && repository.installed_version !== approved.version) {
        throw new Error(`Refusing to overwrite an existing different version of ${approved.repository}`);
      }
      const response = await fetch(`https://api.github.com/repos/${approved.repository}/releases/tags/${approved.version}`, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Cannot verify release metadata for ${approved.repository}`);
      const release = await response.json();
      const asset = release.assets.find(item => item.name === approved.asset);
      if (!asset || asset.digest !== `sha256:${approved.sha256}`) throw new Error(`Release digest changed for ${approved.repository}`);
    }
    if (!values.apply) {
      console.log(JSON.stringify({ preflight: 'passed', approved: APPROVED }));
      return;
    }
    for (const approved of APPROVED) {
      const repository = repositories.find(item => item.full_name === approved.repository);
      const operation = { ...approved, repository_id: repository.id, status: 'pending' };
      record.operations.push(operation);
      await save();
      if (!repository.installed) {
        // Populate the plugin filename and exact release information before downloading.
        await ha.command('hacs/repository/info', { repository_id: repository.id }, 45000);
        await ha.command('hacs/repository/download', { repository: repository.id, version: approved.version }, 45000);
      }
      const installed = await ha.command('hacs/repository/info', { repository_id: repository.id });
      verifyInstalled(installed, approved);
      const resources = await ha.command('lovelace/resources');
      const path = `/hacsfiles/${approved.repository.split('/')[1]}/${approved.asset}`;
      const matching = resources.filter(item => new URL(item.url, ha.baseUrl).pathname === path);
      if (matching.length !== 1 || matching[0].type !== 'module') throw new Error(`Expected one module resource for ${approved.repository}`);
      const script = await fetch(new URL(matching[0].url, ha.baseUrl), { redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!script.ok) throw new Error(`Installed asset is unreachable for ${approved.repository}`);
      const actualHash = createHash('sha256').update(new Uint8Array(await script.arrayBuffer())).digest('hex');
      if (actualHash !== approved.sha256) throw new Error(`Installed bytes do not match the approved release of ${approved.repository}`);
      operation.status = 'verified';
      operation.resource = matching[0];
      await save();
      console.log(JSON.stringify({ repository: approved.repository, installed_version: installed.installed_version, sha256: actualHash, resource: matching[0].url }));
    }
    record.resources_after = await ha.command('lovelace/resources');
    for (const original of before.resources) {
      if (!record.resources_after.some(item => JSON.stringify(item) === JSON.stringify(original))) {
        throw new Error('An existing dashboard resource changed during installation');
      }
    }
    await save();
  } finally {
    ha.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
