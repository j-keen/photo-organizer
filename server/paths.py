"""Workspace-relative path validation and safe resolution.

Every `path` the API receives is workspace-relative ("a/b.jpg", "/" separators, "" = workspace root).
We reject absolute paths, drive letters, ".." segments, backslashes, NUL, and on Windows also ":" (alternate
data streams), reserved device names (CON, NUL, COM1...) and trailing dots/spaces. After joining with the
root we `realpath` the result and refuse anything outside the root, so symlinks/junctions can't escape.
"""
from __future__ import annotations

import os
import re
import stat as stat_mod

from .errors import ApiError

IS_WINDOWS = os.name == 'nt'
_DRIVE = re.compile(r'^[A-Za-z]:')
_RESERVED = re.compile(r'^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$', re.IGNORECASE)
_WIN_BAD = set('<>:"|?*')

OUTSIDE_MESSAGE = '작업 폴더 밖의 경로는 쓸 수 없어요'


def clean_rel(rel: str | None) -> str:
    """Validate a workspace-relative path and return it normalized ('' for the root)."""
    if rel is None:
        return ''
    if not isinstance(rel, str):
        raise ApiError('EINVAL', '경로가 올바르지 않아요')
    if rel in ('', '.'):
        return ''
    if '\x00' in rel:
        raise ApiError('EINVAL', '경로에 쓸 수 없는 문자가 있어요')
    if '\\' in rel:
        raise ApiError('EINVAL', '경로 구분자는 / 를 써야 해요')
    if rel.startswith('/') or _DRIVE.match(rel):
        raise ApiError('EPERM', OUTSIDE_MESSAGE)
    if rel.endswith('/'):
        rel = rel[:-1]
    parts = rel.split('/')
    for seg in parts:
        if seg == '..':
            raise ApiError('EPERM', OUTSIDE_MESSAGE)
        if seg in ('', '.'):
            raise ApiError('EINVAL', '경로가 올바르지 않아요')
        if any(ord(c) < 32 for c in seg):
            raise ApiError('EINVAL', '경로에 쓸 수 없는 문자가 있어요')
        if IS_WINDOWS:
            if any(c in _WIN_BAD for c in seg):
                raise ApiError('EINVAL', '경로에 쓸 수 없는 문자가 있어요 (< > : " | ? *)')
            if seg[-1] in '. ':
                raise ApiError('EINVAL', '이름 끝에 마침표나 공백은 쓸 수 없어요')
            if _RESERVED.match(seg):
                raise ApiError('EINVAL', '시스템 예약 이름이라 쓸 수 없어요')
    return '/'.join(parts)


def clean_name(name: str | None) -> str:
    """Validate a single file/folder name (no separators)."""
    if not isinstance(name, str) or not name or '/' in name:
        raise ApiError('EINVAL', '이름이 올바르지 않아요')
    if len(name) > 255:
        raise ApiError('EINVAL', '이름이 너무 길어요')
    clean_rel(name)
    return name


def _norm(p: str) -> str:
    return os.path.normcase(os.path.normpath(p))


def is_inside(path: str, root: str) -> bool:
    """True if `path` is `root` or below it (both should be absolute; compared case-insensitively on Windows)."""
    p = _norm(path)
    r = _norm(root)
    if p == r:
        return True
    if not r.endswith(os.sep):
        r += os.sep
    return p.startswith(r)


def resolve(root: str, rel: str | None) -> str:
    """Absolute path for a workspace-relative path. `root` must already be a realpath.

    Returns the lexical path (so operations act on links themselves, like a file manager) after verifying
    that its realpath stays inside the workspace.
    """
    rel = clean_rel(rel)
    full = os.path.normpath(os.path.join(root, *rel.split('/'))) if rel else root
    real = os.path.realpath(full)
    if not is_inside(real, root) or not is_inside(full, root):
        raise ApiError('EPERM', '작업 폴더 밖을 가리키는 바로 가기는 따라갈 수 없어요' if is_inside(full, root) else OUTSIDE_MESSAGE)
    return full


def to_rel(root: str, abs_path: str) -> str:
    """Workspace-relative '/'-separated path for an absolute path inside root ('' for the root)."""
    rel = os.path.relpath(abs_path, root)
    if rel == '.':
        return ''
    return rel.replace(os.sep, '/')


def is_link_like(path: str, st: os.stat_result | None = None) -> bool:
    """Symlink or (on Windows) a junction / other name-surrogate reparse point."""
    try:
        st = st or os.lstat(path)
    except OSError:
        return False
    if stat_mod.S_ISLNK(st.st_mode):
        return True
    if IS_WINDOWS:
        attrs = getattr(st, 'st_file_attributes', 0)
        if attrs & stat_mod.FILE_ATTRIBUTE_REPARSE_POINT:
            isjunction = getattr(os.path, 'isjunction', None)
            if isjunction is not None:
                return isjunction(path) or stat_mod.S_ISLNK(st.st_mode)
            return True
    return False


def link_stays_inside(path: str, root: str) -> bool:
    """For a link-like entry: does its target resolve inside the workspace?"""
    try:
        return is_inside(os.path.realpath(path), root)
    except OSError:
        return False
