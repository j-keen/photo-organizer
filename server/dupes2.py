"""Incremental duplicate fingerprints and duplicate detection for API v2."""
from __future__ import annotations

import hashlib
import io
import math
import os
import time
from collections import defaultdict
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass

import numpy as np
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, Response
from PIL import Image, ImageOps
from pydantic import BaseModel, ConfigDict, StrictStr, ValidationError
from starlette.concurrency import run_in_threadpool

from . import config, deps, dupes, errors, external, ffmpeg, fsutil, http_utils, mediacache, paths, routes_workspace
from .errors import ApiError
from .jobs import JobManager
from .workspaces import Workspace

ENGINE = 'server-v2'
POSITIONS = (0.15, 0.35, 0.50, 0.65, 0.85)
DEFAULT_RULES = dict(durationTolSec=2, durationTolPct=1, frameBits=10, minFrames=3,
                     flatStd=4, minDuration=1, sureDurationSec=0.3, imageBits=10,
                     keep=['resolution', 'duration', 'size'])
router = APIRouter()
_READ_ERRORS = (OSError, ValueError, SyntaxError, ApiError)


@dataclass
class Ctx:
    ws: Workspace
    external: object
    ws_cache: object
    ext_cache: object


def normalize_rules(rules):
    """Validate recognized rules, ignoring keys from future client versions."""
    if rules is None:
        rules = {}
    if not isinstance(rules, dict):
        raise ApiError('EINVAL', '규칙 값을 확인해 주세요 (rules)')
    result = {**DEFAULT_RULES, 'keep': list(DEFAULT_RULES['keep'])}
    for key, value in rules.items():
        if key not in result:
            continue
        valid = False
        if key == 'keep':
            valid = (isinstance(value, list) and all(isinstance(v, str) and v in
                     ('resolution', 'duration', 'size') for v in value)
                     and len(set(value)) == len(value))
        elif key in ('frameBits', 'minFrames', 'imageBits'):
            lower, upper = (1, 5) if key == 'minFrames' else (0, 64)
            valid = type(value) is int and lower <= value <= upper
        elif type(value) in (int, float):
            try:
                valid = value >= 0 and math.isfinite(value)
            except OverflowError:
                valid = False
        if not valid:
            raise ApiError('EINVAL', f'규칙 값을 확인해 주세요 ({key})')
        result[key] = list(value) if key == 'keep' else value
    return result


def quick_hash(abs_path, size):
    digest = hashlib.blake2b(digest_size=16)
    with fsutil.open_shared(abs_path) as stream:
        digest.update(stream.read(1 << 20))
        if size > 2 << 20:
            stream.seek(-(1 << 20), os.SEEK_END)
            digest.update(stream.read(1 << 20))
    digest.update(str(size).encode())
    return digest.hexdigest()


def full_hash(abs_path, job=None):
    digest = hashlib.blake2b(digest_size=16)
    with fsutil.open_shared(abs_path) as stream:
        while True:
            if job is not None:
                job.check()
            chunk = stream.read(8 << 20)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def dhash_bytes(px: bytes):
    if len(px) != 72:
        raise ValueError('Expected a 9 by 8 grayscale frame')
    bits = 0
    for row in range(8):
        for col in range(8):
            bits = (bits << 1) | int(px[row * 9 + col] > px[row * 9 + col + 1])
    mean = sum(px) / 72
    return bits, math.sqrt(sum((v - mean) ** 2 for v in px) / 72)


def frame_sample(abs_path, t, job=None):
    if job is not None:
        job.check()
    try:
        raw = ffmpeg.capture(['-ss', '%.2f' % t, '-i', abs_path, '-frames:v', '1',
                              '-vf', 'scale=9:8:flags=area,format=gray', '-f', 'rawvideo', '-'],
                             inputs=[abs_path], job=job, timeout=60)
        if len(raw) == 72:
            bits, std = dhash_bytes(raw)
            return [t, f'{bits:016x}', round(std, 2)]
    except ApiError:
        if job is not None:
            job.check()
    return [t, None, None]


def video_frames(abs_path, duration, job=None):
    return [frame_sample(abs_path, duration * p, job) for p in POSITIONS]


