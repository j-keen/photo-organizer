'use strict';

const SEED = {
    'clip.webm': { video: { seconds: 3 } },
    'a.png': { image: { color: '#b33' } },
    'b.png': { image: { color: '#33b' } },
    'sub/c.png': { image: { color: '#3b3' } },
};

async function setup(page, removed = []) {
    await page.waitForFunction(() => App.chipset?.ready && App.index.ready);
    return page.evaluate((ranges) => {
        App.settings.set('chips.filterOp', 'and');
        const cat = App.chipset.addCategory({ name: '장면' });
        const [a, b] = App.chipset.addChips(cat.id, ['노을', '바다']);
        App.chipset.apply(['a.png', 'sub/c.png'], a.id, 'add', { hud: false });
        App.chipset.apply(['a.png'], b.id, 'add', { hud: false });
        App.catalog.update('clip.webm', (entry) => {
            entry.meta = { ...(entry.meta || {}), edit: {
                cuts: [1], removed: ranges,
                pieces: { '1': { memo: '', chips: [a.id, b.id] } },
                updatedAt: 1,
            } };
        });
        return { a: a.id, b: b.id };
    }, removed);
}

async function visible(page, paths) {
    await page.waitForFunction((expected) => {
        const actual = App.view.visible.filter((e) => e.kind === 'file').map((e) => e.path).sort();
        return JSON.stringify(actual) === JSON.stringify(expected.slice().sort());
    }, paths);
}

module.exports = [
    {
        name: 'chips pieces: counts, AND/OR/exclude, smart views, badges and gallery playback',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            const ids = await setup(page);
            const row = (id) => `.chipf-row[data-chip="${id}"]`;
            await page.waitForFunction((id) => document.querySelector(`.chipf-row[data-chip="${id}"] .chipf-count`)?.textContent === '3', ids.a);
            assert.match(await page.getAttribute(row(ids.a), 'data-tip'), /조각 1/);
            await page.click(row(ids.a));
            await visible(page, ['a.png', 'clip.webm']);
            await page.waitForSelector('.card[data-path="clip.webm"] .chipf-piece-badge');
            assert.equal(await page.textContent('.card[data-path="clip.webm"] .chipf-piece-badge'), '조각 1');
            await (await card(page, 'clip.webm')).click();
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => App.viewer.player?.metaReady && Math.abs(App.viewer.player.time - 1) < 0.4);
            await page.keyboard.press('Escape');
            await page.waitForSelector('#viewer', { state: 'hidden' });
            await page.click(row(ids.b), { modifiers: ['Control'] });
            await page.click('.chipf-op [data-op="and"]');
            await visible(page, ['a.png', 'clip.webm']);
            await page.click('.chipf-op [data-op="or"]');
            await visible(page, ['a.png', 'clip.webm']);
            await page.click(row(ids.b), { modifiers: ['Alt'] });
            await visible(page, []);
            await page.click(row(ids.b), { modifiers: ['Alt'] });
            await visible(page, ['a.png', 'clip.webm']);
            await page.click('.chipf-bar [data-action="everywhere"]');
            await visible(page, ['a.png', 'clip.webm', 'sub/c.png']);
            await (await card(page, 'clip.webm')).dblclick();
            await page.waitForFunction(() => App.viewer.player?.metaReady && Math.abs(App.viewer.player.time - 1) < 0.4);
            await page.keyboard.press('Escape');
            await page.waitForSelector('#viewer', { state: 'hidden' });
            await page.evaluate(() => App.chipsFilter.showUntagged());
            await visible(page, ['b.png']);
        },
    },
    {
        name: 'chips pieces: removed starts are ignored and file chips open normally',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            const ids = await setup(page, [[1, 3]]);
            await page.waitForFunction((id) => App.chipsFilter.stats().chip.get(id) === 2, ids.a);
            assert.equal(await page.evaluate((id) => App.chipsFilter.stats().pieces.get(id) || 0, ids.a), 0);
            await page.evaluate((id) => App.chipsFilter.showChip(id), ids.a);
            await visible(page, ['a.png', 'sub/c.png']);
            await page.evaluate(() => App.chipsFilter.showUntagged());
            await visible(page, ['b.png', 'clip.webm']);
            await page.evaluate((id) => {
                App.chipset.apply(['clip.webm'], id, 'add', { hud: false });
                App.chipsFilter.showChip(id);
            }, ids.a);
            await visible(page, ['a.png', 'clip.webm', 'sub/c.png']);
            const payload = await page.evaluate(() => {
                let result;
                const off = App.bus.on('item:open', (e) => { result = e; });
                App.nav.open(App.index.get('clip.webm'));
                off();
                return result;
            });
            assert.equal(payload.path, 'clip.webm');
            assert.equal(payload.time, undefined);
            assert.equal(await page.locator('.card[data-path="clip.webm"] .chipf-piece-badge').count(), 0);
        },
    },
];
