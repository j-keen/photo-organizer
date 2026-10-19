"""python -m server [--port 8765] [--open] [--workspace D:\\Photos]"""
from __future__ import annotations

import argparse
import http.client
import json
import logging
import os
import socket
import sys
import threading
import time
import webbrowser

from . import APP_ID, VERSION
from .config import DEFAULT_PORT, HOST, Settings


def _setup_console() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            if not stream.isatty():
                stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError, OSError):
            pass


def _probe_port(port: int) -> str:
    """'free' | 'ours' (a Fluid Identity server already answers) | 'busy' (something else / not bindable)."""
    conn = http.client.HTTPConnection(HOST, port, timeout=0.6)
    try:
        conn.request('GET', '/api/health', headers={'Host': f'{HOST}:{port}'})
        body = conn.getresponse().read()
        try:
            data = json.loads(body.decode('utf-8'))
            if isinstance(data, dict) and data.get('app') == APP_ID:
                return 'ours'
        except (ValueError, UnicodeDecodeError):
            pass
        return 'busy'  # something else answers on this port
    except http.client.HTTPException:
        return 'busy'  # not HTTP / closed the connection: still taken
    except (ConnectionRefusedError, socket.timeout, OSError):
        pass
    finally:
        conn.close()
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if os.name == 'nt' and hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            s.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        s.bind((HOST, port))
        return 'free'
    except OSError:
        return 'busy'
    finally:
        s.close()


def _open_when_ready(server, url: str) -> None:
    deadline = time.time() + 20
    while time.time() < deadline:
        if getattr(server, 'started', False):
            webbrowser.open(url)
            return
        time.sleep(0.1)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog='python -m server', description='Fluid Identity 로컬 서버')
    parser.add_argument('--port', type=int, default=None, help=f'포트 번호 (기본 {DEFAULT_PORT})')
    parser.add_argument('--open', action='store_true', help='서버가 켜지면 브라우저로 앱을 열어요')
    parser.add_argument('--workspace', metavar='FOLDER', help='시작할 때 이 폴더를 작업 폴더로 열어요')
    parser.add_argument('--log-level', default=os.environ.get('FI_LOG_LEVEL', 'warning'), help='uvicorn 로그 수준 (기본 warning)')
    args = parser.parse_args(argv)
    _setup_console()
    logging.basicConfig(level=logging.WARNING if args.log_level == 'warning' else logging.INFO, format='%(levelname)s %(name)s: %(message)s')

    explicit = args.port is not None or bool(os.environ.get('FI_PORT'))
    port = args.port or int(os.environ.get('FI_PORT') or DEFAULT_PORT)
    state = _probe_port(port)
    if state == 'ours':
        url = f'http://{HOST}:{port}/'
        print(f'Fluid Identity 서버가 이미 켜져 있어요 → {url}')
        if args.open:
            webbrowser.open(url)
        return 0
    if state == 'busy':
        if explicit:
            print(f'포트 {port}번을 쓸 수 없어요 (다른 프로그램이 쓰는 중이거나 Windows가 예약한 번호예요).')
            print('다른 번호로 실행해 주세요. 예: python -m server --port 8790')
            return 2
        for candidate in range(port + 1, port + 30):
            if _probe_port(candidate) == 'free':
                print(f'포트 {port}번을 다른 프로그램이 쓰고 있어서 {candidate}번으로 열어요.')
                port = candidate
                break
        else:
            print('비어 있는 포트를 찾지 못했어요. --port 로 번호를 지정해 주세요.')
            return 2

    import uvicorn

    from .app import capabilities, create_app
    from .errors import ApiError

    settings = Settings(port=port, open_browser=args.open)
    app = create_app(settings)
    if args.workspace:
        try:
            ws = app.state.registry.open(args.workspace)
            print(f'작업 폴더: {ws.root}')
        except ApiError as e:
            print(f'작업 폴더를 열지 못했어요: {e.message}')

    url = settings.base_url
    caps = capabilities()

    def mark(ok: bool) -> str:
        return '켜짐' if ok else '없음'

    print('')
    print(f'  Fluid Identity 로컬 서버 {VERSION}')
    print(f'  주소     {url}')
    print(f'  기능     영상 처리(ffmpeg) {mark(caps["ffmpeg"])} · 중복 찾기(FAISS) {mark(caps["faiss"])} · HEIC {mark(caps["heif"])}')
    print('  끄려면 이 창을 닫거나 Ctrl+C를 누르세요.')
    print('')

    config = uvicorn.Config(app, host=HOST, port=port, log_level=args.log_level, access_log=False, server_header=False, timeout_graceful_shutdown=3)
    server = uvicorn.Server(config)
    app.state.request_shutdown = lambda: setattr(server, 'should_exit', True)
    if args.open:
        threading.Thread(target=_open_when_ready, args=(server, url), daemon=True).start()
    try:
        server.run()
    except KeyboardInterrupt:
        pass
    print('서버를 껐어요.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
