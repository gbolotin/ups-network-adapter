"""Bounded, read-only 48-hour acceptance collector using existing Python/systemd."""
import argparse
import datetime
import json
import os
from pathlib import Path
import time

from kiosk_health import sample


def utc():
    return datetime.datetime.now(datetime.timezone.utc)


def summarize(root):
    schedule = json.loads((root / 'schedule.json').read_text())
    count = unhealthy = 0
    minimum_ram = maximum_temperature = maximum_pss = None
    first = last = None
    maximum_gap = 0
    latest_healthy = None
    boots = set()
    for line in (root / 'samples.ndjson').read_text().splitlines():
        item = json.loads(line)
        count += 1
        first = first or item['utc']
        if last:
            maximum_gap = max(maximum_gap, (datetime.datetime.fromisoformat(item['utc']) - datetime.datetime.fromisoformat(last)).total_seconds())
        last = item['utc']
        latest_healthy = item['healthy']
        boots.add(item['boot_id'])
        unhealthy += not item['healthy']
        ram, temperature, pss = item['mem_available_kib'], item['temperature_c'], item['kiosk_pss_kib']
        minimum_ram = ram if minimum_ram is None else min(minimum_ram, ram)
        maximum_temperature = temperature if maximum_temperature is None else max(maximum_temperature, temperature)
        maximum_pss = pss if maximum_pss is None else max(maximum_pss, pss)
    complete = utc() >= datetime.datetime.fromisoformat(schedule['deadline_utc'])
    return {**schedule, 'complete': complete, 'samples': count, 'unhealthy_samples': unhealthy,
            'first_sample_utc': first, 'last_sample_utc': last, 'boot_count': len(boots),
            'maximum_gap_seconds': maximum_gap, 'latest_healthy': latest_healthy,
            'minimum_mem_available_kib': minimum_ram, 'maximum_temperature_c': maximum_temperature,
            'maximum_kiosk_pss_kib': maximum_pss}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--initialize', action='store_true')
    parser.add_argument('--summary', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('The private acceptance collector runs as root')
    os.umask(0o077)
    root = args.directory.resolve()
    if root.parent != Path('/var/backups/home-console/20261027T210523Z') or root.name != 'observation':
        raise RuntimeError('Unexpected observation location')
    if args.initialize:
        root.mkdir(mode=0o700)
        start = utc()
        schedule = {'started_utc': start.isoformat(),
                    'deadline_utc': (start + datetime.timedelta(hours=48)).isoformat(), 'interval_seconds': 60}
        with (root / 'schedule.json').open('x') as output:
            json.dump(schedule, output, indent=2)
        (root / 'samples.ndjson').touch(mode=0o600, exist_ok=False)
        print(json.dumps(schedule))
        return
    if args.summary:
        print(json.dumps(summarize(root)))
        return
    schedule = json.loads((root / 'schedule.json').read_text())
    deadline = datetime.datetime.fromisoformat(schedule['deadline_utc'])
    previous = None
    while utc() < deadline:
        item = sample()
        item['healthy'] = item['healthy'] and item['mem_available_kib'] >= 131072 and item['temperature_c'] < 80
        with (root / 'samples.ndjson').open('a') as output:
            output.write(json.dumps(item) + '\n')
        if item['healthy'] != previous:
            print('Observation: healthy' if item['healthy'] else 'Observation: inspect acceptance sample', flush=True)
            previous = item['healthy']
        time.sleep(min(60, max(0, (deadline - utc()).total_seconds())))
    (root / 'summary.json').write_text(json.dumps(summarize(root), indent=2))
    print('Observation: fixed 48-hour collection completed', flush=True)


if __name__ == '__main__':
    main()
