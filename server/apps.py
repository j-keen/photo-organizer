"""Detected and user-registered player allow-list; GET/POST /api/apps/players."""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
from pathlib import Path

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict

from .errors import ApiError, from_os_error

router = APIRouter()
_lock = threading.RLock()
PLAYERS = (
    ('팟플레이어', ('PotPlayerMini64.exe', 'PotPlayerMini.exe'), ('DAUM/PotPlayer', 'Kakao/PotPlayer', 'PotPlayer')),
    ('VLC', ('vlc.exe',), ('VideoLAN/VLC',)),
    ('MPC-HC', ('mpc-hc64.exe', 'mpc-hc.exe'), ('MPC-HC', 'MPC-HC x64')),
    ('MPC-BE', ('mpc-be64.exe', 'mpc-be.exe'), ('MPC-BE', 'MPC-BE x64')),
    ('KMPlayer', ('KMPlayer.exe', 'KMPlayer64.exe'), ('KMPlayer', 'KMPlayer 64X')),
    ('GOM', ('GOM.exe', 'GOM64.exe'), ('GRETECH/GomPlayer', 'GOM/GOMPlayer', 'GOM/GOMPlayerPlus')),
)


def _valid(exe: str) -> str:
    if not os.path.isabs(exe) or not exe.lower().endswith('.exe') or not os.path.isfile(exe):
        raise ApiError('EINVAL', '실제로 있는 .exe 파일의 전체 경로를 입력해 주세요')
    target = os.path.realpath(exe)
    if not target.lower().endswith('.exe'):
        raise ApiError('EINVAL', '실행 파일을 골라 주세요')
    return target


def _player(exe: str, name: str) -> dict:
    key = os.path.normcase(exe)
    return {'id': hashlib.sha256(key.encode('utf-8')).hexdigest()[:24], 'name': name, 'exe': exe}


def _registry(executable: str):
    if os.name != 'nt':
        return
    import winreg

    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
            try:
                with winreg.OpenKey(hive, rf'Software\Microsoft\Windows\CurrentVersion\App Paths\{executable}',
                                    0, winreg.KEY_READ | view) as key:
                    value, _ = winreg.QueryValueEx(key, '')
                    if isinstance(value, str):
                        yield os.path.expandvars(value.strip().strip('"'))
            except OSError:
                continue


def _registered(data_dir: Path) -> list[str]:
    try:
        data = json.loads((Path(data_dir) / 'players.json').read_text(encoding='utf-8'))
    except FileNotFoundError:
        return []
    except (ValueError, UnicodeError):
        raise ApiError('ESERVER', '저장한 플레이어 목록을 읽지 못했어요')
    if not isinstance(data, list) or not all(isinstance(value, str) for value in data):
        raise ApiError('ESERVER', '저장한 플레이어 목록을 읽지 못했어요')
    return data


def list_players(data_dir: Path) -> list[dict]:
    with _lock:
        found = {}

        def add(exe, name):
            try:
                target = _valid(exe)
            except ApiError:
                return
            found.setdefault(os.path.normcase(target), _player(target, name))

        if os.name == 'nt':
            roots = dict.fromkeys(filter(None, (os.environ.get('ProgramW6432'), os.environ.get('ProgramFiles'),
                                                os.environ.get('ProgramFiles(x86)'), r'C:\Program Files', r'C:\Program Files (x86)')))
            for name, executables, folders in PLAYERS:
                for executable in executables:
                    for root in roots:
                        for folder in folders:
                            add(os.path.join(root, *folder.split('/'), executable), name)
                    for exe in _registry(executable):
                        add(exe, name)
        for exe in _registered(data_dir):
            add(exe, Path(exe).stem)
        return list(found.values())


def allowed_exe(data_dir: Path, exe: str) -> str:
    if not os.path.isabs(exe):
        raise ApiError('EPERM', '등록한 플레이어만 열 수 있어요')
    key = os.path.normcase(os.path.realpath(exe))
    for player in list_players(data_dir):
        if os.path.normcase(player['exe']) == key:
            return player['exe']
    raise ApiError('EPERM', '등록한 플레이어만 열 수 있어요')


class PlayerBody(BaseModel):
    model_config = ConfigDict(extra='ignore')
    exe: str


@router.get('/api/apps/players')
def players(request: Request):
    try:
        return list_players(request.app.state.data_dir)
    except OSError as exc:
        raise from_os_error(exc) from exc


@router.post('/api/apps/players')
def register(request: Request, body: PlayerBody):
    tmp = None
    try:
        exe = _valid(body.exe)
        directory = Path(request.app.state.data_dir)
        with _lock:
            saved = _registered(directory)
            key = os.path.normcase(exe)
            if not any(os.path.normcase(os.path.realpath(value)) == key for value in saved):
                saved.append(exe)
                # Replace atomically so an interrupted write never loses the previous allow-list.
                with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=directory, delete=False) as stream:
                    tmp = stream.name
                    json.dump(saved, stream, ensure_ascii=False)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(tmp, directory / 'players.json')
                tmp = None
            return next(player for player in list_players(directory) if os.path.normcase(player['exe']) == key)
    except OSError as exc:
        raise from_os_error(exc) from exc
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except FileNotFoundError:
                pass
