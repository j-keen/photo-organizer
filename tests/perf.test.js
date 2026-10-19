// Performance guards for big folders. Numbers are generous upper bounds for CI-like machines;
// tighten them as the app gets faster.
'use strict';

module.exports = [
    {
        name: 'a 3000-file folder opens fast and only renders what is on screen',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: { 'big/': { bulk: { count: 3000 } }, 'cover.png': { image: {} } } });
            const t0 = Date.now();
            await page.evaluate(() => App.nav.go('big'));
            await page.waitForFunction(() => App.view.visible.length === 3000);
            const openMs = Date.now() - t0;
            const rendered = await page.evaluate(() => document.querySelectorAll('#gallery .card').length);
            assert.ok(rendered < 400, `virtualization should keep DOM small (rendered ${rendered})`);
            assert.ok(openMs < 8000, `opening took ${openMs}ms`);

            // Scrolling to the bottom renders the last cards
            await page.evaluate(() => {
                const s = document.getElementById('gallery-scroll');
                s.scrollTop = s.scrollHeight;
            });
            await page.waitForSelector('.card[data-path="big/IMG_03000.png"]');
            await page.keyboard.press('Control+a');
            assert.equal(await page.evaluate(() => App.select.count), 3000);
            await waitIdle(page, 60000);
        },
    },
    {
        name: 'indexing 3000 files across folders completes',
        async run({ openApp, assert }) {
            const seed = {};
            for (let i = 0; i < 6; i++) seed[`f${i}/`] = { bulk: { count: 500, pattern: `P${i}_{n}.png` } };
            const t0 = Date.now();
            const { page } = await openApp({ seed });
            await page.waitForFunction(() => App.index.ready, null, { timeout: 60000 });
            const ms = Date.now() - t0;
            assert.equal(await page.evaluate(() => App.index.items.length), 3000);
            assert.ok(ms < 30000, `seed+open+index took ${ms}ms`);
            const hits = await page.evaluate(() => App.index.search('P3_00042').length);
            assert.equal(hits, 1);
        },
    },
];
