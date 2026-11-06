'use strict';

const editor = '.capture-annotate';

async function pixels(page) {
    return page.locator(editor + ' canvas').evaluate((canvas) => canvas.toDataURL());
}

async function fileBytes(page) {
    return page.evaluate(async () => Array.from(new Uint8Array(await (await App.fs.getFile('capture.png')).arrayBuffer())));
}

async function filePixels(page) {
    return page.evaluate(async () => {
        const image = await createImageBitmap(await App.fs.getFile('capture.png'));
        try {
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            canvas.getContext('2d').drawImage(image, 0, 0);
            return canvas.toDataURL();
        } finally {
            image.close();
        }
    });
}

async function openEditor(page, assert) {
    assert.equal(await page.evaluate(() => App.captureAnnotate.open('capture.png')), true);
    await page.waitForSelector(editor + ' canvas');
    await page.waitForFunction(() => {
        const box = document.querySelector('.capture-annotate canvas')?.getBoundingClientRect();
        return box && box.width > 0 && box.height > 0;
    });
}

async function stroke(page, tool, offset = 0) {
    await page.locator(editor).getByRole('button', { name: tool, exact: true }).click();
    const before = await pixels(page);
    const box = await page.locator(editor + ' canvas').boundingBox();
    await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * (0.15 + offset));
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * (0.55 + offset), { steps: 8 });
    await page.mouse.up();
    await waitPixels(page, before, false);
}

async function waitPixels(page, expected, equal = true) {
    await page.waitForFunction(({ expected, equal }) => {
        const canvas = document.querySelector('.capture-annotate canvas');
        return canvas && (canvas.toDataURL() === expected) === equal;
    }, { expected, equal });
}

async function waitBytes(page, expected) {
    await page.waitForFunction(async (expected) => {
        const actual = new Uint8Array(await (await App.fs.getFile('capture.png')).arrayBuffer());
        return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
    }, expected);
}

async function trackUndo(page) {
    return page.evaluate(() => {
        window.__annotationPushes = 0;
        const push = App.undo.push;
        App.undo.push = function (...args) {
            window.__annotationPushes++;
            return push.apply(this, args);
        };
        return App.undo.list().length;
    });
}

