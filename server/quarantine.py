"""Reversible external-file quarantine with durable, repairable journals."""
from __future__ import annotations

import errno
import hashlib
import json
import os
import re
import shutil
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field, StrictStr

from . import deps, errors, external as external_module, ffmpeg, fsutil, paths
from .errors import ApiError

router = APIRouter()
_LOG_NAME = '정리기록.json'
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()
_index_lock = threading.Lock()
_NUMBER = re.compile(r'^(\d{3,})_')


def _now() -> int:
    return time.time_ns() // 1_000_000


def _lock(root: str):
    with _locks_guard:
        return _locks.setdefault(os.path.normcase(os.path.abspath(root)), threading.Lock())


def _write_json(filename: str, value) -> None:
    fsutil.atomic_write(filename, [json.dumps(value, ensure_ascii=False, indent=1).encode('utf-8')])


def _check_chain(full: str, root: str) -> None:
    """Reject link-like ancestors, including the root, before accessing a journal or moving files."""
    if not os.path.isabs(full) or not paths.is_inside(full, root):
        raise ApiError('EINVAL', '정리 폴더에서 파일을 찾을 수 없어요')
    current = os.path.abspath(root)
    if paths.is_link_like(current):
        raise ApiError('EPERM', '바로 가기(링크) 폴더에는 파일을 옮길 수 없어요')
    rel = os.path.relpath(full, current)
    if rel != '.':
        for part in rel.split(os.sep):
            current = os.path.join(current, part)
            if paths.is_link_like(current):
                raise ApiError('EPERM', '바로 가기(링크) 폴더에는 파일을 옮길 수 없어요')
    if not paths.is_inside(os.path.realpath(full), os.path.realpath(root)):
        raise ApiError('EPERM', '바로 가기(링크) 폴더에는 파일을 옮길 수 없어요')


def _save_log(qdir: str, log: dict) -> None:
    _check_chain(os.path.join(qdir, _LOG_NAME), os.path.dirname(qdir))
    _write_json(os.path.join(qdir, _LOG_NAME), log)


def _valid_item(item) -> bool:
    return (isinstance(item, dict)
            and all(isinstance(item.get(k), str) for k in ('id', 'path', 'to', 'state'))
            and item['state'] in ('moving', 'moved', 'restored')
            and all(isinstance(item.get(k), int) and not isinstance(item.get(k), bool)
                    for k in ('size', 'mtime', 'at'))
            and isinstance(item.get('reason', ''), str)
            and (item.get('keep') is None or isinstance(item.get('keep'), str)))


def _item_paths_safe(item: dict, root: str) -> bool:
    qdir = os.path.join(root, external_module.QUARANTINE_DIR)
    try:
        original, dest = item['path'], item['to']
        if not all(os.path.isabs(p) for p in (original, dest)):
            return False
        # Do not allow dot segments, even if normalization would stay inside.
        if any(part == '..' for p in (original, dest) for part in re.split(r'[\\/]+', p)):
            return False
        if not paths.is_inside(original, root) or not paths.is_inside(dest, qdir):
            return False
        if os.path.normcase(os.path.normpath(dest)) == os.path.normcase(qdir):
            return False
        if paths.is_inside(original, qdir):
            return False
        _check_chain(original, root)
        _check_chain(dest, root)
        return True
    except (OSError, ValueError, ApiError):
        return False


def _load_log(qdir: str) -> dict:
    """Caller holds the root lock. Repair crash records before returning."""
    root = os.path.dirname(qdir)
    filename = os.path.join(qdir, _LOG_NAME)
    _check_chain(filename, root)
    empty = {'version': 1, 'items': []}
    try:
        with fsutil.open_shared(filename) as stream:
            log = json.load(stream)
    except FileNotFoundError:
        return empty
    except (ValueError, UnicodeError):
        log = None
    if (not isinstance(log, dict) or log.get('version') != 1
            or not isinstance(log.get('items'), list)
            or not all(_valid_item(x) for x in log['items'])):
        backup = f'{filename}.broken-{_now()}'
        while os.path.lexists(backup):
            backup += '-' + uuid.uuid4().hex[:8]
        # Preserve corrupt bytes before creating a fresh journal.
        _rename_new(filename, backup)
        return empty
    repaired = []
    changed = False
    for item in log['items']:
        if item['state'] == 'moving' and _item_paths_safe(item, root):
            changed = True
            if os.path.lexists(item['path']) or not os.path.lexists(item['to']):
                continue
            item['state'] = 'moved'
        repaired.append(item)
    if changed:
        log['items'] = repaired
        _save_log(qdir, log)
    return log


def _read_index(data_dir) -> dict[str, str]:
    try:
        with fsutil.open_shared(str(Path(data_dir) / 'quarantine.json')) as stream:
            value = json.load(stream)
        if isinstance(value, dict) and all(isinstance(k, str) and isinstance(v, str)
                                           and os.path.isabs(v) for k, v in value.items()):
            return value
    except (OSError, ValueError, UnicodeError):
        pass
    return {}


def _index_snapshot(data_dir) -> dict[str, str]:
    with _index_lock:
        return _read_index(data_dir)


