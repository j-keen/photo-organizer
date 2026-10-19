/*
 * Folder listing cache — "big folders and the library open instantly" (stale-while-revalidate).
 *
 *   App.listCache.get(dir)              → { entries, hiddenCount, sidecars, at, statAt } | null   (memory, then IndexedDB)
 *   App.listCache.list(dir, { mode })   → fresh entries; the cache (and App.index) are updated on the way.
 *        mode 'full'  — stat every file (what App.fs.list does)
 *        mode 'names' — names first: unchanged names reuse the cached size/mtime, only new names are stat'ed
 *        mode 'auto'  — 'names' when the folder is cached, else 'full' (default)
 *        The result has .statAt (when sizes/dates were last fully checked) and .stale = true when an in-app change
 *        touched the folder while it was being listed (then nothing is written; the change's reload wins).
 *   App.listCache.needsFull(dir)        → the cached sizes/dates are older than STAT_TTL (names-only checks skip them)
 *   App.listCache.diff(oldEntries, newEntries) → { added, removed, updated, count, keep: Map(path → old entry) }
 *   App.listCache.drop(dir, { recursive }), clear(), retain(folderPaths), flush()
 *   App.listCache.loadIndex() / saveIndex(snapshot)  — whole-library snapshot for App.index
 *   App.listCache.gen(dir)              — bumps on every in-app change of that folder
 *
 * Storage: IndexedDB 'fluid-identity-cache' (stores 'listings' and 'index'). Keys are `<workspace id>|<name>\n<dir>`,
 * so two workspaces never mix. A record holds compact rows [name, isDir, size, mtime] (media + folders only),
 * hiddenCount and the names of v1 memo sidecars. Writes are batched (one transaction every ~250 ms).
 * In-app changes ('fs:changed') patch the cached rows right away (rename/move/trash/copy/create/restore/modify),
 * so the next open is already right; changes made outside the app show up after the background revalidation.
 *
 * Also here: the subtle status-bar hint while a cached folder is re-checked, and the 'cache.clearListings' command.
 */
