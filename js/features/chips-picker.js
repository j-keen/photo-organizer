/*
 * '#' chip picker — a spotlight over the selection (gallery) or the photo on screen (viewer).
 * Fuzzy-matches every chip of the active preset, listed as '분류 › 칩 › 하위', by name and by Hangul initials
 * (ㄱㅅㅎ → 김수현), with tri-state marks for the target files.
 *   Enter        toggle the chip on every target file (one undo entry, centered HUD)
 *   Shift+Enter  remove it
 *   Ctrl+Enter   toggle and keep the picker open for the next chip
 *   Tab          choose the category for '＋ 새 칩 「…」' (search-type categories first)
 *   ↑ ↓ PgUp PgDn move, Esc close
 * Commands: chips.picker ('#', gallery) and chips.picker.viewer ('#', full-screen viewer).
 */
(() => {
    'use strict';
    const { h, formatCount, compareNames } = App.util;
    const ui = App.ui;
    const icon = (name, size = 13) => ui.icon(name, { size });

    let root = null;
    let s = null;

    function createTargets(C) {
        const cats = C.active().categories;
        return [...cats.filter((c) => c.mode === 'search'), ...cats.filter((c) => c.mode !== 'search')];
    }

    function open(scope, args = {}) {
        const C = App.chipset;
        if (!C?.ready) return;
        const files = C.targetFiles(scope);
        if (!files.length) {
            C.hud('칩을 붙일 파일을 먼저 선택해 주세요', { kind: 'info', sub: '사진이나 영상을 고른 뒤 # 을 눌러요' });
            return;
        }
        close();
        const targets = createTargets(C);
        let ti = targets.findIndex((c) => c.id === (args.catId || App.settings.get('chips.pickerCreateCat')));
        if (ti < 0) ti = 0;
        s = { scope, files, active: 0, rows: [], targets, ti, prevFocus: document.activeElement };
        build();
        App.layers.push('dialog');
        update();
        s.input.focus();
    }

    function close() {
        if (!root) return;
        root.remove();
        root = null;
        App.layers.pop('dialog');
        const prev = s?.prevFocus;
        s = null;
        if (prev && prev.isConnected && typeof prev.focus === 'function') prev.focus({ preventScroll: true });
    }

    function build() {
        const input = h('input', {
            class: 'chip-picker-input',
            type: 'text',
            placeholder: '칩 이름이나 초성으로 찾기 — 예: ㄱㅅㅎ',
            spellcheck: 'false',
            autocomplete: 'off',
            role: 'combobox',
            'aria-expanded': 'true',
            'aria-controls': 'chip-picker-list',
            'aria-label': '칩 찾기',
        });
        const list = h('div', { class: 'chip-picker-list', id: 'chip-picker-list', role: 'listbox' });
        const foot = h('div', { class: 'chip-picker-foot' });
        const target = s.scope === 'viewer' ? '보고 있는 파일' : `${formatCount(s.files.length)}개 파일`;
        const box = h('div', { class: 'chip-picker', role: 'dialog', 'aria-label': '칩 고르기' },
            h('div', { class: 'chip-picker-head' },
                h('span', { class: 'chip-picker-hash', text: '#' }),
                input,
                h('span', { class: 'chip-picker-count', html: `${icon('layers', 12)}<span></span>` })),
            list,
            foot);
        box.querySelector('.chip-picker-count span').textContent = target;
        root = h('div', { class: 'chip-picker-backdrop', id: 'chip-picker' }, box);
        document.body.append(root);
        s.input = input;
        s.list = list;
        s.foot = foot;
        root.addEventListener('mousedown', (e) => {
            if (e.target === root) close();
        });
        input.addEventListener('input', () => {
            s.active = 0;
            update();
        });
        input.addEventListener('keydown', onKey);
        list.addEventListener('mousemove', (e) => {
            const r = e.target.closest('[data-i]');
            if (r && Number(r.dataset.i) !== s.active) {
                s.active = Number(r.dataset.i);
                paintActive();
            }
        });
        list.addEventListener('mousedown', (e) => {
            const r = e.target.closest('[data-i]');
            if (!r) return;
            e.preventDefault();
            s.active = Number(r.dataset.i);
            commit({ remove: e.shiftKey, keep: e.ctrlKey || e.metaKey });
        });
    }

    function cpLen(str) {
        return [...str].length;
    }

    function update() {
        const C = App.chipset;
        if (!s || !C?.ready) return;
        const q = s.input.value.trim();
        const all = C.list();
        let rows;
        if (!q) {
            const byId = new Map(all.map((x) => [x.id, x]));
            const rec = C.recent().filter((id) => byId.has(id)).slice(0, 6);
            const recSet = new Set(rec);
            rows = [...rec.map((id) => ({ kind: 'chip', item: byId.get(id), group: '최근에 쓴 칩' })), ...all.filter((x) => !recSet.has(x.id)).map((item) => ({ kind: 'chip', item, group: '모든 칩' }))];
        } else {
            rows = [];
            for (const item of all) {
                const mName = C.match(q, item.name);
                const mLabel = C.match(q, item.label);
                if (!mName && !mLabel) continue;
                const nameScore = mName ? mName.score + 120 - item.depth * 10 : -Infinity;
                const labelScore = mLabel ? mLabel.score : -Infinity;
                const offset = cpLen(item.label) - cpLen(item.name);
                const indices = nameScore >= labelScore ? mName.indices.map((i) => i + offset) : mLabel.indices;
                rows.push({ kind: 'chip', item, score: Math.max(nameScore, labelScore), indices });
            }
            rows.sort((a, b) => b.score - a.score || compareNames(a.item.label, b.item.label));
            const clean = C.cleanName(q);
            const target = s.targets[s.ti];
            const exists = target ? target.chips.some((c) => C.normKey(c.name) === C.normKey(clean)) : false;
            if (clean && !exists && !C.isInitials(q) && !C.validateName(q)) rows.push({ kind: 'create', name: clean });
        }
        s.total = rows.length;
        s.rows = rows.slice(0, 150);
        s.counts = C.counts(s.files);
        s.n = s.files.length;
        s.active = Math.max(0, Math.min(s.active, s.rows.length - 1));
        paint();
    }

    function labelEl(it, indices) {
        const set = new Set(indices || []);
        const chars = [...it.label];
        const nameStart = chars.length - cpLen(it.name);
        const path = h('span', { class: 'chip-picker-path' });
        const name = h('span', { class: 'chip-picker-name' });
        chars.forEach((ch, i) => (i < nameStart ? path : name).append(set.has(i) ? h('mark', { text: ch }) : document.createTextNode(ch)));
        return h('span', { class: 'chip-picker-label' }, path, name);
    }

    function paint() {
        const { list } = s;
        list.innerHTML = '';
        const q = s.input.value.trim();
        if (!s.rows.length) {
            list.append(h('div', { class: 'chip-picker-empty' },
                h('div', { class: 'chip-picker-empty-title', text: q ? '맞는 칩이 없어요' : '아직 칩이 없어요' }),
                h('div', { text: q ? '다른 이름이나 초성으로 찾아 보세요.' : '이름을 쓰고 Enter를 누르면 새 칩을 만들어 바로 붙여요.' })));
        }
        let group = null;
        s.rows.forEach((r, i) => {
            if (!q && r.group !== group) {
                group = r.group;
                list.append(h('div', { class: 'chip-picker-group', text: group }));
            }
            const row = h('div', { class: `chip-picker-row${i === s.active ? ' active' : ''}${r.kind === 'create' ? ' create' : ''}`, role: 'option', dataset: { i }, 'aria-selected': String(i === s.active) });
            if (r.kind === 'create') {
                const target = s.targets[s.ti];
                row.append(...[
                    h('span', { class: 'chip-picker-mark create', html: icon('plus', 13) }),
                    h('span', { class: 'chip-picker-label' }, h('span', { class: 'chip-picker-name', text: `새 칩 「${r.name}」` })),
                    h('span', { class: 'chip-picker-target', text: target ? `→ ${target.name}` : '→ 새 분류 「태그」' }),
                    s.targets.length > 1 ? h('span', { class: 'kbd', text: 'Tab' }) : null,
                ].filter(Boolean));
            } else {
                const it = r.item;
                const c = s.counts.get(it.id) || 0;
                const st = !c ? 'off' : c === s.n ? 'on' : 'mixed';
                row.dataset.chip = it.id;
                row.append(...[
                    h('span', { class: `chip-picker-mark ${st}`, html: st === 'on' ? icon('check', 13) : st === 'mixed' ? icon('minus', 13) : '' }),
                    h('span', { class: 'chip-picker-dot', style: it.color ? { background: `var(--label-${it.color})` } : null }),
                    labelEl(it, r.indices),
                    st === 'mixed' ? h('span', { class: 'chip-picker-frac', text: `${c}/${s.n}` }) : null,
                    it.hotkey ? h('span', { class: 'kbd', text: it.hotkey }) : null,
                ].filter(Boolean));
            }
            list.append(row);
        });
        if (s.total > s.rows.length) list.append(h('div', { class: 'chip-picker-more', text: `${formatCount(s.total - s.rows.length)}개 더 있어요 — 조금 더 입력해서 좁혀 보세요` }));
        paintFoot();
        list.querySelector('.chip-picker-row.active')?.scrollIntoView({ block: 'nearest' });
    }

    function paintActive() {
        s.list.querySelectorAll('.chip-picker-row').forEach((row) => {
            const on = Number(row.dataset.i) === s.active;
            row.classList.toggle('active', on);
            row.setAttribute('aria-selected', String(on));
        });
        s.list.querySelector('.chip-picker-row.active')?.scrollIntoView({ block: 'nearest' });
        paintFoot();
    }

    function paintFoot() {
        const r = s.rows[s.active];
        const mod = App.commands.displayCombo('Mod+Enter').replace('Enter', '↵');
        const hint = (k, t) => h('span', { class: 'chip-picker-hint' }, h('span', { class: 'kbd', text: k }), h('span', { text: t }));
        s.foot.innerHTML = '';
        let verb = '붙이기';
        if (r && r.kind === 'chip') {
            const c = s.counts.get(r.item.id) || 0;
            verb = c === s.n ? '떼기' : '붙이기';
        } else if (r && r.kind === 'create') verb = '만들고 붙이기';
        s.foot.append(hint('↵', verb), hint('⇧↵', '떼기'), hint(mod, '계속 고르기'));
        if (s.targets.length > 1) s.foot.append(hint('Tab', `새 칩 분류: ${s.targets[s.ti].name}`));
        s.foot.append(h('span', { class: 'grow' }), hint('Esc', '닫기'));
    }

    function move(delta) {
        if (!s.rows.length) return;
        s.active = Math.max(0, Math.min(s.rows.length - 1, s.active + delta));
        paintActive();
    }

    function onKey(e) {
        if (e.isComposing || e.keyCode === 229) return;
        // Ctrl+Z with an empty query undoes the last change (handy in Ctrl+Enter "keep picking" mode)
        if (!s.input.value && App.chipsPanel?.runUndoKey?.(e)) {
            requestAnimationFrame(() => s && update());
            return;
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            s.active = s.rows.length ? (s.active + 1) % s.rows.length : 0;
            paintActive();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            s.active = s.rows.length ? (s.active - 1 + s.rows.length) % s.rows.length : 0;
            paintActive();
        } else if (e.key === 'PageDown') {
            e.preventDefault();
            move(8);
        } else if (e.key === 'PageUp') {
            e.preventDefault();
            move(-8);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            commit({ remove: e.shiftKey, keep: e.ctrlKey || e.metaKey });
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close();
        } else if (e.key === 'Tab') {
            e.preventDefault();
            if (s.targets.length > 1) {
                s.ti = (s.ti + (e.shiftKey ? -1 : 1) + s.targets.length) % s.targets.length;
                App.settings.set('chips.pickerCreateCat', s.targets[s.ti].id);
                update();
            }
        }
    }

    function commit({ remove = false, keep = false } = {}) {
        const C = App.chipset;
        const r = s?.rows[s.active];
        if (!r || !C?.ready) return;
        if (r.kind === 'create') {
            const target = s.targets[s.ti];
            const id = C.createAndApply(target?.id || null, r.name, s.files);
            if (!id) return;
        } else {
            C.apply(s.files, r.item.id, remove ? 'remove' : 'toggle');
        }
        if (keep) {
            s.input.value = '';
            s.active = 0;
            s.targets = createTargets(C);
            update();
            s.input.focus();
        } else {
            close();
        }
    }

    App.commands.register({ id: 'chips.picker', title: '칩 검색해서 고르기', group: '칩', icon: 'hash', keys: '#', when: () => App.fs.ready && !!App.chipset?.ready, run: (args) => open('main', args || {}) });
    App.commands.register({ id: 'chips.picker.viewer', title: '칩 검색해서 고르기 (보기 화면)', group: '칩', icon: 'hash', keys: '#', scope: 'viewer', when: () => !!App.viewer?.isOpen && !!App.chipset?.ready, run: () => open('viewer') });

    App.register('chips-picker', {
        init() {
            App.bus.on('workspace:closed', close);
            App.bus.on('viewer:closed', () => {
                if (s?.scope === 'viewer') close();
            });
            App.bus.on('chipset:changed', () => {
                if (s) {
                    s.targets = createTargets(App.chipset);
                    s.ti = Math.min(s.ti, Math.max(0, s.targets.length - 1));
                    update();
                }
            });
            App.bus.on('catalog:changed', () => {
                if (s) update();
            });
        },
    });

    App.chipsPicker = { open, close, get isOpen() { return !!root; } };
})();
