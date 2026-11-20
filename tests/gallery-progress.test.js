'use strict';

const seed = {
    'clip.webm': { video: { seconds: 2 } },
    'photo.png': { image: { color: '#336699' } },
};
const progress = '.card[data-path="clip.webm"] .card-watch-progress:not(.is-watched)';
const finished = '.card[data-path="clip.webm"] .card-watch-progress.is-watched';

module.exports = [
    {
        name: 'gallery progress: saving a mid-way resume keeps watchedAt and progress wins over the finished badge',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: {
                ...seed,
                'clip.webm': { video: { seconds: 40 } },
            } });
            await page.evaluate(() => {
                App.settings.set('viewer.autoNext', false);
                App.settings.set('viewer.muted', true);
                App.catalog.setMeta('clip.webm', { watchedAt: 123, resumeAt: null, resumeDur: null });
                App.gallery.invalidate(['clip.webm']);
            });
            await page.waitForSelector(finished);
            await page.evaluate(() => App.viewer.open('clip.webm', { play: false, time: 12 }));
            await page.waitForFunction(() => App.viewer.player?.metaReady && !App.viewer.player.video.seeking && Math.abs(App.viewer.player.time - 12) < 0.5);
            const result = await page.evaluate(() => {
                const undo = App.undo.list().length;
                App.viewer.player.saveResume();
                const meta = App.catalog.peek('clip.webm').meta;
                return { at: meta.resumeAt, watchedAt: meta.watchedAt, unchangedUndo: undo === App.undo.list().length };
            });
            assert.equal(result.watchedAt, 123);
            assert.equal(Math.abs(result.at - 12) < 0.5, true);
            assert.equal(result.unchangedUndo, true);
            await page.evaluate(() => App.viewer.close());
            await page.waitForSelector(progress);
            assert.equal(await page.locator(finished).count(), 0);
            await page.evaluate(() => {
                App.catalog.setMeta('clip.webm', { resumeAt: null, resumeDur: null });
                App.gallery.invalidate(['clip.webm']);
            });
            await page.waitForSelector(finished);
            assert.equal(await page.locator(progress).count(), 0);
            assert.equal(await page.evaluate(() => App.catalog.peek('clip.webm').meta.watchedAt), 123);
        },
    },
    {
        name: 'gallery progress: cached resume metadata paints one accessible bar, invalidation updates it in place in both themes',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await page.waitForSelector('.card[data-path="clip.webm"]');
            await page.evaluate(() => {
                window.__progressCard = App.gallery.cardFor('clip.webm');
                window.__progressUndo = App.undo.list().length;
                App.catalog.setMeta('clip.webm', { resumeAt: 30, resumeDur: 120 });
                App.catalog.setMeta('photo.png', { resumeAt: 30, resumeDur: 120 });
                App.gallery.invalidate(['clip.webm', 'photo.png']);
            });
            await page.waitForSelector(progress);
            assert.equal(await page.locator(progress).count(), 1);
            assert.equal(await page.locator(`${progress} > i`).evaluate((el) => el.style.width), '25%');
            assert.equal(await page.getAttribute(progress, 'aria-valuenow'), '30');
            assert.equal(await page.getAttribute(progress, 'aria-valuemax'), '120');
            assert.equal(await page.getAttribute(progress, 'role'), 'progressbar');
            assert.equal(await page.locator('.card[data-path="photo.png"] .card-watch-progress').count(), 0);
            for (const theme of ['dark', 'light']) {
                const colors = await page.evaluate((theme) => {
                    document.documentElement.dataset.theme = theme;
                    const card = App.gallery.cardFor('clip.webm');
                    const bar = card.querySelector('.card-watch-progress');
                    const probe = document.createElement('i');
                    probe.style.color = 'var(--accent)';
                    card.append(probe);
                    const result = {
                        fill: getComputedStyle(bar.firstElementChild).backgroundColor,
                        accent: getComputedStyle(probe).color,
                        height: getComputedStyle(bar).height,
                    };
                    probe.remove();
                    return result;
                }, theme);
                assert.equal(colors.fill, colors.accent);
                assert.equal(colors.height, '2px');
            }
            await page.evaluate(() => {
                App.catalog.setMeta('clip.webm', { resumeAt: 60, resumeDur: 120 });
                App.gallery.invalidate(['clip.webm']);
            });
            await page.waitForFunction(() => App.gallery.cardFor('clip.webm')?.querySelector('.card-watch-progress > i')?.style.width === '50%');
            assert.equal(await page.evaluate(() => App.gallery.cardFor('clip.webm') === window.__progressCard), true);
            assert.equal(await page.evaluate(() => App.undo.list().length === window.__progressUndo), true);
            await page.evaluate(() => App.settings.set('viewer.rememberResume', false));
            await page.waitForSelector(progress, { state: 'detached' });
            await page.evaluate(() => App.settings.set('viewer.rememberResume', true));
            await page.waitForSelector(progress);
        },
    },
    {
        name: 'gallery progress: duration fallback works and invalid or cleared positions never produce a bar',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await page.evaluate(() => {
                App.catalog.setMeta('clip.webm', { resumeAt: 30, resumeDur: null, duration: 100 });
                App.gallery.invalidate(['clip.webm']);
            });
            await page.waitForSelector(progress);
            assert.equal(await page.locator(`${progress} > i`).evaluate((el) => el.style.width), '30%');
            for (const [resumeAt, resumeDur] of [[null, null], [-1, 100], [30, -1], [100, 100]]) {
                await page.evaluate(([resumeAt, resumeDur]) => {
                    App.catalog.setMeta('clip.webm', { resumeAt, resumeDur, duration: null });
                    App.gallery.invalidate(['clip.webm']);
                }, [resumeAt, resumeDur]);
                await page.waitForSelector(progress, { state: 'detached' });
            }
        },
    },
    {
        name: 'gallery progress: natural video end clears resume metadata and persists the finished state without undo',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await page.evaluate(() => {
                App.settings.set('viewer.autoNext', false);
                App.settings.set('viewer.muted', true);
                App.viewer.open('clip.webm', { play: false });
            });
            await page.waitForFunction(() => App.viewer.player?.metaReady);
            await page.evaluate(() => {
                App.catalog.setMeta('clip.webm', { resumeAt: 30, resumeDur: 100 });
                App.gallery.invalidate(['clip.webm']);
                window.__watchUndo = App.undo.list().length;
                App.viewer.player.seek(App.viewer.player.duration - 0.25);
            });
            await page.waitForFunction(() => !App.viewer.player.video.seeking);
            await page.evaluate(() => App.viewer.player.play());
            await page.waitForFunction(() => App.viewer.player.video.ended && App.catalog.peek('clip.webm')?.meta.resumeAt === null);
            assert.equal(await page.evaluate(() => App.catalog.peek('clip.webm').meta.resumeDur), null);
            assert.equal(await page.evaluate(() => Number.isFinite(App.catalog.peek('clip.webm').meta.watchedAt) && App.catalog.peek('clip.webm').meta.watchedAt > 0), true);
            assert.equal(await page.evaluate(() => App.undo.list().length === window.__watchUndo), true);
            await page.evaluate(() => App.viewer.close());
            await page.waitForSelector(progress, { state: 'detached' });
            await page.waitForSelector(finished);
            assert.equal(await page.locator(finished).textContent(), '다 봄');
            assert.equal(await page.getAttribute(finished, 'role'), 'status');
            assert.equal(await page.getAttribute(finished, 'aria-valuenow'), null);
            assert.equal(await page.locator('.card[data-path="photo.png"] .is-watched').count(), 0);
        },
    },
];
