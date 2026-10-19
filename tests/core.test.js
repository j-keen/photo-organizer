// Core edge cases: App.fs, App.catalog, App.index, App.undo.
'use strict';

const SEED = {
    'a.png': { image: { label: 'A' } },
    'b.png': { image: { label: 'B' } },
    'trip/x.png': { image: { label: 'X' } },
    'trip/inner/y.png': { image: { label: 'Y' } },
    'old.png': { image: { label: 'Old' } },
    'old.png.txt': '===TAB::Default===\n#TITLE: Default\n#TAGS: #가족, #여행/제주\n바다에서 찍은 사진\n',
};

async function reopen(page, waitIdle) {
    await page.reload();
    await page.waitForFunction(() => window.App && document.querySelector('#topbar').children.length > 0);
    await page.evaluate(() => window.__useExistingWorkspace());
    await page.evaluate(() => App.workspace.pick());
    await page.waitForFunction(() => App.state.cwd === '' && App.view.source.type === 'folder');
    await waitIdle(page);
}

module.exports = [
    {
        name: 'moving a folder into itself is refused',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            const res = await page.evaluate(() => App.fs.move(['trip'], 'trip/inner'));
            assert.deepEqual(res, []);
            assert.ok(await page.evaluate(() => window.__opfs.exists('trip/inner/y.png')));
        },
    },
    {
        name: 'name clashes get numbered names on move and copy',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { ...SEED, 'trip/a.png': { image: {} } } });
            const moved = await page.evaluate(() => App.fs.move(['a.png'], 'trip'));
            assert.equal(moved[0].to, 'trip/a (2).png');
            const copied = await page.evaluate(() => App.fs.copy(['b.png', 'b.png'], 'trip'));
            assert.deepEqual(copied.map((c) => c.to), ['trip/b.png', 'trip/b (2).png']);
            assert.equal(await page.evaluate(() => App.fs.uniqueName('trip', 'b.png')), 'b (3).png');
        },
    },
    {
        name: 'copy carries metadata and undo removes the copy',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await page.evaluate(() => App.catalog.update('a.png', { rating: 3, chips: ['c1'] }));
            await page.evaluate(() => App.fs.copy(['a.png'], 'trip'));
            assert.equal(await page.evaluate(() => App.catalog.get('trip/a.png').rating), 3);
            await page.evaluate(() => App.undo.undo());
            assert.ok(!(await page.evaluate(() => window.__opfs.exists('trip/a.png'))));
            assert.ok(await page.evaluate(() => window.__opfs.exists('a.png')));
            assert.equal(await page.evaluate(() => App.catalog.peek('trip/a.png')), undefined);
        },
    },
    {
        name: 'trashing a folder keeps nested metadata and restore brings it back',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await page.evaluate(() => App.catalog.update('trip/inner/y.png', { memo: 'deep' }));
            const ids = await page.evaluate(() => App.fs.trash(['trip']));
            assert.equal(ids.length, 1);
            assert.ok(!(await page.evaluate(() => window.__opfs.exists('trip'))));
            assert.equal(await page.evaluate(() => App.catalog.peek('trip/inner/y.png')), undefined);
            await page.evaluate((i) => App.fs.restore(i), ids);
            assert.ok(await page.evaluate(() => window.__opfs.exists('trip/inner/y.png')));
            assert.equal(await page.evaluate(() => App.catalog.get('trip/inner/y.png').memo), 'deep');
        },
    },
    {
        name: 'restoring into a folder that no longer exists recreates it',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            const ids = await page.evaluate(() => App.fs.trash(['trip/inner/y.png']));
            await page.evaluate(() => App.fs.trash(['trip']));
            await page.evaluate((i) => App.fs.restore(i), ids);
            assert.ok(await page.evaluate(() => window.__opfs.exists('trip/inner/y.png')));
        },
    },
    {
        name: 'invalid names are rejected with Korean messages',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            const errs = await page.evaluate(() => ['', 'a/b', 'con', 'x.', '.hidden', 'ok name'].map((n) => App.fs.validateName(n)));
            assert.ok(errs[0] && errs[1] && errs[2] && errs[3] && errs[4]);
            assert.equal(errs[5], null);
            const msg = await page.evaluate(() => App.fs.rename('a.png', 'b.png').then(() => 'ok', (e) => e.message));
            assert.match(msg, /이미 있어요/);
        },
    },
    {
        name: 'index follows rename, move and trash',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await page.waitForFunction(() => App.index.ready);
            await page.evaluate(() => App.fs.rename('trip', 'travel'));
            assert.ok(await page.evaluate(() => !!App.index.get('travel/inner/y.png') && !App.index.get('trip/inner/y.png')));
            await page.evaluate(() => App.fs.move(['a.png'], 'travel'));
            assert.ok(await page.evaluate(() => !!App.index.get('travel/a.png')));
            await page.evaluate(() => App.fs.trash(['travel/inner']));
            assert.ok(await page.evaluate(() => !App.index.get('travel/inner/y.png')));
            assert.ok(await page.evaluate(() => App.index.folders.includes('travel') && !App.index.folders.includes('travel/inner')));
        },
    },
    {
        name: 'undo and redo walk a sequence of operations',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await page.evaluate(async () => {
                await App.fs.mkdir('', 'new');
                await App.fs.move(['a.png'], 'new');
                await App.fs.rename('new/a.png', 'renamed.png');
            });
            assert.ok(await page.evaluate(() => window.__opfs.exists('new/renamed.png')));
            await page.evaluate(async () => {
                await App.undo.undo();
                await App.undo.undo();
            });
            assert.ok(await page.evaluate(() => window.__opfs.exists('a.png')));
            await page.evaluate(async () => {
                await App.undo.redo();
                await App.undo.redo();
            });
            assert.ok(await page.evaluate(() => window.__opfs.exists('new/renamed.png')));
        },
    },
    {
        name: 'catalog edits are undoable with Ctrl+Z; rapid edits with a coalesceKey collapse into one step',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await page.evaluate(() => App.catalog.update('a.png', { rating: 4 }, { label: '별점' }));
            await page.evaluate(() => {
                for (const memo of ['h', 'he', 'hel', 'hello']) App.catalog.update('a.png', { memo }, { label: '메모', coalesceKey: 'memo:a.png' });
            });
            assert.deepEqual(await page.evaluate(() => App.undo.list().map((e) => e.label)), ['메모', '별점']);
            await page.click('#gallery-scroll', { position: { x: 5, y: 5 } });
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => App.catalog.get('a.png').memo === '');
            assert.equal(await page.evaluate(() => App.catalog.get('a.png').rating), 4);
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => App.catalog.get('a.png').rating === 0);
            await page.keyboard.press('Control+y');
            await page.waitForFunction(() => App.catalog.get('a.png').rating === 4);
            // A no-op update doesn't create an undo step
            await page.evaluate(() => App.catalog.update('a.png', { rating: 4 }));
            assert.equal(await page.evaluate(() => App.undo.list().length), 1);
        },
    },
    {
        name: 'Ctrl+Z works inside the viewer too',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            await (await card(page, 'a.png')).dblclick();
            await page.waitForSelector('#viewer:not([hidden]) .vw-media');
            await page.evaluate(() => App.catalog.update('a.png', { label: 'red' }, { label: '색상 라벨' }));
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => App.catalog.get('a.png').label === null);
            assert.ok(await page.isVisible('#viewer'), 'viewer stays open');
        },
    },
    {
        name: 'created and overwritten files can be undone and redone',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            const p = await page.evaluate(() => App.fs.createFile('trip', 'note.png', new Blob(['new'])));
            assert.equal(p, 'trip/note.png');
            await page.evaluate(() => App.undo.undo());
            assert.ok(!(await page.evaluate(() => window.__opfs.exists('trip/note.png'))));
            await page.evaluate(() => App.undo.redo());
            assert.ok(await page.evaluate(() => window.__opfs.exists('trip/note.png')));

            const before = await page.evaluate(() => window.__opfs.read('b.png'));
            await page.evaluate(() => App.fs.overwrite('b.png', new Blob(['changed'])));
            assert.equal(await page.evaluate(() => window.__opfs.read('b.png')), 'changed');
            assert.ok((await page.evaluate(() => App.fs.listTrash())).some((i) => i.reason === 'overwrite'), 'previous version kept in trash');
            await page.evaluate(() => App.undo.undo());
            assert.equal(await page.evaluate(() => window.__opfs.read('b.png')), before);
            await page.evaluate(() => App.undo.redo());
            assert.equal(await page.evaluate(() => window.__opfs.read('b.png')), 'changed');
        },
    },
    {
        name: 'undo history lists actions and undoTo rewinds several steps',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await page.evaluate(async () => {
                await App.fs.mkdir('', 'one');
                await App.fs.move(['a.png'], 'one');
                App.catalog.update('b.png', { rating: 1 }, { label: '별점' });
            });
            const labels = await page.evaluate(() => App.undo.list().map((e) => e.label));
            assert.equal(labels.length, 3);
            assert.equal(labels[0], '별점');
            await page.evaluate(() => App.undo.undoTo(3));
            assert.ok(await page.evaluate(() => window.__opfs.exists('a.png')));
            assert.ok(!(await page.evaluate(() => window.__opfs.exists('one'))));
            assert.equal(await page.evaluate(() => App.undo.list({ redo: true }).length), 3);
        },
    },
    {
        name: 'shortcuts work with the Korean IME (jamo keys) and the literal + key',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            const hits = await page.evaluate(() => {
                const hits = [];
                App.commands.register({ id: 'test.altR', title: 't', keys: 'Alt+R', run: () => hits.push('altR') });
                App.commands.register({ id: 'test.j', title: 't', keys: 'J', run: () => hits.push('j') });
                App.commands.register({ id: 'test.plus', title: 't', keys: 'Mod++', run: () => hits.push('plus') });
                const fire = (init) => document.getElementById('gallery-scroll').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
                fire({ key: 'ㄱ', code: 'KeyR', altKey: true });
                fire({ key: 'ㅓ', code: 'KeyJ' });
                fire({ key: 'Process', code: 'KeyJ' });
                fire({ key: '+', code: 'Equal', ctrlKey: true, shiftKey: true });
                return hits;
            });
            assert.deepEqual(hits, ['altR', 'j', 'j', 'plus']);
            assert.equal(await page.evaluate(() => App.commands.displayCombo('Mod++')), 'Ctrl++');
        },
    },
    {
        name: 'nested dialogs: Esc closes only the top one',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await page.evaluate(() => {
                window.__d1 = App.ui.dialog({ title: 'outer', body: 'a', actions: [{ label: 'ok', value: 1, kind: 'primary' }] });
                window.__d2 = App.ui.dialog({ title: 'inner', body: 'b', actions: [{ label: 'ok', value: 2, kind: 'primary' }] });
            });
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('.dialog').count(), 1);
            assert.equal(await page.textContent('.dialog-title'), 'outer');
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('.dialog').count(), 0);
        },
    },
    {
        name: 'renameMany swaps names in one step and undo restores them',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await page.evaluate(() => App.catalog.update('a.png', { memo: 'was a' }, { undoable: false }));
            const before = await page.evaluate(async () => [await window.__opfs.read('a.png'), await window.__opfs.read('b.png')]);
            await page.evaluate(() => App.fs.renameMany([{ path: 'a.png', name: 'b.png' }, { path: 'b.png', name: 'a.png' }]));
            assert.equal(await page.evaluate(() => window.__opfs.read('b.png')), before[0]);
            assert.equal(await page.evaluate(() => App.catalog.get('b.png').memo), 'was a');
            assert.equal(await page.evaluate(() => App.undo.list().length), 1);
            assert.deepEqual(await page.evaluate(() => window.__opfs.list('')), ['.fluid-organizer/', 'a.png', 'b.png', 'old.png', 'old.png.txt', 'trip/']);
            await page.evaluate(() => App.undo.undo());
            assert.equal(await page.evaluate(() => window.__opfs.read('a.png')), before[0]);
            assert.equal(await page.evaluate(() => App.catalog.get('a.png').memo), 'was a');
            const err = await page.evaluate(() => App.fs.renameMany([{ path: 'a.png', name: 'old.png' }]).then(() => null, (e) => e.code));
            assert.equal(err, 'EEXIST');
        },
    },
    {
        name: 'move with onConflict: skip / replace, and undo brings the replaced file back',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { ...SEED, 'trip/a.png': { image: { label: 'old A' } }, 'trip/b.png': { image: {} } } });
            const oldA = await page.evaluate(() => window.__opfs.read('trip/a.png'));
            const res = await page.evaluate(async () => {
                const seen = [];
                const r = await App.fs.move(['a.png', 'b.png'], 'trip', {
                    onConflict: async (conflicts) => {
                        seen.push(...conflicts.map((c) => c.name));
                        return new Map([['a.png', 'replace'], ['b.png', 'skip']]);
                    },
                });
                return { seen, moved: r.map((x) => x.to) };
            });
            assert.deepEqual(res.seen.sort(), ['a.png', 'b.png']);
            assert.deepEqual(res.moved, ['trip/a.png']);
            assert.ok(await page.evaluate(() => window.__opfs.exists('b.png')), 'skipped item stays');
            await page.evaluate(() => App.undo.undo());
            assert.ok(await page.evaluate(() => window.__opfs.exists('a.png')));
            assert.equal(await page.evaluate(() => window.__opfs.read('trip/a.png')), oldA, 'replaced file restored');
            const cancelled = await page.evaluate(() => App.fs.move(['a.png'], 'trip', { onConflict: async () => null }).then((r) => r.cancelled));
            assert.equal(cancelled, true);
        },
    },
    {
        name: 'a failing item does not abort the rest of a batch',
        allowErrors: [/move failed|찾을 수 없어요/],
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            const r = await page.evaluate(async () => {
                const res = await App.fs.move(['a.png', 'ghost.png', 'b.png'], 'trip');
                return { moved: res.map((x) => x.to), failed: res.failed.map((f) => f.path) };
            });
            assert.deepEqual(r.moved, ['trip/a.png', 'trip/b.png']);
            assert.deepEqual(r.failed, ['ghost.png']);
            await page.evaluate(() => App.undo.undo());
            assert.ok(await page.evaluate(() => window.__opfs.exists('a.png') && window.__opfs.exists('b.png')));
        },
    },
    {
        name: 'trash undo/redo/undo cycles keep working',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await page.evaluate(() => App.fs.trash(['a.png'], { silent: true }));
            for (let i = 0; i < 2; i++) {
                await page.evaluate(() => App.undo.undo());
                assert.ok(await page.evaluate(() => window.__opfs.exists('a.png')), `restored (cycle ${i})`);
                await page.evaluate(() => App.undo.redo());
                assert.ok(!(await page.evaluate(() => window.__opfs.exists('a.png'))), `trashed again (cycle ${i})`);
            }
            assert.equal((await page.evaluate(() => App.fs.listTrash())).length, 1);
        },
    },
    {
        name: 'an empty JSON file (interrupted first write) is treated as missing',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { ...SEED, '.fluid-organizer/chipsets.json': '' } });
            assert.equal(await page.evaluate(() => App.fs.readJSON('.fluid-organizer/chipsets.json', 'fallback')), 'fallback');
            assert.equal(await page.evaluate(() => App.wsdata.read('chipsets', 'fb')), 'fb');
        },
    },
    {
        name: 'nav load hooks, history jump and chip names in search',
        async run({ openApp, assert, cardNames }) {
            const { page } = await openApp({ seed: SEED });
            await page.evaluate(() => {
                App.nav.loadHooks.push((p, entries) => (p === 'trip' ? { entries: entries.filter((e) => e.kind === 'dir'), source: { title: 'hooked' } } : null));
            });
            await page.evaluate(() => App.nav.go('trip'));
            assert.deepEqual(await cardNames(page), ['inner']);
            assert.equal(await page.evaluate(() => App.view.source.title), 'hooked');
            await page.evaluate(() => App.nav.go('trip/inner'));
            await page.evaluate(() => App.nav.jump(-2));
            await page.waitForFunction(() => App.state.cwd === '');
            assert.equal(await page.evaluate(() => App.nav.fwd.length), 2);
            await page.waitForFunction(() => App.index.ready);
            const hits = await page.evaluate(() => {
                window.App.chipset = window.App.chipset || { labelOf: (id) => (id === 'c-kim' ? '배우 › 김수현' : '') };
                App.catalog.update('b.png', { chips: ['c-kim'] }, { undoable: false });
                return App.index.search('김수현').map((e) => e.path);
            });
            assert.deepEqual(hits, ['b.png']);
        },
    },
    {
        name: 'catalog persists across reloads and v1 sidecars are imported',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: SEED });
            await page.waitForFunction(() => App.catalog.peek('old.png')?.legacyImported);
            const old = await page.evaluate(() => App.catalog.get('old.png'));
            assert.equal(old.memo, '바다에서 찍은 사진');
            assert.deepEqual(await page.evaluate(() => App.catalog.peek('old.png').legacyTags), ['가족', '여행/제주']);
            assert.equal(await page.evaluate(() => App.view.source.hiddenCount), 0, 'v1 sidecars are not counted as hidden files');
            await page.evaluate(() => App.catalog.update('b.png', { rating: 2 }));
            await page.evaluate(() => App.catalog.flush());
            await reopen(page, waitIdle);
            assert.equal(await page.evaluate(() => App.catalog.get('b.png').rating), 2);
            assert.ok(await page.evaluate(() => window.__opfs.exists('old.png.txt')), 'v1 sidecar is left in place');
        },
    },
];
