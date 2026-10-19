"""Fluid Identity local companion server.

Runs only on the user's PC (bound to 127.0.0.1) and unlocks what a browser can't do well:
HEIC/TIFF thumbnails, any video codec, lossless trims/merges/rotations (ffmpeg), FAISS duplicate
search, a native folder picker and "show in Explorer". Contract: docs/server-api.md.

    python -m server --open
"""

VERSION = '2.1.0'
APP_ID = 'fluid-identity'
# Goes up whenever the web app needs new endpoints (docs/server-api.md "apiVersion"). The app compares it with its own
# App.server.API_VERSION and asks to restart an old server process.
API_VERSION = 2
