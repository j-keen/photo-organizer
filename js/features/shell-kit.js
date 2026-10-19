/*
 * Shell kit: small helpers shared by the shell team's modules (workspace, layout, palette, settings,
 * onboarding, backup). Loaded first in the shell region.
 *   App.shell.relTime(ms)        '방금 전' · '3분 전' · '어제' · '2026. 10. 3.'
 *   App.shell.stamp(date)        'YYYYMMDD-HHMMSS' (file-name friendly)
 *   App.shell.isAutomated()      true under Playwright/WebDriver — first-run tips stay out of the way
 *   App.shell.passUndoKeys(box)  Ctrl+Z / Ctrl+Y keep working inside a shell dialog (outside text fields)
 * Extra icons used by the shell are added to App.ui.ICONS (only when the name is still free).
 */
(() => {
    'use strict';

    const EXTRA_ICONS = {
        monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
        'hard-drive': '<path d="M22 12H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><path d="M6 16h.01M10 16h.01"/>',
        database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
        'shield-check': '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
        'mouse-pointer': '<path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="m13 13 6 6"/>',
        'corner-down-left': '<path d="M9 10 4 15l5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>',
        lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
        history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
        'cloud-off': '<path d="m2 2 20 20"/><path d="M5.78 5.78A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.31-.2M21.53 16.5A4.5 4.5 0 0 0 17.5 10h-1.79A7 7 0 0 0 9.34 5.1"/>',
        'panel-left-close': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M16 15l-3-3 3-3"/>',
    };
    for (const [name, body] of Object.entries(EXTRA_ICONS)) {
        if (App.ui.ICONS && !App.ui.ICONS[name]) App.ui.ICONS[name] = body;
    }

    function relTime(ms, now = Date.now()) {
        if (!ms) return '';
        const s = Math.round((now - ms) / 1000);
        if (s < 45) return '방금 전';
        const m = Math.round(s / 60);
        if (m < 60) return `${m}분 전`;
        const hr = Math.round(m / 60);
        if (hr < 24) return `${hr}시간 전`;
        const d = new Date(ms);
        const today = new Date(now);
        const dayDiff = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
        if (dayDiff === 1) return '어제';
        if (dayDiff < 7) return `${dayDiff}일 전`;
        return App.util.formatDate(ms);
    }

    const pad = (n) => String(n).padStart(2, '0');

    function stamp(d = new Date()) {
        return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    }

    function dayStamp(d = new Date()) {
        return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    }

    function isAutomated() {
        return !!(navigator.webdriver || window.__TEST__);
    }

    /** Add a shell item to the right side of the status bar, kept in `order` among the shell's own items. */
    function addStatus(id, el, order = 50) {
        if (!App.statusbar?.addItem) return null;
        el.dataset.shellOrder = String(order);
        App.statusbar.addItem(id, el, { side: 'right' });
        const parent = el.parentElement;
        if (!parent) return el;
        const mine = [...parent.children].filter((c) => c.dataset.shellOrder != null).sort((a, b) => Number(a.dataset.shellOrder) - Number(b.dataset.shellOrder));
        for (const c of mine) parent.append(c); // other teams' items stay first, ours follow in order
        return el;
    }

    /**
     * Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y inside one of the shell's dialogs (settings, backups...): the core key handler
     * stays out of dialogs, so forward them to the global undo commands. Text fields keep their native undo.
     */
    function passUndoKeys(box) {
        box.addEventListener('keydown', (e) => {
            if (e.defaultPrevented || e.isComposing || App.util.isTypingTarget(e.target)) return;
            const combo = App.commands.comboFromEvent(e);
            const id = combo === 'Mod+Z' ? 'edit.undo' : combo === 'Mod+Shift+Z' || combo === 'Mod+Y' ? 'edit.redo' : null;
            if (!id) return;
            e.preventDefault();
            e.stopPropagation();
            App.commands.run(id);
        });
    }

    App.shell = { relTime, stamp, dayStamp, isAutomated, addStatus, passUndoKeys };
})();
