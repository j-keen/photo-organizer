"""API errors: {"error": {"code": "...", "message": "<Korean>"}} with a matching HTTP status.

Codes (docs/server-api.md + server extensions):
  ENOENT 404 · EEXIST 409 · EINVAL 400 · EPERM 403 · EBUSY 423 · ESERVER 500
  ESESSION 401 (cookie missing/expired → client calls GET /api/session again)
  ENOWS 409    (workspace token unknown → client re-opens the workspace by root)
  ENOTSUP 501  (feature unavailable: ffmpeg/faiss/heif missing, format not supported)
"""
from __future__ import annotations

import errno
import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger('fi.errors')

STATUS = {
    'ENOENT': 404,
    'EEXIST': 409,
    'EINVAL': 400,
    'EPERM': 403,
    'EBUSY': 423,
    'ESERVER': 500,
    'ESESSION': 401,
    'ENOWS': 409,
    'ENOTSUP': 501,
}


class ApiError(Exception):
    def __init__(self, code: str, message: str, status: int | None = None, **extra):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status or STATUS.get(code, 400)
        self.extra = extra

    def to_dict(self) -> dict:
        err = {'code': self.code, 'message': self.message}
        err.update(self.extra)
        return {'error': err}

    def response(self, headers: dict | None = None) -> JSONResponse:
        return JSONResponse(self.to_dict(), status_code=self.status, headers=headers)


def not_found(message: str = '찾을 수 없어요') -> ApiError:
    return ApiError('ENOENT', message)


def invalid(message: str) -> ApiError:
    return ApiError('EINVAL', message)


def forbidden(message: str) -> ApiError:
    return ApiError('EPERM', message)


def unsupported(message: str) -> ApiError:
    return ApiError('ENOTSUP', message)


def _label(display: str | None, noun: str) -> str:
    return f'"{display}" {noun}' if display else noun


def from_os_error(e: OSError, display: str | None = None, *, noun: str = '항목') -> ApiError:
    """Map an OSError to a friendly Korean ApiError. `display` is a workspace-relative path or name."""
    what = _label(display, noun)
    winerror = getattr(e, 'winerror', None)
    if isinstance(e, FileNotFoundError) or winerror in (2, 3):
        return ApiError('ENOENT', f'{what}을(를) 찾을 수 없어요')
    if isinstance(e, FileExistsError) or winerror in (80, 183):
        return ApiError('EEXIST', f'{what}이(가) 이미 있어요')
    if isinstance(e, NotADirectoryError) or winerror == 267:
        return ApiError('EINVAL', f'{what}은(는) 폴더가 아니에요')
    if isinstance(e, IsADirectoryError):
        return ApiError('EINVAL', f'{what}은(는) 폴더예요')
    if winerror in (32, 33):
        return ApiError('EBUSY', f'{what}을(를) 다른 프로그램이 쓰고 있어요. 그 프로그램을 닫고 다시 해 주세요')
    if winerror == 145 or e.errno == errno.ENOTEMPTY:
        return ApiError('EBUSY', f'{what}이(가) 비어 있지 않아요')
    if winerror in (39, 112) or e.errno == errno.ENOSPC:
        return ApiError('ESERVER', '디스크 공간이 부족해요')
    if winerror == 17 or e.errno == errno.EXDEV:
        return ApiError('EINVAL', '다른 드라이브로는 바로 옮길 수 없어요')
    if isinstance(e, PermissionError) or winerror == 5:
        return ApiError('EPERM', f'{what}에 접근할 권한이 없어요')
    if winerror in (21, 1117) or e.errno == errno.EIO:
        return ApiError('ESERVER', '드라이브를 읽을 수 없어요. 연결 상태를 확인해 주세요')
    detail = e.strerror or str(e)
    return ApiError('ESERVER', f'파일 작업에 실패했어요 ({detail})')


def install(app: FastAPI) -> None:
    """Register handlers so every error leaves as the JSON error shape."""

    @app.exception_handler(ApiError)
    async def _api_error(_request: Request, exc: ApiError):
        return exc.response()

    @app.exception_handler(OSError)
    async def _os_error(_request: Request, exc: OSError):
        return from_os_error(exc).response()

    @app.exception_handler(RequestValidationError)
    async def _validation(_request: Request, exc: RequestValidationError):
        fields = []
        for err in exc.errors()[:3]:
            loc = [str(x) for x in err.get('loc', ()) if x not in ('body', 'query')]
            if loc:
                fields.append('.'.join(loc))
        hint = f' ({", ".join(fields)})' if fields else ''
        return ApiError('EINVAL', f'요청 내용이 올바르지 않아요{hint}').response()

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_request: Request, exc: StarletteHTTPException):
        if exc.status_code == 404:
            return ApiError('ENOENT', '요청한 주소를 찾을 수 없어요').response()
        if exc.status_code == 405:
            return ApiError('EINVAL', '지원하지 않는 요청 방식이에요', status=405).response()
        return ApiError('ESERVER' if exc.status_code >= 500 else 'EINVAL', str(exc.detail), status=exc.status_code).response()

    @app.exception_handler(Exception)
    async def _unexpected(_request: Request, exc: Exception):
        log.exception('unexpected server error')
        return ApiError('ESERVER', f'서버에서 문제가 생겼어요 ({type(exc).__name__})').response()
