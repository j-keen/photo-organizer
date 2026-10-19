"""Algorithm units and real HTTP/ffmpeg coverage for duplicate detection v2."""
from __future__ import annotations

import hashlib
import os
import shutil
import sqlite3
import subprocess
import time
import unittest

from PIL import Image

from server import dupes2, ffmpeg
from server.errors import ApiError
from server.tests.helpers import Client, ServerTestCase, make_image, make_video


class AlgorithmTests(unittest.TestCase):
    def test_dhash(self):
        bits, std = dupes2.dhash_bytes(bytes(range(9)) * 8)
        self.assertEqual(bits, 0)
        self.assertGreater(std, 0)
        bits, _ = dupes2.dhash_bytes(bytes(range(8, -1, -1)) * 8)
        self.assertEqual(bits, (1 << 64) - 1)
        self.assertEqual(dupes2.dhash_bytes(bytes([23]) * 72), (0, 0))
        with self.assertRaises(ValueError):
            dupes2.dhash_bytes(b'x')

    def test_video_rules(self):
        rules = dupes2.normalize_rules({})

        def video(duration=6, bits=0, std=20):
            return dict(duration=duration, frames=[[duration * p, f'{bits:016x}', std] for p in dupes2.POSITIONS])

        a = video()
        score, frames = dupes2.same_video(a, video(), rules)
        self.assertEqual(score, 1)
        self.assertEqual(len(frames), 5)
        self.assertTrue(all(f['bits'] == 0 for f in frames))
        self.assertEqual(dupes2.same_video(a, video(9), rules)[0], 0)
        self.assertEqual(dupes2.same_video(a, video(std=3.99), rules)[0], 0)
        partial = video()
        partial['frames'][0][1] = None
        partial['frames'][1][2] = 0
        partial['frames'][2][2] = 0
        self.assertEqual(dupes2.same_video(a, partial, rules)[0], 0)
        self.assertEqual(dupes2.same_video(a, video(bits=(1 << 10) - 1), rules)[0], 1)
        self.assertEqual(dupes2.same_video(a, video(bits=(1 << 11) - 1), rules)[0], 0)
        self.assertEqual(dupes2.same_video(video(1), video(1), rules)[0], 0)
        self.assertEqual(dupes2.same_video(a, video(std=4), rules)[0], 1)

    def test_normalize_rules(self):
        self.assertEqual(dupes2.normalize_rules({}), dupes2.DEFAULT_RULES)
        self.assertEqual(dupes2.normalize_rules({'future': 1}), dupes2.DEFAULT_RULES)
        fresh = dupes2.normalize_rules(None)
        fresh['keep'].append('x')
        self.assertNotIn('x', dupes2.DEFAULT_RULES['keep'])
        for key, value in [('durationTolSec', '2'), ('flatStd', True), ('minDuration', -1),
                           ('frameBits', 65), ('imageBits', -1), ('minFrames', 0),
                           ('minFrames', 6), ('frameBits', 1.5), ('flatStd', float('nan')),
                           ('durationTolPct', float('inf')), ('keep', ['size', 'size']),
                           ('keep', ['width'])]:
            with self.subTest(key=key, value=value), self.assertRaises(ApiError) as caught:
                dupes2.normalize_rules({key: value})
            self.assertEqual(caught.exception.code, 'EINVAL')
            self.assertEqual(caught.exception.message, f'규칙 값을 확인해 주세요 ({key})')


