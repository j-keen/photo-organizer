"""Media inspection, cached thumbnails, and cancellable video streams."""
from __future__ import annotations

import hashlib
import io
import math
import os
import stat
import threading
import time
from collections import OrderedDict
from contextlib import contextmanager
from datetime import datetime

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from PIL import Image, ImageOps
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from . import config, deps, ffmpeg, fsutil, mediacache, paths
from .errors import ApiError, from_os_error
from .http_utils import bytes_response
from .jobs import JobManager
from .workspaces import Workspace

router = APIRouter()
_images = threading.BoundedSemaphore(4)
_videos = threading.BoundedSemaphore(2)
_streams = threading.BoundedSemaphore(3)
_guard = threading.Lock()
_locks: dict[str, list] = {}
_failures: OrderedDict[str, float] = OrderedDict()
_UNSUPPORTED = '썸네일을 만들 수 없는 형식이에요'
_BROKEN = '썸네일을 만들 수 없어요 (손상된 파일일 수 있어요)'
_PROBE_KEYS = ('width', 'height', 'duration', 'fps', 'vcodec', 'acodec', 'rotation',
               'taken', 'camera', 'bitrate', 'format', 'hasAudio')


def _size(value: int) -> int:
    return max(32, min(4096, value))


@contextmanager
def _key_lock(key):
    with _guard:
        entry = _locks.setdefault(key, [threading.Lock(), 0])
        entry[1] += 1
    try:
        with entry[0]:
            yield
    finally:
        with _guard:
            entry[1] -= 1
            if not entry[1]:
                del _locks[key]


def _source(ws, rel):
    absolute = ws.resolve(rel)
    rel = ws.rel(absolute)
    try:
        st = os.stat(absolute)
    except OSError as exc:
        raise from_os_error(exc, rel, noun='파일') from exc
    if not stat.S_ISREG(st.st_mode):
        raise ApiError('EINVAL', _UNSUPPORTED, status=415)
    if config.media_type(rel) == 'other' or config.ext_of(rel) == 'svg':
        raise ApiError('EINVAL', _UNSUPPORTED, status=415)
    return rel, absolute, st


def _cache_path(ws, rel, st, size):
    value = f'{rel}|{st.st_size}|{fsutil.mtime_ms(st)}|{size}'
    digest = hashlib.sha1(value.encode('utf-8')).hexdigest()
    # Validate the data directory too: it could have been replaced by a link.
    return ws.resolve(f'{config.DATA_DIR_NAME}/thumbs/{digest}.webp')


def _text(value):
    if isinstance(value, bytes):
        value = value.decode('utf-8', 'replace')
    return str(value).strip(' \x00') if value else ''


def image_info(abs_path) -> dict:
    """Read image headers and EXIF without decoding pixels."""
    with fsutil.open_shared(abs_path) as handle, Image.open(handle) as img:
        width, height = img.size
        exif = img.getexif()
        if exif.get(0x0112) in (5, 6, 7, 8):
            width, height = height, width
        try:
            detail = exif.get_ifd(0x8769)
        except (ValueError, TypeError, KeyError, OSError):
            detail = {}
        date = _text(detail.get(0x9003) or exif.get(0x9003))
        offset = _text(detail.get(0x9011) or exif.get(0x9011))
        taken = None
        if date:
            try:
                dt = datetime.strptime(date, '%Y:%m:%d %H:%M:%S')
                if offset:
                    dt = datetime.fromisoformat(dt.isoformat() + offset)
                taken = int(dt.timestamp() * 1000)
            except (ValueError, OverflowError, OSError):
                pass
        make, model = _text(exif.get(0x010F)), _text(exif.get(0x0110))
        camera = model if make and model.casefold().startswith(make.casefold()) else ' '.join(x for x in (make, model) if x)
        return dict(width=width, height=height, taken=taken, camera=camera or None,
                    format=img.format, duration=None, fps=None, vcodec=None, acodec=None,
                    rotation=0, bitrate=None, hasAudio=False)


