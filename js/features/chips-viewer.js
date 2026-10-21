/*
 * Viewer integration: the chip panel has a place of its own in the viewer layout — the right-side dock column
 * (App.viewer.registerPanel 'chips'; owner r2 feedback: '팝업으로 넣지 말고 옆에 레이아웃으로 자리를 따로'). The media
 * area, its controls and the film strip make room for it; nothing floats over the photo. A video also gets the
 * '메모 목록' tab in the same column.
 * Opened by the '칩' button in the viewer's top bar or Alt+C. It remembers whether it was open (setting chips.drawer)
 * and follows ←/→ to the next file. Digits 1–9 and '#' also work in the viewer (see chipset.js / chips-picker.js).
 * While a video piece is selected on the seek bar (App.chipset.pieceTarget()), the panel tags that piece instead.
 * Command: chips.drawer.viewer (Alt+C in the viewer).
 */
(() => {
    'use strict';
    const { h } = App.util;
    const ui = App.ui;
    const PANEL = 'chips';

    let host = null; // the panel's content while it is in the dock
    let bodyEl = null;
    let nameEl = null;

    const wanted = () => !!App.settings.get('chips.drawer', false);
    const isOpen = () => !!App.viewer?.isPanelOpen?.(PANEL);

    function current() {
        const cur = App.viewer?.current;
        return cur && cur.kind === 'file' ? cur : null;
    }

    function renderPanel() {
        if (!host || !host.isConnected) return;
        const cur = current();
        const piece = cur ? App.chipset?.pieceTarget?.() || null : null;
        nameEl.textContent = cur ? (piece ? `${cur.name} · ${piece.label}` : cur.name) : '';
        App.chipsPanel.render(bodyEl, { key: 'drawer', files: cur ? [cur.path] : [], entries: cur ? [cur] : [], compact: true, piece });
    }

    function syncButtons() {
        const on = isOpen();
        const cur = current();
        const n = cur && App.chipset?.ready ? App.chipset.chipsOf(cur.path).length : 0;
        document.querySelectorAll('.chip-vw-btn').forEach((b) => {
            b.classList.toggle('active', on);
            b.setAttribute('aria-pressed', String(on));
            const badge = b.querySelector('.chip-vw-count');
            badge.textContent = n ? String(n) : '';
            badge.hidden = !n;
        });
    }

    // Remembered (setting chips.drawer) through 'viewer:panel': opening it in any way (button, Alt+C, its tab) turns it on,
    // closing the dock by hand turns it off; switching tabs, a photo/video change or closing the viewer leave it as is.
    function toggle(force) {
        if (!App.viewer?.isOpen) return;
        const want = force ?? !isOpen();
        App.viewer.togglePanel(PANEL, want);
        // Keep keyboard focus out of the panel so ←/→, 1–9 and # keep driving the viewer
        const a = document.activeElement;
        if (a && (host?.contains(a) || a.classList?.contains('chip-vw-btn'))) a.blur();
        syncButtons();
    }

    App.commands.register({ id: 'chips.drawer.viewer', title: '칩 패널 열고 닫기 (보기 화면)', group: '칩', icon: 'tag', keys: 'Alt+C', scope: 'viewer', when: () => !!App.viewer?.isOpen, run: () => toggle() });

    App.register('chips-viewer', {
        init() {
            if (!App.viewer) return;
            App.viewer.registerPanel({
                id: PANEL,
                title: '칩',
                icon: 'tag',
                keys: 'Alt+C',
                order: 10, // the first tab
                closeOnEscape: false, // a working panel: Esc lets go of a piece, then closes the viewer as before
                render(body) {
                    nameEl = h('span', { class: 'chip-dock-file truncate' });
                    bodyEl = h('div', { class: 'chip-dock-body' });
                    host = h('div', { class: 'chip-dock' },
                        h('div', { class: 'chip-dock-target', html: ui.icon('file', { size: 13 }) }, nameEl),
                        bodyEl,
                        h('div', { class: 'chip-dock-foot', html: '<span class="kbd">1</span>–<span class="kbd">9</span> 칩 단축키 · <span class="kbd">#</span> 찾기·만들기 · <span class="kbd">←</span><span class="kbd">→</span> 다음 파일' }));
                    body.append(host);
                    renderPanel();
                    return () => {
                        host = null;
                        bodyEl = null;
                        nameEl = null;
                    };
                },
                onEntry: () => renderPanel(),
                // no hints(): the panel stays open while working, so the hint row keeps the photo/video keys
                // (the chip keys are in the panel's own foot)
            });
            App.viewer.toolbarItems.push((entry) => {
                const n = entry && entry.kind === 'file' && App.chipset?.ready ? App.chipset.chipsOf(entry.path).length : 0;
                const on = isOpen();
                const btn = h('button', { type: 'button', class: `btn ghost sm chip-vw-btn${on ? ' active' : ''}`, 'aria-pressed': String(on), 'aria-label': '칩 패널 열고 닫기', 'data-tip': '칩 패널 (오른쪽)', 'data-tip-keys': 'Alt+C' },
                    h('span', { class: 'chip-vw-ico', html: ui.icon('tag', { size: 15 }) }),
                    h('span', { text: '칩' }),
                    h('span', { class: 'chip-vw-count', hidden: !n, text: n ? String(n) : '' }));
                btn.addEventListener('click', () => toggle());
                return [btn];
            });
            App.chipsPanel.renderers.add(renderPanel);
            // Open it before the file loads, so the media lays out once next to it
            App.bus.on('viewer:entry', () => {
                if (wanted() && App.viewer.isOpen && !App.viewer.isPanelOpen()) App.viewer.togglePanel(PANEL, true);
            });
            App.bus.on('viewer:shown', () => syncButtons());
            App.bus.on('viewer:panel', ({ id, reason }) => {
                if (id === PANEL) App.settings.set('chips.drawer', true);
                else if (id === null && reason === 'user') App.settings.set('chips.drawer', false);
                syncButtons();
            });
            App.bus.on('catalog:changed', ({ paths }) => {
                const cur = current();
                if (!App.viewer?.isOpen || !cur || (paths && !paths.includes(cur.path))) return;
                syncButtons();
                renderPanel();
            });
            App.bus.on('chipset:changed', () => {
                if (!App.viewer?.isOpen) return;
                syncButtons();
                renderPanel();
            });
            // Selecting a piece on the seek bar (or letting go of it) switches what the panel tags
            App.bus.on('viewer:piece-select', () => {
                if (App.viewer?.isOpen) renderPanel();
            });
        },
    });

    App.chipsViewer = { toggle, get isOpen() { return isOpen(); } };
})();