def same_video(a, b, rules):
    da, db = a.get('duration'), b.get('duration')
    if not da or not db or min(da, db) <= rules['minDuration']:
        return 0, []
    if abs(da - db) > max(rules['durationTolSec'], rules['durationTolPct'] / 100 * max(da, db)):
        return 0, []
    compared = same = 0
    evidence = []
    for i, p in enumerate(POSITIONS):
        fa = a.get('frames', [])
        fb = b.get('frames', [])
        ta, ba, sa = fa[i] if i < len(fa) else (da * p, None, None)
        tb, bb, sb = fb[i] if i < len(fb) else (db * p, None, None)
        distance = None
        if ba is not None and bb is not None and sa is not None and sb is not None:
            if min(sa, sb) >= rules['flatStd']:
                distance = (int(ba, 16) ^ int(bb, 16)).bit_count()
                compared += 1
                same += distance <= rules['frameBits']
        evidence.append(dict(t=ta, tb=tb, bits=distance))
    score = same / compared if compared >= rules['minFrames'] and same >= rules['minFrames'] else 0
    return score, evidence


def _strings(value):
    return isinstance(value, list) and all(isinstance(v, str) for v in value)


def _sources(ctx, dirs, roots):
    result = []
    for value in [*dirs, *roots]:
        if external.is_abs_ref(value):
            absolute = ctx.external.resolve_root(value)
        else:
            absolute = ctx.ws.resolve(value)
            if not os.path.exists(absolute):
                raise ApiError('ENOENT', '폴더를 찾을 수 없어요')
            if not os.path.isdir(absolute):
                raise ApiError('EINVAL', '검색할 경로는 폴더여야 해요')
        root = None if paths.is_inside(absolute, ctx.ws.root) else absolute
        result.append((absolute, root))
    return result


def _normalize_ref(value):
    if external.is_abs_ref(value):
        return os.path.normcase(os.path.normpath(value))
    try:
        return paths.clean_rel(value)
    except ApiError:
        return None


def _validate(ctx, body):
    if not isinstance(body, dict):
        raise ApiError('EINVAL', '요청 내용이 올바르지 않아요')
    dirs, roots = body.get('dirs', []), body.get('roots', [])
    kinds = body.get('kinds', ['exact', 'video', 'image'])
    workers = body.get('workers', min(8, os.cpu_count() or 4))
    if not _strings(dirs) or not _strings(roots):
        raise ApiError('EINVAL', '검색할 폴더 목록을 확인해 주세요')
    if not _strings(kinds) or not kinds or not set(kinds) <= {'exact', 'video', 'image'}:
        raise ApiError('EINVAL', '검사 종류를 확인해 주세요')
    if type(workers) is not int or not 1 <= workers <= 16:
        raise ApiError('EINVAL', '작업 수는 1부터 16까지 정수로 골라 주세요')
    rules = normalize_rules(body.get('rules', {}))
    exclude = body.get('exclude', {})
    if not isinstance(exclude, dict):
        raise ApiError('EINVAL', '제외할 항목을 확인해 주세요')
    for key in ('files', 'folders'):
        if not _strings(exclude.get(key, [])):
            raise ApiError('EINVAL', '제외할 항목을 확인해 주세요')
    pairs = exclude.get('pairs', [])
    if not isinstance(pairs, list) or any(not _strings(p) or len(p) != 2 for p in pairs):
        raise ApiError('EINVAL', '제외할 파일 쌍을 확인해 주세요')
    sources = []
    if 'compare' in body:
        compare = body['compare']
        if not isinstance(compare, dict) or any(not _strings(compare.get(s)) or not compare[s] for s in ('a', 'b')):
            raise ApiError('EINVAL', '비교할 두 폴더 목록을 확인해 주세요')
        for side in ('a', 'b'):
            sources.extend((absolute, root, side) for absolute, root in _sources(ctx, compare[side], []))
        # A file can only be on one side: overlapping sides (a folder vs itself, a parent vs its child) are refused
        for left, _, side_left in sources:
            for right, _, side_right in sources:
                if side_left == 'a' and side_right == 'b' and (paths.is_inside(left, right) or paths.is_inside(right, left)):
                    raise ApiError('EINVAL', '비교할 두 쪽 폴더가 서로 겹쳐요. 겹치지 않는 폴더끼리 골라 주세요')
    else:
        if not dirs and not roots:
            dirs = ['']
        sources = [(absolute, root, None) for absolute, root in _sources(ctx, dirs, roots)]
    return dict(kinds=kinds, workers=workers, rules=rules, exclude=exclude,
                sources=sources, compare='compare' in body)


