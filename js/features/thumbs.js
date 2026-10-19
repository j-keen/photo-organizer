/*
 * Thumbnail engine v2 (thumbs team).
 *
 *   App.thumbs.get(entry, { size, priority })  -> Promise<url|null>  (object URL owned by the cache — never revoke it)
 *   App.thumbs.peek(entry, size?)              -> url|null synchronously when already in memory
 *   App.thumbs.canThumb(entry)                 -> bool
 *   App.thumbs.prioritize(paths)               -> on-screen paths, in visual order, go first
 *   App.thumbs.invalidate(paths) / regenerate(paths) / clearCache() / pregenerate({ dir }) / stats() / usage()
 *   App.thumbs.settings                         -> schema + accessors for the settings dialog (thumbs.* keys)
 *
 * Pipeline: memory LRU -> IndexedDB (App.thumbStore.idb, LRU + byte limit) -> workspace disk cache
 * (.fluid-organizer/thumbs/v2) -> generate. Images decode in Blob-URL Workers (createImageBitmap + OffscreenCanvas ->
 * webp, resized during decode), falling back to the main thread; video frames come from a small pool of <video>
 * elements. With the local server (backend.thumbUrl) its URLs are used directly.
 * Generation also records media info via App.catalog.setMeta: w, h, dc (average colour), duration, and — during
 * pre-generation / sort — taken, camera, gps, orient from EXIF (vendored exifr) or the MP4/MOV header.
 *
 * Events: 'thumbs:meta' {path, duration, w, h} (video info learned), 'thumbs:ready' {path, size, url, w, h} (generated),
 *         'thumbs:stats' (cache numbers changed), 'thumbs:pregen' {state} (pre-generation started/paused/finished).
 */
