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

**Reserved command ids** (implement in the owning team, reference from anywhere):
`folder.new`, `file.open`, `file.rename`, `file.trash`, `select.all`, `select.clear`, `nav.*`, `edit.undo`, `edit.redo`,
`search.focus`, `view.toggleSidebar`, `view.toggleInspector`, `view.toggleTheme`, `workspace.open`, `workspace.close`,
`organize.moveTo`, `organize.copyTo`, `organize.rename` (batch), `organize.unwrap` (폴더 풀기), `organize.byDate`,
`trash.open`, `dupes.open`, `palette.open` (Mod+K), `help.shortcuts` (?), `settings.open` (Mod+,),
`chips.toggleHotkey1..9`, `viewer.*`, `video.*`, `server.connect`, `thumbs.pregenerate`.

### App.undo
`push({ label, undo: async fn, redo: async fn })`, `undo()`, `redo()`, `canUndo()`, `canRedo()`, `clear()`.
For batch operations push **one** entry and call the fs functions with `{ undoable: false }` inside.

### App.idb
Tiny IndexedDB KV: `get/set/del/keys/clear` (store `fluid-identity/kv`), `App.idb.store(dbName, storeName)` for own stores.

### App.ui
`icon(name, {size, class})` → SVG string (names: see `ICONS` in ui.js — add new ones there via integration request),
`iconEl`, `toast(msg, {type: info|success|error|warning|loading, duration, action: {label, run}, id})` → `{update, close}`,
`dialog({title, body, actions: [{label, value, kind, autofocus, onClick(close)}], width, init(box, close)})` → Promise,
`confirm({title, message, okLabel, danger})`, `alert`, `prompt({title, value, validate, selectStem})`,
`menu(items, {x, y} | {anchor, align})`, item = `{label, icon, command | action, hint, checked, danger, disabled, submenu}` | `'-'` | `{header}`,
`contextMenu(el, builder)`, `popover(anchor, contentEl, {align, above})` → `{close}`, `positionFloating`.
CSS building blocks in `css/base.css`: `.btn` (+ `primary ghost danger icon sm lg active`), `.seg`, `.input`, `.textarea`,
`.select`, `.search-box`, `.kbd`, `.badge`, `.spinner`, `.progress>i`, `.panel-section(-head/-body)`, `.empty`, `.menu`, `.dialog`.

### App.fs — file system facade
Entry shape (everything that lists files uses it):
`{ path: 'trip/2024/a.jpg', name: 'a.jpg', kind: 'file'|'dir', type: 'image'|'video'|'dir'|'other', ext: 'jpg', size, mtime }`.

Reads: `list(dir, {stat, all})` (hides dot-files, app data and non-media; `entries.hiddenCount`, `entries.sidecars`),
`stat(p)`, `exists(p)`, `getFile(p)` → File, `url(p)` → `{url, release()}`, `readText`, `readJSON(p, fallback)`.
Writes (emit `fs:changed`, keep catalog in sync, undoable by default):
`mkdir(parent, name)`, `createFile(dir, name, blob)` (unique name), `overwrite(p, blob)`, `rename(p, newName)`,
`move(paths, destDir)` → `[{from,to}]`, `copy(paths, destDir)`, `trash(paths)` → ids, `restore(ids)`, `listTrash()`,
`purgeTrash(ids?)`, `removePermanently(paths)`. Helpers: `uniqueName(dir, name, {isDir, reserved})`, `validateName(name)`,
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
- `App.nav.go(path, {focus})`, `goBack/goForward/goUp/goHome`, `reload()`, `open(entry)` (folder → navigate, file → `item:open`),
  `canBack/canForward/canUp`, `back/fwd` arrays.
- `App.view.entries` (source list), `visible` (filtered+sorted), `source` `{type: 'folder'|'search'|'smart', path, title, ...}`,
  `setEntries(entries, source)` (other modules can show any list, e.g. chip/smart results), `setFilter(id, {label, test, includeDirs})`,
  `clearFilters()`, `setSort(key, dir)`, `registerSortKey(key, label, getter)`, `indexOf(p)`, `get(p)`, `patch(p, fields)`.
- `App.select.paths` (Set), `focus`, `anchor`, `list()` (visible order), `entries()`, `primary()`, `count`,
  `set(paths, {focus, anchor})`, `toggle(p)`, `range(p, {additive})`, `all()`, `clear()`.

### App.index
Whole-workspace flat list for search/smart views: `items`, `folders`, `get(p)`, `under(dir, {recursive})`,
`search(text)`, `ready`, `whenReady()`, `scan()`. Kept up to date from `fs:changed`.

## 5. Feature extension points (js/features)

- `App.workspace.pick()`, `openHandle(handle)`, `openBackend(backend)`, `close()`, `getRecents()`.
- `App.gallery`: `cardDecorators.push((cardEl, entry) => {})`, `contextMenuItems.push((entries) => items)`,
  `refresh()`, `invalidate(paths)`, `scrollTo(path)`, `cardFor(path)`, `columns`, `zoom`, `setZoom(px)`.
  Drag data type for internal drags: `application/x-fi-paths` (JSON array of paths).
- `App.thumbs.get(entry, {size})` → url|null, `peek`, `canThumb`, `prioritize(paths)`, `clearCache()`.
- `App.inspector.addSection({id, title, order, render(body, ctx), when(ctx)})`, `refresh()`.
  ctx = `{entries, primary, folder}`. Built-ins: `preview` (0), `info` (10).
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
