# Fluid Identity v2 — Architecture & Team Contract

Local photo/video organizer. Runs in Chrome/Edge directly from `사진영상정리기.html` (file://), from the
local Python server (http://127.0.0.1:8765, unlocks heavy features), and in tests (http://127.0.0.1:<port>).
v1 (single 5k-line file) is kept at `legacy/사진영상정리기-v1.html` for reference only.

## 1. Rules everyone follows

- **Korean UI copy**, friendly polite tone ("~해요/~할까요?"). Code, comments, identifiers in English.
- **Never** use `alert/confirm/prompt`. Use `App.ui.alert/confirm/prompt/dialog/toast/menu`.
- **Never** touch the file system directly — always `App.fs.*` (keeps catalog, undo, tree, gallery in sync).
- **Colors/sizes only from `css/tokens.css`** variables. Both dark and light themes must look right.
- Classic scripts only (no ES modules, no `import`), each file is an IIFE that attaches to `window.App`.
  Reason: file:// can't load modules or `fetch()` local files. Web Workers must be created from Blob URLs
  built from a function's source (`new Worker(URL.createObjectURL(new Blob([`(${fn})()`])))`).
- CSS classes are prefixed per module (`card-`, `tree-`, `insp-`, `vw-`, `chip-`, `dup-`, `org-`, `pal-`...).
- Every user-visible action should be a **command** (`App.commands.register`) so it gets a shortcut,
  shows up in the command palette and in menus with its key hint.
- Destructive actions go to the **app trash** (`App.fs.trash`) and are **undoable** (`App.undo`).
- Performance: never `getFile()` every file of a big folder on the UI path; the gallery is virtualized — keep it so.
- Accessibility: buttons have `aria-label` or text; tooltips via `data-tip="..." data-tip-keys="Mod+K"`.

## 2. Files & ownership (parallel rounds)

Each team edits **only its own files** plus its own `<!-- team:x -->` region in `사진영상정리기.html`.
Need a change in someone else's file or in `js/core/*`? Don't edit it — put it in your report under
`integrationRequests` (file, exact change, reason). The orchestrator applies those between rounds.
Prefer extension points (events, `addSection`, `cardDecorators`, `contextMenuItems`, `toolbarItems`, commands).

**Round 2 teams** (2026-10-19; `<team>-*` / `<team>.*` files under `js/features/` and `css/` always belong to that team):

| Team | Owns |
|---|---|
| gallery | `js/features/gallery*.js`, `css/gallery*.css`, `tests/gallery*.test.js` |
| viewer | `js/features/viewer*.js`, `js/features/video-*.js`, `css/viewer*.css`, `css/video-*.css`, `tests/viewer*.test.js`, `tests/video*.test.js`, new `vendor/mediabunny*` |
| clips | `js/features/clips*.js`, `css/clips*.css`, `tests/clips*.test.js` |
| dupes | `js/features/duplicates.js`, `js/features/dupes-*.js`, `css/duplicates.css`, `css/dupes-*.css`, `tests/duplicates*.test.js`, `tests/dupes*.test.js` |
| server | `server/**`, `js/core/fs-server.js`, `js/features/server*.js`, `css/server*.css`, `tests/server*.test.js`, `docs/server-api.md` |
| core | `js/core/nav.js`, `js/core/index.js`, `js/core/fs.js`, new `js/core/core-*.js`, `tests/core*.test.js` |
| orchestrator | everything else (other `js/core/*`, nav/thumbs/chips/organize/shell features, `css/tokens.css`, `css/base.css`, `tests/lib/*`, `tests/run.js`, `tests/smoke.test.js`, docs) |

Round 1 teams (for reference — their files now belong to the orchestrator unless listed above):

| Team | Owns |
|---|---|
| nav | `js/features/topbar.js`, `js/features/sidebar.js`, `css/topbar.css`, `css/sidebar.css`, `tests/nav.test.js` |
| gallery | `js/features/gallery.js`, `css/gallery.css`, `tests/gallery.test.js` |
| thumbs | `js/features/thumbs.js`, `js/features/statusbar.js`, `css/jobs.css`, `tests/thumbs.test.js` |
| chips | `js/features/inspector.js`, `js/features/chipset.js`, `css/inspector.css`, `css/chipset.css`, `tests/chipset.test.js` |
| viewer | `js/features/viewer.js`, `js/features/video-editor.js`, `css/viewer.css`, `css/video-editor.css`, `tests/viewer.test.js` |
| server | `server/**`, `js/core/fs-server.js`, `js/features/server.js`, `css/server.css`, `tests/server.test.js` |
| organize | `js/features/organize.js`, `js/features/duplicates.js`, `css/organize.css`, `css/duplicates.css`, `tests/organize.test.js`, `tests/duplicates.test.js` |
| shell | `js/features/workspace.js`, `js/features/layout.js`, `js/features/palette.js`, `css/welcome.css`, `css/palette.css`, `tests/shell.test.js` |
| orchestrator | `js/core/*`, `css/tokens.css`, `css/base.css`, `tests/lib/*`, `tests/run.js`, `tests/smoke.test.js`, docs |

## 3. Load order & module pattern

`사진영상정리기.html` loads vendor libs (`vendor/exifr`, `vendor/mpegts`) → `js/core/*` → feature scripts → `App.start()`.
Scripts register commands at load time; DOM work happens in `init()`:

```js
(() => {
    'use strict';
    const { h } = App.util;
    App.commands.register({ id: 'x.do', title: '...', keys: 'Mod+K', run: () => {} });
    App.register('x', { init() { /* build DOM, subscribe to events */ } });
    App.x = { /* public API */ };
})();
```

`App.start()` runs every `init()` in script order, then emits `app:ready`.

## 4. Core APIs (js/core)

### App.util
`path.{join,parent,base,ext,stem,isInside,rebase,segments}`, `mediaType(name)` → `'image'|'video'|'other'`,
`browserCanDecode(name)`, `compareNames` (Korean natural sort), `debounce`, `throttle`, `sleep`, `nextFrame`, `clamp`,
`uid`, `escapeHtml`, `formatBytes`, `formatDuration(sec)`, `formatDate(ms, withTime)`, `formatCount`,
`matchKo(query, text)` → `{score, ranges}|null` (shared Hangul-aware matcher: initials, partial syllables — use it, don't write another),
`pool(items, limit, fn)`, `fingerprint(entry)`, `h(tag, attrs, ...children)` (DOM builder), `isTypingTarget(el)`.

### App.bus — events
`on(evt, fn)` returns an unsubscribe fn; `once`, `off`, `emit`. Events in use:

| Event | Payload | Emitted by |
|---|---|---|
| `app:ready` | — | core |
| `workspace:opened` / `workspace:closed` | `{name, id}` | workspace |
| `folder:loading` / `folder:loaded` | `{path, entries}` | nav |
| `nav:changed` | — | nav (after cwd/history changed) |
| `view:changed` | `{reason: 'entries'|'sort'|'filter'|'patch'|'refresh'}` | view |
| `view:filters` | — | view |
| `selection:changed` | `{paths, focus}` | select |
| `fs:changed` | `{type, paths, from?, to?, dirs}` | fs (type: create, rename, move, copy, trash, restore, delete, modify) |
| `trash:changed` | — | fs |
| `catalog:loaded` / `catalog:changed` | `{paths}` | catalog |
| `index:progress` / `index:ready` / `index:changed` | | index |
| `jobs:changed` | — | jobs |
| `item:open` | `{path}` | nav.open → viewer |
| `viewer:shown` / `viewer:closed` | `{entry, media}` / `{path}` | viewer |
| `thumbs:meta` | `{path, duration}` | thumbs |
| `settings:changed` | `{key, value}` | settings |
| `layout:changed`, `gallery:zoom`, `commands:changed`, `undo:changed` | | |

### App.state / App.setState / App.layers
`App.state.workspace` (`{name, id, kind}` or null), `App.state.cwd` (folder path, `''` = root), `App.state.layer`.
`App.layers.push('viewer'|'dialog'|'menu')` / `pop(name)` decides which commands receive keys.

### App.settings
Per-browser preferences in localStorage: `get(key, fallback)`, `set(key, value)` (emits `settings:changed`).
Workspace-level data (shared with every browser/PC that opens the folder) goes to `App.wsdata` instead.

### App.commands
`register({ id, title, group, icon, keys: 'Mod+Shift+N' | [...], scope: 'main'|'viewer'|'global', allowInInput, when, run })`,
`run(id, args)`, `list()`, `get(id)`, `isEnabled(id)`, `displayKeys(id)`, `displayCombo(combo)`.
Key combos: `Mod` = Ctrl (⌘ on Mac), modifiers in order `Mod+Alt+Shift+Key`; named keys use `KeyboardEvent.key`
(`ArrowLeft`, `Delete`, `F2`, `Space`, `Escape`). Printable symbols are matched without Shift (`?` not `Shift+/`).
Commands don't fire while typing in inputs unless `allowInInput` (true or list of combos).
Korean IME: when `e.key` is a jamo/'Process', the physical key (`e.code` KeyA–Z / Digit0–9) is used, so `J`, `Alt+R`... work in 한글 mode.
A literal plus key is written `'+'` / `'Mod++'`.

**Reserved command ids** (implement in the owning team, reference from anywhere):
`folder.new`, `file.open`, `file.rename`, `file.trash`, `select.all`, `select.clear`, `nav.*`, `edit.undo`, `edit.redo`,
`search.focus`, `view.toggleSidebar`, `view.toggleInspector`, `view.toggleTheme`, `workspace.open`, `workspace.close`,
`organize.moveTo`, `organize.copyTo`, `organize.rename` (batch), `organize.unwrap` (폴더 풀기), `organize.byDate`,
`trash.open`, `dupes.open`, `palette.open` (Mod+K), `help.shortcuts` (?), `settings.open` (Mod+,),
`chips.toggleHotkey1..9`, `viewer.*`, `video.*`, `server.connect`, `thumbs.pregenerate`.

### App.undo — owner requirement: Ctrl+Z instantly undoes ANY change from ANY screen
`push({ label, undo: async fn, redo: async fn, coalesceKey? })`, `undo()`, `redo()`, `canUndo()`, `canRedo()`,
`list({redo})` → `[{label, time}]` newest first, `undoTo(n)`, `peek()`, `clear()`.
`edit.undo` (Mod+Z) / `edit.redo` (Mod+Shift+Z, Mod+Y) are **core, scope global** commands: they fire in the gallery,
viewer, quick look and panels (text fields keep native undo). Steps run serially.
- `App.fs` writes (`mkdir, rename, move, copy, trash, restore, createFile, overwrite`) push entries by default.
- `App.catalog.update/updateMany` push entries by default (`{label, coalesceKey, undoable}`); same `coalesceKey`
  within 4 s merges (use `'memo:' + path` for typing).
- **One user action = one undo entry.** For batches call fs/catalog with `{ undoable: false }` and push one entry yourself.
- Anything else users change (chipset structure, favorites, markers...) must push its own entry.

### App.idb
Tiny IndexedDB KV: `get/set/del/keys/clear` (store `fluid-identity/kv`), `App.idb.store(dbName, storeName)` for own stores.

### App.ui
`icon(name, {size, class})` → SVG string (names: see `ICONS` in ui.js — add new ones there via integration request),
`iconEl`, `toast(msg, {type: info|success|error|warning|loading, duration, action: {label, run}, id})` → `{update, close}`,
`dialog({title, body, actions: [{label, value, kind, autofocus, onClick(close)}], width, init(box, close)})` → Promise,
`confirm({title, message, okLabel, danger})`, `alert`, `prompt({title, value, validate, selectStem})` — nested dialogs stack (Esc/Enter go to the top one; menus opened inside a dialog render above it),
`menu(items, {x, y} | {anchor, align})`, item = `{label, icon, command | action, hint, checked, danger, disabled, submenu}` | `'-'` | `{header}`,
`contextMenu(el, builder)`, `popover(anchor, contentEl, {align, above})` → `{close}`, `positionFloating`.
CSS building blocks in `css/base.css`: `.btn` (+ `primary ghost danger icon sm lg active`), `.seg`, `.input`, `.textarea`,
`.select`, `.search-box`, `.kbd`, `.badge`, `.spinner`, `.progress>i`, `.panel-section(-head/-body)`, `.empty`, `.menu`, `.dialog`.

### App.fs — file system facade
Entry shape (everything that lists files uses it):
`{ path: 'trip/2024/a.jpg', name: 'a.jpg', kind: 'file'|'dir', type: 'image'|'video'|'dir'|'other', ext: 'jpg', size, mtime }`.

Reads: `list(dir, {stat, all})` (hides dot-files, app data and non-media; `entries.hiddenCount`, `entries.sidecars`),
`stat(p)`, `exists(p)`, `getFile(p)` → File, `url(p)` → `{url, release()}`, `readText`, `readJSON(p, fallback)`.
Writes (emit `fs:changed`, keep catalog in sync, undoable by default — pass `{undoable:false}` inside batches):
`mkdir(parent, name)`, `createFile(dir, name, blob)` (unique name; undo trashes it), `overwrite(p, blob)` (previous
version kept in the app trash; undo restores it), `rename(p, newName)`,
`move(paths, destDir, {onConflict})` → `[{from,to}]` (+ `.failed`, `.cancelled`), `copy(paths, destDir, {onConflict})`,
`renameMany([{path, name}])` (batch rename: swaps/chains, ONE event + ONE undo), `trash(paths, {label})` → ids, `restore(ids)`,
`trashCopy(p, {name, data, reason})` (keep a copy/original in the app trash), `listTrash()`,
`purgeTrash(ids?)`, `removePermanently(paths)`.
Batch ops never abort on one bad item: failures are collected in `result.failed` and shown in one toast.
`onConflict(conflicts: [{src, name, dest, isDir}])` → `Map(src → 'keep'|'skip'|'replace')` or `null` to cancel
('replace' trashes the existing file; undo restores it). Without it, clashes get numbered names. Helpers: `uniqueName(dir, name, {isDir, reserved})`, `validateName(name)`,
`isHiddenName`, `isDataPath`, raw app-data writes `writeRaw/writeJSON` (no events).

**Backend interface** (`App.fs.use(backend)`; `BrowserBackend` = File System Access API, `ServerBackend` = local server):
`kind`, `name`, `list(dir, {stat}) → [{name, kind, size?, mtime?}]`, `stat(p) → {kind, size, mtime}`, `exists(p)`,
`getFile(p) → File`, `write(p, data)`, `mkdir(p)`, `remove(p)` (recursive), `move(src, destDir, newName)`,
`copy(src, destDir, newName)`, `url(p) → {url, release}`. Optional: `thumbUrl(entry, size)`, `reveal(p)`, `capabilities`.

### App.catalog (+ App.wsdata)
Per-file metadata in `.fluid-organizer/catalog.json`, keyed by path, kept in sync on rename/move/trash/restore.
Entry: `{ chips: [chipId], rating: 0-5, label: 'red'|...|null, memo: '', markers: [{id, t, title, memo, color}],
meta: { w, h, duration, taken, camera, rot, ... }, legacyTags: [], updatedAt }`.
`get(p)` (defaults filled), `peek(p)` (raw or undefined), `update(p, patch|fn)`, `updateMany(paths, patch|fn)`,
`setMeta(p, meta)` (cached media info, no event), `entries()`, `flush()`.
`App.wsdata.read(name, fallback)` / `write(name, obj)` / `backup(name, obj)` for `.fluid-organizer/<name>.json`
(e.g. `chipsets`, `favorites`, `settings`). Daily backups live in `.fluid-organizer/backups/`.

### App.jobs
`start({title, total, cancellable})` → job `{update(done, {total, detail}), step(n), finish(), fail(err), cancelled, onCancel(fn)}`,
`list()`, `summary()`. The status bar shows progress; `thumbs` team owns the activity-center UI.

### App.nav / App.view / App.select
- `App.nav.go(path, {focus})`, `goBack/goForward/goUp/goHome`, `jump(±n)`, `reload()`, `open(entry)` (folder → navigate, file → `item:open`),
  `loadHooks.push(async (path, entries, source) => ({entries, source}))` to replace a folder listing before it shows,
  `canBack/canForward/canUp`, `back/fwd` arrays.
- `App.view.entries` (source list), `visible` (filtered+sorted), `source` `{type: 'folder'|'search'|'smart', path, title, ...}`,
  `setEntries(entries, source)` (other modules can show any list, e.g. chip/smart results), `setFilter(id, {label, test, includeDirs})`,
  `clearFilters()`, `setSort(key, dir)`, `registerSortKey(key, label, getter)`, `indexOf(p)`, `get(p)`, `patch(p, fields)`.
- `App.select.paths` (Set), `focus`, `anchor`, `list()` (visible order), `entries()`, `primary()`, `count`,
  `set(paths, {focus, anchor})`, `toggle(p)`, `range(p, {additive})`, `all()`, `clear()`.

### App.index
Whole-workspace flat list for search/smart views: `items`, `folders`, `get(p)`, `under(dir, {recursive})`,
`search(text)` (names, folders, memo, v1 tags and chip names via `App.chipset.labelOf`), `sidecarFolders`, `ready`,
`whenReady()`, `scan()`. Kept up to date from `fs:changed`.

## 5. Feature extension points (js/features)

- `App.workspace.pick()`, `openHandle(handle)`, `openBackend(backend)`, `close()`, `getRecents()`.
- `App.gallery`: `cardDecorators.push((cardEl, entry) => {})`, `contextMenuItems.push((entries) => items)`,
  `refresh()`, `invalidate(paths)`, `scrollTo(path)`, `cardFor(path)`, `columns`, `zoom`, `setZoom(px)`.
  Drag data type for internal drags: `application/x-fi-paths` (JSON array of paths).
- `App.thumbs.get(entry, {size})` → url|null, `peek`, `canThumb`, `prioritize(paths)`, `clearCache()`.
- `App.inspector.addSection({id, title, order, render(body, ctx), when(ctx)})`, `refresh()`.
  ctx = `{entries, primary, folder, files, single}`. Each section renders into `<section class="insp-section insp-sec-<id>">`.
  Built-ins (chips team): preview 0, quick 5, chips 20, info 90, memo 100 (docked bottom).
- `App.sidebar.addSection({id, title, order, render(body)})`; `App.tree.reveal(path)`, `refresh(dir)`.
- `App.topbar.addViewbarItem(() => Element)`, `clearSearch()`, `setTypeFilter('all'|'image'|'video')`.
- `App.statusbar.addItem(id, el, {side})`.
- `App.viewer.open(path)`, `close()`, `step(±1)`, `current`, `media`, `toolbarItems.push((entry) => [Element])`.
- `App.layout.setPanel('sidebar'|'inspector', visible)`.

## 6. Workspace data folder (`<root>/.fluid-organizer/`)

```
workspace.json        { id, createdAt, app, version }
catalog.json          per-file metadata (App.catalog)
chipsets.json         chip presets/categories/chips (chips team)
favorites.json        pinned folders (nav team)
trash/manifest.json   trash items { id, name, kind, size, originalPath, trashPath, deletedAt, catalog }
trash/<batch>/...     trashed files
backups/<name>-YYYYMMDD.json   daily backups of catalog/chipsets (10 kept)
thumbs/               optional on-disk thumbnail cache (thumbs team / server)
```
Everything about the user's library lives here, next to the photos — reinstalling the browser or PC loses nothing.

## 7. Testing

```
npm install            # once per checkout/worktree (playwright only; uses the installed Chrome)
node tests/run.js      # all tests;  node tests/run.js chip  -> only tests whose name contains "chip"
```
`tests/lib/harness.js` → `openApp({ seed })` seeds an OPFS folder (images/videos generated in-page) and
replaces `showDirectoryPicker`, then opens it as the workspace. A test fails on any page error or native dialog.
Helpers: `cardNames(page)`, `card(page, name)`, `waitIdle(page)`, `window.__opfs.{exists,read,list}` for assertions.
Each team adds `tests/<team>.test.js`; **the whole suite must pass** before you finish.
Visual check: take a screenshot with Playwright (`page.screenshot`) and look at it before you call it done.

## 8. Round 2 contracts (2026-10-19)

Teams build these in parallel, so code against the contract and **feature-detect** the other side
(`App.clips?.add`, `App.viewer?.openAt`, `App.server?.dupes?.scanV2` …): your feature must work (degraded, never broken)
before the other team's code is merged, and fully after.

### Keys
- `Mod+B` (`view.toggleSidebar`) is scope `main` now — in the viewer, Ctrl+B is the video razor (viewer team).
- Viewer editing keys (viewer team): `Q` = cut away everything before the playhead, `W` = everything after it,
  `Mod+B` = split at the playhead. Run `node tools/check-keys.js` before you finish: no clashes.

### Video edit state (viewer team owns the format)
`App.catalog.get(path).meta.edit = { cuts: [t, …], removed: [[a, b], …], pieces?: {"<start>": {memo, chips}}, updatedAt }`
(seconds, 3 decimals). Others read it only. Changes go through `App.catalog.updateMany`, so Ctrl+Z works.

### App.viewer playback API (viewer team implements; clips / dupes call it)
- `App.viewer.openAt(path, { start, end, loop = false, autoplay = true })` opens the viewer on that video at `start`;
  with `end` it stops (or loops) there and shows a small dismissible "구간 재생 01:23–01:45" chip.
- `App.viewer.playSequence(items, { title })` with `items = [{ path, start, end, title? }]` plays them back to back
  in the viewer with a queue indicator (n / total, previous / next).

### App.clips — the clip library "보관함" (clips team implements; the viewer calls `add`)
Stored in `.fluid-organizer/clips.json` via `App.wsdata` (`{ version: 1, clips: [Clip] }`, daily backup like chipsets).
`Clip = { id, path, start, end, title, memo, chips: [chipId], order, createdAt, updatedAt, missing? }`.
- `ready`, `list({ path } = {})` (library order; for one path: by start), `get(id)`, `forPath(path)`, `search(query)`
  (title/memo/chips, Korean initial consonants via `App.util.matchKo`).
- `add(clip | clip[])` → created clips (ONE undo step), `update(id, patch, { coalesceKey })` (typing coalesces),
  `remove(ids)` (one undo step), `reorder(ids)`.
- Follows `fs:changed`: rename/move rewrite `path`; trashing the video sets `missing` (hidden), restoring clears it.
- Event `clips:changed` `{ ids, paths, reason: 'add'|'update'|'remove'|'reorder'|'relocate'|'load' }`.

### Duplicate review data (dupes team)
- `.fluid-organizer/dupes.json` = `{ version: 1, excludedFiles: [path], excludedFolders: [path], notDuplicates: [[a, b]], rules, lastScan }`
  (follows renames/moves). `.fluid-organizer/dupes-log.json` = append-only log of applied clean-ups (what was removed,
  which copy was kept, where it went).
- Fingerprints are cached per file (`path|size|mtime`) in IndexedDB (browser engine) or the server's SQLite (server engine).
  Store the engine with each fingerprint and only compare fingerprints from the same engine.

### Matching rule — the owner's own proven algorithm (F:\_중복검사\find_dupes.py; both engines implement exactly this)
- Exact: same size → quick hash (first + last 1 MB + size) → full hash.
- Same video: |Δduration| ≤ max(2 s, 1 %) of the longer; 5 frames at 15/35/50/65/85 % of the duration →
  9×8 grayscale → 64-bit dHash (left > right pixel); nearly flat frames (stddev < 4) are skipped; two frames match when
  Hamming ≤ 10 bits; same video when ≥ 3 frames match; score = matched / compared.
- "확실" (sure) = exact copy, or same video with Δduration ≤ 0.3 s. Everything else is "애매" → the owner reviews it.
- Keep suggestion: highest resolution → longest → largest. All thresholds are user-adjustable (stored in `rules`).

### Server dupes API v2 (server team implements and documents in docs/server-api.md first thing; dupes team consumes)
- `POST /api/dupes/fingerprint { roots?: [absPath], dirs?: [wsPath], kinds: ['exact','video','image'] }` → job
  (incremental: only new/changed files; progress; pause/cancel).
- `POST /api/dupes/scan { roots?, dirs?, compare?: { a: [..], b: [..] }, rules?, exclude?: { files, folders, pairs } }` → job → result
  `{ groups: [{ id, kind: 'exact'|'video'|'image', sure, keep, members: [{ path, root?, size, mtime, duration, w, h }],
  evidence: [{ a, b, score, dDur, frames: [{ t, bits }] }] }], stats }`. `compare` keeps only groups that span both sides.
- `GET /api/dupes/frame?path=&t=&w=` → small JPEG of that frame (review strips).
- External roots (folders outside the workspace, e.g. `D:\VideoDownloader`): scanning is read-only; removing a duplicate
  there = `POST /api/dupes/quarantine { paths }` → moved to `<root>\_중복정리\NNN_<name>` + logged (the owner's own
  convention); `POST /api/dupes/restore { ids }` undoes it.
- Client: `App.server.dupes.fingerprint(opts)`, `.scanV2(opts)`, `.frameUrl(path, t)`, `.quarantine(paths)`, `.restore(ids)`.

## 9. Round 2 additions (shipped 2026-10-19) — read this before round 3

**Core (js/core)**
- `App.listCache` (core-listcache.js): per-workspace IndexedDB folder listings, stale-while-revalidate.
  `get(dir)`, `list(dir, {mode: 'auto'|'names'|'full'})`, `needsFull(dir)`, `diff(old, new)`, `drop(dir, {recursive})`, `clear()`,
  `retain(folders)`, `flush()`, `loadIndex()` / `saveIndex(snapshot)`, `gen(dir)`. In-app `fs:changed` patches the cache.
- `App.nav.load(p, {focus, keepSelection, full, wait, recheck})`, `revalidate({full})`, `whenFresh()`, `revalidating`, `lastOpen`;
  `nav.reload()` (F5) = full re-check. Events: `folder:revalidating {path}`, `folder:revalidated {path, changed, added, removed, updated}`,
  `folder:loaded {cached}`, `view:changed {reason, revalidated?, diff?, background?}` — `view.recompute(reason, info)` merges `info`.
- `App.index`: loads a snapshot at startup (`index:ready {snapshot: true}`), then re-checks; `fresh`, `fromSnapshot`, `size`,
  `whenFresh()`, `scan({full})`, `syncFolder(dir, entries)`. Search also covers piece memos/chips (`meta.edit.pieces`) and marker notes.
- `App.select.anchorIndex`; `range()` never collapses to one item when the anchor vanished (focus → nearest selected → last index).
- `fs:missing {paths, dirs, silent}` when a cached entry turned out to be gone; the folder is re-checked.
- `App.lock` (core-lock.js) — one writer per workspace: `.fluid-organizer/lock.json` + BroadcastChannel. `canWrite()`, `state`,
  `owner`, `takeOver()`, `check()`, `nudge()`; event `lock:changed {state, canWrite}`. A read-only window: App.fs throws `EREADONLY`,
  `App.catalog` refuses edits up front (nudge) and never saves, `App.wsdata.write/backup` are skipped, the status bar says 보기 전용.
- `fs:changed` of type `restore` carries `from` (original paths, same order as `paths`).
- `App.ui.toast(msg, { actions: [{label, run}] })` — several buttons (plus the older single `action`).

**Features**
- `App.workspace.flushHooks` — push `() => Promise`; awaited before a workspace switch/close (modules with their own debounced files).
- `App.sidebar.folderMenuItems` — push `(folderPath) => items` to extend the folder tree's context menu.
- `App.gallery`: `refresh()`/`invalidate()` morph cards IN PLACE (element identity kept, merged into one frame, deferred while the
  pointer is down on an item, a gallery menu is open or a drag runs). `cardDecorators` run on a fresh element whose result is morphed
  into the live card — compute from (card, entry) only. `App.gallery.busy`, `stats`; command `gallery.revealFocus` (Alt+G).
  Volatile nodes inside cards (img, mosaic, svg, placeholders) have `pointer-events: none` so clicks land on stable boxes.
- Viewer editing (`App.videoEdit`, `App.videoEditor.saveKept/savePieces/toClips`, `App.videoLossless`): `meta.edit` adds
  `src: {size, mtime}` (applied only while the file matches; 2 s mtime tolerance) and `pieces: {"<start>": {memo, chips}}`; cuts may
  sit inside removed runs. `App.viewer.openAt`, `playSequence`, `stopSegment`, `sequence`, `segment`; events `viewer:segment-ended`,
  `viewer:sequence-ended`, `viewer:edit-ended`, `viewer:piece-select`. `vendor/mediabunny.min.js` (MPL-2.0) is lazy-loaded on the first
  browser-side save (keyframe-aligned lossless MP4/MOV/WebM/MKV, in-memory, ~1 GB cap).
- `App.clips` exactly as §8, plus `updateMany`; IndexedDB rescue copy (rev-stamped) for failed saves.
- Duplicates (`App.dupes`: store, apply, verify, excludeFiles/Folders, markNotDuplicate, setFolderRole, setRules, trashDuplicates,
  engine, ui.open(args), tools, picker). `dupes.json` adds `rules.folderPriority [{path, role: 'keep'|'remove'}]`,
  `lastScan {id, at, scope, engine, counts, reviewed, choices}`, `extraRoots`. Events `dupes:changed {reason}`, `dupes:applied`,
  `dupes:reviewed`, `dupes:fingerprints`. Settings `dupes.prebuildOnOpen`, `dupes.useServer`, `dupes.merge`, `dupes.upgradeToKeep`.
  Files: duplicates.js + dupes-engine.js, dupes-picker.js, dupes-review.js, dupes-tools.js.
- Server client: `App.server.supports('dupes-v2'|'job-pause'|'restart')`, `API_VERSION`/`apiVersion`/`outdated`, `restart()`,
  `handoffUrl()`; `App.server.dupes.fingerprint/scanV2/start/frameUrl/stat/mediaUrl/quarantine/restore/quarantined/roots/pickRoot/
  forgetRoot/isExternal` — exact JSON in docs/server-api.md "Duplicates v2" (apiVersion 2). Quarantine is ONE undo step unless
  `{undoable: false}`. Groups are `sure` only when every member matches the keeper directly (`direct`).

**Workspace data** (§6) also holds `clips.json`, `dupes.json`, `dupes-log.json`, `lock.json`. Other drives: duplicates removed there go to
`<root>\_중복정리\NNN_<name>` (log `정리기록.json`); external fingerprints live in `%APPDATA%\FluidIdentity\fingerprints.sqlite`.

## 10. Viewer chips for pieces (2026-10-21, owner: '뷰어에서 만들 수 있게 해놔야 사용성이 좋지')

Everything about chips works without leaving the viewer, and a selected video piece is a chip target of its own.
- `App.chipset.pieceTarget()` → the viewer's selected piece, or null. Shape: `{ kind: 'piece', path, start, end, label ('조각 2/3' |
  '잘라낸 부분'), range, chips() → ids, stage(tx, ids), flush() }`. The provider is registered by video-edit.js
  (`App.chipset.setPieceProvider(App.videoEdit.chipTarget)`); `stage` patches the file's `meta` inside a chipset transaction, so
  creating a chip + tagging the piece is ONE undo step.
- `App.chipset.countsFor(files | piece)`, `applyPiece(piece, id, mode, { hud })` (same parent / sub-chip / single-choice rules as
  `apply`, via the shared `chipEditor`), `createAndApply(catId, name, files | piece)`.
- While a piece is selected: the viewer's digit hotkeys, the `#` picker (`App.chipsPicker.open('viewer', { returnFocus })`; the
  head shows the target and switches 조각 ↔ 영상 전체) and the chip panel (`App.chipsPanel.render(host, { …, piece })`) tag the
  piece. Esc lets go of the piece → they tag the file again. The strip's '+ 칩' opens the same `#` picker.
