// Gallery team (round 2): input must never get lost while background work refreshes the grid.
// Owner: '갤러리에서 폴더 다중 선택이 안 돼', 'Shift로 처음과 끝을 선택해도 범위 선택이 안 돼'.
// Root cause: cards were removed and rebuilt while thumbnails / folder stats / media info arrived, so a click whose
// mousedown and mouseup straddled a rebuild landed on the canvas and was lost. These tests run with background
// thumbnail pre-generation ON (off by default in tests) and with a "chaos refresh" that keeps invalidating everything.
'use strict';

const FOLDERS = {};
for (let k = 1; k <= 8; k++) FOLDERS[`폴더${k}/`] = { bulk: { count: 60, image: { color: `hsl(${k * 40},60%,45%)` } } };

/** Client point inside visible item i, from layout geometry */
function itemPoint(page, i, fx = 0.5, fy = 0.4) {
    return page.evaluate(([i, fx, fy]) => {
        const r = App.gallery.itemRect(i);
        const c = document.getElementById('gallery').getBoundingClientRect();
        return { x: c.left + r.x + r.w * fx, y: c.top + r.y + r.h * fy, left: c.left + r.x, top: c.top + r.y, w: r.w, h: r.h };
    }, [i, fx, fy]);
}

const selection = (page) => page.evaluate(() => App.select.list());
const pathsAt = (page, idx) => page.evaluate((ix) => ix.map((i) => App.view.visible[i].path), idx);

/** A human click: press, hold a moment (background work keeps running), release */
async function slowClick(page, pt, { modifiers = [], hold = 90 } = {}) {
    for (const m of modifiers) await page.keyboard.down(m);
    await page.mouse.move(pt.x, pt.y);
    await page.mouse.down();
    await page.waitForTimeout(hold);
    await page.mouse.up();
    for (const m of modifiers) await page.keyboard.up(m);
}

/** Count item elements that were removed while their path is still listed (= rebuilt, not scrolled out) */
function watchRebuilds(page) {
    return page.evaluate(() => {
        const w = (window.__rebuilds = { count: 0, paths: [], obs: null });
        w.obs = new MutationObserver((muts) => {
            for (const m of muts) {
                for (const n of m.removedNodes) {
                    if (n.nodeType !== 1 || !n.dataset || !n.dataset.path || !(n.classList.contains('card') || n.classList.contains('lrow'))) continue;
                    if (App.view.indexOf(n.dataset.path) >= 0 && App.gallery.cardFor(n.dataset.path) !== n) {
                        w.count++;
                        w.paths.push(n.dataset.path);
                    }
                }
            }
        });
        w.obs.observe(document.getElementById('gallery'), { childList: true });
    });
}

/** Background "chaos": invalidate every rendered item and re-run the view every 40–120 ms */
function startChaos(page) {
    return page.evaluate(() => {
        let stop = false;
        window.__chaos = { ticks: 0, stop: () => (stop = true) };
        (function tick() {
            if (stop) return;
            const paths = [];
            App.gallery.forEachRendered((el, p) => paths.push(p));
            App.gallery.invalidate(paths);
            App.view.recompute('patch');
            window.__chaos.ticks++;
            setTimeout(tick, 40 + Math.random() * 80);
        })();
    });
}
const stopChaos = (page) => page.evaluate(() => window.__chaos && window.__chaos.stop());

async function pregenerateFromScratch(page) {
    await page.evaluate(async () => {
        await App.thumbs.clearCache();
        App.settings.set('thumbs.autoPregenerate', true);
    });
}

