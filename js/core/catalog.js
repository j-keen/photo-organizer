/*
 * Catalog: per-file metadata (chips, rating, color label, memo, video markers, cached media info),
 * stored in <workspace>/.fluid-organizer/catalog.json keyed by workspace-relative path.
 * Lives with the photos (not in the browser), is written debounced, and keeps rotating daily backups.
 *
 * Entry shape (all fields optional):
 *   { chips: [chipId], rating: 0..5, label: 'red'|'orange'|'yellow'|'green'|'blue'|'purple'|null,
 *     memo: string, markers: [{ id, t, title, memo, color }], meta: { w, h, duration, taken, ... }, updatedAt }
 *
 * Events: 'catalog:loaded', 'catalog:changed' { paths }
 *
 * Also exposes App.wsdata — tiny helper for other JSON documents in .fluid-organizer/ (chipsets.json, ...).
 */
(() => {
    'use strict';
    const { path: P } = App.util;
    const DIR = '.fluid-organizer';
    const FILE = DIR + '/catalog.json';
    const BACKUP_DIR = DIR + '/backups';
    const KEEP_BACKUPS = 10;

    // ---------- Workspace data documents ----------
    const wsdata = {
        path(name) {
            return `${DIR}/${name}.json`;
        },
        async read(name, fallback) {
            try {
                const v = await App.fs.readJSON(wsdata.path(name), null);
                return v ?? fallback;
            } catch (e) {
                if (e.code === 'ECORRUPT') {
                    const restored = await wsdata.readLatestBackup(name);
                    if (restored) {
                        App.ui.toast(`${name}.json이 손상돼서 최근 백업으로 복구했어요`, { type: 'warning', duration: 8000 });
                        return restored;
                    }
                }
                console.error('[wsdata] read failed', name, e);
                return fallback;
            }
        },
        write(name, obj) {
            return App.fs.writeJSON(wsdata.path(name), obj);
        },
        // Once per day keep a copy in backups/<name>-YYYYMMDD.json, pruning old ones.
        async backup(name, obj) {
            const d = new Date();
            const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
            const target = `${BACKUP_DIR}/${name}-${stamp}.json`;
            try {
                if (await App.fs.exists(target)) return;
                await App.fs.writeJSON(target, obj);
                const files = (await App.fs.backend.list(BACKUP_DIR, { stat: false }))
                    .map((r) => r.name)
                    .filter((n) => n.startsWith(name + '-') && n.endsWith('.json'))
                    .sort();
                for (const old of files.slice(0, Math.max(0, files.length - KEEP_BACKUPS))) {
                    await App.fs.backend.remove(`${BACKUP_DIR}/${old}`).catch(() => {});
                }
            } catch (e) {
                console.warn('[wsdata] backup failed', name, e);
            }
        },
        async readLatestBackup(name) {
            try {
                const files = (await App.fs.backend.list(BACKUP_DIR, { stat: false }))
                    .map((r) => r.name)
                    .filter((n) => n.startsWith(name + '-') && n.endsWith('.json'))
                    .sort()
                    .reverse();
                for (const f of files) {
                    try {
                        return JSON.parse(await App.fs.readText(`${BACKUP_DIR}/${f}`));
                    } catch (e) {
                        /* try older */
                    }
                }
            } catch (e) {
                /* no backups */
            }
            return null;
        },
    };

    // ---------- Catalog ----------
    let data = { version: 1, items: {} };
    let dirty = false;
    let failures = 0; // consecutive failed saves
    let retryTimer = null;

    function isEmpty(e) {
        return (!e.chips || !e.chips.length) && !e.rating && !e.label && !e.memo && (!e.markers || !e.markers.length) && (!e.meta || !Object.keys(e.meta).length) && !e.legacyImported;
    }

    // Visit keys equal to p or under p/
    function keysUnder(p) {
        const out = [];
        for (const k of Object.keys(data.items)) if (P.isInside(k, p)) out.push(k);
        return out;
    }

    const saveSoon = App.util.debounce(() => catalog.save(), 700);

    // Undo support: path -> deep copy of the entry (null when absent)
    function snapshot(paths) {
        const snap = new Map();
        for (const p of paths) snap.set(p, data.items[p] ? JSON.parse(JSON.stringify(data.items[p])) : null);
        return snap;
    }

    function sameSnapshot(a, b) {
        for (const [p, e] of a) {
            const x = e ? { ...e, updatedAt: 0 } : null;
            const y = b.get(p) ? { ...b.get(p), updatedAt: 0 } : null;
            if (JSON.stringify(x) !== JSON.stringify(y)) return false;
        }
        return true;
    }

    function restoreSnapshot(snap) {
        for (const [p, e] of snap) {
            if (e) data.items[p] = JSON.parse(JSON.stringify(e));
            else delete data.items[p];
        }
        dirty = true;
        saveSoon();
        App.bus.emit('catalog:changed', { paths: [...snap.keys()], undo: true });
    }

    const catalog = {
        loaded: false,

        async load() {
            data = await wsdata.read('catalog', null);
            if (!data || typeof data.items !== 'object') data = { version: 1, items: {} };
            catalog.loaded = true;
            dirty = false;
            if (Object.keys(data.items).length) wsdata.backup('catalog', data);
            App.bus.emit('catalog:loaded');
        },

        reset() {
            data = { version: 1, items: {} };
            catalog.loaded = false;
            dirty = false;
            failures = 0;
            clearTimeout(retryTimer);
        },

        /**
         * Events for a save indicator: 'catalog:saving', 'catalog:saved', 'catalog:error' { error, failures }.
         * A failed write (folder briefly unavailable, local server restarting...) is retried with backoff;
         * the user is only alerted when it keeps failing.
         */
        async save() {
            if (!dirty || !App.fs.ready) return;
            dirty = false;
            clearTimeout(retryTimer);
            App.bus.emit('catalog:saving');
            try {
                await wsdata.write('catalog', data);
                if (failures >= 3) App.ui.toast('밀려 있던 정보를 저장했어요', { type: 'success', id: 'catalog-save' });
                failures = 0;
                App.bus.emit('catalog:saved');
            } catch (e) {
                dirty = true;
                failures++;
                console.warn(`[catalog] save failed (attempt ${failures}), retrying`, e && e.message);
                App.bus.emit('catalog:error', { error: e, failures });
                retryTimer = setTimeout(() => catalog.save(), Math.min(30000, 2000 * 2 ** (failures - 1)));
                if (failures === 3) App.ui.toast('정보를 아직 저장하지 못했어요. 계속 다시 시도하고 있어요 — 폴더 권한이나 로컬 서버를 확인해 주세요.', { type: 'error', id: 'catalog-save', duration: 0 });
            }
        },

        /** True while there are edits not yet written to catalog.json */
        get dirty() {
            return dirty;
        },

        flush() {
            saveSoon.cancel();
            return catalog.save();
        },

        /** Stored entry or undefined. Do not mutate — use update(). */
        peek(p) {
            return data.items[p];
        },

        /** Entry with defaults filled in (never undefined). Do not mutate — use update(). */
        get(p) {
            const e = data.items[p] || {};
            return { chips: e.chips || [], rating: e.rating || 0, label: e.label || null, memo: e.memo || '', markers: e.markers || [], meta: e.meta || {} };
        },

        /**
         * update(path, patchObject | (entry) => void, opts). Emits catalog:changed.
         * opts: { label = '정보 변경', undoable = true, coalesceKey, silent }
         * Undoable by default: Ctrl+Z restores the previous values. Pass a coalesceKey (e.g. 'memo:' + path) for
         * rapid repeated edits so they collapse into one undo step; pass { undoable: false } if you push your own entry.
         */
        update(p, patch, opts) {
            catalog.updateMany([p], patch, opts);
        },

        updateMany(paths, patch, { silent = false, undoable = true, label = '정보 변경', coalesceKey = null } = {}) {
            const before = undoable ? snapshot(paths) : null;
            for (const p of paths) {
                const entry = data.items[p] ? JSON.parse(JSON.stringify(data.items[p])) : {};
                if (typeof patch === 'function') patch(entry, p);
                else Object.assign(entry, patch);
                entry.updatedAt = Date.now();
                if (isEmpty(entry)) delete data.items[p];
                else data.items[p] = entry;
            }
            dirty = true;
            saveSoon();
            if (!silent) App.bus.emit('catalog:changed', { paths });
            if (undoable) {
                const after = snapshot(paths);
                if (!sameSnapshot(before, after)) {
                    App.undo.push({ label, coalesceKey, undo: () => restoreSnapshot(before), redo: () => restoreSnapshot(after) });
                }
            }
        },

        /** Merge cached media info without marking as a user edit or emitting noisy events. */
        setMeta(p, meta) {
            const entry = data.items[p] || {};
            entry.meta = { ...(entry.meta || {}), ...meta };
            data.items[p] = entry;
            dirty = true;
            saveSoon();
        },

        // Path bookkeeping (called by App.fs)
        relocate(from, to) {
            let changed = false;
            for (const k of keysUnder(from)) {
                data.items[P.rebase(k, from, to)] = data.items[k];
                delete data.items[k];
                changed = true;
            }
            if (changed) {
                dirty = true;
                saveSoon();
            }
        },

        copy(from, to) {
            let changed = false;
            for (const k of keysUnder(from)) {
                data.items[P.rebase(k, from, to)] = JSON.parse(JSON.stringify(data.items[k]));
                changed = true;
            }
            if (changed) {
                dirty = true;
                saveSoon();
            }
        },

        /** Remove entries for p (and below), returning them keyed relative to p (for the trash manifest). */
        take(p) {
            const taken = {};
            for (const k of keysUnder(p)) {
                taken[k === p ? '' : k.slice(p.length + 1)] = data.items[k];
                delete data.items[k];
            }
            if (Object.keys(taken).length) {
                dirty = true;
                saveSoon();
                return taken;
            }
            return null;
        },

        /** Re-insert entries produced by take() under a (possibly new) path. */
        put(taken, _originalPath, p) {
            for (const [rel, entry] of Object.entries(taken || {})) data.items[rel ? `${p}/${rel}` : p] = entry;
            dirty = true;
            saveSoon();
            App.bus.emit('catalog:changed', { paths: [p] });
        },

        remove(p) {
            const keys = keysUnder(p);
            for (const k of keys) delete data.items[k];
            if (keys.length) {
                dirty = true;
                saveSoon();
            }
        },

        entries() {
            return Object.entries(data.items);
        },

        // ----- Legacy v1 sidecars ("<file>.txt" with ===TAB:: sections and #TAGS: lines) -----
        parseLegacySidecar(text) {
            const tabs = [];
            if (!text.includes('===TAB::')) {
                tabs.push({ title: '', tags: '', content: text });
            } else {
                for (const part of text.split('===TAB::').slice(1)) {
                    const nl = part.indexOf('\n');
                    let body = nl < 0 ? '' : part.slice(nl + 1);
                    let tags = '';
                    let title = (nl < 0 ? part : part.slice(0, nl)).replace(/=+$/, '').trim();
                    const t = body.match(/^#TITLE:\s*(.*)$/m);
                    if (t) {
                        title = t[1].trim();
                        body = body.replace(t[0], '');
                    }
                    const g = body.match(/^#TAGS:\s*(.*)$/m);
                    if (g) {
                        tags = g[1];
                        body = body.replace(g[0], '');
                    }
                    tabs.push({ title, tags, content: body.trim() });
                }
            }
            const memo = tabs
                .map((t) => (tabs.length > 1 && t.title && t.title !== 'Default' && t.title !== 'Draft' ? `[${t.title}]\n${t.content}` : t.content))
                .filter((s) => s && s.trim())
                .join('\n\n')
                .trim();
            const tags = [...new Set(tabs.flatMap((t) => (t.tags.match(/#?[^\s#,]+/g) || []).map((x) => x.replace(/^#/, ''))))];
            return { memo, tags };
        },

        /** Import memo + tags from legacy sidecars for the given media paths (only where no catalog entry exists yet). */
        async importLegacySidecars(mediaPaths) {
            const imported = [];
            for (const p of mediaPaths) {
                if (data.items[p]?.legacyImported) continue;
                let text;
                try {
                    text = await App.fs.readText(p + '.txt');
                } catch (e) {
                    continue;
                }
                const { memo, tags } = catalog.parseLegacySidecar(text);
                catalog.update(p, (e) => {
                    if (memo && !e.memo) e.memo = memo;
                    if (tags.length) e.legacyTags = tags;
                    e.legacyImported = true;
                }, { silent: true, undoable: false });
                imported.push(p);
            }
            if (imported.length) App.bus.emit('catalog:changed', { paths: imported, legacy: true });
            return imported;
        },
    };

    window.addEventListener('beforeunload', () => {
        catalog.flush();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') catalog.flush();
    });

    App.wsdata = wsdata;
    App.catalog = catalog;
})();
