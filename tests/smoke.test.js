// Core smoke tests: workspace, navigation, selection, rename, trash/undo, catalog, search, viewer.
'use strict';

const SEED = {
    'a-photo.png': { image: { label: 'A', color: '#b33' } },
    'b-photo.jpg': { image: { label: 'B', mime: 'image/jpeg', color: '#3b3' } },
    'c-clip.webm': { video: { seconds: 1 } },
    'notes.txt': 'not media',
    'trip/beach.png': { image: { label: 'Beach', color: '#36c' } },
    'trip/2024/sunset.png': { image: { label: 'Sun' } },
    'empty/': null,
};

module.exports = [
    {
        name: 'welcome screen renders without a workspace',
        async run({ openApp, assert }) {
            const { page } = await openApp({ open: false });
            await page.waitForSelector('#welcome:not([hidden]) .welcome-card');
            assert.ok(await page.isVisible('text=작업 폴더 열기'));
        },
    },
    {
        name: 'opening a workspace lists folders first, hides non-media, builds the index',
        async run({ openApp, assert, cardNames }) {
            const { page } = await openApp({ seed: SEED });
            assert.deepEqual(await cardNames(page), ['empty', 'trip', 'a-photo.png', 'b-photo.jpg', 'c-clip.webm']);
            assert.equal(await page.evaluate(() => App.view.source.hiddenCount), 1);
            await page.waitForFunction(() => App.index.ready);
            assert.equal(await page.evaluate(() => App.index.items.length), 5);
            assert.ok(await page.evaluate(() => window.__opfs.exists('.fluid-organizer/workspace.json')));
            await page.waitForSelector('.card.has-thumb', { timeout: 10000 });
        },
    },
    {
        name: 'navigate into folders, up, back and forward',
        async run({ openApp, assert, cardNames, card }) {
            const { page } = await openApp({ seed: SEED });
            await (await card(page, 'trip')).dblclick();
            await page.waitForFunction(() => App.state.cwd === 'trip');
            assert.deepEqual(await cardNames(page), ['2024', 'beach.png']);
            await page.keyboard.press('Alt+ArrowUp');
            await page.waitForFunction(() => App.state.cwd === '');
            // returning up focuses the folder we came from
            await page.waitForFunction(() => App.select.focus === 'trip');
            await page.keyboard.press('Alt+ArrowLeft');
            await page.waitForFunction(() => App.state.cwd === 'trip');
            await page.keyboard.press('Alt+ArrowRight');
            await page.waitForFunction(() => App.state.cwd === '');
            await page.click('.tree-row[data-path="trip"] .tree-name');
            await page.waitForFunction(() => document.querySelector('.crumb.current')?.textContent === 'trip');
            assert.ok(await page.isVisible('.tree-row.current[data-path="trip"]'));
        },
    },
    {
        name: 'selection with click, ctrl, shift and keyboard',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            await (await card(page, 'a-photo.png')).click();
            await (await card(page, 'c-clip.webm')).click({ modifiers: ['Shift'] });
            assert.deepEqual(await page.evaluate(() => App.select.list()), ['a-photo.png', 'b-photo.jpg', 'c-clip.webm']);
            await (await card(page, 'b-photo.jpg')).click({ modifiers: ['Control'] });
            assert.deepEqual(await page.evaluate(() => App.select.list()), ['a-photo.png', 'c-clip.webm']);
            await page.keyboard.press('Escape');
            assert.equal(await page.evaluate(() => App.select.count), 0);
            await page.keyboard.press('Control+a');
            assert.equal(await page.evaluate(() => App.select.count), 5);
        },
    },
    {
        name: 'rename with F2 keeps catalog data, undo restores the name',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            await page.evaluate(() => App.catalog.update('a-photo.png', { rating: 4, memo: 'hello' }));
            await (await card(page, 'a-photo.png')).click();
            await page.keyboard.press('F2');
            await page.waitForSelector('.dialog .input');
            await page.fill('.dialog .input', 'renamed.png');
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => App.view.get('renamed.png'));
            assert.ok(await page.evaluate(() => window.__opfs.exists('renamed.png')));
            assert.ok(!(await page.evaluate(() => window.__opfs.exists('a-photo.png'))));
            assert.equal(await page.evaluate(() => App.catalog.get('renamed.png').rating), 4);
            assert.deepEqual(await page.evaluate(() => App.select.list()), ['renamed.png'], 'renamed item stays selected');
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => App.view.get('a-photo.png'));
            assert.equal(await page.evaluate(() => App.catalog.get('a-photo.png').memo), 'hello');
        },
    },
    {
        name: 'delete moves to the app trash and undo restores',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            await page.evaluate(() => App.catalog.update('b-photo.jpg', { rating: 5 }));
            await (await card(page, 'b-photo.jpg')).click();
            await page.keyboard.press('Delete');
            await page.waitForFunction(() => !App.view.get('b-photo.jpg'));
            assert.ok(!(await page.evaluate(() => window.__opfs.exists('b-photo.jpg'))));
            const trash = await page.evaluate(() => App.fs.listTrash());
            assert.equal(trash.length, 1);
            assert.equal(trash[0].originalPath, 'b-photo.jpg');
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => App.view.get('b-photo.jpg'));
            assert.ok(await page.evaluate(() => window.__opfs.exists('b-photo.jpg')));
            assert.equal(await page.evaluate(() => App.catalog.get('b-photo.jpg').rating), 5);
            assert.equal((await page.evaluate(() => App.fs.listTrash())).length, 0);
        },
    },
    {
        name: 'new folder, drag-and-drop move, and the catalog follows',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            await page.evaluate(() => App.catalog.update('a-photo.png', { memo: 'moved memo' }));
            await page.keyboard.press('Control+Shift+N');
            await page.waitForSelector('.dialog .input');
            await page.fill('.dialog .input', 'picked');
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => App.view.get('picked'));
            await page.evaluate(() => App.fs.move(['a-photo.png'], 'picked'));
            await page.waitForFunction(() => !App.view.get('a-photo.png'));
            assert.ok(await page.evaluate(() => window.__opfs.exists('picked/a-photo.png')));
            assert.equal(await page.evaluate(() => App.catalog.get('picked/a-photo.png').memo), 'moved memo');
            await page.evaluate(() => App.catalog.flush());
            const saved = JSON.parse(await page.evaluate(() => window.__opfs.read('.fluid-organizer/catalog.json')));
            assert.equal(saved.items['picked/a-photo.png'].memo, 'moved memo');
        },
    },
    {
        name: 'search across the workspace and type filter',
        async run({ openApp, assert, cardNames }) {
            const { page } = await openApp({ seed: SEED });
            await page.waitForFunction(() => App.index.ready);
            await page.fill('#search-input', 'sunset');
            await page.waitForFunction(() => App.view.source.type === 'search' && App.view.visible.length === 1);
            assert.deepEqual(await cardNames(page), ['sunset.png']);
            await page.press('#search-input', 'Escape');
            await page.waitForFunction(() => App.view.source.type === 'folder');
            await page.keyboard.press('Alt+3');
            assert.deepEqual(await cardNames(page), ['empty', 'trip', 'c-clip.webm']);
            await page.keyboard.press('Alt+1');
        },
    },
    {
        name: 'viewer opens with Enter, steps with arrows, closes with Esc',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            await (await card(page, 'a-photo.png')).click();
            await page.keyboard.press('Enter');
            await page.waitForSelector('#viewer:not([hidden]) img.vw-media');
            assert.equal(await page.textContent('.vw-title'), 'a-photo.png');
            await page.keyboard.press('ArrowRight');
            await page.waitForFunction(() => document.querySelector('.vw-title').textContent === 'b-photo.jpg');
            await page.keyboard.press('ArrowRight');
            await page.waitForSelector('#viewer video.vw-media');
            await page.keyboard.press('Escape');
            await page.waitForSelector('#viewer', { state: 'hidden' });
            assert.deepEqual(await page.evaluate(() => App.select.list()), ['c-clip.webm']);
        },
    },
];
