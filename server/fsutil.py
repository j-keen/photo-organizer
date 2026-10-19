"""File system helpers with the Windows details handled once:

* open_shared(): read handles that allow rename/delete while open (FILE_SHARE_DELETE), so streaming a video
  never blocks moving it to the trash.
* retry(): transient sharing violations (antivirus, indexer, our own ffmpeg) are retried briefly.
* atomic_write(): temp file in the same folder + fsync + os.replace.
* move()/copy()/remove(): keep timestamps, never clobber, never follow links out of the workspace.
"""
from __future__ import annotations

import errno
import os
import shutil
import stat as stat_mod
import sys
import time
import uuid
from typing import BinaryIO, Callable, Iterable, TypeVar

from .paths import is_link_like

IS_WINDOWS = os.name == 'nt'
TMP_PREFIX = '.fi-tmp-'  # dot-prefixed: the web app hides it while it exists
T = TypeVar('T')

_TRANSIENT_WINERRORS = {5, 32, 33}


def mtime_ms(st: os.stat_result) -> int:
    return st.st_mtime_ns // 1_000_000


def entry_dict(name: str, st: os.stat_result, is_dir: bool) -> dict:
    d = {'name': name, 'kind': 'dir' if is_dir else 'file', 'mtime': mtime_ms(st)}
    if not is_dir:
        d['size'] = st.st_size
    return d


def stat_dict(st: os.stat_result) -> dict:
    is_dir = stat_mod.S_ISDIR(st.st_mode)
    d = {'kind': 'dir' if is_dir else 'file', 'mtime': mtime_ms(st)}
    if not is_dir:
        d['size'] = st.st_size
    return d


def retry(fn: Callable[..., T], *args, attempts: int = 8, delay: float = 0.05, on_retry: Callable[[], None] | None = None) -> T:
    """Call fn(*args), retrying Windows sharing violations / transient access denials (~2s total)."""
    for i in range(attempts):
        try:
            return fn(*args)
        except PermissionError as e:
            if not IS_WINDOWS or getattr(e, 'winerror', None) not in _TRANSIENT_WINERRORS or i == attempts - 1:
                raise
            if on_retry:
                on_retry()
            time.sleep(delay * (1.6 ** i))
    raise AssertionError('unreachable')


if IS_WINDOWS:
    import ctypes
    import msvcrt
    from ctypes import wintypes

    _kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    _CreateFileW = _kernel32.CreateFileW
    _CreateFileW.restype = wintypes.HANDLE
    _CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    _INVALID_HANDLE = wintypes.HANDLE(-1).value
    _GENERIC_READ = 0x80000000
    _SHARE_ALL = 0x1 | 0x2 | 0x4  # READ | WRITE | DELETE
    _OPEN_EXISTING = 3
    _FILE_ATTRIBUTE_NORMAL = 0x80
    _FILE_FLAG_BACKUP_SEMANTICS = 0x02000000

    def open_shared(path: str) -> BinaryIO:
        """Open for reading without blocking renames/deletes of the file by others (or by us)."""
        handle = _CreateFileW(path, _GENERIC_READ, _SHARE_ALL, None, _OPEN_EXISTING, _FILE_ATTRIBUTE_NORMAL, None)
        if handle == _INVALID_HANDLE or handle is None:
            code = ctypes.get_last_error()
            raise ctypes.WinError(code)
        try:
            fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        except Exception:
            _kernel32.CloseHandle(handle)
            raise
        return os.fdopen(fd, 'rb')
else:

    def open_shared(path: str) -> BinaryIO:
        return open(path, 'rb')


def iter_file(f: BinaryIO, start: int = 0, length: int | None = None, chunk: int = 256 * 1024) -> Iterable[bytes]:
    """Yield [start, start+length) of an open file, closing it at the end (or when the consumer stops)."""
    try:
        f.seek(start)
        remaining = length
        while remaining is None or remaining > 0:
            n = chunk if remaining is None else min(chunk, remaining)
            data = f.read(n)
            if not data:
                break
            if remaining is not None:
                remaining -= len(data)
            yield data
    finally:
        f.close()


def tmp_path_for(target: str) -> str:
    d, base = os.path.split(target)
    ext = os.path.splitext(base)[1]
    return os.path.join(d, f'{TMP_PREFIX}{uuid.uuid4().hex[:10]}{ext}.part' if ext else f'{TMP_PREFIX}{uuid.uuid4().hex[:10]}.part')


def atomic_write(target: str, chunks: Iterable[bytes]) -> int:
    """Write chunks to target atomically (creates parent folders). Returns bytes written."""
    os.makedirs(os.path.dirname(target), exist_ok=True)
    tmp = tmp_path_for(target)
    total = 0
    try:
        with open(tmp, 'wb') as f:
            for c in chunks:
                if c:
                    f.write(c)
                    total += len(c)
            f.flush()
            os.fsync(f.fileno())
        retry(os.replace, tmp, target)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    return total


def same_file(a: str, b: str) -> bool:
    try:
        return os.path.samefile(a, b)
    except OSError:
        return False


def _clear_readonly(path: str) -> None:
    try:
        os.chmod(path, stat_mod.S_IWRITE | stat_mod.S_IREAD)
    except OSError:
        pass


