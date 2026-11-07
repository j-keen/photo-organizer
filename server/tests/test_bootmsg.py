"""Regression checks for startup messages and cmd-safe launcher bytes."""
from pathlib import Path
import re
import subprocess
import sys
import unittest

from server.bootmsg import MESSAGES


SERVER_DIR = Path(__file__).resolve().parents[1]


class BootMessageTests(unittest.TestCase):
    def test_all_keys_print_korean_as_utf8(self):
        expected_keys = {
            'preparing', 'ready', 'installing', 'server_error',
            'folder_error', 'venv_error', 'requirements_error', 'pip_error',
        }
        self.assertEqual(set(MESSAGES), expected_keys)
        for key in sorted(expected_keys):
            with self.subTest(key=key):
                result = subprocess.run(
                    [sys.executable, str(SERVER_DIR / 'bootmsg.py'), key],
                    cwd=SERVER_DIR,
                    capture_output=True,
                    timeout=10,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                output = result.stdout.decode('utf-8').replace('\r\n', '\n')
                self.assertEqual(output, f'  {MESSAGES[key]}\n')
                self.assertRegex(output, '[가-힣]')
                self.assertEqual(result.stderr, b'')

    def test_module_entry_point(self):
        result = subprocess.run(
            [sys.executable, '-m', 'server.bootmsg', 'ready'],
            cwd=SERVER_DIR.parent,
            capture_output=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(MESSAGES['ready'], result.stdout.decode('utf-8'))

    def test_invalid_arguments(self):
        for args in ([], ['unknown'], ['ready', 'extra']):
            with self.subTest(args=args):
                result = subprocess.run(
                    [sys.executable, str(SERVER_DIR / 'bootmsg.py'), *args],
                    capture_output=True,
                    timeout=10,
                )
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, b'')
                self.assertIn(b'Usage:', result.stderr)

    def test_start_batch_is_ascii_and_uses_known_keys(self):
        data = (SERVER_DIR / 'start.bat').read_bytes()
        self.assertTrue(data.isascii(), 'start.bat must contain only ASCII bytes, including comments')
        text = data.decode('ascii')
        keys = re.findall(r'bootmsg\.py" ([a-z_]+)', text)
        self.assertEqual(set(keys), set(MESSAGES))


if __name__ == '__main__':
    unittest.main()
