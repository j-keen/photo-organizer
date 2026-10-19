/*
 * Favorites (즐겨찾기): pinned folders in a sidebar section above the folder tree.
 * Stored in <workspace>/.fluid-organizer/favorites.json ({ version, items: [{ path, addedAt }] }) so they travel with
 * the photo folder. Paths follow renames/moves; trashed folders drop out and come back when the trash is undone.
 *
 *   App.navFavorites.has(p), list(), add(p, index?), addMany(paths, index?), remove(p), toggle(p), move(p, toIndex)
 *   Each call is one App.undo entry (add/addMany/remove/move), so one Ctrl+Z reverts one user action.
 * Commands: nav.favoriteToggle (Ctrl+D — current folder, or the one folder selected in the gallery),
 *           nav.favoritesMenu (Ctrl+Alt+B — keyboard list of favorites)
 * Drag & drop: drag a favorite to reorder; drop gallery items / files on a favorite to move (Ctrl = copy) or import;
 * drop folders between favorites (or on the empty box) to pin them there.
 */
(() => {
    'use strict';
    const { h, path: P, formatCount } = App.util;
    const ui = App.ui;
    const FAV_TYPE = 'application/x-fi-fav';

    let items = []; // [{ path, addedAt }]
    let loadedFor = null;
    let body = null;
    const dropped = new Map(); // path -> { index, item } — removed because trashed, restored with the trash
    let dragFav = null;
    let indicator = null; // { path, before } | { end: true }
    let dropInto = null;

    const label = (p) => (p === '' ? App.state.workspace?.name || '작업 폴더' : App.navMatch.normalize(P.base(p)));
    const parentLabel = (p) => {
        const parent = P.parent(p);
        return parent === '' ? App.state.workspace?.name || '' : App.navMatch.normalize(parent);
    };
    const indexOf = (p) => items.findIndex((it) => it.path === p);
    const has = (p) => indexOf(p) >= 0;
    const isCurrent = (p) => App.state.cwd === p && App.view.source.type === 'folder';
    const isMissing = (p) => p !== '' && App.index.ready && App.tree && !App.tree.isFolder(p);

    async function persist() {
        if (!App.fs.ready) return;
        try {
            await App.wsdata.write('favorites', { version: 1, items });
        } catch (e) {
            console.error('[favorites] save failed', e);
            ui.toast('즐겨찾기를 저장하지 못했어요. 폴더 권한을 확인해 주세요.', { type: 'error' });
        }
        App.bus.emit('favorites:changed', { paths: items.map((it) => it.path) });
    }

    let refreshPending = false;
    function refresh() {
        // Re-rendering rows under a drag in progress would drop the drop target; wait until the drag leaves
        if (indicator || dropInto != null || dragFav != null) {
            refreshPending = true;
            return;
        }
        refreshPending = false;
        App.sidebar?.refreshSection('favorites');
    }

    function normalizeData(data) {
        const raw = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
        const out = [];
        for (const it of raw) {
            const p = typeof it === 'string' ? it : it && typeof it.path === 'string' ? it.path : null;
            if (p == null || App.fs.isDataPath(p) || out.some((x) => x.path === p)) continue;
            out.push({ path: p, addedAt: (it && it.addedAt) || Date.now() });
        }
        return out;
    }

    // ---------- API ----------
    // Every user action is exactly one App.undo entry (one Ctrl+Z). Undo closures hold the item objects, whose
    // `path` is rebased in place on renames/moves, so they stay valid after the folder was renamed.
    function commit() {
        persist();
        refresh();
    }

    const undoAction = { label: '실행 취소', run: () => App.undo.undo() };

    function add(p, index = items.length, opts = {}) {
        return addMany([p], index, opts) > 0;
    }

    /** Pin several folders at `index` as one action (one undo entry, one toast). Returns how many were added. */
    function addMany(paths, index = items.length, { silent = false, undoable = true } = {}) {
        const fresh = [...new Set(paths)].filter((p) => p != null && !has(p) && !App.fs.isDataPath(p));
        if (!fresh.length) return 0;
        const at = App.util.clamp(index, 0, items.length);
        const added = fresh.map((p) => ({ path: p, addedAt: Date.now() }));
        items.splice(at, 0, ...added);
        commit();
        const one = added.length === 1 ? label(added[0].path) : null;
        if (undoable) {
            App.undo.push({
                label: one ? `즐겨찾기에 ‘${one}’ 추가` : `즐겨찾기에 폴더 ${formatCount(added.length)}개 추가`,
                undo: async () => {
                    items = items.filter((it) => !added.includes(it));
                    commit();
                },
                redo: async () => {
                    const back = added.filter((it) => !has(it.path));
                    items.splice(Math.min(at, items.length), 0, ...back);
                    commit();
                },
            });
        }
        if (!silent) {
            const text = one ? `‘${one}’${App.navMatch.josa(one, '을/를')} 즐겨찾기에 추가했어요` : `폴더 ${formatCount(added.length)}개를 즐겨찾기에 추가했어요`;
            ui.toast(text, { type: 'success', duration: 3200, action: undoable ? undoAction : null });
        }
        return added.length;
    }

    function remove(p, { undoable = true, silent = false } = {}) {
        const i = indexOf(p);
        if (i < 0) return false;
        const [item] = items.splice(i, 1);
        commit();
        if (undoable) {
            App.undo.push({
                label: `즐겨찾기에서 ‘${label(p)}’ 빼기`,
                undo: async () => {
                    if (has(item.path)) return;
                    items.splice(Math.min(i, items.length), 0, item);
                    commit();
                },
                redo: async () => {
                    const j = items.indexOf(item);
                    if (j < 0) return;
                    items.splice(j, 1);
                    commit();
                },
            });
        }
        if (!silent) ui.toast(`‘${label(p)}’${App.navMatch.josa(label(p), '을/를')} 즐겨찾기에서 뺐어요`, { type: 'info', duration: 3200, action: undoable ? undoAction : null });
        return true;
    }

    function toggle(p) {
        return has(p) ? remove(p) : add(p);
    }

    function placeItem(item, index) {
        const i = items.indexOf(item);
        if (i < 0) return;
        items.splice(i, 1);
        items.splice(App.util.clamp(index, 0, items.length), 0, item);
        commit();
    }

    /** Move a favorite so it lands before the item now at `toIndex` (items.length = to the end). */
    function move(p, toIndex, { undoable = true } = {}) {
        const from = indexOf(p);
        if (from < 0) return false;
        const item = items[from];
        const to = App.util.clamp(toIndex > from ? toIndex - 1 : toIndex, 0, items.length - 1);
        if (to === from) {
            refresh();
            return false;
        }
        placeItem(item, to);
        if (undoable) {
            App.undo.push({
                label: `즐겨찾기 ‘${label(item.path)}’ 순서 바꾸기`,
                undo: async () => placeItem(item, from),
                redo: async () => placeItem(item, to),
            });
        }
        return true;
    }

    // ---------- Rendering ----------
    function render(b) {
        body = b;
        b.classList.add('fav-body');
        if (!items.length) {
            b.append(h('div', { class: 'fav-empty', dataset: { drop: 'pin' } },
                h('span', { class: 'fav-empty-icon', html: ui.icon('star', { size: 15, filled: false }) }),
                h('div', { class: 'fav-empty-text' },
                    h('b', { text: '자주 가는 폴더를 고정해 보세요' }),
                    h('small', { text: `폴더를 여기로 끌어 오거나 ${App.commands.displayCombo('Mod+D')}를 눌러요` }))));
            return;
        }
        const seen = new Map();
        for (const it of items) seen.set(label(it.path), (seen.get(label(it.path)) || 0) + 1);
        const list = h('div', { class: 'fav-list', role: 'list', 'aria-label': '즐겨찾기' });
        for (const it of items) list.append(row(it.path, seen.get(label(it.path)) > 1));
        b.append(list);
    }

    function row(p, ambiguous) {
        const missing = isMissing(p);
        const cur = isCurrent(p);
        const name = label(p);
        const empty = !missing && !!App.tree?.emptyKind?.(p);
        const el = h('div', {
            class: `fav-row${cur ? ' current' : ''}${missing ? ' missing' : ''}${empty ? ' is-empty' : ''}`,
            role: 'listitem',
            draggable: 'true',
            dataset: { path: p },
            'aria-label': name,
            'aria-current': cur ? 'page' : null,
        },
            h('span', { class: 'fav-icon', html: ui.icon(missing ? 'alert' : p === '' ? 'home' : 'folder', { size: 14 }) }),
            h('span', { class: 'fav-name truncate', text: name }),
            ambiguous && p !== '' ? h('span', { class: 'fav-sub truncate', text: parentLabel(p) }) : null);
        const c = App.tree?.countText?.(p);
        if (c && c.text) el.append(h('span', { class: 'tree-count fav-count', text: c.text }));
        if (missing) el.dataset.tip = '폴더를 찾을 수 없어요 · 우클릭해서 즐겨찾기에서 뺄 수 있어요';
        else {
            const where = p === '' ? name : `${parentLabel(p)} › ${name}`;
            const info = App.tree?.folderInfo?.(p);
            el.dataset.tip = info ? `${where} — ${info}` : where;
        }
        return el;
    }

    function applyDragClasses() {
        if (!body) return;
        for (const el of body.querySelectorAll('.fav-row')) {
            const p = el.dataset.path;
            el.classList.toggle('drop-target', dropInto === p);
            el.classList.toggle('ins-before', !!indicator && indicator.path === p && indicator.before);
            el.classList.toggle('ins-after', !!indicator && indicator.path === p && !indicator.before);
            el.classList.toggle('dragging', dragFav === p);
        }
        const list = body.querySelector('.fav-list');
        if (list) list.classList.toggle('ins-end', !!indicator && !!indicator.end);
        const empty = body.querySelector('.fav-empty');
        if (empty) empty.classList.toggle('drop-target', !!indicator && !!indicator.end);
    }

    function clearDrag() {
        indicator = null;
        dropInto = null;
        applyDragClasses();
        if (refreshPending && dragFav == null) setTimeout(refresh, 0);
    }

    // ---------- Interaction ----------
    function open(p) {
        if (isMissing(p)) {
            ui.toast(`‘${label(p)}’ 폴더를 찾을 수 없어요`, { type: 'warning', action: { label: '즐겨찾기에서 빼기', run: () => remove(p) } });
            return;
        }
        App.topbar?.clearSearch?.();
        if (!isCurrent(p)) App.nav.go(p);
    }

    function rowMenu(p, pos) {
        const i = indexOf(p);
        const folderItems = App.tree ? App.tree.menuItems(p).filter((it) => !(it && it.header)) : [];
        ui.menu([
            { header: label(p) },
            { label: '열기', icon: 'folder-open', action: () => open(p) },
            { label: '트리에서 위치 보기', icon: 'eye', disabled: isMissing(p), action: () => { App.tree?.clearFilter?.(); App.tree?.reveal(p); } },
            '-',
            { label: '위로 옮기기', icon: 'chevron-up', disabled: i <= 0, action: () => move(p, i - 1) },
            { label: '아래로 옮기기', icon: 'chevron-down', disabled: i >= items.length - 1, action: () => move(p, i + 2) },
            folderItems.length && !isMissing(p) ? { label: '폴더 작업', icon: 'folder', submenu: folderItems } : null,
            '-',
            { label: '즐겨찾기에서 빼기', icon: 'x', command: 'nav.favoriteToggle', args: { path: p }, hint: App.commands.displayCombo('Mod+D') },
        ].filter(Boolean), pos);
    }

    // Folders being dragged that could be pinned (all folders, not yet favorites)
    function pinnable() {
        const ps = App.navDnd.paths();
        if (!ps || !ps.length || !App.tree) return null;
        if (!ps.every((p) => App.tree.isFolder(p))) return null;
        const fresh = ps.filter((p) => !has(p));
        return fresh.length ? fresh : null;
    }

    function pinText(paths) {
        return paths.length === 1 ? `‘${label(paths[0])}’${App.navMatch.josa(label(paths[0]), '을/를')} 즐겨찾기에 고정해요` : `폴더 ${formatCount(paths.length)}개를 즐겨찾기에 고정해요`;
    }

    function onDragOver(e) {
        if (!body) return;
        const types = [...(e.dataTransfer?.types || [])];
        const rowEl = e.target.closest?.('.fav-row');
        if (types.includes(FAV_TYPE)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (rowEl) {
                const r = rowEl.getBoundingClientRect();
                indicator = { path: rowEl.dataset.path, before: e.clientY < r.top + r.height / 2 };
            } else indicator = { end: true };
            dropInto = null;
            App.navDnd.hint(e, '여기로 순서를 옮겨요', 'move');
            applyDragClasses();
            return;
        }
        if (!types.includes(App.navDnd.TYPE) && !types.includes('Files')) return;
        const pins = types.includes(App.navDnd.TYPE) ? pinnable() : null;
        if (rowEl) {
            const p = rowEl.dataset.path;
            const r = rowEl.getBoundingClientRect();
            const y = e.clientY - r.top;
            const edge = y < r.height * 0.28 ? 'before' : y > r.height * 0.72 ? 'after' : null;
            if (edge && pins) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                indicator = { path: p, before: edge === 'before' };
                dropInto = null;
                App.navDnd.hint(e, pinText(pins), 'copy');
            } else {
                indicator = null;
                const v = isMissing(p) ? { ok: false } : App.navDnd.over(e, p, { label: label(p) });
                dropInto = v.ok ? p : null;
            }
        } else if (pins) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            indicator = { end: true };
            dropInto = null;
            App.navDnd.hint(e, pinText(pins), 'copy');
        } else {
            clearDrag();
            if (e.target.closest?.('.fav-empty')) App.navDnd.hint(e, '폴더만 즐겨찾기에 고정할 수 있어요', 'no');
            return;
        }
        applyDragClasses();
    }

    function onDrop(e) {
        const types = [...(e.dataTransfer?.types || [])];
        const ind = indicator;
        const into = dropInto;
        clearDrag();
        if (types.includes(FAV_TYPE)) {
            e.preventDefault();
            App.navDnd.hideHint();
            const p = e.dataTransfer.getData(FAV_TYPE);
            if (!has(p) || !ind) return;
            const to = ind.end ? items.length : indexOf(ind.path) + (ind.before ? 0 : 1);
            move(p, to);
            return;
        }
        if (ind) {
            e.preventDefault();
            App.navDnd.hideHint();
            let paths = [];
            try {
                paths = JSON.parse(e.dataTransfer.getData(App.navDnd.TYPE) || '[]');
            } catch (err) {
                paths = [];
            }
            const dirs = paths.filter((p) => App.tree?.isFolder(p) && !has(p));
            if (!dirs.length) return;
            addMany(dirs, ind.end ? items.length : indexOf(ind.path) + (ind.before ? 0 : 1));
            return;
        }
        if (into != null) App.navDnd.drop(e, into, { label: label(into) });
    }

    function bind(b) {
        if (b.dataset.favBound) return;
        b.dataset.favBound = '1';
        b.addEventListener('click', (e) => {
            const r = e.target.closest('.fav-row');
            if (r) open(r.dataset.path);
        });
        b.addEventListener('contextmenu', (e) => {
            const r = e.target.closest('.fav-row');
            if (!r) return;
            e.preventDefault();
            e.stopPropagation();
            rowMenu(r.dataset.path, { x: e.clientX, y: e.clientY });
        });
        b.addEventListener('dragstart', (e) => {
            const r = e.target.closest('.fav-row');
            if (!r) return;
            dragFav = r.dataset.path;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData(FAV_TYPE, dragFav);
            e.dataTransfer.setData('text/plain', label(dragFav));
            const ghost = h('div', { class: 'drag-ghost nav-ghost', html: `${ui.icon('star', { size: 12 })}<span>${App.util.escapeHtml(label(dragFav))}</span>` });
            document.body.append(ghost);
            e.dataTransfer.setDragImage(ghost, 12, 12);
            setTimeout(() => ghost.remove(), 0);
            requestAnimationFrame(applyDragClasses);
        });
        b.addEventListener('dragend', () => {
            dragFav = null;
            clearDrag();
        });
        b.addEventListener('dragover', onDragOver);
        b.addEventListener('dragleave', (e) => {
            if (!b.contains(e.relatedTarget)) clearDrag();
        });
        b.addEventListener('drop', onDrop);
    }

    function favoritesMenu() {
        if (!App.fs.ready) return;
        if (!items.length) {
            ui.toast(`아직 즐겨찾기가 없어요. 폴더에서 ${App.commands.displayCombo('Mod+D')}를 누르면 추가돼요`, { type: 'info' });
            return;
        }
        const head = document.querySelector('.sb-section[data-section="favorites"] .sb-head');
        const anchor = head && head.offsetParent ? head : document.getElementById('topbar');
        ui.menu([
            { header: '즐겨찾기' },
            ...items.map((it) => ({ label: label(it.path), icon: isMissing(it.path) ? 'alert' : it.path === '' ? 'home' : 'folder', checked: isCurrent(it.path), hint: App.tree?.countText?.(it.path)?.text || '', action: () => open(it.path) })),
        ], { anchor, align: 'start' });
    }

    function toggleTarget(args) {
        if (args && typeof args.path === 'string') return args.path;
        const sel = App.select.entries();
        if (sel.length === 1 && sel[0].kind === 'dir') return sel[0].path;
        return App.state.cwd;
    }

    App.commands.register({
        id: 'nav.favoriteToggle',
        title: '즐겨찾기에 추가/빼기',
        group: '이동',
        icon: 'star',
        keys: ['Mod+D'],
        when: () => App.fs.ready,
        run: (args) => {
            const p = toggleTarget(args);
            if (p == null) return;
            toggle(p);
        },
    });
    App.commands.register({ id: 'nav.favoritesMenu', title: '즐겨찾기 목록 열기', group: '이동', icon: 'star', keys: ['Mod+Alt+B'], when: () => App.fs.ready, run: favoritesMenu });

    App.register('navFavorites', {
        init() {
            App.sidebar.addSection({
                id: 'favorites',
                title: '즐겨찾기',
                order: 10,
                actions: () => {
                    const add1 = h('button', { class: 'btn ghost icon sm sb-act', type: 'button', 'aria-label': '현재 폴더를 즐겨찾기에 추가', 'data-tip': '현재 폴더를 즐겨찾기에 추가', 'data-tip-keys': 'Mod+D', html: ui.icon('plus', { size: 14 }) });
                    add1.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const p = App.state.cwd;
                        if (p == null) return;
                        if (has(p)) ui.toast('이미 즐겨찾기에 있어요', { type: 'info', duration: 1800 });
                        else add(p);
                    });
                    return [add1];
                },
                render(b) {
                    bind(b);
                    render(b);
                },
            });

            // Mouse moves don't happen during a drag: the first one afterwards means any drag state is stale
            document.addEventListener('mousemove', () => {
                if (dragFav != null || indicator || dropInto != null) {
                    dragFav = null;
                    clearDrag();
                }
            });

            App.bus.on('workspace:opened', async ({ id }) => {
                items = [];
                dropped.clear();
                loadedFor = id;
                const data = await App.wsdata.read('favorites', null);
                if (loadedFor !== id) return;
                items = normalizeData(data);
                refresh();
            });
            App.bus.on('workspace:closed', () => {
                items = [];
                dropped.clear();
                loadedFor = null;
            });
            for (const evt of ['nav:changed', 'nav:counts']) App.bus.on(evt, refresh);
            App.bus.on('view:changed', ({ reason }) => {
                if (reason === 'entries') refresh();
            });
            App.bus.on('fs:changed', (c) => {
                if (!items.length && !dropped.size) return;
                let changed = false;
                if (c.from && c.to && (c.type === 'rename' || c.type === 'move')) {
                    for (const it of items) {
                        for (let i = 0; i < c.from.length; i++) {
                            const r = P.rebase(it.path, c.from[i], c.to[i]);
                            if (r != null && r !== it.path) {
                                it.path = r;
                                changed = true;
                                break;
                            }
                        }
                    }
                }
                if (c.type === 'trash' || c.type === 'delete') {
                    const gone = (p) => (c.paths || []).some((t) => t !== '' && P.isInside(p, t));
                    for (let i = items.length - 1; i >= 0; i--) {
                        if (!gone(items[i].path)) continue;
                        if (c.type === 'trash') dropped.set(items[i].path, { index: i, item: items[i] });
                        items.splice(i, 1);
                        changed = true;
                    }
                }
                if (c.type === 'restore') {
                    for (const [p, v] of [...dropped]) {
                        if (!(c.paths || []).some((r) => P.isInside(p, r))) continue;
                        if (!has(p)) items.splice(Math.min(v.index, items.length), 0, v.item);
                        dropped.delete(p);
                        changed = true;
                    }
                }
                if (changed) {
                    persist();
                    refresh();
                }
            });
        },
    });

    App.navFavorites = { has, list: () => items.map((it) => it.path), add, addMany, remove, toggle, move };
})();
