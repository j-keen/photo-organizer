"""Workspace file operations and streaming HTTP transfers."""
from __future__ import annotations

import os
import stat
import subprocess
import sys

import anyio
from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict
from starlette.concurrency import run_in_threadpool

from . import config, deps, ffmpeg, fsutil, http_utils, paths
from .errors import ApiError, from_os_error
from .workspaces import Workspace

router = APIRouter()


class PathBody(BaseModel):
    model_config = ConfigDict(extra='ignore')
    path: str


class RemoveBody(PathBody):
    # ★ Send to the OS Recycle Bin instead of deleting (Windows). The app uses it when emptying its own trash,
    # so a purge is still recoverable from the Windows Recycle Bin.
    recycle: bool = False


class TransferBody(BaseModel):
    model_config = ConfigDict(extra='ignore')
    src: str
    destDir: str
    name: str


def _stat(ws: Workspace, rel: str):
    target = ws.resolve(rel)
    try:
        return target, os.stat(target)
    except OSError as exc:
        raise from_os_error(exc, rel) from exc


@router.get('/api/fs/list')
def list_entries(path: str = '', ws: Workspace = Depends(deps.workspace)):
    target, st = _stat(ws, path)
    if not stat.S_ISDIR(st.st_mode):
        raise ApiError('EINVAL', '폴더만 목록을 볼 수 있어요')
    entries = []
    try:
        with os.scandir(target) as scan:
            for entry in scan:
                try:
                    if paths.is_link_like(entry.path) and not paths.link_stays_inside(entry.path, ws.root):
                        continue
                    st = entry.stat()
                    entries.append(fsutil.entry_dict(entry.name, st, stat.S_ISDIR(st.st_mode)))
                except OSError:
                    continue
    except OSError as exc:
        raise from_os_error(exc, path, noun='폴더') from exc
    return {'entries': entries}


@router.get('/api/fs/stat')
def stat_entry(path: str = '', ws: Workspace = Depends(deps.workspace)):
    return fsutil.stat_dict(_stat(ws, path)[1])


@router.get('/api/fs/exists')
def exists(path: str = '', ws: Workspace = Depends(deps.workspace)):
    target = ws.resolve(path)
    try:
        st = os.stat(target)
    except (FileNotFoundError, NotADirectoryError):
        return {'exists': False}
    except OSError as exc:
        raise from_os_error(exc, path) from exc
    return {'exists': True, 'kind': 'dir' if stat.S_ISDIR(st.st_mode) else 'file'}


@router.api_route('/api/fs/file', methods=['GET', 'HEAD'])
def get_file(request: Request, path: str, missingOk: bool = False, ws: Workspace = Depends(deps.workspace)):
    target = ws.resolve(path)
    try:
        return http_utils.file_response(request, target, cache_control='no-cache', display=path)
    except ApiError as exc:
        if missingOk and exc.code == 'ENOENT':
            return Response(status_code=204, headers={'X-FI-Missing': '1', 'Cache-Control': 'no-cache'})
        raise
    except FileNotFoundError as exc:
        if missingOk:
            return Response(status_code=204, headers={'X-FI-Missing': '1', 'Cache-Control': 'no-cache'})
        raise from_os_error(exc, path) from exc


def _prepare_write(ws: Workspace, rel: str):
    target = ws.resolve(rel)
    if os.path.isdir(target):
        raise ApiError('EINVAL', '폴더 위에는 파일을 쓸 수 없어요')
    os.makedirs(os.path.dirname(target), exist_ok=True)
    tmp = fsutil.tmp_path_for(target)
    return target, tmp, open(tmp, 'xb')


def _finish_write(writer, tmp: str, target: str, ws: Workspace, rel: str):
    writer.flush()
    os.fsync(writer.fileno())
    writer.close()
    ws.resolve(rel)
    fsutil.retry(os.replace, tmp, target)
    st = os.stat(target)
    return {'ok': True, 'size': st.st_size, 'mtime': fsutil.mtime_ms(st)}


def _discard_write(writer, tmp):
    try:
        if writer is not None:
            writer.close()
    finally:
        if tmp:
            try:
                os.remove(tmp)
            except FileNotFoundError:
                pass


@router.put('/api/fs/file')
async def put_file(request: Request, path: str, ws: Workspace = Depends(deps.workspace)):
    writer = None
    tmp = None
    try:
        target, tmp, writer = await run_in_threadpool(_prepare_write, ws, path)
        async for chunk in request.stream():
            if chunk:
                await run_in_threadpool(writer.write, chunk)
        return await run_in_threadpool(_finish_write, writer, tmp, target, ws, path)
    except OSError as exc:
        raise from_os_error(exc, path, noun='파일') from exc
    finally:
        with anyio.CancelScope(shield=True):
            await run_in_threadpool(_discard_write, writer, tmp)


