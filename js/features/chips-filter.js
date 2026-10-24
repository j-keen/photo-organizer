/*
 * Chip filter — sidebar section '칩' (App.sidebar.addSection).
 * Lists the active preset's categories → chips → sub-chips with file counts across the whole library
 * (App.catalog over App.index), plus a star / color-label filter row and the '미분류' smart view.
 *   click        show only files with this chip in the current view (App.view.setFilter('chips'))
 *   Ctrl+click   add / remove the chip to the condition — '모두 포함' (AND) or '하나라도' (OR)
 *   Alt+click    exclude the chip ("빼고")
 *   '모든 폴더에서 보기' turns the condition into a workspace-wide smart view (App.view.setEntries, type 'smart').
 * File conditions include kept video-piece chips; piece-only matches open at the first contributing piece.
 * App.chipsFilter: { showChip(id), showUntagged(), clear(), stats() }
 *   stats().chip / cat count files once; stats().pieces maps chip IDs to tagged kept-piece counts.
 */
(() => {
    'use strict';
    const { h, path: P, formatCount, debounce } = App.util;
    const ui = App.ui;
    const icon = (name, size = 13) => ui.icon(name, { size });
    const LABELS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];
    const LABEL_NAMES = { red: '빨강', orange: '주황', yellow: '노랑', green: '초록', blue: '파랑', purple: '보라' };

    const F = { ids: new Set(), exclude: new Set(), op: App.settings.get('chips.filterOp', 'and'), rating: 0, labels: new Set() };
    let smart = null; // { kind: 'chips' | 'untagged' } while our smart view is on screen
    let body = null;
    let headEl = null;
    let statsCache = null;
    let applying = 0; // our own setFilter calls (ignore the echo on 'view:filters')
    const more = {}; // catId -> show every chip

    const C = () => App.chipset;

    let tagsCache = null;
    const EMPTY_TAGS = { file: new Set(), all: new Set(), pieces: [] };

    // Read saved metadata without requiring a loaded player or a known duration.
    function tagsOf(path) {
        if (!tagsCache) {
            tagsCache = new Map();
            for (const [p, e] of App.catalog.entries()) {
                const file = new Set((e.chips || []).filter((id) => C()?.info(id)));
                const all = new Set(file);
                const pieces = [];
                const edit = e.meta?.edit;
                if (App.util.mediaType(p) === 'video' && edit?.pieces) {
                    for (const [key, info] of Object.entries(edit.pieces)) {
                        const start = Number(key);
                        if (!Number.isFinite(start) || start < 0) continue;
                        if ((edit.removed || []).some((r) => Array.isArray(r) && start >= r[0] && start < r[1])) continue;
                        const chips = new Set((Array.isArray(info?.chips) ? info.chips : []).filter((id) => C()?.info(id)));
                        if (!chips.size) continue;
                        pieces.push({ start, chips });
                        for (const id of chips) all.add(id);
                    }
                }
                pieces.sort((a, b) => a.start - b.start);
                tagsCache.set(p, { file, all, pieces });
            }
        }
        return tagsCache.get(path) || EMPTY_TAGS;
    }

    function satisfies(chips, inc, exc, op) {
        if (exc.some((id) => chips.has(id))) return false;
        return !inc.length || (op === 'and' ? inc.every((id) => chips.has(id)) : inc.some((id) => chips.has(id)));
    }

    function matchingPieces(entry) {
        if (entry.type !== 'video' || !F.ids.size) return [];
        if (!(smart?.kind === 'chips' && App.view.source.owner === 'chips') && !App.view.filters.has('chips')) return [];
        const tags = tagsOf(entry.path);
        const inc = [...F.ids];
        const exc = [...F.exclude];
        if (!satisfies(tags.all, inc, exc, F.op) || satisfies(tags.file, inc, exc, F.op)) return [];
        // AND can be satisfied across pieces; start with the earliest piece supplying a missing chip.
        return tags.pieces.filter((piece) => inc.some((id) => !tags.file.has(id) && piece.chips.has(id)));
    }

    // ---------- Stats ----------
    function stats() {
        if (statsCache) return statsCache;
        const cs = C();
        const chip = new Map();
        const cat = new Map();
        const pieces = new Map();
        let tagged = 0;
        if (cs?.ready) {
            for (const [p, e] of App.catalog.entries()) {
                if (App.index.ready && !App.index.get(p)) continue;
                const tags = tagsOf(p);
                for (const piece of tags.pieces) {
                    for (const id of piece.chips) pieces.set(id, (pieces.get(id) || 0) + 1);
                }
                let known = false;
                const cats = new Set();
                for (const id of tags.all) {
                    const i = cs.info(id);
                    if (!i) continue;
                    known = true;
                    chip.set(id, (chip.get(id) || 0) + 1);
                    cats.add(i.cat.id);
                }
                if (known) tagged++;
                for (const c of cats) cat.set(c, (cat.get(c) || 0) + 1);
            }
        }
        const total = App.index.ready ? App.index.items.length : null;
        statsCache = { chip, cat, pieces, tagged, total, untagged: total == null ? null : Math.max(0, total - tagged) };
        return statsCache;
    }

    // ---------- Conditions ----------
    function chipTest() {
        const inc = [...F.ids];
        const exc = [...F.exclude];
        if (!inc.length && !exc.length) return null;
        const op = F.op;
        return (e) => satisfies(tagsOf(e.path).all, inc, exc, op);
    }

    function chipLabel() {
        const cs = C();
        const names = [...F.ids].map((id) => cs.nameOf(id) || '?');
        let s = names.join(F.op === 'and' ? ' + ' : ' 또는 ');
        if (F.exclude.size) s += `${s ? ' ' : ''}${[...F.exclude].map((id) => `−${cs.nameOf(id) || '?'}`).join(' ')}`;
        return `칩: ${s}`;
    }

    function withGuard(fn) {
        applying++;
        try {
            fn();
        } finally {
            applying--;
        }
    }

    function applyChips() {
        if (smart && smart.kind === 'chips') {
            if (!F.ids.size && !F.exclude.size) return exitSmart();
            return runSmart('chips');
        }
        const test = chipTest();
        withGuard(() => App.view.setFilter('chips', test ? { label: chipLabel(), test } : null));
        renderSoon();
    }

    function applyRating() {
        const n = F.rating;
        withGuard(() => App.view.setFilter('rating', n ? { label: `★ ${n}개 이상`, test: (e) => (App.catalog.peek(e.path)?.rating || 0) >= n } : null));
        renderSoon();
    }

    function applyLabels() {
        const set = new Set(F.labels);
        withGuard(() => App.view.setFilter('label', set.size ? { label: `라벨: ${[...set].map((l) => LABEL_NAMES[l]).join(', ')}`, test: (e) => set.has(App.catalog.peek(e.path)?.label) } : null));
        renderSoon();
    }

    // ---------- Smart views ----------
    async function runSmart(kind) {
        const cs = C();
        if (!App.fs.ready || !cs?.ready) return;
        smart = { kind };
        if (!App.index.ready) {
            App.view.setEntries([], { type: 'smart', path: null, title: '라이브러리를 살펴보는 중…', owner: 'chips', smart: kind });
            await App.index.whenReady();
            if (!smart || smart.kind !== kind) return;
        }
        let list;
        let title;
        let emptyTitle;
        let emptyText;
        if (kind === 'untagged') {
            list = App.index.items.filter((e) => !tagsOf(e.path).all.size);
            title = '미분류 — 칩이 없는 파일';
            emptyTitle = '모든 파일에 칩이 붙어 있어요';
            emptyText = '새로 들어온 파일이 생기면 여기에 모여요.';
        } else {
            const test = chipTest() || (() => true);
            list = App.index.items.filter(test);
            title = `${chipLabel()} — 모든 폴더`;
            emptyTitle = '조건에 맞는 파일이 없어요';
            emptyText = '칩 조건을 바꾸거나 해제해 보세요.';
        }
        if (App.view.filters.has('chips')) withGuard(() => App.view.setFilter('chips', null));
        App.topbar?.clearSearch?.();
        App.view.setEntries(list, { type: 'smart', path: null, title, owner: 'chips', smart: kind, emptyTitle, emptyText });
        renderSoon();
    }

    function exitSmart() {
        smart = null;
        F.ids.clear();
        F.exclude.clear();
        if (App.view.source.owner === 'chips') App.nav.go(App.state.cwd ?? '');
        renderSoon();
    }

    function clear() {
        F.ids.clear();
        F.exclude.clear();
        if (smart) return exitSmart();
        applyChips();
    }

    function onChipClick(id, e) {
        const additive = e.ctrlKey || e.metaKey;
        if (e.altKey) {
            if (F.exclude.has(id)) F.exclude.delete(id);
            else {
                F.exclude.add(id);
                F.ids.delete(id);
            }
        } else if (additive) {
            if (F.ids.has(id)) F.ids.delete(id);
            else {
                F.ids.add(id);
                F.exclude.delete(id);
            }
        } else if (F.ids.size === 1 && F.ids.has(id) && !F.exclude.size) {
            F.ids.clear();
        } else {
            F.ids = new Set([id]);
            F.exclude.clear();
        }
        applyChips();
    }

    // ---------- Rendering ----------
    function isExpanded(cat, total) {
        const map = App.settings.get('chips.sidebar.expanded', {});
        if (cat.id in map) return !!map[cat.id];
        return cat.mode !== 'search' && total <= 16;
    }

    function setExpanded(catId, v) {
        App.settings.set('chips.sidebar.expanded', { ...App.settings.get('chips.sidebar.expanded', {}), [catId]: v });
        render();
    }

    function row({ cls = '', depth = 0, dot = null, iconName = null, label, count, data = {}, tip = null }) {
        const el = h('button', { type: 'button', class: `chipf-row ${cls}`, dataset: data, style: { paddingLeft: `${10 + depth * 14}px` }, 'data-tip': tip });
        if (iconName) el.append(h('span', { class: 'chipf-ico', html: icon(iconName, 13) }));
        else if (dot !== null) el.append(h('span', { class: 'chipf-dot', style: dot ? { background: dot } : null }));
        el.append(h('span', { class: 'chipf-name truncate', text: label }));
        if (count != null) el.append(h('span', { class: 'chipf-count', text: count === '…' ? '…' : formatCount(count) }));
        return el;
    }

    function render() {
        if (!body || !body.isConnected) return;
        const cs = C();
        body.innerHTML = '';
        updateHead();
        if (!App.fs.ready || !cs?.ready) {
            body.append(h('div', { class: 'chipf-note', text: '작업 폴더를 열면 칩별 파일 수가 보여요.' }));
            return;
        }
        const st = stats();
        const preset = cs.active();
        const wrap = h('div', { class: 'chipf' });

        // Rating & label filter
        const rate = h('div', { class: 'chipf-rate' });
        const starBox = h('div', { class: 'chipf-stars', role: 'group', 'aria-label': '별점 필터' });
        for (let n = 1; n <= 5; n++) starBox.append(h('button', { type: 'button', class: `chipf-star${F.rating && n <= F.rating ? ' on' : ''}`, dataset: { rating: n }, 'aria-label': `별점 ${n}개 이상`, 'data-tip': F.rating === n ? '별점 필터 해제' : `★ ${n}개 이상만 보기`, html: icon('star', 13) }));
        const labelBox = h('div', { class: 'chipf-labels', role: 'group', 'aria-label': '색상 라벨 필터' });
        for (const l of LABELS) labelBox.append(h('button', { type: 'button', class: `chipf-label${F.labels.has(l) ? ' on' : ''}`, dataset: { label: l }, style: `--lc: var(--label-${l})`, 'aria-label': `${LABEL_NAMES[l]} 라벨만 보기`, 'data-tip': `${LABEL_NAMES[l]} 라벨${F.labels.has(l) ? ' 필터 해제' : '만 보기'}` }));
        rate.append(starBox, h('span', { class: 'grow' }), labelBox);
        wrap.append(rate);

        // Smart: untagged
        wrap.append(row({
            cls: `smart${smart?.kind === 'untagged' ? ' on' : ''}`,
            iconName: 'tag',
            label: '미분류',
            count: st.untagged == null ? '…' : st.untagged,
            data: { smart: 'untagged' },
            tip: '칩이 하나도 없는 파일을 모든 폴더에서 모아 봐요',
        }));

        if (!preset.categories.length) {
            wrap.append(h('div', { class: 'chipf-note' }, h('span', { text: '아직 분류가 없어요. ' }), h('button', { type: 'button', class: 'chipf-link', dataset: { action: 'add-category' }, text: '분류 만들기' })));
        }
        for (const cat of preset.categories) {
            const total = cat.chips.length;
            const open = isExpanded(cat, total);
            const color = cat.color ? `var(--label-${cat.color})` : '';
            const head = row({ cls: 'cat', dot: color, label: cat.name, count: st.cat.get(cat.id) || 0, data: { cat: cat.id }, tip: open ? '접기' : '펼치기' });
            head.prepend(h('span', { class: `chipf-twisty${open ? ' open' : ''}`, html: icon('chevron-right', 11) }));
            wrap.append(head);
            if (!open) continue;
            let chips = cat.chips;
            const counted = (ch) => st.chip.get(ch.id) || 0;
            const big = cat.mode === 'search' || chips.length > 16;
            if (big) chips = chips.filter((ch) => counted(ch) || F.ids.has(ch.id) || F.exclude.has(ch.id)).sort((a, b) => counted(b) - counted(a));
            const limit = more[cat.id] ? Infinity : 10;
            chips.slice(0, limit).forEach((ch) => {
                wrap.append(chipRow(ch, 1, st, color));
                if (counted(ch) || F.ids.has(ch.id)) {
                    for (const sub of ch.children) if ((st.chip.get(sub.id) || 0) || F.ids.has(sub.id) || F.exclude.has(sub.id)) wrap.append(chipRow(sub, 2, st, color));
                }
            });
            if (chips.length > limit) wrap.append(h('button', { type: 'button', class: 'chipf-more', dataset: { more: cat.id }, style: { paddingLeft: '24px' }, text: `${formatCount(chips.length - limit)}개 더 보기` }));
            else if (more[cat.id] && chips.length > 10) wrap.append(h('button', { type: 'button', class: 'chipf-more', dataset: { less: cat.id }, style: { paddingLeft: '24px' }, text: '접기' }));
            if (big && !chips.length) wrap.append(h('div', { class: 'chipf-note', style: { paddingLeft: '24px' }, text: '아직 이 분류의 칩이 붙은 파일이 없어요' }));
        }

        // Condition bar
        const active = F.ids.size || F.exclude.size || smart;
        if (active) {
            const bar = h('div', { class: 'chipf-bar' });
            if (F.ids.size >= 2) {
                const seg = h('div', { class: 'seg chipf-op' },
                    h('button', { type: 'button', class: F.op === 'and' ? 'on' : '', dataset: { op: 'and' }, 'data-tip': '고른 칩이 모두 붙은 파일', text: '모두 포함' }),
                    h('button', { type: 'button', class: F.op === 'or' ? 'on' : '', dataset: { op: 'or' }, 'data-tip': '고른 칩 중 하나라도 붙은 파일', text: '하나라도' }));
                bar.append(seg);
            }
            if (smart?.kind !== 'chips' && (F.ids.size || F.exclude.size)) bar.append(h('button', { type: 'button', class: 'btn sm', dataset: { action: 'everywhere' }, 'data-tip': '하위 폴더까지 작업 폴더 전체에서 찾아요', html: `${icon('layers', 13)}<span>모든 폴더에서 보기</span>` }));
            bar.append(h('button', { type: 'button', class: 'btn sm ghost', dataset: { action: 'clear' }, html: `${icon('x', 13)}<span>${smart ? '폴더로 돌아가기' : '해제'}</span>` }));
            wrap.append(bar);
            if (!smart && F.ids.size === 1 && !F.exclude.size) wrap.append(h('div', { class: 'chipf-tip', text: 'Ctrl+클릭으로 칩을 더하고, Alt+클릭으로 빼요' }));
        }
        body.append(wrap);
    }

    function chipRow(ch, depth, st, color) {
        const on = F.ids.has(ch.id);
        const ex = F.exclude.has(ch.id);
        return row({
            cls: `chip-item${on ? ' on' : ''}${ex ? ' ex' : ''}${(st.chip.get(ch.id) || 0) ? '' : ' zero'}`,
            depth,
            dot: color || '',
            label: ch.name,
            count: st.chip.get(ch.id) || 0,
            data: { chip: ch.id },
            tip: (ex ? '빼고 보는 중 · Alt+클릭하면 다시 넣어요' : on ? '필터에 들어 있어요 · 다시 누르면 해제' : '클릭: 이 칩만 보기 · Ctrl+클릭: 더하기 · Alt+클릭: 빼기')
                + (st.pieces.get(ch.id) ? ` · 조각 ${formatCount(st.pieces.get(ch.id))}` : ''),
        });
    }

    function updateHead() {
        if (!headEl) return;
        let badge = headEl.querySelector('.chipf-badge');
        const n = F.ids.size + F.exclude.size + (F.rating ? 1 : 0) + F.labels.size + (smart?.kind === 'untagged' ? 1 : 0);
        if (!n) {
            badge?.remove();
            return;
        }
        if (!badge) {
            badge = h('span', { class: 'badge accent chipf-badge' });
            headEl.append(badge);
        }
        badge.textContent = `필터 ${n}`;
    }

    const renderSoon = debounce(render, 30);

    const refreshSoon = debounce(() => {
        render();
        if (App.view.filters.has('chips')) App.view.recompute('patch');
        App.gallery?.refresh?.();
    }, 150);

    function invalidate() {
        // Drop synchronously: another catalog listener may recompute the view in this same event.
        statsCache = null;
        tagsCache = null;
        refreshSoon();
    }

    function onBodyClick(e) {
        const t = e.target;
        const r = t.closest('[data-rating]');
        if (r) {
            const n = Number(r.dataset.rating);
            F.rating = F.rating === n ? 0 : n;
            return applyRating();
        }
        const l = t.closest('[data-label]');
        if (l) {
            if (F.labels.has(l.dataset.label)) F.labels.delete(l.dataset.label);
            else F.labels.add(l.dataset.label);
            return applyLabels();
        }
        const s = t.closest('[data-smart]');
        if (s) {
            if (smart?.kind === 'untagged') return exitSmart();
            F.ids.clear();
            F.exclude.clear();
            return runSmart('untagged');
        }
        const c = t.closest('[data-cat]');
        if (c) {
            const cat = C().category(c.dataset.cat);
            return setExpanded(c.dataset.cat, !isExpanded(cat, cat.chips.length));
        }
        const chip = t.closest('[data-chip]');
        if (chip) return onChipClick(chip.dataset.chip, e);
        const m = t.closest('[data-more]');
        if (m) {
            more[m.dataset.more] = true;
            return render();
        }
        const less = t.closest('[data-less]');
        if (less) {
            more[less.dataset.less] = false;
            return render();
        }
        const op = t.closest('[data-op]');
        if (op) {
            F.op = op.dataset.op;
            App.settings.set('chips.filterOp', F.op);
            return applyChips();
        }
        const act = t.closest('[data-action]');
        if (act) {
            if (act.dataset.action === 'everywhere') runSmart('chips');
            else if (act.dataset.action === 'clear') clear();
            else if (act.dataset.action === 'add-category') App.commands.run('chips.addCategory');
        }
    }

    function onBodyContext(e) {
        const chip = e.target.closest('[data-chip]');
        if (!chip) return;
        e.preventDefault();
        e.stopPropagation();
        const id = chip.dataset.chip;
        ui.menu([
            { header: C().labelOf(id) },
            { label: '이 칩만 보기 (이 폴더)', icon: 'filter', action: () => onChipClick(id, {}) },
            { label: '모든 폴더에서 보기', icon: 'layers', action: () => showChip(id) },
            { label: F.ids.has(id) ? '조건에서 빼기' : '조건에 더하기', hint: 'Ctrl+클릭', icon: 'plus', action: () => onChipClick(id, { ctrlKey: true }) },
            { label: F.exclude.has(id) ? '제외 해제' : '이 칩이 붙은 파일 빼기', hint: 'Alt+클릭', icon: 'minus', action: () => onChipClick(id, { altKey: true }) },
        ], { x: e.clientX, y: e.clientY });
    }

    function showChip(id) {
        F.ids = new Set([id]);
        F.exclude.clear();
        runSmart('chips');
    }

    // Our smart view keeps its list stable while you tag (a file you just tagged in '미분류' stays put until F5),
    // but follows files that are trashed, moved or renamed.
    function followFs(c) {
        if (!smart || App.view.source.owner !== 'chips') return;
        const list = App.view.entries;
        let changed = false;
        if (c.type === 'trash' || c.type === 'delete') {
            for (let i = list.length - 1; i >= 0; i--) {
                if (c.paths.some((p) => P.isInside(list[i].path, p))) {
                    list.splice(i, 1);
                    changed = true;
                }
            }
        } else if (c.from && c.to) {
            list.forEach((e, i) => {
                for (let k = 0; k < c.from.length; k++) {
                    const r = P.rebase(e.path, c.from[k], c.to[k]);
                    if (r == null) continue;
                    list[i] = { ...e, path: r, name: P.base(r) };
                    changed = true;
                    break;
                }
            });
        }
        if (changed) App.view.recompute('patch');
    }

    // Keep our state in sync when filters are removed elsewhere (viewbar chip ×, other modules)
    function syncFromView() {
        if (applying) return;
        let changed = false;
        if (!App.view.filters.has('chips') && !smart && (F.ids.size || F.exclude.size)) {
            F.ids.clear();
            F.exclude.clear();
            changed = true;
        }
        if (!App.view.filters.has('rating') && F.rating) {
            F.rating = 0;
            changed = true;
        }
        if (!App.view.filters.has('label') && F.labels.size) {
            F.labels.clear();
            changed = true;
        }
        if (changed) renderSoon();
    }

    App.commands.register({ id: 'chips.showUntagged', title: '미분류 파일 보기 (칩 없는 파일)', group: '칩', icon: 'tag', when: () => App.fs.ready && !!C()?.ready, run: () => runSmart('untagged') });
    App.commands.register({ id: 'chips.clearFilter', title: '칩·별점·라벨 필터 해제', group: '칩', icon: 'x', when: () => !!(F.ids.size || F.exclude.size || F.rating || F.labels.size || smart), run: () => {
        F.rating = 0;
        F.labels.clear();
        withGuard(() => {
            if (App.view.filters.has('rating')) App.view.setFilter('rating', null);
            if (App.view.filters.has('label')) App.view.setFilter('label', null);
        });
        clear();
    } });

    App.register('chips-filter', {
        init() {
            App.nav.openHooks.push((entry) => {
                const pieces = matchingPieces(entry);
                return pieces.length ? { time: pieces[0].start } : null;
            });
            if (App.gallery?.cardDecorators) {
                App.gallery.cardDecorators.push((card, entry) => {
                    const pieces = matchingPieces(entry);
                    if (!pieces.length) return;
                    card.append(h('span', {
                        class: 'chipf-piece-badge',
                        text: `조각 ${formatCount(pieces.length)}`,
                        'data-tip': '칩이 붙은 조각부터 재생해요',
                    }));
                });
            }
            App.sidebar?.addSection({
                id: 'chips',
                title: '칩',
                order: 20,
                render(b, el) {
                    body = b;
                    body.classList.add('chipf-body');
                    headEl = el?.querySelector('.panel-section-head') || null;
                    body.addEventListener('click', onBodyClick);
                    body.addEventListener('contextmenu', onBodyContext);
                    render();
                },
            });
            App.bus.on('chipset:changed', invalidate);
            App.bus.on('catalog:changed', invalidate);
            App.bus.on('catalog:loaded', invalidate);
            App.bus.on('index:ready', invalidate);
            App.bus.on('index:changed', invalidate);
            App.bus.on('view:filters', syncFromView);
            App.bus.on('fs:changed', followFs);
            // F5 / nav.reload on a non-folder view
            App.bus.on('view:reload-request', () => {
                if (smart && App.view.source.owner === 'chips') runSmart(smart.kind);
            });
            App.bus.on('view:changed', ({ reason }) => {
                if (reason !== 'entries') return;
                if (smart && App.view.source.owner !== 'chips') {
                    smart = null;
                    F.ids.clear();
                    F.exclude.clear();
                    renderSoon();
                }
            });
            App.bus.on('workspace:opened', () => {
                smart = null;
                F.ids.clear();
                F.exclude.clear();
                F.rating = 0;
                F.labels.clear();
                statsCache = null;
                tagsCache = null;
                renderSoon();
            });
            App.bus.on('workspace:closed', () => {
                smart = null;
                tagsCache = null;
                statsCache = null;
                renderSoon();
            });
        },
    });

    App.chipsFilter = {
        showChip,
        showUntagged: () => runSmart('untagged'),
        clear,
        stats,
        get state() {
            return { ids: [...F.ids], exclude: [...F.exclude], op: F.op, rating: F.rating, labels: [...F.labels], smart: smart?.kind || null };
        },
    };
})();
