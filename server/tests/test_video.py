"""Integration tests for video output, orientation and validation."""
import os
import time
import unittest

from PIL import Image

from server import ffmpeg, fsutil
from server.tests.helpers import ServerTestCase, make_image, make_video


@unittest.skipUnless(ffmpeg.available(), 'ffmpeg unavailable')
class VideoTests(ServerTestCase):
    def setUp(self):
        super().setUp()
        self.folder = self.id().rsplit('.', 1)[-1]
        os.makedirs(self.path(self.folder), exist_ok=True)
        self.clip = self.folder + '/clip.mp4'
        make_video(self.path(self.clip), seconds=4, size=(160, 120), extra=['-g', '25'])

    def tearDown(self):
        deadline = time.monotonic() + 5
        while True:
            leftovers = [os.path.join(d, f) for d, _, files in os.walk(self.root) for f in files if f.startswith('.fi-tmp-')]
            if not leftovers or time.monotonic() >= deadline:
                break
            time.sleep(0.02)
        self.assertEqual(leftovers, [])
        super().tearDown()

    def job(self, endpoint, body):
        response = self.api.post('/api/video/' + endpoint, body)
        self.assertEqual(response.status, 202, response.text)
        job = self.api.wait_job(response.json(), timeout=25)
        self.assertEqual(job['state'], 'done', job)
        result = job['result']
        st = os.stat(self.path(result['path']))
        self.assertEqual(result['size'], st.st_size)
        self.assertEqual(result['mtime'], fsutil.mtime_ms(st))
        return result

    def test_trim_fast_numbering(self):
        body = {'path': self.clip, 'start': 1, 'end': 3, 'mode': 'fast'}
        first = self.job('trim', body)
        second = self.job('trim', body)
        self.assertEqual(first['path'], self.folder + '/clip_cut01.mp4')
        self.assertEqual(second['path'], self.folder + '/clip_cut02.mp4')
        self.assertAlmostEqual(first['duration'], 2, delta=0.6)

    def test_trim_accurate_and_avi(self):
        result = self.job('trim', {'path': self.clip, 'start': 0.4, 'end': 2.1, 'mode': 'accurate'})
        self.assertAlmostEqual(result['duration'], 1.7, delta=0.15)
        avi = self.folder + '/legacy.avi'
        make_video(self.path(avi), seconds=3, size=(160, 120), vcodec='mpeg4', acodec=None, extra=['-g', '25'])
        for mode, ext in [('fast', '.avi'), ('accurate', '.mp4')]:
            result = self.job('trim', {'path': avi, 'start': 1, 'end': 2, 'mode': mode})
            self.assertTrue(result['path'].endswith(ext), result)

    def test_invalid_inputs(self):
        for start, end in [(-1, 2), (2, 1), (1, 1), (0, 5), ('bad', 2), (True, 2), (0, None)]:
            with self.subTest(start=start, end=end):
                self.assertError(self.api.post('/api/video/trim', {'path': self.clip, 'start': start, 'end': end}), 400, 'EINVAL')
        self.assertError(self.api.post('/api/video/trim', {'path': self.clip, 'start': 0, 'end': 1, 'mode': 'unknown'}), 400, 'EINVAL')
        image = self.folder + '/image.png'
        make_image(self.path(image))
        for endpoint, extra in [('trim', {'start': 0, 'end': 1}), ('frame', {'time': 1}), ('transform', {'op': 'rotate90'})]:
            self.assertError(self.api.post('/api/video/' + endpoint, {'path': image, **extra}), 400, 'EINVAL')
            self.assertError(self.api.post('/api/video/' + endpoint, {'path': self.folder + '/missing.mp4', **extra}), 404, 'ENOENT')
        for body in [{'segments': []}, {'segments': [{'path': self.clip}] * 51}, {'segments': [{'path': self.clip, 'start': 2, 'end': 1}]}]:
            self.assertError(self.api.post('/api/video/concat', body), 400, 'EINVAL')
        for t in [-1, 5, 'bad']:
            self.assertError(self.api.post('/api/video/frame', {'path': self.clip, 'time': t}), 400, 'EINVAL')

    def test_concat(self):
        other = self.folder + '/silent.mp4'
        make_video(self.path(other), seconds=1.2, size=(128, 96), fps=30, acodec=None)
        body = {'segments': [{'path': self.clip, 'start': 1, 'end': 2.5}, {'path': other}]}
        result = self.job('concat', body)
        self.assertEqual(result['path'], self.folder + '/clip_merged01.mp4')
        self.assertAlmostEqual(result['duration'], 2.7, delta=0.3)
        info = ffmpeg.probe(self.path(result['path']))
        self.assertEqual((info['width'], info['height']), (160, 120))
        self.assertTrue(info['hasAudio'])
        body['output'] = self.folder + '/chosen.mp4'
        result = self.job('concat', body)
        self.assertEqual(result['path'], body['output'])
        result = self.job('concat', body)
        self.assertEqual(result['path'], self.folder + '/chosen (2).mp4')

    def test_metadata_rotation(self):
        result = self.job('transform', {'path': self.clip, 'op': 'rotate90', 'mode': 'metadata'})
        info = ffmpeg.probe(self.path(result['path']))
        self.assertEqual(info['rotation'], 90)
        self.assertEqual((info['width'], info['height']), (120, 160))
        result = self.job('transform', {'path': result['path'], 'op': 'rotate90', 'mode': 'metadata'})
        self.assertEqual(ffmpeg.probe(self.path(result['path']))['rotation'], 180)
        self.assertError(self.api.post('/api/video/transform', {'path': self.clip, 'op': 'hflip', 'mode': 'metadata'}), 400, 'EINVAL')

    def test_reencode_transforms(self):
        result = self.job('transform', {'path': self.clip, 'op': 'hflip', 'mode': 'reencode'})
        info = ffmpeg.probe(self.path(result['path']))
        self.assertEqual((info['width'], info['height']), (160, 120))
        result = self.job('transform', {'path': self.clip, 'op': 'rotate270', 'mode': 'reencode'})
        info = ffmpeg.probe(self.path(result['path']))
        self.assertEqual((info['width'], info['height'], info['rotation']), (120, 160, 0))

    def test_in_place(self):
        old = os.stat(self.path(self.clip))
        os.utime(self.path(self.clip), ns=(old.st_atime_ns, old.st_mtime_ns - 5_000_000_000))
        before = fsutil.mtime_ms(os.stat(self.path(self.clip)))
        result = self.job('transform', {'path': self.clip, 'op': 'rotate90', 'mode': 'metadata', 'inPlace': True})
        self.assertEqual(result['path'], self.clip)
        self.assertNotEqual(result['mtime'], before)
        self.assertEqual(ffmpeg.probe(self.path(self.clip))['rotation'], 90)

    def test_frames(self):
        for fmt in ['jpg', 'png', 'jpg']:
            response = self.api.post('/api/video/frame', {'path': self.clip, 'time': 1.0, 'format': fmt})
            self.assertEqual(response.status, 200, response.text)
            result = response.json()
            suffix = ' (2)' if fmt == 'jpg' and 'first' in locals() else ''
            self.assertEqual(result['path'], self.folder + f'/clip_frame_00m01s{suffix}.{fmt}')
            with fsutil.open_shared(self.path(result['path'])) as handle:
                with Image.open(handle) as image:
                    image.load()
                    self.assertEqual(image.size, (160, 120))
            self.assertEqual(result['size'], os.path.getsize(self.path(result['path'])))
            self.assertEqual(result['mtime'], fsutil.mtime_ms(os.stat(self.path(result['path']))))
            if fmt == 'jpg':
                first = result
