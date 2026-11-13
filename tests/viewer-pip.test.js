'use strict';

const seed = {
    '01.webm': { video: { seconds: 2 } },
    '02.webm': { video: { seconds: 2 } },
    '03.png': { image: { w: 40, h: 40 } },
};
async function open(page, path = '01.webm') {
    await page.evaluate((path) => {
        App.settings.set('viewer.muted', true);
        App.viewer.open(path, { play: false });
    }, path);
    await page.waitForFunction((path) => App.viewer.player?.path === path && App.viewer.player.metaReady, path);
}

module.exports = [
    {
        name: 'PiP: rejected native request shows a friendly toast without page errors',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await open(page);
            await page.evaluate(() => {
                Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: true });
                HTMLVideoElement.prototype.requestPictureInPicture = async () => {
                    throw new DOMException('User activation required', 'NotAllowedError');
                };
            });
            await page.keyboard.press('Alt+p');
            await page.waitForSelector('.toast:has-text("작은 창을 열지 못했어요")');
            assert.equal(await page.evaluate(() => !!document.pictureInPictureElement), false);
        },
    },
    {
        name: 'PiP: registered command, video control/menu and native toggle or graceful rejection',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await open(page);
            assert.equal(await page.evaluate(() => App.commands.get('viewer.pip').title), '작은 창으로 보기 (PIP)');
            assert.equal(await page.locator('button.vw-pip').getAttribute('data-tip-keys'), 'Alt+P');
            await page.evaluate(() => App.commands.run('viewer.menu'));
            assert.ok(await page.locator('.menu').getByText('작은 창으로 보기 (PIP)', { exact: true }).count());
            await page.keyboard.press('Escape');
            await page.keyboard.press('Alt+p');
            await page.waitForFunction(() => document.pictureInPictureElement || document.querySelector('.toast'));
            if (await page.evaluate(() => !!document.pictureInPictureElement)) {
                assert.equal(await page.evaluate(() => document.pictureInPictureElement === App.viewer.player.video), true);
                await page.keyboard.press('Alt+p');
                await page.waitForFunction(() => !document.pictureInPictureElement);
            } else {
                assert.match(await page.locator('.toast').last().textContent(), /작은 창/);
            }
        },
    },
    {
        name: 'PiP: transfer, media session, resume and close lifecycle with deterministic browser API',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await page.evaluate(() => {
                window.__pipElement = null;
                window.__mediaActions = {};
                Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: true });
                Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, get: () => window.__pipElement });
                HTMLVideoElement.prototype.requestPictureInPicture = async function () {
                    const old = window.__pipElement;
                    window.__pipElement = this;
                    old?.dispatchEvent(new Event('leavepictureinpicture'));
                    this.dispatchEvent(new Event('enterpictureinpicture'));
                };
                document.exitPictureInPicture = async () => {
                    const old = window.__pipElement;
                    window.__pipElement = null;
                    old?.dispatchEvent(new Event('leavepictureinpicture'));
                };
                navigator.mediaSession.setActionHandler = (action, handler) => { window.__mediaActions[action] = handler; };
            });
            await open(page);
            await page.keyboard.press('Alt+p');
            await page.waitForFunction(() => document.pictureInPictureElement === App.viewer.player.video);
            await page.evaluate(() => {
                const p = App.viewer.player;
                Object.defineProperty(p, 'duration', { configurable: true, get: () => 120 });
                Object.defineProperty(p, 'time', { configurable: true, get: () => 30 });
                p.saveResume();
                window.__mediaActions.nexttrack();
            });
            await page.waitForFunction(() => App.viewer.player?.path === '02.webm' && document.pictureInPictureElement === App.viewer.player.video);
            assert.equal(await page.evaluate(() => App.catalog.peek('01.webm').meta.resumeAt), 30);
            await page.evaluate(() => window.__mediaActions.play());
            await page.waitForFunction(() => App.viewer.player.playing);
            await page.evaluate(() => window.__mediaActions.pause());
            await page.waitForFunction(() => !App.viewer.player.playing);
            await page.evaluate(() => window.__mediaActions.previoustrack());
            await page.waitForFunction(() => App.viewer.player?.path === '01.webm' && document.pictureInPictureElement === App.viewer.player.video);
            await page.evaluate(() => {
                App.settings.set('viewer.autoNext', true);
                const p = App.viewer.player;
                Object.defineProperty(p.video, 'ended', { configurable: true, get: () => true });
                p.video.dispatchEvent(new Event('ended'));
            });
            await page.waitForFunction(() => App.viewer.player?.path === '02.webm' && document.pictureInPictureElement === App.viewer.player.video);
            await page.evaluate(() => App.viewer.open('03.png'));
            await page.waitForFunction(() => !document.pictureInPictureElement && !window.__mediaActions.nexttrack);
            await open(page);
            await page.keyboard.press('Alt+p');
            await page.waitForFunction(() => !!document.pictureInPictureElement);
            await page.evaluate(() => App.viewer.close());
            await page.waitForFunction(() => !document.pictureInPictureElement);
            assert.equal(await page.evaluate(() => window.__mediaActions.play), null);
        },
    },
    {
        name: 'PiP: unsupported browser disables command and explains shortcut and control',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            await open(page);
            await page.evaluate(() => Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: false }));
            assert.equal(await page.evaluate(() => App.commands.isEnabled('viewer.pip')), false);
            await page.keyboard.press('Alt+p');
            await page.waitForSelector('.toast:has-text("작은 창 보기를 지원하지")');
            await page.click('button.vw-pip', { force: true });
            assert.ok(await page.locator('.toast:has-text("Chrome이나 Edge")').count());
        },
    },
];
