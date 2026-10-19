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

## Round 2 (2026-10-19) — meeting: owner+competitor lens, design+QA lens, Codex (GPT) → product lead

73 ideas (22 from Codex) → stretch goals below, 32 later, 9 discarded. Owner feedback items were fixed must-haves (see HANDOFF.md).

### Adopted as stretch goals

| Team | Idea |
|---|---|
| gallery | Make the grid input-stable: raise an interaction lock on pointerdown, an open context menu, an active drag and inline-rename focus, queue every invalidate()/re-layout that arrives while it is held, and apply the queue in one requestAnimationFrame on release (force a flush after about 400 ms). Outside the lock, coalesce in-place card updates into one rAF flush and skip paths that are not rendered. Test with autoPregenerate on that zero cards are rebuilt between mouse down and mouse up. |
| gallery | Add a 'chaos refresh' helper to tests/gallery*.test.js that calls App.gallery.invalidate on every rendered path plus App.view.recompute('patch') every 40–120 ms. Re-run plain, Ctrl, Shift and Ctrl+Shift clicks, the checkbox, lasso, drag start, the context-menu target and F2 rename inside it, with down and up split by waitForTimeout, so background work can never silently break input again. |
| gallery | When a background re-sort happens (reason 'sort' with no user input in the last ~1 s, e.g. thumbs.js re-sorting by resolution/duration after pre-generation), keep the first visible item in place with captureAnchor/restoreAnchor instead of scrolling to focus. If the focused item moves off screen, show a small pill '정렬이 바뀌었어요 · 선택한 곳으로' and do not jump. Put any thumbs.js flag you need in integrationRequests. |
| viewer | Guard the edit keys. Ignore Q/W/Mod+B until Number.isFinite(duration), and while a typing target (the piece memo field) has focus. After each edit, show a 1.5 s HUD such as '앞부분 01:23 잘라냄 · Ctrl+Z'. Store size+mtime in meta.edit and, when the file has changed since, show '원본이 바뀌었어요' instead of applying stale pieces. Write a test for each case. |
| viewer | Add one key 'G = 보관함에 담기' (verify with tools/check-keys.js). It adds the selected piece, or otherwise [playhead−15 s, playhead+5 s] (seconds configurable in settings), through App.clips.add as one undo step, without pausing playback, and shows a toast with '메모 쓰기' and '되돌리기'. Feature-detect: when App.clips is absent it adds a marker. |
| clips | Keep the metadata when a clip becomes a file. When a '하나로 저장'/'각각 저장' export finishes, write the clips' chips (union), their memos (joined, with source and time) and meta.source=[{path,start,end}] to the new file with App.catalog.updateMany, in the same single undo step as the file creation. Name outputs with a settings template ('{영상}_{시작}-{끝}_{메모}') that the name prompt previews. |
| clips | Let '이어 보기' and '하나로 저장' act on the whole current filter (search text + chip filter) when nothing is selected, with labels like '배우A 조각 12개 이어 보기', so one chip click becomes a per-person highlight reel. Do not persist bins or reels yet. |
| clips | Make clip frame thumbnails robust. Use App.server.dupes.frameUrl(path, t) when connected (feature-detect). Otherwise capture in the browser with at most 2 concurrent hidden <video> elements, in requestIdleCallback, only for visible rows. Cache by path/size/mtime/t in IndexedDB, and show a tasteful placeholder with the codec name when Chrome cannot decode the file (HEVC/MKV). |
| dupes | Re-verify right before anything is removed. In apply, re-stat every member and require that the kept file exists with the same size+mtime (exact groups also re-check the quick hash). Never remove every member of a group or remove a file whose keeper sits under a disconnected root, and never bulk-remove a member that has clips (App.clips?.forPath) or meta.edit. Skip changed groups with a reason ('보관할 파일이 바뀌어서 건너뛰었어요'). Word the result honestly ('휴지통으로 옮겼어요 · 비우면 n GB 확보'). Write tests for each case. |
| dupes | Add folder roles to rules. rules.folderPriority=[{path, role:'keep'/'remove'}] in dupes.json, set from the scope picker and the folder context menu. The keep suggestion applies the folder role first, then resolution → length → size. Badge each member with its role, explain the suggestion in one line ('보관 폴더에 있어서 남겨요'), and keep the rules-preview counts live. |
| dupes | Make review resumable and show progress. Persist reviewed group ids per lastScan in dupes.json, reopen at the first unreviewed group, show '애매 42개 중 13개 확인' with a thin progress bar, and auto-advance after each keep, 중복 아님 or exclude decision. |
| server | Single-instance launcher and version handshake. Before starting, the launcher/shortcut calls GET /api/health on the fixed default port. If the server is already up, it only opens the browser. /api/health returns apiVersion, and App.server shows an inline '서버를 새 버전으로 다시 켜 주세요 · 다시 켜기' on a mismatch. Add tests for a second launch and for the mismatch. |
| server | Keep the origin stable and do not lose state on the file:// → server switch. Always use a fixed default port. On the one-click switch, carry settings and recent workspace roots once (URL fragment or a short-lived one-time endpoint) and import them on the http side, so the app never 'forgets everything'. Document it in docs/server-api.md. |
| server | Harden quarantine and restore. Move with os.rename within the root. If a copy is ever unavoidable, copy, verify the full hash, then delete the source. Restore never overwrites: if the path is taken, add the suffix ' (복원)'. Write the log with atomic_write. Python tests cover collisions, a read-only source and an interrupted move. |
| core | Make Shift-ranges survive refreshes. In App.select.range, when the anchor is gone, fall back to the focus, then the nearest selected item, then the item at the anchor's last index, and never fall back to a single select. Follow fs:changed renames/moves for the anchor, focus and selection, and keep them by path identity across stale-while-revalidate diffs. Tests in tests/core*.test.js. |
| core | Handle stale cached entries gracefully. When an App.fs op or an open hits NotFound on an entry from a cached listing, revalidate that folder immediately, drop the entry, and show '이 파일은 이미 없어졌어요 · 목록을 새로 고쳤어요'. Batch ops finish the rest and report what they skipped. Test with files deleted behind the app. |
| core | One writer per workspace. A new js/core/core-lock.js keeps .fluid-organizer/lock.json {tabId, origin, heartbeatAt} (heartbeat every 5 s) plus a BroadcastChannel. A second tab, e.g. the leftover file:// tab after the switch to the server, becomes read-only with the banner '다른 창에서 열려 있어요 · 여기서 이어서 하기'. Expose App.lock.canWrite() and put the wsdata/catalog save check in integrationRequests. |

