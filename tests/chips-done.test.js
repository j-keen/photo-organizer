'use strict';

async function setup(page, paths = []) {
    await page.waitForFunction(() => App.chipset?.ready && App.index.ready);
    return page.evaluate((files) => {
        const C = App.chipset;
        C.renamePreset(C.active().id, '주식강의용');
        const cat = C.addCategory({ name: '배우' });
        const chip = C.addChip(cat.id, '쓰담');
        if (files.length) C.apply(files, chip.id, 'add', { hud: false });
        return { cat: cat.id, chip: chip.id };
    }, paths);
}

module.exports = [
    {
        name: 'chips done: viewer shortcut moves, advances, summarizes and undoes once',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: {
                'sub/a.png': { image: { color: '#a33' } },
                'sub/b.png': { image: { color: '#3a3' } },
            } });
            const ids = await setup(page);
            await page.evaluate(async () => App.nav.go('sub'));
            await page.waitForFunction(() => App.view.visible.some((e) => e.path === 'sub/a.png'));
            await page.evaluate(() => App.viewer.open('sub/a.png'));
            await page.waitForSelector('#viewer:not([hidden]) .vw-media');
            await page.keyboard.press('Alt+c');
            await page.waitForSelector('.chip-done-btn');
            await page.click(`.chip-dock [data-chip="${ids.chip}"]`);
            await page.waitForFunction(() => App.catalog.peek('sub/a.png')?.chips?.length === 1);
            await page.evaluate(() => {
                window.__donePushes = 0;
                window.__doneUndoFinished = false;
                window.__doneUndoError = null;
                window.__doneOriginWrites = [];
                window.__doneMissing = [];
                let movedBack = false;
                const check = (event) => {
                    if (movedBack && !App.catalog.peek('sub/a.png')) window.__doneMissing.push(event);
                };
                App.bus.on('fs:changed', (change) => {
                    if (change.type === 'move' && change.to?.includes('sub/a.png')) movedBack = true;
                    check('fs:' + change.type);
                });
                App.bus.on('catalog:changed', () => check('catalog:changed'));
                const update = App.catalog.update;
                App.catalog.update = function (path, patch, opts) {
                    window.__doneOriginWrites.push({ path, movedBack });
                    const result = update.call(this, path, patch, opts);
                    check('catalog.update');
                    return result;
                };
                const push = App.undo.push;
                App.undo.push = function (entry) {
                    window.__donePushes++;
                    const undo = entry.undo;
                    return push.call(this, {
                        ...entry,
                        undo: async () => {
                            try {
                                await undo();
                                check('undo completed');
                            } catch (error) {
                                window.__doneUndoError = error.message;
                                throw error;
                            } finally {
                                window.__doneUndoFinished = true;
                            }
                        },
                    });
                };
            });
            await page.click('.vw-title');
            await page.keyboard.press('Control+Enter');
            await page.waitForFunction(() => App.viewer.current?.path === 'sub/b.png');
            await page.waitForSelector('.toast:has-text("완료 폴더로 옮겼어요 · 배우 쓰담")');
            assert.equal(await page.evaluate(() => window.__donePushes), 1);
            assert.ok(await page.evaluate(() => window.__opfs.exists('_완료/sub/a.png')));
            assert.equal(await page.evaluate(() => App.catalog.peek('_완료/sub/a.png').meta.doneFrom), 'sub');
            await page.evaluate(() => { window.__doneOriginWrites = []; });
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => window.__doneUndoFinished);
            assert.equal(await page.evaluate(() => window.__doneUndoError), null);
            assert.deepEqual(await page.evaluate(() => window.__doneOriginWrites), [{ path: 'sub/a.png', movedBack: true }]);
            assert.deepEqual(await page.evaluate(() => window.__doneMissing), []);
            assert.equal(await page.evaluate(() => window.__donePushes), 1);
            await page.waitForFunction(async (chip) => {
                const entry = App.catalog.peek('sub/a.png');
                return entry?.chips?.includes(chip)
                    && entry.meta?.doneFrom === undefined
                    && entry.meta?.doneAt === undefined
                    && !App.catalog.peek('_완료/sub/a.png')
                    && await window.__opfs.exists('sub/a.png')
                    && !await window.__opfs.exists('_완료');
            }, ids.chip);
            assert.equal(await page.evaluate(() => App.catalog.peek('sub/a.png').chips.length), 1);
            assert.equal(await page.evaluate(() => App.catalog.peek('sub/a.png').meta.doneFrom), undefined);
            assert.equal(await page.evaluate(() => App.catalog.peek('sub/a.png').meta.doneAt), undefined);
        },
    },
    {
        name: 'chips done: no-chip confirmation can cancel; last file closes viewer',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'a.png': { image: { color: '#a33' } } } });
            await setup(page);
            await page.evaluate(() => App.viewer.open('a.png'));
            await page.waitForSelector('#viewer:not([hidden]) .vw-media');
            await page.keyboard.press('Control+Enter');
            await page.waitForSelector('.dialog:has-text("칩이 하나도 없어요. 그래도 완료할까요?")');
            await page.click('.dialog .btn:has-text("취소")');
            await page.waitForSelector('.dialog', { state: 'detached' });
            assert.ok(await page.evaluate(() => window.__opfs.exists('a.png')));
            await page.keyboard.press('Control+Enter');
            await page.waitForSelector('.dialog');
            await page.click('.dialog .btn.primary');
            await page.waitForSelector('#viewer', { state: 'hidden' });
            await page.waitForFunction(() => window.__opfs.exists('_완료/a.png'));
        },
    },
    {
        name: 'chips done: gallery batch and live done smart view',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: {
                'a.png': { image: { color: '#a33' } },
                'b.png': { image: { color: '#3a3' } },
            } });
            await setup(page, ['a.png', 'b.png']);
            await page.evaluate(() => App.select.set(['a.png', 'b.png']));
            await page.evaluate(() => App.commands.run('chips.done'));
            await page.waitForFunction(async () => await window.__opfs.exists('_완료/a.png') && await window.__opfs.exists('_완료/b.png'));
            await page.waitForSelector('.chipf-row[data-smart="done"]');
            await page.click('.chipf-row[data-smart="done"]');
            await page.waitForFunction(() => App.view.source.smart === 'done' && App.view.visible.length === 2);
            assert.deepEqual(await page.evaluate(() => App.view.visible.map((e) => e.path).sort()), ['_완료/a.png', '_완료/b.png']);
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => App.view.source.smart === 'done' && App.view.visible.length === 0);
            assert.ok(await page.evaluate(() => window.__opfs.exists('a.png')));
            assert.ok(await page.evaluate(() => window.__opfs.exists('b.png')));
        },
    },
    {
        name: 'chips done: headings fold with keyboard and survive reload; active set opens menu in both panels',
        async run({ openApp, assert, card, waitIdle }) {
            const { page } = await openApp({ seed: { 'a.png': { image: { color: '#a33' } } } });
            const ids = await setup(page, ['a.png']);
            assert.deepEqual(await page.evaluate(() => App.catalog.peek('a.png')?.chips), [ids.chip]);
            await (await card(page, 'a.png')).click();
            const panel = '.chip-panel[data-panel="inspector"]';
            const head = `${panel} [data-cat-head="${ids.cat}"]`;
            await page.waitForSelector(head);
            await page.focus(head);
            await page.keyboard.press('Space');
            await page.waitForSelector(`${head}[aria-expanded="false"]`);
            assert.equal(await page.textContent(`${head} .chip-cat-on`), '1');
            await page.click(`${panel} .chip-preset-btn`);
            await page.waitForSelector('.menu:has-text("새 칩 세트")');
            await page.keyboard.press('Escape');
            await page.evaluate(async () => {
                await App.catalog.flush();
                await Promise.all(App.workspace.flushHooks.map((fn) => fn()));
            });
            await page.reload();
            await page.waitForFunction(() => window.App && document.querySelector('#topbar').children.length);
            await page.evaluate(async () => {
                await window.__useExistingWorkspace();
                await App.workspace.pick();
            });
            await waitIdle(page);
            await page.waitForFunction(() => App.chipset.ready);
            await (await card(page, 'a.png')).click();
            await page.waitForSelector(`${head}[aria-expanded="false"]`);
            await page.evaluate(() => App.viewer.open('a.png'));
            await page.waitForSelector('#viewer:not([hidden]) .vw-media');
            await page.keyboard.press('Alt+c');
            await page.waitForSelector('.chip-dock .chip-preset-btn');
            assert.match(await page.textContent('.chip-dock .chip-panel > :first-child'), /칩 세트 ·주식강의용/);
            assert.equal(await page.locator('.chip-compact-foot [data-action="preset-menu"]').count(), 0);
            await page.click('.chip-dock .chip-preset-btn');
            await page.waitForSelector('.menu:has-text("새 칩 세트")');
        },
    },
];
