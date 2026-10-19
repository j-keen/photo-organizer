/*
 * Viewer — photos: instant open (cached grid thumbnail first, full image swapped in after decode()),
 * neighbour preloading, zoom (wheel, +/-, 0 = fit, Z = 100%, double-click), drag to pan with inertia,
 * non-destructive rotation (catalog meta.rot) and "apply rotation to file":
 *   JPEG — lossless: only the EXIF Orientation tag changes (pixels and metadata stay untouched)
 *   PNG  — pixels are rotated and re-encoded (PNG is lossless)
 * The original is copied into the app trash first and the change is undoable.
 *
 *   App.viewer.image                  — active photo controller { scale, fitScale, zoomIn(), zoomOut(), fitToScreen(), zoomTo(s) ... }
 *   App.viewer.rotateFile.apply(entry) / canApply(entry)
 */
(() => {
    'use strict';
    const { h, path: P, clamp, formatBytes, escapeHtml } = App.util;
    const ui = App.ui;
    const V = App.viewer;

    const ZOOM_STEPS = [0.05, 0.1, 0.125, 0.167, 0.25, 0.333, 0.5, 0.667, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16];
    const STAGE_PAD = 0;

    function normRot(r) {
        const n = Math.round((Number(r) || 0) / 90) * 90;
        return ((n % 360) + 360) % 360;
    }

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
        for (const r of cache.values()) {
            if (r.inUse) continue;
            try {
                r.release?.();
            } catch (_) {
                /* ignore */
            }
        }
        for (const [k, r] of [...cache]) if (!r.inUse) cache.delete(k);
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

    // ---------- Zoom pill (bottom-right) ----------
    let zoomEl = null;
    let zoomLabel = null;

    function ensureZoomUi() {
        if (zoomEl || !V.root) return;
        const b = (ic, tip, keys, fn) => V.button(ic, tip, keys, fn, { class: 'sm' });
        zoomLabel = h('button', {
            class: 'vw-zoom-label',
            'data-tip': '확대 비율',
            onmousedown: (e) => e.preventDefault(),
            onclick: (e) => {
                const inst = V.image;
                if (!inst) return;
                ui.menu([
                    { label: '화면에 맞춤', checked: inst.fit, hint: '0', action: () => inst.fitToScreen(true) },
                    '-',
                    ...[0.25, 0.5, 1, 2, 4].map((s) => ({ label: `${Math.round(s * 100)}%`, checked: !inst.fit && Math.abs(inst.scale - s) < 0.001, hint: s === 1 ? 'Z' : '', action: () => inst.zoomTo(s, null, true) })),
                ], { anchor: e.currentTarget, align: 'end' });
            },
        });
        zoomEl = h('div', { class: 'vw-zoom', hidden: true, role: 'group', 'aria-label': '확대' },
            b('zoom-out', '축소', '-', () => App.commands.run('viewer.zoomOut')),
            zoomLabel,
            b('zoom-in', '확대', '=', () => App.commands.run('viewer.zoomIn')),
            b('fit', '화면에 맞춤', '0', () => App.commands.run('viewer.zoomFit')));
        // Lives in the top bar so it never covers the photo
        const right = V.root.querySelector('.vw-top-right');
        right.insertBefore(zoomEl, right.firstChild);
    }

    function hideZoomUi() {
        if (zoomEl) zoomEl.hidden = true;
    }

    function updateZoomUi(inst) {
        if (!zoomEl || !inst || V.image !== inst || V.current?.path !== inst.entry.path || V.kind !== 'image') return;
        const pct = Math.round(inst.scale * 100);
        zoomLabel.textContent = inst.fit ? `맞춤 · ${pct}%` : `${pct}%`;
        zoomEl.hidden = false;
        zoomEl.classList.toggle('is-zoomed', !inst.fit);
    }

    // ---------- Photo view ----------
    class ImageView {
        constructor(ctx) {
            this.ctx = ctx;
            this.entry = ctx.entry;
            this.slot = ctx.slot;
            this.angle = V.rotationOf(this.entry.path);
            this.scale = 1;
            this.fitScale = 1;
            this.tx = 0;
            this.ty = 0;
            this.fit = true;
            this.nat = null;
            this.full = null;
            this.ph = null;
            this.rec = null;
            this.raf = 0;
            this.inertia = 0;
            this.destroyed = false;
            this.slot.classList.add('vw-image-slot');
            this.bind();
            this.start();
        }

        get media() {
            return this.full || this.ph || null;
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
                    this.nat = meta.w && meta.h ? { w: meta.w, h: meta.h, guess: false } : { w: ph.naturalWidth * 64, h: ph.naturalHeight * 64, guess: true };
                    this.slot.append(ph);
                    this.layout();
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
            ensureZoomUi();
            updateZoomUi(this);
            preloadSoon();
        }

        showFull(img) {
            img.classList.add('vw-media', 'vw-img');
            img.classList.remove('vw-ph');
            img.alt = this.entry.name;
            const prevNat = this.nat;
            this.full = img;
            this.nat = { w: img.naturalWidth || 1, h: img.naturalHeight || 1, guess: false };
            const meta = App.catalog.peek(this.entry.path)?.meta;
            if (img.naturalWidth && (!meta || !meta.w || !meta.h) && App.util.browserCanDecode(this.entry.name)) {
                App.catalog.setMeta(this.entry.path, { w: img.naturalWidth, h: img.naturalHeight });
            }
            if (prevNat && !this.fit && prevNat.w !== this.nat.w) {
                // keep the same on-screen size when the placeholder guessed a different natural size
                this.scale *= prevNat.w / this.nat.w;
            }
            // (the element may still sit in the previous slot when re-opening the same photo — move it first)
            this.slot.append(img);
            this.layout();
            if (this.ph) {
                const ph = this.ph;
                this.ph = null;
                // remove the placeholder only after the full image has painted (no blank frame)
                requestAnimationFrame(() => requestAnimationFrame(() => ph.remove()));
            }
            if (V.image === this) updateZoomUi(this);
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
                        const k = cacheKey(this.entry);
                        cache.delete(k);
                        V.open(this.entry.path);
                    },
                })],
            }));
            this.ctx.ready();
        }

        // ----- geometry -----
        stageSize() {
            const s = this.ctx.stageSize();
            return { w: Math.max(1, s.w - STAGE_PAD * 2), h: Math.max(1, s.h - STAGE_PAD * 2) };
        }

        rotatedNat(angle = this.angle) {
            const swap = normRot(angle) % 180 !== 0;
            return swap ? { w: this.nat.h, h: this.nat.w } : { w: this.nat.w, h: this.nat.h };
        }

        computeFit(angle = this.angle) {
            if (!this.nat) return 1;
            const { w, h: hh } = this.stageSize();
            const r = this.rotatedNat(angle);
            return Math.min(1, w / r.w, hh / r.h);
        }

        get minScale() {
            return Math.min(this.fitScale, 0.05);
        }

        get maxScale() {
            return Math.max(16, this.fitScale * 4);
        }

        clampPan(scale = this.scale, angle = this.angle, pan = this) {
            const { w, h: hh } = this.stageSize();
            const r = this.rotatedNat(angle);
            const mx = Math.max(0, (r.w * scale - w) / 2);
            const my = Math.max(0, (r.h * scale - hh) / 2);
            return { tx: clamp(pan.tx, -mx, mx), ty: clamp(pan.ty, -my, my) };
        }

        get pannable() {
            if (!this.nat) return false;
            const { w, h: hh } = this.stageSize();
            const r = this.rotatedNat();
            return r.w * this.scale > w + 1 || r.h * this.scale > hh + 1;
        }

        layout() {
            if (!this.nat) return;
            this.fitScale = this.computeFit();
            if (this.fit) {
                this.scale = this.fitScale;
                this.tx = 0;
                this.ty = 0;
            } else {
                Object.assign(this, this.clampPan());
            }
            this.apply();
        }

        apply() {
            if (!this.nat) return;
            const w = this.nat.w * this.scale;
            const hh = this.nat.h * this.scale;
            const t = `translate(-50%, -50%) translate(${this.tx.toFixed(2)}px, ${this.ty.toFixed(2)}px) rotate(${this.angle}deg)`;
            for (const el of [this.full, this.ph]) {
                if (!el || (el !== this.ph && el.parentNode && el.parentNode !== this.slot)) continue;
                el.style.width = `${w}px`;
                el.style.height = `${hh}px`;
                el.style.transform = t;
            }
            this.slot.classList.toggle('vw-pannable', this.pannable);
            if (V.image === this) updateZoomUi(this);
        }

        resize() {
            this.layout();
        }

        stopAnim() {
            cancelAnimationFrame(this.raf);
            cancelAnimationFrame(this.inertia);
            this.raf = 0;
            this.inertia = 0;
        }

        animateTo(target, ms = 220) {
            this.stopAnim();
            const from = { scale: this.scale, tx: this.tx, ty: this.ty, angle: this.angle };
            const to = { ...from, ...target };
            if (matchMedia('(prefers-reduced-motion: reduce)').matches) ms = 0;
            const t0 = performance.now();
            const tick = (now) => {
                const p = ms ? Math.min(1, (now - t0) / ms) : 1;
                const e = 1 - Math.pow(1 - p, 3);
                this.scale = from.scale + (to.scale - from.scale) * e;
                this.tx = from.tx + (to.tx - from.tx) * e;
                this.ty = from.ty + (to.ty - from.ty) * e;
                this.angle = from.angle + (to.angle - from.angle) * e;
                this.apply();
                if (p < 1) this.raf = requestAnimationFrame(tick);
                else this.raf = 0;
            };
            this.raf = requestAnimationFrame(tick);
        }

        /** Zoom to `scale`, keeping the point under (clientX, clientY) still (center when omitted). */
        zoomTo(scale, point = null, animate = false) {
            if (!this.nat) return;
            this.stopAnim();
            const target = clamp(scale, this.minScale, this.maxScale);
            const rect = this.slot.getBoundingClientRect();
            const cx = point ? point.x - rect.left - rect.width / 2 : 0;
            const cy = point ? point.y - rect.top - rect.height / 2 : 0;
            const k = target / this.scale;
            const pan = this.clampPan(target, this.angle, { tx: cx - (cx - this.tx) * k, ty: cy - (cy - this.ty) * k });
            this.fit = Math.abs(target - this.fitScale) < 1e-4;
            if (animate) this.animateTo({ scale: target, ...pan });
            else {
                this.scale = target;
                this.tx = pan.tx;
                this.ty = pan.ty;
                this.apply();
            }
        }

        fitToScreen(animate = true) {
            if (!this.nat) return;
            this.fit = true;
            this.fitScale = this.computeFit();
            if (animate) this.animateTo({ scale: this.fitScale, tx: 0, ty: 0 });
            else this.layout();
            V.osd('화면에 맞춤', { icon: 'fit' });
        }

        zoom100(point = null) {
            this.zoomTo(1, point, true);
            V.osd('100%', { icon: 'zoom-in' });
        }

        zoomStep(dir) {
            if (!this.nat) return;
            const cur = this.scale;
            const stops = [...new Set([...ZOOM_STEPS, this.fitScale])].sort((a, b) => a - b);
            let next = dir > 0 ? stops.find((s) => s > cur * 1.01) : [...stops].reverse().find((s) => s < cur * 0.99);
            if (next == null) next = dir > 0 ? this.maxScale : this.minScale;
            this.zoomTo(next, null, true);
            V.osd(Math.abs(next - this.fitScale) < 1e-4 ? '화면에 맞춤' : `${Math.round(next * 100)}%`, { icon: dir > 0 ? 'zoom-in' : 'zoom-out' });
        }

        zoomIn() {
            this.zoomStep(1);
        }

        zoomOut() {
            this.zoomStep(-1);
        }

        /** Double-click / Space: fit <-> 100% (200% when the photo already fits at 100%). */
        toggleZoom(point = null) {
            if (!this.nat) return;
            if (!this.fit && this.scale > this.fitScale * 1.001) this.fitToScreen(true);
            else {
                const target = Math.abs(this.fitScale - 1) < 0.01 ? 2 : 1;
                this.zoomTo(target, point, true);
                V.osd(`${Math.round(target * 100)}%`, { icon: 'zoom-in' });
            }
        }

        onRotate(rot, delta) {
            if (!this.nat) {
                this.angle += delta;
                return;
            }
            const angle = this.angle + delta;
            if (this.fit) {
                this.fitScale = this.computeFit(angle);
                this.animateTo({ angle, scale: this.fitScale, tx: 0, ty: 0 }, 260);
            } else {
                const pan = this.clampPan(this.scale, angle);
                this.animateTo({ angle, ...pan }, 260);
            }
            this.fitScale = this.computeFit(angle);
        }

        onCatalog() {
            // Rotation changed elsewhere (e.g. undo, another module): follow it
            const r = V.rotationOf(this.entry.path);
            const cur = normRot(this.angle);
            if (r === cur || this.raf) return;
            let d = r - cur;
            if (d > 180) d -= 360;
            if (d < -180) d += 360;
            this.onRotate(r, d);
        }

        // ----- input -----
        bind() {
            const slot = this.slot;
            slot.addEventListener('wheel', (e) => {
                if (!this.nat) return;
                e.preventDefault();
                const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022));
                this.zoomTo(this.scale * factor, { x: e.clientX, y: e.clientY }, false);
            }, { passive: false });

            slot.addEventListener('dblclick', (e) => {
                if (e.target.closest('.vw-card')) return;
                this.toggleZoom({ x: e.clientX, y: e.clientY });
            });

            let drag = null;
            slot.addEventListener('pointerdown', (e) => {
                if (e.button !== 0 || e.target.closest('.vw-card') || !this.nat) return;
                this.stopAnim();
                drag = { id: e.pointerId, x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty, pan: this.pannable, samples: [{ t: performance.now(), x: e.clientX, y: e.clientY }], moved: false };
                slot.setPointerCapture(e.pointerId);
                if (drag.pan) slot.classList.add('vw-panning');
            });
            slot.addEventListener('pointermove', (e) => {
                if (!drag || e.pointerId !== drag.id) return;
                const dx = e.clientX - drag.x;
                const dy = e.clientY - drag.y;
                if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
                drag.samples.push({ t: performance.now(), x: e.clientX, y: e.clientY });
                if (drag.samples.length > 6) drag.samples.shift();
                if (drag.pan) {
                    Object.assign(this, this.clampPan(this.scale, this.angle, { tx: drag.tx + dx, ty: drag.ty + dy }));
                    this.apply();
                } else if (drag.moved) {
                    // Not zoomed in: a horizontal drag previews a swipe to the neighbour
                    this.slot.style.transform = `translateX(${dx * 0.35}px)`;
                }
            });
            const end = (e) => {
                if (!drag || e.pointerId !== drag.id) return;
                const d = drag;
                drag = null;
                slot.classList.remove('vw-panning');
                try {
                    slot.releasePointerCapture(e.pointerId);
                } catch (_) {
                    /* ignore */
                }
                const dx = e.clientX - d.x;
                const dy = e.clientY - d.y;
                if (!d.pan) {
                    this.slot.style.transform = '';
                    if (d.moved && Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy) * 1.5 && V.count > 1) V.step(dx < 0 ? 1 : -1);
                    return;
                }
                // Inertia: keep gliding with the release velocity
                const s = d.samples;
                const a = s[0];
                const b = s[s.length - 1];
                const dt = Math.max(1, b.t - a.t);
                let vx = ((b.x - a.x) / dt) * 16;
                let vy = ((b.y - a.y) / dt) * 16;
                if (performance.now() - b.t > 80 || Math.hypot(vx, vy) < 2) return;
                const glide = () => {
                    vx *= 0.92;
                    vy *= 0.92;
                    const before = { tx: this.tx, ty: this.ty };
                    Object.assign(this, this.clampPan(this.scale, this.angle, { tx: this.tx + vx, ty: this.ty + vy }));
                    this.apply();
                    const movedNow = Math.abs(this.tx - before.tx) + Math.abs(this.ty - before.ty);
                    if (Math.hypot(vx, vy) > 0.4 && movedNow > 0.05) this.inertia = requestAnimationFrame(glide);
                };
                this.inertia = requestAnimationFrame(glide);
            };
            slot.addEventListener('pointerup', end);
            slot.addEventListener('pointercancel', end);
        }

        hints() {
            const dk = V.dk;
            return [
                { keys: ['←', '→'], label: '이전/다음' },
                { mouse: true, label: '휠 확대 · 끌어서 이동' },
                { keys: ['0'], label: '맞춤' },
                { keys: ['Z'], label: '100%' },
                { keys: ['R'], label: '회전' },
                { keys: ['I'], label: '정보' },
                { keys: ['T'], label: '필름' },
                { keys: ['S'], label: '슬라이드쇼' },
                { keys: [dk('Delete')], label: '삭제' },
            ];
        }

        deactivate() {
            this.stopAnim();
        }

        destroy() {
            this.destroyed = true;
            this.stopAnim();
            if (this.rec) {
                this.rec.inUse = Math.max(0, this.rec.inUse - 1);
                this.rec = null;
            }
            if (V.image === this) {
                V.image = null;
                if (V.kind !== 'image') hideZoomUi();
            }
            trimCache();
        }
    }

    V.registerRenderer('image', {
        mount(ctx) {
            return new ImageView(ctx);
        },
    });

    App.bus.on('viewer:entry', ({ entry }) => {
        if (entry.type !== 'image') hideZoomUi();
    });
    App.bus.on('viewer:closed', () => {
        hideZoomUi();
        V.image = null;
        clearCache();
    });
    App.bus.on('fs:changed', (c) => {
        if (c.type !== 'modify') return;
        for (const p of c.paths) for (const [k, r] of [...cache]) if (r.path === p && !r.inUse) cache.delete(k);
    });

    // ---------- Apply rotation to the file ----------
    // EXIF orientation as 2x2 matrices [a, b, c, d] = [[a, b], [c, d]] mapping stored -> displayed pixels (y down).
    const ORIENT_M = { 1: [1, 0, 0, 1], 2: [-1, 0, 0, 1], 3: [-1, 0, 0, -1], 4: [1, 0, 0, -1], 5: [0, 1, 1, 0], 6: [0, -1, 1, 0], 7: [0, -1, -1, 0], 8: [0, 1, -1, 0] };
    const ROT_M = { 0: ORIENT_M[1], 90: ORIENT_M[6], 180: ORIENT_M[3], 270: ORIENT_M[8] };

    function mat(A, B) {
        return [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3]];
    }

    /** New EXIF orientation after rotating an image that currently has orientation `cur` by `deg` clockwise. */
    function composeOrientation(cur, deg) {
        const M = mat(ROT_M[normRot(deg)], ORIENT_M[cur] || ORIENT_M[1]);
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

    /** Lossless JPEG rotation: rewrite (or add) the EXIF Orientation tag. Returns new file bytes. */
    function jpegRotate(u8, deg) {
        const { exif, app0End } = scanJpeg(u8);
        const next = composeOrientation(exif ? exif.orientation : 1, deg);
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
        const t = 10;
        seg.set([0x4d, 0x4d], t); // big-endian TIFF
        dv.setUint16(t + 2, 42);
        dv.setUint32(t + 4, 8);
        dv.setUint16(t + 8, 1);
        dv.setUint16(t + 10, 0x0112);
        dv.setUint16(t + 12, 3);
        dv.setUint32(t + 14, 1);
        dv.setUint16(t + 18, next);
        dv.setUint32(t + 22, 0);
        const at = app0End ?? 2;
        const out = new Uint8Array(u8.length + seg.length);
        out.set(u8.subarray(0, at), 0);
        out.set(seg, at);
        out.set(u8.subarray(at), at + seg.length);
        return out;
    }

    async function canvasRotate(blob, deg, type) {
        const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
        const swap = normRot(deg) % 180 !== 0;
        const w = swap ? bmp.height : bmp.width;
        const hh = swap ? bmp.width : bmp.height;
        const c = new OffscreenCanvas(w, hh);
        const g = c.getContext('2d');
        g.translate(w / 2, hh / 2);
        g.rotate((normRot(deg) * Math.PI) / 180);
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

    function setCatalogAfterApply(path, rot, prevRot) {
        App.catalog.update(path, (e) => {
            const meta = { ...(e.meta || {}) };
            if (prevRot) meta.rot = prevRot;
            else delete meta.rot;
            if (normRot(rot) % 180 && meta.w && meta.h) [meta.w, meta.h] = [meta.h, meta.w];
            e.meta = meta;
        });
    }

    async function writeRotated(entry, rot) {
        const ext = (entry.ext || P.ext(entry.name)).toLowerCase();
        const isJpeg = ext === 'jpg' || ext === 'jpeg' || ext === 'jfif';
        const file = await App.fs.getFile(entry.path);
        const original = new Uint8Array(await file.arrayBuffer());
        const type = isJpeg ? 'image/jpeg' : 'image/png';
        const originalBlob = new Blob([original], { type });
        let blob;
        let lossless = false;
        if (isJpeg) {
            try {
                blob = new Blob([jpegRotate(original, rot)], { type });
                lossless = true;
            } catch (e) {
                console.warn('[viewer] EXIF rotation failed, re-encoding instead', e);
                blob = await canvasRotate(originalBlob, rot, type);
            }
        } else {
            blob = await canvasRotate(originalBlob, rot, type);
            lossless = true;
        }
        // Verify the result decodes with the expected size before touching the original
        const before = await displaySize(originalBlob);
        const after = await displaySize(blob);
        const swap = normRot(rot) % 180 !== 0;
        if ((swap ? before.h : before.w) !== after.w || (swap ? before.w : before.h) !== after.h) throw new Error('회전 결과를 확인하지 못해서 파일을 그대로 두었어요');
        const backup = await backupToTrash(entry, original, file.type || type);
        await App.fs.overwrite(entry.path, blob);
        return { backup, lossless };
    }

    const rotateFile = {
        canApply(entry) {
            return !!entry && entry.type === 'image' && /^(jpe?g|jfif|png)$/i.test(entry.ext || P.ext(entry.name));
        },

        /** Bake the current view rotation into the file. Returns true when applied. */
        async apply(entry, { ask = true } = {}) {
            if (!rotateFile.canApply(entry)) {
                ui.toast('JPEG와 PNG만 파일에 회전을 적용할 수 있어요', { type: 'warning' });
                return false;
            }
            const rot = V.rotationOf(entry.path);
            if (!rot) {
                ui.toast('먼저 R 키로 사진을 돌려 주세요', { type: 'info' });
                return false;
            }
            const isJpeg = /^(jpe?g|jfif)$/i.test(entry.ext || P.ext(entry.name));
            if (ask) {
                const stem = P.stem(entry.name);
                const body = h('div', { class: 'vw-apply-body' },
                    h('p', { text: isJpeg ? 'JPEG는 화질 손실 없이 방향 정보(EXIF)만 바꿔서 저장해요. 다른 프로그램에서도 돌아간 채로 보여요.' : 'PNG는 픽셀을 돌려서 다시 저장해요. 화질은 그대로예요.' }),
                    h('div', { class: 'vw-apply-note', html: `${ui.icon('check-circle', { size: 15 })}<span>원본은 앱 휴지통에 <b>${escapeHtml(stem)} (회전 전 원본)</b>으로 보관돼요. 실행 취소(${escapeHtml(V.dk('Mod+Z'))})로도 되돌릴 수 있어요.</span>` }));
                const ok = await ui.dialog({
                    title: `${rot}° 회전을 파일에 적용할까요?`,
                    body,
                    dismissValue: false,
                    actions: [
                        { label: '취소', value: false, kind: 'ghost' },
                        { label: '파일에 적용', value: true, kind: 'primary', autofocus: true },
                    ],
                });
                if (!ok) return false;
            }
            const t = ui.toast('회전을 저장하는 중…', { type: 'loading' });
            let state;
            try {
                state = await writeRotated(entry, rot);
            } catch (e) {
                t.close();
                ui.toast(`회전을 저장하지 못했어요: ${e.message}`, { type: 'error' });
                return false;
            }
            setCatalogAfterApply(entry.path, rot, 0);
            t.close();
            ui.toast(state.lossless ? '회전을 파일에 저장했어요 (화질 손실 없음)' : '회전을 파일에 저장했어요', {
                type: 'success',
                action: { label: '실행 취소', run: () => App.undo.undo() },
            });
            const path = entry.path;
            let backupId = state.backup?.id;
            App.undo.push({
                label: `"${entry.name}" 회전 저장`,
                undo: async () => {
                    const items = await App.fs.listTrash();
                    const it = items.find((i) => i.id === backupId);
                    if (!it) throw new Error('휴지통에서 원본을 찾을 수 없어요');
                    const f = await App.fs.getFile(it.trashPath);
                    await App.fs.overwrite(path, new Blob([await f.arrayBuffer()], { type: f.type }));
                    await App.fs.purgeTrash([backupId]);
                    setCatalogAfterApply(path, rot, rot);
                },
                redo: async () => {
                    const cur = App.view.get(path) || (await App.fs.stat(path));
                    const s = await writeRotated(cur, rot);
                    backupId = s.backup?.id;
                    setCatalogAfterApply(path, rot, 0);
                },
            });
            return true;
        },

        // exposed for tests
        _jpegRotate: jpegRotate,
        _scanJpeg: scanJpeg,
        _composeOrientation: composeOrientation,
    };
    V.rotateFile = rotateFile;

    // ---------- Commands ----------
    const imageActive = () => V.isOpen && V.kind === 'image' && !!V.image && !App.viewer.slideshow?.running;
    const zoomIn = App.commands.register({ id: 'viewer.zoomIn', title: '확대', group: '보기', icon: 'zoom-in', scope: 'viewer', keys: ['=', '+'], when: imageActive, run: () => V.image?.zoomIn() });
    App.commands.register({ id: 'viewer.zoomOut', title: '축소', group: '보기', icon: 'zoom-out', scope: 'viewer', keys: ['-'], when: imageActive, run: () => V.image?.zoomOut() });
    App.commands.register({ id: 'viewer.zoomFit', title: '화면에 맞춤', group: '보기', icon: 'vw-fit', scope: 'viewer', keys: ['0'], when: imageActive, run: () => V.image?.fitToScreen(true) });
    App.commands.register({ id: 'viewer.zoom100', title: '실제 크기 (100%)', group: '보기', icon: 'zoom-in', scope: 'viewer', keys: ['Z'], when: imageActive, run: () => V.image?.zoom100() });
    App.commands.register({
        id: 'viewer.applyRotation',
        title: '회전을 파일에 적용',
        group: '보기',
        icon: 'vw-save',
        scope: 'viewer',
        when: () => V.isOpen && rotateFile.canApply(V.current) && !!V.rotationOf(V.current.path),
        run: () => rotateFile.apply(V.current),
    });

    // The core key parser can't register a bare "+" yet (normalizeCombo splits on '+'; see integration request).
    // Until it can, route "+" (Shift+= / numpad +) to whichever viewer command wants it.
    const PLUS_COMMANDS = ['viewer.zoomIn', 'viewer.slideshowLonger'];
    if (zoomIn && Array.isArray(zoomIn.keys) && !zoomIn.keys.includes('+')) {
        App.bus.on('app:ready', () => {
            for (const id of PLUS_COMMANDS) {
                const c = App.commands.get(id);
                if (c) c.keys = c.keys.filter(Boolean);
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.defaultPrevented || e.isComposing || e.key !== '+' || e.ctrlKey || e.metaKey || e.altKey) return;
            if (App.layers.top() !== 'viewer' || App.util.isTypingTarget(e.target)) return;
            const id = PLUS_COMMANDS.find((c) => App.commands.get(c) && App.commands.isEnabled(c));
            if (!id) return;
            e.preventDefault();
            App.commands.run(id);
        });
    }
})();
