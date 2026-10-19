// Chips team: chipset model, inspector (preview / chips / pinned memo), tri-state multi-selection, ratings & labels,
// hotkeys (gallery + viewer), '#' picker, sidebar chip filter + smart views, v1 legacy import, autofill — and that
// every change is ONE undo step (Ctrl+Z from the gallery, the viewer and the inspector).
'use strict';

const SEED = {
    'a.png': { image: { label: 'A', color: '#b33' } },
    'b.png': { image: { label: 'B', color: '#3b3' } },
    'c.png': { image: { label: 'C', color: '#33b' } },
    'd-clip.webm': { video: { seconds: 1 } },
    'sub/e.png': { image: { label: 'E' } },
};

const INSP = '.chip-panel[data-panel="inspector"]';

/** Standard chipset: 배우 (검색형) 김수현/박보영/이민호, 장르 (선택형) 드라마[로맨스, 가족]/액션. Returns name -> id. */
async function setupChips(page) {
    await page.waitForFunction(() => App.chipset && App.chipset.ready);
    return page.evaluate(() => {
        const C = App.chipset;
        const actors = C.addCategory({ name: '배우', mode: 'search' });
        C.addChips(actors.id, ['김수현', '박보영', '이민호']);
        const genre = C.addCategory({ name: '장르' });
        const [drama] = C.addChips(genre.id, ['드라마', '액션']);
        C.addChips(genre.id, ['로맨스', '가족'], { parentId: drama.id });
        const ids = Object.fromEntries(C.list().map((x) => [x.name, x.id]));
        ids.__actors = actors.id;
        ids.__genre = genre.id;
        return ids;
    });
}

// Count App.undo entries pushed from now on (pushes the core merges into the previous entry — coalesceKey — don't count)
async function countUndo(page) {
    await page.evaluate(() => {
        window.__undoCount = 0;
        if (App.undo.__counted) return;
        const push = App.undo.push;
        const seen = new WeakSet();
        App.undo.push = function (e) {
            const entry = push.call(this, e) || e;
            if (!seen.has(entry)) {
                seen.add(entry);
                window.__undoCount++;
            }
            return entry;
        };
        App.undo.__counted = true;
    });
}

const undoCount = (page) => page.evaluate(() => window.__undoCount);
const chipsOf = (page, p) => page.evaluate((x) => App.chipset.chipsOf(x), p);
const names = (page, p) => page.evaluate((x) => App.chipset.chipsOf(x).map((id) => App.chipset.nameOf(id)), p);

async function reopen(page, waitIdle) {
    await page.reload();
    await page.waitForFunction(() => window.App && document.querySelector('#topbar').children.length > 0);
    await page.evaluate(() => window.__useExistingWorkspace());
    await page.evaluate(() => App.workspace.pick());
    await page.waitForFunction(() => App.state.cwd === '' && App.view.source.type === 'folder');
    await waitIdle(page);
}

