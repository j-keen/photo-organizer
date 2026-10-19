// Chips team, part 2: Ctrl+Z / Ctrl+Y round trips for every kind of chip edit from the gallery and the viewer,
// sidebar "빼고" (Alt+click), memo bursts, autofill's default parent, the HUD never covering dialogs, and the
// inspector preview following the viewer's view-only rotation / flip. (Model + UI basics: chipset.test.js)
'use strict';

const SEED = {
    'a.png': { image: { label: 'A', color: '#b33' } },
    'b.png': { image: { label: 'B', color: '#3b3' } },
    'c.png': { image: { label: 'C', color: '#33b' } },
    'sub/e.png': { image: { label: 'E' } },
};

const INSP = '.chip-panel[data-panel="inspector"]';

async function setupChips(page) {
    await page.waitForFunction(() => App.chipset && App.chipset.ready);
    return page.evaluate(() => {
        const C = App.chipset;
        const actors = C.addCategory({ name: '배우', mode: 'search' });
        C.addChips(actors.id, ['김수현', '박보영']);
        const genre = C.addCategory({ name: '장르' });
        const [drama] = C.addChips(genre.id, ['드라마', '액션']);
        C.addChips(genre.id, ['로맨스'], { parentId: drama.id });
        const ids = Object.fromEntries(C.list().map((x) => [x.name, x.id]));
        ids.__actors = actors.id;
        ids.__genre = genre.id;
        return ids;
    });
}

const names = (page, p) => page.evaluate((x) => App.chipset.chipsOf(x).map((id) => App.chipset.nameOf(id)), p);
const undoLen = (page) => page.evaluate(() => App.undo.list().length);

