/*
 * Gallery — the main browsing surface (team: gallery).
 *
 * Grid or list (details) view of App.view.visible, fully virtualized: only rows near the viewport exist in the DOM,
 * and every hit-test (lasso, paging, anchoring) is computed from layout geometry instead of the DOM, so folders with
 * tens of thousands of files stay smooth.
 *
 * Interaction: click / Ctrl+click / Shift+click, lasso on empty space (Shift adds, Ctrl toggles, auto-scrolls near the
 * edges), arrow keys + PageUp/PageDown + type-ahead, double-click or Enter opens, Ctrl+wheel zooms, drag selection onto
 * folders to move (Ctrl = copy), drop files from Explorer to import, hover a video card to scrub through it.
 *
 * Extension points:
 *   App.gallery.cardDecorators.push((card, entry) => {...})   grid cards, after they render
 *   App.gallery.contextMenuItems.push((entries) => items[])    extra context-menu items
 *   App.gallery.refresh() / invalidate(paths) / scrollTo(path, {center}) / cardFor(path) / columns / zoom / setZoom(px)
 *   App.gallery.mode / setMode('grid'|'list')        view mode (setting 'gallery.mode', event 'gallery:mode')
 *   App.gallery.fit / setFit('cover'|'contain')      thumbnail fit in the grid (setting 'gallery.fit', event 'gallery:fit')
 *   App.gallery.folderInfo(dir)  -> { images, videos, dirs, samples: Entry[] } | null   (recursive counts, needs App.index)
 *   App.gallery.transfer(paths, destDir, 'move'|'copy') -> results   move/copy with toast + undo (drop, paste)
 *   App.gallery.moveFocus(delta, {shiftKey, ctrlKey}) / itemRect(i) / forEachRendered(fn) / setBottomInset(px)
 * Drag data type for internal drags: 'application/x-fi-paths' (JSON array of paths).
 */
