"""Duplicate detection unit and real HTTP integration tests."""
from __future__ import annotations

import os
import shutil
import threading
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

from server import dupes, ffmpeg
from server.fsutil import open_shared
from server.tests.helpers import ServerTestCase, make_image, make_video


class HashTests(unittest.TestCase):
    def test_gray_and_hamming(self):
        gray = np.random.default_rng(42).integers(0, 256, (32, 32), dtype=np.uint8)
        code = dupes.phash_gray(gray)
        self.assertEqual(len(code), 8)
        self.assertEqual(dupes.hamming(code, dupes.phash_gray(gray.copy())), 0)
        self.assertGreater(dupes.hamming(code, dupes.phash_gray(255 - gray)), 50)
        self.assertEqual(len(dupes.phash_gray(gray[:20, :17])), 8)
        with self.assertRaises(ValueError):
            dupes.hamming(b'a', b'ab')

    def test_pairs_backends(self):
        rng = np.random.default_rng(8)
        for width, radius in ((8, 33), (40, 161)):
            codes = rng.integers(0, 256, (37, width), dtype=np.uint8)
            codes[1] = codes[0]
            expected = [(i, j, dupes.hamming(codes[i].tobytes(), codes[j].tobytes()))
                        for i in range(len(codes)) for j in range(i + 1, len(codes))
                        if dupes.hamming(codes[i].tobytes(), codes[j].tobytes()) < radius]
            with patch.object(dupes, 'USE_FAISS', False):
                self.assertEqual(dupes.find_pairs(codes, radius), expected)
            if dupes.faiss is not None:
                with patch.object(dupes, 'USE_FAISS', True):
                    self.assertEqual(dupes.find_pairs(codes, radius), expected)
            self.assertEqual(dupes.find_pairs(codes, 1), [(0, 1, 0)])

    def test_union_find(self):
        union = dupes.UnionFind(5)
        union.union(0, 1)
        union.union(2, 3)
        union.union(1, 3)
        self.assertEqual(union.find(0), union.find(2))
        self.assertNotEqual(union.find(0), union.find(4))


