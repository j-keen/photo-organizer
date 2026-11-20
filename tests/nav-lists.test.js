'use strict';

const seed = {
    'a.png': { image: { color: '#336699' } },
    'b.png': { image: { color: '#663399' } },
    'sub/c.png': { image: {} },
};

async function nameDialog(page, name) {
    await page.waitForSelector('.dialog input');
    await page.locator('.dialog input').fill(name);
    await page.locator('.dialog input').press('Enter');
    await page.waitForFunction(() => !document.querySelector('.dialog input'));
}

module.exports = [
    {
        name: 'team3: nav-lists save visible files in order, reopen, persist and expose palette items',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            const before = await page.evaluate(() => {
                App.view.setSort('name', 'desc');
                App.commands.run('nav.listSave');
                return App.undo.list().length;
            });
            await nameDialog(page, '골라둔 사진');
            await page.waitForFunction(() => App.navLists.list().length === 1);
            const saved = await page.evaluate(() => App.navLists.list()[0]);
            assert.deepEqual(saved.paths, ['b.png', 'a.png']);
            assert.equal(await page.evaluate(() => App.undo.list().length), before + 1);
            assert.deepEqual(await page.evaluate(() => App.fs.readJSON('.fluid-organizer/lists.json')), { version: 1, items: [saved] });
            await page.evaluate(() => {
                App.view.setSort('name', 'asc');
                App.view.setFilter('hide-a', { test: (entry) => entry.path !== 'a.png' });
            });
            await page.getByRole('button', { name: '목록: 골라둔 사진', exact: true }).click();
            await page.waitForFunction(() => App.view.source.smart?.startsWith('list:'));
            assert.deepEqual(await page.evaluate(() => App.view.visible.map((entry) => entry.path)), ['b.png', 'a.png']);
            assert.equal(await page.evaluate(() => App.view.filters.size), 0);
            await page.evaluate(() => App.palette.open({ scope: 'commands', query: '목록: 골라둔 사진' }));
            await page.waitForSelector('.pal-item');
            assert.ok((await page.locator('.pal-item').allTextContents()).some((text) => text.includes('목록: 골라둔 사진')));
            await page.evaluate(() => App.palette.close());
            await page.evaluate(() => App.nav.go('sub'));
            assert.deepEqual(await page.evaluate(() => App.view.sort), { key: 'name', dir: 'asc' });
            await page.evaluate(() => App.workspace.openBackend(App.fs.backend, { restore: false }));
            await page.evaluate(() => App.navLists.whenReady());
            assert.deepEqual(await page.evaluate(() => App.navLists.list()[0]), saved);
        },
    },
    {
        name: 'team3: nav-lists rename/delete/save each undo once and preserve media',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed });
            const before = await page.evaluate(() => {
                App.commands.run('nav.listSave');
                return App.undo.list().length;
            });
            await nameDialog(page, '처음 이름');
            await page.waitForFunction(() => App.navLists.list().length === 1);
            assert.equal(await page.evaluate(() => App.undo.list().length), before + 1);
            await page.evaluate(() => { App.commands.run('nav.listRename', { id: App.navLists.list()[0].id }); });
            await nameDialog(page, '바꾼 이름');
            await page.waitForFunction(() => App.navLists.list()[0]?.name === '바꾼 이름');
            assert.equal(await page.evaluate(() => App.undo.list().length), before + 2);
            await page.evaluate(() => App.undo.undo());
            assert.equal(await page.evaluate(() => App.navLists.list()[0].name), '처음 이름');
            await page.evaluate(() => App.undo.redo());
            assert.equal(await page.evaluate(() => App.navLists.list()[0].name), '바꾼 이름');
            await page.evaluate(() => { App.commands.run('nav.listDelete', { id: App.navLists.list()[0].id }); });
            await page.getByRole('button', { name: '목록 지우기', exact: true }).click();
            await page.waitForFunction(() => App.navLists.list().length === 0);
            assert.equal(await page.evaluate(() => App.undo.list().length), before + 3);
            assert.equal(await page.evaluate(() => App.fs.exists('a.png')), true);
            assert.equal(await page.evaluate(() => App.fs.exists('b.png')), true);
            await page.evaluate(() => App.undo.undo());
            assert.equal(await page.evaluate(() => App.navLists.list()[0].name), '바꾼 이름');
            await page.evaluate(() => App.undo.undo());
            await page.evaluate(() => App.undo.undo());
            assert.deepEqual(await page.evaluate(() => App.navLists.list()), []);
            await page.evaluate(() => App.undo.redo());
            assert.equal(await page.evaluate(() => App.navLists.list()[0].name), '처음 이름');
            assert.deepEqual(await page.evaluate(() => App.fs.readJSON('.fluid-organizer/lists.json').then((data) => data.items)), await page.evaluate(() => App.navLists.list()));
        },
    },
    {
        name: 'team3: nav-lists missing entries are skipped and counted; search does not replace the opened list',
        async run({ openApp, assert }) {
            const data = { version: 1, items: [{ id: 'saved', name: '이전 목록', createdAt: 1, paths: ['b.png', 'gone.png', 'a.png'] }] };
            const { page } = await openApp({ seed: { ...seed, '.fluid-organizer/lists.json': JSON.stringify(data) } });
            await page.evaluate(() => App.topbar.search('a'));
            await page.evaluate(() => App.navLists.open('saved'));
            assert.deepEqual(await page.evaluate(() => App.view.visible.map((entry) => entry.path)), ['b.png', 'a.png']);
            assert.equal(await page.inputValue('#search-input'), '');
            assert.ok((await page.locator('.toast').allTextContents()).some((text) => text.includes('파일 1개를 건너뛰었어요')));
            await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            assert.equal(await page.evaluate(() => App.view.source.smart), 'list:saved');
        },
    },
];
