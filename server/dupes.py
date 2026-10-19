"""Cached exact and perceptual duplicate detection."""
from __future__ import annotations

import contextvars
import hashlib
import math
import os
import stat
import time
from collections import defaultdict
from typing import Literal

import numpy as np
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr

from . import config, deps, ffmpeg, fsutil, mediacache, paths
from .errors import ApiError, from_os_error
from .jobs import JobManager
from .workspaces import Workspace

try:
    import faiss
except ImportError:
    faiss = None

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except Exception:
    pass

USE_FAISS = faiss is not None
_search_job = contextvars.ContextVar('dupes_search_job', default=None)
router = APIRouter()
_x = np.arange(32, dtype=np.float64)
_DCT = np.cos(np.pi * (_x[None, :] + 0.5) * _x[:, None] / 32) * math.sqrt(2 / 32)
_DCT[0] /= math.sqrt(2)
_POPCOUNT = np.array([i.bit_count() for i in range(256)], dtype=np.uint8)


def phash_gray(gray: np.ndarray) -> bytes:
    gray = np.asarray(gray)
    if gray.ndim != 2 or not gray.size:
        raise ValueError('Expected a nonempty two-dimensional image')
    if gray.shape != (32, 32):
        with Image.fromarray(gray.astype(np.float32)) as image:
            gray = np.asarray(image.resize((32, 32), Image.Resampling.LANCZOS))
    coefficients = (_DCT @ gray.astype(np.float64) @ _DCT.T)[:8, :8].ravel()
    return np.packbits(coefficients > np.median(coefficients[1:])).tobytes()


def phash_image(pil_image) -> bytes:
    image = ImageOps.exif_transpose(pil_image)
    try:
        with image.convert('L') as gray:
            with gray.resize((32, 32), Image.Resampling.LANCZOS) as small:
                return phash_gray(np.asarray(small))
    finally:
        if image is not pil_image:
            image.close()


def hamming(a: bytes, b: bytes) -> int:
    if len(a) != len(b):
        raise ValueError('Hashes must have equal lengths')
    return (int.from_bytes(a, 'big') ^ int.from_bytes(b, 'big')).bit_count()


def video_hash(abs_path, duration, job=None) -> bytes:
    if not duration or not math.isfinite(duration) or duration <= 0:
        raise ValueError('Video duration is unavailable')
    hashes = []
    for fraction in (0.1, 0.3, 0.5, 0.7, 0.9):
        if job is not None:
            job.check()
        raw = ffmpeg.capture([
            '-ss', str(duration * fraction), '-i', str(abs_path), '-frames:v', '1',
            '-vf', 'scale=64:64,format=gray', '-f', 'rawvideo', '-',
        ], inputs=[abs_path], job=job)
        if len(raw) != 4096:
            raise ValueError('Incomplete video frame')
        with Image.fromarray(np.frombuffer(raw, dtype=np.uint8).reshape(64, 64)) as frame:
            with frame.resize((32, 32), Image.Resampling.LANCZOS) as small:
                hashes.append(phash_gray(np.asarray(small)))
    return b''.join(hashes)


def blake2b_file(abs_path, job) -> bytes:
    digest = hashlib.blake2b(digest_size=20)
    with fsutil.open_shared(abs_path) as stream:
        while True:
            job.check()
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.digest()


def prehash(abs_path) -> bytes:
    digest = hashlib.blake2b(digest_size=20)
    with fsutil.open_shared(abs_path) as stream:
        digest.update(stream.read(65536))
        length = stream.seek(0, os.SEEK_END)
        stream.seek(max(0, length - 65536))
        digest.update(stream.read(65536))
    return digest.digest()


