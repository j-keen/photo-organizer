"""Server extensions and foundation units: shutdown, quiet probes, recycle flag, open-with safety, path rules,
ffmpeg probe parsing, workspace tokens surviving a restart."""
from __future__ import annotations

import os
import shutil
import tempfile
import time
import unittest

from server import ffmpeg, paths
from server.errors import ApiError
from server.tests.helpers import Client, RunningServer, ServerTestCase, make_image
from server.workspaces import WorkspaceRegistry, token_for


class ExtensionTests(ServerTestCase):
    def test_session_reports_app_root_and_capabilities(self):
        data = self.api.session().json()
        self.assertTrue(os.path.isdir(data['appRoot']))
        self.assertTrue(os.path.isfile(os.path.join(data['appRoot'], '사진영상정리기.html')))
        for key in ('ffmpeg', 'faiss', 'heif', 'avif', 'x264', 'pick', 'reveal'):
            self.assertIn(key, data['capabilities'])
        self.assertEqual(data['workspace']['root'], os.path.realpath(self.root))

    def test_entry_html_announces_the_server(self):
        r = self.api.request('GET', '/')
        self.assertEqual(r.status, 200)
        self.assertIn(f'data-port="{self.port}"', r.text)
        self.assertEqual(r.headers['cache-control'], 'no-cache')

    def test_probe_soft_answers_204_for_missing_files(self):
        r = self.api.get('/api/media/probe', path='nope.jpg', soft='1')
        self.assertEqual(r.status, 204)
        self.assertEqual(r.headers.get('x-fi-error'), 'ENOENT')
        self.assertError(self.api.get('/api/media/probe', path='nope.jpg'), 404, 'ENOENT')
        make_image(self.path('ok.jpg'), camera=('Canon', 'Canon EOS R5'), exif_datetime='2024:05:01 09:30:00')
        info = self.api.get('/api/media/probe', path='ok.jpg', soft='1').json()
        self.assertEqual(info['camera'], 'Canon EOS R5')
        self.assertIsNotNone(info['taken'])

    def test_remove_with_recycle_flag_still_removes_in_tests(self):
        self.write('.fluid-organizer/trash/b1/a.jpg', b'x')
        r = self.api.post('/api/fs/remove', {'path': '.fluid-organizer/trash/b1/a.jpg', 'recycle': True})
        self.assertEqual(r.status, 200, r.text)
        self.assertEqual(r.json(), {'ok': True, 'recycled': False})  # dry shell: never touches the real Recycle Bin
        self.assertFalse(os.path.exists(self.path('.fluid-organizer/trash/b1/a.jpg')))
        self.assertError(self.api.post('/api/fs/remove', {'path': 'gone.jpg', 'recycle': True}), 404, 'ENOENT')

    def test_open_with_default_app_only_for_media(self):
        self.write('run.bat', b'@echo hi')
        self.assertError(self.api.post('/api/fs/open', {'path': 'run.bat'}), 400, 'EINVAL')
        make_image(self.path('photo.png'))
        r = self.api.post('/api/fs/open', {'path': 'photo.png'})
        self.assertEqual(r.status, 200, r.text)
        self.assertTrue(r.json()['command'])

    def test_user_files_are_served_in_a_script_less_sandbox(self):
        self.write('evil.html', '<script>fetch("/api/fs/remove")</script>')
        r = self.api.get('/api/fs/file', path='evil.html')
        self.assertEqual(r.status, 200)
        csp = r.headers.get('content-security-policy', '')
        self.assertIn('sandbox', csp)
        self.assertIn("default-src 'none'", csp)
        self.assertIn('nosniff', r.headers.get('x-content-type-options', ''))
        # The app's own files are normal documents
        self.assertNotIn('sandbox', self.api.request('GET', '/css/tokens.css').headers.get('content-security-policy', ''))

    def test_files_used_by_an_editing_job_are_reported_busy(self):
        from server.tests.helpers import make_video

        make_video(self.path('busy.mp4'), seconds=12, size=(640, 480), extra=['-preset', 'ultrafast'])
        job = self.api.post('/api/video/trim', {'path': 'busy.mp4', 'start': 0, 'end': 11.5, 'mode': 'accurate'}).json()
        try:
            deadline = time.time() + 10
            while not ffmpeg.busy(self.path('busy.mp4')) and time.time() < deadline:
                time.sleep(0.02)
            self.assertTrue(ffmpeg.busy(self.path('busy.mp4')))
            self.assertError(self.api.post('/api/fs/move', {'src': 'busy.mp4', 'destDir': 'sub', 'name': 'busy.mp4'}), 423, 'EBUSY')
            self.assertError(self.api.post('/api/fs/remove', {'path': 'busy.mp4'}), 423, 'EBUSY')
            self.assertTrue(os.path.exists(self.path('busy.mp4')))
        finally:
            self.api.post(f"/api/jobs/{job['id']}/cancel")
            self.api.wait_job(job, timeout=20)
        r = self.api.post('/api/fs/move', {'src': 'busy.mp4', 'destDir': 'sub', 'name': 'busy.mp4'})
        self.assertEqual(r.status, 200, r.text)

    def test_shutdown_needs_session_and_client_header(self):
        tmp = tempfile.mkdtemp(prefix='fi-stop-')
        srv = RunningServer(os.path.join(tmp, 'data')).start()
        try:
            api = Client(srv.port)
            self.assertError(api.request('POST', '/api/server/shutdown', json_body={}), 401, 'ESESSION')
            api.session()
            self.assertError(api.request('POST', '/api/server/shutdown', json_body={}, client_header=False), 403, 'EPERM')
            r = api.post('/api/server/shutdown', {})
            self.assertEqual(r.json(), {'ok': True})
            deadline = time.time() + 10
            while srv.thread.is_alive() and time.time() < deadline:
                time.sleep(0.05)
            self.assertFalse(srv.thread.is_alive(), 'server should stop after /api/server/shutdown')
        finally:
            srv.stop()
            shutil.rmtree(tmp, ignore_errors=True)


