/*
 * Viewer — shared view transform for photos AND videos: fit / zoom / pan plus the non-destructive orientation
 * (catalog meta.rot / flipH / flipV, see viewer.js), re-applied whenever the file is shown.
 *   Mouse: Ctrl+wheel (or trackpad pinch) zooms anchored at the cursor. A plain wheel pans when zoomed in, otherwise
 *          it is handed to onPlainWheel (photos: previous/next file or zoom — a setting; videos: volume).
 *          Drag pans when zoomed in; double-click = onDoubleTap; a click without dragging = onTap.
 *   Keys:  = / + zoom in, - zoom out, 0 fit, Z 100%.
 *
 *   new App.viewer.ViewTransform({ ctx, slot, path, upscale, pad, swipe, onTap, onDoubleTap, onPlainWheel })
 *   App.viewer.view — the transform of the file on screen (set by viewer.js)
 */
(() => {
    'use strict';
    const { h, clamp } = App.util;
    const ui = App.ui;
    const V = App.viewer;

    const ZOOM_STEPS = [0.05, 0.1, 0.125, 0.167, 0.25, 0.333, 0.5, 0.667, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16];
    const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

    function norm(r) {
        const n = Math.round((Number(r) || 0) / 90) * 90;
        return ((n % 360) + 360) % 360;
    }

    class ViewTransform {
        constructor({ ctx, slot, path, upscale = false, pad = 0, swipe = false, onTap = null, onDoubleTap = null, onPlainWheel = null }) {
            this.ctx = ctx;
            this.slot = slot;
            this.path = path;
            this.upscale = upscale;
            this.pad = pad; // number | {x, y} | () => {x, y} — breathing room around the media at "fit"
            this.swipe = swipe;
            this.onTap = onTap;
            this.onDoubleTap = onDoubleTap;
            this.onPlainWheel = onPlainWheel;
            const t = V.orientationOf(path);
            this.angle = t.rot;
            this.sx = t.flipH ? -1 : 1;
            this.sy = t.flipV ? -1 : 1;
            this.scale = 1;
            this.fitScale = 1;
            this.fit = true;
            this.tx = 0;
            this.ty = 0;
            this.nat = null;
            this.els = [];
            this.raf = 0;
            this.animTo = null;
            this.glide = 0;
            this.frozen = false;
            this.dragMoved = false;
            this.slot.classList.add('vw-xf-slot');
            this.bind();
        }

        // ----- content -----
        setElements(els) {
            this.els = els.filter(Boolean);
            this.apply();
        }

        /** Natural (unrotated) size of the media in px. keepScreenSize: keep the on-screen size when zoomed. */
        setNatural(w, hh, { keepScreenSize = false } = {}) {
            if (!w || !hh) return;
            const prev = this.nat;
            if (prev && prev.w === w && prev.h === hh) return;
            this.nat = { w, h: hh };
            if (keepScreenSize && prev && !this.fit) this.scale *= prev.w / w;
            this.layout();
        }

        // ----- geometry -----
        padding() {
            const p = typeof this.pad === 'function' ? this.pad() : this.pad;
            return typeof p === 'number' ? { x: p, y: p } : p || { x: 0, y: 0 };
        }

        stageSize() {
            return this.ctx.stageSize();
        }

        rotatedNat(angle = this.angle) {
            const swap = norm(angle) % 180 !== 0;
            return swap ? { w: this.nat.h, h: this.nat.w } : { w: this.nat.w, h: this.nat.h };
        }

        computeFit(angle = this.angle) {
            if (!this.nat) return 1;
            const s = this.stageSize();
            const p = this.padding();
            const r = this.rotatedNat(angle);
            const f = Math.min(Math.max(1, s.w - 2 * p.x) / r.w, Math.max(1, s.h - 2 * p.y) / r.h);
            return Math.max(0.001, this.upscale ? f : Math.min(1, f));
        }

        get minScale() {
            return Math.min(this.fitScale, 0.05);
        }

        get maxScale() {
            return Math.max(16, this.fitScale * 4);
        }

        clampPan(scale = this.scale, angle = this.angle, pan = this) {
            const s = this.stageSize();
            const r = this.rotatedNat(angle);
            const mx = Math.max(0, (r.w * scale - s.w) / 2);
            const my = Math.max(0, (r.h * scale - s.h) / 2);
            return { tx: clamp(pan.tx, -mx, mx), ty: clamp(pan.ty, -my, my) };
        }

        get pannable() {
            if (!this.nat) return false;
            const s = this.stageSize();
            const r = this.rotatedNat();
            return r.w * this.scale > s.w + 1 || r.h * this.scale > s.h + 1;
        }

        get zoomed() {
            return !this.fit && this.scale > this.fitScale * 1.001;
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

        resize() {
            if (this.raf) this.finish();
            this.layout();
        }

        apply() {
            if (!this.nat) return;
            const w = this.nat.w * this.scale;
            const hh = this.nat.h * this.scale;
            const t = `translate(-50%, -50%) translate(${this.tx.toFixed(2)}px, ${this.ty.toFixed(2)}px) rotate(${this.angle.toFixed(3)}deg) scale(${this.sx.toFixed(4)}, ${this.sy.toFixed(4)})`;
            for (const el of this.els) {
                el.classList.add('vw-xf');
                el.style.width = `${w}px`;
                el.style.height = `${hh}px`;
                el.style.transform = t;
            }
            this.slot.classList.toggle('vw-pannable', this.pannable);
            this.slot.classList.toggle('vw-zoomed', this.zoomed);
            if (V.view === this) zoomUi.update(this);
        }

        // ----- animation -----
        stop() {
            cancelAnimationFrame(this.glide);
            this.glide = 0;
        }

        /** Jump a running animation to its end state. */
        finish() {
            this.stop();
            if (!this.raf) return;
            cancelAnimationFrame(this.raf);
            this.raf = 0;
            if (this.animTo) Object.assign(this, this.animTo);
            this.animTo = null;
            this.settle();
            this.apply();
        }

        animateTo(target, ms = 220) {
            this.finish();
            const from = { scale: this.scale, tx: this.tx, ty: this.ty, angle: this.angle, sx: this.sx, sy: this.sy };
            const to = { ...from, ...target };
            if (reduceMotion() || !this.nat || !ms) {
                Object.assign(this, to);
                this.settle();
                this.apply();
                return;
            }
            this.animTo = to;
            const t0 = performance.now();
            const step = (now) => {
                const p = Math.min(1, (now - t0) / ms);
                const e = 1 - Math.pow(1 - p, 3);
                for (const k of Object.keys(from)) this[k] = from[k] + (to[k] - from[k]) * e;
                this.apply();
                if (p < 1) {
                    this.raf = requestAnimationFrame(step);
                } else {
                    this.raf = 0;
                    this.animTo = null;
                    this.settle();
                    this.apply();
                }
            };
            this.raf = requestAnimationFrame(step);
        }

        // Canonical values after an orientation animation (no visual change)
        settle() {
            this.sx = this.sx < 0 ? -1 : 1;
            this.sy = this.sy < 0 ? -1 : 1;
            this.angle = Math.round(this.angle / 90) * 90;
            if (Math.abs(this.angle) >= 720) this.angle = norm(this.angle);
        }

        // ----- zoom -----
        /** Zoom to `scale`, keeping the point under (x, y) still (the center when omitted). */
        zoomTo(scale, point = null, animate = false) {
            if (!this.nat) return;
            this.finish();
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

        fitToScreen(animate = true, { quiet = false } = {}) {
            if (!this.nat) return;
            this.finish();
            this.fit = true;
            this.fitScale = this.computeFit();
            this.animateTo({ scale: this.fitScale, tx: 0, ty: 0 }, animate ? 220 : 0);
            if (!quiet) V.osd('화면에 맞춤', { icon: 'vw-fit' });
        }

        zoom100(point = null) {
            this.zoomTo(1, point, true);
            V.osd('100%', { icon: 'zoom-in' });
        }

        zoomStep(dir) {
            if (!this.nat) return;
            this.finish();
            const cur = this.scale;
            const stops = [...new Set([...ZOOM_STEPS, this.fitScale])].sort((a, b) => a - b);
            let next = dir > 0 ? stops.find((s) => s > cur * 1.01) : [...stops].reverse().find((s) => s < cur * 0.99);
            if (next == null) next = dir > 0 ? this.maxScale : this.minScale;
            this.zoomTo(next, null, true);
            V.osd(Math.abs(next - this.fitScale) < 1e-4 ? '화면에 맞춤' : `${Math.round(next * 100)}%`, { icon: dir > 0 ? 'zoom-in' : 'zoom-out' });
        }

        /** Fit <-> 100% (200% when the media already fits at 100%). */
        toggleZoom(point = null) {
            if (!this.nat) return;
            if (this.zoomed) this.fitToScreen(true);
            else {
                const target = Math.abs(this.fitScale - 1) < 0.01 ? 2 : 1;
                this.zoomTo(target, point, true);
                V.osd(`${Math.round(target * 100)}%`, { icon: 'zoom-in' });
            }
        }

        // ----- orientation -----
        /** Follow the stored rotation/flip (after R/H/V, undo, ...), animating the smallest visible change. */
        follow(animate = true) {
            if (this.frozen) return;
            this.finish();
            const t = V.orientationOf(this.path);
            const cur = { rot: norm(this.angle), sx: this.sx < 0 ? -1 : 1, sy: this.sy < 0 ? -1 : 1 };
            // flipping both axes is the same picture as turning 180°: pick whichever is closer to what's on screen
            const cands = [
                { rot: t.rot, sx: t.flipH ? -1 : 1, sy: t.flipV ? -1 : 1 },
                { rot: norm(t.rot + 180), sx: t.flipH ? 1 : -1, sy: t.flipV ? 1 : -1 },
            ];
            let best = null;
            for (const c of cands) {
                let d = c.rot - cur.rot;
                if (d > 180) d -= 360;
                if (d <= -180) d += 360;
                const cost = Math.abs(d) / 90 + (c.sx !== cur.sx ? 1 : 0) + (c.sy !== cur.sy ? 1 : 0);
                if (!best || cost < best.cost) best = { ...c, d, cost };
            }
            if (!best.cost) return;
            const angle = this.angle + best.d;
            const ms = animate ? 260 : 0;
            if (!this.nat) {
                Object.assign(this, { angle, sx: best.sx, sy: best.sy });
                this.settle();
                return;
            }
            if (this.fit) {
                this.fitScale = this.computeFit(angle);
                this.animateTo({ angle, sx: best.sx, sy: best.sy, scale: this.fitScale, tx: 0, ty: 0 }, ms);
            } else {
                this.animateTo({ angle, sx: best.sx, sy: best.sy, ...this.clampPan(this.scale, angle) }, ms);
            }
        }

        /** Zoom by one wheel event, keeping the point under the cursor still. */
        wheelZoom(e) {
            e.preventDefault();
            if (!this.nat) return;
            const notch = e.deltaMode !== 0 || Math.abs(e.deltaY) >= 50;
            const factor = notch ? Math.pow(1.2, -Math.sign(e.deltaY)) : Math.exp(-e.deltaY * 0.01);
            const next = this.scale * factor;
            // snap back to "fit" when zooming out past it
            if (factor < 1 && next <= this.fitScale * 1.0001 && this.scale > this.fitScale * 1.0001) this.zoomTo(this.fitScale, { x: e.clientX, y: e.clientY });
            else this.zoomTo(next, { x: e.clientX, y: e.clientY });
            V.poke();
        }

        // ----- input -----
        bind() {
            const slot = this.slot;
            const ignore = (e) => !!e.target.closest?.('.vw-card, button, a, input, textarea, select');

            slot.addEventListener('wheel', (e) => {
                if (ignore(e)) return;
                if (e.ctrlKey || e.metaKey) {
                    // Ctrl+wheel (Chrome also reports trackpad pinch this way)
                    this.wheelZoom(e);
                    return;
                }
                if (this.pannable) {
                    e.preventDefault();
                    let dx = e.deltaX;
                    let dy = e.deltaY;
                    if (e.shiftKey && !dx) {
                        dx = dy;
                        dy = 0;
                    }
                    const k = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? 400 : 1;
                    this.finish();
                    Object.assign(this, this.clampPan(this.scale, this.angle, { tx: this.tx - dx * k, ty: this.ty - dy * k }));
                    this.apply();
                    return;
                }
                if (this.onPlainWheel) this.onPlainWheel(e);
            }, { passive: false });

            let drag = null;
            slot.addEventListener('pointerdown', (e) => {
                if (e.button !== 0 || ignore(e)) return;
                this.dragMoved = false;
                if (!this.nat) return;
                this.finish();
                drag = { id: e.pointerId, x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty, pan: this.pannable, samples: [{ t: performance.now(), x: e.clientX, y: e.clientY }] };
                try {
                    slot.setPointerCapture(e.pointerId);
                } catch (_) {
                    /* ignore */
                }
            });
            slot.addEventListener('pointermove', (e) => {
                if (!drag || e.pointerId !== drag.id) return;
                const dx = e.clientX - drag.x;
                const dy = e.clientY - drag.y;
                if (!this.dragMoved && Math.abs(dx) + Math.abs(dy) > 4) {
                    this.dragMoved = true;
                    if (drag.pan) slot.classList.add('vw-panning');
                }
                drag.samples.push({ t: performance.now(), x: e.clientX, y: e.clientY });
                if (drag.samples.length > 6) drag.samples.shift();
                if (!this.dragMoved) return;
                if (drag.pan) {
                    Object.assign(this, this.clampPan(this.scale, this.angle, { tx: drag.tx + dx, ty: drag.ty + dy }));
                    this.apply();
                } else if (this.swipe && V.count > 1) {
                    // not zoomed in: a horizontal drag previews a swipe to the neighbour
                    slot.style.transform = `translateX(${dx * 0.35}px)`;
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
                    slot.style.transform = '';
                    if (this.swipe && this.dragMoved && Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy) * 1.5 && V.count > 1) V.step(dx < 0 ? 1 : -1);
                    return;
                }
                if (!this.dragMoved) return;
                // inertia: keep gliding with the release velocity
                const s = d.samples;
                const a = s[0];
                const b = s[s.length - 1];
                const dt = Math.max(1, b.t - a.t);
                let vx = ((b.x - a.x) / dt) * 16;
                let vy = ((b.y - a.y) / dt) * 16;
                if (performance.now() - b.t > 80 || Math.hypot(vx, vy) < 2 || reduceMotion()) return;
                const glide = () => {
                    vx *= 0.92;
                    vy *= 0.92;
                    const before = { tx: this.tx, ty: this.ty };
                    Object.assign(this, this.clampPan(this.scale, this.angle, { tx: this.tx + vx, ty: this.ty + vy }));
                    this.apply();
                    const moved = Math.abs(this.tx - before.tx) + Math.abs(this.ty - before.ty);
                    this.glide = Math.hypot(vx, vy) > 0.4 && moved > 0.05 ? requestAnimationFrame(glide) : 0;
                };
                this.glide = requestAnimationFrame(glide);
            };
            slot.addEventListener('pointerup', end);
            slot.addEventListener('pointercancel', end);
            slot.addEventListener('click', (e) => {
                if (this.dragMoved) {
                    this.dragMoved = false;
                    return;
                }
                if (ignore(e)) return;
                this.onTap?.(e);
            });
            slot.addEventListener('dblclick', (e) => {
                if (ignore(e)) return;
                this.onDoubleTap?.({ x: e.clientX, y: e.clientY }, e);
            });
        }

        destroy() {
            this.stop();
            cancelAnimationFrame(this.raf);
            this.raf = 0;
        }
    }

    V.ViewTransform = ViewTransform;

    // ---------- Zoom control (top bar; photos and videos) ----------
    const zoomUi = {
        el: null,
        label: null,

        ensure() {
            if (this.el || !V.root) return;
            const b = (ic, tip, keys, fn) => V.button(ic, tip, keys, fn, { class: 'sm' });
            this.label = h('button', {
                class: 'vw-zoom-label',
                'data-tip': `확대 비율 · ${V.dk('Mod')}+휠로 확대/축소`,
                onmousedown: (e) => e.preventDefault(),
                onclick: (e) => {
                    const view = V.view;
                    if (!view) return;
                    ui.menu([
                        { label: '화면에 맞춤', checked: view.fit, hint: '0', action: () => view.fitToScreen(true) },
                        '-',
                        ...[0.25, 0.5, 1, 2, 4].map((s) => ({ label: `${Math.round(s * 100)}%`, checked: !view.fit && Math.abs(view.scale - s) < 0.001, hint: s === 1 ? 'Z' : '', action: () => view.zoomTo(s, null, true) })),
                    ], { anchor: e.currentTarget, align: 'end' });
                },
            });
            this.el = h('div', { class: 'vw-zoom', hidden: true, role: 'group', 'aria-label': '확대' },
                b('zoom-out', '축소', '-', () => App.commands.run('viewer.zoomOut')),
                this.label,
                b('zoom-in', '확대', '=', () => App.commands.run('viewer.zoomIn')),
                b('vw-fit', '화면에 맞춤', '0', () => App.commands.run('viewer.zoomFit')));
            const right = V.root.querySelector('.vw-top-right');
            right.insertBefore(this.el, right.firstChild);
        },

        update(view) {
            if (!this.el || !view || V.view !== view) return;
            const pct = Math.round(view.scale * 100);
            const text = view.fit ? `맞춤 · ${pct}%` : `${pct}%`;
            if (this.label.textContent !== text) this.label.textContent = text;
            this.el.hidden = !view.nat;
            this.el.classList.toggle('is-zoomed', view.zoomed);
        },

        hide() {
            if (this.el) this.el.hidden = true;
        },
    };

    App.bus.on('viewer:shown', () => {
        if (V.view) {
            zoomUi.ensure();
            zoomUi.update(V.view);
        } else zoomUi.hide();
    });
    App.bus.on('viewer:entry', ({ entry }) => {
        if (entry.type !== 'image' && entry.type !== 'video') zoomUi.hide();
    });
    App.bus.on('viewer:closed', () => zoomUi.hide());

    // ---------- Commands ----------
    const zoomable = () => V.isOpen && !!V.view && !!V.view.nat && !V.slideshow?.running;
    // During a slideshow the same keys change the interval (one command per key, no clash)
    const zoomOrInterval = () => zoomable() || !!V.slideshow?.running;
    App.commands.register({ id: 'viewer.zoomIn', title: '확대', group: '보기', icon: 'zoom-in', scope: 'viewer', keys: ['=', '+'], when: zoomOrInterval, run: () => (V.slideshow?.running ? V.slideshow.nudge(1) : V.view.zoomStep(1)) });
    App.commands.register({ id: 'viewer.zoomOut', title: '축소', group: '보기', icon: 'zoom-out', scope: 'viewer', keys: ['-'], when: zoomOrInterval, run: () => (V.slideshow?.running ? V.slideshow.nudge(-1) : V.view.zoomStep(-1)) });
    App.commands.register({ id: 'viewer.zoomFit', title: '화면에 맞춤', group: '보기', icon: 'vw-fit', scope: 'viewer', keys: ['0'], when: zoomable, run: () => V.view.fitToScreen(true) });
    App.commands.register({ id: 'viewer.zoom100', title: '실제 크기 (100%)', group: '보기', icon: 'zoom-in', scope: 'viewer', keys: ['Z'], when: zoomable, run: () => V.view.zoom100() });

})();
