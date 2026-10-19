"""ffmpeg helpers (bundled binary from imageio-ffmpeg; no ffprobe needed).

    exe() / available() / has_encoder('libx264')
    probe(abs_path)            -> dict parsed from `ffmpeg -i` (cached by path+size+mtime)
    capture(args, inputs=[..]) -> stdout bytes (thumbnails, frames)
    run(args, job=..., duration=..., inputs=[..]) -> runs with -progress, mirrors progress into the job
    popen(args, inputs=[..])   -> Popen for streaming (caller reads stdout)
    release(abs_prefix)        -> kill our ffmpeg processes reading files under a path (before move/delete)

Processes never open a console window (CREATE_NO_WINDOW) and are tracked so cancel/shutdown/release can stop them.
"""
from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import threading
import time
from collections import OrderedDict
from datetime import datetime, timezone

from .errors import ApiError
from .paths import is_inside

log = logging.getLogger('fi.ffmpeg')

_exe_cache: list = []
_encoders_cache: dict[str, bool] = {}
_active: dict[subprocess.Popen, tuple[str, ...]] = {}
_active_lock = threading.Lock()
_probe_cache: OrderedDict = OrderedDict()
_probe_lock = threading.Lock()
PROBE_CACHE_SIZE = 4000


def exe() -> str | None:
    if _exe_cache:
        return _exe_cache[0]
    path = os.environ.get('FI_FFMPEG') or None
    if not path:
        try:
            import imageio_ffmpeg

            path = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            path = shutil.which('ffmpeg')
    _exe_cache.append(path if path and os.path.exists(path) else None)
    return _exe_cache[0]


def available() -> bool:
    return exe() is not None


def require() -> str:
    path = exe()
    if not path:
        raise ApiError('ENOTSUP', 'ffmpeg를 찾을 수 없어요. server\\start.bat으로 서버를 다시 설치해 주세요')
    return path


def popen_kwargs() -> dict:
    kw: dict = {}
    if os.name == 'nt':
        kw['creationflags'] = getattr(subprocess, 'CREATE_NO_WINDOW', 0x08000000)
    return kw


def has_encoder(name: str) -> bool:
    if name in _encoders_cache:
        return _encoders_cache[name]
    ok = False
    if available():
        try:
            out = subprocess.run([exe(), '-hide_banner', '-encoders'], capture_output=True, timeout=20, **popen_kwargs()).stdout.decode('utf-8', 'replace')
            ok = re.search(r'^\s*[VAS][\w.]{5}\s+' + re.escape(name) + r'\s', out, re.MULTILINE) is not None
        except (OSError, subprocess.SubprocessError):
            ok = False
    _encoders_cache[name] = ok
    return ok


# ---------- process tracking ----------
def _track(proc: subprocess.Popen, inputs) -> None:
    with _active_lock:
        _active[proc] = tuple(os.path.abspath(p) for p in (inputs or ()))


def _untrack(proc: subprocess.Popen) -> None:
    with _active_lock:
        _active.pop(proc, None)


def _kill(proc: subprocess.Popen) -> None:
    try:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=3)
    except (OSError, subprocess.SubprocessError):
        pass


def release(abs_prefix: str) -> int:
    """Stop our ffmpeg processes that read files at/under abs_prefix (Windows can't rename open files)."""
    with _active_lock:
        victims = [p for p, ins in _active.items() if any(is_inside(i, abs_prefix) for i in ins)]
    for p in victims:
        _kill(p)
    return len(victims)


def kill_all() -> None:
    with _active_lock:
        procs = list(_active)
    for p in procs:
        _kill(p)


def popen(args: list[str], *, inputs=(), stdin=subprocess.DEVNULL) -> subprocess.Popen:
    """Start ffmpeg with stdout piped (for streaming). Caller must close/kill it; untrack happens in reap()."""
    cmd = [require(), '-hide_banner', '-nostdin', '-loglevel', 'error', *args]
    proc = subprocess.Popen(cmd, stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **popen_kwargs())
    _track(proc, inputs)
    # Drain stderr so the pipe never fills up
    threading.Thread(target=_drain, args=(proc,), daemon=True).start()
    return proc


def _drain(proc: subprocess.Popen) -> None:
    try:
        for _ in iter(lambda: proc.stderr.read(8192), b''):
            pass
    except (OSError, ValueError):
        pass


def reap(proc: subprocess.Popen) -> None:
    _kill(proc)
    _untrack(proc)
    for s in (proc.stdout, proc.stderr):
        try:
            if s:
                s.close()
        except OSError:
            pass


