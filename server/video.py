"""Workspace video tools with atomic output publication."""
from __future__ import annotations

import math
import os
import stat
import threading
import uuid
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from . import config, deps, ffmpeg, fsutil
from .errors import ApiError, from_os_error
from .jobs import JobManager
from .workspaces import Workspace

router = APIRouter()
_names_lock = threading.Lock()
_reserved: set[str] = set()
_MOV = {'.mp4', '.mov', '.m4v'}


class Body(BaseModel):
    model_config = ConfigDict(extra='ignore')


class TrimBody(Body):
    path: str
    start: Any
    end: Any
    mode: str = 'fast'


class Segment(Body):
    path: str
    start: Any = 0
    end: Any = None


class ConcatBody(Body):
    segments: list[Segment]
    output: str | None = None


class TransformBody(Body):
    path: str
    op: str
    mode: str = 'metadata'
    inPlace: bool = False


class FrameBody(Body):
    path: str
    time: Any
    format: str = 'jpg'


def _number(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ApiError('EINVAL', f'{label}은 숫자로 입력해 주세요')
    try:
        result = float(value)
    except (ValueError, OverflowError):
        raise ApiError('EINVAL', f'{label}이 올바르지 않아요')
    if not math.isfinite(result):
        raise ApiError('EINVAL', f'{label}은 유한한 숫자로 입력해 주세요')
    return result


def _source(ws, rel):
    path = ws.resolve(rel)
    try:
        st = os.stat(path)
    except OSError as exc:
        raise from_os_error(exc, rel, noun='파일') from exc
    if not stat.S_ISREG(st.st_mode):
        raise ApiError('EINVAL', '영상 파일을 골라 주세요')
    if config.media_type(path) != 'video':
        raise ApiError('EINVAL', '영상 파일만 처리할 수 있어요')
    ffmpeg.require()
    info = ffmpeg.probe(path, st)
    if not info.get('hasVideo'):
        raise ApiError('EINVAL', '영상 스트림이 없는 파일이에요')
    return path, st, info


def _range(start, end, info):
    start = _number(start, '시작 시간')
    end = _number(end, '끝 시간')
    duration = info.get('duration')
    if start < 0 or end <= start:
        raise ApiError('EINVAL', '시작 시간은 0 이상이고 끝 시간보다 작아야 해요')
    if duration is not None and end > duration + 0.5:
        raise ApiError('EINVAL', '끝 시간이 영상 길이를 넘어요')
    return start, end


def _output_ext(src_ext, reencode):
    ext = src_ext.lower()
    return '.mp4' if reencode and ext not in _MOV | {'.mkv'} else ext


def _temp_for(final_abs):
    return os.path.join(os.path.dirname(final_abs), f'{fsutil.TMP_PREFIX}{uuid.uuid4().hex}{os.path.splitext(final_abs)[1]}')


def _finish(temp, final, *, replace=False):
    if replace:
        fsutil.retry(os.replace, temp, final)
    else:
        fsutil.publish_new(temp, final)  # never overwrites a file that appeared meanwhile


def _vmap(info):
    """Stream specifier of the movie itself (skips attached cover pictures)."""
    return f"0:v:{info.get('videoIndex') or 0}"


def _remove_temp(path):
    try:
        fsutil.remove(path)
    except FileNotFoundError:
        pass


def _key(path):
    return os.path.normcase(os.path.abspath(path))


def _reserve(directory, stem, tag, ext, *, numbered=False, name=None):
    with _names_lock:
        if numbered:
            candidate = fsutil.numbered_child(directory, stem, tag, ext)
            index = int(os.path.splitext(candidate)[0].rsplit(tag, 1)[1])
            while _key(os.path.join(directory, candidate)) in _reserved or os.path.lexists(os.path.join(directory, candidate)):
                index += 1
                candidate = f'{stem}_{tag}{index:02d}{ext}'
        else:
            base = name or f'{stem}_{tag}{ext}'
            candidate = fsutil.unique_child(directory, base)
            index = 2
            while _key(os.path.join(directory, candidate)) in _reserved or os.path.lexists(os.path.join(directory, candidate)):
                if name is None:
                    candidate = f'{stem}_{tag}{index}{ext}'
                else:
                    s, e = os.path.splitext(base)
                    candidate = f'{s} ({index}){e}'
                index += 1
        final = os.path.join(directory, candidate)
        _reserved.add(_key(final))
        return final


def _release_name(final):
    with _names_lock:
        _reserved.discard(_key(final))


def _result(ws, final, *, video=True):
    st = os.stat(final)
    result = {'path': ws.rel(final), 'size': st.st_size, 'mtime': fsutil.mtime_ms(st)}
    if video:
        result['duration'] = None
        try:
            result['duration'] = ffmpeg.probe(final, st).get('duration')
        except (ApiError, OSError):
            pass
    return result


def _version(path):
    st = os.stat(path)
    return st.st_size, st.st_mtime_ns


def _submit(jobs, ws, kind, final, work, *, in_place=False):
    temp = _temp_for(final)
    before = _version(final) if in_place else None

    def execute(job):
        try:
            job.check()
            work(job, temp)
            job.check()
            # Resolve again before publication to reject a changed parent link.
            ws.resolve(ws.rel(final))
            if in_place:
                if _version(final) != before:
                    raise ApiError('EBUSY', '처리하는 동안 원본이 바뀌어서 덮어쓰지 않았어요. 다시 시도해 주세요')
                ffmpeg.release(final)
            elif os.path.lexists(final):
                raise ApiError('EEXIST', '같은 이름의 파일이 생겼어요. 다시 시도해 주세요')
            _finish(temp, final, replace=in_place)
            result = _result(ws, final)
            job.set_progress(1, '완료했어요')
            return result
        except FileExistsError:
            raise ApiError('EEXIST', '같은 이름의 파일이 생겼어요. 다시 시도해 주세요')
        except OSError as exc:
            raise from_os_error(exc, ws.rel(final), noun='파일') from exc

    # Registered at submit time so it also runs when the job is cancelled before it starts
    cleanup = [lambda: _remove_temp(temp), lambda: _release_name(final)]
    try:
        job = jobs.submit(kind, execute, ws=ws, message='영상을 처리하는 중이에요', cleanup=cleanup)
    except BaseException:
        _release_name(final)
        raise
    return JSONResponse(job.to_dict(), status_code=202)


def _encode():
    return ['-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p']


def _faststart(ext):
    return ['-movflags', '+faststart'] if ext in _MOV else []


@router.post('/api/video/trim')
def trim(body: TrimBody, ws: Workspace = Depends(deps.workspace), jobs: JobManager = Depends(deps.jobs)):
    if body.mode not in ('fast', 'accurate'):
        raise ApiError('EINVAL', '자르기 방식은 fast 또는 accurate로 골라 주세요')
    src, _, info = _source(ws, body.path)
    start, end = _range(body.start, body.end, info)
    accurate = body.mode == 'accurate'
    stem, src_ext = os.path.splitext(os.path.basename(src))
    ext = _output_ext(src_ext, accurate)
    final = _reserve(os.path.dirname(src), stem, 'cut', ext, numbered=True)

    def work(job, temp):
        args = ['-y', '-ss', str(start), '-i', src, '-t', str(end - start), '-map', _vmap(info), '-map', '0:a?']
        args += _encode() + ['-c:a', 'aac', '-b:a', '192k'] if accurate else ['-c', 'copy', '-avoid_negative_ts', 'make_zero']
        ffmpeg.run(args + _faststart(ext) + [temp], job=job, duration=end - start, inputs=[src])

    return _submit(jobs, ws, 'video.trim', final, work)


@router.post('/api/video/concat')
def concat(body: ConcatBody, ws: Workspace = Depends(deps.workspace), jobs: JobManager = Depends(deps.jobs)):
    if not 1 <= len(body.segments) <= 50:
        raise ApiError('EINVAL', '이어 붙일 구간을 1개부터 50개까지 골라 주세요')
    segments = []
    for segment in body.segments:
        src, _, info = _source(ws, segment.path)
        end = segment.end if segment.end is not None else info.get('duration')
        if end is None:
            raise ApiError('EINVAL', '영상 길이를 알 수 없어요. 끝 시간을 입력해 주세요')
        start, end = _range(segment.start, end, info)
        segments.append((src, info, start, end - start))
    total = sum(s[3] for s in segments)
    if not math.isfinite(total) or total <= 0:
        raise ApiError('EINVAL', '이어 붙일 영상 길이는 0보다 커야 해요')
    first, info, _, _ = segments[0]
    width, height = info.get('width'), info.get('height')
    if not width or not height:
        raise ApiError('EINVAL', '영상 크기를 읽을 수 없어요')
    width, height = max(2, int(width) // 2 * 2), max(2, int(height) // 2 * 2)
    fps = info.get('fps') or 30
    if not math.isfinite(fps) or fps <= 0:
        fps = 30
    if body.output is not None:
        target = ws.resolve(body.output)
        if os.path.splitext(target)[1].lower() != '.mp4':
            raise ApiError('EINVAL', '이어 붙인 영상 이름은 .mp4로 끝나야 해요')
        directory = os.path.dirname(target)
        if not os.path.isdir(directory):
            raise ApiError('ENOENT', '저장할 폴더를 찾을 수 없어요')
        final = _reserve(directory, '', '', '.mp4', name=os.path.basename(target))
    else:
        final = _reserve(os.path.dirname(first), os.path.splitext(os.path.basename(first))[0], 'merged', '.mp4', numbered=True)

    def work(job, temp):
        args = ['-y']
        audio_indices = []
        index = 0
        video_indices = []
        for src, meta, start, duration in segments:
            video_indices.append(index)
            args += ['-ss', str(start), '-t', str(duration), '-i', src]
            video_index = index
            index += 1
            if meta.get('hasAudio'):
                audio_indices.append(video_index)
            else:
                audio_indices.append(index)
                args += ['-f', 'lavfi', '-t', str(duration), '-i', 'anullsrc=r=48000:cl=stereo']
                index += 1
        filters = []
        for n, (_, _, _, duration) in enumerate(segments):
            filters.append(f'[{video_indices[n]}:v:{segments[n][1].get("videoIndex") or 0}]setpts=PTS-STARTPTS,scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps},format=yuv420p,trim=duration={duration},setpts=PTS-STARTPTS[v{n}]')
            filters.append(f'[{audio_indices[n]}:a:0]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration={duration},asetpts=PTS-STARTPTS[a{n}]')
        filters.append(''.join(f'[v{n}][a{n}]' for n in range(len(segments))) + f'concat=n={len(segments)}:v=1:a=1[v][a]')
        args += ['-filter_complex_threads', '1', '-filter_complex', ';'.join(filters), '-map', '[v]', '-map', '[a]']
        args += _encode() + ['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', temp]
        ffmpeg.run(args, job=job, duration=total, inputs=[s[0] for s in segments])

    return _submit(jobs, ws, 'video.concat', final, work)


@router.post('/api/video/transform')
def transform(body: TransformBody, ws: Workspace = Depends(deps.workspace), jobs: JobManager = Depends(deps.jobs)):
    filters = {'rotate90': 'transpose=1', 'rotate180': 'hflip,vflip', 'rotate270': 'transpose=2', 'hflip': 'hflip', 'vflip': 'vflip'}
    if body.op not in filters:
        raise ApiError('EINVAL', '지원하는 회전 또는 뒤집기 동작을 골라 주세요')
    if body.mode not in ('metadata', 'reencode'):
        raise ApiError('EINVAL', '변환 방식은 metadata 또는 reencode로 골라 주세요')
    src, _, info = _source(ws, body.path)
    stem, src_ext = os.path.splitext(os.path.basename(src))
    src_ext = src_ext.lower()
    metadata = body.mode == 'metadata'
    if metadata and body.op in ('hflip', 'vflip'):
        raise ApiError('EINVAL', '뒤집기는 다시 인코딩을 골라 주세요')
    if metadata and src_ext not in _MOV:
        raise ApiError('EINVAL', '이 형식은 무손실 회전을 지원하지 않아요. 다시 인코딩을 골라 주세요')
    ext = _output_ext(src_ext, not metadata)
    if body.inPlace and ext != src_ext:
        raise ApiError('EINVAL', '이 형식은 원본에 저장할 수 없어요. 새 파일로 저장해 주세요')
    if body.inPlace:
        final = src
        with _names_lock:
            if _key(final) in _reserved:
                raise ApiError('EBUSY', '이 영상은 이미 처리 중이에요')
            _reserved.add(_key(final))
    else:
        final = _reserve(os.path.dirname(src), stem, 'rot', ext)

    def work(job, temp):
        if metadata:
            clockwise = (int(info.get('rotation') or 0) + int(body.op[6:])) % 360
            angle = (-clockwise) % 360
            if angle > 180:
                angle -= 360
            prefix = ['-y', f"-display_rotation:v:{info.get('videoIndex') or 0}", str(angle), '-i', src]
            try:
                ffmpeg.run(prefix + ['-map', '0', '-c', 'copy'] + _faststart(ext) + [temp], job=job, duration=info.get('duration'), inputs=[src])
            except ApiError as exc:
                if exc.code != 'ESERVER':
                    raise
                job.check()
                _remove_temp(temp)
                ffmpeg.run(prefix + ['-map', _vmap(info), '-map', '0:a?', '-c', 'copy'] + _faststart(ext) + [temp], job=job, duration=info.get('duration'), inputs=[src])
        else:
            args = ['-y', '-i', src, '-map', _vmap(info), '-map', '0:a?', '-vf', filters[body.op]] + _encode()
            args += ['-c:a', 'copy'] if info.get('acodec') == 'aac' else ['-c:a', 'aac', '-b:a', '192k']
            args += ['-metadata:s:v:0', 'rotate=0'] + _faststart(ext) + [temp]
            ffmpeg.run(args, job=job, duration=info.get('duration'), inputs=[src])

    return _submit(jobs, ws, 'video.transform', final, work, in_place=body.inPlace)


@router.post('/api/video/frame')
def frame(body: FrameBody, ws: Workspace = Depends(deps.workspace)):
    if body.format not in ('jpg', 'png'):
        raise ApiError('EINVAL', '이미지 형식은 jpg 또는 png로 골라 주세요')
    time = _number(body.time, '프레임 시간')
    src, _, info = _source(ws, body.path)
    if time < 0 or (info.get('duration') is not None and time > info['duration']):
        raise ApiError('EINVAL', '프레임 시간은 0부터 영상 길이 사이로 입력해 주세요')
    minutes, seconds = divmod(int(time), 60)
    stem = os.path.splitext(os.path.basename(src))[0]
    name = f'{stem}_frame_{minutes:02d}m{seconds:02d}s.{body.format}'
    final = _reserve(os.path.dirname(src), '', '', '', name=name)
    temp = _temp_for(final)
    try:
        args = ['-y', '-ss', str(time), '-i', src, '-map', _vmap(info), '-frames:v', '1']
        args += ['-q:v', '2'] if body.format == 'jpg' else []
        ffmpeg.run(args + [temp], inputs=[src])
        if not os.path.isfile(temp):
            raise ApiError('EINVAL', '이 시간의 프레임을 읽을 수 없어요. 조금 앞 시간을 골라 주세요')
        ws.resolve(ws.rel(final))
        if os.path.lexists(final):
            raise ApiError('EEXIST', '같은 이름의 파일이 생겼어요. 다시 시도해 주세요')
        _finish(temp, final)
        return _result(ws, final, video=False)
    except FileExistsError:
        raise ApiError('EEXIST', '같은 이름의 파일이 생겼어요. 다시 시도해 주세요')
    except OSError as exc:
        raise from_os_error(exc, ws.rel(final), noun='파일') from exc
    finally:
        _remove_temp(temp)
        _release_name(final)