(() => {
    'use strict';
    const { h, path: P, formatBytes, formatDuration, formatDate, formatCount, clamp, compareNames, escapeHtml } = App.util;
    const ui = App.ui;
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

    // Icons this module needs that the shared set doesn't have yet (g- prefix avoids clashes; see integration notes)
    const LOCAL_ICONS = {
        'g-paste': '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 10v7M9 14l3 3 3-3"/>',
        // 꽉 채우기: the picture runs to every edge of the frame
        'g-fit-cover': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m3 16 5-5 4.5 4.5 2.5-2.5 6 6"/><circle cx="15.5" cy="8.5" r="1.5"/>',
        // 원본 비율: a portrait picture sits uncropped inside the frame
        'g-fit-contain': '<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="8.5" y="6" width="7" height="12" rx="1"/>',
        'g-scrub': '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 15h20M9 15v4"/>',
    };
    if (ui.ICONS) for (const [k, v] of Object.entries(LOCAL_ICONS)) if (!ui.ICONS[k]) ui.ICONS[k] = v;

    // ---------- Geometry ----------
    const PAD = 18; // canvas padding (grid)
    const GAP = 12; // gap between cards
    const CARD_PAD = 6; // card padding around its media (top/sides)
    const META_H = 46; // name + sub line under the media
    const MEDIA_RATIO = 0.76; // media height / media width
    const BUFFER_ROWS = 3;
    const LIST_HEAD_H = 34; // sticky header in list mode
    const LIST_PAD = 6;
    const LIST_X = 8; // rows are inset so hover/selection backgrounds get rounded corners
    const LIST_BUFFER = 12;
    const LABEL_NAMES = { red: '빨강', orange: '주황', yellow: '노랑', green: '초록', blue: '파랑', purple: '보라' };
    const ASC_FIRST = new Set(['name', 'type']); // other columns sort biggest/newest first on the first click

    let mode = App.settings.get('gallery.mode', 'grid') === 'list' ? 'list' : 'grid';
    let fit = App.settings.get('gallery.fit', 'cover') === 'contain' ? 'contain' : 'cover';

    let scroller;
    let canvas;
    let content;
    let emptyEl;
    let headEl;
    let loadingEl;
    let typePillEl;
    const rendered = new Map(); // path -> element (card or row)
    const L = { cols: 1, cardW: 180, mediaH: 136, rowH: 188, rowStep: 200, colStep: 192, listRowH: 40, width: 0, inset: 0, version: 0 };
    let rafPending = false;
    let lastPrioritized = '';
    let suppressClick = false;
    let anchor = { i: 0, offset: 0 }; // first visible item, kept for resize anchoring
    const itemHooks = []; // internal decorators applied to grid cards AND list rows

    // ---------- Korean particles ----------
    function finalConsonant(word) {
        const s = String(word || '').replace(/[\s)\]}'"’”.,!?~_-]+$/, '');
        if (!s) return null;
        const ch = s[s.length - 1];
        const code = ch.charCodeAt(0);
        if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28; // 0 = none, 8 = ㄹ
        // Sino-Korean digit readings: 영 일 이 삼 사 오 육 칠 팔 구
        if (/[0-9]/.test(ch)) return [21, 8, 0, 16, 0, 0, 1, 8, 8, 0][Number(ch)];
        return null;
    }
    /** '로' after a vowel or ㄹ, '으로' after other final consonants, '(으)로' when unknown (latin names...) */
    function particleRo(word) {
        const f = finalConsonant(word);
        if (f == null) return '(으)로';
        return f === 0 || f === 8 ? '로' : '으로';
    }

    // ---------- Toast with several actions ----------
    function toastActions(message, actions = [], opts = {}) {
        const [first, ...rest] = actions;
        const t = ui.toast(message, { ...opts, action: first });
        if (rest.length && t && t.el) {
            const closeBtn = t.el.querySelector('.toast-close');
            for (const a of rest) {
                const b = h('button', {
                    class: 'toast-action',
                    text: a.label,
                    onclick: () => {
                        t.close();
                        a.run();
                    },
                });
                if (closeBtn) t.el.insertBefore(b, closeBtn);
                else t.el.append(b);
            }
        }
        return t;
    }

    // ---------- Folder stats (recursive counts + mosaic samples), one pass over App.index ----------
    const folderStats = { map: null, sig: new Map(), dirty: true };

    function offerSample(arr, e, rank) {
        const later = (o) => rank > o.rank || (rank === o.rank && compareNames(e.name, o.e.name) >= 0);
        if (arr.length >= 4) {
            if (later(arr[3])) return;
            arr.pop();
        }
        let i = arr.length;
        while (i > 0 && !later(arr[i - 1])) i--;
        arr.splice(i, 0, { e, rank });
    }

    function computeFolderStats() {
        folderStats.dirty = false;
        if (!App.fs.ready || !App.index || !App.index.ready) {
            folderStats.map = null;
            folderStats.sig = new Map();
            return;
        }
        const map = new Map();
        const get = (d) => {
            let s = map.get(d);
            if (!s) {
                s = { images: 0, videos: 0, dirs: 0, samples: [] };
                map.set(d, s);
            }
            return s;
        };
        for (const f of App.index.folders) {
            get(f);
            if (f !== '') get(P.parent(f)).dirs++;
        }
        for (const e of App.index.items) {
            const isImage = e.type === 'image';
            if (!isImage && e.type !== 'video') continue;
            const thumbable = App.thumbs?.canThumb?.(e);
            let d = P.parent(e.path);
            let depth = 0;
            for (;;) {
                const s = get(d);
                if (isImage) s.images++;
                else s.videos++;
                // Prefer direct children, then shallower descendants; photos before videos (cheaper thumbnails)
                if (thumbable) offerSample(s.samples, e, depth * 2 + (isImage ? 0 : 1));
                if (d === '') break;
                d = P.parent(d);
                depth++;
            }
        }
        const sig = new Map();
        for (const [d, s] of map) sig.set(d, `${s.images}|${s.videos}|${s.dirs}|${s.samples.map((x) => `${x.e.path}:${x.e.mtime || 0}`).join(',')}`);
        folderStats.map = map;
        folderStats.sig = sig;
    }

    function folderInfo(dir) {
        if (folderStats.dirty) computeFolderStats();
        const s = folderStats.map?.get(dir);
        return s ? { images: s.images, videos: s.videos, dirs: s.dirs, samples: s.samples.map((x) => x.e) } : null;
    }

    const refreshFolderStats = App.util.debounce(() => {
        const old = folderStats.sig;
        computeFolderStats();
        const changed = [];
        for (const [p, el] of rendered) if (el.classList.contains('is-dir') && old.get(p) !== folderStats.sig.get(p)) changed.push(p);
        if (changed.length) gallery.invalidate(changed);
        App.bus.emit('gallery:folders');
    }, 250);

    function folderCountText(dir) {
        const s = folderInfo(dir);
        if (!s) return '폴더';
        const parts = [];
        if (s.images) parts.push(`사진 ${formatCount(s.images)}`);
        if (s.videos) parts.push(`영상 ${formatCount(s.videos)}`);
        if (parts.length) return parts.join(' · ');
        return s.dirs ? `폴더 ${formatCount(s.dirs)}개` : '비어 있어요';
    }

    function folderTip(dir) {
        const s = folderInfo(dir);
        if (!s) return null;
        const parts = [`사진 ${formatCount(s.images)}장`, `영상 ${formatCount(s.videos)}개`];
        if (s.dirs) parts.push(`폴더 ${formatCount(s.dirs)}개`);
        return `하위 폴더까지 ${parts.join(' · ')}`;
    }

    // ---------- Layout ----------
    function listRowHeight() {
        return clamp(Math.round(30 + gallery.zoom / 18), 32, 60);
    }

    function canvasHeight() {
        const n = App.view.visible.length;
        if (!n) return 0;
        if (mode === 'list') return LIST_PAD * 2 + n * L.listRowH + L.inset;
        const rows = Math.ceil(n / L.cols);
        return PAD * 2 + rows * L.rowH + (rows - 1) * GAP + L.inset;
    }

    // Viewport metrics are cached (ResizeObserver + scroll events) and scroll writes are applied in the next render
    // frame, so view changes never force a synchronous layout on the navigation path.
    let viewH = 0;
    let scrollTopCache = 0;
    let pendingScroll = null;

    function getScrollTop() {
        return pendingScroll != null ? pendingScroll : scrollTopCache;
    }

    /** For user-initiated APIs (zoom, mode, scrollTo): pick up scroll writes made by others in the same task */
    function syncScroll() {
        if (pendingScroll == null && scroller) scrollTopCache = scroller.scrollTop;
    }

    function setScrollTop(v) {
        pendingScroll = Math.max(0, Math.round(v));
        schedule();
    }

    function layout() {
        if (!scroller) return;
        if (mode === 'list') {
            L.cols = 1;
            L.listRowH = listRowHeight();
            L.rowStep = L.listRowH;
            scroller.style.setProperty('--lrow-h', L.listRowH + 'px'); // header + rows share it
        } else {
            const size = gallery.zoom;
            const inner = Math.max(1, L.width - PAD * 2);
            L.cols = Math.max(1, Math.floor((inner + GAP) / (size + GAP)));
            L.cardW = Math.floor((inner - GAP * (L.cols - 1)) / L.cols);
            L.mediaH = Math.round((L.cardW - CARD_PAD * 2) * MEDIA_RATIO);
            L.rowH = CARD_PAD + L.mediaH + META_H;
            L.rowStep = L.rowH + GAP;
            L.colStep = L.cardW + GAP;
        }
        canvas.style.height = canvasHeight() + 'px';
        L.version++;
        lastPrioritized = '';
    }

    /** Item rectangle in canvas coordinates */
    function itemRect(i) {
        if (mode === 'list') return { x: LIST_X, y: LIST_PAD + i * L.listRowH, w: Math.max(0, L.width - LIST_X * 2), h: L.listRowH };
        const row = Math.floor(i / L.cols);
        const col = i % L.cols;
        return { x: PAD + col * L.colStep, y: PAD + row * L.rowStep, w: L.cardW, h: L.rowH };
    }

    /** Visible part of the canvas (canvas coordinates). The sticky list header covers the top of the viewport. */
    function viewRange() {
        const st = getScrollTop();
        return { top: st, bottom: st + viewH - (mode === 'list' ? LIST_HEAD_H : 0) };
    }

    function indexAtY(y) {
        const n = App.view.visible.length;
        if (!n) return -1;
        if (mode === 'list') return clamp(Math.floor((y - LIST_PAD) / L.listRowH), 0, n - 1);
        return clamp(Math.floor((y - PAD) / L.rowStep) * L.cols, 0, n - 1);
    }

    function captureAnchor(clientY) {
        const n = App.view.visible.length;
        if (!n || !scroller) return null;
        syncScroll();
        const { top, bottom } = viewRange();
        let i = -1;
        if (clientY != null) i = indexAtY(clientY - canvas.getBoundingClientRect().top);
        if (i < 0) {
            const f = App.view.indexOf(App.select.focus);
            if (f >= 0) {
                const r = itemRect(f);
                if (r.y + r.h > top && r.y < bottom) i = f;
            }
        }
        if (i < 0) i = indexAtY(top);
        i = clamp(i, 0, n - 1);
        return { i, offset: itemRect(i).y - top };
    }

    function restoreAnchor(a) {
        if (!a || a.i >= App.view.visible.length) return;
        setScrollTop(itemRect(a.i).y - a.offset);
    }

    function schedule() {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
            rafPending = false;
            renderWindow();
        });
    }

    function windowRange() {
        const n = App.view.visible.length;
        const { top, bottom } = viewRange();
        if (mode === 'list') {
            const step = L.listRowH;
            const first = Math.max(0, Math.floor((top - LIST_PAD) / step));
            const last = Math.min(n - 1, Math.floor((bottom - LIST_PAD) / step));
            return { start: Math.max(0, first - LIST_BUFFER), end: Math.min(n, last + 1 + LIST_BUFFER), visStart: Math.min(n, first), visEnd: Math.min(n, last + 1) };
        }
        const firstRow = Math.max(0, Math.floor((top - PAD) / L.rowStep));
        const lastRow = Math.max(0, Math.floor((bottom - PAD) / L.rowStep));
        return {
            start: Math.min(n, Math.max(0, firstRow - BUFFER_ROWS) * L.cols),
            end: Math.min(n, (lastRow + 1 + BUFFER_ROWS) * L.cols),
            visStart: Math.min(n, firstRow * L.cols),
            visEnd: Math.min(n, (lastRow + 1) * L.cols),
        };
    }

    function place(el, i) {
        const r = itemRect(i);
        el.style.transform = `translate(${r.x}px, ${r.y}px)`;
        el.style.width = r.w + 'px';
        el.style.height = r.h + 'px';
        el._lv = L.version;
        el._i = i;
    }

    function renderWindow() {
        if (!scroller || !App.fs.ready) return;
        if (pendingScroll != null) {
            scroller.scrollTop = pendingScroll;
            pendingScroll = null;
            scrollTopCache = scroller.scrollTop; // clamped by the browser
        }
        const list = App.view.visible;
        const { start, end, visStart, visEnd } = windowRange();
        for (const [p, el] of rendered) {
            const i = App.view.indexOf(p);
            if (i < start || i >= end) {
                el.remove();
                rendered.delete(p);
            }
        }
        let frag = null;
        for (let i = start; i < end; i++) {
            const entry = list[i];
            let el = rendered.get(entry.path);
            if (!el) {
                el = mode === 'list' ? buildRow(entry) : buildCard(entry);
                rendered.set(entry.path, el);
                (frag || (frag = document.createDocumentFragment())).append(el);
                if (dropState.path === entry.path || spring.dir === entry.path) reattachDragState(el, entry.path);
                if (scrub.path === entry.path && mode === 'grid') reattachScrub(el);
            }
            if (el._lv !== L.version || el._i !== i) place(el, i);
        }
        if (frag) canvas.append(frag);
        if (list.length) {
            const top = viewRange().top;
            const i = indexAtY(top);
            anchor = { i, offset: itemRect(i).y - top };
        }
        const key = `${visStart}:${visEnd}:${L.version}`;
        if (key !== lastPrioritized) {
            lastPrioritized = key;
            const onScreen = [];
            for (let i = visStart; i < visEnd; i++) onScreen.push(list[i].path);
            App.thumbs?.prioritize?.(onScreen);
        }
    }

    // ---------- Shared bits for cards and rows ----------
    function syncSelected(el, p) {
        const sel = App.select.has(p);
        el.classList.toggle('selected', sel);
        el.classList.toggle('focused', App.select.focus === p);
        el.setAttribute('aria-selected', sel ? 'true' : 'false');
    }

    function runItemHooks(el, entry) {
        for (const fn of itemHooks) {
            try {
                fn(el, entry);
            } catch (e) {
                console.error('[gallery] item hook failed', e);
            }
        }
    }

    function chipNames(ids) {
        const cs = App.chipset;
        if (!cs || typeof cs.nameOf !== 'function') return [];
        const out = [];
        for (const id of ids) {
            try {
                const n = cs.nameOf(id);
                if (n) out.push(n);
            } catch (e) {
                /* unknown chip */
            }
        }
        return out;
    }

    function chipTip(ids) {
        const names = chipNames(ids);
        if (!names.length) return `칩 ${ids.length}개`;
        const shown = names.slice(0, 8).join(', ');
        return names.length > 8 ? `${shown} 외 ${names.length - 8}개` : shown;
    }

    function memoTip(memo) {
        const one = memo.replace(/\s+/g, ' ').trim();
        return one.length > 120 ? one.slice(0, 120) + '…' : one;
    }

    function typeLabel(entry) {
        if (entry.kind === 'dir') return '폴더';
        const kind = entry.type === 'video' ? '영상' : entry.type === 'image' ? '사진' : '파일';
        return entry.ext ? `${kind} · ${entry.ext.toUpperCase()}` : kind;
    }

    function setThumb(holder, img, entry, onReady) {
        const cached = App.thumbs.peek(entry);
        if (cached) {
            img.src = cached;
            holder.classList.add('has-thumb');
            return;
        }
        if (!App.thumbs.canThumb(entry)) {
            holder.classList.add('no-thumb');
            return;
        }
        App.thumbs.get(entry).then((url) => {
            if (!url) {
                holder.classList.add('no-thumb');
                onReady?.(false);
                return;
            }
            img.src = url;
            const show = () => {
                holder.classList.add('has-thumb');
                onReady?.(true);
            };
            if (img.decode) img.decode().then(show, show);
            else show();
        });
    }

    // ---------- Grid card ----------
    function buildCard(entry) {
        const isDir = entry.kind === 'dir';
        const cat = App.catalog.peek(entry.path);
        const card = h('div', {
            class: `card${isDir ? ' is-dir' : ''}${entry.type === 'video' ? ' is-video' : ''}`,
            dataset: { path: entry.path },
            draggable: 'true',
            role: 'gridcell',
            'aria-label': entry.name,
        });
        syncSelected(card, entry.path);
        const media = h('div', { class: 'card-media' });
        if (isDir) fillFolderMedia(media, entry);
        else fillFileMedia(card, media, entry);
        media.append(h('span', { class: 'card-check', html: ui.icon('check', { size: 12 }) }));
        if (!isDir) addBadges(media, entry, cat);
        card.append(media, cardMeta(entry, cat));
        if (isDir) {
            const tip = folderTip(entry.path);
            if (tip) card.querySelector('.card-sub').dataset.tip = tip;
        }
        runItemHooks(card, entry);
        for (const deco of gallery.cardDecorators) {
            try {
                deco(card, entry);
            } catch (e) {
                console.error('[gallery] decorator failed', e);
            }
        }
        return card;
    }

    function fillFileMedia(card, media, entry) {
        const img = h('img', { class: 'card-img', alt: '', draggable: 'false', decoding: 'async' });
        const ph = h('div', { class: 'card-ph', html: ui.icon(entry.type === 'video' ? 'film' : 'image', { size: 26 }) });
        media.append(ph, img);
        const ext = () => {
            if (!ph.querySelector('.card-ext')) ph.append(h('span', { class: 'card-ext', text: (entry.ext || '?').toUpperCase() }));
        };
        if (!App.thumbs.canThumb(entry)) ext();
        setThumb(card, img, entry, (ok) => {
            if (!ok) ext();
        });
    }

    function fillFolderMedia(media, entry) {
        const info = folderInfo(entry.path);
        const samples = info ? info.samples : [];
        if (!samples.length) {
            const empty = info && !info.images && !info.videos && !info.dirs;
            media.append(h('div', { class: `card-folder${empty ? ' is-empty' : ''}`, html: ui.icon('folder', { size: 40 }) }));
            return;
        }
        const n = Math.min(4, samples.length);
        const grid = h('div', { class: `card-mosaic n${n}` });
        for (const s of samples.slice(0, 4)) grid.append(mosaicCell(s));
        media.append(grid);
    }

    function mosaicCell(e) {
        const cell = h('div', { class: 'mosaic-cell' });
        const img = h('img', { alt: '', draggable: 'false', decoding: 'async' });
        cell.append(img);
        setThumb(cell, img, e);
        return cell;
    }

    function pill(iconName, text, tip, extraClass = '') {
        return h('span', {
            class: `card-pill ${extraClass}`.trim(),
            'data-tip': tip || null,
            html: `${ui.icon(iconName, { size: 11 })}${text != null && text !== '' ? `<span>${escapeHtml(text)}</span>` : ''}`,
        });
    }

    function addBadges(media, entry, cat) {
        const chips = cat?.chips || [];
        const memo = (cat?.memo || '').trim();
        const top = [];
        if (chips.length) top.push(pill('tag', String(chips.length), chipTip(chips), 'is-chips'));
        if (memo) top.push(pill('note', '', memoTip(memo), 'is-memo icon-only'));
        if (top.length) media.append(h('div', { class: 'card-badges' }, ...top));
        if (entry.type === 'video') {
            const dur = cat?.meta?.duration;
            const markers = cat?.markers?.length || 0;
            const box = h('div', { class: 'card-vinfo' });
            if (markers) box.append(pill('flag', String(markers), `마커 ${markers}개`, 'is-markers'));
            box.append(h('span', { class: 'card-pill card-dur', html: `${ui.icon('play', { size: 9 })}<span class="card-time">${dur ? formatDuration(dur) : ''}</span>` }));
            media.append(box);
        }
    }

    function starsEl(rating) {
        return h('span', { class: 'card-stars', 'data-tip': `별점 ${rating}점`, 'aria-label': `별점 ${rating}점`, html: ui.icon('star', { size: 10 }).repeat(rating) });
    }

    function cardSub(entry, cat) {
        if (entry.kind === 'dir') return folderCountText(entry.path);
        const m = cat?.meta;
        const parts = [];
        if (m?.w && m?.h) parts.push(`${m.w}×${m.h}`);
        parts.push(formatBytes(entry.size));
        return parts.join(' · ');
    }

    function cardMeta(entry, cat) {
        const line = h('div', { class: 'card-line' });
        if (entry.kind === 'dir') line.append(h('span', { class: 'card-dir-ico', html: ui.icon('folder', { size: 13 }) }));
        if (cat?.label && LABEL_NAMES[cat.label]) line.append(h('span', { class: `card-label lbl-${cat.label}`, 'data-tip': `${LABEL_NAMES[cat.label]} 라벨` }));
        line.append(h('span', { class: 'card-name', text: entry.name, title: entry.name }));
        const sub = h('div', { class: 'card-line card-subline' }, h('span', { class: 'card-sub', text: cardSub(entry, cat) }));
        if (cat?.rating > 0) sub.append(starsEl(Math.min(5, cat.rating)));
        return h('div', { class: 'card-meta' }, line, sub);
    }

    // ---------- List (details) row ----------
    const COLUMNS = [
        { id: 'thumb', cls: 'lc-thumb', label: '' },
        { id: 'name', cls: 'lc-name', label: '이름', sort: 'name' },
        { id: 'type', cls: 'lc-type', label: '종류', sort: 'type' },
        { id: 'size', cls: 'lc-size', label: '크기', sort: 'size' },
        { id: 'mtime', cls: 'lc-mtime', label: '수정한 날짜', sort: 'mtime' },
        { id: 'res', cls: 'lc-res', label: '해상도', sort: 'resolution' },
        { id: 'dur', cls: 'lc-dur', label: '길이', sort: 'duration' },
        { id: 'rating', cls: 'lc-rating', label: '별점', sort: 'rating' },
    ];

    function renderHead() {
        if (!headEl) return;
        headEl.innerHTML = '';
        const s = App.view.sort;
        for (const c of COLUMNS) {
            const active = !!c.sort && s.key === c.sort;
            const cell = h(c.sort ? 'button' : 'div', {
                class: `lc ${c.cls}${active ? ' sorted' : ''}`,
                type: c.sort ? 'button' : null,
                dataset: c.sort ? { sort: c.sort } : null,
                'aria-sort': active ? (s.dir === 'desc' ? 'descending' : 'ascending') : null,
            });
            if (c.label) cell.append(h('span', { class: 'lh-label', text: c.label }));
            if (active) cell.append(h('span', { class: `lh-arrow${s.dir === 'desc' ? ' desc' : ''}`, html: ui.icon('arrow-up', { size: 11 }) }));
            headEl.append(cell);
        }
    }

    function buildRow(entry) {
        const isDir = entry.kind === 'dir';
        const cat = App.catalog.peek(entry.path);
        const m = cat?.meta || {};
        const row = h('div', {
            class: `lrow${isDir ? ' is-dir' : ''}${entry.type === 'video' ? ' is-video' : ''}`,
            dataset: { path: entry.path },
            draggable: 'true',
            role: 'row',
            'aria-label': entry.name,
        });
        syncSelected(row, entry.path);

        const thumb = h('div', { class: 'lc lc-thumb' });
        if (isDir) {
            thumb.classList.add('is-folder');
            thumb.innerHTML = ui.icon('folder', { size: 16 });
        } else {
            const img = h('img', { alt: '', draggable: 'false', decoding: 'async' });
            thumb.append(h('span', { class: 'lt-ph', html: ui.icon(entry.type === 'video' ? 'film' : 'image', { size: 13 }) }), img);
            setThumb(thumb, img, entry, (ok) => {
                if (!ok) return;
                // Images learn their resolution while the thumbnail is made: fill the cell in place
                const mm = App.catalog.peek(entry.path)?.meta;
                const res = row.querySelector('.lc-res');
                if (res && mm?.w && mm?.h) res.textContent = `${mm.w}×${mm.h}`;
            });
        }

        const name = h('div', { class: 'lc lc-name' });
        if (cat?.label && LABEL_NAMES[cat.label]) name.append(h('span', { class: `card-label lbl-${cat.label}`, 'data-tip': `${LABEL_NAMES[cat.label]} 라벨` }));
        name.append(h('span', { class: 'lr-name', text: entry.name, title: entry.name }));
        const chips = cat?.chips || [];
        const memo = (cat?.memo || '').trim();
        const markers = cat?.markers?.length || 0;
        if (chips.length || memo || markers) {
            const ind = h('span', { class: 'lr-ind' });
            if (chips.length) ind.append(h('span', { class: 'lr-tag', 'data-tip': chipTip(chips), html: `${ui.icon('tag', { size: 11 })}<span>${chips.length}</span>` }));
            if (memo) ind.append(h('span', { class: 'lr-tag', 'data-tip': memoTip(memo), html: ui.icon('note', { size: 11 }) }));
            if (markers) ind.append(h('span', { class: 'lr-tag', 'data-tip': `마커 ${markers}개`, html: `${ui.icon('flag', { size: 11 })}<span>${markers}</span>` }));
            name.append(ind);
        }

        let sizeText;
        if (isDir) {
            const s = folderInfo(entry.path);
            sizeText = s && s.images + s.videos ? `${formatCount(s.images + s.videos)}개` : '—';
        } else sizeText = formatBytes(entry.size);

        const rating = h('div', { class: 'lc lc-rating' });
        if (!isDir) {
            const r = Math.min(5, cat?.rating || 0);
            rating.dataset.rating = String(r);
            // row-reverse so ":hover ~" fills the stars to the left of the pointer
            for (let n = 5; n >= 1; n--) {
                rating.append(h('button', { class: `lstar${n <= r ? ' on' : ''}`, type: 'button', tabindex: '-1', dataset: { n: String(n) }, 'aria-label': `별점 ${n}점`, html: ui.icon('star', { size: 12 }) }));
            }
        }

        row.append(
            thumb,
            name,
            h('div', { class: 'lc lc-type', text: typeLabel(entry) }),
            h('div', { class: 'lc lc-size', text: sizeText, 'data-tip': isDir ? folderTip(entry.path) : null }),
            h('div', { class: 'lc lc-mtime', text: entry.mtime ? formatDate(entry.mtime, true) : '—' }),
            h('div', { class: 'lc lc-res', text: m.w && m.h ? `${m.w}×${m.h}` : '—' }),
            h('div', { class: 'lc lc-dur', text: entry.type === 'video' && m.duration ? formatDuration(m.duration) : '—' }),
            rating,
        );
        runItemHooks(row, entry);
        return row;
    }

    function setRating(paths, n) {
        const before = new Map(paths.map((p) => [p, App.catalog.get(p).rating || 0]));
        const apply = (valueFor) => App.catalog.updateMany(paths, (e, p) => {
            e.rating = valueFor(p);
        });
        apply(() => n);
        App.undo.push({
            label: n ? `별점 ${n}점` : '별점 지우기',
            undo: async () => apply((p) => before.get(p)),
            redo: async () => apply(() => n),
        });
    }

    // ---------- Gallery API ----------
    const gallery = {
        cardDecorators: [],
        contextMenuItems: [],

        get columns() {
            return L.cols;
        },
        get mode() {
            return mode;
        },
        get fit() {
            return fit;
        },
        get zoom() {
            return App.settings.get('gallery.size', 180);
        },

        refresh() {
            for (const el of rendered.values()) el.remove();
            rendered.clear();
            lastPrioritized = '';
            schedule();
        },

        /** Re-render only these items (after their metadata changed) */
        invalidate(paths) {
            for (const p of paths || []) {
                const el = rendered.get(p);
                if (!el) continue;
                el.remove();
                rendered.delete(p);
            }
            schedule();
        },

        scrollTo(p, { center = false } = {}) {
            const i = App.view.indexOf(p);
            if (i < 0 || !scroller) return;
            syncScroll();
            const r = itemRect(i);
            const { top, bottom } = viewRange();
            const margin = mode === 'list' ? 4 : PAD;
            if (center) setScrollTop(r.y - (bottom - top) / 2 + r.h / 2);
            else if (r.y < top) setScrollTop(r.y - margin);
            else if (r.y + r.h > bottom) setScrollTop(r.y + r.h - (bottom - top) + margin);
        },

        cardFor(p) {
            return rendered.get(p) || null;
        },

        forEachRendered(fn) {
            for (const [p, el] of rendered) fn(el, p);
        },

        itemRect,

        setZoom(size, { anchorY = null } = {}) {
            const s = clamp(Math.round(size), 96, 480);
            if (s === gallery.zoom && scroller) return;
            const a = scroller ? captureAnchor(anchorY) : null;
            document.documentElement.style.setProperty('--thumb-size', s + 'px');
            App.settings.set('gallery.size', s);
            if (!scroller) return;
            layout();
            restoreAnchor(a);
            schedule();
            App.bus.emit('gallery:zoom', { size: s });
        },

        setMode(m) {
            m = m === 'list' ? 'list' : 'grid';
            if (m === mode) return;
            const a = scroller ? captureAnchor() : null;
            endScrub();
            mode = m;
            App.settings.set('gallery.mode', m);
            if (!scroller) return;
            applyModeClasses();
            layout();
            restoreAnchor(a);
            gallery.refresh();
            App.topbar?.renderViewbar?.();
            App.bus.emit('gallery:mode', { mode: m });
        },

        setFit(f) {
            f = f === 'contain' ? 'contain' : 'cover';
            if (f === fit) return;
            fit = f;
            App.settings.set('gallery.fit', f);
            if (!scroller) return;
            applyModeClasses();
            App.topbar?.renderViewbar?.();
            App.bus.emit('gallery:fit', { fit: f });
        },

        setBottomInset(px) {
            px = Math.max(0, Math.round(px || 0));
            if (px === L.inset) return;
            L.inset = px;
            if (canvas) canvas.style.height = canvasHeight() + 'px';
        },

        folderInfo,
        transfer,
        importFiles: (files, dir, opts) => importFiles(files, dir, opts),
        moveFocus,
        particleRo,
        toastActions,
        _itemHooks: itemHooks,
        _dragImage: (paths, primary) => makeDragImage(paths, primary || paths[0]),
    };

    function applyModeClasses() {
        canvas.classList.toggle('is-list', mode === 'list');
        canvas.classList.toggle('is-grid', mode === 'grid');
        canvas.classList.toggle('fit-contain', fit === 'contain');
        scroller.classList.toggle('mode-list', mode === 'list');
        headEl.hidden = mode !== 'list';
        if (mode === 'list') renderHead();
    }

    function updateSelectionClasses() {
        for (const [p, el] of rendered) syncSelected(el, p);
    }

    function itemElFrom(t) {
        return t && t.closest ? t.closest('.card[data-path], .lrow[data-path]') : null;
    }

    // ---------- Clicks ----------
    function onClick(e) {
        if (suppressClick) {
            suppressClick = false;
            return;
        }
        if (e.target.closest('.lhead')) return;
        const el = itemElFrom(e.target);
        if (!el || !canvas.contains(el)) {
            if (!e.ctrlKey && !e.shiftKey && !e.metaKey) App.select.clear();
            return;
        }
        const p = el.dataset.path;
        const star = e.target.closest('.lstar');
        if (star) {
            const n = Number(star.dataset.n);
            const cur = App.catalog.get(p).rating || 0;
            setRating([p], cur === n ? 0 : n);
            return;
        }
        if (e.target.closest('.card-check')) {
            App.select.toggle(p);
            return;
        }
        if (e.shiftKey) App.select.range(p, { additive: e.ctrlKey || e.metaKey });
        else if (e.ctrlKey || e.metaKey) App.select.toggle(p);
        else App.select.set([p]);
    }

    function onDblClick(e) {
        if (e.target.closest('.lstar, .lhead, .card-check')) return;
        const el = itemElFrom(e.target);
        if (!el) return;
        const entry = App.view.get(el.dataset.path);
        if (entry) App.nav.open(entry);
    }

    function onHeadClick(e) {
        const cell = e.target.closest('[data-sort]');
        if (!cell) return;
        const key = cell.dataset.sort;
        const cur = App.view.sort;
        const dir = cur.key === key ? (cur.dir === 'asc' ? 'desc' : 'asc') : ASC_FIRST.has(key) ? 'asc' : 'desc';
        App.view.setSort(key, dir);
    }

    // ---------- Lasso (rubber band) — hit-testing from layout geometry, not the DOM ----------
    let lasso = null;

    function lassoCandidate(e) {
        if (e.button !== 0 || !App.fs.ready || e.pointerType === 'touch') return false;
        if (e.target.closest('.lhead, .card-check, .lstar, button, input, a, .gab')) return false;
        const r = scroller.getBoundingClientRect();
        if (e.clientX >= r.left + scroller.clientLeft + scroller.clientWidth) return false; // vertical scrollbar
        if (e.clientY >= r.top + scroller.clientTop + scroller.clientHeight) return false;
        const item = itemElFrom(e.target);
        if (!item) return true;
        // List rows fill the whole width: the thumbnail and name are drag handles, the rest starts a lasso
        if (mode === 'list') return !e.target.closest('.lc-thumb, .lr-name, .card-label, .lr-ind');
        return false;
    }

    function onPointerDown(e) {
        endScrub();
        if (!lassoCandidate(e)) return;
        const cr = canvas.getBoundingClientRect();
        lasso = {
            id: e.pointerId,
            x0: e.clientX - cr.left,
            y0: e.clientY - cr.top,
            cx: e.clientX,
            cy: e.clientY,
            active: false,
            how: e.shiftKey ? 'add' : e.ctrlKey || e.metaKey ? 'toggle' : 'replace',
            base: new Set(App.select.paths),
            baseFocus: App.select.focus,
            baseAnchor: App.select.anchor,
            key: null,
            box: null,
            raf: 0,
        };
    }

    function startLasso() {
        lasso.active = true;
        try {
            scroller.setPointerCapture(lasso.id);
        } catch (err) {
            /* pointer already gone */
        }
        lasso.box = h('div', { class: 'lasso', 'aria-hidden': 'true' });
        canvas.append(lasso.box);
        scroller.classList.add('is-lassoing');
        ui.closeMenus?.();
        document.addEventListener('keydown', onLassoKey, true);
        lasso.raf = requestAnimationFrame(lassoTick);
    }

    function hitRange(x1, y1, x2, y2) {
        const n = App.view.visible.length;
        if (!n) return null;
        if (mode === 'list') {
            if (x2 < LIST_X || x1 > L.width - LIST_X) return null;
            const step = L.listRowH;
            const r1 = Math.max(0, Math.floor((y1 - LIST_PAD) / step));
            const r2 = Math.min(n - 1, Math.floor((y2 - LIST_PAD) / step));
            if (y2 < LIST_PAD || r2 < r1) return null;
            return [r1, r2, 0, 0];
        }
        const rows = Math.ceil(n / L.cols);
        const r1 = Math.max(0, Math.ceil((y1 - PAD - L.rowH) / L.rowStep));
        const r2 = Math.min(rows - 1, Math.floor((y2 - PAD) / L.rowStep));
        const c1 = Math.max(0, Math.ceil((x1 - PAD - L.cardW) / L.colStep));
        const c2 = Math.min(L.cols - 1, Math.floor((x2 - PAD) / L.colStep));
        if (r2 < r1 || c2 < c1) return null;
        return [r1, r2, c1, c2];
    }

    function applyLasso(hit) {
        const list = App.view.visible;
        const paths = [];
        if (hit) {
            const [r1, r2, c1, c2] = hit;
            if (mode === 'list') {
                for (let i = r1; i <= r2; i++) paths.push(list[i].path);
            } else {
                for (let r = r1; r <= r2; r++) {
                    for (let c = c1; c <= c2; c++) {
                        const i = r * L.cols + c;
                        if (i < list.length) paths.push(list[i].path);
                    }
                }
            }
        }
        let next = paths;
        if (lasso.how !== 'replace') {
            const s = new Set(lasso.base);
            for (const p of paths) {
                if (lasso.how === 'toggle' && lasso.base.has(p)) s.delete(p);
                else s.add(p);
            }
            next = [...s];
        }
        const first = paths.length ? paths[0] : lasso.baseAnchor;
        const last = paths.length ? paths[paths.length - 1] : lasso.how === 'replace' ? null : lasso.baseFocus;
        App.select.set(next, { focus: last ?? null, anchor: first ?? null });
    }

    function updateLasso() {
        if (!lasso || !lasso.active) return;
        const cr = canvas.getBoundingClientRect();
        const x = clamp(lasso.cx - cr.left, 0, L.width);
        const y = clamp(lasso.cy - cr.top, 0, Math.max(0, canvasHeight()));
        const x1 = Math.min(lasso.x0, x);
        const x2 = Math.max(lasso.x0, x);
        const y1 = Math.min(lasso.y0, y);
        const y2 = Math.max(lasso.y0, y);
        const b = lasso.box;
        b.style.transform = `translate(${x1}px, ${y1}px)`;
        b.style.width = x2 - x1 + 'px';
        b.style.height = y2 - y1 + 'px';
        const hit = hitRange(x1, y1, x2, y2);
        const key = hit ? hit.join(',') : '';
        if (key === lasso.key) return;
        lasso.key = key;
        applyLasso(hit);
    }

    // Auto-scroll while the pointer is near (or past) the top/bottom edge
    function lassoTick() {
        if (!lasso || !lasso.active) return;
        const r = scroller.getBoundingClientRect();
        const top = r.top + (mode === 'list' ? LIST_HEAD_H : 0);
        const EDGE = 48;
        const MAX = 26;
        let dy = 0;
        if (lasso.cy < top + EDGE) dy = -MAX * Math.min(2.5, (top + EDGE - lasso.cy) / EDGE);
        else if (lasso.cy > r.bottom - EDGE) dy = MAX * Math.min(2.5, (lasso.cy - (r.bottom - EDGE)) / EDGE);
        if (dy) {
            const before = scroller.scrollTop;
            scroller.scrollTop = before + Math.round(dy);
            if (scroller.scrollTop !== before) updateLasso();
        }
        lasso.raf = requestAnimationFrame(lassoTick);
    }

    function endLasso(cancel = false) {
        if (!lasso) return;
        const l = lasso;
        lasso = null;
        if (!l.active) return;
        cancelAnimationFrame(l.raf);
        l.box?.remove();
        scroller.classList.remove('is-lassoing');
        try {
            scroller.releasePointerCapture(l.id);
        } catch (err) {
            /* already released */
        }
        document.removeEventListener('keydown', onLassoKey, true);
        if (cancel) App.select.set([...l.base], { focus: l.baseFocus, anchor: l.baseAnchor });
        // The pointerup also produces a click on the common ancestor: don't let it clear the new selection
        suppressClick = true;
        setTimeout(() => (suppressClick = false), 0);
    }

    function onLassoKey(e) {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        endLasso(true);
    }

    function onPointerMove(e) {
        // Native drags swallow pointer events, so any pointermove means a drag is over (even if its source
        // card was detached by spring-loading and its dragend never reached us)
        if (dragActive && !e.buttons) endDrag();
        if (lasso && e.pointerId === lasso.id) {
            lasso.cx = e.clientX;
            lasso.cy = e.clientY;
            if (!lasso.active) {
                if (!(e.buttons & 1)) {
                    lasso = null;
                    return;
                }
                const cr = canvas.getBoundingClientRect();
                if (Math.hypot(e.clientX - cr.left - lasso.x0, e.clientY - cr.top - lasso.y0) < 5) return;
                startLasso();
            }
            updateLasso();
            return;
        }
        onHoverMove(e);
    }

    function onPointerUp(e) {
        if (lasso && e.pointerId === lasso.id) endLasso(false);
    }

    // ---------- Video hover scrub: only the hovered card gets a (shared) <video> ----------
    const scrub = { card: null, path: null, f: 0, timer: 0, token: 0, seeking: false, pending: null, duration: 0 };
    let scrubVideo = null;
    let scrubSrc = null; // { path, url, release } — kept for re-hovering the same clip
    let dragActive = false;

    function scrubEnabled() {
        return App.settings.get('gallery.scrub', true) !== false;
    }

    function onHoverMove(e) {
        if (mode !== 'grid' || e.buttons || lasso || dragActive || !scrubEnabled()) return;
        const media = e.target.closest ? e.target.closest('.card.is-video > .card-media') : null;
        if (!media) {
            if (scrub.card) endScrub();
            return;
        }
        const card = media.parentElement;
        if (scrub.card !== card) beginScrub(card);
        if (scrub.card !== card) return;
        const r = media.getBoundingClientRect();
        scrub.f = clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1);
        paintScrub();
        seekScrub();
    }

    function beginScrub(card) {
        endScrub();
        const entry = App.view.get(card.dataset.path);
        if (!entry || !App.util.browserCanDecode(entry.name)) return;
        scrub.card = card;
        scrub.path = entry.path;
        scrub.duration = App.catalog.peek(entry.path)?.meta?.duration || 0;
        scrub.seeking = false;
        scrub.pending = null;
        const token = ++scrub.token;
        card.querySelector('.card-media').append(h('div', { class: 'card-scrub', 'aria-hidden': 'true' }, h('i')));
        card.classList.add('scrubbing');
        // A short delay so sweeping the pointer across the grid doesn't open every clip
        scrub.timer = setTimeout(() => loadScrub(entry, token), 90);
    }

    async function loadScrub(entry, token) {
        if (scrub.token !== token) return;
        if (!scrubSrc || scrubSrc.path !== entry.path) {
            if (scrubSrc) scrubSrc.release();
            scrubSrc = null;
            try {
                const u = await App.fs.url(entry.path);
                scrubSrc = { path: entry.path, url: u.url, release: u.release };
            } catch (e) {
                return;
            }
            if (scrub.token !== token) return;
        }
        const v = ensureScrubVideo();
        if (v.dataset.path !== entry.path) {
            v.classList.remove('ready');
            v.dataset.path = entry.path;
            v.src = scrubSrc.url;
        }
        const media = scrub.card?.querySelector('.card-media');
        if (!media) return;
        media.insertBefore(v, media.querySelector('.card-check'));
        if (v.readyState >= 1) seekScrub(true);
    }

    function ensureScrubVideo() {
        if (scrubVideo) return scrubVideo;
        const v = document.createElement('video');
        v.className = 'card-scrub-video';
        v.muted = true;
        v.defaultMuted = true;
        v.playsInline = true;
        v.preload = 'auto';
        v.disablePictureInPicture = true;
        v.setAttribute('aria-hidden', 'true');
        v.addEventListener('loadedmetadata', () => {
            if (!isFinite(v.duration)) {
                // Files without a duration header (e.g. MediaRecorder webm) report Infinity: seeking far past the end
                // makes the browser scan the file and fire durationchange with the real length
                v.dataset.probing = '1';
                scrub.seeking = true;
                v.currentTime = 1e101;
                return;
            }
            if (v.dataset.path === scrub.path) seekScrub(true);
        });
        v.addEventListener('durationchange', () => {
            if (!isFinite(v.duration) || v.duration <= 0) return;
            const p = v.dataset.path;
            const known = App.catalog.peek(p)?.meta?.duration;
            if (p && !(known > 0 && isFinite(known))) {
                App.catalog.setMeta(p, { duration: v.duration });
                if (p === scrub.path) scrub.duration = v.duration;
            }
        });
        v.addEventListener('seeked', () => {
            scrub.seeking = false;
            if (v.dataset.probing) {
                delete v.dataset.probing;
                if (v.dataset.path === scrub.path) seekScrub(true);
                return;
            }
            if (v.dataset.path === scrub.path && scrub.card) v.classList.add('ready');
            if (scrub.pending != null) {
                const t = scrub.pending;
                scrub.pending = null;
                seekTo(t);
            }
        });
        v.addEventListener('error', () => v.classList.remove('ready'));
        scrubVideo = v;
        return v;
    }

    function scrubDuration() {
        const v = scrubVideo;
        const d = v && v.dataset.path === scrub.path && isFinite(v.duration) && v.duration > 0 ? v.duration : scrub.duration;
        return d && isFinite(d) ? d : 0;
    }

    function seekScrub(force = false) {
        const v = scrubVideo;
        if (!v || v.dataset.path !== scrub.path || v.readyState < 1) return;
        const d = scrubDuration();
        if (!d) return;
        seekTo(clamp(scrub.f * d, 0, Math.max(0, d - 0.04)), force);
    }

    function seekTo(t, force = false) {
        const v = scrubVideo;
        if (!v) return;
        if (scrub.seeking) {
            scrub.pending = t;
            return;
        }
        if (!force && Math.abs(v.currentTime - t) < 0.03) return;
        scrub.seeking = true;
        try {
            v.currentTime = t;
        } catch (e) {
            scrub.seeking = false;
        }
    }

    /** The hovered card was re-rendered (e.g. its duration just arrived): move the live preview into the new card */
    function reattachScrub(card) {
        const media = card.querySelector('.card-media');
        if (!media || !card.classList.contains('is-video')) return;
        scrub.card = card;
        card.classList.add('scrubbing');
        media.append(h('div', { class: 'card-scrub', 'aria-hidden': 'true' }, h('i')));
        if (scrubVideo && scrubVideo.dataset.path === scrub.path) media.insertBefore(scrubVideo, media.querySelector('.card-check'));
        paintScrub();
    }

    function paintScrub() {
        const card = scrub.card;
        if (!card) return;
        const bar = card.querySelector('.card-scrub > i');
        if (bar) bar.style.transform = `scaleX(${scrub.f})`;
        const d = scrubDuration();
        const time = card.querySelector('.card-time');
        if (time && d) time.textContent = formatDuration(scrub.f * d);
    }

    function endScrub() {
        clearTimeout(scrub.timer);
        scrub.token++;
        const card = scrub.card;
        if (card) {
            card.classList.remove('scrubbing');
            card.querySelector('.card-scrub')?.remove();
            const time = card.querySelector('.card-time');
            if (time) {
                const d = App.catalog.peek(scrub.path)?.meta?.duration;
                time.textContent = d ? formatDuration(d) : '';
            }
        }
        if (scrubVideo) {
            scrubVideo.pause();
            scrubVideo.classList.remove('ready');
            scrubVideo.remove();
        }
        scrub.card = null;
        scrub.path = null;
        scrub.seeking = false;
        scrub.pending = null;
    }

    function releaseScrubSource() {
        endScrub();
        if (scrubVideo) {
            scrubVideo.removeAttribute('src');
            delete scrubVideo.dataset.path;
            scrubVideo.load();
        }
        if (scrubSrc) scrubSrc.release();
        scrubSrc = null;
    }

    // ---------- Context menu ----------
    function cmdItem(id, label, extra = {}) {
        const cmd = App.commands.get(id);
        if (!cmd) return null;
        return { label: label || cmd.title, icon: extra.icon || cmd.icon, command: id, args: extra.args, danger: extra.danger, disabled: !App.commands.isEnabled(id) };
    }

    function revealInFolder(p) {
        App.topbar?.clearSearch?.();
        return App.nav.go(P.parent(p), { focus: p }).then(() => gallery.scrollTo(p, { center: true }));
    }

    function viewMenu() {
        return [
            { label: '격자', icon: 'grid', checked: mode === 'grid', hint: mode === 'list' ? App.commands.displayKeys('gallery.toggleMode') : '', action: () => gallery.setMode('grid') },
            { label: '목록', icon: 'list', checked: mode === 'list', hint: mode === 'grid' ? App.commands.displayKeys('gallery.toggleMode') : '', action: () => gallery.setMode('list') },
            '-',
            { label: '꽉 채우기', icon: 'g-fit-cover', checked: fit === 'cover', disabled: mode === 'list', action: () => gallery.setFit('cover') },
            { label: '원본 비율', icon: 'g-fit-contain', checked: fit === 'contain', disabled: mode === 'list', action: () => gallery.setFit('contain') },
            '-',
            { label: '영상에 올리면 미리보기', icon: 'g-scrub', checked: scrubEnabled(), action: () => App.commands.run('gallery.toggleScrub') },
        ];
    }

    function sortMenu() {
        return App.view.sortKeys().map((k) => ({
            label: k.label,
            checked: App.view.sort.key === k.key,
            action: () => App.view.setSort(k.key, App.view.sort.key === k.key ? (App.view.sort.dir === 'asc' ? 'desc' : 'asc') : ASC_FIRST.has(k.key) ? 'asc' : 'desc'),
        }));
    }

    function buildContextMenu(entries) {
        const items = [];
        const add = (...xs) => {
            for (const x of xs) if (x) items.push(x);
        };
        const sep = () => {
            if (items.length && items[items.length - 1] !== '-') items.push('-');
        };
        const clip = gallery.clipboard;
        if (!entries.length) {
            add(cmdItem('folder.new', '새 폴더'));
            if (clip) add(cmdItem('file.paste', clip.count ? `붙여넣기 (${formatCount(clip.count)}개)` : '붙여넣기'));
            add(cmdItem('nav.reload', '새로 고침'));
            sep();
            add(cmdItem('select.all', '모두 선택'));
            sep();
            add({ label: '보기 방식', icon: mode === 'list' ? 'list' : 'grid', submenu: viewMenu });
            add({ label: '정렬', icon: 'sort', submenu: sortMenu });
        } else {
            const one = entries.length === 1 ? entries[0] : null;
            add(cmdItem('file.open', one && one.kind === 'dir' ? '열기' : '보기'));
            add(cmdItem('gallery.quicklook', '훑어보기'));
            if (one && App.view.source.type !== 'folder') add({ label: '폴더에서 보기', icon: 'folder-open', action: () => revealInFolder(one.path) });
            sep();
            add(cmdItem('file.copy', '복사'), cmdItem('file.cut', '잘라내기'));
            if (clip && clip.count && one && one.kind === 'dir') add(cmdItem('file.paste', `이 폴더에 붙여넣기 (${formatCount(clip.count)}개)`, { args: { dir: one.path } }));
            sep();
            add(cmdItem('organize.moveTo', '다른 폴더로 이동…'), cmdItem('organize.copyTo', '다른 폴더에 복사…'));
            if (one) add(cmdItem('file.rename', '이름 바꾸기'));
            else add(cmdItem('organize.rename', '이름 한꺼번에 바꾸기…'));
            sep();
            add(cmdItem('file.trash', '휴지통으로 이동', { danger: true }));
        }
        for (const contrib of gallery.contextMenuItems) {
            try {
                const more = contrib(entries);
                if (more && more.length) {
                    sep();
                    items.push(...more);
                }
            } catch (e) {
                console.error('[gallery] context menu contributor failed', e);
            }
        }
        while (items.length && items[items.length - 1] === '-') items.pop();
        return items;
    }

    function onContextMenu(e) {
        if (e.target.closest('.lhead')) {
            e.preventDefault();
            ui.menu([{ header: '정렬 기준' }, ...sortMenu(), '-', { header: '보기 방식' }, ...viewMenu().slice(0, 2)], { x: e.clientX, y: e.clientY });
            return;
        }
        e.preventDefault();
        endScrub();
        const el = itemElFrom(e.target);
        if (el && !App.select.has(el.dataset.path)) App.select.set([el.dataset.path]);
        if (!el && App.select.count && !e.ctrlKey) App.select.clear();
        const entries = el ? App.select.entries() : [];
        const items = buildContextMenu(entries);
        if (items.length) ui.menu(items, { x: e.clientX, y: e.clientY });
    }

    // ---------- Move / copy with toast + undo (drop, paste) ----------
    function undoIfLatest(entry) {
        if (!entry || App.undo.peek() === entry) return App.undo.undo();
        ui.toast(`그 사이에 다른 작업이 있어서 바로 되돌릴 수 없어요. ${App.commands.displayCombo('Mod+Z')}로 차례대로 되돌려 주세요.`, { type: 'warning' });
    }

    async function goAndSelect(dir, paths) {
        if (App.view.source.type !== 'folder') App.topbar?.clearSearch?.();
        await App.nav.go(dir);
        const keep = paths.filter((p) => App.view.indexOf(p) >= 0);
        if (!keep.length) return;
        App.select.set(keep, { focus: keep[0], anchor: keep[0] });
        gallery.scrollTo(keep[0], { center: true });
    }

    function selectAfterReload(paths) {
        let off = null;
        const timer = setTimeout(() => off && off(), 4000);
        off = App.bus.on('folder:loaded', () => {
            off();
            clearTimeout(timer);
            const keep = paths.filter((p) => App.view.indexOf(p) >= 0);
            if (!keep.length) return;
            App.select.set(keep, { focus: keep[keep.length - 1], anchor: keep[0] });
            gallery.scrollTo(keep[keep.length - 1]);
        });
    }

    /** Move or copy into destDir, then toast "n개를 옮겼어요" with [실행 취소] and [폴더로 가기]. */
    async function transfer(paths, destDir, op = 'move', { quiet = false } = {}) {
        const copy = op === 'copy';
        const list = (paths || []).filter((p) => p !== destDir && (copy || P.parent(p) !== destDir));
        if (!list.length) {
            if (!quiet) ui.toast(copy ? '복사할 항목이 없어요' : '이미 그 폴더에 있어요', { type: 'info' });
            return [];
        }
        let results;
        try {
            results = copy ? await App.fs.copy(list, destDir) : await App.fs.move(list, destDir);
        } catch (e) {
            ui.toast(`${copy ? '복사하지' : '옮기지'} 못했어요: ${e.message || e}`, { type: 'error' });
            return [];
        }
        if (!results || !results.length) return [];
        const undoEntry = App.undo.peek();
        const inCwd = App.view.source.type === 'folder' && destDir === App.state.cwd;
        const actions = [{ label: '실행 취소', run: () => undoIfLatest(undoEntry) }];
        if (!inCwd) actions.push({ label: '폴더로 가기', run: () => goAndSelect(destDir, results.map((r) => r.to)) });
        if (!quiet) toastActions(`${formatCount(results.length)}개를 ${copy ? '복사했어요' : '옮겼어요'}`, actions, { type: 'success', duration: 6500 });
        if (inCwd) selectAfterReload(results.map((r) => r.to));
        return results;
    }

    // ---------- Drag & drop ----------
    let dragPaths = null;
    let dropLabelEl = null;
    let dropState = { el: null, key: '', path: null };
    const spring = { dir: null, timer: 0, el: null, armed: false };

    /** A drop-target card re-rendered mid-drag (thumbnail/metadata refresh) keeps its highlight, label and spring */
    function reattachDragState(el, p) {
        if (dropState.path === p) {
            dropState.el = el;
            el.classList.add('drop-target');
            if (dropLabelEl) (el.querySelector('.card-media') || el).append(dropLabelEl);
        }
        if (spring.dir === p) {
            spring.el = el;
            if (spring.armed) el.classList.add('spring-armed');
        }
    }

    function copyModifier(e) {
        return isMac ? e.altKey : e.ctrlKey;
    }

    function decodedImageFor(p) {
        const el = rendered.get(p);
        const img = el && el.querySelector('img.card-img, .lc-thumb img, .mosaic-cell.has-thumb img');
        return img && img.complete && img.naturalWidth > 0 ? img : null;
    }

    function roundRect(g, x, y, w, hh, r) {
        g.beginPath();
        if (g.roundRect) g.roundRect(x, y, w, hh, r);
        else g.rect(x, y, w, hh);
    }

    /** Up to three fanned thumbnails + count badge, drawn synchronously from already-decoded card images. */
    function makeDragImage(paths, primary) {
        try {
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            const W = 184;
            const H = 156;
            const c = document.createElement('canvas');
            c.width = Math.round(W * dpr);
            c.height = Math.round(H * dpr);
            c.className = 'drag-canvas';
            Object.assign(c.style, { width: W + 'px', height: H + 'px', position: 'fixed', left: '-10000px', top: '0px', pointerEvents: 'none' });
            const g = c.getContext('2d');
            g.scale(dpr, dpr);
            const css = getComputedStyle(document.documentElement);
            const v = (name, fb) => css.getPropertyValue(name).trim() || fb;
            const accent = v('--accent', '#ff6b2c');
            const onAccent = v('--on-accent', '#ffffff');
            const tileBg = v('--bg-3', '#23252a');
            const tileFg = v('--text-3', '#81858e');
            const font = v('--font', 'sans-serif');
            const order = [primary, ...paths.filter((p) => p !== primary)].slice(0, 3);
            const tiles = order.map((p) => ({ p, entry: App.view.get(p) || { name: P.base(p), kind: 'file', ext: P.ext(p) }, img: decodedImageFor(p) }));
            const ANG = [0, -9, 8];
            const OFF = [[0, 0], [-13, 3], [13, 5]];
            const cx = W / 2;
            const cy = 62;
            for (let k = tiles.length - 1; k >= 0; k--) {
                const t = tiles[k];
                let tw = 112;
                let th = 84;
                if (t.img) {
                    const a = t.img.naturalWidth / t.img.naturalHeight;
                    if (a >= 112 / 84) th = Math.max(48, Math.round(112 / a));
                    else tw = Math.max(48, Math.round(84 * a));
                }
                g.save();
                g.translate(cx + OFF[k][0], cy + OFF[k][1]);
                g.rotate((ANG[k] * Math.PI) / 180);
                g.shadowColor = 'rgba(0, 0, 0, 0.35)';
                g.shadowBlur = 14;
                g.shadowOffsetY = 4;
                roundRect(g, -tw / 2 - 2.5, -th / 2 - 2.5, tw + 5, th + 5, 9);
                g.fillStyle = 'rgba(255, 255, 255, 0.96)';
                g.fill();
                g.shadowColor = 'transparent';
                roundRect(g, -tw / 2, -th / 2, tw, th, 7);
                g.save();
                g.clip();
                g.fillStyle = tileBg;
                g.fillRect(-tw / 2, -th / 2, tw, th);
                if (t.img) {
                    g.drawImage(t.img, -tw / 2, -th / 2, tw, th);
                } else if (t.entry.kind === 'dir') {
                    g.strokeStyle = accent;
                    g.lineWidth = 1.6;
                    g.lineJoin = 'round';
                    g.translate(-16, -15);
                    g.scale(32 / 24, 32 / 24);
                    g.stroke(new Path2D('M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z'));
                } else {
                    g.fillStyle = tileFg;
                    g.font = `700 13px ${font}`;
                    g.textAlign = 'center';
                    g.textBaseline = 'middle';
                    g.fillText((t.entry.ext || '?').toUpperCase(), 0, 0);
                }
                g.restore();
                g.restore();
            }
            if (paths.length > 1) {
                const label = paths.length > 999 ? '999+' : String(paths.length);
                g.font = `700 12px ${font}`;
                const bw = Math.max(26, g.measureText(label).width + 14);
                const bx = cx + 56 - bw / 2 + 6;
                const by = cy - 50;
                g.shadowColor = 'rgba(0, 0, 0, 0.3)';
                g.shadowBlur = 6;
                roundRect(g, bx, by, bw, 24, 12);
                g.fillStyle = accent;
                g.fill();
                g.shadowColor = 'transparent';
                g.fillStyle = onAccent;
                g.textAlign = 'center';
                g.textBaseline = 'middle';
                g.fillText(label, bx + bw / 2, by + 12.5);
            }
            // Name (or "name 외 n개") under the stack
            const first = tiles[0].entry.name;
            let text = paths.length > 1 ? `${first} 외 ${paths.length - 1}개` : first;
            g.font = `600 12px ${font}`;
            const maxW = W - 16;
            if (g.measureText(text).width > maxW - 20) {
                while (text.length > 4 && g.measureText(text + '…').width > maxW - 20) text = text.slice(0, -1);
                text += '…';
            }
            const tw2 = Math.min(maxW, g.measureText(text).width + 20);
            roundRect(g, cx - tw2 / 2, 124, tw2, 24, 12);
            g.fillStyle = 'rgba(12, 13, 15, 0.82)';
            g.fill();
            g.fillStyle = '#ffffff';
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.fillText(text, cx, 136.5);
            document.body.append(c);
            setTimeout(() => c.remove(), 0);
            gallery._lastDragImage = { count: paths.length, tiles: tiles.length, drawn: tiles.filter((t) => t.img).length };
            return { el: c, x: cx, y: cy };
        } catch (e) {
            console.warn('[gallery] drag image failed', e);
            return null;
        }
    }

    function onDragStart(e) {
        if (lasso) {
            // A lasso started on a list row's empty area: don't turn it into a file drag
            e.preventDefault();
            return;
        }
        const el = itemElFrom(e.target);
        if (!el) return;
        const p = el.dataset.path;
        if (!App.select.has(p)) App.select.set([p]);
        dragPaths = App.select.list();
        dragActive = true;
        endScrub();
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData('application/x-fi-paths', JSON.stringify(dragPaths));
        e.dataTransfer.setData('text/plain', dragPaths.join('\n'));
        const img = makeDragImage(dragPaths, p);
        if (img) e.dataTransfer.setDragImage(img.el, img.x, img.y);
        scroller.classList.add('is-dragging');
    }

    function dropTargetFor(e) {
        const el = e.target.closest ? e.target.closest('.card.is-dir, .lrow.is-dir') : null;
        if (el && canvas.contains(el)) return { el, dir: el.dataset.path };
        if (scroller.contains(e.target) && App.view.source.type === 'folder' && App.state.cwd != null) return { el: scroller, dir: App.state.cwd };
        return null;
    }

    function folderLabelName(dir) {
        return dir === '' ? App.state.workspace?.name || '작업 폴더' : P.base(dir);
    }

    function showDropLabel(t, { copy, count, external }) {
        const key = `${t.dir}|${copy}|${count}|${external}`;
        if (dropState.el === t.el && dropState.key === key) return;
        dropState = { el: t.el, key, path: t.el === scroller ? null : t.dir };
        if (!dropLabelEl) dropLabelEl = h('div', { class: 'drop-label', role: 'status' });
        const name = folderLabelName(t.dir);
        const quoted = `‘${escapeHtml(name)}’${particleRo(name)}`;
        const mod = isMac ? '⌥' : 'Ctrl';
        if (external) {
            dropLabelEl.innerHTML = `${ui.icon('download', { size: 13 })}<span>${count ? `${formatCount(count)}개를 ` : ''}${quoted} 가져오기</span>`;
        } else {
            dropLabelEl.innerHTML = `${ui.icon(copy ? 'copy' : 'folder-input', { size: 13 })}<span>${count ? `${formatCount(count)}개를 ` : ''}${quoted} ${copy ? '복사' : '이동'}</span>${copy ? '' : `<span class="drop-label-hint"> · ${mod}: 복사</span>`}`;
        }
        dropLabelEl.classList.toggle('is-copy', !!copy);
        if (t.el === scroller) {
            dropLabelEl.classList.add('is-floating');
            content.append(dropLabelEl);
        } else {
            dropLabelEl.classList.remove('is-floating');
            (t.el.querySelector('.card-media') || t.el).append(dropLabelEl);
        }
    }

    function armSpring(t) {
        if (t.el === scroller) return disarmSpring();
        if (spring.dir === t.dir) return;
        disarmSpring();
        spring.dir = t.dir;
        spring.el = t.el;
        // Hovering a folder for a moment opens it (spring-loaded folders), so you can drop deeper
        spring.timer = setTimeout(() => {
            spring.armed = true;
            spring.el?.classList.add('spring-armed');
            spring.timer = setTimeout(() => {
                const dir = spring.dir;
                disarmSpring();
                clearDropTargets();
                if (dir != null) App.nav.go(dir);
            }, 450);
        }, 700);
    }

    function disarmSpring() {
        clearTimeout(spring.timer);
        spring.el?.classList.remove('spring-armed');
        spring.dir = null;
        spring.el = null;
        spring.armed = false;
    }

    function onDragOver(e) {
        const t = dropTargetFor(e);
        if (!t) return;
        const types = e.dataTransfer.types;
        const internal = types.includes('application/x-fi-paths');
        const external = !internal && types.includes('Files');
        if (!internal && !external) return;
        if (internal && t.el === scroller && (!dragPaths || dragPaths.every((p) => P.parent(p) === t.dir))) {
            clearDropTargets();
            disarmSpring();
            return; // dropping items onto the folder they're already in does nothing
        }
        if (internal && dragPaths && (dragPaths.includes(t.dir) || dragPaths.some((p) => P.isInside(t.dir, p)))) {
            clearDropTargets();
            return; // can't drop a folder into itself
        }
        e.preventDefault();
        const copy = external || copyModifier(e);
        e.dataTransfer.dropEffect = copy ? 'copy' : 'move';
        if (dropState.el && dropState.el !== t.el) dropState.el.classList.remove('drop-target');
        t.el.classList.add('drop-target');
        const count = internal ? (dragPaths ? dragPaths.length : 0) : e.dataTransfer.items ? e.dataTransfer.items.length : 0;
        showDropLabel(t, { copy, count, external });
        armSpring(t);
    }

    function clearDropTargets() {
        document.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
        dropLabelEl?.remove();
        dropState = { el: null, key: '', path: null };
    }

    function endDrag() {
        dragPaths = null;
        dragActive = false;
        disarmSpring();
        clearDropTargets();
        scroller?.classList.remove('is-dragging');
    }

    async function onDrop(e) {
        const t = dropTargetFor(e);
        const internalRaw = e.dataTransfer.getData('application/x-fi-paths');
        const copy = copyModifier(e);
        const files = [...(e.dataTransfer.files || [])];
        endDrag();
        if (!t) return;
        e.preventDefault();
        if (internalRaw) {
            let paths;
            try {
                paths = JSON.parse(internalRaw);
            } catch (err) {
                return;
            }
            if (!Array.isArray(paths) || !paths.length) return;
            await transfer(paths, t.dir, copy ? 'copy' : 'move');
            return;
        }
        if (files.length) await importFiles(files, t.dir);
    }

    /** Import files dropped/pasted from outside. Only photos/videos; undo moves the imported copies to the trash. */
    async function importFiles(files, dir, { verb = '가져왔어요' } = {}) {
        const media = files.filter((f) => App.util.mediaType(f.name) !== 'other');
        const skipped = files.length - media.length;
        if (!media.length) {
            ui.toast('사진이나 영상 파일만 가져올 수 있어요', { type: 'warning' });
            return [];
        }
        const job = media.length > 3 ? App.jobs.start({ title: '가져오는 중', total: media.length }) : null;
        const created = [];
        try {
            for (const f of media) {
                if (job?.cancelled) break;
                created.push(await App.fs.createFile(dir, f.name, f));
                job?.update(created.length);
            }
        } catch (err) {
            ui.toast(`가져오지 못한 파일이 있어요: ${err.message || err}`, { type: 'error' });
        } finally {
            job?.finish();
        }
        if (!created.length) return created;
        let trashIds = null;
        App.undo.push({
            label: `${created.length}개 가져오기`,
            undo: async () => {
                trashIds = await App.fs.trash(created, { undoable: false, silent: true });
            },
            redo: async () => {
                if (trashIds) await App.fs.restore(trashIds);
            },
        });
        const undoEntry = App.undo.peek();
        const msg = `${formatCount(created.length)}개 파일을 ${verb}${skipped ? ` · 사진·영상이 아닌 ${formatCount(skipped)}개는 건너뛰었어요` : ''}`;
        toastActions(msg, [{ label: '실행 취소', run: () => undoIfLatest(undoEntry) }], { type: 'success', duration: 6000 });
        if (App.view.source.type === 'folder' && dir === App.state.cwd) selectAfterReload(created);
        return created;
    }

    // ---------- Keyboard ----------
    function moveFocus(delta, e) {
        const list = App.view.visible;
        if (!list.length) return;
        let i = App.view.indexOf(App.select.focus);
        if (i < 0) i = delta > 0 ? -1 : list.length;
        const next = clamp(i + delta, 0, list.length - 1);
        const p = list[next].path;
        if (e && e.shiftKey) App.select.range(p);
        else if (e && (e.ctrlKey || e.metaKey)) {
            App.select.focus = p;
            App.select.emit();
        } else App.select.set([p]);
        gallery.scrollTo(p);
    }

    function pageDelta() {
        const { top, bottom } = viewRange();
        const rows = Math.max(1, Math.floor((bottom - top) / (mode === 'list' ? L.listRowH : L.rowStep)));
        return rows * L.cols;
    }

    // Type-ahead: typing letters jumps to the next item whose name starts with them
    let typeBuf = '';
    let typeAt = 0;
    let typeTimer = 0;

    function showTypePill(text, found) {
        if (!typePillEl) return;
        typePillEl.innerHTML = `<span class="tp-key">${escapeHtml(text)}</span><span class="tp-msg">${found ? '로 시작하는 항목' : '일치하는 항목이 없어요'}</span>`;
        typePillEl.classList.toggle('miss', !found);
        typePillEl.classList.add('show');
        clearTimeout(typeTimer);
        typeTimer = setTimeout(() => typePillEl.classList.remove('show'), 1100);
    }

    function onTypeAhead(e) {
        if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
        if (!e.key || e.key.length !== 1 || e.key === ' ' || !App.fs.ready || App.layers.top() !== 'main') return;
        if (App.util.isTypingTarget(e.target) || App.util.isTypingTarget(document.activeElement)) return;
        const list = App.view.visible;
        if (!list.length) return;
        const now = performance.now();
        if (now - typeAt > 900) typeBuf = '';
        typeAt = now;
        typeBuf += e.key.toLocaleLowerCase();
        const cycling = [...typeBuf].every((ch) => ch === typeBuf[0]);
        const q = cycling ? typeBuf[0] : typeBuf;
        const cur = App.view.indexOf(App.select.focus);
        const startAt = cycling ? cur + 1 : Math.max(0, cur);
        let hit = -1;
        for (let k = 0; k < list.length; k++) {
            const i = (startAt + k + list.length) % list.length;
            if (list[i].name.toLocaleLowerCase().startsWith(q)) {
                hit = i;
                break;
            }
        }
        showTypePill(typeBuf, hit >= 0);
        if (hit < 0) return;
        e.preventDefault();
        App.select.set([list[hit].path]);
        gallery.scrollTo(list[hit].path);
    }

    // ---------- Empty state / loading ----------
    function updateEmpty() {
        if (!emptyEl) return;
        const empty = App.fs.ready && App.view.visible.length === 0;
        emptyEl.hidden = !empty;
        emptyEl.classList.add('gallery-empty');
        if (!empty) return;
        const src = App.view.source;
        const otherFilters = [...App.view.filters.keys()].length > 0;
        let title;
        let text;
        let action = null;
        if (src.type === 'search' && !App.index.ready) {
            title = '찾는 중이에요';
            text = '라이브러리를 훑어보는 대로 결과를 보여 드릴게요.';
        } else if (src.type === 'search') {
            title = '검색 결과가 없어요';
            text = '다른 낱말로 찾아보거나 철자를 확인해 보세요.';
        } else if (otherFilters) {
            title = '조건에 맞는 항목이 없어요';
            text = '필터를 바꾸거나 지우면 다시 보여요.';
            action = {
                label: '필터 모두 지우기',
                run: () => {
                    App.topbar?.setTypeFilter?.('all');
                    for (const id of [...App.view.filters.keys()]) App.view.setFilter(id, null);
                },
            };
        } else {
            title = '이 폴더는 비어 있어요';
            text = '탐색기에서 사진이나 영상을 여기로 끌어 놓으면 이 폴더로 가져와요.';
        }
        emptyEl.querySelector('h2').textContent = title;
        emptyEl.querySelector('p').textContent = text;
        emptyEl.querySelector('.gallery-empty-action')?.remove();
        if (action) emptyEl.append(h('button', { class: 'btn sm gallery-empty-action', text: action.label, onclick: action.run }));
    }

    let loadingTimer = 0;
    function showLoading(on) {
        clearTimeout(loadingTimer);
        if (!loadingEl) return;
        if (!on) {
            loadingEl.classList.remove('show');
            return;
        }
        loadingTimer = setTimeout(() => {
            loadingEl.style.top = scroller.offsetTop + 'px';
            loadingEl.classList.add('show');
        }, 160);
    }

    // ---------- Scroll memory (back / forward / up return to where you were) ----------
    const scrollMemory = new Map();
    let lastSource = null;

    function sourceKey(src) {
        if (!src) return '';
        return src.type === 'folder' ? `folder:${src.path}` : `${src.type}:${src.query ?? src.title ?? ''}`;
    }

    function onEntriesChanged() {
        const src = App.view.source;
        const key = sourceKey(src);
        if (lastSource && sourceKey(lastSource) === key) return null; // same list reloaded: keep the position
        if (lastSource && lastSource.type === 'folder') {
            scrollMemory.delete(lastSource.path);
            scrollMemory.set(lastSource.path, getScrollTop());
            if (scrollMemory.size > 300) scrollMemory.delete(scrollMemory.keys().next().value);
        }
        lastSource = { type: src.type, path: src.path, query: src.query, title: src.title };
        return src.type === 'folder' && scrollMemory.has(src.path) ? scrollMemory.get(src.path) : 0;
    }

    // ---------- View bar controls ----------
    function segButton(on, iconName, tip, keysCmd, run) {
        const cmd = keysCmd ? App.commands.get(keysCmd) : null;
        const b = h('button', {
            class: on ? 'on' : '',
            type: 'button',
            'aria-pressed': on ? 'true' : 'false',
            'aria-label': tip,
            'data-tip': tip,
            'data-tip-keys': cmd && cmd.keys[0] ? cmd.keys[0] : null,
            html: ui.icon(iconName, { size: 14 }),
        });
        b.addEventListener('click', () => {
            run();
            b.blur();
        });
        return b;
    }

    function viewbarControls() {
        if (!App.fs.ready) return null;
        const wrap = h('div', { class: 'gv-controls' });
        if (mode === 'grid') {
            wrap.append(h('div', { class: 'seg gv-fit', role: 'group', 'aria-label': '썸네일 맞춤' },
                segButton(fit === 'cover', 'g-fit-cover', '꽉 채우기', fit === 'contain' ? 'gallery.toggleFit' : null, () => gallery.setFit('cover')),
                segButton(fit === 'contain', 'g-fit-contain', '원본 비율', fit === 'cover' ? 'gallery.toggleFit' : null, () => gallery.setFit('contain'))));
        }
        wrap.append(h('div', { class: 'seg gv-mode', role: 'group', 'aria-label': '보기 방식' },
            segButton(mode === 'grid', 'grid', '격자 보기', mode === 'list' ? 'gallery.toggleMode' : null, () => gallery.setMode('grid')),
            segButton(mode === 'list', 'list', '목록 보기', mode === 'grid' ? 'gallery.toggleMode' : null, () => gallery.setMode('list'))));
        return wrap;
    }

    // ---------- Commands ----------
    const hasSelection = () => App.select.count > 0;
    const inFolder = () => App.fs.ready && App.view.source.type === 'folder';
    const hasItems = () => App.fs.ready && App.view.visible.length > 0;

    App.commands.register({ id: 'gallery.left', title: '이전 항목', group: '선택', keys: ['ArrowLeft', 'Shift+ArrowLeft', 'Mod+ArrowLeft'], when: hasItems, run: ({ event } = {}) => moveFocus(-1, event) });
    App.commands.register({ id: 'gallery.right', title: '다음 항목', group: '선택', keys: ['ArrowRight', 'Shift+ArrowRight', 'Mod+ArrowRight'], when: hasItems, run: ({ event } = {}) => moveFocus(1, event) });
    App.commands.register({ id: 'gallery.up', title: '위 항목', group: '선택', keys: ['ArrowUp', 'Shift+ArrowUp', 'Mod+ArrowUp'], when: hasItems, run: ({ event } = {}) => moveFocus(-L.cols, event) });
    App.commands.register({ id: 'gallery.down', title: '아래 항목', group: '선택', keys: ['ArrowDown', 'Shift+ArrowDown', 'Mod+ArrowDown'], when: hasItems, run: ({ event } = {}) => moveFocus(L.cols, event) });
    App.commands.register({ id: 'gallery.pageUp', title: '한 화면 위로', group: '선택', keys: ['PageUp', 'Shift+PageUp'], when: hasItems, run: ({ event } = {}) => moveFocus(-pageDelta(), event) });
    App.commands.register({ id: 'gallery.pageDown', title: '한 화면 아래로', group: '선택', keys: ['PageDown', 'Shift+PageDown'], when: hasItems, run: ({ event } = {}) => moveFocus(pageDelta(), event) });
    App.commands.register({ id: 'gallery.first', title: '처음 항목', group: '선택', keys: ['Home', 'Shift+Home'], when: hasItems, run: ({ event } = {}) => moveFocus(-Infinity, event) });
    App.commands.register({ id: 'gallery.last', title: '마지막 항목', group: '선택', keys: ['End', 'Shift+End'], when: hasItems, run: ({ event } = {}) => moveFocus(Infinity, event) });

    App.commands.register({
        id: 'file.open',
        title: '열기',
        group: '파일',
        icon: 'eye',
        keys: ['Enter'],
        when: () => !!App.select.focus || App.select.count === 1,
        run: () => App.nav.open(App.select.primary() || App.view.get(App.select.list()[0])),
    });

    App.commands.register({
        id: 'file.rename',
        title: '이름 바꾸기',
        group: '파일',
        icon: 'edit',
        keys: ['F2'],
        when: () => App.select.count === 1,
        run: async () => {
            const entry = App.view.get(App.select.list()[0]);
            if (!entry) return;
            const name = await ui.prompt({
                title: '이름 바꾸기',
                value: entry.name,
                selectStem: entry.kind === 'file',
                okLabel: '바꾸기',
                validate: (v) => App.fs.validateName(v),
            });
            if (!name || name === entry.name) return;
            try {
                await App.fs.rename(entry.path, name);
            } catch (e) {
                ui.toast(e.message, { type: 'error' });
            }
        },
    });

    App.commands.register({
        id: 'file.trash',
        title: '휴지통으로 이동',
        group: '파일',
        icon: 'trash',
        keys: ['Delete'],
        when: hasSelection,
        run: async () => {
            const paths = App.select.list();
            if (!paths.length) return;
            const dirs = App.select.entries().filter((e) => e.kind === 'dir').length;
            if (dirs && !(await ui.confirm({ title: '폴더 삭제', message: `폴더 ${dirs}개를 포함해 ${paths.length}개 항목을 휴지통으로 옮길까요? 휴지통에서 되살릴 수 있어요.`, okLabel: '휴지통으로', danger: true }))) return;
            // Pick the neighbour that survives (the list only reloads after the trash finishes)
            const order = App.view.visible.map((e) => e.path);
            const gone = new Set(paths);
            const idx = paths.map((p) => order.indexOf(p)).filter((i) => i >= 0);
            const lastIdx = idx.length ? Math.max(...idx) : -1;
            const firstIdx = idx.length ? Math.min(...idx) : 0;
            const next = order.slice(lastIdx + 1).find((p) => !gone.has(p)) || order.slice(0, firstIdx).reverse().find((p) => !gone.has(p));
            await App.fs.trash(paths);
            if (next && App.view.indexOf(next) >= 0) App.select.set([next]);
            else App.select.clear();
        },
    });

    App.commands.register({
        id: 'folder.new',
        title: '새 폴더',
        group: '파일',
        icon: 'folder-plus',
        keys: ['Mod+Shift+N'],
        when: inFolder,
        run: async () => {
            const dir = App.state.cwd;
            const name = await ui.prompt({ title: '새 폴더', value: await App.fs.uniqueName(dir, '새 폴더', { isDir: true }), okLabel: '만들기', validate: (v) => App.fs.validateName(v) });
            if (!name) return;
            try {
                const p = await App.fs.mkdir(dir, name);
                App.bus.once('folder:loaded', () => {
                    App.select.set([p]);
                    gallery.scrollTo(p);
                });
            } catch (e) {
                ui.toast(e.message, { type: 'error' });
            }
        },
    });

    App.commands.register({ id: 'select.all', title: '모두 선택', group: '선택', icon: 'check', keys: ['Mod+A'], when: () => App.view.visible.length > 0, run: () => App.select.all() });
    App.commands.register({ id: 'select.clear', title: '선택 해제', group: '선택', icon: 'x', keys: ['Escape'], when: hasSelection, run: () => App.select.clear() });
    App.commands.register({ id: 'gallery.zoomIn', title: '썸네일 크게', group: '보기', icon: 'zoom-in', keys: ['Mod+='], run: () => gallery.setZoom(gallery.zoom * 1.15) });
    App.commands.register({ id: 'gallery.zoomOut', title: '썸네일 작게', group: '보기', icon: 'zoom-out', keys: ['Mod+-'], run: () => gallery.setZoom(gallery.zoom / 1.15) });
    App.commands.register({
        id: 'gallery.toggleMode',
        title: '목록 보기와 격자 보기 바꾸기',
        group: '보기',
        icon: 'list',
        keys: ['Mod+Shift+L'],
        when: () => App.fs.ready,
        run: () => gallery.setMode(mode === 'list' ? 'grid' : 'list'),
    });
    App.commands.register({ id: 'gallery.viewGrid', title: '격자로 보기', group: '보기', icon: 'grid', when: () => App.fs.ready && mode !== 'grid', run: () => gallery.setMode('grid') });
    App.commands.register({ id: 'gallery.viewList', title: '목록으로 보기', group: '보기', icon: 'list', when: () => App.fs.ready && mode !== 'list', run: () => gallery.setMode('list') });
    App.commands.register({
        id: 'gallery.toggleFit',
        title: '썸네일 꽉 채우기 / 원본 비율 바꾸기',
        group: '보기',
        icon: 'g-fit-contain',
        keys: ['Mod+Shift+F'],
        when: () => App.fs.ready && mode === 'grid',
        run: () => gallery.setFit(fit === 'contain' ? 'cover' : 'contain'),
    });
    App.commands.register({
        id: 'gallery.toggleScrub',
        title: '영상에 올리면 미리보기 켜고 끄기',
        group: '보기',
        icon: 'g-scrub',
        run: () => {
            const on = !scrubEnabled();
            App.settings.set('gallery.scrub', on);
            if (!on) endScrub();
            ui.toast(on ? '영상 카드에 마우스를 올리면 미리 볼 수 있어요' : '영상 호버 미리보기를 껐어요', { type: 'info', duration: 2200 });
        },
    });
    App.commands.register({
        id: 'gallery.revealInFolder',
        title: '폴더에서 보기',
        group: '이동',
        icon: 'folder-open',
        when: () => App.fs.ready && App.view.source.type !== 'folder' && App.select.count === 1,
        run: () => revealInFolder(App.select.list()[0]),
    });

    // Extra sort keys used by the list view headers (also show up in the sort menu)
    App.view.registerSortKey('resolution', '해상도', (e) => {
        const m = App.catalog.peek(e.path)?.meta;
        return m && m.w && m.h ? m.w * m.h : 0;
    });
    App.view.registerSortKey('duration', '길이', (e) => App.catalog.peek(e.path)?.meta?.duration || 0);

    // ---------- Init ----------
    App.register('gallery', {
        init() {
            scroller = document.getElementById('gallery-scroll');
            canvas = document.getElementById('gallery');
            content = document.getElementById('content');
            emptyEl = document.getElementById('gallery-empty');
            if (!scroller || !canvas) return;
            canvas.setAttribute('aria-multiselectable', 'true');
            document.documentElement.style.setProperty('--thumb-size', gallery.zoom + 'px');

            headEl = h('div', { class: 'lhead', role: 'row', hidden: true });
            headEl.addEventListener('click', onHeadClick);
            scroller.insertBefore(headEl, canvas);
            loadingEl = h('div', { class: 'gallery-loading', 'aria-hidden': 'true' }, h('i'));
            typePillEl = h('div', { class: 'type-pill', 'aria-live': 'polite' });
            content.append(loadingEl, typePillEl);
            applyModeClasses();

            L.width = scroller.clientWidth;
            viewH = scroller.clientHeight;
            scroller.addEventListener('scroll', () => {
                if (pendingScroll == null) scrollTopCache = scroller.scrollTop;
                if (scrub.card) endScrub();
                schedule();
            }, { passive: true });
            let lastCols = L.cols;
            new ResizeObserver(() => {
                // Layout is clean inside ResizeObserver callbacks, so these reads are cheap
                const w = scroller.clientWidth;
                const hh = scroller.clientHeight;
                const widthChanged = w !== L.width;
                L.width = w;
                viewH = hh;
                if (widthChanged) {
                    const a = anchor;
                    layout();
                    if (L.cols !== lastCols) restoreAnchor(a);
                    lastCols = L.cols;
                }
                schedule();
            }).observe(scroller);

            scroller.addEventListener('click', onClick);
            scroller.addEventListener('dblclick', onDblClick);
            scroller.addEventListener('contextmenu', onContextMenu);
            scroller.addEventListener('pointerdown', onPointerDown);
            scroller.addEventListener('pointermove', onPointerMove);
            scroller.addEventListener('pointerup', onPointerUp);
            scroller.addEventListener('pointercancel', () => endLasso(false));
            scroller.addEventListener('pointerleave', () => {
                if (!lasso) endScrub();
            });
            scroller.addEventListener('dragstart', onDragStart);
            scroller.addEventListener('dragover', onDragOver);
            // dragenter (new element) fires before dragleave (old element): a leave from the element we last
            // entered means the pointer really left the gallery; leaves between children are ignored.
            let dragEnterTarget = null;
            scroller.addEventListener('dragenter', (e) => {
                dragEnterTarget = e.target;
            });
            scroller.addEventListener('dragleave', (e) => {
                if (e.target !== dragEnterTarget && scroller.contains(dragEnterTarget)) return;
                dragEnterTarget = null;
                disarmSpring();
                clearDropTargets();
            });
            scroller.addEventListener('drop', onDrop);
            // dragend may fire on a detached card (after spring-loading navigated away): listen on window too
            window.addEventListener('dragend', endDrag, true);
            window.addEventListener('drop', () => setTimeout(endDrag, 0), true);
            scroller.addEventListener('wheel', (e) => {
                if (!e.ctrlKey) return;
                e.preventDefault();
                gallery.setZoom(gallery.zoom * (e.deltaY < 0 ? 1.08 : 0.92), { anchorY: e.clientY });
            }, { passive: false });
            document.addEventListener('keydown', onTypeAhead);

            App.topbar?.addViewbarItem?.(viewbarControls);

            App.bus.on('view:changed', ({ reason }) => {
                const restore = reason === 'entries' ? onEntriesChanged() : null;
                endScrub();
                layout();
                if (restore != null) setScrollTop(restore);
                if (mode === 'list' && (reason === 'sort' || reason === 'entries')) renderHead();
                gallery.refresh();
                if ((reason === 'sort' || reason === 'filter') && App.select.focus && App.view.indexOf(App.select.focus) >= 0) gallery.scrollTo(App.select.focus);
                updateEmpty();
            });
            App.bus.on('selection:changed', updateSelectionClasses);
            App.bus.on('catalog:changed', ({ paths }) => gallery.invalidate(paths));
            App.bus.on('thumbs:meta', ({ path }) => gallery.invalidate([path]));
            App.bus.on('folder:loading', () => showLoading(true));
            App.bus.on('folder:loaded', () => {
                showLoading(false);
                const f = App.select.focus;
                if (f && App.view.indexOf(f) >= 0) {
                    const r = itemRect(App.view.indexOf(f));
                    const { top, bottom } = viewRange();
                    if (r.y < top || r.y + r.h > bottom) gallery.scrollTo(f, { center: true });
                }
            });
            App.bus.on('index:ready', refreshFolderStats);
            App.bus.on('index:changed', refreshFolderStats);
            App.bus.on('workspace:opened', () => {
                folderStats.map = null;
                folderStats.sig = new Map();
                folderStats.dirty = true;
                scrollMemory.clear();
                lastSource = null;
            });
            App.bus.on('workspace:closed', () => {
                emptyEl.hidden = true;
                showLoading(false);
                releaseScrubSource();
                endDrag();
                for (const el of rendered.values()) el.remove();
                rendered.clear();
                folderStats.map = null;
                folderStats.sig = new Map();
                scrollMemory.clear();
                lastSource = null;
            });
        },
    });

    App.gallery = gallery;
})();
