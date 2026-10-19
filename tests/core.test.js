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
