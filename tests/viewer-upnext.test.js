'use strict';

const seed = {
    '01.png': { image: { color: '#336699' } },
    '02.webm': { video: { seconds: 0.3 } },
    '03.png': { image: { color: '#663399' } },
};

module.exports = [
    {
        name: 'team3: viewer-upnext video panel, photo navigation, shortcut and fallback jump',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await page.evaluate(() => {
                // Exercise the compatibility path even after Team 1 lands its API.
                App.viewer.upNext = undefined;
                App.viewer.goPath = undefined;
                App.viewer.open('02.webm');
            });
            await page.waitForFunction(() => App.viewer.current?.path === '02.webm');
            await page.keyboard.press('Alt+n');
            await page.waitForSelector('.upnext-row');
            assert.deepEqual(await page.locator('.upnext-row').evaluateAll((rows) => rows.map((row) => row.dataset.path)), ['02.webm', '03.png']);
            assert.equal(await page.locator('.upnext-row[aria-current="true"]').getAttribute('data-path'), '02.webm');
            await page.keyboard.press('Alt+n');
            await page.waitForSelector('.upnext-list', { state: 'detached' });
            await page.keyboard.press('Alt+n');
            await page.waitForSelector('.upnext-row');
            await page.click('.upnext-row[data-path="03.png"]');
            await page.waitForFunction(() => App.viewer.current?.path === '03.png');
            await page.waitForSelector('.upnext-list', { state: 'detached' });
            assert.equal(await page.locator('.vw-dock-tab[data-panel="upnext"]').count(), 0);
        },
    },
    {
        name: 'team3: viewer-upnext uses upNext/goPath contract and refresh event',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await page.evaluate(async () => {
                await App.thumbs.get(App.view.get('02.webm'));
                App.viewer.open('02.webm');
                App.viewer.upNext = (n) => {
                    window.__upnextLimit = n;
                    return window.__upnextEntries || [];
                };
                App.viewer.goPath = (path) => { window.__upnextJump = path; };
                window.__upnextEntries = [App.view.get('03.png'), App.view.get('01.png')];
                App.catalog.setMeta('02.webm', { duration: 125 });
            });
            await page.evaluate(() => App.commands.run('viewer.upnext'));
            assert.equal(await page.evaluate(() => window.__upnextLimit), 10);
            assert.deepEqual(await page.locator('.upnext-row').evaluateAll((rows) => rows.map((row) => row.dataset.path)), ['02.webm', '03.png', '01.png']);
            assert.ok((await page.locator('.upnext-row[data-path="02.webm"] .upnext-meta').innerText()).includes('2:05'));
            await page.click('.upnext-row[data-path="03.png"]');
            assert.equal(await page.evaluate(() => window.__upnextJump), '03.png');
            await page.evaluate(() => {
                window.__upnextEntries = [App.view.get('01.png')];
                App.bus.emit('viewer:upnext-changed');
            });
            assert.deepEqual(await page.locator('.upnext-row').evaluateAll((rows) => rows.map((row) => row.dataset.path)), ['02.webm', '01.png']);
            await page.locator('.upnext-row[data-path="02.webm"]').focus();
            await page.evaluate(() => {
                window.__upnextFocused = document.activeElement;
                App.catalog.setMeta('02.webm', { duration: 180 });
                App.bus.emit('thumbs:meta', { path: '02.webm', duration: 180 });
                App.bus.emit('thumbs:ready', { path: 'unrelated.png' });
            });
            assert.equal(await page.evaluate(() => document.activeElement === window.__upnextFocused), true);
            assert.ok((await page.locator('.upnext-row[data-path="02.webm"] .upnext-meta').innerText()).includes('3:00'));
            await page.evaluate(() => {
                window.__upnextEntries = [App.view.get('01.png'), App.view.get('02.webm'), App.view.get('01.png')];
                App.bus.emit('viewer:upnext-changed');
            });
            assert.deepEqual(await page.locator('.upnext-row').evaluateAll((rows) => rows.map((row) => row.dataset.path)), ['02.webm', '01.png', '02.webm', '01.png']);
            assert.equal(await page.locator('.upnext-row[aria-current="true"]').count(), 1);
        },
    },
    {
        name: 'team3: viewer-upnext caps the panel at current plus ten and follows theme tokens',
        async run({ openApp, assert }) {
            const files = Object.fromEntries(Array.from({ length: 13 }, (_, index) => [
                `${String(index).padStart(2, '0')}.${index === 0 ? 'webm' : 'png'}`,
                index === 0 ? { video: { seconds: 0.3 } } : { image: {} },
            ]));
            const { page } = await openApp({ seed: files });
            await page.evaluate(() => App.viewer.open('00.webm'));
            await page.evaluate(() => App.commands.run('viewer.upnext'));
            assert.equal(await page.locator('.upnext-row').count(), 11);
            for (const theme of ['dark', 'light']) {
                const colors = await page.evaluate((theme) => {
                    document.documentElement.dataset.theme = theme;
                    const row = document.querySelector('.upnext-row:not(.current)');
                    const probe = document.createElement('div');
                    probe.style.color = 'var(--text)';
                    document.body.append(probe);
                    const result = [getComputedStyle(row).color, getComputedStyle(probe).color];
                    probe.remove();
                    return result;
                }, theme);
                assert.equal(colors[0], colors[1]);
            }
        },
    },
];
