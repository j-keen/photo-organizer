// Gallery performance guard: scrolling a 1500-image folder (grid and list) keeps frames short, never shows a blank
// viewport and keeps the DOM small. Thresholds are generous for busy CI machines; tighten them as the app improves.
'use strict';

/** Scroll top -> bottom in steps, waiting two frames per step; returns frame stats measured in the page. */
function scrollRun(page, steps) {
    return page.evaluate(async (steps) => {
        const s = document.getElementById('gallery-scroll');
        const total = s.scrollHeight - s.clientHeight;
        const frames = [];
        let blank = 0;
        let maxDom = 0;
        let last = performance.now();
        const twoFrames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        // First item whose box reaches below the top of the viewport, from layout geometry
        const firstVisible = (top) => {
            let lo = 0;
            let hi = App.view.visible.length - 1;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                const r = App.gallery.itemRect(mid);
                if (r.y + r.h <= top) lo = mid + 1;
                else hi = mid;
            }
            return lo;
        };
        for (let k = 1; k <= steps; k++) {
            s.scrollTop = Math.round((total * k) / steps);
            await twoFrames();
            const now = performance.now();
            frames.push((now - last) / 2);
            last = now;
            const i = firstVisible(s.scrollTop + 40);
            if (!App.gallery.cardFor(App.view.visible[i].path)) blank++;
            maxDom = Math.max(maxDom, document.querySelectorAll('#gallery > .card, #gallery > .lrow').length);
        }
        frames.sort((a, b) => a - b);
        const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
        return { avg, p95: frames[Math.floor(frames.length * 0.95)], max: frames[frames.length - 1], blank, maxDom };
    }, steps);
}

module.exports = [
    {
        name: 'scrolling 1500 images stays smooth in grid and list views',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: { 'many/': { bulk: { count: 1500 } } } });
            await page.evaluate(() => App.nav.go('many'));
            await page.waitForFunction(() => App.view.visible.length === 1500);
            await page.waitForSelector('.card[data-path="many/IMG_00001.png"]');
            await page.evaluate(() => {
                // Count thumbnail requests made while flinging through the folder
                window.__thumbCalls = 0;
                const orig = App.thumbs.get;
                App.thumbs.get = (...a) => {
                    window.__thumbCalls++;
                    return orig.apply(App.thumbs, a);
                };
            });

            const grid = await scrollRun(page, 80);
            const thumbCalls = await page.evaluate(() => window.__thumbCalls);
            console.log(`      grid: avg ${grid.avg.toFixed(1)}ms/frame, p95 ${grid.p95.toFixed(1)}ms, max ${grid.max.toFixed(1)}ms, max DOM ${grid.maxDom}, blank ${grid.blank}, thumbnail requests ${thumbCalls}`);
            assert.ok(thumbCalls < 500, `flinging past 1500 items doesn't queue a thumbnail for each (${thumbCalls})`);
            await page.waitForSelector('.card[data-path="many/IMG_01500.png"].has-thumb', { timeout: 15000 });
            assert.ok(grid.maxDom < 260, `grid keeps the DOM small (${grid.maxDom} cards)`);
            assert.equal(grid.blank, 0, 'the viewport is never blank after a frame');
            assert.ok(grid.avg < 60, `grid average frame ${grid.avg.toFixed(1)}ms`);
            assert.ok(grid.p95 < 160, `grid p95 frame ${grid.p95.toFixed(1)}ms`);
            await page.waitForSelector('.card[data-path="many/IMG_01500.png"]');

            await page.evaluate(() => {
                document.getElementById('gallery-scroll').scrollTop = 0;
                App.gallery.setMode('list');
            });
            await page.waitForSelector('.lrow[data-path="many/IMG_00001.png"]');
            const list = await scrollRun(page, 80);
            console.log(`      list: avg ${list.avg.toFixed(1)}ms/frame, p95 ${list.p95.toFixed(1)}ms, max ${list.max.toFixed(1)}ms, max DOM ${list.maxDom}, blank ${list.blank}`);
            assert.ok(list.maxDom < 160, `list keeps the DOM small (${list.maxDom} rows)`);
            assert.equal(list.blank, 0);
            assert.ok(list.avg < 60, `list average frame ${list.avg.toFixed(1)}ms`);
            await page.waitForSelector('.lrow[data-path="many/IMG_01500.png"]');

            // Selecting everything and lassoing back to one item stays responsive
            const t0 = Date.now();
            await page.keyboard.press('Control+a');
            assert.equal(await page.evaluate(() => App.select.count), 1500);
            assert.ok(Date.now() - t0 < 1500, 'select-all is quick');
            await waitIdle(page, 60000);
        },
    },
];
