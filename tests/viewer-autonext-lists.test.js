'use strict';

const videos = {
    '01.webm': { video: { seconds: 2 } },
    '02.webm': { video: { seconds: 2 } },
    '03.webm': { video: { seconds: 2 } },
};
const folders = {
    'a/match-01.webm': videos['01.webm'],
    'b/match-02.png': { image: { color: '#336699' } },
    'c/match-03.webm': videos['03.webm'],
};

async function ready(page, path) {
    await page.waitForFunction((p) => App.viewer.current?.path === p &&
        (App.viewer.kind === 'video' ? App.viewer.player?.path === p && App.viewer.player.metaReady :
            App.viewer.media?.complete && App.viewer.media?.naturalWidth > 0), path);
}
async function open(page, path = '01.webm') {
    await page.evaluate((p) => {
        App.settings.set('viewer.muted', true);
        App.viewer.open(p, { play: false });
    }, path);
    await ready(page, path);
}
// Existing auto-next tests cover real media endings. Drive the same native-ended
// guard deterministically here, so ordering / cards don't depend on decode timing.
async function end(page) {
    await page.evaluate(() => {
        const p = App.viewer.player;
        p.pause();
        Object.defineProperty(p.video, 'ended', { configurable: true, get: () => true });
        App.bus.emit('viewer:video-ended', { path: p.path });
    });
}
async function search(page) {
    await page.evaluate(async () => {
        await App.index.whenReady();
        await App.topbar.search('match');
    });
    await page.waitForFunction(() => App.view.source.type === 'search' && App.view.visible.filter((e) => e.kind === 'file').length === 3);
}
async function paths(page, n = 10) {
    return page.evaluate((count) => App.viewer.upNext(count).map((e) => e.path), n);
}
async function osd(page, text) {
    await page.waitForFunction((t) => document.querySelector('.vw-osd')?.textContent.includes(t), text);
}

