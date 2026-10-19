// Organize tools: trash panel + auto-purge, batch rename, move/copy-to picker, conflict sheet, unwrap,
// organize by date / by chip, empty-folder cleanup, gallery context menu.
'use strict';

/** Poll an (async) page function until it returns truthy. */
async function until(page, fn, arg, { timeout = 15000, message } = {}) {
    const t0 = Date.now();
    let last;
    for (;;) {
        last = await page.evaluate(fn, arg);
        if (last) return last;
        if (Date.now() - t0 > timeout) throw new Error(`timed out: ${message || fn.toString().slice(0, 120)}`);
        await page.waitForTimeout(60);
    }
}

const exists = (page, p) => page.evaluate((x) => window.__opfs.exists(x), p);
const sizeOf = (page, p) => page.evaluate(async (x) => (await (await window.__opfs.handleFor(x)).getFile()).size, p);
const trashList = (page) => page.evaluate(() => App.fs.listTrash().then((l) => l.map((i) => i.originalPath).sort()));
const select = (page, paths) => page.evaluate((ps) => App.select.set(ps), paths);

async function reopen(page, waitIdle) {
    await page.evaluate(() => App.catalog.flush());
    await page.reload();
    await page.waitForFunction(() => window.App && document.querySelector('#topbar').children.length > 0);
    await page.evaluate(() => window.__useExistingWorkspace());
    await page.evaluate(() => App.workspace.pick());
    await page.waitForFunction(() => App.state.cwd === '' && App.view.source.type === 'folder');
    await waitIdle(page);
}