def move(src: str, dst: str, *, before_retry: Callable[[], None] | None = None) -> None:
    """Rename/move src to dst (dst must not exist, except a case-only rename of the same file).

    Keeps timestamps. Parent folders of dst are created. Falls back to copy+delete across volumes.
    """
    if not os.path.lexists(src):
        raise FileNotFoundError(errno.ENOENT, 'not found', src)
    if os.path.lexists(dst) and not same_file(src, dst):
        raise FileExistsError(errno.EEXIST, 'exists', dst)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    try:
        retry(os.rename, src, dst, on_retry=before_retry)
    except OSError as e:
        cross_device = getattr(e, 'winerror', None) == 17 or e.errno == errno.EXDEV
        if not cross_device:
            raise
        tmp = tmp_path_for(dst)
        if os.path.isdir(src) and not is_link_like(src):
            shutil.copytree(src, tmp, symlinks=True, copy_function=shutil.copy2)
        else:
            shutil.copy2(src, tmp, follow_symlinks=False)
        os.replace(tmp, dst)
        remove(src)


def copy(src: str, dst: str) -> None:
    """Copy a file or folder tree to dst (must not exist). Timestamps are kept; links are copied as links."""
    if not os.path.lexists(src):
        raise FileNotFoundError(errno.ENOENT, 'not found', src)
    if os.path.lexists(dst):
        raise FileExistsError(errno.EEXIST, 'exists', dst)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = tmp_path_for(dst)
    try:
        if os.path.isdir(src) and not is_link_like(src):
            shutil.copytree(src, tmp, symlinks=True, copy_function=shutil.copy2)
        else:
            shutil.copy2(src, tmp, follow_symlinks=False)
        if os.path.lexists(dst):
            raise FileExistsError(errno.EEXIST, 'exists', dst)
        retry(os.rename, tmp, dst)
    except BaseException:
        if os.path.lexists(tmp):
            remove(tmp)
        raise


def remove(path: str, *, before_retry: Callable[[], None] | None = None) -> None:
    """Delete permanently. Links/junctions are removed without touching their targets."""
    st = os.lstat(path)
    if is_link_like(path, st):
        if stat_mod.S_ISDIR(st.st_mode) or (IS_WINDOWS and os.path.isdir(path)):
            try:
                os.rmdir(path)  # junction / directory symlink
                return
            except OSError:
                pass
        os.unlink(path)
        return
    if stat_mod.S_ISDIR(st.st_mode):

        def onexc(func, p, exc):
            exc = exc[1] if isinstance(exc, tuple) else exc
            if isinstance(exc, PermissionError):
                _clear_readonly(p)
                retry(func, p, on_retry=before_retry)
            elif isinstance(exc, FileNotFoundError):
                return
            else:
                raise exc

        def run():
            if sys.version_info >= (3, 12):
                shutil.rmtree(path, onexc=onexc)
            else:
                shutil.rmtree(path, onerror=onexc)

        retry(run, on_retry=before_retry)
        return

    def unlink():
        try:
            os.remove(path)
        except PermissionError:
            if not (os.stat(path).st_mode & stat_mod.S_IWRITE):
                _clear_readonly(path)
                os.remove(path)
            else:
                raise

    retry(unlink, on_retry=before_retry)


if IS_WINDOWS:

    class _SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [
            ('hwnd', wintypes.HWND),
            ('wFunc', wintypes.UINT),
            ('pFrom', wintypes.LPCWSTR),
            ('pTo', wintypes.LPCWSTR),
            ('fFlags', ctypes.c_ushort),
            ('fAnyOperationsAborted', wintypes.BOOL),
            ('hNameMappings', wintypes.LPVOID),
            ('lpszProgressTitle', wintypes.LPCWSTR),
        ]

    _FO_DELETE = 3
    _FOF_SILENT, _FOF_NOCONFIRMATION, _FOF_ALLOWUNDO, _FOF_NOERRORUI = 0x4, 0x10, 0x40, 0x400


def recycle(path: str) -> bool:
    """Move a file/folder to the OS Recycle Bin (Windows). Returns False when not possible (caller deletes instead)."""
    if not IS_WINDOWS or len(path) >= 259 or not os.path.lexists(path):
        return False
    try:
        op = _SHFILEOPSTRUCTW()
        op.hwnd = None
        op.wFunc = _FO_DELETE
        op.pFrom = os.path.abspath(path) + '\0'  # ctypes adds the second terminating NUL
        op.pTo = None
        op.fFlags = _FOF_SILENT | _FOF_NOCONFIRMATION | _FOF_ALLOWUNDO | _FOF_NOERRORUI
        rc = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
        return rc == 0 and not op.fAnyOperationsAborted and not os.path.lexists(path)
    except Exception:
        return False


def unique_child(dir_abs: str, name: str, *, is_dir: bool = False) -> str:
    """'photo.jpg' -> 'photo (2).jpg' until free (same scheme as App.fs.uniqueName)."""
    stem, ext = (name, '') if is_dir else os.path.splitext(name)
    if not stem:
        stem, ext = name, ''
    candidate = name
    i = 2
    while os.path.lexists(os.path.join(dir_abs, candidate)):
        candidate = f'{stem} ({i}){ext}'
        i += 1
    return candidate


def numbered_child(dir_abs: str, stem: str, tag: str, ext: str, *, width: int = 2) -> str:
    """'<stem>_<tag>01<ext>', '<stem>_<tag>02<ext>' ... first free name (ext includes the dot)."""
    i = 1
    while True:
        candidate = f'{stem}_{tag}{str(i).zfill(width)}{ext}'
        if not os.path.lexists(os.path.join(dir_abs, candidate)):
            return candidate
        i += 1