(() => {
    'use strict';
    const { path: P, h } = App.util;

    const DB_NAME = 'fluid-identity-cache';
    const STORES = ['listings', 'index'];
    const STAT_TTL = 2 * 60 * 1000; // names are re-checked on every open, sizes/dates at most every 2 minutes
    const MEM_MAX_ROWS = 250000;
    const QUICK_STAT_MAX = 400; // more unknown names than this → one full stat listing is as fast

    // ---------- IndexedDB (own DB so batch writes are one transaction) ----------
    let dbPromise = null;
    function db() {
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
                let req;
                try {
                    req = indexedDB.open(DB_NAME, 1);
                } catch (e) {
                    reject(e);
                    return;
                }
                req.onupgradeneeded = () => {
                    for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
                req.onblocked = () => reject(new Error('IndexedDB blocked'));
            });
            dbPromise.catch((e) => console.warn('[listCache] IndexedDB unavailable, memory only', e));
        }
        return dbPromise;
    }

    async function tx(store, mode, fn) {
        const d = await db();
        return new Promise((resolve, reject) => {
            const t = d.transaction(store, mode);
            const req = fn(t.objectStore(store));
            t.oncomplete = () => resolve(req && typeof req === 'object' && 'result' in req ? req.result : undefined);
            t.onerror = () => reject(t.error);
            t.onabort = () => reject(t.error);
        });
    }

    const idbGet = (store, key) => tx(store, 'readonly', (s) => s.get(key)).catch(() => undefined);
    const idbKeysFrom = (store, lower, upper) => tx(store, 'readonly', (s) => s.getAllKeys(IDBKeyRange.bound(lower, upper))).catch(() => []);

    // ---------- Keys ----------
    function wsKey() {
        const ws = App.state.workspace;
        if (!ws || !App.fs.ready) return null;
        return `${ws.id || ''}|${ws.name || ''}`;
    }
    const keyOf = (dir, ws = wsKey()) => (ws == null ? null : `${ws}\n${dir}`);
    const dirOfKey = (key) => key.slice(key.indexOf('\n') + 1);

    // ---------- Memory LRU + pending writes ----------
    const mem = new Map(); // key → record
    let memRows = 0;
    const dirty = new Map(); // key → record | null (delete), flushed in one transaction
    const flight = new Map(); // key → record | null being written right now (until its transaction completes)
    const revs = new Map(); // key → revision; a read that raced a write never installs the older record
    let flushTimer = 0;
    let flushing = Promise.resolve();

    function memSet(key, rec) {
        const old = mem.get(key);
        if (old) {
            memRows -= old.rows.length;
            mem.delete(key);
        }
        if (!rec) return;
        mem.set(key, rec);
        memRows += rec.rows.length;
        while (memRows > MEM_MAX_ROWS && mem.size > 1) {
            const [k, r] = mem.entries().next().value;
            mem.delete(k);
            memRows -= r.rows.length;
        }
    }

    function write(key, rec) {
        revs.set(key, (revs.get(key) || 0) + 1);
        memSet(key, rec);
        dirty.set(key, rec);
        if (!flushTimer) flushTimer = setTimeout(flush, 250);
    }

    function flush() {
        clearTimeout(flushTimer);
        flushTimer = 0;
        if (!dirty.size) return flushing;
        const batch = [...dirty];
        dirty.clear();
        for (const [k, v] of batch) flight.set(k, v);
        flushing = flushing
            .then(() =>
                tx('listings', 'readwrite', (s) => {
                    for (const [k, v] of batch) {
                        if (v) s.put(v, k);
                        else s.delete(k);
                    }
                }),
            )
            .catch((e) => console.warn('[listCache] write failed', e))
            .finally(() => {
                for (const [k, v] of batch) if (flight.get(k) === v) flight.delete(k);
            });
        return flushing;
    }

    async function readRecord(key) {
        if (!key) return null;
        if (mem.has(key)) {
            const r = mem.get(key);
            mem.delete(key);
            mem.set(key, r); // LRU touch
            return r;
        }
        if (dirty.has(key)) return dirty.get(key);
        if (flight.has(key)) return flight.get(key);
        const rev = revs.get(key) || 0;
        const rec = await idbGet('listings', key);
        if ((revs.get(key) || 0) !== rev) return readRecord(key); // written while we were reading: take the newer one
        if (!rec || rec.v !== 1 || !Array.isArray(rec.rows)) return null;
        memSet(key, rec);
        return rec;
    }

    /** Keys of `dir` and every cached folder below it (memory, pending and IndexedDB) */
    async function keysUnder(dir, ws = wsKey()) {
        if (ws == null) return [];
        const base = keyOf(dir, ws);
        const prefix = dir === '' ? `${ws}\n` : base + '/';
        const out = new Set();
        const take = (k) => {
            if (k === base || k.startsWith(prefix)) out.add(k);
        };
        for (const k of mem.keys()) take(k);
        for (const [k, v] of dirty) if (v) take(k);
        for (const k of await idbKeysFrom('listings', prefix, prefix + '￿')) take(k);
        if (dir !== '') {
            if (await idbGet('listings', base)) out.add(base);
        }
        for (const [k, v] of flight) if (v) take(k);
        for (const [k, v] of flight) if (!v && !dirty.get(k)) out.delete(k);
        for (const [k, v] of dirty) if (!v) out.delete(k);
        return [...out];
    }

    // ---------- Records ↔ entries ----------
    function toEntries(rec) {
        const entries = new Array(rec.rows.length);
        for (let i = 0; i < rec.rows.length; i++) {
            const r = rec.rows[i];
            entries[i] = App.fs.toEntry(rec.dir, { name: r[0], kind: r[1] ? 'dir' : 'file', size: r[1] ? undefined : r[2] ?? undefined, mtime: r[1] ? undefined : r[3] ?? undefined });
        }
        entries.hiddenCount = rec.hidden || 0;
        entries.sidecars = (rec.side || []).map((n) => P.join(rec.dir, n));
        return entries;
    }

    function toRecord(dir, entries, statAt) {
        const rows = [];
        for (const e of entries) {
            if (P.parent(e.path) !== dir) continue; // only direct children (never a flattened/recursive list)
            rows.push(e.kind === 'dir' ? [e.name, 1, null, null] : [e.name, 0, e.size ?? null, e.mtime ?? null]);
        }
        return { v: 1, dir, rows, hidden: entries.hiddenCount || 0, side: (entries.sidecars || []).map((p) => P.base(p)), at: Date.now(), chk: Date.now(), statAt: statAt || 0 };
    }

    // ---------- Generations: in-app changes make running revalidations stale ----------
    // gens: a folder's own listing changed; treeGens: a folder was moved/renamed/trashed (everything below is stale too)
    let gens = new Map();
    let treeGens = new Map();
    const gen = (dir) => {
        let n = gens.get(dir) || 0;
        for (let d = dir; ; d = P.parent(d)) {
            n += treeGens.get(d) || 0;
            if (d === '') break;
        }
        return n;
    };
    const bump = (dir) => gens.set(dir, (gens.get(dir) || 0) + 1);
    const bumpTree = (dir) => treeGens.set(dir, (treeGens.get(dir) || 0) + 1);

    // ---------- Diff ----------
    function diff(oldList, newList) {
        const old = new Map();
        for (const e of oldList || []) old.set(e.path, e);
        const keep = new Map();
        let added = 0;
        let updated = 0;
        const seen = new Set();
        for (const e of newList) {
            seen.add(e.path);
            const o = old.get(e.path);
            if (!o) added++;
            else if (o.kind !== e.kind || (e.kind !== 'dir' && (o.size !== e.size || o.mtime !== e.mtime))) updated++;
            else keep.set(e.path, o);
        }
        let removed = 0;
        for (const p of old.keys()) if (!seen.has(p)) removed++;
        return { added, removed, updated, count: added + removed + updated, keep };
    }

    async function statEntries(list) {
        const gone = new Set();
        let next = 0;
        const worker = async () => {
            while (next < list.length) {
                const e = list[next++];
                try {
                    const s = await App.fs.backend.stat(e.path);
                    e.size = s.size;
                    e.mtime = s.mtime;
                } catch (err) {
                    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) gone.add(e.path);
                    else throw err;
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(16, list.length) }, worker));
        return gone;
    }

    // ---------- Public API ----------
    const listCache = {
        STAT_TTL,
        stats: { hits: 0, misses: 0, writes: 0 },

        get enabled() {
            return !!wsKey();
        },

        gen,

        async get(dir) {
            const rec = await readRecord(keyOf(dir));
            if (!rec) {
                listCache.stats.misses++;
                return null;
            }
            listCache.stats.hits++;
            const entries = toEntries(rec);
            return { entries, hiddenCount: entries.hiddenCount, sidecars: entries.sidecars, at: rec.at, checkedAt: rec.chk || 0, statAt: rec.statAt || 0 };
        },

        async needsFull(dir) {
            const rec = await readRecord(keyOf(dir));
            return !rec || Date.now() - (rec.statAt || 0) > STAT_TTL;
        },

        put(dir, entries, { statAt = Date.now() } = {}) {
            const key = keyOf(dir);
            if (!key) return;
            listCache.stats.writes++;
            write(key, toRecord(dir, entries, statAt));
        },

        async list(dir, { mode = 'auto', sync = true } = {}) {
            const ws = wsKey();
            if (ws == null) return App.fs.list(dir);
            const key = keyOf(dir, ws);
            const g0 = gen(dir);
            const rec = mode === 'full' ? null : await readRecord(key);
            let entries;
            let statAt;
            if (!rec) {
                entries = await App.fs.list(dir);
                statAt = Date.now();
            } else {
                const raws = await App.fs.backend.list(dir, { stat: false });
                entries = App.fs.fromRaws(dir, raws);
                const known = new Map();
                for (const r of rec.rows) if (!r[1]) known.set(r[0], r);
                const unknown = [];
                let reported = true; // the backend gave sizes/dates for every file (server backend)
                for (const e of entries) {
                    if (e.kind === 'dir') continue;
                    if (e.size != null && e.mtime != null) continue;
                    reported = false;
                    const k = known.get(e.name);
                    if (k && k[2] != null) {
                        e.size = k[2];
                        e.mtime = k[3] ?? undefined;
                    } else unknown.push(e);
                }
                if (unknown.length > QUICK_STAT_MAX) {
                    entries = await App.fs.list(dir);
                    statAt = Date.now();
                } else {
                    const gone = unknown.length ? await statEntries(unknown) : null;
                    if (gone && gone.size) {
                        const kept = entries.filter((e) => !gone.has(e.path));
                        kept.hiddenCount = entries.hiddenCount;
                        kept.sidecars = entries.sidecars.filter((p) => !gone.has(p));
                        entries = kept;
                    }
                    statAt = reported ? Date.now() : rec.statAt || 0;
                }
            }
            entries.statAt = statAt;
            entries.gen = g0; // callers re-check it before applying (an in-app change may land meanwhile)
            if (gen(dir) !== g0 || wsKey() !== ws) {
                entries.stale = true;
                return entries;
            }
            write(key, toRecord(dir, entries, statAt));
            listCache.stats.writes++;
            if (sync) App.index?.syncFolder?.(dir, entries);
            return entries;
        },

        diff,

        async drop(dir, { recursive = false } = {}) {
            const keys = recursive ? await keysUnder(dir) : [keyOf(dir)].filter(Boolean);
            for (const k of keys) write(k, null);
            for (const k of keys) mem.delete(k);
        },

        /** Forget cached folders of this workspace that no longer exist (after a full library scan). */
        async retain(folders) {
            const ws = wsKey();
            if (ws == null) return;
            const keep = new Set([...folders].map((f) => keyOf(f, ws)));
            for (const k of await keysUnder('', ws)) if (!keep.has(k)) write(k, null);
        },

        /** Forget every cached listing and the library snapshot of the current workspace. */
        async clear() {
            const ws = wsKey();
            if (ws == null) return 0;
            const keys = await keysUnder('', ws);
            for (const k of keys) write(k, null);
            for (const k of keys) mem.delete(k);
            await flush();
            await tx('index', 'readwrite', (s) => s.delete(ws)).catch(() => {});
            return keys.length;
        },

        flush,

        // ----- Library index snapshot (App.index) -----
        async loadIndex() {
            const ws = wsKey();
            if (ws == null) return null;
            const snap = await idbGet('index', ws);
            if (!snap || snap.v !== 1 || !Array.isArray(snap.items) || wsKey() !== ws) return null;
            return snap;
        },

        async saveIndex(snapshot) {
            const ws = wsKey();
            if (ws == null) return;
            await tx('index', 'readwrite', (s) => s.put({ v: 1, at: Date.now(), ...snapshot }, ws)).catch((e) => console.warn('[listCache] index snapshot failed', e));
        },

        /** For tests and measurements: the raw record of a folder */
        async _record(dir) {
            return readRecord(keyOf(dir));
        },

        /** For measurements: forget the in-memory copies (the next read comes from IndexedDB) */
        async _dropMemory() {
            await flush();
            mem.clear();
            memRows = 0;
        },
    };

    // ---------- Patch cached listings after in-app changes ----------
    let chain = Promise.resolve();
    const origGet = listCache.get;
    // Reads wait for pending patches so a reload right after a change never sees the old rows
    listCache.get = async (dir) => {
        await chain;
        return origGet(dir);
    };

    let session = 0; // bumps on every workspace switch: work queued for another workspace never lands here

    /** Would a listing show this file name? (same filters as App.fs.fromRaws) */
    const listable = (name, isDir) => !App.fs.isHiddenName(name) && (isDir || App.util.mediaType(name) !== 'other');

    async function patch(change, ws, s0) {
        const alive = () => session === s0 && wsKey() === ws;
        if (ws == null || !alive()) return;
        const recs = new Map(); // dir → { rec, rows: Map(name → row) } (copies; committed at the end)
        const rec = async (dir) => {
            if (!recs.has(dir)) {
                const r = await readRecord(keyOf(dir, ws));
                recs.set(dir, r ? { rec: r, rows: new Map(r.rows.map((x) => [x[0], x])), touched: false } : null);
            }
            return recs.get(dir);
        };
        const removeRow = (r, name) => {
            const row = r.rows.get(name);
            if (!row) return null;
            r.rows.delete(name);
            r.touched = true;
            return row;
        };
        const addRow = (r, row) => {
            if (!listable(row[0], !!row[1])) {
                r.stale = true; // e.g. renamed to .txt: no row, and its hidden count is settled by the next check
                return;
            }
            r.rows.set(row[0], row);
            r.touched = true;
        };
        const unknown = [];
        const isData = (p) => App.fs.isDataPath(p);
        const type = change.type;

        // Every cached key of this workspace, read once per change (a batch of 1000 moves is one IndexedDB query)
        let allKeys = null;
        const under = async (dir) => {
            if (!allKeys) allKeys = await keysUnder('', ws);
            const base = keyOf(dir, ws);
            return allKeys.filter((k) => k === base || k.startsWith(base + '/'));
        };

        if (type === 'trash' || type === 'delete') {
            const drop = [];
            for (const p of change.paths || []) {
                if (isData(p) || p === '') continue;
                const r = await rec(P.parent(p));
                if (r) removeRow(r, P.base(p));
                drop.push(...(await under(p)));
            }
            if (!alive()) return;
            for (const k of drop) write(k, null);
        } else if ((type === 'rename' || type === 'move') && change.from && change.to) {
            // Two phases so swaps (a ↔ b) and chains work: take every source row/listing first, then place them
            const moves = [];
            for (let i = 0; i < change.from.length; i++) {
                const from = change.from[i];
                const to = change.to[i];
                if (isData(from) && isData(to)) continue;
                const r1 = isData(from) ? null : await rec(P.parent(from));
                const row = r1 ? removeRow(r1, P.base(from)) : null;
                const listings = [];
                if (!row || row[1]) {
                    // A folder moved: its cached listings (and those below) move with it
                    for (const k of await under(from)) listings.push([k, await readRecord(k)]);
                }
                moves.push({ from, to, row, listings });
            }
            const placed = [];
            for (const m of moves) {
                if (!isData(m.to)) {
                    const r2 = await rec(P.parent(m.to));
                    if (r2 && m.row) addRow(r2, [P.base(m.to), m.row[1], m.row[2], m.row[3]]);
                    else if (r2) unknown.push(m.to);
                }
                for (const [k, old] of m.listings) {
                    const nd = P.rebase(dirOfKey(k), m.from, m.to);
                    if (old && nd != null && !isData(m.to)) placed.push([keyOf(nd, ws), { ...old, dir: nd }]);
                }
            }
            if (!alive()) return;
            for (const m of moves) for (const [k] of m.listings) write(k, null);
            for (const [k, v] of placed) write(k, v);
        } else if (type === 'copy' && change.from && change.to) {
            for (let i = 0; i < change.from.length; i++) {
                const r2 = await rec(P.parent(change.to[i]));
                if (!r2) continue;
                const r1 = await rec(P.parent(change.from[i]));
                const row = r1?.rows.get(P.base(change.from[i]));
                if (row) addRow(r2, [P.base(change.to[i]), row[1], row[2], row[3]]);
                else unknown.push(change.to[i]);
            }
        } else {
            // create / restore / modify: ask the disk for the new facts
            for (const p of change.paths || []) if (!isData(p) && p !== '') unknown.push(p);
        }

        for (const p of unknown) {
            const r = await rec(P.parent(p));
            if (!r || !alive()) continue;
            try {
                const e = await App.fs.stat(p);
                if (alive()) addRow(r, e.kind === 'dir' ? [e.name, 1, null, null] : [e.name, 0, e.size ?? null, e.mtime ?? null]);
            } catch (err) {
                /* already gone again — the next revalidation settles it */
            }
        }
        if (!alive()) return;
        for (const [dir, r] of recs) {
            if (!r || !r.touched) continue;
            // stale rows (an entry that left the listing filters) make the next open re-check right away
            write(keyOf(dir, ws), { ...r.rec, rows: [...r.rows.values()], at: Date.now(), ...(r.stale ? { chk: 0 } : {}) });
        }
    }

    App.bus.on('fs:changed', (change) => {
        const ws = wsKey();
        if (!ws) return;
        const dirs = new Set(change.dirs || []);
        for (const p of change.paths || []) dirs.add(P.parent(p));
        for (const p of change.from || []) dirs.add(P.parent(p));
        for (const d of dirs) bump(d);
        // A moved/renamed/trashed folder: listings running anywhere below it are stale too
        if (change.type === 'rename' || change.type === 'move' || change.type === 'trash' || change.type === 'delete') {
            for (const p of change.from || change.paths || []) bumpTree(p);
            for (const p of change.to || []) bumpTree(p);
        }
        const s0 = session;
        chain = chain.then(() => patch(change, ws, s0)).catch((e) => console.warn('[listCache] patch failed', e));
    });

    function resetSession() {
        flush();
        mem.clear();
        memRows = 0;
        gens = new Map();
        treeGens = new Map();
        session++;
    }
    App.bus.on('workspace:opened', resetSession);
    App.bus.on('workspace:closed', resetSession);
    window.addEventListener('pagehide', () => flush());

    // ---------- Status bar: a subtle hint while a cached folder is re-checked ----------
    let sbEl = null;
    let sbTimer = 0;
    let sbHideTimer = 0;
    let checking = null;

    function sbSet(state, text) {
        if (!sbEl) return;
        clearTimeout(sbHideTimer);
        sbEl.dataset.state = state;
        sbEl.hidden = state === 'idle';
        const icon = state === 'done' ? 'check' : 'refresh';
        sbEl.querySelector('.core-sync-ico').innerHTML = App.ui.icon(icon, { size: 12 });
        sbEl.querySelector('.core-sync-text').textContent = text || '';
    }

    function ensureStatusItem() {
        if (sbEl || !App.statusbar?.addItem) return;
        sbEl = h('button', {
            class: 'sb-btn sb-pill core-sync',
            type: 'button',
            hidden: true,
            'data-tip': '저장해 둔 목록을 먼저 보여 드리고, 그사이 바뀐 게 있는지 뒤에서 확인해요 · 지금 다시 확인',
            'data-tip-keys': 'F5',
            'aria-live': 'polite',
        });
        sbEl.append(h('span', { class: 'sb-ico core-sync-ico' }), h('span', { class: 'sb-text core-sync-text' }));
        sbEl.addEventListener('click', () => App.commands.run('nav.reload'));
        App.statusbar.addItem('core-sync', sbEl, { side: 'right' });
    }

    App.bus.on('app:ready', ensureStatusItem);
    App.bus.on('folder:revalidating', ({ path }) => {
        ensureStatusItem();
        checking = path;
        clearTimeout(sbTimer);
        // Only when it takes a moment: quick checks stay invisible
        sbTimer = setTimeout(() => {
            if (checking === path) sbSet('checking', '목록 확인 중');
        }, 350);
    });
    App.bus.on('folder:revalidated', ({ path, changed, added = 0, removed = 0, updated = 0 }) => {
        if (checking !== path) return;
        checking = null;
        clearTimeout(sbTimer);
        if (!changed) {
            sbSet('idle');
            return;
        }
        const parts = [];
        if (added) parts.push(`${App.util.formatCount(added)}개 추가`);
        if (removed) parts.push(`${App.util.formatCount(removed)}개 없어짐`);
        if (updated && !added && !removed) parts.push(`${App.util.formatCount(updated)}개 바뀜`);
        sbSet('done', ['목록을 새로 고쳤어요', ...parts].join(' · '));
        sbHideTimer = setTimeout(() => sbSet('idle'), 3500);
    });
    App.bus.on('workspace:closed', () => sbSet('idle'));

    // ---------- Commands ----------
    App.commands.register({
        id: 'cache.clearListings',
        title: '폴더 목록 캐시 비우기',
        group: '일반',
        icon: 'refresh',
        when: () => App.fs.ready,
        run: async () => {
            const n = await listCache.clear();
            App.ui.toast(n ? `저장해 둔 폴더 목록 ${App.util.formatCount(n)}개를 비웠어요 · 다시 읽어 올게요` : '비울 폴더 목록이 없어요', { type: 'success' });
            await App.nav.reload();
            App.index.scan({ full: true });
        },
    });

    App.listCache = listCache;
})();
