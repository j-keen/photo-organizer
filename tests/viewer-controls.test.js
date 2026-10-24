'use strict';

async function openVideo(page) {
    await page.evaluate(() => App.viewer.open('clip.webm', { play: false }));
    await page.waitForFunction(() => App.viewer.player?.metaReady && App.viewer.player.duration > 0.5);
    await page.evaluate(() => App.viewer.player.pause());
}

async function noOverlap(page) {
    await page.waitForFunction(() => {
        const video = document.querySelector('#viewer video.vw-media');
        const controls = document.querySelector('.vw-ctl');
        return video && controls && video.getBoundingClientRect().bottom <= controls.getBoundingClientRect().top + 0.5;
    });
}

module.exports = [
    {
        name: 'video controls reserve space below video, including selected pieces; preference restores floating controls',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'clip.webm': { video: { seconds: 3 } } } });
            await openVideo(page);
            await noOverlap(page);
            const height = await page.locator('.vw-stage').evaluate((el) => el.clientHeight);
            await page.evaluate(() => App.viewer.player.seek(1));
            await page.keyboard.press('Control+b');
            await page.waitForFunction(() => App.catalog.get('clip.webm').meta.edit?.cuts?.length === 1);
            await page.evaluate(() => App.videoEdit.select('clip.webm', 0, { seek: true }));
            await page.waitForSelector('.vw-pstrip');
            await page.waitForFunction((before) => document.querySelector('.vw-stage').clientHeight < before, height);
            await noOverlap(page);
            await page.evaluate(() => App.settings.set('viewer.controlsBelow', false));
            await page.waitForFunction(() => {
                const stage = document.querySelector('.vw-stage').getBoundingClientRect();
                const wrap = document.querySelector('.vw-stage-wrap').getBoundingClientRect();
                return Math.abs(stage.bottom - wrap.bottom) < 1;
            });
            assert.equal(await page.locator('#viewer.vw-controls-below').count(), 0);
        },
    },
    {
        name: 'paused fullscreen video collapses to a progress line over an idle dock and restores on mouse or key',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'clip.webm': { video: { seconds: 2 } } } });
            await openVideo(page);
            await page.evaluate(() => {
                App.viewer.togglePanel('markers', true);
                App.viewer.root.classList.add('vw-fs');
            });
            await page.hover('.vw-dock-body');
            await page.evaluate(() => App.viewer.poke());
            await page.waitForSelector('#viewer.vw-fs.vw-idle', { timeout: 7000 });
            await page.waitForFunction(() => getComputedStyle(document.querySelector('.vw-ctl')).opacity === '0');
            const line = await page.locator('.vw-idle-progress').boundingBox();
            assert.equal(line.height, 3);
            assert.equal(await page.locator('.vw-idle-progress').evaluate((el) => getComputedStyle(el).opacity), '1');
            assert.equal(await page.evaluate(() => App.viewer.player.playing), false);
            await page.mouse.move(400, 250);
            await page.waitForFunction(() => !App.viewer.root.classList.contains('vw-idle'));
            await page.waitForFunction(() => getComputedStyle(document.querySelector('.vw-ctl')).opacity === '1');
            await page.waitForSelector('#viewer.vw-idle', { timeout: 7000 });
            await page.keyboard.press('Shift');
            await page.waitForFunction(() => !App.viewer.root.classList.contains('vw-idle'));
        },
    },
];
