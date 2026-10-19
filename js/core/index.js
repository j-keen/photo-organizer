/*
 * Workspace index: flat list of every photo/video under the workspace (for search, smart views,
 * chip filters across folders, duplicate scans...). Kept up to date from 'fs:changed'.
 *
 * Instant library open: the index is saved as a snapshot (App.listCache.saveIndex, IndexedDB) and loaded first
 * when a workspace opens — `ready` turns true within milliseconds and search works right away — then the library
 * is re-checked in the background (names first per folder via App.listCache, so unchanged folders cost one
 * directory read) and only real differences are applied ('index:changed'). Changes made while that runs are replayed
 * on top of the new result. Opening a folder also feeds its fresh listing back in (syncFolder).
 *
 *   App.index.items        — Entry[] (same shape as App.fs.list entries)
 *   App.index.folders      — folder paths
 *   App.index.ready        — true once a snapshot or the first scan is loaded
 *   App.index.fresh        — true once the background re-check of this session finished
 *   App.index.fromSnapshot — the items currently come from the saved snapshot (re-check still running)
 *   App.index.whenReady()  — Promise resolved when ready
 *   App.index.whenFresh()  — Promise resolved after the background re-check
 *   App.index.scan({ full }) — (re)scan the library; full ignores the snapshot and the cached listings
 *   App.index.syncFolder(dir, entries) — apply a fresh listing of one folder
 *   App.index.search(text) — entries whose name/folder/memo match all words
 *
 * Events: 'index:progress' { scanned }, 'index:ready' { snapshot }, 'index:changed'
 */
