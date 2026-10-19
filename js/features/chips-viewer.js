/*
 * Viewer integration: a '칩' button in the full-screen viewer's toolbar (App.viewer.toolbarItems) toggles a compact
 * chip drawer, so the owner can tag while looking at a photo full-screen. The drawer remembers whether it was open
 * and follows ←/→ to the next file. Digits 1–9 and '#' also work in the viewer (see chipset.js / chips-picker.js).
 * Command: chips.drawer.viewer (Alt+C in the viewer).
 */
(() => {
    'use strict';
    const { h } = App.util;
    const ui = App.ui;

    let drawer = null;
    let bodyEl = null;
    let nameEl = null;

    const wanted = () => !!App.settings.get('chips.drawer', false);

    function ensure() {
        if (drawer) return drawer;
        const root = document.getElementById('viewer');
        if (!root) return null;
        nameEl = h('span', { class: 'chip-drawer-file truncate' });
        bodyEl = h('div', { class: 'chip-drawer-body' });
        drawer = h('aside', { class: 'chip-drawer', 'aria-label': '칩 서랍', hidden: true },
            h('div', { class: 'chip-drawer-head' },
                h('span', { class: 'chip-drawer-title', html: `${ui.icon('tag', { size: 14 })}<span>칩</span>` }),
                nameEl,
                h('button', { type: 'button', class: 'btn ghost sm icon', 'aria-label': '칩 서랍 닫기', 'data-tip': '칩 서랍 닫기', 'data-tip-keys': 'Alt+C', html: ui.icon('x', { size: 14 }), onclick: () => toggle(false) })),
            bodyEl,
            h('div', { class: 'chip-drawer-foot', html: '<span class="kbd">1</span>–<span class="kbd">9</span> 칩 단축키 · <span class="kbd">#</span> 찾기 · <span class="kbd">←</span><span class="kbd">→</span> 다음 파일' }));
        // Wheel/scroll inside the drawer must not reach the viewer (zoom handlers etc.)
        drawer.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
        root.append(drawer);
        return drawer;
    }

    function current() {
        const cur = App.viewer?.current;
        return cur && cur.kind === 'file' ? cur : null;
    }

    function renderDrawer() {
        if (!drawer || drawer.hidden) return;
        const cur = current();
        nameEl.textContent = cur ? cur.name : '';
        App.chipsPanel.render(bodyEl, { key: 'drawer', files: cur ? [cur.path] : [], entries: cur ? [cur] : [], compact: true });
    }

    function syncButtons() {
        const on = wanted();
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

    function sync() {
        const open = wanted() && !!App.viewer?.isOpen;
        if (open) ensure();
        if (drawer) {
            drawer.hidden = !open;
            document.getElementById('viewer')?.classList.toggle('chip-drawer-open', open);
        }
        syncButtons();
        if (open) renderDrawer();
    }

    function toggle(force) {
        App.settings.set('chips.drawer', force ?? !wanted());
        sync();
        // Keep keyboard focus out of the drawer so ←/→, 1–9 and # keep driving the viewer
        if (drawer && document.activeElement && (drawer.contains(document.activeElement) || document.activeElement.classList?.contains('chip-vw-btn'))) document.activeElement.blur();
    }

    App.commands.register({ id: 'chips.drawer.viewer', title: '칩 서랍 열고 닫기 (보기 화면)', group: '칩', icon: 'tag', keys: 'Alt+C', scope: 'viewer', when: () => !!App.viewer?.isOpen, run: () => toggle() });

    // Ctrl+Z / Ctrl+Shift+Z must also work while viewing full-screen (chips, stars, labels set there).
    // Core is making edit.undo/edit.redo 'global'; until then (feature-detected) add viewer-scope twins.
    function ensureViewerUndo() {
        for (const [id, twin, title, icon] of [['edit.undo', 'chips.undo.viewer', '실행 취소 (보기 화면)', 'undo'], ['edit.redo', 'chips.redo.viewer', '다시 실행 (보기 화면)', 'redo']]) {
            const cmd = App.commands.get(id);
            if (!cmd || cmd.scope === 'global' || cmd.scope === 'viewer' || App.commands.get(twin)) continue;
            App.commands.register({ id: twin, title, group: '편집', icon, keys: cmd.keys, scope: 'viewer', when: () => App.commands.isEnabled(id), run: () => App.commands.run(id) });
        }
    }

    App.register('chips-viewer', {
        init() {
            App.bus.on('app:ready', ensureViewerUndo);
            if (!App.viewer) return;
            App.viewer.toolbarItems.push((entry) => {
                const n = entry && entry.kind === 'file' && App.chipset?.ready ? App.chipset.chipsOf(entry.path).length : 0;
                const btn = h('button', { type: 'button', class: `btn ghost sm chip-vw-btn${wanted() ? ' active' : ''}`, 'aria-pressed': String(wanted()), 'aria-label': '칩 서랍 열고 닫기', 'data-tip': '칩 서랍', 'data-tip-keys': 'Alt+C' },
                    h('span', { class: 'chip-vw-ico', html: ui.icon('tag', { size: 15 }) }),
                    h('span', { text: '칩' }),
                    h('span', { class: 'chip-vw-count', hidden: !n, text: n ? String(n) : '' }));
                btn.addEventListener('click', () => toggle());
                return [btn];
            });
            App.chipsPanel.renderers.add(renderDrawer);
            App.bus.on('viewer:shown', () => sync());
            App.bus.on('viewer:closed', () => {
                if (drawer) drawer.hidden = true;
                document.getElementById('viewer')?.classList.remove('chip-drawer-open');
            });
            App.bus.on('catalog:changed', ({ paths }) => {
                const cur = current();
                if (!App.viewer?.isOpen || !cur || (paths && !paths.includes(cur.path))) return;
                syncButtons();
                renderDrawer();
            });
            App.bus.on('chipset:changed', () => {
                if (!App.viewer?.isOpen) return;
                syncButtons();
                renderDrawer();
            });
        },
    });

    App.chipsViewer = { toggle, get isOpen() { return !!drawer && !drawer.hidden; } };
})();
