# Local server API (apiVersion 2)

Optional Python companion (`server/`). Runs only on the user's PC, bound to `127.0.0.1`. It serves the app
itself at `http://127.0.0.1:8765/` and unlocks what a browser can't do well: HEIC/TIFF/RAW-ish thumbnails, any
video codec, lossless trims/merges/rotations (ffmpeg), FAISS near-duplicate search, native folder picker,
instant moves that keep timestamps, "show in Explorer".

Start: `server\start.bat` (creates `server\.venv`, installs `requirements.txt`, runs `python -m server`, opens the browser).
After the first successful start it creates a desktop shortcut **사진영상정리기** (and a Start-menu entry); from then on
that icon is all the owner needs — see [Launcher](#launcher-one-click-start).
Deps: `fastapi`, `uvicorn`, `numpy`, `pillow`, `pillow-heif` (optional), `faiss-cpu`, `imageio-ffmpeg` (bundled ffmpeg binary).

**apiVersion** — an integer the server reports in `/api/health` and `/api/session`. It goes up whenever the client needs a
new endpoint. The web app knows the version it expects (`App.server.API_VERSION`); a lower server version means an old
server process is still running after an update → the app shows "서버를 새 버전으로 다시 켜 주세요 · 다시 켜기".
| apiVersion | Adds |
|---|---|
| 1 (round 1) | everything up to "Duplicates v1" |
| 2 (round 2) | dupes v2 (fingerprints, scan v2, frames, external roots, quarantine/restore), job pause/resume, `/api/server/restart`, `/api/server/shortcut`, launcher, file:// → server handoff |

## Security (must)
- Bind to 127.0.0.1 only. Reject requests whose `Host` isn't `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding).
- Session: `GET /api/session` sets cookie `fi_session=<random>` (`HttpOnly; SameSite=Strict; Path=/`) **only** when
  `Sec-Fetch-Site` is `same-origin` or `none`. Every other `/api/*` call requires that cookie; mutating calls
  (POST/PUT/DELETE) additionally require header `X-FI-Client: 1` (forces a CORS preflight that we never approve).
- `GET /api/health` is the only endpoint that works without a session; it answers `{"app":"fluid-identity","version":...,"apiVersion":2,"port"}`
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
| `GET /api/workspace/recent` | | `[{root, name, openedAt, exists, id}]` (id = the folder's `.fluid-organizer/workspace.json` id) (stored in `%APPDATA%/FluidIdentity/recent.json`) |

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

## Duplicates v1 (async → job, kept for compatibility)
`POST /api/dupes/scan` `{dirs?: [..] (default whole workspace), mode: 'exact'|'similar'|'both', threshold: 0-64 (default 10), videos: true}`
→ job; result `{groups: [{kind: 'exact'|'similar', items: [{path, size, mtime, width, height, duration, distance}]}], stats}`.
- exact: group by size, then BLAKE2b of the full file (stream), cached by `path|size|mtime`.
- similar: 64-bit pHash (32×32 DCT, numpy) for images; videos use pHash of frames at 10/30/50/70/90% (5 hashes, distance = mean).
  Index with `faiss.IndexBinaryFlat(64)` (or `IndexBinaryHNSW` above 50k items) and `range_search` within threshold;
  union-find into groups. Hash cache in `<root>/.fluid-organizer/hashes.sqlite`.

## Duplicates v2 (apiVersion 2 — ARCHITECTURE §8; the dupes team codes against this section)

The owner's own proven algorithm (`F:\_중복검사\find_dupes.py`) running on the server, plus pre-made fingerprints, folders
outside the workspace, A-vs-B comparison, exclusions and a reversible quarantine.

### File references
Every file in requests and results is named the same way:
- **workspace file** → `path` is workspace-relative (`영상/a.mp4`), `root` is absent.
- **external file** (under a folder outside the open workspace, e.g. `D:\VideoDownloader`) → `path` is the absolute OS path
  (`D:\VideoDownloader\a.mp4`) and `root` is the external root it was found under (as the server normalized it).
  A string is absolute when it starts with a drive (`C:\` / `C:/`), `\\` (UNC) or `/` (POSIX).
- A file that is inside the workspace is always reported as a workspace file, even when it was reached through an
  external root that contains the workspace. The same physical file is never listed twice.
- External roots are **read-only for scanning**: nothing is written there (fingerprints of external files live in
  `%APPDATA%\FluidIdentity\fingerprints.sqlite`). The only write is an explicit quarantine.
- External roots must be **allowed**: a folder the user picked with `POST /api/dupes/roots/pick` (native picker), a recent
  workspace root, or a folder below one of those. Anything else → `EPERM`. The usual path rules apply (no `..`, no ADS `:`,
  no device names, symlinks/junctions are never followed, realpath must stay inside the allowed root).
- Skipped while walking: dot-files/folders, `$RECYCLE.BIN`, `System Volume Information`, `desktop.ini`, `Thumbs.db`, the app's
  `.fluid-organizer`, and quarantine folders `_중복정리`.

### Rules (all optional; defaults = the owner's rule)
`rules` is stored by the dupes team in `.fluid-organizer/dupes.json` and sent with every scan. Unknown keys are ignored,
bad values → `EINVAL`.
```jsonc
{
  "durationTolSec": 2,      // same video only if |Δduration| ≤ max(durationTolSec, durationTolPct% of the longer one)
  "durationTolPct": 1,      // percent
  "frameBits": 10,          // two frames match when the 64-bit dHash Hamming distance ≤ frameBits
  "minFrames": 3,           // same video when ≥ minFrames of the compared frames match (and ≥ minFrames could be compared)
  "flatStd": 4,             // frames whose 9×8 gray stddev < flatStd are "flat" (black/one colour) and not compared
  "minDuration": 1,         // videos ≤ minDuration seconds get no frame fingerprint (exact match only)
  "sureDurationSec": 0.3,   // a video group is "sure" when max(duration) − min(duration) ≤ sureDurationSec
  "imageBits": 10,          // photos: pHash Hamming ≤ imageBits → same photo ("image" group, never "sure" unless exact)
  "keep": ["resolution", "duration", "size"]   // keep suggestion order; resolution = frame height (owner's rule),
                                               // duration = rounded seconds, size = bytes; ties → shorter path
}
```
Frame fingerprints store the raw stddev of every frame, so changing `flatStd`, `frameBits`, `minFrames` or the duration
tolerances never needs new fingerprints.

### `POST /api/dupes/fingerprint` → job (`kind: "dupes.fingerprint"`)
Pre-makes fingerprints so the next scan is fast. Incremental: only new or changed files (key = path + size + mtime ms)
are read. Cancel any time — finished files are already saved, so the next run continues where it stopped.
```jsonc
{ "dirs": [""],                     // workspace-relative folders (default: whole workspace when roots is empty too)
  "roots": ["D:\\VideoDownloader"], // external roots (absolute, allowed)
  "kinds": ["exact", "video", "image"],  // default all three
  "workers": 6 }                    // optional 1..16 parallel ffmpeg readers (default min(8, CPU count))
```
What each kind computes per file: **exact** → quick hash (BLAKE2b-128 of the first 1 MB + the last 1 MB when the file is
over 2 MB + the size as text) for every media file (full hashes are made on demand by scans); **video** → duration,
width, height (`ffmpeg -i`) and 5 frames at 15/35/50/65/85 % of the duration, each `scale=9:8:flags=area,format=gray`
→ 64-bit dHash (row-major, bit = left pixel > right pixel) + stddev; **image** → width, height, 64-bit pHash.
Job result:
```jsonc
{ "files": 2412, "images": 10, "videos": 2402, "bytes": 690123456789,
  "computed": 37, "cached": 2375, "failed": 2,
  "errors": [{ "path": "D:\\VideoDownloader\\broken.mp4", "root": "D:\\VideoDownloader", "message": "영상 정보를 읽을 수 없어요…" }],  // ≤ 50
  "elapsed": 12.3 }
```
Progress messages: `파일 찾는 중`, `지문 만드는 중 (120/2400)`. Pausable (see Jobs).

### `POST /api/dupes/scan` with `"v": 2` → job (`kind: "dupes.scan2"`)
The body is v2 when it has `"v": 2` (the client always sends it) or any of `roots`, `compare`, `kinds`, `rules`, `exclude`;
otherwise it is the v1 scan above. (`POST /api/dupes/scan2` is the same endpoint without the switch.)
```jsonc
{ "v": 2,
  "dirs": ["영상"], "roots": ["D:\\VideoDownloader"],        // what to scan (default: whole workspace)
  "compare": { "a": ["C:\\Users\\me\\Downloads"], "b": ["D:\\VideoDownloader"] },
        // optional: scan a ∪ b (dirs/roots are then ignored; overlapping sides → EINVAL) and keep only groups with members on both sides;
        // entries are workspace folders or absolute external roots; every member gets "side": "a" | "b"
  "kinds": ["exact", "video", "image"],                       // default all three
  "rules": { ... },                                           // see Rules
  "exclude": { "files": ["영상/keep.mp4", "D:\\VideoDownloader\\x.mp4"],   // never scanned
               "folders": ["영상/원본", "D:\\VideoDownloader\\보관"],       // nothing below is scanned
               "pairs": [["영상/a.mp4", "D:\\VideoDownloader\\a (1).mp4"]] } // "not duplicates": these two never end up in one group (also not through a third file)
}
```
Steps (owner's algorithm): same size → quick hash → full hash (BLAKE2b-128, computed on demand and cached) ⇒ exact links;
videos sorted by duration, only pairs within the duration tolerance are compared (frames are made on demand for those);
photos by pHash (FAISS range search). Links are joined with union-find into groups.
Result:
```jsonc
{ "groups": [{
    "id": "3f9c0a1b2c3d4e5f",          // stable: hash of the sorted member refs (same members → same id between scans)
    "kind": "exact" | "video" | "image", // exact = every member has the same full hash
    "sure": true,                        // exact, or a video group with max−min duration ≤ sureDurationSec, and every member
                                         // matches the keeper directly ("확실"); else "애매"
    "keep": "D:\\VideoDownloader\\a.mp4", // ref path of the suggested keeper (rules.keep order)
    "bytes": 123456789, "reclaim": 61728394,   // total size / size freed when only `keep` stays
    "members": [{ "path": "...", "root": "D:\\VideoDownloader" /* external only */, "side": "a" /* compare only */,
                  "kind": "video" | "image", "size": 61728394, "mtime": 1729000000000,
                  "duration": 61.03, "w": 1920, "h": 1080, "keep": true, "direct": true }],   // keeper first, then by keep order;
                  // direct = matches the keeper itself (false = only through another member → the group is never "sure")
    "evidence": [{ "a": "<path>", "b": "<path>", "kind": "exact" | "video" | "image",
                   "score": 0.8,          // exact 1; video = matched frames / compared frames; image = 1 − bits/64
                   "dDur": 0.04,          // |Δduration| seconds (null for photos)
                   "bits": 3,             // photos only: pHash distance
                   "frames": [{ "t": 9.15, "tb": 9.16, "bits": 2 }, { "t": 21.36, "tb": 21.37, "bits": null }] }]
                   // video only, all 5 positions: t = seconds in a, tb = seconds in b, bits = Hamming (null = flat, not compared)
  }],
  "stats": { "engine": "server-v2", "files": 2412, "images": 10, "videos": 2402, "bytes": 690123456789,
             "groups": 41, "exactGroups": 12, "videoGroups": 28, "imageGroups": 1, "sureGroups": 30,
             "reclaimable": 98765432100, "computed": 3, "cached": 2409, "excluded": 4, "skipped": 1,
             "errors": [{ "path": "...", "root": "...", "message": "..." }], "elapsed": 4.2 } }
```
Groups are sorted by `reclaim` (largest first). `evidence` lists the links that formed the group (≤ 60 per group).

### `GET /api/dupes/frame?path=&t=&w=&v=` → `image/jpeg`
A small frame for review strips. `path` is a ref path (workspace-relative or absolute external); `t` seconds (videos,
clamped into the file; ignored for photos); `w` width 32–640 (default 160); `v` any cache-buster (`size-mtime`).
`Cache-Control: private, max-age=86400`. A frame that can't be decoded answers `204` with `X-FI-Error` (quiet in the console).

### External roots
| Method & path | Body | Returns |
|---|---|---|
| `GET /api/dupes/roots` | | `{roots: [{root, name, exists, source: 'picked'|'workspace', pickedAt}]}` |
| `POST /api/dupes/roots/pick` | `{initialDir?}` | native folder dialog → `{root, name}` (remembered as allowed) or `{cancelled: true}` |
| `POST /api/dupes/roots/forget` | `{root}` | `{ok}` (only picked roots; workspace roots stay allowed while they are recent) |
| `GET /api/dupes/stat?path=<abs>` | | `{kind: 'file'|'dir', size, mtime}` (ms) of a file under an allowed root; `404 ENOENT` when gone, `403 EPERM` outside the roots. The review re-verifies the keeper with it right before removing (added at round-2 integration). |
| `GET /api/dupes/media?path=<abs>` | | the file itself with Range/ETag (like `/api/fs/file`) so the review can play files on other drives; same errors as `stat` |

Picked roots are stored in `%APPDATA%\FluidIdentity\roots.json` (12 most recent). Client: `App.server.dupes.stat(path)`, `.mediaUrl(path)`.

### Quarantine (external files only — workspace files go to the app trash with `App.fs.trash`)
| Method & path | Body | Returns |
|---|---|---|
| `POST /api/dupes/quarantine` | `{paths: [abs], keep?: refPath, reason?: str}` | `{moved: [{id, path, to, size}], failed: [{path, code, message}]}` |
| `POST /api/dupes/restore` | `{ids: [id]}` | `{restored: [{id, path}], failed: [{id, code, message}]}` |
| `GET /api/dupes/quarantine` | | `{items: [{id, path, to, root, size, at, reason, keep}]}` — still in quarantine |

- Each file moves to `<root>\_중복정리\NNN_<name>` (the owner's convention; `root` = the most specific allowed root that
  contains it, NNN = next free 3-digit number) with `os.rename` inside the same root — instant, nothing is copied.
  If a copy is ever unavoidable (the folder is a different volume), the server copies, verifies the full hash and only
  then deletes the source; a failed verify keeps the source untouched.
- `keep` (optional, the owner's safety rule): the kept copy must still exist, otherwise nothing is moved (`ENOENT`).
- The log is `<root>\_중복정리\정리기록.json` (`{version: 1, items: [...]}`, written atomically). Each item is first written as
  `state: "moving"`, then `"moved"`; a crash in between is repaired on the next read (whichever file exists wins).
- Restore never overwrites: if the original path is taken it restores as `name (복원).ext`, then `name (복원 2).ext` …
- Read-only files keep their attributes; restore works for them too. Batch calls never abort on one bad item.

## Jobs
| Method & path | Returns |
|---|---|
| `GET /api/jobs` | `[job]` |
| `GET /api/jobs/<id>` | `{id, kind, state: 'running'|'done'|'error'|'cancelled', paused, progress: 0..1, message, result, error}` |
| `POST /api/jobs/<id>/cancel` | `{ok}` |
| `POST /api/jobs/<id>/pause` | `{ok, paused: true}` — the job stops at its next check point (`state` stays `running`, `paused: true`, message `일시정지했어요`) |
| `POST /api/jobs/<id>/resume` | `{ok, paused: false}` |

## Server control & launcher
| Method & path | Returns |
|---|---|
| `GET /api/health` | `{app: "fluid-identity", version, apiVersion: 2, port}` (no session needed, CORS `*`) |
| `POST /api/server/shutdown` | `{ok}` — stops after answering |
| `POST /api/server/restart` | `{ok}` — starts a fresh server process (new code from disk, same port, reopens the current workspace) and exits; the app reconnects by itself |
| `POST /api/server/shortcut` | `{created: [path]}` — (re)creates the desktop + Start-menu shortcut **사진영상정리기** |

### Launcher (one-click start)
- `server\start.bat` sets everything up (venv, packages) and runs `python -m server --open --install-shortcut`.
  After the server is up the first time, it creates `바탕화면\사진영상정리기.lnk` and a Start-menu entry (once; the stamp
  is `server\.venv\shortcut.stamp`, the app can recreate them with `server.shortcut`). The icon is generated into
  `%APPDATA%\FluidIdentity\app.ico`.
- The shortcut runs `server\.venv\Scripts\pythonw.exe -m server --open --resume` in the app folder: no console window,
  logs go to `%APPDATA%\FluidIdentity\server.log`, problems are shown in a Windows message box.
- Single instance + version handshake: before starting, the launcher calls `GET /api/health` on the fixed port 8765.
  Same app and same apiVersion → it only opens the browser. An older apiVersion → it asks that server to shut down,
  waits for the port and starts the new one. Something else on the port → message box (no silent port hopping for the
  launcher, so the browser origin — and its saved settings — stays `http://127.0.0.1:8765`).
- `--resume` reopens the most recent workspace, so the app comes back exactly where the owner left it.

### file:// → server handoff (keeps the folder and the settings)
The app opened from disk keeps its settings in the `file://` origin; the server origin has its own storage. The one-click
switch carries them over once, in the URL fragment (never sent to the server, never logged):
`http://127.0.0.1:8765/#fi-handoff=<base64url(JSON)>` with
`{v: 1, at: <ms>, settings: {<App.settings without the server.* keys>}, workspace: {id, name} | null, cwd}`.
The served app reads it once at start, removes it from the address bar (`history.replaceState`), imports the settings
(the handoff wins over the server origin's values) and opens the recent server workspace whose `.fluid-organizer/workspace.json`
id matches (`GET /api/workspace/recent` now returns `id` too; fallback: the only recent root with the same folder name),
then goes to `cwd`. No match → the folder chooser opens with "이 폴더를 한 번만 골라 주세요" and the folder name.
Handoffs older than 10 minutes are ignored.

## Client side (server team)
- `js/core/fs-server.js` → `App.ServerBackend` implementing the backend interface in ARCHITECTURE.md §4
  (`url(p)` → `/api/fs/file?path=...` with a no-op `release`; `thumbUrl(entry, size)` → `/api/thumb?...`; `reveal(p)`).
- `js/features/server.js` → `App.server`:
  `available` (bool), `capabilities`, `connect()`, `request(method, path, body)`, `job(id)`/`waitJob(id, onProgress)` (polls,
  mirrors progress into `App.jobs`), wrappers: `video.trim/concat/transform/frame`, `dupes.scan`, `media.probe`, `reveal(p)`.
- Dupes v2 client (`App.server.dupes`, feature-detect `App.server?.dupes?.scanV2`; `App.server.supports('dupes-v2')` is true
  only when a v2 server is connected):
  - `fingerprint({dirs, roots, kinds, workers}, {title, onProgress, background, pausable = true})` → job result
  - `scanV2({dirs, roots, compare, kinds, rules, exclude}, {title, onProgress, pausable})` → `{groups, stats}`
  - `start(endpoint, body)` → the raw job (for callers that poll themselves with `waitJob`)
  - `frameUrl(path, t, {w, v})` → URL string for `<img src>` (same-origin, session cookie)
  - `quarantine(paths, {keep, reason})` → `{moved, failed}`; `restore(ids)` → `{restored, failed}`; `quarantined()` → items
  - `roots()` → allowed roots, `pickRoot({initialDir})` → `{root, name}|null`, `forgetRoot(root)`
  - `isExternal(path)` → true for absolute refs
  - `waitJob(job, {pausable: true})` mirrors pause/resume of the status-bar job to `/api/jobs/<id>/pause|resume`.
  When the page is served by the server, opening a workspace uses `/api/workspace/pick` + `App.workspace.openBackend(new App.ServerBackend(...))`.
  When opened from file://, ping `http://127.0.0.1:8765/api/health`; if it answers, show a status-bar hint "서버로 열기" linking there.
  Status-bar item shows connection state; commands `server.connect`, `server.reveal` (Explorer).
