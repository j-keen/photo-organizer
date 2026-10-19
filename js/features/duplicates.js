/*
 * Duplicate finder (App.dupes).
 *   Browser engine:
 *     exact   — group by size → sampled SHA-256 (head/middle/tail 64 KB) → full SHA-256 (streamed in chunks) to confirm
 *     similar — 64-bit pHash (32×32 DCT) computed in Blob-URL workers from createImageBitmap, BK-tree + union-find
 *     Hashes are cached in IndexedDB (path|size|mtime) so re-scans are instant.
 *   Server engine (App.server.dupes.scan, FAISS) when the local server is connected — also covers videos.
 *   Review UI: groups side by side, automatic "keep best" (resolution → size → oldest), checkboxes, compare view,
 *   one App.fs.trash call (= one undo entry) that also merges chips/rating/memo/markers into the kept file.
 *   Commands: dupes.open (Mod+Alt+D), dupes.findSimilar.
 */
(() => {
    'use strict';
    const { h, path: P, formatCount, formatBytes, formatDate, compareNames } = App.util;
    const ui = App.ui;
    const kit = App.organize.kit;
    const { icon, btn } = kit;

    // =====================================================================
    // Hash cache (IndexedDB)
    // =====================================================================
    const DB_NAME = 'fluid-identity-dupes';
    const STORE = 'hashes';
    let dbPromise = null;

    function db() {
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
                const req = indexedDB.open(DB_NAME, 1);
                req.onupgradeneeded = () => req.result.createObjectStore(STORE);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            }).catch((e) => {
                console.warn('[dupes] hash cache unavailable', e);
                return null;
            });
        }
        return dbPromise;
    }

    async function cacheGetMany(keys) {
        const out = new Map();
        const d = await db();
        if (!d || !keys.length) return out;
        return new Promise((resolve) => {
            const tx = d.transaction(STORE, 'readonly');
            const store = tx.objectStore(STORE);
            for (const k of keys) {
                const r = store.get(k);
                r.onsuccess = () => {
                    if (r.result) out.set(k, r.result);
                };
            }
            tx.oncomplete = () => resolve(out);
            tx.onerror = () => resolve(out);
            tx.onabort = () => resolve(out);
        });
    }

    async function cachePutMany(pairs) {
        const d = await db();
        if (!d || !pairs.length) return;
        await new Promise((resolve) => {
            const tx = d.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            for (const [k, v] of pairs) store.put(v, k);
            tx.oncomplete = resolve;
            tx.onerror = resolve;
            tx.onabort = resolve;
        });
    }

    const cacheKey = (e) => `${App.state.workspace?.id || ''}|${e.path}|${e.size || 0}|${e.mtime || 0}`;

    // =====================================================================
    // Perceptual hash
    // =====================================================================
    // 64-bit pHash of a 32×32 grayscale image: DCT-II, top-left 8×8, threshold at the median (DC excluded).
    function phashFromGray(gray) {
        const N = 32;
        let cos = phashFromGray.cos;
        if (!cos) {
            cos = new Float64Array(8 * N);
            for (let u = 0; u < 8; u++) for (let x = 0; x < N; x++) cos[u * N + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
            phashFromGray.cos = cos;
        }
        const tmp = new Float64Array(8 * N);
        for (let u = 0; u < 8; u++) {
            for (let x = 0; x < N; x++) {
                let s = 0;
                for (let y = 0; y < N; y++) s += cos[u * N + y] * gray[y * N + x];
                tmp[u * N + x] = s;
            }
        }
        const coef = new Float64Array(64);
        for (let u = 0; u < 8; u++) {
            for (let v = 0; v < 8; v++) {
                let s = 0;
                for (let x = 0; x < N; x++) s += cos[v * N + x] * tmp[u * N + x];
                coef[u * 8 + v] = s;
            }
        }
        const vals = Array.prototype.slice.call(coef, 1).sort((a, b) => a - b);
        const med = vals[31];
        let hi = 0;
        let lo = 0;
        for (let i = 0; i < 64; i++) {
            const bit = coef[i] > med ? 1 : 0;
            if (i < 32) hi = ((hi << 1) | bit) >>> 0;
            else lo = ((lo << 1) | bit) >>> 0;
        }
        return [hi >>> 0, lo >>> 0];
    }

    // 32×32 grayscale for the pHash + average colour of the four quadrants (12 values). pHash only sees
    // structure, so two flat pictures with the same layout but different colours would match; the colour
    // signature rules those out while resized/re-saved copies stay within a few levels.
    async function analyzeBlob(file) {
        const bmp = await createImageBitmap(file, { resizeWidth: 32, resizeHeight: 32, resizeQuality: 'high' });
        const c = new OffscreenCanvas(32, 32);
        const g = c.getContext('2d', { willReadFrequently: true });
        g.fillStyle = '#fff';
        g.fillRect(0, 0, 32, 32);
        g.drawImage(bmp, 0, 0, 32, 32);
        bmp.close();
        const d = g.getImageData(0, 0, 32, 32).data;
        const gray = new Float64Array(1024);
        const color = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        for (let y = 0; y < 32; y++) {
            for (let x = 0; x < 32; x++) {
                const i = y * 32 + x;
                const r = d[i * 4];
                const gr = d[i * 4 + 1];
                const b = d[i * 4 + 2];
                gray[i] = 0.299 * r + 0.587 * gr + 0.114 * b;
                const q = ((y < 16 ? 0 : 2) + (x < 16 ? 0 : 1)) * 3;
                color[q] += r;
                color[q + 1] += gr;
                color[q + 2] += b;
            }
        }
        for (let k = 0; k < 12; k++) color[k] = Math.round(color[k] / 256);
        return { gray, color };
    }

    // Worker body: gets the two functions above injected as source.
    function workerMain(phash, analyze) {
        self.onmessage = async (e) => {
            const { id, file } = e.data;
            try {
                const { gray, color } = await analyze(file);
                const [hi, lo] = phash(gray);
                self.postMessage({ id, hi, lo, color });
            } catch (err) {
                self.postMessage({ id, error: String((err && err.message) || err) });
            }
        };
    }

    class HashPool {
        constructor(size) {
            this.queue = [];
            this.pending = new Map();
            this.idle = [];
            this.workers = [];
            this.seq = 0;
            this.mainThread = false;
            try {
                const src = `(${workerMain})(${phashFromGray}, ${analyzeBlob});`;
                this.url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
                for (let i = 0; i < size; i++) {
                    const w = new Worker(this.url);
                    w.onmessage = (e) => this.done(w, e.data);
                    w.onerror = (e) => {
                        e.preventDefault?.();
                        this.fail(w);
                    };
                    this.workers.push(w);
                    this.idle.push(w);
                }
            } catch (e) {
                console.info('[dupes] workers unavailable, hashing on the main thread', e);
                this.mainThread = true;
            }
        }

        hash(file) {
            if (this.mainThread) {
                return analyzeBlob(file)
                    .then(({ gray, color }) => ({ hl: phashFromGray(gray), color }))
                    .catch(() => null);
            }
            return new Promise((resolve) => {
                this.queue.push({ id: ++this.seq, file, resolve });
                this.pump();
            });
        }

        pump() {
            while (this.idle.length && this.queue.length) {
                const w = this.idle.pop();
                const t = this.queue.shift();
                this.pending.set(t.id, { t, w });
                w.postMessage({ id: t.id, file: t.file });
            }
        }

        done(w, data) {
            const p = this.pending.get(data.id);
            this.pending.delete(data.id);
            this.idle.push(w);
            if (p) p.t.resolve(data.error ? null : { hl: [data.hi >>> 0, data.lo >>> 0], color: data.color });
            this.pump();
        }

        fail(w) {
            for (const [id, p] of this.pending) {
                if (p.w !== w) continue;
                this.pending.delete(id);
                p.t.resolve(null);
            }
            if (!this.idle.includes(w)) this.idle.push(w);
            this.pump();
        }

        destroy() {
            for (const w of this.workers) w.terminate();
            for (const t of this.queue) t.resolve(null);
            for (const { t } of this.pending.values()) t.resolve(null);
            this.queue = [];
            this.pending.clear();
            if (this.url) URL.revokeObjectURL(this.url);
        }
    }

    function pop32(x) {
        x = x - ((x >>> 1) & 0x55555555);
        x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
        return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
    }

    function hamming(a, b) {
        return pop32((a[0] ^ b[0]) >>> 0) + pop32((a[1] ^ b[1]) >>> 0);
    }

    const hashHex = (hl) => hl[0].toString(16).padStart(8, '0') + hl[1].toString(16).padStart(8, '0');
    const hexHash = (s) => [parseInt(s.slice(0, 8), 16) >>> 0, parseInt(s.slice(8, 16), 16) >>> 0];
    const colorHex = (c) => c.map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('');
    const hexColor = (s) => (s && s.length === 24 ? Array.from({ length: 12 }, (_, i) => parseInt(s.slice(i * 2, i * 2 + 2), 16)) : null);

    /** Largest per-channel difference between two quadrant colour signatures (0..255). */
    function colorDistance(a, b) {
        if (!a || !b) return 0;
        let m = 0;
        for (let k = 0; k < 12; k++) m = Math.max(m, Math.abs(a[k] - b[k]));
        return m;
    }

    class BKTree {
        constructor() {
            this.root = null;
        }
        add(hash, idx) {
            const node = { hash, items: [idx], kids: new Map() };
            if (!this.root) {
                this.root = node;
                return;
            }
            let cur = this.root;
            for (;;) {
                const d = hamming(hash, cur.hash);
                if (d === 0) {
                    cur.items.push(idx);
                    return;
                }
                const next = cur.kids.get(d);
                if (!next) {
                    cur.kids.set(d, node);
                    return;
                }
                cur = next;
            }
        }
        query(hash, t, cb) {
            if (!this.root) return;
            const stack = [this.root];
            while (stack.length) {
                const n = stack.pop();
                const d = hamming(hash, n.hash);
                if (d <= t) for (const i of n.items) cb(i, d);
                for (const [k, child] of n.kids) if (k >= d - t && k <= d + t) stack.push(child);
            }
        }
    }

    class UnionFind {
        constructor(n) {
            this.p = new Int32Array(n);
            for (let i = 0; i < n; i++) this.p[i] = i;
        }
        find(x) {
            while (this.p[x] !== x) {
                this.p[x] = this.p[this.p[x]];
                x = this.p[x];
            }
            return x;
        }
        union(a, b) {
            const ra = this.find(a);
            const rb = this.find(b);
            if (ra !== rb) this.p[rb] = ra;
        }
    }

    // =====================================================================
    // Scan (browser engine)
    // =====================================================================
    function cancelledError() {
        return Object.assign(new Error('cancelled'), { cancelled: true });
    }

    /**
     * scan(entries, { mode: 'exact'|'similar', threshold, focus, onProgress(phase, done, total), isCancelled })
     * -> { groups: [{ id, kind: 'exact'|'similar', items: [item] }], scanned, engine: 'browser' }
     * item = { entry, path, size, mtime, w, h, duration, hash, phash, distance }
     */
    async function scanBrowser(entries, opts = {}) {
        const mode = opts.mode || 'exact';
        const threshold = opts.threshold ?? 8;
        const progress = opts.onProgress || (() => {});
        const isCancelled = opts.isCancelled || (() => false);
        const check = () => {
            if (isCancelled()) throw cancelledError();
        };
        const files = entries.filter((e) => e.kind === 'file' && (e.size || 0) > 0 && (e.type === 'image' || e.type === 'video'));
        const focus = opts.focus || null;
        progress('prepare', 0, files.length);
        const cache = await cacheGetMany(files.map(cacheKey));
        const fresh = new Map();
        const rec = (e) => {
            const k = cacheKey(e);
            let v = fresh.get(k);
            if (!v) {
                v = { ...(cache.get(k) || {}) };
                fresh.set(k, v);
            }
            return v;
        };
        const dirty = new Set();
        const flush = async () => {
            const pairs = [...dirty].map((k) => [k, fresh.get(k)]);
            dirty.clear();
            await cachePutMany(pairs);
        };
        const mark = (e) => dirty.add(cacheKey(e));

        // ---- exact: size → sample → full ----
        const exactKey = new Map(); // path -> content key
        let bySize = kit.groupBy(files, (e) => e.size);
        let candidates = [];
        for (const [size, list] of bySize) {
            if (list.length < 2) continue;
            if (focus && !list.some((e) => e.path === focus)) continue;
            candidates.push(...list);
        }
        bySize = null;
        let done = 0;
        progress('sample', 0, candidates.length);
        await App.util.pool(candidates, 4, async (e) => {
            check();
            const r = rec(e);
            if (!r.s) {
                try {
                    const s = await kit.sampleHash(await App.fs.getFile(e.path));
                    r.s = s.hash;
                    if (s.full) r.f = s.hash;
                    mark(e);
                } catch (err) {
                    r.s = null;
                }
            }
            progress('sample', ++done, candidates.length);
        });
        check();
        const bySample = kit.groupBy(candidates.filter((e) => rec(e).s), (e) => `${e.size}|${rec(e).s}`);
        const needFull = [];
        for (const list of bySample.values()) if (list.length > 1) for (const e of list) if (!rec(e).f) needFull.push(e);
        done = 0;
        progress('full', 0, needFull.length);
        await App.util.pool(needFull, 2, async (e) => {
            check();
            try {
                rec(e).f = await kit.fullHash(await App.fs.getFile(e.path), { isCancelled });
                mark(e);
            } catch (err) {
                if (err.cancelled) throw err;
            }
            progress('full', ++done, needFull.length);
        });
        check();
        for (const list of bySample.values()) {
            if (list.length < 2) continue;
            for (const e of list) if (rec(e).f) exactKey.set(e.path, `${e.size}|${rec(e).f}`);
        }
        await flush();

        // ---- similar images: pHash + BK-tree ----
        const simEdges = [];
        const images = mode === 'similar' ? files.filter((e) => e.type === 'image' && App.util.browserCanDecode(e.name)) : [];
        if (images.length) {
            const need = images.filter((e) => !rec(e).p || (rec(e).p !== '-' && !rec(e).c));
            done = 0;
            progress('phash', 0, need.length);
            const pool = new HashPool(Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2))));
            try {
                let lastFlush = Date.now();
                await App.util.pool(need, 8, async (e) => {
                    check();
                    let res = null;
                    try {
                        res = await pool.hash(await App.fs.getFile(e.path));
                    } catch (err) {
                        res = null;
                    }
                    const r = rec(e);
                    r.p = res ? hashHex(res.hl) : '-';
                    r.c = res && res.color ? colorHex(res.color) : null;
                    mark(e);
                    progress('phash', ++done, need.length);
                    if (Date.now() - lastFlush > 4000) {
                        lastFlush = Date.now();
                        flush();
                    }
                });
            } finally {
                pool.destroy();
            }
            await flush();
            check();
            progress('compare', 0, images.length);
            const hashed = images.filter((e) => rec(e).p && rec(e).p !== '-');
            const tree = new BKTree();
            const hashes = hashed.map((e) => hexHash(rec(e).p));
            const colors = hashed.map((e) => hexColor(rec(e).c));
            const colorTol = 18 + threshold * 2;
            const close = (i, j) => colorDistance(colors[i], colors[j]) <= colorTol;
            hashes.forEach((hl, i) => tree.add(hl, i));
            if (focus) {
                const fi = hashed.findIndex((e) => e.path === focus);
                if (fi >= 0) tree.query(hashes[fi], threshold, (j, d) => j !== fi && close(fi, j) && simEdges.push([hashed[fi].path, hashed[j].path, d]));
            } else {
                for (let i = 0; i < hashed.length; i++) {
                    if (i % 500 === 0) {
                        check();
                        progress('compare', i, hashed.length);
                        await App.util.sleep(0);
                    }
                    tree.query(hashes[i], threshold, (j, d) => {
                        if (j > i && close(i, j)) simEdges.push([hashed[i].path, hashed[j].path, d]);
                    });
                }
            }
        }

        // ---- groups: union exact keys + similar edges ----
        const paths = [];
        const index = new Map();
        const idOf = (p) => {
            if (!index.has(p)) {
                index.set(p, paths.length);
                paths.push(p);
            }
            return index.get(p);
        };
        const byKey = kit.groupBy([...exactKey.entries()], ([, k]) => k);
        const pairs = [];
        for (const list of byKey.values()) if (list.length > 1) for (let i = 1; i < list.length; i++) pairs.push([list[0][0], list[i][0]]);
        for (const [a, b] of simEdges) pairs.push([a, b]);
        for (const [a, b] of pairs) {
            idOf(a);
            idOf(b);
        }
        const uf = new UnionFind(paths.length);
        for (const [a, b] of pairs) uf.union(index.get(a), index.get(b));
        const entryByPath = new Map(files.map((e) => [e.path, e]));
        const buckets = kit.groupBy(paths, (p) => uf.find(index.get(p)));
        let groups = [];
        let gid = 0;
        for (const members of buckets.values()) {
            if (members.length < 2) continue;
            if (focus && !members.includes(focus)) continue;
            const items = members.map((p) => {
                const e = entryByPath.get(p);
                const r = rec(e);
                return { entry: e, path: p, size: e.size, mtime: e.mtime, hash: r.f || r.s || null, phash: r.p && r.p !== '-' ? r.p : null, contentKey: exactKey.get(p) || null };
            });
            const keys = new Set(items.map((i) => i.contentKey));
            const kind = keys.size === 1 && !keys.has(null) ? 'exact' : 'similar';
            groups.push({ id: `g${++gid}`, kind, items });
        }
        if (focus && groups.length > 1) {
            // focus search: one group around the focused file
            const items = [];
            const seen = new Set();
            for (const g of groups) for (const it of g.items) if (!seen.has(it.path)) {
                seen.add(it.path);
                items.push(it);
            }
            groups = [{ id: 'g1', kind: 'similar', items }];
        }
        return { groups, scanned: files.length, engine: 'browser' };
    }

    /** Fill w/h/duration for the items of groups (cheap header probes, cached in the catalog). */
    async function enrich(groups, { onProgress, isCancelled } = {}) {
        const all = groups.flatMap((g) => g.items).filter((it) => !it.w);
        let done = 0;
        await App.util.pool(all, 6, async (it) => {
            if (isCancelled && isCancelled()) return;
            const info = await kit.mediaInfo(it.entry);
            if (info) {
                it.w = info.w;
                it.h = info.h;
                if (info.duration) it.duration = info.duration;
            }
            onProgress && onProgress(++done, all.length);
        });
    }

    // =====================================================================
    // Scan (server engine)
    // =====================================================================
    function serverAvailable() {
        return !!(App.server && App.server.available && App.server.dupes && typeof App.server.dupes.scan === 'function');
    }

    async function scanServer({ dirs, mode, threshold, onProgress, isCancelled }) {
        const body = { mode: mode === 'exact' ? 'exact' : 'both', threshold, videos: true };
        if (dirs) body.dirs = dirs;
        const relay = (p, msg) => onProgress && onProgress('server', typeof p === 'number' ? Math.round(p * 1000) : 0, 1000, msg);
        let res = await App.server.dupes.scan(body, { onProgress: relay });
        if (isCancelled && isCancelled()) throw cancelledError();
        if (res && !Array.isArray(res.groups)) {
            const id = res.id || res.jobId || (res.job && res.job.id);
            if (id && typeof App.server.waitJob === 'function') res = await App.server.waitJob(id, relay);
            if (res && res.result) res = res.result;
        }
        if (isCancelled && isCancelled()) throw cancelledError();
        const groups = [];
        let gid = 0;
        for (const g of (res && res.groups) || []) {
            const items = [];
            for (const it of g.items || []) {
                const p = it.path;
                const e = App.index?.get(p) || { path: p, name: P.base(p), kind: 'file', type: App.util.mediaType(p), ext: P.ext(p), size: it.size, mtime: it.mtime };
                items.push({ entry: e, path: p, size: it.size ?? e.size, mtime: it.mtime ?? e.mtime, w: it.width, h: it.height, duration: it.duration, distance: it.distance, hash: null, phash: null, contentKey: g.kind === 'exact' ? `x${gid}` : null });
            }
            if (items.length > 1) groups.push({ id: `s${++gid}`, kind: g.kind === 'exact' ? 'exact' : 'similar', items });
        }
        return { groups, scanned: (res && res.stats && (res.stats.files || res.stats.scanned)) || null, engine: 'server' };
    }

    // =====================================================================
    // Keep-best & strategies
    // =====================================================================
    function bestFirst(a, b) {
        return ((b.w || 0) * (b.h || 0) - (a.w || 0) * (a.h || 0)) ||
            ((b.size || 0) - (a.size || 0)) ||
            ((a.mtime || Infinity) - (b.mtime || Infinity)) ||
            (a.path.length - b.path.length) ||
            compareNames(a.path, b.path);
    }

    const STRATEGIES = {
        best: { label: '가장 좋은 것 남기기', why: '해상도 → 용량 → 오래된 순으로 골랐어요', cmp: bestFirst },
        oldest: { label: '가장 오래된 것 남기기', why: '가장 먼저 만들어진 파일을 남겨요', cmp: (a, b) => (a.mtime || Infinity) - (b.mtime || Infinity) || bestFirst(a, b) },
        newest: { label: '가장 최근 것 남기기', why: '가장 최근에 수정된 파일을 남겨요', cmp: (a, b) => (b.mtime || 0) - (a.mtime || 0) || bestFirst(a, b) },
        shortest: { label: '경로가 짧은 것 남기기', why: '얕은 폴더에 있는 파일을 남겨요', cmp: (a, b) => a.path.split('/').length - b.path.split('/').length || bestFirst(a, b) },
    };

    function applyStrategy(groups, key, preferDir) {
        const s = STRATEGIES[key] || STRATEGIES.best;
        for (const g of groups) {
            const sorted = g.items.slice().sort((a, b) => {
                if (preferDir != null) {
                    const ia = P.isInside(a.path, preferDir) && a.path !== preferDir ? 0 : 1;
                    const ib = P.isInside(b.path, preferDir) && b.path !== preferDir ? 0 : 1;
                    if (ia !== ib) return ia - ib;
                }
                return s.cmp(a, b);
            });
            g.keep = sorted[0].path;
            g.remove = new Set(g.items.filter((i) => i.path !== g.keep).map((i) => i.path));
        }
    }

    // =====================================================================
    // Metadata merge (copies → keeper), part of the same undo entry as the trash
    // =====================================================================
    const MERGE_KEYS = ['chips', 'rating', 'memo', 'markers', 'label', 'legacyTags', 'legacyImported'];

    function mergedPatch(keeper, donors) {
        const k = App.catalog.peek(keeper) || {};
        const ds = donors.map((p) => App.catalog.peek(p)).filter(Boolean);
        if (!ds.length) return null;
        const patch = {};
        const chips = [...(k.chips || [])];
        for (const d of ds) for (const c of d.chips || []) if (!chips.includes(c)) chips.push(c);
        if (chips.length !== (k.chips || []).length) patch.chips = chips;
        const rating = Math.max(k.rating || 0, ...ds.map((d) => d.rating || 0));
        if (rating !== (k.rating || 0)) patch.rating = rating;
        const memos = [];
        for (const m of [k.memo, ...ds.map((d) => d.memo)]) {
            const t = (m || '').trim();
            if (t && !memos.some((x) => x === t || x.includes(t))) memos.push(t);
        }
        const memo = memos.join('\n\n');
        if (memo !== (k.memo || '').trim() && memo) patch.memo = memo;
        const markers = [...(k.markers || [])];
        const sig = (m) => `${Math.round((m.t || 0) * 10)}|${m.title || ''}`;
        const seen = new Set(markers.map(sig));
        const ids = new Set(markers.map((m) => m.id));
        for (const d of ds) {
            for (const m of d.markers || []) {
                if (seen.has(sig(m))) continue;
                seen.add(sig(m));
                const copy = { ...m };
                if (!copy.id || ids.has(copy.id)) copy.id = App.util.uid('m');
                ids.add(copy.id);
                markers.push(copy);
            }
        }
        if (markers.length !== (k.markers || []).length) patch.markers = markers;
        if (!k.label) {
            const label = ds.map((d) => d.label).find(Boolean);
            if (label) patch.label = label;
        }
        const tags = [...(k.legacyTags || [])];
        for (const d of ds) for (const t of d.legacyTags || []) if (!tags.includes(t)) tags.push(t);
        if (tags.length !== (k.legacyTags || []).length) {
            patch.legacyTags = tags;
            patch.legacyImported = true;
        }
        return Object.keys(patch).length ? patch : null;
    }

    function snapshot(p) {
        const e = App.catalog.peek(p);
        if (!e) return null;
        const out = {};
        for (const key of MERGE_KEYS) if (e[key] !== undefined) out[key] = JSON.parse(JSON.stringify(e[key]));
        return out;
    }

    function restoreSnapshot(p, snap) {
        App.catalog.update(p, (e) => {
            for (const key of MERGE_KEYS) {
                if (snap && snap[key] !== undefined) e[key] = snap[key];
                else delete e[key];
            }
        }, { undoable: false });
    }

    async function withJob(title, total, fn) {
        const job = App.jobs.start({ title, total, cancellable: false });
        try {
            return await fn(job);
        } finally {
            job.finish();
        }
    }

    async function runCleanup(plan, { merge, job }) {
        const snaps = new Map();
        let merged = 0;
        if (merge) {
            for (const g of plan) {
                const patch = mergedPatch(g.keep, g.remove);
                if (!patch) continue;
                if (!snaps.has(g.keep)) snaps.set(g.keep, snapshot(g.keep));
                App.catalog.update(g.keep, (e) => Object.assign(e, patch), { undoable: false });
                merged++;
            }
        }
        const paths = [];
        for (const g of plan) for (const p of g.remove) if (await App.fs.exists(p)) paths.push(p);
        const res = await kit.trashPaths(paths, { job, onProgress: (n, t) => job?.update(n, { total: t, detail: `${formatCount(n)} / ${formatCount(t)}` }) });
        return { snaps, merged, ids: res.ids, paths: res.paths, failed: res.failed, cancelled: res.cancelled };
    }

    /**
     * Soft-delete the chosen copies as ONE undo entry; their chips/rating/memo/markers are merged into the keeper
     * inside the same entry (one Ctrl+Z brings back the files AND the keeper's previous metadata).
     * plan: [{ keep, remove: [paths] }]  -> { trashed, ids, merged, failed, cancelled }
     */
    async function trashDuplicates(plan, { merge = true } = {}) {
        const total = plan.reduce((s, g) => s + g.remove.length, 0);
        const job = App.jobs.start({ title: '복제본 정리 중', total, cancellable: true });
        let state;
        try {
            state = await runCleanup(plan, { merge, job });
        } finally {
            job.finish();
        }
        if (!state.ids.length && !state.merged) return { trashed: 0, ids: [], merged: 0, failed: state.failed, cancelled: state.cancelled };
        const done = new Set(state.paths);
        const live = plan.map((g) => ({ keep: g.keep, remove: g.remove.filter((p) => done.has(p)) })).filter((g) => g.remove.length);
        const first = state;
        App.undo.push({
            label: `복제본 ${formatCount(state.ids.length)}개 정리`,
            undo: async () => {
                const back = await kit.restoreIds(state.ids);
                // keep the plan pointing at wherever the copies came back to, so redo works
                for (const g of live) g.remove = g.remove.map((p) => back.get(p) || p);
                for (const [p, snap] of state.snaps) restoreSnapshot(p, snap);
            },
            redo: async () => {
                state = await withJob('복제본 정리 중', live.reduce((s, g) => s + g.remove.length, 0), (j) => runCleanup(live, { merge, job: j }));
            },
        });
        return { trashed: first.ids.length, ids: first.ids, merged: first.merged, failed: first.failed, cancelled: first.cancelled };
    }

    // =====================================================================
    // Ignore list ("이건 중복 아님"), workspace-level, undoable
    // =====================================================================
    const memberSig = (it) => `${it.size || 0}:${it.hash || it.phash || P.base(it.path)}`;
    const sigKey = (sigs) => sigs.slice().sort().join('\n');

    async function readIgnore() {
        const data = await App.wsdata.read('dupes-ignore', null);
        return data && Array.isArray(data.groups) ? data : { version: 1, groups: [] };
    }

    async function loadIgnored() {
        return (await readIgnore()).groups.map((g) => new Set(g));
    }

    async function setIgnored(sigs, hide) {
        const data = await readIgnore();
        const key = sigKey(sigs);
        if (hide) {
            data.groups = data.groups.filter((g) => sigKey(g) !== key);
            data.groups.push(sigs);
            if (data.groups.length > 5000) data.groups = data.groups.slice(-5000);
        } else {
            // drop every entry that covers this group, otherwise it would stay hidden
            data.groups = data.groups.filter((g) => {
                const s = new Set(g);
                return !sigs.every((x) => s.has(x));
            });
        }
        await App.wsdata.write('dupes-ignore', data);
        App.bus.emit('dupes:ignore', { sigs, hidden: hide });
    }

    function isIgnored(group, ignored) {
        const sigs = group.sigs || group.items.map(memberSig);
        return ignored.some((set) => sigs.every((s) => set.has(s)));
    }

    /** Hide (or show again) a group in future scans — one undo entry. */
    async function ignoreGroup(group, hide = true) {
        const sigs = group.sigs || group.items.map(memberSig);
        await setIgnored(sigs, hide);
        App.undo.push({
            label: hide ? '중복 아님으로 표시' : '숨긴 중복 다시 보기',
            undo: () => setIgnored(sigs, !hide),
            redo: () => setIgnored(sigs, hide),
        });
    }

    // =====================================================================
    // Collect entries for a scope
    // =====================================================================
    async function collect(scope, { includeSub = true, paths = null, waitIndex } = {}) {
        const needIndex = async () => {
            if (!App.index.ready) {
                waitIndex && waitIndex();
                await App.index.whenReady();
            }
        };
        if (paths) return kit.entriesFor(paths);
        if (scope === 'selection') {
            const sel = App.select.entries();
            const files = sel.filter((e) => e.kind === 'file');
            const dirs = sel.filter((e) => e.kind === 'dir');
            if (dirs.length) {
                await needIndex();
                const seen = new Set(files.map((e) => e.path));
                for (const d of dirs) for (const e of App.index.under(d.path)) if (!seen.has(e.path)) {
                    seen.add(e.path);
                    files.push(e);
                }
            }
            return files;
        }
        if (scope === 'folder') {
            const cwd = App.state.cwd ?? '';
            if (includeSub) {
                await needIndex();
                return App.index.under(cwd, { recursive: true });
            }
            return (await App.fs.list(cwd)).filter((e) => e.kind === 'file');
        }
        await needIndex();
        return App.index.items;
    }

    // =====================================================================
    // Panel
    // =====================================================================
    const PHASES = {
        wait: '라이브러리 색인이 끝나기를 기다리는 중',
        prepare: '파일 목록을 준비하는 중',
        sample: '크기가 같은 파일을 비교하는 중',
        full: '내용이 같은지 끝까지 확인하는 중',
        phash: '사진의 생김새를 분석하는 중',
        compare: '비슷한 사진을 짝짓는 중',
        enrich: '해상도를 확인하는 중',
        server: '로컬 서버에서 찾는 중',
    };

    function thresholdLabel(t) {
        if (t <= 3) return '거의 같은 것만';
        if (t <= 7) return '조금 엄격하게';
        if (t <= 11) return '보통';
        if (t <= 15) return '느슨하게';
        return '아주 느슨하게';
    }

    /** true if p or one of its ancestor folders is in set */
    function hitsAny(p, set) {
        for (let q = p; ; q = P.parent(q)) {
            if (set.has(q)) return true;
            if (!q) return false;
        }
    }

    function open(args = {}) {
        if (!App.fs.ready) return null;
        const saved = App.settings.get('dupes.options', {});
        const opts = {
            scope: args.scope || (App.select.count > 1 ? 'selection' : saved.scope && saved.scope !== 'selection' ? saved.scope : 'folder'),
            includeSub: args.includeSub ?? saved.includeSub ?? true,
            mode: args.mode || saved.mode || 'exact',
            threshold: args.threshold ?? saved.threshold ?? 8,
            useServer: args.useServer ?? saved.useServer ?? true,
            merge: saved.merge ?? true,
            focus: args.focus || null,
            paths: args.paths || null,
        };
        if (opts.scope === 'selection' && !App.select.count && !opts.paths) opts.scope = 'folder';

        return kit.panel({
            title: opts.focus ? '비슷한 항목 찾기' : '중복 찾기',
            subtitle: opts.focus ? P.base(opts.focus) : '똑같은 파일이나 비슷한 사진을 찾아서 한 번에 정리해요',
            icon: 'layers',
            width: 1120,
            height: 'min(800px, calc(100vh - 48px))',
            className: 'dup-panel',
            undoKeys: true,
            build(ctx) {
                let job = null;
                let cancelled = false;
                let result = null;
                let groups = []; // every group of the scan; items never leave a group, they are only "gone"
                let shown = [];
                let filter = 'all';
                let sortKey = 'savings';
                let strategy = 'best';
                let preferDir = null;
                let showHidden = false;
                let acted = false;
                let view = 'setup'; // setup | scan | list | empty
                let focusG = 0;
                let focusI = 0;
                let compareClose = null;
                let list = null;
                let summaryEl;
                let trashBtn;
                let footInfo;
                let filterSeg;
                let hiddenBtn;
                const gone = new Set(); // paths trashed/removed since the scan (kept in sync from fs:changed)

                const alive = (g) => g.items.filter((i) => !gone.has(i.path));
                const active = (g) => !g.hidden && alive(g).length > 1;
                const isVisible = (g) => alive(g).length > 1 && (!g.hidden || showHidden);
                const removing = (g) => (g.hidden ? [] : alive(g).filter((i) => i.path !== g.keep && g.remove.has(i.path)));
                const wasted = (g) => removing(g).reduce((s, i) => s + (i.size || 0), 0);
                const potential = (g) => {
                    const a = alive(g);
                    return a.length < 2 ? 0 : a.reduce((s, i) => s + (i.size || 0), 0) - Math.max(...a.map((i) => i.size || 0));
                };

                ctx.onClose(() => {
                    if (job && job.state === 'running') job.cancel();
                    compareClose?.();
                    list?.destroy();
                });

                // ---------------- setup ----------------
                function showSetup() {
                    view = 'setup';
                    list?.destroy();
                    list = null;
                    ctx.main.innerHTML = '';
                    ctx.foot.innerHTML = '';
                    ctx.setSubtitle(opts.focus ? P.base(opts.focus) : '똑같은 파일이나 비슷한 사진을 찾아서 한 번에 정리해요');
                    const selCount = App.select.count;
                    const scopeSeg = kit.seg([
                        { value: 'selection', label: `선택한 항목${selCount ? ` ${formatCount(selCount)}개` : ''}`, icon: 'check' },
                        { value: 'folder', label: `${kit.folderLabel(App.state.cwd ?? '')} 폴더`, icon: 'folder' },
                        { value: 'workspace', label: '작업 폴더 전체', icon: 'home' },
                    ], opts.scope, (v) => {
                        opts.scope = v;
                        subT.el.hidden = v !== 'folder';
                    }, { size: 'lg' });
                    scopeSeg.disable('selection', !selCount && !opts.paths);
                    const subT = kit.toggle('하위 폴더까지 함께 찾기', opts.includeSub, (v) => (opts.includeSub = v));
                    subT.el.hidden = opts.scope !== 'folder';

                    const modeCard = (value, title, desc, iconName) => {
                        const b = h('button', { type: 'button', class: `dup-mode${opts.mode === value ? ' on' : ''}`, role: 'radio', 'aria-checked': String(opts.mode === value), dataset: { mode: value } },
                            h('span', { class: 'dup-mode-ico', html: icon(iconName, 20) }),
                            h('span', { class: 'dup-mode-text' }, h('span', { class: 'dup-mode-title', text: title }), h('span', { class: 'dup-mode-desc', text: desc })),
                            h('span', { class: 'dup-mode-radio' }));
                        b.addEventListener('click', () => {
                            opts.mode = value;
                            for (const x of modes.children) {
                                x.classList.toggle('on', x.dataset.mode === value);
                                x.setAttribute('aria-checked', String(x.dataset.mode === value));
                            }
                            thr.hidden = value !== 'similar';
                        });
                        return b;
                    };
                    const modes = h('div', { class: 'dup-modes', role: 'radiogroup' },
                        modeCard('exact', '똑같은 파일', '이름이 달라도 내용이 완전히 같은 사진·영상을 찾아요', 'copy'),
                        modeCard('similar', '비슷한 사진까지', '크기를 줄였거나 다시 저장한 사진처럼 거의 같은 것도 찾아요', 'sparkles'));
                    const range = h('input', { type: 'range', min: '0', max: '20', step: '1', value: String(opts.threshold), class: 'dup-range', 'aria-label': '비슷한 정도' });
                    const rangeLabel = h('span', { class: 'dup-range-label' });
                    const syncRange = () => {
                        rangeLabel.textContent = `${thresholdLabel(+range.value)} · ${range.value}`;
                    };
                    range.addEventListener('input', () => {
                        opts.threshold = +range.value;
                        syncRange();
                    });
                    syncRange();
                    const thr = h('div', { class: 'dup-threshold' }, h('span', { class: 'faint', text: '엄격하게' }), range, h('span', { class: 'faint', text: '느슨하게' }), rangeLabel);
                    thr.hidden = opts.mode !== 'similar';

                    let serverRow;
                    if (serverAvailable()) {
                        const t = kit.toggle('로컬 서버로 찾기 (FAISS)', opts.useServer, (v) => (opts.useServer = v), { hint: '영상의 비슷한 장면까지 빠르게 찾아요' });
                        serverRow = h('div', { class: 'dup-server on' }, h('span', { class: 'dup-server-ico', html: icon('server', 16) }), t.el);
                    } else {
                        serverRow = h('div', { class: 'dup-server' }, h('span', { class: 'dup-server-ico', html: icon('server', 16) }), h('span', { text: '로컬 서버를 켜면 영상의 비슷한 장면까지 찾을 수 있어요. 지금은 브라우저에서 찾아요.' }));
                    }

                    const tip = (iconName, text) => h('li', null, h('span', { html: icon(iconName, 14) }), h('span', { text }));
                    ctx.main.append(h('div', { class: 'dup-setup' },
                        h('div', { class: 'dup-step' }, h('div', { class: 'dup-step-title', text: '어디에서 찾을까요?' }), scopeSeg.el, subT.el),
                        h('div', { class: 'dup-step' }, h('div', { class: 'dup-step-title', text: '무엇을 찾을까요?' }), modes, thr),
                        serverRow,
                        h('ul', { class: 'dup-tips' },
                            tip('sparkles', '남길 파일은 해상도 → 용량 → 오래된 순으로 알아서 골라 둬요'),
                            tip('tag', '지우는 복제본의 칩·별점·메모·마커는 남기는 파일로 합쳐요'),
                            tip('undo', '모두 휴지통을 거치고, Ctrl+Z 한 번으로 전부 되돌릴 수 있어요'),
                            tip('zap', '한 번 분석한 파일은 기억해 둬서 다음에는 훨씬 빨라요'))));
                    const start = btn({ label: '찾기 시작', kind: 'primary', icon: 'search', onClick: () => startScan() });
                    ctx.foot.append(h('div', { class: 'org-foot-info', text: '찾은 결과는 확인한 뒤에 정리해요. 아무것도 자동으로 지우지 않아요.' }), btn({ label: '취소', kind: 'ghost', onClick: () => ctx.close(null) }), start);
                    start.focus();
                }

                // ---------------- scanning ----------------
                function showScanning() {
                    view = 'scan';
                    list?.destroy();
                    list = null;
                    ctx.main.innerHTML = '';
                    ctx.foot.innerHTML = '';
                    const phaseEl = h('div', { class: 'dup-scan-phase', text: '준비하는 중…' });
                    const countEl = h('div', { class: 'dup-scan-count' });
                    const bar = h('i', { style: { width: '0%' } });
                    ctx.main.append(h('div', { class: 'dup-scan' },
                        h('div', { class: 'dup-scan-ico', html: icon('layers', 26) }),
                        phaseEl,
                        h('div', { class: 'progress dup-scan-bar' }, bar),
                        countEl,
                        h('div', { class: 'dup-scan-hint', text: '한 번 분석한 파일은 기억해 두니까 다음에는 훨씬 빨라요.' })));
                    const stop = btn({ label: '그만 찾기', kind: 'ghost', onClick: () => job?.cancel(), tip: '찾기를 멈추고 처음 화면으로 돌아가요', keys: 'Escape' });
                    ctx.foot.append(h('div', { class: 'grow' }), stop);
                    return (phase, done, total, msg) => {
                        phaseEl.textContent = msg || PHASES[phase] || '찾는 중…';
                        const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
                        bar.style.width = `${total ? pct : 100}%`;
                        bar.parentElement.classList.toggle('indeterminate', !total);
                        countEl.textContent = total && phase !== 'server' ? `${formatCount(done)} / ${formatCount(total)}` : '';
                        job?.update(done, { total, detail: phaseEl.textContent });
                    };
                }

                async function startScan() {
                    App.settings.set('dupes.options', { scope: opts.scope, includeSub: opts.includeSub, mode: opts.mode, threshold: opts.threshold, useServer: opts.useServer, merge: opts.merge });
                    cancelled = false;
                    const progress = showScanning();
                    job = App.jobs.start({ title: opts.focus ? '비슷한 항목 찾는 중' : '중복 찾는 중', total: 0, cancellable: true });
                    job.onCancel(() => (cancelled = true));
                    const isCancelled = () => cancelled;
                    try {
                        const useServer = opts.useServer && serverAvailable() && opts.scope !== 'selection' && !opts.focus && !opts.paths;
                        if (useServer) {
                            const dirs = opts.scope === 'folder' ? [App.state.cwd ?? ''] : undefined;
                            result = await scanServer({ dirs, mode: opts.mode, threshold: opts.threshold, onProgress: progress, isCancelled });
                            if (opts.scope === 'folder' && !opts.includeSub) {
                                const cwd = App.state.cwd ?? '';
                                for (const g of result.groups) g.items = g.items.filter((it) => P.parent(it.path) === cwd);
                                result.groups = result.groups.filter((g) => g.items.length > 1);
                            }
                        } else {
                            const entries = await collect(opts.scope, { includeSub: opts.includeSub, paths: opts.paths, waitIndex: () => progress('wait', 0, 0) });
                            if (cancelled) throw cancelledError();
                            result = await scanBrowser(entries, { mode: opts.focus ? (App.util.mediaType(opts.focus) === 'image' ? 'similar' : 'exact') : opts.mode, threshold: opts.threshold, focus: opts.focus, onProgress: progress, isCancelled });
                        }
                        progress('enrich', 0, 0);
                        await enrich(result.groups, { onProgress: (d, t) => progress('enrich', d, t), isCancelled });
                        if (cancelled) throw cancelledError();
                        const ignored = await loadIgnored();
                        groups = result.groups;
                        for (const g of groups) {
                            g.sigs = g.items.map(memberSig);
                            g.sigKey = sigKey(g.sigs);
                            g.hidden = isIgnored(g, ignored);
                        }
                        applyStrategy(groups, strategy, preferDir);
                        for (const g of groups) if (g.hidden) g.remove.clear();
                        gone.clear();
                        acted = false;
                        showHidden = false;
                        focusG = 0;
                        focusI = 0;
                        ctx.setSubtitle(`${result.scanned != null ? `${formatCount(result.scanned)}개 파일을 살펴봤어요 · ` : ''}${result.engine === 'server' ? '로컬 서버(FAISS)' : '브라우저'}에서 찾음`);
                        renderResults(true);
                    } catch (e) {
                        if (e.cancelled || cancelled) {
                            ui.toast('중복 찾기를 멈췄어요', { type: 'info' });
                        } else {
                            console.error('[dupes] scan failed', e);
                            ui.toast(`중복을 찾지 못했어요: ${e.message || e}`, { type: 'error' });
                        }
                        showSetup();
                    } finally {
                        job?.finish();
                    }
                }

                // ---------------- results ----------------
                function ensureKeeper(g) {
                    const a = alive(g);
                    if (!a.length || a.some((i) => i.path === g.keep)) return;
                    const s = STRATEGIES[strategy] || STRATEGIES.best;
                    g.keep = a.slice().sort(s.cmp)[0].path;
                    g.remove.delete(g.keep);
                }

                function renderResults(force) {
                    if (groups.some(isVisible)) {
                        if (force || view !== 'list') buildList();
                        else refreshShown();
                    } else {
                        buildEmpty();
                    }
                }

                const syncSoon = App.util.debounce(() => {
                    if (view === 'list' || view === 'empty') renderResults(false);
                }, 30);

                function buildEmpty() {
                    view = 'empty';
                    list?.destroy();
                    list = null;
                    ctx.main.innerHTML = '';
                    ctx.foot.innerHTML = '';
                    const hiddenN = groups.filter((g) => g.hidden && alive(g).length > 1).length;
                    const [title, text] = acted
                        ? ['모두 정리했어요', '복제본을 휴지통으로 옮겼어요. 휴지통에서 되살리거나 Ctrl+Z로 한 번에 되돌릴 수 있어요.']
                        : opts.focus
                            ? ['비슷한 항목이 없어요', '같은 사진이나 비슷한 사진을 찾지 못했어요. "비슷한 정도"를 느슨하게 바꿔 볼 수 있어요.']
                            : ['중복된 파일이 없어요', '깔끔해요! 다른 범위나 "비슷한 사진까지"로 다시 찾아볼 수 있어요.'];
                    ctx.main.append(h('div', { class: 'org-empty-state dup-empty' },
                        h('div', { class: 'org-empty-art good', html: icon('check-circle', 30) }),
                        h('h4', { text: title }),
                        h('p', { text }),
                        hiddenN ? btn({ label: `"중복 아님"으로 숨긴 그룹 ${formatCount(hiddenN)}개 보기`, kind: 'ghost sm', icon: 'eye', onClick: () => { showHidden = true; renderResults(true); } }) : null));
                    const close = btn({ label: '닫기', kind: 'primary', onClick: () => ctx.close(null) });
                    ctx.foot.append(h('div', { class: 'grow' }), btn({ label: '다시 찾기', kind: 'ghost', icon: 'refresh', onClick: () => showSetup() }), close);
                    close.focus();
                }

                function buildList() {
                    view = 'list';
                    list?.destroy();
                    ctx.main.innerHTML = '';
                    ctx.foot.innerHTML = '';
                    summaryEl = h('div', { class: 'dup-summary' });
                    filterSeg = kit.seg([
                        { value: 'all', label: '전체' },
                        { value: 'exact', label: '똑같음' },
                        { value: 'similar', label: '비슷함' },
                    ], filter, (v) => {
                        filter = v;
                        focusG = 0;
                        refreshShown();
                    });
                    const sortSel = kit.select([
                        { value: 'savings', label: '확보 용량 큰 순' },
                        { value: 'count', label: '개수 많은 순' },
                        { value: 'folder', label: '폴더 순' },
                    ], sortKey, (v) => {
                        sortKey = v;
                        refreshShown();
                    }, { cls: 'sm' });
                    const dirCounts = new Map();
                    for (const g of groups) for (const it of alive(g)) {
                        const d = P.parent(it.path);
                        dirCounts.set(d, (dirCounts.get(d) || 0) + 1);
                    }
                    const topDirs = [...dirCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
                    const stratSel = kit.select([
                        ...Object.entries(STRATEGIES).map(([k, s]) => ({ value: k, label: s.label })),
                        ...topDirs.map(([d, n]) => ({ value: `dir:${d}`, label: `${kit.folderPathLabel(d)} 폴더 것 남기기 (${formatCount(n)})` })),
                        { value: 'none', label: '선택 모두 해제' },
                    ], preferDir != null ? `dir:${preferDir}` : strategy, (v) => {
                        const target = groups.filter((g) => !g.hidden);
                        if (v === 'none') {
                            for (const g of target) g.remove.clear();
                        } else if (v.startsWith('dir:')) {
                            preferDir = v.slice(4);
                            applyStrategy(target, strategy, preferDir);
                        } else {
                            strategy = v;
                            preferDir = null;
                            applyStrategy(target, strategy, null);
                        }
                        refreshShown();
                        list.refresh();
                    }, { cls: 'sm dup-strategy' });
                    const toolbar = h('div', { class: 'dup-toolbar' }, summaryEl, h('div', { class: 'grow' }), filterSeg.el, sortSel, h('span', { class: 'dup-tool-label', text: '자동 선택' }), stratSel);
                    list = kit.virtualList({ rowHeight: GROUP_H, render: renderGroup, className: 'dup-list', label: '중복 그룹' });
                    ctx.main.append(toolbar, h('div', { class: 'org-picker-body' }, list.el));

                    footInfo = h('div', { class: 'org-foot-info' });
                    const mergeT = kit.toggle('남기는 파일에 칩·별점·메모 합치기', opts.merge, (v) => {
                        opts.merge = v;
                        const s = App.settings.get('dupes.options', {});
                        App.settings.set('dupes.options', { ...s, merge: v });
                    }, { tip: '지우는 복제본에 붙어 있던 칩, 가장 높은 별점, 메모, 마커를 남기는 파일로 옮겨요' });
                    hiddenBtn = btn({ label: '', kind: 'ghost sm', icon: 'eye', onClick: () => {
                        showHidden = !showHidden;
                        renderResults(false);
                    } });
                    trashBtn = btn({ label: '', kind: 'danger', icon: 'trash', onClick: () => trashSelected(), tip: '고른 복제본을 휴지통으로 옮겨요', keys: 'Delete' });
                    ctx.foot.append(mergeT.el, footInfo, hiddenBtn, btn({ label: '다시 찾기', kind: 'ghost', icon: 'refresh', onClick: () => showSetup() }), trashBtn);
                    refreshShown();
                    list.el.focus({ preventScroll: true });
                }

                function refreshShown() {
                    for (const g of groups) ensureKeeper(g);
                    shown = groups.filter((g) => isVisible(g) && (filter === 'all' || g.kind === filter));
                    if (sortKey === 'savings') shown.sort((a, b) => (a.hidden ? 1 : 0) - (b.hidden ? 1 : 0) || potential(b) - potential(a));
                    else if (sortKey === 'count') shown.sort((a, b) => (a.hidden ? 1 : 0) - (b.hidden ? 1 : 0) || alive(b).length - alive(a).length || potential(b) - potential(a));
                    else shown.sort((a, b) => (a.hidden ? 1 : 0) - (b.hidden ? 1 : 0) || compareNames(P.parent(a.keep), P.parent(b.keep)) || compareNames(a.keep, b.keep));
                    if (focusG >= shown.length) focusG = Math.max(0, shown.length - 1);
                    const fg = shown[focusG];
                    if (fg) focusI = Math.max(0, Math.min(focusI, alive(fg).length - 1));
                    if (list) list.setCount(shown.length);
                    updateSummary();
                }

                function updateSummary() {
                    if (!summaryEl || view !== 'list') return;
                    const act = groups.filter(active);
                    const removeCount = act.reduce((s, g) => s + removing(g).length, 0);
                    const bytes = act.reduce((s, g) => s + wasted(g), 0);
                    const exact = act.filter((g) => g.kind === 'exact').length;
                    summaryEl.innerHTML = '';
                    summaryEl.append(
                        h('span', { class: 'dup-sum-main', text: `중복 그룹 ${formatCount(act.length)}개` }),
                        h('span', { class: 'dup-sum-sub', text: `복제본 ${formatCount(act.reduce((s, g) => s + alive(g).length - 1, 0))}개 · 최대 ${formatBytes(act.reduce((s, g) => s + potential(g), 0))} 확보 가능` }));
                    const segBtns = filterSeg.el.querySelectorAll('button');
                    segBtns[0].querySelector('span').textContent = `전체 ${formatCount(act.length)}`;
                    segBtns[1].querySelector('span').textContent = `똑같음 ${formatCount(exact)}`;
                    segBtns[2].querySelector('span').textContent = `비슷함 ${formatCount(act.length - exact)}`;
                    trashBtn.disabled = !removeCount;
                    kit.setBtnLabel(trashBtn, removeCount ? `복제본 ${formatCount(removeCount)}개 휴지통으로 · ${formatBytes(bytes)} 확보` : '휴지통으로 보낼 항목을 고르세요');
                    const hiddenN = groups.filter((g) => g.hidden && alive(g).length > 1).length;
                    hiddenBtn.hidden = !hiddenN;
                    kit.setBtnLabel(hiddenBtn, showHidden ? '숨긴 그룹 감추기' : `숨긴 그룹 ${formatCount(hiddenN)}개`);
                    footInfo.textContent = preferDir != null ? `${kit.folderPathLabel(preferDir)} 폴더에 있는 파일을 먼저 남겨요` : STRATEGIES[strategy].why;
                }

                const GROUP_H = 286;
                const CARD_W = 176;

                function renderGroup(gi) {
                    const g = shown[gi];
                    const items = alive(g);
                    const removeN = removing(g).length;
                    const head = h('div', { class: 'dup-ghead' },
                        h('span', { class: `dup-kind ${g.kind}`, text: g.kind === 'exact' ? '똑같음' : '비슷함' }),
                        g.hidden ? h('span', { class: 'dup-kind hidden', text: '숨김' }) : null,
                        h('span', { class: 'dup-gtitle', text: `${formatCount(items.length)}개` }),
                        h('span', { class: 'dup-gsave', text: g.hidden ? '"중복 아님"으로 표시한 그룹이에요' : removeN ? `${formatCount(removeN)}개 지우면 ${formatBytes(wasted(g))} 확보` : '지울 항목 없음' }),
                        h('div', { class: 'grow' }),
                        btn({ label: '비교', icon: 'eye', kind: 'ghost sm', tip: '나란히 크게 비교', keys: 'C', onClick: () => openCompare(g, items.find((i) => i.path !== g.keep)?.path) }),
                        g.hidden
                            ? btn({ label: '다시 보이기', icon: 'eye', kind: 'ghost sm', tip: '다음 찾기부터 다시 보여 줘요', onClick: () => ignoreGroup(g, false) })
                            : btn({ label: '중복 아님', icon: 'eye-off', kind: 'ghost sm', tip: '이 그룹을 다음부터 보여 주지 않아요 (되돌릴 수 있어요)', onClick: () => ignoreGroup(g, true).then(() => ui.toast('이 그룹은 다음부터 보여 주지 않을게요', { type: 'info', action: { label: '실행 취소', run: () => App.undo.undo() } })) }));
                    const cards = h('div', { class: 'dup-cards' });
                    items.forEach((it, ii) => cards.append(renderCard(g, it, gi, ii)));
                    const el = h('div', { class: `dup-group${gi === focusG ? ' focused' : ''}${g.hidden ? ' is-hidden' : ''}`, role: 'group', 'aria-label': `중복 그룹 ${gi + 1}` }, head, cards);
                    return h('div', { class: 'dup-group-wrap' }, el);
                }

                function renderCard(g, it, gi, ii) {
                    const keep = it.path === g.keep;
                    const rm = !g.hidden && !keep && g.remove.has(it.path);
                    const e = it.entry;
                    const keeper = g.items.find((x) => x.path === g.keep);
                    const res = it.w && it.h ? `${it.w}×${it.h}` : '';
                    const better = !keep && keeper && it.w && keeper.w && it.w * it.h > keeper.w * keeper.h;
                    let likeness = null;
                    if (!keep && keeper && g.kind === 'similar') {
                        if (it.contentKey && it.contentKey === keeper.contentKey) likeness = '똑같음';
                        else if (it.phash && keeper.phash) likeness = `${Math.round((1 - hamming(hexHash(it.phash), hexHash(keeper.phash)) / 64) * 100)}% 비슷`;
                        else if (it.distance != null) likeness = `차이 ${it.distance}`;
                    }
                    const flag = g.hidden
                        ? h('span', { class: 'dup-flag skip', html: '<span>그대로</span>' })
                        : keep
                            ? h('span', { class: 'dup-flag keep', html: `${icon('check', 11)}<span>남김</span>` })
                            : h('span', { class: `dup-flag ${rm ? 'rm' : 'skip'}`, html: rm ? `${icon('trash', 11)}<span>지움</span>` : '<span>그대로</span>' });
                    const card = h('div', { class: `dup-card${keep && !g.hidden ? ' keep' : ''}${rm ? ' remove' : ''}${gi === focusG && ii === focusI ? ' focused' : ''}`, style: { width: CARD_W + 'px' }, title: it.path, dataset: { path: it.path } },
                        h('div', { class: 'dup-card-media' },
                            kit.thumb(e, { cls: 'dup-thumb' }),
                            flag,
                            e.type === 'video' && it.duration ? h('span', { class: 'dup-dur', text: App.util.formatDuration(it.duration) }) : null,
                            !keep && !g.hidden ? h('button', { type: 'button', class: 'dup-keepbtn', text: '이걸 남기기', onclick: (ev) => { ev.stopPropagation(); setKeep(g, it.path); } }) : null),
                        h('div', { class: 'dup-card-meta' },
                            h('div', { class: 'dup-card-name truncate', text: e.name }),
                            h('div', { class: 'dup-card-line' }, res ? h('span', { class: better ? 'dup-better' : '', text: res }) : null, h('span', { text: formatBytes(it.size) })),
                            h('div', { class: 'dup-card-line faint' }, h('span', { text: formatDate(it.mtime) }), likeness ? h('span', { class: 'dup-like', text: likeness }) : null),
                            h('div', { class: 'dup-card-path truncate', text: kit.folderPathLabel(P.parent(it.path)) })));
                    card.addEventListener('click', () => {
                        const prev = focusG;
                        focusG = gi;
                        focusI = ii;
                        if (prev !== gi && list.rowAt(prev)) list.update(prev);
                        if (keep || g.hidden) {
                            list.update(gi);
                            return;
                        }
                        toggleRemove(g, it.path);
                    });
                    card.addEventListener('dblclick', () => openCompare(g, it.path));
                    return card;
                }

                function toggleRemove(g, p) {
                    if (p === g.keep || g.hidden) return;
                    if (g.remove.has(p)) g.remove.delete(p);
                    else g.remove.add(p);
                    redrawGroup(g);
                }

                function setKeep(g, p) {
                    if (g.hidden) return;
                    const old = g.keep;
                    g.keep = p;
                    g.remove.delete(p);
                    if (old && old !== p) g.remove.add(old);
                    redrawGroup(g);
                }

                function redrawGroup(g) {
                    const i = shown.indexOf(g);
                    if (i >= 0 && list) list.update(i);
                    updateSummary();
                }

                async function trashSelected() {
                    const act = groups.filter(active);
                    const plan = act.map((g) => ({ keep: g.keep, remove: removing(g).map((i) => i.path) })).filter((p) => p.remove.length);
                    const count = plan.reduce((s, p) => s + p.remove.length, 0);
                    if (!count) return;
                    const bytes = act.reduce((s, g) => s + wasted(g), 0);
                    const ok = await kit.sheet(ctx.box, {
                        title: `복제본 ${formatCount(count)}개를 휴지통으로 옮길까요?`,
                        message: `${formatBytes(bytes)}를 확보해요.${opts.merge ? ' 지우는 파일의 칩·별점·메모·마커는 남기는 파일로 합쳐요.' : ''} 휴지통에서 되살리거나 Ctrl+Z로 한 번에 되돌릴 수 있어요.`,
                        okLabel: '휴지통으로',
                        icon: 'trash',
                    });
                    if (!ok) return;
                    const busy = kit.busy(ctx.box, '휴지통으로 옮기는 중…');
                    let res;
                    try {
                        res = await trashDuplicates(plan, { merge: opts.merge });
                    } finally {
                        busy.close();
                    }
                    acted = true;
                    // the fs:changed events of the trash already marked the copies as gone
                    syncSoon.flush();
                    if (res.trashed) {
                        ui.toast(`복제본 ${formatCount(res.trashed)}개를 휴지통으로 옮겼어요 · ${formatBytes(bytes)} 확보${res.merged ? ` · ${formatCount(res.merged)}개에 정보를 합쳤어요` : ''}`, {
                            type: 'success',
                            duration: 6000,
                            action: { label: '실행 취소', run: () => App.undo.undo() },
                        });
                    }
                    const unreported = (res.failed || []).filter((f) => !f.reported);
                    if (unreported.length) ui.toast(`${formatCount(unreported.length)}개는 휴지통으로 옮기지 못했어요 (${unreported[0].error})`, { type: 'warning', duration: 6000 });
                }

                // ---------------- keep in sync with the file system (undo/redo, other changes) ----------------
                function rebaseItem(g, it, to) {
                    const from = it.path;
                    it.path = to;
                    it.entry = { ...it.entry, path: to, name: P.base(to) };
                    if (g.keep === from) g.keep = to;
                    if (g.remove.has(from)) {
                        g.remove.delete(from);
                        g.remove.add(to);
                    }
                    if (gone.has(from)) {
                        gone.delete(from);
                        gone.add(to);
                    }
                }

                const offFs = App.bus.on('fs:changed', (c) => {
                    if (!groups.length) return;
                    let changed = false;
                    const paths = new Set(c.paths || []);
                    if (c.type === 'trash' || c.type === 'delete') {
                        for (const g of groups) for (const it of g.items) {
                            if (!gone.has(it.path) && hitsAny(it.path, paths)) {
                                gone.add(it.path);
                                changed = true;
                            }
                        }
                    } else if (c.from && c.to && (c.type === 'move' || c.type === 'rename')) {
                        const prefixes = new Set();
                        for (const g of groups) for (const it of g.items) for (let q = it.path; q; q = P.parent(q)) prefixes.add(q);
                        for (let k = 0; k < c.from.length; k++) {
                            if (!prefixes.has(c.from[k])) continue;
                            for (const g of groups) for (const it of g.items) {
                                const r = P.rebase(it.path, c.from[k], c.to[k]);
                                if (r != null && r !== it.path) {
                                    rebaseItem(g, it, r);
                                    changed = true;
                                }
                            }
                        }
                    } else if (c.type === 'restore' || c.type === 'create' || c.type === 'copy') {
                        for (const g of groups) for (const it of g.items) {
                            if (gone.has(it.path) && hitsAny(it.path, paths)) {
                                gone.delete(it.path);
                                changed = true;
                            }
                        }
                    }
                    if (changed) {
                        compareClose?.();
                        syncSoon();
                    }
                });
                const offIgnore = App.bus.on('dupes:ignore', ({ sigs, hidden }) => {
                    const key = sigKey(sigs);
                    let changed = false;
                    for (const g of groups) {
                        if (g.sigKey !== key || !!g.hidden === hidden) continue;
                        g.hidden = hidden;
                        if (hidden) g.remove.clear();
                        else applyStrategy([g], strategy, preferDir);
                        changed = true;
                    }
                    if (changed) {
                        compareClose?.();
                        syncSoon();
                    }
                });
                ctx.onClose(offFs);
                ctx.onClose(offIgnore);

                // ---------------- compare overlay ----------------
                function openCompare(g, otherPath) {
                    if (!g || alive(g).length < 2) return;
                    compareClose?.();
                    let other = otherPath && otherPath !== g.keep ? otherPath : alive(g).find((i) => i.path !== g.keep)?.path;
                    const overlay = h('div', { class: 'dup-compare', role: 'dialog', 'aria-label': '나란히 비교' });
                    const releases = [];
                    const flagFor = (it) => {
                        if (it.path === g.keep && !g.hidden) return h('span', { class: 'dup-flag keep', html: `${icon('check', 11)}<span>남김</span>` });
                        const rm = !g.hidden && g.remove.has(it.path);
                        return h('span', { class: `dup-flag ${rm ? 'rm' : 'skip'}`, html: rm ? `${icon('trash', 11)}<span>지움</span>` : '<span>그대로</span>' });
                    };
                    const pane = (it, side, keeper, candidate) => {
                        const isKeep = it.path === g.keep;
                        const media = h('div', { class: 'dup-cmp-media' }, h('span', { class: 'spinner' }));
                        const e = it.entry;
                        App.fs.url(it.path).then((src) => {
                            if (!overlay.isConnected) return src.release();
                            releases.push(src.release);
                            media.innerHTML = '';
                            if (e.type === 'video') media.append(h('video', { src: src.url, controls: true, muted: true, preload: 'metadata' }));
                            else if (App.util.browserCanDecode(e.name)) media.append(h('img', { src: src.url, alt: e.name }));
                            else media.append(h('div', { class: 'faint', text: '미리보기를 지원하지 않는 형식이에요' }));
                        }).catch(() => (media.textContent = '열 수 없어요'));
                        const versus = side === 'left' ? candidate : keeper;
                        const tag = (cond, text) => (cond ? h('span', { class: 'badge org-badge success', text }) : null);
                        return h('div', { class: `dup-cmp-pane ${isKeep && !g.hidden ? 'keep' : ''}` },
                            h('div', { class: 'dup-cmp-head' },
                                flagFor(it),
                                h('span', { class: 'dup-cmp-name truncate', text: e.name }),
                                !isKeep && !g.hidden ? btn({ label: '이걸 남기기', kind: 'sm', onClick: () => { setKeep(g, it.path); other = keeper.path; render(); } }) : null),
                            media,
                            h('div', { class: 'dup-cmp-info' },
                                h('div', null, h('span', { class: 'k', text: '해상도' }), h('span', { text: it.w ? `${it.w} × ${it.h}` : '—' }), tag(versus && it.w && versus.w && it.w * it.h > versus.w * versus.h, '더 큼')),
                                h('div', null, h('span', { class: 'k', text: '크기' }), h('span', { text: formatBytes(it.size) }), tag(versus && it.size > versus.size, '더 큼')),
                                h('div', null, h('span', { class: 'k', text: '수정한 날짜' }), h('span', { text: formatDate(it.mtime, true) }), tag(versus && it.mtime && versus.mtime && it.mtime < versus.mtime - 1000, '더 오래됨')),
                                h('div', null, h('span', { class: 'k', text: '위치' }), h('span', { class: 'truncate', text: kit.folderPathLabel(P.parent(it.path)) }))));
                    };
                    function render() {
                        for (const r of releases.splice(0)) r();
                        overlay.innerHTML = '';
                        const items = alive(g);
                        const keeper = items.find((x) => x.path === g.keep) || items[0];
                        const others = items.filter((x) => x !== keeper);
                        const candidate = others.find((x) => x.path === other) || others[0];
                        if (!candidate) return close();
                        other = candidate.path;
                        const idx = others.indexOf(candidate);
                        overlay.append(
                            h('div', { class: 'dup-cmp-bar' },
                                h('span', { class: 'dup-cmp-title', text: '나란히 비교' }),
                                others.length > 1 ? h('span', { class: 'faint', text: `${idx + 1} / ${others.length}` }) : null,
                                h('div', { class: 'grow' }),
                                others.length > 1 ? btn({ icon: 'chevron-left', kind: 'ghost sm icon', tip: '이전', keys: 'ArrowLeft', onClick: () => step(-1) }) : null,
                                others.length > 1 ? btn({ icon: 'chevron-right', kind: 'ghost sm icon', tip: '다음', keys: 'ArrowRight', onClick: () => step(1) }) : null,
                                !g.hidden ? btn({ label: g.remove.has(candidate.path) ? '지우지 않기' : '지울 항목에 넣기', kind: 'sm', tip: '지울 항목에 넣거나 빼요', keys: 'Space', onClick: () => { toggleRemove(g, candidate.path); render(); } }) : null,
                                btn({ icon: 'x', kind: 'ghost sm icon', tip: '비교 닫기', keys: 'Escape', onClick: () => close() })),
                            h('div', { class: 'dup-cmp-panes' }, pane(keeper, 'left', keeper, candidate), pane(candidate, 'right', keeper, candidate)));
                    }
                    function step(d) {
                        const items = alive(g);
                        const others = items.filter((x) => x.path !== g.keep);
                        if (!others.length) return;
                        const i = others.findIndex((x) => x.path === other);
                        other = others[(i + d + others.length) % others.length].path;
                        render();
                    }
                    const release = kit.keyScope((e) => {
                        if (e.ctrlKey || e.metaKey || e.altKey) return false; // let Ctrl+Z etc. reach the panel
                        if (e.key === 'Escape' || e.key === 'c' || e.key === 'C') {
                            close();
                            return true;
                        }
                        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                            step(e.key === 'ArrowLeft' ? -1 : 1);
                            return true;
                        }
                        if (e.key === ' ') {
                            toggleRemove(g, other);
                            render();
                            return true;
                        }
                        return e.key === 'Enter';
                    });
                    function close() {
                        release();
                        for (const r of releases.splice(0)) r();
                        overlay.remove();
                        compareClose = null;
                        list?.el.focus({ preventScroll: true });
                    }
                    compareClose = close;
                    render();
                    if (compareClose) ctx.box.append(overlay);
                }

                // ---------------- keyboard ----------------
                ctx.onKey((e) => {
                    if (view === 'scan' && e.key === 'Escape') {
                        job?.cancel();
                        return true;
                    }
                    if (view !== 'list' || !list || !shown.length || compareClose) return false;
                    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return false;
                    const g = shown[focusG];
                    const items = alive(g);
                    const k = e.key;
                    const redraw = (prevG) => {
                        if (prevG !== focusG) list.update(prevG);
                        list.update(focusG);
                        list.scrollToIndex(focusG);
                    };
                    if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'j' || k === 'k') {
                        const prev = focusG;
                        focusG = Math.max(0, Math.min(shown.length - 1, focusG + (k === 'ArrowDown' || k === 'j' ? 1 : -1)));
                        focusI = Math.min(focusI, alive(shown[focusG]).length - 1);
                        redraw(prev);
                        return true;
                    }
                    if (k === 'ArrowRight' || k === 'ArrowLeft') {
                        focusI = Math.max(0, Math.min(items.length - 1, focusI + (k === 'ArrowRight' ? 1 : -1)));
                        redraw(focusG);
                        const card = list.rowAt(focusG)?.querySelectorAll('.dup-card')[focusI];
                        card?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                        return true;
                    }
                    if (e.target.tagName === 'BUTTON' && (k === ' ' || k === 'Enter')) return false;
                    const it = items[focusI];
                    if (!it) return false;
                    if (k === ' ') {
                        toggleRemove(g, it.path);
                        return true;
                    }
                    if (k === 'Enter') {
                        setKeep(g, it.path);
                        return true;
                    }
                    if (k === 'c' || k === 'C') {
                        openCompare(g, it.path);
                        return true;
                    }
                    if (k === 'Delete') {
                        trashSelected();
                        return true;
                    }
                    return false;
                });

                if (args.autostart || opts.focus) startScan();
                else showSetup();
            },
        });
    }

    function cleanArgs(a) {
        if (!a || typeof a !== 'object') return {};
        const { event, ...rest } = a;
        return rest;
    }

    App.commands.register({ id: 'dupes.open', title: '중복 찾기…', group: '정리', icon: 'layers', keys: 'Mod+Alt+D', when: () => App.fs.ready, run: (a) => open(cleanArgs(a)) });
    App.commands.register({
        id: 'dupes.findSimilar',
        title: '이 사진과 비슷한 항목 찾기',
        group: '정리',
        icon: 'search',
        when: () => App.fs.ready && App.select.count === 1 && App.select.entries()[0]?.kind === 'file',
        run: (a) => {
            const args = cleanArgs(a);
            const p = args.path || App.select.list()[0];
            if (!p) return null;
            return open({ focus: p, scope: 'workspace', autostart: true, threshold: args.threshold });
        },
    });

    App.dupes = {
        open,
        scan: scanBrowser,
        scanServer,
        enrich,
        applyStrategy,
        trashDuplicates,
        mergedPatch,
        ignoreGroup,
        loadIgnored,
        phash: async (file) => hashHex(phashFromGray((await analyzeBlob(file)).gray)),
        hamming: (a, b) => hamming(hexHash(a), hexHash(b)),
        collect,
        clearCache: async () => {
            const d = await db();
            if (!d) return;
            await new Promise((r) => {
                const tx = d.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).clear();
                tx.oncomplete = r;
                tx.onerror = r;
            });
        },
    };
})();