module.exports = [
    {
        name: 'auto-next lists: search crosses folders, stops at a photo, counts the list and hides next-folder action',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: folders });
            await search(page);
            await open(page, 'a/match-01.webm');
            assert.equal(await page.textContent('.vw-counter'), '검색 결과 1 / 3');
            assert.deepEqual(await paths(page), ['b/match-02.png', 'c/match-03.webm']);
            await end(page);
            await ready(page, 'b/match-02.png');
            await osd(page, '다음 파일 · match-02.png');
            assert.equal(await page.textContent('.vw-osd .vw-edge-detail'), 'b');
            assert.equal(await page.evaluate(() => App.viewer.player), null);
            await page.keyboard.press('Control+ArrowRight');
            await ready(page, 'c/match-03.webm');
            await osd(page, '다음 파일 · match-03.webm');
            assert.equal(await page.textContent('.vw-osd .vw-edge-detail'), 'c');
            await page.keyboard.press('Control+ArrowRight');
            await osd(page, '검색 결과 3개 다 봤어요');
            assert.equal(await page.getByRole('button', { name: '다음 폴더로', exact: true }).count(), 0);
            assert.equal(await page.textContent('.vw-counter'), '검색 결과 3 / 3');
        },
    },
    {
        name: 'auto-next lists: search video filter and list sync update upNext without hidden photos',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: folders });
            await search(page);
            await page.evaluate(() => App.topbar.setTypeFilter('video'));
            await open(page, 'a/match-01.webm');
            assert.deepEqual(await paths(page), ['c/match-03.webm']);
            await end(page);
            await ready(page, 'c/match-03.webm');
            await page.evaluate(() => {
                window.__listEvents = 0;
                App.bus.on('viewer:upnext-changed', () => window.__listEvents++);
                App.view.setSort('name', 'desc');
            });
            assert.deepEqual(await paths(page), ['a/match-01.webm']);
            assert.ok(await page.evaluate(() => window.__listEvents > 0));
        },
    },
    {
        name: 'auto-next lists: recursive video filter crosses folders and keeps rate while direct open remembers its folder',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: {
                'a/01.webm': videos['01.webm'], 'a/sub/02.webm': videos['02.webm'],
                'a/sub/03.png': { image: {} },
            } });
            await page.evaluate(() => App.nav.go('a'));
            await page.keyboard.press('Alt+i');
            await page.waitForFunction(() => App.view.source.recursive && App.view.visible.length === 3);
            await page.evaluate(() => {
                App.topbar.setTypeFilter('video');
                App.settings.set('viewer.rateByFolder', { a: 1.5, 'a/sub': 0.5 });
            });
            await open(page, 'a/01.webm');
            assert.equal(await page.textContent('.vw-counter'), '필터 1 / 2');
            assert.equal(await page.evaluate(() => App.viewer.player.rate), 1.5);
            await end(page);
            await ready(page, 'a/sub/02.webm');
            assert.equal(await page.evaluate(() => App.viewer.player.rate), 1.5);
            await page.keyboard.press('Control+ArrowLeft');
            await ready(page, 'a/01.webm');
            await page.keyboard.press('Control+ArrowRight');
            await ready(page, 'a/sub/02.webm');
            assert.equal(await page.evaluate(() => App.viewer.player.rate), 1.5);
            await page.evaluate(() => App.viewer.close());
            await open(page, 'a/sub/02.webm');
            assert.equal(await page.evaluate(() => App.viewer.player.rate), 0.5);
        },
    },
    {
        name: 'auto-next lists: loop wraps, upNext previews without consuming, toggles are undoable',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: videos });
            await open(page, '03.webm');
            assert.deepEqual(await paths(page), []);
            const before = await page.evaluate(() => App.undo.list().length);
            await page.evaluate(() => {
                window.__upnextEvents = 0;
                App.bus.on('viewer:upnext-changed', () => window.__upnextEvents++);
                App.commands.run('viewer.autoNext.loop');
            });
            assert.equal(await page.evaluate(() => App.undo.list().length), before + 1);
            assert.deepEqual(await paths(page, 4), ['01.webm', '02.webm', '03.webm', '01.webm']);
            assert.deepEqual(await paths(page, 4), ['01.webm', '02.webm', '03.webm', '01.webm']);
            await end(page);
            await ready(page, '01.webm');
            assert.ok(await page.evaluate(() => window.__upnextEvents >= 2));
            await page.evaluate(() => App.undo.undo());
            assert.equal(await page.evaluate(() => App.settings.get('viewer.autoNextLoop')), false);
            assert.deepEqual(await paths(page), ['02.webm', '03.webm']);
        },
    },
    {
        name: 'auto-next lists: shuffle has no repeats, stops when exhausted and leaves manual steps sorted',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: videos });
            await open(page);
            await page.evaluate(() => {
                Math.random = () => 0;
                App.commands.run('viewer.autoNext.shuffle');
            });
            assert.deepEqual(await paths(page), ['03.webm', '02.webm']);
            await end(page);
            await ready(page, '03.webm');
            assert.deepEqual(await paths(page), ['02.webm']);
            await end(page);
            await ready(page, '02.webm');
            assert.deepEqual(await paths(page), []);
            await end(page);
            await osd(page, '마지막 파일이에요');
            assert.equal(await page.evaluate(() => App.viewer.current.path), '02.webm');
            await page.keyboard.press('Control+ArrowRight');
            await ready(page, '03.webm');
            assert.deepEqual(await paths(page), []);
            await page.evaluate(() => App.commands.run('viewer.autoNext.loop'));
            assert.equal((await paths(page, 3)).length, 3);
            await page.evaluate(() => App.viewer.close());
            await open(page, '02.webm');
            const next = await paths(page, 2);
            assert.equal(new Set(['02.webm', ...next]).size, 3);
        },
    },
    {
        name: 'auto-next lists: skips broken images only on automatic arrival',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: {
                '01.webm': videos['01.webm'], '02.png': 'broken image', '03.png': { image: {} },
            } });
            await open(page);
            await end(page);
            await ready(page, '03.png');
            await page.waitForFunction(() => document.body.textContent.includes('열 수 없어서 건너뛰었어요 · 02.png'));
            await page.evaluate(() => App.viewer.goPath('02.png'));
            await page.waitForSelector('.vw-card.is-error');
            assert.equal(await page.evaluate(() => App.viewer.current.path), '02.png');
        },
    },
    {
        name: 'auto-next lists: broken video chain cannot loop or skip manual failures',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { '01.webm': videos['01.webm'], '02.webm': 'bad video', '03.webm': 'bad video' } });
            await open(page);
            await page.evaluate(() => {
                App.settings.set('viewer.autoNextLoop', true);
                App.fs.url = async (path) => { if (path !== '01.webm') throw new Error('test unreadable'); throw new Error('unexpected origin reload'); };
            });
            await end(page);
            await osd(page, '열 수 있는 다음 파일이 없어요');
            assert.equal(await page.evaluate(() => App.viewer.current.path), '03.webm');
            await page.evaluate(() => App.viewer.goPath('02.webm'));
            await page.waitForSelector('.vw-card.is-error');
            assert.equal(await page.evaluate(() => App.viewer.current.path), '02.webm');
        },
    },
    {
        name: 'auto-next lists: countdown supports now, Escape, navigation and elapsed time',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: videos });
            await open(page);
            await page.evaluate(() => App.settings.set('viewer.autoNextDelay', 3));
            await end(page);
            await page.waitForSelector('.vw-autonext');
            assert.match(await page.textContent('.vw-autonext-title'), /다음 파일 · 02.webm · 3초/);
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('.vw-autonext').count(), 0);
            assert.equal(await page.evaluate(() => App.viewer.isOpen), true);
            await end(page);
            await page.getByRole('button', { name: '취소', exact: true }).click();
            assert.equal(await page.locator('.vw-autonext').count(), 0);
            await end(page);
            await page.getByRole('button', { name: '지금 보기', exact: true }).click();
            await ready(page, '02.webm');
            await end(page);
            await page.keyboard.press('Control+ArrowLeft');
            await ready(page, '01.webm');
            assert.equal(await page.locator('.vw-autonext').count(), 0);
            await page.clock.install();
            await end(page);
            await page.clock.runFor(3100);
            await ready(page, '02.webm');
        },
    },
    {
        name: 'auto-next lists: ask pauses after five advances, continues, input resets and stop is session-only',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: videos });
            await open(page);
            await page.evaluate(() => { App.settings.set('viewer.autoNextLoop', true); App.settings.set('viewer.autoNextAsk', 5); });
            for (let i = 0; i < 5; i++) { await end(page); await ready(page, ['02.webm', '03.webm', '01.webm'][i % 3]); }
            await page.waitForSelector('.vw-autonext-ask');
            assert.equal(await page.evaluate(() => App.viewer.player.playing), false);
            await page.getByRole('button', { name: '계속 보기', exact: true }).click();
            await page.waitForFunction(() => App.viewer.player.playing);
            for (let i = 0; i < 4; i++) { await end(page); await ready(page, ['01.webm', '02.webm', '03.webm'][i % 3]); }
            await page.keyboard.press('Shift');
            await end(page);
            await ready(page, '02.webm');
            assert.equal(await page.locator('.vw-autonext-ask').count(), 0);
            for (let i = 0; i < 4; i++) { await end(page); await ready(page, ['03.webm', '01.webm', '02.webm'][i % 3]); }
            await page.getByRole('button', { name: '그만 보기', exact: true }).click();
            const path = await page.evaluate(() => App.viewer.current.path);
            await end(page);
            assert.equal(await page.evaluate(() => App.viewer.current.path), path);
            assert.equal(await page.evaluate(() => App.settings.get('viewer.autoNext', true)), true);
            await page.evaluate(() => { App.commands.run('viewer.sleepTimer', { value: 15 }); App.viewer.close(); });
            await open(page);
            await end(page);
            await ready(page, '02.webm');
        },
    },
    {
        name: 'auto-next lists: sleep end and timed sleep pause without changing preferences and clear on close',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: videos });
            await open(page);
            await page.evaluate(() => App.commands.run('viewer.sleepTimer', { value: 'end' }));
            await end(page);
            await osd(page, '잠자기 타이머로 멈췄어요');
            assert.equal(await page.evaluate(() => App.viewer.current.path), '01.webm');
            assert.equal(await page.evaluate(() => App.viewer.player.playing), false);
            await page.evaluate(() => App.viewer.close());
            await open(page);
            await page.clock.install();
            await page.evaluate(() => App.commands.run('viewer.sleepTimer', { value: 15 }));
            await page.click('.vw-actions [data-act="more"]');
            await page.waitForFunction(() => document.querySelector('.menu')?.textContent.includes('15분 남음'));
            await page.keyboard.press('Escape');
            await page.clock.runFor(15 * 60000);
            await osd(page, '잠자기 타이머로 멈췄어요');
            await end(page);
            assert.equal(await page.evaluate(() => App.viewer.current.path), '01.webm');
            await page.evaluate(() => App.viewer.close());
            await open(page);
            await end(page);
            await ready(page, '02.webm');
        },
    },
    {
        name: 'auto-next lists: shortcut feedback, settings choices and smart counter',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: videos });
            await open(page);
            const before = await page.evaluate(() => App.undo.list().length);
            await page.keyboard.press('Alt+Shift+a');
            await osd(page, '다음 파일로 넘기기 끔');
            assert.equal(await page.evaluate(() => App.undo.list().length), before + 1);
            await page.evaluate(() => App.undo.undo());
            assert.equal(await page.evaluate(() => App.settings.get('viewer.autoNext', true)), true);
            await page.evaluate(() => App.view.setEntries(App.view.entries, { type: 'smart', title: '테스트' }));
            assert.equal(await page.textContent('.vw-counter'), '목록 1 / 3');
            await page.evaluate(() => {
                App.viewer.close();
                App.settingsUI.open('viewer');
            });
            await page.waitForSelector('select[aria-label="다음 파일 대기 시간"]');
            const count = await page.evaluate(() => App.undo.list().length);
            await page.getByRole('switch', { name: '목록 반복', exact: true }).click();
            assert.equal(await page.evaluate(() => App.undo.list().length), count + 1);
            await page.evaluate(() => App.undo.undo());
            assert.equal(await page.evaluate(() => App.settings.get('viewer.autoNextLoop', false)), false);
            await page.selectOption('select[aria-label="다음 파일 대기 시간"]', '5');
            assert.equal(await page.evaluate(() => App.settings.get('viewer.autoNextDelay')), 5);
            await page.selectOption('select[aria-label="계속 보기 확인"]', '10');
            assert.equal(await page.evaluate(() => App.settings.get('viewer.autoNextAsk')), 10);
        },
    },
];
