"""One-click start: desktop shortcut + icon, single instance with a version handshake, restart, windowless logging.

    python -m server --open --install-shortcut   (start.bat: first run creates the shortcut once the server is up)
    pythonw -m server --open --resume            (the shortcut '사진영상정리기': no console window)

* health(port) / decide(info) — before starting, ask the fixed port who is there:
    'start'   nobody → start the server
    'open'    our server, same (or newer) apiVersion → only open the browser
    'replace' our server, older apiVersion → ask it to shut down, wait for the port, start the new one
    'busy'    another program → explain (the launcher never hops to another port: the browser origin, and with it the
              app's saved settings, must stay http://127.0.0.1:8765)
* create_shortcuts() — Desktop + Start-menu '사진영상정리기.lnk' (WScript.Shell via PowerShell), icon generated with Pillow.
* spawn_server() — detached new server process (restart from the app).
* windowless() / message_box() — pythonw has no console: logs go to <app data>/server.log, problems to a message box.
"""
from __future__ import annotations

import base64
import http.client
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from . import API_VERSION, APP_ID
from .config import APP_ROOT, DEFAULT_PORT, HOST, SERVER_DIR, app_data_dir

APP_TITLE = '사진영상정리기'
SHORTCUT_NAME = APP_TITLE + '.lnk'
STAMP = SERVER_DIR / '.venv' / 'shortcut.stamp'


class LauncherError(Exception):
    pass


# ---------- single instance / handshake ----------
def health(port: int, timeout: float = 0.8) -> dict | None:
    """/api/health of whatever answers on the port: dict (any JSON object), {} for a non-JSON answer, None when closed."""
    conn = http.client.HTTPConnection(HOST, port, timeout=timeout)
    try:
        conn.request('GET', '/api/health', headers={'Host': f'{HOST}:{port}'})
        body = conn.getresponse().read()
        try:
            data = json.loads(body.decode('utf-8'))
            return data if isinstance(data, dict) else {}
        except (ValueError, UnicodeDecodeError):
            return {}
    except http.client.HTTPException:
        return {}
    except OSError:
        return None
    finally:
        conn.close()


def decide(info: dict | None, api_version: int = API_VERSION) -> str:
    """What a launch should do given the port's /api/health answer: 'start' | 'open' | 'replace' | 'busy'."""
    if info is None:
        return 'start'
    if info.get('app') != APP_ID:
        return 'busy'
    theirs = info.get('apiVersion')
    theirs = theirs if isinstance(theirs, int) and not isinstance(theirs, bool) else 1  # round-1 servers had none
    return 'replace' if theirs < api_version else 'open'


def _api(port: int, method: str, path: str, *, cookie: str | None = None, timeout: float = 3) -> http.client.HTTPResponse:
    conn = http.client.HTTPConnection(HOST, port, timeout=timeout)
    headers = {'Host': f'{HOST}:{port}', 'Sec-Fetch-Site': 'none'}
    if cookie:
        headers['Cookie'] = cookie
    body = None
    if method != 'GET':
        headers.update({'X-FI-Client': '1', 'Content-Type': 'application/json'})
        body = b'{}'
    conn.request(method, path, body=body, headers=headers)
    resp = conn.getresponse()
    resp.read()
    conn.close()
    return resp


def stop_running(port: int, wait: float = 15) -> bool:
    """Ask the Fluid Identity server on `port` to shut down (any version has /api/server/shutdown) and wait until the
    port is free. True when it is gone."""
    try:
        session = _api(port, 'GET', '/api/session')
        cookie = (session.getheader('set-cookie') or '').split(';', 1)[0] or None
        _api(port, 'POST', '/api/server/shutdown', cookie=cookie)
    except (OSError, http.client.HTTPException):
        pass
    return wait_port_free(port, wait)


def wait_port_free(port: int, wait: float = 15) -> bool:
    deadline = time.time() + wait
    while time.time() < deadline:
        if health(port, timeout=0.4) is None:
            return True
        time.sleep(0.15)
    return health(port, timeout=0.4) is None


# ---------- detached server process (restart) ----------
def _windowless_python() -> str:
    exe = Path(sys.executable)
    if os.name == 'nt':
        candidate = exe.with_name('pythonw.exe')
        if candidate.exists():
            return str(candidate)
    return str(exe)