class DuplicateTests(ServerTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.photos = {'photos/base.jpg', 'photos/resized.jpg', 'photos/recompressed.jpg',
                      'photos/pixels.png', 'photos/copies/base.jpg'}
        folder = os.path.join(cls.root, 'photos')
        os.makedirs(os.path.join(folder, 'copies'))
        base = make_image(os.path.join(folder, 'base.jpg'), (800, 600), pattern=1)
        with open_shared(base) as stream, Image.open(stream) as image:
            image.load()
            with image.resize((400, 300), Image.Resampling.LANCZOS) as small:
                small.save(os.path.join(folder, 'resized.jpg'), quality=92)
            image.save(os.path.join(folder, 'recompressed.jpg'), quality=40)
            image.save(os.path.join(folder, 'pixels.png'))
        shutil.copy2(base, os.path.join(folder, 'copies', 'base.jpg'))
        make_image(os.path.join(folder, 'unrelated.jpg'), (800, 600), pattern=2)
        for hidden in ('.hidden', '.fluid-organizer'):
            os.makedirs(os.path.join(cls.root, hidden), exist_ok=True)
            shutil.copy2(base, os.path.join(cls.root, hidden, 'hidden.jpg'))
        cls.have_video = ffmpeg.available() and ffmpeg.has_encoder('libx264')
        if cls.have_video:
            video_dir = os.path.join(cls.root, 'videos')
            original = make_video(os.path.join(video_dir, 'base.mp4'), seconds=3, fps=10, acodec=None)
            ffmpeg.capture(['-y', '-i', original, '-vf', 'scale=160:120', '-c:v', 'libx264',
                            '-crf', '35', '-an', os.path.join(video_dir, 'small.mp4')], inputs=[original])
            make_video(os.path.join(video_dir, 'different.mp4'), seconds=3, fps=10, source='smptebars', acodec=None)
            shutil.copy2(original, os.path.join(video_dir, 'copy.mp4'))

    def run_scan(self, **options):
        response = self.api.post('/api/dupes/scan', options)
        self.assertEqual(response.status, 202, response.text)
        job = self.api.wait_job(response.json(), timeout=40)
        self.assertEqual(job['state'], 'done', job)
        return job['result']

    @staticmethod
    def paths(group):
        return {item['path'] for item in group['items']}

    def test_exact(self):
        result = self.run_scan(mode='exact')
        expected = {frozenset(('photos/base.jpg', 'photos/copies/base.jpg'))}
        if self.have_video:
            expected.add(frozenset(('videos/base.mp4', 'videos/copy.mp4')))
        self.assertEqual({frozenset(self.paths(group)) for group in result['groups']}, expected)
        for group in result['groups']:
            self.assertEqual(group['kind'], 'exact')
            self.assertTrue(all(item['distance'] == 0 for item in group['items']))

    def test_similar_photos(self):
        result = self.run_scan(mode='similar', videos=False)
        self.assertEqual(len(result['groups']), 1)
        self.assertEqual(self.paths(result['groups'][0]), self.photos)
        self.assertEqual(result['stats']['files'], 6)
        self.assertEqual(result['stats']['videos'], 0)
        items = result['groups'][0]['items']
        ordering = [(-item['width'] * item['height'], -item['size'], item['mtime']) for item in items]
        self.assertEqual(ordering, sorted(ordering))

    def test_similar_videos(self):
        if not self.have_video:
            self.skipTest('ffmpeg/libx264 unavailable')
        result = self.run_scan(mode='similar', dirs=['videos'])
        self.assertEqual(len(result['groups']), 1)
        self.assertEqual(self.paths(result['groups'][0]), {'videos/base.mp4', 'videos/copy.mp4', 'videos/small.mp4'})
        self.assertTrue(all(item['duration'] > 0 for item in result['groups'][0]['items']))

    def test_both_unique_and_exact_classification(self):
        result = self.run_scan(mode='both')
        paths = [item['path'] for group in result['groups'] for item in group['items']]
        self.assertEqual(len(paths), len(set(paths)))
        photos = next(group for group in result['groups'] if 'photos/base.jpg' in self.paths(group))
        self.assertEqual(photos['kind'], 'similar')
        copies = {item['path']: item['distance'] for item in photos['items']}
        self.assertEqual(copies['photos/base.jpg'], copies['photos/copies/base.jpg'])
        # Restricting to copies gives a group consisting entirely of identical bytes.
        result = self.run_scan(mode='both', dirs=['photos/copies', 'photos/copies'])
        self.assertEqual(result['groups'], [])
        result = self.run_scan(mode='both', threshold=0, videos=False)
        exact = next(group for group in result['groups'] if 'photos/base.jpg' in self.paths(group))
        # PNG shares decoded pixels, so threshold zero can still produce a similar group.
        self.assertIn('photos/pixels.png', self.paths(exact))
        self.assertTrue(all(item['distance'] == 0 for item in exact['items']))

    def test_all_identical_group_is_exact(self):
        source = self.path('photos/base.jpg')
        folder = self.path('identical')
        os.makedirs(folder, exist_ok=True)
        try:
            shutil.copy2(source, os.path.join(folder, 'a.jpg'))
            shutil.copy2(source, os.path.join(folder, 'b.jpg'))
            result = self.run_scan(mode='both', dirs=['identical'])
            self.assertEqual(len(result['groups']), 1)
            self.assertEqual(result['groups'][0]['kind'], 'exact')
            self.assertTrue(all(item['distance'] == 0 for item in result['groups'][0]['items']))
        finally:
            shutil.rmtree(folder)

    def test_cache_and_dirs(self):
        # Use an isolated directory so this test owns the cold cache regardless of test order.
        folder = self.path('cache-test')
        os.makedirs(folder, exist_ok=True)
        try:
            shutil.copy2(self.path('photos/base.jpg'), os.path.join(folder, 'a.jpg'))
            shutil.copy2(self.path('photos/base.jpg'), os.path.join(folder, 'b.jpg'))
            first = self.run_scan(mode='both', dirs=['cache-test'])
            second = self.run_scan(mode='both', dirs=['cache-test'])
            self.assertEqual(first['groups'], second['groups'])
            self.assertGreater(first['stats']['hashed'], 0)
            self.assertGreater(second['stats']['cached'], 0)
            self.assertEqual(second['stats']['hashed'], 0)
            self.assertEqual(second['stats']['files'], 2)
            self.assertTrue(os.path.isfile(self.path('.fluid-organizer/hashes.sqlite')))
        finally:
            shutil.rmtree(folder)

    def test_validation(self):
        for body in ({'mode': 'bad'}, {'threshold': -1}, {'threshold': 65}, {'threshold': 1.5},
                     {'threshold': True}, {'dirs': 'photos'}, {'dirs': [4]}, {'dirs': ['photos/base.jpg']}):
            self.assertError(self.api.post('/api/dupes/scan', body), 400, 'EINVAL')
        self.assertError(self.api.post('/api/dupes/scan', {'dirs': ['../escape']}), 403, 'EPERM')
        self.assertError(self.api.post('/api/dupes/scan', {'dirs': ['missing-folder']}), 404, 'ENOENT')

    def test_unreadable_is_skipped(self):
        self.write('broken/bad.jpg', b'not an image')
        try:
            result = self.run_scan(mode='similar', dirs=['broken'])
            self.assertEqual(result['stats']['skipped'], 1)
            self.assertEqual(result['groups'], [])
        finally:
            shutil.rmtree(self.path('broken'))

    def test_cancel_mid_scan(self):
        entered = threading.Event()
        release = threading.Event()
        original = dupes._metadata

        def paused(item, cache, job):
            entered.set()
            if not release.wait(10):
                raise AssertionError('Cancellation test timed out')
            job.check()
            return original(item, cache, job)

        with patch.object(dupes, '_metadata', paused):
            response = self.api.post('/api/dupes/scan', {'mode': 'similar', 'videos': False})
            self.assertEqual(response.status, 202, response.text)
            job = response.json()
            try:
                self.assertTrue(entered.wait(10))
                cancelled = self.api.post('/api/jobs/' + job['id'] + '/cancel')
                self.assertEqual(cancelled.status, 200)
            finally:
                release.set()
            self.assertEqual(self.api.wait_job(job)['state'], 'cancelled')


if __name__ == '__main__':
    unittest.main()
