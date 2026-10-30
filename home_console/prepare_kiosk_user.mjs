// Creates only the new, non-admin pi-kiosk account. Never resets an existing login.
import { randomBytes } from 'node:crypto';
import { writeFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { HomeAssistant } from './ha_client.mjs';
import { assertOutsideRepository } from './ha_snapshot.mjs';
import { verifyBackup } from './apply_foundation.mjs';

export async function loginForCheck(baseUrl, credentials) {
  async function post(path, body, form = false) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? new URLSearchParams(body) : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Kiosk authentication request failed (${response.status})`);
    return response.json();
  }
  const clientId = `${baseUrl}/`;
  const flow = await post('/auth/login_flow', { client_id: clientId, handler: ['homeassistant', null], redirect_uri: `${baseUrl}/?auth_callback=1` });
  if (flow.type !== 'form' || !flow.flow_id) throw new Error('Unexpected HA login flow; use the supported interactive login');
  const result = await post(`/auth/login_flow/${encodeURIComponent(flow.flow_id)}`, { client_id: clientId, username: credentials.username, password: credentials.password });
  if (result.type !== 'create_entry' || !result.result) throw new Error('Kiosk login needs interactive authentication');
  const tokens = await post('/auth/token', { grant_type: 'authorization_code', code: result.result, client_id: clientId }, true);
  return {
    client: new HomeAssistant(baseUrl, tokens.access_token),
    async revoke() {
      const response = await fetch(`${baseUrl}/auth/token`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ action: 'revoke', token: tokens.refresh_token }),
      });
      if (!response.ok) throw new Error('Could not revoke the temporary kiosk test session');
    },
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    url: { type: 'string', default: 'http://192.168.50.117' }, 'token-file': { type: 'string' },
    'snapshot-dir': { type: 'string' }, 'backup-id': { type: 'string' },
  } });
  if (!values['token-file'] || !values['snapshot-dir'] || !values['backup-id']) throw new Error('Specify --token-file, --snapshot-dir, and --backup-id');
  const directory = await realpath(resolve(values['snapshot-dir']));
  assertOutsideRepository(directory, fileURLToPath(new URL('..', import.meta.url)));
  const ha = await HomeAssistant.fromFile(values.url, values['token-file']);
  let testSession;
  try {
    await ha.connect();
    verifyBackup(await ha.command('backup/info'), values['backup-id']);
    const users = await ha.command('config/auth/list');
    if (users.some(user => user.username === 'pi-kiosk' || user.name === 'pi-kiosk')) throw new Error('pi-kiosk already exists; refusing to change existing credentials');
    const credentialPath = resolve(directory, 'pi-kiosk-credentials.json');
    const credentials = { username: 'pi-kiosk', password: randomBytes(32).toString('base64url'), user_id: null };
    await writeFile(credentialPath, JSON.stringify(credentials, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const created = await ha.command('config/auth/create', { name: 'pi-kiosk', group_ids: ['system-users'], local_only: true });
    credentials.user_id = created.user.id;
    await writeFile(credentialPath, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600 });
    await ha.command('config/auth_provider/homeassistant/create', { user_id: credentials.user_id, username: credentials.username, password: credentials.password });
    testSession = await loginForCheck(ha.baseUrl, credentials);
    await testSession.client.connect();
    const user = await testSession.client.command('auth/current_user');
    if (user.is_admin || user.is_owner) throw new Error('Kiosk permissions are unexpectedly elevated');
    const dashboard = await testSession.client.command('lovelace/config', { url_path: 'home-console' });
    const summary = { username: credentials.username, is_admin: user.is_admin, local_only: true, dashboard_views_readable: dashboard.views.length, credentials_file: credentialPath };
    await writeFile(resolve(directory, 'pi-kiosk-check.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(summary));
  } finally {
    testSession?.client.close();
    try { if (testSession) await testSession.revoke(); } finally { ha.close(); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
