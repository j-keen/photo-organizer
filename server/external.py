"""External roots for dupes v2: folders outside the open workspace (e.g. D:\\VideoDownloader) that the user allowed.

A folder is allowed when the user picked it with the native picker (POST /api/dupes/roots/pick, remembered in
<app data>/roots.json), when it is a recent/open workspace root, or when it lies below one of those.
Scanning external roots is read-only; the only write is an explicit quarantine (server/quarantine.py).

File references ("refs") in the dupes API: a workspace file is its workspace-relative path; an external file is its
absolute OS path. `resolve_file()` validates an absolute ref with the same rules as workspace paths (no '..', no ADS ':',
no device names, links never followed out) by re-expressing it relative to its allowed root and using paths.resolve().

    ext = request.app.state.external
    root = ext.resolve_root('D:\\VideoDownloader')            # realpath, EPERM when not allowed
    abs_path, root = ext.resolve_file('D:\\VideoDownloader\\a.mp4')
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path

from .errors import ApiError
from .fsutil import atomic_write
from .paths import is_inside, is_link_like, resolve

QUARANTINE_DIR = '_중복정리'
MAX_PICKED = 12
_ABS = re.compile(r'^(?:[A-Za-z]:[\\/]|\\\\|/)')
NOT_ALLOWED = '고르지 않은 폴더라서 쓸 수 없어요. 중복 검사 화면에서 폴더를 먼저 골라 주세요'


def is_abs_ref(value) -> bool:
    """True for an absolute OS path ref (drive, UNC or POSIX); workspace refs are relative."""
    return isinstance(value, str) and bool(_ABS.match(value))


def display_name(root: str) -> str:
    stripped = root.rstrip('\\/')
    return os.path.basename(stripped) or stripped or root


class ExternalRoots:
    def __init__(self, data_dir: Path, registry) -> None:
        self.file = Path(data_dir) / 'roots.json'
        self.registry = registry
        self._lock = threading.RLock()

    # ----- picked roots (roots.json) -----
    def _load(self) -> list[dict]:
        try:
            with open(self.file, 'r', encoding='utf-8') as f:
                data = json.load(f)
            return [x for x in data if isinstance(x, dict) and isinstance(x.get('root'), str)] if isinstance(data, list) else []
        except (OSError, ValueError):
            return []

    def _save(self, items: list[dict]) -> None:
        atomic_write(str(self.file), [json.dumps(items[:MAX_PICKED], ensure_ascii=False, indent=1).encode('utf-8')])

    def remember(self, root: str) -> dict:
        """Allow a folder the user just picked natively. Returns {root, name}."""
        real = self._existing_dir(root)
        with self._lock:
            items = [x for x in self._load() if os.path.normcase(x['root']) != os.path.normcase(real)]
            items.insert(0, {'root': real, 'name': display_name(real), 'pickedAt': int(time.time() * 1000)})
            try:
                self._save(items)
            except OSError:
                raise ApiError('ESERVER', '고른 폴더를 기억하지 못했어요. 잠시 뒤 다시 해 주세요')
        return {'root': real, 'name': display_name(real)}

    def forget(self, root: str) -> None:
        if not isinstance(root, str) or not root:
            raise ApiError('EINVAL', '폴더 경로가 올바르지 않아요')
        with self._lock:
            items = [x for x in self._load() if os.path.normcase(x['root']) != os.path.normcase(root)
                     and os.path.normcase(x['root']) != os.path.normcase(os.path.realpath(root))]
            try:
                self._save(items)
            except OSError:
                pass

    # ----- allowed set -----
    def allowed(self) -> list[str]:
        """Realpaths of every allowed root (picked first, then workspaces), duplicates removed."""
        out: list[str] = []
        seen: set[str] = set()
        candidates = [x['root'] for x in self._load()] + list(self.registry.recent_roots())
        for root in candidates:
            try:
                real = os.path.realpath(root)
            except (OSError, ValueError):
                continue
            key = os.path.normcase(real)
            if key not in seen:
                seen.add(key)
                out.append(real)
        return out

    def entries(self) -> list[dict]:
        out = []
        seen = set()
        for x in self._load():
            key = os.path.normcase(x['root'])
            if key in seen:
                continue
            seen.add(key)
            out.append({'root': x['root'], 'name': x.get('name') or display_name(x['root']), 'exists': os.path.isdir(x['root']),
                        'source': 'picked', 'pickedAt': x.get('pickedAt') or 0})
        for root in self.registry.recent_roots():
            key = os.path.normcase(root)
            if key in seen:
                continue
            seen.add(key)
            out.append({'root': root, 'name': display_name(root), 'exists': os.path.isdir(root), 'source': 'workspace', 'pickedAt': 0})
        return out

    def owner_root(self, abs_path: str) -> str | None:
        """Most specific allowed root that contains abs_path (lexically and after realpath)."""
        best = None
        try:
            real = os.path.realpath(abs_path)
        except (OSError, ValueError):
            return None
        for root in self.allowed():
            if is_inside(abs_path, root) and is_inside(real, root):
                if best is None or len(root) > len(best):
                    best = root
        return best

    # ----- validation -----
    @staticmethod
    def _check_abs(value) -> str:
        if not isinstance(value, str) or not value.strip():
            raise ApiError('EINVAL', '폴더 경로가 올바르지 않아요')
        if '\x00' in value or not is_abs_ref(value):
            raise ApiError('EINVAL', '전체 경로를 써 주세요 (예: D:\\VideoDownloader)')
        if any(part == '..' for part in re.split(r'[\\/]+', value)):
            raise ApiError('EPERM', NOT_ALLOWED)
        return os.path.normpath(value)

    def _existing_dir(self, value) -> str:
        full = self._check_abs(value)
        real = os.path.realpath(full)
        if not os.path.exists(real):
            raise ApiError('ENOENT', '폴더를 찾을 수 없어요. 옮겨졌거나 드라이브가 빠졌을 수 있어요')
        if not os.path.isdir(real):
            raise ApiError('EINVAL', '파일이 아니라 폴더를 골라 주세요')
        return real

    def resolve_root(self, value) -> str:
        """Realpath of an allowed root (or a folder below one). Raises EINVAL / ENOENT / EPERM."""
        full = self._check_abs(value)
        owner = self.owner_root(full)
        if owner is None:
            raise ApiError('EPERM', NOT_ALLOWED)
        rel = os.path.relpath(full, owner)
        abs_path = resolve(owner, '' if rel == '.' else rel.replace(os.sep, '/'))  # same rules as workspace paths
        if rel != '.' and is_link_like(abs_path):
            raise ApiError('EPERM', '바로 가기(링크) 폴더는 검사할 수 없어요')
        if not os.path.exists(abs_path):
            raise ApiError('ENOENT', '폴더를 찾을 수 없어요. 옮겨졌거나 드라이브가 빠졌을 수 있어요')
        if not os.path.isdir(abs_path):
            raise ApiError('EINVAL', '검사할 경로는 폴더여야 해요')
        return os.path.realpath(abs_path)

    def resolve_file(self, value, root: str | None = None) -> tuple[str, str]:
        """(absolute lexical path, allowed root realpath) for an external file ref. Raises EINVAL / EPERM."""
        full = self._check_abs(value)
        owner = self.owner_root(full)
        if owner is None:
            raise ApiError('EPERM', NOT_ALLOWED)
        if root is not None:
            base = self.resolve_root(root)
            if not is_inside(full, base):
                raise ApiError('EPERM', NOT_ALLOWED)
        rel = os.path.relpath(full, owner)
        if rel == '.':
            raise ApiError('EINVAL', '파일 경로가 올바르지 않아요')
        return resolve(owner, rel.replace(os.sep, '/')), owner