def find_pairs(codes: np.ndarray, radius) -> list[tuple[int, int, int]]:
    """Return unique ordered pairs with strict Hamming distance < radius."""
    codes = np.asarray(codes)
    if codes.ndim != 2 or codes.dtype != np.uint8 or codes.shape[1] == 0:
        raise ValueError('Expected an (n, nbytes) uint8 array')
    codes = np.ascontiguousarray(codes)
    pairs = []
    n = len(codes)
    job = _search_job.get()

    def check():
        if job is not None:
            job.check()

    check()
    if n < 2 or radius <= 0:
        return pairs
    if USE_FAISS and faiss is not None:
        index = faiss.IndexBinaryFlat(codes.shape[1] * 8)
        for start in range(0, n, 4096):
            check()
            index.add(codes[start:start + 4096])
        for start in range(0, n, 4096):
            check()
            limits, distances, indices = index.range_search(codes[start:start + 4096], radius)
            for offset in range(len(limits) - 1):
                check()
                i = start + offset
                for position in range(int(limits[offset]), int(limits[offset + 1])):
                    j = int(indices[position])
                    if j > i:
                        pairs.append((i, j, int(distances[position])))
    else:
        # At most roughly 4 MB of XOR bytes per block, including 320-bit codes.
        block = max(1, min(256, int(math.sqrt(4 * 1024 * 1024 / codes.shape[1]))))
        for start in range(0, n, block):
            left = codes[start:start + block]
            for end in range(start, n, block):
                check()
                right = codes[end:end + block]
                distances = _POPCOUNT[np.bitwise_xor(left[:, None, :], right[None, :, :])].sum(axis=2)
                rows, columns = np.nonzero(distances < radius)
                for a, b in zip(rows.tolist(), columns.tolist()):
                    i, j = start + a, end + b
                    if i < j:
                        pairs.append((i, j, int(distances[a, b])))
    check()
    pairs.sort()
    return pairs


class UnionFind:
    def __init__(self, size):
        self.parent = list(range(size))
        self.weight = [1] * size

    def find(self, value):
        while value != self.parent[value]:
            self.parent[value] = self.parent[self.parent[value]]
            value = self.parent[value]
        return value

    def union(self, a, b):
        a, b = self.find(a), self.find(b)
        if a == b:
            return
        if self.weight[a] < self.weight[b]:
            a, b = b, a
        self.parent[b] = a
        self.weight[a] += self.weight[b]


def _validate(ws, dirs, mode, threshold, videos):
    if mode not in ('exact', 'similar', 'both'):
        raise ApiError('EINVAL', '비교 방법을 확인해 주세요')
    if type(threshold) is not int or not 0 <= threshold <= 64:
        raise ApiError('EINVAL', '비슷한 정도는 0부터 64까지 정수로 골라 주세요')
    if not isinstance(dirs, list) or any(not isinstance(rel, str) for rel in dirs):
        raise ApiError('EINVAL', '검색할 폴더 목록을 확인해 주세요')
    if type(videos) is not bool:
        raise ApiError('EINVAL', '영상 포함 여부를 확인해 주세요')
    roots = []
    for rel in dirs:
        absolute = ws.resolve(rel)
        try:
            st = os.stat(absolute)
        except OSError as exc:
            raise from_os_error(exc, rel, noun='폴더')
        if not stat.S_ISDIR(st.st_mode):
            raise ApiError('EINVAL', '검색할 경로는 폴더여야 해요')
        roots.append(absolute)
    return roots


def _walk(ws, roots, videos, job, stats):
    files = []
    visited = set()
    seen_files = set()
    stack = list(reversed(roots))
    while stack:
        job.check()
        folder = stack.pop()
        key = os.path.normcase(folder)
        if key in visited or paths.is_link_like(folder):
            continue
        rel = ws.rel(folder)
        if any(config.is_hidden_name(part) for part in rel.split('/') if part):
            continue
        visited.add(key)
        try:
            with os.scandir(folder) as entries:
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
                                stack.append(entry.path)
                            continue
                        kind = config.media_type(entry.name)
                        if kind == 'other' or (kind == 'video' and not videos) or not entry.is_file():
                            continue
                        absolute = ws.resolve(ws.rel(entry.path))
                        identity = os.path.normcase(absolute)
                        if identity in seen_files:
                            continue
                        st = entry.stat()
                        seen_files.add(identity)
                        files.append({'path': ws.rel(absolute), 'abs': absolute, 'size': st.st_size,
                                      'mtime': fsutil.mtime_ms(st), 'type': kind})
                    except (OSError, ApiError):
                        stats['skipped'] += 1
        except OSError:
            stats['skipped'] += 1
        job.set_progress(min(0.049, len(visited) / (len(visited) + len(stack) + 1) * 0.05), '파일 찾는 중')
    return sorted(files, key=lambda item: item['path'])


