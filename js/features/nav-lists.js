/* Ordered, named snapshots of visible files, stored beside the workspace catalog. */
(() => {
    'use strict';
    const { h, uid, formatCount } = App.util;
    const ui = App.ui;
    const SORT = 'saved-list-order';
    let items = [];
    let session = 0;
    let loaded = false;
    let ready = Promise.resolve();
    let writes = Promise.resolve();
    let order = new Map();
    let previousSort = null;
    let opening = false;
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const writable = () => App.fs.ready && loaded && (!App.lock || App.lock.canWrite());
    const currentId = () => App.view.source.type === 'smart' && App.view.source.smart?.startsWith('list:') ? App.view.source.smart.slice(5) : null;
    const find = (id) => items.find((item) => item.id === id);

    function normalize(data) {
        const seen = new Set();
        return (Array.isArray(data?.items) ? data.items : []).filter((item) => {
            if (!item || typeof item.id !== 'string' || !item.id || seen.has(item.id) || typeof item.name !== 'string' || !item.name.trim() || !Array.isArray(item.paths)) return false;
            seen.add(item.id);
            return true;
        }).map((item) => ({ id: item.id, name: item.name.trim(), paths: [...new Set(item.paths.filter((path) => typeof path === 'string' && path && !App.fs.isDataPath(path)))], createdAt: item.createdAt || Date.now() }));
    }

    function changed() {
        App.sidebar.refreshSection('lists');
        App.topbar.renderViewbar();
        App.bus.emit('lists:changed', { items: clone(items) });
        // Providers read live data; also invalidate any open palette's result cache.
        App.bus.emit('commands:changed');
    }

    async function apply(snapshot, token) {
        if (token !== session || !writable()) throw new Error('현재 작업 폴더에 목록을 저장할 수 없어요');
        await App.wsdata.write('lists', { version: 1, items: snapshot });
        if (token !== session) return;
        items = clone(snapshot);
        const active = find(currentId());
        if (active) {
            App.view.source.title = active.name;
            App.view.recompute('refresh');
        }
        changed();
    }

    function enqueue(task) {
        const pending = writes.then(task);
        writes = pending.catch(() => {});
        return pending;
    }

    function mutate(change, label, token = session) {
        return enqueue(async () => {
            await ready;
            if (token !== session || !writable()) return false;
            const before = clone(items);
            const after = change(clone(items));
            if (!after || JSON.stringify(before) === JSON.stringify(after)) return false;
            await apply(after, token);
            App.undo.push({ label,
                undo: () => enqueue(() => apply(before, token)),
                redo: () => enqueue(() => apply(after, token)),
            });
            return true;
        });
    }

    async function save() {
        const token = session;
        await ready;
        if (!writable() || token !== session) return;
        const paths = App.view.visible.filter((entry) => entry.kind === 'file').map((entry) => entry.path);
        if (!paths.length) return ui.toast('지금 보이는 파일이 없어요', { type: 'info' });
        const name = await ui.prompt({ title: '지금 목록 저장', value: App.view.source.title || '새 목록', validate: (value) => value.trim() ? null : '목록 이름을 입력해 주세요' });
        if (name == null || !name.trim() || token !== session) return;
        const item = { id: uid('list'), name: name.trim(), paths, createdAt: Date.now() };
        if (await mutate((list) => [...list, item], `목록 ‘${item.name}’ 저장`, token)) {
            ui.toast(`‘${item.name}’에 파일 ${formatCount(paths.length)}개를 저장했어요`, { type: 'success' });
            return clone(item);
        }
    }

    async function open(id) {
        const token = session;
        await ready;
        await App.index.whenReady();
        if (token !== session) return;
        const item = find(id);
        if (!item) return;
        const entries = item.paths.map((path) => App.index.get(path)).filter((entry) => entry?.kind === 'file');
        const missing = item.paths.length - entries.length;
        if (!currentId()) previousSort = { ...App.view.sort };
        order = new Map(item.paths.map((path, index) => [path, index]));
        opening = true;
        try {
            App.topbar.clearSearch({ reload: false });
            App.view.clearFilters();
            App.view.setSort(SORT, 'asc');
            App.view.setEntries(entries, { type: 'smart', smart: 'list:' + item.id, title: item.name });
        } finally {
            opening = false;
        }
        if (missing) ui.toast(`찾을 수 없는 파일 ${formatCount(missing)}개를 건너뛰었어요`, { type: 'warning' });
        return entries;
    }

    async function rename(id) {
        const token = session;
        await ready;
        const item = find(id);
        if (!item || !writable()) return;
        const name = await ui.prompt({ title: '목록 이름 바꾸기', value: item.name, validate: (value) => value.trim() ? null : '목록 이름을 입력해 주세요' });
        if (name == null || !name.trim() || token !== session) return;
        return mutate((list) => list.map((entry) => entry.id === id ? { ...entry, name: name.trim() } : entry), '목록 이름 바꾸기', token);
    }

    async function remove(id) {
        const token = session;
        await ready;
        const item = find(id);
        if (!item || !writable()) return;
        const ok = await ui.confirm({ title: '저장한 목록을 지울까요?', message: `‘${item.name}’ 목록을 지워요. 사진과 영상 파일은 그대로 있어요.`, okLabel: '목록 지우기', danger: true });
        if (!ok || token !== session) return;
        return mutate((list) => list.filter((entry) => entry.id !== id), `목록 ‘${item.name}’ 지우기`, token);
    }

    function menuItems(item) {
        return [
            { label: '열기', icon: 'list', command: 'nav.listOpen', args: { id: item.id } },
            { label: '이름 바꾸기', icon: 'edit', command: 'nav.listRename', args: { id: item.id }, disabled: !writable() },
            { label: '목록 지우기', icon: 'trash', command: 'nav.listDelete', args: { id: item.id }, danger: true, disabled: !writable() },
        ];
    }

    function menu(anchor) {
        ui.menu([
            { label: '지금 목록 저장', icon: 'plus', command: 'nav.listSave', disabled: !writable() },
            '-',
            ...(items.length ? items.map((item) => ({ label: item.name, icon: 'list', checked: currentId() === item.id, hint: `${formatCount(item.paths.length)}개`, submenu: menuItems(item) }))
                : [{ label: '아직 저장한 목록이 없어요', disabled: true }]),
        ], { anchor, align: 'end' });
    }

    function render(body) {
        body.classList.add('lists-body');
        if (!items.length) body.append(h('p', { class: 'lists-empty', text: '지금 보는 목록을 저장해 보세요.' }));
        for (const item of items) {
            const active = currentId() === item.id;
            body.append(h('div', { class: 'lists-row', dataset: { id: item.id } },
                h('button', { type: 'button', class: `btn ghost sm lists-open${active ? ' active' : ''}`, 'aria-current': active ? 'page' : null,
                    'aria-label': `목록: ${item.name}`, 'data-tip': `파일 ${formatCount(item.paths.length)}개 · ${item.name}`,
                    onclick: () => App.commands.run('nav.listOpen', { id: item.id }) },
                h('span', { html: ui.icon('list') }), h('span', { class: 'truncate', text: item.name })),
                h('button', { type: 'button', class: 'btn ghost icon sm', 'aria-label': `${item.name} 목록 메뉴`, html: ui.icon('more'),
                    onclick: (event) => App.commands.run('nav.listMenu', { id: item.id, anchor: event.currentTarget }) })));
        }
    }

    const command = (id, title, run, when = () => App.fs.ready && loaded) => App.commands.register({ id, title, group: '저장 목록', icon: 'list', when, run });
    command('nav.listSave', '지금 목록 저장', save, writable);
    command('nav.listOpen', '저장한 목록 열기', (args) => args?.id ? open(args.id) : menu(document.querySelector('.lists-menu-button')));
    command('nav.listRename', '목록 이름 바꾸기', (args) => rename(args?.id || currentId()), writable);
    command('nav.listDelete', '저장한 목록 지우기', (args) => remove(args?.id || currentId()), writable);
    command('nav.listMenu', '저장 목록 메뉴', (args) => {
        const item = find(args?.id);
        if (item) return ui.menu(menuItems(item), { anchor: args.anchor, align: 'end' });
        menu(args?.anchor || document.querySelector('.lists-menu-button'));
    });

    function paletteItem(item) {
        return { key: `list:${App.state.workspace?.id}:${item.id}`, title: `목록: ${item.name}`,
            subtitle: `파일 ${formatCount(item.paths.length)}개`, icon: 'list',
            run: () => App.commands.run('nav.listOpen', { id: item.id }) };
    }

    App.register('nav-lists', {
        init() {
            App.view.registerSortKey(SORT, '저장한 순서', (entry) => order.get(entry.path) ?? Number.MAX_SAFE_INTEGER);
            App.sidebar.addSection({ id: 'lists', title: '저장한 목록', order: 15, render,
                actions: () => [h('button', { type: 'button', class: 'btn ghost icon sm', 'aria-label': '지금 목록 저장', html: ui.icon('plus'),
                    onclick: () => App.commands.run('nav.listSave') })] });
            App.topbar.addViewbarItem(() => h('button', { type: 'button', class: 'btn ghost sm lists-menu-button', text: '목록', 'aria-label': '저장 목록 메뉴',
                onclick: (event) => App.commands.run('nav.listMenu', { anchor: event.currentTarget }) }));
            App.palette.addProvider({ id: 'lists', label: '저장 목록', icon: 'list', order: 25, alsoIn: ['commands'],
                items: () => loaded ? items.map(paletteItem) : [], empty: () => loaded ? items.map(paletteItem) : [],
                resolve: (key) => {
                    const item = items.find((entry) => key === `list:${App.state.workspace?.id}:${entry.id}`);
                    return item ? paletteItem(item) : null;
                } });
            App.workspace.flushHooks.push(() => writes);
            App.bus.on('workspace:opened', () => {
                const token = ++session;
                loaded = false;
                items = [];
                ready = App.wsdata.read('lists', { version: 1, items: [] }).then((data) => {
                    if (token !== session) return;
                    items = normalize(data);
                    loaded = true;
                    changed();
                });
            });
            App.bus.on('workspace:closed', () => { session++; loaded = false; items = []; previousSort = null; order.clear(); changed(); });
            App.bus.on('view:changed', () => {
                if (opening) return;
                if (!currentId() && App.view.sort.key === SORT) {
                    const restore = previousSort || { key: 'name', dir: 'asc' };
                    previousSort = null;
                    App.view.setSort(restore.key === SORT ? 'name' : restore.key, restore.dir);
                }
                if (!currentId()) previousSort = null;
                App.sidebar.refreshSection('lists');
            });
        },
    });

    App.navLists = { save, open, rename, remove, list: () => clone(items), whenReady: () => ready, get ready() { return loaded; } };
})();
