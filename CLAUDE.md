# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Fluid Identity** (사진영상정리기) — a local photo & video organizer that runs in Chrome/Edge. It reads and writes the
user's folders through the File System Access API (or through the optional local Python server in `server/`).
No cloud, no build step.

v2 is a modular rewrite (2026-10). The v1 single-file app is kept at `legacy/사진영상정리기-v1.html` for reference.

## Architecture

Read `docs/ARCHITECTURE.md` first — it is the contract (APIs, events, file ownership, conventions).
`docs/server-api.md` is the local server contract. `docs/ideas.md` logs product ideas (adopted/discarded and why).

- Entry: `사진영상정리기.html` loads `css/*`, `vendor/*`, `js/core/*`, then `js/features/*`, then `App.start()`.
- Classic scripts + `window.App` namespace (must work from file://, so no ES modules / no local fetch).
- `js/core/`: app (bus, state, commands, undo, settings, idb), ui (icons, dialogs, menus, toasts), fs (path-based
  facade + BrowserBackend + trash), catalog (per-file metadata in `.fluid-organizer/catalog.json`), jobs, nav
  (navigation/view/selection), index (whole-workspace file index).
- `js/features/`: workspace, layout, topbar, statusbar, sidebar (tree), thumbs, gallery (virtualized), inspector,
  viewer, chipset, video-editor, organize, duplicates, server client, palette.
- Library data lives with the photos in `<workspace>/.fluid-organizer/` (catalog, chipsets, trash, backups).

## Development

- Run: open `사진영상정리기.html` in Chrome/Edge, or `node tests/serve.js` for an http URL.
- Tests: `npm install` once, then `node tests/run.js [filter]` (Playwright + installed Chrome, OPFS-backed fake
  workspace; fails on any page error or native dialog). Add tests next to the feature you change.
- UI copy is Korean (friendly polite tone). Never use native alert/confirm/prompt — use `App.ui`.
- After meaningful work, update `HANDOFF.md`, commit, and push (global rule: back up to GitHub every big update).
