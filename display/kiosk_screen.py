"""Night backlight control. Exclusively grab only darkness and the complete wake contact.

Normal contacts go directly to Cage. No virtual input device or package is required.
"""
import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import select
import signal
import struct
import time

from kiosk_policy import ScreenPolicy
from screen_settings import read_night_blanking

EVENT = struct.Struct("llHHi")
EVIOCGRAB = 0x40044590
BTN_TOUCH = 330
TOUCH_NAME = "10-0014 Goodix Capacitive TouchScreen"
stopping = False


def stop(*_):
    global stopping
    stopping = True


class TouchScreen:
    def __init__(self):
        matches = [p for p in Path("/sys/class/input").glob("event*/device")
                   if (p / "name").read_text().strip() == TOUCH_NAME]
        lights = list(Path("/sys/class/backlight").glob("*"))
        if len(matches) != 1 or len(lights) != 1 or lights[0].name != "10-0045":
            raise RuntimeError("Expected the verified Goodix touch panel and DSI backlight")
        self.path = "/dev/input/" + matches[0].parent.name
        self.fd = os.open(self.path, os.O_RDONLY | os.O_NONBLOCK)
        self.brightness = lights[0] / "brightness"
        self.maximum = int((lights[0] / "max_brightness").read_text())
        self.grabbed = False
        self.lit = int(self.brightness.read_text()) != 0
        self.buffer = bytearray()
        self.touched = self.contact_down()

    def contact_down(self):
        keys = bytearray(96)
        fcntl.ioctl(self.fd, (2 << 30) | (len(keys) << 16) | (ord("E") << 8) | 0x18, keys)
        return bool(keys[BTN_TOUCH // 8] & (1 << (BTN_TOUCH % 8)))

    def apply(self, lit, grabbed):
        # Establish the grab before darkness; restore light before releasing the grab.
        if grabbed and not self.grabbed:
            if self.contact_down():
                return False
            fcntl.ioctl(self.fd, EVIOCGRAB, 1)
            self.grabbed = True
        if lit != self.lit:
            self.brightness.write_text(str(self.maximum if lit else 0))
            self.lit = lit
            print("Screen: lit" if lit else "Screen: night sleep", flush=True)
        if not grabbed and self.grabbed:
            fcntl.ioctl(self.fd, EVIOCGRAB, 0)
            self.grabbed = False
        return True

    def frames(self):
        self.buffer.extend(os.read(self.fd, EVENT.size * 128))
        complete = len(self.buffer) // EVENT.size * EVENT.size
        events = bytes(self.buffer[:complete])
        del self.buffer[:complete]
        for _, _, kind, code, value in EVENT.iter_unpack(events):
            if kind == 0 and code == 3:
                raise RuntimeError("Touch event overflow; restoring normal input")
            if kind == 1 and code == BTN_TOUCH:
                self.touched = value != 0
            if kind == 0 and code == 0:
                yield self.touched

    def close(self):
        try:
            self.brightness.write_text(str(self.maximum))
        finally:
            # Closing the descriptor also releases its exclusive grab.
            os.close(self.fd)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--inspect", action="store_true")
    args = parser.parse_args()
    screen = TouchScreen()
    if args.inspect:
        try:
            print(json.dumps({"touch": screen.path, "name": TOUCH_NAME,
                              "brightness": int(screen.brightness.read_text()),
                              "maximum": screen.maximum, "contact_down": screen.touched,
                              "exclusive_grab": False}))
        finally:
            os.close(screen.fd)
        return
    policy = ScreenPolicy(lit=screen.lit)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        while not stopping:
            night_enabled = read_night_blanking()
            readable, _, _ = select.select([screen.fd], [], [], 0.25)
            if readable:
                for touched in screen.frames():
                    if not screen.apply(*policy.update(time.monotonic(), datetime.datetime.now().hour, touched, night_enabled)):
                        policy.lit = screen.lit
            else:
                if not screen.apply(*policy.update(time.monotonic(), datetime.datetime.now().hour, screen.touched, night_enabled)):
                    policy.lit = screen.lit
    finally:
        screen.close()


if __name__ == "__main__":
    main()
