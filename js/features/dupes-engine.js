/*
 * Duplicate finder v2 — browser engine (App.dupes.engine).
 *
 * The owner's proven algorithm (F:\_중복검사\find_dupes.py, ARCHITECTURE §8 "Matching rule"):
 *   exact  — same size → quick hash (first + last 1 MB + size) → full hash only when the quick hashes collide
 *   video  — |Δduration| ≤ max(2 s, 1 %) of the longer one; 5 frames at 15/35/50/65/85 % → 9×8 gray → 64-bit dHash
 *            (left > right); nearly flat frames (stddev < 4) are skipped; a frame matches at Hamming ≤ 10 bits;
 *            same video when ≥ 3 compared frames match; score = matched / compared
 *   image  — 64-bit pHash (32×32 DCT) + quadrant colour signature (kept from round 1)
 *   "확실" = exact copy, or the same video with every duration within 0.3 s. Everything else is "애매".
 *   Keep suggestion: folder role → highest resolution → longest → largest. Every threshold lives in `rules`.
 *
 * Fingerprints are made once and cached in IndexedDB per workspace + path, validated by size + mtime and tagged with
 * the engine id ('b1'); later scans only fingerprint new or changed files. Small frame thumbnails (the same 5 frames)
 * are cached next to them so the review strip shows up instantly.
 *
 *   engine.collect(scope)                         → items [{ path, name, size, mtime, type, side? }]
 *   engine.fingerprint(items, { kinds, rules, onProgress, isCancelled, gate }) → { recs, stats }
 *   engine.analyze(items, recs, { kinds, rules }) → raw { items, exactSets, edges }  (candidate pairs, rule-independent-ish)
 *   engine.assemble(raw, { rules, store, compare, focus }) → groups (exclusions, "중복 아님" pairs and roles applied)
 *   engine.scan(scope, opts)                      → result { id, at, scope, engine, raw, stats }
 *   engine.prebuild(opts)                         → background job '지문 미리 만들기' (pausable, cancellable)
 */
