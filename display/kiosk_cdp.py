"""Small synchronous CDP transport using only Python's standard library.

Only Chromium's existing loopback debugger is accepted. Protocol data is never logged.
"""
import base64
import hashlib
import json
import os
import socket
import struct
import time
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, build_opener


class BrowserError(RuntimeError):
    pass


def debugger_json(path: str, port: int = 9222):
    if path not in ("/json/list", "/json/version"):
        raise BrowserError("Unsupported debugger path")
    opener = build_opener(ProxyHandler({}))
    with opener.open(f"http://127.0.0.1:{port}" + path, timeout=4) as response:
        return json.load(response)


class Cdp:
    LIMIT = 8 * 1024 * 1024

    def __init__(self, address: str, timeout: float = 4, port: int = 9222):
        url = urlsplit(address)
        if (url.scheme != "ws" or url.hostname != "127.0.0.1" or url.port != port
                or url.username or url.password or url.query or url.fragment
                or not url.path.startswith("/devtools/")):
            raise BrowserError("Unexpected browser debugger address")
        self.socket = socket.create_connection(("127.0.0.1", port), timeout)
        self.timeout = timeout
        self.buffer = bytearray()
        self.next_id = 0
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (f"GET {url.path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n"
                   f"Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                   "Sec-WebSocket-Version: 13\r\n\r\n")
        try:
            self.socket.sendall(request.encode("ascii"))
            while b"\r\n\r\n" not in self.buffer:
                chunk = self.socket.recv(4096)
                if not chunk:
                    raise BrowserError("Browser disconnected")
                self.buffer.extend(chunk)
                if len(self.buffer) > 65536:
                    raise BrowserError("Invalid browser handshake")
            header, remaining = bytes(self.buffer).split(b"\r\n\r\n", 1)
            self.buffer = bytearray(remaining)
            lines = header.decode("ascii").split("\r\n")
            fields = {key.lower(): value.strip() for line in lines[1:] if ":" in line
                      for key, value in [line.split(":", 1)]}
            expected = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            if " 101 " not in lines[0] or fields.get("sec-websocket-accept") != expected:
                raise BrowserError("Browser handshake rejected")
        except Exception:
            self.close()
            raise

    def close(self):
        self.socket.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def _read(self, length: int, deadline: float) -> bytes:
        if length > self.LIMIT:
            raise BrowserError("Browser response exceeded its bound")
        while len(self.buffer) < length:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise BrowserError("Browser response timed out")
            self.socket.settimeout(remaining)
            data = self.socket.recv(min(65536, length - len(self.buffer)))
            if not data:
                raise BrowserError("Browser disconnected")
            self.buffer.extend(data)
        data = bytes(self.buffer[:length])
        del self.buffer[:length]
        return data

    def _send(self, opcode: int, data: bytes):
        length = len(data)
        if length > self.LIMIT:
            raise BrowserError("Browser request exceeded its bound")
        prefix = bytes([0x80 | opcode])
        if length < 126:
            prefix += bytes([0x80 | length])
        elif length <= 65535:
            prefix += bytes([0x80 | 126]) + struct.pack("!H", length)
        else:
            prefix += bytes([0x80 | 127]) + struct.pack("!Q", length)
        mask = os.urandom(4)
        self.socket.sendall(prefix + mask + bytes(value ^ mask[i % 4] for i, value in enumerate(data)))

    def _message(self, deadline: float):
        message = bytearray()
        while True:
            first, second = self._read(2, deadline)
            if first & 0x70 or second & 0x80:
                raise BrowserError("Unexpected browser frame")
            opcode = first & 15
            length = second & 127
            if length == 126:
                length = struct.unpack("!H", self._read(2, deadline))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read(8, deadline))[0]
            data = self._read(length, deadline)
            if opcode == 8:
                raise BrowserError("Browser disconnected")
            if opcode == 9:
                self._send(10, data)
                continue
            if opcode == 10:
                continue
            if opcode not in (0, 1) or len(message) + length > self.LIMIT:
                raise BrowserError("Unsupported browser frame")
            message.extend(data)
            if first & 0x80:
                return json.loads(message)

    def call(self, method: str, params: dict | None = None):
        self.next_id += 1
        identifier = self.next_id
        self.socket.settimeout(self.timeout)
        self._send(1, json.dumps({"id": identifier, "method": method, "params": params or {}}).encode())
        deadline = time.monotonic() + self.timeout
        while True:
            message = self._message(deadline)
            if message.get("id") != identifier:
                continue
            if "error" in message:
                raise BrowserError("Browser command failed")
            return message.get("result", {})

    def evaluate(self, expression: str):
        result = self.call("Runtime.evaluate", {"expression": expression, "returnByValue": True})
        if result.get("exceptionDetails"):
            raise BrowserError("Browser readiness check failed")
        return result.get("result", {}).get("value")
