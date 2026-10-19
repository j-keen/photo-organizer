"""One-click start: single instance + version handshake, restart, shortcuts/icon, job pause, handoff support."""
from __future__ import annotations

import http.server
import io
import json
import os
import shutil
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from server import API_VERSION, APP_ID, launcher
from server.jobs import Job, JobCancelled
from server.tests.helpers import ServerTestCase, free_port


class _FakeOldServer:
    """A round-1 server look-alike: /api/health without apiVersion, a session cookie and /api/server/shutdown."""

    def __init__(self, body: dict | None = None):
        self.port = free_port()
        self.calls: list[tuple[str, str, dict]] = []
        outer = self
        payload = json.dumps(body if body is not None else {'app': APP_ID, 'version': '2.0.0', 'port': self.port}).encode()

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _send(self, status, data=b'{}', headers=()):
                self.send_response(status)
                for k, v in headers:
                    self.send_header(k, v)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                outer.calls.append(('GET', self.path, dict(self.headers)))
                if self.path == '/api/health':
                    return self._send(200, payload)
                if self.path == '/api/session':
                    return self._send(200, b'{"ok": true}', [('Set-Cookie', 'fi_session=abc; HttpOnly; Path=/')])
                self._send(404)

            def do_POST(self):
                outer.calls.append(('POST', self.path, dict(self.headers)))
                self.rfile.read(int(self.headers.get('Content-Length') or 0))
                if self.path == '/api/server/shutdown':
                    self._send(200, b'{"ok": true}')
                    threading.Thread(target=outer.httpd.shutdown, daemon=True).start()
                    return
                self._send(404)

        self.httpd = http.server.ThreadingHTTPServer(('127.0.0.1', self.port), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()


class DecideTests(unittest.TestCase):
    def test_decide(self):
        self.assertEqual(launcher.decide(None), 'start')
        self.assertEqual(launcher.decide({}), 'busy')
        self.assertEqual(launcher.decide({'app': 'something-else'}), 'busy')
        self.assertEqual(launcher.decide({'app': APP_ID, 'apiVersion': API_VERSION}), 'open')
        self.assertEqual(launcher.decide({'app': APP_ID, 'apiVersion': API_VERSION + 1}), 'open')  # newer: just use it
        self.assertEqual(launcher.decide({'app': APP_ID, 'apiVersion': API_VERSION - 1}), 'replace')
        self.assertEqual(launcher.decide({'app': APP_ID}), 'replace')  # round 1 had no apiVersion
        self.assertEqual(launcher.decide({'app': APP_ID, 'apiVersion': True}), 'replace')

    def test_health_of_closed_port(self):
        self.assertIsNone(launcher.health(free_port(), timeout=0.3))

    def test_mismatch_stops_the_old_server(self):
        with _FakeOldServer() as old:
            info = launcher.health(old.port)
            self.assertEqual(info['app'], APP_ID)
            self.assertEqual(launcher.decide(info), 'replace')
            self.assertTrue(launcher.stop_running(old.port, wait=5))
            shutdown = [c for c in old.calls if c[0] == 'POST' and c[1] == '/api/server/shutdown']
            self.assertEqual(len(shutdown), 1)
            headers = {k.lower(): v for k, v in shutdown[0][2].items()}
            self.assertEqual(headers.get('cookie'), 'fi_session=abc')
            self.assertEqual(headers.get('x-fi-client'), '1')
            self.assertIsNone(launcher.health(old.port, timeout=0.3))

    def test_foreign_program_is_never_replaced(self):
        with _FakeOldServer({'hello': 'world'}) as other:
            self.assertEqual(launcher.decide(launcher.health(other.port)), 'busy')
            out = io.StringIO()
            with redirect_stdout(out):
                from server.__main__ import main
                self.assertEqual(main(['--port', str(other.port)]), 2)
            self.assertIn('다른 프로그램', out.getvalue())
            self.assertFalse(any(c[1] == '/api/server/shutdown' for c in other.calls))


class JobPauseTests(unittest.TestCase):
    def test_pause_blocks_check_until_resume(self):
        job = Job('t', message='일하는 중')
        self.assertTrue(job.pause())
        self.assertTrue(job.paused)
        self.assertEqual(job.to_dict()['message'], '일시정지했어요')
        job.set_progress(0.5, '3/10')  # progress while paused keeps the paused message
        self.assertEqual(job.message, '일시정지했어요')
        released = threading.Event()

        def worker():
            job.check()
            released.set()

        threading.Thread(target=worker, daemon=True).start()
        self.assertFalse(released.wait(0.4))
        self.assertTrue(job.resume())
        self.assertTrue(released.wait(2))
        self.assertFalse(job.paused)
        self.assertEqual(job.message, '3/10')
        self.assertFalse(job.resume())

    def test_cancel_wakes_a_paused_job(self):
        job = Job('t')
        job.pause()
        errors = []

        def worker():
            try:
                job.check()
            except JobCancelled:
                errors.append('cancelled')

        t = threading.Thread(target=worker, daemon=True)
        t.start()
        time.sleep(0.2)
        job.cancel()
        t.join(3)
        self.assertEqual(errors, ['cancelled'])
        job.state = 'cancelled'
        self.assertFalse(job.pause())
        self.assertFalse(job.to_dict()['paused'])


class SecondLaunchTests(ServerTestCase):
    open_workspace = False

    def test_health_reports_api_version(self):
        r = self.api.request('GET', '/api/health', cookie=False)
        data = r.json()
        self.assertEqual(data['apiVersion'], API_VERSION)
        self.assertEqual(self.api.session().json()['apiVersion'], API_VERSION)

    def test_second_launch_only_opens_the_browser(self):
        out = io.StringIO()
        with redirect_stdout(out), patch('webbrowser.open') as browser:
            from server.__main__ import main
            started = time.monotonic()
            self.assertEqual(main(['--port', str(self.port), '--open']), 0)
            self.assertLess(time.monotonic() - started, 5)
        self.assertIn('이미 켜져', out.getvalue())
        browser.assert_called_once_with(f'http://127.0.0.1:{self.port}/')
        self.assertEqual(launcher.health(self.port)['app'], APP_ID)  # still running, untouched

    def test_start_bat_while_running_still_installs_the_shortcut(self):
        out = io.StringIO()
        with redirect_stdout(out), patch('webbrowser.open'), patch.object(launcher, 'install_shortcut_once', return_value=['x.lnk']) as install:
            from server.__main__ import main
            self.assertEqual(main(['--port', str(self.port), '--open', '--install-shortcut']), 0)
        if os.name == 'nt':
            install.assert_called_once_with(self.port)
            self.assertIn('아이콘을 만들었어요', out.getvalue())

    def test_restart_wait_timeout_is_a_failure_not_already_running(self):
        out = io.StringIO()
        with redirect_stdout(out), patch.object(launcher, 'wait_port_free', return_value=False), patch('webbrowser.open') as browser:
            from server.__main__ import main
            self.assertEqual(main(['--port', str(self.port), '--wait-port', '--open']), 2)
        browser.assert_not_called()
        self.assertIn('새로 켜지 못했어요', out.getvalue())

    def test_restart_is_dry_in_tests_and_shortcut_dry(self):
        r = self.api.post('/api/server/restart')
        self.assertEqual(r.status, 200, r.text)
        self.assertEqual(r.json(), {'ok': True, 'dry': True})
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop('FI_SHORTCUT_DIR', None)
            r = self.api.post('/api/server/shortcut')
        if os.name == 'nt':
            self.assertEqual(r.json(), {'created': []})

    def test_recent_has_workspace_ids(self):
        root = os.path.join(self.tmp, '최근 폴더')
        os.makedirs(root, exist_ok=True)
        ws = self.api.open_workspace(root)
        items = self.api.get('/api/workspace/recent').json()
        mine = next(x for x in items if os.path.normcase(x['root']) == os.path.normcase(os.path.realpath(root)))
        self.assertEqual(mine['id'], ws['id'])
        self.assertTrue(mine['exists'])


@unittest.skipUnless(os.name == 'nt', 'Windows shortcuts')
class ShortcutTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='fi-lnk-')
        self.env = patch.dict(os.environ, {'FI_SHORTCUT_DIR': os.path.join(self.tmp, '바탕 화면'), 'FI_DATA_DIR': os.path.join(self.tmp, 'data')})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_icon(self):
        from PIL import Image

        path = launcher.make_icon(Path(self.tmp) / 'app.ico')
        with Image.open(path) as icon:
            self.assertEqual(icon.format, 'ICO')
            self.assertIn((256, 256), icon.info.get('sizes', {(256, 256)}))

    def test_shortcuts_are_created_once(self):
        stamp = Path(self.tmp) / 'shortcut.stamp'
        with patch.object(launcher, 'STAMP', stamp):
            made = launcher.install_shortcut_once()
            self.assertEqual(len(made), 2)
            for p in made:
                self.assertTrue(p.endswith('사진영상정리기.lnk'), p)
                self.assertTrue(os.path.isfile(p) and os.path.getsize(p) > 0, p)
            self.assertTrue(stamp.exists())
            self.assertIsNone(launcher.install_shortcut_once())  # second start.bat run: nothing
        self.assertTrue(os.path.isfile(os.path.join(self.tmp, 'data', 'app.ico')))
        program, args = launcher.shortcut_target()
        self.assertIn('--resume', args)
        self.assertNotIn('--port', args)
        self.assertTrue(launcher.shortcut_target(8790)[1].endswith('--port 8790'), 'a non-default port is kept')
        self.assertTrue(program.lower().endswith(('pythonw.exe', 'python.exe')))