def _index_add(data_dir, ident: str, root: str) -> None:
    with _index_lock:
        index = _read_index(data_dir)
        index[ident] = root
        _write_json(str(Path(data_dir) / 'quarantine.json'), index)


def _roots(external, data_dir) -> list[str]:
    candidates = list(_index_snapshot(data_dir).values()) + list(external.allowed())
    unique = {}
    for root in candidates:
        unique.setdefault(os.path.normcase(os.path.normpath(root)), root)
    return list(unique.values())


def _full_hash(path: str) -> bytes:
    digest = hashlib.blake2b()
    with fsutil.open_shared(path) as stream:
        while chunk := stream.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.digest()


def _rename_new(src: str, dest: str) -> None:
    """Windows rename refuses replacement. POSIX uses atomic exclusive publication."""
    if os.path.lexists(dest):
        raise FileExistsError(errno.EEXIST, 'exists', dest)
    if os.name == 'nt':
        fsutil.retry(os.rename, src, dest)
    else:
        # POSIX rename silently replaces files; a hard link avoids that risk.
        os.link(src, dest, follow_symlinks=False)
        try:
            os.unlink(src)
        except OSError:
            fsutil.remove(dest)
            raise


def _move_verified(src: str, dest: str) -> None:
    ffmpeg.release(src)
    try:
        _rename_new(src, dest)
        return
    except OSError as exc:
        if getattr(exc, 'winerror', None) != 17 and exc.errno != errno.EXDEV:
            raise
    tmp = fsutil.tmp_path_for(dest)
    published = False
    try:
        before = os.stat(src)
        shutil.copy2(src, tmp)
        if _full_hash(tmp) != _full_hash(src):
            raise ApiError('ESERVER', '복사한 파일이 원본과 달라서 옮기지 않았어요')
        after = os.stat(src)
        if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
            raise ApiError('ESERVER', '원본 파일이 바뀌어서 옮기지 않았어요. 다시 해 주세요')
        fsutil.publish_new(tmp, dest)
        published = True
        fsutil.remove(src)
    except Exception:
        # If source deletion failed, undo only our published copy. Never delete the source.
        if published and os.path.lexists(src):
            fsutil.remove(dest)
        raise
    finally:
        if os.path.lexists(tmp):
            fsutil.remove(tmp)


def _failure(exc: Exception, key: str, value: str) -> dict:
    if isinstance(exc, ApiError):
        error = exc
    elif isinstance(exc, OSError):
        error = errors.from_os_error(exc, os.path.basename(value), noun='파일')
    else:
        error = ApiError('ESERVER', '파일 작업을 마치지 못했어요. 정리 기록을 확인해 주세요')
    return {key: value, 'code': error.code, 'message': error.message}


def quarantine(external, ws, data_dir, refs, keep=None, reason='') -> dict:
    result = {'moved': [], 'failed': []}
    keeper = None
    if keep is not None:
        try:
            if external_module.is_abs_ref(keep):
                keeper, _ = external.resolve_file(keep)
            elif ws is not None:
                keeper = ws.resolve(keep)
            if keeper is None or not os.path.isfile(keeper) or paths.is_link_like(keeper):
                raise ValueError('missing keeper')
        except (ApiError, OSError, ValueError):
            result['failed'] = [{'path': p, 'code': 'ENOENT',
                                 'message': '남길 파일이 없어서 옮기지 않았어요'} for p in refs]
            return result
    for ref in refs:
        try:
            if not external_module.is_abs_ref(ref):
                raise ApiError('EINVAL', '파일의 전체 경로를 써 주세요')
            src, root = external.resolve_file(ref)
            if ws is not None and paths.is_inside(os.path.realpath(src), ws.root):
                raise ApiError('EINVAL', '작업 폴더 안 파일은 앱 휴지통으로 보내 주세요')
            with _lock(root):
                _check_chain(src, root)
                if not os.path.lexists(src):
                    raise ApiError('ENOENT', '파일을 찾을 수 없어요')
                if paths.is_link_like(src) or not os.path.isfile(src):
                    raise ApiError('EINVAL', '파일만 정리할 수 있어요')
                qdir = os.path.join(root, external_module.QUARANTINE_DIR)
                if paths.is_inside(src, qdir):
                    raise ApiError('EINVAL', '이미 정리 폴더에 있는 파일이에요')
                if keeper is not None:
                    if not os.path.isfile(keeper):
                        raise ApiError('ENOENT', '남길 파일이 없어서 옮기지 않았어요')
                    if os.path.normcase(src) == os.path.normcase(keeper) or os.path.samefile(src, keeper):
                        raise ApiError('EINVAL', '남길 파일과 같은 파일이에요')
                _check_chain(qdir, root)
                os.makedirs(qdir, exist_ok=True)
                log = _load_log(qdir)
                # Numbers are never reused, also after a restore emptied the slot (the log stays unambiguous)
                names = os.listdir(qdir) + [os.path.basename(x['to']) for x in log['items']]
                number = max((int(m.group(1)) for name in names if (m := _NUMBER.match(name))), default=0) + 1
                while True:
                    dest = os.path.join(qdir, f'{number:03d}_{os.path.basename(src)}')
                    if not os.path.lexists(dest):
                        break
                    number += 1
                st = os.stat(src)
                item = {'id': uuid.uuid4().hex[:12], 'path': src, 'to': dest,
                        'size': st.st_size, 'mtime': fsutil.mtime_ms(st), 'at': _now(),
                        'reason': reason, 'keep': keep, 'state': 'moving'}
                log['items'].append(item)
                _save_log(qdir, log)
                # Persist discovery before any destructive step, even if this root is later forgotten.
                _index_add(data_dir, item['id'], root)
                try:
                    _move_verified(src, dest)
                except Exception:
                    if os.path.lexists(src) and not os.path.lexists(dest):
                        log['items'].remove(item)
                        _save_log(qdir, log)
                    # Ambiguous partial outcomes retain their journal for recovery.
                    raise
                item['state'] = 'moved'
                _save_log(qdir, log)
                result['moved'].append({k: item[k] for k in ('id', 'path', 'to', 'size')})
        except Exception as exc:
            result['failed'].append(_failure(exc, 'path', ref))
    return result


