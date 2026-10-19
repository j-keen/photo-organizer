/*
 * Layout: show/hide sidebar & inspector, drag-to-resize both panels (widths persist per browser).
 */
(() => {
    'use strict';

    function appEl() {
        return document.querySelector('.app');
    }

    function setPanel(name, visible) {
        appEl().classList.toggle(name === 'sidebar' ? 'no-sidebar' : 'no-inspector', !visible);
        App.settings.set(`layout.${name}`, visible);
        App.bus.emit('layout:changed');
    }

    function isVisible(name) {
        return !appEl().classList.contains(name === 'sidebar' ? 'no-sidebar' : 'no-inspector');
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

    App.commands.register({ id: 'view.toggleSidebar', title: '사이드바 열고 닫기', group: '보기', icon: 'sidebar', keys: ['Mod+B'], scope: 'global', run: () => setPanel('sidebar', !isVisible('sidebar')) });
    App.commands.register({ id: 'view.toggleInspector', title: '정보 패널 열고 닫기', group: '보기', icon: 'panel-right', keys: ['Mod+I'], scope: 'global', run: () => setPanel('inspector', !isVisible('inspector')) });

    App.register('layout', {
        init() {
            const sw = App.settings.get('layout.sidebarWidth');
            const iw = App.settings.get('layout.inspectorWidth');
            if (sw) document.documentElement.style.setProperty('--sidebar-w', sw + 'px');
            if (iw) document.documentElement.style.setProperty('--inspector-w', iw + 'px');
            if (App.settings.get('layout.sidebar', true) === false) appEl().classList.add('no-sidebar');
            if (App.settings.get('layout.inspector', true) === false) appEl().classList.add('no-inspector');
            bindResizer(document.getElementById('sidebar-resizer'), '--sidebar-w', 'layout.sidebarWidth', { min: 180, max: 480 });
            bindResizer(document.getElementById('inspector-resizer'), '--inspector-w', 'layout.inspectorWidth', { min: 260, max: 560, invert: true });
        },
    });

    App.layout = { setPanel, isVisible };
})();
