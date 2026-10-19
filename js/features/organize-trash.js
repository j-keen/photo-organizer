/*
 * Organize — trash.
 *   'trash.open'  panel listing App.fs.listTrash(): thumbnails, original folder, deleted date, size, search & sort,
 *                 restore (undoable), delete permanently, empty trash, retention setting.
 *   'trash.empty' empty the whole trash (with confirmation).
 *   Auto-purge: items older than App.settings 'trash.retentionDays' (default 30, 0 = keep forever) go away
 *   shortly after a workspace opens. Status bar shows the trash count.
 */
(() => {
    'use strict';
    const { h, path: P, formatCount, formatBytes, formatDate } = App.util;
    const ui = App.ui;
    const kit = App.organize.kit;
    const { icon, btn } = kit;

    const RET_KEY = 'trash.retentionDays';
    const RETENTION_OPTIONS = [
        { value: 7, label: '7일' },
        { value: 14, label: '14일' },
        { value: 30, label: '30일' },
        { value: 60, label: '60일' },
        { value: 90, label: '90일' },
        { value: 365, label: '1년' },
        { value: 0, label: '영구 보관' },
    ];

    function retentionDays() {
        const v = Number(App.settings.get(RET_KEY, 30));
        return Number.isFinite(v) && v >= 0 ? v : 30;
    }

    function retentionText(days = retentionDays()) {
        return days ? `${days >= 365 ? '1년' : `${days}일`}이 지나면 자동으로 비워요` : '자동으로 비우지 않아요';
    }

    function entryOf(item) {
        const isDir = item.kind === 'dir';
        return {
            path: item.trashPath,
            name: item.name,
            kind: isDir ? 'dir' : 'file',
            type: isDir ? 'dir' : App.util.mediaType(item.name),
            ext: isDir ? '' : P.ext(item.name),
            size: item.size,
        };
    }

    async function purgeIds(ids, title = '휴지통 비우는 중') {
        const job = ids.length > 40 ? App.jobs.start({ title, total: ids.length, cancellable: false }) : null;
        try {
            for (const part of kit.chunk(ids, 150)) {
                await App.fs.purgeTrash(part);
                job?.step(part.length);
            }
        } finally {
            job?.finish();
        }
    }

    /** Restore trash items as ONE undo entry (undo puts them back in the trash). Returns restored paths. */
    async function restoreIds(ids) {
        if (!ids.length) return [];
        const map = await kit.restoreIds(ids);
        const restored = [...map.values()];
        if (restored.length) {
            let current = restored;
            let again = null;
            App.undo.push({
                label: `휴지통에서 ${formatCount(restored.length)}개 복원`,
                undo: async () => {
                    const live = [];
                    for (const p of current) if (await App.fs.exists(p)) live.push(p);
                    again = await kit.trashPaths(live);
                },
                redo: async () => {
                    if (!again) return;
                    const back = await kit.restoreIds(again.ids);
                    current = again.paths.map((p) => back.get(p) || p);
                },
            });
        }
        return restored;
    }

    function revealRestored(paths) {
        if (!paths.length) return;
        const dir = P.parent(paths[0]);
        const here = paths.filter((p) => P.parent(p) === dir);
        App.topbar?.clearSearch?.();
        App.nav.go(dir).then(() => {
            const visible = here.filter((p) => App.view.indexOf(p) >= 0);
            if (visible.length) {
                App.select.set(visible);
                App.gallery?.scrollTo?.(visible[0], { center: true });
            }
        });
    }

    // =====================================================================
    // Panel
    // =====================================================================
    // Deletion policy: permanent deletion happens only here (delete permanently / empty trash, each confirmed)
    // and in the retention-based auto-purge. Everything else in the app is a soft delete into this trash.
    function openTrash({ emptyNow = false } = {}) {
        if (!App.fs.ready) return null;
        return kit.panel({
            title: '휴지통',
            subtitle: '불러오는 중…',
            icon: 'trash',
            width: 920,
            height: 'min(700px, calc(100vh - 48px))',
            className: 'org-trash',
            undoKeys: true,
            build(ctx) {
                let items = [];
                let view = [];
                const selected = new Set();
                let focus = -1;
                let anchor = -1;
                let query = '';
                let sort = App.settings.get('trash.sort', { key: 'deletedAt', dir: 'desc' });
                const stats = new Map(); // id -> Promise<entry>

                const search = h('input', { class: 'input', type: 'search', placeholder: '이름이나 위치로 찾기', spellcheck: 'false', 'aria-label': '휴지통 검색' });
                ctx.headRight.append(h('div', { class: 'search-box org-trash-search' }, ui.iconEl('search', { size: 15 }), search));

                const allCheck = h('button', { type: 'button', class: 'org-colcheck', 'aria-label': '모두 선택', 'data-tip': '모두 선택', 'data-tip-keys': 'Mod+A' });
                const col = (key, label, cls) => {
                    const b = h('button', { type: 'button', class: `org-col ${cls}`, dataset: { key } }, h('span', { text: label }), h('span', { class: 'org-col-sort' }));
                    b.addEventListener('click', () => {
                        sort = { key, dir: sort.key === key && sort.dir === 'desc' ? 'asc' : sort.key === key ? 'desc' : key === 'name' || key === 'originalPath' ? 'asc' : 'desc' };
                        App.settings.set('trash.sort', sort);
                        refreshView();
                    });
                    return b;
                };
                const header = h('div', { class: 'org-trash-cols' }, allCheck, h('span', { class: 'org-col-thumb' }), col('name', '이름', 'c-name'), col('deletedAt', '지운 날짜', 'c-date'), col('size', '크기', 'c-size'), h('span', { class: 'c-actions' }));
                const list = kit.virtualList({ rowHeight: 60, render: renderRow, className: 'org-trash-list', label: '휴지통 항목' });
                const emptyEl = h('div', { class: 'org-empty-state', hidden: true });
                ctx.main.append(header, h('div', { class: 'org-picker-body' }, list.el, emptyEl));

                const retSel = kit.select(RETENTION_OPTIONS, retentionDays(), (v) => {
                    App.settings.set(RET_KEY, v);
                    updateSubtitle();
                    ui.toast(v ? `이제 휴지통에서 ${v >= 365 ? '1년' : `${v}일`}이 지난 항목은 자동으로 비워요` : '휴지통을 자동으로 비우지 않아요', { type: 'info' });
                }, { cls: 'sm' });
                const emptyBtn = btn({ label: '휴지통 비우기', kind: 'ghost org-danger-text', icon: 'trash', onClick: () => emptyAll() });
                const delBtn = btn({ label: '영구 삭제', kind: 'danger', onClick: () => deleteSelected(), tip: '선택한 항목을 완전히 지워요', keys: 'Delete' });
                const restoreBtn = btn({ label: '복원', kind: 'primary', icon: 'undo', onClick: () => restoreSelected(), tip: '원래 있던 폴더로 되돌려요', keys: 'Enter' });
                const selInfo = h('div', { class: 'org-foot-info' });
                ctx.foot.append(h('label', { class: 'org-retention' }, h('span', { text: '보관 기간' }), retSel), selInfo, emptyBtn, delBtn, restoreBtn);

                function compare(a, b) {
                    const d = sort.dir === 'asc' ? 1 : -1;
                    let c = 0;
                    if (sort.key === 'name') c = App.util.compareNames(a.name, b.name);
                    else if (sort.key === 'size') c = (a.size || 0) - (b.size || 0);
                    else if (sort.key === 'originalPath') c = App.util.compareNames(P.parent(a.originalPath), P.parent(b.originalPath)) || App.util.compareNames(a.name, b.name);
                    else c = (a.deletedAt || 0) - (b.deletedAt || 0);
                    return c * d;
                }

                function refreshView() {
                    const q = query.trim().toLowerCase();
                    view = q ? items.filter((i) => i.originalPath.toLowerCase().includes(q)) : items.slice();
                    view.sort(compare);
                    for (const b of header.querySelectorAll('.org-col')) {
                        const on = b.dataset.key === sort.key;
                        b.classList.toggle('on', on);
                        b.querySelector('.org-col-sort').innerHTML = on ? icon(sort.dir === 'asc' ? 'chevron-up' : 'chevron-down', 12) : '';
                    }
                    list.setCount(view.length);
                    if (focus >= view.length) focus = view.length - 1;
                    updateEmpty();
                    updateFoot();
                }

                function updateSubtitle() {
                    const bytes = items.reduce((s, i) => s + (i.size || 0), 0);
                    ctx.setSubtitle(items.length ? `${formatCount(items.length)}개 항목 · ${formatBytes(bytes)} · ${retentionText()}` : retentionText());
                }

                function updateEmpty() {
                    const none = !view.length;
                    emptyEl.hidden = !none;
                    list.el.hidden = none;
                    header.hidden = !items.length;
                    if (!none) return;
                    emptyEl.innerHTML = '';
                    if (!items.length) {
                        emptyEl.append(
                            h('div', { class: 'org-empty-art', html: icon('trash', 30) }),
                            h('h4', { text: '휴지통이 비어 있어요' }),
                            h('p', { text: `지운 사진과 영상은 여기 보관돼요. ${retentionDays() ? `${retentionDays() >= 365 ? '1년' : `${retentionDays()}일`} 동안 ` : ''}언제든 되살릴 수 있어요.` }));
                    } else {
                        emptyEl.append(h('div', { class: 'org-empty-art', html: icon('search', 26) }), h('h4', { text: '찾는 항목이 없어요' }), h('p', { text: '다른 이름이나 폴더로 찾아보세요.' }));
                    }
                }

                function selectedIds() {
                    return items.filter((i) => selected.has(i.id)).map((i) => i.id);
                }

                function updateFoot() {
                    const ids = selectedIds();
                    const bytes = items.filter((i) => selected.has(i.id)).reduce((s, i) => s + (i.size || 0), 0);
                    selInfo.textContent = ids.length ? `${formatCount(ids.length)}개 선택됨${bytes ? ` · ${formatBytes(bytes)}` : ''}` : items.length ? '항목을 골라 복원하거나 지울 수 있어요' : '';
                    restoreBtn.disabled = !ids.length;
                    delBtn.disabled = !ids.length;
                    emptyBtn.disabled = !items.length;
                    kit.setBtnLabel(restoreBtn, ids.length > 1 ? `${formatCount(ids.length)}개 복원` : '복원');
                    const all = view.length > 0 && view.every((i) => selected.has(i.id));
                    const some = !all && view.some((i) => selected.has(i.id));
                    allCheck.innerHTML = '';
                    allCheck.append(kit.checkMark(all, { partial: some }));
                    allCheck.setAttribute('aria-pressed', String(all));
                }

                function statOf(item) {
                    if (!stats.has(item.id)) {
                        stats.set(item.id, App.fs.stat(item.trashPath).then((e) => ({ ...e, name: item.name, type: entryOf(item).type, ext: entryOf(item).ext })).catch(() => entryOf(item)));
                    }
                    return stats.get(item.id);
                }

                function renderRow(i) {
                    const item = view[i];
                    const on = selected.has(item.id);
                    const left = retentionDays() ? Math.ceil((item.deletedAt + retentionDays() * kit.DAY - Date.now()) / kit.DAY) : null;
                    const folder = P.parent(item.originalPath);
                    const row = h('div', { class: `org-row org-trash-row${on ? ' selected' : ''}${i === focus ? ' focused' : ''}`, role: 'option', 'aria-selected': String(on) },
                        h('span', { class: 'org-rowcheck' }, kit.checkMark(on)),
                        kit.thumb(item.kind === 'dir' ? entryOf(item) : statOf(item)),
                        h('div', { class: 'org-trash-name' },
                            h('div', { class: 'org-row-name truncate', text: item.name, title: item.name }),
                            h('div', { class: 'org-row-sub truncate', title: `원래 위치: ${kit.folderPathLabel(folder)}` }, h('span', { html: icon(folder ? 'folder' : 'home', 12) }), h('span', { text: kit.folderPathLabel(folder) }))),
                        h('div', { class: 'org-trash-date', title: formatDate(item.deletedAt, true) },
                            h('div', { text: kit.relTime(item.deletedAt) }),
                            left != null ? h('div', { class: `org-row-sub${left <= 3 ? ' warn' : ''}`, text: left <= 0 ? '곧 비워져요' : `${left}일 뒤 삭제` }) : null),
                        h('div', { class: 'org-trash-size', text: item.kind === 'dir' ? '폴더' : formatBytes(item.size) }),
                        h('div', { class: 'org-row-actions' },
                            btn({ icon: 'undo', kind: 'ghost sm icon', tip: '복원', onClick: (e) => { e.stopPropagation(); restore([item.id]); } }),
                            btn({ icon: 'x', kind: 'ghost sm icon org-danger-text', tip: '영구 삭제', onClick: (e) => { e.stopPropagation(); remove([item.id]); } })));
                    row.addEventListener('mousedown', (e) => {
                        if (e.button !== 0 || e.target.closest('.org-row-actions')) return;
                        e.preventDefault();
                        list.el.focus({ preventScroll: true });
                        if (e.target.closest('.org-rowcheck') || e.ctrlKey || e.metaKey) toggleAt(i);
                        else if (e.shiftKey && anchor >= 0) rangeTo(i);
                        else {
                            selected.clear();
                            selected.add(item.id);
                            anchor = i;
                            setFocus(i);
                        }
                        list.refresh();
                        updateFoot();
                    });
                    row.addEventListener('dblclick', (e) => {
                        if (!e.target.closest('.org-row-actions')) restore([item.id]);
                    });
                    return row;
                }

                function setFocus(i) {
                    focus = Math.max(-1, Math.min(view.length - 1, i));
                    if (focus >= 0) list.scrollToIndex(focus);
                }

                function toggleAt(i) {
                    const id = view[i].id;
                    if (selected.has(id)) selected.delete(id);
                    else selected.add(id);
                    anchor = i;
                    setFocus(i);
                }

                function rangeTo(i) {
                    const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
                    selected.clear();
                    for (let k = a; k <= b; k++) selected.add(view[k].id);
                    setFocus(i);
                }

                async function load() {
                    try {
                        items = await App.fs.listTrash();
                    } catch (e) {
                        items = [];
                        ui.toast(`휴지통을 읽지 못했어요: ${e.message}`, { type: 'error' });
                    }
                    const ids = new Set(items.map((i) => i.id));
                    for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
                    updateSubtitle();
                    refreshView();
                }

                async function restore(ids) {
                    if (!ids.length) return;
                    const restored = await restoreIds(ids);
                    for (const id of ids) selected.delete(id);
                    await load();
                    if (restored.length) {
                        ui.toast(`${formatCount(restored.length)}개를 원래 자리로 되살렸어요`, {
                            type: 'success',
                            action: { label: '보러 가기', run: () => { ctx.close(null); revealRestored(restored); } },
                        });
                    }
                }

                async function remove(ids) {
                    if (!ids.length) return;
                    const sel = items.filter((i) => ids.includes(i.id));
                    const bytes = sel.reduce((s, i) => s + (i.size || 0), 0);
                    const ok = await kit.sheet(ctx.box, {
                        title: sel.length === 1 ? `"${sel[0].name}"을(를) 영구 삭제할까요?` : `${formatCount(sel.length)}개 항목을 영구 삭제할까요?`,
                        message: `${bytes ? `${formatBytes(bytes)}를 비워요. ` : ''}영구 삭제하면 되돌릴 수 없어요.`,
                        okLabel: '영구 삭제',
                        danger: true,
                    });
                    if (!ok) return;
                    await purgeIds(ids);
                    for (const id of ids) selected.delete(id);
                    await load();
                    ui.toast(`${formatCount(ids.length)}개를 영구 삭제했어요`, { type: 'success' });
                }

                function restoreSelected() {
                    const ids = selectedIds();
                    if (ids.length) restore(ids);
                    else if (view[focus]) restore([view[focus].id]);
                }

                function deleteSelected() {
                    const ids = selectedIds();
                    if (ids.length) remove(ids);
                    else if (view[focus]) remove([view[focus].id]);
                }

                async function emptyAll() {
                    if (!items.length) return;
                    const bytes = items.reduce((s, i) => s + (i.size || 0), 0);
                    const ok = await kit.sheet(ctx.box, {
                        title: '휴지통을 비울까요?',
                        message: `${formatCount(items.length)}개 항목${bytes ? `(${formatBytes(bytes)})` : ''}이 영구 삭제돼요. 되돌릴 수 없어요.`,
                        okLabel: '휴지통 비우기',
                        danger: true,
                        icon: 'trash',
                    });
                    if (!ok) return;
                    const n = items.length;
                    await purgeIds(items.map((i) => i.id));
                    selected.clear();
                    await load();
                    ui.toast(`휴지통을 비웠어요 · ${formatCount(n)}개 삭제`, { type: 'success' });
                }

                allCheck.addEventListener('click', () => {
                    const all = view.length > 0 && view.every((i) => selected.has(i.id));
                    if (all) for (const i of view) selected.delete(i.id);
                    else for (const i of view) selected.add(i.id);
                    list.refresh();
                    updateFoot();
                });

                search.addEventListener('input', App.util.debounce(() => {
                    query = search.value;
                    focus = view.length ? 0 : -1;
                    refreshView();
                }, 80));

                ctx.onKey((e) => {
                    const inSearch = e.target === search;
                    const k = e.key;
                    const mod = e.ctrlKey || e.metaKey;
                    if (k === 'ArrowDown' || k === 'ArrowUp') {
                        if (!view.length) return true;
                        if (inSearch) list.el.focus({ preventScroll: true });
                        const next = Math.max(0, Math.min(view.length - 1, (focus < 0 ? (k === 'ArrowDown' ? -1 : view.length) : focus) + (k === 'ArrowDown' ? 1 : -1)));
                        if (e.shiftKey) {
                            if (anchor < 0) anchor = focus < 0 ? next : focus;
                            rangeTo(next);
                        } else {
                            selected.clear();
                            selected.add(view[next].id);
                            anchor = next;
                            setFocus(next);
                        }
                        list.refresh();
                        updateFoot();
                        return true;
                    }
                    if (inSearch) return false;
                    if (e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON') return false;
                    if (k === ' ' && focus >= 0) {
                        toggleAt(focus);
                        list.refresh();
                        updateFoot();
                        return true;
                    }
                    if (mod && (k === 'a' || k === 'A')) {
                        for (const i of view) selected.add(i.id);
                        list.refresh();
                        updateFoot();
                        return true;
                    }
                    if (k === 'Delete' || (k === 'Backspace' && mod)) {
                        deleteSelected();
                        return true;
                    }
                    if (mod && (k === 'f' || k === 'F')) {
                        search.focus();
                        return true;
                    }
                    if (k.length === 1 && !mod && !e.altKey && k !== ' ') search.focus();
                    return false;
                });
                ctx.onEnter(() => restoreSelected());

                const off = App.bus.on('trash:changed', () => load());
                ctx.onClose(() => {
                    off();
                    list.destroy();
                });
                load().then(() => {
                    if (view.length) {
                        focus = 0;
                        list.refresh();
                    }
                    list.el.focus({ preventScroll: true });
                    if (emptyNow) emptyAll();
                });
            },
        });
    }

    /** "휴지통 비우기" from the palette/menus: opens the trash panel and asks there (permanent deletes live in one place). */
    async function emptyTrashCommand() {
        if (!App.fs.ready) return null;
        const items = await App.fs.listTrash();
        if (!items.length) {
            ui.toast('휴지통이 이미 비어 있어요', { type: 'info' });
            return null;
        }
        return openTrash({ emptyNow: true });
    }

    // =====================================================================
    // Auto-purge + status bar entry
    // =====================================================================
    let purgeToken = 0;

    async function autoPurge() {
        const days = retentionDays();
        if (!days || !App.fs.ready) return 0;
        const ws = App.state.workspace?.id;
        let items;
        try {
            items = await App.fs.listTrash();
        } catch (e) {
            return 0;
        }
        const cutoff = Date.now() - days * kit.DAY;
        const old = items.filter((i) => (i.deletedAt || 0) < cutoff);
        if (!old.length || App.state.workspace?.id !== ws) return 0;
        await purgeIds(old.map((i) => i.id), '오래된 휴지통 항목 비우는 중');
        ui.toast(`휴지통에서 ${days >= 365 ? '1년' : `${days}일`}이 지난 항목 ${formatCount(old.length)}개를 비웠어요`, { type: 'info', duration: 5000 });
        return old.length;
    }

    let sbEl = null;
    let sbCount = null;

    async function updateBadge() {
        if (!sbEl) return;
        if (!App.fs.ready) {
            sbEl.hidden = true;
            return;
        }
        let items = [];
        try {
            items = await App.fs.listTrash();
        } catch (e) {
            /* ignore */
        }
        sbEl.hidden = false;
        sbCount.textContent = items.length ? formatCount(items.length) : '';
        sbEl.classList.toggle('has-items', items.length > 0);
        sbEl.dataset.tip = items.length ? `휴지통 · ${formatCount(items.length)}개 · ${formatBytes(items.reduce((s, i) => s + (i.size || 0), 0))}` : '휴지통 · 비어 있음';
    }
    const updateBadgeSoon = App.util.debounce(updateBadge, 150);

    App.commands.register({ id: 'trash.open', title: '휴지통 열기', group: '정리', icon: 'trash', keys: 'Mod+Shift+Backspace', when: () => App.fs.ready, run: () => openTrash() });
    App.commands.register({ id: 'trash.empty', title: '휴지통 비우기…', group: '정리', icon: 'trash', when: () => App.fs.ready, run: () => emptyTrashCommand() });

    App.register('organize-trash', {
        init() {
            if (App.statusbar && typeof App.statusbar.addItem === 'function') {
                sbCount = h('span', { class: 'org-sb-count' });
                sbEl = h('button', { type: 'button', class: 'org-sb-trash sb-btn', 'aria-label': '휴지통 열기', 'data-tip': '휴지통', 'data-tip-keys': 'Mod+Shift+Backspace', hidden: true, onclick: () => App.commands.run('trash.open') }, ui.iconEl('trash', { size: 13 }), sbCount);
                try {
                    App.statusbar.addItem('organize-trash', sbEl, { side: 'right' });
                } catch (e) {
                    console.warn('[organize] status bar item failed', e);
                    sbEl = null;
                }
            }
            App.bus.on('trash:changed', updateBadgeSoon);
            App.bus.on('workspace:closed', updateBadge);
            App.bus.on('workspace:opened', () => {
                updateBadge();
                const my = ++purgeToken;
                setTimeout(() => {
                    if (my === purgeToken) autoPurge().catch((e) => console.warn('[organize] auto-purge failed', e));
                }, 1200);
            });
        },
    });

    Object.assign(App.organize, { openTrash, autoPurge, restoreTrash: restoreIds, purgeTrash: purgeIds, retentionDays });
})();
