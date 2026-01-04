# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Fluid Identity** is a single-file browser-based local photo and video organizer. It uses the File System Access API to read and write files directly on the user's local filesystem without any backend server.

## Architecture

The entire application is contained in `사진영상정리기.html` - a single HTML file with embedded CSS and JavaScript.

### External Dependencies (via CDN)
- `idb-keyval` - IndexedDB wrapper for persisting workspace handle
- `marked` - Markdown parsing for memo rendering

### Core Components

**State Management**: Uses global variables for application state:
- `rootHandle`, `currentHandle` - File System Access directory handles
- `dirStack` - Navigation history stack
- `allEntries`, `filteredEntries` - Current folder items
- `globalSearchIndex` - Flat index of all files for search/tags
- `activeImageItem` - Currently opened media item
- `memoTabs` - Multi-tab memo storage per file

**Sidecar System**: Each media file can have an associated `.txt` sidecar file for memos/tags. Multi-tab memos use a custom format with `===TAB::` delimiters.

**Key Functions**:
- `openDirectoryPicker()` - Initiates workspace selection
- `loadDirectory(dirHandle)` - Renders folder contents
- `scanGlobalRecursively()` - Builds search index
- `openImageEditor(item)` - Opens lightbox/memo editor
- `renderGallery()` - Renders the masonry grid
- `parseMemos()/serializeMemos()` - Handles multi-tab memo format

### Features
- Masonry grid gallery with lazy loading (IntersectionObserver)
- Video preview on hover with highlight capture system
- Multi-selection with Ctrl+Click and Shift+Click
- Drag-and-drop file organization between folders
- Tag system parsed from `#hashtags` in memos
- Backup export to JSON format
- Ctrl+Wheel zoom to adjust grid columns

## Development

Open the HTML file directly in a Chromium-based browser (Chrome, Edge) that supports the File System Access API. No build process required.

## Language

The UI text is in English but the filename is in Korean (사진영상정리기 = Photo Video Organizer).