def _walk(ctx, options, job, stats):
    files, seen = [], set()
    excluded_files = {_normalize_ref(v) for v in options['exclude'].get('files', [])}
    folders = [_normalize_ref(v) for v in options['exclude'].get('folders', [])]
    folders = [v for v in folders if v is not None]
    for source, source_root, side in options['sources']:
        stack, visited = [source], set()
        while stack:
            job.check()
            folder = stack.pop()
            identity = os.path.normcase(folder)
            if identity in visited or paths.is_link_like(folder):
                continue
            visited.add(identity)
            if any(config.is_hidden_name(p) or p == external.QUARANTINE_DIR
                   for p in os.path.relpath(folder, source).split(os.sep) if p != '.'):
                continue
            try:
                with os.scandir(folder) as entries:
                    for entry in entries:
                        job.check()
                        if config.is_hidden_name(entry.name) or entry.name == external.QUARANTINE_DIR:
                            continue
                        try:
                            if paths.is_link_like(entry.path):
                                continue
                            if entry.is_dir(follow_symlinks=False):
                                stack.append(entry.path)
                                continue
                            kind = config.media_type(entry.name)
                            if kind not in ('image', 'video') or not entry.is_file(follow_symlinks=False):
                                continue
                            absolute = os.path.normpath(entry.path)
                            identity = os.path.normcase(absolute)
                            if identity in seen:
                                continue
                            seen.add(identity)
                            inside = paths.is_inside(absolute, ctx.ws.root)
                            ref = ctx.ws.rel(absolute) if inside else absolute
                            normalized = _normalize_ref(ref)
                            if normalized in excluded_files or any(
                                paths.is_inside(absolute, f) if external.is_abs_ref(f)
                                else inside and (not f or ref == f or ref.startswith(f + '/')) for f in folders
                            ):
                                stats['excluded'] += 1
                                continue
                            st = entry.stat(follow_symlinks=False)
                            item = dict(path=ref, abs=absolute, size=st.st_size,
                                        mtime=fsutil.mtime_ms(st), type=kind,
                                        key=ref if inside else identity,
                                        cache=ctx.ws_cache if inside else ctx.ext_cache)
                            if not inside:
                                item['root'] = source_root
                            if side:
                                item['side'] = side
                            files.append(item)
                        except (OSError, ApiError):
                            stats['skipped'] += 1
            except OSError:
                stats['skipped'] += 1
    return sorted(files, key=lambda item: item['path'])


def _parallel(items, worker, workers, job):
    """Bound submissions and yield completed work without hiding cancellation."""
    executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix='fi-dupes2')
    pending = {}
    iterator = iter(items)
    exhausted = False
    try:
        while pending or not exhausted:
            job.check()
            while not exhausted and len(pending) < workers * 2:
                try:
                    item = next(iterator)
                except StopIteration:
                    exhausted = True
                    break
                pending[executor.submit(worker, item)] = item
            if not pending:
                break
            done, _ = wait(pending, timeout=0.2, return_when=FIRST_COMPLETED)
            for future in done:
                job.check()
                item = pending.pop(future)
                yield item, future.result()
    finally:
        for future in pending:
            future.cancel()
        executor.shutdown(wait=True, cancel_futures=True)


def _photo(abs_path, phash):
    with fsutil.open_shared(abs_path) as stream, Image.open(stream) as image:
        width, height = image.size
        orientation = image.getexif().get(0x0112)
        image.draft('RGB', (256, 256))
        if orientation in (5, 6, 7, 8):
            width, height = height, width
        result = dict(w=width, h=height)
        if phash:
            result['phash'] = dupes.phash_image(image).hex()
        return result


