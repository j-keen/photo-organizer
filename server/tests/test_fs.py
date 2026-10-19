"""File API contracts, atomic uploads and shared read handles."""
import http.client
import os
import stat
import urllib.parse

from server import fsutil
from server.tests.helpers import ServerTestCase


class FileSystemTests(ServerTestCase):
    def test_list_stat_exists(self):
        self.write('목록/사진.jpg', b'0123456789')
        self.write('목록/.숨김', b'hidden')
        os.makedirs(self.path('목록/폴더'), exist_ok=True)
        r = self.api.get('/api/fs/list', path='목록')
        self.assertEqual(r.status, 200, r.text)
        entries = {e['name']: e for e in r.json()['entries']}
        self.assertEqual(set(entries), {'사진.jpg', '.숨김', '폴더'})
        self.assertEqual(entries['사진.jpg']['size'], 10)
        self.assertEqual(entries['폴더']['kind'], 'dir')
        self.assertNotIn('size', entries['폴더'])
        for entry in entries.values():
            self.assertIsInstance(entry['mtime'], int)
        r = self.api.get('/api/fs/stat', path='목록/사진.jpg')
        self.assertEqual(r.json(), {k: v for k, v in entries['사진.jpg'].items() if k != 'name'})
        for path, expected in [('목록/사진.jpg', {'exists': True, 'kind': 'file'}),
                               ('목록/폴더', {'exists': True, 'kind': 'dir'}),
                               ('목록/없음', {'exists': False})]:
            r = self.api.get('/api/fs/exists', path=path)
            self.assertEqual(r.status, 200)
            self.assertEqual(r.json(), expected)
        self.assertError(self.api.get('/api/fs/list', path='목록/사진.jpg'), 400, 'EINVAL')
        self.assertError(self.api.get('/api/fs/list', path='없는목록'), 404, 'ENOENT')

    def test_file_http(self):
        self.write('응답/사진.jpg', b'0123456789')
        self.write('응답/영상.mp4', b'mp4')
        r = self.api.get('/api/fs/file', path='응답/사진.jpg')
        self.assertEqual(r.status, 200)
        self.assertEqual(r.body, b'0123456789')
        self.assertEqual(r.headers['content-type'], 'image/jpeg')
        self.assertEqual(r.headers['cache-control'], 'no-cache')
        self.assertEqual(r.headers['x-fi-size'], '10')
        self.assertTrue(r.headers['x-fi-mtime'].isdigit())
        conditional = self.api.request('GET', '/api/fs/file', query={'path': '응답/사진.jpg'}, headers={'If-None-Match': r.headers['etag']})
        self.assertEqual(conditional.status, 304)
        self.assertEqual(conditional.body, b'')
        for value, status_code, body, content_range in [
            ('bytes=2-5', 206, b'2345', 'bytes 2-5/10'),
            ('bytes=-3', 206, b'789', 'bytes 7-9/10'),
            ('bytes=99-100', 416, b'', 'bytes */10'),
            ('bytes=5-2', 416, b'', 'bytes */10')]:
            ranged = self.api.request('GET', '/api/fs/file', query={'path': '응답/사진.jpg'}, headers={'Range': value})
            self.assertEqual(ranged.status, status_code)
            self.assertEqual(ranged.body, body)
            self.assertEqual(ranged.headers['content-range'], content_range)
        head = self.api.request('HEAD', '/api/fs/file', query={'path': '응답/사진.jpg'})
        self.assertEqual(head.status, 200)
        self.assertEqual(head.headers['content-length'], '10')
        self.assertEqual(head.body, b'')
        self.assertEqual(self.api.get('/api/fs/file', path='응답/영상.mp4').headers['content-type'], 'video/mp4')
        for method in ('GET', 'HEAD'):
            missing = self.api.request(method, '/api/fs/file', query={'path': '응답/없음', 'missingOk': 1})
            self.assertEqual(missing.status, 204)
            self.assertEqual(missing.headers['x-fi-missing'], '1')
            self.assertEqual(missing.body, b'')
        self.assertError(self.api.get('/api/fs/file', path='응답/없음'), 404, 'ENOENT')

    def test_put_and_mkdir(self):
        rel = '업로드/깊은/파일.bin'
        for data in (b'old', b'new data', b'abcdefgh' * (5 * 1024 * 1024 // 8)):
            r = self.api.put('/api/fs/file', data, path=rel)
            self.assertEqual(r.status, 200, r.text)
            self.assertEqual(r.json()['size'], len(data))
            self.assertIsInstance(r.json()['mtime'], int)
            self.assertTrue(r.json()['ok'])
            with fsutil.open_shared(self.path(rel)) as stream:
                self.assertEqual(stream.read(), data)
            self.assertFalse(any(n.startswith(fsutil.TMP_PREFIX) for n in os.listdir(os.path.dirname(self.path(rel)))))
        self.assertError(self.api.put('/api/fs/file', b'x', path='업로드'), 400, 'EINVAL')
        for _ in range(2):
            self.assertEqual(self.api.post('/api/fs/mkdir', {'path': '새폴더/안쪽'}).json(), {'ok': True})
        self.assertError(self.api.post('/api/fs/mkdir', {'path': rel}), 409, 'EEXIST')

    def test_move_and_copy(self):
        original = self.write('이동/원본.txt', b'content')
        stamp = 1600000000123000000
        os.utime(original, ns=(stamp, stamp))
        expected = fsutil.mtime_ms(os.stat(original))
        r = self.api.post('/api/fs/move', {'src': '이동/원본.txt', 'destDir': '이동/새폴더', 'name': 'a.txt'})
        self.assertEqual(r.json(), {'ok': True, 'path': '이동/새폴더/a.txt'})
        self.assertFalse(os.path.exists(original))
        self.assertEqual(fsutil.mtime_ms(os.stat(self.path(r.json()['path']))), expected)
        r = self.api.post('/api/fs/move', {'src': '이동/새폴더/a.txt', 'destDir': '이동/새폴더', 'name': 'A.txt'})
        self.assertEqual(r.json(), {'ok': True, 'path': '이동/새폴더/A.txt'})
        self.assertIn('A.txt', os.listdir(self.path('이동/새폴더')))
        self.write('이동/충돌.txt')
        self.assertError(self.api.post('/api/fs/move', {'src': '이동/새폴더/A.txt', 'destDir': '이동', 'name': '충돌.txt'}), 409, 'EEXIST')
        for endpoint in ('move', 'copy'):
            self.assertError(self.api.post('/api/fs/' + endpoint, {'src': '이동/새폴더', 'destDir': '이동/새폴더/자식', 'name': '안쪽'}), 400, 'EINVAL')
        self.assertError(self.api.post('/api/fs/move', {'src': '', 'destDir': '', 'name': 'root'}), 403, 'EPERM')
        for src, name in [('이동/새폴더/A.txt', '복사.txt'), ('이동/새폴더', '트리')]:
            r = self.api.post('/api/fs/copy', {'src': src, 'destDir': '복사결과', 'name': name})
            self.assertEqual(r.json(), {'ok': True, 'path': '복사결과/' + name})
            copied = r.json()['path'] + ('/A.txt' if name == '트리' else '')
            self.assertEqual(fsutil.mtime_ms(os.stat(self.path(copied))), expected)
            with fsutil.open_shared(self.path(copied)) as stream:
                self.assertEqual(stream.read(), b'content')
            self.assertError(self.api.post('/api/fs/copy', {'src': src, 'destDir': '복사결과', 'name': name}), 409, 'EEXIST')

    def test_remove_and_shell(self):
        self.write('삭제/읽기전용.txt')
        os.chmod(self.path('삭제/읽기전용.txt'), stat.S_IREAD)
        self.write('삭제파일.txt')
        for path in ('삭제파일.txt', '삭제'):
            self.assertTrue(self.api.post('/api/fs/remove', {'path': path}).json()['ok'])
            self.assertFalse(os.path.exists(self.path(path)))
        self.assertError(self.api.post('/api/fs/remove', {'path': ''}), 403, 'EPERM')
        self.write('열기/사진.jpg')
        for endpoint in ('reveal', 'open'):
            r = self.api.post('/api/fs/' + endpoint, {'path': '열기/사진.jpg'})
            self.assertEqual(r.status, 200, r.text)
            self.assertTrue(r.json()['ok'])
            command = r.json()['command']
            self.assertEqual(command[-1], self.path('열기/사진.jpg') if os.name == 'nt' or endpoint == 'open' else command[-1])
            if os.name == 'nt':
                self.assertEqual(command[0], 'explorer')
                if endpoint == 'reveal':
                    self.assertEqual(command[1], '/select,')
        self.assertError(self.api.post('/api/fs/open', {'path': '열기'}), 400, 'EINVAL')
        r = self.api.post('/api/fs/reveal', {'path': ''})
        self.assertTrue(r.json()['ok'])
        if os.name == 'nt':
            self.assertEqual(r.json()['command'], ['explorer', self.root])

    def test_move_during_download(self):
        data = b'0123456789abcdef' * (1024 * 1024)
        self.write('스트림/원본.bin', data)
        query = urllib.parse.urlencode({'path': '스트림/원본.bin', 'ws': self.api.ws})
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        try:
            conn.request('GET', '/api/fs/file?' + query, headers={'Cookie': self.api.cookie})
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            first = response.read(1024)
            self.assertEqual(first, data[:1024])
            r = self.api.post('/api/fs/move', {'src': '스트림/원본.bin', 'destDir': '스트림', 'name': '이동.bin'})
            self.assertEqual(r.json(), {'ok': True, 'path': '스트림/이동.bin'})
            self.assertEqual(first + response.read(), data)
        finally:
            conn.close()
