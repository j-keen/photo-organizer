"""Job API lifecycle and cancellation integration tests."""
import os
import re
import time
import unittest

from server import ffmpeg
from server.tests.helpers import ServerTestCase, make_video


@unittest.skipUnless(ffmpeg.available(), 'ffmpeg unavailable')
class JobsTests(ServerTestCase):
    def tearDown(self):
        deadline = time.monotonic() + 5
        while True:
            leftovers = [os.path.join(d, f) for d, _, files in os.walk(self.root) for f in files if f.startswith('.fi-tmp-')]
            with ffmpeg._active_lock:
                active = list(ffmpeg._active)
            if not leftovers and not active:
                break
            if time.monotonic() >= deadline:
                break
            time.sleep(0.02)
        self.assertEqual(leftovers, [])
        self.assertEqual(active, [])
        super().tearDown()

    def submit_trim(self, path, end, mode='accurate'):
        response = self.api.post('/api/video/trim', {'path': path, 'start': 0, 'end': end, 'mode': mode})
        self.assertEqual(response.status, 202, response.text)
        return response.json()

    def test_list_shape_and_finished_cancel(self):
        make_video(self.path('jobs-short.mp4'), seconds=1, size=(128, 96))
        first = self.submit_trim('jobs-short.mp4', 0.5)
        done = self.api.wait_job(first, timeout=15)
        self.assertEqual(done['state'], 'done', done)
        second = self.submit_trim('jobs-short.mp4', 0.6)
        self.assertEqual(self.api.wait_job(second, timeout=15)['state'], 'done')
        response = self.api.get('/api/jobs')
        self.assertEqual(response.status, 200, response.text)
        listed = response.json()
        ids = [job['id'] for job in listed]
        self.assertLess(ids.index(second['id']), ids.index(first['id']))
        created = [job['createdAt'] for job in listed]
        self.assertEqual(created, sorted(created, reverse=True))
        response = self.api.get('/api/jobs/' + first['id'])
        self.assertEqual(response.status, 200, response.text)
        job = response.json()
        self.assertEqual(set(job), {'id', 'kind', 'state', 'progress', 'message', 'result', 'error', 'createdAt', 'finishedAt'})
        self.assertEqual(job['id'], first['id'])
        self.assertEqual(job['kind'], 'video.trim')
        self.assertEqual(job['progress'], 1)
        self.assertIsNone(job['error'])
        self.assertIsInstance(job['result'], dict)
        self.assertIsInstance(job['createdAt'], int)
        self.assertGreaterEqual(job['finishedAt'], job['createdAt'])
        response = self.api.post('/api/jobs/' + first['id'] + '/cancel')
        self.assertEqual(response.status, 200, response.text)
        self.assertEqual(response.json(), {'ok': True, 'state': 'done'})
        self.assertError(self.api.get('/api/jobs/not-a-job'), 404, 'ENOENT')
        self.assertError(self.api.post('/api/jobs/not-a-job/cancel'), 404, 'ENOENT')

    def test_cancel_accurate_trim(self):
        src = self.path('jobs-long.mp4')
        make_video(src, seconds=20, size=(640, 480), extra=['-preset', 'ultrafast'])
        submitted = self.submit_trim('jobs-long.mp4', 19.5)
        # Wait for the actual encoder rather than cancelling only a queued task.
        deadline = time.monotonic() + 3
        encoder = None
        while time.monotonic() < deadline:
            with ffmpeg._active_lock:
                candidates = [p for p, inputs in ffmpeg._active.items() if src in inputs and '-progress' in p.args]
            if candidates:
                encoder = candidates[0]
                break
            time.sleep(0.005)
        self.assertIsNotNone(encoder, 'Trim encoder did not start')
        response = self.api.post('/api/jobs/' + submitted['id'] + '/cancel')
        self.assertEqual(response.status, 200, response.text)
        job = self.api.wait_job(submitted, timeout=10)
        self.assertEqual(job['state'], 'cancelled', job)
        self.assertIsNone(job['result'])
        self.assertFalse(os.path.exists(self.path('jobs-long_cut01.mp4')))
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            with ffmpeg._active_lock:
                active = bool(ffmpeg._active)
            if not active and encoder.poll() is not None:
                break
            time.sleep(0.02)
        with ffmpeg._active_lock:
            self.assertFalse(ffmpeg._active)
        self.assertIsNotNone(encoder.poll())

    def test_corrupt_video_error_job(self):
        # Source validation rejects corrupt inputs synchronously. Submit a real
        # failing ffmpeg task directly to exercise the independent job contract.
        src = self.write('jobs-corrupt.mp4', b'not a video')
        manager = self.srv.app.state.jobs

        def work(job):
            ffmpeg.run(['-i', src, '-f', 'null', '-'], job=job, inputs=[src])

        submitted = manager.submit('video.trim', work, ws=self.srv.app.state.registry.current)
        job = self.api.wait_job(submitted.id, timeout=10)
        self.assertEqual(job['state'], 'error', job)
        self.assertIsNone(job['result'])
        self.assertTrue(job['error']['code'])
        self.assertIsNotNone(re.search('[가-힣]', job['error']['message']))
        self.assertIsInstance(job['finishedAt'], int)
