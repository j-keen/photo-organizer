/*
 * Viewer shell: full-screen look at one photo/video with previous/next navigation over the visible files.
 * Opens on 'item:open' { path, time?, play? }. The media itself is drawn by renderers (viewer-image.js,
 * viewer-player.js); zoom/pan/orientation by viewer-transform.js. This file owns the frame around them: top bar,
 * side panels ("dock"), hint row, on-screen feedback, fullscreen, idle auto-hide, the file list, wheel navigation and
 * the non-destructive orientation stored in catalog meta: rot (0/90/180/270), flipH, flipV.
 *
 * Public API (App.viewer):
 *   open(path, {time, play}), close(), step(±1), go(index), reload(), current, index, files, count, isOpen, kind, media
 *   toolbarItems.push((entry) => [Element...])      — add buttons to the viewer top bar
 *   contextItems.push((entry, kind) => menuItems)   — add items to the viewer's "더 보기"/right-click menu
 *   hintProviders.push((kind) => [{keys, label}])   — add items to the shortcut hint row
 *   transformOf(path) -> CSS transform string ('' = none); orientationOf(path) -> {rot, flipH, flipV};
 *   rotationOf(path) -> 0|90|180|270; cssTransform(t); describeTransform(t)
 *   changeTransform(paths, (t) => t', label)         — undoable orientation change (one Ctrl+Z)
 *   setRotation(path, rot), rotate(±90), flip('h'|'v'), resetTransform(), applyTransformVars(el, t) (thumbnails)
 *   registerRenderer(type, { mount(ctx) -> instance }), registerPanel({ id, title, icon, keys, render, ... })
 *     — dock panels share ONE column right of the media; the ones fitting the file (def.kinds, default all) are tabs
 *   togglePanel(id, force), isPanelOpen(id), osd(text, {icon}), refreshChrome(), freeze(path)
 * Events: 'viewer:entry' {entry, index, count} (current file changed, before it loads),
 *         'viewer:shown' {entry, media}, 'viewer:closing' {path}, 'viewer:closed' {path},
 *         'viewer:panel' {id} (a dock panel opened) / {id: null, closed, reason} (closed: 'user' | 'viewer' | 'kind')
 */
