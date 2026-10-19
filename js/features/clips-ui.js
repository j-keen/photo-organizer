/*
 * Clip library "보관함" — UI (clips team).
 *   Sidebar section '보관함' (App.sidebar.addSection): search (Hangul initials), chip filter, a virtualized list with a
 *   frame thumbnail at each clip's start, multi-select (click / Ctrl / Shift / keyboard), drag (or Alt+↑/↓) to reorder,
 *   right-click menu, a footer with the scope's count + total length and 이어 보기 / 하나로 저장 / 각각 저장.
 *   With nothing selected, playing and saving act on the current filter ("배우A 조각 12개 이어 보기").
 *   Inspector section listing the selected video's clips; a scissors badge on video cards that have clips.
 *
 * List keys (while the list has focus): ↑↓ PgUp PgDn Home End (Shift extends), Space toggle, Mod+A all, Enter play,
 *   Shift+Enter 이어 보기, F2 메모, # 칩, Delete 빼기, Alt+↑/↓ move, Esc clear → gallery, typing → search.
 * Commands (group '보관함'): clips.focus (Alt+B) and one command per action, all in the palette.
 * Public: App.clipsUi = { focus(ids), setFilter({ query, chips, path }), scope(), state }
 */
(() => {
    'use strict';
    const { h, path: P, formatCount, escapeHtml } = App.util;
    const ui = App.ui;
    const icon = (name, size = 14) => ui.icon(name, { size });

    const ROW = 52;
    const BUFFER = 6;
    const DEFAULT_ROWS = 6;
    const MIME = 'application/x-fi-clips';

    const CL = () => App.clips;
    const CS = () => App.chipset;

    // ---------- State ----------
    const sel = new Set();
    let focusId = null;
    let anchorId = null;
    let query = '';
    const chipFilter = new Set();
    let pathFilter = null;
    let visible = [];
    let lastScopeKey = '';

    // DOM
    let body = null;
    let searchInput = null;
    let searchClear = null;
    let tokenRow = null;
    let listEl = null;
    let innerEl = null;
    let dropLine = null;
    let emptyEl = null;
    let footEl = null;
    let noteEl = null;
    const rows = new Map(); // id -> { el, sig, ctl }
    let dropIndex = -1;

    // ---------- Derived data ----------
    function filterActive() {
        return !!(query.trim() || chipFilter.size || pathFilter != null);
    }

    // The filtered list is cached until the library, the chipset or the filter changes (commands' when() call this a lot)
    let dataVersion = 0;
    let computedKey = '';

    function compute() {
        const C = CL();
        if (!C?.ready) {
            visible = [];
            computedKey = '';
            return;
        }
        const key = `${dataVersion}|${C.workspaceId}|${query}|${[...chipFilter].join(',')}|${pathFilter}`;
        if (key === computedKey) return;
        computedKey = key;
        let list = C.list();
        if (pathFilter != null) list = list.filter((c) => c.path === pathFilter);
        if (chipFilter.size) list = list.filter((c) => [...chipFilter].every((id) => (c.chips || []).includes(id)));
        if (query.trim()) list = C.search(query, { list });
        visible = list;
        for (const id of [...sel]) if (!C.get(id) || C.get(id).missing) sel.delete(id);
        if (focusId && !visible.some((c) => c.id === focusId)) focusId = null;
    }

    function selectedClips() {
        return visible.filter((c) => sel.has(c.id));
    }

    function filterName() {
        const parts = [];
        if (chipFilter.size) parts.push(CS()?.sortIds ? CS().sortIds([...chipFilter]).map((id) => CS().nameOf(id) || '?').join('·') : '');
        if (pathFilter != null) parts.push(P.stem(pathFilter));
        if (query.trim()) parts.push(`“${query.trim()}”`);
        return parts.filter(Boolean).join(' ');
    }

    /** What 이어 보기 / 저장 act on: the selection, else the filtered list, else the whole library. */
    function scope() {
        compute(); // commands can run before the next paint (rAF) picked up a change
        const picked = selectedClips();
        if (picked.length) return { clips: picked, kind: 'selection', label: `선택한 조각 ${formatCount(picked.length)}개`, name: '' };
        if (filterActive()) {
            const name = filterName();
            return { clips: visible.slice(), kind: 'filter', label: `${name} 조각 ${formatCount(visible.length)}개`, name };
        }
        return { clips: visible.slice(), kind: 'all', label: `조각 ${formatCount(visible.length)}개 전체`, name: '' };
    }

    function totalLen(list) {
        return list.reduce((n, c) => n + CL().duration(c), 0);
    }

    function fmtLen(sec) {
        if (sec < 60) return `${Math.round(sec * 10) / 10}초`;
        return App.util.formatDuration(sec);
    }

    // ---------- Section ----------
    function chipInfo(id) {
        const i = CS()?.info?.(id);
        return i ? { name: i.chip.name, color: i.cat.color || null, label: CS().labelOf(id) } : null;
    }

    function buildSection(b) {
        body = b;
        body.classList.add('clips-body');
        body.innerHTML = '';
        rows.clear();
        searchInput = h('input', { class: 'input', type: 'text', placeholder: '조각 찾기 · 초성도 돼요', spellcheck: 'false', autocomplete: 'off', 'aria-label': '보관함에서 찾기', 'aria-controls': 'clips-list' });
        searchInput.value = query;
        searchClear = h('button', { class: 'clips-search-clear', type: 'button', hidden: !query, 'aria-label': '지우기', 'data-tip': '지우기', 'data-tip-keys': 'Escape', html: icon('x', 13) });
        const searchBox = h('div', { class: 'search-box clips-search' }, h('span', { html: icon('search', 13) }), searchInput, searchClear);
        tokenRow = h('div', { class: 'clips-tokens', role: 'group', 'aria-label': '칩으로 거르기' });
        innerEl = h('div', { class: 'clips-inner' });
        dropLine = h('div', { class: 'clips-drop', hidden: true });
        listEl = h('div', { class: 'clips-list', id: 'clips-list', tabindex: '0', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': '보관함 조각' }, innerEl, dropLine);
        const savedH = App.settings.get('clips.listHeight', 0);
        if (savedH) listEl.style.height = `${savedH}px`;
        emptyEl = h('div', { class: 'clips-empty', hidden: true });
        footEl = h('div', { class: 'clips-foot', hidden: true });
        noteEl = h('div', { class: 'clips-note', hidden: true });
        body.append(searchBox, tokenRow, listEl, emptyEl, footEl, noteEl);

        searchInput.addEventListener('input', () => {
            query = searchInput.value;
            searchClear.hidden = !query;
            update();
        });
        searchInput.addEventListener('keydown', onSearchKey);
        searchClear.addEventListener('click', () => {
            query = '';
            searchInput.value = '';
            searchClear.hidden = true;
            update();
            searchInput.focus();
        });
        listEl.addEventListener('scroll', () => paintRows(), { passive: true });
        listEl.addEventListener('keydown', onListKey);
        listEl.addEventListener('click', onListClick);
        listEl.addEventListener('contextmenu', onListContext);
        listEl.addEventListener('dragstart', onDragStart);
        listEl.addEventListener('dragover', onDragOver);
        listEl.addEventListener('dragleave', (e) => {
            if (!listEl.contains(e.relatedTarget)) setDrop(-1);
        });
        listEl.addEventListener('drop', onDrop);
        listEl.addEventListener('dragend', () => setDrop(-1));
        listEl.addEventListener('focus', () => {
            if (!focusId && visible.length) setFocus(visible[0].id, { scroll: false });
            paintState();
        });
        listEl.addEventListener('blur', () => paintState());
        // Remember a height the user dragged (CSS resize: vertical)
        let resizeArmed = false;
        listEl.addEventListener('mousedown', (e) => {
            const r = listEl.getBoundingClientRect();
            resizeArmed = e.clientY > r.bottom - 14 && e.clientX > r.right - 14;
        });
        window.addEventListener('mouseup', () => {
            if (!resizeArmed || !listEl?.isConnected) return;
            resizeArmed = false;
            const hgt = Math.round(listEl.getBoundingClientRect().height);
            if (hgt > 40) App.settings.set('clips.listHeight', hgt);
            paintRows();
        });
        update();
    }

    function headActions() {
        const play = h('button', { class: 'btn ghost icon sm sb-act clips-head-play', type: 'button', 'aria-label': '이어 보기', 'data-tip': '이어 보기', html: icon('play', 13) });
        play.addEventListener('click', (e) => {
            e.stopPropagation();
            App.commands.run('clips.playSequence');
        });
        const more = h('button', { class: 'btn ghost icon sm sb-act', type: 'button', 'aria-label': '보관함 메뉴', 'data-tip': '보관함 메뉴', html: icon('more', 14) });
        more.addEventListener('click', (e) => {
            e.stopPropagation();
            ui.menu(sectionMenu(), { anchor: more, align: 'end' });
        });
        return [play, more];
    }

    function sectionMenu() {
        const sc = scope();
        const n = sc.clips.length;
        const missing = CL()?.missingCount?.() || 0;
        return [
            { header: sc.label },
            { label: '이어 보기', icon: 'play', command: 'clips.playSequence', disabled: !n, hint: 'Shift+Enter' },
            { label: '하나로 저장…', icon: 'merge', command: 'clips.exportConcat', disabled: !n },
            { label: '각각 저장…', icon: 'scissors', command: 'clips.exportEach', disabled: !n },
            '-',
            { label: '모두 선택', icon: 'check', command: 'clips.selectAll', disabled: !visible.length },
            { label: '필터 해제', icon: 'x', command: 'clips.clearFilter', disabled: !filterActive() },
            '-',
            { label: '저장 이름 규칙…', icon: 'edit', action: editTemplate },
            { label: missing ? `원본이 없는 조각 ${formatCount(missing)}개 정리` : '원본이 없는 조각 없음', icon: 'trash', command: 'clips.purgeMissing', disabled: !missing },
        ];
    }

    async function editTemplate() {
        const X = App.clipsExport;
        const sample = visible[0] || null;
        const v = await ui.prompt({
            title: '저장 이름 규칙',
            message: `각각 저장할 때 쓰는 파일 이름이에요. ${X.TOKENS.map((t) => t.key).join(' ')}`,
            value: App.settings.get('clips.nameTemplate', X.DEFAULT_TEMPLATE),
            okLabel: '저장',
            validate: (s) => (!s.trim() ? '규칙을 입력해 주세요' : null),
        });
        if (v == null) return;
        App.settings.set('clips.nameTemplate', v);
        ui.toast(sample ? `예: ${X.expand(v, sample, 0)}.${P.ext(sample.path) || 'mp4'}` : '이름 규칙을 바꿨어요', { type: 'success' });
    }

    // ---------- Rendering ----------
    const updateSoon = (() => {
        let raf = 0;
        return () => {
            if (raf) return;
            raf = requestAnimationFrame(() => {
                raf = 0;
                update();
            });
        };
    })();

    function update() {
        compute();
        syncTitles();
        if (!body || !body.isConnected) return;
        const C = CL();
        const total = C?.ready ? C.count() : 0;
        paintTokens();
        const headPlay = body.closest('.sb-section')?.querySelector('.clips-head-play');
        if (headPlay) headPlay.disabled = !visible.length;
        const showList = visible.length > 0;
        listEl.hidden = !showList;
        searchInput.closest('.clips-search').hidden = total === 0 && !query;
        if (!showList) {
            emptyEl.hidden = false;
            emptyEl.innerHTML = '';
            if (!total) {
                emptyEl.append(
                    h('div', { class: 'clips-empty-ico', html: icon('scissors', 18) }),
                    h('div', { class: 'clips-empty-title', text: '아직 담은 조각이 없어요' }),
                    h('div', { class: 'clips-empty-sub', html: `뷰어에서 ${kbd('Q')}·${kbd('W')}·${kbd('Ctrl+B')}로 자르고 보관함에 담아요` }));
            } else {
                emptyEl.append(
                    h('div', { class: 'clips-empty-title', text: '맞는 조각이 없어요' }),
                    h('button', { class: 'btn sm ghost', type: 'button', text: '필터 해제', onclick: () => clearFilter() }));
            }
        } else {
            emptyEl.hidden = true;
            const n = visible.length;
            const want = App.settings.get('clips.listHeight', 0);
            if (!want) listEl.style.height = `${Math.min(n, DEFAULT_ROWS) * ROW + (n > DEFAULT_ROWS ? ROW / 2 : 0)}px`;
            else listEl.style.height = `${Math.min(want, n * ROW)}px`;
            innerEl.style.height = `${n * ROW}px`;
        }
        paintRows();
        paintFoot();
        paintNote();
    }

    function kbd(k) {
        return `<span class="kbd">${escapeHtml(App.commands.displayCombo(k.replace('Ctrl', 'Mod')))}</span>`;
    }

    function paintTokens() {
        tokenRow.innerHTML = '';
        const C = CL();
        if (!C?.ready) return;
        const counts = new Map();
        for (const c of C.list()) for (const id of c.chips || []) counts.set(id, (counts.get(id) || 0) + 1);
        const ids = (CS()?.sortIds ? CS().sortIds([...counts.keys()]) : [...counts.keys()]).filter((id) => chipInfo(id));
        for (const id of chipFilter) if (!ids.includes(id)) ids.unshift(id);
        if (pathFilter != null) {
            tokenRow.append(h('button', {
                class: 'clips-token on is-path',
                type: 'button',
                'data-tip': `${pathFilter} 의 조각만 보는 중 — 누르면 해제`,
                html: `${icon('film', 11)}<span class="truncate">${escapeHtml(P.base(pathFilter))}</span>${icon('x', 11)}`,
                onclick: () => {
                    pathFilter = null;
                    update();
                },
            }));
        }
        for (const id of ids) {
            const info = chipInfo(id);
            const on = chipFilter.has(id);
            const t = h('button', {
                class: `clips-token${on ? ' on' : ''}`,
                type: 'button',
                'aria-pressed': String(on),
                'data-tip': `${info ? info.label : '지워진 칩'} — 조각 ${counts.get(id) || 0}개`,
                dataset: { chip: id },
            },
            h('i', { class: 'clips-dot', style: info?.color ? { background: `var(--label-${info.color})` } : null }),
            h('span', { class: 'truncate', text: info ? info.name : '지워진 칩' }),
            h('span', { class: 'clips-token-n', text: String(counts.get(id) || 0) }));
            t.addEventListener('click', () => {
                if (chipFilter.has(id)) chipFilter.delete(id);
                else chipFilter.add(id);
                sel.clear();
                update();
            });
            tokenRow.append(t);
        }
        tokenRow.hidden = !tokenRow.children.length;
    }

    function viewRange() {
        const top = listEl.scrollTop;
        const hgt = listEl.clientHeight || ROW * DEFAULT_ROWS;
        const first = Math.max(0, Math.floor(top / ROW) - BUFFER);
        const last = Math.min(visible.length - 1, Math.ceil((top + hgt) / ROW) + BUFFER);
        return { first, last };
    }

    function rowSig(c, i) {
        const chips = (c.chips || []).join(',');
        return [i, c.path, c.start, c.end, c.title, c.memo, chips, CL().sourceExists(c.path) ? 1 : 0].join('|');
    }

    function paintRows() {
        if (!listEl || listEl.hidden) {
            for (const r of rows.values()) dropRow(r);
            rows.clear();
            return;
        }
        const { first, last } = viewRange();
        const keep = new Set();
        for (let i = first; i <= last; i++) {
            const c = visible[i];
            if (!c) continue;
            keep.add(c.id);
            const sig = rowSig(c, i);
            const r = rows.get(c.id);
            if (r && r.sig === sig) continue;
            const el = buildRow(c, i);
            const thumbKey = `${c.path}|${c.start}`;
            let reused = false;
            if (r) {
                // Keep the loaded (or loading) thumbnail when only the text, selection or position changed
                const oldThumb = r.el.querySelector('.clips-thumb');
                const newThumb = el.querySelector('.clips-thumb');
                if (r.thumbKey === thumbKey && oldThumb && newThumb) {
                    const dur = newThumb.querySelector('.clips-dur');
                    const oldDur = oldThumb.querySelector('.clips-dur');
                    if (dur && oldDur) oldDur.textContent = dur.textContent;
                    newThumb.replaceWith(oldThumb);
                    reused = true;
                } else r.ctl?.abort();
                r.el.replaceWith(el);
            } else innerEl.append(el);
            const rec = { el, sig, ctl: reused ? r.ctl : null, thumbKey };
            rows.set(c.id, rec);
            if (!reused) loadThumb(rec, c);
        }
        for (const [id, r] of rows) {
            if (!keep.has(id)) {
                dropRow(r);
                rows.delete(id);
            }
        }
        paintState();
    }

    // Selection / focus marks are toggled in place: rebuilding a row between mousedown and mouseup would swallow the
    // click (and cancel a drag that is just starting).
    function paintState() {
        const focused = document.activeElement === listEl;
        for (const [id, r] of rows) {
            const isSel = sel.has(id);
            r.el.classList.toggle('sel', isSel);
            r.el.classList.toggle('focus', focused && focusId === id);
            r.el.setAttribute('aria-selected', String(isSel));
        }
    }

    function dropRow(r) {
        r.ctl?.abort();
        r.el.remove();
    }

    function chipPills(c) {
        const out = [];
        const names = (CS()?.sortIds ? CS().sortIds(c.chips || []) : c.chips || []).map((id) => ({ id, info: chipInfo(id) })).filter((x) => x.info);
        for (const { info } of names.slice(0, 2)) {
            out.push(h('span', { class: 'clips-chip' }, h('i', { class: 'clips-dot', style: info.color ? { background: `var(--label-${info.color})` } : null }), h('span', { class: 'truncate', text: info.name })));
        }
        if (names.length > 2) out.push(h('span', { class: 'clips-chip more', text: `+${names.length - 2}` }));
        return out;
    }

    function buildRow(c, i) {
        const C = CL();
        const isSel = sel.has(c.id);
        const isFocus = focusId === c.id && document.activeElement === listEl;
        const exists = C.sourceExists(c.path);
        const title = C.displayTitle(c);
        const pills = chipPills(c);
        const el = h('div', {
            class: `clips-row${isSel ? ' sel' : ''}${isFocus ? ' focus' : ''}${exists ? '' : ' gone'}`,
            id: `clip-${c.id}`,
            role: 'option',
            'aria-selected': String(isSel),
            draggable: 'true',
            dataset: { id: c.id },
            style: { transform: `translateY(${i * ROW}px)` },
        },
        h('div', { class: 'clips-thumb' }, h('div', { class: 'clips-ph', html: icon('film', 14) }), h('span', { class: 'clips-dur', text: fmtLen(C.duration(c)) }), h('span', { class: 'clips-playico', html: icon('play', 12) })),
        h('div', { class: 'clips-text', 'data-tip': exists ? `${P.base(c.path)} · ${C.fmt(c.start)}–${C.fmt(c.end)}${c.memo && c.memo.trim() !== title ?` — ${c.memo.replace(/\s+/g, ' ').slice(0, 160)}` : ''}` : `원본 영상을 찾을 수 없어요 — ${c.path}` },
            h('div', { class: 'clips-title truncate', text: title }),
            h('div', { class: 'clips-sub' },
                h('span', { class: 'clips-time', text: `${C.fmt(c.start)}–${C.fmt(c.end)}` }),
                pills.length ? h('span', { class: 'clips-chips' }, ...pills) : h('span', { class: 'clips-src truncate', text: exists ? P.base(c.path) : '원본 없음' }))),
        h('button', { class: 'clips-more', type: 'button', tabindex: '-1', 'aria-label': '조각 메뉴', 'data-tip': '조각 메뉴', draggable: 'false', html: icon('more', 14) }));
        return el;
    }

    function setThumb(box, res, p) {
        if (!box || !res) return;
        const ph = box.querySelector('.clips-ph');
        if (res.url) {
            const img = h('img', { class: 'clips-img', alt: '', draggable: 'false', decoding: 'async' });
            img.addEventListener('load', () => {
                box.classList.add('loaded');
                ph?.remove();
            }, { once: true });
            img.addEventListener('error', () => {
                img.remove();
                setThumb(box, { failed: true, label: App.clipsFrames?.label?.(p || '') || 'VIDEO' }, p);
            }, { once: true });
            img.src = res.url;
            box.prepend(img);
        } else if (res.failed) {
            box.classList.add('failed');
            if (ph) {
                ph.innerHTML = `${icon('film', 12)}<span>${escapeHtml(res.label || 'VIDEO')}</span>`;
                box.dataset.tip = 'Chrome이 이 형식의 장면을 그리지 못해요 — 로컬 서버를 켜면 보여요';
            }
        }
    }

    function loadThumb(rec, c) {
        const F = App.clipsFrames;
        const box = rec.el.querySelector('.clips-thumb');
        if (!F || !box) return;
        const hit = F.peek(c.path, c.start);
        if (hit) {
            setThumb(box, hit, c.path);
            return;
        }
        box.classList.add('loading');
        const ctl = new AbortController();
        rec.ctl = ctl;
        F.get(c.path, c.start, { signal: ctl.signal }).then((res) => {
            box.classList.remove('loading');
            if (ctl.signal.aborted || !box.isConnected) return;
            setThumb(box, res, c.path);
        }, () => box.classList.remove('loading'));
    }

    function paintFoot() {
        footEl.innerHTML = '';
        if (!visible.length) {
            footEl.hidden = true;
            return;
        }
        footEl.hidden = false;
        const sc = scope();
        const info = h('div', { class: 'clips-foot-info' },
            h('span', { class: 'clips-foot-count', text: sc.kind === 'selection' ? `${formatCount(sc.clips.length)}개 선택` : `${formatCount(sc.clips.length)}개` }),
            h('span', { class: 'clips-foot-len', text: fmtLen(totalLen(sc.clips)) }));
        const play = h('button', { class: 'btn sm clips-foot-play', type: 'button', 'data-tip': `${sc.label} 이어 보기`, 'data-tip-keys': 'Shift+Enter', html: `${icon('play', 12)}<span>이어 보기</span>` });
        play.addEventListener('click', () => App.commands.run('clips.playSequence'));
        const merge = h('button', { class: 'btn sm ghost icon', type: 'button', 'aria-label': '하나로 저장', 'data-tip': `${sc.label} 하나로 저장`, html: icon('merge', 14) });
        merge.addEventListener('click', () => App.commands.run('clips.exportConcat'));
        const each = h('button', { class: 'btn sm ghost icon', type: 'button', 'aria-label': '각각 저장', 'data-tip': `${sc.label} 각각 저장`, html: icon('scissors', 14) });
        each.addEventListener('click', () => App.commands.run('clips.exportEach'));
        footEl.append(info, h('span', { class: 'grow' }), merge, each, play);
    }

    function paintNote() {
        const C = CL();
        const hidden = C?.ready ? C.list({ includeMissing: true }).filter((c) => c.missing).length : 0;
        noteEl.hidden = !hidden;
        noteEl.innerHTML = '';
        if (!hidden) return;
        noteEl.append(
            h('span', { html: icon('trash', 12) }),
            h('span', { class: 'grow', text: `휴지통에 있는 영상의 조각 ${formatCount(hidden)}개는 숨겼어요` }),
            h('button', { class: 'clips-note-btn', type: 'button', text: '정리', 'data-tip': '원본이 없는 조각을 보관함에서 빼요 (Ctrl+Z로 되돌릴 수 있어요)', onclick: () => App.commands.run('clips.purgeMissing') }));
    }

    // Palette titles follow the scope ("배우A 조각 12개 이어 보기")
    function syncTitles() {
        const sc = scope();
        const key = `${sc.kind}|${sc.label}`;
        if (key === lastScopeKey) return;
        lastScopeKey = key;
        const n = sc.clips.length;
        const label = n ? sc.label : '보관함 조각';
        const set = (id, t) => {
            const cmd = App.commands.get(id);
            if (cmd) cmd.title = t;
        };
        set('clips.playSequence', `${label} 이어 보기`);
        set('clips.exportConcat', `${label} 하나로 저장`);
        set('clips.exportEach', `${label} 각각 저장`);
        App.bus.emit('commands:changed');
    }

    // ---------- Selection ----------
    function idx(id) {
        return visible.findIndex((c) => c.id === id);
    }

    function setFocus(id, { scroll = true } = {}) {
        focusId = id;
        if (listEl && id) listEl.setAttribute('aria-activedescendant', `clip-${id}`);
        if (scroll) scrollToId(id);
        paintState();
    }

    function scrollToId(id) {
        const i = idx(id);
        if (i < 0 || !listEl) return;
        const top = i * ROW;
        if (top < listEl.scrollTop) listEl.scrollTop = top;
        else if (top + ROW > listEl.scrollTop + listEl.clientHeight) listEl.scrollTop = top + ROW - listEl.clientHeight;
    }

    function selectOnly(id) {
        sel.clear();
        if (id) sel.add(id);
        anchorId = id;
        afterSelect();
    }

    function selectRange(id, additive) {
        const a = idx(anchorId ?? id);
        const b = idx(id);
        if (a < 0 || b < 0) return selectOnly(id);
        if (!additive) sel.clear();
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) sel.add(visible[i].id);
        afterSelect();
    }

    function afterSelect() {
        paintState();
        paintFoot();
        syncTitles();
    }

    function clickTarget(e) {
        return e.target.closest?.('.clips-row');
    }

    function onListClick(e) {
        const row = clickTarget(e);
        if (!row) return;
        const id = row.dataset.id;
        if (e.target.closest('.clips-more')) {
            e.stopPropagation();
            if (!sel.has(id)) selectOnly(id);
            setFocus(id, { scroll: false });
            const r = e.target.closest('.clips-more').getBoundingClientRect();
            ui.menu(rowMenu(), { x: r.left, y: r.bottom + 2 });
            return;
        }
        listEl.focus({ preventScroll: true });
        if (e.shiftKey) {
            selectRange(id, e.ctrlKey || e.metaKey);
            setFocus(id, { scroll: false });
        } else if (e.ctrlKey || e.metaKey) {
            if (sel.has(id)) sel.delete(id);
            else sel.add(id);
            anchorId = id;
            setFocus(id, { scroll: false });
            afterSelect();
        } else {
            selectOnly(id);
            setFocus(id, { scroll: false });
            CL().playOne(CL().get(id));
        }
    }

    function onListContext(e) {
        const row = clickTarget(e);
        e.preventDefault();
        e.stopPropagation();
        if (!row) {
            ui.menu(sectionMenu(), { x: e.clientX, y: e.clientY });
            return;
        }
        const id = row.dataset.id;
        if (!sel.has(id)) selectOnly(id);
        setFocus(id, { scroll: false });
        ui.menu(rowMenu(), { x: e.clientX, y: e.clientY });
    }

    function rowMenu() {
        const picked = selectedClips();
        const n = picked.length;
        const one = n === 1 ? picked[0] : null;
        return [
            n > 1 ? { header: `선택한 조각 ${n}개` } : null,
            { label: '재생', icon: 'play', command: 'clips.play', hint: 'Enter' },
            n > 1 ? { label: `${n}개 이어 보기`, icon: 'repeat', command: 'clips.playSequence', hint: 'Shift+Enter' } : null,
            '-',
            { label: '메모 편집…', icon: 'note', command: 'clips.editMemo', hint: 'F2' },
            { label: '칩…', icon: 'tag', command: 'clips.chips', hint: '#' },
            '-',
            { label: '하나로 저장…', icon: 'merge', command: 'clips.exportConcat' },
            { label: n > 1 ? '각각 저장…' : '파일로 저장…', icon: 'scissors', command: 'clips.exportEach' },
            '-',
            one ? { label: '원본 영상 열기', icon: 'folder-open', command: 'clips.openSource' } : null,
            one ? { label: '이 영상의 조각만 보기', icon: 'filter', command: 'clips.showForVideo', args: { path: one.path } } : null,
            one ? '-' : null,
            { label: n > 1 ? `보관함에서 ${n}개 빼기` : '보관함에서 빼기', icon: 'trash', command: 'clips.remove', hint: 'Del', danger: true },
        ].filter(Boolean).filter((x, i, arr) => !(x === '-' && (i === 0 || arr[i - 1] === '-')));
    }

    function onSearchKey(e) {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'ArrowDown' || e.key === 'Enter') {
            if (!visible.length) return;
            e.preventDefault();
            e.stopPropagation();
            if (!sel.size) selectOnly(visible[0].id);
            setFocus(focusId && idx(focusId) >= 0 ? focusId : visible[0].id);
            listEl.focus();
            if (e.key === 'Enter') CL().playOne(CL().get(focusId));
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            if (searchInput.value) {
                searchInput.value = '';
                query = '';
                searchClear.hidden = true;
                update();
            } else {
                searchInput.blur();
                document.getElementById('gallery-scroll')?.focus({ preventScroll: true });
            }
        }
    }

    function moveFocus(delta, e) {
        if (!visible.length) return;
        let i = idx(focusId);
        if (i < 0) i = delta > 0 ? -1 : visible.length;
        const j = Math.max(0, Math.min(visible.length - 1, delta === Infinity ? visible.length - 1 : delta === -Infinity ? 0 : i + delta));
        const id = visible[j].id;
        if (e.shiftKey) selectRange(id, false);
        else if (!(e.ctrlKey || e.metaKey)) selectOnly(id);
        setFocus(id);
    }

    function onListKey(e) {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.target !== listEl) return;
        const mod = e.ctrlKey || e.metaKey;
        const pageRows = Math.max(1, Math.floor(listEl.clientHeight / ROW) - 1);
        const handled = () => {
            e.preventDefault();
            e.stopPropagation();
        };
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            handled();
            moveSelected(e.key === 'ArrowUp' ? -1 : 1);
            return;
        }
        switch (e.key) {
            case 'ArrowDown':
                handled();
                return moveFocus(1, e);
            case 'ArrowUp':
                handled();
                return moveFocus(-1, e);
            case 'PageDown':
                handled();
                return moveFocus(pageRows, e);
            case 'PageUp':
                handled();
                return moveFocus(-pageRows, e);
            case 'Home':
                handled();
                return moveFocus(-Infinity, e);
            case 'End':
                handled();
                return moveFocus(Infinity, e);
            case ' ':
                handled();
                if (focusId) {
                    if (sel.has(focusId)) sel.delete(focusId);
                    else sel.add(focusId);
                    anchorId = focusId;
                    afterSelect();
                }
                return;
            case 'Enter':
                handled();
                if (e.shiftKey) App.commands.run('clips.playSequence');
                else if (focusId) CL().playOne(CL().get(focusId));
                return;
            case 'F2':
                handled();
                App.commands.run('clips.editMemo');
                return;
            case 'Delete':
            case 'Backspace':
                if (mod) return;
                handled();
                App.commands.run('clips.remove');
                return;
            case 'Escape':
                handled();
                if (sel.size) {
                    sel.clear();
                    afterSelect();
                } else {
                    listEl.blur();
                    document.getElementById('gallery-scroll')?.focus({ preventScroll: true });
                }
                return;
            default:
        }
        if (mod && !e.altKey && !e.shiftKey && (e.key === 'a' || e.key === 'A' || e.code === 'KeyA')) {
            handled();
            App.commands.run('clips.selectAll');
            return;
        }
        if (e.key === '#') {
            handled();
            App.commands.run('clips.chips');
            return;
        }
        // Typing starts the search
        if (!mod && !e.altKey && e.key.length === 1 && e.key !== ' ' && /\S/.test(e.key)) {
            handled();
            searchInput.focus();
            searchInput.value += e.key;
            searchInput.dispatchEvent(new Event('input'));
        }
    }

    function moveSelected(dir) {
        const ids = visible.map((c) => c.id);
        const picked = ids.filter((id) => sel.has(id));
        if (!picked.length) return;
        const order = ids.slice();
        const list = dir < 0 ? picked : picked.slice().reverse();
        for (const id of list) {
            const i = order.indexOf(id);
            const j = i + dir;
            if (j < 0 || j >= order.length || sel.has(order[j])) continue;
            [order[i], order[j]] = [order[j], order[i]];
        }
        if (order.join() !== ids.join()) CL().reorder(order, { label: '보관함 순서 바꾸기' });
    }

    // ---------- Drag to reorder ----------
    function onDragStart(e) {
        const row = clickTarget(e);
        if (!row) return;
        const id = row.dataset.id;
        if (!sel.has(id)) selectOnly(id);
        const ids = visible.filter((c) => sel.has(c.id)).map((c) => c.id);
        e.dataTransfer.setData(MIME, JSON.stringify(ids));
        e.dataTransfer.effectAllowed = 'move';
        const ghost = h('div', { class: 'clips-ghost', text: ids.length > 1 ? `조각 ${ids.length}개` : CL().displayTitle(CL().get(id)) });
        document.body.append(ghost);
        e.dataTransfer.setDragImage(ghost, 12, 12);
        setTimeout(() => ghost.remove(), 0);
    }

    function dropIndexAt(e) {
        const r = listEl.getBoundingClientRect();
        const y = e.clientY - r.top + listEl.scrollTop;
        return Math.max(0, Math.min(visible.length, Math.round(y / ROW)));
    }

    function setDrop(i) {
        dropIndex = i;
        if (!dropLine) return;
        dropLine.hidden = i < 0;
        if (i >= 0) dropLine.style.transform = `translateY(${i * ROW - 1}px)`;
    }

    function onDragOver(e) {
        if (!e.dataTransfer.types.includes(MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDrop(dropIndexAt(e));
        // Auto-scroll near the edges
        const r = listEl.getBoundingClientRect();
        if (e.clientY < r.top + 18) listEl.scrollTop -= 8;
        else if (e.clientY > r.bottom - 18) listEl.scrollTop += 8;
    }

    function onDrop(e) {
        if (!e.dataTransfer.types.includes(MIME)) return;
        e.preventDefault();
        let ids = [];
        try {
            ids = JSON.parse(e.dataTransfer.getData(MIME) || '[]');
        } catch (err) {
            ids = [];
        }
        const at = dropIndex >= 0 ? dropIndex : dropIndexAt(e);
        setDrop(-1);
        const moving = new Set(ids);
        const order = visible.map((c) => c.id);
        const rest = order.filter((id) => !moving.has(id));
        const pos = order.slice(0, at).filter((id) => !moving.has(id)).length;
        const next = [...rest.slice(0, pos), ...order.filter((id) => moving.has(id)), ...rest.slice(pos)];
        if (next.join() !== order.join()) CL().reorder(next, { label: ids.length > 1 ? `조각 ${ids.length}개 순서 바꾸기` : '보관함 순서 바꾸기' });
    }

    // ---------- Memo dialog ----------
    function parseTime(s) {
        const t = String(s || '').trim();
        if (!t) return NaN;
        const parts = t.split(':').map((x) => x.trim());
        if (parts.some((x) => x === '' || isNaN(Number(x)))) return NaN;
        return parts.reduce((acc, x) => acc * 60 + Number(x), 0);
    }

    function fmtPrecise(t) {
        const base = CL().fmt(t);
        const frac = Math.round((t % 1) * 10);
        return frac ? `${base}.${frac}` : base;
    }

    async function editMemo(id) {
        const C = CL();
        const c = C.get(id);
        if (!c) return;
        const key = `clip-memo:${id}`;
        const titleIn = h('input', { class: 'input', type: 'text', value: c.title || '', placeholder: C.memoLine(c) || C.autoTitle(c), spellcheck: 'false', 'aria-label': '제목' });
        const memoIn = h('textarea', { class: 'textarea clips-memo-input', rows: '5', placeholder: '이 장면에 대해 적어 두세요 — 검색에도 쓰여요', 'aria-label': '메모' });
        memoIn.value = c.memo || '';
        const startIn = h('input', { class: 'input clips-time-input', type: 'text', value: fmtPrecise(c.start), 'aria-label': '시작', spellcheck: 'false' });
        const endIn = h('input', { class: 'input clips-time-input', type: 'text', value: fmtPrecise(c.end), 'aria-label': '끝', spellcheck: 'false' });
        const timeErr = h('div', { class: 'field-error' });
        const saved = h('span', { class: 'clips-saved', text: '' });
        const push = App.util.debounce(() => {
            if (!C.get(id)) return;
            C.update(id, { title: titleIn.value, memo: memoIn.value }, { coalesceKey: key });
            saved.textContent = '저장했어요';
        }, 250);
        const commitTime = () => {
            const s = parseTime(startIn.value);
            const en = parseTime(endIn.value);
            if (!isFinite(s) || !isFinite(en) || s < 0 || en <= s) {
                timeErr.textContent = '시간은 1:23 또는 83.5 처럼 쓰고, 끝이 시작보다 뒤여야 해요';
                return false;
            }
            timeErr.textContent = '';
            const cur = C.get(id);
            if (cur && (Math.abs(cur.start - s) > 0.0005 || Math.abs(cur.end - en) > 0.0005)) {
                C.update(id, { start: s, end: en }, { coalesceKey: `clip-time:${id}` });
                saved.textContent = '저장했어요';
            }
            return true;
        };
        for (const el of [titleIn, memoIn]) el.addEventListener('input', () => {
            saved.textContent = '';
            push();
        });
        for (const el of [startIn, endIn]) {
            el.addEventListener('change', commitTime);
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') commitTime();
            });
        }
        const playBtn = h('button', { class: 'btn sm ghost', type: 'button', html: `${icon('play', 12)}<span>구간 재생</span>`, onclick: () => C.playOne(C.get(id)) });
        const bodyEl = h('div', { class: 'clips-memo' },
            h('div', { class: 'clips-memo-src', html: `${icon('film', 13)}<span class="truncate"></span>` }),
            h('div', { class: 'field' }, h('label', { text: '제목' }), titleIn),
            h('div', { class: 'field' }, h('label', { text: '메모' }), memoIn),
            h('div', { class: 'field' }, h('label', { text: '구간' }), h('div', { class: 'clips-time-row' }, startIn, h('span', { class: 'clips-time-sep', text: '–' }), endIn, h('span', { class: 'grow' }), playBtn), timeErr),
            h('div', { class: 'clips-memo-foot' }, h('span', { class: 'faint', text: '쓰는 대로 저장돼요 · Ctrl+Z로 되돌려요' }), saved));
        bodyEl.querySelector('.clips-memo-src span').textContent = `${c.path} · ${C.fmt(c.start)}–${C.fmt(c.end)}`;
        await ui.dialog({
            title: '조각 메모',
            body: bodyEl,
            width: 460,
            actions: [{ label: '완료', kind: 'primary', value: true, onClick: (close) => {
                if (!commitTime()) return;
                push.flush();
                close(true);
            } }],
            init() {
                (c.memo || !c.title ? memoIn : titleIn).focus();
            },
        });
        push.flush();
    }

    // ---------- Chip picker for clips ----------
    let chipPop = null;

    function openChips(ids, anchor) {
        const C = CS();
        const L = CL();
        if (!C?.ready) {
            ui.toast('칩셋을 불러오는 중이에요', { type: 'info' });
            return;
        }
        if (!ids.length) return;
        chipPop?.close();
        const input = h('input', { class: 'input', type: 'text', placeholder: '칩 이름이나 초성으로 찾기', spellcheck: 'false', autocomplete: 'off', 'aria-label': '칩 찾기' });
        const listBox = h('div', { class: 'clips-cp-list', role: 'listbox' });
        const hint = h('div', { class: 'clips-cp-foot', html: `<span class="kbd">↵</span> 붙이기/떼기 <span class="kbd">Esc</span> 닫기` });
        const box = h('div', { class: 'clips-cp' }, h('div', { class: 'clips-cp-head', text: ids.length > 1 ? `조각 ${ids.length}개에 칩` : '조각에 칩' }), input, listBox, hint);
        let active = 0;
        let items = [];
        const counts = () => {
            const m = new Map();
            for (const id of ids) for (const ch of L.get(id)?.chips || []) m.set(ch, (m.get(ch) || 0) + 1);
            return m;
        };
        const paint = () => {
            const q = input.value.trim();
            const all = C.list();
            items = q ? all.map((it) => ({ it, m: C.match(q, it.name) || C.match(q, it.label) })).filter((x) => x.m).sort((a, b) => b.m.score - a.m.score).map((x) => ({ kind: 'chip', it: x.it })) : all.map((it) => ({ kind: 'chip', it }));
            const clean = C.cleanName(q);
            if (clean && !C.isInitials(q) && !all.some((it) => C.normKey(it.name) === C.normKey(clean)) && !C.validateName(q)) items.push({ kind: 'create', name: clean });
            items = items.slice(0, 80);
            active = Math.max(0, Math.min(active, items.length - 1));
            const cnt = counts();
            listBox.innerHTML = '';
            if (!items.length) listBox.append(h('div', { class: 'clips-cp-empty', text: q ? '맞는 칩이 없어요' : '아직 칩이 없어요 — 이름을 쓰고 Enter' }));
            items.forEach((x, i) => {
                const row = h('div', { class: `clips-cp-row${i === active ? ' active' : ''}`, role: 'option', dataset: { i } });
                if (x.kind === 'create') {
                    row.append(h('span', { class: 'clips-cp-mark', html: icon('plus', 12) }), h('span', { class: 'truncate', text: `새 칩 「${x.name}」 만들고 붙이기` }));
                } else {
                    const n = cnt.get(x.it.id) || 0;
                    const st = !n ? 'off' : n === ids.length ? 'on' : 'mixed';
                    row.append(
                        h('span', { class: `clips-cp-mark ${st}`, html: st === 'on' ? icon('check', 12) : st === 'mixed' ? icon('minus', 12) : '' }),
                        h('i', { class: 'clips-dot', style: x.it.color ? { background: `var(--label-${x.it.color})` } : null }),
                        h('span', { class: 'clips-cp-label truncate' }, h('span', { class: 'faint', text: `${x.it.catName} › ` }), h('span', { text: x.it.name })));
                }
                listBox.append(row);
            });
            listBox.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
        };
        const commit = () => {
            const x = items[active];
            if (!x) return;
            let chipId;
            if (x.kind === 'create') {
                chipId = C.createAndApply(C.active()?.categories?.find((k) => k.mode === 'search')?.id || null, x.name, [], { hud: false });
                if (!chipId) return;
                input.value = '';
            } else chipId = x.it.id;
            const all = ids.every((id) => (L.get(id)?.chips || []).includes(chipId));
            const name = C.nameOf(chipId) || '칩';
            L.updateMany(ids, (c) => ({ chips: all ? c.chips.filter((k) => k !== chipId) : [...new Set([...c.chips, chipId])] }), { label: `조각 칩 ${all ? '떼기' : '붙이기'} "${name}"` });
            paint();
        };
        input.addEventListener('input', () => {
            active = 0;
            paint();
        });
        input.addEventListener('keydown', (e) => {
            if (e.isComposing || e.keyCode === 229) return;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                active = Math.min(items.length - 1, active + 1);
                paint();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                active = Math.max(0, active - 1);
                paint();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                commit();
            }
        });
        listBox.addEventListener('mousedown', (e) => {
            const r = e.target.closest('[data-i]');
            if (!r) return;
            e.preventDefault();
            active = Number(r.dataset.i);
            commit();
        });
        const anchorEl = anchor || listEl || document.body;
        chipPop = ui.popover(anchorEl, box, { class: 'clips-cp-pop', padding: '8px', onClose: () => {
            chipPop = null;
            if (listEl?.isConnected) listEl.focus({ preventScroll: true });
        } });
        paint();
        input.focus();
    }

    // ---------- Commands ----------
    const ready = () => !!CL()?.ready && App.fs.ready;
    const picked = () => selectedClips();
    const focusOrPicked = () => {
        const p = picked();
        if (p.length) return p;
        const f = focusId && CL().get(focusId);
        return f ? [f] : [];
    };

    function rowAnchor() {
        return (focusId && rows.get(focusId)?.el) || listEl;
    }

    function clearFilter() {
        query = '';
        chipFilter.clear();
        pathFilter = null;
        if (searchInput) {
            searchInput.value = '';
            searchClear.hidden = true;
        }
        update();
    }

    function focus(ids, { search = false } = {}) {
        if (!App.fs.ready) return;
        if (App.layout?.isVisible && !App.layout.isVisible('sidebar')) App.layout.setPanel('sidebar', true);
        const sec = document.querySelector('.sb-section[data-section="clips"]');
        if (sec?.classList.contains('collapsed')) sec.querySelector('.sb-head-title')?.click();
        if (Array.isArray(ids) && ids.length) {
            if (ids.some((id) => idx(id) < 0)) clearFilter();
            sel.clear();
            for (const id of ids) sel.add(id);
            anchorId = ids[0];
            afterSelect();
            setFocus(ids[0]);
        }
        sec?.scrollIntoView({ block: 'nearest' });
        if (search || !visible.length) searchInput?.focus();
        else {
            if (!focusId && visible.length) setFocus(visible[0].id);
            listEl?.focus({ preventScroll: true });
        }
    }

    const reg = (cmd) => App.commands.register({ group: '보관함', ...cmd });
    reg({ id: 'clips.focus', title: '보관함으로 이동', icon: 'scissors', keys: 'Alt+B', when: () => App.fs.ready, run: (a) => focus(a?.ids) });
    reg({ id: 'clips.search', title: '보관함에서 찾기', icon: 'search', when: ready, run: () => focus(null, { search: true }) });
    reg({ id: 'clips.play', title: '선택한 조각 재생', icon: 'play', when: () => ready() && focusOrPicked().length > 0, run: () => {
        const f = (focusId && sel.has(focusId) && CL().get(focusId)) || focusOrPicked()[0];
        CL().playOne(f);
    } });
    reg({ id: 'clips.playSequence', title: '보관함 조각 이어 보기', icon: 'repeat', when: () => ready() && scope().clips.length > 0, run: () => {
        const sc = scope();
        CL().playMany(sc.clips, { title: sc.kind === 'filter' ? sc.name : sc.label });
    } });
    reg({ id: 'clips.editMemo', title: '조각 메모 편집', icon: 'note', when: () => ready() && focusOrPicked().length > 0, run: () => {
        const f = (focusId && sel.has(focusId) && focusId) || focusOrPicked()[0]?.id;
        if (f) editMemo(f);
    } });
    reg({ id: 'clips.chips', title: '조각에 칩 붙이기', icon: 'tag', when: () => ready() && focusOrPicked().length > 0 && !!CS()?.ready, run: () => openChips(focusOrPicked().map((c) => c.id), rowAnchor()) });
    reg({ id: 'clips.exportConcat', title: '보관함 조각 하나로 저장', icon: 'merge', when: () => ready() && scope().clips.length > 0, run: () => {
        const sc = scope();
        return App.clipsExport.run(sc.clips, { mode: 'concat', label: sc.kind === 'filter' ? sc.name : '' });
    } });
    reg({ id: 'clips.exportEach', title: '보관함 조각 각각 저장', icon: 'scissors', when: () => ready() && scope().clips.length > 0, run: () => {
        const sc = scope();
        return App.clipsExport.run(sc.clips, { mode: 'each', label: sc.kind === 'filter' ? sc.name : '' });
    } });
    reg({ id: 'clips.openSource', title: '조각의 원본 영상 열기', icon: 'folder-open', when: () => ready() && focusOrPicked().length > 0, run: () => {
        const c = focusOrPicked()[0];
        if (!CL().sourceExists(c.path)) {
            ui.toast('원본 영상을 찾을 수 없어요', { type: 'warning' });
            return;
        }
        App.nav.go(P.parent(c.path), { focus: c.path });
    } });
    reg({ id: 'clips.showForVideo', title: '이 영상의 조각만 보기', icon: 'filter', when: () => ready(), run: (a) => {
        let p = a?.path;
        if (!p) {
            const prim = App.select.primary?.();
            if (prim && prim.type === 'video') p = prim.path;
            else p = focusOrPicked()[0]?.path;
        }
        if (!p) return;
        pathFilter = p;
        sel.clear();
        update();
        focus();
    } });
    reg({ id: 'clips.remove', title: '보관함에서 빼기', icon: 'trash', when: () => ready() && focusOrPicked().length > 0, run: () => {
        const list = focusOrPicked();
        const i = idx(list[0].id);
        CL().remove(list.map((c) => c.id));
        // Keep the cursor near where it was
        compute();
        const next = visible[Math.min(i, visible.length - 1)];
        sel.clear();
        if (next) {
            sel.add(next.id);
            anchorId = next.id;
            focusId = next.id;
        }
        update();
    } });
    reg({ id: 'clips.selectAll', title: '보관함 조각 모두 선택', icon: 'check', when: () => ready() && visible.length > 0, run: () => {
        for (const c of visible) sel.add(c.id);
        afterSelect();
    } });
    reg({ id: 'clips.clearFilter', title: '보관함 필터 해제', icon: 'x', when: () => filterActive(), run: clearFilter });
    reg({ id: 'clips.purgeMissing', title: '원본이 없는 조각 정리', icon: 'trash', when: () => ready() && CL().missingCount() > 0, run: async () => {
        const n = CL().missingCount();
        const ok = await ui.confirm({ title: '원본이 없는 조각 정리', message: `원본 영상이 휴지통에 있거나 사라진 조각 ${formatCount(n)}개를 보관함에서 뺄까요? Ctrl+Z로 되돌릴 수 있어요.`, okLabel: '정리하기' });
        if (ok) CL().purgeMissing();
    } });

    // ---------- Inspector: the selected video's clips ----------
    function installInspector() {
        if (typeof App.inspector?.addSection !== 'function') return;
        App.inspector.addSection({
            id: 'clips',
            title: '보관함 조각',
            order: 25,
            deps: ['select', 'clips', 'chipset'],
            when: ({ primary }) => !!CL()?.ready && primary?.kind === 'file' && primary.type === 'video' && CL().forPath(primary.path).length > 0,
            render(b, { primary }) {
                const C = CL();
                const list = C.forPath(primary.path);
                b.classList.add('clips-insp');
                const head = h('div', { class: 'clips-insp-head' },
                    h('span', { class: 'clips-insp-count', text: `${formatCount(list.length)}개 · ${fmtLen(totalLen(list))}` }),
                    h('span', { class: 'grow' }));
                if (list.length > 1) {
                    head.append(h('button', { class: 'btn sm ghost clips-insp-play', type: 'button', 'data-tip': '이 영상의 조각을 차례로 재생', html: `${icon('play', 11)}<span>이어 보기</span>`, onclick: () => C.playMany(list, { title: P.stem(primary.path) }) }));
                }
                head.append(h('button', { class: 'btn sm ghost icon', type: 'button', 'aria-label': '보관함에서 보기', 'data-tip': '보관함에서 이 영상의 조각만 보기', html: icon('filter', 13), onclick: () => App.commands.run('clips.showForVideo', { path: primary.path }) }));
                b.append(head);
                const box = h('div', { class: 'clips-insp-list' });
                for (const c of list.slice(0, 30)) {
                    const row = h('button', { class: 'clips-insp-row', type: 'button', 'data-tip': '이 구간 재생', dataset: { id: c.id } },
                        h('span', { class: 'clips-insp-thumb' }, h('span', { class: 'clips-ph', html: icon('film', 12) })),
                        h('span', { class: 'clips-insp-text' },
                            h('span', { class: 'clips-insp-title truncate', text: C.displayTitle(c) }),
                            h('span', { class: 'clips-insp-time', text: `${C.fmt(c.start)}–${C.fmt(c.end)} · ${fmtLen(C.duration(c))}` })));
                    row.addEventListener('click', () => C.playOne(c));
                    row.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        ui.menu([
                            { label: '재생', icon: 'play', action: () => C.playOne(c) },
                            { label: '메모 편집…', icon: 'note', action: () => editMemo(c.id) },
                            { label: '보관함에서 보기', icon: 'scissors', action: () => focus([c.id]) },
                            '-',
                            { label: '보관함에서 빼기', icon: 'trash', danger: true, action: () => C.remove([c.id]) },
                        ], { x: e.clientX, y: e.clientY });
                    });
                    box.append(row);
                    const F = App.clipsFrames;
                    if (F) {
                        const hit = F.peek(c.path, c.start);
                        const apply = (res) => {
                            const th = row.querySelector('.clips-insp-thumb');
                            if (!th || !res) return;
                            if (res.url) {
                                const img = h('img', { alt: '', draggable: 'false' });
                                img.onload = () => th.querySelector('.clips-ph')?.remove();
                                img.src = res.url;
                                th.prepend(img);
                            } else if (res.failed) th.querySelector('.clips-ph').innerHTML = `<span>${escapeHtml(res.label || '')}</span>`;
                        };
                        if (hit) apply(hit);
                        else F.get(c.path, c.start).then((res) => row.isConnected && apply(res), () => {});
                    }
                }
                if (list.length > 30) box.append(h('div', { class: 'clips-insp-more', text: `외 ${formatCount(list.length - 30)}개 — 보관함에서 모두 볼 수 있어요` }));
                b.append(box);
            },
        });
    }

    // ---------- Gallery: a scissors badge on videos with clips ----------
    let counts = new Map();

    function recount() {
        counts = new Map();
        if (!CL()?.ready) return;
        for (const c of CL().list()) counts.set(c.path, (counts.get(c.path) || 0) + 1);
    }

    function decorateCard(card, entry) {
        if (!entry || entry.kind !== 'file' || entry.type !== 'video') return;
        const n = counts.get(entry.path);
        if (!n) return;
        const media = card.querySelector('.card-media');
        if (!media) return;
        const badge = h('span', {
            class: 'card-pill clips-badge',
            role: 'button',
            'data-tip': `보관함 조각 ${n}개 — 누르면 보관함에서 보여요`,
            'aria-label': `보관함 조각 ${n}개`,
            html: `${icon('scissors', 10)}<span>${n}</span>`,
        });
        badge.addEventListener('click', (e) => {
            e.stopPropagation();
            App.commands.run('clips.showForVideo', { path: entry.path });
        });
        badge.addEventListener('dblclick', (e) => e.stopPropagation());
        badge.addEventListener('mousedown', (e) => e.stopPropagation());
        const vinfo = media.querySelector('.card-vinfo');
        if (vinfo) vinfo.prepend(badge);
        else media.append(h('div', { class: 'clips-badge-box' }, badge));
    }

    function onClipsChanged(e) {
        const before = counts;
        recount();
        dataVersion++;
        // Only cards whose clip count changed are redrawn (a redraw would stop a playing hover preview)
        const paths = new Set();
        for (const p of new Set([...before.keys(), ...counts.keys()])) if ((before.get(p) || 0) !== (counts.get(p) || 0)) paths.add(p);
        if (paths.size && App.gallery?.invalidate) App.gallery.invalidate([...paths]);
        App.inspector?.refresh?.('clips');
        updateSoon();
    }

    App.register('clips-ui', {
        init() {
            App.sidebar?.addSection?.({
                id: 'clips',
                title: '보관함',
                order: 30,
                actions: headActions,
                render(b) {
                    buildSection(b);
                },
            });
            installInspector();
            if (Array.isArray(App.gallery?.cardDecorators)) App.gallery.cardDecorators.push(decorateCard);
            App.bus.on('clips:changed', onClipsChanged);
            const bump = () => {
                dataVersion++;
                updateSoon();
            };
            App.bus.on('chipset:changed', bump);
            App.bus.on('index:ready', bump);
            App.bus.on('index:changed', bump);
            App.bus.on('workspace:closed', () => {
                sel.clear();
                chipFilter.clear();
                pathFilter = null;
                query = '';
                focusId = null;
                anchorId = null;
                chipPop?.close();
            });
            App.bus.on('workspace:opened', () => {
                sel.clear();
                chipFilter.clear();
                pathFilter = null;
                query = '';
                focusId = null;
            });
        },
    });

    App.clipsUi = {
        focus,
        scope,
        editMemo,
        openChips: (ids) => openChips(ids, listEl),
        setFilter({ query: q, chips, path } = {}) {
            if (q != null) query = String(q);
            if (chips) {
                chipFilter.clear();
                for (const id of chips) chipFilter.add(id);
            }
            if (path !== undefined) pathFilter = path;
            if (searchInput) {
                searchInput.value = query;
                searchClear.hidden = !query;
            }
            update();
        },
        clearFilter,
        get state() {
            return { selected: [...sel], focus: focusId, query, chips: [...chipFilter], path: pathFilter, visible: visible.map((c) => c.id) };
        },
    };
})();