def restore(external, data_dir, ids) -> dict:
    result = {'restored': [], 'failed': []}
    for ident in ids:
        try:
            index = _index_snapshot(data_dir)
            roots = ([index[ident]] if ident in index else []) + _roots(external, data_dir)
            found = False
            seen = set()
            for root in roots:
                key = os.path.normcase(os.path.normpath(root))
                if key in seen:
                    continue
                seen.add(key)
                with _lock(root):
                    qdir = os.path.join(root, external_module.QUARANTINE_DIR)
                    log = _load_log(qdir)
                    item = next((x for x in log['items'] if x['id'] == ident), None)
                    if item is None:
                        continue
                    found = True
                    if item['state'] == 'restored':
                        raise ApiError('EINVAL', '이미 되돌린 파일이에요')
                    if item['state'] != 'moved' or not _item_paths_safe(item, root):
                        raise ApiError('EINVAL', '정리 폴더에서 파일을 찾을 수 없어요')
                    if not os.path.isfile(item['to']):
                        raise ApiError('ENOENT', '정리 폴더에서 파일을 찾을 수 없어요')
                    target = item['path']
                    stem, ext = os.path.splitext(target)
                    number = 1
                    while os.path.lexists(target):
                        suffix = '복원' if number == 1 else f'복원 {number}'
                        target = f'{stem} ({suffix}){ext}'
                        number += 1
                    _check_chain(target, root)
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    # Log the intended restore destination before moving, for manual recovery
                    # if persisting the final restored state fails.
                    item['restoredTo'] = target
                    item['restoredAt'] = _now()
                    _save_log(qdir, log)
                    ffmpeg.release(item['to'])
                    fsutil.move(item['to'], target)
                    item['state'] = 'restored'
                    _save_log(qdir, log)
                    result['restored'].append({'id': ident, 'path': target})
                    break
            if not found:
                raise ApiError('ENOENT', '정리 기록을 찾을 수 없어요')
        except Exception as exc:
            result['failed'].append(_failure(exc, 'id', ident))
    return result


def list_items(external, data_dir) -> dict:
    items = {}
    for root in _roots(external, data_dir):
        try:
            with _lock(root):
                log = _load_log(os.path.join(root, external_module.QUARANTINE_DIR))
                for item in log['items']:
                    if (item['state'] == 'moved' and _item_paths_safe(item, root)
                            and os.path.isfile(item['to'])):
                        entry = {k: item.get(k) for k in ('id', 'path', 'to', 'size', 'at', 'reason', 'keep')}
                        entry['root'] = root
                        items.setdefault(item['id'], entry)
        except (OSError, ValueError, ApiError):
            # An unavailable drive must not hide the records on other drives.
            continue
    return {'items': sorted(items.values(), key=lambda x: x['at'], reverse=True)}


class QuarantineBody(BaseModel):
    model_config = ConfigDict(extra='ignore')
    paths: list[StrictStr] = Field(min_length=1, max_length=10000)
    keep: StrictStr | None = None
    reason: StrictStr = Field(default='', max_length=200)


class RestoreBody(BaseModel):
    model_config = ConfigDict(extra='ignore')
    ids: list[StrictStr] = Field(min_length=1, max_length=10000)


def _optional_workspace(request: Request, ws: str | None = None):
    """The workspace of ?ws=<token> (or the current one) — None when nothing is open (quarantine still works)."""
    try:
        return deps.workspace(request, ws)
    except ApiError:
        return request.app.state.registry.current


@router.post('/api/dupes/quarantine')
def quarantine_route(body: QuarantineBody, request: Request, ws=Depends(_optional_workspace)):
    return quarantine(request.app.state.external, ws, request.app.state.data_dir,
                      body.paths, body.keep, body.reason)


@router.post('/api/dupes/restore')
def restore_route(body: RestoreBody, request: Request):
    return restore(request.app.state.external, request.app.state.data_dir, body.ids)


@router.get('/api/dupes/quarantine')
def list_route(request: Request):
    return list_items(request.app.state.external, request.app.state.data_dir)