def _metadata(item, cache, job):
    job.check()
    key = (item['path'], item['size'], item['mtime'])
    meta = cache.get_meta(*key) or {}
    required = ('width', 'height', 'duration')
    if any(field not in meta for field in required) or not meta.get('width') or not meta.get('height'):
        if item['type'] == 'image':
            with fsutil.open_shared(item['abs']) as stream, Image.open(stream) as image:
                width, height = image.size
                if image.getexif().get(0x0112) in (5, 6, 7, 8):
                    width, height = height, width
            values = {'width': width, 'height': height, 'duration': None}
        else:
            job.check()
            values = ffmpeg.probe(item['abs'])
            job.check()
        meta = {**meta, **values}
        cache.put_meta(*key, meta)
    item.update({field: meta.get(field) for field in required})


class _Hashes:
    def __init__(self, cache, stats, job):
        self.cache, self.stats, self.job = cache, stats, job
        self.pending = defaultdict(list)

    def get(self, item, kind, compute):
        self.job.check()
        key = (item['path'], item['size'], item['mtime'])
        value = self.cache.get_hash(*key, kind)
        if value is not None:
            self.stats['cached'] += 1
            return bytes(value)
        value = compute()
        self.job.check()
        current = os.stat(item['abs'])
        if (current.st_size, fsutil.mtime_ms(current)) != key[1:]:
            raise OSError('File changed during scan')
        self.stats['hashed'] += 1
        self.pending[kind].append((*key, value))
        if sum(map(len, self.pending.values())) >= 200:
            self.flush()
        return value

    def flush(self):
        for kind, rows in self.pending.items():
            if rows:
                self.cache.put_hashes(kind, rows)
        self.pending.clear()


