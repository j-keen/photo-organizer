// Core round 2: instant folders (listing cache, stale-while-revalidate), instant library (index snapshot),
// stale entries that vanished behind the app, Shift-ranges that survive refreshes.
'use strict';

const SEED = {
    'cover.png': { image: { label: 'C' } },
    'big/': { bulk: { count: 60 } },
    'trip/x.png': { image: { label: 'X' } },
    'trip/inner/y.png': { image: { label: 'Y' } },
    'other/z.png': { image: { label: 'Z' } },
};

// Change the workspace behind the app's back (like Explorer would)
async function outside(page, ops) {
    await page.evaluate(async (ops) => {
        const dirOf = async (rel) => {
            let d = window.__fakeRoot;
            for (const seg of rel.split('/').filter(Boolean)) d = await d.getDirectoryHandle(seg, { create: true });
            return d;
        };
        for (const op of ops) {
            const parts = op.path.split('/');
            const name = parts.pop();
            const dir = await dirOf(parts.join('/'));
            if (op.add) {
                const fh = await dir.getFileHandle(name, { create: true });
                const w = await fh.createWritable();
                await w.write(new Blob([op.add]));
                await w.close();
            } else if (op.remove) {
                await dir.removeEntry(name, { recursive: true });
            }
        }
    }, ops);
}

async function reopen(page, waitIdle) {
    await page.reload();
    await page.waitForFunction(() => window.App && document.querySelector('#topbar').children.length > 0);
    await page.evaluate(() => window.__useExistingWorkspace());
    await page.evaluate(() => App.workspace.pick());
    await page.waitForFunction(() => App.state.cwd === '' && App.view.source.type === 'folder');
    await waitIdle(page);
}

const names = (page) => page.evaluate(() => App.view.visible.map((e) => e.name));

