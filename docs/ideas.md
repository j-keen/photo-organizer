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