module.exports = [
    {
        name: 'trash panel restores, deletes for good and empties the trash',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: { 'a.png': { image: { label: 'A' } }, 'b.png': { image: { label: 'B' } }, 'trip/c.png': { image: { label: 'C' } }, 'keep.png': { image: {} } } });
            await page.evaluate(() => App.catalog.update('b.png', { rating: 4 }));
            await page.evaluate(() => App.fs.trash(['a.png', 'b.png', 'trip'], { silent: true }));
            await page.waitForFunction(() => document.querySelector('.org-sb-trash .org-sb-count')?.textContent === '3');

            await page.keyboard.press('Control+Shift+Backspace');
            await page.waitForSelector('.org-trash .org-trash-row');
            assert.equal(await page.locator('.org-trash-row').count(), 3);
            assert.match(await page.textContent('.org-trash .org-head-sub'), /3개 항목/);

            // Search, pick with the keyboard, restore with Enter
            await page.fill('.org-trash-search input', 'b.png');
            await page.waitForFunction(() => document.querySelectorAll('.org-trash-row').length === 1);
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('Enter');
            await until(page, () => window.__opfs.exists('b.png'), null, { message: 'b.png restored' });
            assert.equal(await page.evaluate(() => App.catalog.get('b.png').rating), 4, 'catalog data comes back with the file');
            await page.waitForFunction(() => document.querySelectorAll('.org-trash-row').length === 0);

            // Delete one item for good (inline confirmation sheet, not a native dialog)
            await page.fill('.org-trash-search input', '');
            await page.waitForFunction(() => document.querySelectorAll('.org-trash-row').length === 2);
            await page.click('.org-trash-row:has-text("a.png") .org-rowcheck');
            await page.click('.org-trash .org-foot .btn.danger');
            await page.waitForSelector('.org-sheet');
            await page.click('.org-sheet .btn.danger');
            await until(page, () => App.fs.listTrash().then((l) => l.length === 1), null, { message: 'one item purged' });
            assert.deepEqual(await trashList(page), ['trip']);

            // Empty everything
            await page.click('.org-trash .org-foot .btn.org-danger-text');
            await page.waitForSelector('.org-sheet');
            await page.click('.org-sheet .btn.danger');
            await page.waitForSelector('.org-trash .org-empty-state h4');
            assert.equal(await page.textContent('.org-trash .org-empty-state h4'), '휴지통이 비어 있어요');
            assert.ok(!(await exists(page, 'trip')));

            // Restoring was one undo entry
            await page.keyboard.press('Escape');
            await page.waitForSelector('.org-trash', { state: 'detached' });
            await page.keyboard.press('Control+z');
            await until(page, () => App.fs.listTrash().then((l) => l.length === 1), null, { message: 'undo re-trashes b.png' });
            assert.deepEqual(await trashList(page), ['b.png']);
            assert.ok(!(await exists(page, 'b.png')));
            await waitIdle(page);
        },
    },
    {
        name: 'old trash items are purged automatically when the workspace opens',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: { 'a.png': { image: {} }, 'b.png': { image: {} } } });
            await page.evaluate(() => App.fs.trash(['a.png', 'b.png'], { silent: true }));
            await page.evaluate(async () => {
                const m = await App.fs.readTrashManifest();
                m.items.find((i) => i.originalPath === 'a.png').deletedAt = Date.now() - 40 * 86400000;
                await App.fs.writeJSON('.fluid-organizer/trash/manifest.json', m);
            });
            await reopen(page, waitIdle);
            await until(page, () => App.fs.listTrash().then((l) => l.length === 1), null, { message: 'old item purged' });
            assert.deepEqual(await trashList(page), ['b.png']);
            await page.waitForSelector('.toast:has-text("30일이 지난 항목 1개")');

            // Retention 0 = keep forever
            await page.evaluate(async () => {
                App.settings.set('trash.retentionDays', 0);
                const m = await App.fs.readTrashManifest();
                m.items[0].deletedAt = Date.now() - 400 * 86400000;
                await App.fs.writeJSON('.fluid-organizer/trash/manifest.json', m);
            });
            await reopen(page, waitIdle);
            await page.waitForTimeout(1600);
            assert.deepEqual(await trashList(page), ['b.png']);
        },
    },
    {
        name: 'batch rename: pattern tokens, live preview, one undo for the whole batch',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: { 'IMG_1.png': { image: {} }, 'IMG_2.png': { image: {} }, 'IMG_3.PNG': { image: {} }, 'keep.png': { image: {} } } });
            await page.evaluate(() => App.catalog.update('IMG_2.png', { memo: 'second' }));
            await select(page, ['IMG_1.png', 'IMG_2.png', 'IMG_3.PNG']);
            await page.keyboard.press('Control+Shift+R');
            await page.waitForSelector('.org-rename .org-rn-row');
            await page.fill('.org-rename .org-pattern-row input', 'trip_{n:3}');
            await page.click('.org-rename .seg button:has-text(".jpg")'); // lower-case extensions
            await page.waitForFunction(() => document.querySelector('.org-rename .org-foot .btn.primary')?.textContent.includes('3개'));
            const preview = await page.$$eval('.org-rename .org-rn-to', (els) => els.map((e) => e.textContent));
            assert.deepEqual(preview, ['trip_001.png', 'trip_002.png', 'trip_003.png']);
            await page.focus('.org-rename .org-pattern-row input');
            await page.keyboard.press('Enter');
            await until(page, async () => (await window.__opfs.exists('trip_003.png')) && !(await window.__opfs.exists('IMG_1.png')), null, { message: 'renamed' });
            await waitIdle(page);
            assert.equal(await page.evaluate(() => App.catalog.get('trip_002.png').memo), 'second');
            assert.match(await page.evaluate(() => App.undo.peek().label), /이름 일괄 변경/);

            await page.keyboard.press('Control+z');
            await until(page, async () => (await window.__opfs.exists('IMG_3.PNG')) && !(await window.__opfs.exists('trip_001.png')), null, { message: 'one undo restores all names' });
            assert.ok(await exists(page, 'IMG_1.png'));
            assert.ok(await exists(page, 'IMG_2.png'));
            await page.keyboard.press('Control+Shift+Z');
            await until(page, () => window.__opfs.exists('trip_002.png'), null, { message: 'redo' });
            await waitIdle(page);
        },
    },
    {
        name: 'batch rename: F2 on a multi-selection, conflicts block until numbered',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: { 'a.png': { image: {} }, 'b.png': { image: {} }, 'c.png': { image: {} }, 'same.png': { image: {} } } });
            await select(page, ['a.png', 'b.png', 'c.png']);
            await page.keyboard.press('F2');
            await page.waitForSelector('.org-rename .org-rn-row');
            await page.fill('.org-rename .org-pattern-row input', 'same');
            await page.waitForFunction(() => document.querySelectorAll('.org-rename .org-rn-row.bad').length === 3);
            assert.ok(await page.isDisabled('.org-rename .org-foot .btn.primary'), 'apply is blocked while names clash');
            await page.click('.org-rename label:has-text("겹치면 번호 붙이기")');
            await page.waitForFunction(() => !document.querySelector('.org-rename .org-foot .btn.primary').disabled);
            await page.click('.org-rename .org-foot .btn.primary');
            await until(page, () => window.__opfs.exists('same (4).png'), null, { message: 'numbered names' });
            assert.ok(await exists(page, 'same (2).png'));
            assert.ok(await exists(page, 'same (3).png'));
            assert.ok(await exists(page, 'same.png'), 'the existing file is untouched');
            await waitIdle(page);

            // A single selection keeps the classic F2 prompt
            await select(page, ['same.png']);
            await page.keyboard.press('F2');
            await page.waitForSelector('.dialog .input');
            assert.equal(await page.locator('.org-rename').count(), 0);
            await page.keyboard.press('Escape');
        },
    },
    {
        name: 'batch rename core: tokens, regex replace, case and two-phase swaps',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'trip/x.png': { bytes: [1, 2, 3] }, 'trip/y.png': { bytes: [4, 5, 6, 7] }, 'trip/IMG_0042.JPG': { image: {} } } });
            await page.evaluate(() => App.nav.go('trip'));
            await page.waitForFunction(() => App.state.cwd === 'trip' && App.view.visible.length === 3);
            const names = await page.evaluate(() => {
                const es = App.view.visible.slice().sort((a, b) => a.name.localeCompare(b.name));
                const run = (opts) => App.organize.computeRenames(es, opts).rows.map((r) => r.to);
                return {
                    folder: run({ pattern: '{folder}-{n:2}', start: 7, step: 2 }),
                    regex: run({ pattern: '{name}', find: '^IMG_(\\d+)$', replace: 'photo-$1', regex: true, extCase: 'lower' }),
                    upper: run({ pattern: '{name}.{ext}', caseMode: 'upper' }),
                    title: run({ pattern: 'my {name} shot', caseMode: 'title' }),
                };
            });
            assert.deepEqual(names.folder, ['trip-07.JPG', 'trip-09.png', 'trip-11.png']);
            assert.deepEqual(names.regex, ['photo-0042.jpg', 'x.png', 'y.png']);
            assert.deepEqual(names.upper, ['IMG_0042.JPG', 'X.PNG', 'Y.PNG']);
            assert.deepEqual(names.title, ['My Img_0042 Shot.JPG', 'My X Shot.png', 'My Y Shot.png']);

            // Swap two names in one go (needs temporary names) and undo it in one step
            await page.evaluate(() => App.organize.commitRenames([{ from: 'trip/x.png', toName: 'y.png' }, { from: 'trip/y.png', toName: 'x.png' }], 'swap'));
            assert.equal(await sizeOf(page, 'trip/x.png'), 4);
            assert.equal(await sizeOf(page, 'trip/y.png'), 3);
            await page.evaluate(() => App.undo.undo());
            assert.equal(await sizeOf(page, 'trip/x.png'), 3);
            assert.equal(await sizeOf(page, 'trip/y.png'), 4);
        },
    },
    {
        name: 'move to: searchable picker, recent destination, one undo',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: { 'a.png': { image: {} }, 'b.png': { image: {} }, 'trip/x.png': { image: {} }, 'trip/2024/y.png': { image: {} }, 'work/z.png': { image: {} } } });
            await page.waitForFunction(() => App.index.ready);
            await select(page, ['a.png']);
            await page.keyboard.press('Control+Shift+M');
            await page.waitForSelector('.org-picker .org-picker-row');
            await page.keyboard.type('2024');
            await page.waitForFunction(() => document.querySelector('.org-picker-row.active')?.title === 'trip › 2024');
            await page.keyboard.press('Enter');
            await until(page, () => window.__opfs.exists('trip/2024/a.png'), null, { message: 'moved' });
            await page.waitForSelector('.toast:has-text("2024 폴더로")');
            await waitIdle(page);

            // Next time the last destination is pre-selected: Ctrl+Shift+M, Enter
            await select(page, ['b.png']);
            await page.keyboard.press('Control+Shift+M');
            await page.waitForSelector('.org-picker .org-picker-head');
            await page.waitForFunction(() => document.querySelector('.org-picker-row.active')?.title === 'trip › 2024');
            await page.keyboard.press('Enter');
            await until(page, () => window.__opfs.exists('trip/2024/b.png'), null, { message: 'moved again' });
            await waitIdle(page);

            await page.keyboard.press('Control+z');
            await until(page, () => window.__opfs.exists('b.png'), null, { message: 'undo move' });
            assert.ok(!(await exists(page, 'trip/2024/b.png')));

            // Folders can't go inside themselves; the current folder is marked
            await select(page, ['trip']);
            await page.keyboard.press('Control+Shift+M');
            await page.waitForSelector('.org-picker .org-picker-row');
            assert.equal(await page.locator('.org-picker-row.disabled').count(), 3, 'root (current folder), trip and trip/2024 are disabled');
            await page.keyboard.press('Escape');
            await page.waitForSelector('.org-picker', { state: 'detached' });
        },
    },
    {
        name: 'copy to: create a folder inline in the picker',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: { 'a.png': { image: {} }, 'trip/x.png': { image: {} } } });
            await select(page, ['a.png']);
            await page.keyboard.press('Control+Shift+C');
            await page.waitForSelector('.org-picker .org-picker-row');
            await page.click('.org-picker .org-foot .btn:has-text("새 폴더")');
            await page.waitForSelector('.org-nf:not([hidden]) input');
            await page.fill('.org-nf input', 'copies');
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => document.querySelector('.org-picker-row.active')?.title === 'copies');
            assert.ok(await page.isVisible('.org-picker'), 'Enter in the new-folder field must not close the picker');
            await page.keyboard.press('Enter');
            await until(page, () => window.__opfs.exists('copies/a.png'), null, { message: 'copied' });
            assert.ok(await exists(page, 'a.png'), 'the original stays');
            await waitIdle(page);
        },
    },
    {
        name: 'one Ctrl+Z undoes "move into a folder made in the picker" (files back, folder gone)',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: { 'a.png': { image: {} }, 'b.png': { image: {} }, 'trip/x.png': { image: {} } } });
            await select(page, ['a.png', 'b.png']);
            await page.keyboard.press('Control+Shift+M');
            await page.waitForSelector('.org-picker .org-picker-row');
            await page.keyboard.press('Control+Alt+N');
            await page.waitForSelector('.org-nf:not([hidden]) input');
            await page.fill('.org-nf input', 'picked');
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => document.querySelector('.org-picker-row.active')?.title === 'picked');
            await page.keyboard.press('Enter');
            await until(page, () => window.__opfs.exists('picked/b.png'), null, { message: 'moved into new folder' });
            await waitIdle(page);
            assert.match(await page.evaluate(() => App.undo.peek().label), /picked 폴더로 이동/);
            await page.keyboard.press('Control+z');
            await until(page, async () => (await window.__opfs.exists('a.png')) && !(await window.__opfs.exists('picked')), null, { message: 'one undo' });
            assert.ok(await exists(page, 'b.png'));
            assert.ok(!(await page.evaluate(() => App.undo.canUndo())), 'nothing else left on the undo stack');
            await page.keyboard.press('Control+Shift+Z');
            await until(page, () => window.__opfs.exists('picked/a.png'), null, { message: 'redo recreates the folder' });
            await waitIdle(page);

            // A folder made in the picker and then cancelled is still one undoable step
            await select(page, ['trip/x.png'].length ? ['trip'] : []);
            await page.keyboard.press('Control+Shift+M');
            await page.waitForSelector('.org-picker .org-picker-row');
            await page.keyboard.press('Control+Alt+N');
            await page.waitForSelector('.org-nf:not([hidden]) input');
            await page.fill('.org-nf input', 'later');
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => document.querySelector('.org-picker-row.active')?.title === 'later');
            await page.keyboard.press('Escape');
            await page.waitForSelector('.org-picker', { state: 'detached' });
            assert.ok(await exists(page, 'later'));
            assert.equal(await page.evaluate(() => App.undo.peek().label), '새 폴더 "later"');
            await page.keyboard.press('Control+z');
            await until(page, async () => !(await window.__opfs.exists('later')), null, { message: 'undo the cancelled folder' });
        },
    },
    {
        name: 'undoing a copy moves the copies to the app trash (never a permanent delete); redo brings them back',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: { 'a.png': { image: {} }, 'b.png': { image: {} }, 'out/': null } });
            await page.evaluate(() => App.catalog.update('a.png', { rating: 5 }, { undoable: false }));
            await page.evaluate(() => App.organize.copyTo(['a.png', 'b.png'], 'out'));
            await until(page, () => window.__opfs.exists('out/b.png'), null, { message: 'copied' });
            await waitIdle(page);
            assert.equal(await page.evaluate(() => App.catalog.get('out/a.png').rating), 5);
            await page.evaluate(() => App.undo.undo());
            assert.ok(!(await exists(page, 'out/a.png')));
            assert.deepEqual(await trashList(page), ['out/a.png', 'out/b.png'], 'copies wait in the trash');
            assert.ok(await exists(page, 'a.png'), 'originals untouched');
            await page.evaluate(() => App.undo.redo());
            assert.ok(await exists(page, 'out/a.png'));
            assert.deepEqual(await trashList(page), []);
            assert.equal(await page.evaluate(() => App.catalog.get('out/a.png').rating), 5, 'metadata comes back with the copy');
        },
    },
    {
        name: 'empty-trash command asks inside the trash panel, and Ctrl+Z works while the panel is open',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: { 'a.png': { image: {} }, 'b.png': { image: {} } } });
            await page.evaluate(() => App.fs.trash(['a.png', 'b.png'], { silent: true }));
            await page.evaluate(() => { App.commands.run('trash.empty'); });
            await page.waitForSelector('.org-trash .org-sheet');
            assert.match(await page.textContent('.org-sheet-title'), /휴지통을 비울까요/);
            await page.keyboard.press('Escape'); // closes only the sheet
            await page.waitForSelector('.org-sheet', { state: 'detached' });
            assert.ok(await page.isVisible('.org-trash'));
            assert.equal((await trashList(page)).length, 2, 'nothing was deleted');

            // restore inside the panel, then undo it without leaving the panel
            await page.click('.org-trash-row:has-text("a.png")');
            await page.keyboard.press('Enter');
            await until(page, () => window.__opfs.exists('a.png'), null, { message: 'restored' });
            await page.waitForFunction(() => document.querySelectorAll('.org-trash-row').length === 1);
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => document.querySelectorAll('.org-trash-row').length === 2);
            assert.ok(!(await exists(page, 'a.png')));
            await page.keyboard.press('Control+Shift+Z');
            await page.waitForFunction(() => document.querySelectorAll('.org-trash-row').length === 1);
            assert.ok(await exists(page, 'a.png'));
            await page.keyboard.press('Escape');
            await page.waitForSelector('.org-trash', { state: 'detached' });
            await waitIdle(page);
        },
    },
    {
        name: 'conflict sheet: replace sends the old file to the trash, skip-if-same skips identical files',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({
                seed: {
                    'a.png': { image: { label: 'NEW', w: 640, h: 480 } },
                    'same.png': { image: { label: 'S', color: '#123456' } },
                    'trip/a.png': { image: { label: 'OLD', w: 320, h: 240 } },
                    'trip/same.png': { image: { label: 'S', color: '#123456' } },
                },
            });
            const newSize = await sizeOf(page, 'a.png');
            const oldSize = await sizeOf(page, 'trip/a.png');
            assert.notEqual(newSize, oldSize);
            await page.evaluate(() => {
                App.organize.moveTo(['a.png', 'same.png'], 'trip');
            });
            await page.waitForSelector('.org-conflict .org-option');
            assert.match(await page.textContent('.org-conflict .org-head-sub'), /2개 중 1번째/);
            await page.keyboard.press('3'); // 바꾸기
            await page.waitForFunction(() => /2개 중 2번째/.test(document.querySelector('.org-conflict .org-head-sub')?.textContent || ''));
            await page.keyboard.press('4'); // 내용이 같으면 건너뛰기
            await until(page, async () => !(await window.__opfs.exists('a.png')), null, { message: 'moved' });
            await waitIdle(page);
            assert.equal(await sizeOf(page, 'trip/a.png'), newSize, 'incoming file took the name');
            assert.deepEqual(await trashList(page), ['trip/a.png'], 'replaced file went to the trash');
            assert.ok(await exists(page, 'same.png'), 'identical file was skipped');
            assert.ok(!(await exists(page, 'trip/same (2).png')));

            await page.keyboard.press('Control+z');
            await until(page, async () => (await window.__opfs.exists('a.png')) && (await App.fs.listTrash()).length === 0, null, { message: 'undo' });
            assert.equal(await sizeOf(page, 'a.png'), newSize);
            assert.equal(await sizeOf(page, 'trip/a.png'), oldSize, 'the replaced file is back');
            assert.deepEqual(await trashList(page), []);

            // The same sheet plugs into the core onConflict hook (drag & drop): replace + skip, one undo
            await page.evaluate(() => { App.fs.move(['a.png', 'same.png'], 'trip', { onConflict: App.organize.conflictHook }); });
            await page.waitForSelector('.org-conflict .org-option');
            await page.keyboard.press('3');
            await page.waitForFunction(() => /2개 중 2번째/.test(document.querySelector('.org-conflict .org-head-sub')?.textContent || ''));
            await page.keyboard.press('2'); // 건너뛰기
            await until(page, async () => !(await window.__opfs.exists('a.png')), null, { message: 'moved via hook' });
            await waitIdle(page);
            assert.equal(await sizeOf(page, 'trip/a.png'), newSize);
            assert.deepEqual(await trashList(page), ['trip/a.png']);
            assert.ok(await exists(page, 'same.png'), 'skipped');
            await page.keyboard.press('Control+z');
            await until(page, async () => (await window.__opfs.exists('a.png')) && (await App.fs.listTrash()).length === 0, null, { message: 'undo via hook' });
            assert.equal(await sizeOf(page, 'trip/a.png'), oldSize);
        },
    },
    {
        name: 'unwrap lifts everything (incl. non-media and v1 sidecars) and undo restores the folder',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({
                seed: {
                    'a.png': { image: { label: 'ROOT' } },
                    'box/a.png': { image: { label: 'BOX' } },
                    'box/a.png.txt': '#TAGS: x\nmemo',
                    'box/readme.txt': 'hello',
                    'box/sub/b.png': { image: {} },
                },
            });
            await select(page, ['box']);
            await page.keyboard.press('Control+Shift+U');
            await page.waitForSelector('.org-unwrap .org-unwrap-row');
            await page.waitForFunction(() => document.querySelector('.org-unwrap-stats')?.textContent.includes('사진 1'));
            await page.keyboard.press('Enter');
            await page.waitForSelector('.org-conflict .org-option'); // box/a.png clashes with a.png
            await page.keyboard.press('1'); // keep both
            await until(page, async () => !(await window.__opfs.exists('box')), null, { message: 'box trashed' });
            await waitIdle(page);
            const root = await page.evaluate(() => window.__opfs.list(''));
            for (const n of ['a (2).png', 'a (2).png.txt', 'a.png', 'readme.txt', 'sub/']) assert.ok(root.includes(n), `${n} lifted (got ${root.join(', ')})`);
            assert.deepEqual(await trashList(page), ['box']);
            assert.match(await page.evaluate(() => App.undo.peek().label), /폴더 풀기/);

            await page.keyboard.press('Control+z');
            await until(page, async () => (await window.__opfs.exists('box/sub/b.png')) && (await window.__opfs.exists('box/a.png')) && !(await window.__opfs.exists('a (2).png')) && (await App.fs.listTrash()).length === 0, null, { message: 'undo unwrap' });
            assert.ok(await exists(page, 'box/a.png'));
            assert.ok(await exists(page, 'box/a.png.txt'));
            assert.ok(await exists(page, 'box/readme.txt'));
            assert.ok(!(await exists(page, 'a (2).png')));
            assert.deepEqual(await trashList(page), []);

            // Flatten: nested files come out too
            await page.evaluate(() => {
                App.organize.unwrap(['box'], { flatten: true, yes: true });
            });
            await page.waitForSelector('.org-conflict .org-option');
            await page.keyboard.press('2'); // skip the clashing a.png -> box keeps it, so the folder stays
            await until(page, () => window.__opfs.exists('b.png'), null, { message: 'flattened' });
            await waitIdle(page);
            assert.ok(await exists(page, 'box/a.png'), 'skipped file stays, so the folder is kept');
            assert.ok(!(await exists(page, 'box/sub/b.png')));
        },
    },
    {
        name: 'organize by date uses capture dates, creates folders and undoes in one step',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: { 'p1.png': { image: {} }, 'p2.png': { image: {} }, 'p3.png': { image: {} }, 'other.png': { image: {} } } });
            await page.evaluate(() => {
                App.catalog.setMeta('p1.png', { taken: new Date(2023, 4, 6, 12).getTime() });
                App.catalog.setMeta('p2.png', { taken: new Date(2023, 4, 20, 12).getTime() });
                App.catalog.setMeta('p3.png', { taken: new Date(2024, 0, 2, 12).getTime() });
            });
            await select(page, ['p1.png', 'p2.png', 'p3.png']);
            await page.keyboard.press('Control+Shift+D');
            await page.waitForSelector('.org-plan .org-plan-dir');
            await page.click('.org-plan .seg button:has-text("2024/03")');
            await page.waitForFunction(() => document.querySelector('.org-plan .org-sum-main')?.textContent === '3개 파일을 폴더 2개로 정리해요');
            await page.waitForFunction(() => document.querySelectorAll('.org-plan-dir').length === 2);
            const dirs = await page.$$eval('.org-plan-dir .org-plan-label', (els) => els.map((e) => [...e.querySelectorAll(':scope > span:not(.org-plan-sep)')].map((s) => s.textContent).join('/')));
            assert.deepEqual(dirs, ['2023/05', '2024/01']);
            await page.click('.org-plan .org-foot .btn.primary');
            await until(page, () => window.__opfs.exists('2024/01/p3.png'), null, { message: 'organized' });
            await waitIdle(page);
            assert.ok(await exists(page, '2023/05/p1.png'));
            assert.ok(await exists(page, '2023/05/p2.png'));
            assert.ok(await exists(page, 'other.png'));
            await page.keyboard.press('Control+z');
            await until(page, async () => (await window.__opfs.exists('p3.png')) && !(await window.__opfs.exists('2023')) && !(await window.__opfs.exists('2024')), null, { message: 'undo by date' });
            assert.ok(!(await exists(page, '2024')), 'created folders are removed again');
        },
    },
    {
        name: 'organize by chip moves files into chip folders and offers to clean emptied folders',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: { 'c1.png': { image: {} }, 'c2.png': { image: {} }, 'c3.png': { image: {} }, 'c4.png': { image: {} }, 'src/c5.png': { image: {} }, 'legacy.png': { image: {} } } });
            await page.evaluate(async () => {
                await App.wsdata.write('chipsets', {
                    version: 1,
                    activePreset: 'p',
                    presets: [{ id: 'p', name: '기본', categories: [{ id: 'cat', name: '배우', mode: 'search', chips: [{ id: 'k1', name: '김배우', children: [{ id: 'k1a', name: '드라마' }] }, { id: 'k2', name: '이배우', children: [] }] }] }],
                });
                App.catalog.update('c1.png', { chips: ['k1'] });
                App.catalog.update('c2.png', { chips: ['k1', 'k1a'] });
                App.catalog.update('c3.png', { chips: ['k2', 'k1'] });
                App.catalog.update('src/c5.png', { chips: ['k2'] });
                App.catalog.update('legacy.png', { legacyTags: ['배우/이배우'], legacyImported: true });
            });
            await page.evaluate(() => { App.organize.byChip({ paths: ['c1.png', 'c2.png', 'c3.png', 'c4.png', 'src/c5.png', 'legacy.png'] }); });
            await page.waitForSelector('.org-plan .org-plan-dir');
            await page.waitForFunction(() => document.querySelector('.org-plan .org-sum-main')?.textContent.startsWith('5개 파일을'));
            await page.click('.org-plan .org-foot .btn.primary');
            await until(page, () => window.__opfs.exists('이배우/c5.png'), null, { message: 'organized by chip' });
            await waitIdle(page);
            assert.ok(await exists(page, '김배우/c1.png'));
            assert.ok(await exists(page, '김배우/드라마/c2.png'), 'sub-chip folder');
            assert.ok(await exists(page, '김배우/c3.png'), 'several chips -> first chip in panel order');
            assert.ok(await exists(page, '이배우/legacy.png'), 'v1 tags are understood');
            assert.ok(await exists(page, 'c4.png'), 'untagged files stay');
            await page.click('.toast .toast-action:has-text("빈 폴더")');
            await until(page, async () => !(await window.__opfs.exists('src')), null, { message: 'emptied folder trashed' });
            await page.keyboard.press('Control+z');
            await until(page, () => window.__opfs.exists('src'), null, { message: 'folder back' });
            await page.keyboard.press('Control+z');
            await until(page, async () => (await window.__opfs.exists('src/c5.png')) && !(await window.__opfs.exists('김배우')), null, { message: 'files back' });
            assert.ok(await exists(page, 'c2.png'));
            assert.ok(!(await exists(page, '김배우')));
        },
    },
    {
        name: 'empty folders are found and trashed in one undoable step',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: { 'e1/': null, 'e2/inner/': null, 'e3/Thumbs.db': 'x', 'full/a.png': { image: {} }, 'mixed/empty/': null, 'mixed/b.png': { image: {} } } });
            await page.evaluate(() => { App.organize.cleanEmpty({ root: '' }); });
            await page.waitForSelector('.org-empty .org-empty-row');
            const rows = await page.$$eval('.org-empty-row .org-row-name', (els) => els.map((e) => e.textContent).sort());
            assert.deepEqual(rows, ['e1', 'e2', 'e3', 'empty']);
            await page.click('.org-empty .org-foot .btn.primary');
            await until(page, async () => !(await window.__opfs.exists('e1')) && !(await window.__opfs.exists('mixed/empty')), null, { message: 'trashed' });
            assert.ok(await exists(page, 'full/a.png'));
            assert.ok(await exists(page, 'mixed/b.png'));
            await page.keyboard.press('Control+z');
            await until(page, async () => (await window.__opfs.exists('e2/inner')) && (await window.__opfs.exists('e3/Thumbs.db')) && (await window.__opfs.exists('mixed/empty')), null, { message: 'undo' });
            assert.ok(await exists(page, 'e3/Thumbs.db'));
            await waitIdle(page);
        },
    },
    {
        name: 'gallery context menu offers organize actions with shortcuts',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: { 'a.png': { image: {} }, 'b.png': { image: {} }, 'trip/x.png': { image: {} } } });
            await (await card(page, 'a.png')).click({ button: 'right' });
            await page.waitForSelector('.menu');
            const labels = await page.$$eval('.menu .menu-label', (els) => els.map((e) => e.textContent));
            for (const l of ['다른 폴더로 이동…', '다른 폴더로 복사…', '정리하기', '중복검사']) assert.ok(labels.includes(l), `menu has ${l} (got ${labels.join(', ')})`);
            for (const l of ['다른 폴더로 이동…', '다른 폴더로 복사…']) assert.equal(labels.filter((x) => x === l).length, 1, `${l} appears once`);
            assert.ok(await page.isVisible('.menu .menu-item:has-text("다른 폴더로 이동") .menu-hint:has-text("Shift+M")'));
            await page.keyboard.press('Escape');
            await page.click('#gallery-scroll', { position: { x: 600, y: 600 }, button: 'right' });
            await page.waitForSelector('.menu .menu-label:has-text("이 폴더 정리하기")');
            await page.keyboard.press('Escape');
        },
    },
    {
        name: 'owner rule: every organize action is ONE undo entry — one Ctrl+Z reverts it fully, Ctrl+Y redoes it',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({
                seed: {
                    'a.png': { image: { color: '#246', label: 'A' } },
                    'b.png': { image: { color: '#462', label: 'B' } },
                    'c.png': { image: { color: '#624', label: 'C' } },
                    'box/x.png': { image: { color: '#357', label: 'X' } },
                    'box/sub/y.png': { image: { color: '#573', label: 'Y' } },
                    'dest/c.png': { image: { color: '#999', label: 'OLD' } },
                    'dup.png': { image: { w: 320, h: 240, color: '#3a6', label: 'DUP' } },
                    'old/dup copy.png': { image: { w: 320, h: 240, color: '#3a6', label: 'DUP' } },
                    'shot1.png': { image: { color: '#a36', label: 'S1' } },
                    'shot2.png': { image: { color: '#36a', label: 'S2' } },
                    'e1/': null,
                    'e2/inner/': null,
                },
            });
            await page.evaluate(async () => {
                await App.wsdata.write('chipsets', {
                    version: 1,
                    activePreset: 'p',
                    presets: [{ id: 'p', name: '기본', categories: [{ id: 'cat', name: '배우', mode: 'search', chips: [{ id: 'k1', name: '김배우', children: [] }] }] }],
                });
                App.catalog.update('a.png', { chips: ['k1'], rating: 3 }, { undoable: false });
                App.catalog.update('old/dup copy.png', { chips: ['k1'], rating: 5, memo: '복제본 메모' }, { undoable: false });
                App.catalog.setMeta('shot1.png', { taken: new Date(2022, 6, 1, 12).getTime() });
                App.catalog.setMeta('shot2.png', { taken: new Date(2022, 7, 9, 12).getTime() });
                App.undo.clear();
            });
            await page.waitForFunction(() => App.index.ready);

            // Whole visible state: every file/folder, the app trash, and the user metadata of each file
            const snapOnce = (opts = {}) => page.evaluate(async ({ ignoreTrash }) => {
                const out = [];
                async function walk(dir, pre) {
                    for await (const [n, c] of dir.entries()) {
                        if (n === '.fluid-organizer') continue;
                        const p = pre ? `${pre}/${n}` : n;
                        if (c.kind === 'directory') {
                            out.push(p + '/');
                            await walk(c, p);
                        } else {
                            const e = App.catalog.get(p);
                            out.push(`${p} ${JSON.stringify([e.chips, e.rating, e.memo, e.label])} ${(await c.getFile()).size}`);
                        }
                    }
                }
                try {
                    await walk(window.__fakeRoot, '');
                } catch (e) {
                    return 'busy:' + e.name; // something moved while we looked: poll again
                }
                out.sort();
                const trash = ignoreTrash ? [] : (await App.fs.listTrash()).map((i) => 'TRASH ' + i.originalPath).sort();
                return JSON.stringify([...out, ...trash]);
            }, { ignoreTrash: !!opts.ignoreTrash });
            const snap = async (opts) => {
                for (;;) {
                    const s = await snapOnce(opts);
                    if (!s.startsWith('busy:')) return s;
                    await page.waitForTimeout(50);
                }
            };

            const steps = [];
            async function check(name, action, opts = {}) {
                const before = await snap(opts);
                const depth = await page.evaluate(() => App.undo.list().length);
                await action();
                await waitIdle(page);
                const after = await snap(opts);
                assert.notEqual(after, before, `${name}: changed something`);
                assert.equal(await page.evaluate(() => App.undo.list().length), depth + 1, `${name}: exactly one undo entry`);
                await page.keyboard.press('Control+z');
                const t0 = Date.now();
                while ((await snap(opts)) !== before) {
                    if (Date.now() - t0 > 10000) assert.equal(await snap(opts), before, `${name}: one Ctrl+Z reverts everything`);
                    await page.waitForTimeout(80);
                }
                await waitIdle(page);
                await page.keyboard.press('Control+y');
                const t1 = Date.now();
                while ((await snap(opts)) !== after) {
                    if (Date.now() - t1 > 10000) assert.equal(await snap(opts), after, `${name}: Ctrl+Y redoes it`);
                    await page.waitForTimeout(80);
                }
                await waitIdle(page);
                assert.equal(await page.evaluate(() => App.undo.list().length), depth + 1, `${name}: still one entry after redo`);
                steps.push(name);
            }

            await check('batch rename', () => page.evaluate(() => App.organize.commitRenames([{ from: 'a.png', toName: 'b.png' }, { from: 'b.png', toName: 'a.png' }], '이름 일괄 변경')));
            await check('move to', () => page.evaluate(() => App.organize.moveTo(['a.png', 'b.png'], 'dest')));
            await check('copy to (copies go to the trash on undo)', () => page.evaluate(() => App.organize.copyTo(['shot1.png'], 'dest')), { ignoreTrash: true });
            await check('conflict choice "replace"', () => page.evaluate(() => App.organize.commit({ op: 'move', label: '바꾸기', items: [{ from: 'c.png', toDir: 'dest', action: 'replace', existing: 'dest/c.png' }] })));
            await check('unwrap + flatten', () => page.evaluate(() => App.organize.unwrap(['box'], { yes: true, flatten: true })));
            await check('organize by date', async () => {
                await page.evaluate(() => { App.organize.byDate({ paths: ['shot1.png', 'shot2.png'], pattern: 'YYYY-MM' }); });
                await page.waitForSelector('.org-plan .org-plan-dir');
                await page.waitForFunction(() => document.querySelector('.org-plan .org-sum-main')?.textContent.startsWith('2개 파일을'));
                await page.click('.org-plan .org-foot .btn.primary');
                await page.waitForSelector('.org-plan', { state: 'detached' });
                await until(page, () => window.__opfs.exists('2022-08/shot2.png'), null, { message: 'by date' });
            });
            await check('organize by chip', async () => {
                await page.evaluate(() => { App.organize.byChip({ paths: ['dest/a.png', 'dest/b.png'] }); });
                await page.waitForSelector('.org-plan .org-plan-dir');
                await page.click('.org-plan .org-foot .btn.primary');
                await page.waitForSelector('.org-plan', { state: 'detached' });
                await until(page, () => window.__opfs.exists('김배우'), null, { message: 'by chip' });
            });
            await check('clean empty folders', () => page.evaluate(() => App.organize.trashFolders(['e1', 'e2'], '빈 폴더 2개 정리')));
            await check('duplicates cleanup with metadata merge', () => page.evaluate(() => App.dupes.trashDuplicates([{ keep: 'dup.png', remove: ['old/dup copy.png'] }])));
            assert.equal(await page.evaluate(() => App.catalog.get('dup.png').rating), 5, 'redo merged the metadata again');
            await check('trash restore', async () => {
                const ids = await page.evaluate(() => App.fs.listTrash().then((l) => l.filter((i) => i.originalPath === 'old/dup copy.png').map((i) => i.id)));
                assert.equal(ids.length, 1);
                await page.evaluate((x) => App.organize.restoreTrash(x), ids);
            });
            assert.equal(steps.length, 10);
        },
    },
    {
        name: 'Ctrl+Z inside a planning panel (move picker, rename) dismisses it and undoes the last step; text fields keep text undo',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: { 'a.png': { image: {} }, 'b.png': { image: {} }, 'trip/x.png': { image: {} } } });
            await page.evaluate(() => App.organize.moveTo(['a.png'], 'trip'));
            await waitIdle(page);
            assert.ok(await exists(page, 'trip/a.png'));

            // picker opens with the (empty) search box focused: Ctrl+Z is the app's undo there
            await select(page, ['b.png']);
            await page.keyboard.press('Control+Shift+M');
            await page.waitForSelector('.org-picker .org-picker-row');
            await page.keyboard.press('Control+z');
            await page.waitForSelector('.org-picker', { state: 'detached' });
            await until(page, () => window.__opfs.exists('a.png'), null, { message: 'picker Ctrl+Z undid the move' });
            assert.ok(!(await exists(page, 'trip/a.png')));
            await waitIdle(page);

            // ...and Ctrl+Y from the rename panel (focus in its non-empty pattern field keeps native text undo)
            await select(page, ['a.png', 'b.png']);
            await page.keyboard.press('Control+Shift+R');
            await page.waitForSelector('.org-rename');
            await page.keyboard.press('Control+z'); // text field with text: native undo, panel stays
            await page.waitForTimeout(150);
            assert.ok(await page.isVisible('.org-rename'), 'text undo does not close the panel');
            assert.ok(await exists(page, 'a.png'));
            await page.evaluate(() => document.activeElement.blur());
            await page.keyboard.press('Control+y');
            await page.waitForSelector('.org-rename', { state: 'detached' });
            await until(page, () => window.__opfs.exists('trip/a.png'), null, { message: 'redo from the rename panel' });
            await waitIdle(page);
        },
    },
];
