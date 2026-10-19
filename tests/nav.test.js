// Nav team: folder tree (menu, inline edit, keyboard, drag & drop, counts, filter), favorites, breadcrumb,
// history menus, search box (initials, chips, scope, suggestions) and the "하위 폴더 포함" view.
'use strict';

const SEED = {
    'a.png': { image: { label: 'A', color: '#b33' } },
    'b.png': { image: { label: 'B', color: '#3b3' } },
    'trip/x.png': { image: { label: 'X' } },
    'trip/inner/y.png': { image: { label: 'Y' } },
    'trip/inner/y2.png': { image: { label: 'Y2' } },
    'family/f1.png': { image: { label: 'F' } },
    '김수현 화보/k1.png': { image: { label: 'K' } },
    '여행/2024 제주/sea.png': { image: { label: 'S' } },
    '여행/2023 부산/night.png': { image: { label: 'N' } },
    'empty/': null,
};

// Index built, background jobs done and the tree's per-folder counts computed (they are recomputed when idle)
async function ready(page) {
    await page.waitForFunction(() => App.index.ready && App.jobs.list().length === 0, null, { timeout: 20000 });
    await page.waitForFunction(() => App.tree.countsFor('') !== null);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

const row = (p) => `.tree-row[data-path="${p}"]`;

async function menuLabels(page) {
    await page.waitForSelector('.menu');
    return page.$$eval('.menu .menu-item .menu-label', (els) => els.map((e) => e.textContent));
}

async function clickMenu(page, labelText) {
    await page.locator('.menu .menu-item').filter({ has: page.locator('.menu-label', { hasText: labelText }) }).filter({ hasNot: page.locator('.menu-hint', { hasText: labelText }) }).first().click();
}

async function clickMenuExact(page, labelText) {
    const i = (await menuLabels(page)).indexOf(labelText);
    if (i < 0) throw new Error(`menu item "${labelText}" not found`);
    await page.locator('.menu .menu-item').nth(i).click();
}

// page.waitForFunction treats a returned Promise as truthy, so async checks poll through page.evaluate instead
async function waitUntil(page, fn, arg, { timeout = 10000, what = '' } = {}) {
    const t0 = Date.now();
    for (;;) {
        if (await page.evaluate(fn, arg)) return;
        if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what || fn}`);
        await page.waitForTimeout(40);
    }
}

function waitExists(page, p, want = true) {
    return waitUntil(page, async ([q, w]) => (await window.__opfs.exists(q)) === w, [p, want], { what: `${p} ${want ? 'to exist' : 'to be gone'}` });
}

function waitFavFile(page, order) {
    return waitUntil(page, async (o) => {
        try {
            return JSON.parse(await window.__opfs.read('.fluid-organizer/favorites.json')).items.map((i) => i.path).join() === o;
        } catch (e) {
            return false;
        }
    }, order, { what: `favorites.json = ${order}` });
}

// Dispatch a synthetic drag: optional dragstart on `from` (so drop targets learn the dragged paths), then
// dragover/drop on `to`. Returns whether the target accepted the drop (dragover default prevented).
async function synthDrop(page, { from = null, to, paths = null, files = null, ctrl = false, drop = true, fav = null, edge = null }) {
    return page.evaluate(async ({ from, to, paths, files, ctrl, drop, fav, edge }) => {
        const target = document.querySelector(to);
        if (!target) throw new Error('no drop target ' + to);
        const dt = new DataTransfer();
        if (paths) {
            dt.setData('application/x-fi-paths', JSON.stringify(paths));
            dt.setData('text/plain', paths.join('\n'));
        }
        if (fav) dt.setData('application/x-fi-fav', fav);
        for (const f of files || []) dt.items.add(new File([f.text], f.name, { type: f.type || 'text/plain' }));
        const src = from ? document.querySelector(from) : document.body;
        if (paths || fav) src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
        const r = target.getBoundingClientRect();
        const y = edge === 'top' ? r.top + 2 : edge === 'bottom' ? r.bottom - 2 : r.top + r.height / 2;
        const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + Math.min(40, r.width / 2), clientY: y, ctrlKey: ctrl };
        target.dispatchEvent(new DragEvent('dragenter', opts));
        const over = new DragEvent('dragover', opts);
        target.dispatchEvent(over);
        const accepted = over.defaultPrevented;
        if (accepted && drop) target.dispatchEvent(new DragEvent('drop', opts));
        src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
        return accepted;
    }, { from, to, paths, files, ctrl, drop, fav, edge });
}

module.exports = [
    {
        name: 'tree context menu: inline new folder, validation, rename, trash with confirm and undo',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await ready(page);
            await page.click(`${row('trip')}`, { button: 'right' });
            const labels = await menuLabels(page);
            for (const l of ['열기', '새 폴더', '이름 바꾸기', '즐겨찾기에 추가', '새로 고침', '휴지통으로 이동']) assert.ok(labels.includes(l), `menu has ${l}: ${labels}`);
            assert.ok(!labels.includes('폴더 풀기'), 'unwrap only shows when organize registers it');
            assert.ok(!labels.includes('탐색기에서 보기'), 'reveal only shows when the backend supports it');
            await clickMenu(page, '새 폴더');
            const input = page.locator('.tree-row.phantom input.tree-edit');
            await input.waitFor();
            assert.equal(await input.inputValue(), '새 폴더');
            await input.fill('picked');
            await input.press('Enter');
            await waitExists(page, 'trip/picked');
            await page.waitForSelector(`${row('trip/picked')}`);
            assert.equal(await page.locator('.tree-row.phantom').count(), 0);

            // Invalid names are explained inline and nothing is created
            await page.evaluate(() => App.tree.startNewFolder('trip'));
            await input.waitFor();
            await input.fill('a/b');
            await input.press('Enter');
            await page.waitForSelector('.tree-edit-error:not([hidden])');
            assert.match(await page.textContent('.tree-edit-error'), /쓸 수 없어요/);
            await input.press('Escape');
            await page.waitForFunction(() => !document.querySelector('.tree-row.phantom'));

            // Inline rename from the menu
            await page.click(`${row('trip/picked')}`, { button: 'right' });
            await clickMenu(page, '이름 바꾸기');
            const edit = page.locator(`${row('trip/picked')} input.tree-edit`);
            await edit.waitFor();
            await edit.fill('renamed');
            await edit.press('Enter');
            await waitExists(page, 'trip/renamed');
            assert.ok(!(await page.evaluate(() => window.__opfs.exists('trip/picked'))));

            // Trash a non-empty folder: confirm dialog with contents, then undo
            await page.click(`${row('trip')}`, { button: 'right' });
            await clickMenu(page, '휴지통으로 이동');
            await page.waitForSelector('.dialog');
            assert.match(await page.textContent('.dialog'), /사진 3개/);
            await page.click('.dialog .btn.danger');
            await page.waitForFunction(() => !document.querySelector('.tree-row[data-path="trip"]'));
            assert.ok(!(await page.evaluate(() => window.__opfs.exists('trip'))));
            await page.keyboard.press('Control+z');
            await waitExists(page, 'trip/inner/y.png');
            await page.waitForSelector(`${row('trip')}`);
        },
    },
    {
        name: 'tree keyboard: arrows/expand/Enter stay in the tree, F2 and Delete act on folders, Esc returns',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            await ready(page);
            await (await card(page, 'a.png')).click();
            await page.keyboard.press('Control+Shift+E');
            assert.equal(await page.evaluate(() => document.activeElement.id), 'folder-tree');
            const cursor = () => page.evaluate(() => document.querySelector('.tree-row.kbd-focus')?.dataset.path);
            const moveTo = async (p) => {
                for (let i = 0; i < 20; i++) {
                    const [cur, want] = await page.evaluate((q) => {
                        const rows = App.tree.rows.map((r) => r.p);
                        return [rows.indexOf(document.querySelector('.tree-row.kbd-focus')?.dataset.path), rows.indexOf(q)];
                    }, p);
                    if (cur === want) return;
                    await page.keyboard.press(want > cur ? 'ArrowDown' : 'ArrowUp');
                }
            };
            assert.equal(await cursor(), '', 'starts on the current folder');
            await page.keyboard.press('ArrowDown');
            assert.notEqual(await cursor(), '');
            assert.deepEqual(await page.evaluate(() => App.select.list()), ['a.png'], 'gallery selection untouched by tree arrows');
            await moveTo('trip');
            assert.equal(await cursor(), 'trip');
            await page.keyboard.press('ArrowRight');
            await page.waitForSelector(`${row('trip')}[aria-expanded="true"]`);
            await page.keyboard.press('ArrowRight');
            assert.equal(await cursor(), 'trip/inner');
            await page.keyboard.press('ArrowLeft');
            assert.equal(await cursor(), 'trip');
            await page.keyboard.press('ArrowLeft');
            await page.waitForSelector(`${row('trip')}[aria-expanded="false"]`);
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => App.state.cwd === 'trip');
            assert.equal(await page.evaluate(() => document.activeElement.id), 'folder-tree', 'Enter keeps focus in the tree');

            // F2 renames the folder under the cursor (not the selected file); Esc cancels and returns to the tree
            await page.keyboard.press('F2');
            await page.waitForSelector(`${row('trip')} input.tree-edit`);
            await page.keyboard.press('Escape');
            await page.waitForFunction(() => document.activeElement.id === 'folder-tree');

            // Delete trashes the (empty) folder under the cursor without touching gallery files
            await moveTo('empty');
            assert.equal(await cursor(), 'empty');
            await page.keyboard.press('Delete');
            await waitExists(page, 'empty', false);
            assert.ok(await page.evaluate(() => window.__opfs.exists('a.png')));
            await page.keyboard.press('Escape');
            assert.equal(await page.evaluate(() => document.activeElement.id), 'gallery-scroll');
            await page.keyboard.press('Control+Shift+E');
            await page.keyboard.press('Control+Shift+E');
            assert.equal(await page.evaluate(() => document.activeElement.id), 'gallery-scroll', 'the shortcut toggles back to the gallery');
        },
    },
    {
        name: 'tree drag & drop: move files and folders, Ctrl copies, refuses into itself, hover expands, imports OS files',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            await ready(page);
            // Real mouse drag: gallery card -> tree row
            await page.dragAndDrop(`.card[data-path="a.png"]`, `${row('family')} .tree-name`);
            await waitExists(page, 'family/a.png');
            assert.ok(!(await page.evaluate(() => window.__opfs.exists('a.png'))));
            await page.waitForSelector('.toast', { hasText: '옮겼어요' });

            // A folder row dragged onto itself / its own subfolder is refused; onto another folder it moves
            await page.click(`${row('trip')} .tree-twisty`);
            await page.waitForSelector(`${row('trip/inner')}`);
            assert.equal(await synthDrop(page, { from: row('trip'), to: row('trip/inner'), paths: ['trip'], drop: false }), false);
            assert.equal(await synthDrop(page, { from: row('trip'), to: row('trip'), paths: ['trip'], drop: false }), false);
            assert.equal(await synthDrop(page, { to: row(''), paths: ['b.png'], drop: false }), false, 'already there');
            await page.dragAndDrop(`${row('trip')} .tree-name`, `${row('family')} .tree-name`);
            await waitExists(page, 'family/trip/inner/y.png');
            await page.waitForSelector(`${row('family/trip')}`);

            // Ctrl = copy
            assert.ok(await synthDrop(page, { to: row('empty'), paths: ['b.png'], ctrl: true }));
            await waitExists(page, 'empty/b.png');
            assert.ok(await page.evaluate(() => window.__opfs.exists('b.png')));

            // Files from the OS are imported (one undo entry)
            assert.ok(await synthDrop(page, { to: row('empty'), files: [{ name: 'dropped.png', text: 'x' }, { name: 'desktop.ini', text: 'x' }] }));
            await waitExists(page, 'empty/dropped.png');
            assert.ok(!(await page.evaluate(() => window.__opfs.exists('empty/desktop.ini'))), 'system files are skipped');
            await page.evaluate(() => App.undo.undo());
            await waitExists(page, 'empty/dropped.png', false);

            // Hovering a collapsed folder while dragging expands it
            await page.click(`${row('family')} .tree-twisty`); // collapse
            await page.waitForFunction(() => !document.querySelector('.tree-row[data-path="family/trip"]'));
            const src = await (await card(page, 'b.png')).boundingBox();
            const dst = await page.locator(`${row('family')} .tree-name`).boundingBox();
            await page.mouse.move(src.x + 30, src.y + 30);
            await page.mouse.down();
            await page.mouse.move(src.x + 60, src.y + 60, { steps: 4 });
            await page.mouse.move(dst.x + 10, dst.y + 8, { steps: 6 });
            await page.waitForTimeout(250);
            await page.mouse.move(dst.x + 14, dst.y + 9, { steps: 2 });
            await page.waitForSelector(`${row('family/trip')}`, { timeout: 3000 });
            await page.mouse.up();
            await waitExists(page, 'family/b.png');
        },
    },
    {
        name: 'per-folder counts, summary tooltip (photos · videos · folders · size) and dimmed empty folders follow the index',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { ...SEED, 'shell/void/': null } });
            await ready(page);
            const count = (p) => page.evaluate((q) => document.querySelector(`.tree-row[data-path="${q}"] .tree-count`)?.textContent || '', p);
            const tip = (p) => page.getAttribute(row(p), 'data-tip');
            assert.equal(await count('trip'), '1');
            assert.match(await tip('trip'), /^사진 1 · 영상 0 · 폴더 1 \(하위 포함 3개 · [\d.]+ KB\)$/);
            assert.match(await tip('family'), /^사진 1 · 영상 0 · 폴더 0 \([\d.]+ KB\)$/);
            // Empty folders: dashed + dimmed, '비어 있음' in the tooltip (also when only empty subfolders are inside)
            assert.equal(await count('empty'), '');
            assert.equal(await tip('empty'), '비어 있음');
            assert.ok(await page.isVisible(`${row('empty')}.is-empty`));
            assert.equal(await tip('shell'), '비어 있음 · 사진·영상 없는 하위 폴더 1개');
            assert.ok(await page.isVisible(`${row('shell')}.is-empty`));
            assert.ok(!(await page.isVisible(`${row('trip')}.is-empty`)));
            await page.evaluate(() => App.fs.copy(['family/f1.png'], 'empty'));
            await page.waitForFunction(() => !document.querySelector('.tree-row[data-path="empty"]').classList.contains('is-empty'));
            assert.match(await tip('empty'), /^사진 1 · 영상 0 · 폴더 0/);
            await page.evaluate(() => App.fs.move(['a.png', 'b.png'], 'trip'));
            await page.waitForFunction(() => document.querySelector('.tree-row[data-path="trip"] .tree-count')?.textContent === '3');
            await page.hover(`${row('trip')} .tree-count`);
            await page.waitForSelector('.tooltip', { hasText: '하위 포함 5개' });
            // Options menu: include subfolders
            await page.hover('.tree-section .sb-head');
            await page.click('.tree-section .sb-act[aria-label="폴더 트리 설정"]');
            await clickMenu(page, '하위 폴더까지 합친 개수');
            await page.waitForFunction(() => document.querySelector('.tree-row[data-path="trip"] .tree-count')?.textContent === '5');
            await page.evaluate(() => App.commands.run('nav.toggleCounts'));
            await page.waitForFunction(() => !document.querySelector('.tree-row .tree-count'));
        },
    },
    {
        name: 'favorites: Ctrl+D pins, click opens, reorder by drag, follows rename, trash/undo, persists',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: SEED });
            await ready(page);
            assert.ok(await page.isVisible('.fav-empty'), 'helpful empty state');
            await page.evaluate(() => App.nav.go('trip'));
            await page.keyboard.press('Control+d');
            await page.waitForSelector('.fav-row[data-path="trip"]');
            await page.click(`${row('family')}`, { button: 'right' });
            await clickMenu(page, '즐겨찾기에 추가');
            await page.waitForSelector('.fav-row[data-path="family"]');
            await waitFavFile(page, 'trip,family');

            // Click navigates
            await page.evaluate(() => App.nav.go(''));
            await page.click('.fav-row[data-path="family"]');
            await page.waitForFunction(() => App.state.cwd === 'family');
            await page.waitForSelector('.fav-row.current[data-path="family"]');

            // Reorder: drag 'family' above 'trip'
            assert.ok(await synthDrop(page, { from: '.fav-row[data-path="family"]', to: '.fav-row[data-path="trip"]', fav: 'family', edge: 'top' }));
            await page.waitForFunction(() => App.navFavorites.list().join() === 'family,trip');
            await waitFavFile(page, 'family,trip');

            // Drop a file onto a favorite moves it there; dropping a folder on the edge pins it
            assert.ok(await synthDrop(page, { to: '.fav-row[data-path="trip"]', paths: ['b.png'] }));
            await waitExists(page, 'trip/b.png');
            assert.ok(await synthDrop(page, { from: row('empty'), to: '.fav-row[data-path="trip"]', paths: ['empty'], edge: 'bottom' }));
            await page.waitForFunction(() => App.navFavorites.list().join() === 'family,trip,empty');

            // Rename follows, trash drops it, undo brings it back
            await page.evaluate(() => App.fs.rename('trip', 'travel'));
            await page.waitForFunction(() => App.navFavorites.list().join() === 'family,travel,empty');
            await page.evaluate(() => App.fs.trash(['travel']));
            await page.waitForFunction(() => App.navFavorites.list().join() === 'family,empty');
            await page.evaluate(() => App.undo.undo());
            await page.waitForFunction(() => App.navFavorites.list().join() === 'family,travel,empty');

            // Remove from the context menu, undo restores it
            await page.click('.fav-row[data-path="empty"]', { button: 'right' });
            await clickMenu(page, '즐겨찾기에서 빼기');
            await page.waitForFunction(() => App.navFavorites.list().join() === 'family,travel');
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => App.navFavorites.list().join() === 'family,travel,empty');

            // Keyboard list (Ctrl+Shift+D) and persistence across reloads
            await page.keyboard.press('Control+Shift+D');
            assert.deepEqual((await menuLabels(page)).slice(0, 3), ['family', 'travel', 'empty']);
            await page.keyboard.press('Escape');
            await page.evaluate(() => App.catalog.flush());
            await page.reload();
            await page.waitForFunction(() => window.App && document.querySelector('#topbar').children.length > 0);
            await page.evaluate(() => window.__useExistingWorkspace());
            await page.evaluate(() => App.workspace.pick());
            await page.waitForFunction(() => App.state.cwd === '' && App.view.source.type === 'folder');
            await waitIdle(page);
            await page.waitForFunction(() => App.navFavorites.list().join() === 'family,travel,empty');
            await page.waitForSelector('.fav-row[data-path="travel"]');
        },
    },
    {
        name: 'one Ctrl+Z undoes each tree, breadcrumb and favorites action; Ctrl+Shift+Z redoes it',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await ready(page);
            const exists = (p) => page.evaluate((q) => window.__opfs.exists(q), p);
            const favs = (list) => page.waitForFunction((l) => App.navFavorites.list().join() === l, list);
            // Ctrl+Z belongs to the app (text fields keep their own); press it from the gallery like a user would
            const undo = async () => {
                await page.evaluate(() => document.getElementById('gallery-scroll').focus());
                await page.keyboard.press('Control+z');
            };
            const redo = () => page.keyboard.press('Control+Shift+z');

            // New folder (inline in the tree)
            await page.evaluate(() => App.tree.startNewFolder('trip'));
            const input = page.locator('.tree-row.phantom input.tree-edit');
            await input.waitFor();
            await input.fill('made');
            await input.press('Enter');
            await waitExists(page, 'trip/made');
            await undo();
            await waitExists(page, 'trip/made', false);
            assert.ok(await exists('trip/x.png'));

            // Inline rename
            await page.evaluate(() => App.tree.startRename('family'));
            const edit = page.locator(`${row('family')} input.tree-edit`);
            await edit.waitFor();
            await edit.fill('kin');
            await edit.press('Enter');
            await waitExists(page, 'kin');
            await undo();
            // OPFS can't move folders natively, so App.fs copies then deletes: wait for both halves
            await waitExists(page, 'family');
            await waitExists(page, 'kin', false);
            assert.ok(await exists('family/f1.png'));

            // Two files dropped on a tree row move back with one Ctrl+Z
            assert.ok(await synthDrop(page, { to: row('family'), paths: ['a.png', 'b.png'] }));
            await waitExists(page, 'family/b.png');
            await undo();
            await waitExists(page, 'a.png');
            await waitExists(page, 'b.png');
            await waitExists(page, 'family/a.png', false);

            // Ctrl+drop on a breadcrumb copies; one Ctrl+Z removes the copy
            await page.evaluate(() => App.nav.go('trip/inner'));
            await page.waitForFunction(() => App.state.cwd === 'trip/inner');
            assert.ok(await synthDrop(page, { to: '.crumb.root', paths: ['trip/inner/y.png'], ctrl: true }));
            await waitExists(page, 'y.png');
            await undo();
            await waitExists(page, 'y.png', false);
            assert.ok(await exists('trip/inner/y.png'));

            // Trashing a folder from the tree
            await page.evaluate(() => App.tree.trashFolder('empty'));
            await waitExists(page, 'empty', false);
            await undo();
            await waitExists(page, 'empty');

            // Favorites: add, pin several at once, reorder, remove — one Ctrl+Z each, redo with Ctrl+Shift+Z
            await page.evaluate(() => App.nav.go('trip'));
            await page.waitForFunction(() => App.state.cwd === 'trip');
            await page.evaluate(() => document.getElementById('gallery-scroll').focus());
            await page.keyboard.press('Control+d');
            await favs('trip');
            await undo();
            await favs('');
            await redo();
            await favs('trip');
            assert.ok(await synthDrop(page, { to: '.fav-row[data-path="trip"]', paths: ['family', 'empty'], edge: 'bottom' }));
            await favs('trip,family,empty');
            await undo();
            await favs('trip');
            await redo();
            await favs('trip,family,empty');
            assert.ok(await synthDrop(page, { from: '.fav-row[data-path="empty"]', to: '.fav-row[data-path="trip"]', fav: 'empty', edge: 'top' }));
            await favs('empty,trip,family');
            await undo();
            await favs('trip,family,empty');
            await page.click('.fav-row[data-path="family"]', { button: 'right' });
            await clickMenu(page, '즐겨찾기에서 빼기');
            await favs('trip,empty');
            await undo();
            await favs('trip,family,empty');
            await waitFavFile(page, 'trip,family,empty');
        },
    },
    {
        name: 'tree stays virtualized with 1,500 folders; filter, expand and keyboard stay fast',
        async run({ openApp, assert }) {
            const seed = { 'cover.png': { image: {} } };
            for (let i = 1; i <= 1500; i++) seed[`앨범 ${String(i).padStart(4, '0')}/`] = null;
            const { page } = await openApp({ seed });
            await page.waitForFunction(() => App.index.ready && App.tree.rows.length > 1500, null, { timeout: 30000 });
            const domRows = () => page.evaluate(() => document.querySelectorAll('#folder-tree .tree-row').length);
            assert.ok((await domRows()) < 120, `only rows near the viewport exist (${await domRows()})`);
            // Scroll to the bottom: the last folder gets rendered, the DOM stays small
            await page.evaluate(() => {
                const s = App.sidebar.scrollEl;
                s.scrollTop = s.scrollHeight;
            });
            await page.waitForSelector('.tree-row[data-path="앨범 1500"]');
            assert.ok((await domRows()) < 120);
            // Filtering 1,500 folders by initials is instant and exact
            const t0 = Date.now();
            await page.evaluate(() => App.tree.filter('ㅇㅂ 0042'));
            await page.waitForSelector('.tree-row[data-path="앨범 0042"] mark.hl');
            assert.ok(Date.now() - t0 < 1500, `filter took ${Date.now() - t0}ms`);
            assert.equal(await page.evaluate(() => App.tree.rows.filter((r) => r.match).length), 1);
            await page.evaluate(() => App.tree.clearFilter());
            // Keyboard: End jumps to the last folder without rendering everything
            await page.keyboard.press('Control+Shift+E');
            await page.keyboard.press('End');
            await page.waitForSelector('.tree-row.kbd-focus[data-path="앨범 1500"]');
            assert.ok((await domRows()) < 120);
            // Collapse all keeps the workspace root open (its 1,500 children stay listed) and scrolls back to the top
            await page.evaluate(() => App.commands.run('nav.collapseTree'));
            await page.waitForFunction(() => App.sidebar.scrollEl.scrollTop === 0 && App.tree.rows.length === 1501);
            await page.waitForSelector('.tree-row[data-path="앨범 0001"]');
            assert.ok((await domRows()) < 120);
        },
    },
    {
        name: 'breadcrumb: chevron lists subfolders, crumbs are drop targets, long paths fold into …',
        async run({ openApp, assert }) {
            const deep = { ...SEED };
            const segs = ['아주 긴 이름의 첫번째 폴더', '두번째로 꽤 긴 폴더 이름', '세번째 폴더도 길어요', '네번째 폴더 이름', '마지막 폴더'];
            deep[segs.join('/') + '/z.png'] = { image: {} };
            const { page } = await openApp({ seed: deep, viewport: { width: 1100, height: 760 } });
            await ready(page);
            await page.evaluate(() => App.nav.go('trip/inner'));
            await page.waitForFunction(() => document.querySelector('.crumb.current')?.textContent === 'inner');
            await page.click('.crumb-sep[data-path=""]');
            const labels = await menuLabels(page);
            assert.ok(labels.includes('trip') && labels.includes('family') && labels.includes('여행'), labels.join());
            assert.ok(await page.isVisible('.menu .menu-item:has-text("trip") .menu-check .ico'), 'the folder on the path is checked');
            await clickMenuExact(page, 'family');
            await page.waitForFunction(() => App.state.cwd === 'family');

            // Drop onto the root crumb moves the file up
            await page.evaluate(() => App.nav.go('trip/inner'));
            await page.waitForFunction(() => App.state.cwd === 'trip/inner');
            assert.ok(await synthDrop(page, { to: '.crumb.root', paths: ['trip/inner/y.png'] }));
            await waitExists(page, 'y.png');
            assert.equal(await synthDrop(page, { to: '.crumb.current', paths: ['trip/inner/y2.png'], drop: false }), false, 'current folder refuses its own files');

            // Deep path folds the middle into '…'
            await page.evaluate((p) => App.nav.go(p), segs.join('/'));
            await page.waitForSelector('.crumb-more:not([hidden])');
            assert.equal(await page.textContent('.crumb.current'), '마지막 폴더');
            await page.click('.crumb-more');
            const hidden = await menuLabels(page);
            assert.ok(hidden.includes(segs[0]) || hidden.includes(segs[1]), hidden.join());
            await clickMenuExact(page, hidden[0]);
            await page.waitForFunction((p) => App.state.cwd === p, segs.slice(0, segs.indexOf(hidden[0]) + 1).join('/'));
        },
    },
    {
        name: 'back/forward right-click shows history and jumps several steps; Ctrl+H shows both directions',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await ready(page);
            for (const p of ['trip', 'trip/inner', 'family']) {
                await page.evaluate((q) => App.nav.go(q), p);
            }
            await page.click('button[aria-label="뒤로"]', { button: 'right' });
            assert.deepEqual((await menuLabels(page)).slice(0, 3), ['inner', 'trip', 'ws']);
            await clickMenuExact(page, 'ws');
            await page.waitForFunction(() => App.state.cwd === '');
            assert.deepEqual(await page.evaluate(() => App.nav.fwd), ['family', 'trip/inner', 'trip']);
            assert.equal(await page.evaluate(() => App.nav.back.length), 0);
            await page.click('button[aria-label="앞으로"]', { button: 'right' });
            assert.deepEqual((await menuLabels(page)).slice(0, 3), ['trip', 'inner', 'family']);
            await clickMenuExact(page, 'family');
            await page.waitForFunction(() => App.state.cwd === 'family');
            assert.deepEqual(await page.evaluate(() => App.nav.back), ['', 'trip', 'trip/inner']);
            await page.keyboard.press('Control+h');
            const labels = await menuLabels(page);
            assert.ok(labels.includes('family') && labels.includes('inner'), labels.join());
            assert.ok(await page.isVisible('.menu .menu-header:has-text("지금 보는 폴더")'));
            await page.keyboard.press('Escape');
        },
    },
    {
        name: 'search box: initials and chip names match, count, clear button, scope, suggestions, Esc steps, recents',
        async run({ openApp, assert, cardNames }) {
            const { page } = await openApp({ seed: SEED });
            await ready(page);
            await page.click('#search-input');
            await page.keyboard.type('ㄱㅅㅎ');
            await page.waitForFunction(() => App.view.source.type === 'search' && App.view.visible.some((e) => e.path === '김수현 화보/k1.png'));
            await page.waitForFunction(() => document.querySelector('.search-count')?.textContent === '1개');
            await page.waitForSelector('#search-suggest .sg-opt:has-text("김수현 화보")');
            assert.equal(await page.textContent('#search-suggest .sg-opt mark.hl'), '김수현');
            // Keyboard: ArrowDown picks the folder suggestion, Enter goes there and clears the box
            await page.keyboard.press('ArrowDown');
            assert.equal(await page.getAttribute('#search-input', 'aria-activedescendant'), 'sg-opt-0');
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => App.state.cwd === '김수현 화보' && App.view.source.type === 'folder');
            assert.equal(await page.inputValue('#search-input'), '');

            // Clear button
            await page.fill('#search-input', 'png');
            await page.waitForFunction(() => App.view.source.type === 'search');
            await page.click('.search-clear');
            await page.waitForFunction(() => App.view.source.type === 'folder');
            assert.equal(await page.inputValue('#search-input'), '');

            // Scope: current folder only (Alt+S)
            await page.evaluate(() => App.nav.go('trip'));
            await page.fill('#search-input', 'png');
            await page.waitForFunction(() => App.view.source.type === 'search' && App.view.visible.length > 3);
            await page.keyboard.press('Alt+s');
            await page.waitForFunction(() => App.view.source.scope === 'folder');
            const names = (await cardNames(page)).sort();
            assert.deepEqual(names, ['x.png', 'y.png', 'y2.png']);
            assert.ok(await page.isVisible('.vb-scope'));
            await page.keyboard.press('Alt+s');
            await page.waitForFunction(() => App.view.source.scope === 'all');

            // Esc: (1) leaves the suggestion list, (2) clears the text, (3) returns to the gallery
            await page.fill('#search-input', '');
            await page.evaluate(() => App.nav.go(''));
            await page.click('#search-input');
            await page.keyboard.type('tri');
            await page.waitForSelector('#search-suggest .sg-opt:has-text("trip")');
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('Escape');
            assert.equal(await page.inputValue('#search-input'), 'tri');
            assert.equal(await page.locator('#search-suggest').count(), 0);
            await page.keyboard.press('Escape');
            await page.waitForFunction(() => App.view.source.type === 'folder');
            assert.equal(await page.inputValue('#search-input'), '');
            await page.keyboard.press('Escape');
            assert.equal(await page.evaluate(() => document.activeElement.id), 'gallery-scroll');

            // Chips (feature-detected App.chipset.nameOf) match by name and show up as suggestions
            await page.evaluate(() => {
                App.chipset = App.chipset || {};
                const prev = App.chipset.nameOf;
                App.chipset.nameOf = (id) => ({ c1: '바다 풍경' })[id] ?? (prev ? prev.call(App.chipset, id) : null);
                App.catalog.update('a.png', { chips: ['c1'] });
            });
            await page.click('#search-input');
            await page.keyboard.type('바다');
            await page.waitForFunction(() => App.view.source.type === 'search' && App.view.visible.some((e) => e.path === 'a.png'));
            await page.waitForSelector('#search-suggest .sg-chip');
            await page.click('#search-suggest .sg-chip');
            await page.waitForFunction(() => App.view.source.type === 'smart');
            assert.deepEqual(await cardNames(page), ['a.png']);
            assert.match(await page.textContent('.crumb.current'), /바다 풍경/);

            // Recent searches appear when the empty box gets focus
            await page.click('#search-input');
            await page.waitForSelector('#search-suggest .menu-header:has-text("최근 검색")');
            assert.ok(await page.isVisible('#search-suggest .sg-opt:has-text("바다")'));
            await page.keyboard.press('Escape');
            await page.waitForFunction(() => App.view.source.type === 'folder');
        },
    },
    {
        name: 'tree filter: names or initials narrow the tree to matches + ancestors, Enter opens, Esc clears',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await ready(page);
            await page.keyboard.press('Control+Shift+F');
            assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '폴더 찾기');
            await page.keyboard.type('ㅈㅈ');
            await page.waitForSelector(`${row('여행/2024 제주')} mark.hl`);
            const paths = await page.$$eval('.tree-row', (els) => els.map((e) => e.dataset.path).sort());
            assert.deepEqual(paths, ['', '여행', '여행/2024 제주'].sort());
            assert.equal(await page.textContent(`${row('여행/2024 제주')} mark.hl`), '제주');
            assert.ok(await page.isVisible(`${row('여행')}.ctx`), 'ancestors are shown dimmed');
            assert.match(await page.textContent('.tree-filter-info'), /1개/);
            // Rows stay drop targets while filtered
            assert.ok(await synthDrop(page, { to: row('여행/2024 제주'), paths: ['b.png'] }));
            await waitExists(page, '여행/2024 제주/b.png');
            await page.click('.tree-filter input');
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => App.state.cwd === '여행/2024 제주');
            // No matches -> friendly empty state
            await page.fill('.tree-filter input', '없는폴더');
            await page.waitForSelector('.tree-empty:not([hidden])');
            await page.keyboard.press('Escape');
            await page.waitForSelector('.tree-empty', { state: 'hidden' });
            assert.equal(await page.inputValue('.tree-filter input'), '');
            await page.waitForSelector(`${row('trip')}`);
            // Typing in the focused tree starts filtering
            await page.keyboard.press('Control+Shift+E');
            await page.keyboard.press('f');
            await page.waitForFunction(() => document.activeElement.matches('.tree-filter input') && document.activeElement.value === 'f');
            await page.waitForSelector(`${row('family')} mark.hl`);
        },
    },
    {
        name: '하위 폴더 포함 lists nested files with folder badges, is remembered per folder, survives reloads',
        async run({ openApp, assert, cardNames, waitIdle }) {
            const { page } = await openApp({ seed: SEED });
            await ready(page);
            await page.evaluate(() => App.nav.go('trip'));
            await page.waitForFunction(() => App.state.cwd === 'trip' && App.view.source.type === 'folder');
            assert.deepEqual(await cardNames(page), ['inner', 'x.png']);
            await page.keyboard.press('Alt+r');
            await page.waitForFunction(() => App.view.source.recursive === true);
            assert.deepEqual((await cardNames(page)).sort(), ['x.png', 'y.png', 'y2.png']);
            assert.equal(await page.getAttribute('.nav-rec-toggle', 'aria-pressed'), 'true');
            await page.waitForSelector('.card[data-path="trip/inner/y.png"] .nav-subdir');
            assert.equal(await page.textContent('.card[data-path="trip/inner/y.png"] .nav-subdir span'), 'inner');
            assert.equal(await page.locator('.card[data-path="trip/x.png"] .nav-subdir').count(), 0);
            // New files below show up without leaving the view
            await page.evaluate(() => App.fs.copy(['a.png'], 'trip/inner'));
            await page.waitForFunction(() => App.view.visible.some((e) => e.path === 'trip/inner/a.png'));
            // Remembered per folder
            await page.evaluate(() => App.nav.go('family'));
            await page.waitForFunction(() => App.state.cwd === 'family' && !App.view.source.recursive);
            await page.evaluate(() => App.nav.goBack());
            await page.waitForFunction(() => App.state.cwd === 'trip' && App.view.source.recursive === true);
            // Badge click jumps to the file's folder with the file selected
            await page.click('.card[data-path="trip/inner/y.png"] .nav-subdir');
            await page.waitForFunction(() => App.state.cwd === 'trip/inner');
            await page.waitForFunction(() => App.select.list().join() === 'trip/inner/y.png');
            // Survives a reload (flush first: a reload during the catalog's first save leaves an empty file)
            await waitIdle(page);
            await page.evaluate(() => App.catalog.flush());
            await page.waitForTimeout(150);
            await page.evaluate(() => App.catalog.flush());
            await page.reload();
            await page.waitForFunction(() => window.App && document.querySelector('#topbar').children.length > 0);
            await page.evaluate(() => window.__useExistingWorkspace());
            await page.evaluate(() => App.workspace.pick());
            await page.waitForFunction(() => App.state.cwd === '' && App.view.source.type === 'folder');
            await waitIdle(page);
            await page.evaluate(() => App.nav.go('trip'));
            await page.waitForFunction(() => App.view.source.recursive === true && App.view.visible.length === 4, null, { timeout: 15000 });
            await page.click('.nav-rec-toggle');
            await page.waitForFunction(() => !App.view.source.recursive);
            assert.deepEqual(await cardNames(page), ['inner', 'x.png']);
        },
    },
];
