"""FastAPI application factory: security middleware, health/session, route modules, static app files."""
from __future__ import annotations

import logging
import os
import re
import sys
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import APP_ID, VERSION, config, errors, ffmpeg, mediacache
from .config import ENTRY_HTML, STATIC_DIRS, Settings
from .errors import ApiError
from .http_utils import bytes_response, file_response
from .jobs import JobManager
from .paths import clean_rel, resolve
from .security import SecurityMiddleware, SessionManager
from .workspaces import WorkspaceRegistry

log = logging.getLogger('fi.app')

_caps: dict | None = None
_caps_lock = threading.Lock()


def register_image_plugins() -> None:
    """Let Pillow open HEIC/HEIF (pillow-heif) — AVIF is built into Pillow 11+."""
    try:
        import pillow_heif

        pillow_heif.register_heif_opener()
    except Exception:  # optional dependency
        pass


def capabilities() -> dict:
    """What this installation can do (computed once; importing faiss takes a moment)."""
    global _caps
    with _caps_lock:
        if _caps is not None:
            return dict(_caps)
        caps = {'ffmpeg': ffmpeg.available(), 'faiss': False, 'heif': False, 'avif': False, 'x264': False, 'pick': False, 'reveal': True}
        try:
            import faiss  # noqa: F401

            caps['faiss'] = True
        except Exception:
            pass
        try:
            import pillow_heif  # noqa: F401

            caps['heif'] = True
        except Exception:
            pass
        try:
            from PIL import features

            caps['avif'] = bool(features.check('avif'))
        except Exception:
            pass
        try:
            import tkinter  # noqa: F401

            caps['pick'] = True
        except Exception:
            pass
        if caps['ffmpeg']:
            caps['x264'] = ffmpeg.has_encoder('libx264')
        _caps = caps
        return dict(caps)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    data_dir = config.app_data_dir(settings.data_dir)
    session = SessionManager()
    registry = WorkspaceRegistry(data_dir)
    jobs = JobManager()
    register_image_plugins()
    threading.Thread(target=capabilities, daemon=True, name='fi-caps').start()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        jobs.shutdown()
        ffmpeg.kill_all()
        mediacache.close_all()

    app = FastAPI(title='Fluid Identity local server', version=VERSION, docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.settings = settings
    app.state.session = session
    app.state.registry = registry
    app.state.jobs = jobs
    app.state.data_dir = data_dir
    errors.install(app)

    # ---------- health & session ----------
    @app.get('/api/health')
    def health():
        return JSONResponse({'app': APP_ID, 'version': VERSION, 'port': settings.port}, headers={'Cache-Control': 'no-store'})

    @app.get('/api/session')
    def get_session(request: Request):
        site = request.headers.get('sec-fetch-site')
        if site not in ('same-origin', 'none'):
            raise ApiError('EPERM', f'이 페이지에서는 서버를 쓸 수 없어요. {settings.base_url} 로 열어 주세요')
        ws = registry.current
        body = {
            'ok': True,
            'app': APP_ID,
            'version': VERSION,
            'platform': sys.platform,
            'port': settings.port,
            'appRoot': os.path.realpath(str(settings.app_root)),
            'capabilities': capabilities(),
            'workspace': ws.to_dict() if ws else None,
        }
        resp = JSONResponse(body, headers={'Cache-Control': 'no-store'})
        resp.headers.append('set-cookie', session.cookie_header())
        return resp

    @app.post('/api/server/shutdown')
    def shutdown():
        """★ Stop the server from the app ('서버 끄기'); the response is sent first."""
        stop = getattr(app.state, 'request_shutdown', None)

        def later():
            if callable(stop):
                stop()
            else:  # started some other way: behave like Ctrl+C
                import _thread

                _thread.interrupt_main()

        threading.Timer(0.25, later).start()
        return {'ok': True}

    # ---------- feature routes ----------
    from . import dupes, media, routes_fs, routes_jobs, routes_workspace, video

    for mod in (routes_workspace, routes_fs, media, video, dupes, routes_jobs):
        app.include_router(mod.router)

    # ---------- static app files (registered last) ----------
    app_root = os.path.realpath(str(settings.app_root))
    meta_tag = f'<meta name="fi-server" content="{VERSION}" data-port="{settings.port}">'

    def entry_html(request: Request):
        try:
            with open(os.path.join(app_root, ENTRY_HTML), 'r', encoding='utf-8') as f:
                html = f.read()
        except FileNotFoundError:
            raise ApiError('ENOENT', f'{ENTRY_HTML} 파일을 찾을 수 없어요')
        html = re.sub(r'(<head[^>]*>)', lambda m: m.group(1) + '\n    ' + meta_tag, html, count=1)
        return bytes_response(request, html.encode('utf-8'), 'text/html; charset=utf-8', cache_control='no-cache')

    @app.api_route('/', methods=['GET', 'HEAD'], include_in_schema=False)
    def index(request: Request):
        return entry_html(request)

    @app.api_route('/{rel_path:path}', methods=['GET', 'HEAD'], include_in_schema=False)
    def static_file(request: Request, rel_path: str):
        if rel_path == 'api' or rel_path.startswith('api/'):
            raise ApiError('ENOENT', '요청한 주소를 찾을 수 없어요')
        if rel_path in (ENTRY_HTML, 'index.html'):
            return entry_html(request)
        try:
            rel = clean_rel(rel_path)
        except ApiError:
            raise ApiError('ENOENT', '요청한 주소를 찾을 수 없어요')
        top = rel.split('/', 1)[0]
        if top not in STATIC_DIRS or '/' not in rel:
            raise ApiError('ENOENT', '요청한 주소를 찾을 수 없어요')
        try:
            abs_path = resolve(app_root, rel)
        except ApiError:
            raise ApiError('ENOENT', '요청한 주소를 찾을 수 없어요')
        if not os.path.isfile(abs_path):
            raise ApiError('ENOENT', '요청한 주소를 찾을 수 없어요')
        return file_response(request, abs_path, cache_control='no-cache')

    app.add_middleware(SecurityMiddleware, port=settings.port, session=session)
    return app
