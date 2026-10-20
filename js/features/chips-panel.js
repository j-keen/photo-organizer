/*
 * Chip panel UI — the inspector's main section and the viewer's chip drawer share renderPanel().
 *   선택형 categories show every chip; 검색형 categories show a search box (Enter creates) + the chips already on
 *   the selection + recently used quick picks. A selected parent chip opens a sub-chip row with '+'.
 *   Multi-selection shows tri-state chips (on / mixed "3/5" / off); one click = one undo entry for all files.
 * Also here: category / chip / preset menus and dialogs, gallery card badge + context menu, copy/paste chips.
 *
 * App.chipsPanel.render(host, { key, files, entries, compact, piece }) — render a panel into any element.
 *   piece: a chip target from App.chipset.pieceTarget() (the viewer's selected video piece) — clicks tag the piece.
 */
(() => {
    'use strict';
    const { h, formatCount, compareNames } = App.util;
    const ui = App.ui;
    const cs = () => App.chipset;
    const icon = (name, size = 14) => ui.icon(name, { size });

    const states = new Map(); // panel key -> UI state that survives re-renders

    function stateFor(key) {
        if (!states.has(key)) states.set(key, { queries: {}, active: {}, adding: null, expanded: {} });
        return states.get(key);
    }

    // ---------- Focus & scroll survival across re-renders ----------
    function captureFocus(host) {
        const a = document.activeElement;
        if (!a || !host.contains(a)) return null;
        if (a.dataset.search) return { sel: `[data-search="${CSS.escape(a.dataset.search)}"]`, start: a.selectionStart, end: a.selectionEnd };
        if (a.classList.contains('chip-add-input')) return { sel: `.chip-add-input[data-add="${CSS.escape(a.dataset.add)}"][data-parent="${CSS.escape(a.dataset.parent || '')}"]`, value: a.value, start: a.selectionStart, end: a.selectionEnd };
        if (a.dataset.chip) return { sel: `.chip[data-chip="${CSS.escape(a.dataset.chip)}"]` };
        if (a.dataset.action) return { sel: `[data-action="${CSS.escape(a.dataset.action)}"]` };
        return null;
    }

    function restoreFocus(panel, f) {
        if (!f) return;
        const el = panel.querySelector(f.sel);
        if (!el) return;
        if (f.value != null) el.value = f.value;
        el.focus({ preventScroll: true });
        if (f.start != null && el.setSelectionRange) {
            try {
                el.setSelectionRange(f.start, f.end);
            } catch (e) {
                /* not a text field */
            }
        }
        if (el.dataset.search && el.value.trim()) showResults(el);
    }

    // ---------- Rendering ----------
    function render(host, opts) {
        const scroller = host.closest('.insp-zone-scroll, .chip-drawer-body');
        const scrollTop = scroller ? scroller.scrollTop : 0;
        const focus = captureFocus(host);
        const panel = buildPanel(opts);
        host.replaceChildren(panel);
        if (scroller) scroller.scrollTop = scrollTop;
        restoreFocus(panel, focus);
    }

    function buildPanel(opts) {
        const C = cs();
        const st = stateFor(opts.key);
        const panel = h('div', { class: `chip-panel${opts.compact ? ' compact' : ''}`, dataset: { panel: opts.key } });
        panel._opts = opts;
        bindPanel(panel);
        if (!C || !C.ready) {
            panel.append(h('div', { class: 'chip-loading' }, h('span', { class: 'spinner' }), h('span', { text: '칩셋을 불러오는 중…' })));
            return panel;
        }
        const preset = C.active();
        const files = opts.files || [];
        const piece = opts.piece || null;
        const n = piece ? 1 : files.length;
        const counts = piece ? C.countsFor(piece) : C.counts(files);
        // A different selection starts clean (no "just tagged" sub-row)
        const filesKey = `${n}|${files[0] || ''}|${files[files.length - 1] || ''}|${piece ? piece.start : ''}`;
        if (st.filesKey !== filesKey) {
            st.filesKey = filesKey;
            st.lastChip = null;
        }
        const ctx = {
            C,
            st,
            n,
            files,
            counts,
            opts,
            stateOf(id) {
                const c = counts.get(id) || 0;
                return !n || !c ? 'off' : c === n ? 'on' : 'mixed';
            },
        };
        if (!opts.compact) panel.append(renderHead(preset));
        const target = targetLine(ctx);
        if (target) panel.append(target);
        const legacy = piece ? null : legacyBanner(ctx);
        if (legacy) panel.append(legacy);
        if (!preset.categories.length) {
            panel.append(emptyState());
        } else {
            const cats = h('div', { class: 'chip-cats' });
            for (const cat of preset.categories) cats.append(renderCategory(cat, ctx));
            panel.append(cats);
        }
        const others = otherChips(ctx);
        if (others) panel.append(others);
        if (opts.compact) {
            panel.append(h('div', { class: 'chip-compact-foot' },
                h('button', { type: 'button', class: 'btn ghost sm', dataset: { action: 'preset-menu' }, html: `${icon('layers', 13)}<span class="truncate"></span>${icon('chevron-down', 12)}` }),
                h('span', { class: 'grow' }),
                h('button', { type: 'button', class: 'btn ghost sm', dataset: { action: 'add-category' }, 'data-tip': '분류 추가 (배우, 장르처럼)', html: `${icon('plus', 13)}<span>분류</span>` }),
                h('button', { type: 'button', class: 'btn ghost sm', dataset: { action: 'picker' }, 'data-tip': '칩 찾기 · 없는 이름은 Enter로 새로 만들어요', 'data-tip-keys': '#', html: `${icon('hash', 13)}<span>찾기</span>` })));
            panel.querySelector('.chip-compact-foot .truncate').textContent = preset.name;
        }
        return panel;
    }

    function renderHead(preset) {
        const presetBtn = h('button', { type: 'button', class: 'chip-preset-btn', dataset: { action: 'preset-menu' }, 'data-tip': '칩셋 프리셋 바꾸기·관리', 'aria-haspopup': 'menu' },
            h('span', { class: 'chip-preset-ico', html: icon('layers', 14) }),
            h('span', { class: 'chip-preset-name truncate', text: preset.name }),
            h('span', { class: 'chip-preset-caret', html: icon('chevron-down', 12) }));
        return h('div', { class: 'chip-head' },
            h('span', { class: 'chip-head-title', text: '칩' }),
            presetBtn,
            h('span', { class: 'grow' }),
            h('button', { type: 'button', class: 'btn ghost sm icon', dataset: { action: 'picker' }, 'aria-label': '칩 검색해서 고르기', 'data-tip': '칩 검색해서 고르기', 'data-tip-keys': '#', html: icon('hash', 15) }),
            h('button', { type: 'button', class: 'btn ghost sm icon', dataset: { action: 'add-category' }, 'aria-label': '분류 추가', 'data-tip': '분류 추가', html: icon('plus', 15) }),
            h('button', { type: 'button', class: 'btn ghost sm icon', dataset: { action: 'panel-menu' }, 'aria-label': '칩 메뉴', 'data-tip': '칩 메뉴', html: icon('more', 15) }));
    }

    function targetLine(ctx) {
        const piece = ctx.opts.piece;
        if (piece) {
            const el = h('div', { class: 'chip-target piece', html: `${icon('scissors', 13)}<span></span>` });
            el.lastChild.textContent = `${piece.label} (${piece.range})에 붙여요 — 영상 전체에 붙이려면 Esc`;
            return el;
        }
        const entries = ctx.opts.entries || [];
        const dirs = entries.filter((e) => e.kind === 'dir').length;
        let text = '';
        let cls = '';
        if (!ctx.n && !entries.length) {
            if (ctx.opts.compact) return null;
            text = '파일을 고르면 칩을 붙일 수 있어요 · 칩과 분류는 우클릭해서 고쳐요';
            cls = 'muted';
        } else if (!ctx.n) {
            text = '폴더에는 칩을 붙일 수 없어요 — 폴더 안의 파일을 골라 주세요';
            cls = 'warn';
        } else if (ctx.n > 1) {
            text = `${formatCount(ctx.n)}개 파일에 함께 붙이고 떼요${dirs ? ` (폴더 ${formatCount(dirs)}개는 빼고)` : ''}`;
            cls = 'multi';
        } else if (dirs) {
            text = `파일 1개에만 붙여요 (폴더 ${formatCount(dirs)}개는 빼고)`;
            cls = 'multi';
        } else {
            return null;
        }
        const el = h('div', { class: `chip-target ${cls}`, html: `${icon(cls === 'warn' ? 'info' : cls === 'multi' ? 'layers' : 'tag', 13)}<span></span>` });
        el.lastChild.textContent = text;
        return el;
    }

    function legacyBanner(ctx) {
        if (!ctx.n || !App.chipsTools) return null;
        const tags = new Set();
        for (const p of ctx.files) {
            const e = App.catalog.peek(p);
            if (e?.legacyTags?.length && !e.legacyConverted) for (const t of e.legacyTags) tags.add(t);
        }
        if (!tags.size) return null;
        const row = h('div', { class: 'chip-row' });
        for (const t of [...tags].slice(0, 12)) row.append(h('span', { class: 'chip legacy', text: `#${t}` }));
        if (tags.size > 12) row.append(h('span', { class: 'chip-more', text: `+${tags.size - 12}` }));
        return h('div', { class: 'chip-legacy' },
            h('div', { class: 'chip-legacy-head', html: `${icon('download', 13)}<span>이전 버전 태그</span>` }),
            row,
            h('button', { type: 'button', class: 'btn sm primary', dataset: { action: 'convert-legacy' }, html: `${icon('sparkles', 13)}<span>칩으로 바꾸기</span>` }));
    }

    function emptyState() {
        return h('div', { class: 'chip-empty' },
            h('div', { class: 'chip-empty-icon', html: icon('tag', 22) }),
            h('div', { class: 'chip-empty-title', text: '아직 분류가 없어요' }),
            h('div', { class: 'chip-empty-text', text: "'배우', '장르'처럼 분류를 만들고 그 안에 칩을 넣어 보세요. 파일을 고르고 칩을 누르면 붙어요." }),
            h('div', { class: 'chip-empty-actions' },
                h('button', { type: 'button', class: 'btn primary sm', dataset: { action: 'add-category' }, html: `${icon('plus', 13)}<span>첫 분류 만들기</span>` }),
                h('button', { type: 'button', class: 'btn sm', dataset: { action: 'autofill' }, html: `${icon('sparkles', 13)}<span>폴더 이름으로 채우기</span>` })));
    }

    function chipButton(chip, ctx, { sub = false, suggest = false } = {}) {
        const s = suggest ? 'off' : ctx.stateOf(chip.id);
        const key = ctx.C.hotkeyOf(chip.id);
        const cnt = ctx.counts.get(chip.id) || 0;
        let tip = chip.name;
        if (ctx.n) {
            if (s === 'on') tip = `${chip.name} — 누르면 떼요`;
            else if (s === 'mixed') tip = `${chip.name} — ${formatCount(ctx.n)}개 중 ${formatCount(cnt)}개에 붙어 있어요. 누르면 모두 붙여요`;
            else tip = `${chip.name} — 누르면 붙여요`;
        }
        return h('button', {
            type: 'button',
            class: `chip is-${s}${sub ? ' sub' : ''}${suggest ? ' suggest' : ''}${!sub && chip.children?.length ? ' has-children' : ''}`,
            dataset: { chip: chip.id },
            'aria-pressed': s === 'on' ? 'true' : s === 'mixed' ? 'mixed' : 'false',
            'data-tip': tip,
            'data-tip-keys': key || null,
        },
            h('span', { class: 'chip-name', text: chip.name }),
            s === 'mixed' ? h('span', { class: 'chip-frac', text: `${cnt}/${ctx.n}` }) : null,
            key ? h('span', { class: 'chip-key', text: key }) : null);
    }

    function addControl(ctx, cat, parent) {
        const a = ctx.st.adding;
        if (a && a.catId === cat.id && (a.parentId || '') === (parent?.id || '')) {
            return h('input', {
                class: 'chip-add-input',
                type: 'text',
                placeholder: parent ? '하위 칩 이름' : '칩 이름 · 쉼표로 여러 개',
                dataset: { add: cat.id, parent: parent?.id || '' },
                spellcheck: 'false',
                autocomplete: 'off',
                'aria-label': parent ? `${parent.name}에 하위 칩 추가` : `${cat.name}에 칩 추가`,
            });
        }
        return h('button', {
            type: 'button',
            class: `chip chip-add${parent ? ' sub' : ''}`,
            dataset: { add: cat.id, parent: parent?.id || '' },
            'aria-label': parent ? `${parent.name}에 하위 칩 추가` : `${cat.name}에 칩 추가`,
            'data-tip': parent ? '하위 칩 추가' : '칩 추가',
            html: icon('plus', 12),
        });
    }

    function renderCategory(cat, ctx) {
        const el = h('div', { class: `chip-cat mode-${cat.mode}${cat.color ? ' colored' : ''}`, dataset: { cat: cat.id } });
        if (cat.color) el.style.setProperty('--cc', `var(--label-${cat.color})`);
        let on = 0;
        if (ctx.n) for (const ch of cat.chips) if (ctx.counts.get(ch.id)) on++;
        const badges = [];
        if (cat.mode === 'search') badges.push(h('span', { class: 'chip-cat-badge', text: `검색형 · ${formatCount(cat.chips.length)}` }));
        if (cat.single) badges.push(h('span', { class: 'chip-cat-badge', text: '하나만' }));
        el.append(h('div', { class: 'chip-cat-head', dataset: { catHead: cat.id } },
            h('span', { class: 'chip-cat-dot' }),
            h('span', { class: 'chip-cat-name', text: cat.name }),
            ...badges,
            on ? h('span', { class: 'chip-cat-on', text: formatCount(on) }) : null,
            h('span', { class: 'grow' }),
            h('button', { type: 'button', class: 'chip-cat-more', dataset: { catMenu: cat.id }, 'aria-label': `${cat.name} 분류 메뉴`, 'data-tip': '분류 메뉴', html: icon('more', 14) })));
        if (cat.mode === 'search') renderSearchCategory(el, cat, ctx);
        else renderSelectCategory(el, cat, ctx);
        return el;
    }

    function renderSelectCategory(el, cat, ctx) {
        const row = h('div', { class: 'chip-row' });
        for (const chip of cat.chips) row.append(chipButton(chip, ctx));
        row.append(addControl(ctx, cat, null));
        el.append(row);
        renderSubRows(el, cat, cat.chips, ctx);
    }

    // A selected parent opens its sub-chip row. Parents without sub-chips only show the row ('+') right after
    // they were tagged (or while a sub-chip is being typed), so a busy panel stays calm.
    function renderSubRows(el, cat, chips, ctx) {
        const a = ctx.st.adding;
        for (const chip of chips) {
            const s = ctx.stateOf(chip.id);
            const fresh = ctx.st.lastChip === chip.id || (a && a.parentId === chip.id);
            const show = chip.children.length > 0 ? (ctx.n ? s !== 'off' : true) : ctx.n && s !== 'off' && fresh;
            if (!show) continue;
            const row = h('div', { class: 'chip-sub-row', dataset: { parent: chip.id } },
                h('span', { class: 'chip-sub-label', text: chip.name }));
            for (const sub of chip.children) row.append(chipButton(sub, ctx, { sub: true }));
            row.append(addControl(ctx, cat, chip));
            el.append(row);
        }
    }

    function renderSearchCategory(el, cat, ctx) {
        const q = ctx.st.queries[cat.id] || '';
        const input = h('input', {
            class: 'input chip-search-input',
            type: 'text',
            value: q,
            placeholder: cat.chips.length ? `${cat.name} 검색 (초성도 돼요) — 없으면 Enter로 추가` : `첫 ${cat.name} 칩 이름을 쓰고 Enter`,
            dataset: { search: cat.id },
            spellcheck: 'false',
            autocomplete: 'off',
            role: 'combobox',
            'aria-expanded': 'false',
            'aria-label': `${cat.name} 검색`,
        });
        el.append(h('div', { class: 'chip-search' }, h('span', { class: 'chip-search-ico', html: icon('search', 13) }), input));
        const onChips = cat.chips.filter((ch) => ctx.stateOf(ch.id) !== 'off');
        if (onChips.length) {
            const row = h('div', { class: 'chip-row' });
            for (const chip of onChips) row.append(chipButton(chip, ctx));
            el.append(row);
        }
        if (ctx.n) {
            const rec = ctx.C.recent()
                .filter((id) => {
                    const i = ctx.C.info(id);
                    return i && i.cat.id === cat.id && !i.parent && ctx.C.inActive(id) && ctx.stateOf(id) === 'off';
                })
                .slice(0, ctx.opts.compact ? 4 : 6);
            if (rec.length) {
                const row = h('div', { class: 'chip-row chip-recent' }, h('span', { class: 'chip-recent-label', text: '최근' }));
                for (const id of rec) row.append(chipButton(ctx.C.info(id).chip, ctx, { suggest: true }));
                el.append(row);
            }
        }
        renderSubRows(el, cat, onChips, ctx);
    }

    function otherChips(ctx) {
        if (!ctx.n) return null;
        const ids = [...ctx.counts.keys()].filter((id) => ctx.C.info(id) && !ctx.C.inActive(id));
        if (!ids.length) return null;
        const row = h('div', { class: 'chip-row' });
        for (const id of ctx.C.sortIds(ids)) {
            const i = ctx.C.info(id);
            const s = ctx.stateOf(id);
            row.append(h('button', {
                type: 'button',
                class: `chip other is-${s}`,
                dataset: { chip: id, other: '1' },
                'data-tip': `${i.preset.name} 프리셋의 칩 — 누르면 떼요`,
            }, h('span', { class: 'chip-name', text: ctx.C.labelOf(id, ' › ') }), h('span', { class: 'chip-x', html: icon('x', 11) })));
        }
        return h('div', { class: 'chip-cat chip-others' },
            h('div', { class: 'chip-cat-head' }, h('span', { class: 'chip-cat-name', text: '다른 프리셋의 칩' })),
            row);
    }

    // ---------- Search results (검색형) ----------
    function searchItems(cat, q) {
        const C = cs();
        const items = [];
        for (const chip of cat.chips) {
            const m = C.match(q, chip.name);
            if (m) items.push({ chip, parent: null, score: m.score, indices: m.indices });
            for (const sub of chip.children) {
                const m2 = C.match(q, sub.name);
                if (m2) items.push({ chip: sub, parent: chip, score: m2.score - 40, indices: m2.indices });
            }
        }
        items.sort((a, b) => b.score - a.score || compareNames(a.chip.name, b.chip.name));
        return items.slice(0, 30);
    }

    function highlight(text, indices) {
        const set = new Set(indices || []);
        const frag = document.createDocumentFragment();
        [...text].forEach((ch, i) => frag.append(set.has(i) ? h('mark', { text: ch }) : document.createTextNode(ch)));
        return frag;
    }

    function showResults(input) {
        const panel = input.closest('.chip-panel');
        const C = cs();
        if (!panel || !C?.ready) return;
        const st = stateFor(panel.dataset.panel);
        const catId = input.dataset.search;
        const cat = C.category(catId);
        const box = input.closest('.chip-search');
        let list = box.querySelector('.chip-results');
        st.queries[catId] = input.value;
        const q = input.value.trim();
        if (!q || !cat) {
            list?.remove();
            input.setAttribute('aria-expanded', 'false');
            return;
        }
        if (!list) {
            list = h('div', { class: 'chip-results', role: 'listbox' });
            box.append(list);
        }
        const opts = panel._opts;
        const counts = opts.piece ? C.countsFor(opts.piece) : C.counts(opts.files || []);
        const n = opts.piece ? 1 : (opts.files || []).length;
        const items = searchItems(cat, q);
        const clean = C.cleanName(q);
        const exact = cat.chips.some((ch) => C.normKey(ch.name) === C.normKey(clean));
        const createErr = C.isInitials(q) ? '초성으로는 새 칩을 만들 수 없어요' : C.validateName(q, cat.chips);
        const rows = items.map((it) => ({ kind: 'chip', ...it }));
        if (!exact && !createErr) rows.push({ kind: 'create', name: clean });
        const active = Math.max(0, Math.min(st.active[catId] ?? 0, rows.length - 1));
        st.active[catId] = active;
        list.innerHTML = '';
        if (!rows.length) {
            list.append(h('div', { class: 'chip-result empty', text: C.isInitials(q) ? '맞는 칩이 없어요' : createErr || '찾는 칩이 없어요' }));
        }
        rows.forEach((r, i) => {
            const row = h('div', { class: `chip-result${i === active ? ' active' : ''}${r.kind === 'create' ? ' create' : ''}`, role: 'option', dataset: { i } });
            if (r.kind === 'create') {
                row.append(h('span', { class: 'chip-result-mark', html: icon('plus', 12) }), h('span', { class: 'chip-result-name', text: `새 칩 「${r.name}」 만들기${n ? ' + 붙이기' : ''}` }));
            } else {
                const c = counts.get(r.chip.id) || 0;
                const s = !n || !c ? 'off' : c === n ? 'on' : 'mixed';
                row.append(h('span', { class: `chip-result-mark ${s}`, html: s === 'on' ? icon('check', 12) : s === 'mixed' ? icon('minus', 12) : '' }));
                const name = h('span', { class: 'chip-result-name' });
                if (r.parent) name.append(h('span', { class: 'faint', text: `${r.parent.name} › ` }));
                name.append(highlight(r.chip.name, r.indices));
                row.append(name);
                if (s === 'mixed') row.append(h('span', { class: 'chip-result-frac', text: `${c}/${n}` }));
                const key = C.hotkeyOf(r.chip.id);
                if (key) row.append(h('span', { class: 'kbd', text: key }));
            }
            row._row = r;
            list.append(row);
        });
        list._rows = rows;
        input.setAttribute('aria-expanded', 'true');
        list.querySelector('.chip-result.active')?.scrollIntoView({ block: 'nearest' });
    }

    function hideResults(input) {
        input.closest('.chip-search')?.querySelector('.chip-results')?.remove();
        input.setAttribute('aria-expanded', 'false');
    }

    function pickResult(input, row, { remove = false } = {}) {
        const panel = input.closest('.chip-panel');
        const C = cs();
        const opts = panel._opts;
        const st = stateFor(panel.dataset.panel);
        const catId = input.dataset.search;
        const files = opts.files || [];
        let id = null;
        if (row.kind === 'create') {
            try {
                id = C.createAndApply(catId, row.name, opts.piece || files);
            } catch (e) {
                ui.toast(e.message, { type: 'warning' });
                return;
            }
        } else if (opts.piece) {
            C.applyPiece(opts.piece, row.chip.id, remove ? 'remove' : 'toggle');
        } else {
            id = row.chip.id;
            if (!files.length) {
                C.hud('칩을 붙일 파일을 먼저 선택해 주세요', { kind: 'info', sub: C.hudLabel(id) });
                return;
            }
            C.apply(files, id, remove ? 'remove' : 'toggle');
        }
        st.queries[catId] = '';
        st.active[catId] = 0;
        input.value = '';
        hideResults(input);
    }

    // ---------- Event wiring (per panel element) ----------
    function bindPanel(panel) {
        panel.addEventListener('click', onClick);
        panel.addEventListener('contextmenu', onContextMenu);
        panel.addEventListener('keydown', onKeyDown);
        panel.addEventListener('input', (e) => {
            if (e.target.dataset?.search) {
                stateFor(panel.dataset.panel).active[e.target.dataset.search] = 0;
                showResults(e.target);
            }
        });
        panel.addEventListener('focusin', (e) => {
            if (e.target.dataset?.search && e.target.value.trim()) showResults(e.target);
        });
        panel.addEventListener('focusout', (e) => {
            const t = e.target;
            if (t.dataset?.search) setTimeout(() => document.activeElement !== t && t.isConnected && hideResults(t), 120);
            if (t.classList?.contains('chip-add-input')) {
                setTimeout(() => {
                    if (!t.isConnected || document.activeElement === t) return;
                    const st = stateFor(panel.dataset.panel);
                    if (st.adding && st.adding.catId === t.dataset.add) {
                        st.adding = null;
                        rerenderAll();
                    }
                }, 120);
            }
        });
        panel.addEventListener('mousedown', (e) => {
            const r = e.target.closest('.chip-result');
            if (!r) return;
            e.preventDefault(); // keep focus in the search box
            const input = r.closest('.chip-search').querySelector('input');
            const list = r.parentNode;
            const row = list._rows?.[Number(r.dataset.i)];
            if (row) pickResult(input, row, { remove: e.shiftKey });
        });
    }

    function panelOf(el) {
        return el.closest('.chip-panel');
    }

    /** If e is the undo/redo shortcut, run it (from any field) and return true. */
    function runUndoKey(e) {
        const combo = App.commands.comboFromEvent?.(e);
        if (!combo) return false;
        for (const [id, fallback] of [['edit.undo', () => App.undo.undo()], ['edit.redo', () => App.undo.redo()]]) {
            const cmd = App.commands.get(id);
            const keys = cmd ? cmd.keys : id === 'edit.undo' ? ['Mod+Z'] : ['Mod+Shift+Z', 'Mod+Y'];
            if (!keys.includes(combo)) continue;
            e.preventDefault();
            e.stopPropagation();
            if (cmd) App.commands.run(id);
            else fallback();
            return true;
        }
        return false;
    }

    /**
     * The panel's options as of now. The inspector re-renders on a short debounce, so a click right after picking
     * another file must act on that file, not on the one the panel was last drawn for.
     */
    function liveOpts(panel) {
        if (panel.dataset.panel === 'inspector' && App.inspector?.flushPending?.()) {
            const fresh = document.querySelector('.chip-panel[data-panel="inspector"]');
            if (fresh?._opts) return fresh._opts;
        }
        return panel._opts;
    }

    // A re-render (undo, a hotkey, a selection change…) between mousedown and mouseup swaps the chip element and the
    // browser drops the click. If press and release land on the same chip of the same panel, click the new element.
    let pressed = null;
    let chipClicks = 0;
    document.addEventListener('mousedown', (e) => {
        const el = e.button === 0 ? e.target.closest?.('.chip-panel .chip[data-chip]') : null;
        pressed = el ? { el, id: el.dataset.chip, panel: el.closest('.chip-panel').dataset.panel } : null;
    }, true);
    document.addEventListener('mouseup', (e) => {
        const p = pressed;
        pressed = null;
        if (!p || e.button !== 0 || p.el.isConnected) return;
        const now = e.target.closest?.('.chip-panel .chip[data-chip]');
        if (!now || now.dataset.chip !== p.id || now.closest('.chip-panel').dataset.panel !== p.panel) return;
        const seq = chipClicks;
        setTimeout(() => {
            if (chipClicks !== seq) return; // the browser delivered the click after all
            const el = now.isConnected ? now : document.querySelector(`.chip-panel[data-panel="${CSS.escape(p.panel)}"] .chip[data-chip="${CSS.escape(p.id)}"]`);
            el?.click();
        });
    }, true);

    function onClick(e) {
        const panel = panelOf(e.target);
        const C = cs();
        if (!panel || !C?.ready) return;
        const opts = panel._opts;
        const st = stateFor(panel.dataset.panel);
        const act = e.target.closest('[data-action]');
        if (act) {
            const a = act.dataset.action;
            if (a === 'preset-menu') presetMenu({ anchor: act });
            else if (a === 'add-category') App.commands.run('chips.addCategory');
            else if (a === 'panel-menu') ui.menu(panelMenuItems(), { anchor: act, align: 'end' });
            else if (a === 'picker') App.commands.run(opts.key === 'drawer' ? 'chips.picker.viewer' : 'chips.picker');
            else if (a === 'autofill') App.commands.run('chips.autofill');
            else if (a === 'convert-legacy') App.commands.run('chips.convertLegacy');
            return;
        }
        const more = e.target.closest('[data-cat-menu]');
        if (more) {
            const r = more.getBoundingClientRect();
            ui.menu(categoryMenuItems(more.dataset.catMenu), { x: r.left, y: r.bottom + 4 });
            return;
        }
        const add = e.target.closest('.chip-add');
        if (add) {
            st.adding = { catId: add.dataset.add, parentId: add.dataset.parent || null };
            rerenderAll();
            requestAnimationFrame(() => document.querySelector(`.chip-panel[data-panel="${panel.dataset.panel}"] .chip-add-input`)?.focus());
            return;
        }
        const chip = e.target.closest('.chip[data-chip]');
        if (chip) {
            chipClicks++;
            const live = liveOpts(panel);
            const files = live.files || [];
            const id = chip.dataset.chip;
            if (live.piece) {
                const res = C.applyPiece(live.piece, id, chip.dataset.other ? 'remove' : 'toggle');
                st.lastChip = res.mode === 'add' ? id : null;
                return;
            }
            if (!files.length) {
                C.hud(opts.entries?.length ? '폴더에는 칩을 붙일 수 없어요' : '칩을 붙일 파일을 먼저 선택해 주세요', { kind: 'info', sub: C.hudLabel(id) });
                return;
            }
            const res = C.apply(files, id, chip.dataset.other ? 'remove' : 'toggle');
            st.lastChip = res.mode === 'add' ? id : null;
        }
    }

    function onContextMenu(e) {
        const C = cs();
        if (!C?.ready) return;
        const chip = e.target.closest('.chip[data-chip]');
        const head = e.target.closest('[data-cat-head]');
        let items = null;
        if (chip && !chip.dataset.other) items = chipMenuItems(chip.dataset.chip);
        else if (head) items = categoryMenuItems(head.dataset.catHead);
        else if (e.target.closest('.chip-panel')) items = panelMenuItems();
        if (!items) return;
        e.preventDefault();
        e.stopPropagation();
        ui.menu(items, { x: e.clientX, y: e.clientY });
    }

    function onKeyDown(e) {
        const t = e.target;
        const panel = panelOf(t);
        if (!panel) return;
        const st = stateFor(panel.dataset.panel);
        if (e.isComposing || e.keyCode === 229) return; // Hangul IME is still composing
        // Ctrl+Z / Ctrl+Shift+Z in an EMPTY chip field undoes the last app change (e.g. the chip just picked here);
        // with text in the field the browser's own text undo applies.
        if ((t.dataset?.search || t.classList.contains('chip-add-input')) && !t.value && runUndoKey(e)) return;
        // Search box of a 검색형 category
        if (t.dataset?.search) {
            const list = t.closest('.chip-search').querySelector('.chip-results');
            const rows = list?._rows || [];
            const catId = t.dataset.search;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (!rows.length) return;
                const cur = st.active[catId] ?? 0;
                st.active[catId] = (cur + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
                showResults(t);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                if (!t.value.trim()) return;
                showResults(t);
                const fresh = t.closest('.chip-search').querySelector('.chip-results')?._rows || [];
                const row = fresh[st.active[catId] ?? 0];
                if (row) pickResult(t, row, { remove: e.shiftKey });
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                if (t.value) {
                    t.value = '';
                    st.queries[catId] = '';
                    hideResults(t);
                } else {
                    t.blur();
                    document.getElementById('gallery-scroll')?.focus();
                }
            }
            return;
        }
        // Inline "add chip" field
        if (t.classList.contains('chip-add-input')) {
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                const names = t.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
                if (!names.length) {
                    st.adding = null;
                    rerenderAll();
                    return;
                }
                const bad = names.map((n) => cs().validateName(n)).find(Boolean);
                if (bad) {
                    ui.toast(bad, { type: 'warning' });
                    return;
                }
                try {
                    const made = cs().addChips(t.dataset.add, names, { parentId: t.dataset.parent || null });
                    t.value = '';
                    if (made.length) cs().hud(`＋ 칩 ${made.length > 1 ? `${made.length}개` : `「${made[0].name}」`} 추가`, { kind: 'add', sub: '계속 입력하거나 Esc로 마쳐요' });
                } catch (err) {
                    ui.toast(err.message, { type: 'warning' });
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                st.adding = null;
                rerenderAll();
            }
            return;
        }
        // A focused chip: Enter / Space toggle it (instead of opening the file)
        const chip = t.closest?.('.chip[data-chip]');
        if (chip && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            e.stopPropagation();
            chip.click();
        }
    }

    // ---------- Menus ----------
    function presetMenu(pos) {
        const C = cs();
        if (!C?.ready) return;
        const list = C.presets();
        const i = list.findIndex((p) => p.active);
        const cur = list[i];
        ui.menu([
            { header: '칩셋 프리셋' },
            ...list.map((p) => ({ label: p.name, checked: p.active, hint: p.categories ? `분류 ${p.categories}` : '비어 있음', action: () => C.setActive(p.id) })),
            '-',
            { label: '새 프리셋…', icon: 'plus', command: 'chips.newPreset' },
            { label: '지금 프리셋 복제…', icon: 'copy', command: 'chips.duplicatePreset' },
            { label: '이름 바꾸기…', icon: 'edit', command: 'chips.renamePreset' },
            list.length > 1
                ? {
                    label: '순서 바꾸기',
                    icon: 'sort',
                    submenu: () => [
                        { label: '위로', icon: 'arrow-up', disabled: i <= 0, action: () => C.movePreset(cur.id, -1) },
                        { label: '아래로', icon: 'chevron-down', disabled: i >= list.length - 1, action: () => C.movePreset(cur.id, 1) },
                    ],
                }
                : null,
            '-',
            { label: '프리셋 삭제…', icon: 'trash', danger: true, command: 'chips.deletePreset', disabled: list.length <= 1 },
        ], pos);
    }

    function panelMenuItems() {
        return [
            { label: '분류 추가…', icon: 'plus', command: 'chips.addCategory' },
            { label: '칩 검색해서 고르기', icon: 'hash', command: 'chips.picker' },
            '-',
            { label: '칩 자동 채우기…', icon: 'sparkles', command: 'chips.autofill' },
            { label: '이전 버전 태그 찾기', icon: 'download', command: 'chips.importLegacy' },
            { label: '이전 버전 태그를 칩으로 바꾸기…', icon: 'tag', command: 'chips.convertLegacy' },
            '-',
            { label: '칩 복사', icon: 'copy', command: 'chips.copy' },
            { label: '칩 붙여넣기', icon: 'download', command: 'chips.paste' },
            { label: '고른 파일의 칩 모두 떼기', icon: 'x', command: 'chips.clearSelection' },
        ];
    }

    function categoryMenuItems(catId) {
        const C = cs();
        const cat = C.category(catId);
        if (!cat) return null;
        const cats = C.active().categories;
        const i = cats.indexOf(cat);
        return [
            { header: cat.name },
            { label: '칩 추가', icon: 'plus', action: () => startAdding(cat.id, null) },
            { label: '분류 설정…', icon: 'settings', action: () => editCategory(cat.id) },
            { label: cat.mode === 'search' ? '선택형으로 바꾸기 (칩 모두 펼치기)' : '검색형으로 바꾸기 (검색해서 고르기)', icon: cat.mode === 'search' ? 'grid' : 'search', action: () => C.setCategory(cat.id, { mode: cat.mode === 'search' ? 'select' : 'search' }) },
            {
                label: '색',
                icon: 'tag',
                submenu: () => [
                    { label: '색 없음', checked: !cat.color, action: () => C.setCategory(cat.id, { color: null }) },
                    ...C.COLORS.map((c) => ({ label: C.COLOR_NAMES[c], checked: cat.color === c, action: () => C.setCategory(cat.id, { color: c }) })),
                ],
            },
            { label: '이름 바꾸기…', icon: 'edit', action: () => renameCategory(cat.id) },
            '-',
            { label: '위로', icon: 'arrow-up', disabled: i <= 0, action: () => C.moveCategory(cat.id, -1) },
            { label: '아래로', icon: 'chevron-down', disabled: i >= cats.length - 1, action: () => C.moveCategory(cat.id, 1) },
            '-',
            { label: '분류 삭제…', icon: 'trash', danger: true, action: () => deleteCategory(cat.id) },
        ];
    }

    function chipMenuItems(id) {
        const C = cs();
        const info = C.info(id);
        if (!info) return null;
        const isSub = !!info.parent;
        const key = C.hotkeyOf(id);
        const preset = C.active();
        const holder = (d) => {
            const hid = preset.hotkeys?.[d];
            return hid && hid !== id ? C.nameOf(hid) : '';
        };
        const used = C.usage().get(id) || 0;
        const otherCats = preset.categories.filter((c) => c.id !== info.cat.id);
        return [
            { header: `${C.labelOf(id)} · 파일 ${formatCount(used)}개` },
            !isSub ? { label: '하위 칩 추가', icon: 'plus', action: () => startAdding(info.cat.id, id) } : null,
            {
                label: key ? `단축키 ${key}` : '단축키 지정',
                icon: 'keyboard',
                submenu: () => [
                    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => ({ label: `${d}${holder(d) ? `  —  지금: ${holder(d)}` : ''}`, checked: key === String(d), action: () => C.setHotkey(id, d) })),
                    '-',
                    { label: '단축키 없애기', checked: false, disabled: !key, action: () => C.setHotkey(id, null) },
                ],
            },
            { label: '이 칩이 붙은 파일 보기', icon: 'search', disabled: !used, action: () => App.chipsFilter?.showChip(id) },
            '-',
            { label: '이름 바꾸기…', icon: 'edit', action: () => renameChip(id) },
            { label: '다른 칩과 합치기…', icon: 'merge', action: () => mergeChip(id) },
            !isSub && otherCats.length
                ? { label: '다른 분류로 옮기기', icon: 'folder-input', submenu: () => otherCats.map((c) => ({ label: c.name, action: () => guard(() => C.moveChipTo(id, c.id)) })) }
                : null,
            { label: isSub ? '앞으로' : '앞으로 (왼쪽)', icon: 'arrow-left', action: () => C.moveChip(id, -1) },
            { label: isSub ? '뒤로' : '뒤로 (오른쪽)', icon: 'arrow-right', action: () => C.moveChip(id, 1) },
            '-',
            { label: '칩 삭제…', icon: 'trash', danger: true, action: () => deleteChip(id) },
        ].filter(Boolean);
    }

    function guard(fn) {
        try {
            return fn();
        } catch (e) {
            ui.toast(e.message, { type: 'warning' });
            return null;
        }
    }

    // Where new chips are typed: the chip drawer while the viewer is open (opened if needed), else the inspector
    function addHost() {
        if (App.viewer?.isOpen && App.chipsViewer) {
            if (!App.chipsViewer.isOpen) App.chipsViewer.toggle(true);
            return '.chip-panel[data-panel="drawer"]';
        }
        if (App.layout && !App.layout.isVisible('inspector')) App.layout.setPanel('inspector', true);
        return '.chip-panel[data-panel="inspector"]';
    }

    function startAdding(catId, parentId) {
        const C = cs();
        const cat = C.category(catId);
        if (!cat) return;
        const host = addHost();
        if (cat.mode === 'search' && !parentId) {
            // 검색형: the search box doubles as the "new chip" field
            requestAnimationFrame(() => document.querySelector(`${host} [data-search="${CSS.escape(catId)}"]`)?.focus());
            return;
        }
        for (const st of states.values()) st.adding = { catId, parentId };
        rerenderAll();
        // (one selector list would return the first match in document order — the inspector, hidden behind the viewer)
        requestAnimationFrame(() => (document.querySelector(`${host} .chip-add-input`) || document.querySelector('.chip-panel .chip-add-input'))?.focus());
    }

    // ---------- Dialogs ----------
    function categoryDialog({ title, okLabel, cat = null }) {
        const C = cs();
        let mode = cat?.mode || 'select';
        let color = cat?.color || null;
        const name = h('input', { class: 'input', type: 'text', value: cat?.name || '', placeholder: '예: 배우, 장르, 상태', spellcheck: 'false', autocomplete: 'off' });
        const err = h('div', { class: 'field-error' });
        const modeBtns = ['select', 'search'].map((m) => h('button', { type: 'button', class: `chip-mode-opt${m === mode ? ' on' : ''}`, dataset: { mode: m } },
            h('span', { class: 'chip-mode-ico', html: icon(m === 'select' ? 'grid' : 'search', 16) }),
            h('span', { class: 'chip-mode-text' },
                h('b', { text: C.MODE_NAMES[m] }),
                h('span', { text: m === 'select' ? '칩을 모두 펼쳐 두고 바로 골라요' : '칩이 많을 때 (배우 이름 등) 검색해서 골라요' }))));
        const modeRow = h('div', { class: 'chip-mode-opts' }, ...modeBtns);
        modeRow.addEventListener('click', (e) => {
            const b = e.target.closest('[data-mode]');
            if (!b) return;
            mode = b.dataset.mode;
            modeBtns.forEach((x) => x.classList.toggle('on', x === b));
        });
        const swatches = h('div', { class: 'chip-swatches' },
            h('button', { type: 'button', class: `chip-swatch none${!color ? ' on' : ''}`, dataset: { color: '' }, 'aria-label': '색 없음', 'data-tip': '색 없음' }),
            ...C.COLORS.map((c) => h('button', { type: 'button', class: `chip-swatch${color === c ? ' on' : ''}`, dataset: { color: c }, style: `--sw: var(--label-${c})`, 'aria-label': C.COLOR_NAMES[c], 'data-tip': C.COLOR_NAMES[c] })));
        swatches.addEventListener('click', (e) => {
            const b = e.target.closest('[data-color]');
            if (!b) return;
            color = b.dataset.color || null;
            swatches.querySelectorAll('.chip-swatch').forEach((x) => x.classList.toggle('on', x === b));
        });
        const single = h('input', { type: 'checkbox', checked: !!cat?.single });
        const body = h('div', { class: 'chip-dialog' },
            h('div', { class: 'field' }, h('label', { text: '분류 이름' }), name, err),
            h('div', { class: 'field' }, h('label', { text: '고르는 방식' }), modeRow),
            h('div', { class: 'field' }, h('label', { text: '색 (칩 색깔)' }), swatches),
            h('label', { class: 'chip-check' }, single, h('span', { text: '한 파일에 하나만 고르기 (예: 상태 — 완료/보류)' })));
        const siblings = C.active().categories;
        return ui.dialog({
            title,
            body,
            width: 460,
            actions: [
                { label: '취소', value: null, kind: 'ghost' },
                {
                    label: okLabel,
                    kind: 'primary',
                    onClick: (close) => {
                        const e2 = C.validateName(name.value, siblings, cat);
                        if (e2) {
                            err.textContent = e2;
                            name.classList.add('invalid');
                            name.focus();
                            return;
                        }
                        close({ name: name.value, mode, color, single: single.checked });
                    },
                },
            ],
            init() {
                name.focus();
                name.select();
                name.addEventListener('input', () => {
                    err.textContent = '';
                    name.classList.remove('invalid');
                });
            },
        });
    }

    async function addCategory() {
        const C = cs();
        if (!C?.ready) return;
        const v = await categoryDialog({ title: '분류 추가', okLabel: '만들기' });
        if (!v) return;
        const cat = guard(() => C.addCategory(v));
        if (!cat) return;
        startAdding(cat.id, null);
    }

    async function editCategory(catId) {
        const C = cs();
        const cat = C.category(catId);
        if (!cat) return;
        const v = await categoryDialog({ title: '분류 설정', okLabel: '저장', cat });
        if (!v) return;
        guard(() => {
            C.commit(`분류 설정 "${cat.name}"`, (d, pr) => {
                const c = pr.categories.find((x) => x.id === catId);
                c.name = C.cleanName(v.name);
                c.mode = v.mode === 'search' ? 'search' : 'select';
                if (v.color) c.color = v.color;
                else delete c.color;
                if (v.single) c.single = true;
                else delete c.single;
            });
        });
    }

    async function renameCategory(catId) {
        const C = cs();
        const cat = C.category(catId);
        if (!cat) return;
        const name = await ui.prompt({ title: '분류 이름 바꾸기', value: cat.name, okLabel: '바꾸기', validate: (v) => C.validateName(v, C.active().categories, cat) });
        if (name) guard(() => C.renameCategory(catId, name));
    }

    async function renameChip(id) {
        const C = cs();
        const info = C.info(id);
        if (!info) return;
        const siblings = info.parent ? info.parent.children : info.cat.chips;
        const name = await ui.prompt({ title: info.parent ? '하위 칩 이름 바꾸기' : '칩 이름 바꾸기', message: '이 칩이 붙은 파일에도 새 이름이 바로 보여요.', value: info.chip.name, okLabel: '바꾸기', validate: (v) => C.validateName(v, siblings, info.chip) });
        if (name) guard(() => C.renameChip(id, name));
    }

    async function deleteChip(id) {
        const C = cs();
        const info = C.info(id);
        if (!info) return;
        const ids = C.idsUnder(info.chip);
        const imp = C.impactOf(ids);
        const parts = [`「${C.labelOf(id)}」 칩을 지울까요?`];
        if (info.chip.children?.length) parts.push(`하위 칩 ${info.chip.children.length}개도 함께 지워져요.`);
        if (imp.files) parts.push(`파일 ${formatCount(imp.files)}개에 붙은 칩도 함께 떨어져요.`);
        if (imp.shared) parts.push('다른 프리셋에도 있는 칩은 파일에 그대로 남아요.');
        parts.push(`${App.commands.displayCombo('Mod+Z')}로 되돌릴 수 있어요.`);
        const ok = await ui.confirm({ title: '칩 삭제', message: parts.join(' '), okLabel: '삭제', danger: true });
        if (ok) guard(() => C.removeChip(id));
    }

    async function deleteCategory(catId) {
        const C = cs();
        const cat = C.category(catId);
        if (!cat) return;
        const ids = cat.chips.flatMap(C.idsUnder);
        const imp = C.impactOf(ids);
        const parts = [`「${cat.name}」 분류와 칩 ${formatCount(ids.length)}개를 지울까요?`];
        if (imp.files) parts.push(`파일 ${formatCount(imp.files)}개에 붙은 칩도 함께 떨어져요.`);
        parts.push(`${App.commands.displayCombo('Mod+Z')}로 되돌릴 수 있어요.`);
        const ok = await ui.confirm({ title: '분류 삭제', message: parts.join(' '), okLabel: '삭제', danger: true });
        if (ok) guard(() => C.removeCategory(catId));
    }

    /** chooseDialog({ title, message, items: [{ id, label, sub }], okLabel }) -> Promise<id|null> */
    function chooseDialog({ title, message, items, okLabel = '고르기', placeholder = '찾기' }) {
        const C = cs();
        const input = h('input', { class: 'input', type: 'text', placeholder, spellcheck: 'false', autocomplete: 'off' });
        const list = h('div', { class: 'chip-choose-list', role: 'listbox' });
        let shown = [];
        let active = 0;
        let pickedId = null;
        const draw = () => {
            const q = input.value.trim();
            shown = q ? items.map((it) => ({ it, m: C.match(q, it.label) })).filter((x) => x.m).sort((a, b) => b.m.score - a.m.score).map((x) => ({ ...x.it, indices: x.m.indices })) : items.slice();
            active = Math.min(active, Math.max(0, shown.length - 1));
            list.innerHTML = '';
            if (!shown.length) list.append(h('div', { class: 'chip-result empty', text: '맞는 칩이 없어요' }));
            shown.slice(0, 200).forEach((it, i) => {
                const row = h('div', { class: `chip-result${i === active ? ' active' : ''}`, dataset: { i } }, h('span', { class: 'chip-result-name' }, highlight(it.label, it.indices)), it.sub ? h('span', { class: 'faint', text: it.sub }) : null);
                list.append(row);
            });
            list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
        };
        return ui.dialog({
            title,
            width: 480,
            body: h('div', { class: 'chip-dialog' }, message ? h('p', { text: message }) : null, input, list),
            actions: [
                { label: '취소', value: null, kind: 'ghost' },
                { label: okLabel, kind: 'primary', onClick: (close) => close(shown[active]?.id || null) },
            ],
            init(box, close) {
                draw();
                input.focus();
                input.addEventListener('input', () => {
                    active = 0;
                    draw();
                });
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault();
                        if (!shown.length) return;
                        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
                        draw();
                    }
                });
                list.addEventListener('mousedown', (e) => {
                    const r = e.target.closest('[data-i]');
                    if (!r) return;
                    e.preventDefault();
                    active = Number(r.dataset.i);
                    pickedId = shown[active]?.id || null;
                    close(pickedId);
                });
            },
        });
    }

    async function mergeChip(id) {
        const C = cs();
        const info = C.info(id);
        if (!info) return;
        const isSub = !!info.parent;
        const items = C.list().filter((x) => x.id !== id && (isSub ? x.depth === 1 : x.depth === 0)).map((x) => ({ id: x.id, label: x.label }));
        if (!items.length) {
            ui.toast('합칠 수 있는 다른 칩이 없어요', { type: 'info' });
            return;
        }
        const target = await chooseDialog({
            title: '다른 칩과 합치기',
            message: `「${C.labelOf(id)}」이 붙은 파일에 고른 칩을 붙이고, 이 칩은 지워요.${isSub ? '' : ' 하위 칩도 함께 옮겨요.'}`,
            items,
            okLabel: '합치기',
            placeholder: '합칠 칩 찾기 (초성도 돼요)',
        });
        if (!target) return;
        const res = guard(() => C.mergeChip(id, target));
        if (res) C.hud(`「${C.nameOf(target)}」로 합쳤어요`, { kind: 'add', sub: res.changed ? `파일 ${formatCount(res.changed)}개` : '' });
    }

    async function presetPrompt(title, value, okLabel, self = null) {
        const C = cs();
        return ui.prompt({ title, value, okLabel, validate: (v) => C.validateName(v, C.doc.presets, self) });
    }

    // ---------- Re-render every visible panel ----------
    const renderers = new Set(); // functions that re-render a mounted panel

    function rerenderAll() {
        for (const fn of renderers) fn();
    }

    // ---------- Commands ----------
    const ready = () => App.fs.ready && !!cs()?.ready;
    const selFiles = () => App.select.entries().filter((e) => e.kind === 'file').map((e) => e.path);

    App.commands.register({ id: 'chips.addCategory', title: '칩 분류 추가', group: '칩', icon: 'plus', when: ready, run: addCategory });
    App.commands.register({
        id: 'chips.switchPreset',
        title: '칩셋 프리셋 바꾸기',
        group: '칩',
        icon: 'layers',
        when: ready,
        run: () => {
            const btn = document.querySelector('.chip-panel[data-panel="inspector"] .chip-preset-btn');
            if (btn && btn.getClientRects().length) presetMenu({ anchor: btn });
            else presetMenu({ x: window.innerWidth / 2 - 120, y: window.innerHeight / 3 });
        },
    });
    App.commands.register({
        id: 'chips.nextPreset',
        title: '다음 칩셋 프리셋',
        group: '칩',
        icon: 'layers',
        keys: 'Alt+P',
        when: () => ready() && cs().presets().length > 1,
        run: () => {
            const list = cs().presets();
            const i = list.findIndex((p) => p.active);
            const next = list[(i + 1) % list.length];
            cs().setActive(next.id);
            cs().hud(`프리셋: ${next.name}`, { kind: 'info' });
        },
    });
    App.commands.register({
        id: 'chips.newPreset',
        title: '새 칩셋 프리셋',
        group: '칩',
        icon: 'plus',
        when: ready,
        run: async () => {
            const name = await presetPrompt('새 프리셋', '', '만들기');
            if (name) guard(() => cs().createPreset(name));
        },
    });
    App.commands.register({
        id: 'chips.duplicatePreset',
        title: '칩셋 프리셋 복제',
        group: '칩',
        icon: 'copy',
        when: ready,
        run: async () => {
            const cur = cs().active();
            const name = await presetPrompt('지금 프리셋 복제', `${cur.name} 사본`, '복제');
            if (name) guard(() => cs().createPreset(name, { duplicate: true }));
        },
    });
    App.commands.register({
        id: 'chips.renamePreset',
        title: '칩셋 프리셋 이름 바꾸기',
        group: '칩',
        icon: 'edit',
        when: ready,
        run: async () => {
            const cur = cs().active();
            const name = await presetPrompt('프리셋 이름 바꾸기', cur.name, '바꾸기', cur);
            if (name) guard(() => cs().renamePreset(cur.id, name));
        },
    });
    App.commands.register({
        id: 'chips.deletePreset',
        title: '칩셋 프리셋 삭제',
        group: '칩',
        icon: 'trash',
        when: () => ready() && cs().presets().length > 1,
        run: async () => {
            const C = cs();
            const cur = C.active();
            const imp = C.presetImpact(cur.id);
            const ok = await ui.confirm({
                title: '프리셋 삭제',
                message: `「${cur.name}」 프리셋을 지울까요?${imp.files ? ` 이 프리셋에만 있는 칩이 붙은 파일 ${formatCount(imp.files)}개에서 칩이 떨어져요.` : ''} ${App.commands.displayCombo('Mod+Z')}로 되돌릴 수 있어요.`,
                okLabel: '삭제',
                danger: true,
            });
            if (ok) guard(() => C.deletePreset(cur.id));
        },
    });

    // Copy / paste chips between files (Lightroom-style "copy metadata")
    let clipboard = null;
    App.commands.register({
        id: 'chips.copy',
        title: '칩 복사',
        group: '칩',
        icon: 'copy',
        keys: 'Mod+Alt+C',
        when: () => ready() && selFiles().length > 0,
        run: () => {
            const C = cs();
            const p = App.select.primary()?.kind === 'file' ? App.select.primary().path : selFiles()[0];
            const ids = C.chipsOf(p);
            if (!ids.length) {
                C.hud('복사할 칩이 없어요', { kind: 'info' });
                return;
            }
            clipboard = ids;
            const leaf = ids.filter((id) => !ids.some((x) => C.info(x)?.parent?.id === id));
            C.hud(`칩 ${ids.length}개 복사`, { kind: 'info', sub: leaf.map((x) => C.nameOf(x)).slice(0, 5).join(', ') + (leaf.length > 5 ? ' …' : '') });
        },
    });
    App.commands.register({
        id: 'chips.paste',
        title: '칩 붙여넣기 (더하기)',
        group: '칩',
        icon: 'download',
        keys: 'Mod+Alt+V',
        when: () => ready() && selFiles().length > 0,
        run: () => {
            const C = cs();
            const ids = (clipboard || []).filter((id) => C.info(id));
            if (!ids.length) {
                C.hud('먼저 칩을 복사해 주세요', { kind: 'info', sub: `${App.commands.displayCombo('Mod+Alt+C')} — 칩 복사` });
                return;
            }
            const files = selFiles();
            const { changed } = C.transaction(`칩 붙여넣기 (${ids.length}개)`, (tx) => {
                for (const p of files) {
                    const cur = tx.chipsOf(p);
                    const next = cur.slice();
                    for (const id of ids) if (!next.includes(id)) next.push(id);
                    tx.setChips(p, next);
                }
            });
            C.hud(changed ? `＋ 칩 ${ids.length}개 붙여넣기${files.length > 1 ? ` — ${formatCount(files.length)}개` : ''}` : '이미 모두 붙어 있어요', { kind: changed ? 'add' : 'info' });
        },
    });
    App.commands.register({
        id: 'chips.clearSelection',
        title: '고른 파일의 칩 모두 떼기',
        group: '칩',
        icon: 'x',
        when: () => ready() && selFiles().length > 0,
        run: () => {
            const C = cs();
            const files = selFiles();
            const { changed } = C.transaction('칩 모두 떼기', (tx) => {
                for (const p of files) tx.setChips(p, []);
            });
            C.hud(changed ? `칩을 모두 뗐어요${files.length > 1 ? ` — ${formatCount(changed)}개` : ''}` : '뗄 칩이 없어요', { kind: changed ? 'remove' : 'info', sub: changed ? `${App.commands.displayCombo('Mod+Z')}로 되돌릴 수 있어요` : '' });
        },
    });
    App.commands.register({
        id: 'chips.focusPanel',
        title: '칩 패널로 이동',
        group: '칩',
        icon: 'tag',
        keys: 'Alt+C',
        when: ready,
        run: () => {
            if (App.layout && !App.layout.isVisible('inspector')) App.layout.setPanel('inspector', true);
            requestAnimationFrame(() => {
                const panel = document.querySelector('.chip-panel[data-panel="inspector"]');
                const target = panel?.querySelector('.chip-search-input, .chip[data-chip], [data-action="add-category"]');
                if (target) {
                    target.focus();
                    target.scrollIntoView({ block: 'nearest' });
                }
            });
        },
    });

    // ---------- Gallery: card badge + context menu ----------
    function leafIds(ids) {
        const C = cs();
        const set = new Set(ids);
        return ids.filter((id) => !(C.info(id)?.chip.children || []).some((s) => set.has(s.id)));
    }

    function decorateCard(card, entry) {
        const C = cs();
        if (entry.kind !== 'file' || !C?.ready) return;
        const ids = C.chipsOf(entry.path);
        if (!ids.length) return;
        const media = card.querySelector('.card-media');
        if (!media) return;
        const leaves = leafIds(ids);
        const first = C.info(leaves[0]);
        const badge = h('span', { class: 'chip-card-badge', 'data-tip': leaves.map((id) => C.labelOf(id)).join('  ·  ') },
            h('span', { class: 'chip-card-dot', style: first?.cat.color ? { background: `var(--label-${first.cat.color})` } : null }),
            h('span', { class: 'chip-card-name', text: first?.chip.name || '' }),
            leaves.length > 1 ? h('span', { class: 'chip-card-more', text: `+${leaves.length - 1}` }) : null);
        media.append(badge);
    }

    function contextItems(entries) {
        const C = cs();
        if (!C?.ready) return [];
        const files = C.toFilePaths(entries);
        if (!files.length) return [];
        return [{ label: '칩', icon: 'tag', submenu: () => contextChipItems(files) }];
    }

    function contextChipItems(files) {
        const C = cs();
        const preset = C.active();
        const counts = C.counts(files);
        const n = files.length;
        const items = [];
        let budget = 60;
        for (const cat of preset.categories) {
            if (budget <= 0) break;
            items.push({ header: cat.name });
            const chips = cat.mode === 'search' ? cat.chips.filter((ch) => counts.get(ch.id)) : cat.chips;
            for (const ch of chips) {
                if (budget-- <= 0) break;
                const c = counts.get(ch.id) || 0;
                items.push({ label: ch.name + (c && c < n ? `  (${c}/${n})` : ''), checked: c === n && n > 0, hint: C.hotkeyOf(ch.id) || '', action: () => C.apply(files, ch.id, 'toggle') });
                if (c) {
                    for (const s of ch.children) {
                        const sc = counts.get(s.id) || 0;
                        items.push({ label: `   └ ${s.name}${sc && sc < n ? `  (${sc}/${n})` : ''}`, checked: sc === n, hint: C.hotkeyOf(s.id) || '', action: () => C.apply(files, s.id, 'toggle') });
                    }
                }
            }
            if (cat.mode === 'search') items.push({ label: `${cat.name}에서 찾기…`, icon: 'search', action: () => App.commands.run('chips.picker') });
        }
        if (!preset.categories.length) items.push({ label: '분류를 먼저 만들어 주세요', disabled: true });
        items.push('-',
            { label: '검색해서 고르기…', icon: 'hash', command: 'chips.picker' },
            { label: '칩 복사', icon: 'copy', command: 'chips.copy' },
            { label: '칩 붙여넣기', icon: 'download', command: 'chips.paste', disabled: !clipboard },
            { label: '칩 모두 떼기', icon: 'x', command: 'chips.clearSelection', danger: true });
        return items;
    }

    // ---------- Inspector section ----------
    let inspectorBody = null;
    let inspectorCtx = null;

    function renderInspector() {
        if (!inspectorBody || !inspectorBody.isConnected || !inspectorCtx) return;
        render(inspectorBody, { key: 'inspector', files: inspectorCtx.files.map((f) => f.path), entries: inspectorCtx.entries });
    }
    renderers.add(renderInspector);

    App.inspector.addSection({
        id: 'chips',
        order: 20,
        update(body, c) {
            inspectorBody = body;
            inspectorCtx = c;
            renderInspector();
        },
        onHide() {
            inspectorBody = null;
        },
    });

    const refreshCards = App.util.debounce(() => App.gallery?.refresh(), 60);

    App.register('chips-panel', {
        init() {
            App.gallery?.cardDecorators.push(decorateCard);
            App.gallery?.contextMenuItems.push(contextItems);
            App.bus.on('chipset:changed', ({ reason }) => {
                if (reason === 'load' || reason === 'close' || reason === 'preset') states.clear();
                refreshCards();
            });
        },
    });

    App.chipsPanel = { render, rerenderAll, renderers, chooseDialog, presetMenu, categoryDialog, stateFor, runUndoKey };
})();
