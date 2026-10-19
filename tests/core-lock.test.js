// Core round 2: one writer per workspace (js/core/core-lock.js).
'use strict';

const SEED = { 'a.png': { image: { label: 'A' } }, 'sub/b.png': { image: { label: 'B' } } };

// A second window of the same browser profile (same origin → same OPFS + BroadcastChannel) on the same workspace
async function secondWindow(app) {
    const page = await app.page.context().newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
        if (m.type() === 'error' && !/pretendard|favicon|net::ERR_/i.test(m.text())) errors.push(`console: ${m.text()}`);
    });
    page.on('dialog', (d) => {
        errors.push(`native dialog: ${d.message()}`);
        d.dismiss();
    });
    await page.addInitScript(() => {
        window.__TEST__ = true;
        window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('ws');
    });
    await page.goto(app.page.url());
    await page.waitForFunction(() => window.App && document.querySelector('#topbar').children.length > 0);
    await page.evaluate(() => App.workspace.pick());
    await page.waitForFunction(() => App.state.cwd === '' && App.view.source.type === 'folder');
    return { page, errors };
}

module.exports = [
    {
        name: 'core lock: a second window becomes read-only, refuses writes, and can take over',
        async run({ openApp, assert }) {
            const app = await openApp({ seed: SEED });
            const a = app.page;
            await a.waitForFunction(() => App.lock.state === 'owner');
            const lockFile = JSON.parse(await a.evaluate(() => window.__opfs.read('.fluid-organizer/lock.json')));
            assert.equal(lockFile.tabId, await a.evaluate(() => App.lock.tabId));

            const { page: b, errors } = await secondWindow(app);
            await b.waitForFunction(() => App.lock.state === 'readonly');
            assert.equal(await b.evaluate(() => App.lock.canWrite()), false);
            assert.ok(await b.locator('.core-lock').isVisible());
            assert.match(await b.locator('.core-lock').innerText(), /다른 창에서 열려 있어요/);
            // Writes are refused (nothing touches the disk) and the banner nudges
            const code = await b.evaluate(() => App.fs.mkdir('', '새 폴더').then(() => null, (e) => e.code));
            assert.equal(code, 'EREADONLY');
            assert.equal(await a.evaluate(() => window.__opfs.exists('새 폴더')), false);
            assert.equal(await b.evaluate(() => App.commands.isEnabled('lock.takeOver')), true);

            // The first window keeps working (and its catalog edits are saved)
            await a.evaluate(() => App.fs.mkdir('', 'from-a'));
            assert.ok(await a.evaluate(() => window.__opfs.exists('from-a')));
            await a.evaluate(async () => {
                App.catalog.update('a.png', { rating: 4 });
                await App.catalog.flush();
            });
            // An edit in the read-only window is flagged and never reaches the disk
            await b.evaluate(() => App.catalog.update('a.png', { rating: 1 }));
            await b.waitForFunction(() => [...document.querySelectorAll('#toasts .toast-msg')].some((t) => t.textContent.includes('여기서 이어서 하기')));
            await b.evaluate(() => App.catalog.flush());
            assert.equal(JSON.parse(await a.evaluate(() => window.__opfs.read('.fluid-organizer/catalog.json'))).items['a.png'].rating, 4);

            // Take over in the second window: the first steps back right away (same origin → BroadcastChannel)
            await b.locator('.core-lock-btn').click();
            await b.waitForFunction(() => App.lock.state === 'owner' && App.view.source.type === 'folder');
            await a.waitForFunction(() => App.lock.state === 'readonly', null, { timeout: 8000 });
            assert.equal(await b.evaluate(() => App.lock.canWrite()), true);
            // The second window re-read the workspace: it sees what the first one made, its stale edit is gone
            await b.waitForFunction(() => App.view.indexOf('from-a') >= 0);
            assert.equal(await b.evaluate(() => App.catalog.get('a.png').rating), 4);
            await b.evaluate(() => App.catalog.flush());
            assert.equal(JSON.parse(await a.evaluate(() => window.__opfs.read('.fluid-organizer/catalog.json'))).items['a.png'].rating, 4);
            await b.evaluate(() => App.fs.mkdir('', 'from-b'));
            assert.ok(await a.evaluate(() => window.__opfs.exists('from-b')));
            assert.equal(errors.length, 0, errors.join('\n'));
        },
    },
    {
        name: 'core lock: closing the writing window lets the read-only one continue; a reload keeps ownership',
        async run({ openApp, assert, waitIdle }) {
            const app = await openApp({ seed: SEED });
            const a = app.page;
            await a.waitForFunction(() => App.lock.state === 'owner');
            // Reloading the owner tab keeps its ownership (tab id in sessionStorage)
            await a.reload();
            await a.waitForFunction(() => window.App && document.querySelector('#topbar').children.length > 0);
            await a.evaluate(() => window.__useExistingWorkspace());
            await a.evaluate(() => App.workspace.pick());
            await a.waitForFunction(() => App.lock.state === 'owner');
            await waitIdle(a);

            const { page: b, errors } = await secondWindow(app);
            await b.waitForFunction(() => App.lock.state === 'readonly');
            await a.close({ runBeforeUnload: true });
            // 'released' over BroadcastChannel (or the 16 s staleness) hands over
            await b.waitForFunction(() => App.lock.state === 'owner', null, { timeout: 25000 });
            assert.equal(await b.evaluate(() => App.lock.canWrite()), true);
            assert.equal(await b.locator('.core-lock').isVisible(), false);
            assert.equal(errors.length, 0, errors.join('\n'));
        },
    },
];
