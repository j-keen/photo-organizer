"""Open With allow-list, persistence and shell argument contracts."""
import os
from unittest.mock import patch

from server import apps, routes_fs
from server.tests.helpers import ServerTestCase


class OpenWithTests(ServerTestCase):
    def test_registration_and_launch(self):
        target = self.write('외부 열기/영상.avi')
        exe = self.write('플레이어/player.exe')
        r = self.api.post('/api/apps/players', {'exe': exe})
        self.assertEqual(r.status, 200, r.text)
        player = r.json()
        self.assertIn(player, self.api.get('/api/apps/players').json())
        self.assertIn(player, apps.list_players(self.srv.app.state.data_dir))
        with patch.object(routes_fs.subprocess, 'Popen') as launch:
            r = self.api.post('/api/fs/open-with', {'path': '외부 열기/영상.avi', 'app': player['exe']})
            self.assertEqual(r.status, 200, r.text)
            self.assertEqual(r.json()['command'], [os.path.realpath(exe), target])
            launch.assert_not_called()
            self.srv.settings.dry_shell = False
            try:
                r = self.api.post('/api/fs/open-with', {'path': '외부 열기/영상.avi', 'app': player['exe']})
                self.assertEqual(r.status, 200, r.text)
                self.assertEqual(launch.call_args.args[0], [os.path.realpath(exe), target])
            finally:
                self.srv.settings.dry_shell = True
        unregistered = self.write('플레이어/other.exe')
        self.assertError(self.api.post('/api/fs/open-with', {'path': '외부 열기/영상.avi', 'app': unregistered}), 403, 'EPERM')
        self.assertError(self.api.post('/api/apps/players', {'exe': 'relative.exe'}), 400, 'EINVAL')
        self.assertError(self.api.post('/api/apps/players', {'exe': target}), 400, 'EINVAL')
        self.write('script.cmd')
        self.assertError(self.api.post('/api/fs/open-with', {'path': 'script.cmd'}), 400, 'EINVAL')
        self.assertError(self.api.post('/api/fs/open-with', {'path': '외부 열기'}), 400, 'EINVAL')
        self.assertError(self.api.post('/api/fs/open-with', {'path': 'missing.avi'}), 404, 'ENOENT')

    def test_windows_chooser(self):
        if os.name != 'nt':
            self.skipTest('Windows chooser')
        target = self.write('공백 있는 영상.avi')
        with patch.object(routes_fs.subprocess, 'Popen') as launch:
            r = self.api.post('/api/fs/open-with', {'path': '공백 있는 영상.avi'})
            self.assertEqual(r.status, 200, r.text)
            self.assertEqual(r.json()['command'][1:], ['shell32.dll,OpenAs_RunDLL', target])
            launch.assert_not_called()
        session = self.api.session().json()
        self.assertTrue(session['capabilities']['open-with'])
        self.assertIn('open-with', session['supports'])