def spawn_server(*, port: int, workspace: str | None = None, wait_port: bool = False, open_browser: bool = False) -> subprocess.Popen:
    """Start `python -m server` as an independent process (survives this one). With wait_port it waits for the port
    to be free first (restart: the old server exits right after spawning)."""
    args = [_windowless_python(), '-m', 'server', '--port', str(port)]
    if wait_port:
        args.append('--wait-port')
    if workspace:
        args += ['--workspace', workspace]
    else:
        args.append('--resume')
    if open_browser:
        args.append('--open')
    kwargs: dict = {'cwd': str(APP_ROOT), 'stdin': subprocess.DEVNULL, 'stdout': subprocess.DEVNULL, 'stderr': subprocess.DEVNULL,
                    'close_fds': True}
    if os.name == 'nt':
        kwargs['creationflags'] = (getattr(subprocess, 'DETACHED_PROCESS', 0x8) | getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0x200)
                                   | getattr(subprocess, 'CREATE_NO_WINDOW', 0x08000000))
    else:
        kwargs['start_new_session'] = True
    env = dict(os.environ)
    env.pop('FI_PORT', None)
    return subprocess.Popen(args, env=env, **kwargs)


# ---------- windowless mode (pythonw) ----------
def windowless() -> bool:
    return sys.stdout is None or sys.stderr is None


def redirect_output() -> Path | None:
    """pythonw has no console: send prints/logs to <app data>/server.log (trimmed when it grows over 2 MB)."""
    try:
        log_path = app_data_dir() / 'server.log'
        if log_path.exists() and log_path.stat().st_size > 2 * 1024 * 1024:
            log_path.replace(log_path.with_suffix('.log.old'))
        stream = open(log_path, 'a', encoding='utf-8', errors='replace', buffering=1)
        stream.write(f'\n----- {time.strftime("%Y-%m-%d %H:%M:%S")} -----\n')
        sys.stdout = sys.stderr = stream
        return log_path
    except OSError:
        devnull = open(os.devnull, 'w', encoding='utf-8')
        sys.stdout = sys.stderr = devnull
        return None


def message_box(text: str, title: str = APP_TITLE, *, error: bool = True) -> None:
    """Native Windows message box (the only way to talk to the user without a console). No-op elsewhere or in tests."""
    if os.name != 'nt' or os.environ.get('FI_DRY_SHELL') == '1':
        return
    try:
        import ctypes

        ctypes.windll.user32.MessageBoxW(None, text, title, 0x10 if error else 0x40)
    except Exception:
        pass


