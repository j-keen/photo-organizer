'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

async function filePage(h, run) {
    const browser = await h.launchBrowser();
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        page.on('dialog', d => { errors.push('native dialog'); d.dismiss(); });
        await page.goto(pathToFileURL(path.join(h.ROOT, h.APP_FILE)).href);
        await page.waitForFunction(() => !!window.App?.viewer && !!App.server);
        await run(page);
        h.assert.deepEqual(errors, []);
    } finally { await browser.close(); }
}

module.exports = [
    {
        name: 'server launch: file card launches then hands off the video',
        async run(h) {
            await filePage(h, async page => {
                await page.evaluate(async () => {
                    App.setState({ workspace: { id: 'launch-test', name: '테스트' }, cwd: '' });
                    const entry = { path: 'launch.avi', name: 'launch.avi', kind: 'file', type: 'video', ext: 'avi', size: 1, mtime: 0 };
                    App.fs.stat = async () => entry;
                    App.view.setEntries([entry], { type: 'folder', path: '' });
                    window.launches = 0;
                    App.server.health = async () => null;
                    App.server.launch = async () => { window.launches++; return true; };
                    App.server.navigate = url => { window.destination = url; };
                    await App.viewer.open('launch.avi');
                });
                await page.getByRole('button', { name: '바로 재생하기', exact: true }).click();
                await page.waitForFunction(() => !!window.destination);
                const data = await page.evaluate(() => ({ launches, destination }));
                h.assert.equal(data.launches, 1);
                const payload = JSON.parse(Buffer.from(data.destination.split('#fi-handoff=')[1], 'base64url'));
                h.assert.equal(payload.open, 'launch.avi');
            });
        },
    },
    {
        name: 'server launch: timeout opens setup and preserves the requested video',
        async run(h) {
            const app = await h.openApp({ seed: { 'launch.avi': { bytes: [0] } } });
            await app.page.evaluate(async () => {
                App.server.health = async () => null;
                App.server.launchLink = () => {};
                const launch = App.server.launch;
                App.server.launch = () => launch({ timeout: 20, interval: 5 });
                await App.viewer.open('launch.avi');
            });
            await app.page.getByRole('button', { name: '바로 재생하기', exact: true }).click();
            await app.page.waitForSelector('.srv-setup');
            h.assert.ok(await app.page.getByRole('button', { name: '지금 켜기', exact: true }).isVisible());
        },
    },
    {
        name: 'server launch: polling uses the injectable link and health hooks',
        async run(h) {
            const app = await h.openApp();
            const result = await app.page.evaluate(async () => {
                let links = 0, probes = 0;
                App.server.launchLink = () => links++;
                App.server.health = async () => ++probes === 3 ? { app: 'fluid-identity' } : null;
                return { ok: await App.server.launch({ interval: 5 }), links, probes };
            });
            h.assert.deepEqual(result, { ok: true, links: 1, probes: 3 });
        },
    },
];