class _Run:
    """Own mutable fingerprints on the collecting thread and flush completed files."""

    def __init__(self, ctx, options, job):
        self.started = time.perf_counter()
        self.job, self.options = job, options
        self.stats = dict(excluded=0, skipped=0, errors=[])
        job.set_progress(0, '파일 찾는 중')
        self.files = _walk(ctx, options, job, self.stats)
        self.changed, self.failed = set(), set()
        self.pending = defaultdict(dict)
        for cache in {item['cache'] for item in self.files}:
            members = [item for item in self.files if item['cache'] is cache]
            documents = cache.get_fingerprints(ENGINE, [(i['key'], i['size'], i['mtime']) for i in members])
            for item in members:
                item['fp'] = documents.get(item['key'], {})
        self.noted = set()
        for i, item in enumerate(self.files):
            cached_errors = item['fp'].get('errors', {})
            if 'hash' in cached_errors:
                self.fail(i, cached_errors['hash'])  # unreadable: can't take part at all
            elif 'probe' in cached_errors or 'phash' in cached_errors:
                # Undecodable media can still be an exact copy; it only sits out the video/photo comparison
                self.note(i, cached_errors.get('probe') or cached_errors.get('phash'))

    def note(self, i, message):
        """Report a file problem once (≤ 50 listed) without excluding the file."""
        if i in self.noted:
            return
        self.noted.add(i)
        self.stats['skipped'] += 1
        if len(self.stats['errors']) < 50:
            item = self.files[i]
            self.stats['errors'].append({**{k: item[k] for k in ('path', 'root') if k in item}, 'message': message})

    def fail(self, i, message):
        """Exclude a file from every comparison (unreadable or changing while we read it)."""
        if i in self.failed:
            return
        self.failed.add(i)
        self.note(i, message)

    def flush(self):
        for cache, entries in self.pending.items():
            rows = []
            for i, document in entries.items():
                item = self.files[i]
                try:
                    st = os.stat(item['abs'])
                    unchanged = (st.st_size, fsutil.mtime_ms(st)) == (item['size'], item['mtime'])
                except OSError:
                    unchanged = False
                if unchanged:
                    rows.append((item['key'], item['size'], item['mtime'], document))
                else:
                    self.fail(i, '파일이 바뀌고 있어서 건너뛰었어요')
            cache.put_fingerprints(ENGINE, rows)
        self.pending.clear()

    def stage(self, indexes, operation, message, start, end, workers):
        required = {
            'qhash': ('qhash',), 'fhash': ('fhash',), 'probe': ('duration', 'w', 'h'),
            'frames': ('frames',), 'phash': ('phash', 'w', 'h'), 'header': ('w', 'h'),
        }[operation]
        error_key = {'qhash': 'hash', 'fhash': 'hash', 'header': 'phash'}.get(operation, operation)
        needed = [i for i in indexes if i not in self.failed
                  and error_key not in self.files[i]['fp'].get('errors', {})
                  and any(k not in self.files[i]['fp'] for k in required)]
        self.changed.update(needed)

        def work(i):
            self.job.check()
            item = self.files[i]
            absolute = item['abs']
            try:
                if operation == 'qhash':
                    values = dict(qhash=quick_hash(absolute, item['size']))
                elif operation == 'fhash':
                    values = dict(fhash=full_hash(absolute, self.job))
                elif operation == 'probe':
                    info = ffmpeg.probe(absolute)
                    values = dict(duration=info.get('duration'), w=info.get('width'), h=info.get('height'))
                elif operation == 'frames':
                    duration = item['fp'].get('duration') or 0
                    values = dict(frames=video_frames(absolute, duration, self.job) if duration > 0 else [])
                    if any(frame[1] is None for frame in values['frames']):
                        values['errors'] = {'frames': '일부 장면을 읽을 수 없어요'}
                else:
                    values = _photo(absolute, operation == 'phash')
            except _READ_ERRORS as exc:
                self.job.check()
                if isinstance(exc, OSError):
                    # Locked / vanished / drive hiccup: report it, but never cache it (the next scan tries again)
                    error = errors.from_os_error(exc, os.path.basename(absolute), noun='파일')
                    values = {'transient': error.message}
                else:
                    message = exc.message if isinstance(exc, ApiError) else '파일을 읽을 수 없어요'
                    values = {'errors': {error_key: message}}
                    if operation == 'header':
                        values.update(w=None, h=None)
            self.job.check()
            try:
                st = os.stat(absolute)
                unchanged = (st.st_size, fsutil.mtime_ms(st)) == (item['size'], item['mtime'])
            except OSError:
                unchanged = False
            return values, unchanged

        results = _parallel(needed, work, workers, self.job)
        try:
            for done, (i, (values, unchanged)) in enumerate(results, 1):
                if not unchanged:
                    self.fail(i, '파일이 바뀌고 있어서 건너뛰었어요')
                elif 'transient' in values:
                    if error_key == 'hash':
                        self.fail(i, values['transient'])
                    else:
                        self.note(i, values['transient'])
                else:
                    item = self.files[i]
                    document = item['fp']
                    document['type'] = item['type']
                    problems = values.pop('errors', {})
                    document.update(values)
                    if problems:
                        document.setdefault('errors', {}).update(problems)
                        if error_key == 'hash':
                            self.fail(i, next(iter(problems.values())))
                        elif error_key != 'frames' and operation != 'header':
                            self.note(i, next(iter(problems.values())))
                    self.pending[item['cache']][i] = dict(document)
                    if sum(len(v) for v in self.pending.values()) >= 50:
                        self.flush()
                self.job.check()
                self.job.set_progress(start + (end - start) * done / max(1, len(needed)),
                                      f'{message} ({done}/{len(needed)})')
        finally:
            results.close()
        self.job.check()
        self.job.set_progress(end, f'{message} ({len(needed)}/{len(needed)})')

    def summary(self):
        return dict(files=len(self.files), images=sum(i['type'] == 'image' for i in self.files),
                    videos=sum(i['type'] == 'video' for i in self.files), bytes=sum(i['size'] for i in self.files),
                    computed=len(self.changed), cached=len(self.files) - len(self.changed),
                    errors=self.stats['errors'], elapsed=time.perf_counter() - self.started)


