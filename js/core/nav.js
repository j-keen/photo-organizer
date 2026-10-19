/*
 * Current view state:
 *   App.nav    — current folder (App.state.cwd), back/forward/up history, (re)loading.
 *   App.view   — entries of the current source (folder or search) -> filters -> sort -> visible list.
 *   App.select — selection of paths within the visible list (+ anchor/focus for keyboard & shift-click).
 *
 * Events: 'folder:loading' {path}, 'folder:loaded' {path, entries}, 'view:changed' {reason},
 *         'selection:changed' {paths, focus}
 */
(() => {
    'use strict';
    const { path: P, compareNames } = App.util;

    // ---------- View ----------
    const sortKeys = new Map();

    const view = {
        entries: [],
        visible: [],
        index: new Map(),
        source: { type: 'none', path: null, title: '' },
        sort: App.settings.get('view.sort', { key: 'name', dir: 'asc' }),
        filters: new Map(),

        /** registerSortKey('rating', '별점', (entry) => number|string) */
        registerSortKey(key, label, get) {
            sortKeys.set(key, { key, label, get });
        },

        sortKeys() {
            return [...sortKeys.values()];
        },

        setEntries(entries, source) {
            view.entries = entries;
            view.source = source;
            view.recompute('entries');
        },

        setSort(key, dir) {
            view.sort = { key, dir: dir || view.sort.dir };
            App.settings.set('view.sort', view.sort);
            view.recompute('sort');
        },

        /** filter: { label, test(entry) -> bool, includeDirs?: bool } or null to remove */
        setFilter(id, filter) {
            if (filter) view.filters.set(id, filter);
            else view.filters.delete(id);
            view.recompute('filter');
            App.bus.emit('view:filters');
        },

        clearFilters() {
            view.filters.clear();
            view.recompute('filter');
            App.bus.emit('view:filters');
        },

        recompute(reason = 'refresh') {
            let list = view.entries;
            for (const f of view.filters.values()) {
                list = list.filter((e) => (e.kind === 'dir' && !f.includeDirs ? true : f.test(e)));
            }
            const sk = sortKeys.get(view.sort.key) || sortKeys.get('name');
            const dir = view.sort.dir === 'desc' ? -1 : 1;
            list = [...list].sort((a, b) => {
                if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
                let c = 0;
                if (sk.key !== 'name') {
                    const va = sk.get(a);
                    const vb = sk.get(b);
                    c = typeof va === 'string' ? compareNames(va, vb) : (va || 0) - (vb || 0);
                }
                if (c === 0) c = compareNames(a.name, b.name);
                return c * dir;
            });
            view.visible = list;
            view.index = new Map(list.map((e, i) => [e.path, i]));
            App.select.prune();
            App.bus.emit('view:changed', { reason });
        },

        indexOf(p) {
            return view.index.has(p) ? view.index.get(p) : -1;
        },

        get(p) {
            const i = view.indexOf(p);
            return i >= 0 ? view.visible[i] : view.entries.find((e) => e.path === p) || null;
        },

        /** Merge fields into an entry (e.g. size after a write) and re-sort. */
        patch(p, fields) {
            const e = view.entries.find((x) => x.path === p);
            if (!e) return;
            Object.assign(e, fields);
            view.recompute('patch');
        },
    };

    view.registerSortKey('name', '이름', (e) => e.name);
    view.registerSortKey('mtime', '수정한 날짜', (e) => e.mtime || 0);
    view.registerSortKey('size', '크기', (e) => e.size || 0);
    view.registerSortKey('type', '종류', (e) => `${e.type}.${e.ext}`);
    view.registerSortKey('rating', '별점', (e) => App.catalog.peek(e.path)?.rating || 0);

    // ---------- Selection ----------
    const select = {
        paths: new Set(),
        anchor: null,
        focus: null,

        has(p) {
            return select.paths.has(p);
        },

        get count() {
            return select.paths.size;
        },

        /** Selected paths in visible order */
        list() {
            return view.visible.filter((e) => select.paths.has(e.path)).map((e) => e.path);
        },

        entries() {
            return view.visible.filter((e) => select.paths.has(e.path));
        },

        /** The single "active" item shown in the inspector (focus, else the only selected item) */
        primary() {
            if (select.focus && select.paths.has(select.focus)) return view.get(select.focus);
            if (select.paths.size === 1) return view.get([...select.paths][0]);
            return null;
        },

        set(paths, { focus, anchor } = {}) {
            select.paths = new Set(paths);
            select.focus = focus !== undefined ? focus : paths[paths.length - 1] || null;
            select.anchor = anchor !== undefined ? anchor : select.focus;
            select.emit();
        },

        toggle(p) {
            if (select.paths.has(p)) select.paths.delete(p);
            else select.paths.add(p);
            select.focus = p;
            select.anchor = p;
            select.emit();
        },

        /** Select from anchor to p in visible order. additive keeps the existing selection (Ctrl+Shift). */
        range(p, { additive = false } = {}) {
            const a = view.indexOf(select.anchor);
            const b = view.indexOf(p);
            if (a < 0 || b < 0) return select.set([p]);
            const [from, to] = a < b ? [a, b] : [b, a];
            const next = additive ? new Set(select.paths) : new Set();
            for (let i = from; i <= to; i++) next.add(view.visible[i].path);
            select.paths = next;
            select.focus = p;
            select.emit();
        },

        all() {
            select.set(view.visible.map((e) => e.path), { focus: select.focus, anchor: select.anchor });
        },

        clear() {
            if (!select.paths.size && !select.focus) return;
            select.paths = new Set();
            select.focus = null;
            select.anchor = null;
            select.emit();
        },

        // Drop selected paths that are no longer visible (after filter/reload)
        prune() {
            let changed = false;
            for (const p of [...select.paths]) {
                if (!view.index.has(p)) {
                    select.paths.delete(p);
                    changed = true;
                }
            }
            if (select.focus && !view.index.has(select.focus)) {
                select.focus = null;
                changed = true;
            }
            if (changed) select.emit();
        },

        emit() {
            App.bus.emit('selection:changed', { paths: [...select.paths], focus: select.focus });
        },
    };

    // ---------- Navigation ----------
    let loadToken = 0;

    const nav = {
        back: [],
        fwd: [],

        get cwd() {
            return App.state.cwd;
        },

        canBack: () => nav.back.length > 0,
        canForward: () => nav.fwd.length > 0,
        canUp: () => App.state.cwd != null && App.state.cwd !== '',

        async go(p, { push = true, focus = null } = {}) {
            if (!App.fs.ready) return;
            if (p === App.state.cwd && view.source.type === 'folder') return nav.load({ focus });
            if (push && App.state.cwd != null && view.source.type === 'folder') {
                nav.back.push(App.state.cwd);
                if (nav.back.length > 200) nav.back.shift();
                nav.fwd = [];
            }
            App.setState({ cwd: p });
            select.clear();
            await nav.load({ focus });
            App.bus.emit('nav:changed');
        },

        async load({ focus = null, keepSelection = false } = {}) {
            const token = ++loadToken;
            const p = App.state.cwd;
            App.bus.emit('folder:loading', { path: p });
            let entries;
            try {
                entries = await App.fs.list(p);
            } catch (e) {
                if (token !== loadToken) return;
                if (e.code === 'ENOENT' && p !== '') {
                    App.ui.toast('폴더를 찾을 수 없어서 상위 폴더로 이동했어요', { type: 'warning' });
                    return nav.go(P.parent(p), { push: false });
                }
                console.error('[nav] list failed', e);
                App.ui.toast(`폴더를 읽을 수 없어요: ${e.message}`, { type: 'error' });
                return;
            }
            if (token !== loadToken) return; // superseded by a newer navigation
            const prevSelection = keepSelection ? select.list() : [];
            const title = p === '' ? App.state.workspace?.name || '' : P.base(p);
            view.setEntries(entries, { type: 'folder', path: p, title, hiddenCount: entries.hiddenCount });
            if (keepSelection && prevSelection.length) select.set(prevSelection.filter((x) => view.index.has(x)), { focus: select.focus });
            if (focus && view.index.has(focus)) select.set([focus], { focus });
            App.bus.emit('folder:loaded', { path: p, entries });
            if (entries.sidecars?.length) App.catalog.importLegacySidecars(entries.sidecars);
        },

        reload() {
            if (view.source.type === 'folder') return nav.load({ keepSelection: true });
            App.bus.emit('view:reload-request');
        },

        goBack() {
            if (!nav.back.length) return;
            nav.fwd.push(App.state.cwd);
            return nav.go(nav.back.pop(), { push: false });
        },

        goForward() {
            if (!nav.fwd.length) return;
            nav.back.push(App.state.cwd);
            return nav.go(nav.fwd.pop(), { push: false });
        },

        goUp() {
            if (!nav.canUp()) return;
            const child = App.state.cwd;
            return nav.go(P.parent(child), { focus: child });
        },

        goHome() {
            return nav.go('');
        },

        /** Open an entry: folders navigate, files go to the viewer */
        open(entry) {
            if (!entry) return;
            if (entry.kind === 'dir') return nav.go(entry.path);
            App.bus.emit('item:open', { path: entry.path });
        },
    };

    // Keep cwd/history/selection valid when things move underneath us.
    const reloadSoon = App.util.debounce(() => nav.load({ keepSelection: true }), 120);

    App.bus.on('fs:changed', (change) => {
        const cwd = App.state.cwd;
        if (cwd == null) return;

        if (change.from && change.to) {
            for (let i = 0; i < change.from.length; i++) {
                const rebased = P.rebase(cwd, change.from[i], change.to[i]);
                if (rebased != null && rebased !== cwd) {
                    nav.back = nav.back.map((h) => P.rebase(h, change.from[i], change.to[i]) ?? h);
                    nav.fwd = nav.fwd.map((h) => P.rebase(h, change.from[i], change.to[i]) ?? h);
                    App.setState({ cwd: rebased });
                    nav.load({ keepSelection: true });
                    App.bus.emit('nav:changed');
                    return;
                }
            }
            // Keep renamed/moved items selected under their new path
            if (view.source.type === 'folder') {
                const moved = change.from.map((f, i) => [f, change.to[i]]).filter(([f]) => select.has(f));
                if (moved.length) {
                    const next = select.list().map((p) => moved.find(([f]) => f === p)?.[1] ?? p);
                    select.paths = new Set(next);
                    if (select.focus) select.focus = moved.find(([f]) => f === select.focus)?.[1] ?? select.focus;
                }
            }
        }

        if ((change.type === 'trash' || change.type === 'delete') && change.paths.some((p) => P.isInside(cwd, p) && p !== '')) {
            let up = cwd;
            while (up && change.paths.some((p) => P.isInside(up, p))) up = P.parent(up);
            nav.go(up, { push: false });
            return;
        }

        if (view.source.type === 'folder' && change.dirs.includes(cwd)) reloadSoon();
    });

    // Commands
    App.commands.register({ id: 'nav.back', title: '뒤로', group: '이동', icon: 'arrow-left', keys: ['Alt+ArrowLeft'], allowInInput: true, when: nav.canBack, run: () => nav.goBack() });
    App.commands.register({ id: 'nav.forward', title: '앞으로', group: '이동', icon: 'arrow-right', keys: ['Alt+ArrowRight'], allowInInput: true, when: nav.canForward, run: () => nav.goForward() });
    App.commands.register({ id: 'nav.up', title: '상위 폴더로', group: '이동', icon: 'corner-up', keys: ['Alt+ArrowUp', 'Backspace'], allowInInput: ['Alt+ArrowUp'], when: nav.canUp, run: () => nav.goUp() });
    App.commands.register({ id: 'nav.home', title: '작업 폴더 처음으로', group: '이동', icon: 'home', keys: ['Alt+Home'], when: () => App.fs.ready, run: () => nav.goHome() });
    App.commands.register({ id: 'nav.reload', title: '새로 고침', group: '이동', icon: 'refresh', keys: ['F5'], when: () => App.fs.ready, run: () => nav.reload() });

    // Mouse side buttons
    window.addEventListener('mouseup', (e) => {
        if (App.layers.top() !== 'main') return;
        if (e.button === 3) {
            e.preventDefault();
            App.commands.run('nav.back');
        } else if (e.button === 4) {
            e.preventDefault();
            App.commands.run('nav.forward');
        }
    });

    App.nav = nav;
    App.view = view;
    App.select = select;
})();