(() => {
    'use strict';
    const { h, path: P, clamp, escapeHtml } = App.util;
    const ui = App.ui;

    // Icons the shared kit doesn't have (same 24px stroke style as js/core/ui.js)
    const EXTRA_ICONS = {
        repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
        minimize: '<path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"/>',
        'frame-prev': '<path d="M6 5v14"/><path d="m18 6-8 6 8 6V6z"/>',
        'frame-next': '<path d="M18 5v14"/><path d="m6 6 8 6-8 6V6z"/>',
        'seek-back': '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
        'seek-fwd': '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
        'volume-1': '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>',
        'map-pin': '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
        slideshow: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="m10 7 5 3-5 3V7z"/><path d="M8 21h8M12 17v4"/>',
        fit: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
        save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
        gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
        'list-marker': '<path d="M9 6h12M9 12h12M9 18h12"/><path d="M3 4.5h3v4l-1.5-1-1.5 1v-4zM3 10.5h3v4l-1.5-1-1.5 1v-4zM3 16.5h3v4l-1.5-1-1.5 1v-4z"/>',
        'in-point': '<path d="M7 4v16"/><path d="M7 4h5M7 20h5"/><path d="m14 12 5-4v8z"/>',
        'out-point': '<path d="M17 4v16"/><path d="M17 4h-5M17 20h-5"/><path d="m10 12-5-4v8z"/>',
        poster: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/><path d="m9.5 6.5.9 1.8 2 .3-1.45 1.4.35 2-1.8-.95-1.8.95.35-2L6.6 8.6l2-.3z"/>',
        mouse: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v4"/>',
        palette: '<circle cx="13.5" cy="6.5" r="1"/><circle cx="17.5" cy="10.5" r="1"/><circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12.5" r="1"/><path d="M12 2a10 10 0 0 0 0 20c.9 0 1.6-.7 1.6-1.6 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H16c3.3 0 6-2.7 6-6 0-4.9-4.5-8.6-10-8.6Z"/>',
        'reset-orient': '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 8v4l2.5 2.5"/>',
        clip: '<rect x="2" y="4" width="20" height="5" rx="1"/><path d="M4 9v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/>',
    };

    // Also expose them to the shared kit as "vw-<name>" so menus and the command palette can show them.
    // (Integration request: move these into js/core/ui.js ICONS.)
    for (const [k, v] of Object.entries(EXTRA_ICONS)) {
        if (ui.ICONS && !ui.ICONS['vw-' + k]) ui.ICONS['vw-' + k] = v;
    }

    function icon(name, opts = {}) {
        const body = EXTRA_ICONS[name] || EXTRA_ICONS[String(name).replace(/^vw-/, '')];
        if (!body) return ui.icon(name, opts);
        const size = opts.size || 16;
        const style = size !== 16 ? ` style="width:${size}px;height:${size}px"` : '';
        return `<svg class="ico ${opts.class || ''}" width="${size}" height="${size}"${style} viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
    }

    /** Display text for a key combo ('Mod+ArrowLeft' -> 'Ctrl+←'). */
    function dk(combo) {
        return App.commands.displayCombo(combo);
    }

    // ---------- Orientation (non-destructive, catalog meta.rot / flipH / flipV) ----------
    function normRot(r) {
        const n = Math.round((Number(r) || 0) / 90) * 90;
        return ((n % 360) + 360) % 360;
    }

    // Both flips == a 180° turn, so keep at most one flip
    function normalizeTransform(t) {
        let rot = normRot(t && t.rot);
        let flipH = !!(t && t.flipH);
        let flipV = !!(t && t.flipV);
        if (flipH && flipV) {
            rot = normRot(rot + 180);
            flipH = false;
            flipV = false;
        }
        return { rot, flipH, flipV };
    }

    function orientationOf(p) {
        const m = App.catalog?.peek?.(p)?.meta;
        return normalizeTransform({ rot: m?.rot, flipH: m?.flipH, flipV: m?.flipV });
    }

    /** CSS transform for an orientation (flip first, then rotate — the order the viewer uses). '' = none. */
    function cssTransform(t) {
        const parts = [];
        if (t.rot) parts.push(`rotate(${t.rot}deg)`);
        if (t.flipH || t.flipV) parts.push(`scale(${t.flipH ? -1 : 1}, ${t.flipV ? -1 : 1})`);
        return parts.join(' ');
    }

    function isIdentity(t) {
        return !t.rot && !t.flipH && !t.flipV;
    }

    function sameTransform(a, b) {
        return a.rot === b.rot && !!a.flipH === !!b.flipH && !!a.flipV === !!b.flipV;
    }

    function describeTransform(t) {
        return [t.rot ? `${t.rot}°` : null, t.flipH ? '좌우 반전' : null, t.flipV ? '상하 반전' : null].filter(Boolean).join(' · ');
    }

    function withTransform(meta, t) {
        const out = { ...(meta || {}) };
        if (t.rot) out.rot = t.rot;
        else delete out.rot;
        if (t.flipH) out.flipH = true;
        else delete out.flipH;
        if (t.flipV) out.flipV = true;
        else delete out.flipV;
        return out;
    }

    /** Change the orientation of paths as ONE undo step. fn(currentTransform, path) -> next transform. */
    function changeTransform(paths, fn, label) {
        const before = new Map(paths.map((p) => [p, orientationOf(p)]));
        const after = new Map(paths.map((p) => [p, normalizeTransform(fn(before.get(p), p))]));
        const changed = paths.filter((p) => !sameTransform(before.get(p), after.get(p)));
        if (!changed.length) return false;
        const write = (map) => App.catalog.updateMany(changed, (e, p) => {
            e.meta = withTransform(e.meta, map.get(p));
        }, { undoable: false, label });
        write(after);
        App.undo.push({ label, undo: () => write(before), redo: () => write(after) });
        return true;
    }

    // "Flip horizontally" means left<->right on screen, whatever the current rotation is.
    function screenFlip(t, axis) {
        const swap = t.rot % 180 !== 0;
        const local = (axis === 'h') !== swap ? 'h' : 'v';
        return { rot: t.rot, flipH: local === 'h' ? !t.flipH : t.flipH, flipV: local === 'v' ? !t.flipV : t.flipV };
    }

    /** CSS variables used by rotated/flipped thumbnails (gallery cards, filmstrip): see viewer.css */
    function applyTransformVars(el, t) {
        const on = !!t && !isIdentity(t);
        el.classList.toggle('vw-xf-on', on);
        el.classList.toggle('vw-xf-swap', on && t.rot % 180 !== 0);
        if (on) {
            el.style.setProperty('--vw-rot', `${t.rot}deg`);
            el.style.setProperty('--vw-sx', t.flipH ? '-1' : '1');
            el.style.setProperty('--vw-sy', t.flipV ? '-1' : '1');
        } else {
            el.style.removeProperty('--vw-rot');
            el.style.removeProperty('--vw-sx');
            el.style.removeProperty('--vw-sy');
        }
    }

    // ---------- State ----------
    let root;
    let topEl;
    let titleEl;
    let subEl;
    let counterEl;
    let toolsEl;
    let actionsEl;
    let mainEl;
    let stageWrap;
    let stage;
    let overlays;
    let dock;
    let dockBody;
    let dockTitle;
    let bottomEl;
    let hintsEl;
    let osdEl;
    let navPrev;
    let navNext;

    let files = [];
    let index = -1;
    let loadToken = 0;
    let visible = null; // { slot, entry, inst }
    let pending = null;
    let staleTimer = null;
    let lastDirection = 1;
    let enteredFullscreen = false;
    let lastFsExit = 0;
    let idleTimer = null;
    let osdTimer = null;

    const renderers = new Map();
    const panels = new Map();
    let openPanel = null; // { def, cleanup }

    const BG_CHOICES = [
        { id: 'auto', label: '테마 따라가기' },
        { id: 'black', label: '검정' },
        { id: 'dark', label: '어두운 회색' },
        { id: 'gray', label: '회색' },
        { id: 'white', label: '흰색' },
    ];

    const viewer = {
        icon,
        dk,
        toolbarItems: [],
        contextItems: [],
        hintProviders: [],
        player: null, // set by viewer-player.js while a video is shown
        image: null, // set by viewer-image.js while a photo is shown
        view: null, // set by viewer-transform.js: zoom/pan/orientation of the file on screen

        get isOpen() {
            return !!root && !root.hidden;
        },
        get current() {
            return files[index] || null;
        },
        get index() {
            return index;
        },
        /** The file list being browsed (read-only — do not mutate). */
        get files() {
            return files;
        },
        get count() {
            return files.length;
        },
        /** 'image' | 'video' | 'other' | null */
        get kind() {
            const e = files[index];
            return e ? e.type : null;
        },
        get media() {
            return (visible && visible.inst && visible.inst.media) || null;
        },
        get session() {
            return visible ? visible.inst : null;
        },
        get stageEl() {
            return stage;
        },
        get overlayEl() {
            return overlays;
        },
        get root() {
            return root;
        },
        get direction() {
            return lastDirection;
        },

        /** Open a file. opts: { time (seconds, videos), play (bool) } */
        open(p, opts = {}) {
            if (!root) return;
            syncList();
            let i = files.findIndex((e) => e.path === p);
            if (i < 0) {
                // Not in the current view (e.g. a file just created elsewhere): add it next to the current one.
                const entry = App.view.get(p) || App.index?.get?.(p) || null;
                if (!entry) {
                    App.fs.stat(p).then((st) => {
                        if (st && st.kind === 'file' && !files.some((f) => f.path === st.path)) {
                            files.splice(Math.max(0, index + 1), 0, st);
                            viewer.open(p, opts);
                        }
                    }).catch(() => ui.toast('파일을 찾을 수 없어요', { type: 'error' }));
                    return;
                }
                files.splice(Math.max(0, index + 1), 0, entry);
                i = files.indexOf(entry);
            }
            index = i;
            lastDirection = 1;
            if (!viewer.isOpen) {
                root.hidden = false;
                root.classList.add('vw-opening');
                setTimeout(() => root.classList.remove('vw-opening'), 320);
                App.layers.push('viewer');
                applyChromePrefs();
                root.focus({ preventScroll: true });
                poke();
            }
            show({ ...opts });
        },

        close() {
            if (!viewer.isOpen) return;
            const cur = viewer.current;
            if (openPanel) closePanel({ reason: 'viewer' });
            App.bus.emit('viewer:closing', { path: cur?.path });
            if (pending) destroyRec(pending);
            if (visible) destroyRec(visible);
            pending = null;
            visible = null;
            viewer.view = null;
            clearTimeout(staleTimer);
            if (document.fullscreenElement && enteredFullscreen) document.exitFullscreen().catch(() => {});
            enteredFullscreen = false;
            root.hidden = true;
            root.classList.remove('vw-idle');
            clearTimeout(osdTimer);
            osdEl.classList.remove('vw-osd-in', 'vw-osd-out');
            osdEl.innerHTML = '';
            App.layers.pop('viewer');
            if (cur && App.view.indexOf(cur.path) >= 0) {
                App.select.set([cur.path]);
                App.gallery?.scrollTo?.(cur.path);
            }
            App.bus.emit('viewer:closed', { path: cur?.path });
        },

        step(delta, opts = {}) {
            if (!files.length) return;
            lastDirection = delta < 0 ? -1 : 1;
            index = (index + delta + files.length) % files.length;
            show(opts);
        },

        go(i, opts = {}) {
            if (!files.length) return;
            const next = clamp(i, 0, files.length - 1);
            lastDirection = next < index ? -1 : 1;
            index = next;
            show(opts);
        },

        /** Re-read the current file from disk and show it again (after its content changed). */
        async reload() {
            const cur = files[index];
            if (!cur || !viewer.isOpen) return;
            try {
                const st = await App.fs.stat(cur.path);
                if (files[index] === cur) files[index] = st;
            } catch (e) {
                /* gone: fs:changed handles it */
            }
            if (files[index] && files[index].path === cur.path) show({ reload: true });
        },

        // ----- orientation -----
        /** CSS transform string of the stored view orientation ('' when none), e.g. 'rotate(90deg) scale(-1, 1)' */
        transformOf: (p) => cssTransform(orientationOf(p)),
        orientationOf,
        cssTransform,
        rotationOf: (p) => orientationOf(p).rot,
        /** Set the view rotation of one file (one undo step). */
        setRotation(p, rot) {
            return changeTransform([p], (t) => ({ ...t, rot }), '회전');
        },
        describeTransform,
        normalizeTransform,
        isIdentityTransform: isIdentity,
        changeTransform,
        applyTransformVars,

        rotate(delta) {
            const cur = viewer.current;
            if (!cur || (cur.type !== 'image' && cur.type !== 'video')) return;
            changeTransform([cur.path], (t) => ({ ...t, rot: t.rot + delta }), delta > 0 ? '오른쪽으로 회전' : '왼쪽으로 회전');
            const t = orientationOf(cur.path);
            osd(t.rot ? `${t.rot}° 회전` : '원래 방향', { icon: delta > 0 ? 'rotate-cw' : 'rotate-ccw' });
            refreshChrome();
        },

        flip(axis) {
            const cur = viewer.current;
            if (!cur || (cur.type !== 'image' && cur.type !== 'video')) return;
            changeTransform([cur.path], (t) => screenFlip(t, axis), axis === 'h' ? '좌우 반전' : '상하 반전');
            osd(axis === 'h' ? '좌우 반전' : '상하 반전', { icon: axis === 'h' ? 'flip-h' : 'flip-v' });
            refreshChrome();
        },

        resetTransform() {
            const cur = viewer.current;
            if (!cur) return;
            if (changeTransform([cur.path], () => ({ rot: 0 }), '회전·반전 되돌리기')) osd('원래 방향', { icon: 'vw-reset-orient' });
            refreshChrome();
        },

        /** Stop the on-screen media from following catalog orientation changes (while its file is rewritten). */
        freeze(p) {
            if (visible && visible.entry.path === p && visible.inst) visible.inst.frozen = true;
            if (visible?.inst?.view && visible.entry.path === p) visible.inst.view.frozen = true;
        },

        // ----- extension: renderers & dock panels -----
        registerRenderer(type, renderer) {
            renderers.set(type, renderer);
        },

        /**
         * panel: { id, title, icon, keys, toolbar, kinds?: ['image'|'video'], order? (tab order, default 50), closeOnEscape?,
         *          render(body, ctx) -> cleanup?, onEntry?(entry), onClose?({ reason }), hints?() (replace the hint row) }
         */
        registerPanel(def) {
            panels.set(def.id, def);
        },

        togglePanel(id, force) {
            const isOpenNow = openPanel && openPanel.def.id === id;
            const want = force === undefined ? !isOpenNow : !!force;
            if (want === !!isOpenNow) return;
            if (want) showPanel(id);
            else closePanel();
        },

        isPanelOpen(id) {
            return !!openPanel && (id ? openPanel.def.id === id : true);
        },

        get panel() {
            return openPanel ? openPanel.def.id : null;
        },

        /** Re-run a panel's render (e.g. after its data changed). */
        refreshPanel(id) {
            if (openPanel && openPanel.def.id === id) showPanel(id);
        },

        osd,
        refreshChrome,
        poke,
        wheelNavigate,
        refreshHints: () => renderHints(),
        /** Fullscreen the whole page so menus, toasts and popovers keep working. */
        toggleFullscreen,
    };

    // ---------- File list ----------
    function viewFiles() {
        return App.view.visible.filter((e) => e.kind === 'file');
    }

    // Rebuild the list from the gallery's visible entries, keeping the current file selected.
    function syncList() {
        const cur = files[index];
        const next = viewFiles();
        if (cur) {
            const i = next.findIndex((e) => e.path === cur.path);
            if (i >= 0) {
                files = next;
                index = i;
                return true;
            }
            if (viewer.isOpen) {
                // Current file is no longer in the view (moved away, filtered): keep it so the viewer doesn't jump.
                const at = Math.min(index, next.length);
                next.splice(at, 0, cur);
                files = next;
                index = at;
                return false;
            }
        }
        files = next;
        index = Math.min(Math.max(index, 0), files.length - 1);
        return true;
    }

    // ---------- Showing an entry ----------
    function destroyRec(rec) {
        if (!rec) return;
        try {
            rec.inst?.destroy?.();
        } catch (e) {
            console.error('[viewer] renderer destroy failed', e);
        }
        rec.slot.remove();
    }

    function show(opts = {}) {
        const entry = files[index];
        if (!entry) return;
        const token = ++loadToken;
        updateChrome(entry);
        App.select.set([entry.path]);
        // a panel made for another kind of file (메모 목록 → a photo) steps out; another panel may take the dock
        if (openPanel && openPanel.def.kinds && !openPanel.def.kinds.includes(entry.type)) closePanel({ reason: 'kind' });
        App.bus.emit('viewer:entry', { entry, index, count: files.length });

        if (pending) destroyRec(pending);
        pending = null;
        if (visible) {
            try {
                visible.inst?.deactivate?.();
            } catch (e) {
                /* ignore */
            }
        }
        clearTimeout(staleTimer);

        const slot = h('div', { class: 'vw-slot', dataset: { path: entry.path } });
        if (opts.transition === 'fade' && visible) slot.classList.add('vw-fade-in');
        stage.append(slot);
        const rec = { slot, entry, inst: null, token, ready: false, mounting: true, readyQueued: false };
        pending = rec;
        const renderer = renderers.get(entry.type) || renderers.get('other');
        const ctx = {
            entry,
            slot,
            token,
            opts,
            viewer,
            icon,
            get active() {
                return token === loadToken && (pending === rec || visible === rec);
            },
            get shown() {
                return visible === rec;
            },
            // Renderer has something on screen: swap it in (old slot goes away in the same frame)
            ready: () => {
                if (rec.mounting) rec.readyQueued = true;
                else promote(rec);
            },
            stageSize: () => ({ w: stage.clientWidth, h: stage.clientHeight }),
        };
        staleTimer = setTimeout(() => {
            if (pending !== rec) return;
            visible?.slot.classList.add('vw-stale');
            slot.classList.add('vw-loading');
        }, opts.reload ? 400 : 140);
        try {
            rec.inst = (renderer && renderer.mount(ctx)) || {};
        } catch (e) {
            console.error('[viewer] renderer failed', e);
            rec.inst = {};
            slot.append(viewer.card({ icon: 'alert', tone: 'is-error', title: '이 파일을 열 수 없어요', text: escapeHtml(e.message || String(e)) }));
            rec.readyQueued = true;
        }
        rec.mounting = false;
        if (pending === rec && (rec.readyQueued || rec.inst.immediate)) promote(rec);
    }

    function promote(rec) {
        if (rec.ready || pending !== rec) return;
        rec.ready = true;
        clearTimeout(staleTimer);
        rec.slot.classList.remove('vw-loading');
        const old = visible;
        visible = rec;
        pending = null;
        viewer.view = rec.inst?.view || null;
        try {
            rec.inst?.onShown?.();
        } catch (e) {
            console.error('[viewer] onShown failed', e);
        }
        if (old) {
            if (rec.slot.classList.contains('vw-fade-in')) {
                old.slot.classList.add('vw-fade-out');
                try {
                    old.inst?.deactivate?.();
                } catch (e) {
                    /* ignore */
                }
                setTimeout(() => destroyRec(old), 480);
            } else {
                destroyRec(old);
            }
        }
        renderHints();
        refreshChrome();
        App.bus.emit('viewer:shown', { entry: rec.entry, media: rec.inst?.media || null });
        if (openPanel) {
            try {
                openPanel.def.onEntry?.(rec.entry);
            } catch (e) {
                console.error('[viewer] panel onEntry failed', e);
            }
            renderDockHead(); // photo ↔ video changes which tabs fit
        }
    }

    viewer.card = function card({ icon: ic = 'info', title, text, actions = [], tone = '' }) {
        return h('div', { class: `vw-card ${tone}` },
            h('div', { class: 'vw-card-icon', html: icon(ic, { size: 26 }) }),
            h('div', { class: 'vw-card-title', text: title }),
            text ? h('div', { class: 'vw-card-text', html: text }) : null,
            actions.length ? h('div', { class: 'vw-card-actions' }, ...actions) : null);
    };

    // Fallback renderer for anything without a dedicated renderer
    viewer.registerRenderer('other', {
        mount(ctx) {
            const e = ctx.entry;
            ctx.slot.append(viewer.card({
                icon: 'file',
                title: `${(e.ext || '파일').toUpperCase()} 파일은 여기서 미리 볼 수 없어요`,
                text: escapeHtml(App.util.formatBytes(e.size)),
            }));
            return { immediate: true };
        },
    });

    // ---------- Chrome (top bar, nav, hints) ----------
    function btn(iconName, tip, keys, onclick, extra = {}) {
        const b = h('button', {
            class: `btn ghost icon vw-btn ${extra.class || ''}`,
            'aria-label': tip,
            'data-tip': tip,
            'data-tip-keys': keys || null,
            html: icon(iconName),
            onclick,
            onmousedown: (e) => e.preventDefault(), // keep focus off buttons so Space/Enter stay shortcuts
        });
        if (extra.id) b.dataset.act = extra.id;
        return b;
    }
    viewer.button = btn;

    function cmdKey(id) {
        const c = App.commands.get(id);
        return c && c.keys.length ? c.keys[0] : null;
    }

    function updateChrome(entry) {
        titleEl.textContent = entry.name;
        titleEl.title = entry.path;
        const folder = P.parent(entry.path);
        subEl.textContent = folder ? folder.replace(/\//g, ' › ') : App.state.workspace?.name || '';
        counterEl.textContent = `${App.util.formatCount(index + 1)} / ${App.util.formatCount(files.length)}`;
        toolsEl.innerHTML = '';
        for (const fn of viewer.toolbarItems) {
            try {
                for (const el of fn(entry) || []) toolsEl.append(el);
            } catch (e) {
                console.error('[viewer] toolbar contributor failed', e);
            }
        }
        root.dataset.kind = entry.type;
        const single = files.length < 2;
        navPrev.hidden = single;
        navNext.hidden = single;
        refreshChrome();
    }

    function canApplyToFile(entry) {
        if (!entry) return false;
        if (entry.type === 'image') return !!viewer.rotateFile?.canApply?.(entry);
        if (entry.type === 'video') return !!App.videoEditor?.canApplyViewTransform?.(entry);
        return false;
    }

    function refreshChrome() {
        if (!root || !viewer.isOpen) return;
        const entry = viewer.current;
        if (!entry) return;
        const kind = entry.type;
        actionsEl.innerHTML = '';
        const t = orientationOf(entry.path);
        const media = kind === 'image' || kind === 'video';

        if (media && !isIdentity(t) && canApplyToFile(entry)) {
            actionsEl.append(h('button', {
                class: 'btn sm vw-apply-rot',
                'data-tip': kind === 'video' ? '지금 보기 방향 그대로 새 영상 파일을 만들어요 (로컬 서버)' : '지금 방향은 이 앱에서만 보여요. 파일 자체를 돌려 저장해요',
                html: `${icon(t.rot ? 'rotate-cw' : t.flipH ? 'flip-h' : 'flip-v', { size: 14 })}<span>${escapeHtml(describeTransform(t))}</span><span class="vw-apply-sep"></span><span>파일에 적용</span>`,
                onmousedown: (e) => e.preventDefault(),
                onclick: () => App.commands.run('viewer.applyTransform'),
            }));
        }
        if (media) {
            actionsEl.append(
                btn('rotate-ccw', '왼쪽으로 회전', cmdKey('viewer.rotateCCW'), () => App.commands.run('viewer.rotateCCW')),
                btn('rotate-cw', '오른쪽으로 회전', cmdKey('viewer.rotateCW'), () => App.commands.run('viewer.rotateCW')),
                btn('flip-h', '좌우 반전', cmdKey('viewer.flipH'), () => App.commands.run('viewer.flipH'), { class: (t.rot % 180 ? t.flipV : t.flipH) ? 'active' : '', id: 'flip-h' }),
                btn('flip-v', '상하 반전', cmdKey('viewer.flipV'), () => App.commands.run('viewer.flipV'), { class: (t.rot % 180 ? t.flipH : t.flipV) ? 'active' : '', id: 'flip-v' }),
                h('span', { class: 'vw-sep' }));
        }
        const infoOn = App.settings.get('viewer.info', false);
        actionsEl.append(btn('info', '정보', cmdKey('viewer.info'), () => App.commands.run('viewer.info'), { class: infoOn ? 'active' : '', id: 'info' }));
        const stripOn = App.settings.get('viewer.filmstrip', true);
        actionsEl.append(btn('film', '필름 스트립', cmdKey('viewer.filmstrip'), () => App.commands.run('viewer.filmstrip'), { class: stripOn ? 'active' : '', id: 'filmstrip' }));
        if (App.commands.get('viewer.slideshow')) {
            const running = viewer.slideshow?.running;
            actionsEl.append(btn('vw-slideshow', running ? '슬라이드쇼 끝내기' : '슬라이드쇼 (간격·순서는 우클릭)', cmdKey('viewer.slideshow'), () => App.commands.run('viewer.slideshow'), { class: running ? 'active' : '', id: 'slideshow' }));
        }
        if (kind === 'video') {
            for (const p of panels.values()) {
                if (!p.toolbar) continue;
                actionsEl.append(btn(p.icon || 'info', p.title, p.keys || null, () => viewer.togglePanel(p.id), { class: viewer.isPanelOpen(p.id) ? 'active' : '', id: 'panel-' + p.id }));
            }
        }
        actionsEl.append(h('span', { class: 'vw-sep' }));
        const fs = !!document.fullscreenElement;
        actionsEl.append(btn(fs ? 'vw-minimize' : 'maximize', fs ? '전체 화면 끝내기' : '전체 화면', cmdKey('viewer.fullscreen'), () => App.commands.run('viewer.fullscreen'), { id: 'fullscreen' }));
        actionsEl.append(btn('more-vertical', '더 보기', cmdKey('viewer.menu'), (ev) => openMoreMenu(ev.currentTarget), { id: 'more' }));
        const showBtn = actionsEl.querySelector('[data-act="slideshow"]');
        if (showBtn && viewer.slideshow?.menu) {
            showBtn.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                viewer.slideshow.menu(showBtn);
            });
        }
    }

    function openMoreMenu(anchor) {
        ui.menu(buildMenuItems(), { anchor, align: 'end' });
    }

    function buildMenuItems() {
        const entry = viewer.current;
        if (!entry) return [];
        const kind = entry.type;
        const items = [];
        for (const fn of viewer.contextItems) {
            try {
                const more = fn(entry, kind);
                if (more && more.length) items.push(...more, '-');
            } catch (e) {
                console.error('[viewer] context contributor failed', e);
            }
        }
        if (kind === 'image' || kind === 'video') {
            const t = orientationOf(entry.path);
            items.push(
                { label: '오른쪽으로 회전', icon: 'rotate-cw', command: 'viewer.rotateCW' },
                { label: '왼쪽으로 회전', icon: 'rotate-ccw', command: 'viewer.rotateCCW' },
                { label: '좌우 반전', icon: 'flip-h', command: 'viewer.flipH' },
                { label: '상하 반전', icon: 'flip-v', command: 'viewer.flipV' },
                { label: '회전·반전 되돌리기', icon: 'vw-reset-orient', command: 'viewer.resetTransform', disabled: isIdentity(t) });
            if (canApplyToFile(entry)) items.push({ label: '회전·반전을 파일에 적용…', icon: 'vw-save', command: 'viewer.applyTransform', disabled: isIdentity(t) });
            items.push('-');
        }
        const photoWheel = App.settings.get('viewer.wheelNav', true) !== false;
        const videoWheel = App.settings.get('viewer.videoWheel', 'volume') === 'volume';
        items.push(
            { label: '정보 보기', icon: 'info', command: 'viewer.info', checked: !!App.settings.get('viewer.info', false) },
            { label: '필름 스트립', icon: 'film', command: 'viewer.filmstrip', checked: !!App.settings.get('viewer.filmstrip', true) },
            { label: '단축키 힌트', icon: 'keyboard', command: 'viewer.hints', checked: !!App.settings.get('viewer.hints', true) },
            {
                label: '마우스 휠',
                icon: 'vw-mouse',
                checked: false,
                submenu: () => [
                    { header: `확대·축소는 ${dk('Mod')}+휠` },
                    { label: photoWheel ? '사진: 이전/다음 파일로' : '사진: 이전/다음 파일로 (지금은 확대)', checked: photoWheel, action: () => App.settings.set('viewer.wheelNav', !photoWheel) },
                    { label: '영상: 소리 크기', checked: videoWheel, action: () => App.settings.set('viewer.videoWheel', videoWheel ? 'none' : 'volume') },
                ],
            },
            {
                label: '배경',
                icon: 'vw-palette',
                checked: false,
                submenu: () => BG_CHOICES.map((b) => ({ label: b.label, checked: App.settings.get('viewer.bg', 'auto') === b.id, action: () => setBackground(b.id) })),
            },
            '-');
        if (App.server?.reveal || App.fs.backend?.reveal) {
            items.push({ label: '탐색기에서 보기', icon: 'external', action: () => revealCurrent() });
        }
        items.push({ label: '휴지통으로 이동', icon: 'trash', command: 'viewer.trash', danger: true });
        return items;
    }

    async function revealCurrent() {
        const cur = viewer.current;
        if (!cur) return;
        try {
            if (App.server?.reveal) await App.server.reveal(cur.path);
            else await App.fs.backend.reveal(cur.path);
        } catch (e) {
            ui.toast(`탐색기를 열 수 없어요: ${e.message}`, { type: 'error' });
        }
    }

    function setBackground(id) {
        App.settings.set('viewer.bg', id);
        root.dataset.bg = id;
    }

    function applyChromePrefs() {
        root.dataset.bg = App.settings.get('viewer.bg', 'auto');
        root.classList.toggle('vw-no-hints', !App.settings.get('viewer.hints', true));
        root.classList.toggle('vw-no-strip', !App.settings.get('viewer.filmstrip', true));
    }

    // ---------- Hint row ----------
    // Hint items: { keys: ['←', '→'] (display text), mouse?: true, label }. Use App.viewer.dk(combo) for real combos.
    function hintKeysHtml(keys) {
        return keys.map((k) => `<span class="kbd">${escapeHtml(k)}</span>`).join('');
    }

    function renderHints() {
        if (!hintsEl) return;
        const entry = viewer.current;
        const kind = entry ? entry.type : null;
        let list = [];
        const panelHints = openPanel?.def.hints?.();
        if (panelHints && panelHints.length) list = panelHints;
        else {
            const instHints = visible?.inst?.hints?.() || [];
            list = [...instHints];
            for (const fn of viewer.hintProviders) {
                try {
                    list.push(...(fn(kind) || []));
                } catch (e) {
                    /* ignore */
                }
            }
        }
        list.push({ keys: ['F'], label: '전체 화면' }, { keys: [dk('Shift+H')], label: '힌트 끄기' }, { keys: [dk('Escape')], label: '닫기' });
        hintsEl.innerHTML = list
            .map((it) => `<span class="vw-hint">${hintKeysHtml(it.keys || [])}${it.mouse ? `<span class="vw-hint-mouse">${icon('mouse', { size: 13 })}</span>` : ''}<span>${escapeHtml(it.label)}</span></span>`)
            .join('');
    }

    // ---------- Dock panels (right side) ----------
    // One column next to the media, part of the layout (never floating over it). Panels that fit the file on screen
    // show as tabs in its head (e.g. 칩 | 메모 목록 for a video), so switching never hunts for a toolbar button.
    function panelsFor(kind) {
        return [...panels.values()].filter((p) => !p.kinds || p.kinds.includes(kind)).sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
    }

    function renderDockHead() {
        if (!openPanel) return;
        const def = openPanel.def;
        const list = panelsFor(viewer.current?.type);
        dockTitle.innerHTML = '';
        dockTitle.classList.toggle('has-tabs', list.length > 1 && list.includes(def));
        if (!dockTitle.classList.contains('has-tabs')) {
            dockTitle.innerHTML = `${icon(def.icon || 'info', { size: 15 })}<span>${escapeHtml(def.title)}</span>`;
            return;
        }
        for (const p of list) {
            const on = p === def;
            dockTitle.append(h('button', {
                type: 'button',
                class: `vw-dock-tab${on ? ' on' : ''}`,
                'aria-pressed': String(on),
                'data-tip': p.title,
                'data-tip-keys': p.keys || null,
                dataset: { panel: p.id },
                html: `${icon(p.icon || 'info', { size: 14 })}<span>${escapeHtml(p.title)}</span>`,
                onmousedown: (e) => e.preventDefault(),
                onclick: () => !on && showPanel(p.id),
            }));
        }
    }

    function showPanel(id) {
        const def = panels.get(id);
        if (!def) return;
        if (openPanel) closePanel({ silent: true, reason: 'switch' });
        dock.hidden = false;
        root.classList.add('vw-has-dock');
        dockBody.innerHTML = '';
        dockBody.dataset.panel = id;
        let cleanup = null;
        try {
            cleanup = def.render(dockBody, { entry: viewer.current, viewer, icon }) || null;
        } catch (e) {
            console.error('[viewer] panel render failed', e);
        }
        openPanel = { def, cleanup };
        renderDockHead();
        renderHints();
        refreshChrome();
        resizeAll();
        App.bus.emit('viewer:panel', { id });
    }

    /**
     * reason (passed to def.onClose): 'user' (closed it), 'switch' (another panel took the dock), 'viewer' (viewer closed),
     * 'kind' (the next file isn't a kind the panel is for)
     */
    function closePanel({ silent = false, reason = 'user' } = {}) {
        if (!openPanel) return;
        const id = openPanel.def.id;
        try {
            if (typeof openPanel.cleanup === 'function') openPanel.cleanup();
            openPanel.def.onClose?.({ reason });
        } catch (e) {
            console.error('[viewer] panel cleanup failed', e);
        }
        openPanel = null;
        dock.hidden = true;
        dockBody.innerHTML = '';
        root.classList.remove('vw-has-dock');
        if (!silent) {
            renderHints();
            refreshChrome();
            resizeAll();
        }
        if (reason !== 'switch') App.bus.emit('viewer:panel', { id: null, closed: id, reason });
    }

    function resizeAll() {
        requestAnimationFrame(() => {
            visible?.inst?.resize?.();
            pending?.inst?.resize?.();
        });
    }

    // ---------- On-screen display (feedback bubble) ----------
    function osd(text, { icon: ic = null, duration = 750 } = {}) {
        if (!osdEl) return;
        osdEl.innerHTML = `${ic ? icon(ic, { size: 22 }) : ''}<span>${escapeHtml(text)}</span>`;
        osdEl.classList.remove('vw-osd-out');
        osdEl.classList.add('vw-osd-in');
        clearTimeout(osdTimer);
        osdTimer = setTimeout(() => {
            osdEl.classList.remove('vw-osd-in');
            osdEl.classList.add('vw-osd-out');
        }, duration);
    }

    // ---------- Mouse wheel: previous/next file (photos; when not zoomed in) ----------
    let wheelAcc = 0;
    let wheelLast = 0;
    let wheelStepAt = 0;
    let wheelLock = 0;

    /** Called by the view transform for a plain wheel that didn't zoom/pan. Returns true when handled. */
    function wheelNavigate(e) {
        if (!viewer.isOpen || files.length < 2 || App.settings.get('viewer.wheelNav', true) === false) return false;
        e.preventDefault();
        const now = performance.now();
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (!d) return true;
        // Mouse wheels send whole "notches" (100+ px or line mode); trackpads send many small deltas.
        const notch = e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 100 && Number.isInteger(e.deltaY));
        if (notch) {
            if (now - wheelStepAt < 110) return true;
            wheelStepAt = now;
            viewer.step(d > 0 ? 1 : -1);
            return true;
        }
        // one file per trackpad gesture (ignore the inertia tail)
        if (now < wheelLock) {
            wheelLock = now + 240;
            return true;
        }
        if (now - wheelLast > 240) wheelAcc = 0;
        wheelLast = now;
        wheelAcc += d;
        if (Math.abs(wheelAcc) >= 110) {
            viewer.step(wheelAcc > 0 ? 1 : -1);
            wheelAcc = 0;
            wheelLock = now + 240;
        }
        return true;
    }

    // ---------- Idle auto-hide (controls fade while watching) ----------
    const IDLE_MS = 2600;

    function shouldAutoHide() {
        if (!viewer.isOpen) return false;
        if (root.querySelector('.vw-top:hover, .vw-ctl:hover, .vw-strip:hover, .vw-dock:hover, .vw-info:hover, .vw-show-hud:hover')) return false;
        if (document.querySelector('.menu, .dialog-backdrop')) return false;
        if (root.querySelector('.vw-ctl:focus-within')) return false; // typing a piece memo
        if (viewer.slideshow?.running) return true;
        if (viewer.player?.playing) return true;
        return !!document.fullscreenElement;
    }

    function poke() {
        if (!root) return;
        root.classList.remove('vw-idle');
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            if (shouldAutoHide()) root.classList.add('vw-idle');
        }, IDLE_MS);
    }

    // ---------- Fullscreen ----------
    function toggleFullscreen() {
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
            return;
        }
        const el = document.documentElement;
        if (!el.requestFullscreen) return;
        el.requestFullscreen().then(() => {
            enteredFullscreen = true;
        }).catch((e) => ui.toast(`전체 화면으로 바꿀 수 없어요: ${e.message}`, { type: 'warning' }));
    }

    // ---------- Commands (general) ----------
    const isOpen = () => viewer.isOpen;
    const isVideo = () => viewer.isOpen && viewer.kind === 'video';
    const isImage = () => viewer.isOpen && viewer.kind === 'image';
    const isMedia = () => isImage() || isVideo();

    // ←/→ change file for photos; for videos they seek (viewer-player.js), Ctrl+←/→ and PageUp/PageDown always change file.
    function arrowStep(delta, event) {
        const plainArrow = event && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !event.ctrlKey && !event.metaKey;
        if (plainArrow && isVideo() && viewer.player && !viewer.player.failed) {
            viewer.player.seekStep(delta);
            return;
        }
        viewer.step(delta);
    }

    App.commands.register({
        id: 'viewer.close',
        title: '보기 닫기',
        group: '보기',
        icon: 'x',
        scope: 'viewer',
        keys: ['Escape'],
        run: () => {
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => {});
                return;
            }
            if (Date.now() - lastFsExit < 300) return; // the Esc that just left fullscreen
            if (viewer.slideshow?.running) {
                viewer.slideshow.stop();
                return;
            }
            if (App.videoEdit?.deselect?.()) return; // a selected edit piece goes first
            if (openPanel && openPanel.def.closeOnEscape !== false) {
                closePanel();
                return;
            }
            viewer.close();
        },
    });
    App.commands.register({ id: 'viewer.prev', title: '이전 파일', group: '보기', icon: 'chevron-left', scope: 'viewer', keys: ['PageUp', 'Mod+ArrowLeft', 'ArrowLeft'], when: isOpen, run: (a) => arrowStep(-1, a && a.event) });
    App.commands.register({ id: 'viewer.next', title: '다음 파일', group: '보기', icon: 'chevron-right', scope: 'viewer', keys: ['PageDown', 'Mod+ArrowRight', 'ArrowRight'], when: isOpen, run: (a) => arrowStep(1, a && a.event) });
    App.commands.register({
        id: 'viewer.first',
        title: '처음 파일',
        group: '보기',
        scope: 'viewer',
        keys: ['Home'],
        when: isOpen,
        run: () => (isVideo() && viewer.player ? viewer.player.seek(0) : viewer.go(0)),
    });
    App.commands.register({
        id: 'viewer.last',
        title: '마지막 파일',
        group: '보기',
        scope: 'viewer',
        keys: ['End'],
        when: isOpen,
        run: () => (isVideo() && viewer.player ? viewer.player.seek(Math.max(0, (viewer.player.duration || 0) - 0.05)) : viewer.go(files.length - 1)),
    });
    App.commands.register({
        id: 'viewer.playPause',
        title: '재생/일시정지',
        group: '보기',
        icon: 'play',
        scope: 'viewer',
        keys: ['Space'],
        when: isOpen,
        run: () => {
            if (viewer.slideshow?.running) return viewer.slideshow.togglePause();
            if (isVideo() && viewer.player) return viewer.player.toggle();
            if (isImage() && viewer.view) return viewer.view.toggleZoom();
        },
    });
    App.commands.register({
        id: 'viewer.trash',
        title: '휴지통으로 이동',
        group: '보기',
        icon: 'trash',
        scope: 'viewer',
        keys: ['Delete'],
        when: isOpen,
        run: async () => {
            const cur = viewer.current;
            if (!cur) return;
            // A selected edit piece on the seek bar: Delete removes (or restores) that piece, not the file
            if (isVideo() && App.videoEdit?.removeSelected?.()) return;
            // Settings › 일반 › '삭제 전 확인' (off by default: deletes are soft and undoable)
            if (App.settings.get('trash.confirm', false) && !(await ui.confirm({ title: '휴지통으로 옮기기', message: `"${cur.name}"을(를) 휴지통으로 옮길까요?`, okLabel: '휴지통으로', danger: true }))) return;
            visible?.inst?.deactivate?.();
            // fs:changed (trash) moves the viewer to the neighbour; App.fs.trash pushes its own undo entry
            await App.fs.trash([cur.path]);
        },
    });
    App.commands.register({ id: 'viewer.rotateCW', title: '오른쪽으로 회전', group: '보기', icon: 'rotate-cw', scope: 'viewer', keys: ['R'], when: isMedia, run: () => viewer.rotate(90) });
    App.commands.register({ id: 'viewer.rotateCCW', title: '왼쪽으로 회전', group: '보기', icon: 'rotate-ccw', scope: 'viewer', keys: ['Shift+R'], when: isMedia, run: () => viewer.rotate(-90) });
    App.commands.register({ id: 'viewer.flipH', title: '좌우 반전', group: '보기', icon: 'flip-h', scope: 'viewer', keys: ['H'], when: isMedia, run: () => viewer.flip('h') });
    App.commands.register({ id: 'viewer.flipV', title: '상하 반전', group: '보기', icon: 'flip-v', scope: 'viewer', keys: ['V'], when: isMedia, run: () => viewer.flip('v') });
    App.commands.register({
        id: 'viewer.resetTransform',
        title: '회전·반전 되돌리기',
        group: '보기',
        icon: 'vw-reset-orient',
        scope: 'viewer',
        when: () => isMedia() && !isIdentity(orientationOf(viewer.current.path)),
        run: () => viewer.resetTransform(),
    });
    App.commands.register({
        id: 'viewer.applyTransform',
        title: '회전·반전을 파일에 적용',
        group: '보기',
        icon: 'vw-save',
        scope: 'viewer',
        when: () => isMedia() && canApplyToFile(viewer.current) && !isIdentity(orientationOf(viewer.current.path)),
        run: () => (isVideo() ? App.videoEditor.applyViewTransform(viewer.current) : viewer.rotateFile.apply(viewer.current)),
    });
    App.commands.register({
        id: 'viewer.fullscreen',
        title: '전체 화면',
        group: '보기',
        icon: 'maximize',
        scope: 'viewer',
        keys: ['F'],
        when: isOpen,
        run: () => toggleFullscreen(),
    });
    App.commands.register({
        id: 'viewer.hints',
        title: '단축키 힌트 보이기/숨기기',
        group: '보기',
        icon: 'keyboard',
        scope: 'viewer',
        keys: ['Shift+H'],
        when: isOpen,
        run: () => {
            const on = !App.settings.get('viewer.hints', true);
            App.settings.set('viewer.hints', on);
            root.classList.toggle('vw-no-hints', !on);
            resizeAll();
        },
    });
    // Undo/redo in the viewer: core edit.undo / edit.redo are global commands (Mod+Z, Mod+Shift+Z / Mod+Y).
    App.commands.register({
        id: 'viewer.menu',
        title: '보기 메뉴',
        group: '보기',
        icon: 'more-vertical',
        scope: 'viewer',
        keys: ['Shift+F10', 'ContextMenu'],
        when: isOpen,
        run: () => openMoreMenu(actionsEl.querySelector('[data-act="more"]') || actionsEl),
    });

    // Orientation of the selection from the gallery (no viewer needed) — one undo step for the whole batch
    function selectedMedia() {
        return App.select.entries().filter((e) => e.type === 'image' || e.type === 'video').map((e) => e.path);
    }
    function orientSelected(fn, label, done) {
        const paths = selectedMedia();
        if (!paths.length) return;
        if (!changeTransform(paths, fn, label)) return;
        ui.toast(paths.length === 1 ? done : `${App.util.formatCount(paths.length)}개 파일을 ${done}`, {
            type: 'success',
            duration: 2600,
            action: { label: '실행 취소', run: () => App.undo.undo() },
        });
    }
    const hasMediaSelection = () => App.fs.ready && App.select.entries().some((e) => e.type === 'image' || e.type === 'video');
    App.commands.register({ id: 'viewer.rotateSelectedCW', title: '선택한 파일 오른쪽으로 회전', group: '보기', icon: 'rotate-cw', when: hasMediaSelection, run: () => orientSelected((t) => ({ ...t, rot: t.rot + 90 }), '오른쪽으로 회전', '회전했어요') });
    App.commands.register({ id: 'viewer.rotateSelectedCCW', title: '선택한 파일 왼쪽으로 회전', group: '보기', icon: 'rotate-ccw', when: hasMediaSelection, run: () => orientSelected((t) => ({ ...t, rot: t.rot - 90 }), '왼쪽으로 회전', '회전했어요') });
    App.commands.register({ id: 'viewer.flipSelected', title: '선택한 파일 좌우 반전', group: '보기', icon: 'flip-h', when: hasMediaSelection, run: () => orientSelected((t) => screenFlip(t, 'h'), '좌우 반전', '좌우 반전했어요') });
    App.commands.register({ id: 'viewer.flipSelectedV', title: '선택한 파일 상하 반전', group: '보기', icon: 'flip-v', when: hasMediaSelection, run: () => orientSelected((t) => screenFlip(t, 'v'), '상하 반전', '상하 반전했어요') });
    App.commands.register({ id: 'viewer.resetSelected', title: '선택한 파일 회전·반전 되돌리기', group: '보기', icon: 'vw-reset-orient', when: () => hasMediaSelection() && selectedMedia().some((p) => !isIdentity(orientationOf(p))), run: () => orientSelected(() => ({ rot: 0 }), '회전·반전 되돌리기', '원래 방향으로 되돌렸어요') });

    // ---------- Init ----------
    const reloadSoon = App.util.debounce(() => viewer.reload(), 60);

    App.register('viewer', {
        init() {
            root = document.getElementById('viewer');
            root.tabIndex = -1;
            root.setAttribute('role', 'dialog');
            root.setAttribute('aria-label', '보기');

            titleEl = h('div', { class: 'vw-title truncate' });
            subEl = h('div', { class: 'vw-sub truncate' });
            counterEl = h('div', { class: 'vw-counter' });
            toolsEl = h('div', { class: 'vw-tools' });
            actionsEl = h('div', { class: 'vw-actions' });
            topEl = h('div', { class: 'vw-top' },
                h('div', { class: 'vw-top-left' },
                    h('div', { class: 'vw-titles' }, titleEl, h('div', { class: 'vw-subline' }, counterEl, h('span', { class: 'vw-dot' }), subEl))),
                // closing the viewer sits at the far top-right, like a window (owner: the old top-left X was confused with the panel's)
                h('div', { class: 'vw-top-right' }, toolsEl, actionsEl, h('span', { class: 'vw-sep' }),
                    btn('x', '보기 화면 닫기', 'Escape', () => App.commands.run('viewer.close'), { class: 'vw-close' })));

            stage = h('div', { class: 'vw-stage' });
            overlays = h('div', { class: 'vw-overlays' });
            osdEl = h('div', { class: 'vw-osd', role: 'status', 'aria-live': 'polite' });
            navPrev = h('button', { class: 'vw-nav prev', 'aria-label': '이전 파일', 'data-tip': '이전 파일', 'data-tip-keys': 'PageUp', html: ui.icon('chevron-left', { size: 26 }), onmousedown: (e) => e.preventDefault(), onclick: () => viewer.step(-1) });
            navNext = h('button', { class: 'vw-nav next', 'aria-label': '다음 파일', 'data-tip': '다음 파일', 'data-tip-keys': 'PageDown', html: ui.icon('chevron-right', { size: 26 }), onmousedown: (e) => e.preventDefault(), onclick: () => viewer.step(1) });
            stageWrap = h('div', { class: 'vw-stage-wrap' }, stage, navPrev, navNext, overlays, osdEl);

            dockTitle = h('div', { class: 'vw-dock-title' });
            dockBody = h('div', { class: 'vw-dock-body' });
            dock = h('aside', { class: 'vw-dock', hidden: true },
                h('div', { class: 'vw-dock-head' }, dockTitle, h('div', { class: 'grow' }),
                    // not an X: that one closes the viewer (top-right corner)
                    btn('panel-right', '패널 닫기', null, () => closePanel(), { class: 'sm' })),
                dockBody);
            mainEl = h('div', { class: 'vw-main' }, stageWrap, dock);

            hintsEl = h('div', { class: 'vw-hints', 'aria-hidden': 'true' });
            bottomEl = h('div', { class: 'vw-bottom' }, h('div', { class: 'vw-strip-host' }), hintsEl);
            root.append(topEl, mainEl, bottomEl);

            // Right-click menu on the media area
            stageWrap.addEventListener('contextmenu', (e) => {
                if (e.target.closest('.vw-ctl, .vw-info, input, textarea')) return;
                e.preventDefault();
                const items = buildMenuItems();
                if (items.length) ui.menu(items, { x: e.clientX, y: e.clientY });
            });

            // Mouse "back" button closes the viewer
            root.addEventListener('mouseup', (e) => {
                if (e.button === 3) {
                    e.preventDefault();
                    viewer.close();
                } else if (e.button === 4) {
                    e.preventDefault();
                }
            });

            root.addEventListener('mousemove', poke, { passive: true });
            root.addEventListener('pointerdown', poke, { passive: true });
            new ResizeObserver(() => {
                visible?.inst?.resize?.();
                pending?.inst?.resize?.();
            }).observe(stage);

            document.addEventListener('fullscreenchange', () => {
                if (!document.fullscreenElement) {
                    lastFsExit = Date.now();
                    enteredFullscreen = false;
                }
                root.classList.toggle('vw-fs', !!document.fullscreenElement);
                refreshChrome();
                poke();
            });

            App.bus.on('item:open', ({ path, time, play }) => viewer.open(path, { time, play }));
            App.bus.on('workspace:closed', () => viewer.close());
            App.bus.on('settings:changed', ({ key }) => {
                if (!viewer.isOpen) return;
                if (key === 'viewer.filmstrip' || key === 'viewer.hints' || key === 'viewer.bg') {
                    applyChromePrefs();
                    refreshChrome();
                    resizeAll();
                }
            });

            // Paths change under us (rename/move/trash/delete done anywhere): keep the list in step.
            App.bus.on('fs:changed', (c) => {
                if (!viewer.isOpen) return;
                const cur = files[index];
                if (c.type === 'trash' || c.type === 'delete') {
                    const gone = (p) => c.paths.some((x) => P.isInside(p, x));
                    const curGone = cur && gone(cur.path);
                    const before = files.length;
                    let at = index;
                    files = files.filter((f, i) => {
                        const keep = !gone(f.path);
                        if (!keep && i < index) at--;
                        return keep;
                    });
                    if (curGone) {
                        if (!files.length) {
                            viewer.close();
                            return;
                        }
                        index = clamp(at, 0, files.length - 1);
                        show();
                    } else if (cur) {
                        index = files.indexOf(cur);
                        if (files.length !== before) updateChrome(cur);
                    }
                    return;
                }
                if (c.from && c.to) {
                    files = files.map((f) => {
                        for (let i = 0; i < c.from.length; i++) {
                            const r = P.rebase(f.path, c.from[i], c.to[i]);
                            if (r != null && r !== f.path) return { ...f, path: r, name: P.base(r) };
                        }
                        return f;
                    });
                    if (files[index]) updateChrome(files[index]);
                    return;
                }
                if (c.type === 'modify' && cur && c.paths.includes(cur.path)) reloadSoon();
            });
            App.bus.on('view:changed', () => {
                if (!viewer.isOpen) return;
                const before = files[index]?.path;
                syncList();
                const cur = files[index];
                if (!cur) return viewer.close();
                if (cur.path !== before) show();
                else updateChrome(cur);
            });
            App.bus.on('catalog:changed', ({ paths }) => {
                if (!viewer.isOpen) return;
                const cur = viewer.current;
                if (!cur || !paths || !paths.includes(cur.path)) return;
                if (!visible?.inst?.frozen) visible?.inst?.onCatalog?.();
                refreshChrome();
            });

            // Rotated/flipped thumbnails in the gallery (CSS in viewer.css)
            if (App.gallery && Array.isArray(App.gallery.cardDecorators)) {
                App.gallery.cardDecorators.push((card, entry) => {
                    if (!entry || entry.kind !== 'file') return;
                    applyTransformVars(card, orientationOf(entry.path));
                });
            }
            if (App.gallery && Array.isArray(App.gallery.contextMenuItems)) {
                App.gallery.contextMenuItems.push((entries) => {
                    const media = entries.filter((e) => e.type === 'image' || e.type === 'video');
                    if (!media.length) return [];
                    return [
                        { label: '오른쪽으로 회전', icon: 'rotate-cw', command: 'viewer.rotateSelectedCW' },
                        { label: '왼쪽으로 회전', icon: 'rotate-ccw', command: 'viewer.rotateSelectedCCW' },
                        { label: '좌우 반전', icon: 'flip-h', command: 'viewer.flipSelected' },
                        { label: '상하 반전', icon: 'flip-v', command: 'viewer.flipSelectedV' },
                        ...(media.some((e) => !isIdentity(orientationOf(e.path))) ? [{ label: '회전·반전 되돌리기', icon: 'vw-reset-orient', command: 'viewer.resetSelected' }] : []),
                    ];
                });
            }
        },
    });

    App.viewer = viewer;
})();
