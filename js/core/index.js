/*
 * Workspace index: flat list of every photo/video under the workspace (for search, smart views,
 * chip filters across folders, duplicate scans...). Built in the background after a workspace opens and
 * kept up to date from 'fs:changed'.
 *
 *   App.index.items        — Entry[] (same shape as App.fs.list entries)
 *   App.index.folders      — folder paths
 *   App.index.ready        — true once the first scan finished
 *   App.index.whenReady()  — Promise resolved after the first scan
 *   App.index.search(text) — entries whose name/folder/memo match all words
 *
 * Events: 'index:progress' { scanned }, 'index:ready', 'index:changed'
 */
(() => {
    'use strict';
    const { path: P } = App.util;

    let byPath = new Map();
    let folderSet = new Set();
    let scanToken = 0;
    let readyResolve;
    let readyPromise = new Promise((r) => (readyResolve = r));

    const index = {
        ready: false,
        scanning: false,
        /** folders that contain v1 "<file>.txt" memo sidecars (for the whole-library v1 import) */
        sidecarFolders: [],

        get items() {
            return [...byPath.values()];
        },

        get folders() {
            return [...folderSet];
        },

        get(p) {
            return byPath.get(p) || null;
        },

        whenReady() {
            return readyPromise;
        },

        reset() {
            scanToken++;
            byPath = new Map();
            folderSet = new Set();
            index.ready = false;
            index.scanning = false;
            readyPromise = new Promise((r) => (readyResolve = r));
        },

        async scan() {
            const token = ++scanToken;
            index.scanning = true;
            const found = new Map();
            const folders = new Set(['']);
            const sidecarDirs = new Set();
            const job = App.jobs.start({ title: '라이브러리 색인 중', total: 0, cancellable: false });
            const queue = [''];
            let scannedDirs = 0;
            try {
                while (queue.length) {
                    if (token !== scanToken) return;
                    const dir = queue.shift();
                    let entries;
                    try {
                        entries = await App.fs.list(dir);
                    } catch (e) {
                        console.warn('[index] cannot list', dir, e);
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
            }
            if (token !== scanToken) return;
            byPath = found;
            folderSet = folders;
            index.sidecarFolders = [...sidecarDirs];
            index.scanning = false;
            index.ready = true;
            readyResolve();
            App.bus.emit('index:ready');
            App.bus.emit('index:changed');
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

    // Incremental maintenance
    async function restat(paths) {
        for (const p of paths) {
            try {
                const e = await App.fs.stat(p);
                if (e.kind === 'dir') {
                    folderSet.add(p);
                    for (const child of await collect(p)) byPath.set(child.path, child);
                } else if (e.type !== 'other') {
                    byPath.set(p, e);
                }
            } catch (err) {
                /* vanished meanwhile */
            }
        }
        App.bus.emit('index:changed');
    }

    async function collect(dir) {
        const out = [];
        const queue = [dir];
        while (queue.length) {
            const d = queue.shift();
            for (const e of await App.fs.list(d).catch(() => [])) {
                if (e.kind === 'dir') {
                    folderSet.add(e.path);
                    queue.push(e.path);
                } else out.push(e);
            }
        }
        return out;
    }

    App.bus.on('fs:changed', (change) => {
        if (!index.ready) return;
        const paths = change.paths.filter((p) => !App.fs.isDataPath(p));
        if (change.type === 'trash' || change.type === 'delete') {
            for (const p of paths) {
                for (const k of [...byPath.keys()]) if (P.isInside(k, p)) byPath.delete(k);
                for (const f of [...folderSet]) if (P.isInside(f, p)) folderSet.delete(f);
            }
            App.bus.emit('index:changed');
        } else if (change.from && change.to && (change.type === 'move' || change.type === 'rename')) {
            for (let i = 0; i < change.from.length; i++) {
                const from = change.from[i];
                const to = change.to[i];
                for (const [k, e] of [...byPath]) {
                    const r = P.rebase(k, from, to);
                    if (r != null) {
                        byPath.delete(k);
                        byPath.set(r, { ...e, path: r, name: P.base(r) });
                    }
                }
                for (const f of [...folderSet]) {
                    const r = P.rebase(f, from, to);
                    if (r != null) {
                        folderSet.delete(f);
                        folderSet.add(r);
                    }
                }
            }
            App.bus.emit('index:changed');
        } else {
            restat(paths);
        }
    });

    App.index = index;
})();
