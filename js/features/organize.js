/*
 * Organize tools — shared kit, public API and gallery context menu.
 *
 *   organize.js           kit (panels, virtual lists, inline sheets, media info, chips, folders, hashing),
 *                         App.organize API object, gallery context-menu contribution
 *   organize-transfer.js  folder picker, conflict sheet, transfer engine (one undo entry per batch),
 *                         move/copy to…, unwrap (폴더 풀기), organize by date / by chip, empty-folder cleanup
 *   organize-rename.js    batch rename (pattern tokens, find & replace, case, live preview)
 *   organize-trash.js     trash panel, status-bar entry, auto-purge
 *   duplicates.js         duplicate finder (App.dupes)
 *
 * Everything goes through App.fs (catalog/undo/tree stay in sync) and App.ui (no native dialogs).
 */
(() => {
    'use strict';
    const { h, path: P, formatBytes, formatDate, formatCount } = App.util;
    const ui = App.ui;

    const DAY = 86400000;

    // ---------- Small DOM helpers ----------
    function icon(name, size = 16, cls = '') {
        return ui.icon(name, { size, class: cls });
    }

    /** btn({ label, icon, kind: 'primary'|'danger'|'ghost'|'sm'..., tip, keys, onClick, title }) */
    function btn(opts) {
        const el = h('button', {
            type: 'button',
            class: `btn ${opts.kind || ''}`.trim(),
            'data-tip': opts.tip || null,
            'data-tip-keys': opts.keys || null,
            'aria-label': opts.aria || (!opts.label ? opts.tip : null) || null,
            onclick: opts.onClick || null,
        });
        if (opts.icon) el.insertAdjacentHTML('beforeend', icon(opts.icon, opts.iconSize || 15));
        if (opts.label != null) el.append(h('span', { class: 'btn-label', text: opts.label }));
        if (opts.disabled) el.disabled = true;
        return el;
    }

    function setBtnLabel(el, label) {
        const span = el.querySelector('.btn-label');
        if (span) span.textContent = label;
        else el.append(h('span', { class: 'btn-label', text: label }));
    }

    /** Segmented control: seg([{value, label, icon, tip}], value, onChange) -> { el, get(), set(v) } */
    function seg(options, value, onChange, { size = '' } = {}) {
        const el = h('div', { class: `seg org-seg ${size}`.trim(), role: 'radiogroup' });
        let current = value;
        const buttons = new Map();
        for (const o of options) {
            const b = h('button', { type: 'button', role: 'radio', 'data-tip': o.tip || null, dataset: { value: String(o.value) } });
            if (o.icon) b.insertAdjacentHTML('beforeend', icon(o.icon, 14));
            if (o.label) b.append(h('span', { text: o.label }));
            b.addEventListener('click', () => {
                if (current === o.value) return;
                api.set(o.value);
                onChange?.(o.value);
            });
            buttons.set(o.value, b);
            el.append(b);
        }
        const api = {
            el,
            get: () => current,
            set(v) {
                current = v;
                for (const [val, b] of buttons) {
                    b.classList.toggle('on', val === v);
                    b.setAttribute('aria-checked', String(val === v));
                }
            },
            disable(v, disabled) {
                const b = buttons.get(v);
                if (b) b.disabled = !!disabled;
            },
        };
        api.set(value);
        return api;
    }

    /** Native checkbox with label: toggle(label, checked, onChange, {hint}) -> { el, input, get(), set() } */
    function toggle(label, checked, onChange, { hint, tip } = {}) {
        const input = h('input', { type: 'checkbox' });
        input.checked = !!checked;
        input.addEventListener('change', () => onChange?.(input.checked));
        const el = h('label', { class: 'org-toggle', 'data-tip': tip || null }, input, h('span', { class: 'org-toggle-text' }, h('span', { text: label }), hint ? h('span', { class: 'org-toggle-hint', text: hint }) : null));
        return {
            el,
            input,
            get: () => input.checked,
            set(v) {
                input.checked = !!v;
            },
        };
    }

    /** Native select: select([{value,label}], value, onChange) */
    function select(options, value, onChange, { cls = '' } = {}) {
        const el = h('select', { class: `select org-select ${cls}`.trim() });
        for (const o of options) {
            const opt = h('option', { value: String(o.value), text: o.label });
            el.append(opt);
        }
        el.value = String(value);
        el.addEventListener('change', () => {
            const o = options.find((x) => String(x.value) === el.value);
            onChange?.(o ? o.value : el.value);
        });
        return el;
    }

    /** Visual checkbox used inside list rows (click handling is up to the row). */
    function checkMark(checked, { partial = false } = {}) {
        return h('span', { class: `org-check${checked ? ' on' : ''}${partial ? ' partial' : ''}`, 'aria-hidden': 'true', html: icon(partial ? 'minus' : 'check', 12) });
    }

    function field(label, control, { hint, cls = '' } = {}) {
        return h('div', { class: `org-field ${cls}`.trim() }, h('div', { class: 'org-field-label', text: label }), control, hint ? h('div', { class: 'org-field-hint', text: hint }) : null);
    }

    // ---------- Keyboard scopes (LIFO) ----------
    // App.ui.dialog listens on document (capture), in registration order — with two dialogs open, Esc would close
    // both. Our panels, sheets and overlays instead register here: one window-capture listener (runs before the
    // document listeners) offers each key to the newest scope first; a scope returning true consumes it.
    const scopes = [];
    window.addEventListener('keydown', (e) => {
        if (e.isComposing || !scopes.length) return;
        for (let i = scopes.length - 1; i >= 0; i--) {
            let consumed = false;
            try {
                consumed = scopes[i](e);
            } catch (err) {
                console.error('[organize] key handler failed', err);
            }
            if (consumed) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
        }
    }, true);

    function keyScope(handler) {
        scopes.push(handler);
        return () => {
            const i = scopes.lastIndexOf(handler);
            if (i >= 0) scopes.splice(i, 1);
        };
    }

    /** Enter on these elements keeps its native meaning (press the button, open the select...). */
    function nativeEnter(t) {
        return !!(t && t.closest && (t.closest('button, select, textarea, a[href], [contenteditable="true"], [data-native-enter]')));
    }

    /** Text fields keep their own Ctrl+Z (text undo). */
    function isTextField(t) {
        if (!t || !t.tagName) return false;
        if (t.isContentEditable || t.tagName === 'TEXTAREA') return true;
        if (t.tagName !== 'INPUT') return false;
        return !['checkbox', 'radio', 'range', 'button', 'submit', 'color', 'file'].includes((t.type || 'text').toLowerCase());
    }

    /** Ctrl+Z belongs to the text field only while it holds text (an empty search box has nothing to undo). */
    function wantsTextUndo(t) {
        if (!isTextField(t)) return false;
        const v = t.isContentEditable ? t.textContent : t.value;
        return (v || '') !== '';
    }

    /**
     * Panel = App.ui.dialog shell with our own header/body/footer layout and keyboard scope.
     * panel({ title, subtitle, icon, width, height, className, build(ctx) }) -> Promise (value passed to close)
     * ctx = { box, main, foot, headRight, close, setTitle, setSubtitle, onClose(fn),
     *         onKey(fn(e) -> consumed?)   every keydown while this panel is the top-most one (any focus target),
     *         onEnter(fn(e))              Enter outside buttons/selects/textareas }
     * Esc closes the panel unless an onKey handler consumed it.
     * Undo keys (owner rule: Ctrl+Z works from every screen). Outside text fields (they keep their own text undo):
     *   opts.undoKeys = true  live panels that follow fs changes (trash, duplicates): Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y
     *                         run App.undo/redo while the panel stays open.
     *   default               planning panels (picker, rename, by date...) would show a stale plan, so the panel is
     *                         dismissed first (as if cancelled) and then the step is undone/redone.
     *   opts.undoKeys = false keys are left alone.
     */
    function panel(opts) {
        const closers = [];
        let afterClose = null; // 'undo' | 'redo' queued by the keys above
        return ui
            .dialog({
                width: opts.width || 720,
                actions: [],
                dismissValue: opts.dismissValue ?? null,
                dismissible: opts.dismissible,
                body: '',
                init(box, close) {
                    box.classList.add('org-panel');
                    for (const c of String(opts.className || '').split(/\s+/).filter(Boolean)) box.classList.add(c);
                    if (opts.height) box.style.height = opts.height;
                    const body = box.querySelector('.dialog-body');
                    const titleEl = h('h3', { class: 'org-head-title', text: opts.title || '' });
                    const subEl = h('div', { class: 'org-head-sub', text: opts.subtitle || '' });
                    const headRight = h('div', { class: 'org-head-right' });
                    const closeBtn = btn({ icon: 'x', kind: 'ghost icon org-close', tip: '닫기', keys: 'Escape', onClick: () => close(opts.dismissValue ?? null) });
                    const head = h('div', { class: 'org-head' },
                        opts.icon ? h('div', { class: `org-head-icon ${opts.iconTone || ''}`.trim(), html: icon(opts.icon, 18) }) : null,
                        h('div', { class: 'org-head-text' }, titleEl, subEl),
                        headRight,
                        closeBtn);
                    const main = h('div', { class: 'org-main' });
                    const foot = h('div', { class: 'org-foot' });
                    body.append(head, main, foot);
                    box.setAttribute('aria-label', opts.title || '');
                    const keyHandlers = [];
                    let enterHandler = null;
                    const isTop = () => {
                        if (!box.isConnected || App.layers.top() === 'menu') return false;
                        const all = document.querySelectorAll('.dialog-backdrop');
                        return all[all.length - 1] === box.parentElement;
                    };
                    closers.push(keyScope((e) => {
                        if (!isTop()) return false;
                        for (const fn of keyHandlers) if (fn(e)) return true;
                        if (opts.undoKeys !== false && (e.ctrlKey || e.metaKey) && !e.altKey && !wantsTextUndo(e.target)) {
                            const k = e.key.toLowerCase();
                            const which = k === 'z' && !e.shiftKey ? 'undo' : (k === 'z' && e.shiftKey) || (k === 'y' && !e.shiftKey) ? 'redo' : null;
                            if (which) {
                                if (!(which === 'undo' ? App.undo.canUndo() : App.undo.canRedo())) return true;
                                if (opts.undoKeys) App.undo[which]();
                                else {
                                    afterClose = which;
                                    close(opts.dismissValue ?? null);
                                }
                                return true;
                            }
                        }
                        if (e.key === 'Escape') {
                            close(opts.dismissValue ?? null);
                            return true;
                        }
                        if (e.key === 'Enter' && enterHandler && !nativeEnter(e.target)) {
                            enterHandler(e);
                            return true;
                        }
                        return false;
                    }));
                    const ctx = {
                        box,
                        body,
                        head,
                        headRight,
                        main,
                        foot,
                        close,
                        setTitle: (t) => (titleEl.textContent = t),
                        setSubtitle: (t) => (subEl.textContent = t),
                        onClose: (fn) => closers.push(fn),
                        onKey: (fn) => keyHandlers.push(fn),
                        onEnter: (fn) => (enterHandler = fn),
                    };
                    opts.build(ctx);
                },
            })
            .then((v) => {
                for (const fn of closers) {
                    try {
                        fn();
                    } catch (e) {
                        console.error(e);
                    }
                }
                // after the caller's own "cancelled" handling (e.g. adopting a folder made in the picker) has run
                if (afterClose) setTimeout(() => App.undo[afterClose](), 0);
                return v;
            });
    }

    /**
     * Inline confirmation sheet shown over a panel (no nested dialogs).
     * sheet(box, { title, message, okLabel, cancelLabel, danger, icon, details }) -> Promise<boolean>
     */
    function sheet(box, opts) {
        return new Promise((resolve) => {
            const prevFocus = document.activeElement;
            const ok = btn({ label: opts.okLabel || '확인', kind: opts.danger ? 'danger' : 'primary' });
            const cancel = btn({ label: opts.cancelLabel || '취소', kind: 'ghost' });
            const card = h('div', { class: 'org-sheet', role: 'alertdialog', 'aria-modal': 'true' },
                h('div', { class: `org-sheet-icon${opts.danger ? ' danger' : ''}`, html: icon(opts.icon || (opts.danger ? 'alert' : 'info'), 20) }),
                h('div', { class: 'org-sheet-title', text: opts.title || '' }),
                opts.message ? h('div', { class: 'org-sheet-msg', text: opts.message }) : null,
                opts.details || null,
                h('div', { class: 'org-sheet-actions' }, cancel, ok));
            const overlay = h('div', { class: 'org-sheet-backdrop' }, card);
            let done = false;
            const finish = (v) => {
                if (done) return;
                done = true;
                release();
                overlay.classList.add('leaving');
                setTimeout(() => overlay.remove(), 120);
                box.classList.remove('org-has-sheet');
                if (prevFocus && prevFocus.isConnected) prevFocus.focus();
                resolve(v);
            };
            const release = keyScope((e) => {
                if (e.key === 'Escape') {
                    finish(false);
                    return true;
                }
                if (e.key === 'Enter') {
                    if (document.activeElement === cancel) finish(false);
                    else finish(true);
                    return true;
                }
                if (e.key === 'Tab') {
                    (document.activeElement === ok ? cancel : ok).focus();
                    return true;
                }
                if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                    (document.activeElement === ok ? cancel : ok).focus();
                    return true;
                }
                return !card.contains(e.target); // swallow other keys meant for the panel underneath
            });
            ok.addEventListener('click', () => finish(true));
            cancel.addEventListener('click', () => finish(false));
            overlay.addEventListener('mousedown', (e) => {
                if (e.target === overlay) finish(false);
            });
            box.classList.add('org-has-sheet');
            box.append(overlay);
            (opts.danger ? cancel : ok).focus();
        });
    }

    /** Thin "busy" overlay for a panel while it waits on something short. */
    function busy(box, text) {
        const label = h('span', { text: text || '잠시만요…' });
        const el = h('div', { class: 'org-busy' }, h('div', { class: 'org-busy-card' }, h('span', { class: 'spinner' }), label));
        box.append(el);
        return { update: (t) => (label.textContent = t), close: () => el.remove() };
    }

    // ---------- Virtual list (fixed row height) ----------
    /**
     * virtualList({ rowHeight, count, render(i) -> Element, overscan, className, label })
     * -> { el, setCount(n), refresh(), update(i), scrollToIndex(i), count }
     */
    function virtualList({ rowHeight, count = 0, render, overscan = 8, className = '', label = '' }) {
        const el = h('div', { class: `org-vlist ${className}`.trim(), tabindex: '0', role: 'listbox', 'aria-label': label || null });
        const sizer = h('div', { class: 'org-vlist-sizer' });
        el.append(sizer);
        const rows = new Map();
        let n = 0;
        let raf = 0;

        function paint() {
            raf = 0;
            const top = el.scrollTop;
            const height = el.clientHeight || 480;
            const first = Math.max(0, Math.floor(top / rowHeight) - overscan);
            const last = Math.min(n - 1, Math.ceil((top + height) / rowHeight) + overscan);
            for (const [i, r] of rows) {
                if (i < first || i > last) {
                    r.remove();
                    rows.delete(i);
                }
            }
            for (let i = first; i <= last; i++) {
                if (rows.has(i)) continue;
                let r;
                try {
                    r = render(i);
                } catch (e) {
                    console.error('[organize] row render failed', e);
                    r = h('div');
                }
                r.style.position = 'absolute';
                r.style.left = '0';
                r.style.right = '0';
                r.style.top = i * rowHeight + 'px';
                r.style.height = rowHeight + 'px';
                r.dataset.index = String(i);
                rows.set(i, r);
                sizer.append(r);
            }
        }
        const schedule = () => {
            if (!raf) raf = requestAnimationFrame(paint);
        };
        el.addEventListener('scroll', schedule, { passive: true });
        const ro = new ResizeObserver(schedule);
        ro.observe(el);

        const api = {
            el,
            get count() {
                return n;
            },
            setCount(c) {
                n = c;
                sizer.style.height = n * rowHeight + 'px';
                api.refresh();
            },
            refresh() {
                for (const r of rows.values()) r.remove();
                rows.clear();
                schedule();
            },
            update(i) {
                const r = rows.get(i);
                if (!r) return;
                r.remove();
                rows.delete(i);
                schedule();
            },
            rowAt(i) {
                return rows.get(i) || null;
            },
            scrollToIndex(i, { center = false } = {}) {
                const t = i * rowHeight;
                if (center) el.scrollTop = t - el.clientHeight / 2 + rowHeight / 2;
                else if (t < el.scrollTop) el.scrollTop = t;
                else if (t + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = t + rowHeight - el.clientHeight;
                schedule();
            },
            paintNow: paint,
            destroy() {
                ro.disconnect();
            },
        };
        api.setCount(count);
        return api;
    }

    // ---------- Thumbnails ----------
    /** Thumbnail tile for an entry (or a promise of one). Uses the shared gallery thumbnail cache. */
    function thumb(entryOrPromise, { cls = '', size } = {}) {
        const box = h('div', { class: `org-thumb ${cls}`.trim() });
        const fill = (entry) => {
            if (!entry) return;
            if (entry.kind === 'dir') {
                box.classList.add('is-dir');
                box.innerHTML = icon('folder', 20);
                return;
            }
            const kindIcon = entry.type === 'video' ? 'film' : entry.type === 'image' ? 'image' : 'file';
            box.innerHTML = '';
            box.append(h('span', { class: 'org-thumb-ico', html: icon(kindIcon, 18) }));
            if (entry.type === 'video') box.classList.add('is-video');
            if (!App.thumbs?.canThumb?.(entry)) {
                if (entry.ext) box.append(h('span', { class: 'org-thumb-ext', text: entry.ext.toUpperCase() }));
                return;
            }
            const img = h('img', { alt: '', draggable: 'false', decoding: 'async' });
            box.append(img);
            const show = (url) => {
                if (!url) return;
                img.src = url;
                box.classList.add('loaded');
            };
            const cached = App.thumbs.peek?.(entry, size);
            if (cached) show(cached);
            else
                App.thumbs
                    .get(entry, size ? { size } : undefined)
                    .then(show)
                    .catch(() => {});
        };
        if (entryOrPromise && typeof entryOrPromise.then === 'function') entryOrPromise.then(fill, () => {});
        else fill(entryOrPromise);
        return box;
    }

    // ---------- Formatting ----------
    const pad2 = (n) => String(n).padStart(2, '0');

    /** fmtDate(ms, 'YYYY-MM-DD HH:mm') — tokens YYYY YY MM M DD D HH H mm ss */
    function fmtDate(ms, fmt = 'YYYY-MM-DD') {
        const d = new Date(ms);
        if (isNaN(d)) return '';
        const map = {
            YYYY: String(d.getFullYear()),
            YY: String(d.getFullYear()).slice(-2),
            MM: pad2(d.getMonth() + 1),
            M: String(d.getMonth() + 1),
            DD: pad2(d.getDate()),
            D: String(d.getDate()),
            HH: pad2(d.getHours()),
            H: String(d.getHours()),
            mm: pad2(d.getMinutes()),
            ss: pad2(d.getSeconds()),
        };
        return fmt.replace(/YYYY|YY|MM|M|DD|D|HH|H|mm|ss/g, (t) => map[t]);
    }

    function startOfDay(ms) {
        const d = new Date(ms);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    }

    /** "방금", "5분 전", "3시간 전", "어제", "4일 전", "2024. 3. 2." */
    function relTime(ms) {
        if (!ms) return '—';
        const now = Date.now();
        const diff = now - ms;
        if (diff < 60000) return '방금';
        if (diff < 3600000) return `${Math.floor(diff / 60000)}분 전`;
        const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY);
        if (days <= 0) return `${Math.max(1, Math.floor(diff / 3600000))}시간 전`;
        if (days === 1) return '어제';
        if (days < 30) return `${days}일 전`;
        return formatDate(ms);
    }

    function plural(n, unit = '개') {
        return `${formatCount(n)}${unit}`;
    }

    // ---------- Media info (dimensions / dates) ----------
    async function readJpegSize(file) {
        let len = Math.min(file.size, 131072);
        let buf = new DataView(await file.slice(0, len).arrayBuffer());
        let off = 2;
        let orientation = 1;
        let size = null;
        for (let guard = 0; guard < 400; guard++) {
            if (off + 4 > buf.byteLength) {
                if (len >= file.size || len >= 4194304) break;
                len = Math.min(file.size, Math.max(off + 65536, len * 2));
                buf = new DataView(await file.slice(0, len).arrayBuffer());
                continue;
            }
            if (buf.getUint8(off) !== 0xff) break;
            const marker = buf.getUint8(off + 1);
            if (marker === 0xff) {
                off++;
                continue;
            }
            if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
                off += 2;
                continue;
            }
            const segLen = buf.getUint16(off + 2);
            if (marker === 0xe1 && off + 4 + segLen <= buf.byteLength && buf.getUint32(off + 4) === 0x45786966) {
                orientation = readExifOrientation(buf, off + 10) || 1;
            }
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                if (off + 9 > buf.byteLength) {
                    len = Math.min(file.size, off + 65536);
                    buf = new DataView(await file.slice(0, len).arrayBuffer());
                }
                const hgt = buf.getUint16(off + 5);
                const w = buf.getUint16(off + 7);
                size = orientation >= 5 && orientation <= 8 ? { w: hgt, h: w } : { w, h: hgt };
                break;
            }
            if (marker === 0xda || marker === 0xd9) break;
            off += 2 + segLen;
        }
        return size;
    }

    function readExifOrientation(view, tiff) {
        try {
            const little = view.getUint16(tiff) === 0x4949;
            const ifd = tiff + view.getUint32(tiff + 4, little);
            const count = view.getUint16(ifd, little);
            for (let i = 0; i < count; i++) {
                const e = ifd + 2 + i * 12;
                if (view.getUint16(e, little) === 0x0112) return view.getUint16(e + 8, little);
            }
        } catch (e) {
            /* truncated */
        }
        return 1;
    }

    /** Pixel size from the file header (no full decode). Returns {w,h} or null. */
    async function readImageSize(file) {
        try {
            const head = new DataView(await file.slice(0, 64).arrayBuffer());
            if (head.byteLength < 26) return null;
            const u8 = (i) => head.getUint8(i);
            if (head.getUint32(0) === 0x89504e47) return { w: head.getUint32(16), h: head.getUint32(20) };
            if (u8(0) === 0x47 && u8(1) === 0x49 && u8(2) === 0x46) return { w: head.getUint16(6, true), h: head.getUint16(8, true) };
            if (u8(0) === 0x42 && u8(1) === 0x4d) return { w: Math.abs(head.getInt32(18, true)), h: Math.abs(head.getInt32(22, true)) };
            if (head.getUint32(0) === 0x52494646 && head.getUint32(8) === 0x57454250 && head.byteLength >= 30) {
                const chunk = head.getUint32(12);
                if (chunk === 0x56503858) return { w: 1 + (u8(24) | (u8(25) << 8) | (u8(26) << 16)), h: 1 + (u8(27) | (u8(28) << 8) | (u8(29) << 16)) };
                if (chunk === 0x5650384c) {
                    const b0 = u8(21), b1 = u8(22), b2 = u8(23), b3 = u8(24);
                    return { w: 1 + (((b1 & 0x3f) << 8) | b0), h: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
                }
                if (chunk === 0x56503820) return { w: head.getUint16(26, true) & 0x3fff, h: head.getUint16(28, true) & 0x3fff };
            }
            if (head.getUint16(0) === 0xffd8) return await readJpegSize(file);
        } catch (e) {
            /* unreadable */
        }
        return null;
    }

    function videoMeta(entry) {
        return new Promise((resolve) => {
            App.fs
                .url(entry.path)
                .then((src) => {
                    const v = document.createElement('video');
                    v.preload = 'metadata';
                    v.muted = true;
                    let finished = false;
                    const done = (r) => {
                        if (finished) return;
                        finished = true;
                        clearTimeout(timer);
                        v.removeAttribute('src');
                        v.load();
                        src.release();
                        resolve(r);
                    };
                    const timer = setTimeout(() => done(null), 5000);
                    v.onloadedmetadata = () => done({ w: v.videoWidth, h: v.videoHeight, duration: isFinite(v.duration) ? v.duration : undefined });
                    v.onerror = () => done(null);
                    v.src = src.url;
                })
                .catch(() => resolve(null));
        });
    }

    const infoPending = new Map();

    /** { w, h, duration } for an entry, from the catalog cache or a cheap probe (cached back via setMeta). */
    function mediaInfo(entry) {
        const meta = App.catalog?.peek(entry.path)?.meta;
        if (meta && meta.w && meta.h) return Promise.resolve({ w: meta.w, h: meta.h, duration: meta.duration });
        if (entry.kind !== 'file' || (entry.type !== 'image' && entry.type !== 'video')) return Promise.resolve(null);
        const key = `${entry.path}|${entry.size}|${entry.mtime}`;
        if (infoPending.has(key)) return infoPending.get(key);
        const job = (async () => {
            let info = null;
            if (entry.type === 'image') {
                try {
                    const file = await App.fs.getFile(entry.path);
                    info = await readImageSize(file);
                    if (!info && App.util.browserCanDecode(entry.name)) {
                        const bmp = await createImageBitmap(file);
                        info = { w: bmp.width, h: bmp.height };
                        bmp.close();
                    }
                } catch (e) {
                    info = null;
                }
            } else if (App.util.browserCanDecode(entry.name)) {
                info = await videoMeta(entry);
            }
            if ((!info || !info.w) && App.server?.available && App.server.media?.probe) {
                try {
                    const r = await App.server.media.probe(entry.path);
                    if (r && r.width) info = { w: r.width, h: r.height, duration: r.duration };
                } catch (e) {
                    /* server can't probe it either */
                }
            }
            if (info && info.w && info.h) App.catalog?.setMeta(entry.path, info);
            return info;
        })();
        infoPending.set(key, job);
        job.finally(() => setTimeout(() => infoPending.delete(key), 1000));
        return job;
    }

    const noTaken = new Set();

    /** Capture time (ms) from the catalog / EXIF / server probe, or null when the file doesn't say. */
    async function takenDate(entry) {
        const meta = App.catalog?.peek(entry.path)?.meta;
        if (meta && meta.taken) return meta.taken;
        if (entry.kind !== 'file') return null;
        const key = `${entry.path}|${entry.size}|${entry.mtime}`;
        if (noTaken.has(key)) return null;
        let taken = null;
        if (entry.type === 'image' && window.exifr && typeof window.exifr.parse === 'function') {
            try {
                const file = await App.fs.getFile(entry.path);
                const r = await window.exifr.parse(file, ['DateTimeOriginal', 'CreateDate']);
                const d = r && (r.DateTimeOriginal || r.CreateDate);
                if (d instanceof Date && !isNaN(d) && d.getFullYear() > 1900) taken = d.getTime();
            } catch (e) {
                /* no EXIF */
            }
        } else if (entry.type === 'video' && App.server?.available && App.server.media?.probe) {
            try {
                const r = await App.server.media.probe(entry.path);
                if (r && r.taken) taken = r.taken;
            } catch (e) {
                /* not available */
            }
        }
        if (taken) App.catalog?.setMeta(entry.path, { taken });
        else noTaken.add(key);
        return taken;
    }

    // ---------- Chips (read-only adapter: App.chipset if present, else chipsets.json) ----------
    function normalizeChipData(data) {
        let cats = [];
        let presets = [];
        if (Array.isArray(data)) cats = data;
        else if (data && Array.isArray(data.presets)) {
            presets = data.presets;
            const active = presets.find((p) => p.id === data.activePreset) || presets[0];
            cats = (active && active.categories) || [];
        } else if (data && Array.isArray(data.categories)) cats = data.categories;

        const byId = new Map();
        const norm = (list, preset) =>
            (list || []).map((c) => {
                const cat = { id: c.id, name: c.name || c.title || '', mode: c.mode, chips: [], preset };
                cat.chips = (c.chips || c.items || []).map((ch, i) => {
                    const chip = { id: ch.id, name: ch.name || ch.label || '', order: i, cat, parent: null, children: [] };
                    chip.children = (ch.children || ch.subs || ch.subChips || ch.chips || []).map((s, j) => {
                        const sub = { id: s.id, name: s.name || s.label || '', order: j, cat, parent: chip, children: [] };
                        if (sub.id != null && !byId.has(sub.id)) byId.set(sub.id, sub);
                        return sub;
                    });
                    if (chip.id != null && !byId.has(chip.id)) byId.set(chip.id, chip);
                    return chip;
                });
                return cat;
            });
        const categories = norm(cats, null);
        // Chips that live in other presets still resolve to names (files may carry them)
        for (const p of presets) if (p.categories && p.categories !== cats) norm(p.categories, p.id);
        return { categories, byId };
    }

    async function chipModel() {
        let data = null;
        const cs = App.chipset;
        try {
            if (cs) {
                if (typeof cs.model === 'function') data = await cs.model();
                else if (typeof cs.getData === 'function') data = await cs.getData();
                else if (typeof cs.data === 'function') data = await cs.data();
                else if (cs.data && typeof cs.data === 'object') data = cs.data;
                else if (typeof cs.categories === 'function') data = await cs.categories();
                else if (Array.isArray(cs.categories)) data = cs.categories;
            }
        } catch (e) {
            console.warn('[organize] App.chipset read failed, falling back to chipsets.json', e);
            data = null;
        }
        if (!data && App.wsdata) data = await App.wsdata.read('chipsets', null);
        return normalizeChipData(data);
    }

    // ---------- Folders ----------
    let folderCache = null;

    /** Every folder path in the workspace ('' = root). Uses the index when ready, else a quick folder-only walk. */
    async function allFolders() {
        if (App.index?.ready) return App.index.folders;
        const ws = App.state.workspace?.id;
        if (folderCache && folderCache.ws === ws) return folderCache.list;
        const out = [''];
        const queue = [''];
        while (queue.length) {
            const d = queue.shift();
            let raws;
            try {
                raws = await App.fs.backend.list(d, { stat: false });
            } catch (e) {
                continue;
            }
            for (const r of raws) {
                if (r.kind !== 'dir' || App.fs.isHiddenName(r.name)) continue;
                const p = P.join(d, r.name);
                out.push(p);
                queue.push(p);
            }
            if (out.length > 200000) break;
        }
        folderCache = { ws, list: out };
        return out;
    }

    App.bus.on('fs:changed', () => {
        folderCache = null;
    });

    /** Raw children of a folder (all kinds incl. non-media), hidden/system names split out. */
    async function listRaw(dir) {
        const raws = await App.fs.backend.list(dir, { stat: false });
        const visible = [];
        const hidden = [];
        for (const r of raws) (App.fs.isHiddenName(r.name) ? hidden : visible).push(r);
        return { visible, hidden };
    }

    /** Lower-cased name -> raw entry for a folder (empty map when it doesn't exist). */
    async function namesIn(dir) {
        try {
            const raws = await App.fs.backend.list(dir, { stat: false });
            return new Map(raws.map((r) => [r.name.toLowerCase(), r]));
        } catch (e) {
            return new Map();
        }
    }

    /**
     * Does a folder hold anything worth keeping (recursively)? Hidden system files (Thumbs.db, desktop.ini,
     * .DS_Store...) don't count; hidden folders (.git...) do, so we never throw those away by accident.
     */
    async function hasVisibleContent(dir) {
        let raws;
        try {
            raws = await App.fs.backend.list(dir, { stat: false });
        } catch (e) {
            return false;
        }
        for (const r of raws) {
            if (App.fs.isHiddenName(r.name)) {
                if (r.kind === 'dir') return true;
                continue;
            }
            if (r.kind === 'file') return true;
            if (await hasVisibleContent(P.join(dir, r.name))) return true;
        }
        return false;
    }

    /** Topmost folders under root (root excluded) that hold nothing worth keeping. */
    async function findEmptyFolders(root, { limit = 5000 } = {}) {
        const out = [];
        async function visit(dir) {
            let raws;
            try {
                raws = await App.fs.backend.list(dir, { stat: false });
            } catch (e) {
                return { empty: false, kids: [] };
            }
            let empty = true;
            const kids = [];
            for (const r of raws) {
                if (App.fs.isHiddenName(r.name)) {
                    if (r.kind === 'dir') empty = false;
                    continue;
                }
                if (r.kind === 'file') {
                    empty = false;
                    continue;
                }
                const child = P.join(dir, r.name);
                const res = await visit(child);
                if (res.empty) kids.push(child);
                else empty = false;
            }
            if (!empty) out.push(...kids);
            return { empty, kids };
        }
        const res = await visit(root);
        if (res.empty) out.push(...res.kids);
        out.sort((a, b) => App.util.compareNames(a, b));
        return out.slice(0, limit);
    }

    function folderLabel(p) {
        return p === '' ? App.state.workspace?.name || '작업 폴더' : P.base(p);
    }

    function folderPathLabel(p) {
        return p === '' ? App.state.workspace?.name || '작업 폴더' : p.split('/').join(' › ');
    }

    // Recent destinations (per workspace, per browser)
    const recent = {
        key: () => `organize.recentDest.${App.state.workspace?.id || 'none'}`,
        get() {
            const v = App.settings.get(recent.key(), []);
            return Array.isArray(v) ? v : [];
        },
        add(p) {
            const list = recent.get().filter((x) => x !== p);
            list.unshift(p);
            App.settings.set(recent.key(), list.slice(0, 8));
        },
        rebase(from, to) {
            const list = recent.get();
            const next = list.map((x) => P.rebase(x, from, to) ?? x);
            if (next.some((x, i) => x !== list[i])) App.settings.set(recent.key(), next);
        },
    };

    App.bus.on('fs:changed', (c) => {
        if (!App.state.workspace || !c.from || !c.to || (c.type !== 'move' && c.type !== 'rename')) return;
        for (let i = 0; i < c.from.length; i++) recent.rebase(c.from[i], c.to[i]);
    });

    // ---------- Hashing ----------
    function toHex(buf) {
        const b = new Uint8Array(buf);
        let s = '';
        for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
        return s;
    }

    // Non-crypto 128-bit fallback (only when crypto.subtle is unavailable, e.g. insecure contexts)
    function fallbackHash(bytes) {
        let h1 = 0xdeadbeef ^ bytes.length;
        let h2 = 0x41c6ce57 ^ bytes.length;
        let h3 = 0x9e3779b9;
        let h4 = 0x85ebca6b;
        for (let i = 0; i < bytes.length; i++) {
            const b = bytes[i];
            h1 = Math.imul(h1 ^ b, 2654435761);
            h2 = Math.imul(h2 ^ b, 1597334677);
            h3 = Math.imul(h3 ^ b, 2246822507);
            h4 = Math.imul(h4 ^ b, 3266489909);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h3 ^ (h3 >>> 13), 3266489909);
        h3 = Math.imul(h3 ^ (h3 >>> 16), 2246822507) ^ Math.imul(h4 ^ (h4 >>> 13), 3266489909);
        h4 = Math.imul(h4 ^ (h4 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return [h1, h2, h3, h4].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
    }

    async function digest(buf) {
        if (window.crypto && crypto.subtle) return toHex(await crypto.subtle.digest('SHA-256', buf));
        return 'f' + fallbackHash(new Uint8Array(buf));
    }

    const SAMPLE = 65536;

    /** Hash of head + middle + tail (64 KB each) + size. Whole file when it is small. */
    async function sampleHash(file) {
        if (file.size <= SAMPLE * 3) return { full: true, hash: await digest(await file.arrayBuffer()) };
        const mid = Math.floor(file.size / 2) - SAMPLE / 2;
        const blob = new Blob([file.slice(0, SAMPLE), file.slice(mid, mid + SAMPLE), file.slice(file.size - SAMPLE), String(file.size)]);
        return { full: false, hash: await digest(await blob.arrayBuffer()) };
    }

    /** Content hash of the whole file, streamed in 16 MB chunks (hash of chunk hashes above 32 MB). */
    async function fullHash(file, { isCancelled } = {}) {
        if (file.size <= 33554432) return digest(await file.arrayBuffer());
        const CH = 16777216;
        const parts = [];
        for (let off = 0; off < file.size; off += CH) {
            if (isCancelled && isCancelled()) throw Object.assign(new Error('cancelled'), { cancelled: true });
            parts.push(await digest(await file.slice(off, off + CH).arrayBuffer()));
        }
        return 'c' + (await digest(new TextEncoder().encode(parts.join('') + ':' + file.size)));
    }

    /** Same size and same sampled content? (used by "skip when identical") */
    async function sameContent(pathA, pathB) {
        try {
            const [a, b] = await Promise.all([App.fs.getFile(pathA), App.fs.getFile(pathB)]);
            if (a.size !== b.size) return false;
            const [ha, hb] = await Promise.all([sampleHash(a), sampleHash(b)]);
            return ha.hash === hb.hash;
        } catch (e) {
            return false;
        }
    }

    // ---------- Targets ----------
    function entryFor(p) {
        return (App.view.indexOf(p) >= 0 ? App.view.get(p) : null) || App.index?.get?.(p) || null;
    }

    async function entriesFor(paths) {
        const out = [];
        for (const p of paths) {
            let e = entryFor(p);
            if (!e) {
                try {
                    e = await App.fs.stat(p);
                } catch (err) {
                    continue;
                }
            }
            out.push(e);
        }
        return out;
    }

    /** Entries an organize command should act on: args.paths, else the selection. */
    async function targetEntries(args) {
        if (args && Array.isArray(args.paths)) return entriesFor(args.paths);
        return App.select.entries();
    }

    function summarizeEntries(entries) {
        const s = { files: 0, dirs: 0, images: 0, videos: 0, others: 0, bytes: 0 };
        for (const e of entries) {
            if (e.kind === 'dir') s.dirs++;
            else {
                s.files++;
                s.bytes += e.size || 0;
                if (e.type === 'image') s.images++;
                else if (e.type === 'video') s.videos++;
                else s.others++;
            }
        }
        return s;
    }

    /** "IMG_0001.jpg 외 11개" */
    function describeItems(entriesOrPaths) {
        const n = entriesOrPaths.length;
        if (!n) return '';
        const first = typeof entriesOrPaths[0] === 'string' ? P.base(entriesOrPaths[0]) : entriesOrPaths[0].name;
        return n === 1 ? first : `${first} 외 ${formatCount(n - 1)}개`;
    }

    function groupBy(list, keyFn) {
        const m = new Map();
        for (const x of list) {
            const k = keyFn(x);
            if (!m.has(k)) m.set(k, []);
            m.get(k).push(x);
        }
        return m;
    }

    function chunk(list, size) {
        const out = [];
        for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
        return out;
    }

    /**
     * Soft-delete many paths into the app trash without pushing undo entries (the caller pushes ONE entry).
     * Works in chunks so a failure only affects its own chunk and a cancelled job stops cleanly.
     * -> { ids, paths (trashed, same order as ids), failed: [{path, error}], cancelled }
     */
    async function trashPaths(paths, { job, onProgress } = {}) {
        const ids = [];
        const done = [];
        const failed = [];
        let cancelled = false;
        const size = Math.max(20, Math.ceil(paths.length / 40));
        for (const part of chunk(paths, size)) {
            if (job && job.cancelled) {
                cancelled = true;
                break;
            }
            try {
                const got = await App.fs.trash(part, { undoable: false, silent: true });
                // fs.trash skips items it couldn't move (and reports them); ids follow the order of the rest
                let moved = part;
                if (got.length !== part.length) {
                    moved = [];
                    for (const p of part) if (!(await App.fs.exists(p))) moved.push(p);
                    for (const p of part) if (!moved.includes(p)) failed.push({ path: p, error: '휴지통으로 옮기지 못했어요', reported: true });
                }
                ids.push(...got);
                done.push(...moved.slice(0, got.length));
            } catch (e) {
                console.warn('[organize] trash failed for a chunk', e);
                for (const p of part) failed.push({ path: p, error: e.message || String(e) });
            }
            onProgress && onProgress(done.length + failed.length, paths.length);
        }
        return { ids, paths: done, failed, cancelled };
    }

    /** Restore trash ids that are still in the trash. -> Map(originalPath -> restored path) */
    async function restoreIds(ids) {
        if (!ids || !ids.length) return new Map();
        const items = await App.fs.listTrash();
        const present = ids.filter((id) => items.some((i) => i.id === id));
        const origin = new Map(items.filter((i) => present.includes(i.id)).map((i) => [i.id, i.originalPath]));
        const restored = await App.fs.restore(present, { undoable: false });
        const map = new Map();
        present.forEach((id, i) => {
            if (restored[i]) map.set(origin.get(id), restored[i]);
        });
        return map;
    }

    const kit = {
        DAY,
        icon,
        btn,
        setBtnLabel,
        seg,
        toggle,
        select,
        checkMark,
        field,
        keyScope,
        panel,
        sheet,
        busy,
        virtualList,
        thumb,
        fmtDate,
        relTime,
        plural,
        formatBytes,
        readImageSize,
        mediaInfo,
        takenDate,
        videoMeta,
        chipModel,
        normalizeChipData,
        allFolders,
        listRaw,
        namesIn,
        hasVisibleContent,
        findEmptyFolders,
        folderLabel,
        folderPathLabel,
        recent,
        digest,
        sampleHash,
        fullHash,
        sameContent,
        entryFor,
        entriesFor,
        targetEntries,
        summarizeEntries,
        describeItems,
        groupBy,
        chunk,
        trashPaths,
        restoreIds,
        isTextField,
        wantsTextUndo,
    };

    // ---------- Gallery context menu ----------
    function contextItems(entries) {
        if (!App.fs.ready) return [];
        const has = (id) => !!App.commands.get(id);
        const files = entries.filter((e) => e.kind === 'file');
        const dirs = entries.filter((e) => e.kind === 'dir');
        const items = [];
        if (!entries.length) {
            const inFolder = App.view.source.type === 'folder';
            const tidy = [
                inFolder && has('organize.byDate') ? { label: '날짜별로 정리…', icon: 'calendar', command: 'organize.byDate' } : null,
                inFolder && has('organize.byChip') ? { label: '칩별로 정리…', icon: 'tag', command: 'organize.byChip' } : null,
                inFolder && App.state.cwd && has('organize.unwrap') ? { label: '이 폴더 풀기', icon: 'folder-output', command: 'organize.unwrap' } : null,
                has('organize.cleanEmpty') ? { label: '빈 폴더 정리…', icon: 'folder', command: 'organize.cleanEmpty' } : null,
            ].filter(Boolean);
            if (tidy.length) items.push({ label: '이 폴더 정리하기', icon: 'sparkles', submenu: tidy });
            if (has('dupes.open')) items.push({ label: '중복 찾기…', icon: 'layers', command: 'dupes.open' });
            if (has('trash.open')) items.push({ label: '휴지통 열기', icon: 'trash', command: 'trash.open' });
            return items;
        }
        if (has('organize.moveTo')) items.push({ label: '다른 폴더로 이동…', icon: 'folder-input', command: 'organize.moveTo' });
        if (has('organize.copyTo')) items.push({ label: '다른 폴더로 복사…', icon: 'copy', command: 'organize.copyTo' });
        if (has('organize.rename') && entries.length > 1) items.push({ label: '이름 일괄 변경…', icon: 'edit', command: 'organize.rename' });
        const tidy = [
            has('organize.rename') && entries.length === 1 ? { label: '이름 규칙으로 바꾸기…', icon: 'edit', command: 'organize.rename' } : null,
            dirs.length && has('organize.unwrap') ? { label: dirs.length > 1 ? `폴더 ${dirs.length}개 풀기` : '폴더 풀기', icon: 'folder-output', command: 'organize.unwrap' } : null,
            files.length && has('organize.byDate') ? { label: '날짜별로 정리…', icon: 'calendar', command: 'organize.byDate' } : null,
            files.length && has('organize.byChip') ? { label: '칩별로 정리…', icon: 'tag', command: 'organize.byChip' } : null,
        ].filter(Boolean);
        if (tidy.length) items.push({ label: '정리하기', icon: 'sparkles', submenu: tidy });
        // The duplicate submenu for selected items ('중복검사') comes from dupes-tools.js (round 2)
        return items;
    }

    App.organize = Object.assign(App.organize || {}, { kit });

    App.register('organize', {
        init() {
            if (App.gallery && Array.isArray(App.gallery.contextMenuItems)) App.gallery.contextMenuItems.push(contextItems);
        },
    });
})();
