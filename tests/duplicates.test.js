// Duplicate finder: exact duplicates, similar images (pHash), keep-best, cleanup with metadata merge as ONE undo,
// scope options and cancelling.
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
const select = (page, paths) => page.evaluate((ps) => App.select.set(ps), paths);

/** Cards of each visible group: [[path, ...], ...] with the kept file first */
const groupsShown = (page) => page.$$eval('.dup-group', (gs) => gs.map((g) => {
    const cards = [...g.querySelectorAll('.dup-card')];
    const keep = cards.filter((c) => c.classList.contains('keep')).map((c) => c.dataset.path);
    return [...keep, ...cards.filter((c) => !c.classList.contains('keep')).map((c) => c.dataset.path).sort()];
}));

/** Open the panel (optionally with args), choose scope/mode in the setup screen and start. */
async function scan(page, { args = {}, scope, mode, sub } = {}) {
    if (!(await page.isVisible('.dup-panel'))) {
        await page.evaluate((a) => { App.commands.run('dupes.open', a); }, args);
    }
    await page.waitForSelector('.dup-panel .dup-setup');
    if (scope) await page.click(`.dup-setup .seg button[data-value="${scope}"]`);
    if (sub != null) {
        const box = page.locator('.dup-setup .org-toggle input');
        if ((await box.isChecked()) !== sub) await box.click();
    }
    if (mode) await page.click(`.dup-mode[data-mode="${mode}"]`);
    await page.click('.dup-panel .org-foot .btn.primary:has-text("찾기 시작")');
    await page.waitForSelector('.dup-panel .dup-group, .dup-panel .dup-empty');
}

const DUP = { w: 400, h: 300, color: '#2a6', label: 'DUP' };

