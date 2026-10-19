/*
 * Selection action bar (team: gallery). With 2+ items selected a floating bar docks at the bottom-center of the grid:
 *   "24개 선택 · 3.2 GB | 칩 · 이동… · 복사… · 이름 바꾸기 · 휴지통 | ✕"
 * Buttons only run registered commands and hide while their command is missing or disabled, so the bar fills in as
 * other teams register chips.picker / organize.* . It slides in only when prefers-reduced-motion is off (CSS).
 */
(() => {
    'use strict';
    const { h, formatBytes, formatCount } = App.util;
    const ui = App.ui;

    const ACTIONS = [
        { id: 'chips.picker', label: '칩', icon: 'tag' },
        { id: 'organize.moveTo', label: '이동…', icon: 'folder-input' },
        { id: 'organize.copyTo', label: '복사…', icon: 'copy' },
        { id: 'organize.rename', label: '이름 바꾸기', icon: 'edit' },
        { id: 'file.trash', label: '휴지통', icon: 'trash', danger: true },
    ];
    const BAR_SPACE = 80; // extra scroll room under the last row so the bar never hides it

    let bar;
    let countEl;
    let sizeEl;
    let actionsSep;
    const buttons = new Map();
    let shown = false;
    let raf = 0;

    function renderSoon() {
        if (raf) return;
        raf = requestAnimationFrame(() => {
            raf = 0;
            render();
        });
    }

    function render() {
        if (!bar) return;
        const n = App.select.count;
        const show = App.fs.ready && n >= 2;
        if (show) {
            const entries = App.select.entries();
            const size = entries.reduce((s, e) => s + (e.kind === 'file' ? e.size || 0 : 0), 0);
            countEl.textContent = `${formatCount(n)}개 선택`;
            sizeEl.textContent = size ? formatBytes(size) : '';
            sizeEl.hidden = !size;
            let any = false;
            for (const a of ACTIONS) {
                const btn = buttons.get(a.id);
                const cmd = App.commands.get(a.id);
                const ok = !!cmd && App.commands.isEnabled(a.id);
                btn.hidden = !ok;
                if (!ok) continue;
                any = true;
                btn.dataset.tip = cmd.title || a.label;
                if (cmd.keys && cmd.keys[0]) btn.dataset.tipKeys = cmd.keys[0];
                else delete btn.dataset.tipKeys;
            }
            actionsSep.hidden = !any;
        }
        if (show !== shown) {
            shown = show;
            bar.classList.toggle('show', show);
            bar.setAttribute('aria-hidden', show ? 'false' : 'true');
            bar.inert = !show;
            App.gallery?.setBottomInset?.(show ? BAR_SPACE : 0);
        }
    }

    App.register('gallery-actionbar', {
        init() {
            const content = document.getElementById('content');
            if (!content) return;
            countEl = h('span', { class: 'gab-count' });
            sizeEl = h('span', { class: 'gab-size' });
            const actions = h('div', { class: 'gab-actions' });
            for (const a of ACTIONS) {
                const b = h('button', {
                    class: `btn ghost sm gab-btn${a.danger ? ' is-danger' : ''}`,
                    type: 'button',
                    hidden: true,
                    dataset: { command: a.id },
                    html: `${ui.icon(a.icon, { size: 14 })}<span>${a.label}</span>`,
                });
                b.addEventListener('click', () => {
                    b.blur();
                    App.commands.run(a.id);
                });
                buttons.set(a.id, b);
                actions.append(b);
            }
            const closeBtn = h('button', { class: 'btn ghost sm icon gab-close', type: 'button', 'aria-label': '선택 해제', 'data-tip': '선택 해제', 'data-tip-keys': 'Escape', html: ui.icon('x', { size: 15 }) });
            closeBtn.addEventListener('click', () => App.commands.run('select.clear'));
            actionsSep = h('span', { class: 'gab-sep', 'aria-hidden': 'true' });
            bar = h('div', { class: 'gab', role: 'toolbar', 'aria-label': '선택한 항목', 'aria-hidden': 'true' },
                h('div', { class: 'gab-info' }, countEl, sizeEl),
                actionsSep,
                actions,
                h('span', { class: 'gab-sep', 'aria-hidden': 'true' }),
                closeBtn);
            bar.inert = true;
            content.append(bar);

            for (const evt of ['selection:changed', 'commands:changed', 'view:changed', 'workspace:opened', 'workspace:closed', 'undo:changed']) App.bus.on(evt, renderSoon);
        },
    });
})();
