#!/usr/bin/env node
/*
 * Lists every registered command and flags keyboard-shortcut collisions (same combo, overlapping scope).
 * Global commands collide with every scope. Opens the app with a tiny seeded workspace so all modules init.
 *   node tools/check-keys.js [--all]   (--all prints the full table)
 */
'use strict';
const { openApp } = require('../tests/lib/harness');

(async () => {
    const app = await openApp({ seed: { 'a.png': { image: {} } } });
    try {
        const cmds = await app.page.evaluate(() => App.commands.list().map((c) => ({ id: c.id, title: c.title, scope: c.scope, keys: c.keys, group: c.group || '' })));
        const byCombo = new Map();
        for (const c of cmds) for (const k of c.keys) {
            if (!byCombo.has(k)) byCombo.set(k, []);
            byCombo.get(k).push(c);
        }
        const clashes = [];
        // Pairs that share a key on purpose: their `when` conditions never hold at the same time
        const ALLOWED = [
            ['layout.closeOverlay', 'select.clear'], // Esc closes an overlay panel first, otherwise clears the selection
            ['file.rename', 'organize.rename'], // F2: one item → inline rename, several → batch rename
            ['clipboard.cancel', 'select.clear'], // Esc: clears the selection first, then cancels a pending cut
            ['layout.closeOverlay', 'clipboard.cancel'],
        ];
        const allowed = (a, b) => ALLOWED.some(([x, y]) => (a.id === x && b.id === y) || (a.id === y && b.id === x));
        for (const [combo, list] of byCombo) {
            for (let i = 0; i < list.length; i++) {
                for (let j = i + 1; j < list.length; j++) {
                    const a = list[i];
                    const b = list[j];
                    if ((a.scope === b.scope || a.scope === 'global' || b.scope === 'global') && !allowed(a, b)) clashes.push({ combo, a, b });
                }
            }
        }
        if (process.argv.includes('--all')) {
            for (const c of cmds.sort((x, y) => (x.group + x.id).localeCompare(y.group + y.id))) {
                console.log(`${c.group.padEnd(6)} ${c.id.padEnd(32)} ${c.scope.padEnd(10)} ${c.keys.join(', ')}`);
            }
            console.log('');
        }
        console.log(`${cmds.length} commands, ${byCombo.size} distinct shortcuts`);
        for (const { combo, a, b } of clashes) console.log(`  CLASH ${combo}: ${a.id} (${a.scope}) <-> ${b.id} (${b.scope})`);
        // Chrome/Windows-reserved combos that a web page can't reliably use
        const reserved = ['Mod+T', 'Mod+N', 'Mod+W', 'Mod+Shift+N', 'Mod+Shift+T', 'Mod+Shift+W', 'Mod+Tab', 'Mod+L', 'Alt+F4', 'Mod+1', 'Mod+2', 'Mod+3', 'Mod+4', 'Mod+5', 'Mod+6', 'Mod+7', 'Mod+8', 'Mod+9'];
        for (const c of cmds) for (const k of c.keys) if (reserved.includes(k)) console.log(`  RESERVED ${k}: ${c.id} — the browser keeps this combo`);
        if (app.errors.length) console.log('page errors:', app.errors);
        process.exitCode = clashes.length ? 1 : 0;
    } finally {
        await app.close();
    }
})();