def capture(args: list[str], *, inputs=(), timeout: float = 60, job=None) -> bytes:
    """Run ffmpeg and return stdout (e.g. `-f image2pipe -c:v png -`). Raises ApiError on failure."""
    cmd = [require(), '-hide_banner', '-nostdin', '-loglevel', 'error', *args]
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **popen_kwargs())
    _track(proc, inputs)
    if job is not None:
        job.add_proc(proc)
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill(proc)
        raise ApiError('ESERVER', '영상 처리 시간이 너무 오래 걸려서 멈췄어요')
    finally:
        _untrack(proc)
        if job is not None:
            job.remove_proc(proc)
    if job is not None:
        job.check()
    if proc.returncode != 0:
        raise ApiError('ESERVER', f'영상을 처리하지 못했어요 ({_last_line(err)})')
    return out


def _last_line(err: bytes | str | None) -> str:
    text = err.decode('utf-8', 'replace') if isinstance(err, bytes) else (err or '')
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if not lines:
        return 'ffmpeg 오류'
    line = lines[-1]
    # File names in ffmpeg messages are in the console code page (mojibake for Korean) — keep the gist only
    line = re.sub(r"'[^']*'", "''", line)
    return line[:160]


def run(args: list[str], *, job=None, duration: float | None = None, inputs=(), progress_span: tuple[float, float] = (0.0, 1.0), timeout: float | None = None) -> None:
    """Run ffmpeg to completion, mapping `-progress` output to job progress. Raises ApiError / JobCancelled."""
    cmd = [require(), '-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', *args]
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **popen_kwargs())
    _track(proc, inputs)
    if job is not None:
        job.add_proc(proc)
    err_chunks: list[bytes] = []

    def read_err():
        try:
            for chunk in iter(lambda: proc.stderr.read(4096), b''):
                err_chunks.append(chunk)
                if len(err_chunks) > 64:
                    del err_chunks[:32]
        except (OSError, ValueError):
            pass

    t = threading.Thread(target=read_err, daemon=True)
    t.start()
    started = time.time()
    a, b = progress_span
    try:
        for raw in iter(proc.stdout.readline, b''):
            line = raw.decode('utf-8', 'replace').strip()
            if job is not None and job.cancelled:
                _kill(proc)
                break
            if timeout and time.time() - started > timeout:
                _kill(proc)
                raise ApiError('ESERVER', '영상 처리 시간이 너무 오래 걸려서 멈췄어요')
            if job is not None and duration and duration > 0:
                key, _, val = line.partition('=')
                if key in ('out_time_us', 'out_time_ms'):
                    try:
                        secs = int(val) / 1_000_000  # both are microseconds in ffmpeg >= 4
                    except ValueError:
                        continue
                    job.set_progress(a + (b - a) * min(1.0, max(0.0, secs / duration)))
        proc.wait()
        t.join(timeout=2)
    finally:
        if proc.poll() is None:
            _kill(proc)
        _untrack(proc)
        if job is not None:
            job.remove_proc(proc)
        for s in (proc.stdout, proc.stderr):
            try:
                s.close()
            except OSError:
                pass
    if job is not None:
        job.check()
    if proc.returncode != 0:
        raise ApiError('ESERVER', f'영상을 처리하지 못했어요 ({_last_line(b"".join(err_chunks))})')


# ---------- probe ----------
_RE_DURATION = re.compile(r'Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)')
_RE_BITRATE = re.compile(r'bitrate:\s*(\d+)\s*kb/s')
_RE_INPUT = re.compile(r'^Input #0,\s*([^,]+(?:,[^,]+)*?),\s*from', re.MULTILINE)
_RE_VIDEO = re.compile(r'Stream #0:(\d+)[^:]*:\s*Video:\s*([\w-]+)(.*)')
_RE_AUDIO = re.compile(r'Stream #0:(\d+)[^:]*:\s*Audio:\s*([\w-]+)(.*)')
_RE_SIZE = re.compile(r'(?:,|\s)(\d{2,5})x(\d{2,5})(?:[\s,\[]|$)')
_RE_FPS = re.compile(r'([\d.]+)\s*fps')
_RE_TBR = re.compile(r'([\d.]+k?)\s*tbr')
_RE_ROT_MATRIX = re.compile(r'rotation of\s*(-?[\d.]+)\s*degrees')
_RE_ROT_TAG = re.compile(r'^\s*rotate\s*:\s*(-?\d+)', re.MULTILINE)
_RE_CREATION = re.compile(r'^\s*creation_time\s*:\s*(\S+)', re.MULTILINE)
_RE_MAKE = re.compile(r'^\s*(?:com\.apple\.quicktime\.make|make)\s*:\s*(.+)$', re.MULTILINE | re.IGNORECASE)
_RE_MODEL = re.compile(r'^\s*(?:com\.apple\.quicktime\.model|model)\s*:\s*(.+)$', re.MULTILINE | re.IGNORECASE)
_RE_HZ = re.compile(r'(\d+)\s*Hz')


