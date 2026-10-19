/*
 * Sidebar: workspace switcher, sections (favorites, …) and the folder tree.
 *
 *   App.sidebar.addSection({ id, title, order, render(body, el), actions?: () => Element[], collapsible?: true })
 *   App.sidebar.refreshSection(id), App.sidebar.scrollEl
 *   App.tree.reveal(path), refresh(dir), children (Map dir -> child dir paths), focus(), filter(text), clearFilter(),
 *            countsFor(path) -> {i, v, s, ri, rv, rs} | null (direct / recursive photos, videos, bytes),
 *            folderInfo(path) -> '사진 n · 영상 n · 폴더 n · 전체 3.4 GB (하위 포함 m개)' | '비어 있음' | '계산 중…',
 *            emptyKind(path) -> 'empty' | 'nomedia' | null, countText(path), hasKids(path), isFolder(path),
 *            menuItems(path), openMenu(path, pos), startNewFolder(parent), startRename(path), trashFolder(path), openFolder(path)
 * Events: 'nav:counts' after the per-folder photo/video counts were recomputed.
 * Empty folders (no photos/videos at any depth) get a dimmed, dashed folder icon and a '비어 있음' tag; hovering a row
 * shows its summary.
 *
 * The tree is a virtualized flat list (only rows near the viewport exist) so huge libraries and big filter results
 * stay smooth. Rows: click = open, twisty / double-click = expand, right-click = menu, drag = move (Ctrl = copy),
 * drop target for gallery items, other folders and files from the OS (hover 0.6s to expand, edges auto-scroll).
 * Keyboard (Ctrl+Shift+E): ↑↓ PgUp/PgDn Home/End move, →← expand/collapse, Enter/Space open, F2 rename,
 * Delete trash, Alt+N new folder, Ctrl+D favorite, Menu key / Shift+F10 folder menu, typing starts the filter,
 * Esc back to the gallery. Every change (new folder, rename, trash, drop) is exactly one Ctrl+Z step.
 * Filter box (Ctrl+Shift+F): name or Hangul initials ('ㄱㅅ' → '김수현') over every folder of the workspace index.
 */
