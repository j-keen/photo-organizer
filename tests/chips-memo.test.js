'use strict';

async function openViewer(page, path, video = false) {
    await page.evaluate((p) => App.viewer.open(p), path);
    await page.waitForFunction(({ p, video }) => App.viewer.isOpen && App.viewer.current?.path === p && (!video || (App.viewer.player?.metaReady && App.viewer.player.duration > 2)), { p: path, video });
    if (video) await page.evaluate(() => App.viewer.player.pause());
    await page.evaluate(() => App.chipsViewer.toggle(true));
    await page.waitForSelector('.chip-dock-memo-input:not([disabled])');
}

module.exports = [
    {
        name: 'viewer memo: autosave, persistent caret, inspector storage and one app undo',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'a.png': { image: { color: '#345' } }, 'b.png': { image: { color: '#567' } } } });
            await openViewer(page, 'a.png');
            const depth = await page.evaluate(() => App.undo.list().length);
            await page.click('.chip-dock-memo-input');
            await page.keyboard.type('file #memo');
            await page.waitForFunction(() => App.catalog.peek('a.png')?.memo === 'file #memo');
            await page.evaluate(() => {
                window.__memoNode = document.querySelector('.chip-dock-memo-input');
                window.__memoNode.setSelectionRange(4, 4);
                App.chipsPanel.rerenderAll();
                App.bus.emit('catalog:changed', { paths: ['a.png'] });
            });
            assert.ok(await page.evaluate(() => document.activeElement === window.__memoNode && window.__memoNode.selectionStart === 4));
            await page.keyboard.press('Escape');
            assert.ok(await page.evaluate(() => App.viewer.isOpen));
            assert.equal(await page.evaluate(() => App.undo.list().length), depth + 1);
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => !App.catalog.peek('a.png')?.memo && document.querySelector('.chip-dock-memo-input').value === '');
            await page.keyboard.press('Control+y');
            await page.waitForFunction(() => App.catalog.peek('a.png')?.memo === 'file #memo');
            await page.keyboard.press('Escape');
            await page.waitForFunction(() => !App.viewer.isOpen);
            await page.locator('.card[data-path="a.png"]').click();
            await page.waitForFunction(() => document.querySelector('.insp-memo-input')?.value === 'file #memo');
        },
    },
    {
        name: 'viewer piece memo: shared strip storage, typing guards and target changes flush text',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'clip.webm': { video: { seconds: 3 } }, 'z.png': { image: { color: '#345' } } } });
            await openViewer(page, 'clip.webm', true);
            await page.evaluate(() => App.viewer.player.seek(1.5));
            await page.waitForFunction(() => Math.abs(App.viewer.player.time - 1.5) < 0.05);
            await page.keyboard.press('Control+b');
            await page.waitForFunction(() => App.videoEdit.piecesOf('clip.webm').length === 2);
            await page.evaluate(() => {
                App.videoEdit.setPieceInfo('clip.webm', 1.5, { memo: 'existing' });
                App.videoEdit.select('clip.webm', 1.5);
            });
            await page.waitForFunction(() => document.querySelector('.chip-dock-memo-input')?.value === 'existing');
            assert.equal(await page.textContent('.chip-dock-memo-target'), '조각 2/2');
            await page.fill('.chip-dock-memo-input', '');
            await page.keyboard.press('q');
            await page.keyboard.press('Space');
            await page.keyboard.press('ArrowRight');
            await page.waitForFunction(() => App.catalog.peek('clip.webm')?.meta?.edit?.pieces?.['1.5']?.memo === 'q ');
            await page.waitForFunction(() => document.querySelector('.vw-pstrip-memo')?.value === 'q ');
            assert.ok(await page.evaluate(() => App.viewer.current.path === 'clip.webm' && !App.viewer.player.playing && App.catalog.peek('clip.webm').meta.edit.cuts.length === 1 && App.catalog.peek('clip.webm').meta.edit.removed.length === 0));
            await page.keyboard.press('Control+Enter');
            assert.ok(await page.evaluate(() => App.viewer.isOpen && App.viewer.current.path === 'clip.webm' && document.activeElement !== document.querySelector('.chip-dock-memo-input')));
            await page.fill('.chip-dock-memo-input', 'pending piece');
            await page.evaluate(() => App.videoEdit.deselect());
            await page.waitForFunction(() => App.catalog.peek('clip.webm').meta.edit.pieces['1.5'].memo === 'pending piece' && document.querySelector('.chip-dock-memo-target')?.textContent === '파일');
            await page.fill('.chip-dock-memo-input', 'pending file');
            await page.evaluate(() => App.viewer.open('z.png'));
            await page.waitForFunction(() => App.viewer.current?.path === 'z.png' && App.catalog.peek('clip.webm')?.memo === 'pending file' && document.querySelector('.chip-dock-memo-input')?.value === '');
            await page.click('.chip-dock-memo-input');
            await page.keyboard.press('Escape');
            assert.ok(await page.evaluate(() => App.viewer.isOpen));
        },
    },
];