module.exports = [
    {
        name: 'chips: inspector layout — preview on top, chip panel in the middle, memo pinned at the bottom',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            await setupChips(page);
            // the "open a workspace" placeholder goes away once the inspector re-renders for the workspace
            await page.waitForSelector('#inspector .insp-off', { state: 'hidden' });
            await (await card(page, 'a.png')).click();
            await page.waitForSelector('.insp-zone-top .insp-preview');
            await page.waitForSelector(`.insp-zone-scroll ${INSP} .chip-cat`);
            await page.waitForSelector('.insp-zone-bottom .insp-memo-input:not([disabled])');
            const box = await page.evaluate(() => {
                const r = (s) => document.querySelector(s).getBoundingClientRect();
                return { insp: r('#inspector'), top: r('.insp-zone-top'), mid: r('.insp-zone-scroll'), memo: r('.insp-zone-bottom') };
            });
            assert.ok(box.top.bottom <= box.mid.top + 1 && box.mid.bottom <= box.memo.top + 1, 'zones are stacked top → middle → bottom');
            assert.ok(Math.abs(box.memo.bottom - box.insp.bottom) < 2, 'memo is pinned to the bottom of the panel');
            // Stars and color labels live in the quick strip under the preview
            assert.equal(await page.locator('.insp-zone-top .insp-star').count(), 5);
            assert.equal(await page.locator('.insp-zone-top .insp-label').count(), 6);
            // Details are collapsible and remember it
            const head = page.locator('.insp-sec-info .insp-head');
            const before = await page.evaluate(() => document.querySelector('.insp-sec-info').classList.contains('collapsed'));
            await head.click();
            assert.equal(await page.evaluate(() => document.querySelector('.insp-sec-info').classList.contains('collapsed')), !before);
            // Nothing selected: chip structure is still editable, memo hidden
            await page.keyboard.press('Escape');
            await page.waitForSelector('.insp-zone-bottom .insp-memo-input', { state: 'detached' });
            await page.waitForSelector(`${INSP} .chip-target.muted`);
        },
    },
    {
        name: 'chips: toggling on one file and on a multi-selection (tri-state) is one undo step each',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            const ids = await setupChips(page);
            await page.evaluate((id) => App.chipset.apply(['a.png', 'b.png'], id, 'add', { hud: false }), ids['드라마']);
            await countUndo(page);
            await (await card(page, 'a.png')).click();
            await (await card(page, 'c.png')).click({ modifiers: ['Shift'] });
            const chip = page.locator(`${INSP} .chip[data-chip="${ids['드라마']}"]`);
            await page.waitForFunction((sel) => document.querySelector(sel)?.classList.contains('is-mixed'), `${INSP} .chip[data-chip="${ids['드라마']}"]`);
            assert.equal(await chip.locator('.chip-frac').textContent(), '2/3');
            assert.equal(await chip.getAttribute('aria-pressed'), 'mixed');
            // Memo is disabled with a hint while several files are selected
            assert.ok(await page.isDisabled('.insp-memo-input'));
            assert.match(await page.textContent('.insp-memo-hint'), /한 파일만 선택하면/);
            await chip.click();
            await page.waitForFunction(() => ['a.png', 'b.png', 'c.png'].every((p) => App.catalog.peek(p)?.chips?.length));
            assert.equal(await undoCount(page), 1, 'one undo entry for three files');
            await page.waitForFunction((sel) => document.querySelector(sel)?.classList.contains('is-on'), `${INSP} .chip[data-chip="${ids['드라마']}"]`);
            assert.match(await page.textContent('#chip-hud'), /장르 · 드라마 — 3개/);
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => !App.catalog.peek('c.png')?.chips?.length);
            assert.deepEqual(await names(page, 'a.png'), ['드라마'], 'files that already had it keep it');
            // Clicking an "on" chip removes it from every selected file
            await page.keyboard.press('Control+Shift+z');
            await page.waitForFunction(() => App.catalog.peek('c.png')?.chips?.length === 1);
            await chip.click();
            await page.waitForFunction(() => ['a.png', 'b.png', 'c.png'].every((p) => !App.catalog.peek(p)?.chips?.length));
            // Folders can't carry chips
            const res = await page.evaluate((id) => App.chipset.apply(['sub'], id, 'add', { hud: false }), ids['액션']);
            assert.equal(res.changed, 0);
        },
    },
    {
        name: 'chips: a sub-chip brings its parent, turning the parent off drops its sub-chips',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            const ids = await setupChips(page);
            await (await card(page, 'a.png')).click();
            await page.click(`${INSP} .chip[data-chip="${ids['드라마']}"]`);
            await page.waitForSelector(`${INSP} .chip-sub-row[data-parent="${ids['드라마']}"] .chip[data-chip="${ids['로맨스']}"]`);
            await page.click(`${INSP} .chip[data-chip="${ids['로맨스']}"]`);
            await page.waitForFunction(() => App.catalog.peek('a.png')?.chips?.length === 2);
            assert.deepEqual(await names(page, 'a.png'), ['드라마', '로맨스']);
            await page.click(`${INSP} .chip[data-chip="${ids['드라마']}"]`);
            await page.waitForFunction(() => !App.catalog.peek('a.png')?.chips?.length);
            await page.waitForSelector(`${INSP} .chip-sub-row[data-parent="${ids['드라마']}"]`, { state: 'detached' });
            // Applying a sub-chip directly adds the parent too
            await page.evaluate((id) => App.chipset.apply(['b.png'], id, 'add', { hud: false }), ids['가족']);
            assert.deepEqual(await names(page, 'b.png'), ['드라마', '가족']);
            // '+' in the sub-row creates a sub-chip
            await (await card(page, 'b.png')).click();
            await page.click(`${INSP} .chip-sub-row[data-parent="${ids['드라마']}"] .chip-add`);
            await page.fill(`${INSP} .chip-add-input`, '스릴러, 사극');
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => App.chipset.list().some((x) => x.name === '사극' && x.depth === 1));
            assert.deepEqual(await page.evaluate(() => App.chipset.list().filter((x) => x.depth === 1).map((x) => x.name)), ['로맨스', '가족', '스릴러', '사극']);
        },
    },
    {
        name: 'chips: 검색형 category — Hangul initials find chips, Enter creates and applies (Ctrl+Z in the empty box undoes)',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            const ids = await setupChips(page);
            assert.ok(await page.evaluate(() => !!App.chipset.match('ㄱㅅㅎ', '김수현') && !!App.chipset.match('김ㅅ', '김수현') && !!App.chipset.match('수', '김수현')));
            assert.ok(await page.evaluate(() => !App.chipset.match('ㅂㅂ', '김수현') && !!App.chipset.match('ㅂㅂ', '박보영') && !!App.chipset.match('보', '박보영')));
            await (await card(page, 'a.png')).click();
            const box = `${INSP} [data-search="${ids.__actors}"]`;
            await page.click(box);
            await page.keyboard.type('ㄱㅅ');
            await page.waitForSelector(`${INSP} .chip-results .chip-result.active`);
            assert.match(await page.textContent(`${INSP} .chip-results .chip-result.active`), /김수현/);
            assert.equal(await page.locator(`${INSP} .chip-result.create`).count(), 0, 'initials never offer to create a chip');
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => App.catalog.peek('a.png')?.chips?.length === 1);
            assert.deepEqual(await names(page, 'a.png'), ['김수현']);
            // A new name + Enter creates the chip in this category and puts it on the file (one undo step)
            await countUndo(page);
            await page.click(box);
            await page.keyboard.type('송강호');
            await page.waitForSelector(`${INSP} .chip-result.create`);
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => App.catalog.peek('a.png')?.chips?.length === 2);
            assert.deepEqual(await names(page, 'a.png'), ['김수현', '송강호']);
            assert.equal(await undoCount(page), 1);
            assert.equal(await page.evaluate(() => App.chipset.list().find((x) => x.name === '송강호').catName), '배우');
            // Focus is back in the empty search box: Ctrl+Z undoes the chip (not the text field)
            await page.waitForFunction((sel) => document.activeElement === document.querySelector(sel), box);
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => App.catalog.peek('a.png')?.chips?.length === 1);
            assert.ok(!(await page.evaluate(() => App.chipset.list().some((x) => x.name === '송강호'))), 'the created chip is gone too');
        },
    },
    {
        name: 'chips: stars and color labels — clicks, Ctrl+Alt shortcuts, [ ], undo',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            await setupChips(page);
            await (await card(page, 'a.png')).click();
            await page.keyboard.press('Control+Alt+3');
            await page.waitForFunction(() => App.catalog.peek('a.png')?.rating === 3);
            await page.waitForSelector('.insp-star.on[data-rating="3"]');
            await page.keyboard.press(']');
            await page.waitForFunction(() => App.catalog.peek('a.png')?.rating === 4);
            await page.keyboard.press('[');
            await page.keyboard.press('[');
            await page.waitForFunction(() => App.catalog.peek('a.png')?.rating === 2);
            await page.click('.insp-star[data-rating="5"]');
            await page.waitForFunction(() => App.catalog.peek('a.png')?.rating === 5);
            await page.click('.insp-star[data-rating="5"]');
            await page.waitForFunction(() => !App.catalog.peek('a.png')?.rating, null, { timeout: 3000 });
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => App.catalog.peek('a.png')?.rating === 5);
            // Labels: Ctrl+Alt+6 = red, click toggles, multi-selection is one undo step
            await page.keyboard.press('Control+Alt+6');
            await page.waitForFunction(() => App.catalog.peek('a.png')?.label === 'red');
            await page.click('.insp-label[data-label="blue"]');
            await page.waitForFunction(() => App.catalog.peek('a.png')?.label === 'blue');
            await (await card(page, 'c.png')).click({ modifiers: ['Shift'] });
            await countUndo(page);
            await page.keyboard.press('Control+Alt+8');
            await page.waitForFunction(() => ['a.png', 'b.png', 'c.png'].every((p) => App.catalog.peek(p)?.label === 'green'));
            assert.equal(await undoCount(page), 1);
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => App.catalog.peek('a.png')?.label === 'blue' && !App.catalog.peek('b.png')?.label);
        },
    },
    {
        name: 'chips: memo autosaves with an indicator and is one undo step per editing burst',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            await setupChips(page);
            await (await card(page, 'a.png')).click();
            await countUndo(page);
            await page.click('.insp-memo-input');
            await page.keyboard.type('노을 사진');
            await page.waitForSelector('.insp-memo-state[data-state="saved"]');
            await page.keyboard.type(' — 보정 없음');
            await page.waitForFunction(() => App.catalog.peek('a.png')?.memo === '노을 사진 — 보정 없음');
            await page.waitForSelector('.insp-memo-state[data-state="saved"]');
            await page.keyboard.press('Escape');
            assert.equal(await undoCount(page), 1, 'two autosaves in one burst = one undo entry');
            await page.evaluate(() => App.catalog.flush());
            assert.match(await page.evaluate(() => window.__opfs.read('.fluid-organizer/catalog.json')), /보정 없음/);
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => !App.catalog.peek('a.png')?.memo);
            await page.waitForFunction(() => document.querySelector('.insp-memo-input').value === '');
            await page.keyboard.press('Control+y');
            await page.waitForFunction(() => document.querySelector('.insp-memo-input').value === '노을 사진 — 보정 없음');
            // Alt+M jumps into the memo; another file shows its own memo
            await (await card(page, 'b.png')).click();
            await page.keyboard.press('Alt+m');
            await page.waitForFunction(() => document.activeElement === document.querySelector('.insp-memo-input'));
            assert.equal(await page.inputValue('.insp-memo-input'), '');
        },
    },
    {
        name: 'chips: digit hotkeys toggle chips in the gallery and the viewer; Ctrl+Z works in the viewer',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            const ids = await setupChips(page);
            await (await card(page, 'a.png')).click();
            // Assign 1 through the chip's context menu
            await page.click(`${INSP} .chip[data-chip="${ids['액션']}"]`, { button: 'right' });
            await page.click('.menu .menu-item:has-text("단축키 지정")');
            await page.click('.menu .menu-item:has(.menu-label:text-is("1"))');
            await page.waitForSelector(`${INSP} .chip[data-chip="${ids['액션']}"] .chip-key`);
            assert.equal(await page.textContent(`${INSP} .chip[data-chip="${ids['액션']}"] .chip-key`), '1');
            assert.match(await page.evaluate(() => App.commands.get('chips.toggleHotkey1').title), /장르 · 액션/);
            await (await card(page, 'b.png')).click({ modifiers: ['Shift'] });
            await page.keyboard.press('1');
            await page.waitForFunction(() => ['a.png', 'b.png'].every((p) => App.catalog.peek(p)?.chips?.length === 1));
            await page.keyboard.press('1');
            await page.waitForFunction(() => ['a.png', 'b.png'].every((p) => !App.catalog.peek(p)?.chips?.length));
            // An empty hotkey explains itself instead of failing silently
            await page.keyboard.press('7');
            assert.match(await page.textContent('#chip-hud'), /7번 칩 단축키가 비어 있어요/);
            // Viewer: digits tag the photo on screen, Ctrl+Z undoes without leaving the viewer
            await (await card(page, 'c.png')).click();
            await page.keyboard.press('Enter');
            await page.waitForSelector('#viewer:not([hidden]) .vw-media');
            await page.keyboard.press('1');
            await page.waitForFunction(() => App.catalog.peek('c.png')?.chips?.length === 1);
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => !App.catalog.peek('c.png')?.chips?.length);
            assert.ok(await page.isVisible('#viewer'), 'still in the viewer');
            await page.keyboard.press('Control+Alt+4');
            await page.waitForFunction(() => App.catalog.peek('c.png')?.rating === 4);
            // Chip drawer from the viewer toolbar
            await page.click('.chip-vw-btn');
            await page.waitForSelector('.chip-drawer:not([hidden]) .chip-panel.compact');
            await page.click(`.chip-drawer .chip[data-chip="${ids['드라마']}"]`);
            await page.waitForFunction(() => App.catalog.peek('c.png')?.chips?.length === 1);
            await page.waitForFunction(() => document.querySelector('.chip-vw-btn .chip-vw-count').textContent === '1');
            await page.keyboard.press('ArrowRight');
            await page.waitForFunction(() => document.querySelector('.chip-drawer-file').textContent === 'd-clip.webm');
            await page.keyboard.press('Escape');
            await page.waitForSelector('#viewer', { state: 'hidden' });
        },
    },
    {
        name: "chips: '#' picker — initials, Enter toggles on the selection, Shift+Enter removes, creates new chips",
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            const ids = await setupChips(page);
            await (await card(page, 'a.png')).click();
            await (await card(page, 'c.png')).click({ modifiers: ['Shift'] });
            await countUndo(page);
            await page.keyboard.press('#');
            await page.waitForSelector('#chip-picker .chip-picker-input');
            await page.keyboard.type('ㅂㅂ');
            await page.waitForFunction((id) => document.querySelector('#chip-picker .chip-picker-row.active')?.dataset.chip === id, ids['박보영']);
            await page.keyboard.press('Enter');
            await page.waitForSelector('#chip-picker', { state: 'detached' });
            await page.waitForFunction(() => ['a.png', 'b.png', 'c.png'].every((p) => App.catalog.peek(p)?.chips?.length === 1));
            assert.equal(await undoCount(page), 1);
            assert.match(await page.textContent('#chip-hud'), /＋ 배우 · 박보영 — 3개/);
            // Path search: "장르 › 로맨스" style labels match too; tri-state mark shows on the row
            await page.keyboard.press('#');
            await page.keyboard.type('ㅂㅂ');
            await page.waitForSelector('#chip-picker .chip-picker-row.active .chip-picker-mark.on');
            await page.keyboard.press('Shift+Enter');
            await page.waitForFunction(() => ['a.png', 'b.png', 'c.png'].every((p) => !App.catalog.peek(p)?.chips?.length));
            // Ctrl+Enter keeps the picker open; a new name is created in the 검색형 category
            await page.keyboard.press('#');
            await page.keyboard.type('장르로맨');
            await page.waitForFunction((id) => document.querySelector('#chip-picker .chip-picker-row.active')?.dataset.chip === id, ids['로맨스']);
            await page.keyboard.press('Control+Enter');
            await page.waitForFunction(() => App.catalog.peek('b.png')?.chips?.length === 2);
            assert.ok(await page.isVisible('#chip-picker'), 'picker stays open');
            await page.keyboard.type('전도연');
            await page.waitForSelector('#chip-picker .chip-picker-row.create.active');
            assert.match(await page.textContent('#chip-picker .chip-picker-row.create'), /→ 배우/);
            await page.keyboard.press('Enter');
            await page.waitForSelector('#chip-picker', { state: 'detached' });
            await page.waitForFunction(() => App.catalog.peek('c.png')?.chips?.length === 3);
            assert.deepEqual(await names(page, 'c.png'), ['전도연', '드라마', '로맨스']);
            // Nothing selected: the picker explains instead of opening
            await page.keyboard.press('Escape');
            await page.keyboard.press('#');
            assert.equal(await page.locator('#chip-picker').count(), 0);
        },
    },
    {
        name: 'chips: sidebar chip filter — counts, AND/OR, every folder, 미분류, stars and labels',
        async run({ openApp, assert, card, cardNames }) {
            const { page } = await openApp({ seed: SEED });
            const ids = await setupChips(page);
            await page.waitForFunction(() => App.index.ready);
            await page.evaluate((x) => {
                const C = App.chipset;
                C.apply(['a.png', 'b.png', 'sub/e.png'], x['드라마'], 'add', { hud: false });
                C.apply(['b.png'], x['액션'], 'add', { hud: false });
                App.catalog.update('c.png', { rating: 4, label: 'red' });
            }, ids);
            const count = (id) => page.textContent(`.chipf-row[data-chip="${id}"] .chipf-count`);
            await page.waitForFunction((id) => document.querySelector(`.chipf-row[data-chip="${id}"] .chipf-count`)?.textContent === '3', ids['드라마']);
            assert.equal(await count(ids['액션']), '1');
            await page.click(`.chipf-row[data-chip="${ids['드라마']}"]`);
            await page.waitForFunction(() => App.view.filters.has('chips'));
            assert.deepEqual(await cardNames(page), ['sub', 'a.png', 'b.png']);
            await page.click(`.chipf-row[data-chip="${ids['액션']}"]`, { modifiers: ['Control'] });
            await page.waitForFunction(() => App.view.visible.filter((e) => e.kind === 'file').length === 1);
            assert.deepEqual(await cardNames(page), ['sub', 'b.png'], 'AND by default');
            await page.click('.chipf-op [data-op="or"]');
            await page.waitForFunction(() => App.view.visible.filter((e) => e.kind === 'file').length === 2);
            await page.click('.chipf-bar [data-action="everywhere"]');
            await page.waitForFunction(() => App.view.source.type === 'smart');
            assert.deepEqual((await cardNames(page)).sort(), ['a.png', 'b.png', 'e.png']);
            // F5 re-runs the smart view; trashing a file there removes it
            await page.evaluate(() => App.fs.trash(['sub/e.png']));
            await page.waitForFunction(() => App.view.visible.length === 2);
            await page.click('.chipf-bar [data-action="clear"]');
            await page.waitForFunction(() => App.view.source.type === 'folder' && !App.view.filters.has('chips'));
            await page.click('.chipf-row[data-smart="untagged"]');
            await page.waitForFunction(() => App.view.source.type === 'smart' && App.view.source.smart === 'untagged');
            assert.deepEqual((await cardNames(page)).sort(), ['c.png', 'd-clip.webm']);
            // Stars & labels filter the folder view
            await page.click('.chipf-row[data-smart="untagged"]');
            await page.waitForFunction(() => App.view.source.type === 'folder');
            await page.click('.chipf-star[data-rating="3"]');
            await page.waitForFunction(() => App.view.filters.has('rating'));
            assert.deepEqual(await cardNames(page), ['sub', 'c.png']);
            await page.click('.chipf-label[data-label="blue"]');
            await page.waitForFunction(() => App.view.filters.has('label'));
            assert.deepEqual(await cardNames(page), ['sub']);
            await page.evaluate(() => App.commands.run('chips.clearFilter'));
            await page.waitForFunction(() => !App.view.filters.has('rating') && !App.view.filters.has('label'));
        },
    },
    {
        name: 'chips: v1 tags — whole-library scan job and one-click conversion (one undo step)',
        async run({ openApp, assert, waitIdle }) {
            const seed = {
                ...SEED,
                'old.png': { image: { label: 'Old' } },
                'old.png.txt': '===TAB::Default===\n#TITLE: Default\n#TAGS: #가족, #장르/드라마/로맨스\n바다\n',
                'deep/inner/v.png': { image: { label: 'V' } },
                'deep/inner/v.png.txt': '===TAB::Note===\n#TAGS: #여행/제주\n',
            };
            const { page } = await openApp({ seed });
            await setupChips(page);
            await page.waitForFunction(() => App.index.ready);
            // deep/inner was never opened: the background job still finds its sidecar
            await page.waitForFunction(() => App.catalog.peek('deep/inner/v.png')?.legacyImported, null, { timeout: 15000 });
            await waitIdle(page);
            await page.waitForSelector('.toast:has-text("이전 버전 태그 3개를 찾았어요")');
            assert.equal((await page.evaluate(() => App.chipsTools.legacyStats())).tags, 3);
            await countUndo(page);
            await page.evaluate(() => {
                App.commands.run('chips.convertLegacy');
            });
            await page.waitForSelector('.dialog .chip-legacy-preview');
            assert.match(await page.textContent('.dialog .chip-legacy-preview'), /가져온 태그[\s\S]*가족/);
            await page.click('.dialog .btn.primary');
            await page.waitForFunction(() => App.catalog.peek('old.png')?.legacyConverted);
            assert.deepEqual(await names(page, 'old.png'), ['드라마', '로맨스', '가족']);
            assert.deepEqual(await page.evaluate(() => App.chipset.chipsOf('deep/inner/v.png').map((id) => App.chipset.labelOf(id))), ['여행 › 제주']);
            assert.equal(await page.evaluate(() => App.chipset.list().find((x) => x.name === '가족' && x.depth === 0).catName), '가져온 태그');
            assert.equal(await undoCount(page), 1);
            assert.equal((await page.evaluate(() => App.chipsTools.legacyStats())).tags, 0);
            await page.evaluate(() => App.undo.undo());
            assert.equal((await chipsOf(page, 'old.png')).length, 0);
            assert.ok(!(await page.evaluate(() => App.chipset.active().categories.some((c) => c.name === '가져온 태그' || c.name === '여행'))));
            assert.equal((await page.evaluate(() => App.chipsTools.legacyStats())).tags, 3, 'undo brings the tags back to convert later');
            assert.ok(await page.evaluate(() => window.__opfs.exists('old.png.txt')), 'sidecars stay untouched');
        },
    },
    {
        name: 'chips: autofill wizard — subfolders and file names become chips in one undo step',
        async run({ openApp, assert }) {
            const seed = {
                '배우/김수현/a.png': { image: {} },
                '배우/김수현/b.png': { image: {} },
                '배우/박보영/c.png': { image: {} },
                'misc/김수현_인터뷰.png': { image: {} },
                'misc/other.png': { image: {} },
            };
            const { page } = await openApp({ seed });
            await page.waitForFunction(() => App.chipset.ready && App.index.ready);
            const ksh = await page.evaluate(() => {
                const cat = App.chipset.addCategory({ name: '배우', mode: 'search' });
                return App.chipset.addChip(cat.id, '김수현').id;
            });
            const props = await page.evaluate(() => App.chipsTools.computeProposals({ folders: true, parent: '배우', catId: App.chipset.active().categories[0].id, names: true, scope: 'all' }).map((p) => [p.name, p.files.size, !!p.existing]));
            assert.deepEqual(props, [['김수현', 3, true], ['박보영', 1, false]]);
            await countUndo(page);
            await page.evaluate(() => {
                App.commands.run('chips.autofill');
            });
            await page.waitForSelector('.dialog .af-row');
            assert.equal(await page.inputValue('.dialog .af-fields select'), '배우', 'defaults to the folder with the most subfolders');
            assert.match(await page.textContent('.dialog .af-summary'), /칩 2개 \(새 칩 1개\) → 파일 4개/);
            await page.click('.dialog .btn.primary');
            await page.waitForFunction(() => App.catalog.peek('배우/박보영/c.png')?.chips?.length === 1);
            assert.deepEqual(await page.evaluate((id) => ['배우/김수현/a.png', '배우/김수현/b.png', 'misc/김수현_인터뷰.png'].map((p) => App.catalog.peek(p)?.chips?.includes(id)), ksh), [true, true, true]);
            assert.ok(!(await page.evaluate(() => App.catalog.peek('misc/other.png')?.chips?.length)));
            assert.equal(await page.evaluate(() => App.chipset.list().find((x) => x.name === '박보영').catName), '배우');
            assert.equal(await undoCount(page), 1);
            await page.evaluate(() => App.undo.undo());
            assert.ok(!(await page.evaluate(() => App.chipset.list().some((x) => x.name === '박보영'))));
            assert.ok(!(await page.evaluate(() => App.catalog.peek('배우/김수현/a.png')?.chips?.length)));
        },
    },
    {
        name: 'chips: structure edits are undoable — categories, rename, delete with files, hotkeys, presets',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            const ids = await setupChips(page);
            await page.evaluate((x) => App.chipset.apply(['a.png', 'b.png'], x['드라마'], 'add', { hud: false }), ids);
            await countUndo(page);
            const cats = () => page.evaluate(() => App.chipset.active().categories.map((c) => c.name));
            // Add a category through the dialog, undo with Ctrl+Z
            await page.evaluate(() => {
                App.commands.run('chips.addCategory');
            });
            await page.waitForSelector('.dialog .chip-mode-opts');
            await page.keyboard.type('상태');
            await page.click('.dialog .chip-mode-opt[data-mode="search"]');
            await page.click('.dialog .btn.primary');
            await page.waitForFunction(() => App.chipset.active().categories.length === 3);
            assert.equal(await page.evaluate(() => App.chipset.active().categories[2].mode), 'search');
            await page.click('#gallery-scroll', { position: { x: 600, y: 600 } });
            await page.keyboard.press('Control+z');
            assert.deepEqual(await cats(), ['배우', '장르']);
            // Rename (visible everywhere at once), then undo
            await page.evaluate((id) => App.chipset.renameChip(id, '멜로'), ids['로맨스']);
            assert.equal(await page.evaluate((id) => App.chipset.nameOf(id), ids['로맨스']), '멜로');
            await page.evaluate(() => App.undo.undo());
            assert.equal(await page.evaluate((id) => App.chipset.nameOf(id), ids['로맨스']), '로맨스');
            // Delete a chip that files use: confirm dialog, files lose it, one undo brings both back
            await (await card(page, 'a.png')).click();
            await page.click(`${INSP} .chip[data-chip="${ids['드라마']}"]`, { button: 'right' });
            await page.click('.menu .menu-item:has-text("칩 삭제")');
            await page.waitForSelector('.dialog:has-text("파일 2개에 붙은 칩도 함께 떨어져요")');
            await page.click('.dialog .btn.danger');
            await page.waitForFunction(() => !App.catalog.peek('a.png')?.chips?.length && !App.catalog.peek('b.png')?.chips?.length);
            assert.ok(!(await page.evaluate((id) => !!App.chipset.info(id), ids['드라마'])));
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => App.catalog.peek('b.png')?.chips?.length === 1);
            assert.deepEqual(await names(page, 'a.png'), ['드라마']);
            assert.ok(await page.evaluate((id) => App.chipset.info(id).chip.children.length === 2, ids['드라마']), 'sub-chips are back');
            // Hotkey assignment
            await page.evaluate((id) => App.chipset.setHotkey(id, 3), ids['액션']);
            assert.equal(await page.evaluate((id) => App.chipset.hotkeyOf(id), ids['액션']), '3');
            await page.evaluate(() => App.undo.undo());
            assert.equal(await page.evaluate((id) => App.chipset.hotkeyOf(id), ids['액션']), null);
            // Presets: create switches to it; undo returns; duplicate shares chip ids; delete + undo restores it
            await page.evaluate(() => App.chipset.createPreset('가족사진'));
            assert.equal(await page.evaluate(() => App.chipset.active().name), '가족사진');
            await page.evaluate(() => App.undo.undo());
            assert.deepEqual(await page.evaluate(() => App.chipset.presets().map((p) => [p.name, p.active])), [['기본', true]]);
            await page.evaluate(() => App.chipset.createPreset('영화', { duplicate: true }));
            assert.equal(await page.evaluate((id) => App.chipset.active().categories[1].chips[0].id === id, ids['드라마']), true);
            await page.evaluate(() => App.chipset.movePreset(App.chipset.active().id, -1));
            assert.deepEqual(await page.evaluate(() => App.chipset.presets().map((p) => p.name)), ['영화', '기본']);
            await page.evaluate(() => App.chipset.deletePreset(App.chipset.active().id));
            assert.deepEqual(await page.evaluate(() => App.chipset.presets().map((p) => p.name)), ['기본']);
            await page.evaluate(() => App.undo.undo());
            assert.deepEqual(await page.evaluate(() => App.chipset.presets().map((p) => [p.name, p.active])), [['영화', true], ['기본', false]]);
            assert.equal(await undoCount(page), 8, 'one entry per structure edit (8 edits above)');
        },
    },
    {
        name: 'chips: chipsets.json persists across reloads; cards show a chip badge; validation is friendly',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: SEED });
            const ids = await setupChips(page);
            await page.evaluate((x) => {
                App.chipset.apply(['a.png'], x['로맨스'], 'add', { hud: false });
                App.chipset.setHotkey(x['김수현'], 2);
            }, ids);
            await page.waitForSelector('.card[data-path="a.png"] .chip-card-badge');
            assert.match(await page.textContent('.card[data-path="a.png"] .chip-card-badge'), /로맨스/);
            assert.equal(await page.evaluate(() => App.chipset.validateName('a/b')), '/ 와 \\ 는 이름에 쓸 수 없어요');
            assert.equal(await page.evaluate((id) => App.chipset.validateName('김 수현', App.chipset.category(id).chips), ids.__actors), '같은 이름이 이미 있어요');
            await page.evaluate(() => App.catalog.flush());
            await page.waitForFunction(() => window.__opfs.exists('.fluid-organizer/chipsets.json'));
            const saved = JSON.parse(await page.evaluate(() => window.__opfs.read('.fluid-organizer/chipsets.json')));
            assert.equal(saved.presets[0].categories[1].chips[0].children[0].name, '로맨스');
            await reopen(page, waitIdle);
            await page.waitForFunction(() => App.chipset.ready);
            assert.deepEqual(await names(page, 'a.png'), ['드라마', '로맨스']);
            assert.equal(await page.evaluate((id) => App.chipset.hotkeyOf(id), ids['김수현']), '2');
            assert.equal(await page.evaluate((id) => App.chipset.labelOf(id), ids['로맨스']), '장르 › 드라마 › 로맨스');
        },
    },
];