def _load_image(abs_path, size=None):
    with fsutil.open_shared(abs_path) as handle, Image.open(handle) as img:
        img.seek(0)
        if size is not None and img.format == 'JPEG':
            img.draft('RGB', (size, size))
        img.load()
        oriented = ImageOps.exif_transpose(img)
        try:
            return oriented.copy()
        finally:
            if oriented is not img:
                oriented.close()


def open_image(abs_path) -> Image.Image:
    """Return an owned, fully loaded, oriented first frame."""
    return _load_image(abs_path)


def media_info(ws, rel, abs_path, st) -> dict:
    cache = mediacache.for_workspace(ws)
    mtime = fsutil.mtime_ms(st)
    meta = cache.get_meta(rel, st.st_size, mtime) or {}
    if isinstance(meta.get('probe'), dict):
        return dict(meta['probe'])
    if config.media_type(rel) == 'video':
        with _videos:
            info = ffmpeg.probe(abs_path, st)
    else:
        with _images:
            info = image_info(abs_path)
    meta.update(info)
    meta['probe'] = info
    cache.put_meta(rel, st.st_size, mtime, meta)
    return dict(info)


def _webp(img, size):
    converted = img.convert('RGBA' if img.mode in ('P', 'LA', 'RGBA', 'PA') or 'transparency' in img.info else 'RGB')
    try:
        converted.thumbnail((size, size), Image.Resampling.LANCZOS, reducing_gap=2.0)
        out = io.BytesIO()
        converted.save(out, 'WEBP', quality=82, method=4)
        return out.getvalue()
    finally:
        converted.close()


def _video_frame(absolute, size, info):
    duration = info.get('duration')
    seek = min(3.0, duration * 0.1) if duration and duration > 0 else 0.0
    scale = f"scale='min({size},iw)':'min({size},ih)':force_original_aspect_ratio=decrease"
    # ffmpeg rounds scaled dimensions; extreme aspect ratios must stay nonzero.
    width, height = info.get('width'), info.get('height')
    if width and height and min(width, height) * min(1, size / max(width, height)) < 1:
        factor = min(1, size / max(width, height))
        scale = f'scale={max(1, round(width * factor))}:{max(1, round(height * factor))}'
    for t in (seek, 0.0) if seek else (0.0,):
        data = ffmpeg.capture(['-ss', f'{t:.3f}', '-i', absolute, '-frames:v', '1',
                               '-vf', scale, '-f', 'image2pipe', '-c:v', 'png', '-'],
                              inputs=[absolute], timeout=30)
        if data:
            with Image.open(io.BytesIO(data)) as img:
                img.load()
                return _webp(img, size)
    raise ApiError('EINVAL', _BROKEN, status=415)


def make_thumbnail(ws, rel, size) -> tuple[bytes, dict]:
    size = _size(size)
    rel, absolute, st = _source(ws, rel)
    target = _cache_path(ws, rel, st, size)
    with _key_lock(target):
        try:
            with fsutil.open_shared(target) as handle:
                data = handle.read()
        except FileNotFoundError:
            data = None
        except OSError as exc:
            raise from_os_error(exc, rel, noun='파일') from exc
        if data is not None:
            # Header-only image inspection is sufficient when SQLite metadata was lost.
            return data, media_info(ws, rel, absolute, st)
        now = time.monotonic()
        with _guard:
            while _failures and next(iter(_failures.values())) <= now:
                _failures.popitem(last=False)
            failed = target in _failures
        if failed:
            raise ApiError('EINVAL', _BROKEN, status=415)
        try:
            info = media_info(ws, rel, absolute, st)
            if config.media_type(rel) == 'video':
                with _videos:
                    data = _video_frame(absolute, size, info)
            else:
                with _images, _load_image(absolute, size) as img:
                    data = _webp(img, size)
        except (ApiError, OSError, ValueError, SyntaxError, Image.DecompressionBombError) as exc:
            if isinstance(exc, ApiError) and exc.code in ('ENOTSUP', 'EPERM', 'ENOENT'):
                raise
            if isinstance(exc, (FileNotFoundError, PermissionError)):
                raise from_os_error(exc, rel, noun='파일') from exc
            with _guard:
                _failures[target] = time.monotonic() + 600
                _failures.move_to_end(target)
                while len(_failures) > 4096:
                    _failures.popitem(last=False)
            raise ApiError('EINVAL', _BROKEN, status=415) from exc
        try:
            fsutil.atomic_write(target, [data])
        except OSError as exc:
            raise from_os_error(exc, rel, noun='파일') from exc
        return data, info