class PathRuleTests(unittest.TestCase):
    def test_accepts_normal_paths(self):
        self.assertEqual(paths.clean_rel(''), '')
        self.assertEqual(paths.clean_rel('a/b c/사진 1.jpg'), 'a/b c/사진 1.jpg')
        self.assertEqual(paths.clean_rel('a/b/'), 'a/b')
        self.assertEqual(paths.clean_rel('.fluid-organizer/catalog.json'), '.fluid-organizer/catalog.json')

    def test_rejects_escapes_and_ambiguous_names(self):
        bad = ['../x', 'a/../../x', '/abs', 'C:/x', 'a\\b', 'a//b', 'a/./b', 'x\x00y']
        if os.name == 'nt':
            bad += ['x:stream', 'CON', 'nul.txt', 'com1', 'a/LPT9.log', 'dot.', 'space ', 'a*b', 'a?b']
        for rel in bad:
            with self.subTest(rel=rel), self.assertRaises(ApiError):
                paths.clean_rel(rel)

    def test_is_inside(self):
        root = os.path.realpath(tempfile.gettempdir())
        self.assertTrue(paths.is_inside(os.path.join(root, 'a', 'b'), root))
        self.assertTrue(paths.is_inside(root, root))
        self.assertFalse(paths.is_inside(root + 'x', root))
        self.assertFalse(paths.is_inside(os.path.dirname(root), root))