# ---------- icon ----------
def make_icon(path: Path) -> Path:
    """A crisp app icon (rounded indigo→violet square, white photo frame with a play mark) as a multi-size .ico."""
    from PIL import Image, ImageDraw

    size = 256
    scale = 4  # supersample for smooth edges
    big = size * scale
    gradient = Image.new('RGBA', (big, big))
    top, bottom = (99, 102, 241), (168, 85, 247)
    draw = ImageDraw.Draw(gradient)
    for y in range(big):
        k = y / (big - 1)
        draw.line([(0, y), (big, y)], fill=tuple(round(a + (b - a) * k) for a, b in zip(top, bottom)) + (255,))
    mask = Image.new('L', (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, big - 1, big - 1], radius=56 * scale, fill=255)
    icon = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    icon.paste(gradient, (0, 0), mask)
    s = scale
    white = (255, 255, 255, 255)
    # back card (stack) on its own layer so its translucency blends with the gradient
    back = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(back).rounded_rectangle([72 * s, 54 * s, 208 * s, 162 * s], radius=16 * s, fill=(255, 255, 255, 110))
    icon.alpha_composite(back)
    d = ImageDraw.Draw(icon)
    # front frame, a mountain + sun, and a small play badge
    d.rounded_rectangle([50 * s, 78 * s, 186 * s, 190 * s], radius=16 * s, fill=white)
    d.polygon([(66 * s, 174 * s), (106 * s, 124 * s), (134 * s, 156 * s), (150 * s, 138 * s), (172 * s, 174 * s)], fill=(124, 92, 246, 255))
    d.ellipse([140 * s, 96 * s, 162 * s, 118 * s], fill=(251, 191, 36, 255))
    d.ellipse([150 * s, 150 * s, 214 * s, 214 * s], fill=(17, 24, 39, 255), outline=white, width=6 * s)
    d.polygon([(174 * s, 166 * s), (174 * s, 198 * s), (200 * s, 182 * s)], fill=white)
    out = icon.resize((size, size), Image.Resampling.LANCZOS)
    path.parent.mkdir(parents=True, exist_ok=True)
    out.save(path, format='ICO', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    return path


# ---------- shortcuts ----------
_PS_SHORTCUT = r"""
$ErrorActionPreference = 'Stop'
$override = $env:FI_SHORTCUT_DIR
if ($override) { $dirs = @($override, (Join-Path $override 'Programs')) }
else { $dirs = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')) }
$shell = New-Object -ComObject WScript.Shell
$made = @()
foreach ($dir in $dirs) {
    if (-not $dir) { continue }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $path = Join-Path $dir $env:FI_LNK_NAME
    $s = $shell.CreateShortcut($path)
    $s.TargetPath = $env:FI_LNK_TARGET
    $s.Arguments = $env:FI_LNK_ARGS
    $s.WorkingDirectory = $env:FI_LNK_CWD
    $s.IconLocation = $env:FI_LNK_ICON + ',0'
    $s.Description = $env:FI_LNK_DESC
    $s.WindowStyle = 7
    $s.Save()
    $made += $path
}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$made | ConvertTo-Json -Compress
"""


def shortcut_target(port: int = DEFAULT_PORT) -> tuple[str, str]:
    """(program, arguments) the shortcut runs: the venv's pythonw with `-m server --open --resume` (+ the port when it
    isn't the default, so the browser keeps the same address — and with it the app's saved settings)."""
    args = '-m server --open --resume'
    if port != DEFAULT_PORT:
        args += f' --port {int(port)}'
    return _windowless_python(), args


def create_shortcuts(*, port: int = DEFAULT_PORT, dry: bool = False) -> list[str]:
    """Create/refresh Desktop and Start-menu shortcuts. Returns their paths. FI_SHORTCUT_DIR redirects them (tests);
    dry=True (FI_DRY_SHELL test servers) only reports what it would create."""
    if os.name != 'nt':
        raise LauncherError('바탕화면 아이콘은 Windows에서만 만들 수 있어요')
    override = os.environ.get('FI_SHORTCUT_DIR')
    if dry and not override:
        return []
    icon = make_icon(app_data_dir() / 'app.ico')
    program, arguments = shortcut_target(port)
    env = dict(os.environ, FI_LNK_NAME=SHORTCUT_NAME, FI_LNK_TARGET=program, FI_LNK_ARGS=arguments, FI_LNK_CWD=str(APP_ROOT),
               FI_LNK_ICON=str(icon), FI_LNK_DESC='사진영상정리기 — 로컬 서버와 앱을 함께 켜요')
    script = base64.b64encode(_PS_SHORTCUT.encode('utf-16-le')).decode('ascii')
    try:
        proc = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', script],
                              capture_output=True, env=env, timeout=60, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except (OSError, subprocess.SubprocessError) as exc:
        raise LauncherError(f'바탕화면 아이콘을 만들지 못했어요 ({exc})') from exc
    if proc.returncode != 0:
        detail = proc.stderr.decode('utf-8', 'replace').strip().splitlines()[-1:] or ['']
        raise LauncherError(f'바탕화면 아이콘을 만들지 못했어요 ({detail[0][:120]})')
    try:
        made = json.loads(proc.stdout.decode('utf-8-sig').strip() or '[]')
    except ValueError:
        made = []
    return [made] if isinstance(made, str) else [p for p in made if isinstance(p, str)]


def install_shortcut_once(port: int = DEFAULT_PORT) -> list[str] | None:
    """start.bat's first successful run: create the shortcuts unless that already happened (stamp in the venv)."""
    if STAMP.exists():
        return None
    made = create_shortcuts(port=port)
    try:
        STAMP.parent.mkdir(parents=True, exist_ok=True)
        STAMP.write_text(time.strftime('%Y-%m-%d %H:%M:%S') + '\n', encoding='utf-8')
    except OSError:
        pass
    return made
