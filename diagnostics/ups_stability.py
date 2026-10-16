#!/usr/bin/env python3
"""Seven-day, read-only UPS health sampling and bounded pre-failure USB capture."""

import argparse
from datetime import datetime, timezone
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import subprocess
import threading
import time

SERVICES = ('ups-autodetect', 'nut-driver@ups', 'nut-server', 'ups-snmp')
FIELDS = ('ups.status', 'device.model', 'battery.charge', 'battery.runtime',
          'input.voltage', 'ups.load', 'driver.flag.pollonly', 'driver.parameter.pollinterval')


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def command(arguments, timeout=5):
    try:
        result = subprocess.run(arguments, capture_output=True, text=True, timeout=timeout)
        return {'returncode': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {'returncode': -1, 'stdout': '', 'stderr': str(error)}


def usb_devices(root=Path('/sys/bus/usb/devices')):
    devices = []
    for path in root.iterdir():
        try:
            if (path.joinpath('idVendor').read_text().strip(),
                    path.joinpath('idProduct').read_text().strip()) == ('051d', '0002'):
                devices.append({'path': path.name, 'bus': int(path.joinpath('busnum').read_text()),
                                'device': int(path.joinpath('devnum').read_text())})
        except (OSError, ValueError):
            continue
    return devices


def is_ups_record(line, devices):
    fields = line.split()
    if len(fields) < 4:
        return False
    address = fields[3].split(':')
    try:
        return len(address) == 4 and any(
            (int(address[1]), int(address[2])) == (device['bus'], device['device']) for device in devices)
    except ValueError:
        return False


def rotating_log(path, size, backups):
    handler = RotatingFileHandler(path, maxBytes=size, backupCount=backups, encoding='utf-8')
    handler.setFormatter(logging.Formatter('%(message)s'))
    logger = logging.Logger(str(path), level=logging.INFO)
    logger.addHandler(handler)
    return logger


def sample(check_snmp):
    result = command(['/usr/bin/upsc', 'ups@127.0.0.1'])
    values = dict(line.split(': ', 1) for line in result['stdout'].splitlines() if ': ' in line)
    services = command(['/usr/bin/systemctl', 'show', '--property=MainPID', '--value', *SERVICES])
    pids = services['stdout'].split()
    record = {'time': timestamp(), 'nut_returncode': result['returncode'],
              'nut_error': result['stderr'][:2048], 'readings': {key: values.get(key) for key in FIELDS},
              'service_pids': dict(zip(SERVICES, pids)), 'usb': usb_devices()}
    errors = []
    if result['returncode'] or not values.get('ups.status'):
        errors.append('NUT readings unavailable')
    if services['returncode'] or len(pids) != len(SERVICES) or '0' in pids:
        errors.append('Adapter service unavailable')
    if len(record['usb']) != 1:
        errors.append('Expected APC USB device unavailable or ambiguous')
    try:
        record['usbmon_stats'] = Path('/sys/kernel/debug/usb/usbmon/0s').read_text().strip()
    except OSError as error:
        record['usbmon_stats'] = str(error)
    if check_snmp:
        snmp = command(['/usr/bin/snmpget', '-v2c', '-c', 'public', '-t', '2', '-r', '0',
                        '127.0.0.1:161', '1.3.6.1.2.1.33.1.2.4.0', '1.3.6.1.2.1.33.1.4.1.0'])
        record['snmp'] = snmp
        if snmp['returncode'] or 'No Such' in snmp['stdout']:
            errors.append('SNMP readings unavailable')
    record['errors'] = errors
    return record


def save_incident(directory, record):
    # Exclusive creation preserves the first fault, including across service restarts.
    try:
        with directory.joinpath('incident.json').open('x', encoding='utf-8') as stream:
            json.dump(record, stream, indent=2)
    except FileExistsError:
        return
    print('First fault recorded; USB trace frozen. No recovery action performed.', flush=True)
    for name, arguments in (
        ('services-at-fault.log', ['/usr/bin/journalctl', '--since', '-30min', '--no-pager', '-n', '2000',
                                   *[part for unit in SERVICES for part in ('-u', unit)]]),
        ('kernel-at-fault.log', ['/usr/bin/journalctl', '-k', '--since', '-30min', '--no-pager', '-n', '2000']),
    ):
        result = command(arguments, timeout=15)
        directory.joinpath(name).write_bytes((result['stdout'] + result['stderr']).encode('utf-8')[-1024 * 1024:])


def trace(directory, stop):
    logger = rotating_log(directory / 'usb.log', 4 * 1024 * 1024, 7)
    devices = []
    refresh = 0
    try:
        descriptor = os.open('/sys/kernel/debug/usb/usbmon/0u', os.O_RDONLY)
        try:
            while not stop.is_set() and not directory.joinpath('incident.json').exists():
                if time.monotonic() >= refresh:
                    current = usb_devices()
                    # Retain the old address during disconnect so pending completions are captured.
                    # shortcut: early enumeration can precede sysfs identity; capture the whole bus if implicated.
                    if current:
                        devices = current
                    refresh = time.monotonic() + 1
                data = os.read(descriptor, 4096)
                if not data:
                    raise OSError('USB monitor ended unexpectedly')
                if stop.is_set() or directory.joinpath('incident.json').exists():
                    break
                for line in data.decode('ascii', errors='replace').splitlines():
                    if is_ups_record(line, devices):
                        logger.info('%s %s', timestamp(), line)
        finally:
            os.close(descriptor)
    finally:
        for handler in logger.handlers:
            handler.close()


def run(directory, duration):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    metadata_path = directory / 'test.json'
    if not metadata_path.exists():
        metadata_path.write_text(json.dumps({'started': timestamp(), 'deadline': time.time() + duration,
                                            'duration_seconds': duration}), encoding='utf-8')
    metadata = json.loads(metadata_path.read_text(encoding='utf-8'))
    if time.time() >= metadata['deadline']:
        print('Observation period complete; logs retained.', flush=True)
        return
    logger = rotating_log(directory / 'health.jsonl', 2 * 1024 * 1024, 7)
    stop = threading.Event()
    worker = threading.Thread(target=trace, args=(directory, stop), daemon=True)
    worker.start()
    previous = None
    health_path = directory / 'health.jsonl'
    if health_path.exists() and health_path.stat().st_size:
        try:
            previous = json.loads(health_path.read_text(encoding='utf-8').splitlines()[-1])['service_pids']
        except (json.JSONDecodeError, KeyError):
            print('Previous health record incomplete; inspect logs for an interrupted write.', flush=True)
    index = 0
    print(f"Observation active until {metadata['deadline']}; logs: {directory}", flush=True)
    try:
        while time.time() < metadata['deadline']:
            started = time.monotonic()
            record = sample(index % 5 == 0)
            record['events'] = []
            if previous and previous != record['service_pids']:
                record['events'].append('Adapter service PID changed')
            if not worker.is_alive() and not directory.joinpath('incident.json').exists():
                raise RuntimeError('USB trace worker stopped unexpectedly')
            logger.info(json.dumps(record, separators=(',', ':')))
            if record['nut_returncode'] or not record['readings'].get('ups.status'):
                save_incident(directory, record)
            previous = record['service_pids']
            index += 1
            stop.wait(max(0, min(60 - (time.monotonic() - started), metadata['deadline'] - time.time())))
    finally:
        stop.set()
        worker.join(timeout=3)
        for handler in logger.handlers:
            handler.close()
    print('Observation period complete; logs retained.', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=Path('/var/log/ups-stability'))
    parser.add_argument('--duration', type=int, default=7 * 24 * 60 * 60)
    arguments = parser.parse_args()
    if arguments.duration <= 0:
        parser.error('--duration must be positive')
    os.umask(0o077)
    run(arguments.directory, arguments.duration)