def _headers(info):
    return {f'X-FI-{name.title()}': str(info[name]) for name in ('width', 'height', 'duration')
            if info.get(name) is not None}


@router.get('/api/thumb')
def thumb(request: Request, path: str, size: int = 360, v: str | None = None,
          soft: int = 0, ws: Workspace = Depends(deps.workspace)):
    try:
        data, info = make_thumbnail(ws, path, size)
    except ApiError as exc:
        if soft == 1:
            return Response(status_code=204, headers={'X-FI-Error': exc.code, 'Cache-Control': 'no-store'})
        raise
    return bytes_response(request, data, 'image/webp', headers=_headers(info),
                          cache_control='private, max-age=31536000, immutable' if v is not None else 'no-cache')


def _probe(ws, path):
    rel, absolute, st = _source(ws, path)
    try:
        info = media_info(ws, rel, absolute, st)
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as exc:
        if isinstance(exc, (FileNotFoundError, PermissionError)):
            raise from_os_error(exc, rel, noun='파일') from exc
        raise ApiError('EINVAL', '파일 정보를 읽을 수 없어요. 손상된 파일일 수 있어요', status=415) from exc
    return {**{key: info.get(key) for key in _PROBE_KEYS},
            'size': st.st_size, 'mtime': fsutil.mtime_ms(st)}


@router.get('/api/media/probe')
def probe(path: str, soft: int = 0, ws: Workspace = Depends(deps.workspace)):
    try:
        return _probe(ws, path)
    except ApiError as exc:
        # ★ soft=1: the inspector may ask about a file that was just moved/trashed — answer quietly
        if soft == 1:
            return Response(status_code=204, headers={'X-FI-Error': exc.code, 'Cache-Control': 'no-store'})
        raise


class _VideoResponse(StreamingResponse):
    """ASGI-level cleanup also covers disconnects before iteration starts."""
    def __init__(self, iterator, cleanup, headers):
        self.cleanup = cleanup
        super().__init__(iterator, media_type='video/mp4', headers=headers)

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            await run_in_threadpool(self.cleanup)


