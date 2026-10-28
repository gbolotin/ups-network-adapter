"""Archive safety checks; no SSH, root access, or live service changes."""

import hashlib
from pathlib import Path
import tarfile
import tempfile
import unittest

from home_console.capture_pi import archive_paths


class CapturePiTests(unittest.TestCase):
    def test_saved_bytes_hashes_and_missing_paths_are_verifiable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'launcher'
            source.write_bytes(b'#!/bin/sh\nexec chromium\n')
            archive = root / 'kiosk.tar'
            manifest = archive_paths([source, root / 'absent'], archive)
            self.assertEqual(manifest['sha256'], hashlib.sha256(archive.read_bytes()).hexdigest())
            self.assertEqual(manifest['members'][0]['sha256'], hashlib.sha256(source.read_bytes()).hexdigest())
            self.assertEqual(manifest['missing_optional_paths'], [str(root / 'absent')])
            with tarfile.open(archive) as saved:
                self.assertEqual(saved.extractfile(saved.getmembers()[0]).read(), source.read_bytes())

    def test_existing_archive_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'kiosk.tar'
            archive.write_bytes(b'original snapshot')
            with self.assertRaises(FileExistsError):
                archive_paths([], archive)
            self.assertEqual(archive.read_bytes(), b'original snapshot')


if __name__ == '__main__':
    unittest.main()
