"""Test helpers: a real server on a free port (uvicorn in a thread) + an HTTP client that behaves like the app.

    class MyTest(ServerTestCase):
        def test_x(self):
            r = self.api.get('/api/fs/list', path='')
            self.assertEqual(r.status, 200, r.text)

Run all server tests:   server\\.venv\\Scripts\\python.exe -m unittest discover -s server/tests -t .
"""
from __future__ import annotations

import http.client
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.parse
from pathlib import Path

import uvicorn

from server import ffmpeg
from server.app import create_app
from server.config import Settings


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class Response:
    def __init__(self, status: int, headers: dict, body: bytes) -> None:
        self.status = status
        self.headers = headers  # lower-case keys
        self.body = body

    @property
    def text(self) -> str:
        return self.body.decode('utf-8', 'replace')

    def json(self):
        return json.loads(self.body.decode('utf-8'))

    def __repr__(self) -> str:
        return f'<Response {self.status} {self.text[:200]}>'


class Client:
    """Minimal HTTP client with the app's headers (Host, cookie, X-FI-Client, Sec-Fetch-Site, ws token)."""

    def __init__(self, port: int) -> None:
        self.port = port
        self.cookie: str | None = None
        self.ws: str | None = None

    def request(self, method: str, url_path: str, *, query: dict | None = None, json_body=None, body: bytes | None = None,
                headers: dict | None = None, host: str | None = None, cookie: bool = True, client_header: bool = True,
                ws: bool = True, timeout: float = 120) -> Response:
        q = dict(query or {})
        if ws and self.ws and url_path.startswith(('/api/fs', '/api/thumb', '/api/media', '/api/video', '/api/dupes', '/api/thumbs')) and 'ws' not in q:
            q['ws'] = self.ws
        url = url_path + ('?' + urllib.parse.urlencode(q) if q else '')
        h = {'Host': host or f'127.0.0.1:{self.port}'}
        if cookie and self.cookie:
            h['Cookie'] = self.cookie
        if client_header and method not in ('GET', 'HEAD'):
            h['X-FI-Client'] = '1'
        data = body
        if json_body is not None:
            data = json.dumps(json_body).encode('utf-8')
            h['Content-Type'] = 'application/json'
        if headers:
            h.update(headers)
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=timeout)
        try:
            conn.request(method, url, body=data, headers=h)
            resp = conn.getresponse()
            payload = resp.read()
            hdrs = {}
            for k, v in resp.getheaders():
                k = k.lower()
                hdrs[k] = hdrs[k] + ', ' + v if k in hdrs and k != 'set-cookie' else v
            return Response(resp.status, hdrs, payload)
        finally:
            conn.close()

    def get(self, url_path: str, **query) -> Response:
        """GET with query parameters as keyword arguments, e.g. api.get('/api/fs/stat', path='a.jpg')."""
        return self.request('GET', url_path, query=query)

    def post(self, url_path: str, json_body=None, **kw) -> Response:
        return self.request('POST', url_path, json_body=json_body if json_body is not None else {}, **kw)

    def put(self, url_path: str, body: bytes, **query) -> Response:
        return self.request('PUT', url_path, query=query, body=body)

    def session(self, site: str = 'same-origin') -> Response:
        r = self.request('GET', '/api/session', headers={'Sec-Fetch-Site': site}, cookie=False)
        sc = r.headers.get('set-cookie')
        if r.status == 200 and sc:
            self.cookie = sc.split(';', 1)[0]
        return r

    def open_workspace(self, root: str) -> dict:
        r = self.post('/api/workspace/open', {'root': str(root)})
        if r.status != 200:
            raise AssertionError(f'open workspace failed: {r}')
        data = r.json()
        self.ws = data['token']
        return data

    def wait_job(self, job: dict | str, timeout: float = 120) -> dict:
        job_id = job['id'] if isinstance(job, dict) else job
        deadline = time.time() + timeout
        while time.time() < deadline:
            r = self.get(f'/api/jobs/{job_id}')
            if r.status != 200:
                raise AssertionError(f'job lookup failed: {r}')
            data = r.json()
            if data['state'] != 'running':
                return data
            time.sleep(0.1)
        raise AssertionError(f'job {job_id} did not finish in {timeout}s')


class RunningServer:
    def __init__(self, data_dir: str, app_root: Path | None = None) -> None:
        self.port = free_port()
        kwargs = {'port': self.port, 'data_dir': Path(data_dir), 'dry_shell': True}
        if app_root:
            kwargs['app_root'] = app_root
        self.settings = Settings(**kwargs)
        self.app = create_app(self.settings)
        config = uvicorn.Config(self.app, host='127.0.0.1', port=self.port, log_level='error', access_log=False, lifespan='on')
        self.server = uvicorn.Server(config)
        self.app.state.request_shutdown = lambda: setattr(self.server, 'should_exit', True)
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def start(self) -> 'RunningServer':
        self.thread.start()
        deadline = time.time() + 20
        while not self.server.started:
            if time.time() > deadline:
                raise RuntimeError('server did not start')
            time.sleep(0.02)
        return self

    def stop(self) -> None:
        self.server.should_exit = True
        self.thread.join(timeout=10)


