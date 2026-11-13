/* External program menus and failed-video escape routes. */
'use strict';

module.exports = [
    {
        name: 'open-with: offline menus remain available and explain server setup',
        async run(h) {
            const { page } = await h.openApp({ seed: { 'broken.avi': { bytes: [1, 2, 3] }, 'folder/': null } });
            await page.evaluate(() => { App.server.health = async () => null; });
            await page.locator('.card[data-path="broken.avi"]').click({ button: 'right' });
            await page.waitForFunction(() => document.body.textContent.includes('기본 앱으로 열기 · 로컬 서버를 켜면 돼요'));
            await page.getByText('기본 앱으로 열기 · 로컬 서버를 켜면 돼요', { exact: true }).click();
            await page.waitForSelector('.srv-setup');
            await page.keyboard.press('Escape');
            await page.evaluate(() => App.viewer.open('broken.avi'));
            await page.waitForSelector('#viewer .vw-card .srv-external');
            const buttons = page.locator('#viewer .vw-card .srv-external');
            h.assert.ok((await buttons.allTextContents()).includes('다른 프로그램으로 열기'));
            h.assert.equal(await buttons.first().evaluate((node) => node.style.opacity), '');
            h.assert.ok(await page.getByRole('button', { name: '바로 재생하기', exact: true }).isVisible());
            await buttons.first().click();
            await page.waitForSelector('.srv-setup');
        },
    },
    {
        name: 'open-with: older servers explain that player support needs an update',
        async run(h) {
            const { page } = await h.openApp({ seed: { 'broken.avi': { bytes: [1, 2, 3] } } });
            await page.evaluate(() => {
                const original = App.server;
                window.__opens = [];
                window.__setupCalls = 0;
                App.settings.set('external.player.video', { id: 'pot', name: '팟플레이어' });
                App.server = {
                    available: true,
                    backend: {},
                    supports: () => false,
                    canStream: () => false,
                    externalButtons: original.externalButtons,
                    externalItems: original.externalItems,
                    openWith: async (...args) => { window.__opens.push(args); },
                    showSetup: () => { window.__setupCalls++; },
                };
            });
            await page.evaluate(() => App.viewer.open('broken.avi'));
            await page.waitForSelector('#viewer .vw-card .srv-external');
            const button = page.locator('#viewer .vw-card').getByRole('button', {
                name: '팟플레이어로 열기 · 로컬 서버를 업데이트해 주세요',
                exact: true,
            });
            await button.waitFor({ state: 'visible' });
            h.assert.equal(await button.evaluate((node) => node.style.opacity), '0.55');
            await button.click();
            await page.waitForFunction(() => document.body.textContent.includes('로컬 서버를 업데이트해 주세요'));
            h.assert.deepEqual(await page.evaluate(() => window.__opens), []);
            h.assert.equal(await page.evaluate(() => window.__setupCalls), 0);
            const labels = await page.evaluate(() => App.server.externalItems(App.viewer.current).map((item) => item.label));
            h.assert.ok(labels.includes('기본 앱으로 열기'));
            h.assert.ok(labels.includes('다른 프로그램으로 열기 · 로컬 서버를 업데이트해 주세요'));
            h.assert.ok(labels.every((label) => !label.includes('로컬 서버를 켜면 돼요')));
        },
    },
    {
        name: 'open-with: fail card and viewer context menu call the selected player',
        async run(h) {
            const { page } = await h.openApp({ seed: { 'broken.avi': { bytes: [1, 2, 3] } } });
            await page.evaluate(() => {
                const original = App.server;
                window.__opens = [];
                App.settings.set('external.player.video', { id: 'pot', name: '팟플레이어' });
                App.server = {
                    available: true,
                    backend: {},
                    supports: (feature) => feature === 'open-with',
                    canStream: () => false,
                    externalButtons: original.externalButtons,
                    externalItems: original.externalItems,
                    players: async () => [],
                    openWith: async (...args) => { window.__opens.push(args); },
                    reveal: async (path) => { window.__revealed = path; },
                    openDefault: async () => {},
                    showSetup: () => {},
                };
            });
            await page.evaluate(() => App.viewer.open('broken.avi'));
            await page.waitForSelector('#viewer .vw-card .srv-external');
            await page.locator('#viewer .vw-card').getByRole('button', { name: '팟플레이어로 열기', exact: true }).click();
            await page.waitForFunction(() => window.__opens.length === 1);
            h.assert.deepEqual(await page.evaluate(() => window.__opens[0]), ['broken.avi', 'pot']);
            await page.locator('#viewer .vw-card').getByRole('button', { name: '다른 프로그램으로 열기', exact: true }).click();
            await page.getByText('목록에서 고르기…', { exact: true }).click();
            await page.waitForFunction(() => window.__opens.length === 2);
            h.assert.deepEqual(await page.evaluate(() => window.__opens[1]), ['broken.avi']);
            await page.locator('#viewer .vw-card').getByRole('button', { name: '탐색기에서 보기', exact: true }).click();
            await page.waitForFunction(() => window.__revealed === 'broken.avi');
            const labels = await page.evaluate(() => App.viewer.contextItems.flatMap((provider) => provider(App.viewer.current, 'video') || []).map((item) => item.label));
            h.assert.ok(labels.includes('팟플레이어로 열기'));
            h.assert.ok(labels.includes('기본 앱으로 열기'));
        },
    },
];
