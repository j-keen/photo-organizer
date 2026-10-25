'use strict';

const seed = {
    '01-01.webm': { video: { seconds: 2 } },
    '01-02.png': { image: { color: '#336699' } },
    '01-03.webm': { video: { seconds: 2 } },
};

async function openVideo(page, path = '01-01.webm') {
    await page.evaluate((p) => {
        App.settings.set('viewer.muted', true);
        App.viewer.open(p, { play: false });
    }, path);
    await page.waitForFunction((p) => App.viewer.player?.path === p && App.viewer.player.metaReady && App.viewer.player.duration > 0.5, path);
}

async function finish(page) {
    await page.evaluate(() => {
        const p = App.viewer.player;
        p.seek(p.duration - 0.3);
    });
    await page.waitForFunction(() => !App.viewer.player.video.seeking);
    await page.evaluate(() => App.viewer.player.play());
}

// Sample after the media event and its synchronous navigation have settled.
async function observe(page) {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
        window.__autoNextSeen = !!document.querySelector('.vw-autonext');
        resolve();
    }))));
}

module.exports = [
    {
        name: 'auto-next: natural end immediately skips the photo and plays the next video',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await openVideo(page);
            assert.equal(await page.evaluate(() => App.settings.get('viewer.autoNext', true)), true);
            await finish(page);
            await page.waitForFunction(() => App.viewer.current?.path === '01-03.webm', null, { timeout: 2000 });
            await page.waitForFunction(() => App.viewer.current?.path === '01-03.webm' && App.viewer.player?.path === '01-03.webm' && App.viewer.player.playing);
            assert.equal(await page.locator('.vw-autonext').count(), 0);
        },
    },
    {
        name: 'auto-next: completion toast moves only the previous file and undo restores it',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await openVideo(page);
            const before = await page.evaluate(() => App.undo.list().length);
            await finish(page);
            await page.waitForFunction(() => App.viewer.player?.path === '01-03.webm');
            await page.getByRole('button', { name: '완료로 옮기기', exact: true }).click();
            await page.getByRole('button', { name: '완료하기', exact: true }).click();
            await page.waitForFunction(async () => await window.__opfs.exists('_완료/01-01.webm'));
            assert.equal(await page.evaluate(() => App.viewer.current.path), '01-03.webm');
            assert.equal(await page.evaluate(() => App.undo.list().length), before + 1);
            await page.evaluate(() => App.undo.undo());
            await page.waitForFunction(async () => await window.__opfs.exists('01-01.webm'));
        },
    },
    {
        name: 'auto-next: automatic completion advances before moving the previous file',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await openVideo(page);
            await page.evaluate(() => App.settings.set('viewer.autoDoneOnEnd', true));
            await finish(page);
            await page.getByRole('button', { name: '완료하기', exact: true }).click();
            await page.waitForFunction(async () => await window.__opfs.exists('_완료/01-01.webm'));
            assert.equal(await page.evaluate(() => App.viewer.current.path), '01-03.webm');
            assert.equal(await page.getByRole('button', { name: '완료로 옮기기', exact: true }).count(), 0);
        },
    },
    {
        name: 'auto-next: menu setting disables the card and is one undo step',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await openVideo(page);
            const before = await page.evaluate(() => App.undo.list().length);
            await page.click('.vw-actions [data-act="more"]');
            await page.click('.menu :text-is("다 보면 다음 영상")');
            await page.waitForFunction(() => App.settings.get('viewer.autoNext', true) === false);
            assert.equal(await page.evaluate(() => App.undo.list().length), before + 1);
            await finish(page);
            await page.waitForFunction(() => App.viewer.player.video.ended);
            await observe(page);
            assert.equal(await page.evaluate(() => window.__autoNextSeen), false);
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => App.settings.get('viewer.autoNext', true) === true);
        },
    },
    {
        name: 'auto-next: openAt segment end never offers the next file',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await openVideo(page);
            await page.evaluate(() => {
                window.__segmentDone = false;
                App.bus.on('viewer:segment-ended', () => { window.__segmentDone = true; });
                const d = App.viewer.player.duration;
                App.viewer.openAt('01-01.webm', { start: d - 0.5, end: d - 0.2 });
            });
            await page.waitForFunction(() => window.__segmentDone);
            await observe(page);
            assert.equal(await page.evaluate(() => window.__autoNextSeen), false);
            assert.equal(await page.evaluate(() => App.viewer.current.path), '01-01.webm');
        },
    },
    {
        name: 'auto-next: last video shows only the last-video OSD',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await openVideo(page, '01-03.webm');
            await finish(page);
            await page.waitForFunction(() => document.querySelector('.vw-osd')?.textContent === '마지막 영상이에요');
            assert.equal(await page.locator('.vw-autonext').count(), 0);
            assert.equal(await page.evaluate(() => App.viewer.current.path), '01-03.webm');
        },
    },
    {
        name: 'auto-next: edited preview immediately advances despite its boundary seek',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await openVideo(page);
            await page.evaluate(() => App.viewer.player.seek(1));
            await page.waitForFunction(() => !App.viewer.player.video.seeking);
            await page.keyboard.press('w');
            await page.waitForFunction(() => App.viewer.player.skip?.length > 0);
            await page.evaluate(() => App.viewer.player.seek(0.7));
            await page.waitForFunction(() => !App.viewer.player.video.seeking);
            await page.evaluate(() => App.viewer.player.play());
            await page.waitForFunction(() => App.viewer.current?.path === '01-03.webm', null, { timeout: 2000 });
            await page.waitForFunction(() => App.viewer.current?.path === '01-03.webm' && App.viewer.player?.path === '01-03.webm' && App.viewer.player.playing);
            assert.equal(await page.locator('.vw-autonext').count(), 0);
        },
    },
];
