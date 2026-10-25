'use strict';

const seed = {
    '01.webm': { video: { seconds: 2 } },
    '02.webm': { video: { seconds: 2 } },
    'other/03.webm': { video: { seconds: 2 } },
};

async function openVideo(page, path = '01.webm', opts = {}) {
    await page.evaluate(({ path, opts }) => {
        App.settings.set('viewer.muted', true);
        App.viewer.open(path, { play: false, ...opts });
    }, { path, opts });
    await page.waitForFunction((path) => App.viewer.player?.path === path && App.viewer.player.metaReady, path);
}

// Short generated media keeps seeding fast; the time model is controlled independently.
async function model(page, time) {
    await page.evaluate((time) => {
        const p = App.viewer.player;
        p.pause();
        Object.defineProperty(p, 'duration', { configurable: true, get: () => 120 });
        Object.defineProperty(p, 'time', { configurable: true, get: () => time });
    }, time);
}

module.exports = [
    {
        name: 'resume: leaving stores without undo, reopening seeks and 처음부터 clears',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await openVideo(page);
            await page.evaluate(() => {
                // Closing clears the active player; keep its prototype for the reopening hook.
                window.__resumePlayerProto = Object.getPrototypeOf(App.viewer.player);
            });
            const before = await page.evaluate(() => App.undo.list().length);
            await model(page, 30);
            await page.evaluate(() => App.viewer.close());
            assert.equal(await page.evaluate(() => App.catalog.peek('01.webm').meta.resumeAt), 30);
            assert.equal(await page.evaluate(() => App.undo.list().length), before);
            // Install before reopening: afterMeta applies resume before a readiness wait can observe it.
            await page.evaluate(() => {
                const proto = window.__resumePlayerProto;
                const afterMeta = proto.afterMeta;
                window.__resumeSeek = null;
                proto.afterMeta = function (...args) {
                    if (this.path !== '01.webm' || this.destroyed || this.metaReady) return afterMeta.apply(this, args);
                    proto.afterMeta = afterMeta;
                    Object.defineProperty(this, 'duration', { configurable: true, get: () => 120 });
                    // Keep the real seek inside the short generated media.
                    const seek = this.seek.bind(this);
                    this.seek = (t) => { window.__resumeSeek = t; seek(t === 30 ? 1 : t); };
                    return afterMeta.apply(this, args);
                };
            });
            await page.evaluate(() => App.viewer.close());
            await page.evaluate(() => App.catalog.setMeta('01.webm', { resumeAt: 30, duration: 120 }));
            await openVideo(page);
            await page.waitForSelector('.vw-resume');
            await page.waitForFunction(() => !App.viewer.player.video.seeking && Math.abs(App.viewer.player.time - 1) < 0.05);
            assert.equal(await page.evaluate(() => window.__resumeSeek), 30);
            assert.equal(await page.locator('.vw-resume span').textContent(), '0:30부터 이어서 봐요 · ');
            await page.click('.vw-resume button');
            await page.waitForFunction(() => window.__resumeSeek === 0 && !App.viewer.player.video.seeking && Math.abs(App.viewer.player.time) < 0.05 && App.catalog.peek('01.webm').meta.resumeAt == null);
            assert.equal(await page.locator('.vw-resume').count(), 0);
        },
    },
    {
        name: 'resume: short and near-end positions clear; explicit time bypasses resume',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            for (const time of [9, 105, 119]) {
                await openVideo(page);
                await page.evaluate(() => App.catalog.setMeta('01.webm', { resumeAt: 30 }));
                await model(page, time);
                await page.evaluate(() => App.viewer.close());
                assert.equal(await page.evaluate(() => App.catalog.peek('01.webm').meta.resumeAt), null);
            }
            await page.evaluate(() => App.catalog.setMeta('01.webm', { resumeAt: 30, duration: 120 }));
            await openVideo(page, '01.webm', { time: 0 });
            assert.equal(await page.locator('.vw-resume').count(), 0);
        },
    },
    {
        name: 'resume: playing time updates checkpoint and gallery decorator uses catalog progress',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await openVideo(page);
            await model(page, 30);
            await page.evaluate(() => {
                const p = App.viewer.player;
                Object.defineProperty(p, 'playing', { configurable: true, get: () => true });
                p.resumeSavedAt = -5000;
                p.video.dispatchEvent(new Event('timeupdate'));
            });
            await page.waitForFunction(() => App.catalog.peek('01.webm').meta.resumeAt === 30);
            assert.equal(await page.evaluate(() => App.catalog.peek('01.webm').meta.resumeDur), 120);
            // The checkpoint must refresh the existing card even while the viewer covers it.
            await page.waitForSelector('.card[data-path="01.webm"] .vw-resume-progress > i', { state: 'attached' });
            assert.equal(await page.$eval('.card[data-path="01.webm"] .vw-resume-progress > i', (el) => el.style.width), '25%');
            await page.evaluate(() => App.viewer.close());
            await page.waitForSelector('.card[data-path="01.webm"] .vw-resume-progress > i');
            assert.equal(await page.$eval('.card[data-path="01.webm"] .vw-resume-progress > i', (el) => el.style.width), '25%');
            await page.evaluate(() => {
                App.catalog.setMeta('01.webm', { resumeAt: null });
                App.gallery.invalidate(['01.webm']);
            });
            await page.waitForSelector('.card[data-path="01.webm"] .vw-resume-progress', { state: 'detached' });
        },
    },
    {
        name: 'folder rate: persists normal speed, isolates folders, ignores shuttle and removes normal rate',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await openVideo(page);
            await page.evaluate(() => App.viewer.player.setRate(1.5));
            await openVideo(page, '02.webm');
            assert.equal(await page.evaluate(() => App.viewer.player.rate), 1.5);
            await page.evaluate(() => App.viewer.player.jkl(1));
            assert.equal(await page.evaluate(() => App.settings.get('viewer.rateByFolder', {})['']), 1.5);
            await page.evaluate(() => App.viewer.player.setRate(1));
            assert.equal(await page.evaluate(() => Object.hasOwn(App.settings.get('viewer.rateByFolder', {}), '')), false);
            await page.evaluate(() => App.undo.undo());
            assert.equal(await page.evaluate(() => App.settings.get('viewer.rateByFolder', {})['']), 1.5);
            await page.evaluate(() => App.viewer.close());
            await openVideo(page, 'other/03.webm');
            assert.equal(await page.evaluate(() => App.viewer.player.rate), 1);
        },
    },
];
