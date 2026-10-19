"""Quarantine safety and recovery tests; no media decoders are required."""
from __future__ import annotations

import errno
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from server import fsutil, quarantine as q
from server.external import ExternalRoots, QUARANTINE_DIR
from server.workspaces import Workspace
from server.tests.helpers import ServerTestCase


class FakeRegistry:
    def recent_roots(self):
        return []


class QuarantineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.data = self.base / 'data'
        self.ext = self.base / '외부 폴더'
        self.work = self.base / '작업'
        for directory in (self.data, self.ext, self.work):
            directory.mkdir()
        self.external = ExternalRoots(self.data, FakeRegistry())
        self.external.remember(str(self.ext))
        self.ws = Workspace(token='t', id='w', name='작업', root=os.path.realpath(self.work))
        self.qdir = self.ext / QUARANTINE_DIR
        self.logfile = self.qdir / '정리기록.json'
        self.release = patch.object(q.ffmpeg, 'release')
        self.release.start()
        self.addCleanup(self.release.stop)

    def tearDown(self):
        for root, dirs, files in os.walk(self.base):
            for name in files + dirs:
                try:
                    os.chmod(os.path.join(root, name), stat.S_IREAD | stat.S_IWRITE | stat.S_IEXEC)
                except OSError:
                    pass
        self.tmp.cleanup()

    def write(self, name, content=b'original', root=None):
        path = (root or self.ext) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return str(path)

    def move(self, *refs, **kwargs):
        return q.quarantine(self.external, self.ws, self.data, list(refs), **kwargs)

    def log(self):
        return json.loads(self.logfile.read_text(encoding='utf-8'))

    def assert_no_tmp(self):
        self.assertFalse([p for p in self.qdir.iterdir() if p.name.startswith(fsutil.TMP_PREFIX)])

    def test_round_trip(self):
        refs = [self.write('a.mp4', b'a'), self.write('b.mp4', b'b')]
        result = self.move(*refs, keep=None, reason='중복')
        self.assertEqual(result['failed'], [])
        moved = result['moved']
        self.assertEqual([Path(x['to']).name for x in moved], ['001_a.mp4', '002_b.mp4'])
        self.assertTrue(all(not os.path.exists(p) for p in refs))
        self.assertEqual([x['state'] for x in self.log()['items']], ['moved', 'moved'])
        index = json.loads((self.data / 'quarantine.json').read_text(encoding='utf-8'))
        self.assertEqual(set(index), {x['id'] for x in moved})
        self.assertEqual(len(q.list_items(self.external, self.data)['items']), 2)
        result = q.restore(self.external, self.data, [x['id'] for x in moved])
        self.assertEqual(result['failed'], [])
        self.assertEqual([Path(p).read_bytes() for p in refs], [b'a', b'b'])
        self.assertEqual([x['state'] for x in self.log()['items']], ['restored', 'restored'])
        self.assertEqual(q.list_items(self.external, self.data), {'items': []})
        again = q.restore(self.external, self.data, [moved[0]['id']])
        self.assertEqual(again['failed'][0]['code'], 'EINVAL')

    def test_numbering(self):
        self.qdir.mkdir()
        (self.qdir / '007_x.mp4').write_bytes(b'x')
        result = self.move(self.write('a.mp4'))
        self.assertEqual(Path(result['moved'][0]['to']).name, '008_a.mp4')
        (self.qdir / '1000_z.mp4').write_bytes(b'z')
        result = self.move(self.write('b.mp4'))
        self.assertEqual(Path(result['moved'][0]['to']).name, '1001_b.mp4')

    def test_restore_collisions(self):
        original = self.write('a.mp4')
        for suffix in ('복원', '복원 2'):
            moved = self.move(original)['moved'][0]
            self.write('a.mp4', b'new')
            result = q.restore(self.external, self.data, [moved['id']])
            self.assertEqual(result['failed'], [])
            self.assertEqual(Path(result['restored'][0]['path']).name, f'a ({suffix}).mp4')
            self.assertEqual(Path(original).read_bytes(), b'new')
            if suffix == '복원':
                self.assertEqual(Path(result['restored'][0]['path']).read_bytes(), b'original')

    def test_readonly(self):
        src = self.write('a.mp4')
        os.chmod(src, stat.S_IREAD)
        moved = self.move(src)['moved'][0]
        self.assertFalse(os.stat(moved['to']).st_mode & stat.S_IWRITE)
        result = q.restore(self.external, self.data, [moved['id']])
        self.assertEqual(result['failed'], [])
        self.assertEqual(Path(src).read_bytes(), b'original')
        self.assertFalse(os.stat(src).st_mode & stat.S_IWRITE)

    def test_interrupted_move_and_batch_continues(self):
        a, b = self.write('a.mp4'), self.write('b.mp4')
        real = q._rename_new
        def rename(src, dest):
            if src == a:
                raise OSError(errno.EIO, 'boom')
            return real(src, dest)
        with patch.object(q, '_rename_new', side_effect=rename):
            result = self.move(a, b)
        self.assertEqual(result['failed'][0]['code'], 'ESERVER')
        self.assertEqual(len(result['moved']), 1)
        self.assertEqual(Path(a).read_bytes(), b'original')
        self.assertTrue(all(x['state'] != 'moving' for x in self.log()['items']))
        self.assert_no_tmp()

    def seed_crash(self, ident, original_exists):
        self.qdir.mkdir(exist_ok=True)
        src = str(self.ext / f'{ident}.mp4')
        dest = str(self.qdir / f'001_{ident}.mp4')
        Path(src if original_exists else dest).write_bytes(b'recover')
        return {'id': ident, 'path': src, 'to': dest, 'size': 7, 'mtime': 1,
                'at': 1, 'reason': '', 'keep': None, 'state': 'moving'}

    def test_crash_repair(self):
        moved = self.seed_crash('crash', False)
        untouched = self.seed_crash('untouched', True)
        q._write_json(str(self.logfile), {'version': 1, 'items': [moved, untouched]})
        listed = q.list_items(self.external, self.data)['items']
        self.assertEqual([x['id'] for x in listed], ['crash'])
        self.assertEqual([x['state'] for x in self.log()['items']], ['moved'])
        result = q.restore(self.external, self.data, ['crash'])
        self.assertEqual(result['failed'], [])
        self.assertEqual(Path(moved['path']).read_bytes(), b'recover')
        self.assertTrue(Path(untouched['path']).exists())

    def test_cross_volume(self):
        src = self.write('a.mp4', b'cross volume data')
        with patch.object(q, '_rename_new', side_effect=OSError(errno.EXDEV, 'cross')):
            result = self.move(src)
        self.assertEqual(result['failed'], [])
        self.assertEqual(Path(result['moved'][0]['to']).read_bytes(), b'cross volume data')
        self.assertFalse(Path(src).exists())
        self.assert_no_tmp()

    def test_hash_mismatch(self):
        src = self.write('a.mp4')
        with patch.object(q, '_rename_new', side_effect=OSError(errno.EXDEV, 'cross')):
            with patch.object(q, '_full_hash', side_effect=[b'a', b'b']):
                result = self.move(src)
        self.assertEqual(result['failed'][0]['code'], 'ESERVER')
        self.assertEqual(Path(src).read_bytes(), b'original')
        self.assertEqual(self.log()['items'], [])
        self.assert_no_tmp()
        self.assertEqual(list(self.qdir.glob('*_a.mp4')), [])

    def test_validation(self):
        a, b = self.write('a.mp4'), self.write('b.mp4')
        result = self.move(a, b, keep=str(self.ext / 'absent.mp4'))
        self.assertEqual([x['code'] for x in result['failed']], ['ENOENT', 'ENOENT'])
        self.assertTrue(Path(a).exists() and Path(b).exists())
        self.assertEqual(self.move(a, keep=a)['failed'][0]['code'], 'EINVAL')
        workspace_file = self.write('workspace.mp4', root=self.work)
        self.external.remember(str(self.work))
        outside = self.write('outside.mp4', root=self.base)
        directory = self.ext / 'directory'
        directory.mkdir()
        cases = [(workspace_file, 'EINVAL'), (outside, 'EPERM'), ('relative.mp4', 'EINVAL'),
                 (str(self.ext / '..' / 'outside.mp4'), 'EPERM'),
                 (str(directory), 'EINVAL'), (str(self.ext / 'missing.mp4'), 'ENOENT')]
        result = self.move(*(p for p, _ in cases))
        self.assertEqual(result['moved'], [])
        self.assertEqual([x['code'] for x in result['failed']], [c for _, c in cases])

    def test_relative_keeper_and_no_workspace(self):
        keeper = self.write('keep.mp4', root=self.work)
        src = self.write('a.mp4')
        result = self.move(src, keep='keep.mp4')
        self.assertEqual(result['failed'], [])
        self.assertTrue(Path(keeper).exists())
        result = q.quarantine(self.external, None, self.data, [self.write('b.mp4')])
        self.assertEqual(result['failed'], [])

    def test_corrupt_log_preserved(self):
        self.qdir.mkdir()
        self.logfile.write_bytes(b'{broken journal')
        result = self.move(self.write('a.mp4'))
        self.assertEqual(result['failed'], [])
        backups = list(self.qdir.glob('정리기록.json.broken-*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), b'{broken journal')
        self.assertEqual(self.log()['items'][0]['state'], 'moved')

    def test_restore_forgotten_root_and_missing_id(self):
        moved = self.move(self.write('a.mp4'))['moved'][0]
        self.external.forget(str(self.ext))
        self.assertEqual(len(q.list_items(self.external, self.data)['items']), 1)
        result = q.restore(self.external, self.data, [moved['id'], 'unknown'])
        self.assertEqual(len(result['restored']), 1)
        self.assertEqual(result['failed'][0]['code'], 'ENOENT')

    def test_restore_recreates_parent(self):
        src = self.write('nested/a.mp4')
        moved = self.move(src)['moved'][0]
        Path(src).parent.rmdir()
        result = q.restore(self.external, self.data, [moved['id']])
        self.assertEqual(result['failed'], [])
        self.assertEqual(Path(src).read_bytes(), b'original')

    def test_final_log_failure_remains_recoverable(self):
        src = self.write('a.mp4')
        save = q._save_log
        calls = 0
        def fail_second(directory, log):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError(errno.EIO, 'journal unavailable')
            return save(directory, log)
        with patch.object(q, '_save_log', side_effect=fail_second):
            result = self.move(src)
        self.assertEqual(result['failed'][0]['code'], 'ESERVER')
        listed = q.list_items(self.external, self.data)['items']
        self.assertEqual(len(listed), 1)
        self.assertEqual(q.restore(self.external, self.data, [listed[0]['id']])['failed'], [])
        self.assertEqual(Path(src).read_bytes(), b'original')

    def test_tampered_restore_path(self):
        moved = self.move(self.write('a.mp4'))['moved'][0]
        log = self.log()
        outside = self.base / 'must-not-write.mp4'
        log['items'][0]['path'] = str(outside)
        q._write_json(str(self.logfile), log)
        result = q.restore(self.external, self.data, [moved['id']])
        self.assertEqual(result['failed'][0]['code'], 'EINVAL')
        self.assertFalse(outside.exists())
        self.assertTrue(Path(moved['to']).exists())


class QuarantineHTTPTests(ServerTestCase):
    def test_round_trip_and_workspace_rejection(self):
        ext = os.path.join(self.tmp, '외부 폴더')
        os.makedirs(ext, exist_ok=True)
        type(self).srv.settings.pick_result = ext
        response = self.api.post('/api/dupes/roots/pick')
        self.assertEqual(response.status, 200, response.text)
        self.assertEqual(os.path.realpath(response.json()['root']), os.path.realpath(ext))
        src = os.path.join(ext, 'http.mp4')
        Path(src).write_bytes(b'http content')
        response = self.api.post('/api/dupes/quarantine', {'paths': [src], 'reason': '중복'})
        self.assertEqual(response.status, 200, response.text)
        self.assertEqual(response.json()['failed'], [])
        item = response.json()['moved'][0]
        response = self.api.get('/api/dupes/quarantine')
        self.assertEqual(response.status, 200, response.text)
        self.assertIn(item['id'], [x['id'] for x in response.json()['items']])
        response = self.api.post('/api/dupes/restore', {'ids': [item['id']]})
        self.assertEqual(response.status, 200, response.text)
        self.assertEqual(response.json()['failed'], [])
        self.assertEqual(Path(src).read_bytes(), b'http content')
        workspace_file = self.write('http-workspace.mp4', b'workspace content')
        response = self.api.post('/api/dupes/quarantine', {'paths': [workspace_file]})
        self.assertEqual(response.status, 200, response.text)
        self.assertEqual(response.json()['failed'][0]['code'], 'EINVAL')
        self.assertEqual(Path(workspace_file).read_bytes(), b'workspace content')

    def test_strict_validation(self):
        for body in ({'paths': []}, {'paths': [123]}, {'paths': ['x'], 'reason': 'x' * 201}):
            self.assertError(self.api.post('/api/dupes/quarantine', body), 400, 'EINVAL')
        self.assertError(self.api.post('/api/dupes/restore', {'ids': [123]}), 400, 'EINVAL')


if __name__ == '__main__':
    unittest.main()
