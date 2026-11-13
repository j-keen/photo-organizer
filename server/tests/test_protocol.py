import os
import unittest
from unittest.mock import patch
from server import launcher, APP_ID, API_VERSION
from server.__main__ import main


class FakeRegistry:
    HKEY_CURRENT_USER = 1
    REG_SZ = 1
    KEY_SET_VALUE = 2

    def __init__(self):
        self.values = {}
        self.writes = 0

    def OpenKey(self, root, key):
        class Handle:
            def __enter__(self): return (root, key)
            def __exit__(self, *args): pass
        return Handle()

    CreateKeyEx = lambda self, root, key, *args: self.OpenKey(root, key)

    def QueryValueEx(self, handle, name):
        try: return self.values[handle, name]
        except KeyError: raise FileNotFoundError()

    def SetValueEx(self, handle, name, reserved, kind, value):
        self.values[handle, name] = (value, kind)
        self.writes += 1


class ProtocolTests(unittest.TestCase):
    def test_absolute_windowless_command(self):
        command = launcher.protocol_command()
        self.assertIn('pythonw.exe', command)
        self.assertIn('--from-link "%1"', command)
        self.assertIn('sys.path.insert', command)
        self.assertIn('runpy.run_module', command)
        self.assertNotIn('--open', command)
        self.assertIn(str(launcher.APP_ROOT).replace('\\', '\\\\'), command)

    def test_compare_before_write_and_dry(self):
        registry = FakeRegistry()
        with patch.dict(os.environ, {'FI_DRY_SHELL': '0'}), patch.object(launcher, 'make_icon'):
            self.assertTrue(launcher.register_protocol(registry=registry, root=42))
            self.assertEqual(registry.writes, 4)
            self.assertFalse(launcher.register_protocol(registry=registry, root=42))
            self.assertEqual(registry.writes, 4)
            handle = (42, r'Software\Classes\fluid-organizer\shell\open\command')
            registry.values[handle, ''] = ('outdated', registry.REG_SZ)
            self.assertTrue(launcher.register_protocol(registry=registry, root=42))
            self.assertEqual(registry.writes, 5)
        with patch.dict(os.environ, {'FI_DRY_SHELL': '1'}):
            self.assertFalse(launcher.register_protocol(registry=registry))
        self.assertEqual(registry.writes, 5)

    def test_link_does_not_open_browser_when_running(self):
        with patch.object(launcher, 'register_protocol'), patch.object(launcher, 'health', return_value={
            'app': APP_ID, 'apiVersion': API_VERSION
        }), patch('webbrowser.open') as browser:
            self.assertEqual(main(['--from-link', 'fluid-organizer://evil/path?command=delete', '--open']), 0)
            browser.assert_not_called()

    def test_link_start_does_not_open_browser(self):
        with patch.object(launcher, 'register_protocol'), patch.object(launcher, 'health', return_value=None), \
             patch('server.__main__._probe_port', return_value='free'), patch('uvicorn.Server.run'), \
             patch('webbrowser.open') as browser, patch('server.__main__._open_when_ready') as opener:
            self.assertEqual(main(['--from-link', 'fluid-organizer://start', '--open']), 0)
            browser.assert_not_called()
            opener.assert_not_called()
