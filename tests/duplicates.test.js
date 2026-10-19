// Duplicate finder v2 (photos): exact copies and similar images, keep suggestion, apply with metadata merge as ONE undo,
// scope options (this folder ± subfolders, picked folders, whole workspace, selection), cancelling, the clean-up log.
'use strict';

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
const trashList = (page) => page.evaluate(() => App.fs.listTrash().then((l) => l.map((i) => i.originalPath).sort()));

/** Start a scan of `scope` straight away (as the context menus do) and wait for the review or the empty state. */
async function scanUI(page, scope = { type: 'workspace' }) {
    await page.evaluate((s) => {
        App.commands.run('dupes.open', { scope: s, autostart: true });
    }, scope);
    await page.waitForSelector('.dup-panel .dup-review, .dup-panel .dup-empty', { timeout: 60000 });
}

/** Groups of the open review: [{ kind, sure, keep, paths (sorted), resolved, decision }] in list order */
const reviewGroups = (page) => page.evaluate(() => {
    const rv = App.dupes.ui.active?.rv;
    if (!rv) return [];
    return rv.order.map((id) => rv.byId.get(id)).map((g) => ({
        id: g.id,
        kind: g.kind,
        sure: g.sure,
        keep: (rv.choice.get(g.id)?.keep) || g.keep,
        paths: g.members.map((m) => m.path).sort(),
        resolved: g.resolved || null,
        decision: rv.decisions.get(g.id) || null,
    }));
});

async function closePanel(page) {
    await page.keyboard.press('Escape');
    await page.waitForSelector('.dup-panel', { state: 'detached' });
}

const DUP = { w: 400, h: 300, color: '#2a6', label: 'DUP' };

