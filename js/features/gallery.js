/*
 * Gallery: virtualized grid of the visible entries (App.view.visible).
 * Only rows near the viewport exist in the DOM, so folders with tens of thousands of files stay smooth.
 *
 * Interaction: click / Ctrl+click / Shift+click selection, double-click or Enter opens, arrow keys move focus,
 * Ctrl+wheel zooms, drag selection onto folders to move (Ctrl = copy), drop files from Explorer to import.
 *
 * Extension points for other modules:
 *   App.gallery.cardDecorators.push((card, entry) => {...})   — add badges/overlays to a card after it renders
 *   App.gallery.contextMenuItems.push((entries) => items[])    — contribute context menu items
 *   App.gallery.refresh()                                     — re-render visible cards (e.g. after metadata changes)
 *   App.gallery.scrollTo(path)
 */
(() => {
    'use strict';
    const { h, path: P, formatBytes, formatDuration } = App.util;
    const ui = App.ui;

    const GAP = 12;
    const PAD = 16;
    const META_H = 44;
    const BUFFER_ROWS = 3;

    let scroller;
    let canvas;
    let emptyEl;
    let cols = 1;
    let cardW = 180;
    let rowH = 224;
    const rendered = new Map(); // path -> element
    let rafPending = false;

    const gallery = {
        cardDecorators: [],
        contextMenuItems: [],

        get columns() {
            return cols;
        },

        refresh() {
            for (const el of rendered.values()) el.remove();
            rendered.clear();
            schedule();
        },

        /** Re-render only these cards (after their metadata changed) */
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
            if (i < 0) return;
            const row = Math.floor(i / cols);
            const top = PAD + row * (rowH + GAP);
            const viewTop = scroller.scrollTop;
            const viewBottom = viewTop + scroller.clientHeight;
            if (center) scroller.scrollTop = top - scroller.clientHeight / 2 + rowH / 2;
            else if (top < viewTop) scroller.scrollTop = top - PAD;
            else if (top + rowH > viewBottom) scroller.scrollTop = top + rowH - scroller.clientHeight + PAD;
        },

        cardFor(p) {
            return rendered.get(p) || null;
        },

        setZoom(size) {
            const s = App.util.clamp(Math.round(size), 96, 480);
            document.documentElement.style.setProperty('--thumb-size', s + 'px');
            App.settings.set('gallery.size', s);
            layout();
            gallery.refresh();
            App.bus.emit('gallery:zoom', { size: s });
        },

        get zoom() {
            return App.settings.get('gallery.size', 180);
        },
    };

    function layout() {
        const size = gallery.zoom;
        const width = scroller.clientWidth - PAD * 2;
        cols = Math.max(1, Math.floor((width + GAP) / (size + GAP)));
        cardW = Math.floor((width - GAP * (cols - 1)) / cols);
        rowH = Math.round(cardW * 0.82) + META_H;
        const rows = Math.ceil(App.view.visible.length / cols);
        canvas.style.height = rows ? PAD * 2 + rows * rowH + (rows - 1) * GAP + 'px' : '0px';
    }

    function schedule() {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
            rafPending = false;
            renderWindow();
        });
    }

    function renderWindow() {
        const list = App.view.visible;
        const top = scroller.scrollTop - PAD;
        const firstRow = Math.max(0, Math.floor(top / (rowH + GAP)) - BUFFER_ROWS);
        const lastRow = Math.ceil((top + scroller.clientHeight) / (rowH + GAP)) + BUFFER_ROWS;
        const start = firstRow * cols;
        const end = Math.min(list.length, (lastRow + 1) * cols);

        const wanted = new Set();
        for (let i = start; i < end; i++) wanted.add(list[i].path);
        for (const [p, el] of rendered) {
            if (!wanted.has(p)) {
                el.remove();
                rendered.delete(p);
            }
        }
        const onScreen = [];
        for (let i = start; i < end; i++) {
            const entry = list[i];
            let el = rendered.get(entry.path);
            if (!el) {
                el = buildCard(entry);
                rendered.set(entry.path, el);
                canvas.append(el);
            }
            const row = Math.floor(i / cols);
            const col = i % cols;
            el.style.transform = `translate(${PAD + col * (cardW + GAP)}px, ${PAD + row * (rowH + GAP)}px)`;
            el.style.width = cardW + 'px';
            el.style.height = rowH + 'px';
            onScreen.push(entry.path);
        }
        App.thumbs.prioritize(onScreen);
    }

    function cardSub(entry) {
        if (entry.kind === 'dir') return '폴더';
        const meta = App.catalog.peek(entry.path)?.meta;
        const parts = [];
        if (meta?.w && meta?.h) parts.push(`${meta.w}×${meta.h}`);
        parts.push(formatBytes(entry.size));
        return parts.join(' · ');
    }

    function buildCard(entry) {
        const selected = App.select.has(entry.path);
        const card = h('div', {
            class: `card${entry.kind === 'dir' ? ' is-dir' : ''}${selected ? ' selected' : ''}${App.select.focus === entry.path ? ' focused' : ''}`,
            dataset: { path: entry.path },
            draggable: 'true',
        });
        const media = h('div', { class: 'card-media' });
        if (entry.kind === 'dir') {
            media.append(h('div', { class: 'card-folder', html: ui.icon('folder', { size: 44 }) }));
        } else {
            const img = h('img', { class: 'card-img', alt: '', draggable: 'false' });
            const placeholder = h('div', { class: 'card-ph', html: ui.icon(entry.type === 'video' ? 'film' : 'image', { size: 28 }) });
            media.append(placeholder, img);
            const cached = App.thumbs.peek(entry);
            if (cached) {
                img.src = cached;
                card.classList.add('has-thumb');
            } else if (App.thumbs.canThumb(entry)) {
                App.thumbs.get(entry).then((url) => {
                    if (url && card.isConnected) {
                        img.src = url;
                        card.classList.add('has-thumb');
                    } else if (!url) {
                        card.classList.add('no-thumb');
                    }
                });
            } else {
                card.classList.add('no-thumb');
                placeholder.append(h('span', { class: 'card-ext', text: entry.ext.toUpperCase() }));
            }
            if (entry.type === 'video') {
                const dur = App.catalog.peek(entry.path)?.meta?.duration;
                media.append(h('span', { class: 'card-badge video', html: `${ui.icon('play', { size: 10 })}${dur ? `<span>${formatDuration(dur)}</span>` : ''}` }));
            }
        }
        media.append(h('span', { class: 'card-check', html: ui.icon('check', { size: 12 }) }));
        card.append(media, h('div', { class: 'card-meta' }, h('div', { class: 'card-name', text: entry.name, title: entry.name }), h('div', { class: 'card-sub', text: cardSub(entry) })));
        for (const deco of gallery.cardDecorators) {
            try {
                deco(card, entry);
            } catch (e) {
                console.error('[gallery] decorator failed', e);
            }
        }
        return card;
    }

    function updateSelectionClasses() {
        for (const [p, el] of rendered) {
            el.classList.toggle('selected', App.select.has(p));
            el.classList.toggle('focused', App.select.focus === p);
        }
    }

    function entryFromEvent(e) {
        const card = e.target.closest?.('.card');
        return card ? App.view.get(card.dataset.path) : null;
    }

    // ---------- Pointer interaction ----------
    function onClick(e) {
        const entry = entryFromEvent(e);
        if (!entry) {
            if (!e.ctrlKey && !e.shiftKey && !e.metaKey) App.select.clear();
            return;
        }
        if (e.target.closest('.card-check')) {
            App.select.toggle(entry.path);
            return;
        }
        if (e.shiftKey) App.select.range(entry.path, { additive: e.ctrlKey || e.metaKey });
        else if (e.ctrlKey || e.metaKey) App.select.toggle(entry.path);
        else App.select.set([entry.path]);
    }

    function onDblClick(e) {
        const entry = entryFromEvent(e);
        if (entry) App.nav.open(entry);
    }

    function onContextMenu(e) {
        const entry = entryFromEvent(e);
        e.preventDefault();
        if (entry && !App.select.has(entry.path)) App.select.set([entry.path]);
        const entries = entry ? App.select.entries() : [];
        ui.menu(buildContextMenu(entries), { x: e.clientX, y: e.clientY });
    }

    function buildContextMenu(entries) {
        const items = [];
        if (!entries.length) {
            items.push(
                { label: '새 폴더', icon: 'folder-plus', command: 'folder.new' },
                { label: '새로 고침', icon: 'refresh', command: 'nav.reload' },
                '-',
                { label: '모두 선택', icon: 'check', command: 'select.all' },
                {
                    label: '정렬',
                    icon: 'sort',
                    submenu: () => App.view.sortKeys().map((k) => ({
                        label: k.label,
                        checked: App.view.sort.key === k.key,
                        action: () => App.view.setSort(k.key, App.view.sort.key === k.key && App.view.sort.dir === 'asc' ? 'desc' : 'asc'),
                    })),
                },
            );
        } else {
            const one = entries.length === 1 ? entries[0] : null;
            items.push({ label: one && one.kind === 'dir' ? '열기' : '보기', icon: 'eye', command: 'file.open' });
            if (one) items.push({ label: '이름 바꾸기', icon: 'edit', command: 'file.rename' });
            items.push({ label: '휴지통으로 이동', icon: 'trash', command: 'file.trash', danger: true });
        }
        for (const contrib of gallery.contextMenuItems) {
            try {
                const more = contrib(entries);
                if (more && more.length) items.push('-', ...more);
            } catch (e) {
                console.error('[gallery] context menu contributor failed', e);
            }
        }
        return items;
    }

    // ---------- Drag & drop ----------
    let dragPaths = null;

    function onDragStart(e) {
        const entry = entryFromEvent(e);
        if (!entry) return;
        if (!App.select.has(entry.path)) App.select.set([entry.path]);
        dragPaths = App.select.list();
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData('application/x-fi-paths', JSON.stringify(dragPaths));
        e.dataTransfer.setData('text/plain', dragPaths.join('\n'));
        const ghost = h('div', { class: 'drag-ghost', text: dragPaths.length === 1 ? P.base(dragPaths[0]) : `${dragPaths.length}개 항목` });
        document.body.append(ghost);
        e.dataTransfer.setDragImage(ghost, 10, 10);
        setTimeout(() => ghost.remove(), 0);
    }

    function dropTargetFor(e) {
        const card = e.target.closest?.('.card.is-dir');
        if (card) return { el: card, dir: card.dataset.path };
        if (e.target.closest?.('#gallery-scroll') && App.view.source.type === 'folder') return { el: scroller, dir: App.state.cwd };
        return null;
    }

    function onDragOver(e) {
        const t = dropTargetFor(e);
        if (!t) return;
        const internal = e.dataTransfer.types.includes('application/x-fi-paths');
        const external = e.dataTransfer.types.includes('Files');
        if (!internal && !external) return;
        if (internal && t.el === scroller) return; // dropping onto the folder you're in does nothing
        if (internal && dragPaths && dragPaths.includes(t.dir)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = external || e.ctrlKey ? 'copy' : 'move';
        document.querySelectorAll('.drop-target').forEach((n) => n !== t.el && n.classList.remove('drop-target'));
        t.el.classList.add('drop-target');
    }

    function clearDropTargets() {
        document.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
    }

    async function onDrop(e) {
        const t = dropTargetFor(e);
        clearDropTargets();
        if (!t) return;
        e.preventDefault();
        const raw = e.dataTransfer.getData('application/x-fi-paths');
        if (raw) {
            const paths = JSON.parse(raw);
            if (e.ctrlKey) await App.fs.copy(paths, t.dir);
            else await App.fs.move(paths, t.dir);
            return;
        }
        if (e.dataTransfer.files.length) await importFiles([...e.dataTransfer.files], t.dir);
    }

    async function importFiles(files, dir) {
        const job = App.jobs.start({ title: '가져오는 중', total: files.length });
        let n = 0;
        try {
            for (const file of files) {
                if (job.cancelled) break;
                await App.fs.createFile(dir, file.name, file);
                job.update(++n);
            }
        } finally {
            job.finish();
        }
        ui.toast(`${n}개 파일을 가져왔어요`, { type: 'success' });
    }

    // ---------- Keyboard focus movement ----------
    function moveFocus(delta, e) {
        const list = App.view.visible;
        if (!list.length) return;
        let i = App.view.indexOf(App.select.focus);
        if (i < 0) i = delta > 0 ? -1 : list.length;
        const next = App.util.clamp(i + delta, 0, list.length - 1);
        const p = list[next].path;
        if (e?.shiftKey) App.select.range(p);
        else if (e?.ctrlKey || e?.metaKey) {
            App.select.focus = p;
            App.select.emit();
        } else App.select.set([p]);
        gallery.scrollTo(p);
    }

    // ---------- Commands ----------
    const hasSelection = () => App.select.count > 0;
    const inFolder = () => App.fs.ready && App.view.source.type === 'folder';

    App.commands.register({ id: 'gallery.left', title: '이전 항목', keys: ['ArrowLeft', 'Shift+ArrowLeft', 'Mod+ArrowLeft'], run: ({ event }) => moveFocus(-1, event) });
    App.commands.register({ id: 'gallery.right', title: '다음 항목', keys: ['ArrowRight', 'Shift+ArrowRight', 'Mod+ArrowRight'], run: ({ event }) => moveFocus(1, event) });
    App.commands.register({ id: 'gallery.up', title: '위 항목', keys: ['ArrowUp', 'Shift+ArrowUp', 'Mod+ArrowUp'], run: ({ event }) => moveFocus(-cols, event) });
    App.commands.register({ id: 'gallery.down', title: '아래 항목', keys: ['ArrowDown', 'Shift+ArrowDown', 'Mod+ArrowDown'], run: ({ event }) => moveFocus(cols, event) });
    App.commands.register({ id: 'gallery.first', title: '처음 항목', keys: ['Home'], run: () => moveFocus(-Infinity) });
    App.commands.register({ id: 'gallery.last', title: '마지막 항목', keys: ['End'], run: () => moveFocus(Infinity) });

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
            const i = App.view.indexOf(paths[0]);
            await App.fs.trash(paths);
            const next = App.view.visible[Math.min(i, App.view.visible.length - 1)];
            if (next) App.select.set([next.path]);
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
    App.commands.register({ id: 'select.clear', title: '선택 해제', group: '선택', keys: ['Escape'], when: hasSelection, run: () => App.select.clear() });
    App.commands.register({ id: 'gallery.zoomIn', title: '썸네일 크게', group: '보기', icon: 'zoom-in', keys: ['Mod+='], run: () => gallery.setZoom(gallery.zoom * 1.15) });
    App.commands.register({ id: 'gallery.zoomOut', title: '썸네일 작게', group: '보기', icon: 'zoom-out', keys: ['Mod+-'], run: () => gallery.setZoom(gallery.zoom / 1.15) });

    App.register('gallery', {
        init() {
            scroller = document.getElementById('gallery-scroll');
            canvas = document.getElementById('gallery');
            emptyEl = document.getElementById('gallery-empty');
            document.documentElement.style.setProperty('--thumb-size', gallery.zoom + 'px');

            scroller.addEventListener('scroll', schedule, { passive: true });
            new ResizeObserver(() => {
                layout();
                schedule();
            }).observe(scroller);

            scroller.addEventListener('click', onClick);
            scroller.addEventListener('dblclick', onDblClick);
            scroller.addEventListener('contextmenu', onContextMenu);
            scroller.addEventListener('dragstart', onDragStart);
            scroller.addEventListener('dragover', onDragOver);
            scroller.addEventListener('dragleave', (e) => {
                if (!scroller.contains(e.relatedTarget)) clearDropTargets();
            });
            scroller.addEventListener('drop', onDrop);
            scroller.addEventListener('dragend', () => {
                dragPaths = null;
                clearDropTargets();
            });
            scroller.addEventListener('wheel', (e) => {
                if (!e.ctrlKey) return;
                e.preventDefault();
                gallery.setZoom(gallery.zoom * (e.deltaY < 0 ? 1.08 : 0.92));
            }, { passive: false });

            App.bus.on('view:changed', ({ reason }) => {
                if (reason === 'entries') scroller.scrollTop = 0;
                layout();
                gallery.refresh();
                const empty = App.fs.ready && App.view.visible.length === 0;
                emptyEl.hidden = !empty;
                if (empty) {
                    const filtered = App.view.filters.size > 0 || App.view.source.type === 'search';
                    emptyEl.querySelector('h2').textContent = filtered ? '조건에 맞는 항목이 없어요' : '이 폴더는 비어 있어요';
                    emptyEl.querySelector('p').textContent = filtered ? '검색어나 필터를 바꿔 보세요.' : '탐색기에서 사진이나 영상을 여기로 끌어 놓으면 이 폴더로 가져와요.';
                }
            });
            App.bus.on('selection:changed', updateSelectionClasses);
            App.bus.on('catalog:changed', ({ paths }) => gallery.invalidate(paths));
            App.bus.on('thumbs:meta', ({ path }) => gallery.invalidate([path]));
            App.bus.on('workspace:closed', () => {
                emptyEl.hidden = true;
            });
        },
    });

    App.gallery = gallery;
})();
