'use strict';

async function prepare(openApp) {
    const seed = { 'photo.png': { image: {} } };
    for (const name of ['short', 'medium', 'long', 'unknown']) seed[name + '.webm'] = { video: { seconds: 0.3 } };
    const app = await openApp({ seed });
    await app.page.evaluate(async () => {
        // Let the real thumbnail metadata settle before supplying boundary fixtures.
        await Promise.all(App.view.entries.filter((entry) => entry.type === 'video').map((entry) => App.thumbs.get(entry)));
        App.catalog.setMeta('short.webm', { duration: 60 });
        App.catalog.setMeta('medium.webm', { duration: 60.1 });
        App.catalog.setMeta('long.webm', { duration: 600 });
        App.catalog.setMeta('unknown.webm', { duration: null });
    });
    return app;
}

module.exports = [
    {
        name: 'team3: topbar-length boundaries, unknown duration, menu and undo',
        async run({ openApp, assert }) {
            const { page } = await prepare(openApp);
            const before = await page.evaluate(() => App.undo.list().length);
            await page.getByRole('button', { name: '영상 길이', exact: true }).click();
            await page.locator('.menu').getByText('1분 이하', { exact: true }).click();
            assert.deepEqual(await page.evaluate(() => App.view.visible.map((entry) => entry.path)), ['short.webm']);
            assert.equal(await page.evaluate(() => App.undo.list().length), before + 1);
            await page.evaluate(() => App.commands.run('view.length.medium'));
            assert.deepEqual(await page.evaluate(() => App.view.visible.map((entry) => entry.path)), ['medium.webm']);
            await page.evaluate(() => App.commands.run('view.length.long'));
            assert.deepEqual(await page.evaluate(() => App.view.visible.map((entry) => entry.path)), ['long.webm']);
            await page.evaluate(() => App.undo.undo());
            assert.deepEqual(await page.evaluate(() => App.view.visible.map((entry) => entry.path)), ['medium.webm']);
            await page.evaluate(() => App.commands.run('view.length.all'));
            assert.equal(await page.evaluate(() => App.view.visible.length), 5);
            assert.ok((await page.getByRole('button', { name: '영상 길이', exact: true }).getAttribute('data-tip')).includes('전체에만'));
        },
    },
    {
        name: 'team3: topbar-length metadata updates, type interaction, chip clear and clear-all',
        async run({ openApp, assert }) {
            const { page } = await prepare(openApp);
            await page.evaluate(() => {
                App.topbar.setTypeFilter('video');
                App.commands.run('view.length.long');
            });
            await page.evaluate(() => {
                App.catalog.setMeta('unknown.webm', { duration: 700 });
                App.bus.emit('thumbs:meta', { path: 'unknown.webm', duration: 700 });
            });
            await page.waitForFunction(() => App.view.visible.length === 2);
            assert.deepEqual(await page.evaluate(() => App.view.visible.map((entry) => entry.path)), ['long.webm', 'unknown.webm']);
            await page.locator('.filter-chip').filter({ hasText: '영상 10분 이상' }).click();
            assert.equal(await page.evaluate(() => App.view.visible.length), 4);
            await page.evaluate(() => App.undo.undo());
            assert.equal(await page.evaluate(() => App.view.visible.length), 2);
            await page.evaluate(() => App.view.clearFilters());
            assert.equal(await page.evaluate(() => App.view.filters.size), 0);
            assert.equal(await page.getByRole('button', { name: '영상 길이', exact: true }).innerText(), '길이: 전체');
        },
    },
];