def fingerprint(ctx, body, job):
    options = _validate(ctx, body)
    run = _Run(ctx, options, job)
    try:
        all_files = list(range(len(run.files)))
        videos = [i for i in all_files if run.files[i]['type'] == 'video']
        images = [i for i in all_files if run.files[i]['type'] == 'image']
        stages = []
        if 'exact' in options['kinds']:
            stages.append((all_files, 'qhash', min(2, options['workers'])))
        if 'video' in options['kinds']:
            stages.extend([(videos, 'probe', options['workers']), (videos, 'frames', options['workers'])])
        if 'image' in options['kinds']:
            stages.append((images, 'phash', min(2, options['workers'])))
        for n, (indexes, operation, workers) in enumerate(stages):
            run.stage(indexes, operation, '지문 만드는 중', 0.05 + 0.94 * n / len(stages),
                      0.05 + 0.94 * (n + 1) / len(stages), workers)
        run.flush()
        job.check()
        job.set_progress(1, '지문 만드는 중 (%d/%d)' % (len(run.files), len(run.files)))
        return {**run.summary(), 'failed': len(run.failed)}
    finally:
        run.flush()


def _candidate_pairs(files, indexes, rules, job):
    ordered = sorted((i for i in indexes if files[i]['fp'].get('duration') is not None),
                     key=lambda i: files[i]['fp']['duration'])
    for position, a in enumerate(ordered):
        job.check()
        da = files[a]['fp']['duration']
        for offset in range(position + 1, len(ordered)):
            job.check()
            b = ordered[offset]
            db = files[b]['fp']['duration']
            if db - da > max(rules['durationTolSec'], rules['durationTolPct'] / 100 * db):
                break
            yield a, b


