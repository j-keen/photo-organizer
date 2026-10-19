"""Media API integration tests using the real local HTTP server."""
from __future__ import annotations

import http.client
import io
import os
import time
import unittest
import urllib.parse
from datetime import datetime
from unittest.mock import patch

from PIL import Image

from server import ffmpeg, media
from server.tests.helpers import ServerTestCase, make_image, make_video


class ImageTests(ServerTestCase):
    def thumb(self, rel, size=128, **query):
        response = self.api.get('/api/thumb', path=rel, size=size, **query)
        self.assertEqual(response.status, 200, response.text)
        self.assertEqual(response.headers['content-type'], 'image/webp')
        self.assertEqual(response.body[:4], b'RIFF')
        self.assertEqual(response.body[8:12], b'WEBP')
        with Image.open(io.BytesIO(response.body)) as img:
            img.load()
            return response, img.copy()

    def test_jpeg_cache_and_sizes(self):
        rel = 'images/cache.jpg'
        make_image(self.path(rel), size=(1200, 800))
        response, img = self.thumb(rel)
        with img:
            self.assertEqual(max(img.size), 128)
        self.assertEqual(response.headers['x-fi-width'], '1200')
        self.assertEqual(response.headers['x-fi-height'], '800')
        self.assertEqual(response.headers['cache-control'], 'no-cache')
        directory = self.path('.fluid-organizer/thumbs')
        self.assertTrue(any(name.endswith('.webp') for name in os.listdir(directory)))
        started = time.monotonic()
        with patch.object(media, '_load_image', side_effect=AssertionError('cache decoded pixels')):
            again = self.api.get('/api/thumb', path=rel, size=128)
            conditional = self.api.request('GET', '/api/thumb', query={'path': rel, 'size': 128},
                                           headers={'If-None-Match': response.headers['etag']})
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual(again.body, response.body)
        self.assertEqual(again.headers['etag'], response.headers['etag'])
        self.assertEqual(conditional.status, 304)
        self.assertEqual(conditional.body, b'')
        versioned = self.api.get('/api/thumb', path=rel, size=128, v='1')
        self.assertEqual(versioned.headers['cache-control'], 'private, max-age=31536000, immutable')
        make_image(self.path('images/small.jpg'), size=(40, 20))
        _, small = self.thumb('images/small.jpg', 360)
        with small:
            self.assertEqual(small.size, (40, 20))

    def test_orientation_and_exif(self):
        rel = 'images/oriented.jpg'
        date = '2023:04:05 12:34:56'
        make_image(self.path(rel), size=(640, 400), exif_orientation=6,
                   exif_datetime=date, camera=('Canon', 'Canon Test'))
        response, img = self.thumb(rel)
        with img:
            self.assertGreater(img.height, img.width)
        self.assertEqual(response.headers['x-fi-width'], '400')
        self.assertEqual(response.headers['x-fi-height'], '640')
        response = self.api.get('/api/media/probe', path=rel)
        self.assertEqual(response.status, 200, response.text)
        info = response.json()
        self.assertEqual((info['width'], info['height']), (400, 640))
        self.assertEqual(info['camera'], 'Canon Test')
        self.assertEqual(info['taken'], int(datetime.strptime(date, '%Y:%m:%d %H:%M:%S').timestamp() * 1000))
        self.assertEqual(info['format'], 'JPEG')
        self.assertEqual(info['size'], os.stat(self.path(rel)).st_size)
        self.assertIsInstance(info['mtime'], int)
        self.assertIsNone(info['duration'])

    def test_alpha_and_tiff(self):
        rel = 'images/alpha.png'
        os.makedirs(os.path.dirname(self.path(rel)), exist_ok=True)
        with Image.new('RGBA', (160, 80), (100, 50, 20, 64)) as img:
            img.save(self.path(rel))
        _, img = self.thumb(rel)
        with img:
            self.assertIn('A', img.getbands())
            self.assertEqual(img.getchannel('A').getextrema(), (64, 64))
        make_image(self.path('images/sample.tiff'))
        _, img = self.thumb('images/sample.tiff')
        img.close()

    def test_heic(self):
        try:
            make_image(self.path('images/sample.heic'))
        except (ImportError, KeyError, OSError, RuntimeError, ValueError) as exc:
            self.skipTest(f'HEIF encoder unavailable: {exc}')
        _, img = self.thumb('images/sample.heic')
        img.close()

    def test_avif(self):
        Image.init()
        if 'AVIF' not in Image.SAVE:
            self.skipTest('AVIF encoder unavailable')
        make_image(self.path('images/sample.avif'), fmt='AVIF')
        _, img = self.thumb('images/sample.avif')
        img.close()

    def test_errors_and_soft_failure(self):
        self.write('errors/broken.jpg', b'broken jpeg')
        self.write('errors/vector.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')
        self.write('errors/plain.txt', 'hello')
        for rel, status, code in [('errors/broken.jpg', 415, 'EINVAL'),
                                  ('errors/vector.svg', 415, 'EINVAL'),
                                  ('errors/plain.txt', 415, 'EINVAL'),
                                  ('errors/missing.jpg', 404, 'ENOENT')]:
            with self.subTest(path=rel):
                self.assertError(self.api.get('/api/thumb', path=rel), status, code)
                response = self.api.get('/api/thumb', path=rel, soft=1)
                self.assertEqual(response.status, 204)
                self.assertEqual(response.body, b'')
                self.assertEqual(response.headers['x-fi-error'], code)
        with patch.object(media, 'image_info', side_effect=AssertionError('repeated failed decode')):
            self.assertError(self.api.get('/api/thumb', path='errors/broken.jpg'), 415, 'EINVAL')


