'use strict';

async function photo(page) {
    await page.evaluate(() => App.viewer.open('photo.png'));
    await page.waitForFunction(() => App.viewer.image?.full?.naturalWidth === 400 && App.capture.available());
}

module.exports = [
    {
        name: 'capture: source resolution, oriented region, format and inherited chips',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'photo.png': { image: { w: 400, h: 200, color: '#c33' } } } });
            await photo(page);
            const result = await page.evaluate(async () => {
                App.settings.set('capture.format', 'png');
                App.catalog.update('photo.png', { chips: ['test-chip'] }, { undoable: false });
                App.viewer.setRotation('photo.png', 90);
                const view = App.viewer.view;
                view.finish();
                view.zoomTo(2);
                const r = view.slot.getBoundingClientRect();
                const shot = await App.capture.grab({ region: { x: r.left + r.width / 2 - 50, y: r.top + r.height / 2 - 80, width: 100, height: 160 } });
                const before = App.undo.list().length;
                const saved = await App.capture.save(shot, { undoable: false });
                return { w: shot.w, h: shot.h, mime: shot.blob.type, source: shot.source, saved, meta: App.catalog.peek(saved.path), delta: App.undo.list().length - before };
            });
            assert.equal(result.w, 50);
            assert.equal(result.h, 80);
            assert.equal(result.mime, 'image/png');
            assert.equal(result.source.rot, 90);
            assert.equal(result.source.crop.x, 75);
            assert.equal(result.source.crop.y, 160);
            assert.equal(result.saved.path, '_캡처/photo_캡처.png');
            assert.equal(result.saved.createdDir, true);
            assert.deepEqual(result.meta.chips, ['test-chip']);
            assert.equal(result.meta.meta.capture.path, 'photo.png');
            assert.equal(result.delta, 0);
        },
    },
    {
        name: 'capture: one undo removes file and empty created folder; redo restores metadata',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'photo.png': { image: { w: 400, h: 200, color: '#3c3' } } } });
            await photo(page);
            const result = await page.evaluate(async () => {
                App.settings.set('capture.format', 'jpg');
                const before = App.undo.list().length;
                window.__shot = await App.capture.grab();
                window.__capturePath = await App.capture.save(window.__shot);
                return { delta: App.undo.list().length - before, w: window.__shot.w, h: window.__shot.h };
            });
            assert.deepEqual(result, { delta: 1, w: 400, h: 200 });
            await page.evaluate(() => App.undo.undo());
            assert.equal(await page.evaluate(() => __opfs.exists('_캡처')), false);
            await page.evaluate(() => App.undo.redo());
            assert.equal(await page.evaluate(() => __opfs.exists(window.__capturePath)), true);
            assert.equal(await page.evaluate(() => App.catalog.peek(window.__capturePath).meta.capture.kind), 'image');
            const second = await page.evaluate(() => App.capture.save(window.__shot));
            assert.equal(second, '_캡처/photo_캡처 (2).jpg');
            await page.evaluate(() => App.undo.undo());
            assert.equal(await page.evaluate(() => __opfs.exists(window.__capturePath)), true);
        },
    },
    {
        name: 'capture: region selection escapes without closing viewer and dragging returns viewport rect',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'photo.png': { image: { w: 400, h: 200, color: '#33c' } } } });
            await photo(page);
            await page.evaluate(() => { window.__region = 'waiting'; App.capture.pickRegion().then((r) => { window.__region = r; }); });
            await page.waitForSelector('.cap-region');
            await page.keyboard.press('Escape');
            await page.waitForFunction(() => window.__region === null);
            assert.equal(await page.evaluate(() => App.viewer.isOpen), true);
            await page.evaluate(() => { window.__region = 'waiting'; App.capture.pickRegion().then((r) => { window.__region = r; }); });
            await page.waitForSelector('.cap-region');
            const bounds = await page.locator('.cap-region').boundingBox();
            await page.mouse.move(bounds.x + 100, bounds.y + 100);
            await page.mouse.down();
            await page.mouse.move(bounds.x + 200, bounds.y + 160);
            await page.mouse.up();
            await page.waitForFunction(() => window.__region !== 'waiting');
            const rect = await page.evaluate(() => window.__region);
            assert.equal(rect.width, 100);
            assert.equal(rect.height, 60);
            assert.equal(await page.locator('.cap-region').count(), 0);
        },
    },
];
