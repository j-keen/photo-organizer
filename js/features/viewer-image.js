/*
 * Viewer — photos: instant open (cached grid thumbnail first, full image swapped in after decode()),
 * neighbour preloading, zoom/pan/orientation through the shared ViewTransform (viewer-transform.js), and
 * "회전·반전을 파일에 적용":
 *   JPEG — lossless: only the EXIF Orientation tag changes (pixels and the other metadata stay untouched)
 *   PNG  — pixels are rotated/flipped on a canvas and re-encoded (PNG is lossless)
 * The original is copied into the app trash first and the change is ONE undo step.
 *
 *   App.viewer.image                  — active photo view { entry, view, media }
 *   App.viewer.rotateFile.apply(entry) / canApply(entry)
 */
(() => {
    'use strict';
    const { h, path: P, formatBytes, escapeHtml } = App.util;
    const ui = App.ui;
    const V = App.viewer;

    // ---------- Decoded image cache (current + neighbours) ----------
    const CACHE_MAX = 5;
    const cache = new Map(); // key -> { key, path, img, release, done, error, promise, inUse }

    function cacheKey(entry) {
        return `${entry.path}|${entry.size ?? 0}|${entry.mtime ?? 0}`;
    }

    function load(entry) {
        const key = cacheKey(entry);
        let rec = cache.get(key);
        if (rec) {
            cache.delete(key);
            cache.set(key, rec);
            return rec;
        }
        rec = { key, path: entry.path, img: null, release: null, done: false, error: null, inUse: 0 };
        rec.promise = (async () => {
            const src = await App.fs.url(entry.path);
            rec.release = src.release;
            const img = new Image();
            img.decoding = 'async';
            img.draggable = false;
            img.alt = entry.name;
            img.src = src.url;
            await img.decode();
            rec.img = img;
            rec.done = true;
            return img;
        })();
        rec.promise.catch((e) => {
            rec.error = e;
            cache.delete(key);
            try {
                rec.release?.();
            } catch (_) {
                /* ignore */
            }
        });
        cache.set(key, rec);
        trimCache();
        return rec;
    }

    function trimCache() {
        while (cache.size > CACHE_MAX) {
            let victim = null;
            for (const [k, r] of cache) {
                if (!r.inUse) {
                    victim = k;
                    break;
                }
            }
            if (!victim) break;
            const r = cache.get(victim);
            cache.delete(victim);
            try {
                r.release?.();
            } catch (_) {
                /* ignore */
            }
        }
    }

    function clearCache() {
        for (const [k, r] of [...cache]) {
            if (r.inUse) continue;
            cache.delete(k);
            try {
                r.release?.();
            } catch (_) {
                /* ignore */
            }
        }
    }

    // Warm the next/previous photos (direction-aware) once the current one is on screen.
    const preloadSoon = App.util.debounce(() => {
        if (!V.isOpen) return;
        const files = V.files;
        const n = files.length;
        if (n < 2) return;
        const order = V.direction >= 0 ? [1, 2, -1] : [-1, -2, 1];
        for (const off of order) {
            const e = files[(((V.index + off) % n) + n) % n];
            if (e && e !== V.current && e.type === 'image' && App.util.browserCanDecode(e.name)) load(e);
        }
    }, 60);

    // Breathing room around a photo at "fit" (keeps the side arrows off the picture)
    function imagePad() {
        const w = V.stageEl ? V.stageEl.clientWidth : 1200;
        return w > 900 ? { x: 72, y: 18 } : { x: 10, y: 8 };
    }

    // ---------- Photo view ----------
    class ImageView {
        constructor(ctx) {
            this.ctx = ctx;
            this.entry = ctx.entry;
            this.slot = ctx.slot;
            this.full = null;
            this.ph = null;
            this.rec = null;
            this.destroyed = false;
            this.slot.classList.add('vw-image-slot');
            this.view = new V.ViewTransform({
                ctx,
                slot: this.slot,
                path: this.entry.path,
                upscale: false,
                pad: imagePad,
                swipe: true,
                onDoubleTap: (pt) => this.view.toggleZoom(pt),
                // plain wheel: previous/next photo (default) or zoom (setting off / single photo)
                onPlainWheel: (e) => {
                    if (!V.wheelNavigate(e)) this.view.wheelZoom(e);
                },
            });
            this.start();
        }

        get media() {
            return this.full || this.ph || null;
        }

        get frozen() {
            return this.view.frozen;
        }

        set frozen(v) {
            this.view.frozen = !!v;
        }

        start() {
            const entry = this.entry;
            const meta = App.catalog.peek(entry.path)?.meta || {};
            if (!App.util.browserCanDecode(entry.name)) {
                const thumbUrl = App.fs.backend?.thumbUrl ? App.fs.backend.thumbUrl(entry, 2048) : null;
                if (thumbUrl) {
                    // The local server renders HEIC/TIFF/RAW-ish formats for us
                    const img = new Image();
                    img.src = typeof thumbUrl === 'string' ? thumbUrl : thumbUrl.url;
                    img.decode().then(() => {
                        if (this.destroyed) return;
                        this.showFull(img);
                        this.ctx.ready();
                    }, () => this.showUnsupported());
                    return;
                }
                this.showUnsupported();
                return;
            }
            const rec = load(entry);
            rec.inUse++;
            this.rec = rec;
            if (rec.done) {
                this.showFull(rec.img);
                this.ctx.ready();
                return;
            }
            // Instant open: paint the cached grid thumbnail scaled to fit while the full image decodes
            const thumb = App.thumbs?.peek?.(entry);
            if (thumb) {
                const ph = new Image();
                ph.className = 'vw-ph';
                ph.alt = '';
                ph.draggable = false;
                ph.src = thumb;
                ph.decode().then(() => {
                    if (this.destroyed || this.full) return;
                    this.ph = ph;
                    this.slot.append(ph);
                    this.view.setElements([ph]);
                    // real size from the catalog when known, else the thumbnail's aspect (fit makes the scale irrelevant)
                    if (meta.w && meta.h) this.view.setNatural(meta.w, meta.h);
                    else this.view.setNatural(ph.naturalWidth * 64, ph.naturalHeight * 64);
                    this.ctx.ready();
                }, () => {});
            }
            rec.promise.then(
                (img) => {
                    if (this.destroyed) return;
                    this.showFull(img);
                    this.ctx.ready();
                },
                (err) => {
                    if (this.destroyed) return;
                    this.showError(err);
                },
            );
        }

        // Called by the viewer when this slot is the one on screen
        onShown() {
            V.image = this;
            preloadSoon();
        }

        showFull(img) {
            img.classList.add('vw-media', 'vw-img');
            img.classList.remove('vw-ph');
            img.alt = this.entry.name;
            this.full = img;
            const meta = App.catalog.peek(this.entry.path)?.meta;
            if (img.naturalWidth && (!meta || !meta.w || !meta.h) && App.util.browserCanDecode(this.entry.name)) {
                App.catalog.setMeta(this.entry.path, { w: img.naturalWidth, h: img.naturalHeight });
            }
            // (the element may still sit in a previous slot when re-opening the same photo — append moves it)
            this.slot.append(img);
            this.view.setElements(this.ph ? [img, this.ph] : [img]);
            this.view.setNatural(img.naturalWidth || 1, img.naturalHeight || 1, { keepScreenSize: true });
            if (this.ph) {
                const ph = this.ph;
                this.ph = null;
                // remove the placeholder only after the full image has painted (no blank frame)
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    ph.remove();
                    if (!this.destroyed) this.view.setElements([img]);
                }));
            }
        }

        showUnsupported() {
            const e = this.entry;
            this.slot.innerHTML = '';
            const server = !!App.server?.available;
            this.slot.append(V.card({
                icon: 'image',
                title: `${(e.ext || '').toUpperCase()} 사진은 브라우저에서 바로 볼 수 없어요`,
                text: server
                    ? '서버 주소(http://127.0.0.1:8765)에서 작업 폴더를 열면 이 형식도 볼 수 있어요.'
                    : `로컬 서버를 켜면 HEIC·TIFF 같은 형식도 볼 수 있어요. <span class="faint">${escapeHtml(formatBytes(e.size))}</span>`,
            }));
            this.ctx.ready();
        }

        showError(err) {
            this.slot.querySelectorAll('.vw-ph').forEach((n) => n.remove());
            this.ph = null;
            this.slot.append(V.card({
                icon: 'alert',
                tone: 'is-error',
                title: '이 사진을 열 수 없어요',
                text: escapeHtml(err?.name === 'EncodingError' ? '파일이 손상됐거나 지원하지 않는 형식이에요.' : err?.message || String(err)),
                actions: [h('button', {
                    class: 'btn sm',
                    text: '다시 시도',
                    onclick: () => {
                        cache.delete(cacheKey(this.entry));
                        V.reload();
                    },
                })],
            }));
            this.ctx.ready();
        }

        resize() {
            this.view.resize();
        }

        onCatalog() {
            this.view.follow();
        }

        hints() {
            const dk = V.dk;
            return [
                { keys: ['←', '→'], label: '이전/다음' },
                { keys: [dk('Mod')], mouse: true, label: '확대' },
                { keys: ['0'], label: '맞춤' },
                { keys: ['Z'], label: '100%' },
                { keys: ['R'], label: '회전' },
                { keys: ['H', 'V'], label: '반전' },
                { keys: ['I'], label: '정보' },
                { keys: ['S'], label: '슬라이드쇼' },
                { keys: [dk('Delete')], label: '삭제' },
            ];
        }

        deactivate() {
            this.view.finish();
        }

        destroy() {
            this.destroyed = true;
            this.view.destroy();
            if (this.rec) {
                this.rec.inUse = Math.max(0, this.rec.inUse - 1);
                this.rec = null;
            }
            if (V.image === this) V.image = null;
            trimCache();
        }
    }

    V.registerRenderer('image', {
        mount(ctx) {
            return new ImageView(ctx);
        },
    });

    App.bus.on('viewer:closed', () => {
        V.image = null;
        clearCache();
    });
    App.bus.on('fs:changed', (c) => {
        if (c.type !== 'modify') return;
        for (const p of c.paths) for (const [k, r] of [...cache]) if (r.path === p && !r.inUse) cache.delete(k);
    });

    // ---------- Apply the view orientation to the file ----------
    // 2x2 matrices [a, b, c, d] = [[a, b], [c, d]] mapping stored -> displayed pixels (x right, y down).
    const ORIENT_M = { 1: [1, 0, 0, 1], 2: [-1, 0, 0, 1], 3: [-1, 0, 0, -1], 4: [1, 0, 0, -1], 5: [0, 1, 1, 0], 6: [0, -1, 1, 0], 7: [0, -1, -1, 0], 8: [0, 1, -1, 0] };
    const ROT_M = { 0: ORIENT_M[1], 90: ORIENT_M[6], 180: ORIENT_M[3], 270: ORIENT_M[8] };

    function mat(A, B) {
        return [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3]];
    }

    /** Matrix of the view transform (CSS rotate(rot) scale(sx, sy): flip first, then rotate). */
    function viewMatrix(t) {
        return mat(ROT_M[t.rot] || ROT_M[0], [t.flipH ? -1 : 1, 0, 0, t.flipV ? -1 : 1]);
    }

    /** New EXIF orientation after applying view transform t to an image that currently has orientation `cur`. */
    function composeOrientation(cur, t) {
        if (typeof t === 'number') t = { rot: ((t % 360) + 360) % 360 };
        const M = mat(viewMatrix(t), ORIENT_M[cur] || ORIENT_M[1]);
        for (const [k, v] of Object.entries(ORIENT_M)) if (v.every((x, i) => x === M[i])) return Number(k);
        return 1;
    }

    // Find the Exif APP1 segment and the IFD0 Orientation entry of a JPEG.
    function scanJpeg(u8) {
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        if (u8.length < 4 || dv.getUint16(0) !== 0xffd8) throw new Error('JPEG 파일이 아니에요');
        let off = 2;
        let app0End = null;
        while (off + 4 <= u8.length) {
            if (u8[off] !== 0xff) throw new Error('JPEG 구조를 읽을 수 없어요');
            const marker = u8[off + 1];
            if (marker === 0xff) {
                off++;
                continue;
            }
            if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
                off += 2;
                continue;
            }
            if (marker === 0xda || marker === 0xd9) break;
            const len = dv.getUint16(off + 2);
            if (len < 2 || off + 2 + len > u8.length) throw new Error('JPEG 구조를 읽을 수 없어요');
            if (marker === 0xe0 && off === 2) app0End = off + 2 + len;
            if (marker === 0xe1 && len >= 16 && u8[off + 4] === 0x45 && u8[off + 5] === 0x78 && u8[off + 6] === 0x69 && u8[off + 7] === 0x66 && u8[off + 8] === 0 && u8[off + 9] === 0) {
                const tiff = off + 10;
                const le = u8[tiff] === 0x49;
                if (!le && u8[tiff] !== 0x4d) throw new Error('EXIF 바이트 순서를 알 수 없어요');
                const g16 = (p) => dv.getUint16(p, le);
                const g32 = (p) => dv.getUint32(p, le);
                if (g16(tiff + 2) !== 42) throw new Error('EXIF 구조를 읽을 수 없어요');
                const ifd0 = tiff + g32(tiff + 4);
                const segEnd = off + 2 + len;
                if (ifd0 + 2 > segEnd) throw new Error('EXIF 구조를 읽을 수 없어요');
                const n = g16(ifd0);
                if (ifd0 + 2 + n * 12 + 4 > segEnd) throw new Error('EXIF 구조를 읽을 수 없어요');
                let orientAt = null;
                for (let i = 0; i < n; i++) {
                    const e = ifd0 + 2 + i * 12;
                    if (g16(e) === 0x0112) orientAt = e;
                }
                const orientation = orientAt != null ? g16(orientAt + 8) : 1;
                return { exif: { segStart: off, segLen: len, segEnd, tiff, le, ifd0, n, orientAt, orientation: orientation >= 1 && orientation <= 8 ? orientation : 1 }, app0End };
            }
            off += 2 + len;
        }
        return { exif: null, app0End };
    }

    /** Lossless JPEG re-orientation: rewrite (or add) the EXIF Orientation tag. t = view transform. Returns new bytes. */
    function jpegReorient(u8, t) {
        const { exif, app0End } = scanJpeg(u8);
        const next = composeOrientation(exif ? exif.orientation : 1, t);
        if (exif && exif.orientAt != null) {
            const out = u8.slice();
            const dv = new DataView(out.buffer);
            dv.setUint16(exif.orientAt + 2, 3, exif.le); // SHORT
            dv.setUint32(exif.orientAt + 4, 1, exif.le);
            dv.setUint16(exif.orientAt + 8, next, exif.le);
            dv.setUint16(exif.orientAt + 10, 0, exif.le);
            return out;
        }
        if (exif) {
            // IFD0 has no Orientation entry: write a new IFD0 (old entries + Orientation, sorted) at the end of the
            // APP1 segment and point the TIFF header at it. No other offsets move, so maker notes etc. stay valid.
            const src = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
            const { le, tiff, ifd0, n, segStart, segLen, segEnd } = exif;
            const entries = [];
            for (let i = 0; i < n; i++) {
                const e = ifd0 + 2 + i * 12;
                entries.push({ tag: src.getUint16(e, le), bytes: u8.slice(e, e + 12) });
            }
            const oe = new Uint8Array(12);
            const odv = new DataView(oe.buffer);
            odv.setUint16(0, 0x0112, le);
            odv.setUint16(2, 3, le);
            odv.setUint32(4, 1, le);
            odv.setUint16(8, next, le);
            entries.push({ tag: 0x0112, bytes: oe });
            entries.sort((a, b) => a.tag - b.tag);
            const nextIfd = src.getUint32(ifd0 + 2 + n * 12, le);
            const pad = (segEnd - tiff) % 2;
            const ifdLen = 2 + entries.length * 12 + 4;
            const newLen = segLen + pad + ifdLen;
            if (newLen > 0xffff) throw new Error('EXIF 정보가 너무 커서 방향을 기록할 수 없어요');
            const out = new Uint8Array(u8.length + pad + ifdLen);
            out.set(u8.subarray(0, segEnd), 0);
            let p = segEnd + pad;
            const dv = new DataView(out.buffer);
            dv.setUint16(p, entries.length, le);
            p += 2;
            for (const e of entries) {
                out.set(e.bytes, p);
                p += 12;
            }
            dv.setUint32(p, nextIfd, le);
            p += 4;
            out.set(u8.subarray(segEnd), p);
            dv.setUint16(segStart + 2, newLen); // segment length is always big-endian
            dv.setUint32(tiff + 4, segEnd + pad - tiff, le);
            return out;
        }
        // No EXIF at all: insert a minimal APP1 with just the Orientation tag
        if (next === 1) return u8.slice();
        const tiffLen = 8 + 2 + 12 + 4;
        const seg = new Uint8Array(4 + 6 + tiffLen);
        const dv = new DataView(seg.buffer);
        seg[0] = 0xff;
        seg[1] = 0xe1;
        dv.setUint16(2, 2 + 6 + tiffLen);
        seg.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);
        const tf = 10;
        seg.set([0x4d, 0x4d], tf); // big-endian TIFF
        dv.setUint16(tf + 2, 42);
        dv.setUint32(tf + 4, 8);
        dv.setUint16(tf + 8, 1);
        dv.setUint16(tf + 10, 0x0112);
        dv.setUint16(tf + 12, 3);
        dv.setUint32(tf + 14, 1);
        dv.setUint16(tf + 18, next);
        dv.setUint32(tf + 22, 0);
        const at = app0End ?? 2;
        const out = new Uint8Array(u8.length + seg.length);
        out.set(u8.subarray(0, at), 0);
        out.set(seg, at);
        out.set(u8.subarray(at), at + seg.length);
        return out;
    }

    async function canvasReorient(blob, t, type) {
        const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
        const swap = t.rot % 180 !== 0;
        const w = swap ? bmp.height : bmp.width;
        const hh = swap ? bmp.width : bmp.height;
        const c = new OffscreenCanvas(w, hh);
        const g = c.getContext('2d');
        g.translate(w / 2, hh / 2);
        g.rotate((t.rot * Math.PI) / 180);
        g.scale(t.flipH ? -1 : 1, t.flipV ? -1 : 1);
        g.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
        bmp.close();
        return c.convertToBlob(type === 'image/png' ? { type } : { type, quality: 0.95 });
    }

    async function displaySize(blob) {
        const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
        const s = { w: bmp.width, h: bmp.height };
        bmp.close();
        return s;
    }

    // Keep a copy of the original in the app trash (restorable as "<name> (회전 전 원본).<ext>").
    async function backupToTrash(entry, bytes, type) {
        const fsx = App.fs;
        const stem = P.stem(entry.name);
        const ext = P.ext(entry.name);
        const name = `${stem} (회전 전 원본)${ext ? '.' + ext : ''}`;
        const data = new Blob([bytes], { type: type || 'application/octet-stream' });
        if (typeof fsx.trashCopy === 'function') return fsx.trashCopy(entry.path, { name, data }); // future public API
        const batchDir = P.join(fsx.TRASH_DIR, `b${Date.now().toString(36)}r`);
        const trashPath = P.join(batchDir, name);
        await fsx.writeRaw(trashPath, data);
        const peek = App.catalog.peek(entry.path);
        const item = {
            id: App.util.uid('t'),
            name,
            kind: 'file',
            size: bytes.length,
            originalPath: entry.path,
            trashPath,
            deletedAt: Date.now(),
            catalog: peek ? { '': JSON.parse(JSON.stringify(peek)) } : null,
            reason: 'rotate-backup',
        };
        if (typeof fsx._updateTrashManifest === 'function') {
            await fsx._updateTrashManifest((m) => {
                m.items.push(item);
            });
        } else {
            const m = await fsx.readTrashManifest();
            m.items.push(item);
            await fsx.writeJSON(P.join(fsx.TRASH_DIR, 'manifest.json'), m);
        }
        App.bus.emit('trash:changed');
        return item;
    }

    // Catalog side of "apply": the view orientation becomes identity (or comes back on undo); size swaps for 90°/270°.
    function setCatalogAfterApply(path, t, restore) {
        App.catalog.update(path, (e) => {
            const meta = { ...(e.meta || {}) };
            delete meta.rot;
            delete meta.flipH;
            delete meta.flipV;
            if (restore) {
                if (t.rot) meta.rot = t.rot;
                if (t.flipH) meta.flipH = true;
                if (t.flipV) meta.flipV = true;
            }
            if (t.rot % 180 && meta.w && meta.h) [meta.w, meta.h] = [meta.h, meta.w];
            e.meta = meta;
        }, { undoable: false, label: '회전·반전 파일에 적용' });
    }

    async function writeReoriented(entry, t, { lossless = true } = {}) {
        const ext = (entry.ext || P.ext(entry.name)).toLowerCase();
        const isJpeg = ext === 'jpg' || ext === 'jpeg' || ext === 'jfif';
        const file = await App.fs.getFile(entry.path);
        const original = new Uint8Array(await file.arrayBuffer());
        const type = isJpeg ? 'image/jpeg' : 'image/png';
        const originalBlob = new Blob([original], { type });
        let blob;
        let exact = !isJpeg; // PNG re-encode is lossless
        if (isJpeg && lossless) {
            try {
                blob = new Blob([jpegReorient(original, t)], { type });
                exact = true;
            } catch (e) {
                console.warn('[viewer] EXIF orientation failed, re-encoding instead', e);
            }
        }
        if (!blob) blob = await canvasReorient(originalBlob, t, type);
        // Verify the result decodes with the expected size before touching the original
        const before = await displaySize(originalBlob);
        const after = await displaySize(blob);
        const swap = t.rot % 180 !== 0;
        if ((swap ? before.h : before.w) !== after.w || (swap ? before.w : before.h) !== after.h) throw new Error('결과를 확인하지 못해서 파일을 그대로 두었어요');
        const backup = await backupToTrash(entry, original, file.type || type);
        await App.fs.overwrite(entry.path, blob, { undoable: false });
        return { backup, exact };
    }

    const rotateFile = {
        canApply(entry) {
            return !!entry && entry.type === 'image' && /^(jpe?g|jfif|png)$/i.test(entry.ext || P.ext(entry.name));
        },

        /** Bake the current view orientation into the file. Returns true when applied. */
        async apply(entry, { ask = true } = {}) {
            if (!rotateFile.canApply(entry)) {
                ui.toast('JPEG와 PNG만 파일에 적용할 수 있어요', { type: 'warning' });
                return false;
            }
            const t = V.orientationOf(entry.path);
            if (V.isIdentityTransform(t)) {
                ui.toast('먼저 R(회전)이나 H·V(반전)로 방향을 바꿔 주세요', { type: 'info' });
                return false;
            }
            const isJpeg = /^(jpe?g|jfif)$/i.test(entry.ext || P.ext(entry.name));
            const desc = V.describeTransform(t);
            if (ask) {
                const stem = P.stem(entry.name);
                const body = h('div', { class: 'vw-apply-body' },
                    h('p', { text: isJpeg ? 'JPEG는 화질 손실 없이 방향 정보(EXIF)만 바꿔서 저장해요. 촬영 정보도 그대로 남고, 다른 프로그램에서도 바뀐 방향으로 보여요.' : 'PNG는 픽셀을 돌려서 다시 저장해요. 화질은 그대로예요.' }),
                    h('div', { class: 'vw-apply-note', html: `${ui.icon('check-circle', { size: 15 })}<span>원본은 앱 휴지통에 <b>${escapeHtml(stem)} (회전 전 원본)</b>으로 보관돼요. 실행 취소(${escapeHtml(V.dk('Mod+Z'))})로 바로 되돌릴 수도 있어요.</span>` }));
                const ok = await ui.dialog({
                    title: `${desc} 방향을 파일에 적용할까요?`,
                    body,
                    dismissValue: false,
                    actions: [
                        { label: '취소', value: false, kind: 'ghost' },
                        { label: '파일에 적용', value: true, kind: 'primary', autofocus: true },
                    ],
                });
                if (!ok) return false;
            }
            const toast = ui.toast('방향을 저장하는 중…', { type: 'loading' });
            const path = entry.path;
            V.freeze(path); // the photo on screen must not "un-rotate" before the new file is shown
            let state;
            try {
                state = await writeReoriented(entry, t);
            } catch (e) {
                toast.close();
                if (V.image?.view?.path === path) V.image.view.frozen = false;
                ui.toast(`방향을 저장하지 못했어요: ${e.message}`, { type: 'error' });
                return false;
            }
            setCatalogAfterApply(path, t, false);
            toast.close();
            ui.toast(state.exact ? '방향을 파일에 저장했어요 (화질 손실 없음)' : '방향을 파일에 저장했어요', {
                type: 'success',
                action: { label: '실행 취소', run: () => App.undo.undo() },
            });
            let backupId = state.backup?.id;
            App.undo.push({
                label: `"${entry.name}" 방향 저장`,
                undo: async () => {
                    const items = await App.fs.listTrash();
                    const it = items.find((i) => i.id === backupId);
                    if (!it) throw new Error('휴지통에서 원본을 찾을 수 없어요');
                    const f = await App.fs.getFile(it.trashPath);
                    V.freeze(path);
                    await App.fs.overwrite(path, new Blob([await f.arrayBuffer()], { type: f.type }), { undoable: false });
                    await App.fs.purgeTrash([backupId]);
                    setCatalogAfterApply(path, t, true);
                },
                redo: async () => {
                    const cur = await App.fs.stat(path);
                    V.freeze(path);
                    const s = await writeReoriented(cur, t);
                    backupId = s.backup?.id;
                    setCatalogAfterApply(path, t, false);
                },
            });
            return true;
        },

        // exposed for tests
        _jpegReorient: jpegReorient,
        _scanJpeg: scanJpeg,
        _composeOrientation: composeOrientation,
    };
    V.rotateFile = rotateFile;
})();