module.exports = [
    {
        name: 'chips+: inline add (선택형) and every file edit round-trips with Ctrl+Z / Ctrl+Y in the gallery',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            const ids = await setupChips(page);
            await (await card(page, 'a.png')).click();
            // '+' in a 선택형 category: two chips at once, ONE undo step for the structure edit
            const n0 = await undoLen(page);
            await page.click(`${INSP} .chip-cat[data-cat="${ids.__genre}"] > .chip-row .chip-add, ${INSP} .chip-cat[data-cat="${ids.__genre}"] .chip-add:not(.sub)`);
            await page.fill(`${INSP} .chip-add-input`, '코미디, 공포');
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => App.chipset.list().some((x) => x.name === '공포'));
            assert.equal(await undoLen(page), n0 + 1);
            await page.keyboard.press('Escape');
            await page.click('#gallery-scroll', { position: { x: 600, y: 600 } });
            await (await card(page, 'a.png')).click();
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => !App.chipset.list().some((x) => x.name === '공포' || x.name === '코미디'));
            await page.keyboard.press('Control+y');
            await page.waitForFunction(() => App.chipset.list().filter((x) => x.name === '공포' || x.name === '코미디').length === 2);
            // Chip click → Ctrl+Z → Ctrl+Y
            await page.click(`${INSP} .chip[data-chip="${ids['액션']}"]`);
            await page.waitForFunction(() => App.catalog.peek('a.png')?.chips?.length === 1);
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => !App.catalog.peek('a.png')?.chips?.length);
            await page.keyboard.press('Control+y');
            await page.waitForFunction(() => App.catalog.peek('a.png')?.chips?.length === 1);
            // Hotkey on a multi-selection → one step each way
            await page.evaluate((id) => App.chipset.setHotkey(id, 2), ids['박보영']);
            await (await card(page, 'c.png')).click({ modifiers: ['Shift'] });
            const n1 = await undoLen(page);
            await page.keyboard.press('2');
            await page.waitForFunction(() => ['a.png', 'b.png', 'c.png'].every((p) => App.catalog.peek(p)?.chips?.length >= 1) && App.catalog.peek('b.png').chips.length === 1);
            assert.equal(await undoLen(page), n1 + 1);
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => !App.catalog.peek('b.png')?.chips?.length && !App.catalog.peek('c.png')?.chips?.length);
            assert.deepEqual(await names(page, 'a.png'), ['액션']);
            await page.keyboard.press('Control+y');
            await page.waitForFunction(() => App.catalog.peek('c.png')?.chips?.length === 1);
            // Copy / paste chips and "remove all" are one step too
            await (await card(page, 'a.png')).click();
            await page.evaluate(() => App.commands.run('chips.copy'));
            await (await card(page, 'b.png')).click();
            const n2 = await undoLen(page);
            await page.evaluate(() => App.commands.run('chips.paste'));
            await page.waitForFunction(() => App.catalog.peek('b.png')?.chips?.length === 2);
            assert.equal(await undoLen(page), n2 + 1);
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => App.catalog.peek('b.png')?.chips?.length === 1);
        },
    },
    {
        name: 'chips+: a chip click right after picking another file tags THAT file (no stale panel, no lost click)',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            const ids = await setupChips(page);
            await (await card(page, 'a.png')).click();
            await page.waitForSelector(`${INSP} .chip[data-chip="${ids['액션']}"]`);
            // Same task: the selection changes and the (still a.png) panel's chip is clicked before the debounced refresh
            await page.evaluate((id) => {
                App.select.set(['b.png'], { focus: 'b.png' });
                document.querySelector(`.chip-panel[data-panel="inspector"] .chip[data-chip="${id}"]`).click();
            }, ids['액션']);
            await page.waitForFunction(() => App.catalog.peek('b.png')?.chips?.length === 1);
            assert.ok(!(await page.evaluate(() => App.catalog.peek('a.png')?.chips?.length)), 'the previously shown file is untouched');
            // A re-render between mousedown and mouseup still counts as a click on that chip
            await page.evaluate((id) => {
                const sel = `.chip-panel[data-panel="inspector"] .chip[data-chip="${id}"]`;
                const opts = { bubbles: true, cancelable: true, button: 0 };
                document.querySelector(sel).dispatchEvent(new MouseEvent('mousedown', opts));
                App.chipsPanel.rerenderAll();
                document.querySelector(sel).dispatchEvent(new MouseEvent('mouseup', opts));
            }, ids['드라마']);
            await page.waitForFunction(() => App.catalog.peek('b.png')?.chips?.length === 2);
            await page.waitForTimeout(100);
            assert.equal(await page.evaluate(() => App.catalog.peek('b.png').chips.length), 2, 'applied exactly once');
        },
    },
    {
        name: 'chips+: viewer — chips, stars and labels undo and redo without leaving the viewer',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            const ids = await setupChips(page);
            await page.evaluate((id) => App.chipset.setHotkey(id, 1), ids['드라마']);
            await (await card(page, 'b.png')).dblclick();
            await page.waitForSelector('#viewer:not([hidden]) .vw-media');
            await page.keyboard.press('1');
            await page.waitForFunction(() => App.catalog.peek('b.png')?.chips?.length === 1);
            await page.keyboard.press('Control+Alt+5');
            await page.waitForFunction(() => App.catalog.peek('b.png')?.rating === 5);
            await page.keyboard.press('Control+Alt+6');
            await page.waitForFunction(() => App.catalog.peek('b.png')?.label === 'red');
            for (const check of ['!App.catalog.peek("b.png")?.label', '!App.catalog.peek("b.png")?.rating', '!App.catalog.peek("b.png")?.chips?.length']) {
                await page.keyboard.press('Control+z');
                await page.waitForFunction(check);
            }
            await page.keyboard.press('Control+y');
            await page.waitForFunction(() => App.catalog.peek('b.png')?.chips?.length === 1);
            await page.keyboard.press('Control+Shift+z');
            await page.waitForFunction(() => App.catalog.peek('b.png')?.rating === 5);
            assert.ok(await page.isVisible('#viewer'), 'still in the viewer');
            // '#' picker in the viewer: initials, one step
            await page.keyboard.press('#');
            await page.waitForSelector('#chip-picker .chip-picker-input');
            await page.keyboard.type('ㄱㅅ');
            await page.waitForFunction((id) => document.querySelector('#chip-picker .chip-picker-row.active')?.dataset.chip === id, ids['김수현']);
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => App.catalog.peek('b.png')?.chips?.length === 2);
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => App.catalog.peek('b.png')?.chips?.length === 1);
            assert.ok(await page.isVisible('#viewer'));
        },
    },
    {
        name: 'chips+: sidebar filter — Alt+click excludes ("빼고"), works with 모든 폴더에서 보기',
        async run({ openApp, assert, cardNames }) {
            const { page } = await openApp({ seed: SEED });
            const ids = await setupChips(page);
            await page.waitForFunction(() => App.index.ready);
            await page.evaluate((x) => {
                App.chipset.apply(['a.png', 'sub/e.png'], x['드라마'], 'add', { hud: false });
                App.chipset.apply(['b.png'], x['액션'], 'add', { hud: false });
            }, ids);
            await page.waitForSelector(`.chipf-row[data-chip="${ids['드라마']}"]`);
            await page.click(`.chipf-row[data-chip="${ids['드라마']}"]`, { modifiers: ['Alt'] });
            await page.waitForFunction(() => App.view.filters.has('chips'));
            assert.deepEqual(await cardNames(page), ['sub', 'b.png', 'c.png'], 'files with 드라마 are hidden');
            await page.waitForSelector(`.chipf-row.ex[data-chip="${ids['드라마']}"]`);
            await page.click('.chipf-bar [data-action="everywhere"]');
            await page.waitForFunction(() => App.view.source.type === 'smart');
            assert.deepEqual((await cardNames(page)).sort(), ['b.png', 'c.png'], 'sub/e.png has 드라마 too');
            // Filters are navigation, not edits: nothing to undo
            assert.equal(await page.evaluate(() => App.undo.list().filter((e) => /필터/.test(e.label)).length), 0);
        },
    },
    {
        name: 'chips+: memo — one undo step per typing burst, a new burst after leaving the memo',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            await setupChips(page);
            await (await card(page, 'a.png')).click();
            const n0 = await undoLen(page);
            await page.click('.insp-memo-input');
            await page.keyboard.type('첫 줄');
            await page.waitForSelector('.insp-memo-state[data-state="saved"]');
            await page.keyboard.type(' 이어서');
            await page.waitForFunction(() => App.catalog.peek('a.png')?.memo === '첫 줄 이어서');
            await page.keyboard.press('Escape');
            assert.equal(await undoLen(page), n0 + 1, 'autosaves of one burst merge (coalesceKey memo:<path>)');
            await page.click('.insp-memo-input');
            await page.keyboard.press('End');
            await page.keyboard.type(' 둘째');
            await page.keyboard.press('Escape');
            await page.waitForFunction(() => App.catalog.peek('a.png')?.memo === '첫 줄 이어서 둘째');
            assert.equal(await undoLen(page), n0 + 2, 'leaving the memo ends the burst');
            assert.match(await page.evaluate(() => App.undo.list()[0].label), /메모 고치기 · a\.png/);
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => document.querySelector('.insp-memo-input').value === '첫 줄 이어서');
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => document.querySelector('.insp-memo-input').value === '' && !App.catalog.peek('a.png')?.memo);
            await page.keyboard.press('Control+y');
            await page.waitForFunction(() => document.querySelector('.insp-memo-input').value === '첫 줄 이어서');
        },
    },
    {
        name: 'chips+: autofill defaults to the folder with the most subfolders, even inside a folder that has several',
        async run({ openApp, assert }) {
            const seed = {
                '모음/배우/김수현/a.png': { image: {} },
                '모음/배우/박보영/b.png': { image: {} },
                '모음/배우/이민호/c.png': { image: {} },
                '모음/배우/전도연/f.png': { image: {} },
                '모음/기타/d.png': { image: {} },
                '모음/풍경/e.png': { image: {} },
            };
            const { page } = await openApp({ seed });
            await page.waitForFunction(() => App.chipset.ready && App.index.ready);
            await page.evaluate(() => App.nav.go('모음'));
            await page.waitForFunction(() => App.state.cwd === '모음');
            await page.evaluate(() => {
                App.commands.run('chips.autofill');
            });
            await page.waitForSelector('.dialog .af-row');
            assert.equal(await page.inputValue('.dialog .af-fields select'), '모음/배우');
            assert.match(await page.textContent('.dialog .af-summary'), /칩 4개/);
            await page.keyboard.press('Escape');
        },
    },
    {
        name: 'chips+: the HUD stays under menus and dialogs and stays hidden while a dialog is open',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            const ids = await setupChips(page);
            await page.evaluate(() => App.chipset.hud('테스트'));
            const z = await page.evaluate(() => {
                const z = (sel) => Number(getComputedStyle(document.querySelector(sel)).zIndex);
                const root = getComputedStyle(document.documentElement);
                return { hud: z('#chip-hud'), dialog: Number(root.getPropertyValue('--z-dialog')), menu: Number(root.getPropertyValue('--z-menu')), viewer: Number(root.getPropertyValue('--z-viewer')) };
            });
            assert.ok(z.hud > z.viewer && z.hud < z.menu && z.hud < z.dialog, JSON.stringify(z));
            // Deleting a used chip opens a confirm dialog: a HUD fired meanwhile must not show
            await page.evaluate((x) => App.chipset.apply(['a.png'], x['액션'], 'add', { hud: false }), ids);
            await (await card(page, 'a.png')).click();
            await page.click(`${INSP} .chip[data-chip="${ids['액션']}"]`, { button: 'right' });
            await page.click('.menu .menu-item:has-text("칩 삭제")');
            await page.waitForSelector('.dialog-backdrop');
            await page.evaluate(() => App.chipset.hud('겹치면 안 돼요'));
            assert.ok(!(await page.evaluate(() => document.querySelector('#chip-hud').classList.contains('show'))));
            await page.keyboard.press('Escape');
        },
    },
    {
        name: "chips+: inspector preview follows the viewer's view-only rotation / flip (90° swaps the fit box)",
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            await setupChips(page);
            // Feature-detected API: object form { rot, flipH, flipV } (and a CSS string form)
            await page.evaluate(() => {
                window.__xf = {};
                App.viewer.transformOf = (p) => window.__xf[p] || { rot: 0, flipH: false, flipV: false };
            });
            await (await card(page, 'a.png')).click();
            await page.waitForSelector('.insp-preview.ready .insp-img');
            assert.ok(!(await page.evaluate(() => document.querySelector('.insp-preview').classList.contains('xf'))));
            await page.evaluate(() => {
                window.__xf['a.png'] = { rot: 90, flipH: true, flipV: false };
                App.catalog.update('a.png', (e) => (e.meta = { ...(e.meta || {}), rot: 90, flipH: true }), { undoable: false });
            });
            await page.waitForSelector('.insp-preview.xf.xf-swap');
            const r = await page.evaluate(() => {
                const box = document.querySelector('.insp-preview').getBoundingClientRect();
                const img = document.querySelector('.insp-img');
                return { bw: box.width, bh: box.height, iw: img.offsetWidth, ih: img.offsetHeight, tf: getComputedStyle(img).transform };
            });
            assert.ok(Math.abs(r.iw - r.bh) < 2 && Math.abs(r.ih - r.bw) < 2, `fit box swapped: ${JSON.stringify(r)}`);
            assert.notEqual(r.tf, 'none');
            // CSS string form, 180°: transformed, no swap
            await page.evaluate(() => {
                App.viewer.transformOf = () => 'rotate(180deg)';
                App.catalog.update('a.png', (e) => (e.meta = { ...(e.meta || {}), rot: 180 }), { undoable: false });
            });
            await page.waitForFunction(() => {
                const b = document.querySelector('.insp-preview');
                return b.classList.contains('xf') && !b.classList.contains('xf-swap');
            });
            // Fallback: only rotationOf
            await page.evaluate(() => {
                delete App.viewer.transformOf;
                App.viewer.rotationOf = () => 270;
                App.catalog.update('a.png', (e) => (e.meta = { ...(e.meta || {}), rot: 270 }), { undoable: false });
            });
            await page.waitForSelector('.insp-preview.xf-swap');
            assert.match(await page.evaluate(() => document.querySelector('.insp-preview').style.getPropertyValue('--insp-xf')), /rotate\(270deg\)/);
        },
    },
];
