# Local server API (v1)

Optional Python companion (`server/`). Runs only on the user's PC, bound to `127.0.0.1`. It serves the app
itself at `http://127.0.0.1:8765/` and unlocks what a browser can't do well: HEIC/TIFF/RAW-ish thumbnails, any
video codec, lossless trims/merges/rotations (ffmpeg), FAISS near-duplicate search, native folder picker,
instant moves that keep timestamps, "show in Explorer".

Start: `server\start.bat` (creates `server\.venv`, installs `requirements.txt`, runs `python -m server`, opens the browser).
Deps: `fastapi`, `uvicorn`, `numpy`, `pillow`, `pillow-heif` (optional), `faiss-cpu`, `imageio-ffmpeg` (bundled ffmpeg binary).

## Security (must)
- Bind to 127.0.0.1 only. Reject requests whose `Host` isn't `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding).
- Session: `GET /api/session` sets cookie `fi_session=<random>` (`HttpOnly; SameSite=Strict; Path=/`) **only** when
  `Sec-Fetch-Site` is `same-origin` or `none`. Every other `/api/*` call requires that cookie; mutating calls
  (POST/PUT/DELETE) additionally require header `X-FI-Client: 1` (forces a CORS preflight that we never approve).
- `GET /api/health` is the only endpoint that works without a session; it answers `{"app":"fluid-identity","version":...}`
  with `Access-Control-Allow-Origin: *` so a page opened from file:// can detect the server and offer to switch.
- All `path` parameters are workspace-relative (`a/b.jpg`, `/` separators). Reject absolute paths, drive letters,
  `..` segments, and anything that resolves (after `realpath`) outside the workspace root. Never follow symlinks out.
- Errors: HTTP 4xx/5xx with `{"error": {"code": "ENOENT"|"EEXIST"|"EINVAL"|"EPERM"|"EBUSY"|"ESERVER", "message": "<Korean>"}}`.

## Workspace
| Method & path | Body / query | Returns |
|---|---|---|
| `GET /api/session` | | `{ok, version, capabilities: {faiss, ffmpeg, heif}, workspace: {id,name,root}|null}` |
| `POST /api/workspace/pick` | | opens a native folder dialog on the desktop (tkinter); `{root}` or `{cancelled: true}` |
| `POST /api/workspace/open` | `{root}` absolute path | `{id, name, root}` (creates `.fluid-organizer/workspace.json` if missing) |
| `GET /api/workspace/recent` | | `[{root, name, openedAt}]` (stored in `%APPDATA%/FluidIdentity/recent.json`) |

## File system (mirrors the App.fs backend interface)
| Method & path | Body / query | Returns |
|---|---|---|
| `GET /api/fs/list` | `?path=` | `{entries: [{name, kind: 'file'|'dir', size, mtime}]}` (mtime in ms) |
| `GET /api/fs/stat` | `?path=` | `{kind, size, mtime}` |
| `GET /api/fs/file` | `?path=` | raw bytes, correct `Content-Type`, `Accept-Ranges`/`Range` (206) support, `ETag` |
| `PUT /api/fs/file` | `?path=`, raw body | `{ok}` (creates parent dirs; atomic write via temp + replace) |
| `POST /api/fs/mkdir` | `{path}` | `{ok}` |
| `POST /api/fs/move` | `{src, destDir, name}` | `{ok}` — `os.replace`/`shutil.move`, keeps mtime; fails with EEXIST if target exists |
| `POST /api/fs/copy` | `{src, destDir, name}` | `{ok}` — `shutil.copy2`/`copytree` (keeps mtime) |
| `POST /api/fs/remove` | `{path}` | `{ok}` — permanent (the app uses it only to purge its own trash) |
| `POST /api/fs/reveal` | `{path}` | opens Explorer with the item selected (`explorer /select,`) |