class ServerTestCase(unittest.TestCase):
    """Starts one server per test class with a fresh temp workspace (self.root) and an opened session (self.api)."""

    open_workspace = True

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.mkdtemp(prefix='fi-test-')
        cls.root = os.path.join(cls.tmp, '작업 폴더')  # non-ASCII on purpose
        os.makedirs(cls.root)
        cls.data_dir = os.path.join(cls.tmp, 'appdata')
        cls.srv = RunningServer(cls.data_dir).start()
        cls.port = cls.srv.port

    @classmethod
    def tearDownClass(cls) -> None:
        cls.srv.stop()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self) -> None:
        self.api = Client(self.port)
        r = self.api.session()
        self.assertEqual(r.status, 200, r.text)
        if self.open_workspace:
            self.api.open_workspace(self.root)

    # ----- filesystem fixtures -----
    def path(self, rel: str) -> str:
        return os.path.join(self.root, *rel.split('/'))

    def write(self, rel: str, data: bytes | str = b'x') -> str:
        p = self.path(rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'wb') as f:
            f.write(data.encode('utf-8') if isinstance(data, str) else data)
        return p

    def assertError(self, resp: Response, status: int, code: str) -> None:
        self.assertEqual(resp.status, status, resp.text)
        self.assertEqual(resp.json()['error']['code'], code, resp.text)
        self.assertTrue(resp.json()['error']['message'])


# ----- media fixtures -----
def make_image(path: str, size=(640, 480), color=(200, 60, 40), fmt: str | None = None, *, pattern: int | None = None,
               quality: int = 92, exif_orientation: int | None = None, exif_datetime: str | None = None, camera: tuple[str, str] | None = None) -> str:
    """Write a test image. `pattern` (seed) draws distinctive shapes so perceptual hashes differ between seeds."""
    from PIL import Image, ImageDraw

    img = Image.new('RGB', size, color)
    d = ImageDraw.Draw(img)
    if pattern is not None:
        import random

        rnd = random.Random(pattern)
        w, h = size
        for _ in range(14):
            x0, y0 = rnd.randrange(w), rnd.randrange(h)
            x1, y1 = x0 + rnd.randrange(w // 8, w // 2), y0 + rnd.randrange(h // 8, h // 2)
            fill = tuple(rnd.randrange(256) for _ in range(3))
            (d.ellipse if rnd.random() < 0.5 else d.rectangle)([x0, y0, x1, y1], fill=fill)
    else:
        d.rectangle([size[0] // 4, size[1] // 4, size[0] // 2, size[1] // 2], fill=(255, 255, 255))
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    fmt = fmt or {'.jpg': 'JPEG', '.jpeg': 'JPEG', '.png': 'PNG', '.webp': 'WEBP', '.tif': 'TIFF', '.tiff': 'TIFF', '.heic': 'HEIF', '.bmp': 'BMP', '.gif': 'GIF'}.get(os.path.splitext(path)[1].lower(), 'PNG')
    kw = {}
    if fmt in ('JPEG', 'WEBP', 'HEIF'):
        kw['quality'] = quality
    if exif_orientation or exif_datetime or camera:
        exif = Image.Exif()
        if exif_orientation:
            exif[0x0112] = exif_orientation
        if camera:
            exif[0x010F], exif[0x0110] = camera
        if exif_datetime:
            exif.get_ifd(0x8769)[0x9003] = exif_datetime
        kw['exif'] = exif.tobytes()
    if fmt == 'HEIF':
        import pillow_heif

        pillow_heif.register_heif_opener()
    img.save(path, fmt, **kw)
    return path


def make_video(path: str, seconds: float = 2.0, size=(320, 240), fps: int = 25, *, vcodec: str = 'libx264', acodec: str | None = 'aac',
               source: str = 'testsrc', extra: list[str] | None = None) -> str:
    """Write a short test video with the bundled ffmpeg (lavfi testsrc + sine audio)."""
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    args = [ffmpeg.exe(), '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', f'{source}=duration={seconds}:size={size[0]}x{size[1]}:rate={fps}']
    if acodec:
        args += ['-f', 'lavfi', '-i', f'sine=frequency=440:duration={seconds}']
    args += ['-c:v', vcodec]
    if vcodec in ('libx264', 'libx265'):
        args += ['-pix_fmt', 'yuv420p', '-g', str(fps)]
    if acodec:
        args += ['-c:a', acodec, '-shortest']
    args += list(extra or [])
    args.append(path)
    subprocess.run(args, check=True, capture_output=True, **ffmpeg.popen_kwargs())
    return path