@router.get('/api/media/stream')
def stream(path: str, start: float = 0, ws: Workspace = Depends(deps.workspace)):
    rel, absolute, st = _source(ws, path)
    if config.media_type(rel) != 'video':
        raise ApiError('EINVAL', '영상 파일만 재생할 수 있어요', status=415)
    if not math.isfinite(start) or start < 0:
        raise ApiError('EINVAL', '재생 시작 시간을 확인해 주세요')
    if not _streams.acquire(blocking=False):
        raise ApiError('EBUSY', '이미 영상 세 개를 재생하고 있어요. 잠시 후 다시 해 주세요')
    proc = None
    cleanup_lock = threading.Lock()
    cleaned = False

    def cleanup():
        nonlocal cleaned
        with cleanup_lock:
            if cleaned:
                return
            cleaned = True
            try:
                if proc is not None:
                    ffmpeg.reap(proc)
            finally:
                _streams.release()

    try:
        info = media_info(ws, rel, absolute, st)
        if not info.get('hasVideo'):
            raise ApiError('EINVAL', '재생할 영상이 없어요', status=415)
        args = ['-ss', str(start)] if start else []
        args += ['-i', absolute, '-map', '0:v:0', '-map', '0:a:0?']
        if info.get('vcodec') == 'h264':
            args += ['-c:v', 'copy']
        else:
            args += ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
                     '-pix_fmt', 'yuv420p', '-vf', "scale='min(1920,iw)':-2"]
        if not info.get('hasAudio'):
            args += ['-an']
        elif info.get('acodec') in ('aac', 'mp3'):
            args += ['-c:a', 'copy']
        else:
            args += ['-c:a', 'aac', '-b:a', '160k', '-ac', '2']
        args += ['-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1']
        proc = ffmpeg.popen(args, inputs=[absolute])

        def chunks():
            try:
                while True:
                    try:
                        chunk = proc.stdout.read(64 * 1024)
                    except (OSError, ValueError):  # pipe closed by cleanup() after a disconnect
                        break
                    if not chunk:
                        break
                    yield chunk
            finally:
                cleanup()

        headers = {'Cache-Control': 'no-store'}
        if info.get('duration') is not None:
            headers['X-FI-Duration'] = str(info['duration'])
        return _VideoResponse(chunks(), cleanup, headers)
    except BaseException:
        cleanup()
        raise


class PregenerateBody(BaseModel):
    model_config = ConfigDict(extra='ignore')
    dirs: list[str] = Field(default_factory=lambda: [''])
    size: int = 360


def _walk(ws, absolute, job):
    job.check()
    with os.scandir(absolute) as entries:
        for entry in entries:
            job.check()
            if config.is_hidden_name(entry.name):
                continue
            try:
                linked = paths.is_link_like(entry.path)
                if linked and not paths.link_stays_inside(entry.path, ws.root):
                    continue
                if entry.is_dir():
                    if not linked:
                        yield from _walk(ws, entry.path, job)
                elif entry.is_file() and config.media_type(entry.name) != 'other':
                    yield ws.rel(entry.path)
            except FileNotFoundError:
                continue


@router.post('/api/thumbs/pregenerate')
def pregenerate(body: PregenerateBody, ws: Workspace = Depends(deps.workspace),
                jobs: JobManager = Depends(deps.jobs)):
    directories = []
    for rel in body.dirs:
        absolute = ws.resolve(rel)
        try:
            st = os.stat(absolute)
        except OSError as exc:
            raise from_os_error(exc, rel, noun='폴더') from exc
        if not stat.S_ISDIR(st.st_mode):
            raise ApiError('EINVAL', '썸네일을 만들 폴더를 골라 주세요')
        # Explicitly supplied hidden directories obey the same walking rules.
        if any(config.is_hidden_name(part) for part in ws.rel(absolute).split('/') if part):
            continue
        if paths.is_link_like(absolute):
            continue
        directories.append(absolute)
    size = _size(body.size)

    def work(job):
        files = sorted({rel for directory in directories for rel in _walk(ws, directory, job)})
        result = dict(made=0, cached=0, failed=0, total=len(files))
        job.set_progress(0, f'썸네일 만드는 중 (0/{len(files)})')
        for n, rel in enumerate(files, 1):
            job.check()
            try:
                canonical, absolute, st = _source(ws, rel)
                target = _cache_path(ws, canonical, st, size)
                if os.path.isfile(target):
                    result['cached'] += 1
                else:
                    make_thumbnail(ws, rel, size)
                    result['made'] += 1
            except (ApiError, OSError):
                result['failed'] += 1
            job.check()
            job.set_progress(n / len(files), f'썸네일 만드는 중 ({n}/{len(files)})')
        return result

    job = jobs.submit('thumbs.pregenerate', work, ws=ws, message='파일 찾는 중')
    return JSONResponse(job.to_dict(), status_code=202)