(() => {
    'use strict';
    const { path: P } = App.util;

    let byPath = new Map();
    let folderSet = new Set();
    let scanToken = 0;
    let readyResolve;
    let readyPromise = new Promise((r) => (readyResolve = r));
    let freshResolve;
    let freshPromise = new Promise((r) => (freshResolve = r));
    let changeLog = null; // fs:changed events seen while a scan runs (replayed on the new result)

    const index = {
        ready: false,
        fresh: false,
        fromSnapshot: false,
        scanning: false,
        /** folders that contain v1 "<file>.txt" memo sidecars (for the whole-library v1 import) */
        sidecarFolders: [],

        get items() {
            return [...byPath.values()];
        },

        get folders() {
            return [...folderSet];
        },

        get size() {
            return byPath.size;
        },

        get(p) {
            return byPath.get(p) || null;
        },

        whenReady() {
            return readyPromise;
        },

        whenFresh() {
            return freshPromise;
        },

        reset() {
            scanToken++;
            byPath = new Map();
            folderSet = new Set();
            changeLog = null;
            index.ready = false;
            index.fresh = false;
            index.fromSnapshot = false;
            index.scanning = false;
            index.sidecarFolders = [];
            readyPromise = new Promise((r) => (readyResolve = r));
            freshPromise = new Promise((r) => (freshResolve = r));
        },

        async scan({ full = false } = {}) {
            const token = ++scanToken;
            index.scanning = true;
            const LC = App.listCache?.enabled ? App.listCache : null;
            // Changes made from now on are replayed on top of the scan result (they may predate what it listed)
            const log = [];
            changeLog = log;

            // 1) Instant start from the saved snapshot
            let fromSnap = false;
            if (!index.ready && LC && !full) {
                let snap = null;
                try {
                    snap = await LC.loadIndex();
                } catch (e) {
                    console.warn('[index] snapshot unreadable', e);
                }
                if (token !== scanToken) return;
                if (snap) {
                    hydrate(snap);
                    fromSnap = true;
                    index.fromSnapshot = true;
                    markReady(true);
                    App.bus.emit('index:changed');
                }
            }

            // 2) Walk the library (names first per cached folder)
            const found = new Map();
            const folders = new Set(['']);
            const sidecarDirs = new Set();
            const failed = []; // folders that could not be read (drive asleep, permission...): keep what we knew
            const job = App.jobs.start({ title: fromSnap ? '라이브러리 새로 확인 중' : '라이브러리 색인 중', total: 0, cancellable: false, background: true, kind: 'index' });
            const queue = [''];
            let scannedDirs = 0;
            try {
                while (queue.length) {
                    if (token !== scanToken) return;
                    const dir = queue.shift();
                    let entries;
                    try {
                        entries = LC ? await LC.list(dir, { mode: full ? 'full' : 'auto', sync: false }) : await App.fs.list(dir);
                    } catch (e) {
                        console.warn('[index] cannot list', dir, e);
                        failed.push(dir);
                        continue;
                    }
                    for (const e of entries) {
                        if (e.kind === 'dir') {
                            folders.add(e.path);
                            queue.push(e.path);
                        } else {
                            found.set(e.path, e);
                        }
                    }
                    if (entries.sidecars?.length) sidecarDirs.add(dir);
                    scannedDirs++;
                    if (scannedDirs % 10 === 0) {
                        job.update(found.size, { detail: `${found.size}개 파일` });
                        App.bus.emit('index:progress', { scanned: found.size });
                        await new Promise((r) => setTimeout(r, 0));
                    }
                }
            } finally {
                job.finish();
                if (changeLog === log && token !== scanToken) changeLog = null;
            }
            if (token !== scanToken) return;

            // 3) Folders that failed to read keep what the snapshot / previous scan knew about them
            for (const dir of failed) {
                for (const [k, e] of byPath) if (P.isInside(k, dir) && !found.has(k)) found.set(k, e);
                for (const f of folderSet) if (P.isInside(f, dir)) folders.add(f);
                if (index.sidecarFolders.includes(dir)) sidecarDirs.add(dir);
            }

            // 4) Replay the changes made meanwhile on the new maps, then swap them in (announce only real differences)
            changeLog = null;
            for (const c of log) {
                await applyChange(c, { emit: false, maps: { files: found, folders } });
                if (token !== scanToken) return;
            }
            const changed = !index.ready || differs(byPath, found) || folderSet.size !== folders.size || [...folders].some((f) => !folderSet.has(f));
            byPath = found;
            folderSet = folders;
            index.sidecarFolders = [...sidecarDirs];
            index.scanning = false;
            index.fromSnapshot = false;
            const first = !index.ready;
            if (first) markReady(false);
            index.fresh = true;
            freshResolve();
            if (changed || log.length || first) App.bus.emit('index:changed');
            saveSnapshot();
            // Forget cached listings of folders that are gone — only after a complete walk
            if (!failed.length) LC?.retain(folderSet).catch?.(() => {});
        },

        /** Apply a fresh listing of one folder (direct children), e.g. after a folder was re-checked on open */
        syncFolder(dir, entries) {
            if (!index.ready || !entries) return false;
            const files = new Map();
            const dirs = new Set();
            for (const e of entries) {
                if (P.parent(e.path) !== dir) continue;
                if (e.kind === 'dir') dirs.add(e.path);
                else files.set(e.path, e);
            }
            let changed = false;
            for (const k of [...byPath.keys()]) {
                if (P.parent(k) === dir && !files.has(k)) {
                    byPath.delete(k);
                    changed = true;
                }
            }
            for (const [k, e] of files) {
                const o = byPath.get(k);
                if (!o || o.size !== e.size || o.mtime !== e.mtime) {
                    byPath.set(k, { ...e });
                    changed = true;
                }
            }
            if (!folderSet.has(dir) && dir !== '') {
                folderSet.add(dir);
                changed = true;
            }
            for (const f of [...folderSet]) {
                if (f !== '' && P.parent(f) === dir && !dirs.has(f)) {
                    removeTree(f);
                    changed = true;
                }
            }
            const added = [...dirs].filter((d) => !folderSet.has(d));
            if (added.length) {
                for (const d of added) folderSet.add(d);
                changed = true;
                // A folder that appeared outside the app: pull in what's inside it
                restat(added);
            }
            if (changed) announce();
            return changed;
        },

        /** Entries under a folder (recursive by default) */
        under(dir, { recursive = true } = {}) {
            const out = [];
            for (const e of byPath.values()) {
                if (recursive ? P.isInside(e.path, dir) && e.path !== dir : P.parent(e.path) === dir) out.push(e);
            }
            return out;
        },

        search(text, { limit = 5000 } = {}) {
            const words = text.toLowerCase().split(/\s+/).filter(Boolean);
            if (!words.length) return [];
            const out = [];
            const chipName = (id) => App.chipset?.labelOf?.(id) || App.chipset?.nameOf?.(id) || '';
            for (const e of byPath.values()) {
                const meta = App.catalog.peek(e.path);
                const chips = meta?.chips?.length ? meta.chips.map(chipName).join(' ') : '';
                const hay = (e.path + ' ' + (meta?.memo || '') + ' ' + (meta?.legacyTags || []).join(' ') + ' ' + chips).toLowerCase();
                if (words.every((w) => hay.includes(w))) {
                    out.push(e);
                    if (out.length >= limit) break;
                }
            }
            return out;
        },
    };

    function markReady(snapshot) {
        index.ready = true;
        readyResolve();
        App.bus.emit('index:ready', { snapshot });
    }

    function hydrate(snap) {
        const map = new Map();
        for (const row of snap.items) {
            const p = row[0];
            map.set(p, App.fs.toEntry(P.parent(p), { name: P.base(p), kind: 'file', size: row[1] ?? undefined, mtime: row[2] ?? undefined }));
        }
        byPath = map;
        folderSet = new Set(['', ...(snap.folders || [])]);
        index.sidecarFolders = Array.isArray(snap.sidecarFolders) ? snap.sidecarFolders : [];
    }

    function differs(a, b) {
        if (a.size !== b.size) return true;
        for (const [k, e] of b) {
            const o = a.get(k);
            if (!o || o.size !== e.size || o.mtime !== e.mtime) return true;
        }
        return false;
    }

    function removeTree(p, maps = { files: byPath, folders: folderSet }) {
        for (const k of [...maps.files.keys()]) if (P.isInside(k, p)) maps.files.delete(k);
        for (const f of [...maps.folders]) if (f !== '' && P.isInside(f, p)) maps.folders.delete(f);
    }

    // Snapshot: compact rows, saved a moment after the last change
    const saveSnapshot = App.util.debounce(() => {
        if (!index.ready || !App.listCache?.enabled) return;
        const items = [];
        for (const e of byPath.values()) items.push([e.path, e.size ?? null, e.mtime ?? null]);
        App.listCache.saveIndex({ items, folders: [...folderSet].filter((f) => f !== ''), sidecarFolders: index.sidecarFolders });
    }, 1500);

    const announce = App.util.debounce(() => App.bus.emit('index:changed'), 50);
    App.bus.on('index:changed', () => {
        if (index.ready && !index.fromSnapshot) saveSnapshot();
    });

    // Incremental maintenance. Every helper works on the maps it was given (captured up front), so work that
    // resumes after an await never writes into another workspace's index after a switch.
    const current = () => ({ files: byPath, folders: folderSet });

    async function restat(paths, { emit = true, maps = current() } = {}) {
        for (const p of paths) {
            try {
                const e = await App.fs.stat(p);
                if (e.kind === 'dir') {
                    maps.folders.add(p);
                    for (const child of await collect(p, maps)) maps.files.set(child.path, child);
                } else if (e.type !== 'other') {
                    maps.files.set(p, e);
                }
            } catch (err) {
                /* vanished meanwhile */
            }
        }
        if (emit && maps.files === byPath) App.bus.emit('index:changed');
    }

    async function collect(dir, maps = current()) {
        const out = [];
        const queue = [dir];
        while (queue.length) {
            const d = queue.shift();
            for (const e of await App.fs.list(d).catch(() => [])) {
                if (e.kind === 'dir') {
                    maps.folders.add(e.path);
                    queue.push(e.path);
                } else out.push(e);
            }
        }
        return out;
    }

    async function applyChange(change, { emit = true, maps = current() } = {}) {
        const paths = (change.paths || []).filter((p) => !App.fs.isDataPath(p));
        if (change.type === 'trash' || change.type === 'delete') {
            for (const p of paths) removeTree(p, maps);
            if (emit) App.bus.emit('index:changed');
        } else if (change.from && change.to && (change.type === 'move' || change.type === 'rename')) {
            for (let i = 0; i < change.from.length; i++) {
                const from = change.from[i];
                const to = change.to[i];
                for (const [k, e] of [...maps.files]) {
                    const r = P.rebase(k, from, to);
                    if (r != null) {
                        maps.files.delete(k);
                        maps.files.set(r, { ...e, path: r, name: P.base(r) });
                    }
                }
                for (const f of [...maps.folders]) {
                    const r = P.rebase(f, from, to);
                    if (r != null) {
                        maps.folders.delete(f);
                        maps.folders.add(r);
                    }
                }
            }
            if (emit) App.bus.emit('index:changed');
        } else {
            await restat(paths, { emit, maps });
        }
    }

    App.bus.on('fs:changed', (change) => {
        if (changeLog) changeLog.push(change);
        if (!index.ready) return;
        applyChange(change);
    });

    App.index = index;
})();