@unittest.skipUnless(ffmpeg.available() and ffmpeg.has_encoder('libx264'), 'ffmpeg/x264 unavailable')
class VideoTests(ServerTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        try:
            make_video(os.path.join(cls.root, 'movie.mp4'))
            make_video(os.path.join(cls.root, 'movie.avi'), vcodec='mpeg4', acodec='mp3')
            make_video(os.path.join(cls.root, 'portrait.mp4'), extra=['-vf', 'transpose=1'])
            # Display-matrix rotation (what phones write); the legacy `rotate` tag is ignored by ffmpeg 7
            ffmpeg.capture(['-y', '-display_rotation:v:0', '90', '-i', os.path.join(cls.root, 'movie.mp4'), '-map', '0',
                            '-c', 'copy', os.path.join(cls.root, 'rotated.mp4')], timeout=15)
        except BaseException:
            super().tearDownClass()
            raise

    def test_video_thumbs_and_probe(self):
        for rel in ('movie.mp4', 'movie.avi', 'portrait.mp4', 'rotated.mp4'):
            with self.subTest(path=rel):
                response = self.api.get('/api/thumb', path=rel, size=128)
                self.assertEqual(response.status, 200, response.text)
                self.assertAlmostEqual(float(response.headers['x-fi-duration']), 2, delta=0.15)
                with Image.open(io.BytesIO(response.body)) as img:
                    self.assertEqual(max(img.size), 128)
                    if rel in ('portrait.mp4', 'rotated.mp4'):
                        self.assertGreater(img.height, img.width)
                probe = self.api.get('/api/media/probe', path=rel)
                self.assertEqual(probe.status, 200, probe.text)
                info = probe.json()
                self.assertAlmostEqual(info['duration'], 2, delta=0.15)
                self.assertEqual(info['fps'], 25)
                if rel == 'movie.mp4':
                    self.assertEqual(info['vcodec'], 'h264')
                    self.assertEqual(info['acodec'], 'aac')
                    self.assertEqual((info['width'], info['height']), (320, 240))
                elif rel == 'rotated.mp4':
                    self.assertIn(info['rotation'], (90, 270))
                    self.assertEqual((info['width'], info['height']), (240, 320))

    def test_stream_and_start(self):
        for start in (0, 1):
            response = self.api.get('/api/media/stream', path='movie.avi', start=start)
            self.assertEqual(response.status, 200, response.text)
            self.assertEqual(response.headers['content-type'], 'video/mp4')
            self.assertEqual(response.headers['cache-control'], 'no-store')
            self.assertEqual(response.body[4:8], b'ftyp')
            self.assertIn(b'moof', response.body)
        make_image(self.path('stream-image.jpg'))
        self.assertError(self.api.get('/api/media/stream', path='stream-image.jpg'), 415, 'EINVAL')

    def test_disconnect_reaps_process(self):
        # A longer, noisy source keeps the pipe busy after the client stops reading.
        rel = 'disconnect.avi'
        make_video(self.path(rel), seconds=12, size=(640, 480), vcodec='mpeg4',
                   acodec=None, extra=['-q:v', '2'])
        query = urllib.parse.urlencode({'path': rel, 'ws': self.api.ws})
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        try:
            connection.request('GET', '/api/media/stream?' + query,
                               headers={'Cookie': self.api.cookie})
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            payload = response.read(200 * 1024)
            self.assertEqual(payload[4:8], b'ftyp')
            self.assertIn(b'moof', payload)
            response.close()
        finally:
            connection.close()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            with ffmpeg._active_lock:
                active = len(ffmpeg._active)
            if active == 0:
                break
            time.sleep(0.05)
        self.assertEqual(active, 0, 'stream ffmpeg process leaked after disconnect')

    def test_pregenerate(self):
        for n in range(3):
            make_image(self.path(f'pregenerate/{n}.jpg'), size=(160, 120))
        make_video(self.path('pregenerate/video.mp4'), seconds=0.4, size=(160, 120))
        for expected in ({'made': 4, 'cached': 0, 'failed': 0, 'total': 4},
                         {'made': 0, 'cached': 4, 'failed': 0, 'total': 4}):
            response = self.api.post('/api/thumbs/pregenerate',
                                     {'dirs': ['pregenerate'], 'size': 96})
            self.assertEqual(response.status, 202, response.text)
            job = self.api.wait_job(response.json(), timeout=10)
            self.assertEqual(job['state'], 'done', job)
            self.assertEqual(job['result'], expected)
            self.assertEqual(job['message'], '썸네일 만드는 중 (4/4)')


if __name__ == '__main__':
    unittest.main()
