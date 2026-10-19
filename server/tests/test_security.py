"""HTTP security boundaries, path validation and junction containment."""
import os
import subprocess

from server import ffmpeg
from server.tests.helpers import ServerTestCase


class SecurityTests(ServerTestCase):
    def test_host_health_and_preflight(self):
        r = self.api.request('GET', '/api/health', host=f'evil.com:{self.port}', cookie=False)
        self.assertError(r, 403, 'EPERM')
        r = self.api.request('GET', '/api/health', host=f'localhost:{self.port}', cookie=False)
        self.assertEqual(r.status, 200)
        self.assertEqual(r.headers['access-control-allow-origin'], '*')
        r = self.api.request('OPTIONS', '/api/health', cookie=False)
        self.assertEqual(r.status, 204)
        self.assertEqual(r.headers['access-control-allow-origin'], '*')
        r = self.api.request('OPTIONS', '/api/fs/list')
        self.assertError(r, 403, 'EPERM')
        self.assertNotIn('access-control-allow-origin', r.headers)

    def test_session_and_mutations(self):
        for site in ('cross-site', 'same-site', None):
            headers = {} if site is None else {'Sec-Fetch-Site': site}
            r = self.api.request('GET', '/api/session', headers=headers, cookie=False)
            self.assertError(r, 403, 'EPERM')
            self.assertNotIn('set-cookie', r.headers)
        for site in ('same-origin', 'none'):
            r = self.api.session(site)
            self.assertEqual(r.status, 200)
            for attribute in ('HttpOnly', 'SameSite=Strict', 'Path=/'):
                self.assertIn(attribute, r.headers['set-cookie'])
        self.assertError(self.api.request('GET', '/api/fs/list', cookie=False), 401, 'ESESSION')
        self.assertError(self.api.request('GET', '/api/fs/list', headers={'Cookie': 'fi_session=wrong'}), 401, 'ESESSION')
        self.assertError(self.api.post('/api/fs/mkdir', {'path': 'blocked'}, client_header=False), 403, 'EPERM')
        self.assertError(self.api.post('/api/fs/mkdir', {'path': 'blocked'}, headers={'Origin': 'https://evil.com'}), 403, 'EPERM')

    def test_invalid_paths(self):
        invalid = ['../x', 'a/../../x', '/abs', 'C:/Windows/win.ini', 'C:\\Windows', 'a\\..\\b', 'a/./b', 'a//b']
        if os.name == 'nt':
            invalid += ['x:stream', 'CON', 'nul.txt', 'trailing.']
        for path in invalid:
            with self.subTest(path=path):
                for endpoint in ('stat', 'exists', 'file'):
                    r = self.api.get('/api/fs/' + endpoint, path=path)
                    self.assertIn(r.status, (400, 403), r.text)
                    self.assertIn(r.json()['error']['code'], ('EINVAL', 'EPERM'))

    def _link(self, link, target):
        if os.name == 'nt':
            result = subprocess.run(['cmd', '/c', 'mklink', '/J', link, target],
                                    capture_output=True, **ffmpeg.popen_kwargs())
            if result.returncode:
                self.skipTest('Directory junction creation unavailable')
        else:
            try:
                os.symlink(target, link, target_is_directory=True)
            except OSError:
                self.skipTest('Directory symlink creation unavailable')

    def test_junction_boundaries(self):
        outside = os.path.join(self.tmp, 'outside')
        os.makedirs(outside, exist_ok=True)
        with open(os.path.join(outside, 'secret.txt'), 'wb') as stream:
            stream.write(b'secret')
        self.write('inside-target/안쪽.txt', b'inside')
        links = []
        try:
            self._link(self.path('outside-link'), outside)
            links.append(self.path('outside-link'))
            self._link(self.path('inside-link'), self.path('inside-target'))
            links.append(self.path('inside-link'))
            names = {e['name'] for e in self.api.get('/api/fs/list').json()['entries']}
            self.assertNotIn('outside-link', names)
            self.assertIn('inside-link', names)
            for endpoint in ('stat', 'file'):
                self.assertError(self.api.get('/api/fs/' + endpoint, path='outside-link/secret.txt'), 403, 'EPERM')
            self.assertEqual(self.api.get('/api/fs/file', path='inside-link/안쪽.txt').body, b'inside')
            self.assertEqual(self.api.get('/api/fs/stat', path='inside-link').json()['kind'], 'dir')
        finally:
            for link in reversed(links):
                if os.name == 'nt':
                    os.rmdir(link)
                else:
                    os.unlink(link)

    def test_static_and_headers(self):
        r = self.api.get('/')
        self.assertEqual(r.status, 200)
        self.assertIn('<meta name="fi-server"', r.text)
        self.assertEqual(r.headers['x-content-type-options'], 'nosniff')
        self.assertEqual(r.headers['x-frame-options'], 'DENY')
        for path in ('/server/app.py', '/.git/config', '/docs/server-api.md'):
            self.assertError(self.api.get(path), 404, 'ENOENT')
