"""Native folder selection and workspace registry routes."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict

from . import deps, ffmpeg
from .errors import ApiError, from_os_error
from .workspaces import WorkspaceRegistry

router = APIRouter()
_picker_lock = threading.Lock()
_picker_guard = threading.Lock()
_picker: subprocess.Popen | None = None
_picker_cancelled = False

_PICK_SCRIPT = """
import json
import os
import sys
if os.name == 'nt':
    try:
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # crisp dialog on high-DPI screens
    except Exception:
        pass
import tkinter as tk
from tkinter import filedialog
sys.stdout.reconfigure(encoding='utf-8')
root = tk.Tk()
root.withdraw()
root.attributes('-topmost', True)
root.lift()
root.focus_force()
try:
    chosen = filedialog.askdirectory(parent=root, mustexist=True, title=sys.argv[2] if len(sys.argv) > 2 else '작업 폴더 선택', initialdir=sys.argv[1])
    print(json.dumps(os.path.normpath(chosen) if chosen else '', ensure_ascii=False), flush=True)
finally:
    root.destroy()
"""


class Body(BaseModel):
    model_config = ConfigDict(extra='ignore')


class PickBody(Body):
    initialDir: str = ''


class RootBody(Body):
    root: str


@router.post('/api/workspace/pick')
def pick(request: Request, body: PickBody = PickBody()):
    return native_pick(request, body.initialDir, '작업 폴더 선택')


def native_pick(request: Request, initial_dir: str = '', title: str = '작업 폴더 선택') -> dict:
    """Show the native folder dialog on the desktop: {root} or {cancelled: True}. Shared with /api/dupes/roots/pick."""
    global _picker, _picker_cancelled
    if not _picker_lock.acquire(blocking=False):
        raise ApiError('EBUSY', '폴더 선택 창이 이미 열려 있어요')
    proc = None
    try:
        result = request.app.state.settings.pick_result
        if result is not None:
            return {'root': os.path.normpath(result)} if result else {'cancelled': True}
        initial = initial_dir if isinstance(initial_dir, str) and os.path.isdir(initial_dir) else ''
        if not initial:
            current = request.app.state.registry.current
            initial = current.root if current else os.path.expanduser('~')
        with _picker_guard:
            _picker_cancelled = False
            proc = subprocess.Popen(
                [sys.executable, '-c', _PICK_SCRIPT, initial, title],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                **ffmpeg.popen_kwargs(),
            )
            _picker = proc
        out, _ = proc.communicate()
        with _picker_guard:
            cancelled = _picker_cancelled
        if cancelled:
            return {'cancelled': True}
        if proc.returncode:
            raise ApiError('ENOTSUP', '폴더 선택 창을 열 수 없어요. Python의 tkinter 설치 상태를 확인해 주세요')
        try:
            chosen = json.loads(out.decode('utf-8'))
        except (ValueError, UnicodeError):
            raise ApiError('ESERVER', '선택한 폴더 경로를 읽을 수 없어요')
        if not isinstance(chosen, str):
            raise ApiError('ESERVER', '선택한 폴더 경로를 읽을 수 없어요')
        return {'root': os.path.normpath(chosen)} if chosen else {'cancelled': True}
    except OSError as exc:
        raise from_os_error(exc, noun='폴더') from exc
    finally:
        with _picker_guard:
            if _picker is proc:
                _picker = None
        if proc is not None:
            if proc.poll() is None:
                proc.kill()
            proc.wait()
            for stream in (proc.stdout, proc.stderr):
                if stream:
                    stream.close()
        _picker_lock.release()


@router.post('/api/workspace/pick/cancel')
def cancel_pick():
    global _picker_cancelled
    with _picker_guard:
        if _picker is not None and _picker.poll() is None:
            _picker_cancelled = True
            try:
                _picker.kill()
            except ProcessLookupError:
                pass
    return {'ok': True}


@router.post('/api/workspace/open')
def open_workspace(body: RootBody, registry: WorkspaceRegistry = Depends(deps.registry)):
    return registry.open(body.root).to_dict()


@router.get('/api/workspace/recent')
def recent(registry: WorkspaceRegistry = Depends(deps.registry)):
    return registry.recent()


@router.post('/api/workspace/forget')
def forget(body: RootBody, registry: WorkspaceRegistry = Depends(deps.registry)):
    registry.forget(body.root)
    return {'ok': True}