module.exports = [
    {
        name: 'Ctrl+click selects every folder card while thumbnails are pre-generated (no lost clicks, no rebuilds)',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: FOLDERS });
            await page.waitForFunction(() => App.view.visible.length === 8 && App.index.ready);
            await watchRebuilds(page);
            await pregenerateFromScratch(page);
            await page.evaluate(() => {
                window.__evlog = [];
                const d = (t) => (t && t.closest && t.closest('[data-path]')?.dataset.path) || (t && (t.id || t.className || t.tagName));
                for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) window.addEventListener(type, (e) => window.__evlog.push(`${type}:${d(e.target)}`), true);
                App.bus.on('selection:changed', ({ paths }) => window.__evlog.push(`sel:${paths.length}`));
                new MutationObserver((ms) => {
                    for (const m of ms) for (const n of m.removedNodes) window.__evlog.push(`rm:${d(m.target)}:${n.className || n.nodeName}`);
                }).observe(document.getElementById('gallery'), { childList: true, subtree: true });
            });
            const paths = await pathsAt(page, [0, 1, 2, 3, 4, 5, 6, 7]);
            await slowClick(page, await itemPoint(page, 0));
            for (let i = 1; i < 8; i++) await slowClick(page, await itemPoint(page, i), { modifiers: ['Control'] });
            const sel0 = await selection(page);
            if (sel0.length !== 8) console.log(await page.evaluate(() => window.__evlog.join(' ') + ' ' + JSON.stringify(App.gallery.stats) + ' ' + (window.__gdbg || []).join(' ')));
            assert.deepEqual(sel0, paths, 'every Ctrl+click lands');
            // Ctrl+click again toggles off, Shift+click picks a range from the anchor
            await slowClick(page, await itemPoint(page, 3), { modifiers: ['Control'] });
            assert.ok(!(await selection(page)).includes(paths[3]), 'Ctrl+click toggles a folder off');
            await slowClick(page, await itemPoint(page, 1));
            await slowClick(page, await itemPoint(page, 6), { modifiers: ['Shift'] });
            assert.deepEqual(await selection(page), paths.slice(1, 7), 'Shift+click selects the range');
            const rebuilds = await page.evaluate(() => window.__rebuilds);
            assert.equal(rebuilds.count, 0, `folder cards are updated in place (rebuilt: ${rebuilds.paths.slice(0, 8).join(', ')})`);
            assert.ok(await page.evaluate(() => App.gallery.stats.morphed > 0), 'background work really updated cards meanwhile');
        },
    },
    {
        name: 'a click survives its card element being swapped between mousedown and mouseup (safety net)',
        async run({ openApp, assert }) {
            const seed = {};
            for (let i = 1; i <= 8; i++) seed[`p${i}.png`] = { image: { w: 64, h: 48 } };
            const { page } = await openApp({ seed });
            for (const mode of ['grid', 'list']) {
                await page.evaluate((m) => App.gallery.setMode(m), mode);
                await page.waitForTimeout(80);
                const all = await page.evaluate(() => App.view.visible.map((e) => e.path));
                const swapDuringClick = async (i, modifiers = []) => {
                    const pt = await itemPoint(page, i, mode === 'list' ? 0.3 : 0.5, 0.5);
                    for (const m of modifiers) await page.keyboard.down(m);
                    await page.mouse.move(pt.x, pt.y);
                    await page.mouse.down();
                    // What the old code did on every background refresh: throw the element away and build a new one
                    await page.evaluate((p) => {
                        const el = App.gallery.cardFor(p);
                        el.replaceWith(el.cloneNode(true));
                    }, all[i]);
                    await page.mouse.up();
                    for (const m of modifiers) await page.keyboard.up(m);
                };
                const before = await page.evaluate(() => {
                    window.__evlog = [];
                    const d = (t) => (t && t.closest && t.closest('[data-path]')?.dataset.path) || (t && (t.id || t.className || t.tagName));
                    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) window.addEventListener(type, (e) => window.__evlog.push(`${type}:${d(e.target)}`), true);
                    App.bus.on('selection:changed', ({ paths }) => window.__evlog.push(`sel:${paths.join('+')}`));
                    return App.gallery.stats.recovered;
                });
                await swapDuringClick(1);
                await swapDuringClick(3, ['Control']);
                await swapDuringClick(5, ['Shift']);
                await page.waitForTimeout(50);
                const got = await selection(page);
                if (got.join() !== all.slice(3, 6).join()) console.log(await page.evaluate(() => window.__evlog.join(' ')));
                assert.deepEqual(got, all.slice(3, 6), `${mode}: plain, Ctrl and Shift clicks all landed`);
                assert.ok((await page.evaluate(() => App.gallery.stats.recovered)) > before, `${mode}: the safety net did the work`);
                await page.evaluate(() => {
                    App.select.clear();
                    App.gallery.setMode(App.gallery.mode === 'grid' ? 'list' : 'grid'); // rebuild for real (drop the clones)
                    App.gallery.setMode(App.gallery.mode === 'grid' ? 'list' : 'grid');
                });
            }
            // A double-click whose second click is dropped the same way still opens the folder (once)
            await page.evaluate(() => App.gallery.setMode('grid'));
            await page.evaluate(() => App.fs.mkdir('', '폴더'));
            await page.waitForFunction(() => App.view.indexOf('폴더') >= 0);
            const pt = await itemPoint(page, await page.evaluate(() => App.view.indexOf('폴더')));
            await page.mouse.move(pt.x, pt.y);
            await page.mouse.down();
            await page.mouse.up();
            await page.mouse.down({ clickCount: 2 });
            await page.evaluate(() => {
                const el = App.gallery.cardFor('폴더');
                el.replaceWith(el.cloneNode(true));
            });
            await page.mouse.up({ clickCount: 2 });
            await page.waitForFunction(() => App.state.cwd === '폴더', null, { timeout: 5000 });
            await page.waitForTimeout(300);
            assert.equal(await page.evaluate(() => App.nav.back.length), 1, 'opened exactly once');
        },
    },
    {
        name: 'Shift ranges after scrolling and Ctrl / Ctrl+Shift clicks land during pre-generation (grid and list)',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'pics/': { bulk: { count: 300 } } } });
            await page.evaluate(() => App.nav.go('pics'));
            await page.waitForFunction(() => App.view.visible.length === 300);
            await pregenerateFromScratch(page);
            for (const mode of ['grid', 'list']) {
                await page.evaluate((m) => App.gallery.setMode(m), mode);
                await page.evaluate(() => (document.getElementById('gallery-scroll').scrollTop = 0));
                await page.waitForTimeout(80);
                const all = await page.evaluate(() => App.view.visible.map((e) => e.path));
                const at = (i) => itemPoint(page, i, mode === 'list' ? 0.3 : 0.5, 0.5);
                // Click an item, wheel down like a person, Shift+click far below
                await slowClick(page, await at(2));
                assert.deepEqual(await selection(page), [all[2]], `${mode}: plain click`);
                const mid = await page.evaluate(() => {
                    const r = document.getElementById('gallery-scroll').getBoundingClientRect();
                    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
                });
                await page.mouse.move(mid.x, mid.y);
                for (let k = 0; k < 10; k++) {
                    await page.mouse.wheel(0, 400);
                    await page.waitForTimeout(40);
                }
                await page.evaluate(() => App.thumbs.invalidate(App.view.visible.map((e) => e.path))); // more background churn
                const target = await page.evaluate(() => {
                    const c = document.getElementById('gallery').getBoundingClientRect();
                    const sr = document.getElementById('gallery-scroll').getBoundingClientRect();
                    for (let i = App.view.visible.length - 1; i >= 0; i--) {
                        const r = App.gallery.itemRect(i);
                        const top = c.top + r.y;
                        if (top + r.h * 0.5 < sr.bottom - 10 && top > sr.top + 40) return i; // last item comfortably on screen
                    }
                    return -1;
                });
                assert.ok(target > 40, `${mode}: scrolled far enough (${target})`);
                await slowClick(page, await at(target), { modifiers: ['Shift'], hold: 120 });
                assert.deepEqual(await selection(page), all.slice(2, target + 1), `${mode}: Shift+click after scrolling selects the whole range`);
                // Ctrl toggles one off and another one off
                await slowClick(page, await at(target - 1), { modifiers: ['Control'] });
                await slowClick(page, await at(target - 3), { modifiers: ['Control'] });
                let sel = await selection(page);
                assert.ok(!sel.includes(all[target - 1]) && !sel.includes(all[target - 3]) && sel.includes(all[target - 2]), `${mode}: Ctrl toggles`);
                // Ctrl+Shift adds the range from the last Ctrl+click without dropping the rest
                await slowClick(page, await at(target - 1), { modifiers: ['Control', 'Shift'] });
                sel = await selection(page);
                assert.ok(sel.includes(all[2]) && sel.includes(all[target - 3]) && sel.includes(all[target - 1]) && sel.includes(all[target]), `${mode}: Ctrl+Shift adds the range`);
                await page.evaluate(() => App.select.clear());
            }
        },
    },
    {
        name: 'chaos refresh: clicks, checkbox, lasso, context menu, rename and drag keep working (grid and list)',
        async run({ openApp, assert }) {
            const seed = { 'box/': null };
            for (let i = 1; i <= 30; i++) seed[`p${String(i).padStart(2, '0')}.png`] = { image: { w: 64, h: 48, color: `hsl(${i * 12},60%,45%)` } };
            const { page } = await openApp({ seed });
            await page.waitForFunction(() => App.view.visible.length === 31 && App.index.ready);
            await watchRebuilds(page);
            await startChaos(page);
            for (const mode of ['grid', 'list']) {
                await page.evaluate((m) => App.gallery.setMode(m), mode);
                await page.waitForTimeout(100);
                await page.evaluate(() => (window.__rebuilds.count = 0));
                const all = await page.evaluate(() => App.view.visible.map((e) => e.path)); // [box, p01…p30]
                const at = (i) => itemPoint(page, i, mode === 'list' ? 0.3 : 0.5, 0.5);
                const hold = () => 40 + Math.floor(Math.random() * 120);
                await slowClick(page, await at(2), { hold: hold() });
                assert.deepEqual(await selection(page), [all[2]], `${mode}: plain`);
                await slowClick(page, await at(5), { modifiers: ['Control'], hold: hold() });
                assert.deepEqual(await selection(page), [all[2], all[5]], `${mode}: Ctrl`);
                await slowClick(page, await at(8), { modifiers: ['Shift'], hold: hold() });
                assert.deepEqual(await selection(page), all.slice(5, 9), `${mode}: Shift`);
                await slowClick(page, await at(1), { modifiers: ['Control'], hold: hold() });
                await slowClick(page, await at(3), { modifiers: ['Control', 'Shift'], hold: hold() });
                assert.deepEqual(await selection(page), [...all.slice(1, 4), ...all.slice(5, 9)], `${mode}: Ctrl+Shift`);
                if (mode === 'grid') {
                    // The round checkbox toggles without touching the rest
                    const ck = await page.evaluate((p) => {
                        const r = App.gallery.cardFor(p).querySelector('.card-check').getBoundingClientRect();
                        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
                    }, all[12]);
                    await page.mouse.move(ck.x, ck.y);
                    await slowClick(page, ck, { hold: hold() });
                    const sel = await selection(page);
                    assert.ok(sel.includes(all[12]) && sel.includes(all[1]), 'grid: checkbox adds');
                    // Lasso from the empty padding over the first two items
                    const p0 = await at(0);
                    const p1 = await at(1);
                    await page.mouse.move(p0.left - 8, p0.top - 8);
                    await page.mouse.down();
                    await page.mouse.move(p1.x, p1.y, { steps: 6 });
                    await page.waitForTimeout(90);
                    await page.mouse.up();
                    assert.deepEqual(await selection(page), all.slice(0, 2), 'grid: lasso');
                }
                // Context menu target + rename from it
                const target = await page.evaluate((n) => App.view.indexOf(n), mode === 'grid' ? 'p09.png' : 'p10.png'); // not selected: a right-click on a selected item keeps the selection
                const pt = await at(target);
                await page.mouse.move(pt.x, pt.y);
                await page.mouse.down({ button: 'right' });
                await page.waitForTimeout(hold());
                await page.mouse.up({ button: 'right' });
                await page.waitForSelector('.menu');
                assert.deepEqual(await selection(page), [all[target]], `${mode}: the context menu is for the pressed item`);
                await page.waitForTimeout(150);
                await page.click('.menu .menu-item:has-text("이름 바꾸기")');
                await page.waitForSelector('.dialog input.input');
                assert.equal(await page.inputValue('.dialog input.input'), all[target], `${mode}: renaming the right item`);
                await page.waitForTimeout(200);
                const newName = `renamed-${mode}.png`;
                await page.keyboard.press('Control+a');
                await page.keyboard.type(newName);
                await page.keyboard.press('Enter');
                await page.waitForFunction((n) => window.__opfs.exists(n), newName);
                await page.waitForFunction((n) => App.view.indexOf(n) >= 0, newName);
                // F2 on a clicked item
                const k = await page.evaluate(() => App.view.indexOf('p13.png'));
                await slowClick(page, await at(k), { hold: hold() });
                await page.keyboard.press('F2');
                await page.waitForSelector('.dialog input.input');
                assert.equal(await page.inputValue('.dialog input.input'), 'p13.png', `${mode}: F2 renames the clicked item`);
                await page.keyboard.press('Escape');
                await page.waitForSelector('.dialog', { state: 'detached' });
                // Drag an item onto the folder while everything keeps refreshing
                // (list rows are dragged by their thumbnail or name; the empty part of a row starts a lasso)
                const from = mode === 'grid' ? await at(await page.evaluate(() => App.view.indexOf('p11.png'))) : await page.evaluate(() => {
                    const r = App.gallery.cardFor('p11.png').querySelector('.lr-name').getBoundingClientRect();
                    return { x: r.left + 12, y: r.top + r.height / 2 };
                });
                const to = await at(0);
                await page.mouse.move(from.x, from.y);
                await page.mouse.down();
                await page.waitForTimeout(hold());
                await page.mouse.move(to.x, to.y, { steps: 10 });
                for (let n = 0; n < 40 && !(await page.isVisible('#gallery .drop-label')); n++) {
                    await page.mouse.move(to.x + (n % 2), to.y);
                    await page.waitForTimeout(50);
                }
                await page.mouse.up();
                // The move finished: the file is in the folder and the listing no longer shows it
                await page.waitForFunction(async () => (await window.__opfs.exists('box/p11.png')) && App.view.indexOf('p11.png') < 0, null, { timeout: 8000 });
                await page.evaluate(() => App.fs.move(['box/p11.png'], '')); // put it back for the next mode
                await page.waitForFunction(() => App.view.indexOf('p11.png') >= 0);
                assert.equal(await page.evaluate(() => window.__rebuilds.count), 0, `${mode}: chaos never rebuilt an item element`);
            }
            const ticks = await page.evaluate(() => window.__chaos.ticks);
            await stopChaos(page);
            assert.ok(ticks > 20, `chaos actually ran (${ticks} ticks)`);
        },
    },
    {
        name: 'a held click freezes the card under it (no rebuild, no move) and updates apply on release',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: FOLDERS });
            await page.waitForFunction(() => App.view.visible.length === 8 && App.index.ready);
            await pregenerateFromScratch(page);
            await startChaos(page);
            for (const i of [0, 3, 6]) {
                const pt = await itemPoint(page, i);
                await page.mouse.move(pt.x, pt.y);
                await page.mouse.down();
                const busy = await page.evaluate((i) => {
                    const p = App.view.visible[i].path;
                    const el = App.gallery.cardFor(p);
                    window.__held = { el, p, transform: el.style.transform, muts: 0, flushes: App.gallery.stats.flushes };
                    window.__heldObs = new MutationObserver((ms) => (window.__held.muts += ms.filter((m) => m.type === 'childList').length));
                    window.__heldObs.observe(el, { childList: true, subtree: true });
                    return App.gallery.busy;
                }, i);
                assert.ok(busy, 'a press on a card holds background updates');
                await page.waitForTimeout(250);
                const held = await page.evaluate(() => {
                    const w = window.__held;
                    window.__heldObs.disconnect();
                    return { same: App.gallery.cardFor(w.p) === w.el && w.el.isConnected, moved: w.el.style.transform !== w.transform, muts: w.muts, flushes: App.gallery.stats.flushes - w.flushes };
                });
                await page.mouse.up();
                assert.deepEqual(held, { same: true, moved: false, muts: 0, flushes: 0 }, 'nothing touched the pressed card while the button was down');
                const f = await page.evaluate(() => window.__held.flushes);
                await page.waitForFunction((f) => App.gallery.stats.flushes > f && !App.gallery.busy, f);
            }
            // A long press never starves updates: they still apply after ~400 ms
            const pt = await itemPoint(page, 1);
            await page.mouse.move(pt.x, pt.y);
            await page.mouse.down();
            const f0 = await page.evaluate(() => App.gallery.stats.flushes);
            await page.waitForTimeout(900);
            const f1 = await page.evaluate(() => App.gallery.stats.flushes);
            await page.mouse.up();
            assert.ok(f1 > f0, `queued updates were forced through during a long press (${f0} -> ${f1})`);
            await stopChaos(page);
        },
    },
    {
        name: 'in-place updates keep loaded thumbnails and element identity (refresh, invalidate, patch, folder stats)',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'a.png': { image: {} }, 'b.png': { image: {} }, 'sub/c.png': { image: {} }, 'sub/d.png': { image: {} } } });
            await page.waitForSelector('.card[data-path="a.png"].has-thumb');
            await page.waitForSelector('.card[data-path="sub"] .mosaic-cell.has-thumb');
            const r = await page.evaluate(async () => {
                const frames = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
                const card = App.gallery.cardFor('a.png');
                const img = card.querySelector('img.card-img');
                const folder = App.gallery.cardFor('sub');
                const cell = folder.querySelector('.mosaic-cell img');
                const built = App.gallery.stats.built;
                App.gallery.refresh();
                App.gallery.invalidate(['a.png', 'sub']);
                App.view.recompute('patch');
                App.bus.emit('thumbs:meta', { path: 'a.png', duration: 0 });
                await frames();
                await App.catalog.update('a.png', { rating: 4 });
                await frames();
                return {
                    sameCard: App.gallery.cardFor('a.png') === card,
                    sameImg: card.querySelector('img.card-img') === img,
                    stillThumb: card.classList.contains('has-thumb'),
                    sameFolder: App.gallery.cardFor('sub') === folder,
                    sameCell: folder.querySelector('.mosaic-cell img') === cell,
                    stars: card.querySelectorAll('.card-stars svg').length,
                    builtMore: App.gallery.stats.built > built,
                };
            });
            assert.deepEqual(r, { sameCard: true, sameImg: true, stillThumb: true, sameFolder: true, sameCell: true, stars: 4, builtMore: true });
            // Folder stats follow file operations in place: moving a file in updates the count line of the same element
            const folder = await page.evaluateHandle(() => App.gallery.cardFor('sub'));
            await page.evaluate(() => App.fs.move(['b.png'], 'sub'));
            await page.waitForFunction(() => /^사진 3/.test(document.querySelector('.card[data-path="sub"] .card-sub')?.textContent || ''));
            assert.ok(await page.evaluate((el) => el.isConnected && App.gallery.cardFor('sub') === el, folder), 'the folder card was updated, not replaced');
        },
    },
    {
        name: 'hover preview survives background refreshes and ends only when its card leaves the pointer',
        async run({ openApp, assert }) {
            const { helpers } = require('./gallery.test.js');
            const seed = { 'c-clip.webm': { video: { seconds: 1 } } };
            for (let i = 1; i <= 6; i++) seed[`p${i}.png`] = { image: { w: 64, h: 48 } };
            const { page } = await openApp({ seed });
            assert.notEqual(await helpers.ensurePlayableClip(page, 'c-clip.webm'), 'failed', 'could not get a playable test clip');
            await page.waitForFunction(() => (App.view.get('c-clip.webm')?.size || 0) > 1000);
            const playing = () => page.evaluate(() => {
                const v = document.querySelector('#gallery video.card-scrub-video');
                return !!v && v.isConnected && !v.paused && v.closest('.card')?.dataset.path === 'c-clip.webm';
            });
            const hover = async () => {
                const i = await page.evaluate(() => App.view.indexOf('c-clip.webm'));
                const pt = await itemPoint(page, i, 0.5, 0.35);
                await page.mouse.move(pt.x - 6, pt.y);
                await page.mouse.move(pt.x, pt.y);
                for (let k = 0; k < 60 && !(await playing()); k++) {
                    await page.mouse.move(pt.x + (k % 2), pt.y);
                    await page.waitForTimeout(100);
                }
                assert.ok(await playing(), 'the hovered clip plays');
            };
            await hover();
            const card = await page.evaluateHandle(() => App.gallery.cardFor('c-clip.webm'));
            for (let round = 0; round < 3; round++) {
                await page.evaluate(() => {
                    App.view.recompute('patch');
                    App.gallery.refresh();
                    App.gallery.invalidate(['c-clip.webm']);
                    App.bus.emit('thumbs:meta', { path: 'c-clip.webm', duration: 1 });
                    App.view.recompute('refresh');
                });
                await page.waitForTimeout(250); // the pointer rests: no mouse move re-starts anything
                assert.ok(await playing(), `still playing after background refresh #${round + 1}`);
            }
            assert.ok(await page.evaluate((el) => App.gallery.cardFor('c-clip.webm') === el, card), 'same card element');
            // A re-sort that puts another card under the resting pointer ends the preview
            await page.evaluate(() => App.view.setSort('name', 'desc'));
            await page.waitForFunction(() => !document.querySelector('#gallery video.card-scrub-video') && !document.querySelector('.card.scrubbing'));
            // Hover it again at its new place, then filter it away
            await page.evaluate(() => App.view.setSort('name', 'asc'));
            await hover();
            await page.evaluate(() => App.view.setFilter('photos-only', { label: '사진만', test: (e) => e.type !== 'video' }));
            await page.waitForFunction(() => !document.querySelector('#gallery video.card-scrub-video'));
            await page.evaluate(() => App.view.setFilter('photos-only', null));
        },
    },
    {
        name: 'a background re-sort keeps the first visible item in place and offers a pill instead of jumping',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'pics/': { bulk: { count: 240 } } } });
            await page.evaluate(() => App.nav.go('pics'));
            await page.waitForFunction(() => App.view.visible.length === 240);
            await slowClick(page, await itemPoint(page, 1));
            const focus = await page.evaluate(() => App.select.focus);
            await page.evaluate(() => (document.getElementById('gallery-scroll').scrollTop = 1800));
            await page.waitForTimeout(1300); // no user input for a while: the next re-sort counts as background work
            const before = await page.evaluate(() => {
                const s = document.getElementById('gallery-scroll').getBoundingClientRect();
                const els = [...document.querySelectorAll('#gallery > .card')].map((el) => ({ p: el.dataset.path, r: el.getBoundingClientRect() }));
                const vis = els.filter((x) => x.r.bottom > s.top + 1).sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);
                return { p: vis[0].p, top: Math.round(vis[0].r.top) };
            });
            // The anchor item keeps its height on screen (its column may change with the new order)
            const topOf = (p) => page.evaluate((p) => {
                const el = App.gallery.cardFor(p);
                return el ? Math.round(el.getBoundingClientRect().top) : null;
            }, p);
            await page.evaluate(() => {
                // What thumbs.js does after reading media info: same sort key, new order, no user input
                App.view.registerSortKey('test-rev', '테스트', (e) => -Number(e.name.match(/\d+/)[0]));
                App.view.sort = { key: 'test-rev', dir: 'asc' };
                App.view.recompute('sort');
            });
            await page.waitForTimeout(150);
            const after = await topOf(before.p);
            assert.ok(after != null && Math.abs(after - before.top) < 4, `the item at the top stays at the same height (${before.top} -> ${after})`);
            await page.waitForSelector('.sort-pill.show');
            assert.equal(await page.evaluate(() => App.select.focus), focus, 'the selection is kept');
            assert.match(await page.textContent('.sort-pill'), /정렬이 바뀌었어요.*선택한 곳으로/);
            await page.click('.sort-pill .sp-go');
            await page.waitForSelector('.sort-pill:not(.show)', { state: 'attached' });
            const inView = (p) => page.evaluate((p) => {
                const el = App.gallery.cardFor(p);
                if (!el) return false;
                const r = el.getBoundingClientRect();
                const s = document.getElementById('gallery-scroll').getBoundingClientRect();
                return r.bottom > s.top && r.top < s.bottom;
            }, p);
            await page.waitForFunction((p) => !!App.gallery.cardFor(p), focus);
            assert.ok(await inView(focus), 'the pill scrolls to the focused item');
            // A sort the user asks for (input just now) still brings the focused item into view
            await page.evaluate(() => (document.getElementById('gallery-scroll').scrollTop = 3000));
            await page.waitForTimeout(100);
            assert.ok(!(await inView(focus)));
            await page.keyboard.press('Shift');
            await page.evaluate(() => App.view.setSort('name', 'asc'));
            await page.waitForTimeout(150);
            assert.ok(!(await page.isVisible('.sort-pill.show')), 'no pill for a user sort');
            assert.ok(await inView(focus), 'a user sort scrolls to the focused item');
        },
    },
];
