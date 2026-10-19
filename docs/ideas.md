# Idea log

Every idea considered for the product, with the decision and the reason. Teams append here (via their reports)
each round: generate → critique → select → build → measure → revisit.

Status: ✅ adopted (round) · 🕓 later · ❌ discarded

## Round 0 (foundation, orchestrator)

| Idea | Status | Why |
|---|---|---|
| Rewrite v1 monolith into modules (`js/core` + `js/features`) | ✅ R0 | v1 had fake virtual scroll, in-memory trash, ratings keyed by filename; parallel teams need file ownership |
| Library metadata in `<workspace>/.fluid-organizer/` instead of browser storage / per-file `.txt` sidecars | ✅ R0 | survives browser/PC reinstall (the SSD loss that started this); one file to load instead of thousands; v1 sidecars are imported, not deleted |
| Real trash (files move to `.fluid-organizer/trash`, restorable after reload) + undo for every file operation | ✅ R0 | v1 "trash" lived in memory — deletions were actually permanent |
| Chips stored by ID (not name) | ✅ R0 | renaming a chip updates every file automatically (v1 limitation) |
| Virtualized gallery from day one | ✅ R0 | folders with 10k+ files must stay smooth |
| Daily rotating backups of catalog/chipsets | ✅ R0 | user just lost 9 months of work; cheap insurance |
| Vendored third-party libs (exifr, mpegts) | ✅ R0 | works offline |
| Optional local Python server (FAISS, ffmpeg, HEIC) instead of ffmpeg.wasm | ✅ R0 | user's decision; wasm ffmpeg is slow, huge, and needs COOP/COEP that file:// can't provide |
| Electron desktop app | ❌ | user chose HTML + local server; Electron would be a full rewrite |
| Cloud sync / accounts | ❌ | local-only by design; privacy is a feature |
| Face recognition / AI auto-tagging | 🕓 | heavy (torch); revisit with the server once basics are solid |

## Round 1 (2026-10-19) — 3 idea generators (pro photographer · SaaS designer · owner+competitors) → product lead

120 ideas → 21 adopted as stretch goals (see team reports), 43 discarded, 41 later.

### Later (next rounds)

