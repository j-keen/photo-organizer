'use strict';

async function openVideo(page) {
    await page.evaluate(() => App.viewer.open('b-clip.webm'));
    await page.waitForFunction(() => App.viewer.player?.metaReady && App.viewer.player.duration > 2);
    await page.evaluate(() => {
        App.viewer.player.pause();
        App.settings.set('viewer.seekStep', 1);
        App.viewer.player.seek(1.25);
    });
    await page.waitForFunction(() => Math.abs(App.viewer.player.time - 1.25) < 0.05);
}

const seed = {
    'a-photo.png': { image: { color: '#663399' } },
    'b-clip.webm': { video: { seconds: 3 } },
    'c-photo.png': { image: { color: '#336699' } },
};

module.exports = [
    {
        name: 'arrow navigation stays latched after Ctrl release until arrow keyup',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await openVideo(page);
            await page.keyboard.down('Control');
            await page.keyboard.down('ArrowRight');
            await page.waitForFunction(() => App.viewer.current.path === 'c-photo.png');
            await page.keyboard.up('Control');
            await page.keyboard.down('ArrowLeft');
            await page.waitForFunction(() => App.viewer.current.path === 'b-clip.webm' && App.viewer.player?.metaReady);
            await page.evaluate(() => {
                window.__arrowSeeks = 0;
                const player = App.viewer.player;
                const seekStep = player.seekStep.bind(player);
                player.seekStep = (delta) => {
                    window.__arrowSeeks++;
                    return seekStep(delta);
                };
            });
            await page.keyboard.down('ArrowRight');
            await page.waitForFunction(() => App.viewer.current.path === 'c-photo.png');
            assert.equal(await page.evaluate(() => window.__arrowSeeks), 0);
            await page.keyboard.up('ArrowLeft');
            await page.keyboard.up('ArrowRight');
            await page.keyboard.press('ArrowLeft');
            await page.waitForFunction(() => App.viewer.current.path === 'b-clip.webm' && App.viewer.player?.metaReady);
            await page.evaluate(() => {
                App.viewer.player.pause();
                App.viewer.player.seek(0.5);
            });
            await page.waitForFunction(() => Math.abs(App.viewer.player.time - 0.5) < 0.05);
            await page.keyboard.press('ArrowRight');
            await page.waitForFunction(() => Math.abs(App.viewer.player.time - 1.5) < 0.12);
            assert.equal(await page.evaluate(() => App.viewer.current.path), 'b-clip.webm');
        },
    },
    ...['Control', 'Meta'].flatMap((modifier) => ['ArrowLeft', 'ArrowRight'].map((arrow) => ({
        name: `${arrow} followed by ${modifier} restores the seek and steps once`,
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await openVideo(page);
            await page.evaluate(() => {
                const player = App.viewer.player;
                window.__arrowOriginalTime = player.time;
                window.__arrowRestores = [];
                window.__arrowEntries = 0;
                App.bus.on('viewer:entry', () => window.__arrowEntries++);
                const seek = player.seek.bind(player);
                player.seek = (time, ...args) => {
                    window.__arrowRestores.push(time);
                    return seek(time, ...args);
                };
                // Freeze only the chord clock so test runner latency cannot cross 150 ms.
                window.__arrowNow = performance.now;
                const now = performance.now();
                performance.now = () => now;
            });
            await page.keyboard.down(arrow);
            await page.keyboard.down(modifier);
            const target = arrow === 'ArrowLeft' ? 'a-photo.png' : 'c-photo.png';
            await page.waitForFunction((path) => App.viewer.current.path === path, target);
            const result = await page.evaluate(() => {
                performance.now = window.__arrowNow;
                return {
                    original: window.__arrowOriginalTime,
                    restores: window.__arrowRestores,
                    entries: window.__arrowEntries,
                };
            });
            assert.ok(Math.abs(result.restores[result.restores.length - 1] - result.original) < 0.001, 'original player position restored before navigation');
            assert.equal(result.entries, 1);
            await page.keyboard.up(modifier);
            await page.keyboard.up(arrow);
        },
    }))),
    {
        name: 'released plain arrow seeks without becoming a late modifier chord',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await openVideo(page);
            await page.keyboard.press('ArrowRight');
            await page.waitForFunction(() => Math.abs(App.viewer.player.time - 2.25) < 0.12);
            await page.keyboard.press('Control');
            assert.equal(await page.evaluate(() => App.viewer.current.path), 'b-clip.webm');
            await page.keyboard.press('ArrowLeft');
            await page.waitForFunction(() => Math.abs(App.viewer.player.time - 1.25) < 0.12);
        },
    },
];