module.exports = [
    {
        name: 'exact copies: 확실 group, shortest path kept, Enter cleans it as ONE undo with metadata merge and a log entry',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({
                seed: {
                    'a.png': { image: DUP },
                    'trip/copy of a.png': { image: DUP },
                    'old/deep/a (2).png': { image: DUP },
                    'unique.png': { image: { w: 400, h: 300, color: '#a62', label: 'U' } },
                },
            });
            await page.waitForFunction(() => App.index.ready);
            await page.evaluate(() => {
                App.catalog.update('a.png', { rating: 2, memo: '원본' }, { undoable: false });
                App.catalog.update('trip/copy of a.png', { chips: ['k1'], rating: 4, memo: '여행 메모' }, { undoable: false });
                App.catalog.update('old/deep/a (2).png', { chips: ['k2'], markers: [{ id: 'm1', t: 0, title: '표시' }] }, { undoable: false });
                App.undo.clear();
            });

            await scanUI(page);
            const groups = await reviewGroups(page);
            assert.equal(groups.length, 1);
            assert.deepEqual(groups[0].paths, ['a.png', 'old/deep/a (2).png', 'trip/copy of a.png']);
            assert.equal(groups[0].kind, 'exact');
            assert.equal(groups[0].sure, true, 'exact copies are 확실');
            assert.equal(groups[0].keep, 'a.png', 'identical files: the shallowest path is kept');
            assert.match(await page.textContent('.dup-dhead'), /확실/);
            assert.match(await page.textContent('.dup-why'), /a\.png/);
            assert.equal(await page.locator('.dup-member.st-remove').count(), 2);
            assert.match(await page.textContent('.dup-tabs'), /확실 1/);

            // Enter = 이 묶음 정리
            await page.keyboard.press('Enter');
            await until(page, () => App.fs.listTrash().then((l) => l.length === 2), null, { message: 'copies trashed' });
            await page.waitForSelector('.toast:has-text("휴지통으로 옮겼어요")');
            assert.match(await page.textContent('.toast:has-text("휴지통으로 옮겼어요")'), /비우면 .*확보/);
            assert.deepEqual(await trashList(page), ['old/deep/a (2).png', 'trip/copy of a.png']);
            assert.ok(await exists(page, 'a.png'));
            const merged = await page.evaluate(() => App.catalog.get('a.png'));
            assert.equal(merged.rating, 4, 'highest rating wins');
            assert.deepEqual(merged.chips.slice().sort(), ['k1', 'k2']);
            assert.match(merged.memo, /원본/);
            assert.match(merged.memo, /여행 메모/);
            assert.equal(merged.markers.length, 1);
            assert.equal(await page.evaluate(() => App.undo.list().length), 1, 'ONE undo entry for trash + merge');
            const state = (await reviewGroups(page))[0];
            assert.equal(state.resolved, 'applied', 'the group shows as 정리함');
            await page.waitForSelector('.dup-row.resolved .dup-row-state.applied');
            const log = JSON.parse(await page.evaluate(() => window.__opfs.read('.fluid-organizer/dupes-log.json')));
            assert.equal(log.entries.length, 1);
            assert.equal(log.entries[0].groups[0].kept, 'a.png');
            assert.deepEqual(log.entries[0].groups[0].removed.map((r) => r.path).sort(), ['old/deep/a (2).png', 'trip/copy of a.png']);

            // One Ctrl+Z while the panel is open brings everything back, and the group is open again
            await page.keyboard.press('Control+z');
            await until(page, () => App.fs.listTrash().then((l) => l.length === 0), null, { message: 'undo restores both copies' });
            assert.ok(await exists(page, 'trip/copy of a.png'));
            const back = await page.evaluate(() => [App.catalog.get('a.png'), App.catalog.get('trip/copy of a.png')]);
            assert.equal(back[0].rating, 2);
            assert.equal(back[0].memo, '원본');
            assert.deepEqual(back[0].chips, []);
            assert.equal(back[1].rating, 4, 'the copy keeps its own data');
            await until(page, () => {
                const rv = App.dupes.ui.active.rv;
                const g = rv.byId.get(rv.order[0]);
                return !g.resolved && g.members.length === 3;
            }, null, { message: 'group live again' });

            // Ctrl+Y does it again; then close the panel and undo from the gallery
            await page.keyboard.press('Control+y');
            await until(page, () => App.fs.listTrash().then((l) => l.length === 2), null, { message: 'redo' });
            assert.equal(await page.evaluate(() => App.catalog.get('a.png').rating), 4);
            await closePanel(page);
            await page.keyboard.press('Control+z');
            await until(page, () => App.fs.listTrash().then((l) => l.length === 0), null, { message: 'undo from the gallery' });
            assert.equal(await page.evaluate(() => App.catalog.get('a.png').rating), 2);
            await waitIdle(page);
        },
    },
    {
        name: 'similar images: resized/re-encoded copies are one 애매 group, the biggest is kept; choose another with 2',
        async run({ openApp, assert, waitIdle }) {
            const scene = { color: '#3a6', label: 'SUN' };
            const { page } = await openApp({
                seed: {
                    'sun.png': { image: { ...scene, w: 800, h: 600 } },
                    'web/sun-small.jpg': { image: { ...scene, w: 400, h: 300, mime: 'image/jpeg' } },
                    'thumbs/sun-tiny.png': { image: { ...scene, w: 200, h: 150 } },
                    'moon.png': { image: { color: '#c33', label: 'MOON', w: 800, h: 600 } },
                    'night.png': { image: { color: '#225', label: 'ZZ', w: 600, h: 800 } },
                },
            });
            await page.waitForFunction(() => App.index.ready);
            const d = await page.evaluate(async () => {
                const ph = async (p) => App.dupes.phash(await App.fs.getFile(p));
                const [a, b, c, m] = await Promise.all(['sun.png', 'web/sun-small.jpg', 'thumbs/sun-tiny.png', 'moon.png'].map(ph));
                return { small: App.dupes.hamming(a, b), tiny: App.dupes.hamming(a, c), other: App.dupes.hamming(a, m) };
            });
            assert.ok(d.small <= 8 && d.tiny <= 8, `copies are close (${d.small}, ${d.tiny})`);

            await scanUI(page);
            const groups = await reviewGroups(page);
            assert.equal(groups.length, 1, JSON.stringify(groups));
            assert.deepEqual(groups[0].paths, ['sun.png', 'thumbs/sun-tiny.png', 'web/sun-small.jpg']);
            assert.equal(groups[0].kind, 'image');
            assert.equal(groups[0].sure, false, 'similar pictures are 애매');
            assert.equal(groups[0].keep, 'sun.png', 'highest resolution kept');
            assert.match(await page.textContent('.dup-why'), /해상도가 가장 높아서/);
            assert.ok(await page.isVisible('.dup-member .dup-likeness'), 'shows how alike they are');

            // 2 = keep the second member (in group order)
            const second = await page.evaluate(() => {
                const rv = App.dupes.ui.active.rv;
                return rv.byId.get(rv.order[0]).members[1].path;
            });
            await page.keyboard.press('2');
            await page.waitForSelector(`.dup-member.st-keep[data-path="${second}"]`);
            assert.match(await page.textContent('.dup-why'), /직접 고른/);
            // leave the tiny one where it is, then clean
            const tinyState = '.dup-member[data-path="thumbs/sun-tiny.png"] .dup-state';
            if ((await page.getAttribute('.dup-member[data-path="thumbs/sun-tiny.png"]', 'class')).includes('st-remove')) await page.click(tinyState);
            await page.waitForSelector('.dup-member.st-leave[data-path="thumbs/sun-tiny.png"]');
            await page.click('.dup-dhead .btn.primary');
            await until(page, () => App.fs.listTrash().then((l) => l.length === 1), null, { message: 'trashed' });
            const removed = await trashList(page);
            assert.equal(removed.length, 1);
            assert.ok(!removed.includes(second) && !removed.includes('thumbs/sun-tiny.png'), `kept the chosen one and the tiny one: ${removed}`);
            await page.keyboard.press('Control+z');
            await until(page, () => App.fs.listTrash().then((l) => l.length === 0), null, { message: 'undo' });
            await closePanel(page);
            await waitIdle(page);
        },
    },
    {
        name: 'scopes: this folder with/without subfolders, picked folders (tree checkboxes), whole workspace, selection',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({
                seed: {
                    'x/a.png': { image: DUP },
                    'x/sub/a.png': { image: DUP },
                    'y/a.png': { image: DUP },
                    'z/a.png': { image: DUP },
                    'x/other.png': { image: { color: '#a26', label: 'O' } },
                },
            });
            await page.waitForFunction(() => App.index.ready);
            await page.evaluate(() => App.nav.go('x'));
            await page.waitForFunction(() => App.state.cwd === 'x');
            await waitIdle(page);

            // 지금 보는 폴더, without subfolders → nothing; with → x/a + x/sub/a
            await page.evaluate(() => {
                App.commands.run('dupes.open', { fresh: true });
            });
            await page.waitForSelector('.dup-panel .dup-setup');
            await page.click('.dup-scope[data-mode="folder"]');
            const sub = page.locator('.dup-scope-detail .org-toggle input');
            if (await sub.isChecked()) await sub.click();
            await page.click('.dup-panel .org-foot .btn.primary:has-text("찾기 시작")');
            await page.waitForSelector('.dup-panel .dup-empty');
            await page.click('.dup-panel .org-foot .btn:has-text("다시 찾기")');
            await page.waitForSelector('.dup-panel .dup-setup');
            await page.locator('.dup-scope-detail .org-toggle input').check();
            await page.click('.dup-panel .org-foot .btn.primary:has-text("찾기 시작")');
            await page.waitForSelector('.dup-panel .dup-review');
            assert.deepEqual((await reviewGroups(page)).map((g) => g.paths), [['x/a.png', 'x/sub/a.png']]);

            // 폴더 골라서: y + z (two checkboxes in the tree)
            await page.click('.dup-panel .org-foot .btn:has-text("다시 찾기")');
            await page.click('.dup-scope[data-mode="folders"]');
            await page.click('.dup-tree-row[data-path="y"] .org-check');
            await page.click('.dup-tree-row[data-path="z"] .org-check');
            assert.match(await page.textContent('.dup-picked'), /y.*z|z.*y/);
            await page.click('.dup-panel .org-foot .btn.primary:has-text("찾기 시작")');
            await page.waitForSelector('.dup-panel .dup-review');
            assert.deepEqual((await reviewGroups(page)).map((g) => g.paths), [['y/a.png', 'z/a.png']]);
            assert.deepEqual(await page.evaluate(() => App.dupes.store.data.lastScan.scope), { type: 'folders', paths: ['y', 'z'], roots: [] }, 'the scope is remembered');

            // 전체 작업 폴더
            await page.click('.dup-panel .org-foot .btn:has-text("다시 찾기")');
            await page.click('.dup-scope[data-mode="workspace"]');
            await page.click('.dup-panel .org-foot .btn.primary:has-text("찾기 시작")');
            await page.waitForSelector('.dup-panel .dup-review');
            assert.deepEqual((await reviewGroups(page)).map((g) => g.paths), [['x/a.png', 'x/sub/a.png', 'y/a.png', 'z/a.png']]);
            await closePanel(page);

            // Selection (organize's context menu passes scope 'selection'): a file plus a folder
            await page.evaluate(() => App.nav.go(''));
            await page.waitForFunction(() => App.state.cwd === '');
            await waitIdle(page);
            await page.evaluate(() => App.select.set(['x', 'y']));
            await page.evaluate(() => {
                App.commands.run('dupes.open', { scope: 'selection' });
            });
            await page.waitForSelector('.dup-panel .dup-review');
            assert.deepEqual((await reviewGroups(page)).map((g) => g.paths), [['x/a.png', 'x/sub/a.png', 'y/a.png']]);
            await closePanel(page);
            assert.deepEqual(await trashList(page), [], 'scanning never deletes anything');
        },
    },
    {
        name: 'cancel: Esc on setup, "그만 찾기" during a scan, and cancelling the bulk confirmation trash nothing',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({
                seed: {
                    'a.png': { image: DUP },
                    'b.png': { image: DUP },
                    'many/': { bulk: { count: 600, image: { color: '#555', label: 'M' } } },
                },
            });
            await page.waitForFunction(() => App.index.ready);
            await page.evaluate(() => App.dupes.clearCache());

            await page.keyboard.press('Control+Alt+D');
            await page.waitForSelector('.dup-panel .dup-setup');
            await page.keyboard.press('Escape');
            await page.waitForSelector('.dup-panel', { state: 'detached' });

            // Stop a running scan: back to the setup screen, no results, nothing touched
            await page.evaluate(() => {
                App.commands.run('dupes.open', { fresh: true });
            });
            await page.waitForSelector('.dup-panel .dup-setup');
            await page.click('.dup-scope[data-mode="workspace"]');
            await page.click('.dup-panel .org-foot .btn.primary:has-text("찾기 시작")');
            await page.click('.dup-panel .org-foot .btn:has-text("그만 찾기")');
            await page.waitForSelector('.toast:has-text("중복 찾기를 멈췄어요")');
            await page.waitForSelector('.dup-panel .dup-setup');

            // Run it to the end, then cancel the bulk confirmation (Esc closes only the sheet)
            await page.click('.dup-panel .org-foot .btn.primary:has-text("찾기 시작")');
            await page.waitForSelector('.dup-panel .dup-review', { timeout: 60000 });
            const groups = await reviewGroups(page);
            assert.ok(groups.length >= 2 && groups.every((g) => g.sure), 'exact groups');
            await page.click('.dup-panel .org-foot .btn.danger');
            await page.waitForSelector('.dup-panel .org-sheet');
            await page.keyboard.press('Escape');
            await page.waitForSelector('.dup-panel .org-sheet', { state: 'detached' });
            assert.ok(await page.isVisible('.dup-panel .dup-review'), 'results stay');
            assert.deepEqual(await trashList(page), []);
            assert.equal(await page.evaluate(() => App.undo.list().length), 0, 'nothing to undo');
            await closePanel(page);
            await waitIdle(page, 60000);
        },
    },
];
module.exports.helpers = { until, scanUI, reviewGroups, closePanel, trashList, exists, DUP };