## Media
| Method & path | Body / query | Returns |
|---|---|---|
| `GET /api/thumb` | `?path=&size=360` | `image/webp`; images via Pillow (+HEIC via pillow-heif), videos via ffmpeg frame at 10% (max 3s). Cached in `<root>/.fluid-organizer/thumbs/<sha1(path|size|mtime|size)>.webp` |
| `GET /api/media/probe` | `?path=` | `{width, height, duration, fps, vcodec, acodec, rotation, taken, camera}` (taken = EXIF DateTimeOriginal in ms) |
| `GET /api/media/stream` | `?path=` | for formats the browser can't play (avi/wmv/ts/hevc mkv...): ffmpeg remux/transcode to fragmented MP4 (H.264/AAC) streamed |

## Video tools (async → job)
Outputs are written next to the source with a unique name; the job result returns the workspace-relative path.
| Method & path | Body | Notes |
|---|---|---|
| `POST /api/video/trim` | `{path, start, end, mode: 'fast'|'accurate'}` | fast = stream copy (keyframe-aligned), accurate = re-encode (libx264 crf 18, aac). Output `<stem>_cut01.<ext>` |
| `POST /api/video/concat` | `{segments: [{path, start, end}], output?}` | segments may come from different files; re-encode to H.264/AAC mp4 (consistent params). Output `<stem>_merged01.mp4` |
| `POST /api/video/transform` | `{path, op: 'rotate90'|'rotate180'|'rotate270'|'hflip'|'vflip', mode: 'metadata'|'reencode'}` | metadata = lossless display-matrix rotation (rotate ops only); flips need reencode. Output `<stem>_rot.<ext>` unless `inPlace: true` |
| `POST /api/video/frame` | `{path, time, format: 'jpg'|'png'}` | synchronous: `{path}` of `<stem>_frame_<mm>m<ss>s.jpg` |

## Duplicates (async → job)
`POST /api/dupes/scan` `{dirs?: [..] (default whole workspace), mode: 'exact'|'similar'|'both', threshold: 0-64 (default 10), videos: true}`
→ job; result `{groups: [{kind: 'exact'|'similar', items: [{path, size, mtime, width, height, duration, distance}]}], stats}`.
- exact: group by size, then BLAKE2b of the full file (stream), cached by `path|size|mtime`.
- similar: 64-bit pHash (32×32 DCT, numpy) for images; videos use pHash of frames at 10/30/50/70/90% (5 hashes, distance = mean).
  Index with `faiss.IndexBinaryFlat(64)` (or `IndexBinaryHNSW` above 50k items) and `range_search` within threshold;
  union-find into groups. Hash cache in `<root>/.fluid-organizer/hashes.sqlite`.

## Jobs
| Method & path | Returns |
|---|---|
| `GET /api/jobs` | `[job]` |
| `GET /api/jobs/<id>` | `{id, kind, state: 'running'|'done'|'error'|'cancelled', progress: 0..1, message, result, error}` |
| `POST /api/jobs/<id>/cancel` | `{ok}` |

## Client side (server team)
- `js/core/fs-server.js` → `App.ServerBackend` implementing the backend interface in ARCHITECTURE.md §4
  (`url(p)` → `/api/fs/file?path=...` with a no-op `release`; `thumbUrl(entry, size)` → `/api/thumb?...`; `reveal(p)`).
- `js/features/server.js` → `App.server`:
  `available` (bool), `capabilities`, `connect()`, `request(method, path, body)`, `job(id)`/`waitJob(id, onProgress)` (polls,
  mirrors progress into `App.jobs`), wrappers: `video.trim/concat/transform/frame`, `dupes.scan`, `media.probe`, `reveal(p)`.
  When the page is served by the server, opening a workspace uses `/api/workspace/pick` + `App.workspace.openBackend(new App.ServerBackend(...))`.
  When opened from file://, ping `http://127.0.0.1:8765/api/health`; if it answers, show a status-bar hint "서버로 열기" linking there.
  Status-bar item shows connection state; commands `server.connect`, `server.reveal` (Explorer).
