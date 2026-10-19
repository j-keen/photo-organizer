/*
 * Layout: show/hide the sidebar & inspector, drag-to-resize both panels (widths persist per browser),
 * responsive folding and focus mode.
 *
 *   App.layout.setPanel('sidebar'|'inspector', visible) · toggle(name) · isVisible(name)
 *   App.layout.range(name) -> 'wide' | 'compact' | 'narrow' · apply() · zen (bool) · toggleZen()
 *
 * Responsive (setting layout.autoCollapse, default on):
 *   ≥ 1100px  both panels docked, as the user last chose (layout.sidebar / layout.inspector)
 *   820–1100  the inspector folds away; opening it docks it and that choice is remembered (layout.inspector.compact)
 *   < 820px   both panels fold; opening one shows it as an overlay (sidebar = drawer with a scrim)
 */
(() => {
    'use strict';
    const { h } = App.util;

    const WIDE = 1100;
    const NARROW = 820;
    const overlay = { sidebar: false, inspector: false };
    let zen = false;
    let scrim = null;
    let lastBand = null;

    function appEl() {
        return document.querySelector('.app');
    }

    function autoCollapse() {
        return App.settings.get('layout.autoCollapse', true) !== false;
    }

    function band() {
        const w = window.innerWidth;
        return w < NARROW ? 'narrow' : w < WIDE ? 'compact' : 'wide';
    }

    /** Width range that applies to a panel: 'wide' (docked by preference), 'compact' (inspector folded by default), 'narrow' (overlay). */
    function range(name) {
        if (!autoCollapse()) return 'wide';
        const b = band();
        if (b === 'narrow') return 'narrow';
        if (b === 'compact' && name === 'inspector') return 'compact';
        return 'wide';
    }

    function prefKey(name, r) {
        return r === 'compact' ? `layout.${name}.compact` : `layout.${name}`;
    }

    function docked(name, r) {
        if (r === 'narrow') return false;
        const fallback = r !== 'compact';
        return !!App.settings.get(prefKey(name, r), fallback);
    }

    function apply() {
        const app = appEl();
        if (!app) return;
        const before = app.className + '|' + app.dataset.layout;
        for (const name of ['sidebar', 'inspector']) {
            const r = range(name);
            if (r !== 'narrow') overlay[name] = false;
            const show = !zen && docked(name, r);
            const floating = !zen && r === 'narrow' && overlay[name];
            app.classList.toggle(`no-${name}`, !show);
            app.classList.toggle(`${name}-overlay`, floating);
        }
        app.classList.toggle('zen', zen);
        app.dataset.layout = autoCollapse() ? band() : 'wide';
        if (scrim) scrim.hidden = !app.classList.contains('sidebar-overlay');
        if (app.className + '|' + app.dataset.layout !== before) App.bus.emit('layout:changed');
    }

    function setPanel(name, visible) {
        zen = false;
        const r = range(name);
        if (r === 'narrow') {
            overlay[name] = !!visible;
            if (visible) overlay[name === 'sidebar' ? 'inspector' : 'sidebar'] = false; // one overlay at a time
        } else {
            App.settings.set(prefKey(name, r), !!visible);
        }
        apply();
    }

    function isVisible(name) {
        const app = appEl();
        if (!app) return false;
        return !app.classList.contains(`no-${name}`) || app.classList.contains(`${name}-overlay`);
    }

    function toggle(name) {
        setPanel(name, !isVisible(name));
    }

    function closeOverlays() {
        if (!overlay.sidebar && !overlay.inspector) return;
        overlay.sidebar = false;
        overlay.inspector = false;
        apply();
    }

    function toggleZen() {
        zen = !zen;
        if (zen) closeOverlays();
        apply();
        App.ui.toast(zen ? '집중 모드 — 패널을 모두 숨겼어요' : '패널을 다시 보여 드려요', { type: 'info', duration: 1600, id: 'layout-zen' });
    }

    function onResize() {
        const b = band();
        if (b !== lastBand) {
            lastBand = b;
            if (b !== 'narrow') closeOverlays();
            apply();
        }
    }

    function bindResizer(resizer, varName, settingKey, { min, max, invert }) {
        resizer.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const startX = e.clientX;
            const start = parseInt(getComputedStyle(document.documentElement).getPropertyValue(varName), 10);
            resizer.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            const onMove = (ev) => {
                const dx = (ev.clientX - startX) * (invert ? -1 : 1);
                const w = App.util.clamp(start + dx, min, max);
                document.documentElement.style.setProperty(varName, w + 'px');
            };
            const onUp = () => {
                resizer.classList.remove('dragging');
                document.body.style.cursor = '';
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
                App.settings.set(settingKey, parseInt(getComputedStyle(document.documentElement).getPropertyValue(varName), 10));
                App.bus.emit('layout:changed');
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        });
        resizer.addEventListener('dblclick', () => {
            document.documentElement.style.removeProperty(varName);
            App.settings.set(settingKey, null);
            App.bus.emit('layout:changed');
        });
    }

    App.commands.register({ id: 'view.toggleSidebar', title: '사이드바 열고 닫기', group: '보기', icon: 'sidebar', keys: ['Mod+B'], scope: 'global', run: () => toggle('sidebar') });
    App.commands.register({ id: 'view.toggleInspector', title: '정보 패널 열고 닫기', group: '보기', icon: 'panel-right', keys: ['Mod+I'], scope: 'global', run: () => toggle('inspector') });
    App.commands.register({ id: 'view.zen', title: '집중 모드 (패널 모두 숨기기)', group: '보기', icon: 'maximize', keys: ['Mod+.'], keywords: ['zen', 'focus', '전체 화면'], run: toggleZen });
    App.commands.register({ id: 'layout.closeOverlay', title: '떠 있는 패널 닫기', keys: ['Escape'], hidden: true, palette: false, when: () => overlay.sidebar || overlay.inspector, run: closeOverlays });

    App.register('layout', {
        init() {
            const sw = App.settings.get('layout.sidebarWidth');
            const iw = App.settings.get('layout.inspectorWidth');
            if (sw) document.documentElement.style.setProperty('--sidebar-w', sw + 'px');
            if (iw) document.documentElement.style.setProperty('--inspector-w', iw + 'px');
            bindResizer(document.getElementById('sidebar-resizer'), '--sidebar-w', 'layout.sidebarWidth', { min: 180, max: 480 });
            bindResizer(document.getElementById('inspector-resizer'), '--inspector-w', 'layout.inspectorWidth', { min: 260, max: 560, invert: true });

            scrim = h('div', { class: 'lay-scrim', hidden: true, onclick: closeOverlays });
            appEl()?.append(scrim);
            lastBand = band();
            apply();
            window.addEventListener('resize', App.util.throttle(onResize, 80));
            // A folder picked in the drawer takes you there: close the drawer
            App.bus.on('nav:changed', () => {
                if (overlay.sidebar) {
                    overlay.sidebar = false;
                    apply();
                }
            });
            App.bus.on('settings:changed', ({ key }) => {
                if (key === 'layout.autoCollapse') apply();
            });
        },
    });

    App.layout = {
        setPanel,
        isVisible,
        toggle,
        range,
        apply,
        closeOverlays,
        toggleZen,
        get zen() {
            return zen;
        },
    };
})();