module.exports = [
    {
        name: 'annotation tools: local history, changed pixels and one global undo restoring original bytes',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'capture.png': { image: { w: 640, h: 480, color: '#123456', label: 'CAPTURE' } } } });
            const original = await fileBytes(page);
            const originalPixels = await filePixels(page);
            const depth = await trackUndo(page);
            await openEditor(page, assert);
            const base = await pixels(page);
            assert.equal(base, originalPixels);
            await stroke(page, '펜');
            const pen = await pixels(page);
            await page.keyboard.press('Control+z');
            await waitPixels(page, base);
            await page.keyboard.press('Control+Shift+z');
            await waitPixels(page, pen);
            for (const [index, tool] of ['화살표', '사각형', '타원'].entries()) {
                await stroke(page, tool, (index + 1) * 0.08);
            }
            const beforeText = await pixels(page);
            await page.locator(editor).getByRole('button', { name: '글자', exact: true }).click();
            const box = await page.locator(editor + ' canvas').boundingBox();
            await page.mouse.click(box.x + box.width * 0.1, box.y + box.height * 0.85);
            await page.waitForSelector('.dialog input');
            await page.locator('.dialog input').fill('한글 메모');
            await page.locator('.dialog').getByRole('button', { name: '넣기', exact: true }).click();
            await page.waitForFunction(() => !document.querySelector('.dialog'));
            await waitPixels(page, beforeText, false);
            const edited = await pixels(page);
            assert.equal(await page.evaluate(() => window.__annotationPushes), 0);
            assert.equal(await page.evaluate(() => App.undo.list().length), depth);
            assert.deepEqual(await fileBytes(page), original);
            await page.locator(editor).getByRole('button', { name: '저장', exact: true }).click();
            await page.waitForFunction(() => !document.querySelector('.capture-annotate'));
            assert.equal(await page.evaluate(() => window.__annotationPushes), 1);
            assert.equal(await page.evaluate(() => App.undo.list().length), depth + 1);
            const saved = await fileBytes(page);
            assert.notDeepEqual(saved, original);
            assert.notEqual(await filePixels(page), originalPixels);
            assert.equal(await filePixels(page), edited);
            assert.equal(await page.evaluate(async () => (await App.fs.listTrash()).filter((item) => item.originalPath === 'capture.png' && item.reason === 'overwrite').length), 1);
            await page.keyboard.press('Control+z');
            await waitBytes(page, original);
            assert.deepEqual(await fileBytes(page), original);
            await page.keyboard.press('Control+y');
            await waitBytes(page, saved);
            assert.deepEqual(await fileBytes(page), saved);
            assert.equal(await page.evaluate(() => window.__annotationPushes), 1);
        },
    },
    {
        name: '취소 asks through App.ui, declining preserves drawings and discarding keeps the file',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'capture.png': { image: { color: '#123456', label: 'CAPTURE' } } } });
            const original = await fileBytes(page);
            const depth = await trackUndo(page);
            await openEditor(page, assert);
            await stroke(page, '사각형');
            const edited = await pixels(page);
            await page.locator(editor).getByRole('button', { name: '취소', exact: true }).click();
            await page.waitForSelector('.dialog');
            assert.ok(await page.locator(editor).isVisible());
            assert.deepEqual(await fileBytes(page), original);
            await page.locator('.dialog').getByRole('button', { name: '계속 그리기', exact: true }).click();
            await page.waitForFunction(() => !document.querySelector('.dialog'));
            await waitPixels(page, edited);
            await page.keyboard.press('Escape');
            await page.waitForSelector('.dialog');
            await page.locator('.dialog').getByRole('button', { name: '닫기', exact: true }).click();
            await page.waitForFunction(() => !document.querySelector('.capture-annotate') && !document.querySelector('.dialog'));
            assert.deepEqual(await fileBytes(page), original);
            assert.equal(await page.evaluate(() => window.__annotationPushes), 0);
            assert.equal(await page.evaluate(() => App.undo.list().length), depth);
            await openEditor(page, assert);
            await page.keyboard.press('Escape');
            await page.waitForFunction(() => !document.querySelector('.capture-annotate'));
            assert.deepEqual(await fileBytes(page), original);
        },
    },
    {
        name: 'failed save preserves annotations and supports retry with one global undo entry',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'capture.png': { image: { color: '#123456', label: 'CAPTURE' } } } });
            const original = await fileBytes(page);
            await trackUndo(page);
            await openEditor(page, assert);
            await stroke(page, '화살표');
            const edited = await pixels(page);
            await page.evaluate(() => {
                window.__annotationOverwrite = App.fs.overwrite;
                App.fs.overwrite = async () => { throw new Error('테스트 저장 실패'); };
            });
            try {
                await page.locator(editor).getByRole('button', { name: '저장', exact: true }).click();
                await page.waitForFunction(() => document.querySelector('.capture-annotate')?.getAttribute('aria-busy') === 'false' && document.querySelector('#toasts')?.textContent.includes('테스트 저장 실패'));
                await waitPixels(page, edited);
                assert.deepEqual(await fileBytes(page), original);
                assert.equal(await page.evaluate(() => window.__annotationPushes), 0);
            } finally {
                await page.evaluate(() => { App.fs.overwrite = window.__annotationOverwrite; });
            }
            await page.locator(editor).getByRole('button', { name: '저장', exact: true }).click();
            await page.waitForFunction(() => !document.querySelector('.capture-annotate'));
            assert.equal(await page.evaluate(() => window.__annotationPushes), 1);
            assert.equal(await filePixels(page), edited);
            await page.keyboard.press('Control+z');
            await waitBytes(page, original);
        },
    },
];
