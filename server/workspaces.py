"""Open workspaces and the recent-workspaces list.

Several browser tabs may have different workspaces open at once, so every fs/media request carries the
workspace token (`?ws=<token>`; falls back to the most recently opened workspace). The token is derived from
the folder's real path, so it stays the same across server restarts; an unknown token is looked up in the
recent list and re-opened transparently, otherwise ENOWS tells the client to re-open by root.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from . import VERSION
from .config import DATA_DIR_NAME
from .errors import ApiError
from .fsutil import atomic_write
from .paths import resolve, to_rel

MAX_RECENT = 12


def token_for(real_root: str) -> str:
    return hashlib.sha1(os.path.normcase(real_root).encode('utf-8')).hexdigest()[:16]


def _new_ws_id() -> str:
    # Same shape as App.util.uid('ws') in the web app
    ms = int(time.time() * 1000)
    digits = '0123456789abcdefghijklmnopqrstuvwxyz'
    b36 = ''
    while ms:
        ms, r = divmod(ms, 36)
        b36 = digits[r] + b36
    return 'ws' + b36 + ''.join(secrets.choice(digits) for _ in range(6))


@dataclass
class Workspace:
    token: str
    id: str
    name: str
    root: str  # realpath of the workspace folder

    @property
    def data_dir(self) -> str:
        return os.path.join(self.root, DATA_DIR_NAME)

    def resolve(self, rel: str | None) -> str:
        return resolve(self.root, rel)

    def rel(self, abs_path: str) -> str:
        return to_rel(self.root, abs_path)

    def to_dict(self) -> dict:
        return {'id': self.id, 'name': self.name, 'root': self.root, 'token': self.token}


def display_name(real_root: str) -> str:
    name = os.path.basename(real_root.rstrip('\\/'))
    return name or real_root.rstrip('\\/') or real_root


class WorkspaceRegistry:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = Path(data_dir)
        self.recent_file = self.data_dir / 'recent.json'
        self._lock = threading.RLock()
        self._open: dict[str, Workspace] = {}
        self._current: str | None = None

    # ----- opening -----
    def open(self, root: str, *, remember: bool = True) -> Workspace:
        if not isinstance(root, str) or not root.strip():
            raise ApiError('EINVAL', '폴더 경로를 입력해 주세요')
        root = os.path.expandvars(root.strip().strip('"'))
        if not os.path.isabs(root):
            raise ApiError('EINVAL', '전체 경로를 입력해 주세요 (예: D:\\사진\\2024)')
        real = os.path.realpath(root)
        if not os.path.exists(real):
            raise ApiError('ENOENT', '폴더를 찾을 수 없어요. 경로를 확인해 주세요')
        if not os.path.isdir(real):
            raise ApiError('EINVAL', '파일이 아니라 폴더를 골라 주세요')
        meta = self._ensure_meta(real)
        token = token_for(real)
        ws = Workspace(token=token, id=meta['id'], name=display_name(real), root=real)
        with self._lock:
            self._open[token] = ws
            self._current = token
        if remember:
            self._remember(ws)
        return ws

    def _ensure_meta(self, real: str) -> dict:
        meta_path = os.path.join(real, DATA_DIR_NAME, 'workspace.json')
        try:
            with open(meta_path, 'r', encoding='utf-8') as f:
                meta = json.load(f)
            if isinstance(meta, dict) and meta.get('id'):
                return meta
        except FileNotFoundError:
            pass
        except (OSError, ValueError):
            pass
        meta = {'id': _new_ws_id(), 'createdAt': int(time.time() * 1000), 'app': 'Fluid Identity', 'version': VERSION}
        try:
            atomic_write(meta_path, [json.dumps(meta, ensure_ascii=False, indent=1).encode('utf-8')])
        except PermissionError:
            raise ApiError('EPERM', '이 폴더에는 쓸 수 없어서 작업 폴더로 열 수 없어요')
        return meta

    # ----- lookup -----
    @property
    def current(self) -> Workspace | None:
        with self._lock:
            return self._open.get(self._current) if self._current else None

    def get(self, token: str | None) -> Workspace:
        with self._lock:
            if token:
                ws = self._open.get(token)
                if ws:
                    return ws
            elif self._current and self._current in self._open:
                return self._open[self._current]
        if token:
            # Server restarted? Re-open silently if this token belongs to a recent workspace.
            for item in self._load_recent():
                root = item.get('root')
                if root and token_for(os.path.realpath(root)) == token and os.path.isdir(root):
                    return self.open(root, remember=False)
            raise ApiError('ENOWS', '작업 폴더를 다시 열어야 해요')
        raise ApiError('ENOWS', '작업 폴더가 열려 있지 않아요')

    def all_open(self) -> list[Workspace]:
        with self._lock:
            return list(self._open.values())

    # ----- recent list (%APPDATA%/FluidIdentity/recent.json) -----
    def _load_recent(self) -> list[dict]:
        try:
            with open(self.recent_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
            return [x for x in data if isinstance(x, dict) and isinstance(x.get('root'), str)] if isinstance(data, list) else []
        except (OSError, ValueError):
            return []

    def _save_recent(self, items: list[dict]) -> None:
        try:
            atomic_write(str(self.recent_file), [json.dumps(items[:MAX_RECENT], ensure_ascii=False, indent=1).encode('utf-8')])
        except OSError:
            pass

    def _remember(self, ws: Workspace) -> None:
        with self._lock:
            items = [x for x in self._load_recent() if os.path.normcase(x['root']) != os.path.normcase(ws.root)]
            items.insert(0, {'root': ws.root, 'name': ws.name, 'openedAt': int(time.time() * 1000)})
            self._save_recent(items)

    def recent(self) -> list[dict]:
        out = []
        for x in self._load_recent():
            out.append({'root': x['root'], 'name': x.get('name') or display_name(x['root']), 'openedAt': x.get('openedAt') or 0, 'exists': os.path.isdir(x['root'])})
        return out

    def forget(self, root: str) -> None:
        if not isinstance(root, str):
            raise ApiError('EINVAL', '폴더 경로가 올바르지 않아요')
        with self._lock:
            items = [x for x in self._load_recent() if os.path.normcase(x['root']) != os.path.normcase(root)]
            self._save_recent(items)