@router.post('/api/fs/mkdir')
def mkdir(body: PathBody, ws: Workspace = Depends(deps.workspace)):
    target = ws.resolve(body.path)
    try:
        if os.path.lexists(target) and not os.path.isdir(target):
            raise ApiError('EEXIST', '같은 이름의 파일이 이미 있어요')
        os.makedirs(target, exist_ok=True)
    except OSError as exc:
        raise from_os_error(exc, body.path, noun='폴더') from exc
    return {'ok': True}


def _transfer_paths(ws: Workspace, body: TransferBody, *, moving: bool):
    src, st = _stat(ws, body.src)
    if moving and not ws.rel(src):
        raise ApiError('EPERM', '작업 폴더 자체는 옮길 수 없어요')
    directory = ws.resolve(body.destDir)
    name = paths.clean_name(body.name)
    rel = '/'.join(filter(None, (ws.rel(directory), name)))
    dst = ws.resolve(rel)
    if stat.S_ISDIR(st.st_mode) and paths.is_inside(os.path.realpath(dst), os.path.realpath(src)):
        # An identical destination is only meaningful as a case-only move.
        case_only = moving and src != dst and os.path.normcase(src) == os.path.normcase(dst)
        if not case_only:
            raise ApiError('EINVAL', '폴더를 자기 안으로 옮길 수 없어요' if moving else '폴더를 자기 안으로 복사할 수 없어요')
    if os.path.lexists(dst):
        case_only = moving and fsutil.same_file(src, dst) and os.path.normcase(src) == os.path.normcase(dst)
        if not case_only:
            raise ApiError('EEXIST', '같은 이름의 항목이 이미 있어요')
    return src, dst


@router.post('/api/fs/move')
def move(body: TransferBody, ws: Workspace = Depends(deps.workspace)):
    src, dst = _transfer_paths(ws, body, moving=True)
    try:
        ffmpeg.release(src)
        fsutil.move(src, dst, before_retry=lambda: ffmpeg.release(src))
    except OSError as exc:
        raise from_os_error(exc, body.src) from exc
    return {'ok': True, 'path': ws.rel(dst)}


@router.post('/api/fs/copy')
def copy(body: TransferBody, ws: Workspace = Depends(deps.workspace)):
    src, dst = _transfer_paths(ws, body, moving=False)
    try:
        fsutil.copy(src, dst)
    except OSError as exc:
        raise from_os_error(exc, body.src) from exc
    return {'ok': True, 'path': ws.rel(dst)}


@router.post('/api/fs/remove')
def remove(request: Request, body: RemoveBody, ws: Workspace = Depends(deps.workspace)):
    target = ws.resolve(body.path)
    if not ws.rel(target):
        raise ApiError('EPERM', '작업 폴더 자체는 지울 수 없어요')
    try:
        ffmpeg.release(target)
        if not os.path.lexists(target):
            raise FileNotFoundError(target)
        recycled = body.recycle and not request.app.state.settings.dry_shell and fsutil.recycle(target)
        if not recycled:
            fsutil.remove(target, before_retry=lambda: ffmpeg.release(target))
    except OSError as exc:
        raise from_os_error(exc, body.path) from exc
    return {'ok': True, 'recycled': bool(recycled)}


def _launch(request: Request, command: list[str], *, startfile: str | None = None):
    if request.app.state.settings.dry_shell:
        return {'ok': True, 'command': command}
    try:
        if startfile is not None:
            os.startfile(startfile)
        else:
            subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, **ffmpeg.popen_kwargs())
    except OSError as exc:
        raise from_os_error(exc) from exc
    return {'ok': True}


@router.post('/api/fs/reveal')
def reveal(request: Request, body: PathBody, ws: Workspace = Depends(deps.workspace)):
    target, _ = _stat(ws, body.path)
    if os.name == 'nt':
        command = ['explorer', '/select,', target] if ws.rel(target) else ['explorer', target]
    elif sys.platform == 'darwin':
        command = ['open', '-R', target]
    else:
        command = ['xdg-open', os.path.dirname(target) if ws.rel(target) else target]
    return _launch(request, command)


@router.post('/api/fs/open')
def open_default(request: Request, body: PathBody, ws: Workspace = Depends(deps.workspace)):
    target, st = _stat(ws, body.path)
    if not stat.S_ISREG(st.st_mode):
        raise ApiError('EINVAL', '파일만 기본 앱으로 열 수 있어요')
    if config.media_type(target) == 'other':
        # Never launch programs/scripts that happen to live in the workspace
        raise ApiError('EINVAL', '사진과 영상만 기본 앱으로 열 수 있어요')
    if os.name == 'nt':
        return _launch(request, ['explorer', target], startfile=target)
    return _launch(request, ['open' if sys.platform == 'darwin' else 'xdg-open', target])