def scan(ws, dirs, mode, threshold, videos, job) -> dict:
    started = time.perf_counter()
    roots = _validate(ws, dirs, mode, threshold, videos)
    stats = dict(files=0, images=0, videos=0, hashed=0, cached=0, skipped=0,
                 exactGroups=0, similarGroups=0, elapsed=0, faiss=False)
    job.set_progress(0, '파일 찾는 중')
    files = _walk(ws, roots, videos, job, stats)
    stats['files'] = len(files)
    stats['images'] = sum(item['type'] == 'image' for item in files)
    stats['videos'] = stats['files'] - stats['images']
    cache = mediacache.for_workspace(ws)
    hashes = _Hashes(cache, stats, job)
    failed = set()
    full = {}
    perceptual = {}
    union = UnionFind(len(files))

    def fail(i):
        if i not in failed:
            failed.add(i)
            stats['skipped'] += 1

    try:
        job.set_progress(0.05, '같은 파일 비교 중 (0/0)')
        if mode != 'similar':
            sizes = defaultdict(list)
            for i, item in enumerate(files):
                job.check()
                sizes[item['size']].append(i)
            candidates = [i for members in sizes.values() if len(members) > 1 for i in members]
            quick = defaultdict(list)
            for done, i in enumerate(candidates, 1):
                job.check()
                item = files[i]
                try:
                    value = hashes.get(item, 'prehash', lambda: prehash(item['abs']))
                    quick[(item['size'], value)].append(i)
                except (OSError, ValueError, ApiError):
                    fail(i)
                job.set_progress(0.05 + 0.12 * done / max(1, len(candidates)), f'같은 파일 비교 중 ({done}/{len(candidates)})')
            candidates = [i for members in quick.values() if len(members) > 1 for i in members]
            identical = defaultdict(list)
            for done, i in enumerate(candidates, 1):
                job.check()
                item = files[i]
                try:
                    full[i] = hashes.get(item, 'blake2b', lambda: blake2b_file(item['abs'], job))
                    identical[full[i]].append(i)
                except (OSError, ValueError, ApiError):
                    fail(i)
                job.set_progress(0.17 + 0.18 * done / max(1, len(candidates)), f'같은 파일 비교 중 ({done}/{len(candidates)})')
            for members in identical.values():
                for i in members[1:]:
                    job.check()
                    union.union(members[0], i)
        hashes.flush()
        if mode != 'exact':
            representatives = {}
            for i, item in enumerate(files):
                job.check()
                if i not in failed:
                    representatives.setdefault((union.find(i), item['type']), i)
            for kind, start, stop, message in (
                ('image', 0.35, 0.75, '비슷한 사진 분석 중'),
                ('video', 0.75, 0.95, '비슷한 영상 분석 중'),
            ):
                members = [i for (_, media_kind), i in representatives.items() if media_kind == kind]
                for done, i in enumerate(members, 1):
                    job.check()
                    item = files[i]
                    try:
                        if kind == 'image':
                            def compute():
                                with fsutil.open_shared(item['abs']) as stream, Image.open(stream) as image:
                                    image.draft('RGB', (256, 256))
                                    return phash_image(image)
                            perceptual[i] = hashes.get(item, 'phash', compute)
                        else:
                            def compute():
                                # Frame positions need the duration (probe once, cached in hashes.sqlite meta)
                                _metadata(item, cache, job)
                                return video_hash(item['abs'], item['duration'], job)
                            perceptual[i] = hashes.get(item, 'vhash', compute)
                    except (OSError, ValueError, SyntaxError, ApiError):
                        fail(i)
                    job.set_progress(start + (stop - start) * done / max(1, len(members)), f'{message} ({done}/{len(members)})')
                hashes.flush()
                # Copy each representative code to its exact copies before unioning similar edges.
                by_root = {union.find(i): perceptual[i] for i in members if i in perceptual}
                for i, item in enumerate(files):
                    job.check()
                    if i not in failed and item['type'] == kind and union.find(i) in by_root:
                        perceptual[i] = by_root[union.find(i)]
                searchable = [i for i in members if i in perceptual and i not in failed]
                if len(searchable) > 1:
                    codes = np.array([list(perceptual[i]) for i in searchable], dtype=np.uint8)
                    token = _search_job.set(job)
                    try:
                        edges = find_pairs(codes, threshold * (5 if kind == 'video' else 1) + 1)
                        stats['faiss'] = stats['faiss'] or bool(USE_FAISS and faiss is not None)
                    finally:
                        _search_job.reset(token)
                    for a, b, _ in edges:
                        job.check()
                        union.union(searchable[a], searchable[b])
        job.set_progress(0.95, '묶는 중')
        components = defaultdict(list)
        for i in range(len(files)):
            job.check()
            if i not in failed:
                components[union.find(i)].append(i)
        groups = []
        for members in components.values():
            job.check()
            if len(members) < 2:
                continue
            for i in members:
                # Only grouped files need width/height/duration (cheap header reads, cached)
                if 'width' not in files[i]:
                    try:
                        _metadata(files[i], cache, job)
                    except (OSError, ValueError, SyntaxError, ApiError):
                        files[i].update(width=None, height=None, duration=None)
            members.sort(key=lambda i: (-(files[i].get('width') or 0) * (files[i].get('height') or 0), -files[i]['size'], files[i]['mtime'], files[i]['path']))
            first = members[0]
            exact = first in full and all(i in full and full[i] == full[first] for i in members)
            kind = 'exact' if exact else 'similar'
            items = []
            for i in members:
                job.check()
                item = files[i]
                distance = 0
                if not exact and i in perceptual and first in perceptual:
                    distance = hamming(perceptual[first], perceptual[i])
                    if item['type'] == 'video':
                        distance = round(distance / 5, 1)
                items.append({**{key: item.get(key) for key in ('path', 'size', 'mtime', 'width', 'height', 'duration')}, 'distance': distance})
            groups.append({'kind': kind, 'items': items})
            stats['exactGroups' if exact else 'similarGroups'] += 1
        groups.sort(key=lambda group: (group['kind'] != 'exact', -len(group['items']), group['items'][0]['path']))
        job.check()
        stats['elapsed'] = time.perf_counter() - started
        job.set_progress(1, '묶는 중')
        return {'groups': groups, 'stats': stats}
    finally:
        hashes.flush()


class ScanBody(BaseModel):
    model_config = ConfigDict(extra='ignore')
    dirs: list[StrictStr] = Field(default_factory=lambda: [''])
    mode: Literal['exact', 'similar', 'both'] = 'both'
    threshold: StrictInt = Field(default=10, ge=0, le=64)
    videos: bool = Field(default=True, strict=True)


@router.post('/api/dupes/scan')
def scan_route(body: ScanBody, ws: Workspace = Depends(deps.workspace), jobs: JobManager = Depends(deps.jobs)):
    _validate(ws, body.dirs, body.mode, body.threshold, body.videos)
    job = jobs.submit('dupes.scan', lambda job: scan(ws, body.dirs, body.mode, body.threshold, body.videos, job), ws=ws, message='파일 찾는 중')
    return JSONResponse(job.to_dict(), status_code=202)