module.exports = [
    {
        name: 'core cache: a folder opens from its cached listing, then outside changes show up (selection kept)',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: SEED });
            await page.evaluate(() => App.index.whenFresh());
            await page.evaluate(() => App.nav.go('big'));
            await page.evaluate(() => App.nav.whenFresh());
            // The library scan already cached every folder: this open came from the cache
            assert.equal(await page.evaluate(() => App.nav.lastOpen.cached), true);
            await page.evaluate(() => App.nav.go(''));
            await page.evaluate(() => App.nav.whenFresh());

            await outside(page, [{ path: 'big/NEW_1.png', add: 'n1' }, { path: 'big/NEW_2.png', add: 'n2' }, { path: 'big/IMG_00003.png', remove: true }]);

            const r = await page.evaluate(async () => {
                const events = [];
                const off = App.bus.on('view:changed', (e) => events.push(e));
                await App.nav.go('big');
                const first = App.view.visible.map((e) => e.name);
                const cached = App.nav.lastOpen.cached;
                // Select two items while the re-check runs
                App.select.set(['big/IMG_00010.png', 'big/IMG_00011.png'], { focus: 'big/IMG_00011.png', anchor: 'big/IMG_00010.png' });
                const result = await App.nav.revalidate();
                await App.nav.whenFresh();
                off();
                return {
                    cached,
                    firstHasOld: first.includes('IMG_00003.png'),
                    firstHasNew: first.includes('NEW_1.png'),
                    after: App.view.visible.map((e) => e.name),
                    revalidatedEvents: events.filter((e) => e.revalidated).length,
                    diffs: events.filter((e) => e.revalidated).map((e) => e.diff),
                    sel: App.select.list(),
                    focus: App.select.focus,
                    anchor: App.select.anchor,
                    result,
                };
            });
            assert.equal(r.cached, true, 'shown from the cache');
            assert.ok(r.firstHasOld && !r.firstHasNew, 'the cached listing is shown first');
            assert.ok(r.after.includes('NEW_1.png') && r.after.includes('NEW_2.png'), 'files added outside show up');
            assert.ok(!r.after.includes('IMG_00003.png'), 'files removed outside disappear');
            assert.equal(r.revalidatedEvents, 1, 'one view:changed for the real difference');
            assert.deepEqual(r.diffs[0], { added: 2, removed: 1, updated: 0 });
            assert.deepEqual(r.sel, ['big/IMG_00010.png', 'big/IMG_00011.png']);
            assert.equal(r.focus, 'big/IMG_00011.png');
            assert.equal(r.anchor, 'big/IMG_00010.png');
            // The index learned about it too (search works on the new file)
            assert.equal(await page.evaluate(() => App.index.search('NEW_2').length), 1);
            // The cache now holds the corrected listing
            const rows = await page.evaluate(async () => (await App.listCache._record('big')).rows.map((r) => r[0]));
            assert.ok(rows.includes('NEW_1.png') && !rows.includes('IMG_00003.png'));
        },
    },
    {
        name: 'core cache: re-checking an unchanged folder emits no view change and keeps entry objects',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await page.evaluate(() => App.index.whenFresh());
            const r = await page.evaluate(async () => {
                await App.nav.go('big');
                await App.nav.whenFresh();
                const before = App.view.visible[5];
                let changed = 0;
                const off = App.bus.on('view:changed', () => changed++);
                const res = await App.nav.revalidate({ full: true });
                off();
                return { changed, same: App.view.visible[5] === before, res };
            });
            assert.equal(r.changed, 0);
            assert.equal(r.same, true);
            assert.equal(r.res.changed, false);
        },
    },
    {
        name: 'core cache: in-app rename, move, copy and trash patch the cached listings right away',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await page.evaluate(() => App.index.whenFresh());
            const rows = (dir) => page.evaluate(async (d) => ((await App.listCache._record(d)) || { rows: [] }).rows.map((r) => r[0]).sort(), dir);
            await page.evaluate(() => App.fs.rename('big/IMG_00001.png', 'renamed.png'));
            await page.evaluate(() => App.fs.move(['big/IMG_00002.png'], 'other'));
            await page.evaluate(() => App.fs.copy(['big/IMG_00004.png'], 'other'));
            await page.evaluate(() => App.fs.trash(['big/IMG_00005.png']));
            await page.evaluate(() => App.listCache.get('big')); // waits for pending patches
            const big = await rows('big');
            const other = await rows('other');
            assert.ok(big.includes('renamed.png') && !big.includes('IMG_00001.png'), 'rename');
            assert.ok(!big.includes('IMG_00002.png') && other.includes('IMG_00002.png'), 'move');
            assert.ok(big.includes('IMG_00004.png') && other.includes('IMG_00004.png'), 'copy');
            assert.ok(!big.includes('IMG_00005.png'), 'trash');
            // Sizes travel with moved rows (no extra stat needed)
            const moved = await page.evaluate(async () => (await App.listCache._record('other')).rows.find((r) => r[0] === 'IMG_00002.png'));
            assert.ok(moved[2] > 0 && moved[3] > 0);

            // Renamed to a non-media name: it leaves the cached listing (like it leaves a real listing)
            await page.evaluate(() => App.fs.rename('big/IMG_00006.png', 'IMG_00006.txt'));
            await page.evaluate(() => App.listCache.get('big'));
            assert.ok(!(await rows('big')).some((n) => n.startsWith('IMG_00006')));

            // Renaming a folder moves the cached listings below it
            await page.evaluate(() => App.fs.rename('trip', 'travel'));
            await page.evaluate(() => App.listCache.get(''));
            assert.equal(await page.evaluate(async () => !!(await App.listCache._record('trip/inner'))), false);
            assert.deepEqual(await rows('travel/inner'), ['y.png']);
            // Undo goes back the same way
            await page.evaluate(() => App.undo.undo());
            await page.evaluate(() => App.listCache.get(''));
            assert.deepEqual(await rows('trip/inner'), ['y.png']);
            // Opening the folder shows the patched listing at once
            await page.evaluate(() => App.nav.go('other'));
            assert.equal(await page.evaluate(() => App.nav.lastOpen.cached), true);
            assert.deepEqual((await names(page)).sort(), ['IMG_00002.png', 'IMG_00004.png', 'z.png']);
        },
    },
    {
        name: 'core cache: the current folder updates instantly after in-app changes, then F5 re-checks everything',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await page.evaluate(() => App.index.whenFresh());
            await page.evaluate(() => App.nav.go('big'));
            await page.evaluate(() => App.nav.whenFresh());
            await page.evaluate(() => App.fs.mkdir('big', '새 폴더'));
            await page.waitForFunction(() => App.view.indexOf('big/새 폴더') >= 0);
            await page.evaluate(() => App.fs.trash(['big/IMG_00007.png']));
            await page.waitForFunction(() => App.view.indexOf('big/IMG_00007.png') < 0);
            await outside(page, [{ path: 'big/LATE.png', add: 'late' }]);
            await page.evaluate(() => App.nav.reload());
            assert.ok((await names(page)).includes('LATE.png'), 'F5 resolves after the re-check');
        },
    },
    {
        name: 'core cache: switching workspaces never mixes cached listings',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: { 'same/a-only.png': { image: {} } } });
            await page.evaluate(() => App.index.whenFresh());
            await page.evaluate(() => App.nav.go('same'));
            assert.deepEqual(await names(page), ['a-only.png']);
            // A second workspace with a folder of the same name
            await page.evaluate(() => window.__seedWorkspace({ 'same/b-only.png': { bytes: [1, 2, 3] }, 'same/c.png': { bytes: [4] } }, 'ws2'));
            await page.evaluate(() => App.workspace.pick());
            await page.waitForFunction(() => App.state.workspace && App.state.workspace.name === 'ws2' && App.view.source.type === 'folder');
            await waitIdle(page);
            const r = await page.evaluate(async () => {
                const seen = [];
                const off = App.bus.on('view:changed', () => App.view.source.path === 'same' && seen.push(App.view.visible.map((e) => e.name)));
                await App.nav.go('same');
                await App.nav.whenFresh();
                off();
                return seen;
            });
            for (const list of r) assert.ok(!list.includes('a-only.png'), 'never shows the other workspace');
            assert.deepEqual((await names(page)).sort(), ['b-only.png', 'c.png']);
        },
    },
    {
        name: 'core cache: the library opens instantly from its snapshot after a reload; outside changes arrive after the re-check',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: SEED });
            await page.evaluate(() => App.index.whenFresh());
            await page.waitForTimeout(1800); // snapshot save is debounced
            await outside(page, [{ path: 'trip/inner/added-outside.png', add: 'x' }]);
            await page.reload();
            await page.waitForFunction(() => window.App && document.querySelector('#topbar').children.length > 0);
            await page.evaluate(() => window.__useExistingWorkspace());
            const r = await page.evaluate(async () => {
                const t0 = performance.now();
                const info = {};
                App.bus.once('index:ready', (e) => {
                    info.snapshot = e && e.snapshot;
                    info.readyMs = performance.now() - t0;
                    info.items = App.index.size;
                    info.fromSnapshot = App.index.fromSnapshot;
                    info.hitOld = App.index.search('IMG_00042').length;
                    info.hitNew = App.index.search('added-outside').length;
                });
                await App.workspace.pick();
                await App.index.whenReady();
                await App.index.whenFresh();
                info.hitNewAfter = App.index.search('added-outside').length;
                info.fresh = App.index.fresh;
                return info;
            });
            assert.equal(r.snapshot, true);
            assert.equal(r.fromSnapshot, true);
            assert.equal(r.items, 64);
            assert.equal(r.hitOld, 1, 'search works from the snapshot');
            assert.equal(r.hitNew, 0);
            assert.equal(r.hitNewAfter, 1, 'the background re-check finds outside changes');
            assert.equal(r.fresh, true);
            await waitIdle(page);
        },
    },
    {
        name: 'core cache: an entry that vanished behind the app is dropped on use; batches skip it and report',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await page.evaluate(() => App.index.whenFresh());
            await page.evaluate(() => App.nav.go('big'));
            await page.evaluate(() => App.nav.whenFresh());
            await outside(page, [{ path: 'big/IMG_00020.png', remove: true }, { path: 'big/IMG_00021.png', remove: true }]);
            // Opening a vanished file: error for the caller, then the listing is re-checked and a friendly note shown
            const code = await page.evaluate(() => App.fs.getFile('big/IMG_00020.png').then(() => null, (e) => e.code));
            assert.equal(code, 'ENOENT');
            await page.waitForFunction(() => App.view.indexOf('big/IMG_00020.png') < 0 && App.view.indexOf('big/IMG_00021.png') < 0);
            await page.waitForFunction(() => [...document.querySelectorAll('#toasts .toast-msg')].some((t) => t.textContent.includes('이미 없어졌어요')));
            // A batch with one vanished item finishes the rest and says what it skipped
            await outside(page, [{ path: 'big/IMG_00030.png', remove: true }]);
            const ids = await page.evaluate(() => App.fs.trash(['big/IMG_00030.png', 'big/IMG_00031.png']));
            assert.equal(ids.length, 1);
            assert.ok(await page.evaluate(() => window.__opfs.exists('big/IMG_00031.png').then((x) => !x)));
            await page.waitForFunction(() => [...document.querySelectorAll('#toasts .toast-msg')].some((t) => t.textContent.includes('건너뛰었어요')));
            await page.waitForFunction(() => App.view.indexOf('big/IMG_00030.png') < 0);
            // Undo brings back only what was really trashed
            await page.evaluate(() => App.undo.undo());
            assert.ok(await page.evaluate(() => window.__opfs.exists('big/IMG_00031.png')));
        },
    },
    {
        name: 'core cache: swapped names keep their own sizes; a folder deleted outside sends you up once re-checked',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { ...SEED, 'swap/small.png': { bytes: [1] }, 'swap/large.png': { bytes: [1, 2, 3, 4, 5, 6, 7, 8] } } });
            await page.evaluate(() => App.index.whenFresh());
            await page.evaluate(() => App.fs.renameMany([{ path: 'swap/small.png', name: 'large.png' }, { path: 'swap/large.png', name: 'small.png' }]));
            await page.evaluate(() => App.listCache.get('swap'));
            const sizes = await page.evaluate(async () => Object.fromEntries((await App.listCache._record('swap')).rows.map((r) => [r[0], r[2]])));
            assert.deepEqual(sizes, { 'large.png': 1, 'small.png': 8 });

            await outside(page, [{ path: 'trip', remove: true }]);
            await page.evaluate(() => App.nav.go('trip/inner'));
            assert.equal(await page.evaluate(() => App.nav.lastOpen.cached), true, 'the cached listing shows first');
            await page.waitForFunction(() => App.state.cwd === '' && App.view.indexOf('trip') < 0, null, { timeout: 8000 });
            assert.equal(await page.evaluate(async () => !!(await App.listCache._record('trip/inner'))), false, 'its cache is forgotten');
        },
    },
    {
        name: 'core cache: a server-style backend (listings with sizes) is cached and re-checked without extra stats',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: SEED });
            await page.evaluate(async () => {
                // Like js/core/fs-server.js: list() ignores { stat: false } and always reports size + mtime
                class StatListing extends App.fs.BrowserBackend {
                    constructor(root) {
                        super(root);
                        this.kind = 'server';
                        this.stats = 0;
                    }
                    list(dir) {
                        return super.list(dir, { stat: true });
                    }
                    stat(p) {
                        this.stats++;
                        return super.stat(p);
                    }
                }
                window.__sb = new StatListing(window.__fakeRoot);
                await App.workspace.openBackend(window.__sb);
            });
            await page.waitForFunction(() => App.state.workspace?.kind === 'server' && App.view.source.type === 'folder');
            await waitIdle(page);
            await page.evaluate(() => App.index.whenFresh());
            await outside(page, [{ path: 'trip/srv-new.png', add: 'abc' }]);
            const r = await page.evaluate(async () => {
                await App.nav.go('trip');
                const cached = App.nav.lastOpen.cached;
                const before = window.__sb.stats;
                await App.nav.whenFresh();
                const rec = await App.listCache._record('trip');
                return { cached, extraStats: window.__sb.stats - before, names: App.view.visible.map((e) => e.name), fullyChecked: Date.now() - rec.statAt < 5000 };
            });
            assert.equal(r.cached, true);
            assert.ok(r.names.includes('srv-new.png'));
            assert.equal(r.extraStats, 0, 'sizes come with the listing');
            assert.equal(r.fullyChecked, true, 'a listing with sizes counts as a full check');
        },
    },
    {
        name: 'core select: Shift-ranges survive refreshes (anchor gone → focus, nearest selected, last index; renames followed)',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: SEED });
            await page.evaluate(() => App.nav.go('big'));
            await waitIdle(page);
            const p = (n) => `big/IMG_${String(n).padStart(5, '0')}.png`;
            // Anchor renamed in the app: the anchor follows
            const r1 = await page.evaluate(async (a) => {
                App.select.set([a], { focus: a, anchor: a });
                await App.fs.rename(a, 'AAA.png');
                return App.select.anchor;
            }, p(10));
            assert.equal(r1, 'big/AAA.png');
            await page.waitForFunction(() => App.view.indexOf('big/AAA.png') >= 0);

            // Anchor deleted outside + re-check → range starts at the focus
            await page.evaluate(({ a, f }) => App.select.set([a, f], { focus: f, anchor: a }), { a: p(20), f: p(22) });
            await outside(page, [{ path: p(20), remove: true }]);
            await page.evaluate(() => App.nav.revalidate());
            await page.evaluate(() => App.nav.whenFresh());
            const r3 = await page.evaluate((t) => {
                App.select.range(t);
                return App.select.list();
            }, p(25));
            assert.deepEqual(r3, [p(22), p(23), p(24), p(25)]);

            // Anchor and focus gone: nearest selected item
            const r4 = await page.evaluate(
                ({ s1, s2, t }) => {
                    App.select.paths = new Set([s1, s2]);
                    App.select.focus = null;
                    App.select.anchor = 'big/gone.png';
                    App.select.range(t);
                    return App.select.list();
                },
                { s1: p(40), s2: p(50), t: p(48) },
            );
            assert.deepEqual(r4, [p(48), p(49), p(50)]);

            // Nothing left at all: the anchor's last index is used (no silent single select)
            const r5 = await page.evaluate(
                async ({ a, t }) => {
                    App.select.set([a], { focus: a, anchor: a });
                    const idx = App.view.indexOf(a);
                    await App.fs.trash([a], { silent: true });
                    await new Promise((r) => setTimeout(r, 400));
                    App.select.paths = new Set();
                    App.select.focus = null;
                    App.select.range(t);
                    return { idx, list: App.select.list().length, first: App.select.list()[0], anchor: App.select.anchor };
                },
                { a: p(30), t: p(33) },
            );
            // IMG_00030 sat at r5.idx; the item now at that index becomes the anchor → range of 3 (31, 32, 33)
            assert.equal(r5.list, 3, `range kept (${JSON.stringify(r5)})`);
            assert.equal(r5.first, r5.anchor);
            assert.equal(r5.first, p(31));
        },
    },
];