module.exports = [
    {
        name: 'exact duplicates: same bytes under other names/folders, keep-best, trash + metadata merge is ONE undo',
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
            const sizes = await page.evaluate(() => Promise.all(['a.png', 'trip/copy of a.png', 'old/deep/a (2).png'].map((p) => App.fs.stat(p).then((s) => s.size))));
            assert.ok(sizes.every((s) => s === sizes[0]), 'seeded copies are byte-identical');
            await page.evaluate(() => {
                App.catalog.update('a.png', { rating: 2, memo: '원본' }, { undoable: false });
                App.catalog.update('trip/copy of a.png', { chips: ['k1'], rating: 4, memo: '여행 메모' }, { undoable: false });
                App.catalog.update('old/deep/a (2).png', { chips: ['k2'], markers: [{ id: 'm1', t: 0, title: '표시' }] }, { undoable: false });
                App.undo.clear();
            });

            await page.keyboard.press('Control+Alt+D');
            await scan(page, { scope: 'workspace', mode: 'exact' });
            assert.deepEqual(await groupsShown(page), [['a.png', 'old/deep/a (2).png', 'trip/copy of a.png']], 'one group, keeps the shortest path of identical files');
            assert.match(await page.textContent('.dup-group .dup-kind'), /똑같음/);
            const label = await page.textContent('.dup-panel .org-foot .btn.danger');
            assert.match(label, /복제본 2개 휴지통으로/);

            await page.click('.dup-panel .org-foot .btn.danger');
            await page.waitForSelector('.dup-panel .org-sheet');
            await page.keyboard.press('Enter');
            await until(page, () => App.fs.listTrash().then((l) => l.length === 2), null, { message: 'copies trashed' });
            await page.waitForSelector('.dup-panel .dup-empty');
            assert.deepEqual(await trashList(page), ['old/deep/a (2).png', 'trip/copy of a.png']);
            assert.ok(await exists(page, 'a.png'));
            assert.ok(await exists(page, 'unique.png'));
            const merged = await page.evaluate(() => App.catalog.get('a.png'));
            assert.equal(merged.rating, 4, 'highest rating wins');
            assert.deepEqual(merged.chips.slice().sort(), ['k1', 'k2']);
            assert.match(merged.memo, /원본/);
            assert.match(merged.memo, /여행 메모/);
            assert.equal(merged.markers.length, 1);
            assert.equal(await page.evaluate(() => App.undo.list().length), 1, 'ONE undo entry for trash + merge');
            assert.match(await page.evaluate(() => App.undo.peek().label), /복제본 2개 정리/);

            // One Ctrl+Z while the panel is still open brings everything back, metadata included
            await page.keyboard.press('Control+z');
            await until(page, () => App.fs.listTrash().then((l) => l.length === 0), null, { message: 'undo restores both copies' });
            assert.ok(await exists(page, 'trip/copy of a.png'));
            assert.ok(await exists(page, 'old/deep/a (2).png'));
            const back = await page.evaluate(() => [App.catalog.get('a.png'), App.catalog.get('trip/copy of a.png')]);
            assert.equal(back[0].rating, 2);
            assert.equal(back[0].memo, '원본');
            assert.deepEqual(back[0].chips, []);
            assert.equal(back[1].rating, 4, 'the copy keeps its own data');

            // Ctrl+Y does it again; then close the panel and undo from the gallery
            await page.keyboard.press('Control+y');
            await until(page, () => App.fs.listTrash().then((l) => l.length === 2), null, { message: 'redo' });
            assert.equal(await page.evaluate(() => App.catalog.get('a.png').rating), 4);
            await page.keyboard.press('Escape');
            await page.waitForSelector('.dup-panel', { state: 'detached' });
            await page.keyboard.press('Control+z');
            await until(page, () => App.fs.listTrash().then((l) => l.length === 0), null, { message: 'undo from the gallery' });
            assert.equal(await page.evaluate(() => App.catalog.get('a.png').rating), 2);
            await waitIdle(page);
        },
    },
    {
        name: 'similar images: resized and re-encoded copies are grouped by pHash, the biggest is kept',
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

            // The pHash of a resized/re-encoded copy is close; a different picture is far
            const d = await page.evaluate(async () => {
                const ph = async (p) => App.dupes.phash(await App.fs.getFile(p));
                const [a, b, c, m] = await Promise.all(['sun.png', 'web/sun-small.jpg', 'thumbs/sun-tiny.png', 'moon.png'].map(ph));
                return { small: App.dupes.hamming(a, b), tiny: App.dupes.hamming(a, c), other: App.dupes.hamming(a, m) };
            });
            assert.ok(d.small <= 8 && d.tiny <= 8, `copies are close (${d.small}, ${d.tiny})`);

            // Exact mode does not group them (different bytes)
            await scan(page, { args: { scope: 'workspace' }, mode: 'exact' });
            assert.ok(await page.isVisible('.dup-empty'), 'no exact duplicates');
            await page.click('.dup-panel .org-foot .btn:has-text("다시 찾기")');

            await scan(page, { mode: 'similar' });
            const groups = await groupsShown(page);
            assert.deepEqual(groups, [['sun.png', 'thumbs/sun-tiny.png', 'web/sun-small.jpg']], `one similar group, biggest kept (distance to moon ${d.other})`);
            assert.match(await page.textContent('.dup-group .dup-kind'), /비슷함/);
            assert.ok(await page.isVisible('.dup-card .dup-like'), 'shows how alike they are');

            // Keep a different one: "이걸 남기기" on the small jpg, then send the rest to the trash
            await page.hover('.dup-card[data-path="web/sun-small.jpg"]');
            await page.click('.dup-card[data-path="web/sun-small.jpg"] .dup-keepbtn');
            assert.equal((await groupsShown(page))[0][0], 'web/sun-small.jpg');
            // Untick the tiny one: it stays where it is
            await page.click('.dup-card[data-path="thumbs/sun-tiny.png"] .dup-card-meta');
            assert.match(await page.textContent('.dup-panel .org-foot .btn.danger'), /복제본 1개 휴지통으로/);
            await page.click('.dup-panel .org-foot .btn.danger');
            await page.waitForSelector('.dup-panel .org-sheet');
            await page.keyboard.press('Enter');
            await until(page, () => App.fs.listTrash().then((l) => l.length === 1), null, { message: 'trashed' });
            assert.deepEqual(await trashList(page), ['sun.png']);
            assert.ok(await exists(page, 'thumbs/sun-tiny.png'));
            await page.keyboard.press('Control+z');
            await until(page, () => window.__opfs.exists('sun.png'), null, { message: 'undo' });
            await page.keyboard.press('Escape');
            await page.waitForSelector('.dup-panel', { state: 'detached' });
            await waitIdle(page);
        },
    },
    {
        name: 'scope options: selection, this folder with/without subfolders, whole workspace',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({
                seed: {
                    'x/a.png': { image: DUP },
                    'x/sub/a.png': { image: DUP },
                    'y/a.png': { image: DUP },
                    'x/other.png': { image: { color: '#a26', label: 'O' } },
                },
            });
            await page.waitForFunction(() => App.index.ready);
            await page.evaluate(() => App.nav.go('x'));
            await page.waitForFunction(() => App.state.cwd === 'x');
            await waitIdle(page);

            await scan(page, { scope: 'folder', sub: false, mode: 'exact' });
            assert.ok(await page.isVisible('.dup-empty'), 'only x/a.png itself without subfolders');
            await page.click('.dup-panel .org-foot .btn:has-text("다시 찾기")');

            await scan(page, { scope: 'folder', sub: true });
            assert.deepEqual(await groupsShown(page), [['x/a.png', 'x/sub/a.png']]);
            await page.click('.dup-panel .org-foot .btn:has-text("다시 찾기")');

            await scan(page, { scope: 'workspace' });
            assert.deepEqual(await groupsShown(page), [['x/a.png', 'x/sub/a.png', 'y/a.png']]);
            await page.keyboard.press('Escape');
            await page.waitForSelector('.dup-panel', { state: 'detached' });

            // Selection: a file plus a folder (the folder's files count)
            await page.evaluate(() => App.nav.go(''));
            await page.waitForFunction(() => App.state.cwd === '');
            await waitIdle(page);
            await select(page, ['x', 'y']);
            await scan(page, { args: { scope: 'selection' } });
            assert.deepEqual(await groupsShown(page), [['x/a.png', 'x/sub/a.png', 'y/a.png']]);
            await page.keyboard.press('Escape');
            await page.waitForSelector('.dup-panel', { state: 'detached' });
            const viaPaths = await page.evaluate(async () => {
                const entries = await App.dupes.collect('selection', { paths: ['x/sub/a.png', 'y/a.png'] });
                const res = await App.dupes.scan(entries, { mode: 'exact' });
                return res.groups.map((g) => g.items.map((i) => i.path).sort());
            });
            assert.deepEqual(viaPaths, [['x/sub/a.png', 'y/a.png']]);
            assert.deepEqual(await trashList(page), [], 'scanning never deletes anything');
        },
    },
    {
        name: 'cancel: Esc on setup, "그만 찾기" during a scan, and cancelling the confirmation trash nothing',
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
            await page.evaluate(() => { App.commands.run('dupes.open', { scope: 'workspace' }); });
            await page.waitForSelector('.dup-panel .dup-setup');
            await page.click('.dup-mode[data-mode="exact"]');
            await page.click('.dup-panel .org-foot .btn.primary:has-text("찾기 시작")');
            await page.click('.dup-panel .org-foot .btn:has-text("그만 찾기")');
            await page.waitForSelector('.toast:has-text("중복 찾기를 멈췄어요")');
            await page.waitForSelector('.dup-panel .dup-setup');
            assert.equal(await page.locator('.dup-group').count(), 0);

            // Run it to the end, then cancel the confirmation (Esc closes only the sheet)
            await page.click('.dup-panel .org-foot .btn.primary:has-text("찾기 시작")');
            await page.waitForSelector('.dup-panel .dup-group', { timeout: 60000 });
            await page.click('.dup-panel .org-foot .btn.danger');
            await page.waitForSelector('.dup-panel .org-sheet');
            await page.keyboard.press('Escape');
            await page.waitForSelector('.dup-panel .org-sheet', { state: 'detached' });
            assert.ok(await page.isVisible('.dup-panel .dup-group'), 'results stay');
            assert.deepEqual(await trashList(page), []);
            assert.equal(await page.evaluate(() => App.undo.list().length), 0, 'nothing to undo');
            await page.keyboard.press('Escape');
            await page.waitForSelector('.dup-panel', { state: 'detached' });
            await waitIdle(page, 60000);
        },
    },
];