(() => {
    'use strict';
    const { h, path: P, compareNames, formatCount, formatBytes, escapeHtml } = App.util;
    const ui = App.ui;

    const ROW_H = 28;
    const BUFFER = 10;
    const INDENT = 14;
    const NEW_KEY = '\u0000new';

    let host;
    let scrollEl;
    let sectionsEl;
    let treeSection;
    let treeStickyEl;
    let treeEl;
    let filterInput;
    let filterClear;
    let filterInfo;
    let emptyEl;
    let wsBtn;

    const children = new Map(); // dir -> [child dir paths] listed from disk
    const loadingDirs = new Map(); // dir -> Promise
    let expanded = new Set(['']);
    let rows = []; // [{ key, p, depth, open, kids: true|false|null, match?, ctx?, phantom? }]
    let rowIndex = new Map(); // key -> index
    const rendered = new Map(); // key -> { el, sig }
    let focusPath = null; // keyboard cursor
    let dropPath = null; // drag hover target
    let flashPath = null;
    let editing = null; // { kind: 'new'|'rename', parent?, path?, value, input?, errEl?, busy?, returnFocus? }
    let filterText = '';
    const filterCollapsed = new Set();
    let filterMatches = 0;
    let counts = new Map(); // dir -> { i, v, ri, rv }
    let idxKids = null; // Map parent -> sorted child folder paths (from App.index)
    let folderSet = null; // Set of every folder path (from App.index)
    let dragSrcEl = null;
    let kbdMenuAt = -Infinity; // when the Menu key / Shift+F10 last opened a row menu
    let countMode = App.settings.get('tree.counts', 'direct'); // 'direct' | 'recursive' | 'off'
    const sections = [];
    const rowIds = new Map();
    let rowIdSeq = 0;
    const spring = App.navDnd.spring(600);

    const byName = (a, b) => compareNames(P.base(a), P.base(b));

    // Icons requested from core (integration request); until one of them exists, fall back to the closest built-in
    const ICON_FALLBACK = { 'list-collapse': ['chevrons-down-up', 'minus'] };
    const iconName = (name) => {
        if (!ui.ICONS || ui.ICONS[name] || !ICON_FALLBACK[name]) return name;
        return ICON_FALLBACK[name].find((n) => ui.ICONS[n]) || name;
    };
    function icon(name, opts) {
        return ui.icon(iconName(name), opts);
    }

    // Buttons shouldn't keep focus after a mouse click (a later Enter would re-press them instead of opening
    // the selected gallery item); keyboard users still Tab to them and press Enter/Space.
    function noMouseFocus(el) {
        // Any mouse button: a right-click would otherwise focus it and leave a focus ring behind the menu
        el.addEventListener('mousedown', (e) => e.preventDefault());
        return el;
    }

    function nameOf(p) {
        return p === '' ? App.state.workspace?.name || '작업 폴더' : App.navMatch.normalize(P.base(p));
    }

    function rowId(p) {
        if (!rowIds.has(p)) rowIds.set(p, `tree-r${++rowIdSeq}`);
        return rowIds.get(p);
    }

    function isCurrent(p) {
        return App.state.cwd === p && App.view.source.type === 'folder';
    }

    function isOnPath(p) {
        const cwd = App.state.cwd;
        return cwd != null && cwd !== p && P.isInside(cwd, p);
    }

    function expandedKey() {
        return `tree.expanded.${App.state.workspace?.id || 'none'}`;
    }

    const persistExpanded = App.util.debounce((key, list) => App.settings.set(key, list), 400);
    function saveExpanded() {
        persistExpanded(expandedKey(), [...expanded]);
    }

    // ---------- Folder data ----------
    function kidsOf(p) {
        if (children.has(p)) return children.get(p);
        if (idxKids) return idxKids.get(p) || [];
        return null;
    }

    function loadChildren(dir, { force = false } = {}) {
        const inflight = loadingDirs.get(dir);
        if (inflight) return force ? inflight.then(() => loadChildren(dir)) : inflight;
        const ws = App.state.workspace?.id;
        const job = (async () => {
            try {
                const entries = await App.fs.list(dir, { stat: false });
                if (ws === App.state.workspace?.id) children.set(dir, entries.filter((e) => e.kind === 'dir').map((e) => e.path).sort(byName));
            } catch (e) {
                if (ws === App.state.workspace?.id) children.set(dir, []);
            } finally {
                loadingDirs.delete(dir);
            }
        })();
        loadingDirs.set(dir, job);
        return job;
    }

    function ensureLoaded(dir) {
        if (children.has(dir) || loadingDirs.has(dir)) return;
        loadChildren(dir).then(rebuildSoon);
    }

    function rebuildIndexFolders() {
        if (!App.index.ready) {
            idxKids = null;
            folderSet = null;
            return;
        }
        const folders = App.index.folders;
        folderSet = new Set(folders);
        idxKids = new Map();
        for (const f of folders) {
            if (f === '') continue;
            const parent = P.parent(f);
            let list = idxKids.get(parent);
            if (!list) idxKids.set(parent, (list = []));
            list.push(f);
        }
        for (const list of idxKids.values()) list.sort(byName);
    }

    // dir -> { i, v, s (direct photos, videos, bytes), ri, rv, rs (including every subfolder) }
    function computeCounts() {
        const next = new Map();
        if (!App.index.ready) {
            counts = next;
            return;
        }
        const blank = () => ({ i: 0, v: 0, s: 0, ri: 0, rv: 0, rs: 0 });
        for (const e of App.index.items) {
            const d = P.parent(e.path);
            let c = next.get(d);
            if (!c) next.set(d, (c = blank()));
            if (e.type === 'image') c.i++;
            else if (e.type === 'video') c.v++;
            c.s += e.size || 0;
        }
        for (const [d, c] of [...next]) {
            if (!c.i && !c.v) continue;
            let a = d;
            for (;;) {
                let ac = next.get(a);
                if (!ac) next.set(a, (ac = blank()));
                ac.ri += c.i;
                ac.rv += c.v;
                ac.rs += c.s;
                if (a === '') break;
                a = P.parent(a);
            }
        }
        counts = next;
    }

    function compactCount(n) {
        if (n < 10000) return formatCount(n);
        return `${(n / 10000).toFixed(n < 100000 ? 1 : 0).replace(/\.0$/, '')}만`;
    }

    /** 'empty' (no photos/videos, no subfolders), 'nomedia' (only subfolders without photos/videos) or null */
    function emptyKind(p) {
        if (!App.index.ready || !idxKids) return null; // counts not computed yet
        const c = counts.get(p);
        if (c && c.ri + c.rv > 0) return null;
        const kids = kidsOf(p);
        if (kids == null) return null;
        return kids.length ? 'nomedia' : 'empty';
    }

    const CALCULATING = '계산 중…';

    /**
     * One-line folder summary for tooltips: direct photos · videos · subfolders, then the total size of every
     * photo/video inside (subfolders included). '계산 중…' until the workspace index is ready.
     */
    function folderInfo(p) {
        if (!App.index.ready || !idxKids) return CALCULATING;
        const kind = emptyKind(p);
        const kids = kidsOf(p) || [];
        if (kind === 'empty') return '비어 있음';
        if (kind === 'nomedia') return `비어 있음 · 사진·영상 없는 하위 폴더 ${formatCount(kids.length)}개`;
        const c = counts.get(p) || { i: 0, v: 0, s: 0, ri: 0, rv: 0, rs: 0 };
        const head = `사진 ${formatCount(c.i)} · 영상 ${formatCount(c.v)} · 폴더 ${formatCount(kids.length)} · 전체 ${formatBytes(c.rs)}`;
        const deeper = c.ri + c.rv !== c.i + c.v;
        return deeper ? `${head} (하위 포함 ${formatCount(c.ri + c.rv)}개)` : head;
    }

    function countText(p) {
        if (countMode === 'off') return null;
        const c = counts.get(p);
        if (!c) return null;
        const n = countMode === 'recursive' ? c.ri + c.rv : c.i + c.v;
        return { text: n ? compactCount(n) : '', tip: folderInfo(p) || '' };
    }

    function isFolder(p) {
        if (p === '') return true;
        if (folderSet && folderSet.has(p)) return true;
        if ((children.get(P.parent(p)) || []).includes(p)) return true;
        return App.view.get(p)?.kind === 'dir';
    }

    const reindex = App.util.debounce(() => {
        const run = () => {
            rebuildIndexFolders();
            computeCounts();
            rebuild();
            App.bus.emit('nav:counts');
        };
        if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 400 });
        else setTimeout(run, 0);
    }, 180);

    // ---------- Rows ----------
    function buildFilterRows(out) {
        const universe = folderSet || new Set(['', ...[...children.values()].flat()]);
        const matches = new Map();
        for (const f of universe) {
            if (!f) continue;
            const m = App.navMatch.match(P.base(f), filterText);
            if (m) matches.set(f, m.ranges);
        }
        filterMatches = matches.size;
        const include = new Set(['']);
        for (const f of matches.keys()) {
            let a = f;
            while (a && !include.has(a)) {
                include.add(a);
                a = P.parent(a);
            }
        }
        const kids = new Map();
        for (const f of include) {
            if (f === '') continue;
            const parent = P.parent(f);
            if (!kids.has(parent)) kids.set(parent, []);
            kids.get(parent).push(f);
        }
        for (const list of kids.values()) list.sort(byName);
        const walk = (p, depth) => {
            const k = kids.get(p);
            const open = !filterCollapsed.has(p);
            out.push({ key: p, p, depth, open: open && !!k, kids: !!k, match: matches.get(p) || null, ctx: p !== '' && !matches.has(p) });
            if (open && k) for (const c of k) walk(c, depth + 1);
        };
        walk('', 0);
    }

    function buildRows() {
        const out = [];
        if (App.fs.ready && App.state.workspace) {
            if (filterText) {
                buildFilterRows(out);
            } else {
                const walk = (p, depth) => {
                    const kids = kidsOf(p);
                    const open = expanded.has(p);
                    out.push({ key: p, p, depth, open, kids: kids == null ? null : kids.length > 0 });
                    if (open && kids) for (const c of kids) walk(c, depth + 1);
                };
                walk('', 0);
            }
            if (editing && editing.kind === 'new') {
                const pi = out.findIndex((r) => r.p === editing.parent);
                if (pi >= 0) out.splice(pi + 1, 0, { key: NEW_KEY, p: null, phantom: true, depth: out[pi].depth + 1 });
            }
        }
        rows = out;
        rowIndex = new Map();
        rows.forEach((r, i) => rowIndex.set(r.key, i));
        if (treeEl) treeEl.style.height = rows.length * ROW_H + 'px';
        if (!filterText) for (const r of rows) if (r.open && r.kids === null) ensureLoaded(r.p);
        updateFilterUI();
    }

    function rebuild() {
        buildRows();
        scheduleRender();
    }

    const rebuildSoon = App.util.debounce(rebuild, 30);

    // Structural signature: a row element is rebuilt only when one of these changes. Everything else (current,
    // keyboard focus, drop highlight, expanded state, icon, count) is patched in place by patchRow — replacing the
    // element under the cursor in the middle of a drag would make Chrome drop onto a detached node.
    function signature(r) {
        if (r.phantom) return 'phantom';
        const p = r.p;
        if (editing && editing.kind === 'rename' && editing.path === p) return `edit|${p}`;
        return [p, nameOf(p), r.depth, r.match ? r.match.join(',') : '', r.ctx ? 1 : 0].join('|');
    }

    function buildRow(r) {
        if (r.phantom) {
            const row = h('div', { class: 'tree-row phantom editing', role: 'treeitem', 'aria-level': String(r.depth + 1), style: { paddingLeft: 4 + r.depth * INDENT + 'px' } },
                h('span', { class: 'tree-twisty leaf', html: ui.icon('chevron-right', { size: 12 }) }),
                h('span', { class: 'tree-icon', html: ui.icon('folder-plus', { size: 15 }) }),
                buildEditInput(editing.value, '새 폴더 이름'));
            return row;
        }
        const p = r.p;
        const isRoot = p === '';
        const isEdit = editing && editing.kind === 'rename' && editing.path === p;
        const cls = ['tree-row'];
        if (r.ctx) cls.push('ctx');
        if (isEdit) cls.push('editing');
        if (isRoot) cls.push('root');
        const row = h('div', {
            class: cls.join(' '),
            id: rowId(p),
            role: 'treeitem',
            'aria-level': String(r.depth + 1),
            'aria-label': nameOf(p),
            dataset: { path: p },
            draggable: !isRoot && !isEdit ? 'true' : null,
            style: { paddingLeft: 4 + r.depth * INDENT + 'px' },
        });
        row.append(h('span', { class: 'tree-twisty' }), h('span', { class: 'tree-icon' }));
        if (isEdit) {
            row.append(buildEditInput(editing.value, '새 이름'));
            return row;
        }
        const name = h('span', { class: 'tree-name truncate' });
        const text = nameOf(p);
        if (r.match && r.match.length) name.append(App.navMatch.highlight(text, r.match));
        else name.textContent = text;
        row.append(name);
        const actions = h('span', { class: 'tree-actions' },
            noMouseFocus(h('button', { class: 'tree-act', type: 'button', tabindex: '-1', 'data-act': 'new', 'aria-label': '하위 폴더 만들기', 'data-tip': '하위 폴더 만들기', html: ui.icon('folder-plus', { size: 14 }) })),
            noMouseFocus(h('button', { class: 'tree-act', type: 'button', tabindex: '-1', 'data-act': 'menu', 'aria-label': '폴더 메뉴', 'data-tip': '폴더 메뉴', html: ui.icon('more', { size: 14 }) })));
        row.append(actions);
        return row;
    }

    /** Apply the dynamic state of a row without replacing any of its elements */
    function patchRow(el, r) {
        if (r.phantom) return;
        const p = r.p;
        const cur = isCurrent(p);
        el.classList.toggle('current', cur);
        el.classList.toggle('on-path', !cur && isOnPath(p));
        el.classList.toggle('kbd-focus', focusPath === p);
        el.classList.toggle('drop-target', dropPath === p);
        el.classList.toggle('flash', flashPath === p);
        el.setAttribute('aria-selected', cur ? 'true' : 'false');
        if (r.kids) el.setAttribute('aria-expanded', String(!!r.open));
        else el.removeAttribute('aria-expanded');
        const tw = el.firstElementChild;
        const spinning = r.open && r.kids === null;
        tw.classList.toggle('leaf', r.kids === false);
        tw.classList.toggle('open', !!r.open && r.kids !== false);
        const mode = spinning ? 'spin' : 'chev';
        if (tw.dataset.mode !== mode) {
            tw.dataset.mode = mode;
            tw.innerHTML = spinning ? '<span class="spinner"></span>' : ui.icon('chevron-right', { size: 12 });
        }
        const ic = tw.nextElementSibling;
        const iconName = p === '' ? 'home' : r.open && r.kids ? 'folder-open' : 'folder';
        if (ic.dataset.icon !== iconName) {
            ic.dataset.icon = iconName;
            ic.innerHTML = ui.icon(iconName, { size: 15 });
        }
        const empty = emptyKind(p);
        el.classList.toggle('is-empty', !!empty);
        if (el.classList.contains('editing')) {
            delete el.dataset.tip;
            return;
        }
        // Explorer-style summary when hovering the row (direct counts, folders, total size incl. subfolders)
        const info = folderInfo(p);
        if (el.dataset.tip !== info) el.dataset.tip = info;
        // Empty folders say so right in the row (dimmed), where the count would be
        let tag = el.querySelector(':scope > .tree-empty-tag');
        if (empty && p !== '') {
            if (!tag) {
                tag = h('span', { class: 'tree-empty-tag', text: '비어 있음' });
                el.append(tag);
            }
        } else if (tag) tag.remove();
        let cnt = el.querySelector(':scope > .tree-count');
        const c = empty ? null : countText(p);
        if (c && c.text) {
            if (!cnt) {
                cnt = h('span', { class: 'tree-count' });
                el.append(cnt);
            }
            if (cnt.textContent !== c.text) cnt.textContent = c.text;
        } else if (cnt) cnt.remove();
    }

    // ---------- Virtualized rendering ----------
    let renderPending = false;
    function scheduleRender() {
        if (renderPending) return;
        renderPending = true;
        requestAnimationFrame(() => {
            renderPending = false;
            renderWindow();
        });
    }

    function renderWindow() {
        if (!treeEl || !scrollEl) return;
        const sr = scrollEl.getBoundingClientRect();
        const tr = treeEl.getBoundingClientRect();
        const viewTop = sr.top - tr.top;
        const viewH = scrollEl.clientHeight || 600;
        const first = Math.max(0, Math.floor(viewTop / ROW_H) - BUFFER);
        const last = Math.min(rows.length, Math.ceil((viewTop + viewH) / ROW_H) + BUFFER);
        const wanted = new Set();
        for (let i = first; i < last; i++) {
            const r = rows[i];
            wanted.add(r.key);
            const sig = signature(r);
            let rec = rendered.get(r.key);
            if (!rec || rec.sig !== sig) {
                const el = buildRow(r);
                if (rec) {
                    if (rec.el === dragSrcEl) dragSrcEl = el;
                    rec.el.replaceWith(el);
                } else treeEl.append(el);
                rec = { el, sig };
                rendered.set(r.key, rec);
            }
            const y = `translateY(${i * ROW_H}px)`;
            if (rec.el.style.transform !== y) rec.el.style.transform = y;
            patchRow(rec.el, r);
        }
        for (const [key, rec] of rendered) {
            if (wanted.has(key)) continue;
            if (rec.el === dragSrcEl) continue; // keep the drag source alive so 'dragend' still reaches us
            if (editing && rec.el.contains(editing.input) && key === (editing.kind === 'new' ? NEW_KEY : editing.path)) continue;
            rec.el.remove();
            rendered.delete(key);
        }
        if (editing && editing.input && editing.focusPending) {
            editing.focusPending = false;
            editing.input.focus();
            const v = editing.input.value;
            editing.input.setSelectionRange(0, v.length);
        }
        const activeId = focusPath != null && rendered.has(focusPath) ? rowId(focusPath) : null;
        for (const el of [treeEl, filterInput]) {
            if (!el) continue;
            if (document.activeElement === el && activeId) el.setAttribute('aria-activedescendant', activeId);
            else el.removeAttribute('aria-activedescendant');
        }
        if (emptyEl) emptyEl.hidden = !(filterText && filterMatches === 0);
    }

    function renderNow() {
        buildRows();
        renderWindow();
    }

    function ensureVisible(i) {
        if (i == null || i < 0 || !scrollEl || !treeEl) return;
        const sr = scrollEl.getBoundingClientRect();
        const tr = treeEl.getBoundingClientRect();
        const stickyBottom = treeStickyEl ? Math.max(0, treeStickyEl.getBoundingClientRect().bottom - sr.top) : 0;
        const rowTop = tr.top - sr.top + i * ROW_H;
        if (rowTop < stickyBottom + 2) scrollEl.scrollTop -= stickyBottom + 2 - rowTop + 4;
        else if (rowTop + ROW_H > scrollEl.clientHeight - 2) scrollEl.scrollTop += rowTop + ROW_H - scrollEl.clientHeight + 6;
    }

    function flash(p) {
        flashPath = p;
        setTimeout(() => {
            if (flashPath === p) {
                flashPath = null;
                scheduleRender();
            }
        }, 1400);
    }

    // ---------- Expand / collapse ----------
    async function toggle(p, force) {
        if (filterText) {
            const open = force ?? filterCollapsed.has(p);
            if (open) filterCollapsed.delete(p);
            else filterCollapsed.add(p);
            if (!open && focusPath && focusPath !== p && P.isInside(focusPath, p)) focusPath = p;
            rebuild();
            return;
        }
        const open = force ?? !expanded.has(p);
        if (open) {
            expanded.add(p);
            rebuild();
            if (!children.has(p)) {
                await loadChildren(p);
                rebuild();
            }
        } else {
            if (!expanded.has(p)) return;
            expanded.delete(p);
            if (focusPath && focusPath !== p && P.isInside(focusPath, p)) focusPath = p;
            rebuild();
        }
        saveExpanded();
    }

    function collapseAll() {
        expanded = new Set(['']);
        filterCollapsed.clear();
        saveExpanded();
        rebuild();
        if (scrollEl) scrollEl.scrollTop = 0;
    }

    function expandSubtree(p) {
        if (!idxKids) {
            toggle(p, true);
            ui.toast('라이브러리 색인이 끝나면 하위 폴더를 한꺼번에 펼칠 수 있어요', { type: 'info' });
            return;
        }
        let n = 0;
        const queue = [p];
        while (queue.length && n < 600) {
            const d = queue.shift();
            const kids = idxKids.get(d) || [];
            if (!kids.length) continue;
            expanded.add(d);
            n++;
            queue.push(...kids);
        }
        saveExpanded();
        rebuild();
        if (n >= 600) ui.toast('폴더가 아주 많아서 일부만 펼쳤어요', { type: 'info' });
    }

    function collapseSubtree(p) {
        for (const d of [...expanded]) if (P.isInside(d, p) && d !== '') expanded.delete(d);
        if (p === '') expanded = new Set(['']);
        if (focusPath && P.isInside(focusPath, p) && focusPath !== p) focusPath = p;
        saveExpanded();
        rebuild();
    }

    // ---------- Open / cursor ----------
    function openFolder(p) {
        focusPath = p;
        App.topbar?.clearSearch?.();
        if (isCurrent(p)) {
            scheduleRender();
            return;
        }
        App.nav.go(p);
    }

    function cursorIndex() {
        if (focusPath != null && rowIndex.has(focusPath)) return rowIndex.get(focusPath);
        const cwd = App.state.cwd ?? '';
        if (!filterText && rowIndex.has(cwd)) return rowIndex.get(cwd);
        if (filterText) {
            const i = rows.findIndex((r) => r.match);
            if (i >= 0) return i;
        }
        return rows.length ? 0 : -1;
    }

    function setCursor(i) {
        if (!rows.length) return;
        i = App.util.clamp(i, 0, rows.length - 1);
        if (rows[i].phantom) i = App.util.clamp(i + 1, 0, rows.length - 1);
        focusPath = rows[i].p;
        ensureVisible(i);
        renderWindow();
    }

    function move(delta) {
        const i = cursorIndex();
        setCursor(i < 0 ? 0 : i + delta);
    }

    function pageSize() {
        return Math.max(1, Math.floor((scrollEl?.clientHeight || 300) / ROW_H) - 2);
    }

    function focusTree() {
        if (!App.fs.ready || !treeEl) return;
        if (App.layout && !App.layout.isVisible('sidebar')) App.layout.setPanel('sidebar', true);
        if (treeSection && treeSection.classList.contains('collapsed')) {
            toggleSection('tree', treeSection);
            buildRows();
        }
        if (focusPath == null || !rowIndex.has(focusPath)) {
            const i = cursorIndex();
            focusPath = i >= 0 ? rows[i].p : null;
        }
        treeEl.tabIndex = 0;
        treeEl.focus({ preventScroll: true });
        ensureVisible(rowIndex.get(focusPath));
        renderWindow();
    }

    function focusGallery() {
        const g = document.getElementById('gallery-scroll');
        if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
        g?.focus({ preventScroll: true });
    }

    function focusFilter() {
        if (!App.fs.ready || !filterInput) return;
        if (App.layout && !App.layout.isVisible('sidebar')) App.layout.setPanel('sidebar', true);
        const sec = treeSection;
        if (sec && sec.classList.contains('collapsed')) toggleSection('tree', sec);
        filterInput.focus();
        filterInput.select();
    }

    // ---------- Filter ----------
    function setFilter(text) {
        const next = (text || '').trim();
        if (next === filterText) return;
        filterText = next;
        filterCollapsed.clear();
        buildRows();
        if (filterText) {
            const i = rows.findIndex((r) => r.match);
            focusPath = i >= 0 ? rows[i].p : null;
            if (scrollEl && treeSection) {
                const top = treeSection.offsetTop;
                if (scrollEl.scrollTop > top) scrollEl.scrollTop = top;
            }
        } else {
            focusPath = null;
            const cwd = App.state.cwd ?? '';
            tree.reveal(cwd);
        }
        renderWindow();
    }

    function clearFilter() {
        if (filterInput) filterInput.value = '';
        setFilter('');
    }

    function updateFilterUI() {
        if (!filterInput) return;
        const has = !!filterInput.value;
        filterClear.hidden = !has;
        if (!filterText) {
            filterInfo.hidden = true;
            return;
        }
        filterInfo.hidden = false;
        const partial = !folderSet;
        filterInfo.textContent = filterMatches
            ? `폴더 ${formatCount(filterMatches)}개 찾음${partial ? ' · 색인 중이라 일부만 보여요' : ''}`
            : partial ? '색인이 끝나면 모든 폴더에서 찾아요' : '';
        filterInfo.hidden = !filterInfo.textContent;
        if (emptyEl) {
            emptyEl.querySelector('.tree-empty-title').textContent = `‘${filterText}’${App.navMatch.josa(filterText, '와/과')} 맞는 폴더가 없어요`;
        }
    }

    // ---------- Inline editing (new folder / rename) ----------
    function buildEditInput(value, label) {
        const wrap = h('span', { class: 'tree-edit-wrap' });
        const input = h('input', { class: 'tree-edit', type: 'text', value, spellcheck: 'false', autocomplete: 'off', 'aria-label': label });
        const err = h('span', { class: 'tree-edit-error', role: 'alert', hidden: true });
        wrap.append(input, err);
        input.addEventListener('keydown', onEditKey);
        input.addEventListener('input', () => {
            if (!editing || editing.input !== input) return;
            editing.value = input.value;
            const msg = input.value.trim() ? App.fs.validateName(input.value.trim()) : null;
            showEditError(msg);
        });
        input.addEventListener('blur', () => {
            if (editing && editing.input === input && !editing.busy) commitEdit({ fromBlur: true });
        });
        for (const evt of ['mousedown', 'click', 'dblclick', 'dragstart']) input.addEventListener(evt, (e) => e.stopPropagation());
        if (editing) {
            editing.input = input;
            editing.errEl = err;
        }
        return wrap;
    }

    function showEditError(msg) {
        if (!editing || !editing.errEl) return;
        editing.errEl.textContent = msg || '';
        editing.errEl.hidden = !msg;
        editing.input.classList.toggle('invalid', !!msg);
    }

    function onEditKey(e) {
        e.stopPropagation();
        if (e.isComposing) return;
        if (e.key === 'Enter') {
            e.preventDefault();
            commitEdit();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelEdit();
        }
    }

    function finishEdit(focusBack) {
        const ed = editing;
        editing = null;
        renderNow();
        if (focusBack && ed && ed.returnFocus) focusTree();
    }

    function cancelEdit() {
        if (!editing) return;
        finishEdit(true);
    }

    async function commitEdit({ fromBlur = false } = {}) {
        const ed = editing;
        if (!ed || ed.busy || !ed.input) return;
        const value = ed.input.value.trim();
        if (ed.kind === 'rename' && value === P.base(ed.path)) return finishEdit(!fromBlur);
        const err = App.fs.validateName(value);
        if (err) {
            if (fromBlur) {
                finishEdit(false);
                ui.toast(`${err} — ${ed.kind === 'new' ? '폴더를 만들지 않았어요' : '이름을 그대로 뒀어요'}`, { type: 'warning' });
            } else {
                showEditError(err);
                ed.input.focus();
            }
            return;
        }
        ed.busy = true;
        try {
            let p;
            if (ed.kind === 'new') {
                p = await App.fs.mkdir(ed.parent, value);
                await loadChildren(ed.parent, { force: true });
            } else {
                p = await App.fs.rename(ed.path, value);
            }
            editing = null;
            focusPath = p;
            flash(p);
            renderNow();
            ensureVisible(rowIndex.get(p));
            if (!fromBlur && ed.returnFocus) focusTree();
        } catch (e) {
            ed.busy = false;
            if (fromBlur || editing !== ed || !ed.input.isConnected) {
                if (editing === ed) finishEdit(false);
                ui.toast(e.message || String(e), { type: 'error' });
            } else {
                showEditError(e.message || String(e));
                ed.input.focus();
            }
        }
    }

    function treeVisible() {
        return !!treeEl && treeEl.isConnected && (!App.layout || App.layout.isVisible('sidebar')) && !treeSection.classList.contains('collapsed');
    }

    async function startNewFolder(parent = App.state.cwd ?? '') {
        if (!App.fs.ready) return;
        if (!treeVisible()) {
            const name = await ui.prompt({ title: '새 폴더', message: parent ? `‘${nameOf(parent)}’ 안에 만들어요` : '', value: await App.fs.uniqueName(parent, '새 폴더', { isDir: true }), okLabel: '만들기', validate: (v) => App.fs.validateName(v) });
            if (!name) return;
            try {
                await App.fs.mkdir(parent, name);
            } catch (e) {
                ui.toast(e.message, { type: 'error' });
            }
            return;
        }
        if (editing) finishEdit(false);
        if (filterText) clearFilter();
        const returnFocus = document.activeElement === treeEl;
        expanded.add(parent);
        saveExpanded();
        await tree.reveal(parent, { scroll: false });
        if (!children.has(parent)) await loadChildren(parent);
        const value = await App.fs.uniqueName(parent, '새 폴더', { isDir: true });
        editing = { kind: 'new', parent, value, returnFocus, focusPending: true };
        buildRows();
        ensureVisible(rowIndex.get(NEW_KEY));
        renderWindow();
    }

    async function startRename(p, { inline = true } = {}) {
        if (!App.fs.ready || p == null) return;
        if (p === '') {
            ui.toast('작업 폴더 자체의 이름은 탐색기에서 바꿔 주세요', { type: 'info' });
            return;
        }
        if (!inline || !treeVisible()) {
            const name = await ui.prompt({ title: '폴더 이름 바꾸기', value: nameOf(p), okLabel: '바꾸기', validate: (v) => App.fs.validateName(v) });
            if (!name || name === P.base(p)) return;
            try {
                await App.fs.rename(p, name);
            } catch (e) {
                ui.toast(e.message, { type: 'error' });
            }
            return;
        }
        if (editing) finishEdit(false);
        if (filterText && !rowIndex.has(p)) clearFilter();
        const returnFocus = document.activeElement === treeEl;
        if (!filterText) await tree.reveal(p, { scroll: false });
        editing = { kind: 'rename', path: p, value: nameOf(p), returnFocus, focusPending: true };
        buildRows();
        ensureVisible(rowIndex.get(p));
        renderWindow();
    }

    async function trashFolder(p) {
        if (!App.fs.ready || p == null) return;
        if (p === '') {
            ui.toast('작업 폴더 자체는 휴지통으로 옮길 수 없어요', { type: 'info' });
            return;
        }
        const c = counts.get(p);
        const kids = kidsOf(p);
        const empty = emptyKind(p) === 'empty';
        if (!empty) {
            const parts = [];
            if (c?.ri) parts.push(`사진 ${formatCount(c.ri)}개`);
            if (c?.rv) parts.push(`영상 ${formatCount(c.rv)}개`);
            // every part ends in '개', so the subject particle is always '가' ("사진 3개와 영상 1개(12 MB)가 …")
            const size = c?.rs ? `(${formatBytes(c.rs)})` : '';
            const inside = parts.length ? `${parts.join('와 ')}${size}가 함께 옮겨져요. ` : kids && kids.length ? `하위 폴더 ${formatCount(kids.length)}개가 함께 옮겨져요. ` : '';
            const ok = await ui.confirm({
                title: '폴더를 휴지통으로 옮길까요?',
                message: `‘${nameOf(p)}’ 폴더를 휴지통으로 옮겨요. ${inside}휴지통에서 언제든 되살릴 수 있어요.`,
                okLabel: '휴지통으로 이동',
                danger: true,
            });
            if (!ok) return;
        }
        // Keep the keyboard cursor nearby: next sibling (or the row above) instead of jumping to the top
        const i = rowIndex.get(p);
        if (i != null && focusPath != null && P.isInside(focusPath, p)) {
            let next = null;
            for (let j = i + 1; j < rows.length; j++) {
                if (rows[j].depth <= rows[i].depth) {
                    next = rows[j].p;
                    break;
                }
            }
            focusPath = next ?? (i > 0 ? rows[i - 1].p : P.parent(p));
        }
        // Core pushes the single undo entry (undo restores, redo trashes it again); the toast is ours
        const name = nameOf(p);
        try {
            const ids = await App.fs.trash([p], { silent: true, label: `‘${name}’ 폴더 삭제` });
            if (!ids.length) return;
            ui.toast(`‘${name}’ 폴더를 휴지통으로 옮겼어요`, { type: 'success', action: { label: '실행 취소', run: () => App.undo.undo() } });
        } catch (e) {
            ui.toast(`휴지통으로 옮기지 못했어요: ${e.message || e}`, { type: 'error' });
        }
    }

    async function refreshTree(p = '') {
        const dirs = [...children.keys()].filter((d) => P.isInside(d, p));
        if (!dirs.includes(p)) dirs.push(p);
        await Promise.all(dirs.map((d) => loadChildren(d, { force: true })));
        rebuild();
        const cwd = App.state.cwd;
        if (cwd != null && P.isInside(cwd, p) && App.view.source.type === 'folder') App.nav.reload();
        ui.toast('폴더 목록을 새로 읽었어요', { type: 'success', duration: 1600 });
    }

    // ---------- Context menu ----------
    function menuItems(p) {
        const isRoot = p === '';
        const fav = App.navFavorites;
        const kids = kidsOf(p);
        const items = [{ header: nameOf(p) }, { label: '열기', icon: 'folder-open', hint: 'Enter', action: () => openFolder(p) }];
        if (App.navSubfolders) items.push({ label: '하위 폴더까지 모두 보기', icon: 'layers', action: () => App.navSubfolders.openRecursive(p) });
        items.push(
            '-',
            { label: '새 폴더', icon: 'folder-plus', command: 'nav.newSubfolder', args: { path: p } },
            { label: '이름 바꾸기', icon: 'edit', command: 'nav.renameFolder', args: { path: p }, hint: 'F2', disabled: isRoot },
        );
        if (App.commands.get('organize.unwrap')) {
            items.push({ label: '폴더 풀기', icon: 'folder-output', disabled: isRoot, action: () => App.commands.run('organize.unwrap', { paths: [p] }) });
        }
        items.push('-');
        if (fav) items.push({ label: fav.has(p) ? '즐겨찾기에서 빼기' : '즐겨찾기에 추가', icon: 'star', command: 'nav.favoriteToggle', args: { path: p }, hint: App.commands.displayCombo('Mod+D') });
        if (typeof App.fs.backend?.reveal === 'function') items.push({ label: '탐색기에서 보기', icon: 'external', command: 'nav.revealFolder', args: { path: p } });
        if (!filterText && kids && kids.length) {
            items.push({ label: '하위 폴더 모두 펼치기', icon: 'chevron-down', action: () => expandSubtree(p) });
            if (expanded.has(p)) items.push({ label: '하위 폴더 모두 접기', icon: 'chevron-up', action: () => collapseSubtree(p) });
        }
        items.push({ label: '새로 고침', icon: 'refresh', command: 'nav.refreshTree', args: { path: p } });
        if (!isRoot) items.push('-', { label: '휴지통으로 이동', icon: 'trash', danger: true, command: 'nav.trashFolder', args: { path: p }, hint: 'Del' });
        return items;
    }

    function openMenu(p, pos) {
        if (!App.fs.ready) return;
        ui.menu(menuItems(p), pos);
    }

    /** Keyboard (Menu key / Shift+F10): open the folder menu under the cursor row, then return to the tree */
    function openRowMenu(i) {
        const r = rows[i];
        if (!r) return;
        focusPath = r.p;
        ensureVisible(i);
        renderWindow();
        const el = rendered.get(r.key)?.el;
        const box = el ? el.querySelector('.tree-name') || el : null;
        const rect = box ? box.getBoundingClientRect() : null;
        const pos = rect ? { x: Math.round(rect.left + 12), y: Math.round(rect.bottom + 2) } : { anchor: treeEl, align: 'start' };
        openMenu(r.p, pos);
        // Keyboard users start on the first item (↑↓ Enter, Esc closes and the tree keeps focus)
        document.querySelector('.menu .menu-item:not(.disabled)')?.classList.add('active');
    }

    function treeOptionsMenu(anchor) {
        const setMode = (m) => {
            countMode = m;
            App.settings.set('tree.counts', m);
            rebuild();
            App.bus.emit('nav:counts');
        };
        ui.menu([
            { header: '폴더 옆 개수' },
            { label: '바로 안의 사진·영상', checked: countMode === 'direct', action: () => setMode('direct') },
            { label: '하위 폴더까지 합친 개수', checked: countMode === 'recursive', action: () => setMode('recursive') },
            { label: '표시 안 함', checked: countMode === 'off', action: () => setMode('off') },
            '-',
            { label: '폴더 찾기', icon: 'search', command: 'nav.filterTree' },
            { label: '현재 폴더 찾아가기', icon: 'eye', action: () => { clearFilter(); tree.reveal(App.state.cwd ?? ''); } },
            { label: '폴더 모두 접기', icon: iconName('list-collapse'), command: 'nav.collapseTree' },
            { label: '새로 고침', icon: 'refresh', command: 'nav.refreshTree', args: { path: '' } },
        ], { anchor, align: 'end' });
    }

    // ---------- Keyboard ----------
    function handleNavKey(e, inTree) {
        const mod = e.ctrlKey || e.metaKey;
        const i = cursorIndex();
        const r = rows[i];
        switch (e.key) {
            case 'ArrowDown':
                if (mod || e.altKey) return false;
                move(1);
                return true;
            case 'ArrowUp':
                if (mod || e.altKey) return false;
                move(-1);
                return true;
            case 'PageDown':
                move(pageSize());
                return true;
            case 'PageUp':
                move(-pageSize());
                return true;
            case 'Home':
                if (!inTree) return false;
                setCursor(0);
                return true;
            case 'End':
                if (!inTree) return false;
                setCursor(rows.length - 1);
                return true;
            case 'ArrowRight':
                if (!inTree || mod || e.altKey || !r) return false;
                if (r.kids === false) return true;
                if (!r.open) toggle(r.p, true);
                else if (rows[i + 1] && rows[i + 1].depth > r.depth) setCursor(i + 1);
                return true;
            case 'ArrowLeft':
                if (!inTree || mod || e.altKey || !r) return false;
                if (r.open && r.kids !== false && r.p !== '') toggle(r.p, false);
                else if (r.depth > 0) {
                    const pi = rowIndex.get(P.parent(r.p));
                    if (pi != null) setCursor(pi);
                }
                return true;
            case 'Enter':
                if (mod || e.altKey) return false;
                if (r) openFolder(r.p);
                return true;
            case ' ':
                if (!inTree) return false;
                if (r) openFolder(r.p);
                return true;
            case 'F2':
                if (r && r.p) startRename(r.p);
                return true;
            case 'Delete':
                if (!inTree) return false;
                if (r && r.p) trashFolder(r.p);
                return true;
            case 'ContextMenu':
            case 'F10':
                // Menu key / Shift+F10: the folder menu for the row under the cursor
                if (e.key === 'F10' && (!e.shiftKey || mod || e.altKey)) return false;
                kbdMenuAt = performance.now();
                if (r && !r.phantom) openRowMenu(i);
                return true;
            default:
                break;
        }
        if (!inTree) return false;
        // Physical key, so shortcuts also work while the Korean IME is in 한글 mode
        const k = /^Key[A-Z]$/.test(e.code || '') ? e.code.slice(3).toLowerCase() : e.key.length === 1 ? e.key.toLowerCase() : e.key;
        if (e.altKey && !mod && !e.shiftKey && k === 'n') {
            if (r) startNewFolder(r.p); // same as the nav.newSubfolder command, but under the tree cursor
            return true;
        }
        if (mod && !e.shiftKey && !e.altKey && k === 'd') {
            if (r) App.commands.run('nav.favoriteToggle', { path: r.p });
            return true;
        }
        if (e.key.length === 1 && !mod && !e.altKey && /\S/.test(e.key)) {
            filterInput.focus();
            filterInput.value += e.key;
            setFilter(filterInput.value);
            updateFilterUI();
            return true;
        }
        return false;
    }

    function onTreeKey(e) {
        if (e.isComposing || editing || App.layers.top() !== 'main') return;
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            if (filterText) clearFilter();
            else focusGallery();
            return;
        }
        if (handleNavKey(e, true)) {
            e.preventDefault();
            e.stopPropagation();
        }
    }

    function onFilterKey(e) {
        if (e.isComposing) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            if (filterInput.value) clearFilter();
            else focusGallery();
            return;
        }
        if (e.key === 'Tab' && !e.shiftKey && rows.length) {
            e.preventDefault();
            e.stopPropagation();
            focusTree();
            return;
        }
        if (handleNavKey(e, false)) {
            e.preventDefault();
            e.stopPropagation();
        }
    }

    // ---------- Drag & drop ----------
    function rowFromEvent(e) {
        const row = e.target.closest?.('.tree-row');
        return row && !row.classList.contains('phantom') && treeEl.contains(row) ? row : null;
    }

    function setDrop(p) {
        if (dropPath === p) return;
        dropPath = p;
        scheduleRender();
    }

    function endDrag() {
        if (dragSrcEl) dragSrcEl.classList.remove('dragging');
        dragSrcEl = null;
        setDrop(null);
        spring.cancel();
    }

    function bindDnd() {
        treeEl.addEventListener('dragstart', (e) => {
            const row = rowFromEvent(e);
            if (!row || editing) return;
            const p = row.dataset.path;
            if (p === '') {
                e.preventDefault();
                return;
            }
            e.dataTransfer.effectAllowed = 'copyMove';
            e.dataTransfer.setData(App.navDnd.TYPE, JSON.stringify([p]));
            e.dataTransfer.setData('text/plain', p);
            const ghost = h('div', { class: 'drag-ghost nav-ghost', html: `${ui.icon('folder', { size: 13 })}<span>${escapeHtml(nameOf(p))}</span>` });
            document.body.append(ghost);
            e.dataTransfer.setDragImage(ghost, 12, 12);
            setTimeout(() => ghost.remove(), 0);
            dragSrcEl = row;
            requestAnimationFrame(() => row.classList.add('dragging'));
        });
        treeEl.addEventListener('dragend', endDrag);
        treeEl.addEventListener('dragover', (e) => {
            App.navDnd.autoScroll(e, scrollEl);
            const row = rowFromEvent(e);
            if (!row) {
                setDrop(null);
                spring.cancel();
                return;
            }
            const p = row.dataset.path;
            const v = App.navDnd.over(e, p, { label: nameOf(p) });
            if (v.silent) return;
            setDrop(v.ok ? p : null);
            const r = rows[rowIndex.get(p)];
            if (r && r.kids !== false && !r.open) spring.arm(p, () => toggle(p, true));
            else spring.cancel();
        });
        treeEl.addEventListener('dragleave', (e) => {
            if (!treeEl.contains(e.relatedTarget)) {
                setDrop(null);
                spring.cancel();
            }
        });
        treeEl.addEventListener('drop', (e) => {
            const row = rowFromEvent(e);
            spring.cancel();
            setDrop(null);
            if (!row) return;
            const p = row.dataset.path;
            const v = App.navDnd.verdict(e, p);
            if (!v.ok) return;
            const draggedDirs = (App.navDnd.paths() || []).some((x) => isFolder(x));
            App.navDnd.drop(e, p, { label: nameOf(p) }).then((res) => {
                // Show where dropped folders ended up
                if (res && res.length && draggedDirs && !filterText && !expanded.has(p)) toggle(p, true);
            });
        });
        // A detached drag source never receives 'dragend' — the next mouse move means the drag is over anyway
        document.addEventListener('mousemove', () => {
            if (dragSrcEl) endDrag();
        });
        scrollEl.addEventListener('dragover', (e) => {
            if (!treeEl.contains(e.target)) App.navDnd.autoScroll(e, scrollEl);
        });
    }

    // ---------- Sections ----------
    function collapsedKey(id) {
        return `sidebar.collapsed.${id}`;
    }

    function toggleSection(id, el) {
        const collapsed = !el.classList.contains('collapsed');
        el.classList.toggle('collapsed', collapsed);
        el.querySelector('.sb-head-title')?.setAttribute('aria-expanded', String(!collapsed));
        App.settings.set(collapsedKey(id), collapsed);
        if (id === 'tree') rebuild();
        else scheduleRender();
    }

    function sectionHead(id, title, actions, collapsible = true) {
        const head = h('div', { class: 'panel-section-head sb-head' });
        const titleBtn = noMouseFocus(h('button', { class: 'sb-head-title', type: 'button', 'aria-expanded': 'true', html: `${ui.icon('chevron-down', { size: 12, class: 'sb-head-chev' })}<span>${escapeHtml(title)}</span>` }));
        if (!collapsible) titleBtn.disabled = true;
        head.append(titleBtn, h('span', { class: 'grow' }));
        const acts = h('span', { class: 'sb-head-actions' });
        for (const a of actions || []) if (a) acts.append(noMouseFocus(a));
        head.append(acts);
        titleBtn.addEventListener('click', () => {
            if (collapsible) toggleSection(id, head.parentElement.classList.contains('tree-sticky') ? treeSection : head.parentElement);
        });
        return head;
    }

    function headAction(iconName, tip, onClick, keys) {
        const b = h('button', { class: 'btn ghost icon sm sb-act', type: 'button', 'aria-label': tip, 'data-tip': tip, html: icon(iconName, { size: 14 }) });
        if (keys) b.dataset.tipKeys = keys;
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick(e, b);
        });
        return b;
    }

    function renderSection(s, el) {
        const body = el.querySelector(':scope > .panel-section-body');
        body.innerHTML = '';
        try {
            s.render(body, el);
        } catch (e) {
            console.error('[sidebar] section failed', s.id, e);
        }
    }

    function renderSections() {
        if (!sectionsEl) return;
        sectionsEl.innerHTML = '';
        if (!App.fs.ready) return;
        for (const s of sections) {
            const collapsible = s.collapsible !== false;
            let actions = [];
            try {
                actions = s.actions ? s.actions() : [];
            } catch (e) {
                console.error('[sidebar] section actions failed', s.id, e);
            }
            const el = h('div', { class: 'panel-section sb-section', dataset: { section: s.id } }, sectionHead(s.id, s.title, actions, collapsible), h('div', { class: 'panel-section-body' }));
            if (collapsible && App.settings.get(collapsedKey(s.id), false)) {
                el.classList.add('collapsed');
                el.querySelector('.sb-head-title').setAttribute('aria-expanded', 'false');
            }
            sectionsEl.append(el);
            renderSection(s, el);
        }
        scheduleRender();
    }

    const sidebar = {
        addSection(section) {
            const i = sections.findIndex((s) => s.id === section.id);
            if (i >= 0) sections.splice(i, 1);
            sections.push(section);
            sections.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
            renderSections();
        },
        refreshSection(id) {
            const s = sections.find((x) => x.id === id);
            const el = sectionsEl?.querySelector(`.sb-section[data-section="${CSS.escape(id)}"]`);
            if (s && el) renderSection(s, el);
            else renderSections();
            scheduleRender();
        },
        get scrollEl() {
            return scrollEl;
        },
    };

    // ---------- Workspace switcher ----------
    async function workspaceMenu(anchor) {
        const recents = await App.workspace.getRecents();
        ui.menu([
            { header: '최근 작업 폴더' },
            ...recents.slice(0, 6).map((r) => ({ label: r.name, icon: 'folder', checked: r.name === App.state.workspace?.name, action: () => App.workspace.openHandle(r.handle) })),
            '-',
            { label: '다른 폴더 열기…', icon: 'folder-open', command: 'workspace.open' },
            { label: '작업 폴더 닫기', icon: 'x', command: 'workspace.close' },
        ], { anchor });
    }

    // ---------- Public tree API ----------
    const tree = {
        children,

        async reveal(p, { scroll = true } = {}) {
            if (!App.fs.ready || p == null) return;
            const segs = P.segments(p);
            let changed = false;
            for (let i = 0; i < segs.length; i++) {
                const anc = segs.slice(0, i).join('/');
                if (!expanded.has(anc)) {
                    expanded.add(anc);
                    changed = true;
                }
                if (!children.has(anc)) {
                    if (idxKids) loadChildren(anc).then(rebuildSoon);
                    else await loadChildren(anc);
                }
            }
            if (changed) saveExpanded();
            buildRows();
            if (scroll && !filterText) ensureVisible(rowIndex.get(p));
            scheduleRender();
        },

        async refresh(dir) {
            if (!children.has(dir)) return;
            await loadChildren(dir, { force: true });
            rebuild();
        },

        focus: focusTree,
        focusFilter,
        filter(text) {
            if (filterInput) filterInput.value = text || '';
            setFilter(text || '');
        },
        clearFilter,
        countsFor: (p) => counts.get(p) || null,
        folderInfo,
        emptyKind,
        /** true / false / null (not known yet) */
        hasKids(p) {
            const k = kidsOf(p);
            return k == null ? null : k.length > 0;
        },
        countText,
        isFolder,
        menuItems,
        openMenu,
        openFolder,
        startNewFolder,
        startRename,
        trashFolder,
        get rows() {
            return rows;
        },
    };

    // ---------- Commands ----------
    const treeFocused = () => !!treeEl && document.activeElement === treeEl;
    const target = (args) => (args && typeof args.path === 'string' ? args.path : treeFocused() && focusPath != null ? focusPath : App.state.cwd ?? '');
    const ready = () => App.fs.ready;

    App.commands.register({ id: 'nav.focusTree', title: '폴더 트리로 이동 (다시 누르면 갤러리)', group: '이동', icon: 'folder', keys: ['Mod+Shift+E'], allowInInput: ['Mod+Shift+E'], when: ready, run: () => (treeFocused() ? focusGallery() : focusTree()) });
    App.commands.register({ id: 'nav.filterTree', title: '폴더 찾기 (초성 검색)', group: '이동', icon: 'search', keys: ['Mod+Shift+F'], allowInInput: true, when: ready, run: () => focusFilter() });
    App.commands.register({ id: 'nav.newSubfolder', title: '하위 폴더 만들기 (폴더 트리)', group: '파일', icon: 'folder-plus', keys: ['Alt+N'], when: ready, run: (a) => startNewFolder(target(a)) });
    App.commands.register({ id: 'nav.renameFolder', title: '폴더 이름 바꾸기', group: '파일', icon: 'edit', when: ready, run: (a) => startRename(target(a), { inline: a?.inline !== false }) });
    App.commands.register({ id: 'nav.trashFolder', title: '폴더를 휴지통으로 이동', group: '파일', icon: 'trash', when: ready, run: (a) => trashFolder(target(a)) });
    App.commands.register({
        id: 'nav.revealFolder',
        title: '탐색기에서 보기',
        group: '파일',
        icon: 'external',
        when: () => App.fs.ready && typeof App.fs.backend?.reveal === 'function',
        run: async (a) => {
            try {
                await App.fs.backend.reveal(target(a));
            } catch (e) {
                ui.toast(`탐색기를 열지 못했어요: ${e.message || e}`, { type: 'error' });
            }
        },
    });
    App.commands.register({ id: 'nav.refreshTree', title: '폴더 트리 새로 고침', group: '이동', icon: 'refresh', when: ready, run: (a) => refreshTree(a && typeof a.path === 'string' ? a.path : '') });
    App.commands.register({ id: 'nav.collapseTree', title: '폴더 모두 접기', group: '이동', icon: iconName('list-collapse'), when: ready, run: () => collapseAll() });
    App.commands.register({
        id: 'nav.toggleCounts',
        title: '폴더 옆 사진·영상 개수 켜고 끄기',
        group: '보기',
        icon: 'hash',
        run: () => {
            countMode = countMode === 'off' ? 'direct' : 'off';
            App.settings.set('tree.counts', countMode);
            rebuild();
            App.bus.emit('nav:counts');
        },
    });

    // ---------- Init ----------
    App.register('sidebar', {
        init() {
            host = document.getElementById('sidebar');
            wsBtn = noMouseFocus(h('button', { class: 'ws-switch', type: 'button', 'data-tip': '작업 폴더 바꾸기' }));
            wsBtn.addEventListener('click', () => workspaceMenu(wsBtn));

            treeEl = h('div', { class: 'tree', id: 'folder-tree', role: 'tree', 'aria-label': '폴더 트리' });
            filterInput = h('input', { class: 'input', type: 'text', placeholder: '폴더 찾기 · 초성도 돼요', spellcheck: 'false', autocomplete: 'off', role: 'combobox', 'aria-label': '폴더 찾기', 'aria-controls': 'folder-tree', 'aria-autocomplete': 'list', 'aria-expanded': 'true' });
            filterClear = noMouseFocus(h('button', { class: 'tree-filter-clear', type: 'button', hidden: true, 'aria-label': '지우기', 'data-tip': '지우기', 'data-tip-keys': 'Escape', html: ui.icon('x', { size: 13 }) }));
            filterInfo = h('div', { class: 'tree-filter-info', hidden: true });
            emptyEl = h('div', { class: 'tree-empty', hidden: true }, h('div', { class: 'tree-empty-title' }), h('div', { class: 'tree-empty-sub', text: '이름 일부나 초성(ㄱㅅ)으로도 찾을 수 있어요' }));
            const filterBox = h('div', { class: 'search-box tree-filter', 'data-tip': '폴더 찾기', 'data-tip-keys': 'Mod+Shift+F' }, h('span', { html: ui.icon('search', { size: 13 }) }), filterInput, filterClear);

            const head = sectionHead('tree', '폴더', [
                headAction('folder-plus', '새 폴더', () => App.commands.run('nav.newSubfolder', { path: App.state.cwd ?? '' }), 'Alt+N'),
                headAction('list-collapse', '모두 접기', () => collapseAll()),
                headAction('more', '폴더 트리 설정', (e, b) => treeOptionsMenu(b)),
            ]);
            treeStickyEl = h('div', { class: 'tree-sticky' }, head, filterBox, filterInfo);
            treeSection = h('div', { class: 'panel-section tree-section', dataset: { section: 'tree' } }, treeStickyEl, h('div', { class: 'tree-body' }, treeEl, emptyEl));
            if (App.settings.get(collapsedKey('tree'), false)) {
                treeSection.classList.add('collapsed');
                head.querySelector('.sb-head-title').setAttribute('aria-expanded', 'false');
            }
            sectionsEl = h('div', { class: 'sidebar-sections' });
            scrollEl = h('div', { class: 'sidebar-scroll' }, sectionsEl, treeSection);
            host.append(h('div', { class: 'sidebar-head' }, wsBtn), scrollEl);

            // Enter/Space on a keyboard-focused button activate it instead of firing gallery commands
            host.addEventListener('keydown', (e) => {
                if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('button')) e.stopPropagation();
            });

            scrollEl.addEventListener('scroll', scheduleRender, { passive: true });
            new ResizeObserver(scheduleRender).observe(scrollEl);
            new ResizeObserver(scheduleRender).observe(sectionsEl);

            treeEl.addEventListener('click', (e) => {
                const row = rowFromEvent(e);
                if (!row) return;
                const p = row.dataset.path;
                const act = e.target.closest('[data-act]');
                if (act) {
                    e.stopPropagation();
                    if (act.dataset.act === 'new') startNewFolder(p);
                    else openMenu(p, { anchor: act, align: 'end' });
                    return;
                }
                if (e.target.closest('.tree-twisty')) {
                    toggle(p);
                    return;
                }
                openFolder(p);
            });
            treeEl.addEventListener('dblclick', (e) => {
                const row = rowFromEvent(e);
                if (row && !e.target.closest('.tree-twisty, [data-act]')) toggle(row.dataset.path);
            });
            treeSection.addEventListener('contextmenu', (e) => {
                if (e.target.closest('input')) return;
                if (performance.now() - kbdMenuAt < 1000) {
                    // The Menu key already opened the cursor row's menu on keydown; ignore the follow-up event
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                const row = rowFromEvent(e);
                if (!row && !e.target.closest('.tree-body')) return;
                e.preventDefault();
                e.stopPropagation();
                const p = row ? row.dataset.path : '';
                if (row) {
                    focusPath = p;
                    scheduleRender();
                }
                openMenu(p, { x: e.clientX, y: e.clientY });
            });
            // Names that don't fit get the full name in front of the row's summary tooltip
            treeEl.addEventListener('mouseover', (e) => {
                const name = e.target.closest?.('.tree-name');
                if (!name) return;
                if (name.scrollWidth > name.clientWidth + 1) {
                    const info = folderInfo(name.parentElement?.dataset.path ?? '');
                    name.dataset.tip = info ? `${name.textContent} — ${info}` : name.textContent;
                } else delete name.dataset.tip;
            });
            treeEl.addEventListener('keydown', onTreeKey);
            treeEl.addEventListener('focus', () => {
                treeEl.classList.add('tree-kbd');
                renderWindow();
            });
            treeEl.addEventListener('blur', () => {
                treeEl.classList.remove('tree-kbd');
                treeEl.removeAttribute('tabindex');
                treeEl.removeAttribute('aria-activedescendant');
            });

            filterInput.addEventListener('input', () => {
                setFilter(filterInput.value);
                updateFilterUI();
            });
            filterInput.addEventListener('keydown', onFilterKey);
            filterInput.addEventListener('focus', () => {
                treeEl.classList.add('tree-kbd-proxy');
                scheduleRender();
            });
            filterInput.addEventListener('blur', () => {
                treeEl.classList.remove('tree-kbd-proxy');
                filterInput.removeAttribute('aria-activedescendant');
            });
            filterClear.addEventListener('click', () => {
                clearFilter();
                filterInput.focus();
            });

            bindDnd();

            App.bus.on('workspace:opened', async ({ name }) => {
                wsBtn.innerHTML = `<span class="ws-icon">${ui.icon('folder', { size: 15 })}</span><span class="grow truncate">${escapeHtml(name)}</span>${ui.icon('chevron-down', { size: 14 })}`;
                treeSection.hidden = false;
                children.clear();
                counts = new Map();
                idxKids = null;
                folderSet = null;
                focusPath = null;
                editing = null;
                filterText = '';
                filterInput.value = '';
                for (const rec of rendered.values()) rec.el.remove();
                rendered.clear();
                expanded = new Set(App.settings.get(expandedKey(), ['']));
                expanded.add('');
                await Promise.all([...expanded].map((d) => loadChildren(d)));
                rebuild();
                renderSections();
            });
            App.bus.on('workspace:closed', () => {
                wsBtn.innerHTML = '';
                children.clear();
                counts = new Map();
                idxKids = null;
                folderSet = null;
                editing = null;
                filterText = '';
                filterInput.value = '';
                treeSection.hidden = true;
                rebuild();
                renderSections();
            });
            App.bus.on('nav:changed', () => {
                if (filterText) scheduleRender();
                else tree.reveal(App.state.cwd || '');
            });
            App.bus.on('view:changed', ({ reason }) => {
                if (reason === 'entries') scheduleRender();
            });
            App.bus.on('index:ready', reindex);
            App.bus.on('index:changed', reindex);
            App.bus.on('fs:changed', async (c) => {
                if (!App.fs.ready) return;
                if (c.from && c.to && (c.type === 'rename' || c.type === 'move')) rebaseAll(c.from, c.to);
                if (c.type === 'trash' || c.type === 'delete') forget(c.paths || []);
                const dirs = new Set(c.dirs || []);
                for (const p of [...(c.from || []), ...(c.paths || [])]) dirs.add(P.parent(p));
                const reload = [...dirs].filter((d) => children.has(d) && !App.fs.isDataPath(d));
                if (reload.length) await Promise.all(reload.map((d) => loadChildren(d, { force: true })));
                rebuild();
            });
            treeSection.hidden = true;
        },
    });

    function rebaseAll(from, to) {
        const rb = (p) => {
            for (let i = 0; i < from.length; i++) {
                const r = P.rebase(p, from[i], to[i]);
                if (r != null) return r;
            }
            return p;
        };
        expanded = new Set([...expanded].map(rb));
        for (const [k, v] of [...children]) {
            const nk = rb(k);
            if (nk !== k) {
                children.delete(k);
                children.set(nk, v.map(rb));
            }
        }
        const fc = [...filterCollapsed].map(rb);
        filterCollapsed.clear();
        fc.forEach((x) => filterCollapsed.add(x));
        if (focusPath != null) focusPath = rb(focusPath);
        if (editing && editing.kind === 'rename' && editing.path) editing.path = rb(editing.path);
        saveExpanded();
    }

    function forget(paths) {
        const gone = (p) => paths.some((t) => t !== '' && P.isInside(p, t));
        for (const k of [...children.keys()]) if (gone(k)) children.delete(k);
        expanded = new Set([...expanded].filter((p) => !gone(p)));
        if (focusPath != null && gone(focusPath)) {
            let up = focusPath;
            while (up && gone(up)) up = P.parent(up);
            focusPath = up;
        }
        if (editing && editing.kind === 'rename' && gone(editing.path)) editing = null;
        if (editing && editing.kind === 'new' && gone(editing.parent)) editing = null;
        saveExpanded();
    }

    App.tree = tree;
    App.sidebar = sidebar;
})();
