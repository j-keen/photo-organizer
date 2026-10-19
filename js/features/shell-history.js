/*
 * Undo history — '실행 취소 기록' (edit.history, Mod+Alt+Z): every undoable action with its time; click one to undo
 * back to (and including) it, or redo forward again. Plus a status-bar hint showing what Ctrl+Z will undo next,
 * (Ctrl+Z / Ctrl+Shift+Z themselves are core global commands; inside this dialog they act on the list.)
 *
 *   App.history.open() · close() · isOpen
 *   App.history.undoList() / redoList()   [{ label, time }] newest first (App.undo.list when the core has it)
 *   App.history.undoSteps(n) / redoSteps(n)
 *
 * Works with both cores: when App.undo.list / undoTo / peekRedo exist they are used (undoTo(n) undoes the n newest
 * entries); otherwise the stacks are mirrored from 'undo:changed' + App.undo.peek().
 */
(() => {
    'use strict';
    const { h, formatCount } = App.util;
    const ui = App.ui;
    const LIMIT = 200;

    const nativeList = typeof App.undo.list === 'function';
    const nativeRedo = nativeList && typeof App.undo.peekRedo === 'function';

    // =====================================================================================================
    // Mirror of the undo/redo stacks (only for a core without App.undo.list)
    // =====================================================================================================
    const mirror = { undo: [], redo: [] }; // oldest → newest: { entry, time }

    function lastIndexOf(list, entry) {
        for (let i = list.length - 1; i >= 0; i--) if (list[i].entry === entry) return i;
        return -1;
    }

    function syncMirror() {
        const u = App.undo;
        const top = u.peek ? u.peek() : null;
        if (!top) {
            if (!u.canRedo()) {
                mirror.undo = [];
                mirror.redo = [];
            } else {
                while (mirror.undo.length) mirror.redo.push(mirror.undo.pop());
            }
            return;
        }
        const i = lastIndexOf(mirror.undo, top);
        if (i === mirror.undo.length - 1) {
            if (!u.canRedo()) mirror.redo = [];
            return;
        }
        if (i >= 0) {
            // undone back to i: the popped entries went to the redo stack, newest first
            const popped = mirror.undo.splice(i + 1);
            while (popped.length) mirror.redo.push(popped.pop());
            return;
        }
        const nextRedo = mirror.redo[mirror.redo.length - 1];
        if (nextRedo && nextRedo.entry === top) {
            mirror.undo.push(mirror.redo.pop());
            return;
        }
        mirror.undo.push({ entry: top, time: top.time || Date.now() });
        if (mirror.undo.length > LIMIT) mirror.undo.shift();
        mirror.redo = [];
    }

    if (!nativeList) App.bus.on('undo:changed', syncMirror);

    // =====================================================================================================
    // Stack access + multi-step undo/redo
    // =====================================================================================================
    function undoList() {
        if (nativeList) return App.undo.list();
        return mirror.undo.map((m) => ({ label: m.entry.label, time: m.time })).reverse();
    }

    function redoList() {
        if (!App.undo.canRedo()) return [];
        if (nativeRedo) return App.undo.list({ redo: true });
        return mirror.redo.map((m) => ({ label: m.entry.label, time: m.time })).reverse();
    }

    let stepping = false;

    async function undoSteps(n) {
        n = Math.min(n, undoList().length || (App.undo.canUndo() ? n : 0));
        if (n <= 0) return 0;
        stepping = true;
        try {
            if (typeof App.undo.undoTo === 'function') await App.undo.undoTo(n);
            else for (let i = 0; i < n && App.undo.canUndo(); i++) await App.undo.undo({ quiet: i < n - 1 });
        } finally {
            stepping = false;
        }
        if (n > 1) {
            ui.toast(`작업 ${formatCount(n)}개를 되돌렸어요`, { type: 'info', id: 'undo-toast', duration: 4000, action: { label: '다시 실행', run: () => redoSteps(n) } });
        }
        App.bus.emit('undo:changed');
        return n;
    }

    async function redoSteps(n) {
        n = Math.min(n, redoList().length || (App.undo.canRedo() ? n : 0));
        if (n <= 0) return 0;
        stepping = true;
        try {
            if (typeof App.undo.redoTo === 'function') await App.undo.redoTo(n);
            else for (let i = 0; i < n && App.undo.canRedo(); i++) await App.undo.redo({ quiet: i < n - 1 });
        } finally {
            stepping = false;
        }
        if (n > 1) ui.toast(`작업 ${formatCount(n)}개를 다시 실행했어요`, { type: 'info', id: 'undo-toast', duration: 3000 });
        App.bus.emit('undo:changed');
        return n;
    }

    function iconFor(label = '') {
        if (/휴지통|삭제|지우/.test(label)) return 'trash';
        if (/되살/.test(label)) return 'rotate-ccw';
        if (/이동|옮기/.test(label)) return 'folder-input';
        if (/복사/.test(label)) return 'copy';
        if (/새 폴더|폴더 만들/.test(label)) return 'folder-plus';
        if (/이름/.test(label)) return 'edit';
        if (/칩|태그|분류/.test(label)) return 'tag';
        if (/별점|평점/.test(label)) return 'star';
        if (/라벨|색/.test(label)) return 'flag';
        if (/메모/.test(label)) return 'note';
        if (/회전|뒤집/.test(label)) return 'rotate-cw';
        if (/자르|합치|영상/.test(label)) return 'scissors';
        if (/풀기|정리/.test(label)) return 'layers';
        if (/백업/.test(label)) return 'history';
        if (/최근/.test(label)) return 'folder';
        return 'undo';
    }

    // =====================================================================================================
    // Dialog
    // =====================================================================================================
    let view = null; // { list, close, busy, offUndo, timer }

    function kbdEl(combo) {
        return App.palette?.kbdEl ? App.palette.kbdEl(combo, 'hist-kbd') : h('span', { class: 'kbd', text: App.commands.displayCombo(combo) });
    }

    function actionText(kind, index) {
        if (kind === 'redo') return index === 0 ? '다시 실행' : `여기까지 다시 실행 · ${index + 1}개`;
        return index === 0 ? '되돌리기' : `여기까지 되돌리기 · ${index + 1}개`;
    }

    function rowEl(kind, index, item) {
        const next = index === 0;
        const label = item.label || '이름 없는 작업';
        const el = h('button', {
            class: `hist-row ${kind}${next ? ' next' : ''}`,
            type: 'button',
            role: 'listitem',
            dataset: { kind, index: String(index) },
            'aria-label': `${label} — ${actionText(kind, index)}`,
        },
            h('span', { class: 'hist-ico', html: ui.icon(kind === 'redo' ? 'redo' : iconFor(label), { size: 14 }) }),
            h('span', { class: 'hist-label', text: label }),
            h('span', { class: 'hist-time', text: App.shell.relTime(item.time) }),
            h('span', { class: 'hist-action', text: actionText(kind, index) }),
            next ? kbdEl(kind === 'redo' ? 'Mod+Shift+Z' : 'Mod+Z') : null);
        el.addEventListener('click', () => act(kind, index));
        return el;
    }

    function render({ keepFocus = true } = {}) {
        if (!view) return;
        const focused = keepFocus ? view.list.querySelector('.hist-row:focus') : null;
        const want = focused ? { kind: focused.dataset.kind, index: Number(focused.dataset.index) } : null;
        const undo = undoList();
        const redo = redoList();
        const list = view.list;
        list.innerHTML = '';
        view.count.textContent = undo.length ? `되돌릴 수 있는 작업 ${formatCount(undo.length)}개` : '';
        if (!undo.length && !redo.length) {
            list.append(h('div', { class: 'hist-empty' },
                h('div', { class: 'hist-empty-ico', html: ui.icon('history', { size: 22 }) }),
                h('div', { class: 'hist-empty-title', text: '아직 되돌릴 작업이 없어요' }),
                h('div', { class: 'hist-empty-text', text: '이름 바꾸기, 이동, 삭제, 칩 붙이기 같은 작업은 모두 여기에 기록돼요. 언제든 Ctrl+Z로 되돌릴 수 있어요.' })));
            return;
        }
        if (redo.length) {
            list.append(h('div', { class: 'hist-group', role: 'presentation' }, h('span', { text: '다시 실행할 수 있어요' }), h('span', { class: 'hist-group-count', text: String(redo.length) })));
            for (let j = redo.length - 1; j >= 0; j--) list.append(rowEl('redo', j, redo[j]));
        }
        list.append(h('div', { class: 'hist-now', role: 'presentation' }, h('span', { text: '지금' })));
        if (!undo.length) list.append(h('div', { class: 'hist-none', text: '더 되돌릴 작업이 없어요' }));
        undo.forEach((item, i) => list.append(rowEl('undo', i, item)));
        const target =
            (want && list.querySelector(`.hist-row[data-kind="${want.kind}"][data-index="${Math.min(want.index, (want.kind === 'redo' ? redo : undo).length - 1)}"]`)) ||
            (want && list.querySelector('.hist-row.next')) ||
            null;
        if (target) target.focus({ preventScroll: false });
    }

    async function act(kind, index) {
        if (!view || view.busy) return;
        view.busy = true;
        view.list.classList.add('busy');
        const row = view.list.querySelector(`.hist-row[data-kind="${kind}"][data-index="${index}"]`);
        row?.classList.add('working');
        row?.querySelector('.hist-ico')?.replaceChildren(h('span', { class: 'spinner' }));
        try {
            if (kind === 'undo') await undoSteps(index + 1);
            else await redoSteps(index + 1);
        } finally {
            if (view) {
                view.busy = false;
                view.list.classList.remove('busy');
                render({ keepFocus: false });
                (view.list.querySelector(`.hist-row.next.${kind}`) || view.list.querySelector('.hist-row.next'))?.focus();
            }
        }
    }

    function onKey(e) {
        if (!view) return;
        const combo = App.commands.comboFromEvent(e);
        if (combo === 'Mod+Z' || combo === 'Mod+Shift+Z' || combo === 'Mod+Y') {
            e.preventDefault();
            e.stopPropagation();
            act(combo === 'Mod+Z' ? 'undo' : 'redo', 0);
            return;
        }
        if (combo === 'Mod+Alt+Z') {
            e.preventDefault();
            view.close(null);
            return;
        }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
        const rows = [...view.list.querySelectorAll('.hist-row')];
        if (!rows.length) return;
        e.preventDefault();
        const i = rows.indexOf(document.activeElement);
        let next;
        if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = rows.length - 1;
        else next = i < 0 ? 0 : App.util.clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, rows.length - 1);
        rows[next].focus();
    }

    function open() {
        if (view) {
            view.list.querySelector('.hist-row.next')?.focus();
            return;
        }
        const list = h('div', { class: 'hist-list', role: 'list', 'aria-label': '실행 취소 기록' });
        const count = h('span', { class: 'hist-count' });
        const closeBtn = h('button', { class: 'btn ghost icon hist-close', type: 'button', 'aria-label': '닫기', 'data-tip': '닫기', 'data-tip-keys': 'Escape', html: ui.icon('x') });
        const root = h('div', { class: 'hist' },
            h('div', { class: 'hist-head' },
                h('span', { class: 'hist-head-mark', html: ui.icon('history', { size: 18 }) }),
                h('div', { class: 'grow' },
                    h('h3', { text: '실행 취소 기록' }),
                    h('p', { text: '작업을 누르면 그 작업까지 한 번에 되돌려요. 너무 많이 되돌렸다면 위에서 다시 실행하면 돼요.' })),
                closeBtn),
            list,
            h('div', { class: 'hist-foot' },
                h('span', { class: 'hist-foot-item' }, kbdEl('Mod+Z'), h('span', { text: '되돌리기' })),
                h('span', { class: 'hist-foot-item' }, kbdEl('Mod+Shift+Z'), h('span', { text: '다시 실행' })),
                h('span', { class: 'grow' }),
                count));
        ui.dialog({
            body: root,
            actions: [],
            width: 560,
            init(box, close) {
                box.classList.add('hist-dialog');
                box.setAttribute('aria-label', '실행 취소 기록');
                view = { list, count, close, busy: false };
                closeBtn.addEventListener('click', () => close(null));
                box.addEventListener('keydown', onKey);
                view.offUndo = App.bus.on('undo:changed', () => {
                    if (view && !view.busy && !stepping) render();
                });
                view.timer = setInterval(() => {
                    if (view && !view.busy) render();
                }, 30000);
                render({ keepFocus: false });
                const first = list.querySelector('.hist-row.next.undo') || list.querySelector('.hist-row');
                (first || closeBtn).focus();
            },
        }).then(() => {
            if (view) {
                view.offUndo?.();
                clearInterval(view.timer);
            }
            view = null;
        });
    }

    // =====================================================================================================
    // Status bar: what Ctrl+Z will undo next
    // =====================================================================================================
    let sbBtn = null;

    function renderStatus() {
        if (!sbBtn) return;
        const top = App.undo.canUndo() ? App.undo.peek?.() : null;
        sbBtn.hidden = !top;
        if (!top) return;
        sbBtn.replaceChildren(h('span', { html: ui.icon('undo', { size: 12 }) }), h('span', { class: 'sb-undo-text', text: top.label || '실행 취소' }));
        sbBtn.dataset.tip = 'Ctrl+Z로 바로 되돌려요 · 눌러서 실행 취소 기록 보기';
        sbBtn.dataset.tipKeys = 'Mod+Alt+Z';
    }

    App.bus.once('app:ready', () => {
        if (!App.statusbar?.addItem) return;
        sbBtn = h('button', { class: 'sb-shell sb-undo', type: 'button', hidden: true, 'aria-label': '실행 취소 기록 열기' });
        sbBtn.addEventListener('click', () => open());
        App.shell.addStatus('undo', sbBtn, 10);
        renderStatus();
    });
    App.bus.on('undo:changed', () => renderStatus());

    App.commands.register({ id: 'edit.history', title: '실행 취소 기록', group: '편집', icon: 'history', keys: ['Mod+Alt+Z'], scope: 'global', keywords: ['undo', 'history', '되돌리기', '히스토리'], run: () => open() });

    App.history = {
        open,
        close: () => view?.close(null),
        get isOpen() {
            return !!view;
        },
        undoList,
        redoList,
        undoSteps,
        redoSteps,
        iconFor,
    };
})();