class ProbeParsingTests(unittest.TestCase):
    SAMPLE = """Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'IMG_0001.MOV':
  Metadata:
    major_brand     : qt
    creation_time   : 2024-05-01T12:34:56.000000Z
    com.apple.quicktime.make: Apple
    com.apple.quicktime.model: iPhone 15 Pro
  Duration: 00:01:02.50, start: 0.000000, bitrate: 9876 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p(tv, bt709), 1920x1080, 9000 kb/s, 29.97 fps, 29.97 tbr, 600 tbn (default)
      Side data:
        displaymatrix: rotation of -90.00 degrees
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 256 kb/s (default)
"""

    def test_parses_phone_video(self):
        info = ffmpeg.parse_probe(self.SAMPLE)
        self.assertEqual(info['format'], 'mov')
        self.assertAlmostEqual(info['duration'], 62.5)
        self.assertEqual(info['bitrate'], 9876000)
        self.assertEqual((info['vcodec'], info['acodec']), ('hevc', 'aac'))
        self.assertEqual(info['rotation'], 90)
        self.assertEqual((info['width'], info['height']), (1080, 1920))
        self.assertEqual((info['codedWidth'], info['codedHeight']), (1920, 1080))
        self.assertAlmostEqual(info['fps'], 29.97)
        self.assertEqual(info['camera'], 'Apple iPhone 15 Pro')
        self.assertEqual(info['taken'], 1714566896000)
        self.assertTrue(info['hasAudio'])
        self.assertEqual(info['sampleRate'], 44100)

    def test_audio_only_and_cover_art(self):
        text = """Input #0, mp3, from 'a.mp3':
  Duration: 00:00:03.00, start: 0.0, bitrate: 128 kb/s
  Stream #0:0: Audio: mp3 (mp3float), 44100 Hz, stereo, fltp, 128 kb/s
  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc), 500x500, 90k tbr, 90k tbn (attached pic)
"""
        info = ffmpeg.parse_probe(text)
        self.assertTrue(info['hasAudio'])
        self.assertEqual(info['vcodec'], 'mjpeg')  # only an attached picture: still reported, callers check hasVideo + codec


class WorkspaceSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='fi-ws-')

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_concurrent_first_opens_agree_on_one_id(self):
        import threading

        root = os.path.join(self.tmp, 'new')
        os.makedirs(root)
        registry = WorkspaceRegistry(os.path.join(self.tmp, 'data'))
        ids = []
        threads = [threading.Thread(target=lambda: ids.append(registry.open(root).id)) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(set(ids)), 1)

    @unittest.skipUnless(os.name == 'nt', 'junctions are Windows-only')
    def test_data_folder_link_pointing_outside_is_refused(self):
        import subprocess

        root = os.path.join(self.tmp, 'ws')
        outside = os.path.join(self.tmp, 'elsewhere')
        os.makedirs(root)
        os.makedirs(outside)
        r = subprocess.run(['cmd', '/c', 'mklink', '/J', os.path.join(root, '.fluid-organizer'), outside], capture_output=True)
        if r.returncode != 0:
            self.skipTest('mklink /J failed')
        with self.assertRaises(ApiError) as ctx:
            WorkspaceRegistry(os.path.join(self.tmp, 'data')).open(root)
        self.assertEqual(ctx.exception.code, 'EPERM')
        self.assertFalse(os.path.exists(os.path.join(outside, 'workspace.json')))


class WorkspaceRestartTests(unittest.TestCase):
    def test_token_is_stable_and_survives_a_restart(self):
        tmp = tempfile.mkdtemp(prefix='fi-ws-')
        try:
            root = os.path.join(tmp, '사진')
            os.makedirs(root)
            first = WorkspaceRegistry(os.path.join(tmp, 'data'))
            ws = first.open(root)
            self.assertEqual(ws.token, token_for(os.path.realpath(root)))
            # A new registry (server restart) can resolve the old token through the recent list
            second = WorkspaceRegistry(os.path.join(tmp, 'data'))
            again = second.get(ws.token)
            self.assertEqual(again.root, ws.root)
            self.assertEqual(again.id, ws.id)
            with self.assertRaises(ApiError) as ctx:
                second.get('0123456789abcdef')
            self.assertEqual(ctx.exception.code, 'ENOWS')
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