def scan(ctx, body, job):
    options = _validate(ctx, body)
    rules = options['rules']
    run = _Run(ctx, options, job)
    files = run.files
    union = dupes.UnionFind(len(files))
    # Evidence is capped per component, including while components are merged.
    evidence = {}
    video_components = set()
    excluded_pairs = {frozenset((_normalize_ref(a), _normalize_ref(b)))
                      for a, b in options['exclude'].get('pairs', [])}
    # "Not duplicates" must also hold transitively: a group may never contain both files of an excluded pair,
    # so every component remembers which files it must not be merged with.
    by_ref = {_normalize_ref(item['path']): i for i, item in enumerate(files)}
    forbid: dict[int, set[int]] = defaultdict(set)
    for pair in excluded_pairs:
        ends = [by_ref.get(ref) for ref in pair]
        if len(ends) == 2 and None not in ends:
            forbid[ends[0]].add(ends[1])
            forbid[ends[1]].add(ends[0])

    def allowed(a, b):
        return frozenset((_normalize_ref(files[a]['path']), _normalize_ref(files[b]['path']))) not in excluded_pairs

    def link(a, b, kind, score=1, frames=None, bits=None):
        if a in run.failed or b in run.failed or not allowed(a, b):
            return False
        ra, rb = union.find(a), union.find(b)
        if ra != rb and (any(union.find(x) == rb for x in forbid.get(ra, ())) or any(union.find(x) == ra for x in forbid.get(rb, ()))):
            return False
        links = evidence.pop(ra, [])
        if rb != ra:
            links += evidence.pop(rb, [])
        has_video = kind == 'video' or ra in video_components or rb in video_components
        video_components.discard(ra)
        video_components.discard(rb)
        merged = forbid.pop(ra, set()) | (forbid.pop(rb, set()) if rb != ra else set())
        union.union(a, b)
        root = union.find(a)
        if merged:
            forbid[root] = merged
        if has_video:
            video_components.add(root)
        da, db = files[a]['fp'].get('duration'), files[b]['fp'].get('duration')
        delta = abs(da - db) if da is not None and db is not None else None
        edge = dict(a=files[a]['path'], b=files[b]['path'], kind=kind, score=score,
                    dDur=round(delta, 3) if kind == 'video' and delta is not None else delta,
                    frames=frames or [])
        if bits is not None:
            edge['bits'] = bits
        evidence[root] = (links + [edge])[:60]
        return True

    def direct(keeper, i):
        """Does member i match the keeper itself (not only through a chain of other files)?"""
        fk, fi = files[keeper]['fp'], files[i]['fp']
        if fk.get('fhash') and fk.get('fhash') == fi.get('fhash'):
            return True
        if files[keeper]['type'] == 'video' and files[i]['type'] == 'video':
            return same_video(fk, fi, rules)[0] > 0
        if files[keeper]['type'] == 'image' and files[i]['type'] == 'image' and fk.get('phash') and fi.get('phash'):
            return (int(fk['phash'], 16) ^ int(fi['phash'], 16)).bit_count() <= rules['imageBits']
        return False

    try:
        indexes = list(range(len(files)))
        videos = [i for i in indexes if files[i]['type'] == 'video']
        images = [i for i in indexes if files[i]['type'] == 'image']
        hashes_workers = min(2, options['workers'])
        # Metadata also supplies exact evidence and the keeper's height.
        run.stage(videos, 'probe', '영상 길이 확인 중', 0.05, 0.15, options['workers'])
        run.stage(images, 'header', '사진 지문 만드는 중', 0.15, 0.18, hashes_workers)
        if 'exact' in options['kinds']:
            sizes = defaultdict(list)
            for i in indexes:
                sizes[files[i]['size']].append(i)
            candidates = [i for members in sizes.values() if len(members) >= 2 for i in members]
            run.stage(candidates, 'qhash', '같은 파일 확인 중', 0.18, 0.28, hashes_workers)
            quick = defaultdict(list)
            for i in candidates:
                if i not in run.failed and 'qhash' in files[i]['fp']:
                    quick[(files[i]['size'], files[i]['fp']['qhash'])].append(i)
            candidates = [i for members in quick.values() if len(members) >= 2 for i in members]
            run.stage(candidates, 'fhash', '같은 파일 확인 중', 0.28, 0.40, hashes_workers)
            identical = defaultdict(list)
            for i in candidates:
                if i not in run.failed and 'fhash' in files[i]['fp']:
                    identical[files[i]['fp']['fhash']].append(i)
            for members in identical.values():
                for offset, b in enumerate(members):
                    job.check()
                    for earlier in range(offset):
                        if link(members[earlier], b, 'exact'):
                            break
        if 'video' in options['kinds']:
            valid = [i for i in videos if i not in run.failed]
            needed = set()
            for a, b in _candidate_pairs(files, valid, rules, job):
                needed.update((a, b))
            run.stage(sorted(needed), 'frames', '장면 지문 만드는 중', 0.40, 0.75, options['workers'])
            for a, b in _candidate_pairs(files, valid, rules, job):
                score, frames = same_video(files[a]['fp'], files[b]['fp'], rules)
                if score:
                    link(a, b, 'video', score, frames)
        if 'image' in options['kinds']:
            run.stage(images, 'phash', '사진 지문 만드는 중', 0.75, 0.90, hashes_workers)
            searchable = [i for i in images if i not in run.failed and 'phash' in files[i]['fp']]
            if len(searchable) >= 2:
                codes = np.frombuffer(b''.join(bytes.fromhex(files[i]['fp']['phash']) for i in searchable),
                                      dtype=np.uint8).reshape(len(searchable), 8)
                token = dupes._search_job.set(job)
                try:
                    for a, b, distance in dupes.iter_pairs(codes, rules['imageBits'] + 1):
                        job.check()
                        link(searchable[a], searchable[b], 'image', round(1 - distance / 64, 4), bits=distance)
                finally:
                    dupes._search_job.reset(token)
        run.flush()
        job.check()
        job.set_progress(0.95, '묶는 중')
        components = defaultdict(list)
        for i in indexes:
            job.check()
            if i not in run.failed:
                components[union.find(i)].append(i)
        groups = []
        for root, members in components.items():
            job.check()
            if len(members) < 2:
                continue
            if options['compare'] and {files[i]['side'] for i in members} != {'a', 'b'}:
                continue

            def keep_order(i):
                item, fp = files[i], files[i]['fp']
                values = dict(resolution=fp.get('h') or 0, duration=round(fp.get('duration') or 0), size=item['size'])
                return (*(-values[k] for k in rules['keep']), len(item['path']), item['path'])

            members.sort(key=keep_order)
            full = [files[i]['fp'].get('fhash') for i in members]
            kind = 'exact' if full[0] and all(v == full[0] for v in full) else 'video' if root in video_components else 'image'
            durations = [files[i]['fp'].get('duration') for i in members]
            # Members found only through a chain (A~B, B~C but not A~C) are never "sure": the owner reviews them
            matches_keeper = [True] + [direct(members[0], i) for i in members[1:]]
            sure = all(matches_keeper) and (kind == 'exact' or (kind == 'video' and all(files[i]['type'] == 'video' for i in members)
                    and all(d is not None for d in durations)
                    and max(durations) - min(durations) <= rules['sureDurationSec']))
            output = []
            for offset, i in enumerate(members):
                item, fp = files[i], files[i]['fp']
                output.append({**{k: item[k] for k in ('path', 'root', 'side', 'size', 'mtime') if k in item},
                               'kind': item['type'], 'duration': fp.get('duration'), 'w': fp.get('w'),
                               'h': fp.get('h'), 'keep': offset == 0, 'direct': matches_keeper[offset]})
            total = sum(files[i]['size'] for i in members)
            identifier = hashlib.sha1('\n'.join(sorted(files[i]['path'] for i in members)).encode('utf-8')).hexdigest()[:16]
            member_paths = {item['path'] for item in output}
            links = [edge for edge in evidence.get(root, []) if edge['a'] in member_paths and edge['b'] in member_paths]
            groups.append(dict(id=identifier, kind=kind, sure=bool(sure), keep=output[0]['path'], bytes=total,
                               reclaim=total - output[0]['size'], members=output, evidence=links))
        groups.sort(key=lambda group: (-group['reclaim'], group['id']))
        stats = {**run.summary(), 'engine': ENGINE, 'groups': len(groups),
                 'excluded': run.stats['excluded'], 'skipped': run.stats['skipped'],
                 'sureGroups': sum(g['sure'] for g in groups), 'reclaimable': sum(g['reclaim'] for g in groups)}
        for kind in ('exact', 'video', 'image'):
            stats[kind + 'Groups'] = sum(g['kind'] == kind for g in groups)
        job.check()
        job.set_progress(1, '묶는 중')
        return dict(groups=groups, stats=stats)
    finally:
        run.flush()


