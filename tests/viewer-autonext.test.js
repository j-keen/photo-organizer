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

// Observe past the full countdown without timing-dependent negative assertions.
async function observe(page) {
    await page.evaluate(() => new Promise((resolve) => {
        window.__autoNextSeen = !!document.querySelector('.vw-autonext');
        const observer = new MutationObserver(() => {
            if (document.querySelector('.vw-autonext')) window.__autoNextSeen = true;
        });
        observer.observe(document.getElementById('viewer'), { childList: true, subtree: true });
        setTimeout(() => { observer.disconnect(); resolve(); }, 3300);
    }));
}

module.exports = [
    {
        name: 'auto-next: natural end counts down, skips the photo, and plays the next video',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await openVideo(page);
            assert.equal(await page.evaluate(() => App.settings.get('viewer.autoNext', true)), true);
            await finish(page);
            await page.waitForSelector('.vw-autonext');
            assert.match(await page.textContent('.vw-autonext'), /다음 영상 · 01-03.webm · 3초/);
            await page.waitForFunction(() => App.viewer.current?.path === '01-03.webm' && App.viewer.player?.path === '01-03.webm' && App.viewer.player.playing);
            assert.equal(await page.locator('.vw-autonext').count(), 0);
        },
    },
    {
        name: 'auto-next: cancel keeps the current video; Escape dismisses only the card',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await openVideo(page);
            await finish(page);
            await page.waitForSelector('.vw-autonext');
            await page.click('.vw-autonext button:has-text("취소")');
            await observe(page);
            assert.equal(await page.evaluate(() => App.viewer.current.path), '01-01.webm');
            assert.equal(await page.evaluate(() => window.__autoNextSeen), false);
            await finish(page);
            await page.waitForSelector('.vw-autonext');
            await page.keyboard.press('Escape');
            await page.waitForSelector('.vw-autonext', { state: 'detached' });
            assert.ok(await page.evaluate(() => App.viewer.isOpen));
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
        name: 'auto-next: edited preview end offers next video despite its boundary seek',
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
            await page.waitForSelector('.vw-autonext');
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => App.viewer.current?.path === '01-03.webm' && App.viewer.player?.path === '01-03.webm' && App.viewer.player.playing);
            assert.equal(await page.locator('.vw-autonext').count(), 0);
        },
    },
];
