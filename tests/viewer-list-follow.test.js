'use strict';

const seed = {
    'a/match-01.webm': { video: { seconds: 2 } },
    'b/match-02.png': { image: { color: '#336699' } },
    'c/match-03.webm': { video: { seconds: 2 } },
    'a/deep/match-04.png': { image: { color: '#663399' } },
    'b/match-05.webm': { video: { seconds: 2 } },
    'c/match-06.png': { image: { color: '#339966' } },
    'b/hidden.png': { image: { color: '#996633' } },
};
const all = Object.keys(seed).filter((p) => p.includes('match')).sort((a, b) => a.split('/').pop().localeCompare(b.split('/').pop()));
const videos = all.filter((p) => p.endsWith('.webm'));

async function ready(page, path) {
    await page.waitForFunction((p) => {
        const v = App.viewer;
        return v.current?.path === p && (v.kind === 'video' ? v.player?.path === p && v.player.metaReady :
            v.media instanceof HTMLImageElement && v.media.complete && v.media.naturalWidth > 0);
    }, path);
}

async function openFirst(page, paths) {
    await page.evaluate((p) => {
        App.viewer.close();
        App.viewer.open(p, { play: false });
    }, paths[0]);
    await ready(page, paths[0]);
}

async function manualControls(page, assert, paths) {
    assert.deepEqual(await page.evaluate(() => App.view.visible.filter((e) => e.kind === 'file').map((e) => e.path)), paths);
    for (const control of ['Control+ArrowRight', 'PageDown', 'button']) {
        await openFirst(page, paths);
        assert.deepEqual(await page.evaluate(() => App.viewer.files.map((e) => e.path)), paths);
        for (const p of paths.slice(1)) {
            if (control === 'button') await page.locator('.vw-nav.next').click({ force: true });
            else await page.keyboard.press(control);
            await ready(page, p);
            assert.deepEqual(await page.evaluate(() => App.viewer.files.map((e) => e.path)), paths);
        }
        await page.keyboard.press('Control+ArrowLeft');
        await ready(page, paths[paths.length - 2]);
    }
}

async function slideshow(page, assert, paths) {
    await openFirst(page, paths);
    await page.evaluate(() => {
        App.settings.set('viewer.slideshowInterval', 1);
        App.settings.set('viewer.slideshowShuffle', false);
        App.settings.set('viewer.slideshowLoop', false);
        App.settings.set('viewer.slideshowVideos', true);
        window.__listFollowSeen = [];
        window.__listFollowOff?.();
        window.__listFollowOff = App.bus.on('viewer:entry', ({ entry }) => window.__listFollowSeen.push(entry.path));
        App.viewer.slideshow.start();
    });
    for (const p of paths) {
        await ready(page, p);
        if (p.endsWith('.webm')) {
            // Exercise the real ended path; avoid waiting through each entire recording.
            await page.evaluate(() => App.viewer.player.seek(App.viewer.player.duration - 0.25));
            await page.waitForFunction(() => !App.viewer.player.video.seeking);
            await page.evaluate(() => App.viewer.player.play());
        }
    }
    await page.waitForFunction(() => !App.viewer.slideshow.running);
    assert.deepEqual(await page.evaluate(() => window.__listFollowSeen), paths.slice(1));
    assert.equal(await page.evaluate(() => App.viewer.current.path), paths[paths.length - 1]);
    assert.deepEqual(await page.evaluate(() => App.viewer.files.map((e) => e.path)), paths);
    await page.evaluate(() => window.__listFollowOff());
}

async function wheelFromPhoto(page, assert, paths) {
    const at = paths.findIndex((p, i) => p.endsWith('.png') && i < paths.length - 1);
    if (at < 0) return; // Video wheels control volume; file wheel navigation is a photo action.
    await page.evaluate((p) => {
        App.viewer.close();
        App.settings.set('viewer.wheelNav', true);
        App.viewer.open(p, { play: false });
    }, paths[at]);
    await ready(page, paths[at]);
    // Use the active media's screen position, independent of dock/filmstrip preferences.
    const box = await page.evaluate(() => {
        const r = App.viewer.media.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(box.x, box.y);
    await page.mouse.wheel(0, 120);
    await ready(page, paths[at + 1]);
    assert.deepEqual(await page.evaluate(() => App.viewer.files.map((e) => e.path)), paths);
}

async function search(page) {
    await page.evaluate(async () => {
        App.settings.set('viewer.autoplay', false);
        App.settings.set('viewer.muted', true);
        App.settings.set('viewer.autoNext', false);
        App.view.setSort('name', 'asc');
        await App.topbar.search('match');
    });
}

module.exports = [
    {
        name: 'viewer list follow: cross-folder topbar search follows visible order with keys, next button, photo wheel and slideshow',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await search(page);
            await manualControls(page, assert, all);
            await wheelFromPhoto(page, assert, all);
            await slideshow(page, assert, all);
        },
    },
    {
        name: 'viewer list follow: videos-only search never visits hidden photos with keys, next button or slideshow',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await search(page);
            await page.evaluate(() => App.commands.run('view.filterVideos'));
            await manualControls(page, assert, videos);
            await slideshow(page, assert, videos);
            assert.equal(await page.evaluate(() => App.viewer.files.every((e) => e.type === 'video')), true);
        },
    },
    {
        name: 'viewer list follow: chip-filtered descending search follows only tagged files across folders',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await search(page);
            await page.waitForFunction(() => App.chipset.ready);
            const paths = [all[0], all[1], all[2], all[5]].reverse();
            const id = await page.evaluate((paths) => {
                const cat = App.chipset.addCategory({ name: '목록 확인' });
                const [chip] = App.chipset.addChips(cat.id, ['보기']);
                App.chipset.apply(paths, chip.id, 'add', { hud: false });
                App.view.setSort('name', 'desc');
                return chip.id;
            }, paths);
            await page.locator(`.chipf-row[data-chip="${id}"]`).click();
            await manualControls(page, assert, paths);
            await wheelFromPhoto(page, assert, paths);
            await slideshow(page, assert, paths);
        },
    },
    {
        name: 'viewer list follow: recursive photos-only view follows nested folders and hides videos for every navigation control',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await page.evaluate(async () => {
                App.settings.set('viewer.autoplay', false);
                App.settings.set('viewer.muted', true);
                App.view.setSort('name', 'desc');
                await App.commands.run('nav.toggleRecursive');
                App.commands.run('view.filterImages');
            });
            const paths = ['c/match-06.png', 'a/deep/match-04.png', 'b/match-02.png', 'b/hidden.png'];
            assert.equal(await page.evaluate(() => App.view.source.recursive), true);
            await manualControls(page, assert, paths);
            await wheelFromPhoto(page, assert, paths);
            await slideshow(page, assert, paths);
        },
    },
];