(() => {
    'use strict';
    const { h, path: P, clamp, formatCount } = App.util;
    const ui = App.ui;
    const store = App.thumbStore;

    const DEFAULT_SIZE = 360;
    const SIZES = [360, 720, 1440];
    const MEM_LIMIT = 1800;
    const META_V = 1; // bump when readMeta learns new fields so pre-generation fills them in
    const MAX_PIXELS = 200e6;
    const HC = navigator.hardwareConcurrency || 4;
    const LOW_MEM = (navigator.deviceMemory || 8) <= 4;
    const WORKERS = clamp(Math.floor(HC / 2), 1, LOW_MEM ? 2 : 4);
    const SLOTS = { image: WORKERS * 2, video: HC >= 8 && !LOW_MEM ? 3 : 2 };
    const HI = 0;
    const LO = 1;
    const EXIF_EXT = new Set(['jpg', 'jpeg', 'jfif', 'tif', 'tiff', 'heic', 'heif', 'avif', 'png', 'webp']);
    // Tests start with background pre-generation off (a test can turn it on); real users get it on by default.
    const AUTO_DEFAULT = !window.__TEST__;

    // ---------- Settings (per browser, App.settings) ----------
    const LIMIT_CHOICES = [256, 512, 1024, 2048, 4096, 8192];
    const fmtMB = (mb) => (mb >= 1024 ? `${+(mb / 1024).toFixed(1)} GB` : `${mb} MB`);
    const SETTINGS_SCHEMA = [
        {
            key: 'thumbs.autoPregenerate',
            label: '작업 폴더를 열면 썸네일 미리 만들기',
            description: '라이브러리 색인이 끝나면 화면에 없는 사진·영상의 썸네일도 천천히 만들어 둬요. 보고 있는 화면이 항상 먼저예요.',
            type: 'boolean',
            default: AUTO_DEFAULT,
        },
        {
            key: 'thumbs.diskCache',
            label: '작업 폴더에도 썸네일 보관',
            description: '.fluid-organizer/thumbs 폴더에 함께 저장해서 브라우저를 다시 설치해도 바로 보여요.',
            type: 'boolean',
            default: true,
        },
        {
            key: 'thumbs.cacheLimitMB',
            label: '브라우저 썸네일 캐시 용량',
            description: '넘치면 오래 안 본 썸네일부터 지워요.',
            type: 'select',
            unit: 'MB',
            default: 1024,
            min: 64,
            options: LIMIT_CHOICES.map((v) => ({ value: v, label: fmtMB(v) })),
        },
    ];
    const settingDefault = (key) => SETTINGS_SCHEMA.find((s) => s.key === key).default;
    const setting = (key) => App.settings.get(key, settingDefault(key));

    const settings = {
        schema: SETTINGS_SCHEMA,
        keys: { autoPregenerate: 'thumbs.autoPregenerate', diskCache: 'thumbs.diskCache', cacheLimitMB: 'thumbs.cacheLimitMB' },
        get(key) {
            return setting(key);
        },
        set(key, value) {
            App.settings.set(key, value);
        },
        get autoPregenerate() {
            return !!setting('thumbs.autoPregenerate');
        },
        set autoPregenerate(v) {
            App.settings.set('thumbs.autoPregenerate', !!v);
        },
        get diskCache() {
            return setting('thumbs.diskCache') !== false;
        },
        set diskCache(v) {
            App.settings.set('thumbs.diskCache', !!v);
        },
        get cacheLimitMB() {
            return Number(setting('thumbs.cacheLimitMB')) || 1024;
        },
        set cacheLimitMB(v) {
            App.settings.set('thumbs.cacheLimitMB', Math.max(1, Number(v) || 1024));
        },
    };

    // ---------- Helpers ----------
    const counters = { generated: 0, failed: 0, main: 0, framesOnPage: 0, frameRetries: 0, hits: { mem: 0, idb: 0, disk: 0 } };
    const sessionFailed = new Set(); // keys that failed transiently (timeouts) — not retried this session
    const posterSeen = new Map(); // video path -> poster time used for its cache key

    function bucket(size) {
        const s = Number(size) || DEFAULT_SIZE;
        return SIZES.find((x) => s <= x) || SIZES[SIZES.length - 1];
    }

    function metaOf(entryOrPath) {
        const p = typeof entryOrPath === 'string' ? entryOrPath : entryOrPath.path;
        return App.catalog.peek(p)?.meta || {};
    }

    function posterOf(entryOrPath) {
        const t = metaOf(entryOrPath).posterT;
        return typeof t === 'number' && isFinite(t) && t >= 0 ? Math.round(t * 100) / 100 : null;
    }

    function isVideo(entry) {
        return entry.type === 'video' || App.util.mediaType(entry.name) === 'video';
    }

    // name|size|mtime survives moves; entries listed without stat fall back to the path so same-named files never collide
    function keyOf(entry, size = DEFAULT_SIZE) {
        const id = entry.size == null && entry.mtime == null ? `@${entry.path}` : `${entry.name}|${entry.size ?? 0}|${entry.mtime ?? 0}`;
        let key = `v2|${id}|${bucket(size)}`;
        if (isVideo(entry)) {
            const t = posterOf(entry);
            posterSeen.set(entry.path, t);
            if (t != null) key += `|t${t}`;
        }
        return key;
    }

    function serverMode() {
        return !!App.fs.backend && typeof App.fs.backend.thumbUrl === 'function';
    }

    function serverUrl(entry, size) {
        try {
            return App.fs.backend.thumbUrl(entry, bucket(size)) || null;
        } catch (e) {
            return null;
        }
    }

    function canThumbBrowser(entry) {
        return !!entry && entry.kind === 'file' && App.util.browserCanDecode(entry.name);
    }

    function canThumb(entry) {
        if (!entry || entry.kind !== 'file') return false;
        if (serverMode()) return entry.type === 'image' || entry.type === 'video';
        return App.util.browserCanDecode(entry.name);
    }

    function decodeError(message) {
        const e = new Error(message);
        e.decode = true;
        return e;
    }

    function idle(timeout = 500) {
        return new Promise((r) => ('requestIdleCallback' in window ? requestIdleCallback(() => r(), { timeout }) : setTimeout(r, 16)));
    }

    // Drop undefined/NaN fields so a partial result never erases known info
    function cleanPatch(patch) {
        const out = {};
        for (const [k, v] of Object.entries(patch || {})) {
            if (v == null || (typeof v === 'number' && !isFinite(v))) continue;
            out[k] = v;
        }
        return out;
    }

    function same(a, b) {
        return a === b || (a && b && typeof a === 'object' && JSON.stringify(a) === JSON.stringify(b));
    }

    /** Still the same file in the same workspace as when the work started? (meta must never land on another file) */
    function stillValid(ctx) {
        if (ctx.stale || ctx.backend !== App.fs.backend || !App.fs.ready) return false;
        if (App.index.ready) {
            const ie = App.index.get(ctx.entry.path);
            if (!ie) return false;
            if ((ie.size ?? 0) !== (ctx.entry.size ?? 0) || (ie.mtime ?? 0) !== (ctx.entry.mtime ?? 0)) return false;
        }
        return true;
    }

    function commitMeta(ctx, patch) {
        patch = cleanPatch(patch);
        if (!Object.keys(patch).length || !stillValid(ctx)) return false;
        const cur = metaOf(ctx.entry);
        if (Object.keys(patch).every((k) => same(cur[k], patch[k]))) return false;
        App.catalog.setMeta(ctx.entry.path, patch);
        return true;
    }

    // ---------- Memory LRU (object URLs) ----------
    const mem = new Map(); // key -> { url, blob }

    function memGet(key) {
        const v = mem.get(key);
        if (v) {
            mem.delete(key);
            mem.set(key, v);
        }
        return v || null;
    }

    function memPut(key, blob) {
        const cur = memGet(key);
        if (cur) return cur.url;
        const url = URL.createObjectURL(blob);
        mem.set(key, { url, blob });
        while (mem.size > MEM_LIMIT) {
            const [k, v] = mem.entries().next().value;
            mem.delete(k);
            URL.revokeObjectURL(v.url);
        }
        return url;
    }

    function memDrop(key) {
        const v = mem.get(key);
        if (!v) return;
        mem.delete(key);
        URL.revokeObjectURL(v.url);
    }

    // Shared by the worker and the main thread (its source is injected into the worker).
    function averageColor(src) {
        const c = new OffscreenCanvas(4, 4);
        const g = c.getContext('2d', { willReadFrequently: true });
        g.imageSmoothingQuality = 'high';
        g.drawImage(src, 0, 0, 4, 4);
        const d = g.getImageData(0, 0, 4, 4).data;
        let r = 0;
        let gr = 0;
        let b = 0;
        let a = 0;
        for (let i = 0; i < d.length; i += 4) {
            const al = d[i + 3];
            r += d[i] * al;
            gr += d[i + 1] * al;
            b += d[i + 2] * al;
            a += al;
        }
        if (a < 16 * 255 * 0.25) return { dc: null, lum: 0 };
        r /= a;
        gr /= a;
        b /= a;
        const hex = (v) => Math.round(v).toString(16).padStart(2, '0');
        return { dc: '#' + hex(r) + hex(gr) + hex(b), lum: 0.2126 * r + 0.7152 * gr + 0.0722 * b };
    }

    // ---------- Worker (runs in its own thread; built from this function's source) ----------
    function workerMain(MAX_PIXELS) {
        const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
        const u16be = (b, o) => (b[o] << 8) | b[o + 1];
        const u16le = (b, o) => b[o] | (b[o + 1] << 8);
        const u32be = (b, o) => b[o] * 16777216 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
        const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216;
        const i32be = (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
        const str4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

        async function bytesAt(blob, start, length) {
            return new Uint8Array(await blob.slice(start, Math.min(blob.size, start + length)).arrayBuffer());
        }

        function exifOrientation(b, start, end) {
            if (end - start < 8) return 1;
            const le = b[start] === 0x49;
            const r16 = (o) => (le ? u16le(b, o) : u16be(b, o));
            const r32 = (o) => (le ? u32le(b, o) : u32be(b, o));
            const ifd = start + r32(start + 4);
            if (ifd + 2 > end) return 1;
            const n = r16(ifd);
            for (let i = 0; i < n; i++) {
                const e = ifd + 2 + i * 12;
                if (e + 12 > end) break;
                if (r16(e) === 0x0112) {
                    const v = r16(e + 8);
                    return v >= 1 && v <= 8 ? v : 1;
                }
            }
            return 1;
        }

        async function jpegInfo(blob) {
            let base = 0;
            let buf = await bytesAt(blob, 0, 65536);
            const at = async (o, n) => {
                if (o < base || o + n > base + buf.length) {
                    base = o;
                    buf = await bytesAt(blob, o, Math.max(n, 65536));
                }
                return o + n <= base + buf.length ? o - base : -1;
            };
            let off = 2;
            let orient = 1;
            for (let guard = 0; guard < 200; guard++) {
                let i = await at(off, 4);
                if (i < 0 || buf[i] !== 0xff) return null;
                const marker = buf[i + 1];
                if (marker === 0xff) {
                    off++;
                    continue;
                }
                if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
                    off += 2;
                    continue;
                }
                if (marker === 0xd9 || marker === 0xda) return null;
                const len = u16be(buf, i + 2);
                if (len < 2) return null;
                if (SOF.has(marker)) {
                    i = await at(off, 9);
                    if (i < 0) return null;
                    const hgt = u16be(buf, i + 5);
                    const wid = u16be(buf, i + 7);
                    return wid && hgt ? { w: wid, h: hgt, orient } : null;
                }
                if (marker === 0xe1 && orient === 1 && len > 16) {
                    i = await at(off, Math.min(len + 2, 65538));
                    if (i >= 0 && str4(buf, i + 4) === 'Exif' && buf[i + 8] === 0 && buf[i + 9] === 0) {
                        orient = exifOrientation(buf, i + 10, Math.min(buf.length, i + 2 + len));
                    }
                }
                off += 2 + len;
            }
            return null;
        }

        async function sniff(blob) {
            const b = await bytesAt(blob, 0, 64);
            if (b.length < 26) return null;
            if (b[0] === 0xff && b[1] === 0xd8) return jpegInfo(blob);
            if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { w: u32be(b, 16), h: u32be(b, 20), orient: 1 };
            if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { w: u16le(b, 6), h: u16le(b, 8), orient: 1 };
            if (b[0] === 0x42 && b[1] === 0x4d) return { w: Math.abs(u32le(b, 18) | 0), h: Math.abs(u32le(b, 22) | 0), orient: 1 };
            if (str4(b, 0) === 'RIFF' && str4(b, 8) === 'WEBP') {
                const fourcc = str4(b, 12);
                if (fourcc === 'VP8 ') return { w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff, orient: 1 };
                if (fourcc === 'VP8L') return { w: 1 + (b[21] | ((b[22] & 0x3f) << 8)), h: 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)), orient: 1 };
                if (fourcc === 'VP8X') return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)), orient: 1 };
            }
            return null; // AVIF/HEIF/SVG/unknown -> decode to learn the size
        }

        async function thumb(blob, size) {
            let info = null;
            try {
                info = await sniff(blob);
            } catch (e) {
                info = null;
            }
            let w = 0;
            let h = 0;
            let bm;
            let expect = null;
            if (info && info.w > 0 && info.h > 0) {
                const swap = info.orient >= 5;
                w = swap ? info.h : info.w;
                h = swap ? info.w : info.h;
                if (w * h > MAX_PIXELS) throw Object.assign(new Error('image too large'), { decode: true });
                const s = Math.min(1, size / Math.max(w, h));
                const opts = { imageOrientation: 'from-image' };
                if (s < 1) {
                    // Resize while decoding (about twice as fast as decode + draw). Only one side is given so the
                    // browser keeps the aspect ratio even if its idea of the orientation differs from ours.
                    opts.resizeQuality = 'high';
                    expect = [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
                    if (w >= h) opts.resizeWidth = expect[0];
                    else opts.resizeHeight = expect[1];
                }
                bm = await createImageBitmap(blob, opts);
            } else {
                bm = await createImageBitmap(blob, { imageOrientation: 'from-image' });
                w = bm.width;
                h = bm.height;
            }
            const out = await encode(bm, size, expect);
            return { ...out, w, h, orient: info ? info.orient : 1 };
        }

        // Scale (if needed) on a CPU-backed canvas, take the average colour and encode webp. Closes the bitmap.
        // `expect` = [w, h] we asked the decoder for: the browser rounds the free side up, so snap when within 1px.
        async function encode(bm, size, expect) {
            const s = Math.min(1, size / Math.max(bm.width, bm.height));
            let tw = Math.max(1, Math.round(bm.width * s));
            let th = Math.max(1, Math.round(bm.height * s));
            if (expect && Math.abs(bm.width - expect[0]) <= 1 && Math.abs(bm.height - expect[1]) <= 1) [tw, th] = expect;
            const canvas = new OffscreenCanvas(tw, th);
            const g = canvas.getContext('2d', { willReadFrequently: true });
            g.imageSmoothingQuality = 'high';
            g.drawImage(bm, 0, 0, tw, th);
            bm.close();
            const color = averageColor(canvas);
            const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
            return { blob, tw, th, dc: color.dc, lum: color.lum };
        }

        // ISO BMFF (mp4/mov/m4v): duration, display size and creation time without a <video> element
        function walk(b, start, end, fn) {
            let o = start;
            while (o + 8 <= end) {
                let size = u32be(b, o);
                const type = str4(b, o + 4);
                let hdr = 8;
                if (size === 1) {
                    if (o + 16 > end) break;
                    size = u32be(b, o + 8) * 4294967296 + u32be(b, o + 12);
                    hdr = 16;
                } else if (size === 0) size = end - o;
                if (size < hdr) break;
                fn(type, o + hdr, Math.min(o + size, end));
                o += size;
            }
        }

        function rotationOf(a, b2, c, d) {
            const r = (v) => Math.round(v / 65536);
            const [ra, rb, rc, rd] = [r(a), r(b2), r(c), r(d)];
            if (ra === 0 && rb === 1 && rc === -1 && rd === 0) return 90;
            if (ra === -1 && rb === 0 && rc === 0 && rd === -1) return 180;
            if (ra === 0 && rb === -1 && rc === 1 && rd === 0) return 270;
            return 0;
        }

        async function vmeta(blob) {
            const head = await bytesAt(blob, 0, 12);
            if (head.length < 12 || str4(head, 4) !== 'ftyp') return null;
            let off = 0;
            let moov = null;
            for (let i = 0; i < 400 && off + 8 <= blob.size; i++) {
                const b = await bytesAt(blob, off, 16);
                let size = u32be(b, 0);
                let hdr = 8;
                if (size === 1) {
                    size = u32be(b, 8) * 4294967296 + u32be(b, 12);
                    hdr = 16;
                } else if (size === 0) size = blob.size - off;
                if (size < hdr) return null;
                if (str4(b, 4) === 'moov') {
                    moov = [off + hdr, size - hdr];
                    break;
                }
                off += size;
            }
            if (!moov) return null;
            const m = await bytesAt(blob, moov[0], Math.min(moov[1], 262144));
            const out = {};
            walk(m, 0, m.length, (type, s, e) => {
                if (type === 'mvhd' && e - s >= 24) {
                    const v1 = m[s] === 1;
                    const o = s + 4;
                    const created = v1 ? u32be(m, o) * 4294967296 + u32be(m, o + 4) : u32be(m, o);
                    const timescale = v1 ? u32be(m, o + 16) : u32be(m, o + 8);
                    const duration = v1 ? u32be(m, o + 20) * 4294967296 + u32be(m, o + 24) : u32be(m, o + 12);
                    if (timescale && duration && duration !== 0xffffffff) out.duration = duration / timescale;
                    const ms = (created - 2082844800) * 1000;
                    if (created > 0 && ms > Date.UTC(1971, 0, 1) && ms < Date.now() + 366 * 864e5) out.taken = ms;
                } else if (type === 'trak' && !out.w) {
                    let tk = null;
                    let video = false;
                    walk(m, s, e, (t2, s2, e2) => {
                        if (t2 === 'tkhd' && e2 - s2 >= 84) {
                            const o = s2 + 4 + (m[s2] === 1 ? 32 : 20) + 16;
                            tk = { w: Math.round(u32be(m, o + 36) / 65536), h: Math.round(u32be(m, o + 40) / 65536), rotation: rotationOf(i32be(m, o), i32be(m, o + 4), i32be(m, o + 12), i32be(m, o + 16)) };
                        } else if (t2 === 'mdia') {
                            walk(m, s2, e2, (t3, s3, e3) => {
                                if (t3 === 'hdlr' && e3 - s3 >= 12 && str4(m, s3 + 8) === 'vide') video = true;
                            });
                        }
                    });
                    if (tk && video && tk.w && tk.h) {
                        const turn = tk.rotation === 90 || tk.rotation === 270;
                        out.w = turn ? tk.h : tk.w;
                        out.h = turn ? tk.w : tk.h;
                        if (tk.rotation) out.rotation = tk.rotation;
                    }
                }
            });
            return out;
        }

        async function dominant(blob) {
            const bm = await createImageBitmap(blob);
            const c = averageColor(bm);
            bm.close();
            return c;
        }

        self.onmessage = async (e) => {
            const { id, op, blob, size, bitmap } = e.data;
            try {
                let result;
                if (op === 'thumb') result = await thumb(blob, size);
                else if (op === 'encode') result = await encode(bitmap, size);
                else if (op === 'sniff') result = await sniff(blob);
                else if (op === 'vmeta') result = await vmeta(blob);
                else if (op === 'dc') result = await dominant(blob);
                else throw new Error('unknown op ' + op);
                self.postMessage({ id, ok: true, result });
            } catch (err) {
                self.postMessage({ id, ok: false, error: String((err && err.message) || err), decode: !!(err && (err.decode || err.name === 'InvalidStateError' || err.name === 'EncodingError')) });
            }
        };
    }

    const workers = {
        list: [],
        ok: null, // null = not tried yet, true = running, false = unavailable (main-thread fallback)
        url: null,
        seq: 0,
        calls: new Map(),
        crashes: 0,

        ensure() {
            if (workers.ok !== null) return workers.ok;
            try {
                if (typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function') throw new Error('unsupported');
                const src = `'use strict';\nconst averageColor = ${averageColor.toString()};\n(${workerMain.toString()})(${MAX_PIXELS});`;
                workers.url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
                for (let i = 0; i < WORKERS; i++) workers.spawn();
                workers.ok = true;
            } catch (e) {
                console.info('[thumbs] workers unavailable, decoding on the main thread', e && e.message);
                workers.ok = false;
            }
            return workers.ok;
        },

        spawn() {
            const rec = { w: new Worker(workers.url, { name: 'fi-thumbs' }), busy: 0 };
            rec.w.onmessage = (e) => {
                const call = workers.calls.get(e.data.id);
                if (!call) return;
                workers.calls.delete(e.data.id);
                clearTimeout(call.timer);
                rec.busy = Math.max(0, rec.busy - 1);
                if (e.data.ok) call.resolve(e.data.result);
                else call.reject(Object.assign(new Error(e.data.error), { decode: e.data.decode }));
            };
            rec.w.onerror = (ev) => {
                ev.preventDefault?.();
                workers.crash(rec);
            };
            workers.list.push(rec);
            return rec;
        },

        // A worker died (or never started): fail its calls over to the main thread, replace it or give up.
        crash(rec) {
            for (const [id, call] of [...workers.calls]) {
                if (call.rec !== rec) continue;
                workers.calls.delete(id);
                clearTimeout(call.timer);
                call.reject(Object.assign(new Error('worker crashed'), { workerDown: true }));
            }
            try {
                rec.w.terminate();
            } catch (e) {
                /* gone */
            }
            workers.list = workers.list.filter((r) => r !== rec);
            if (++workers.crashes > 3) {
                for (const r of workers.list) r.w.terminate();
                workers.list = [];
                workers.ok = false;
                console.info('[thumbs] workers keep failing, decoding on the main thread');
            } else if (workers.ok) {
                workers.spawn();
            }
        },

        run(msg, timeout = 30000, transfer = []) {
            if (!workers.ensure() || !workers.list.length) return Promise.reject(Object.assign(new Error('no worker'), { workerDown: true }));
            const rec = workers.list.reduce((a, b) => (b.busy < a.busy ? b : a));
            const id = ++workers.seq;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    workers.calls.delete(id);
                    rec.busy = Math.max(0, rec.busy - 1);
                    reject(Object.assign(new Error('worker timeout'), { timeout: true }));
                }, timeout);
                workers.calls.set(id, { resolve, reject, timer, rec });
                rec.busy++;
                try {
                    rec.w.postMessage({ ...msg, id }, transfer);
                } catch (e) {
                    workers.calls.delete(id);
                    clearTimeout(timer);
                    rec.busy = Math.max(0, rec.busy - 1);
                    reject(Object.assign(e, { workerDown: true }));
                }
            });
        },
    };

    // Main-thread encoder (fallback). A CPU-backed canvas avoids the GPU read-back that otherwise blocks the page
    // for 100ms+ the first time.
    async function encodeOnMain(src, tw, th) {
        const canvas = new OffscreenCanvas(tw, th);
        const g = canvas.getContext('2d', { willReadFrequently: true });
        g.imageSmoothingQuality = 'high';
        g.drawImage(src, 0, 0, tw, th);
        const color = averageColor(canvas);
        const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
        return { blob, dc: color.dc, lum: color.lum };
    }

    // ---------- Image thumbnails ----------
    async function imageThumbMain(file, size) {
        counters.main++;
        let src;
        let w;
        let hgt;
        let done = () => {};
        try {
            const bm = await createImageBitmap(file, { imageOrientation: 'from-image' });
            src = bm;
            w = bm.width;
            hgt = bm.height;
            done = () => bm.close();
        } catch (e) {
            // SVG and a few odd files only decode through <img>
            const url = URL.createObjectURL(file);
            try {
                const img = new Image();
                img.decoding = 'async';
                img.src = url;
                await img.decode();
                src = img;
                w = img.naturalWidth || 300;
                hgt = img.naturalHeight || 150;
            } catch (e2) {
                throw decodeError('image decode failed');
            } finally {
                setTimeout(() => URL.revokeObjectURL(url), 0);
            }
        }
        try {
            if (w * hgt > MAX_PIXELS) throw decodeError('image too large');
            const s = Math.min(1, size / Math.max(w, hgt));
            const out = await encodeOnMain(src, Math.max(1, Math.round(w * s)), Math.max(1, Math.round(hgt * s)));
            return { ...out, w, h: hgt };
        } finally {
            done();
        }
    }

    let heavyBusy = 0; // big files decode one at a time (memory)
    const heavyWaiters = [];

    async function imageThumb(t) {
        const file = await t.backend.getFile(t.entry.path);
        const heavy = file.size > 24 * 1024 * 1024;
        if (heavy) {
            while (heavyBusy) await new Promise((r) => heavyWaiters.push(r));
            heavyBusy++;
        }
        try {
            if (t.entry.ext !== 'svg' && workers.ensure()) {
                try {
                    return await workers.run({ op: 'thumb', blob: file, size: t.size }, 45000);
                } catch (e) {
                    if (e.timeout) throw e;
                    // decode failures and dead workers get one more chance on the main thread (<img> path)
                }
            }
            return await imageThumbMain(file, t.size);
        } finally {
            if (heavy) {
                heavyBusy--;
                heavyWaiters.shift()?.();
            }
        }
    }

    // ---------- Video thumbnails (main thread, pooled <video> elements) ----------
    const idleVideos = [];
    let videoBusy = 0;
    const videoWaiters = [];

    async function withVideo(fn) {
        while (videoBusy >= SLOTS.video) await new Promise((r) => videoWaiters.push(r));
        videoBusy++;
        const v = idleVideos.pop() || Object.assign(document.createElement('video'), { muted: true, playsInline: true, preload: 'auto' });
        v.muted = true;
        try {
            return await fn(v);
        } finally {
            try {
                v.removeAttribute('src');
                v.load();
            } catch (e) {
                /* ignore */
            }
            if (idleVideos.length < SLOTS.video) idleVideos.push(v);
            videoBusy--;
            videoWaiters.shift()?.();
        }
    }

    function mediaEvent(v, name, timeout) {
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timer);
                v.removeEventListener(name, ok);
                v.removeEventListener('error', bad);
            };
            const ok = () => {
                cleanup();
                resolve();
            };
            const bad = () => {
                cleanup();
                const code = v.error && v.error.code;
                reject(code === 3 || code === 4 ? decodeError(`video decode failed (${code})`) : new Error('video load failed'));
            };
            const timer = setTimeout(() => {
                cleanup();
                reject(Object.assign(new Error(`video ${name} timeout`), { timeout: true }));
            }, timeout);
            v.addEventListener(name, ok);
            v.addEventListener('error', bad);
        });
    }

    async function loadVideo(v, url) {
        const meta = mediaEvent(v, 'loadedmetadata', 12000);
        v.src = url;
        await meta;
        let duration = v.duration;
        if (!isFinite(duration) || duration <= 0) {
            // MediaRecorder/streamed WebM has no duration until you seek past the end
            try {
                const seeked = mediaEvent(v, 'seeked', 5000);
                v.currentTime = 1e101;
                await seeked;
            } catch (e) {
                /* keep unknown */
            }
            duration = v.duration;
        }
        return isFinite(duration) && duration > 0 ? duration : null;
    }

    // After a seek the frame is usually there already; otherwise wait for any sign of data (loadeddata fires only once)
    function waitForFrame(v, timeout) {
        if (v.readyState >= 2) return Promise.resolve();
        return new Promise((resolve) => {
            const names = ['loadeddata', 'canplay', 'canplaythrough', 'timeupdate'];
            const done = () => {
                clearTimeout(timer);
                for (const n of names) v.removeEventListener(n, done);
                resolve();
            };
            for (const n of names) v.addEventListener(n, done);
            const timer = setTimeout(done, timeout);
        });
    }

    async function seekVideo(v, t) {
        const seeked = mediaEvent(v, 'seeked', 8000);
        v.currentTime = t;
        await seeked;
        await waitForFrame(v, 1500);
    }

    // The scaled frame goes to a worker for colour + webp encoding. Some frames can't be wrapped in an ImageBitmap
    // (Chrome reports "image source is not usable", seen with the first software-decoded video of a page); those are
    // drawn on the page instead. Video frames are opaque, so a capture without colour was a blank frame: never cache it.
    async function grabFrame(v, size) {
        const s = Math.min(1, size / Math.max(v.videoWidth, v.videoHeight));
        const tw = Math.max(1, Math.round(v.videoWidth * s));
        const th = Math.max(1, Math.round(v.videoHeight * s));
        let out = null;
        if (workers.ensure()) {
            try {
                const bitmap = await createImageBitmap(v, { resizeWidth: tw, resizeHeight: th, resizeQuality: 'high' });
                out = await workers.run({ op: 'encode', bitmap, size }, 20000, [bitmap]);
            } catch (e) {
                if (e.timeout) throw e;
                out = null; // draw it on the page below
            }
        }
        if (!out || !out.dc) {
            if (out) {
                // Blank capture (decoder still warming up): give it a moment and take the frame again
                counters.frameRetries++;
                await App.util.sleep(150);
                await seekVideo(v, Math.max(0, v.currentTime - 0.001));
            } else {
                counters.framesOnPage++;
            }
            out = await encodeOnMain(v, tw, th);
            if (!out.dc) throw Object.assign(new Error('blank video frame'), { retry: true });
        }
        return { blob: out.blob, dc: out.dc, dark: out.lum < 14 };
    }

    async function videoThumb(t) {
        const src = await t.backend.url(t.entry.path);
        try {
            return await withVideo(async (v) => {
                const duration = await loadVideo(v, src.url);
                const w = v.videoWidth;
                const hgt = v.videoHeight;
                if (!w || !hgt) throw decodeError('no video track');
                const poster = posterOf(t.entry);
                // Poster frame chosen in the viewer, else 10% in (max 3s) like the server does
                let at = poster != null ? poster : duration ? Math.min(3, duration * 0.1) : 0;
                if (duration) at = clamp(at, 0, Math.max(0, duration - 0.05));
                await seekVideo(v, at);
                let frame = await grabFrame(v, t.size);
                if (poster == null && frame.dark && duration && duration > 2) {
                    // Fade-in from black: try a later frame once
                    await seekVideo(v, Math.min(duration * 0.4, duration - 0.2));
                    const second = await grabFrame(v, t.size);
                    if (!second.dark) frame = second;
                }
                return { blob: frame.blob, w, h: hgt, duration, dc: frame.dc };
            });
        } finally {
            src.release();
        }
    }

    async function videoInfoFromElement(entry, backend) {
        const src = await backend.url(entry.path);
        try {
            return await withVideo(async (v) => {
                v.preload = 'metadata';
                const duration = await loadVideo(v, src.url);
                v.preload = 'auto';
                return { w: v.videoWidth || undefined, h: v.videoHeight || undefined, duration: duration || undefined };
            });
        } finally {
            src.release();
        }
    }

    // ---------- Metadata (EXIF via vendored exifr, MP4/MOV header) ----------
    let exifrPromise = null;

    function loadExifr() {
        if (window.exifr) return Promise.resolve(window.exifr);
        if (!exifrPromise) {
            exifrPromise = new Promise((resolve) => {
                const s = document.createElement('script');
                s.src = 'vendor/exifr.full.umd.js';
                s.onload = () => resolve(window.exifr || null);
                s.onerror = () => resolve(null);
                document.head.append(s);
            });
        }
        return exifrPromise;
    }

    const EXIF_OPTS = {
        tiff: true,
        exif: true,
        gps: true,
        ifd1: false,
        interop: false,
        xmp: false,
        icc: false,
        iptc: false,
        jfif: false,
        ihdr: false,
        translateValues: false,
        reviveValues: true,
        mergeOutput: true,
        silentErrors: true,
        pick: ['Make', 'Model', 'Orientation', 'DateTimeOriginal', 'CreateDate', 'GPSLatitude', 'GPSLatitudeRef', 'GPSLongitude', 'GPSLongitudeRef'],
    };

    function cameraName(make, model) {
        make = String(make || '').replace(/\0/g, '').trim();
        model = String(model || '').replace(/\0/g, '').trim();
        if (!make) return model || undefined;
        if (!model) return make;
        const brand = make.split(/\s+/)[0].toLowerCase();
        return model.toLowerCase().startsWith(brand) ? model : `${make} ${model}`;
    }

    async function exifRead(file, ext) {
        if (!EXIF_EXT.has(ext)) return {};
        const exifr = await loadExifr();
        if (!exifr) return {};
        await idle(); // keep the parse off busy frames
        let r;
        try {
            r = await exifr.parse(file, EXIF_OPTS);
        } catch (e) {
            return {};
        }
        if (!r) return {};
        const out = {};
        const date = r.DateTimeOriginal || r.CreateDate;
        if (date instanceof Date && !isNaN(date) && date.getFullYear() > 1900) out.taken = date.getTime();
        const camera = cameraName(r.Make, r.Model);
        if (camera) out.camera = camera.slice(0, 80);
        if (isFinite(r.latitude) && isFinite(r.longitude) && Math.abs(r.latitude) <= 90 && Math.abs(r.longitude) <= 180 && (r.latitude || r.longitude)) {
            out.gps = { lat: Math.round(r.latitude * 1e6) / 1e6, lng: Math.round(r.longitude * 1e6) / 1e6 };
        }
        if (r.Orientation >= 2 && r.Orientation <= 8) out.orient = r.Orientation;
        return out;
    }

    /** Read media info without making a thumbnail. Returns a meta patch ({ mv } at least) or null if unreadable. */
    async function readMeta(entry, { dims = true, backend = App.fs.backend } = {}) {
        let file;
        try {
            file = await backend.getFile(entry.path);
        } catch (e) {
            return null;
        }
        const out = { mv: META_V };
        if (isVideo(entry)) {
            let info = null;
            if (workers.ensure()) info = await workers.run({ op: 'vmeta', blob: file }, 15000).catch(() => null);
            if (info) {
                if (info.taken) out.taken = info.taken;
                if (dims && info.w && info.h) {
                    out.w = info.w;
                    out.h = info.h;
                }
                if (dims && info.duration > 0) out.duration = info.duration;
            }
            if (dims && (!out.w || !out.duration) && App.util.browserCanDecode(entry.name)) {
                const el = await videoInfoFromElement(entry, backend).catch(() => null);
                if (el) Object.assign(out, cleanPatch({ w: out.w || el.w, h: out.h || el.h, duration: out.duration || el.duration }));
            }
        } else {
            if (dims && workers.ensure()) {
                const s = await workers.run({ op: 'sniff', blob: file }, 10000).catch(() => null);
                if (s && s.w > 0 && s.h > 0) {
                    const swap = s.orient >= 5;
                    out.w = swap ? s.h : s.w;
                    out.h = swap ? s.w : s.h;
                }
            }
            Object.assign(out, await exifRead(file, entry.ext || P.ext(entry.name)));
        }
        return out;
    }

    // ---------- Scheduler ----------
    const pending = new Map(); // key -> task (lookup, queued or running)
    const queues = { hi: [], lo: [] };
    const running = { image: 0, video: 0 };
    const runningLo = { image: 0, video: 0 };
    let rank = new Map(); // path -> on-screen order (from prioritize)
    let seq = 0;
    let lastInteraction = 0;
    let loRetry = null;

    const markActive = () => {
        lastInteraction = performance.now();
    };
    for (const ev of ['wheel', 'pointerdown', 'keydown', 'touchmove']) window.addEventListener(ev, markActive, { passive: true, capture: true });
    document.addEventListener('scroll', markActive, { passive: true, capture: true });

    function newTask(entry, size, key, prio) {
        return { key, entry, size, prio, kind: isVideo(entry) ? 'video' : 'image', waiters: [], state: 'new', seq: ++seq, backend: App.fs.backend, stale: false, force: false };
    }

    function begin(t) {
        pending.set(t.key, t);
        if (t.force) {
            enqueue(t);
            return;
        }
        t.state = 'lookup';
        lookup(t).then(
            (blob) => {
                if (t.state !== 'lookup') return; // cancelled meanwhile
                if (blob) settle(t, blob, null);
                else enqueue(t);
            },
            () => t.state === 'lookup' && enqueue(t),
        );
    }

    async function lookup(t) {
        const blob = await store.idb.get(t.key);
        if (blob) {
            counters.hits.idb++;
            return blob;
        }
        if (t.size === DEFAULT_SIZE) {
            const d = await store.disk.read(t.key);
            if (d) {
                counters.hits.disk++;
                store.idb.put(t.key, d);
                return d;
            }
        }
        return null;
    }

    function enqueue(t) {
        t.state = 'queued';
        (t.prio === HI ? queues.hi : queues.lo).push(t);
        pump();
    }

    function upgrade(t) {
        if (t.prio === HI) return;
        t.prio = HI;
        if (t.state === 'queued') {
            const i = queues.lo.indexOf(t);
            if (i >= 0) queues.lo.splice(i, 1);
            queues.hi.push(t);
            pump();
        }
    }

    function takeBest(list, kind) {
        let best = -1;
        let bestRank = Infinity;
        let bestSeq = Infinity;
        for (let i = 0; i < list.length; i++) {
            const t = list[i];
            if (t.kind !== kind) continue;
            const r = rank.has(t.entry.path) ? rank.get(t.entry.path) : 1e9;
            if (r < bestRank || (r === bestRank && t.seq < bestSeq)) {
                best = i;
                bestRank = r;
                bestSeq = t.seq;
            }
        }
        return best < 0 ? null : list.splice(best, 1)[0];
    }

    function pump() {
        for (const kind of ['image', 'video']) {
            while (running[kind] < SLOTS[kind]) {
                const t = takeBest(queues.hi, kind);
                if (!t) break;
                start(t, false);
            }
        }
        if (!queues.lo.length) return;
        if (pregen.paused) return;
        const quietFor = performance.now() - lastInteraction;
        if (quietFor < 350) {
            if (!loRetry) {
                loRetry = setTimeout(() => {
                    loRetry = null;
                    pump();
                }, 380 - quietFor);
            }
            return;
        }
        for (const kind of ['image', 'video']) {
            if (queues.hi.some((t) => t.kind === kind)) continue; // on-screen work first
            const cap = Math.max(1, SLOTS[kind] - 1); // always leave a slot free for what the user is looking at
            while (running[kind] < SLOTS[kind] && runningLo[kind] < cap) {
                const t = takeBest(queues.lo, kind);
                if (!t) break;
                start(t, true);
            }
        }
    }

    function start(t, lowSlot) {
        t.state = 'running';
        t.lowSlot = lowSlot;
        running[t.kind]++;
        if (lowSlot) runningLo[t.kind]++;
        (t.kind === 'video' ? videoThumb(t) : imageThumb(t))
            .then((res) => onGenerated(t, res), (err) => onFailed(t, err))
            .finally(() => {
                running[t.kind]--;
                if (t.lowSlot) runningLo[t.kind]--;
                pump();
            });
    }

    function onGenerated(t, res) {
        if (!res || !(res.blob instanceof Blob)) return onFailed(t, decodeError('no output'));
        counters.generated++;
        store.idb.put(t.key, res.blob);
        if (t.size === DEFAULT_SIZE) store.disk.write(t.key, res.blob);
        const before = metaOf(t.entry);
        const patch = { w: res.w, h: res.h, dc: res.dc };
        if (t.kind === 'video') patch.duration = res.duration;
        if (res.orient > 1) patch.orient = res.orient;
        const changed = commitMeta(t, patch);
        // First time we learn a video's length: the card shows it (contract event; the gallery re-renders that card).
        // Image sizes arrive with 'thumbs:ready' so cards can update in place. Background work off-screen stays quiet.
        const visible = t.prio === HI || App.view.indexOf(t.entry.path) >= 0;
        if (changed && visible && t.kind === 'video' && res.duration && !before.duration) {
            App.bus.emit('thumbs:meta', { path: t.entry.path, duration: res.duration, w: res.w, h: res.h });
        }
        t.generated = true;
        settle(t, res.blob, res);
    }

    function onFailed(t, err) {
        // Transient trouble (e.g. a blank first video frame): try again a little later, twice at most
        if (err && err.retry && (t.attempts || 0) < 2 && !t.stale) {
            t.attempts = (t.attempts || 0) + 1;
            t.state = 'retry';
            setTimeout(() => {
                if (t.state !== 'retry') return;
                if (t.stale || t.backend !== App.fs.backend) settle(t, null, null);
                else enqueue(t);
            }, 500 * t.attempts);
            return;
        }
        counters.failed++;
        if (err && err.code === 'ENOENT') {
            /* the file is gone — nothing to remember */
        } else if (err && err.decode) store.idb.markFailed(t.key);
        else sessionFailed.add(t.key);
        console.debug('[thumbs] no thumbnail for', t.entry.path, err && err.message);
        settle(t, null, null);
    }

    function settle(t, blob, res) {
        if (pending.get(t.key) === t) pending.delete(t.key);
        t.state = 'done';
        let url = null;
        if (blob && t.waiters.some((w) => w.url)) {
            url = memPut(t.key, blob);
            if (res) App.bus.emit('thumbs:ready', { path: t.entry.path, size: t.size, url, w: res.w, h: res.h, duration: res.duration || undefined });
        }
        for (const w of t.waiters) {
            if (w.url) w.url(url);
            else w.done({ ok: !!blob, generated: !!t.generated });
        }
        t.waiters = [];
    }

    function dropQueued(filter) {
        for (const list of [queues.hi, queues.lo]) {
            for (let i = list.length - 1; i >= 0; i--) {
                const t = list[i];
                if (!filter(t)) continue;
                list.splice(i, 1);
                settle(t, null, null);
            }
        }
        for (const t of pending.values()) {
            if (t.state === 'lookup' && filter(t)) settle(t, null, null);
        }
    }

    /** Make sure the default-size thumbnail exists (pre-generation). Resolves { ok, generated, cached }. */
    function ensureThumb(entry, { priority = 'low', force = false, size = DEFAULT_SIZE } = {}) {
        if (!canThumbBrowser(entry)) return Promise.resolve({ ok: false });
        const key = keyOf(entry, size);
        if (!force) {
            if (mem.has(key) || store.idb.has(key) === true || store.disk.has(key) === true) return Promise.resolve({ ok: true, cached: true });
            if (store.idb.isFailed(key) || sessionFailed.has(key)) return Promise.resolve({ ok: false, failed: true });
        }
        return new Promise((resolve) => {
            const cur = pending.get(key);
            if (cur && !force) {
                cur.waiters.push({ done: resolve });
                if (priority === 'high') upgrade(cur);
                return;
            }
            const t = newTask(entry, size, key, priority === 'high' ? HI : LO);
            t.force = force;
            t.waiters.push({ done: resolve });
            begin(t);
        });
    }

    function isCached(entry) {
        if (serverMode()) return true;
        const key = keyOf(entry, DEFAULT_SIZE);
        return mem.has(key) || store.idb.has(key) === true || store.disk.has(key) === true;
    }

    function isSettled(entry) {
        const key = keyOf(entry, DEFAULT_SIZE);
        return isCached(entry) || store.idb.isFailed(key) || sessionFailed.has(key);
    }

    function entryFor(p) {
        return App.view.get(p) || App.index.get(p) || null;
    }

    // ---------- Pre-generation (background job) ----------
    const pregen = { running: false, paused: false, job: null, ctx: null, token: 0, again: false };

    function etaText(ms) {
        const s = Math.round(ms / 1000);
        if (s < 50) return '1분 안에 끝나요';
        const m = Math.round(s / 60);
        if (m < 60) return `약 ${m}분 남음`;
        return `약 ${Math.floor(m / 60)}시간 ${m % 60}분 남음`;
    }

    function setPaused(v) {
        if (!pregen.running || pregen.paused === v) return;
        pregen.paused = v;
        const ctx = pregen.ctx;
        if (ctx) {
            if (v) ctx.pausedAt = performance.now();
            else if (ctx.pausedAt) {
                ctx.pausedMs += performance.now() - ctx.pausedAt;
                ctx.pausedAt = 0;
            }
        }
        if (pregen.job) {
            pregen.job.paused = v;
            pregen.job.update(pregen.job.done, { detail: v ? '일시정지됨 · 다시 시작하면 이어서 만들어요' : ctx ? ctx.detail() : '' });
        }
        App.bus.emit('thumbs:pregen', { state: v ? 'paused' : 'running' });
        if (!v) {
            ctx?.feed();
            pump();
        }
    }

    function cancelPregen() {
        const ctx = pregen.ctx;
        if (!ctx || ctx.cancelled) return;
        ctx.cancelled = true;
        if (pregen.paused) setPaused(false);
        dropQueued((t) => t.prio === LO);
        ctx.feed();
    }

    function orderWork(work) {
        const cwd = App.state.cwd || '';
        const score = (e) => (P.parent(e.path) === cwd ? 0 : cwd && P.isInside(e.path, cwd) ? 1 : 2);
        return work.sort((a, b) => score(a.e) - score(b.e) || (a.e.path < b.e.path ? -1 : a.e.path > b.e.path ? 1 : 0));
    }

    async function pregenerate({ dir = null, force = false, auto = false } = {}) {
        if (!App.fs.ready) return null;
        if (pregen.running) {
            if (auto) pregen.again = true;
            else {
                ui.toast('이미 썸네일을 만들고 있어요', { type: 'info', action: App.commands.get('jobs.activity') ? { label: '작업 현황', run: () => App.commands.run('jobs.activity') } : undefined });
            }
            return null;
        }
        pregen.running = true;
        pregen.paused = false;
        pregen.again = false;
        const token = ++pregen.token;
        const backend = App.fs.backend;
        let job = null;
        try {
            if (!App.index.ready) {
                if (!auto) ui.toast('라이브러리 색인이 끝나면 바로 썸네일을 만들기 시작할게요', { type: 'info' });
                await App.index.whenReady();
            }
            if (token !== pregen.token || backend !== App.fs.backend) return null;
            await store.idb.load();
            if (store.disk.enabled) await store.disk.loadIndex();
            const items = (dir ? App.index.under(dir) : App.index.items).filter((e) => canThumb(e));
            const server = serverMode();
            const work = [];
            for (const e of items) {
                const m = metaOf(e);
                const thumb = !server && (force || !isSettled(e));
                // A colour can only come from a thumbnail, so files that can't be decoded don't keep coming back
                const wantsColour = !server && !m.dc && (thumb || isCached(e));
                const meta = force || (m.mv || 0) < META_V || wantsColour;
                if (thumb || meta) work.push({ e, thumb, meta });
            }
            if (!work.length) {
                if (!auto) ui.toast(dir ? '이 폴더의 썸네일은 모두 준비돼 있어요' : '모든 썸네일이 이미 준비돼 있어요', { type: 'success' });
                return { total: 0, made: 0 };
            }
            orderWork(work);
            const silent = auto && pregen.incremental && work.length < 30;
            const ctx = {
                total: work.length,
                done: 0,
                made: 0,
                failed: 0,
                cancelled: false,
                t0: performance.now(),
                pausedMs: 0,
                pausedAt: 0,
                feed: () => {},
                detail() {
                    const left = ctx.total - ctx.done;
                    const elapsed = performance.now() - ctx.t0 - ctx.pausedMs;
                    const base = `${formatCount(ctx.done)} / ${formatCount(ctx.total)}개`;
                    if (ctx.done < 8 || elapsed < 1500) return base;
                    return `${base} · ${etaText((elapsed / ctx.done) * left)}`;
                },
            };
            pregen.ctx = ctx;
            if (!silent) {
                job = App.jobs.start({ title: '썸네일 만드는 중', total: work.length, cancellable: true, detail: '준비 중…' });
                Object.assign(job, {
                    kind: 'thumbs',
                    background: true, // never blocks closing the tab: it resumes next time
                    pausable: true,
                    paused: false,
                    doneTitle: dir ? `"${P.base(dir)}" 썸네일 미리 만들기` : '썸네일 미리 만들기',
                    pause: () => setPaused(true),
                    resume: () => setPaused(false),
                });
                job.onCancel(cancelPregen);
                pregen.job = job;
            }
            App.bus.emit('thumbs:pregen', { state: 'running', total: work.length });
            const WINDOW = SLOTS.image + SLOTS.video + 2;
            let next = 0;
            let inflight = 0;
            const tick = App.util.throttle(() => job?.update(ctx.done, { detail: pregen.paused ? job.detail : ctx.detail() }), 250);
            await new Promise((resolveAll) => {
                ctx.feed = () => {
                    while (!ctx.cancelled && !pregen.paused && inflight < WINDOW && next < work.length) {
                        const item = work[next++];
                        inflight++;
                        processItem(item, ctx, backend, force)
                            .catch(() => {
                                ctx.failed++;
                            })
                            .finally(() => {
                                inflight--;
                                ctx.done++;
                                tick();
                                ctx.feed();
                            });
                    }
                    if (!inflight && (ctx.cancelled || next >= work.length)) resolveAll();
                };
                ctx.feed();
            });
            if (job) {
                job.update(ctx.done, { detail: ctx.detail() });
                const parts = [];
                if (ctx.made) parts.push(`${formatCount(ctx.made)}개 만듦`);
                if (ctx.done - ctx.made - ctx.failed > 0) parts.push(`${formatCount(ctx.done - ctx.made - ctx.failed)}개 정보 갱신`);
                if (ctx.failed) parts.push(`${formatCount(ctx.failed)}개는 만들 수 없음`);
                job.result = parts.join(' · ') || '완료';
                if (!ctx.cancelled) job.finish();
            }
            if (!auto && !ctx.cancelled && !silent) {
                ui.toast(ctx.made ? `썸네일 ${formatCount(ctx.made)}개를 미리 만들었어요` : '썸네일 정보를 모두 갱신했어요', { type: 'success' });
            }
            if (!ctx.cancelled && sortNeedsRefresh()) App.view.recompute('sort', { background: true });
            return { total: ctx.total, made: ctx.made, failed: ctx.failed, cancelled: ctx.cancelled };
        } catch (e) {
            console.warn('[thumbs] pre-generation stopped', e);
            if (job && job.state === 'running') job.fail(e);
            return null;
        } finally {
            if (token === pregen.token) {
                pregen.running = false;
                pregen.paused = false;
                pregen.job = null;
                pregen.ctx = null;
                pregen.incremental = false;
                App.bus.emit('thumbs:pregen', { state: 'idle' });
                App.bus.emit('thumbs:stats');
                if (pregen.again && settings.autoPregenerate) scheduleIncremental();
            }
        }
    }

    async function processItem(item, ctx, backend, force) {
        const e = item.e;
        const mctx = { entry: e, backend, stale: false };
        if (serverMode()) return serverWarm(e, mctx);
        if (item.thumb) {
            const r = await ensureThumb(e, { priority: 'low', force });
            if (ctx.cancelled) return;
            if (r.generated) ctx.made++;
            else if (!r.ok && !r.cached) ctx.failed++;
        }
        if (!item.meta || ctx.cancelled) return;
        const m = metaOf(e);
        const patch = (m.mv || 0) < META_V || force ? await readMeta(e, { dims: !(m.w && m.h), backend }) : {};
        if (patch === null) return;
        if (!metaOf(e).dc) {
            const key = keyOf(e, DEFAULT_SIZE);
            const blob = mem.get(key)?.blob || (await store.idb.get(key)) || (await store.disk.read(key));
            if (blob && workers.ensure()) {
                const c = await workers.run({ op: 'dc', blob }, 10000).catch(() => null);
                if (c && c.dc) patch.dc = c.dc;
            }
        }
        commitMeta(mctx, patch);
    }

    // With the local server: warm its thumbnail cache and record colour + probe info
    async function serverWarm(e, mctx) {
        const url = serverUrl(e, DEFAULT_SIZE);
        const patch = { mv: META_V };
        if (url && !metaOf(e).dc) {
            try {
                const res = await fetch(url, { credentials: 'same-origin' });
                if (res.ok && workers.ensure()) {
                    const c = await workers.run({ op: 'dc', blob: await res.blob() }, 10000).catch(() => null);
                    if (c && c.dc) patch.dc = c.dc;
                }
            } catch (err) {
                /* server busy — next time */
            }
        }
        const probe = App.server && App.server.media && App.server.media.probe;
        if (typeof probe === 'function') {
            try {
                const p = await probe.call(App.server.media, e.path);
                if (p) Object.assign(patch, { w: p.width, h: p.height, duration: p.duration || undefined, taken: p.taken || undefined, camera: p.camera || undefined });
            } catch (err) {
                /* optional */
            }
        }
        commitMeta(mctx, patch);
    }

    let autoTimer = null;
    let incrementalTimer = null;

    function scheduleAuto(delay = 1500) {
        clearTimeout(autoTimer);
        autoTimer = setTimeout(() => {
            autoTimer = null;
            if (!App.fs.ready || !settings.autoPregenerate || pregen.running) return;
            // Let the first screen's thumbnails and any foreground job go first
            if (queues.hi.length || running.image + running.video > 0 || App.jobs.list().some((j) => !j.background && j.title !== '라이브러리 색인 중')) {
                scheduleAuto(1000);
                return;
            }
            pregenerate({ auto: true });
        }, delay);
    }

    function scheduleIncremental() {
        clearTimeout(incrementalTimer);
        incrementalTimer = setTimeout(() => {
            if (!App.fs.ready || !settings.autoPregenerate || !App.index.ready) return;
            if (pregen.running) {
                pregen.again = true;
                return;
            }
            pregen.incremental = true;
            pregenerate({ auto: true });
        }, 2500);
    }

    // ---------- Sort keys (+ read missing info when the user sorts by them) ----------
    const SORT_KEYS = {
        taken: (e) => metaOf(e).taken || e.mtime || 0,
        resolution: (e) => {
            const m = metaOf(e);
            return (m.w || 0) * (m.h || 0);
        },
        duration: (e) => metaOf(e).duration || 0,
    };
    App.view.registerSortKey('taken', '촬영 날짜', SORT_KEYS.taken);
    App.view.registerSortKey('resolution', '해상도', SORT_KEYS.resolution);
    App.view.registerSortKey('duration', '영상 길이', SORT_KEYS.duration);

    const sortTried = new Set(); // paths whose info was already read this session (never loop)

    function needsSortInfo(e, key) {
        if (e.kind !== 'file' || sortTried.has(e.path)) return false;
        const m = metaOf(e);
        if (key === 'taken') return (m.mv || 0) < META_V;
        if (key === 'resolution') return !(m.w && m.h);
        if (key === 'duration') return isVideo(e) && !m.duration;
        return false;
    }

    function sortNeedsRefresh() {
        return Object.prototype.hasOwnProperty.call(SORT_KEYS, App.view.sort.key);
    }

    let sortFillRunning = false;

    async function fillForSortNow() {
        const key = App.view.sort.key;
        if (!SORT_KEYS[key] || !App.fs.ready || sortFillRunning) return;
        const need = App.view.visible.filter((e) => needsSortInfo(e, key)).slice(0, 20000);
        if (!need.length) return;
        sortFillRunning = true;
        const source = App.view.source;
        const backend = App.fs.backend;
        const label = { taken: '촬영 날짜', resolution: '해상도', duration: '영상 길이' }[key];
        const job = need.length >= 24 ? App.jobs.start({ title: `${label} 정보 읽는 중`, total: need.length, cancellable: true, detail: '정렬에 필요한 정보를 읽고 있어요' }) : null;
        if (job) Object.assign(job, { background: true, kind: 'thumbs-meta', doneTitle: `${label} 정보 읽기` });
        let done = 0;
        try {
            await App.util.pool(need, 4, async (e) => {
                if (job?.cancelled || backend !== App.fs.backend) return;
                sortTried.add(e.path);
                const patch = await readMeta(e, { dims: key !== 'taken' || !(metaOf(e).w && metaOf(e).h), backend });
                if (patch) commitMeta({ entry: e, backend, stale: false }, patch);
                done++;
                job?.update(done);
            });
            if (job && job.state === 'running') {
                job.result = `${formatCount(done)}개 읽음`;
                job.finish();
            }
        } catch (e) {
            if (job && job.state === 'running') job.fail(e);
        } finally {
            sortFillRunning = false;
        }
        // Same place still (a reload replaces the source object, so compare what it points at)
        const cur = App.view.source;
        if (App.view.sort.key === key && cur.type === source.type && cur.path === source.path && backend === App.fs.backend) App.view.recompute('sort', { background: true });
        // Files that appeared meanwhile get their turn
        if (App.view.visible.some((e) => needsSortInfo(e, App.view.sort.key))) fillForSort();
    }

    const fillForSort = App.util.debounce(() => {
        fillForSortNow().catch((e) => console.warn('[thumbs] reading sort info failed', e));
    }, 120);

    // ---------- Card colour placeholders (gallery decorator) ----------
    function decorateCard(card, entry) {
        if (!entry || entry.kind !== 'file' || card.classList.contains('has-thumb') || card.classList.contains('no-thumb') || !canThumb(entry)) return;
        const dc = metaOf(entry).dc;
        if (typeof dc === 'string' && /^#[0-9a-f]{6}$/i.test(dc)) {
            card.style.setProperty('--thumb-dc', dc);
            card.classList.add('thumb-dc');
        } else {
            card.classList.add('thumb-wait');
            const media = card.querySelector('.card-media');
            if (media) media.prepend(h('span', { class: 'thumb-shimmer', 'aria-hidden': 'true' }));
        }
    }

    // ---------- Settings UI (used by the dialog below; the shell team's settings page can embed it) ----------
    function switchEl(checked, onChange, label) {
        const input = h('input', { type: 'checkbox', role: 'switch', 'aria-label': label });
        input.checked = !!checked;
        input.addEventListener('change', () => onChange(input.checked));
        return h('label', { class: 'thumb-switch' }, input, h('span', { class: 'thumb-switch-track', 'aria-hidden': 'true' }));
    }

    function settingsPanel() {
        const usageText = h('span', { class: 'thumb-set-usage-text', text: '계산 중…' });
        const bar = h('div', { class: 'progress thumb-set-meter' }, h('i', { style: { width: '0%' } }));
        const refresh = async () => {
            const u = await thumbs.usage();
            const pct = u.idb.limit ? Math.min(100, (u.idb.bytes / u.idb.limit) * 100) : 0;
            bar.firstChild.style.width = pct.toFixed(1) + '%';
            const parts = [`브라우저 ${App.util.formatBytes(u.idb.bytes)} / ${fmtMB(Math.round(u.idb.limit / 1048576))} · ${formatCount(u.idb.count)}개`];
            if (u.disk.enabled) parts.push(`작업 폴더 ${formatCount(u.disk.count)}개`);
            if (u.coverage) parts.push(`라이브러리 ${Math.round((u.coverage.cached / Math.max(1, u.coverage.total)) * 100)}% 준비`);
            usageText.textContent = parts.join(' · ');
        };
        const row = (label, desc, control) =>
            h('div', { class: 'thumb-set-row' },
                h('div', { class: 'thumb-set-text' }, h('div', { class: 'thumb-set-label', text: label }), desc ? h('div', { class: 'thumb-set-desc', text: desc }) : null),
                control);
        const [autoS, diskS, limitS] = SETTINGS_SCHEMA;
        const select = h('select', { class: 'select thumb-set-select', 'aria-label': limitS.label });
        const cur = settings.cacheLimitMB;
        const choices = LIMIT_CHOICES.includes(cur) ? LIMIT_CHOICES : [...LIMIT_CHOICES, cur].sort((a, b) => a - b);
        for (const v of choices) select.append(h('option', { value: String(v), text: fmtMB(v), selected: v === cur }));
        select.addEventListener('change', () => {
            settings.cacheLimitMB = Number(select.value);
            setTimeout(refresh, 300);
        });
        // Two-step button instead of a confirm dialog: this panel usually lives inside a dialog already
        const clearLabel = h('span', { text: '캐시 비우기' });
        let armed = null;
        const disarm = () => {
            clearTimeout(armed);
            armed = null;
            clearBtn.classList.remove('danger');
            clearLabel.textContent = '캐시 비우기';
        };
        const clearBtn = h('button', {
            class: 'btn sm thumb-set-clear',
            type: 'button',
            onclick: async () => {
                if (!armed) {
                    armed = setTimeout(disarm, 4000);
                    clearBtn.classList.add('danger');
                    clearLabel.textContent = '한 번 더 누르면 비워요';
                    return;
                }
                disarm();
                clearBtn.disabled = true;
                await clearWithToast();
                clearBtn.disabled = false;
                refresh();
            },
        }, h('span', { html: ui.icon('trash', { size: 13 }) }), clearLabel);
        const root = h('div', { class: 'thumb-set' },
            row(autoS.label, autoS.description, switchEl(settings.autoPregenerate, (v) => (settings.autoPregenerate = v), autoS.label)),
            row(diskS.label, diskS.description, switchEl(settings.diskCache, (v) => {
                settings.diskCache = v;
                setTimeout(refresh, 300);
            }, diskS.label)),
            row(limitS.label, limitS.description, select),
            h('div', { class: 'thumb-set-usage' }, h('div', { class: 'row' }, h('span', { class: 'thumb-set-usage-title', text: '사용 중' }), h('span', { class: 'grow' }), clearBtn), bar, usageText));
        refresh();
        const off = App.bus.on('thumbs:stats', App.util.throttle(() => root.isConnected ? refresh() : off(), 800));
        return root;
    }

    // ---------- Public API ----------
    let coverageMemo = null;
    App.bus.on('index:changed', () => (coverageMemo = null));

    const thumbs = {
        DEFAULT_SIZE,
        settings,

        canThumb,

        peek(entry, size = DEFAULT_SIZE) {
            if (!canThumb(entry)) return null;
            const s = typeof size === 'object' && size ? size.size : size;
            if (serverMode()) return serverUrl(entry, s);
            const hit = memGet(keyOf(entry, s));
            if (hit) counters.hits.mem++;
            return hit ? hit.url : null;
        },

        get(entry, { size = DEFAULT_SIZE, priority = 'high' } = {}) {
            if (!canThumb(entry)) return Promise.resolve(null);
            if (serverMode()) return Promise.resolve(serverUrl(entry, size));
            const s = bucket(size);
            const key = keyOf(entry, s);
            const hit = memGet(key);
            if (hit) {
                counters.hits.mem++;
                return Promise.resolve(hit.url);
            }
            if (store.idb.isFailed(key) || sessionFailed.has(key)) return Promise.resolve(null);
            return new Promise((resolve) => {
                const cur = pending.get(key);
                if (cur) {
                    cur.waiters.push({ url: resolve });
                    if (priority !== 'low') upgrade(cur);
                    return;
                }
                const t = newTask(entry, s, key, priority === 'low' ? LO : HI);
                t.waiters.push({ url: resolve });
                begin(t);
            });
        },

        /** On-screen paths in visual order: queued work for them starts first. */
        prioritize(paths) {
            rank = new Map();
            (paths || []).forEach((p, i) => rank.set(p, i));
            pump();
        },

        /** Drop queued (not yet running) on-screen requests for anything not in `paths`. */
        cancelExcept(paths) {
            const keep = new Set(paths || []);
            dropQueued((t) => t.prio === HI && t.state === 'queued' && !keep.has(t.entry.path));
        },

        isCached,
        ensureThumb,
        readMeta,
        keyOf,

        /** Forget in-memory thumbnails for these paths (all sizes) and re-render their cards. */
        invalidate(paths) {
            for (const p of paths || []) {
                const e = entryFor(p);
                if (e && e.kind === 'file') for (const s of SIZES) memDrop(keyOf(e, s));
            }
            App.gallery?.invalidate?.(paths || []);
        },

        /** Throw away cached thumbnails for these files and make them again now. */
        async regenerate(paths) {
            const entries = (paths || []).map(entryFor).filter((e) => e && canThumbBrowser(e));
            if (!entries.length) return 0;
            const keys = [];
            for (const e of entries) {
                for (const s of SIZES) {
                    const k = keyOf(e, s);
                    keys.push(k);
                    memDrop(k);
                    sessionFailed.delete(k);
                }
                store.disk.forget(keyOf(e, DEFAULT_SIZE));
            }
            await store.idb.del(keys);
            const jobs = entries.map((e) => ensureThumb(e, { priority: 'high', force: true }));
            App.gallery?.invalidate?.(entries.map((e) => e.path));
            const results = await Promise.all(jobs);
            App.inspector?.refresh?.();
            return results.filter((r) => r.ok).length;
        },

        pregenerate,
        get pregenerating() {
            return pregen.running;
        },
        get paused() {
            return pregen.paused;
        },
        pause: () => setPaused(true),
        resume: () => setPaused(false),
        cancel: () => (pregen.job ? pregen.job.cancel() : cancelPregen()),

        /** Clear thumbnail caches. opts: { memory = true, idb = true, disk = true }. Resolves { bytes, files }. */
        async clearCache({ memory = true, idb = true, disk = true } = {}) {
            let bytesFreed = 0;
            let files = 0;
            if (memory) {
                for (const v of mem.values()) URL.revokeObjectURL(v.url);
                mem.clear();
            }
            sessionFailed.clear();
            if (idb) bytesFreed = await store.idb.clear();
            if (disk && App.fs.ready) files = await store.disk.clear();
            App.gallery?.refresh?.();
            App.inspector?.refresh?.();
            App.bus.emit('thumbs:stats');
            return { bytes: bytesFreed, files };
        },

        /** Share of the library whose thumbnail is ready (null until the index is built). Memoized briefly. */
        coverage() {
            if (!App.index.ready) return null;
            const now = performance.now();
            const stamp = `${counters.generated}|${store.idb.usage().count}|${store.disk.usage().count}|${mem.size}|${serverMode()}`;
            if (coverageMemo && coverageMemo.stamp === stamp && now - coverageMemo.at < 1500) return { ...coverageMemo.value };
            let total = 0;
            let cached = 0;
            for (const e of App.index.items) {
                if (!canThumb(e)) continue;
                total++;
                if (isCached(e)) cached++;
            }
            coverageMemo = { stamp, at: now, value: { total, cached } };
            return { total, cached };
        },

        async usage() {
            await store.idb.load();
            if (App.fs.ready && store.disk.enabled) await store.disk.loadIndex();
            return { idb: store.idb.usage(), disk: store.disk.usage(), memory: mem.size, coverage: thumbs.coverage(), server: serverMode() };
        },

        stats() {
            return {
                memory: mem.size,
                queued: queues.hi.length + queues.lo.length,
                queuedHigh: queues.hi.length,
                queuedLow: queues.lo.length,
                running: running.image + running.video,
                slots: { ...SLOTS },
                workers: workers.list.length,
                worker: workers.ok === true,
                mainThread: counters.main, // images decoded on the page because no worker could
                framesOnPage: counters.framesOnPage, // video frames drawn on the page (ImageBitmap unavailable)
                frameRetries: counters.frameRetries, // video frames re-taken on the page after a blank capture
                generated: counters.generated,
                failed: counters.failed,
                hits: { ...counters.hits },
                idb: store.idb.usage(),
                disk: store.disk.usage(),
                pregenerating: pregen.running,
                paused: pregen.paused,
                server: serverMode(),
            };
        },

        settingsPanel,

        // Test/diagnostic hooks
        _debug: {
            workers,
            queues,
            pending,
            disableWorkers() {
                for (const r of workers.list) r.w.terminate();
                workers.list = [];
                workers.ok = false;
            },
            sortTried,
            idleVideos,
            flush: () => Promise.all([store.idb.flush(), store.disk.drain()]),
        },
    };

    // ---------- Commands ----------
    const hasThumbSelection = () => App.select.entries().some((e) => e.kind === 'file' && canThumbBrowser(e));

    App.commands.register({
        id: 'thumbs.pregenerate',
        title: '썸네일 미리 만들기',
        group: '썸네일',
        icon: 'image',
        keys: 'Mod+Alt+T',
        when: () => App.fs.ready,
        run: (args) => pregenerate({ dir: args && typeof args.dir === 'string' ? args.dir : null, force: !!(args && args.force) }),
    });
    App.commands.register({
        id: 'thumbs.togglePause',
        get title() {
            return pregen.paused ? '썸네일 만들기 계속하기' : '썸네일 만들기 잠시 멈추기';
        },
        group: '썸네일',
        icon: 'pause',
        keys: 'Mod+Alt+P',
        when: () => pregen.running,
        run: () => setPaused(!pregen.paused),
    });
    App.commands.register({
        id: 'thumbs.cancel',
        title: '썸네일 만들기 그만두기',
        group: '썸네일',
        icon: 'x',
        when: () => pregen.running,
        run: () => thumbs.cancel(),
    });
    App.commands.register({
        id: 'thumbs.regenerate',
        title: '선택한 항목 썸네일 다시 만들기',
        group: '썸네일',
        icon: 'refresh',
        keys: 'Mod+Alt+R',
        when: hasThumbSelection,
        run: async () => {
            const paths = App.select.entries().filter((e) => e.kind === 'file').map((e) => e.path);
            const t = ui.toast('썸네일을 다시 만드는 중…', { type: 'loading' });
            const n = await thumbs.regenerate(paths);
            t.update(n ? `썸네일 ${formatCount(n)}개를 다시 만들었어요` : '썸네일을 만들 수 없는 파일이에요', { type: n ? 'success' : 'warning', duration: 2600 });
        },
    });
    App.commands.register({
        id: 'thumbs.clearCache',
        title: '썸네일 캐시 비우기…',
        group: '썸네일',
        icon: 'trash',
        when: () => true,
        run: async () => {
            const u = await thumbs.usage();
            const ok = await ui.confirm({
                title: '썸네일 캐시를 비울까요?',
                message: `브라우저에 저장된 썸네일 ${formatCount(u.idb.count)}개(${App.util.formatBytes(u.idb.bytes)})${u.disk.enabled && u.disk.count ? `와 작업 폴더의 썸네일 ${formatCount(u.disk.count)}개` : ''}를 지워요. 사진과 영상은 그대로이고, 썸네일은 필요할 때 다시 만들어요.`,
                okLabel: '비우기',
            });
            if (!ok) return;
            await clearWithToast();
        },
    });

    async function clearWithToast() {
        const r = await thumbs.clearCache();
        ui.toast(`썸네일 캐시를 비웠어요${r.bytes ? ` · ${App.util.formatBytes(r.bytes)} 확보` : ''}`, { type: 'success' });
        return r;
    }
    App.commands.register({
        id: 'thumbs.settings',
        title: '썸네일 · 캐시 설정…',
        group: '썸네일',
        icon: 'sliders',
        run: () => ui.dialog({ title: '썸네일 · 캐시', body: settingsPanel(), width: 500, actions: [{ label: '닫기', value: true, kind: 'primary', autofocus: true }] }),
    });

    // ---------- Wiring ----------
    function resetWorkspaceState() {
        clearTimeout(autoTimer);
        clearTimeout(incrementalTimer);
        autoTimer = null;
        incrementalTimer = null;
        if (pregen.running) thumbs.cancel();
        pregen.token++;
        pregen.running = false;
        pregen.paused = false;
        pregen.job = null;
        pregen.ctx = null;
        for (const t of pending.values()) t.stale = true;
        dropQueued(() => true);
        rank = new Map();
        sortTried.clear();
        posterSeen.clear();
    }

    App.bus.on('workspace:opened', resetWorkspaceState);
    App.bus.on('workspace:closed', resetWorkspaceState);

    App.bus.on('index:ready', () => {
        if (settings.autoPregenerate) scheduleAuto();
    });
    App.bus.on('index:changed', () => {
        if (App.index.ready && settings.autoPregenerate && !autoTimer) scheduleIncremental();
    });
    App.bus.on('settings:changed', ({ key, value }) => {
        if (key === 'thumbs.autoPregenerate' && value && App.fs.ready && App.index.ready) scheduleAuto(400);
    });

    App.bus.on('view:changed', ({ reason }) => {
        if ((reason === 'sort' || reason === 'entries') && SORT_KEYS[App.view.sort.key]) fillForSort();
    });

    // Poster frame chosen in the viewer ('이 장면을 썸네일로'): new key -> new frame; refresh cards and folder mosaics
    App.bus.on('catalog:changed', ({ paths }) => {
        const changed = [];
        for (const p of paths || []) {
            if (App.util.mediaType(p) !== 'video' || !posterSeen.has(p)) continue;
            if (posterSeen.get(p) !== posterOf(p)) changed.push(p);
        }
        if (!changed.length) return;
        const all = new Set(changed);
        for (const p of changed) {
            posterSeen.set(p, posterOf(p));
            for (let d = P.parent(p); ; d = P.parent(d)) {
                all.add(d);
                if (!d) break;
            }
        }
        App.gallery?.invalidate?.([...all]);
    });

    App.bus.on('fs:changed', (c) => {
        // Work in flight for files that moved away / changed must not write meta onto the old path
        const touchedPaths = [...(c.from || []), ...(c.type === 'modify' || c.type === 'trash' || c.type === 'delete' ? c.paths || [] : [])];
        if (touchedPaths.length) {
            for (const t of pending.values()) if (touchedPaths.some((p) => P.isInside(t.entry.path, p))) t.stale = true;
        }
        // Renaming a file keeps its thumbnail: copy cache entries over to the new name's key
        if (c.type === 'rename' && c.from && c.to) {
            c.from.forEach((from, i) => {
                const to = c.to[i];
                if (App.util.mediaType(to) === 'other') return;
                const old = App.view.get(from) || App.index.get(to);
                if (!old || old.kind !== 'file') return;
                // path `to` for both: the catalog (poster time) has already moved to the new path
                const before = { ...old, path: to, name: P.base(from) };
                const after = { ...old, path: to, name: P.base(to) };
                for (const s of SIZES) {
                    const oldKey = keyOf(before, s);
                    const newKey = keyOf(after, s);
                    const m = mem.get(oldKey);
                    if (m) memPut(newKey, m.blob);
                    if (store.idb.has(oldKey) !== false) {
                        store.idb.get(oldKey).then((blob) => {
                            if (!blob) return;
                            store.idb.put(newKey, blob);
                            if (s === DEFAULT_SIZE) store.disk.write(newKey, blob);
                        });
                    }
                }
            });
        }
        if (c.type === 'modify') {
            for (const p of c.paths || []) {
                const name = P.base(p);
                for (const k of [...mem.keys()]) if (k.startsWith(`v2|${name}|`)) memDrop(k);
            }
        }
    });

    App.register('thumbs', {
        init() {
            App.gallery?.cardDecorators?.push(decorateCard);
            App.gallery?.contextMenuItems?.push((entries) => {
                const files = entries.filter((e) => e.kind === 'file' && canThumbBrowser(e));
                const dirs = entries.filter((e) => e.kind === 'dir');
                const items = [];
                if (files.length) items.push({ label: files.length > 1 ? `썸네일 다시 만들기 (${formatCount(files.length)}개)` : '썸네일 다시 만들기', icon: 'refresh', command: 'thumbs.regenerate' });
                if (dirs.length === 1 && entries.length === 1 && App.fs.ready) {
                    items.push({ label: '이 폴더 썸네일 미리 만들기', icon: 'image', action: () => App.commands.run('thumbs.pregenerate', { dir: dirs[0].path }) });
                }
                return items;
            });
        },
    });

    App.thumbs = thumbs;
})();
