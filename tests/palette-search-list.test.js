'use strict';

const seed = {
    'home/local.png': { image: { color: '#336699' } },
    'a/trip.webm': { video: { seconds: 2 } },
    'b/my-trip.webm': { video: { seconds: 2 } },
    'c/trip-photo.png': { image: { color: '#663399' } },
    'b/unrelated.png': { image: { color: '#336699' } },
};

async function palette(page, query = 'trip') {
    await page.evaluate(async (q) => {
        await App.nav.go('home');
        App.settings.set('viewer.muted', true);
        App.settings.set('viewer.autoplay', false);
        App.palette.open({ scope: 'files', query: q });
    }, query);
    await page.waitForSelector('.pal-item .pal-title');
    const names = await page.locator('.pal-item .pal-title').allTextContents();
    return page.evaluate((names) => names.map((name) => App.index.items.find((e) => e.name === name).path), names);
}

module.exports = [
    {
        name: 'palette search list: topbar count follows the palette list despite an empty folder search',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await page.evaluate(() => App.topbar.setSearchScope('folder'));
            const paths = await palette(page, 'trp');
            assert.equal(paths.length, 3);
            await page.keyboard.press('Enter');
            await page.waitForFunction((n) => App.view.source.paletteOrder?.length === n, paths.length);
            await page.waitForFunction((n) => Array.from(document.querySelectorAll('.topbar-search [data-tip]')).some((el) =>
                !el.hidden && el.textContent === `${n}개` && el.dataset.tip === `찾은 사진·영상 ${n}개 · 팔레트 검색 결과`), paths.length);
            await page.evaluate(() => App.viewer.close());
            await page.evaluate(() => App.topbar.search('unrelated'));
            await page.waitForFunction(() => App.view.source.query === 'unrelated' && !App.view.source.paletteOrder);
            await page.waitForFunction(() => Array.from(document.querySelectorAll('.topbar-search [data-tip]')).some((el) =>
                !el.hidden && el.textContent === '0개' && el.dataset.tip === '찾은 사진·영상 0개 · 현재 폴더 안'));
        },
    },
    {
        name: 'palette search list: open preserves shown cross-folder matches, auto-next and clearing restores the folder sort',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await page.evaluate(() => App.view.setSort('name', 'desc'));
            const paths = await palette(page);
            assert.equal(paths.length, 3);
            // Fuzzy relevance and a descending folder sort intentionally disagree.
            assert.equal(paths[0], 'a/trip.webm');
            await page.keyboard.press('Enter');
            await page.waitForFunction((p) => App.viewer.current?.path === p &&
                (App.viewer.kind === 'image' ? App.viewer.media?.complete : App.viewer.player?.metaReady), paths[0]);
            assert.deepEqual(await page.evaluate(() => App.view.visible.map((e) => e.path)), paths);
            assert.deepEqual(await page.evaluate(() => App.viewer.files.map((e) => e.path)), paths);
            assert.equal(await page.evaluate(() => App.view.source.type), 'search');
            assert.equal(await page.evaluate(() => App.view.source.query), 'trip');
            assert.equal(await page.evaluate(() => App.state.cwd), 'home');
            assert.deepEqual(await page.evaluate(() => App.settings.get('view.sort')), { key: 'name', dir: 'desc' });
            await page.evaluate(() => {
                App.settings.set('viewer.autoNext', true);
                const p = App.viewer.player;
                p.seek(p.duration - 0.25);
            });
            await page.waitForFunction(() => !App.viewer.player.video.seeking);
            await page.evaluate(() => App.viewer.player.play());
            await page.waitForFunction((p) => App.viewer.current?.path === p, paths[1]);
            await page.keyboard.press('Control+ArrowRight');
            await page.waitForFunction((p) => App.viewer.current?.path === p, paths[2]);
            await page.evaluate(() => App.viewer.close());
            await page.evaluate(() => App.topbar.clearSearch());
            await page.waitForFunction(() => App.view.source.type === 'folder' && App.view.source.path === 'home');
            assert.deepEqual(await page.evaluate(() => App.view.sort), { key: 'name', dir: 'desc' });
            assert.deepEqual(await page.evaluate(() => App.view.visible.map((e) => e.path)), ['home/local.png']);
        },
    },
    {
        name: 'palette search list: fuzzy fallback outside topbar scope keeps the list and gallery Escape returns to the folder',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await page.evaluate(() => App.topbar.setSearchScope('folder'));
            const paths = await palette(page, 'trp');
            assert.equal(paths.length, 3);
            await page.keyboard.press('Enter');
            await page.waitForFunction((p) => App.viewer.current?.path === p &&
                (App.viewer.kind === 'image' ? App.viewer.media?.complete : App.viewer.player?.metaReady), paths[0]);
            assert.deepEqual(await page.evaluate(() => App.viewer.files.map((e) => e.path)), paths);
            assert.equal(await page.evaluate(() => App.view.source.query), 'trp');
            await page.evaluate(() => App.viewer.close());
            await page.evaluate(() => App.commands.run('nav.escape'));
            await page.waitForFunction(() => App.view.source.type === 'folder' && App.state.cwd === 'home');
            assert.equal(await page.evaluate(() => App.view.sort.key), 'name');
        },
    },
    ...['Shift', 'Alt'].map((modifier) => ({
        name: `palette search list: ${modifier}+Enter reveals in the containing folder without opening`,
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            const paths = await palette(page);
            await page.keyboard.press(`${modifier}+Enter`);
            await page.waitForFunction((p) => App.view.source.type === 'folder' && App.select.focus === p, paths[0]);
            assert.equal(await page.evaluate(() => App.state.cwd), 'a');
            assert.equal(await page.evaluate(() => App.viewer.isOpen), false);
            assert.deepEqual(await page.evaluate(() => App.view.visible.map((e) => e.path)), ['a/trip.webm']);
        },
    })),
    {
        name: 'palette search list: clicking a later photo keeps preceding matches and temporary sorting never persists',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            const paths = await palette(page);
            const at = paths.findIndex((p) => p.endsWith('.png'));
            assert.ok(at > 0);
            await page.locator('.pal-item').nth(at).click();
            await page.waitForFunction((p) => App.viewer.current?.path === p && App.viewer.kind === 'image', paths[at]);
            assert.deepEqual(await page.evaluate(() => App.viewer.files.map((e) => e.path)), paths);
            await page.keyboard.press('Control+ArrowLeft');
            await page.waitForFunction((p) => App.viewer.current?.path === p, paths[at - 1]);
            await page.evaluate(() => {
                App.viewer.close();
                App.view.setSort('paletteOrder', 'desc');
            });
            assert.deepEqual(await page.evaluate(() => App.settings.get('view.sort')), { key: 'name', dir: 'asc' });
            await page.evaluate(() => App.topbar.clearSearch());
            await page.waitForFunction(() => App.view.source.type === 'folder');
            assert.deepEqual(await page.evaluate(() => App.view.sort), { key: 'name', dir: 'asc' });
        },
    },
    {
        name: 'palette search list: normal search is reused and a manual sort choice survives leaving the results',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await palette(page);
            await page.evaluate(() => {
                window.__searchCalls = [];
                const search = App.topbar.search;
                App.topbar.search = async (q) => {
                    await search(q);
                    window.__searchCalls.push({ q, contains: App.view.entries.some((e) => e.path === 'a/trip.webm') });
                };
            });
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => App.viewer.current?.path === 'a/trip.webm');
            assert.deepEqual(await page.evaluate(() => window.__searchCalls), [{ q: 'trip', contains: true }]);
            assert.equal(await page.evaluate(() => App.view.source.scope), 'all');
            await page.evaluate(() => {
                App.viewer.close();
                App.view.setSort('name', 'desc');
                App.topbar.clearSearch();
            });
            await page.waitForFunction(() => App.view.source.type === 'folder');
            assert.deepEqual(await page.evaluate(() => App.view.sort), { key: 'name', dir: 'desc' });
        },
    },
];
