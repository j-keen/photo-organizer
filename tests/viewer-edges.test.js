'use strict';

const seed = {
    'a/01.png': { image: { color: '#336699' } },
    'a/02.png': { image: { color: '#663399' } },
    'b2/01.png': { image: { color: '#339966' } },
    'b10/01.png': { image: { color: '#996633' } },
};

async function openPhoto(page, path = 'a/01.png') {
    await page.evaluate(async (p) => {
        await App.nav.go(App.util.path.parent(p));
        App.viewer.open(p);
    }, path);
    await current(page, path);
}

async function current(page, path) {
    await page.waitForFunction((p) => App.viewer.current?.path === p &&
        App.viewer.media instanceof HTMLImageElement && App.viewer.media.complete &&
        App.viewer.media.naturalWidth > 0, path);
}

async function message(page, text) {
    await page.waitForFunction((value) => document.querySelector('.vw-osd')?.textContent.includes(value), text);
}

module.exports = [
    {
        name: 'viewer edges: keyboard warns, wraps in both directions and resets after three seconds',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await openPhoto(page, 'a/02.png');
            await page.keyboard.press('Control+ArrowRight');
            await message(page, '마지막 파일이에요 · 한 번 더 누르면 처음으로');
            assert.equal(await page.evaluate(() => App.viewer.current.path), 'a/02.png');
            await page.keyboard.press('Control+ArrowRight');
            await current(page, 'a/01.png');
            await message(page, '처음 파일이에요 (1/2)');
            await page.keyboard.press('ArrowLeft');
            await message(page, '첫 파일이에요 · 한 번 더 누르면 마지막으로');
            await page.keyboard.press('PageUp');
            await current(page, 'a/02.png');
            await message(page, '마지막 파일이에요 (2/2)');
            await page.keyboard.press('PageDown');
            await message(page, '마지막 파일이에요 · 한 번 더 누르면 처음으로');
            await page.waitForFunction(() => !document.querySelector('.vw-osd').classList.contains('vw-osd-in'));
            await page.keyboard.press('PageDown');
            await message(page, '마지막 파일이에요 · 한 번 더 누르면 처음으로');
            assert.equal(await page.evaluate(() => App.viewer.current.path), 'a/02.png');
        },
    },
    {
        name: 'viewer edges: stage buttons share guards, track the session and open the natural next folder',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await openPhoto(page);
            await page.click('.vw-nav.next');
            await current(page, 'a/02.png');
            await page.click('.vw-nav.next');
            await message(page, '이 폴더 2개 다 봤어요');
            assert.equal(await page.evaluate(() => App.viewer.current.path), 'a/02.png');
            await page.getByRole('button', { name: '다음 폴더로', exact: true }).click();
            await current(page, 'b2/01.png');
            assert.equal(await page.evaluate(() => App.state.cwd), 'b2');
            await page.evaluate(() => App.viewer.close());
            await openPhoto(page, 'a/02.png');
            await page.click('.vw-nav.next');
            await message(page, '마지막 파일이에요 · 한 번 더 누르면 처음으로');
            assert.equal(await page.locator('.vw-edge-detail').count(), 0);
            await page.click('.vw-nav.next');
            await current(page, 'a/01.png');
            await page.click('.vw-nav.prev');
            await message(page, '첫 파일이에요 · 한 번 더 누르면 마지막으로');
            await page.click('.vw-nav.prev');
            await current(page, 'a/02.png');
        },
    },
    {
        name: 'viewer edges: Escape closes a panel before the viewer and the second close Escape goes up',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await openPhoto(page);
            await page.evaluate(() => {
                App.viewer.registerPanel({ id: 'edge-test', title: '테스트', render() {} });
                App.viewer.togglePanel('edge-test', true);
            });
            await page.keyboard.press('Escape');
            await page.waitForFunction(() => App.viewer.isOpen && !App.viewer.isPanelOpen());
            await page.keyboard.press('Escape');
            await page.waitForFunction(() => !App.viewer.isOpen);
            assert.equal(await page.evaluate(() => App.state.cwd), 'a');
            await page.keyboard.press('Escape');
            await page.waitForFunction(() => App.state.cwd === '');
            assert.equal(await page.evaluate(() => App.viewer.isOpen), false);
        },
    },
];
