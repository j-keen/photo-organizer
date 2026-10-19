/*
 * Shell kit: small helpers shared by the shell team's modules (workspace, layout, palette, settings,
 * onboarding, backup). Loaded first in the shell region.
 *   App.shell.relTime(ms)        '방금 전' · '3분 전' · '어제' · '2026. 10. 3.'
 *   App.shell.stamp(date)        'YYYYMMDD-HHMMSS' (file-name friendly)
 *   App.shell.isAutomated()      true under Playwright/WebDriver — first-run tips stay out of the way
 *   App.shell.passUndoKeys(box)  Ctrl+Z / Ctrl+Y keep working inside a shell dialog (outside text fields)
 * (The shell's icons — monitor, hard-drive, history, ... — live in core ICONS.)
 */
(() => {
    'use strict';

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
