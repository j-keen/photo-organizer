'use strict';

const SEED = {
    'a.png': { image: { color: '#336699' } },
    'trip/day/b.png': { image: { color: '#663399' } },
};

async function folder(page, path) {
    await page.evaluate((p) => App.nav.go(p), path);
    await page.waitForFunction((p) => App.view.source.type === 'folder' && App.view.source.path === p, path);
    await page.locator('#gallery-scroll').focus();
}

async function esc(page) {
    await page.keyboard.press('Escape');
}

module.exports = [
    {
        name: 'gallery Escape cancels cut, clears filters, then goes up regardless of selection',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await folder(page, 'trip/day');
            await page.evaluate(() => {
                App.select.set(['trip/day/b.png']);
                App.gallery.clipboard.set('cut', ['trip/day/b.png']);
                App.view.setFilter('test', { label: '테스트', test: () => true });
            });
            await esc(page);
            await page.waitForFunction(() => App.gallery.clipboard.mode === null);
            assert.equal(await page.evaluate(() => App.select.count), 1);
            assert.equal(await page.evaluate(() => App.view.filters.size), 1);
            await esc(page);
            await page.waitForFunction(() => App.view.filters.size === 0 && App.view.source.type === 'folder');
            assert.equal(await page.evaluate(() => App.state.cwd), 'trip/day');
            await page.evaluate(() => App.select.set(['trip/day/b.png']));
            assert.equal(await page.evaluate(() => App.select.count), 1);
            await esc(page);
            await page.waitForFunction(() => App.view.source.path === 'trip' && App.select.focus === 'trip/day');
            assert.equal(await page.evaluate(() => App.state.cwd), 'trip');
            await page.waitForSelector('.escape-trail');
            assert.equal(await page.textContent('.escape-trail'), 'day');
            assert.equal(await page.evaluate(() => App.select.paths.has('trip/day')), true);
            await esc(page);
            await page.waitForFunction(() => App.view.source.path === '' && App.select.focus === 'trip');
            assert.equal(await page.evaluate(() => App.state.cwd), '');
        },
    },
    {
        name: 'gallery Escape returns search and chip smart views to the folder',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await folder(page, 'trip');
            await page.evaluate(() => App.topbar.search('b.png'));
            await page.waitForFunction(() => App.view.source.type === 'search');
            await esc(page);
            await page.waitForFunction(() => App.view.source.type === 'folder' && App.view.source.path === 'trip');
            assert.equal(await page.inputValue('#search-input'), '');
            await page.evaluate(() => App.chipsFilter.showUntagged());
            await page.waitForFunction(() => App.view.source.type === 'smart');
            await esc(page);
            await page.waitForFunction(() => App.view.source.type === 'folder' && App.chipsFilter.state.smart === null);
            await page.evaluate(() => App.topbar.setTypeFilter('image'));
            await esc(page);
            await page.waitForFunction(() => App.view.filters.size === 0);
            assert.equal(await page.evaluate(() => App.settings.get('view.type')), 'all');
        },
    },
    {
        name: 'gallery Escape at root clears selection first, then shows a unique notice and opens the workspace command',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await folder(page, '');
            await page.evaluate(() => {
                App.select.set(['a.png'], { focus: 'a.png', anchor: 'a.png' });
                window.__openCalls = 0;
                App.commands.register({ id: 'workspace.open', run: () => { window.__openCalls++; } });
            });
            await esc(page);
            await page.waitForFunction(() => App.select.count === 0 && App.select.focus === null);
            assert.equal(await page.evaluate(() => App.state.cwd), '');
            assert.equal(await page.locator('.toast-action').count(), 0);
            await esc(page);
            await page.waitForSelector('.toast-action:text-is("작업 폴더 바꾸기")');
            await esc(page);
            await page.waitForFunction(() => [...document.querySelectorAll('.toast-action')].filter((el) => el.textContent === '작업 폴더 바꾸기').length === 1);
            await page.getByRole('button', { name: '작업 폴더 바꾸기', exact: true }).click();
            assert.equal(await page.evaluate(() => window.__openCalls), 1);
            await page.locator('#gallery-scroll').focus();
            await esc(page);
            await page.waitForSelector('.toast-action:text-is("작업 폴더 바꾸기")');
            await page.waitForFunction(() => ![...document.querySelectorAll('.toast-action')].some((el) => el.textContent === '작업 폴더 바꾸기'));
        },
    },
    {
        name: 'holding gallery Escape jumps once to root and focuses the first item',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await folder(page, 'trip/day');
            await page.evaluate(() => App.select.clear());
            await page.keyboard.down('Escape');
            await page.waitForFunction(() => App.view.source.path === 'trip');
            await page.evaluate(() => { window.__holdAt = performance.now(); });
            await page.waitForFunction(() => performance.now() - window.__holdAt >= 600);
            await page.keyboard.down('Escape');
            await page.waitForFunction(() => App.view.source.path === '' && App.select.focus === App.view.visible[0]?.path);
            const history = await page.evaluate(() => App.nav.back.length);
            await page.keyboard.down('Escape');
            await page.keyboard.up('Escape');
            assert.equal(await page.evaluate(() => App.nav.back.length), history);
        },
    },
    {
        name: 'gallery Escape setting off clears state without navigating and fields keep Escape',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await folder(page, 'trip/day');
            await page.evaluate(() => {
                App.settings.set('gallery.escapeUp', false);
                App.select.set(['trip/day/b.png']);
            });
            await esc(page);
            await page.waitForFunction(() => App.select.count === 0);
            assert.equal(await page.evaluate(() => App.select.focus), null);
            assert.equal(await page.evaluate(() => App.state.cwd), 'trip/day');
            await page.evaluate(() => App.topbar.setTypeFilter('image'));
            await esc(page);
            await page.waitForFunction(() => App.view.filters.size === 0);
            await esc(page);
            assert.equal(await page.evaluate(() => App.state.cwd), 'trip/day');
            await page.evaluate(() => App.select.set(['trip/day/b.png']));
            await page.locator('#search-input').focus();
            await esc(page);
            assert.equal(await page.evaluate(() => App.select.count), 1);
            assert.equal(await page.evaluate(() => App.state.cwd), 'trip/day');
        },
    },
];
