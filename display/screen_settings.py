"""Persistent Pi screen preferences shared by the controller and screen service."""
import json
import os
from pathlib import Path
import tempfile

SETTINGS_PATH = Path('/var/lib/ups-kiosk-control/screen.json')


def read_night_blanking(path=SETTINGS_PATH):
    try:
        settings = json.loads(path.read_text())
    except FileNotFoundError:
        return True
    value = settings.get('night_blanking_enabled') if isinstance(settings, dict) else None
    if type(value) is not bool:
        raise ValueError('Invalid night screen setting')
    return value


def write_night_blanking(enabled, path=SETTINGS_PATH):
    if type(enabled) is not bool:
        raise ValueError('Expected a boolean night screen setting')
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            json.dump({'night_blanking_enabled': enabled}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
