"""Full kiosk-file/profile rollback drill, followed by restoration of verified HA.

Root-only, fixed paths. NUT, Docker data, SSH, and HA configuration are untouched.
Both browser profiles are retained privately; no recursive deletion is performed.
"""
import base64
import datetime
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tarfile
import time
from urllib.parse import urlsplit

sys.path.insert(0, '/usr/local/lib/ups-network-adapter')
from kiosk_cdp import Cdp, debugger_json
from kiosk_supervisor import READINESS
from deploy_pi import digest, install, run, wait_for_profile_release

ROOT = Path('/var/backups/home-console/20261027T210523Z')
PROFILE = Path('/var/lib/ups-kiosk/chromium')
LAUNCHER = '/usr/local/bin/ups-kiosk-browser'
UNIT = '/etc/systemd/system/ups-kiosk.service'


def stopped():
    run('systemctl', 'stop', 'ups-kiosk-login.timer', 'ups-kiosk-login.service', 'ups-kiosk.service')
    wait_for_profile_release()


def wait_page(kind, timeout=60):
    began = time.monotonic()
    while time.monotonic() - began < timeout:
        try:
            for page in debugger_json('/json/list'):
                if page.get('type') != 'page':
                    continue
                parsed = urlsplit(page.get('url', ''))
                if kind == 'old' and parsed.netloc == '127.0.0.1:8080' and parsed.path == '/device/ups':
                    with Cdp(page['webSocketDebuggerUrl']) as client:
                        if client.evaluate("document.body.innerText.includes('Online') && document.body.innerText.includes('UPS Data')"):
                            return page
                if kind == 'new' and parsed.netloc == '192.168.50.117':
                    with Cdp(page['webSocketDebuggerUrl']) as client:
                        if client.evaluate(READINESS) == 'ready' and not client.evaluate('document.hidden'):
                            return page
        except (OSError, RuntimeError, KeyError, ValueError):
            pass
        time.sleep(.5)
    raise RuntimeError('Restored interface did not become usable: ' + kind)


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run this fixed-path drill as root')
    os.umask(0o077)
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    cutover = json.loads((ROOT / 'cutover.json').read_text())
    if digest(ROOT / 'kiosk.tar') != manifest['archive']['sha256'] or digest(ROOT / 'chromium-stopped.tar') != cutover['profile_sha256']:
        raise RuntimeError('Original rollback archive hash differs')
    if PROFILE.is_symlink() or not PROFILE.is_dir():
        raise RuntimeError('Unexpected profile path')
    verified = ROOT / 'profile-home-console-verified'
    old_after = ROOT / 'profile-original-after-drill'
    if verified.exists() or old_after.exists():
        raise RuntimeError('Inspect existing drill profiles before retrying')
    current = {LAUNCHER: (Path(LAUNCHER).read_bytes(), 0o755), UNIT: (Path(UNIT).read_bytes(), 0o644)}
    record = {'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'status': 'preparing', 'old_verified': False, 'new_verified': False}
    record_path = ROOT / 'full-rollback-drill.json'
    with record_path.open('x') as output:
        json.dump(record, output)
    moved = False
    original_error = None
    try:
        run('systemctl', 'disable', '--now', 'ups-kiosk-screen.service')
        stopped()
        with tarfile.open(ROOT / 'chromium-home-console-verified.tar', 'x') as saved:
            saved.add(PROFILE, arcname='var/lib/ups-kiosk/chromium', recursive=True)
        record['verified_ha_profile_sha256'] = digest(ROOT / 'chromium-home-console-verified.tar')
        PROFILE.rename(verified)
        moved = True
        with tarfile.open(ROOT / 'chromium-stopped.tar') as original:
            members = original.getmembers()
            links = {m.name for m in members if m.issym() or m.islnk()}
            for member in members:
                path = PurePosixPath(member.name)
                if path.is_absolute() or '..' in path.parts or not (member.name == 'var/lib/ups-kiosk/chromium' or member.name.startswith('var/lib/ups-kiosk/chromium/')):
                    raise RuntimeError('Unexpected profile archive member')
                if any(str(parent) in links for parent in path.parents):
                    raise RuntimeError('Profile archive contains a linked parent')
                if member.islnk() and not member.linkname.startswith('var/lib/ups-kiosk/chromium/'):
                    raise RuntimeError('Unexpected profile hard link')
            # Hash-verified, root-only archive with validated paths; preserve uid/gid/modes.
            original.extractall('/', members=members, filter='fully_trusted')
        with tarfile.open(ROOT / 'kiosk.tar') as original:
            for path in current:
                member = original.getmember(path.lstrip('/'))
                install(original.extractfile(member).read(), path, member.mode)
        run('systemctl', 'daemon-reload')
        run('systemctl', 'start', 'ups-kiosk.service', 'ups-kiosk-login.timer')
        page = wait_page('old')
        with Cdp(page['webSocketDebuggerUrl']) as client:
            shot = client.call('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': False})
            (ROOT / 'rollback-peanut-verified.png').write_bytes(base64.b64decode(shot['data']))
        record['old_verified'] = True
        record['status'] = 'original_peanut_and_profile_verified'
        record_path.write_text(json.dumps(record, indent=2))
        print(json.dumps({'original_kiosk_rollback_verified': True, 'private_profiles_preserved': True}), flush=True)
    except Exception as error:
        original_error = error
    finally:
        stopped()
        if moved:
            if PROFILE.exists():
                PROFILE.rename(old_after)
            verified.rename(PROFILE)
        for path, (data, mode) in current.items():
            install(data, path, mode)
        run('systemctl', 'daemon-reload')
        run('systemctl', 'start', 'ups-kiosk.service', 'ups-kiosk-login.timer')
        run('systemctl', 'enable', '--now', 'ups-kiosk-screen.service')
    wait_page('new')
    record['new_verified'] = True
    record['status'] = 'passed' if not original_error else 'verified_ha_restored_after_old_test_failure'
    record['ups_status'] = run('upsc', 'ups@localhost', 'ups.status')
    record_path.write_text(json.dumps(record, indent=2))
    print(json.dumps({'verified_ha_restored': True, 'ups_status': record['ups_status'], 'rollback_drill': record['status']}), flush=True)
    if original_error:
        raise original_error


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        raise SystemExit(str(error))