def parse_probe(text: str) -> dict:
    info: dict = {
        'format': None, 'duration': None, 'bitrate': None, 'width': None, 'height': None,
        'codedWidth': None, 'codedHeight': None, 'fps': None, 'vcodec': None, 'acodec': None,
        'rotation': 0, 'taken': None, 'camera': None, 'hasVideo': False, 'hasAudio': False,
        'sampleRate': None,
    }
    m = _RE_INPUT.search(text)
    if m:
        info['format'] = m.group(1).split(',')[0].strip()
    m = _RE_DURATION.search(text)
    if m:
        info['duration'] = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    m = _RE_BITRATE.search(text)
    if m:
        info['bitrate'] = int(m.group(1)) * 1000
    vm = _RE_VIDEO.search(text)
    # Skip attached cover pictures (mjpeg/png "attached pic") in favour of a real video stream
    for cand in _RE_VIDEO.finditer(text):
        if 'attached pic' not in cand.group(3):
            vm = cand
            break
    if vm:
        info['hasVideo'] = True
        info['vcodec'] = vm.group(2)
        rest = vm.group(3)
        sm = _RE_SIZE.search(rest)
        if sm:
            info['codedWidth'], info['codedHeight'] = int(sm.group(1)), int(sm.group(2))
        fm = _RE_FPS.search(rest)
        if fm:
            info['fps'] = float(fm.group(1))
        else:
            tm = _RE_TBR.search(rest)
            if tm and not tm.group(1).endswith('k'):
                info['fps'] = float(tm.group(1))
        # Rotation side data/metadata lives in the lines after this stream header
        tail = text[vm.end():]
        nxt = re.search(r'Stream #0:\d', tail)
        block = tail[: nxt.start()] if nxt else tail
        rm = _RE_ROT_MATRIX.search(block)
        rot_cw = 0
        if rm:
            rot_cw = int(round(-float(rm.group(1)))) % 360
        else:
            tg = _RE_ROT_TAG.search(block)
            if tg:
                rot_cw = int(tg.group(1)) % 360
        info['rotation'] = rot_cw
        if info['codedWidth']:
            if rot_cw in (90, 270):
                info['width'], info['height'] = info['codedHeight'], info['codedWidth']
            else:
                info['width'], info['height'] = info['codedWidth'], info['codedHeight']
    am = _RE_AUDIO.search(text)
    if am:
        info['hasAudio'] = True
        info['acodec'] = am.group(2)
        hz = _RE_HZ.search(am.group(3))
        if hz:
            info['sampleRate'] = int(hz.group(1))
    cm = _RE_CREATION.search(text)
    if cm:
        info['taken'] = _parse_iso_ms(cm.group(1))
    make = _RE_MAKE.search(text)
    model = _RE_MODEL.search(text)
    if make or model:
        mk = make.group(1).strip() if make else ''
        md = model.group(1).strip() if model else ''
        info['camera'] = md if mk and md.lower().startswith(mk.lower()) else ' '.join(x for x in (mk, md) if x)
    return info


def _parse_iso_ms(s: str) -> int | None:
    s = s.strip()
    if s.startswith('1970-01-01') or s.startswith('1904-01-01') or s.startswith('0000'):
        return None
    try:
        if s.endswith('Z'):
            s = s[:-1] + '+00:00'
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except ValueError:
        return None


def probe(abs_path: str, st: os.stat_result | None = None) -> dict:
    """Media info via `ffmpeg -i` (cached by path+size+mtime). Raises ApiError if ffmpeg can't read it."""
    st = st or os.stat(abs_path)
    key = (os.path.normcase(abs_path), st.st_size, st.st_mtime_ns)
    with _probe_lock:
        hit = _probe_cache.get(key)
        if hit is not None:
            _probe_cache.move_to_end(key)
            return dict(hit)
    cmd = [require(), '-hide_banner', '-nostdin', '-i', abs_path]
    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, **popen_kwargs())
        _track(proc, [abs_path])
        try:
            _, err = proc.communicate(timeout=30)
        finally:
            _untrack(proc)
    except subprocess.TimeoutExpired:
        _kill(proc)
        raise ApiError('ESERVER', '영상 정보를 읽는 데 너무 오래 걸려요')
    text = err.decode('utf-8', 'replace')
    if 'Input #0' not in text:
        raise ApiError('EINVAL', '영상 정보를 읽을 수 없어요. 손상됐거나 지원하지 않는 형식이에요')
    info = parse_probe(text)
    with _probe_lock:
        _probe_cache[key] = dict(info)
        while len(_probe_cache) > PROBE_CACHE_SIZE:
            _probe_cache.popitem(last=False)
    return info