### Adopted by the teams themselves

| Team | Idea | Why |
|---|---|---|
| clips | Selection → filter → all scope with labels like '배우A 조각 12개 이어 보기' for 이어 보기 and both exports (meeting stretch) | One chip click becomes a per-person highlight reel, which fits the owner's people/category workflow with the fewest clicks. Bins and reels are not persisted, as instructed. |
| clips | Carry chips, memos and meta.source onto exported files with a name template '{영상}_{시작}-{끝}_{메모}' and a live preview (meeting stretch) | A clip that becomes a file should not lose the owner's tagging. Writing it in the same undo step keeps Ctrl+Z exact. |
| clips | Robust frame thumbnails: server frameUrl, 2 idle-time browser captures, visible rows only, IndexedDB cache, codec placeholder (meeting stretch) | The owner's library is 2,400+ videos with HEVC/MKV mixed in. No broken images, and repeat opens stay instant. |
| clips | IndexedDB rescue copy of clips.json stamped with a revision; a newer copy wins on open | The owner lost 9 months of work. A failed or skipped file write must never lose clips. |
| clips | Footer with scope count + total length and one-click 이어 보기 / 하나로 저장 / 각각 저장 | The most common actions without opening a menu. Total length tells how long the reel will be. |
| clips | Note + one-click clean-up for clips whose video is in the trash | Hidden data should never be invisible. It explains why clips 'disappeared', and the clean-up is undoable. |
| clips | Typing in the list starts the search; Alt+↑/↓ reorders | Keyboard-first owner requirement; it mirrors the folder tree's behaviour. |
| clips | '이 영상의 조각만 보기' path filter, reachable from the card badge, the inspector and the row menu | Cheap, and it links the gallery and the library in both directions. |
| clips | Resizable list height (remembered) | The owner will have hundreds of clips. A fixed 6-row box is too small for curating, and the tree must stay reachable. |
| core | Library scan pre-warms every folder's listing cache | Free (the scan lists every folder anyway) and makes even the first open of any folder after startup instant. |
| core | Re-check the current folder when the window regains focus / becomes visible | The owner moves files in Explorer and comes back; this catches it without polling or a watcher API. |
| core | Names-first revalidation with a 2-minute size/date TTL | Listing 20k names takes ~280 ms vs ~1 s with stats; adds/removes appear fast, full stats only when needed or on F5. |
| core | Never forget a cache on a guess (drive asleep / unplugged) | Safety: an unreadable drive keeps its cached listing and index entries; only a successful re-check removes things. |
| core | 'cache.clearListings' command | Cheap safety valve if a cache ever looks wrong. |
| core | view:changed carries {revalidated, diff} and unchanged entry objects are kept | Lets the gallery team update cards in place (owner's lost-click issue) without a new API. |
| viewer | Grow the seek bar into a piece lane only once a video is edited (no separate timeline) | Matches '뷰어에서 바로' with zero mode switches. Unedited videos keep the slim bar. |
| viewer | Skip removed parts only when playback runs INTO them | 편집본 미리보기 works by default, and the owner can still seek into a removed part to review it before restoring. |
| viewer | Delete toggles: remove a kept piece / restore a removed one (cuts kept between removed pieces) | One key, an exact undo of a mistake without Ctrl+Z, and no surprise merges. |
| viewer | New files inherit piece memo + chips; joining the last pieces moves notes onto the file memo | Notes written while cutting are never lost and stay searchable on the output files. |
| viewer | Esc deselects the piece before closing panels/the viewer | Keyboard-first flow without accidentally leaving the viewer. |
| viewer | Merge touching/overlapping ranges in the lossless engine and report restored footage | Codex found duplicated/restored footage. Being honest about keyframe alignment beats silently wrong output. |
| viewer | Lazy-load the 685 KB Mediabunny bundle on first save | Start-up stays fast and file:// still works (classic script tag). |
| viewer | Settings page '영상 편집' for the G range and save options | The brief asked for configurable seconds. Keeping the other edit options there too avoids hunting in menus. |
| gallery | 카드 안의 바뀌는 노드에 pointer-events:none (회의 후 추가) | Chrome이 클릭을 버리는 원인(누른 노드 제거)을 비용 거의 없이 근본적으로 막아요. hover 미리보기, 올가미, 드래그, 툴팁(pill은 그대로 둠)은 영향 없어요. |
| gallery | 버려진 클릭을 '다음 pointerdown 전에' 순서대로 처리 | 바쁜 페이지에서는 입력이 타이머보다 먼저 처리돼서 setTimeout(0)만으로는 Shift 범위 기준점이 어긋났어요(재현해서 확인). |
| gallery | 잠금의 400ms 상한을 '잠금 시작' 기준으로 계산 | 앞선 클릭의 타이머가 다음 클릭 도중에 강제 반영돼서 클릭이 사라지는 경우를 실제로 찾았어요. |
| gallery | 직접 일으킨 스크롤에서는 빠른 스크롤 말풍선을 띄우지 않고 미리보기도 끄지 않기 | 화면을 확인하다가 앵커 유지 스크롤 때 말풍선이 뜨는 걸 발견했어요. |
| gallery | App.gallery.stats / busy | 테스트와 진단에서 다시 만든 카드 0개, 복구한 클릭 수를 숫자로 확인할 수 있어요. |
| gallery | 제자리 갱신 덕분에 refresh 때 썸네일이 깜빡이지 않음 | 구조를 바꾸면서 자연스럽게 생긴 효과예요. 이전에는 카드를 다시 만들 때마다 opacity 전환이 다시 일어났어요. |
| gallery | Codex 지적: 잠금 중 pendingView가 있을 때 renderWindow가 새 순서로 카드를 옮기는 문제 | 그대로 반영했어요. 스크롤·크기 변경이 없으면 화면을 그대로 두고, 있으면 즉시 반영해요. |
| gallery | Codex 지적: 클릭이 버려질 때 더블클릭 열기도 사라지는 문제 | 반영했어요. 대신 실행한 두 번째 클릭이 앞선 클릭과 같은 항목이고 500ms 안이면 열어요. 기본 dblclick과 겹쳐서 두 번 열리지는 않아요. |
| server | Generate a real app icon (.ico) for the desktop shortcut with Pillow | A shortcut with the generic Python icon looks like a script, not a product; generating it avoids shipping binary assets. |
| server | Store the per-frame stddev instead of dropping flat frames at fingerprint time | flatStd / frameBits / minFrames / duration rules stay user-adjustable without re-fingerprinting 690 GB. |
| server | Workspace id in /api/workspace/recent and use it to match the file:// folder | The file:// page can't know absolute paths; the .fluid-organizer/workspace.json id identifies the same folder exactly. |
| server | Carry the handoff in the URL fragment instead of a one-time endpoint | The fragment never reaches the server or logs, needs no CORS write path and no server state. |
| server | Generic job pause/resume in the server JobManager mirrored from App.jobs | Benefits every long server job (fingerprints, scans, thumbnail pre-generation), not just dupes. |
| server | Quarantine numbers never reused; redo moves exactly what undo restored | Keeps the 정리기록 log unambiguous and makes Ctrl+Z/redo safe even when another file took the original name (Codex finding). |
| server | Quiet 204 for media requests of files that just moved | Removes red console 404s during rename/rotate and fixed two flaky server tests. |
| server | 'sure' requires a direct match with the keeper; exclusions are transitive | Codex review: transitive union-find could otherwise auto-suggest deleting a file that never matched the kept one. |
| dupes | '옮겨서 남기기': keep the best quality copy but move it into the keep folder (owner's cleanup_cross.py rule B), per group (U) and as a bulk option | It's the owner's own proven workflow: the best file ends up where the library lives. Done as one undo step and verified like any clean-up. |
| dupes | Save a group snapshot with the result so a resumed review keeps decided groups in the list | Without it, groups marked 중복 아님 or cleaned vanish on reopen and the progress count is wrong. |
| dupes | Pause the background pre-build while a foreground scan runs; scans and the pre-build share in-flight computations | Avoids two decoders fighting over the same videos and avoids computing the same fingerprint twice. |
| dupes | Cache the 5 frame thumbnails together with the fingerprints and prefetch the next group's | The review strip shows up at once, which is the heart of 'verify while watching'. |
| dupes | Explain the keep suggestion by the rule that beat the runner-up ('보관 폴더에 있어서', '해상도가 가장 높아서', '조건이 같아서 가장 오래된…') | The owner can trust or override the suggestion without opening every file. |
| dupes | Render big groups 8 members at a time ('+n개 더 보기') and join exact sets with a chain of n-1 edges instead of n² edges | A folder of hundreds of identical placeholders stays smooth. |
| dupes | Bulk clean-up only removes members that match the keeper directly (from Codex finding 4) | A~B~C chains don't prove A~C. Without a direct match, the file needs a human look. |
| dupes | Settings page '중복검사' and viewer context-menu entries | The owner can find the options where he expects them; both use existing extension points. |

### Later

| Idea | Why later |
|---|---|
| Resume each video's last position + watched-progress bar on cards (owner + Codex, viewer) | High value and S, but viewer is the heaviest team this round (in-viewer editing, playback API, Mediabunny research). First viewer pick for round 3; openAt must take precedence. |
| Zoomable precision track + hover frame preview + edge nudges (owner + design-qa, viewer) | Matters on long videos but is M and builds on the new piece track; ship the simple Q/W/Ctrl+B track first and see whether the owner misses precision. |
| Keyframe-honest cuts + server smart cut (re-encode only edge GOPs) (viewer + server) | The right fix for 'saved piece starts early', but it needs keyframe probing on both sides plus an L server mode; do it after Mediabunny research shows what the browser can do. |
| Auto-preview the seam after Q/W/Delete (viewer) | Nice polish on top of 편집본 미리보기; wait until skip playback is stable. |
| Clickable timestamps and #tag autocomplete in piece memos (viewer) | Depends on the hashtag index (viewer must-have via integrationRequest) landing first. |
| '편집만 해 둔 영상' badge/filter, plus list-view columns (길이, 편집됨, 보관함, 지문) and saved review views (viewer, gallery, Codex) | One work-queue feature spread across teams; build it once meta.edit, clips and fingerprints exist and their shapes are stable. |
| Clip/piece ticks on the card hover-scrub line (gallery) | Needs App.clips and meta.edit merged; good round-3 integration polish. |
| Cached storyboard sprites for long videos (Codex, gallery) | Already 'later' in round 1; M with server ffmpeg jobs; it does not fix this round's input problems. |
| Keyboard bucket sorting 1–9 to folders (Codex, gallery) | Strong fit for the owner, but a new mode with key-scope design; propose it to the owner next round. |
| Batch-update long-task budget test at 20k–50k items (design-qa, gallery) | The rAF batching itself is in pick 1; a perf gate with PerformanceObserver comes after in-place updates settle. |
| Smart bins / named collections / saved chip reels in clips.json (owner, design-qa, Codex) | Filter-wide play/export (picked) proves the need first; persisted bins change the clips.json shape mid-contract. |
| Overlap detection when adding clips (Codex) | Becomes important once the G grab key creates near-duplicates; measure how often it happens first. |
| Nudge clip edges in the 보관함 (owner) | M; the edge-precision tooling should be shared with the viewer's zoom track (later). |
| Relink missing clips + metadata rescue after Explorer moves (owner clips, Codex core) | One feature (persistent media identity by size+duration/sampled hash) shared by catalog and clips; design it once in core next round. |
| Export preflight + disk-space planning (design-qa clips, Codex server) | Needs a server disk/estimate endpoint plus UI; do it after concat paths (and the fast path) are final. |
| Lossless concat fast path + loudnorm (server) | A speed win for same-source reels; wait until smart cut/keyframe work defines piece boundaries. |
| '이미 있어요' badge on new downloads (dupes) | The best prevention idea, but it needs the v2 fingerprint cache to be stable and trusted first. Headline candidate for round 3. |
| Streaming partial results during scans (dupes + server) | Needs a job.partialGroups extension to the v2 contract while both sides are being built in parallel; add it after v2 is stable. |
| Clean-up receipt and reclaimed-space history (dupes) | The honest wording is folded into the re-verify pick; the history UI comes after. |
| Polite fingerprinting: below-normal ffmpeg priority, one worker per volume, pause while the viewer plays (server + dupes browser engine) | Correct direction, but volume-aware scheduling needs measuring on the owner's real HDDs; v2 must first be correct and incremental. |
| Duplicate scan coverage report and backup coverage before cleanup (Codex, dupes) | Coverage depends on v2 job stats; backup coverage depends on a backup system that does not exist yet. |
| Protect distinct highlights: remap clips to the kept copy during cleanup (Codex, dupes) | The safety part (never bulk-remove a member with clips/edits) is in the re-verify pick; timing-verified remapping comes after App.clips ships. |
| [Codex] Verified media backup with restore drill (server) | The most important idea for an owner who lost 9 months of work, but L and a product area of its own. Propose it as a round-3 headline must-have. |
| [Codex] Crash-safe operation journal + capability-aware job recovery (core, server) | L; worth doing alongside the backup work so long cross-drive operations share one recovery model. |
| [Codex] Safe eject / disconnected-drive recovery + drive-letter-proof fingerprints (core, server) | Real for external drives, but the owner's roots are fixed internal D:/C: now; revisit with external-root usage data. |
| '서버 켜기' custom URL protocol (server) | Registry protocol handlers add install and security surface; first see whether the desktop shortcut + handshake already removes the confusion. |
| Cheap notModified signature for /api/fs/list (server for core) | Cross-team dependency outside §8; core's SWR must work without it first. A good follow-up once the numbers are measured. |
| Pick up exactly where I left off (core) | High owner value and S, but core's instant-open must-haves come first; pair it with viewer resume next round. |
| Prefetch listings on hover/focus intent (core) | Needs emitters in gallery/sidebar files; measure the cached-open numbers first. |
| Names-first progressive listing for cold huge folders (core) | The cold open is a one-time cost once the listing cache exists; do it if the 20k cold numbers turn out bad. |
| Index clips, piece memos and hashtags in search (core) | Hashtag search already reaches index.js through the viewer's integrationRequest; full clip-level results come after App.clips lands. |
| Remove O(n) hot paths at 50k items (core) | Do it when the 20k measurement in the must-have shows these paths are the bottleneck; otherwise it is premature. |

### Discarded

| Idea | Why |
|---|---|
| Toast to undo a large selection cleared by accident (design-qa, gallery) | Treats a symptom that must-have 1b removes at the source (pointerdown must start on empty canvas to clear); adds UI noise. |
| [Codex] Inherited chips with explicit overrides (clips) | Adds a second chip model (inherited, added, excluded, snapshot) that is too complex for the owner's few-clicks goal; the export-metadata pick covers the real need. |
| [Codex] Portable highlight package (clips) | The owner works on one PC with a synced vault; a manifest/import flow solves a problem he does not have. |
| [Codex] Session recovery for unfinished editing (viewer) | Edits already persist per video in meta.edit; restoring the working context duplicates core's 'pick up where I left off' (later). |
| [Codex] Precision cut controls with honest output estimates (viewer) | Duplicates the zoomable track and keyframe-honesty ideas (merged into later); editable numeric fields go against the owner's 'Q·W·Ctrl+B 정도면 돼'. |
| [Codex] Choose the keeper by owner priorities (dupes) | Merged into the folder-role pick; ranking by bitrate and annotations adds rules the owner did not ask for and the proven algorithm does not use. |
| [Codex] Visible metadata save health (core) | Round 1 already serializes catalog saves with retries, backoff and save events; a status dot is a small orchestrator tweak, not a team item. |
| Keyframe-aware track with Shift snapping (owner, viewer) | Merged into 'Keyframe-honest cuts' in later. It is one idea from two lenses. |
| Polite fingerprint and scan jobs on the server (design-qa variant) | Merged with the owner's 'polite background fingerprinting' in later. They are duplicates. |
| [clips] Inline memo editing directly in the list rows | Fragile in a virtualized list (rows unmount while typing). F2 opens a dialog that saves as you type, with the same one-step undo. |
| [clips] Trim handles on clip rows to adjust start/end | Timeline editing belongs to the viewer team's in-viewer editor. The memo dialog offers exact start/end fields for small fixes. |
| [clips] Saved bins / reels (persistent playlists) | Explicitly out of scope this round. The live filter scope already produces chip reels. |
| [clips] Hover-scrub preview on clip thumbnails | A second media pipeline in the sidebar for little gain. Click already plays the exact range. |
| [clips] Sorting options for the library (newest, by source, by length) | Library order + drag is the curation model. Sorting would fight manual order; reconsider with bins. |
| [clips] Separate full-screen 보관함 view in the gallery area | Clips are not files, so App.view entries do not fit without a contract change. The sidebar plus the inspector cover this round. |
| [core] Names-first display for uncached folders (show names, fill sizes later) | Entries without size/mtime would break thumbnail cache keys / fingerprints and size/date sorting; pre-warming makes uncached opens rare anyway. |
| [core] Live folder watching with FileSystemObserver | Not exposed for these handles in the installed Chrome (typeof FileSystemObserver === 'undefined'); focus re-check covers the Explorer flow. Later: server SSE watcher. |
| [core] Prefetch subfolder listings on hover | Needs gallery/sidebar files (other teams) and the scan pre-warm already covers it. |
| [core] Web Locks API for the single writer | Same-origin only — it can't see the file:// tab vs the server tab, which is exactly the owner's case; lock.json is needed anyway. |
| [core] localStorage for listing caches | 5 MB limit and synchronous; IndexedDB handles 20k-row records in ~20 ms. |
| [viewer] Waveform / thumbnail strip drawn inside the edit track | Costs a decode pass per video (performance on 2,400 videos). Better as a later server-backed sprite feature. |
| [viewer] Reordering pieces inside one video | Time order is natural for one file. Cross-video ordering belongs to the clips team's 보관함 + playSequence. |
| [viewer] Keep the old I/O + segment bin as an 'advanced' mode | The owner explicitly asked for Q/W/Ctrl+B only. Two editing models would confuse. |
| [viewer] Automatic scene-cut suggestions | Needs server-side ffmpeg scene detection. Out of scope this round. |
| [viewer] Browser re-encode (WebCodecs) for frame-accurate cuts | Slow and lossy on big files and adds codec edge cases. The server's 'accurate' mode already covers it. |
| [viewer] Tooltips on every piece in the track | They collide with the hover time/frame preview. Notes show as a dot on the piece and in the strip/메모 목록 instead. |
| [gallery] Shift 범위의 기준점(anchor)을 카드에 표시 | 화면이 복잡해져요. 주인님 문제의 원인은 클릭 유실이었고 이미 고쳤어요. |
| [gallery] 재정렬 뒤 새로 포인터 밑에 온 영상 카드를 자동 재생 | 주인님 규칙은 '올린 카드만 재생'이에요. 마우스를 움직이지 않았는데 재생되면 놀랄 수 있어요. |
| [gallery] 잠금 중에는 스크롤 렌더링까지 완전히 멈추기 | 올가미 자동 스크롤이 깨지고 빈 화면이 보여요. 잠금은 카드를 누를 때만 걸고, 올가미가 시작되면 풀어요. |
| [gallery] 다시 올렸을 때 미리보기를 멈춘 지점부터 이어서 재생 | 좋은 아이디어지만 이번 라운드 범위 밖이라 다음으로 미뤘어요. |
| [gallery] Codex가 다른 팀 파일을 직접 수정하게 하기 | 소유권 규칙과 read-only sandbox 때문에 하지 않았어요. |
| [server] Tray icon (pystray) for the server | Extra dependency and a background UI process; the desktop icon + status bar cover the owner's need this round. Proposed as a next idea. |
| [server] Auto-start the server at Windows login / as a service | Intrusive and harder to explain; the owner asked for one click, not always-on. |
| [server] Short-lived one-time handoff endpoint | Needs a cross-origin POST from file:// and server state; the fragment is simpler and private. |
| [server] Let the desktop shortcut hop to a free port when 8765 is busy | Changes the browser origin and makes the app 'forget' its settings; a clear message is better. |
| [server] Ship ffprobe for duration/resolution | The bundled ffmpeg -i parser (already cached per path+size+mtime) gives the same data without another binary. |
| [server] Accept overlapping compare sides (parent vs child) | A file can only belong to one side; refusing with a clear Korean message is safer than silently dropping cross-side matches. |
| [dupes] Badge on gallery cards for files excluded from the duplicate check | Visual noise on thousands of cards. The viewer toolbar toggle and the exclusions manager cover it. |
| [dupes] Automatic scheduled clean-up of 확실 groups | Unsafe after the SSD loss; the owner explicitly wants to verify before anything leaves. |
| [dupes] A log viewer UI for dupes-log.json in this round | Out of the must-have scope. The log is written now; the viewer is listed as a next idea. |
| [dupes] Audio fingerprints / CLIP embeddings for similarity | Too heavy for the browser engine; a later server-side option. |
| [dupes] Manual frame-offset alignment for trimmed re-uploads | Complex. Position jumps plus A/B already cover verification; kept as a next idea (sliding alignment). |
| [dupes] Making keeper/leave pill toggles undoable | They are selections inside the review before anything happens (like checkboxes in a dialog). They are persisted with the progress instead; the actual clean-up is undoable. |