| Idea | Why later |
|---|---|
| Verified copy/move and mirror backup of the media to another drive (server, 2 variants) | Top round-2 item for an owner who lost 9 months of work to a dead SSD. It is an L server job and needs the server MVP first. |
| Instant folders (names-first listing, LRU cache, background revalidation) + instant library open from a cached index (design + owner) | The biggest perceived-speed win, but it needs changes to js/core/nav.js and index.js. Orchestrator work between rounds. |
| Crash-safe operation journal with resume/rollback (2 variants) | A strong trust feature, but it needs hooks inside the batch functions of js/core/fs.js. Core work between rounds. |
| Lost-metadata rescue after files are moved in Explorer | The core catalog must first stamp a size+mtime fingerprint on entries; after that it is an M job for organize. |
| Live folder watching that follows Explorer moves (2 variants) | Needs a core App.fs.externalChange plus server SSE. After the server MVP. |
| Basket / quick collection on B (3 variants) | The chip filter's '모든 폴더에서 보기' already gathers files across folders this round. Revisit as a sidebar collection if the owner still wants ad-hoc sets. |
| Smart folders: saved searches with live counts, plus Library built-ins (최근 추가, 모든 영상, 큰 영상) | Needs a serializable filter state from chips and search first. Round 2. |
| Full search token language (별점:, 날짜:, 크기:, 길이:, -#칩 pills) | Round 2, once Hangul-initials and chip-name search have landed. |
| Chip filter extras: Alt-click exclude (NOT) and per-category 미분류 progress bar | Strong motivation for working through the tagging backlog. Add on top of chips must-have 6 next round. |
| Suggested chips row (same-folder chips, recent and frequent chips) | Tune it on real chip usage after the port; the autofill wizard covers bulk name matching now. |
| Copy/paste chips between files | Small, but ranks behind the picker and autofill. Use Mod+Alt+C/V, since Mod+Shift+C is organize.copyTo. |
| Folder chips inherited by everything inside | Changes how every team computes chips. Agree an App.chipset.effectiveChips(path) contract first. |
| Chip manager: merge, aliases, avatars, colors, import/export | Needed as the actor taxonomy grows. After the chipset port settles. |
| Bucket sorting mode (1–9 moves to a folder, then auto-advance) | A strong move-based workflow, but organize is full this round. |
| Chip tokens in batch rename ({칩:배우}) | Tiny once the App.chipset API is stable. Round 2. |
| Viewer auto-advance after chip keys + walking only 미분류 files | Needs a chips:applied event from the chip hotkeys first. |
| Resume video playback position ('이어 보기') | Nice for long clips, but ranks behind the must-have player work. |
| Highlight reel across videos | Unique for this owner, but needs markers (viewer) and concat (server) to land first. |
| Storyboard sprites for hover scrub (design, owner) | Measure the gallery's <video>-based scrub first. Sprites add a pass per video to pre-generation. |
| Shared-element open/close morph in the viewer | Polish pass after the viewer must-haves. |
| Find similar photos from any photo (FAISS kNN) | Reuses the pHash cache once /api/dupes/scan is stable. |
| Face clustering → actor chips | Possibly the biggest time saver for actor tagging, but heavy (ONNX models, opt-in). Marked 🕓 in ideas.md. |
| AI text search (CLIP) | Heavy. Marked 🕓 in ideas.md. |
| Server video proxies + RAW decode | /api/media/stream covers playback now, and HEIC thumbnails are already a must-have. Build proxies if seeking in big HEVC files proves slow. |
| Windows integration: Explorer 'Fluid Identity로 열기' entry, tray icon, open with default app, copy path (3 variants) | Gives a native feel after the server MVP. Registry writes and os.startfile need careful whitelisting. |
| Install as an app (PWA) | Needs a manifest and service worker served by the server. After the server MVP. |
| XMP keyword/rating write-back and read (pro, owner) | Touches the original files and needs exiftool. Opt-in only, once the chip hierarchy is settled. |
| Offline drive catalog (search drives that aren't connected) | Useful once the owner runs several archive drives. L effort. |
| Group headers in the grid | Changes the row model. After list view and performance settle. |
| Justified row layout | L effort. The cover/contain toggle fixes cropping this round. |
| Custom folder cover image | Cheap once the automatic mosaic lands. Round 2. |
| Actionable empty states | Round-2 polish pass. |
| Copy the image itself to the system clipboard (for KakaoTalk) | Decide what Mod+C should do once the internal clipboard lands. |
| Media quality badges (4K, 60fps, HEVC, 세로) + inspector media-info section | Coordinate with the gallery badges to avoid clutter. Round 2. |
| Thumbnail pack files instead of one file per thumbnail | Only if the per-file disk cache measures slow on exFAT/HDD. |
| Show job progress in the tab title while the tab is hidden | Small polish after the activity center. |
| Keybinding editor, keymap presets and shortcut nudges (3 variants) | Needs a core App.commands.setKeys, digit matching by e.code, and a commands:run event. |
| Accessibility & motion pass (dialog focus trap, focus rings, live region, --text-4 contrast) | Mostly core ui.js/tokens.css work. Orchestrator pass between rounds. |
| Reconnect screen when permission or the drive drops mid-session | Needs a file-system error signal from core. |
| Backup center extras: hourly snapshots, diff-based restore, alarm when many chips disappear | After the 데이터와 백업 page lands. |
| App.palette.addProvider API + a selection context group at the top of the palette | Worth adding once chips and organize want to contribute palette entries. Round 2. |

### Discarded

| Idea | Why |
|---|---|
| Lasso / rubber-band selection (pro, design and owner variants) | Already gallery must-have 1. |
| Quick Look on Space (3 variants) | Already gallery must-have 7. |
| List/details view with sortable columns | Already gallery must-have 5. |
| Folder cards with mosaic covers and counts (design, owner) | Already gallery must-have 2. Custom cover and empty states moved to later. |
| Video hover scrub on cards (gallery pro variant) | Already gallery must-have 4. The poster-frame part became a viewer + thumbs stretch; sprites are in later. |
| Folder tree completion / tree & breadcrumb as real organizers (pro, design) | Already nav must-haves 1–4 and 6. The tree quick-filter is the stretch. |
| Favorites and recent folders in the sidebar (parts of the 'favorites·recent·smart' and 'Library' ideas) | Favorites are nav must-have 5, and the back/forward history menu covers recents. |
| Thumbnail pre-generation + on-disk cache (pro, design) | Already thumbs must-haves 2–3. |
| EXIF + taken-date / duration / resolution sort keys (3 variants) | Already thumbs must-have 4. |
| Activity center extras: failed-job retry list, jump back through undo history, favicon progress ring | Thumbs must-have 5 covers the panel. Undo-history jumps need a core App.undo.list, which isn't worth it for so little gain. |
| Tri-state chip panel for multi-selection (3 variants) | Already chips must-have 3. Undo makes the '>50 files' confirmation unnecessary. |
| Chip filter with AND/OR and a 미분류 view (design, owner) | Already chips must-have 6. NOT and per-category progress moved to later. |
| v1 tags → chips migration wizard (design) | Chips must-have 7. The library-wide sidecar scan is the stretch. |
| Chip panel inside the viewer on Mod+I | Already chips must-have 8 (the viewer chip drawer), and Mod+I is the global inspector toggle. |
| Video player: J/K/L, frame step, speed, A–B loop, markers, capture (design, pro editing keys) | Already viewer must-haves 3–4. The v1 ←/→ seek and the poster frame are the stretches. |
| Segment video editor with waveform timeline (pro, design) | Already viewer must-have 5. Waveform and per-segment export extras are not worth it this round. |
| Pro zoom extras: minimap, zoom lock, 100% focus check | Zoom/pan is viewer must-have 1. Minimap and zoom lock are extras for pro culling. |
| Trash panel with batches, thumbnails, hold-to-empty | Already organize must-have 1. The team may adopt batch grouping. |
| Batch rename with tokens and live preview (3 variants) | Already organize must-have 2. Pairing RAW/XMP files is pro-only, and chip tokens are in later. |
| Quick Move/Copy picker (Mod+Shift+M) | Already organize must-have 3. Its conflict sheet is the stretch. |
| Preview-first organize-by-date and 폴더 풀기 | Already organize must-haves 4–5. |
| Duplicate review with keep-best rules (3 variants) | Already organize must-have 6. Metadata merge plus the savings meter is the stretch. |
| Command palette over commands, folders, files and chips (3 variants) | Already shell must-have 1. Hangul-initials matching is the stretch; the provider API and selection group are in later. |
| Shortcut sheet on ? (3 variants) | Already shell must-have 2. Rebinding and keymap presets are in later. |
| Settings sheet (Mod+,) | Already shell must-have 3. The 데이터와 백업 page is the stretch. |
| RAW viewing via embedded JPEG (CR2/CR3/NEF/ARW/DNG…) | Built for a pro-photographer persona: nothing in the owner's spec or v1 uses RAW. It is L effort with fragile per-format parsing. |
| Lightroom rating keys (0–5 stars, 6–9 labels, P/X/U flags, Caps Lock auto-advance) | Digits are reserved for chip hotkeys, and pick/reject culling isn't this owner's workflow. |
| Culling mode with '미평가 N장 남음' | Pro culling. The filmstrip and neighbour preloading are already viewer must-have 1. |
| Stacks: RAW+JPG pairs and auto-grouped bursts | A pro need at L effort, and it breaks the one-card-one-file selection model every team relies on. |
| Lightroom-style filter bar (flags, camera, lens, orientation, period) | Overlaps the chip filter and search. Camera/lens facets mean nothing for downloaded media. L effort. |
| SD-card import with verification | Pro ingest at L effort; this owner's media arrive by download or copy. |
| Export presets (resize, watermark, strip GPS, ZIP) | A delivery workflow that isn't in the owner's spec. L effort. |
| Select files from a number list pasted from KakaoTalk | A client-delivery workflow for pro photographers. |
| Offline HTML client-proofing page | Pro delivery workflow at L effort. |
| Blur/sharpness scoring and best-of-burst suggestion | An AI-culling heuristic for pro bursts; noisy on downloaded media. |
| Capture-time correction | Only multi-camera pro shoots need it. |
| Survey/compare view (N) with synced zoom | Pro culling. Side-by-side compare already lives in the duplicates review. |
| Marker export to YouTube chapters / EDL / FCPXML | An editor/creator niche. Markers themselves are a must-have. |
| Viewbar culling progress bar (picks/rejects) | Needs pick/reject flags we aren't adding. Per-category 미분류 progress (in later) covers the motivation. |
| Share to a phone on the same Wi-Fi (QR) | Opens a LAN listener, a new attack surface, for a feature outside the product's purpose. |
| Sample library in OPFS | The owner already has a real library, and the tests seed OPFS anyway. |
| Chip brush (paint chips by clicking or dragging across cards) | Needs a click-interception hook in the gallery. Multi-select, hotkeys and the # picker cover the need. |
| Spring-loaded folder cards in the grid while dragging | Fragile because virtualized cards unmount mid-drag, and the tree already springs open (nav must-have 2). |

### Owner feedback during round 1 (all adopted)

| Request | Where |
|---|---|
| Only the hovered video card plays (muted, looping); never many at once | gallery (Shift scrubs) |
| Folder cards: empty or not, photos/videos/folders inside, total size | gallery cards + tree tooltip/empty look |
| Viewer: rotate + horizontal/vertical flip for images and videos, Ctrl+wheel zoom | viewer (R/Shift+R, H, V) |
| Soft delete by default | core trash; permanent only inside the trash panel |
| Ctrl+Z undoes anything, anywhere, in one step | core global undo + per-team audits |
| ↑/↓ volume in the player; seek feedback must not pile up | viewer player OSD (accumulates in place) + core toast de-dup |