def _context(request, ws):
    return Ctx(ws, request.app.state.external, mediacache.for_workspace(ws),
               mediacache.for_external(request.app.state.data_dir))


async def _json(request):
    try:
        data = await request.json()
    except (ValueError, UnicodeError):
        raise ApiError('EINVAL', '요청 내용이 올바르지 않아요') from None
    if not isinstance(data, dict):
        raise ApiError('EINVAL', '요청 내용이 올바르지 않아요')
    return data


def _submit(request, ws, jobs, data, make_fingerprints=False):
    ctx = _context(request, ws)
    _validate(ctx, data)
    fn = fingerprint if make_fingerprints else scan
    kind = 'dupes.fingerprint' if make_fingerprints else 'dupes.scan2'
    job = jobs.submit(kind, lambda job: fn(ctx, data, job), ws=ws, message='파일 찾는 중')
    return JSONResponse(job.to_dict(), status_code=202)


@router.post('/api/dupes/scan')
async def scan_route(request: Request, ws: Workspace = Depends(deps.workspace), jobs: JobManager = Depends(deps.jobs)):
    data = await _json(request)
    if data.get('v') == 2 or any(k in data for k in ('roots', 'compare', 'kinds', 'rules', 'exclude')):
        return await run_in_threadpool(_submit, request, ws, jobs, data)
    try:
        body = dupes.ScanBody.model_validate(data)
    except ValidationError:
        raise ApiError('EINVAL', '요청 내용이 올바르지 않아요') from None
    return await run_in_threadpool(dupes.scan_route, body, ws, jobs)


@router.post('/api/dupes/scan2')
async def scan2_route(request: Request, ws: Workspace = Depends(deps.workspace), jobs: JobManager = Depends(deps.jobs)):
    return await run_in_threadpool(_submit, request, ws, jobs, await _json(request))


