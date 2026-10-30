// Install the narrow Pi endpoint and prepare HA REST commands. No power operation runs.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { HomeAssistant } from './ha_client.mjs';

const [tokenFile, directory] = process.argv.slice(2);
assert.ok(tokenFile && directory);
const recordPath = resolve(directory, 'pi-control-install.json');
let record;
try { record = JSON.parse(await readFile(recordPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const token = record?.token || randomBytes(36).toString('hex');
if (!record) {
  record = { utc: new Date().toISOString(), token, status: 'pending' };
  await writeFile(recordPath, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
}
const save = () => writeFile(recordPath, JSON.stringify(record, null, 2));
const source = await readFile(new URL('../display/kiosk_control.py', import.meta.url));
const service = await readFile(new URL('../display/ups-kiosk-control.service', import.meta.url));
const screenSettings = await readFile(new URL('../display/screen_settings.py', import.meta.url));
const upsPower = await readFile(new URL('../display/ups_power.py', import.meta.url));
const upsIdentity = await readFile(new URL('./ha_components/usb_ups_adapter/policy.py', import.meta.url));
const install = `import base64,os,pathlib,subprocess\nfiles=${JSON.stringify({
  '/usr/local/lib/ups-network-adapter/kiosk_control.py': source.toString('base64'),
  '/usr/local/lib/ups-network-adapter/screen_settings.py': screenSettings.toString('base64'),
  '/usr/local/lib/ups-network-adapter/ups_power.py': upsPower.toString('base64'),
  '/usr/local/lib/ups-network-adapter/ups_identity.py': upsIdentity.toString('base64'),
  '/etc/systemd/system/ups-kiosk-control.service': service.toString('base64'),
  '/etc/ups-network-adapter/kiosk-control.token': Buffer.from(token).toString('base64'),
})}\nfor name in files:\n if pathlib.Path(name).exists(): raise RuntimeError('Control endpoint already exists; review before updating')\nfor name,data in files.items():\n p=pathlib.Path(name);p.write_bytes(base64.b64decode(data));os.chmod(p,0o600 if name.endswith('.token') else 0o644)\nsubprocess.run(['systemctl','daemon-reload'],check=True)\nsubprocess.run(['systemctl','enable','--now','ups-kiosk-control.service'],check=True,capture_output=True)\nprint('Pi endpoint installed; no power command sent')\n`;
if (!record.pi_installed) await new Promise((resolvePromise, reject) => {
  const child = spawn('ssh', ['-i', resolve(process.env.USERPROFILE, '.ssh/ups_adapter_admin'), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'upsadmin@192.168.50.200', 'sudo -n python3 -'], { windowsHide: true });
  let error = '';
  child.stderr.on('data', data => { error += data; });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolvePromise() : reject(new Error('Pi endpoint install failed: ' + error.slice(-300))));
  child.stdin.end(install);
});
record.pi_installed = true;
await save();
const ha = await HomeAssistant.fromFile('http://192.168.50.117', tokenFile);
let stopEditor = false;
try {
  await ha.connect();
  const info = await ha.command('supervisor/api', { endpoint: '/addons/core_configurator/info', method: 'get' });
  stopEditor = info.state !== 'started';
  if (stopEditor) {
    for (let attempt = 0; ; attempt++) {
      try {
        await ha.command('supervisor/api', { endpoint: '/addons/core_configurator/start', method: 'post' }, 45000);
        break;
      } catch (error) { if (attempt >= 2) throw error; }
    }
  }
  const ready = await ha.command('supervisor/api', { endpoint: '/addons/core_configurator/info', method: 'get' });
  const base = new URL(ready.ingress_entry, ha.baseUrl);
  assert.equal(base.origin, ha.baseUrl);
  const session = await ha.command('supervisor/api', { endpoint: '/ingress/session', method: 'post' });
  async function request(path, body) {
    const response = await fetch(base.href.replace(/\/$/, '') + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Cookie: `ingress_session=${session.session}`, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: body ? new URLSearchParams(body) : undefined });
    if (!response.ok) throw new Error('File Editor request failed');
    return response;
  }
  const configPath = '/homeassistant/configuration.yaml';
  const before = await (await request('/api/file?filename=' + encodeURIComponent(configPath))).text();
  assert.ok(before !== 'File not found' && !/^rest_command\s*:/m.test(before), 'Review existing REST command configuration');
  record.configuration_before = before;
  const after = before.trimEnd() + '\n\n# Home Console: only the Raspberry Pi endpoint, not HA host power.\nrest_command: !include home_console_pi_power.yaml\n';
  record.configuration_after = after;
  const commands = `home_console_pi_power:\n  url: "http://192.168.50.200:8766/power"\n  method: POST\n  headers:\n    Authorization: "Bearer ${token}"\n  content_type: "application/json"\n  payload: '{"action":"{{ action }}","confirmed":true}'\n  timeout: 10\nhome_console_pi_health:\n  url: "http://192.168.50.200:8766/health"\n  method: GET\n  headers:\n    Authorization: "Bearer ${token}"\n  timeout: 10\n`;
  await save();
  const screenHeaders = `  headers:\n    Authorization: "Bearer ${token}"\n  timeout: 10\n`;
  const screenCommands = '\nhome_console_pi_screen:\n  url: "http://192.168.50.200:8766/screen"\n  method: GET\n' + screenHeaders
    + '\nhome_console_pi_set_screen:\n  url: "http://192.168.50.200:8766/screen"\n  method: POST\n' + screenHeaders
    + `  content_type: "application/json"\n  payload: '{"enabled":{{ enabled | tojson }}}'\n`;
  for (const [filename, text] of [['/homeassistant/home_console_pi_power.yaml', commands + screenCommands], [configPath, after]]) {
    const result = await (await request('/api/save', { filename, text })).json();
    if (result.error) throw new Error('Cannot save HA REST command configuration');
  }
  try {
    const check = await ha.rest('/api/config/core/check_config', { method: 'POST', body: {}, timeoutMs: 60000 });
    assert.equal(check.result, 'valid', String(check.errors || 'HA configuration validation failed').replaceAll(token, '[REDACTED]'));
  } catch (error) {
    await request('/api/save', { filename: configPath, text: before });
    record.status = 'configuration-rolled-back';
    await save();
    throw error;
  }
  record.status = 'validated-awaiting-ha-restart';
  await save();
  console.log('Pi endpoint installed and HA configuration validated. HA restart is required; no power operation sent.');
} finally {
  try { if (stopEditor) await ha.command('supervisor/api', { endpoint: '/addons/core_configurator/stop', method: 'post' }, 30000); }
  finally { ha.close(); }
}
