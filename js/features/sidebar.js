/*
 * Sidebar: workspace switcher + lazily loaded folder tree.
 *   App.tree.reveal(path)  — expand ancestors and scroll the node into view
 *   App.tree.refresh(dir)  — reload one folder's children
 *   App.sidebar.addSection({ id, title, render(bodyEl), order }) — other modules add sections (favorites, chips...)
 */
(() => {
    'use strict';
    const { h, path: P, compareNames } = App.util;
    const ui = App.ui;

    let treeEl;
    let sectionsEl;
    const children = new Map(); // dir path -> [child dir paths] (loaded)
    let expanded = new Set(['']);
    const sections = [];

    function expandedKey() {
        return `tree.expanded.${App.state.workspace?.id || 'none'}`;
    }

    function saveExpanded() {
        App.settings.set(expandedKey(), [...expanded]);
    }

    async function loadChildren(dir) {
        try {
            const raws = await App.fs.backend.list(dir, { stat: false });
            const dirs = raws.filter((r) => r.kind === 'dir' && !App.fs.isHiddenName(r.name)).map((r) => P.join(dir, r.name));
            dirs.sort((a, b) => compareNames(P.base(a), P.base(b)));
            children.set(dir, dirs);
        } catch (e) {
            children.set(dir, []);
        }
    }

    function nodeRow(p, depth) {
        const isRoot = p === '';
        const kids = children.get(p);
        const open = expanded.has(p);
        const current = App.state.cwd === p && App.view.source.type === 'folder';
        const row = h('div', {
            class: `tree-row${current ? ' current' : ''}`,
            dataset: { path: p },
            style: { paddingLeft: 8 + depth * 14 + 'px' },
            role: 'treeitem',
            'aria-expanded': String(open),
        },
            h('span', { class: `tree-twisty${kids && !kids.length ? ' empty' : ''}${open ? ' open' : ''}`, html: ui.icon('chevron-right', { size: 12 }) }),
            h('span', { class: 'tree-icon', html: ui.icon(isRoot ? 'home' : open ? 'folder-open' : 'folder', { size: 15 }) }),
            h('span', { class: 'tree-name truncate', text: isRoot ? App.state.workspace?.name || '' : P.base(p) }));
        return row;
    }

    function renderNode(p, depth, frag) {
        frag.append(nodeRow(p, depth));
        if (!expanded.has(p)) return;
        for (const c of children.get(p) || []) renderNode(c, depth + 1, frag);
    }

    function render() {
        if (!treeEl) return;
        const scroll = treeEl.scrollTop;
        treeEl.innerHTML = '';
        if (!App.fs.ready) return;
        const frag = document.createDocumentFragment();
        renderNode('', 0, frag);
        treeEl.append(frag);
        treeEl.scrollTop = scroll;
    }

    async function toggle(p, force) {
        const open = force ?? !expanded.has(p);
        if (open) {
            if (!children.has(p)) await loadChildren(p);
            expanded.add(p);
            // Pre-load grandchildren so twisties know whether they're empty
            await Promise.all((children.get(p) || []).filter((c) => !children.has(c)).slice(0, 60).map(loadChildren));
        } else {
            expanded.delete(p);
        }
        saveExpanded();
        render();
    }

    const tree = {
        async reveal(p) {
            const segs = P.segments(p);
            for (let i = 0; i < segs.length; i++) {
                const anc = segs.slice(0, i).join('/');
                if (!children.has(anc)) await loadChildren(anc);
                expanded.add(anc);
            }
            render();
            const row = treeEl.querySelector(`.tree-row[data-path="${CSS.escape(p)}"]`);
            row?.scrollIntoView({ block: 'nearest' });
        },

        async refresh(dir) {
            if (!children.has(dir)) return;
            await loadChildren(dir);
            render();
        },

        children,
    };

    const sidebar = {
        addSection(section) {
            sections.push(section);
            sections.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
            renderSections();
        },
    };

    function renderSections() {
        if (!sectionsEl) return;
        sectionsEl.innerHTML = '';
        for (const s of sections) {
            const body = h('div', { class: 'panel-section-body' });
            const el = h('div', { class: 'panel-section', dataset: { section: s.id } }, h('div', { class: 'panel-section-head' }, h('span', { class: 'grow', text: s.title })), body);
            sectionsEl.append(el);
            try {
                s.render(body, el);
            } catch (e) {
                console.error('[sidebar] section failed', s.id, e);
            }
        }
    }

    async function workspaceMenu(anchor) {
        const recents = await App.workspace.getRecents();
        ui.menu([
            { header: '최근 작업 폴더' },
            ...recents.slice(0, 6).map((r) => ({ label: r.name, icon: 'folder', action: () => App.workspace.openHandle(r.handle) })),
            '-',
            { label: '다른 폴더 열기…', icon: 'folder-open', command: 'workspace.open' },
            { label: '작업 폴더 닫기', icon: 'x', command: 'workspace.close' },
        ], { anchor });
    }

    App.register('sidebar', {
        init() {
            const host = document.getElementById('sidebar');
            const wsBtn = h('button', { class: 'ws-switch', 'data-tip': '작업 폴더 바꾸기' });
            wsBtn.addEventListener('click', () => workspaceMenu(wsBtn));
            treeEl = h('div', { class: 'tree', role: 'tree' });
            sectionsEl = h('div', { class: 'sidebar-sections' });
            host.append(
                h('div', { class: 'sidebar-head' }, wsBtn),
                h('div', { class: 'sidebar-scroll' },
                    sectionsEl,
                    h('div', { class: 'panel-section tree-section' }, h('div', { class: 'panel-section-head' }, h('span', { class: 'grow', text: '폴더' })), treeEl)));

            treeEl.addEventListener('click', (e) => {
                const row = e.target.closest('.tree-row');
                if (!row) return;
                const p = row.dataset.path;
                if (e.target.closest('.tree-twisty')) {
                    toggle(p);
                    return;
                }
                App.topbar?.clearSearch();
                App.nav.go(p);
            });
            treeEl.addEventListener('dblclick', (e) => {
                const row = e.target.closest('.tree-row');
                if (row && !e.target.closest('.tree-twisty')) toggle(row.dataset.path);
            });

            App.bus.on('workspace:opened', async ({ name }) => {
                wsBtn.innerHTML = `<span class="ws-icon">${ui.icon('folder', { size: 15 })}</span><span class="grow truncate">${App.util.escapeHtml(name)}</span>${ui.icon('chevron-down', { size: 14 })}`;
                children.clear();
                expanded = new Set(App.settings.get(expandedKey(), ['']));
                expanded.add('');
                await Promise.all([...expanded].map(loadChildren));
                render();
                renderSections();
            });
            App.bus.on('workspace:closed', () => {
                wsBtn.innerHTML = '';
                children.clear();
                render();
            });
            App.bus.on('nav:changed', () => tree.reveal(App.state.cwd || ''));
            App.bus.on('view:changed', ({ reason }) => {
                if (reason === 'entries') render();
            });
            App.bus.on('fs:changed', async (c) => {
                const dirs = new Set(c.dirs);
                for (const p of [...(c.from || []), ...(c.paths || [])]) dirs.add(P.parent(p));
                let touched = false;
                for (const d of dirs) {
                    if (children.has(d)) {
                        await loadChildren(d);
                        touched = true;
                    }
                }
                if (c.from && c.to) {
                    // Keep expansion state for renamed/moved folders
                    expanded = new Set([...expanded].map((x) => c.from.reduce((acc, f, i) => P.rebase(acc, f, c.to[i]) ?? acc, x)));
                }
                if (touched) render();
            });
        },
    });

    App.tree = tree;
    App.sidebar = sidebar;
})();
