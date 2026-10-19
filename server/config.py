"""Static configuration: paths, ports, media type tables, MIME types, runtime settings."""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parent
APP_ROOT = SERVER_DIR.parent  # the repo folder that holds 사진영상정리기.html
ENTRY_HTML = '사진영상정리기.html'
HOST = '127.0.0.1'
DEFAULT_PORT = 8765

# Top-level folders of APP_ROOT that are served as static files at "/<dir>/...". Everything else
# (server/, .git, node_modules, docs, tests ...) is never served.
STATIC_DIRS = ('css', 'js', 'vendor', 'assets', 'fonts', 'img')

# Workspace data folder (catalog, trash, thumbs cache, hashes.sqlite) — same name the web app uses.
DATA_DIR_NAME = '.fluid-organizer'
HIDDEN_NAMES = {'desktop.ini', 'thumbs.db', '.ds_store', '$recycle.bin', 'system volume information'}

# Same tables as js/core/app.js (keep in sync)
IMAGE_EXT = {'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'heic', 'heif', 'tif', 'tiff', 'svg', 'jfif'}
VIDEO_EXT = {'mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi', 'wmv', 'flv', '3gp', 'ts', 'm2ts', 'mts', 'mpg', 'mpeg'}
BROWSER_IMAGE_EXT = {'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'svg', 'jfif'}
BROWSER_VIDEO_EXT = {'mp4', 'm4v', 'webm', 'mov', 'mkv'}

MIME = {
    # app files
    'html': 'text/html; charset=utf-8',
    'js': 'text/javascript; charset=utf-8',
    'mjs': 'text/javascript; charset=utf-8',
    'css': 'text/css; charset=utf-8',
    'json': 'application/json; charset=utf-8',
    'map': 'application/json; charset=utf-8',
    'txt': 'text/plain; charset=utf-8',
    'md': 'text/markdown; charset=utf-8',
    'woff': 'font/woff',
    'woff2': 'font/woff2',
    'ttf': 'font/ttf',
    'ico': 'image/x-icon',
    # images
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'jfif': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'bmp': 'image/bmp',
    'avif': 'image/avif',
    'heic': 'image/heic',
    'heif': 'image/heif',
    'tif': 'image/tiff',
    'tiff': 'image/tiff',
    'svg': 'image/svg+xml',
    # videos
    'mp4': 'video/mp4',
    'm4v': 'video/mp4',
    'webm': 'video/webm',
    'mov': 'video/quicktime',
    'mkv': 'video/x-matroska',
    'avi': 'video/x-msvideo',
    'wmv': 'video/x-ms-wmv',
    'flv': 'video/x-flv',
    '3gp': 'video/3gpp',
    'ts': 'video/mp2t',
    'm2ts': 'video/mp2t',
    'mts': 'video/mp2t',
    'mpg': 'video/mpeg',
    'mpeg': 'video/mpeg',
}


def ext_of(name: str) -> str:
    base = name.replace('\\', '/').rsplit('/', 1)[-1]
    i = base.rfind('.')
    return base[i + 1:].lower() if i > 0 else ''


def media_type(name: str) -> str:
    """'image' | 'video' | 'other' (same rules as App.util.mediaType)."""
    ext = ext_of(name)
    if ext in IMAGE_EXT:
        return 'image'
    if ext in VIDEO_EXT:
        return 'video'
    return 'other'


def browser_can_decode(name: str) -> bool:
    ext = ext_of(name)
    return ext in BROWSER_IMAGE_EXT or ext in BROWSER_VIDEO_EXT


def content_type(name: str) -> str:
    return MIME.get(ext_of(name), 'application/octet-stream')


def is_hidden_name(name: str) -> bool:
    return name.startswith('.') or name.lower() in HIDDEN_NAMES


def app_data_dir(override: str | os.PathLike | None = None) -> Path:
    """Per-user server data (recent workspaces). FI_DATA_DIR overrides it (tests)."""
    env = override or os.environ.get('FI_DATA_DIR')
    if env:
        p = Path(env)
    elif os.name == 'nt':
        p = Path(os.environ.get('APPDATA') or (Path.home() / 'AppData' / 'Roaming')) / 'FluidIdentity'
    elif sys.platform == 'darwin':
        p = Path.home() / 'Library' / 'Application Support' / 'FluidIdentity'
    else:
        p = Path(os.environ.get('XDG_CONFIG_HOME') or (Path.home() / '.config')) / 'fluid-identity'
    p.mkdir(parents=True, exist_ok=True)
    return p


@dataclass
class Settings:
    """Runtime settings for one server instance (create_app(settings))."""

    port: int = DEFAULT_PORT
    app_root: Path = APP_ROOT
    data_dir: Path | None = None  # None -> app_data_dir()
    open_browser: bool = False
    # Tests set FI_DRY_SHELL=1 so reveal/open-with-default-app don't pop up Explorer windows.
    dry_shell: bool = field(default_factory=lambda: os.environ.get('FI_DRY_SHELL') == '1')
    # Tests set FI_PICK_RESULT to a folder (or '' for "cancelled") instead of showing the native dialog.
    pick_result: str | None = field(default_factory=lambda: os.environ.get('FI_PICK_RESULT'))

    @property
    def base_url(self) -> str:
        return f'http://{HOST}:{self.port}/'
