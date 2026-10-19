/*
 * Top bar (brand, panel toggles, back/forward/up, breadcrumb, search, app menu)
 * and the view bar above the gallery (title + counts, type filter, sort, zoom).
 */
(() => {
    'use strict';
    const { h, path: P, formatCount } = App.util;
    const ui = App.ui;

    let backBtn;
    let fwdBtn;
    let upBtn;
    let crumbs;
    let searchInput;
    let viewbar;
    const viewbarItems = []; // () => Element|null, rendered left of the type filter on every view change

    function iconBtn(iconName, tip, command, extraClass = '') {
        const btn = h('button', { class: `btn ghost icon ${extraClass}`, 'data-tip': tip, html: ui.icon(iconName), 'aria-label': tip });
        if (command) {
            const keys = App.commands.get(command)?.keys?.[0];
            if (keys) btn.dataset.tipKeys = keys;
            btn.addEventListener('click', () => App.commands.run(command));
        }
        return btn;
    }

    // ---------- Breadcrumb ----------
    function renderCrumbs() {
        crumbs.innerHTML = '';
        const ws = App.state.workspace;
        if (!ws) return;
        const source = App.view.source;
        const segs = P.segments(App.state.cwd || '');
        const root = h('button', { class: 'crumb root', dataset: { path: '' }, html: `${ui.icon('home', { size: 14 })}<span>${App.util.escapeHtml(ws.name)}</span>` });
        crumbs.append(root);
        segs.forEach((seg, i) => {
            crumbs.append(h('span', { class: 'crumb-sep', html: ui.icon('chevron-right', { size: 12 }) }));
            crumbs.append(h('button', { class: 'crumb', dataset: { path: segs.slice(0, i + 1).join('/') }, text: seg }));
        });
        if (source.type === 'search') {
            crumbs.append(h('span', { class: 'crumb-sep', html: ui.icon('chevron-right', { size: 12 }) }));
            crumbs.append(h('span', { class: 'crumb current', text: source.title }));
        } else {
            crumbs.lastChild.classList.add('current');
        }
        crumbs.scrollLeft = crumbs.scrollWidth;
    }

    function updateNavButtons() {
        backBtn.disabled = !App.nav.canBack();
        fwdBtn.disabled = !App.nav.canForward();
        upBtn.disabled = !App.nav.canUp();
    }

    // ---------- Search ----------
    let searchToken = 0;
    const runSearch = App.util.debounce(async () => {
        const q = searchInput.value.trim();
        const token = ++searchToken;
        if (!q) {
            if (App.view.source.type === 'search') App.nav.load();
            return;
        }
        if (!App.index.ready) {
            App.view.setEntries([], { type: 'search', path: null, title: `"${q}" 검색 중…`, query: q });
            await App.index.whenReady();
            if (token !== searchToken) return;
        }
        const results = App.index.search(q);
        App.view.setEntries(results, { type: 'search', path: null, title: `"${q}" 검색 결과`, query: q });
    }, 180);

    function clearSearch() {
        if (!searchInput.value) return false;
        searchInput.value = '';
        runSearch.flush();
        return true;
    }

    // ---------- View bar ----------
    const TYPE_FILTERS = [
        { id: 'all', label: '전체' },
        { id: 'image', label: '사진', icon: 'image' },
        { id: 'video', label: '영상', icon: 'video' },
    ];

    function currentTypeFilter() {
        return App.view.filters.get('type')?.id || 'all';
    }

    function setTypeFilter(id) {
        if (id === 'all') App.view.setFilter('type', null);
        else App.view.setFilter('type', { id, label: id === 'image' ? '사진만' : '영상만', test: (e) => e.type === id });
        App.settings.set('view.type', id);
    }

    function renderViewbar() {
        viewbar.innerHTML = '';
        if (!App.fs.ready) return;
        const source = App.view.source;
        const all = App.view.entries;
        const counts = { dir: 0, image: 0, video: 0 };
        for (const e of all) counts[e.type] = (counts[e.type] || 0) + 1;
        const title = source.type === 'search' ? source.title : source.title || App.state.workspace?.name || '';
        const countParts = [];
        if (counts.dir) countParts.push(`폴더 ${formatCount(counts.dir)}`);
        countParts.push(`사진 ${formatCount(counts.image)}`);
        countParts.push(`영상 ${formatCount(counts.video)}`);

        const seg = h('div', { class: 'seg', role: 'tablist' });
        const active = currentTypeFilter();
        for (const f of TYPE_FILTERS) {
            seg.append(h('button', { class: active === f.id ? 'on' : '', html: (f.icon ? ui.icon(f.icon, { size: 13 }) : '') + f.label, onclick: () => setTypeFilter(f.id) }));
        }

        const sortKey = App.view.sortKeys().find((k) => k.key === App.view.sort.key);
        const sortBtn = h('button', {
            class: 'btn ghost sm',
            'data-tip': '정렬',
            html: `${ui.icon('sort', { size: 14 })}<span>${sortKey?.label || '이름'}</span>${ui.icon(App.view.sort.dir === 'asc' ? 'arrow-up' : 'arrow-up', { size: 12, class: App.view.sort.dir === 'desc' ? 'flip' : '' })}`,
            onclick: (e) => {
                ui.menu([
                    { header: '정렬 기준' },
                    ...App.view.sortKeys().map((k) => ({ label: k.label, checked: App.view.sort.key === k.key, action: () => App.view.setSort(k.key) })),
                    '-',
                    { label: '오름차순', checked: App.view.sort.dir === 'asc', action: () => App.view.setSort(App.view.sort.key, 'asc') },
                    { label: '내림차순', checked: App.view.sort.dir === 'desc', action: () => App.view.setSort(App.view.sort.key, 'desc') },
                ], { anchor: e.currentTarget, align: 'end' });
            },
        });

        const zoom = h('input', { type: 'range', class: 'zoom-slider', min: '96', max: '480', step: '4', value: String(App.gallery.zoom), 'data-tip': '썸네일 크기 (Ctrl+휠)' });
        zoom.addEventListener('input', () => App.gallery.setZoom(Number(zoom.value)));

        const extras = [];
        for (const fn of viewbarItems) {
            try {
                const el = fn();
                if (el) extras.push(el);
            } catch (e) {
                console.error('[topbar] viewbar item failed', e);
            }
        }
        viewbar.append(
            h('div', { class: 'vb-title' }, h('span', { class: 'vb-name truncate', text: title }), h('span', { class: 'vb-count', text: countParts.join(' · ') })),
            h('div', { class: 'vb-filters', id: 'vb-filters' }),
            h('div', { class: 'grow' }),
            ...extras,
            seg,
            sortBtn,
            h('span', { class: 'vb-zoom', html: ui.icon('image', { size: 12 }) }, zoom),
        );
        renderFilterChips();
    }

    // Active non-type filters as removable chips (other modules add filters via App.view.setFilter)
    function renderFilterChips() {
        const host = document.getElementById('vb-filters');
        if (!host) return;
        host.innerHTML = '';
        for (const [id, f] of App.view.filters) {
            if (id === 'type') continue;
            host.append(h('button', { class: 'filter-chip', html: `${App.util.escapeHtml(f.label || id)}${ui.icon('x', { size: 12 })}`, onclick: () => App.view.setFilter(id, null) }));
        }
    }

    function appMenu(anchor) {
        const theme = document.documentElement.dataset.theme;
        ui.menu([
            { label: '작업 폴더 열기…', icon: 'folder-open', command: 'workspace.open' },
            { label: '작업 폴더 닫기', icon: 'x', command: 'workspace.close', disabled: !App.fs.ready },
            '-',
            { label: theme === 'light' ? '어두운 테마' : '밝은 테마', icon: theme === 'light' ? 'moon' : 'sun', command: 'view.toggleTheme' },
            { label: '사이드바', icon: 'sidebar', command: 'view.toggleSidebar', checked: !document.querySelector('.app').classList.contains('no-sidebar') },
            { label: '정보 패널', icon: 'panel-right', command: 'view.toggleInspector', checked: !document.querySelector('.app').classList.contains('no-inspector') },
            '-',
            { label: '실행 취소', icon: 'undo', command: 'edit.undo', disabled: !App.undo.canUndo() },
            { label: '다시 실행', icon: 'redo', command: 'edit.redo', disabled: !App.undo.canRedo() },
        ], { anchor, align: 'end' });
    }

    App.commands.register({ id: 'search.focus', title: '검색', group: '보기', icon: 'search', keys: ['Mod+F'], scope: 'global', when: () => App.fs.ready, run: () => searchInput.focus() });
    App.commands.register({ id: 'edit.undo', title: '실행 취소', group: '편집', icon: 'undo', keys: ['Mod+Z'], when: () => App.undo.canUndo(), run: () => App.undo.undo() });
    App.commands.register({ id: 'edit.redo', title: '다시 실행', group: '편집', icon: 'redo', keys: ['Mod+Shift+Z', 'Mod+Y'], when: () => App.undo.canRedo(), run: () => App.undo.redo() });
    App.commands.register({
        id: 'view.toggleTheme',
        title: '테마 바꾸기',
        group: '보기',
        icon: 'sun',
        scope: 'global',
        run: () => {
            const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
            document.documentElement.dataset.theme = next;
            App.settings.set('theme', next);
        },
    });
    App.commands.register({ id: 'view.filterAll', title: '전체 보기', group: '보기', keys: ['Alt+1'], allowInInput: true, when: () => App.fs.ready, run: () => setTypeFilter('all') });
    App.commands.register({ id: 'view.filterImages', title: '사진만 보기', group: '보기', icon: 'image', keys: ['Alt+2'], allowInInput: true, when: () => App.fs.ready, run: () => setTypeFilter('image') });
    App.commands.register({ id: 'view.filterVideos', title: '영상만 보기', group: '보기', icon: 'video', keys: ['Alt+3'], allowInInput: true, when: () => App.fs.ready, run: () => setTypeFilter('video') });

    App.register('topbar', {
        init() {
            const bar = document.getElementById('topbar');
            viewbar = document.getElementById('viewbar');
            backBtn = iconBtn('arrow-left', '뒤로', 'nav.back');
            fwdBtn = iconBtn('arrow-right', '앞으로', 'nav.forward');
            upBtn = iconBtn('corner-up', '상위 폴더', 'nav.up');
            crumbs = h('nav', { class: 'crumbs', 'aria-label': '경로' });
            crumbs.addEventListener('click', (e) => {
                const btn = e.target.closest('.crumb[data-path]');
                if (!btn) return;
                clearSearch();
                App.nav.go(btn.dataset.path);
            });

            searchInput = h('input', { class: 'input', id: 'search-input', type: 'search', placeholder: '파일 이름·메모 검색', spellcheck: 'false', autocomplete: 'off' });
            searchInput.addEventListener('input', runSearch);
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    if (!clearSearch()) searchInput.blur();
                } else if (e.key === 'Enter') {
                    runSearch.flush();
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    searchInput.blur();
                    document.getElementById('gallery-scroll').focus();
                }
            });

            const left = h('div', { class: 'topbar-group' },
                h('div', { class: 'topbar-brand' }, h('span', { class: 'brand-mark', html: ui.icon('aperture', { size: 14 }) }), h('span', { class: 'brand-name', text: 'Fluid Identity' })),
                iconBtn('sidebar', '사이드바 열고 닫기', 'view.toggleSidebar'),
                h('span', { class: 'topbar-sep' }),
                backBtn, fwdBtn, upBtn);

            const center = h('div', { id: 'topbar-center' }, crumbs);
            const search = h('div', { class: 'search-box topbar-search' }, h('span', { html: ui.icon('search', { size: 14 }) }), searchInput);
            const menuBtn = iconBtn('more', '메뉴');
            menuBtn.addEventListener('click', () => appMenu(menuBtn));
            const right = h('div', { id: 'topbar-right' }, search, iconBtn('panel-right', '정보 패널 열고 닫기', 'view.toggleInspector'), menuBtn);

            bar.append(left, center, right);

            App.bus.on('nav:changed', () => {
                renderCrumbs();
                updateNavButtons();
            });
            App.bus.on('view:changed', () => {
                renderCrumbs();
                updateNavButtons();
                renderViewbar();
            });
            App.bus.on('view:filters', renderFilterChips);
            App.bus.on('gallery:zoom', ({ size }) => {
                const z = viewbar.querySelector('.zoom-slider');
                if (z && Number(z.value) !== size) z.value = String(size);
            });
            App.bus.on('workspace:opened', () => {
                searchInput.value = '';
                const t = App.settings.get('view.type', 'all');
                if (t !== 'all') setTypeFilter(t);
            });
            App.bus.on('workspace:closed', () => {
                crumbs.innerHTML = '';
                viewbar.innerHTML = '';
                updateNavButtons();
            });
            updateNavButtons();
        },
    });

    App.topbar = {
        clearSearch,
        setTypeFilter,
        /** addViewbarItem(() => Element|null) — re-invoked whenever the view bar re-renders */
        addViewbarItem(fn) {
            viewbarItems.push(fn);
            if (App.fs.ready) renderViewbar();
        },
        renderViewbar: () => renderViewbar(),
    };
})();