- Creating in the viewer: the picker makes a chip from any new name (a '태그' category when there is none); the panel's compact
  foot has '분류' (category dialog), and `startAdding` types new chips in the panel while the viewer is open.
- Piece chips stay piece chips: the sidebar chip filter and 칩별 정리 count FILE chips only (search finds piece chips; saving a
  piece as a file or putting it in 보관함 carries them along).
- The viewer's chip panel is a DOCK panel (chips-viewer.js, `registerPanel({ id: 'chips', order: 10, closeOnEscape: false })`,
  2026-10-22, owner: '팝업 말고 옆에 레이아웃으로 자리를 따로'): it has its own column right of the media (the stage, controls
  and film strip make room; nothing floats over the photo). Opened by the top-bar '칩' button / Alt+C / its tab; setting
  `chips.drawer` remembers it through `viewer:panel` (opening it in any way → on; closing the dock by hand → off; tab switches,
  photo/video changes and closing the viewer leave it). When on, it takes the dock on `viewer:entry` if nothing else is there.
  It has no `hints()`, so the hint row keeps the photo/video keys.
- Viewer dock (viewer.js): panels fitting the file (`kinds`, sorted by `order`) show as TABS in the dock head (video: 칩 |
  메모 목록); a panel whose `kinds` don't fit the next file closes (reason 'kind'), e.g. 메모 목록 on a photo;
  `onClose({ reason: 'user' | 'switch' | 'viewer' | 'kind' })`; event `viewer:panel` {id} / {id: null, closed, reason}.
