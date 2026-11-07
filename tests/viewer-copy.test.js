'use strict';

module.exports = [
    {
        name: 'viewer copies original photos and current video frames as oriented PNG',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: {
                'photo.jpg': { image: { w: 1800, h: 1100, mime: 'image/jpeg', color: '#c33' } },
                'clip.webm': { video: { w: 320, h: 240, seconds: 1 } },
            } });
            await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
            await page.evaluate(() => {
                window.__writes = [];
                window.__copyRequests = [];
                Object.defineProperty(navigator.clipboard, 'write', { configurable: true, value: async (items) => {
                    window.__copyRequests.push({ path: App.viewer.current?.path, type: App.viewer.current?.type });
                    const blob = await items[0].getType('image/png');
                    const bitmap = await createImageBitmap(blob);
                    window.__writes.push({ type: blob.type, size: blob.size, w: bitmap.width, h: bitmap.height });
                    bitmap.close();
                } });
                App.viewer.open('photo.jpg');
            });
            await page.waitForFunction(() => App.viewer.image?.full?.naturalWidth === 1800);
            await page.keyboard.press('Control+c');
            await page.waitForFunction(() => window.__writes.length === 1);
            assert.deepEqual(await page.evaluate(() => ({ ...window.__writes[0], size: undefined })), { type: 'image/png', size: undefined, w: 1800, h: 1100 });
            assert.ok(await page.evaluate(() => window.__writes[0].size > 0));
            assert.deepEqual(await page.evaluate(() => App.gallery.clipboard.paths), ['photo.jpg']);
            await page.keyboard.press('r');
            await page.keyboard.press('h');
            await page.keyboard.press('Control+c');
            await page.waitForFunction(() => window.__writes.length === 2);
            assert.deepEqual(await page.evaluate(() => [window.__writes[1].w, window.__writes[1].h]), [1100, 1800]);
            await page.evaluate(() => {
                const memo = App.util.h('textarea', { id: 'copy-test-memo', 'aria-label': '메모' });
                App.viewer.root.append(memo);
                memo.focus();
            });
            await page.keyboard.type('memo');
            await page.keyboard.press('Control+c');
            assert.equal(await page.evaluate(() => window.__copyRequests.length), 2);
            await page.evaluate(() => {
                document.querySelector('#copy-test-memo').remove();
                // Focus first: changing focus after selecting text can collapse the selection.
                App.viewer.root.focus();
                const text = App.util.h('p', { id: 'copy-test-text', style: 'user-select:text' }, '텍스트');
                App.viewer.root.append(text);
                const range = document.createRange();
                range.selectNodeContents(text);
                getSelection().removeAllRanges();
                getSelection().addRange(range);
            });
            await page.waitForFunction(() => !!getSelection()?.toString());
            await page.keyboard.press('Control+c');
            assert.equal(await page.evaluate(() => window.__copyRequests.length), 2);
            await page.evaluate(() => {
                getSelection().removeAllRanges();
                document.querySelector('#copy-test-text').remove();
            });
            await page.locator('.vw-stage').click({ button: 'right', position: { x: 20, y: 20 } });
            await page.waitForSelector('.menu');
            for (const label of ['이미지 복사', '보이는 부분만 복사', '파일 경로 복사']) assert.ok(await page.locator('.menu').getByText(label, { exact: true }).count());
            await page.keyboard.press('Escape');
            await page.evaluate(() => App.viewer.open('clip.webm', { play: false }));
            await page.waitForFunction(() => {
                const viewer = App.viewer;
                const player = viewer.player;
                return viewer.current?.path === 'clip.webm' && viewer.current.type === 'video' &&
                    player?.metaReady && viewer.media === player.video && player.video.readyState >= 2 &&
                    player.video.videoWidth === 320 && player.video.videoHeight === 240;
            });
            assert.equal(await page.evaluate(() => window.__copyRequests.length), 2);
            await page.evaluate(() => {
                App.viewer.player.pause();
                App.viewer.setRotation('clip.webm', 90);
                App.viewer.root.focus();
            });
            await page.keyboard.press('Control+c');
            await page.waitForFunction(() => window.__writes.length === 3);
            assert.deepEqual(await page.evaluate(() => window.__copyRequests), [
                { path: 'photo.jpg', type: 'image' },
                { path: 'photo.jpg', type: 'image' },
                { path: 'clip.webm', type: 'video' },
            ]);
            assert.deepEqual(await page.evaluate(() => [window.__writes[2].type, window.__writes[2].w, window.__writes[2].h]), ['image/png', 240, 320]);
            assert.ok(await page.evaluate(() => window.__writes[2].size > 0));
            await page.locator('.vw-stage').click({ button: 'right', position: { x: 20, y: 20 } });
            await page.waitForSelector('.menu');
            assert.ok(await page.locator('.menu').getByText('지금 장면 복사', { exact: true }).count());
            const scopes = await page.evaluate(() => ['viewer.copy', 'file.copy'].map((id) => App.commands.get(id).scope));
            assert.deepEqual(scopes, ['viewer', 'main']);
        },
    },
];
