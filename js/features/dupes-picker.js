/*
 * Folder tree picker for the duplicate finder's scope (App.dupes.picker).
 *   picker.create({ mode: 'check' | 'ab', picked: Set, a: Set, b: Set, onChange() }) -> { el, refresh(), setMode(m), focusSearch() }
 *   'check'  multi-select with checkboxes (a checked folder includes its subfolders)
 *   'ab'     each folder can go to side A or side B ('두 쪽 비교')
 * Keys: ↑/↓ move, →/← open/close, Space checks (A/B in compare mode); Enter is left to the panel (= start).
 * Virtualized (fixed rows) so a workspace with thousands of folders stays smooth. Each row also shows the folder's
 * duplicate-check role (보관/정리) and whether it is excluded; the ⋯ button sets those (undoable, App.dupes).
 */
(() => {
    'use strict';
    const { h, path: P, formatCount, compareNames } = App.util;
    const ui = App.ui;
    const kit = App.organize.kit;
    const { icon } = kit;

    const ROW = 32;

    function folderModel() {
        const folders = App.index.folders.slice();
        const kids = new Map();
        for (const f of folders) {
            if (f === '') continue;
            const parent = P.parent(f);
            if (!kids.has(parent)) kids.set(parent, []);
            kids.get(parent).push(f);
        }
        for (const list of kids.values()) list.sort((a, b) => compareNames(P.base(a), P.base(b)));
        // media files per folder, recursive
        const counts = new Map();
        for (const e of App.index.items) {
            if (e.kind !== 'file' || (e.type !== 'image' && e.type !== 'video')) continue;
            for (let d = P.parent(e.path); ; d = P.parent(d)) {
                counts.set(d, (counts.get(d) || 0) + 1);
                if (d === '') break;
            }
        }
        return { folders, kids, counts };
    }

    function create(opts) {
        const state = { mode: opts.mode || 'check', expanded: new Set(['']), query: '' };
        const picked = opts.picked || new Set();
        const sideA = opts.a || new Set();
        const sideB = opts.b || new Set();
        let model = folderModel();
        let rows = [];
        let focusIdx = 0;

        // Ancestors of picked folders start expanded so the picks are visible
        for (const p of [...picked, ...sideA, ...sideB]) for (let d = P.parent(p); d !== ''; d = P.parent(d)) state.expanded.add(d);

        const search = h('input', { class: 'input dup-tree-search', type: 'search', placeholder: '폴더 이름으로 찾기 (초성도 돼요)', 'aria-label': '폴더 찾기', 'data-native-enter': '' });
        const list = kit.virtualList({ rowHeight: ROW, render: renderRow, className: 'dup-tree-list', label: '폴더' });
        const el = h('div', { class: 'dup-tree' }, h('div', { class: 'dup-tree-top' }, h('span', { class: 'dup-tree-search-ico', html: icon('search', 14) }), search), list.el);

        const pickedHit = (p, set) => {
            for (let d = p; ; d = P.parent(d)) {
                if (set.has(d)) return d;
                if (d === '') return null;
            }
        };
        const hasPickedBelow = (p, set) => {
            for (const x of set) if (x !== p && P.isInside(x, p)) return true;
            return false;
        };

        function build() {
            rows = [];
            const q = state.query.trim();
            if (q) {
                const hits = [];
                for (const f of model.folders) {
                    if (f === '') continue;
                    const m = App.util.matchKo(q, P.base(f));
                    if (m) hits.push({ f, score: m.score });
                }
                hits.sort((a, b) => b.score - a.score || compareNames(a.f, b.f));
                for (const { f } of hits.slice(0, 2000)) rows.push({ p: f, depth: 0, flat: true });
            } else {
                const walk = (p, depth) => {
                    rows.push({ p, depth });
                    if (!state.expanded.has(p)) return;
                    for (const k of model.kids.get(p) || []) walk(k, depth + 1);
                };
                walk('', 0);
            }
            if (focusIdx >= rows.length) focusIdx = Math.max(0, rows.length - 1);
            list.setCount(rows.length);
        }

        function toggleExpand(p) {
            if (state.expanded.has(p)) state.expanded.delete(p);
            else state.expanded.add(p);
            build();
        }

        function setPick(p, on) {
            if (on) {
                // a parent pick covers the children: drop children, never pick both
                for (const x of [...picked]) if (x !== p && P.isInside(x, p)) picked.delete(x);
                picked.add(p);
            } else picked.delete(p);
            list.refresh();
            opts.onChange?.();
        }

        function setSide(p, side) {
            const mine = side === 'a' ? sideA : sideB;
            const other = side === 'a' ? sideB : sideA;
            if (mine.has(p)) mine.delete(p);
            else {
                for (const x of [...mine]) if (x !== p && P.isInside(x, p)) mine.delete(x);
                // a folder can't be on both sides (nor inside a folder of the other side)
                for (const x of [...other]) if (x === p || P.isInside(x, p) || P.isInside(p, x)) other.delete(x);
                mine.add(p);
            }
            list.refresh();
            opts.onChange?.();
        }

        function roleMenu(p, anchor) {
            const store = App.dupes.store;
            const role = store.data.rules.folderPriority.find((x) => x.path === p)?.role || null;
            const excluded = store.data.excludedFolders.includes(p);
            ui.menu([
                { header: kit.folderPathLabel(p) },
                { label: '보관 폴더 — 중복이면 이 폴더 것을 남겨요', icon: 'shield-check', checked: role === 'keep', action: () => App.dupes.setFolderRole(p, role === 'keep' ? null : 'keep') },
                { label: '정리 폴더 — 중복이면 이 폴더 것을 먼저 지워요', icon: 'trash', checked: role === 'remove', action: () => App.dupes.setFolderRole(p, role === 'remove' ? null : 'remove') },
                role ? { label: '역할 지우기', icon: 'x', action: () => App.dupes.setFolderRole(p, null) } : null,
                '-',
                p === '' ? null : { label: excluded ? '중복검사에 다시 넣기' : '이 폴더는 중복검사에서 빼기', icon: 'eye-off', action: () => App.dupes.excludeFolders([p], !excluded) },
            ].filter(Boolean), { anchor, align: 'end' });
        }

        function renderRow(i) {
            const r = rows[i];
            const p = r.p;
            const store = App.dupes.store;
            const isRoot = p === '';
            const name = isRoot ? App.state.workspace?.name || '작업 폴더' : r.flat ? kit.folderPathLabel(p) : P.base(p);
            const hasKids = (model.kids.get(p) || []).length > 0;
            const count = model.counts.get(p) || 0;
            const role = store.roleEntry(p);
            const ownRole = role && role.path === p ? role.role : null;
            const excluded = isRoot ? null : store.excludedBy(p);
            const row = h('div', { class: `dup-tree-row${i === focusIdx ? ' focused' : ''}${excluded ? ' excluded' : ''}`, role: 'treeitem', dataset: { path: p }, 'aria-level': String(r.depth + 1) });
            row.style.paddingLeft = `${8 + r.depth * 16}px`;
            const chev = h('button', { type: 'button', class: `dup-tree-chev${hasKids && !r.flat ? '' : ' none'}${state.expanded.has(p) ? ' open' : ''}`, tabindex: '-1', 'aria-label': state.expanded.has(p) ? '접기' : '펼치기', html: icon('chevron-right', 13) });
            chev.addEventListener('click', (e) => {
                e.stopPropagation();
                if (hasKids && !r.flat) toggleExpand(p);
            });
            row.append(chev);
            if (state.mode === 'check') {
                const via = pickedHit(p, picked);
                const on = via !== null;
                const implied = on && via !== p;
                const partial = !on && hasPickedBelow(p, picked);
                const box = kit.checkMark(on, { partial });
                if (implied) box.classList.add('implied');
                row.append(box);
                row.addEventListener('click', () => {
                    focusIdx = i;
                    if (excluded) return;
                    if (implied) {
                        ui.toast(`‘${kit.folderLabel(via)}’ 폴더를 골라서 이 폴더도 함께 찾아요`, { type: 'info', duration: 2400 });
                        return;
                    }
                    setPick(p, !on);
                });
            } else {
                const viaA = pickedHit(p, sideA);
                const viaB = pickedHit(p, sideB);
                const ab = h('span', { class: 'dup-ab' });
                for (const side of ['a', 'b']) {
                    const via = side === 'a' ? viaA : viaB;
                    const has = via !== null;
                    const b2 = h('button', { type: 'button', class: `dup-ab-btn side-${side}${has ? ' on' : ''}${has && via !== p ? ' implied' : ''}`, text: side.toUpperCase(), 'aria-pressed': String(has), 'data-tip': side === 'a' ? 'A 쪽에 넣기 (예: 다운로드)' : 'B 쪽에 넣기 (예: 보관함)' });
                    b2.addEventListener('click', (e) => {
                        e.stopPropagation();
                        focusIdx = i;
                        if (excluded) return;
                        if (has && via !== p) {
                            ui.toast(`‘${kit.folderLabel(via)}’ 폴더가 이미 ${side.toUpperCase()} 쪽이라 이 폴더도 포함돼요`, { type: 'info', duration: 2400 });
                            return;
                        }
                        setSide(p, side);
                    });
                    ab.append(b2);
                }
                row.append(ab);
                row.addEventListener('click', () => {
                    focusIdx = i;
                    list.refresh();
                });
            }
            row.append(...[
                h('span', { class: 'dup-tree-ico', html: icon(isRoot ? 'home' : 'folder', 15) }),
                h('span', { class: 'dup-tree-name truncate', text: name, title: kit.folderPathLabel(p) }),
                ownRole ? h('span', { class: `dup-role-badge ${ownRole}`, text: ownRole === 'keep' ? '보관' : '정리' }) : null,
                excluded ? h('span', { class: 'dup-role-badge excluded', text: excluded.path === p ? '빠짐' : '상위 폴더 빠짐' }) : null,
                h('span', { class: 'dup-tree-count', text: count ? formatCount(count) : '' })].filter(Boolean));
            const more = h('button', { type: 'button', class: 'dup-tree-more btn ghost icon sm', 'aria-label': '폴더 역할과 제외', 'data-tip': '보관/정리 폴더 지정, 검사에서 빼기', html: icon('more', 14) });
            more.addEventListener('click', (e) => {
                e.stopPropagation();
                roleMenu(p, more);
            });
            row.append(more);
            return row;
        }

        search.addEventListener('input', App.util.debounce(() => {
            state.query = search.value;
            focusIdx = 0;
            build();
        }, 80));

        // keyboard: ↑/↓ move, →/← expand/collapse, Space/Enter pick (A/B in compare mode)
        list.el.addEventListener('keydown', (e) => {
            if (!rows.length) return;
            const r = rows[focusIdx];
            let handled = true;
            if (e.key === 'ArrowDown') focusIdx = Math.min(rows.length - 1, focusIdx + 1);
            else if (e.key === 'ArrowUp') focusIdx = Math.max(0, focusIdx - 1);
            else if (e.key === 'ArrowRight' && r && !state.expanded.has(r.p) && (model.kids.get(r.p) || []).length) toggleExpand(r.p);
            else if (e.key === 'ArrowLeft' && r && state.expanded.has(r.p) && r.p !== '') toggleExpand(r.p);
            else if (e.key === ' ' && r && state.mode === 'check') {
                if (pickedHit(r.p, picked) === null || picked.has(r.p)) setPick(r.p, !picked.has(r.p));
            } else if ((e.key === 'a' || e.key === 'A' || e.key === 'b' || e.key === 'B') && r && state.mode === 'ab') setSide(r.p, e.key.toLowerCase());
            else handled = false;
            if (handled) {
                e.preventDefault();
                e.stopPropagation();
                list.refresh();
                list.scrollToIndex(focusIdx);
            }
        });

        const offs = [
            App.bus.on('dupes:changed', () => list.refresh()),
            App.bus.on('index:changed', App.util.debounce(() => {
                model = folderModel();
                build();
            }, 200)),
        ];

        build();
        return {
            el,
            refresh() {
                model = folderModel();
                build();
            },
            setMode(m) {
                state.mode = m;
                list.refresh();
            },
            focusSearch() {
                search.focus();
            },
            destroy() {
                for (const off of offs) off();
                list.destroy();
            },
        };
    }

    App.dupes = App.dupes || {};
    App.dupes.picker = { create };
})();
