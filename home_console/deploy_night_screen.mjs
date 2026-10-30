// Upgrade the existing Pi screen endpoint and HA commands, with private before-records.
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { HomeAssistant } from './ha_client.mjs';
import { editor } from './deploy_ups_switching.mjs';
import { assertOutsideRepository } from './ha_snapshot.mjs';
import { fileURLToPath } from 'node:url';

const [tokenFile, directory] = process.argv.slice(2);
assert.ok(tokenFile && directory);
assertOutsideRepository(resolve(directory), fileURLToPath(new URL('..', import.meta.url)));
const credentials = JSON.parse(await readFile(resolve(directory, 'pi-control-install.json'), 'utf8'));
const assets = {};
for (const name of ['kiosk_control.py', 'screen_settings.py', 'kiosk_policy.py', 'kiosk_screen.py', 'ups_power.py']) {
  assets['/usr/local/lib/ups-network-adapter/' + name] = (await readFile(new URL('../display/' + name, import.meta.url))).toString('base64');
}
assets['/usr/local/lib/ups-network-adapter/ups_identity.py'] = (await readFile(new URL('./ha_components/usb_ups_adapter/policy.py', import.meta.url))).toString('base64');
assets['/etc/systemd/system/ups-kiosk-control.service'] = (await readFile(new URL('../display/ups-kiosk-control.service', import.meta.url))).toString('base64');
const install = `import base64,json,os,pathlib,shutil,subprocess
backup=pathlib.Path('/var/backups/home-console/night-screen-20261030')
backup.mkdir(mode=0o700,parents=True,exist_ok=True)
assets=json.loads(${JSON.stringify(JSON.stringify(assets))})
manifest={}
for name in assets:
 p=pathlib.Path(name)
 target=backup/p.name
 manifest[name]=p.exists()
 if p.exists() and not target.exists(): shutil.copy2(p,target)
if not (backup/'manifest.json').exists(): (backup/'manifest.json').write_text(json.dumps(manifest))
for name,data in assets.items():
 p=pathlib.Path(name);temporary=p.with_name(p.name+'.night-new')
 temporary.write_bytes(base64.b64decode(data));os.chmod(temporary,0o644);temporary.replace(p)
subprocess.run(['python3','-m','py_compile',* [name for name in assets if name.endswith('.py')]],check=True)
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','restart','ups-kiosk-control.service','ups-kiosk-screen.service'],check=True)
print('Pi screen services updated; no power command sent')
`;
execFileSync('ssh', ['-i', resolve(process.env.USERPROFILE, '.ssh/ups_adapter_admin'), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
  'root@192.168.50.200', 'python3', '-'], { input: install, timeout: 45000, windowsHide: true });

const ha = await HomeAssistant.fromFile('http://192.168.50.117', tokenFile);
try {
  await ha.connect();
  const files = await editor(ha);
  try {
    const path = '/homeassistant/home_console_pi_power.yaml';
    const before = await files.read(path);
    assert.ok(before.includes('home_console_pi_power:') && !before.includes('home_console_pi_screen:'));
    const headers = `  headers:\n    Authorization: "Bearer ${credentials.token}"\n  timeout: 10\n`;
    const after = before.trimEnd() + '\n\nhome_console_pi_screen:\n  url: "http://192.168.50.200:8766/screen"\n  method: GET\n' + headers
      + '\nhome_console_pi_set_screen:\n  url: "http://192.168.50.200:8766/screen"\n  method: POST\n' + headers
      + `  content_type: "application/json"\n  payload: '{"enabled":{{ enabled | tojson }}}'\n`;
    await writeFile(resolve(directory, 'night-screen-ha-before.json'), JSON.stringify({ utc: new Date().toISOString(), path, before, after }, null, 2), { flag: 'wx', mode: 0o600 });
    await files.save(path, after);
    try {
      const check = await ha.rest('/api/config/core/check_config', { method: 'POST', body: {}, timeoutMs: 60000 });
      assert.equal(check.result, 'valid');
      await ha.rest('/api/services/rest_command/reload', { method: 'POST', body: {} });
    } catch (error) {
      await files.save(path, before);
      await ha.rest('/api/services/rest_command/reload', { method: 'POST', body: {} });
      throw error;
    }
    const result = await ha.command('call_service', { domain: 'rest_command', service: 'home_console_pi_screen', return_response: true });
    assert.equal(result.response.status, 200);
    assert.equal(typeof result.response.content.enabled, 'boolean');
    console.log(JSON.stringify({ deployed: true, night_blanking_enabled: result.response.content.enabled, ha_restarted: false }));
  } finally { await files.close(); }
} finally { ha.close(); }
