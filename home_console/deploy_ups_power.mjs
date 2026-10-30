// Add a narrow confirmed UPS output control; never execute an UPS off command.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HomeAssistant } from './ha_client.mjs';
import { editor } from './deploy_ups_switching.mjs';
import { assertOutsideRepository } from './ha_snapshot.mjs';

const [tokenFile, directory, controlCredentials] = process.argv.slice(2);
assert.ok(tokenFile && directory && controlCredentials);
assertOutsideRepository(resolve(directory), fileURLToPath(new URL('..', import.meta.url)));
const credentials = JSON.parse(await readFile(controlCredentials, 'utf8'));
const revision = 'ups-power-' + new Date().toISOString().replace(/[^0-9TZ]/g, '');
const journal = resolve(directory, revision + '.json');
const record = { utc: new Date().toISOString(), status: 'pending', off_commands_sent: 0 };
await writeFile(journal, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
const save = () => writeFile(journal, JSON.stringify(record, null, 2));
const assets = {};
for (const name of ['kiosk_control.py', 'ups_power.py']) {
  assets['/usr/local/lib/ups-network-adapter/' + name] = (await readFile(new URL('../display/' + name, import.meta.url))).toString('base64');
}
// Reuse the identical physical identity policy on both sides of the connection.
assets['/usr/local/lib/ups-network-adapter/ups_identity.py'] = (await readFile(new URL('./ha_components/usb_ups_adapter/policy.py', import.meta.url))).toString('base64');
const install = `import base64,json,os,pathlib,re,secrets,shutil,subprocess,sys
backup=pathlib.Path(${JSON.stringify('/var/backups/home-console/' + revision)})
backup.mkdir(mode=0o700,parents=True,exist_ok=False)
assets=json.loads(${JSON.stringify(JSON.stringify(assets))})
users=pathlib.Path('/etc/nut/upsd.users')
config=pathlib.Path('/etc/ups-network-adapter/ups-power.json')
before=users.read_text()
if re.search(r'^\\s*\\[home_console_power\\]',before,re.M) or config.exists(): raise RuntimeError('UPS power account already exists; review before changing')
shutil.copy2(users,backup/'upsd.users')
manifest={name:pathlib.Path(name).exists() for name in assets}
for name in assets:
 p=pathlib.Path(name)
 if p.exists(): shutil.copy2(p,backup/p.name)
(backup/'manifest.json').write_text(json.dumps(manifest))
password=secrets.token_hex(32)
config.write_text(json.dumps({'username':'home_console_power','password':password}))
os.chmod(config,0o600)
try:
 users.write_text(before.rstrip()+'\\n\\n[home_console_power]\\n    password = '+password+'\\n    instcmds = load.off\\n')
 for name,data in assets.items():
  p=pathlib.Path(name);temporary=p.with_name(p.name+'.ups-new')
  temporary.write_bytes(base64.b64decode(data));os.chmod(temporary,0o644);temporary.replace(p)
 subprocess.run(['python3','-m','py_compile',*assets],check=True,capture_output=True)
 subprocess.run(['systemctl','reload','nut-server.service'],check=True,capture_output=True)
 sys.path.insert(0,'/usr/local/lib/ups-network-adapter')
 from ups_power import NutConnection,UpsPower
 with NutConnection() as nut:
  nut.command('USERNAME home_console_power');nut.command('PASSWORD '+password)
 info=UpsPower().status()
 if not info['can_power_off']: raise RuntimeError('Current UPS has no output-off support')
 subprocess.run(['systemctl','restart','ups-kiosk-control.service'],check=True,capture_output=True)
 subprocess.run(['systemctl','is-active','ups-kiosk-control.service','nut-server.service'],check=True,capture_output=True)
 print(json.dumps({'backend_installed':True,'model':info['model'],'can_power_off':info['can_power_off'],'off_commands_sent':0}))
except Exception:
 shutil.copy2(backup/'upsd.users',users)
 for name,existed in manifest.items():
  p=pathlib.Path(name)
  if existed: shutil.copy2(backup/p.name,p)
  elif p.exists(): p.unlink()
 if config.exists(): config.unlink()
 subprocess.run(['systemctl','reload','nut-server.service'],capture_output=True)
 subprocess.run(['systemctl','restart','ups-kiosk-control.service'],capture_output=True)
 raise
`;
record.pi = JSON.parse(execFileSync('ssh', ['-i', resolve(process.env.USERPROFILE, '.ssh/ups_adapter_admin'), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
  'upsadmin@192.168.50.200', 'sudo', '-n', 'python3', '-'], { input: install, timeout: 45000, windowsHide: true }).toString().trim());
await save();
const ha = await HomeAssistant.fromFile('http://192.168.50.117', tokenFile);
try {
  await ha.connect();
  const files = await editor(ha);
  try {
    const path = '/homeassistant/home_console_pi_power.yaml';
    const before = await files.read(path);
    assert.ok(before.includes('home_console_pi_power:') && !before.includes('home_console_ups_status:'));
    const headers = `  headers:\n    Authorization: "Bearer ${credentials.token}"\n  timeout: 20\n`;
    const after = before.trimEnd() + '\n\nhome_console_ups_status:\n  url: "http://192.168.50.200:8766/ups"\n  method: GET\n' + headers
      + '\nhome_console_ups_off:\n  url: "http://192.168.50.200:8766/ups/off"\n  method: POST\n' + headers
      + `  content_type: "application/json"\n  payload: '{"expected_identity":{{ expected_identity | tojson }},"confirmed":true}'\n`;
    record.ha = { path, before, after };
    await save();
    await files.save(path, after);
    try {
      const check = await ha.rest('/api/config/core/check_config', { method: 'POST', body: {}, timeoutMs: 60000 });
      assert.equal(check.result, 'valid');
      await ha.rest('/api/services/rest_command/reload', { method: 'POST', body: {} });
      const result = await ha.command('call_service', { domain: 'rest_command', service: 'home_console_ups_status', return_response: true });
      assert.equal(result.response.status, 200);
      const state = await ha.rest('/api/states/sensor.connected_ups_connected');
      assert.equal(result.response.content.id, state.attributes.id);
      assert.equal(result.response.content.can_power_off, true);
      record.capabilities = result.response.content;
      record.status = 'verified';
      await save();
      console.log(JSON.stringify({ deployed: true, model: record.capabilities.model, can_power_off: true, off_commands_sent: 0, ha_restarted: false }));
    } catch (error) {
      await files.save(path, before);
      await ha.rest('/api/services/rest_command/reload', { method: 'POST', body: {} });
      throw error;
    }
  } finally { await files.close(); }
} finally { ha.close(); }