class RestartProcessTests(unittest.TestCase):
    """spawn_server() starts an independent server that waits for the port and reopens the workspace."""

    def test_spawned_server_waits_for_the_port_then_serves(self):
        tmp = tempfile.mkdtemp(prefix='fi-restart-')
        port = free_port()
        root = os.path.join(tmp, '작업')
        os.makedirs(root)
        try:
            with _FakeOldServer() as old, patch.dict(os.environ, {'FI_DATA_DIR': os.path.join(tmp, 'data'), 'FI_DRY_SHELL': '1'}):
                old_port = old.port
                proc = launcher.spawn_server(port=old_port, workspace=root, wait_port=True)
                time.sleep(1.0)
                # Still the old server: the new process waits instead of hopping to another port
                self.assertNotIn('apiVersion', launcher.health(old_port) or {})
                self.assertTrue(launcher.stop_running(old_port, wait=5))
            deadline = time.monotonic() + 30
            info = None
            while time.monotonic() < deadline:
                info = launcher.health(old_port, timeout=0.5)
                if info and info.get('apiVersion') == API_VERSION:
                    break
                time.sleep(0.2)
            self.assertEqual((info or {}).get('apiVersion'), API_VERSION, info)
            self.assertTrue(launcher.stop_running(old_port, wait=15))
            proc.wait(timeout=15)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