@router.post('/api/dupes/fingerprint')
async def fingerprint_route(request: Request, ws: Workspace = Depends(deps.workspace), jobs: JobManager = Depends(deps.jobs)):
    return await run_in_threadpool(_submit, request, ws, jobs, await _json(request), True)


@router.get('/api/dupes/frame')
def frame_route(request: Request, path: str, t: float = 0, w: int = 160, v: str = '',
                ws: Workspace = Depends(deps.workspace)):
    if external.is_abs_ref(path):
        absolute, _ = request.app.state.external.resolve_file(path)
    else:
        absolute = ws.resolve(path)
    width = max(32, min(640, w))
    try:
        if not os.path.isfile(absolute):
            return Response(status_code=204, headers={'X-FI-Error': 'ENOENT'})
        if config.media_type(absolute) == 'video':
            info = ffmpeg.probe(absolute)
            duration = info.get('duration') or 0
            seconds = max(0, min(t if math.isfinite(t) else 0, max(0, duration - 0.05)))
            content = ffmpeg.capture(['-ss', f'{seconds:.3f}', '-i', absolute, '-frames:v', '1',
                                      '-vf', f'scale={width}:-2', '-f', 'image2pipe', '-c:v', 'mjpeg',
                                      '-q:v', '5', '-'], inputs=[absolute], timeout=30)
        else:
            with fsutil.open_shared(absolute) as stream, Image.open(stream) as original:
                image = ImageOps.exif_transpose(original)
                try:
                    image.thumbnail((width, width * 4))
                    with image.convert('RGB') as rgb:
                        output = io.BytesIO()
                        rgb.save(output, 'JPEG', quality=85)
                        content = output.getvalue()
                finally:
                    if image is not original:
                        image.close()
        if not content.startswith(b'\xff\xd8'):
            return Response(status_code=204, headers={'X-FI-Error': 'EINVAL'})
        return Response(content, media_type='image/jpeg', headers={'Cache-Control': 'private, max-age=86400'})
    except _READ_ERRORS as exc:
        code = exc.code if isinstance(exc, ApiError) else 'ENOENT' if isinstance(exc, FileNotFoundError) else 'EINVAL'
        return Response(status_code=204, headers={'X-FI-Error': code})


@router.get('/api/dupes/stat')
def stat_route(request: Request, path: str, ws: Workspace = Depends(deps.workspace)):
    """Size/mtime of a file under a picked external root — the review re-verifies the keeper right before removing."""
    absolute, _ = request.app.state.external.resolve_file(path)
    try:
        st = os.stat(absolute)
    except FileNotFoundError:
        raise ApiError('ENOENT', '파일을 찾을 수 없어요')
    except OSError as exc:
        raise ApiError('ESERVER', f'파일 정보를 읽지 못했어요: {exc.strerror or exc}')
    if os.path.isdir(absolute):
        return {'kind': 'dir', 'size': 0, 'mtime': fsutil.mtime_ms(st)}
    return {'kind': 'file', 'size': st.st_size, 'mtime': fsutil.mtime_ms(st)}


@router.get('/api/dupes/media')
def media_route(request: Request, path: str, ws: Workspace = Depends(deps.workspace)):
    """Play a file under a picked external root in the review (Range/ETag like /api/fs/file)."""
    absolute, _ = request.app.state.external.resolve_file(path)
    if not os.path.isfile(absolute):
        raise ApiError('ENOENT', '파일을 찾을 수 없어요')
    return http_utils.file_response(request, absolute, cache_control='no-cache', display=os.path.basename(absolute))


@router.get('/api/dupes/roots')
def roots_route(request: Request):
    return {'roots': request.app.state.external.entries()}


class _PickBody(BaseModel):
    model_config = ConfigDict(extra='ignore')
    initialDir: StrictStr = ''


class _RootBody(BaseModel):
    model_config = ConfigDict(extra='ignore')
    root: StrictStr


# Sync routes: the native dialog blocks until the user answers, so it must run in the thread pool, never on the event loop
@router.post('/api/dupes/roots/pick')
def pick_root_route(request: Request, body: _PickBody = _PickBody()):
    result = routes_workspace.native_pick(request, body.initialDir, '중복 검사할 폴더 선택')
    return request.app.state.external.remember(result['root']) if result.get('root') else {'cancelled': True}


@router.post('/api/dupes/roots/forget')
def forget_root_route(request: Request, body: _RootBody):
    request.app.state.external.forget(body.root)
    return {'ok': True}