@unittest.skipUnless(ffmpeg.available(), 'Bundled ffmpeg is required')
class Dupes2IntegrationTests(ServerTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.video_dir = os.path.join(cls.root, 'videos')
        os.makedirs(cls.video_dir)
        cls.base = make_video(os.path.join(cls.video_dir, 'base.mp4'), seconds=6,
                              source='testsrc2', acodec=None)
        shutil.copy2(cls.base, os.path.join(cls.video_dir, 'copy.mp4'))
        cls.run_ffmpeg(['-i', cls.base, '-vf', 'scale=160:120', '-c:v', 'libx264',
                        '-crf', '32', '-pix_fmt', 'yuv420p', '-an', os.path.join(cls.video_dir, 'small.mp4')])
        cls.run_ffmpeg(['-f', 'lavfi', '-i', 'mandelbrot=size=320x240:rate=25', '-t', '6',
                        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', os.path.join(cls.video_dir, 'other.mp4')])
        cls.photo = make_image(os.path.join(cls.root, 'photos', 'original.jpg'), pattern=3)
        with Image.open(cls.photo) as image:
            image.resize((320, 240)).save(os.path.join(cls.root, 'photos', 'half.jpg'), quality=92)
        make_image(os.path.join(cls.root, 'photos', 'different.jpg'), pattern=81)
        # Same picture, 1 s longer: the same video, but |Δduration| > 0.3 s → "애매" (the owner reviews it)
        still = make_image(os.path.join(cls.tmp, 'still.png'), size=(320, 240), pattern=11)
        cls.still_dir = os.path.join(cls.root, 'still')
        os.makedirs(cls.still_dir)
        for name, seconds in (('six.mp4', 6), ('seven.mp4', 7)):
            cls.run_ffmpeg(['-loop', '1', '-i', still, '-t', str(seconds), '-r', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
                            os.path.join(cls.still_dir, name)])
        cls.ext_dir = os.path.join(cls.tmp, '외부 폴더')
        os.makedirs(cls.ext_dir)
        shutil.copy2(cls.base, os.path.join(cls.ext_dir, 'outside.mp4'))
        client = Client(cls.port)
        client.session()
        client.open_workspace(cls.root)
        cls.srv.settings.pick_result = cls.ext_dir
        response = client.post('/api/dupes/roots/pick')
        if response.status != 200:
            raise AssertionError(response.text)
        cls.ext_dir = response.json()['root']

    @classmethod
    def run_ffmpeg(cls, args):
        subprocess.run([ffmpeg.exe(), '-hide_banner', '-loglevel', 'error', '-y', *args],
                       check=True, capture_output=True, timeout=20, **ffmpeg.popen_kwargs())

    def result(self, endpoint='/api/dupes/scan2', **body):
        response = self.api.post(endpoint, body)
        self.assertEqual(response.status, 202, response.text)
        job = self.api.wait_job(response.json(), timeout=45)
        self.assertEqual(job['state'], 'done', job)
        return job['result']

    def base_group(self, result):
        return next(g for g in result['groups'] if any(m['path'] == 'videos/base.mp4' for m in g['members']))

    def test_01_exact_video_photo_and_keeper(self):
        exact = self.result(dirs=['videos'], kinds=['exact'])
        group = self.base_group(exact)
        self.assertEqual(group['kind'], 'exact')
        self.assertTrue(group['sure'])
        self.assertEqual({m['path'] for m in group['members']}, {'videos/base.mp4', 'videos/copy.mp4'})
        result = self.result(dirs=['videos', 'photos'])
        group = self.base_group(result)
        self.assertEqual(group['kind'], 'video')
        self.assertTrue(group['sure'])
        self.assertEqual(group['keep'], 'videos/base.mp4')
        self.assertEqual(group['members'][0]['h'], 240)
        self.assertTrue(group['members'][0]['keep'])
        self.assertTrue(all(m['direct'] for m in group['members']), group['members'])
        self.assertFalse(any(m['path'] == 'videos/other.mp4' for m in group['members']))
        self.assertIn('videos/small.mp4', {m['path'] for m in group['members']})
        links = [e for e in group['evidence'] if e['kind'] == 'video']
        self.assertTrue(links)
        self.assertTrue(all(len(e['frames']) == 5 and e['score'] >= 0.6 for e in links))
        photo = next(g for g in result['groups'] if g['kind'] == 'image')
        self.assertFalse(photo['sure'])
        self.assertEqual({m['path'] for m in photo['members']}, {'photos/original.jpg', 'photos/half.jpg'})
        expected = hashlib.sha1('\n'.join(sorted(m['path'] for m in group['members'])).encode()).hexdigest()[:16]
        self.assertEqual(group['id'], expected)
        self.assertEqual(result['stats']['engine'], 'server-v2')
        self.assertEqual(result['stats']['files'], 7)

    def test_01b_unsure_when_durations_differ(self):
        result = self.result(dirs=['still'])
        self.assertEqual(len(result['groups']), 1)
        group = result['groups'][0]
        self.assertEqual(group['kind'], 'video')
        self.assertFalse(group['sure'])
        self.assertEqual(group['keep'], 'still/seven.mp4')  # same height → longer wins
        self.assertAlmostEqual(group['evidence'][0]['dDur'], 1, delta=0.15)
        # A stricter duration rule keeps them apart; a looser "sure" rule makes the group sure
        self.assertEqual(self.result(dirs=['still'], rules={'durationTolSec': 0.5, 'durationTolPct': 0})['groups'], [])
        self.assertTrue(self.result(dirs=['still'], rules={'sureDurationSec': 2})['groups'][0]['sure'])

    def test_02_compare_and_roots(self):
        response = self.api.get('/api/dupes/roots')
        self.assertEqual(response.status, 200)
        self.assertTrue(any(r['root'] == self.ext_dir and r['source'] == 'picked' for r in response.json()['roots']))
        result = self.result(compare={'a': ['videos'], 'b': [self.ext_dir]})
        self.assertTrue(result['groups'])
        for group in result['groups']:
            self.assertEqual({m['side'] for m in group['members']}, {'a', 'b'})
        member = next(m for g in result['groups'] for m in g['members'] if m['side'] == 'b')
        self.assertTrue(os.path.isabs(member['path']))
        self.assertEqual(member['root'], self.ext_dir)
        self.assertFalse(os.path.exists(os.path.join(self.ext_dir, '.fluid-organizer')))
        self.assertTrue(os.path.isfile(os.path.join(self.data_dir, 'fingerprints.sqlite')))

    def test_03_exclusions(self):
        result = self.result(dirs=['videos'], exclude={'files': ['videos/copy.mp4']})
        self.assertFalse(any(m['path'] == 'videos/copy.mp4' for g in result['groups'] for m in g['members']))
        self.assertEqual(result['stats']['excluded'], 1)
        result = self.result(dirs=['videos', 'photos'], exclude={'folders': ['photos']})
        self.assertEqual(result['stats']['excluded'], 3)
        self.assertEqual(result['stats']['images'], 0)
        # "Not duplicates" holds transitively: base and copy never share a group, not even through small.mp4
        result = self.result(dirs=['videos'], exclude={'pairs': [['videos/base.mp4', 'videos/copy.mp4']]})
        together = [g for g in result['groups'] if {'videos/base.mp4', 'videos/copy.mp4'} <= {m['path'] for m in g['members']}]
        self.assertEqual(together, [])
        self.assertTrue(any(len(g['members']) >= 2 for g in result['groups']))

    def test_03b_excluded_pair_through_an_exact_chain(self):
        os.makedirs(self.path('triple'))
        for name in ('a.png', 'b.png', 'c.png'):
            shutil.copy2(self.photo, self.path(f'triple/{name}'))
        result = self.result(dirs=['triple'], kinds=['exact'], exclude={'pairs': [['triple/a.png', 'triple/c.png']]})
        self.assertEqual(len(result['groups']), 1)
        members = {m['path'] for m in result['groups'][0]['members']}
        self.assertEqual(len(members), 2)
        self.assertFalse({'triple/a.png', 'triple/c.png'} <= members)

    def test_04_incremental_and_cache(self):
        endpoint = '/api/dupes/fingerprint'
        self.result(endpoint, dirs=['videos', 'photos'])
        second = self.result(endpoint, dirs=['videos', 'photos'])
        self.assertEqual(second['computed'], 0)
        self.assertEqual(second['cached'], second['files'])
        st = os.stat(self.photo)
        os.utime(self.photo, ns=(st.st_atime_ns, st.st_mtime_ns + 2_000_000_000))
        third = self.result(endpoint, dirs=['videos', 'photos'])
        self.assertEqual(third['computed'], 1)
        with sqlite3.connect(os.path.join(self.root, '.fluid-organizer', 'hashes.sqlite')) as db:
            row = db.execute('SELECT json FROM fingerprints WHERE engine=? AND path=?',
                             (dupes2.ENGINE, 'photos/original.jpg')).fetchone()
            self.assertIsNotNone(row)
        self.result(endpoint, roots=[self.ext_dir])
        self.assertTrue(os.path.isfile(os.path.join(self.data_dir, 'fingerprints.sqlite')))
        self.assertEqual(sorted(os.listdir(self.ext_dir)), ['outside.mp4'])

    def fresh_videos(self, folder):
        os.makedirs(self.path(folder))
        for i in range(4):
            shutil.copy2(self.base, self.path(f'{folder}/{i}.mp4'))

    def test_05_pause_resume_and_cancel(self):
        self.fresh_videos('pause')
        response = self.api.post('/api/dupes/fingerprint', {'dirs': ['pause'], 'workers': 1})
        self.assertEqual(response.status, 202)
        job = response.json()
        paused = self.api.post(f"/api/jobs/{job['id']}/pause")
        self.assertEqual(paused.status, 200)
        deadline = time.monotonic() + 5
        while True:
            state = self.api.get(f"/api/jobs/{job['id']}").json()
            if state['paused']:
                break
            self.assertLess(time.monotonic(), deadline, state)
            time.sleep(0.02)
        progress = state['progress']
        time.sleep(1)
        state = self.api.get(f"/api/jobs/{job['id']}").json()
        self.assertEqual(state['state'], 'running')
        self.assertEqual(state['progress'], progress)
        self.assertTrue(state['paused'])
        self.api.post(f"/api/jobs/{job['id']}/resume")
        self.assertEqual(self.api.wait_job(job)['state'], 'done')
        self.fresh_videos('cancel')
        response = self.api.post('/api/dupes/fingerprint', {'dirs': ['cancel'], 'workers': 1})
        self.assertEqual(response.status, 202)
        job = response.json()
        self.api.post(f"/api/jobs/{job['id']}/cancel")
        self.assertEqual(self.api.wait_job(job)['state'], 'cancelled')

    def test_06_safety_and_junction(self):
        forbidden = 'C:\\Windows' if os.name == 'nt' else '/etc'
        self.assertError(self.api.post('/api/dupes/scan2', {'roots': [forbidden]}), 403, 'EPERM')
        traversal = os.path.join(self.ext_dir, '..', 'elsewhere')
        self.assertError(self.api.post('/api/dupes/scan2', {'roots': [traversal]}), 403, 'EPERM')
        self.assertError(self.api.post('/api/dupes/scan2', {'compare': {'a': ['..'], 'b': ['videos']}}), 403, 'EPERM')
        outside = os.path.join(self.tmp, 'outside.mp4')
        self.assertError(self.api.get('/api/dupes/frame', path=outside), 403, 'EPERM')
        self.assertError(self.api.get('/api/dupes/frame', path='../x.mp4'), 403, 'EPERM')
        if os.name == 'nt':
            import _winapi
            target = os.path.join(self.tmp, 'junction-target')
            link = os.path.join(self.ext_dir, 'junction')
            os.makedirs(target)
            shutil.copy2(self.base, os.path.join(target, 'escape.mp4'))
            _winapi.CreateJunction(target, link)
            try:
                result = self.result(roots=[self.ext_dir])
                self.assertEqual(result['stats']['files'], 1)
                self.assertFalse(any('escape.mp4' in m['path'] for g in result['groups'] for m in g['members']))
            finally:
                os.rmdir(link)

    def test_07_frames_and_legacy(self):
        for path in ('videos/base.mp4', 'photos/original.jpg', os.path.join(self.ext_dir, 'outside.mp4')):
            response = self.api.get('/api/dupes/frame', path=path, t=999, w=160)
            self.assertEqual(response.status, 200, response.text)
            self.assertTrue(response.headers['content-type'].startswith('image/jpeg'))
            self.assertTrue(response.body.startswith(b'\xff\xd8'))
            self.assertEqual(response.headers['cache-control'], 'private, max-age=86400')
        response = self.api.get('/api/dupes/frame', path='videos/missing.mp4')
        self.assertEqual(response.status, 204)
        self.assertEqual(response.headers['x-fi-error'], 'ENOENT')
        result = self.result('/api/dupes/scan', mode='exact', dirs=['videos'])
        self.assertTrue(result['groups'])
        self.assertIn('items', result['groups'][0])
        for body, status, code in [({'mode': 'wrong'}, 400, 'EINVAL'),
                                   ({'dirs': ['..']}, 403, 'EPERM'),
                                   ({'dirs': ['missing-folder']}, 404, 'ENOENT')]:
            self.assertError(self.api.post('/api/dupes/scan', body), status, code)
        response = self.api.request('POST', '/api/dupes/scan', body=b'{broken', headers={'Content-Type': 'application/json'})
        self.assertError(response, 400, 'EINVAL')

    def test_08_request_validation(self):
        for body in [[], {'dirs': 'videos'}, {'roots': [1]}, {'kinds': []}, {'kinds': ['unknown']},
                     {'workers': True}, {'workers': 17}, {'compare': {'a': [], 'b': ['videos']}},
                     {'exclude': {'pairs': [['a']]}}, {'exclude': {'files': [1]}}, {'rules': {'frameBits': 65}},
                     {'compare': {'a': ['videos'], 'b': ['videos']}}, {'compare': {'a': [''], 'b': ['videos']}}]:
            with self.subTest(body=body):
                self.assertError(self.api.post('/api/dupes/scan2', body), 400, 'EINVAL')


if __name__ == '__main__':
    unittest.main()