(() => {
    'use strict';
    const { path: P, formatCount, formatBytes } = App.util;

    const ENGINE = 'b1';
    const POSITIONS = [0.15, 0.35, 0.5, 0.65, 0.85];
    const MB = 1048576;
    const DEFAULT_RULES = Object.freeze({ frameBits: 10, minFrames: 3, durSec: 2, durPct: 1, sureSec: 0.3, imageBits: 8 });

    const counters = { quick: 0, full: 0, probe: 0, video: 0, image: 0 };

    function normalizeRules(r) {
        const out = { ...DEFAULT_RULES };
        const num = (k, lo, hi) => {
            const v = Number(r && r[k]);
            if (Number.isFinite(v)) out[k] = Math.min(hi, Math.max(lo, v));
        };
        num('frameBits', 0, 32);
        num('minFrames', 1, 5);
        num('durSec', 0, 30);
        num('durPct', 0, 10);
        num('sureSec', 0, 10);
        num('imageBits', 0, 24);
        out.minFrames = Math.round(out.minFrames);
        out.frameBits = Math.round(out.frameBits);
        out.imageBits = Math.round(out.imageBits);
        return out;
    }

    const durTol = (rules, a, b) => Math.max(rules.durSec, (rules.durPct / 100) * Math.max(a, b));

    // =================================================================================================
    // IndexedDB: fingerprints, frame thumbnails, last results
    // =================================================================================================
    const DB_NAME = 'fluid-identity-dupes';
    let dbPromise = null;

    function db() {
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
                const req = indexedDB.open(DB_NAME, 2);
                req.onupgradeneeded = () => {
                    const d = req.result;
                    if (d.objectStoreNames.contains('hashes')) d.deleteObjectStore('hashes'); // round-1 format
                    if (!d.objectStoreNames.contains('fp')) d.createObjectStore('fp');
                    if (!d.objectStoreNames.contains('frames')) d.createObjectStore('frames');
                    if (!d.objectStoreNames.contains('results')) d.createObjectStore('results');
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
                req.onblocked = () => reject(new Error('blocked'));
            }).catch((e) => {
                console.warn('[dupes] fingerprint cache unavailable', e);
                return null;
            });
        }
        return dbPromise;
    }

    function tx(storeName, mode, fn) {
        return db().then((d) => {
            if (!d) return undefined;
            return new Promise((resolve) => {
                let out;
                let t;
                try {
                    t = d.transaction(storeName, mode);
                } catch (e) {
                    resolve(undefined);
                    return;
                }
                const s = t.objectStore(storeName);
                out = fn(s);
                t.oncomplete = () => resolve(typeof out === 'function' ? out() : out);
                t.onerror = () => resolve(typeof out === 'function' ? out() : out);
                t.onabort = () => resolve(typeof out === 'function' ? out() : out);
            });
        });
    }

    const wsId = () => App.state.workspace?.id || '';
    const fpKey = (path, ws = wsId()) => `${ws}|${path}`;

    const cache = {
        /** Map(path → record) for records that still match size + mtime exactly (+ engine). */
        async getMany(items, ws = wsId()) {
            const found = new Map();
            if (!items.length) return found;
            await tx('fp', 'readonly', (s) => {
                for (const it of items) {
                    const r = s.get(fpKey(it.path, ws));
                    r.onsuccess = () => {
                        const v = r.result;
                        if (!v || v.e !== ENGINE || v.size !== it.size || v.mtime !== it.mtime) return;
                        found.set(it.path, v);
                    };
                }
            });
            return found;
        },
        async putMany(recs, ws = wsId()) {
            if (!recs.length) return;
            await tx('fp', 'readwrite', (s) => {
                for (const r of recs) {
                    const v = { ...r };
                    delete v.dirty;
                    s.put(v, fpKey(r.path, ws));
                }
            });
        },
        async count() {
            const ws = wsId();
            return (await tx('fp', 'readonly', (s) => {
                const r = s.count(IDBKeyRange.bound(`${ws}|`, `${ws}|\uffff`));
                return () => r.result || 0;
            })) || 0;
        },
        /**
         * Records under `from` follow a move/rename made inside the app (same bytes) — also the frame thumbnails.
         * The platform may give the moved file a new mtime: we read it once (same size → same file) so the next scan
         * reuses the fingerprint; anything else that changes size/mtime later is fingerprinted again.
         */
        async rebase(pairs) {
            const ws = wsId();
            if (!pairs.length) return;
            const moved = [];
            for (const storeName of ['fp', 'frames']) {
                await tx(storeName, 'readwrite', (s) => {
                    for (const [from, to] of pairs) {
                        const range = IDBKeyRange.bound(`${ws}|${from}`, `${ws}|${from}/\uffff`);
                        const req = s.openCursor(range);
                        req.onsuccess = () => {
                            const c = req.result;
                            if (!c) return;
                            const path = String(c.key).slice(ws.length + 1);
                            const next = P.rebase(path, from, to);
                            if (next != null && next !== path) {
                                const v = { ...c.value, path: next };
                                s.put(v, `${ws}|${next}`);
                                c.delete();
                                if (storeName === 'fp') moved.push({ path: next, size: v.size, mtime: v.mtime });
                            }
                            c.continue();
                        };
                    }
                });
            }
            if (!moved.length) return;
            const fresh = [];
            await App.util.pool(moved, 16, async (m) => {
                try {
                    const st = await App.fs.stat(m.path);
                    if (st && st.size === m.size && st.mtime !== m.mtime) fresh.push({ path: m.path, mtime: st.mtime });
                } catch (e) {
                    /* gone again */
                }
            });
            if (!fresh.length || wsId() !== ws) return;
            for (const storeName of ['fp', 'frames']) {
                await tx(storeName, 'readwrite', (s) => {
                    for (const f of fresh) {
                        const r = s.get(`${ws}|${f.path}`);
                        r.onsuccess = () => {
                            if (r.result) s.put({ ...r.result, mtime: f.mtime }, `${ws}|${f.path}`);
                        };
                    }
                });
            }
        },
        async clear() {
            for (const storeName of ['fp', 'frames']) await tx(storeName, 'readwrite', (s) => s.clear());
        },
        async getFrames(item, ws = wsId()) {
            return tx('frames', 'readonly', (s) => {
                const r = s.get(fpKey(item.path, ws));
                return () => {
                    const v = r.result;
                    return v && v.size === item.size && v.mtime === item.mtime ? v.blobs : null;
                };
            });
        },
        async putFrames(item, blobs, ws = wsId()) {
            if (ws !== wsId()) return;
            await tx('frames', 'readwrite', (s) => s.put({ path: item.path, size: item.size, mtime: item.mtime, blobs }, fpKey(item.path, ws)));
        },
        async getResult() {
            const ws = wsId();
            if (!ws) return null;
            return tx('results', 'readonly', (s) => {
                const r = s.get(ws);
                return () => r.result || null;
            });
        },
        async putResult(result) {
            const ws = wsId();
            if (!ws) return;
            await tx('results', 'readwrite', (s) => (result ? s.put(result, ws) : s.delete(ws)));
        },
    };

    // =================================================================================================
    // Exact: quick hash (head + tail 1 MB + size) and full hash
    // =================================================================================================
    async function digest(buf) {
        return App.organize.kit.digest(buf);
    }

    /** -> { q, full } ; files up to 2 MB are hashed whole (then q is also the full hash). */
    async function quickHash(file) {
        if (file.size <= 2 * MB) return { q: await digest(await new Blob([file, ':' + file.size]).arrayBuffer()), full: true };
        const blob = new Blob([file.slice(0, MB), file.slice(file.size - MB), ':' + file.size]);
        return { q: await digest(await blob.arrayBuffer()), full: false };
    }

    // =================================================================================================
    // Images: pHash (+ colour signature) in Blob-URL workers
    // =================================================================================================
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

    // 32×32 gray for the pHash + mean colour of the four quadrants (two flat pictures with the same layout but other
    // colours would otherwise match).
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
    /** Hamming distance of two 16-hex-digit (64-bit) hashes. */
    function hamHex(a, b) {
        return pop32((parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16)) >>> 0) + pop32((parseInt(a.slice(8, 16), 16) ^ parseInt(b.slice(8, 16), 16)) >>> 0);
    }
    const hashHex = (hl) => hl[0].toString(16).padStart(8, '0') + hl[1].toString(16).padStart(8, '0');
    const colorHex = (c) => c.map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('');
    const hexColor = (s) => (s && s.length === 24 ? Array.from({ length: 12 }, (_, i) => parseInt(s.slice(i * 2, i * 2 + 2), 16)) : null);
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
                const d = hamHex(hash, cur.hash);
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
                const d = hamHex(hash, n.hash);
                if (d <= t) for (const i of n.items) cb(i, d);
                for (const [k, child] of n.kids) if (k >= d - t && k <= d + t) stack.push(child);
            }
        }
    }

    // =================================================================================================
    // Videos: duration probe + 5-frame dHash (+ small frame thumbnails for the review strip)
    // =================================================================================================
    function waitEvent(el, names, ms) {
        return new Promise((resolve) => {
            let timer = 0;
            const fns = [];
            const done = (v) => {
                clearTimeout(timer);
                for (const [n, f] of fns) el.removeEventListener(n, f);
                resolve(v);
            };
            for (const n of names) {
                const f = () => done(n);
                fns.push([n, f]);
                el.addEventListener(n, f);
            }
            timer = setTimeout(() => done(null), ms);
        });
    }

    /** Opens a muted <video> on a file. -> { v, release() } once metadata is there (duration made finite). */
    async function openVideo(path) {
        const src = await App.fs.url(path);
        const v = document.createElement('video');
        v.muted = true;
        v.preload = 'auto';
        v.playsInline = true;
        const release = () => {
            v.removeAttribute('src');
            try {
                v.load();
            } catch (e) {
                /* gone */
            }
            src.release();
        };
        v.src = src.url;
        const ev = await waitEvent(v, ['loadedmetadata', 'error'], 10000);
        if (ev !== 'loadedmetadata' || !v.videoWidth) {
            release();
            return null;
        }
        if (!Number.isFinite(v.duration) || v.duration <= 0) {
            // MediaRecorder / some downloads have no duration in the header: seek far to the end to learn it
            const p = waitEvent(v, ['durationchange', 'seeked'], 6000);
            v.currentTime = 1e7;
            await p;
            for (let i = 0; i < 20 && !Number.isFinite(v.duration); i++) await App.util.sleep(50);
        }
        if (!Number.isFinite(v.duration) || v.duration <= 0) {
            release();
            return null;
        }
        return { v, release };
    }

    async function seek(v, t) {
        if (Math.abs(v.currentTime - t) < 0.0005 && v.readyState >= 2) return true;
        const p = waitEvent(v, ['seeked', 'error'], 8000);
        v.currentTime = t;
        const ev = await p;
        if (ev !== 'seeked') return false;
        if (v.readyState < 2) await waitEvent(v, ['canplay', 'loadeddata'], 3000);
        return true;
    }

    // 9×8 area-averaged gray (limited-range luma like ffmpeg's format=gray, so the flat-frame threshold means the same)
    const GW = 9 * 16;
    const GH = 8 * 16;
    let grayCanvas = null;
    let thumbCanvas = null;

    function frameHash(v) {
        if (!grayCanvas) grayCanvas = document.createElement('canvas');
        grayCanvas.width = GW;
        grayCanvas.height = GH;
        const g = grayCanvas.getContext('2d', { willReadFrequently: true });
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        g.drawImage(v, 0, 0, GW, GH);
        const d = g.getImageData(0, 0, GW, GH).data;
        const px = new Float64Array(72);
        for (let y = 0; y < GH; y++) {
            const row = (y >> 4) * 9;
            for (let x = 0; x < GW; x++) {
                const i = (y * GW + x) * 4;
                px[row + (x >> 4)] += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            }
        }
        let mean = 0;
        for (let i = 0; i < 72; i++) {
            px[i] = 16 + (219 / 255) * (px[i] / 256);
            mean += px[i];
        }
        mean /= 72;
        let varc = 0;
        for (let i = 0; i < 72; i++) varc += (px[i] - mean) ** 2;
        if (Math.sqrt(varc / 72) < 4) return null; // black / single-colour frame
        let hi = 0;
        let lo = 0;
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                const bit = px[row * 9 + col] > px[row * 9 + col + 1] ? 1 : 0;
                if (row < 4) hi = ((hi << 1) | bit) >>> 0;
                else lo = ((lo << 1) | bit) >>> 0;
            }
        }
        return hashHex([hi >>> 0, lo >>> 0]);
    }

    function frameThumb(v) {
        if (!thumbCanvas) thumbCanvas = document.createElement('canvas');
        const w = 160;
        const h = Math.max(40, Math.min(160, Math.round((w * (v.videoHeight || 9)) / (v.videoWidth || 16))));
        thumbCanvas.width = w;
        thumbCanvas.height = h;
        const g = thumbCanvas.getContext('2d');
        g.drawImage(v, 0, 0, w, h);
        return new Promise((resolve) => thumbCanvas.toBlob((b) => resolve(b), 'image/jpeg', 0.72));
    }

    /** Duration + size of a video (no frames). -> { dur, w, h } | null */
    async function probeVideo(item) {
        const meta = App.catalog?.peek(item.path)?.meta;
        if (meta && meta.duration > 0 && meta.w && meta.h) return { dur: +meta.duration, w: meta.w, h: meta.h, from: 'catalog' };
        if (!App.util.browserCanDecode(item.name || P.base(item.path))) return null;
        counters.probe++;
        const o = await openVideo(item.path);
        if (!o) return null;
        const out = { dur: o.v.duration, w: o.v.videoWidth, h: o.v.videoHeight };
        o.release();
        return out;
    }

    /** 5 frame hashes (+ thumbnails). -> { dur, w, h, fr: [hex|null] } | null */
    async function videoFrames(item, { thumbs = true, ws = wsId() } = {}) {
        if (!App.util.browserCanDecode(item.name || P.base(item.path))) return null;
        counters.video++;
        const o = await openVideo(item.path);
        if (!o) return null;
        const { v } = o;
        try {
            const dur = v.duration;
            const fr = [];
            const blobs = [];
            for (const pos of POSITIONS) {
                const t = Math.max(0, Math.min(dur - 0.05, dur * pos));
                if (dur <= 1 || !(await seek(v, t))) {
                    fr.push(null);
                    blobs.push(null);
                    continue;
                }
                fr.push(frameHash(v));
                blobs.push(thumbs ? await frameThumb(v) : null);
            }
            if (thumbs) cache.putFrames(item, blobs, ws).catch(() => {});
            return { dur, w: v.videoWidth, h: v.videoHeight, fr, blobs };
        } finally {
            o.release();
        }
    }

    /** Frame thumbnails for the review strip: cached, else made now. -> [Blob|null] x5 */
    const framePending = new Map();
    async function frameBlobs(item) {
        const ws = wsId();
        const hit = await cache.getFrames(item, ws);
        if (hit && hit.some(Boolean)) return hit;
        const key = `${ws}|${item.path}|${item.size}|${item.mtime}`;
        if (!framePending.has(key)) {
            const p = (async () => {
                if (!App.util.browserCanDecode(item.name || P.base(item.path))) return null;
                const o = await openVideo(item.path);
                if (!o) return null;
                const blobs = [];
                try {
                    for (const pos of POSITIONS) {
                        const t = Math.max(0, Math.min(o.v.duration - 0.05, o.v.duration * pos));
                        blobs.push((await seek(o.v, t)) ? await frameThumb(o.v) : null);
                    }
                } finally {
                    o.release();
                }
                cache.putFrames(item, blobs, ws).catch(() => {});
                return blobs;
            })();
            framePending.set(key, p);
            p.finally(() => framePending.delete(key));
        }
        return framePending.get(key);
    }

    /** Frame-by-frame comparison of two videos under `rules` (no duration check). */
    function compareFrames(fa, fb, rules) {
        const frames = [];
        let compared = 0;
        let matched = 0;
        for (let i = 0; i < POSITIONS.length; i++) {
            const x = fa && fa[i];
            const y = fb && fb[i];
            if (!x || !y) {
                frames.push({ i, bits: null });
                continue;
            }
            const bits = hamHex(x, y);
            compared++;
            if (bits <= rules.frameBits) matched++;
            frames.push({ i, bits });
        }
        return { frames, compared, matched };
    }

    /** Owner's same_video(): score (0 when not the same video). */
    function videoScore(edge, rules) {
        if (!(edge.da > 0 && edge.db > 0)) return 0;
        if (Math.abs(edge.da - edge.db) > durTol(rules, edge.da, edge.db)) return 0;
        let compared = 0;
        let matched = 0;
        for (const f of edge.frames || []) {
            if (f.bits == null) continue;
            compared++;
            if (f.bits <= rules.frameBits) matched++;
        }
        if (compared < rules.minFrames || matched < rules.minFrames) return 0;
        return matched / compared;
    }

    // =================================================================================================
    // Collect: scope → items
    // =================================================================================================
    /**
     * scope = { type: 'folder', path, sub } | { type: 'folders', paths } | { type: 'workspace' } |
     *         { type: 'compare', a: [paths], b: [paths] } | { type: 'paths', paths } ; + roots/compare roots (server only)
     */
    async function collect(scope, { onWait } = {}) {
        if (!App.index.ready) {
            onWait && onWait();
            await App.index.whenReady();
        }
        const store = App.dupes.store;
        await store.ready();
        const seen = new Map();
        const add = (e, side) => {
            if (!e || e.kind !== 'file' || (e.type !== 'image' && e.type !== 'video')) return;
            const prev = seen.get(e.path);
            if (prev) {
                if (side && prev.side && prev.side !== side) prev.side = 'ab';
                return;
            }
            seen.set(e.path, { path: e.path, name: e.name, size: e.size, mtime: e.mtime, type: e.type, ext: e.ext, side: side || null });
        };
        const under = (dir, recursive = true) => App.index.under(dir, { recursive });
        const t = scope.type;
        if (t === 'folder') for (const e of under(scope.path || '', scope.sub !== false)) add(e);
        else if (t === 'folders') for (const d of scope.paths || []) for (const e of under(d)) add(e);
        else if (t === 'compare') {
            for (const d of scope.a || []) for (const e of under(d)) add(e, 'a');
            for (const d of scope.b || []) for (const e of under(d)) add(e, 'b');
        } else if (t === 'paths') {
            for (const p of scope.paths || []) {
                const e = App.index.get(p) || (App.index.folders.includes(p) ? { kind: 'dir', path: p } : null);
                if (e && e.kind === 'dir') for (const x of under(p)) add(x);
                else if (e) add(e);
                else if (App.index.folders.includes(p)) for (const x of under(p)) add(x);
            }
        } else for (const e of App.index.items) add(e);
        let items = [...seen.values()].filter((it) => !store.isExcluded(it.path));
        // Entries listed without stat (fast folder open) get their size/mtime now
        const missing = items.filter((it) => !Number.isFinite(it.size) || !Number.isFinite(it.mtime));
        if (missing.length) {
            await App.util.pool(missing, 16, async (it) => {
                try {
                    const s = await App.fs.stat(it.path);
                    it.size = s.size;
                    it.mtime = s.mtime;
                } catch (e) {
                    it.size = 0;
                }
            });
        }
        items = items.filter((it) => it.size > 0);
        return items;
    }

    // =================================================================================================
    // Fingerprint (incremental)
    // =================================================================================================
    const cancelledError = () => Object.assign(new Error('cancelled'), { cancelled: true });
    // `${kind}|${ws}|${path}|${size}|${mtime}` → promise of { fields, ms }: a scan and the background pre-build share one
    // computation, and each copies the result into its own record.
    const inflight = new Map();

    function shared(key, fn) {
        if (inflight.has(key)) return inflight.get(key);
        const p = Promise.resolve().then(async () => {
            const s = performance.now();
            const fields = await fn();
            return { fields, ms: Math.round(performance.now() - s) };
        });
        inflight.set(key, p);
        p.then(() => inflight.delete(key), () => inflight.delete(key));
        return p;
    }

    /**
     * Make the fingerprints a scan needs. Cached ones are reused; only new/changed files are read.
     * kinds = { exact: true, video: true, image: true } ; focus = path (only what that file needs)
     * -> { recs: Map(path → rec), stats: { reused, made, savedMs, workMs, failed } }
     * Stops (cancelled) when the workspace changes underneath, so nothing is written into another library's cache.
     */
    async function fingerprint(items, opts = {}) {
        const kinds = { exact: true, video: true, image: true, ...(opts.kinds || {}) };
        const rules = normalizeRules(opts.rules);
        const progress = opts.onProgress || (() => {});
        const isCancelled = opts.isCancelled || (() => false);
        const gate = opts.gate || (() => null);
        const focus = opts.focus || null;
        const ws = wsId();
        const check = async () => {
            const g = gate();
            if (g) await g;
            if (isCancelled() || wsId() !== ws) throw cancelledError();
        };
        const t0 = performance.now();
        progress('prepare', 0, items.length);
        const cached = await cache.getMany(items, ws);
        const recs = new Map();
        const stats = { reused: 0, made: 0, savedMs: 0, workMs: 0, failed: 0, files: items.length };
        const touched = new Set();
        const recOf = (it) => {
            let r = recs.get(it.path);
            if (!r) {
                const c = cached.get(it.path);
                r = c ? c : { path: it.path, size: it.size, mtime: it.mtime, e: ENGINE, ms: {} };
                if (!r.ms) r.ms = {};
                recs.set(it.path, r);
            }
            return r;
        };
        for (const it of items) recOf(it);
        const reuse = (r, part) => {
            stats.reused++;
            stats.savedMs += (r.ms && r.ms[part]) || 0;
        };
        let lastFlush = performance.now();
        const flush = async (force) => {
            if (!touched.size || (!force && performance.now() - lastFlush < 3000)) return;
            if (wsId() !== ws) return;
            lastFlush = performance.now();
            const list = [...touched].map((p) => recs.get(p)).filter(Boolean);
            touched.clear();
            await cache.putMany(list, ws);
        };
        /** Run (or join) one computation and copy its fields into this scan's record. */
        const compute = async (it, part, fn) => {
            const r = recOf(it);
            let res;
            try {
                res = await shared(`${part}|${ws}|${it.path}|${it.size}|${it.mtime}`, fn);
            } catch (e) {
                if (e && e.cancelled && (isCancelled() || wsId() !== ws)) throw e;
                res = { fields: { failed: true }, ms: 0 }; // somebody else's cancelled run: count it as not done
            }
            const { failed, ...fields } = res.fields || {};
            if (failed) stats.failed++;
            Object.assign(r, fields);
            r.ms[part] = res.ms;
            stats.workMs += res.ms;
            stats.made++;
            if (!failed || Object.keys(fields).length) touched.add(r.path);
            return r;
        };

        try {
            // ---- exact ----
            if (kinds.exact) {
                const bySize = new Map();
                for (const it of items) {
                    if (!bySize.has(it.size)) bySize.set(it.size, []);
                    bySize.get(it.size).push(it);
                }
                let cands = [];
                for (const list of bySize.values()) {
                    if (list.length < 2) continue;
                    if (focus && !list.some((x) => x.path === focus)) continue;
                    cands.push(...list);
                }
                let done = 0;
                progress('quick', 0, cands.length);
                await App.util.pool(cands, 4, async (it) => {
                    await check();
                    const r = recOf(it);
                    if (r.q) reuse(r, 'q');
                    else {
                        await compute(it, 'q', async () => {
                            counters.quick++;
                            try {
                                const res = await quickHash(await App.fs.getFile(it.path));
                                return res.full ? { q: res.q, f: res.q, fq: true } : { q: res.q };
                            } catch (e) {
                                return { failed: true };
                            }
                        });
                    }
                    progress('quick', ++done, cands.length);
                    await flush();
                });
                const byQ = new Map();
                for (const it of cands) {
                    const r = recOf(it);
                    if (!r.q) continue;
                    const k = `${it.size}|${r.q}`;
                    if (!byQ.has(k)) byQ.set(k, []);
                    byQ.get(k).push(it);
                }
                const needFull = [];
                for (const list of byQ.values()) if (list.length > 1) for (const it of list) needFull.push(it);
                done = 0;
                progress('full', 0, needFull.length);
                await App.util.pool(needFull, 2, async (it) => {
                    await check();
                    const r = recOf(it);
                    if (r.f) {
                        if (!r.fq) reuse(r, 'f');
                    } else {
                        await compute(it, 'f', async () => {
                            counters.full++;
                            try {
                                return { f: await App.organize.kit.fullHash(await App.fs.getFile(it.path), { isCancelled: () => isCancelled() || wsId() !== ws }) };
                            } catch (e) {
                                if (e.cancelled) throw e;
                                return { failed: true };
                            }
                        });
                    }
                    progress('full', ++done, needFull.length);
                    await flush();
                });
                cands = null;
            }

            // ---- video ----
            if (kinds.video) {
                const vids = items.filter((it) => it.type === 'video');
                let done = 0;
                progress('probe', 0, vids.length);
                await App.util.pool(vids, 4, async (it) => {
                    await check();
                    const r = recOf(it);
                    if (r.dur !== undefined) reuse(r, 'd');
                    else {
                        await compute(it, 'd', async () => {
                            const info = await probeVideo(it).catch(() => null);
                            return info ? { dur: info.dur, w: info.w, h: info.h } : { dur: null };
                        });
                    }
                    progress('probe', ++done, vids.length);
                    await flush();
                });
                // Only videos with a duration partner need frames (owner's optimisation)
                const order = vids.filter((it) => recOf(it).dur > 1).sort((a, b) => recOf(a).dur - recOf(b).dur);
                const need = new Set();
                for (let i = 0; i < order.length; i++) {
                    const da = recOf(order[i]).dur;
                    for (let j = i + 1; j < order.length; j++) {
                        const db2 = recOf(order[j]).dur;
                        if (db2 - da > durTol(rules, da, db2)) break;
                        if (focus && order[i].path !== focus && order[j].path !== focus) continue;
                        const ri = recOf(order[i]);
                        const rj = recOf(order[j]);
                        if (ri.f && ri.f === rj.f) continue; // identical bytes: already an exact pair
                        need.add(order[i]);
                        need.add(order[j]);
                    }
                }
                const todo = [...need];
                done = 0;
                progress('frames', 0, todo.length);
                await App.util.pool(todo, 2, async (it) => {
                    await check();
                    const r = recOf(it);
                    if (Array.isArray(r.fr)) reuse(r, 'v');
                    else {
                        await compute(it, 'v', async () => {
                            const res = await videoFrames(it, { ws }).catch(() => null);
                            return res ? { fr: res.fr, dur: res.dur, w: res.w, h: res.h } : { fr: [null, null, null, null, null], failed: true };
                        });
                    }
                    progress('frames', ++done, todo.length);
                    await flush();
                });
            }

            // ---- image ----
            if (kinds.image) {
                const imgs = items.filter((it) => it.type === 'image' && App.util.browserCanDecode(it.name || P.base(it.path)));
                const need = [];
                for (const it of imgs) {
                    const r = recOf(it);
                    if (r.p !== undefined) reuse(r, 'p');
                    else need.push(it);
                }
                let done = 0;
                progress('image', 0, need.length);
                if (need.length) {
                    const pool = new HashPool(Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2))));
                    try {
                        await App.util.pool(need, 8, async (it) => {
                            await check();
                            await compute(it, 'p', async () => {
                                counters.image++;
                                let res = null;
                                try {
                                    res = await pool.hash(await App.fs.getFile(it.path));
                                } catch (e) {
                                    res = null;
                                }
                                return res ? { p: hashHex(res.hl), c: res.color ? colorHex(res.color) : null } : { p: null, c: null, failed: true };
                            });
                            progress('image', ++done, need.length);
                            await flush();
                        });
                    } finally {
                        pool.destroy();
                    }
                }
            }
        } finally {
            await flush(true).catch(() => {});
        }
        stats.ms = Math.round(performance.now() - t0);
        return { recs, stats };
    }

    // =================================================================================================
    // Analyze: candidate pairs (independent of the frame/sure thresholds so the rules preview can replay them)
    // =================================================================================================
    /**
     * -> raw = { items: [member], exactSets: [[path]], edges: [{ a, b, kind: 'video'|'image', da, db, frames, d }] }
     * member = { path, name, size, mtime, type, side, dur, w, h, f?, fr? }
     */
    async function analyze(items, recs, opts = {}) {
        const kinds = { exact: true, video: true, image: true, ...(opts.kinds || {}) };
        const rules = normalizeRules(opts.rules);
        const isCancelled = opts.isCancelled || (() => false);
        let ops = 0;
        const breathe = async () => {
            if (++ops % 4000) return;
            await App.util.sleep(0); // keep the UI responsive with thousands of similar-length videos
            if (isCancelled()) throw cancelledError();
        };
        const focus = opts.focus || null;
        const members = items.map((it) => {
            const r = recs.get(it.path) || {};
            const m = { path: it.path, name: it.name || P.base(it.path), size: it.size, mtime: it.mtime, type: it.type, side: it.side || null };
            if (r.dur) m.dur = Math.round(r.dur * 1000) / 1000;
            if (r.w) m.w = r.w;
            if (r.h) m.h = r.h;
            if (r.f) m.f = r.f;
            if (r.q) m.q = r.q;
            if (Array.isArray(r.fr)) m.fr = r.fr;
            if (!m.w) {
                const meta = App.catalog?.peek(it.path)?.meta;
                if (meta && meta.w) {
                    m.w = meta.w;
                    m.h = meta.h;
                    if (!m.dur && meta.duration) m.dur = meta.duration;
                }
            }
            return m;
        });
        const exactSets = [];
        if (kinds.exact) {
            const byF = new Map();
            for (const m of members) {
                if (!m.f) continue;
                const k = `${m.size}|${m.f}`;
                if (!byF.has(k)) byF.set(k, []);
                byF.get(k).push(m.path);
            }
            for (const list of byF.values()) if (list.length > 1 && (!focus || list.includes(focus))) exactSets.push(list);
        }
        const edges = [];
        if (kinds.video) {
            const order = members.filter((m) => m.type === 'video' && m.dur > 1 && m.fr).sort((a, b) => a.dur - b.dur);
            for (let i = 0; i < order.length; i++) {
                const a = order[i];
                for (let j = i + 1; j < order.length; j++) {
                    const b = order[j];
                    if (b.dur - a.dur > durTol(rules, a.dur, b.dur)) break;
                    if (focus && a.path !== focus && b.path !== focus) continue;
                    if (a.f && a.f === b.f) continue;
                    await breathe();
                    const cmp = compareFrames(a.fr, b.fr, rules);
                    if (!cmp.compared) continue;
                    // keep only pairs the loosest rule (20 bits) could still call a match: the preview can replay them
                    if (!cmp.frames.some((f) => f.bits != null && f.bits <= 20)) continue;
                    edges.push({ a: a.path, b: b.path, kind: 'video', da: a.dur, db: b.dur, frames: cmp.frames.map((f) => f.bits) });
                }
            }
        }
        if (kinds.image) {
            const imgs = members.filter((m) => m.type === 'image' && recs.get(m.path)?.p);
            const tree = new BKTree();
            const hashes = imgs.map((m) => recs.get(m.path).p);
            const colors = imgs.map((m) => hexColor(recs.get(m.path).c));
            hashes.forEach((hh, i) => tree.add(hh, i));
            const reach = Math.min(24, rules.imageBits + 4); // a little beyond the rule so the preview can loosen it
            for (let i = 0; i < imgs.length; i++) {
                tree.query(hashes[i], reach, (j, d) => {
                    if (j <= i) return;
                    if (focus && imgs[i].path !== focus && imgs[j].path !== focus) return;
                    if (imgs[i].f && imgs[i].f === imgs[j].f) return;
                    edges.push({ a: imgs[i].path, b: imgs[j].path, kind: 'image', d, cd: colorDistance(colors[i], colors[j]) });
                });
            }
        }
        // Keep only members that take part in something (smaller saved result)
        const used = new Set();
        for (const s of exactSets) for (const p of s) used.add(p);
        for (const e of edges) {
            used.add(e.a);
            used.add(e.b);
        }
        return { items: members.filter((m) => used.has(m.path)), exactSets, edges, scanned: items.length };
    }

    /** Is this candidate edge a match under `rules`? -> score (0 = no) */
    function edgeScore(e, rules) {
        if (e.unverified) return e.score || 1;
        if (e.kind === 'exact') return 1;
        if (e.kind === 'image') return e.d <= rules.imageBits && (e.cd == null || e.cd <= 18 + rules.imageBits * 2) ? 1 - e.d / 64 : 0;
        if (e.kind === 'video') return videoScore({ da: e.da, db: e.db, frames: (e.frames || []).map((bits) => ({ bits })) }, rules);
        return e.score || 0;
    }

    // =================================================================================================
    // Assemble: raw → groups (exclusions, "중복 아님", compare sides, focus, keep suggestion)
    // =================================================================================================
    function hashStr(s) {
        let h1 = 0x811c9dc5;
        let h2 = 0x01000193;
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            h1 = Math.imul(h1 ^ c, 16777619);
            h2 = Math.imul(h2 ^ c, 2246822507);
        }
        return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
    }

    class UnionFind {
        constructor() {
            this.p = new Map();
        }
        find(x) {
            if (!this.p.has(x)) this.p.set(x, x);
            let r = x;
            while (this.p.get(r) !== r) r = this.p.get(r);
            while (this.p.get(x) !== r) {
                const n = this.p.get(x);
                this.p.set(x, r);
                x = n;
            }
            return r;
        }
        union(a, b) {
            const ra = this.find(a);
            const rb = this.find(b);
            if (ra !== rb) this.p.set(rb, ra);
        }
    }

    const KIND_LABEL = { exact: '똑같은 파일', video: '같은 영상', image: '비슷한 사진' };

    /** Keep order: folder role → resolution → duration → size → shallower path → older → name. */
    function keepOrder(roleOf) {
        const res = (m) => (m.h || 0) * 100000 + (m.w || 0);
        return (a, b) => {
            const ra = roleRank(roleOf(a.path));
            const rb = roleRank(roleOf(b.path));
            return (rb - ra) ||
                (res(b) - res(a)) ||
                (Math.round(b.dur || 0) - Math.round(a.dur || 0)) ||
                ((b.size || 0) - (a.size || 0)) ||
                (a.path.split(/[\\/]/).length - b.path.split(/[\\/]/).length) ||
                ((a.mtime || Infinity) - (b.mtime || Infinity)) ||
                App.util.compareNames(a.path, b.path);
        };
    }
    const roleRank = (r) => (r === 'keep' ? 1 : r === 'remove' ? -1 : 0);

    /** One line on why the suggested file is kept: the rule that decided against the runner-up. */
    function keepWhy(keep, others, roleOf) {
        const next = others[0];
        if (!next) return '';
        const rk = roleRank(roleOf(keep.path));
        const rn = roleRank(roleOf(next.path));
        if (rk !== rn) return rk > 0 ? '보관 폴더에 있어서 남겨요' : '다른 파일이 정리 폴더에 있어서 이걸 남겨요';
        const res = (m) => (m.h || 0) * 100000 + (m.w || 0);
        if (res(keep) !== res(next)) return '해상도가 가장 높아서 남겨요';
        if (Math.round(keep.dur || 0) !== Math.round(next.dur || 0)) return '해상도는 같고, 가장 길어서 남겨요';
        if ((keep.size || 0) !== (next.size || 0)) return '해상도·길이가 같아서 용량이 가장 큰 것을 남겨요';
        if (keep.path.split(/[\\/]/).length !== next.path.split(/[\\/]/).length) return '조건이 같아서 덜 깊은 폴더에 있는 것을 남겨요';
        if ((keep.mtime || 0) !== (next.mtime || 0)) return '조건이 같아서 가장 오래된 파일을 남겨요';
        return '조건이 같아서 이름 순으로 앞선 것을 남겨요';
    }

    /**
     * raw → [group]
     * group = { id, kind, sure, members: [m + {role}], keep, why, evidence: [{a, b, kind, score, dDur, frames}], bytes }
     */
    function assemble(raw, opts = {}) {
        const rules = normalizeRules(opts.rules);
        const store = opts.store || App.dupes.store;
        const roleOf = (p) => store.roleOf(p);
        const gone = opts.gone || null; // Set of paths no longer there
        const byPath = new Map();
        for (const m of raw.items) {
            if (store.isExcluded(m.path) || (gone && gone.has(m.path))) continue;
            byPath.set(m.path, m);
        }
        const uf = new UnionFind();
        const edges = [];
        for (const set of raw.exactSets) {
            const live = set.filter((p) => byPath.has(p));
            const marked = store.pairPaths && live.some((p) => store.pairPaths.has(p));
            if (!marked) {
                // identical bytes: a chain is enough to join them (n-1 edges, not n²)
                for (let i = 1; i < live.length; i++) edges.push({ a: live[0], b: live[i], kind: 'exact', score: 1 });
                continue;
            }
            for (let i = 0; i < live.length; i++) {
                for (let j = i + 1; j < live.length; j++) {
                    if (store.isNotDup(live[i], live[j])) continue;
                    edges.push({ a: live[i], b: live[j], kind: 'exact', score: 1 });
                }
            }
        }
        for (const e of raw.edges) {
            if (!byPath.has(e.a) || !byPath.has(e.b) || store.isNotDup(e.a, e.b)) continue;
            const score = edgeScore(e, rules);
            if (!score) continue;
            edges.push({ ...e, score });
        }
        for (const e of edges) uf.union(e.a, e.b);
        const comps = new Map();
        for (const e of edges) {
            const r = uf.find(e.a);
            if (!comps.has(r)) comps.set(r, { paths: new Set(), edges: [] });
            const c = comps.get(r);
            c.paths.add(e.a);
            c.paths.add(e.b);
            c.edges.push(e);
        }
        const groups = [];
        const cmp = keepOrder(roleOf);
        for (const c of comps.values()) {
            if (c.paths.size < 2) continue;
            const members = [...c.paths].map((p) => ({ ...byPath.get(p), role: roleOf(p) }));
            if (opts.focus && !c.paths.has(opts.focus)) continue;
            if (opts.compare) {
                const sides = new Set(members.map((m) => m.side).filter(Boolean));
                const hasA = sides.has('a') || sides.has('ab');
                const hasB = sides.has('b') || sides.has('ab');
                if (!hasA || !hasB) continue;
            }
            const allExact = c.edges.every((e) => e.kind === 'exact') && members.every((m) => m.f && m.f === members[0].f);
            const kind = allExact ? 'exact' : c.edges.some((e) => e.kind === 'video') ? 'video' : c.edges.some((e) => e.kind === 'image') ? 'image' : 'exact';
            let sure = kind === 'exact';
            if (!sure && kind === 'video' && members.every((m) => m.type === 'video' && m.dur > 0)) {
                const durs = members.map((m) => m.dur);
                sure = Math.max(...durs) - Math.min(...durs) <= rules.sureSec + 1e-6;
            }
            if (c.edges.some((e) => e.unverified)) sure = false;
            members.sort(cmp);
            const keep = members[0];
            const sorted = [...members].sort((a, b) => App.util.compareNames(a.path, b.path));
            const id = 'g' + hashStr(sorted.map((m) => m.path).join('\n'));
            const evidence = c.edges.filter((e) => e.kind !== 'exact').map((e) => ({
                a: e.a,
                b: e.b,
                kind: e.kind,
                score: e.score,
                dDur: e.kind === 'video' ? Math.round(Math.abs(e.da - e.db) * 1000) / 1000 : 0,
                frames: e.kind === 'video' && Array.isArray(e.frames) ? e.frames.map((bits, i) => ({ t: (e.da || 0) * POSITIONS[i], bits })) : undefined,
                d: e.d,
                unverified: e.unverified || undefined,
            }));
            const maxSize = Math.max(...members.map((m) => m.size || 0));
            groups.push({
                id,
                kind,
                kindLabel: KIND_LABEL[kind],
                sure,
                members,
                keep: keep.path,
                why: keepWhy(keep, members.slice(1), roleOf),
                evidence,
                bytes: members.reduce((s, m) => s + (m.size || 0), 0) - (keep.size || 0),
                maxBytes: members.reduce((s, m) => s + (m.size || 0), 0) - maxSize,
            });
        }
        groups.sort((a, b) => (b.sure - a.sure) || (b.bytes - a.bytes) || App.util.compareNames(a.keep, b.keep));
        return groups;
    }

    /** Group id from member paths (the same id assemble() gives). */
    function groupIdOf(paths) {
        return 'g' + hashStr([...paths].sort((a, b) => App.util.compareNames(a, b)).join('\n'));
    }

    /** Do a and b match each other directly under `rules` (not only through a third member)? */
    function directMatch(group, a, b, rules) {
        rules = normalizeRules(rules);
        const e = pairEvidence(group, a, b, rules);
        if (!e) return false;
        if (e.kind === 'exact') return true;
        if (e.unverified) return (e.score || 0) > 0;
        if (e.kind === 'image') return (e.d ?? 99) <= rules.imageBits;
        if (e.kind === 'video') {
            const ma = group.members.find((m) => m.path === a);
            const mb = group.members.find((m) => m.path === b);
            const da = ma?.dur || 0;
            const db = mb?.dur || 0;
            return videoScore({ da, db, frames: e.frames || [] }, rules) > 0;
        }
        return false;
    }

    /** Best evidence between two members (direct edge, or recomputed from their frame hashes). */
    function pairEvidence(group, a, b, rules) {
        rules = normalizeRules(rules);
        const e = group.evidence.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
        const ma = group.members.find((m) => m.path === a);
        const mb = group.members.find((m) => m.path === b);
        if (ma && mb && ma.f && ma.f === mb.f) return { kind: 'exact', score: 1, frames: null };
        if (e && e.kind === 'video') return e;
        if (e) return e;
        if (ma && mb && ma.fr && mb.fr) {
            const c = compareFrames(ma.fr, mb.fr, rules);
            return { kind: 'video', score: c.compared ? c.matched / c.compared : 0, dDur: Math.abs((ma.dur || 0) - (mb.dur || 0)), frames: c.frames.map((f, i) => ({ t: (ma.dur || 0) * POSITIONS[i], bits: f.bits })), indirect: true };
        }
        return null;
    }

    /** Resolution (and length) of group members that don't know it yet: cheap header reads, cached in the catalog. */
    async function enrich(raw, opts = {}) {
        const need = raw.items.filter((m) => !m.root && (!m.w || (m.type === 'video' && !m.dur)));
        let done = 0;
        await App.util.pool(need, 6, async (m) => {
            if (opts.isCancelled && opts.isCancelled()) return;
            const e = App.index?.get(m.path) || { kind: 'file', path: m.path, name: m.name, type: m.type, size: m.size, mtime: m.mtime };
            const info = await App.organize.kit.mediaInfo(e).catch(() => null);
            if (info && info.w) {
                m.w = info.w;
                m.h = info.h;
                if (!m.dur && info.duration) m.dur = info.duration;
            }
            opts.onProgress && opts.onProgress('enrich', ++done, need.length);
        });
    }

    // =================================================================================================
    // Scan (browser) and the server engine v2 adapter
    // =================================================================================================
    function serverV2() {
        const s = App.server;
        return !!(s && s.available && s.dupes && typeof s.dupes.scanV2 === 'function');
    }

    function newScanId() {
        return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    async function scanBrowser(scope, opts = {}) {
        const progress = opts.onProgress || (() => {});
        const items = await collect(scope, { onWait: () => progress('wait', 0, 0) });
        if (opts.isCancelled && opts.isCancelled()) throw cancelledError();
        const { recs, stats } = await fingerprint(items, { ...opts, focus: opts.focus });
        progress('match', 0, 0);
        await App.util.sleep(0);
        const raw = await analyze(items, recs, { kinds: opts.kinds, rules: opts.rules, focus: opts.focus, isCancelled: opts.isCancelled });
        await enrich(raw, opts);
        return { id: newScanId(), at: Date.now(), ws: wsId(), scope, engine: 'browser', kinds: opts.kinds, rules: normalizeRules(opts.rules), focus: opts.focus || null, raw, stats: { ...stats, scanned: items.length } };
    }

    /** Server engine v2 (ARCHITECTURE §8) — same rules and result shape; external roots. */
    async function scanServer(scope, opts = {}) {
        const sd = App.server.dupes;
        const progress = opts.onProgress || (() => {});
        const store = App.dupes.store;
        await store.ready();
        const body = { rules: normalizeRules(opts.rules), exclude: { files: store.data.excludedFiles, folders: store.data.excludedFolders, pairs: store.data.notDuplicates } };
        const kinds = { exact: true, video: true, image: true, ...(opts.kinds || {}) };
        body.kinds = Object.keys(kinds).filter((k) => kinds[k]);
        if (scope.type === 'folder') body.dirs = [scope.path || ''];
        else if (scope.type === 'folders') body.dirs = scope.paths || [];
        else if (scope.type === 'compare') body.compare = { a: [...(scope.a || []), ...(scope.rootsA || [])], b: [...(scope.b || []), ...(scope.rootsB || [])] };
        else if (scope.type === 'paths') body.dirs = scope.paths || [];
        if (scope.roots && scope.roots.length) body.roots = scope.roots;
        if (scope.type === 'compare') body.roots = [...(scope.rootsA || []), ...(scope.rootsB || [])];
        if (scope.type === 'workspace' || (scope.type === 'folders' && !body.dirs.length && body.roots)) {
            /* whole workspace: no dirs */
        }
        let res = await sd.scanV2(body, {
            title: '중복 찾는 중 (로컬 서버)',
            onProgress: (p, msg) => progress('server', typeof p === 'number' ? Math.round(p * 1000) : 0, 1000, msg),
        });
        if (opts.isCancelled && opts.isCancelled()) throw cancelledError();
        if (res && !Array.isArray(res.groups)) {
            const id = res.id || res.jobId || (res.job && res.job.id);
            if (id && typeof App.server.waitJob === 'function') res = await App.server.waitJob(id, { onProgress: (p, msg) => progress('server', Math.round((p || 0) * 1000), 1000, msg) });
            if (res && res.result) res = res.result;
        }
        if (opts.isCancelled && opts.isCancelled()) throw cancelledError();
        const raw = fromServer(res, scope);
        return { id: newScanId(), at: Date.now(), ws: wsId(), scope, engine: 'server', kinds, rules: normalizeRules(opts.rules), focus: opts.focus || null, raw, stats: { scanned: (res && res.stats && (res.stats.files || res.stats.scanned)) || raw.items.length, reused: res?.stats?.reused || 0, made: res?.stats?.made || 0, savedMs: 0 } };
    }

    const normAbs = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    function sideOf(path, root, scope) {
        if (scope.type !== 'compare') return null;
        const inA = (scope.a || []).some((d) => !root && P.isInside(path, d)) || (scope.rootsA || []).some((r) => root && (normAbs(path) + '/').startsWith(normAbs(r) + '/'));
        const inB = (scope.b || []).some((d) => !root && P.isInside(path, d)) || (scope.rootsB || []).some((r) => root && (normAbs(path) + '/').startsWith(normAbs(r) + '/'));
        return inA && inB ? 'ab' : inA ? 'a' : inB ? 'b' : null;
    }

    function fromServer(res, scope) {
        const items = new Map();
        const exactSets = [];
        const edges = [];
        for (const g of (res && res.groups) || []) {
            const paths = [];
            for (const m of g.members || g.items || []) {
                const p = m.path;
                if (!p) continue;
                paths.push(p);
                if (items.has(p)) continue;
                const e = !m.root ? App.index?.get(p) : null;
                items.set(p, {
                    path: p,
                    root: m.root || null,
                    name: (e && e.name) || p.split(/[\\/]/).pop(),
                    size: m.size ?? e?.size ?? 0,
                    mtime: m.mtime ?? e?.mtime ?? 0,
                    type: e?.type || App.util.mediaType(p),
                    side: sideOf(p, m.root, scope),
                    dur: m.duration || undefined,
                    w: m.w || m.width || undefined,
                    h: m.h || m.height || undefined,
                    f: g.kind === 'exact' ? `x:${g.id || exactSets.length}` : undefined,
                });
            }
            if (paths.length < 2) continue;
            if (g.kind === 'exact') {
                exactSets.push(paths);
                continue;
            }
            const ev = Array.isArray(g.evidence) ? g.evidence : [];
            if (!ev.length) {
                // no evidence: keep the server's grouping but never call it 확실 (no bulk clean-up without proof)
                const kind = g.kind === 'image' ? 'image' : 'video';
                for (let i = 1; i < paths.length; i++) edges.push({ a: paths[0], b: paths[i], kind, score: 1, unverified: true });
                continue;
            }
            for (const e of ev) {
                if (g.kind === 'video' && Array.isArray(e.frames)) {
                    const ma = items.get(e.a);
                    const mb = items.get(e.b);
                    const da = ma?.dur || 0;
                    const db2 = mb?.dur || (da ? da + (e.dDur || 0) : 0);
                    const bits = POSITIONS.map((_, i) => (e.frames[i] && e.frames[i].bits != null ? e.frames[i].bits : null));
                    edges.push({ a: e.a, b: e.b, kind: 'video', da, db: db2, frames: bits, server: true });
                } else if (g.kind === 'image') {
                    edges.push({ a: e.a, b: e.b, kind: 'image', d: e.d ?? Math.round((1 - (e.score ?? 1)) * 64), cd: null });
                } else edges.push({ a: e.a, b: e.b, kind: g.kind === 'image' ? 'image' : 'video', score: e.score || 1, unverified: true });
            }
        }
        return { items: [...items.values()], exactSets, edges, scanned: res?.stats?.files || items.size };
    }

    async function scan(scope, opts = {}) {
        const external = (scope.roots && scope.roots.length) || (scope.rootsA && scope.rootsA.length) || (scope.rootsB && scope.rootsB.length);
        const useServer = serverV2() && (opts.useServer !== false || external) && scope.type !== 'paths' && !opts.focus;
        if (external && !serverV2()) throw Object.assign(new Error('다른 드라이브 폴더는 로컬 서버가 켜져 있어야 찾을 수 있어요'), { code: 'ENOSERVER' });
        return useServer ? scanServer(scope, opts) : scanBrowser(scope, opts);
    }

    // =================================================================================================
    // Pre-build fingerprints in the background ('지문 미리 만들기')
    // =================================================================================================
    let prebuildJob = null;

    function prebuild({ quiet = false, scope = { type: 'workspace' }, kinds } = {}) {
        if (prebuildJob && (prebuildJob.state === 'running' || prebuildJob.state === 'paused')) return prebuildJob;
        if (!App.fs.ready) return null;
        let resumeFn = null;
        let resumeP = null;
        const job = App.jobs.start({
            title: '중복검사 지문 미리 만들기',
            total: 0,
            cancellable: true,
            background: true,
            pausable: true,
            kind: 'dupes.fingerprint',
            onPause: () => {
                resumeP = new Promise((r) => (resumeFn = r));
            },
            onResume: () => {
                resumeFn && resumeFn();
                resumeP = null;
            },
        });
        prebuildJob = job;
        const PH = { prepare: '파일 목록 준비', quick: '크기가 같은 파일 확인', full: '내용 끝까지 확인', probe: '영상 길이 확인', frames: '영상 장면 지문', image: '사진 생김새 지문' };
        const ws = wsId();
        (async () => {
            try {
                if (App.server?.available && App.server.dupes && typeof App.server.dupes.fingerprint === 'function' && App.settings.get('dupes.useServer', true)) {
                    job.update(0, { total: 0, detail: '로컬 서버에서 지문을 만드는 중' });
                    await App.server.dupes.fingerprint({ dirs: [''], kinds: ['exact', 'video', 'image'] });
                    job.finish({ server: true });
                    if (!quiet) App.ui.toast('로컬 서버에 중복검사 지문을 만들어 뒀어요', { type: 'success' });
                    App.bus.emit('dupes:fingerprints');
                    return;
                }
                const items = await collect(scope);
                if (job.cancelled || wsId() !== ws) return job.finish();
                const res = await fingerprint(items, {
                    kinds: kinds || { exact: true, video: true, image: true },
                    rules: App.dupes.store.rules(),
                    gate: () => resumeP,
                    isCancelled: () => job.cancelled || wsId() !== ws,
                    onProgress: (phase, done, total) => job.update(done, { total, detail: `${PH[phase] || '준비'} · ${formatCount(done)} / ${formatCount(total)}` }),
                });
                job.finish({ made: res.stats.made, reused: res.stats.reused });
                App.bus.emit('dupes:fingerprints');
                if (!quiet) App.ui.toast(res.stats.made ? `중복검사 지문 ${formatCount(res.stats.made)}개를 새로 만들었어요 · 다음 검사는 더 빨라요` : '중복검사 지문이 모두 준비돼 있어요', { type: 'success' });
            } catch (e) {
                if (e.cancelled || job.cancelled) {
                    job.finish();
                    App.bus.emit('dupes:fingerprints');
                    return;
                }
                console.error('[dupes] pre-build failed', e);
                job.fail(e);
                if (!quiet) App.ui.toast(`지문을 만들지 못했어요: ${e.message || e}`, { type: 'error' });
            }
        })();
        return job;
    }

    // Fingerprints follow moves/renames made inside the app (same bytes)
    App.bus.on('fs:changed', (c) => {
        if (!c.from || !c.to || (c.type !== 'move' && c.type !== 'rename')) return;
        const pairs = c.from.map((f, i) => [f, c.to[i]]).filter(([f, t]) => f && t && f !== t);
        cache.rebase(pairs).catch(() => {});
    });
    App.bus.on('workspace:closed', () => {
        if (prebuildJob && (prebuildJob.state === 'running' || prebuildJob.state === 'paused')) prebuildJob.cancel();
    });

    App.dupes = App.dupes || {};
    App.dupes.engine = {
        ENGINE,
        POSITIONS,
        DEFAULT_RULES,
        KIND_LABEL,
        counters,
        normalizeRules,
        cache,
        collect,
        fingerprint,
        analyze,
        assemble,
        edgeScore,
        pairEvidence,
        directMatch,
        groupIdOf,
        scan,
        scanBrowser,
        scanServer,
        fromServer,
        serverV2,
        prebuild,
        get prebuildJob() {
            return prebuildJob && (prebuildJob.state === 'running' || prebuildJob.state === 'paused') ? prebuildJob : null;
        },
        frameBlobs,
        videoFrames,
        probeVideo,
        quickHash,
        hamHex,
        phashFile: async (file) => hashHex(phashFromGray((await analyzeBlob(file)).gray)),
        formatSaved: (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)}분` : ms >= 1000 ? `${Math.round(ms / 1000)}초` : `${Math.max(0, Math.round(ms))}ms`),
        formatBytes,
    };
})();
