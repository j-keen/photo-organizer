"""Fluid Identity local companion server.

Runs only on the user's PC (bound to 127.0.0.1) and unlocks what a browser can't do well:
HEIC/TIFF thumbnails, any video codec, lossless trims/merges/rotations (ffmpeg), FAISS duplicate
search, a native folder picker and "show in Explorer". Contract: docs/server-api.md.

    python -m server --open
"""

VERSION = '2.0.0'
APP_ID = 'fluid-identity'
