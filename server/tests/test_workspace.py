"""Workspace persistence, independent tokens and headless selection."""
import json
import os

from server.tests.helpers import ServerTestCase


class WorkspaceTests(ServerTestCase):
    def test_open_and_validation(self):
        opened = self.api.post('/api/workspace/open', {'root': self.root})
        self.assertEqual(opened.status, 200, opened.text)
        ws = opened.json()
        self.assertEqual(set(ws), {'id', 'name', 'root', 'token'})
        self.assertEqual(ws['root'], os.path.realpath(self.root))
        with open(self.path('.fluid-organizer/workspace.json'), encoding='utf-8') as stream:
            self.assertEqual(json.load(stream)['id'], ws['id'])
        again = self.api.post('/api/workspace/open', {'root': self.root}).json()
        self.assertEqual(again['id'], ws['id'])
        self.assertEqual(again['token'], ws['token'])
        self.assertError(self.api.post('/api/workspace/open', {'root': 'relative/path'}), 400, 'EINVAL')
        self.assertError(self.api.post('/api/workspace/open', {'root': os.path.join(self.tmp, 'missing-workspace')}), 404, 'ENOENT')
        file = self.write('작업폴더아님.txt')
        self.assertError(self.api.post('/api/workspace/open', {'root': file}), 400, 'EINVAL')
        session = self.api.session().json()
        self.assertEqual(session['workspace'], ws)

    def test_recent_and_forget(self):
        first = os.path.join(self.tmp, '최근 첫째')
        second = os.path.join(self.tmp, '최근 둘째')
        os.makedirs(first, exist_ok=True)
        os.makedirs(second, exist_ok=True)
        self.api.open_workspace(first)
        self.api.open_workspace(second)
        recent = self.api.get('/api/workspace/recent')
        self.assertEqual(recent.status, 200)
        items = recent.json()
        self.assertEqual([x['root'] for x in items[:2]], [os.path.realpath(second), os.path.realpath(first)])
        self.assertGreaterEqual(items[0]['openedAt'], items[1]['openedAt'])
        self.assertTrue(all(x['exists'] for x in items[:2]))
        self.assertEqual(items[0]['name'], '최근 둘째')
        # Rename rather than delete an open workspace to exercise the existence flag.
        os.rename(second, second + ' 이동')
        try:
            items = self.api.get('/api/workspace/recent').json()
            self.assertFalse(next(x for x in items if x['root'] == os.path.realpath(second))['exists'])
            r = self.api.post('/api/workspace/forget', {'root': os.path.realpath(first)})
            self.assertEqual(r.json(), {'ok': True})
            self.assertNotIn(os.path.realpath(first), [x['root'] for x in self.api.get('/api/workspace/recent').json()])
            self.assertTrue(os.path.isdir(first))
        finally:
            os.rename(second + ' 이동', second)

    def test_independent_workspaces(self):
        left = os.path.join(self.tmp, '독립 왼쪽')
        right = os.path.join(self.tmp, '독립 오른쪽')
        for root, name in ((left, '왼쪽.txt'), (right, '오른쪽.txt')):
            os.makedirs(root, exist_ok=True)
            with open(os.path.join(root, name), 'wb') as stream:
                stream.write(b'x')
        a = self.api.open_workspace(left)
        b = self.api.open_workspace(right)
        self.assertNotEqual(a['token'], b['token'])
        for ws, present, absent in ((a, '왼쪽.txt', '오른쪽.txt'), (b, '오른쪽.txt', '왼쪽.txt')):
            r = self.api.get('/api/fs/list', ws=ws['token'])
            self.assertEqual(r.status, 200, r.text)
            names = {x['name'] for x in r.json()['entries']}
            self.assertIn(present, names)
            self.assertNotIn(absent, names)
        self.assertError(self.api.get('/api/fs/list', ws='unknown-workspace-token'), 409, 'ENOWS')

    def test_picker_does_not_open(self):
        settings = self.srv.settings
        previous = settings.pick_result
        picked = os.path.join(self.tmp, '선택만 한 폴더')
        os.makedirs(picked, exist_ok=True)
        before = self.api.session().json()['workspace']
        try:
            settings.pick_result = picked
            r = self.api.post('/api/workspace/pick', {'initialDir': self.root})
            self.assertEqual(r.json(), {'root': os.path.normpath(picked)})
            self.assertEqual(self.api.session().json()['workspace'], before)
            self.assertFalse(os.path.exists(os.path.join(picked, '.fluid-organizer')))
            settings.pick_result = ''
            self.assertEqual(self.api.post('/api/workspace/pick').json(), {'cancelled': True})
            self.assertEqual(self.api.post('/api/workspace/pick/cancel').json(), {'ok': True})
        finally:
            settings.pick_result = previous
