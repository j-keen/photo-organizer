// Duplicate finder v2 — review freedom and safety: keyboard flow (←/→, 1/2, D, X, Enter), '중복 아님' memory and
// exclusions (persisted in dupes.json, undoable, following renames), the exclusions manager, resumable review with
// progress, folder roles in the keep suggestion, the rules dialog's live preview, re-verification before removing,
// bulk clean-up of 확실 groups as ONE undo, gallery/viewer entry points.
'use strict';
const { until, scanUI, reviewGroups, closePanel, trashList, exists } = require('./duplicates.test.js').helpers;

const IMG = (color, label, w = 400, h = 300) => ({ image: { w, h, color, label } });
const readJSON = async (page, p) => JSON.parse(await page.evaluate((x) => window.__opfs.read(x), p));

/** Three exact groups in different folders. */
const SEED3 = {
    'a/red.png': IMG('#c33', 'R'),
    'b/red.png': IMG('#c33', 'R'),
    'a/green.png': IMG('#2a6', 'G'),
    'b/green copy.png': IMG('#2a6', 'G'),
    'a/blue.png': IMG('#36c', 'B'),
    'c/blue.png': IMG('#36c', 'B'),
    'c/blue (2).png': IMG('#36c', 'B'),
};

const current = (page) => page.evaluate(() => {
    const rv = App.dupes.ui.active.rv;
    const g = rv.byId.get(rv.cur[rv.tab]);
    return g ? { id: g.id, paths: g.members.map((m) => m.path).sort(), resolved: g.resolved || null } : null;
});

module.exports = [
    {
        name: 'keyboard flow: ←/→ between groups, D = 중복 아님 (remembered, undoable), X = 이 파일 빼기, auto-advance, hint bar',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED3 });
            await page.waitForFunction(() => App.index.ready);
            await scanUI(page);
            assert.equal((await reviewGroups(page)).length, 3);
            assert.match(await page.textContent('.dup-hints'), /중복 아님/);
            assert.match(await page.textContent('.dup-hints'), /이 파일 빼기/);
            const first = await current(page);
            await page.keyboard.press('ArrowRight');
            const second = await current(page);
            assert.notEqual(second.id, first.id, '→ next group');
            await page.keyboard.press('ArrowLeft');
            assert.equal((await current(page)).id, first.id, '← previous group');

            // D: not duplicates → remembered as pairs in dupes.json, the group is resolved, we move on
            await page.keyboard.press('d');
            await until(page, (id) => App.dupes.ui.active.rv.byId.get(id).resolved === 'notdup', first.id, { message: 'resolved as notdup' });
            assert.notEqual((await current(page)).id, first.id, 'auto-advanced');
            const data = await readJSON(page, '.fluid-organizer/dupes.json');
            assert.ok(data.notDuplicates.some(([a, b]) => first.paths.includes(a) && first.paths.includes(b)), 'pair saved');
            assert.match(await page.textContent(`.dup-row[data-gid="${first.id}"]`), /중복 아님/);

            // X on the current group's compared member: excluded file, group dissolves (2 members) → next
            const cur = await current(page);
            const focus = await page.getAttribute('.dup-member.focused', 'data-path');
            assert.ok(cur.paths.includes(focus));
            await page.keyboard.press('x');
            await until(page, (p) => App.dupes.store.data.excludedFiles.includes(p), focus, { message: 'file excluded' });
            await page.waitForSelector('.toast:has-text("중복검사에서 뺐어요")');
            if (cur.paths.length === 2) await until(page, (id) => !!App.dupes.ui.active.rv.byId.get(id).resolved, cur.id, { message: 'dissolved' });

            // Ctrl+Z twice: the exclusion and the '중복 아님' are undone, both groups are live again
            await page.keyboard.press('Control+z');
            await until(page, (p) => !App.dupes.store.data.excludedFiles.includes(p), focus, { message: 'exclusion undone' });
            await page.keyboard.press('Control+z');
            await until(page, () => App.dupes.store.data.notDuplicates.length === 0, null, { message: 'pairs undone' });
            await until(page, () => {
                const rv = App.dupes.ui.active.rv;
                return rv.order.every((id) => !rv.byId.get(id).resolved);
            }, null, { message: 'all groups live again' });
            await closePanel(page);

            // A fresh scan never groups a remembered pair again
            await page.evaluate(() => App.dupes.markNotDuplicate(['a/red.png', 'b/red.png']));
            await page.evaluate(() => App.dupes.excludeFiles(['c/blue (2).png']));
            await scanUI(page);
            const groups = await reviewGroups(page);
            assert.ok(!groups.some((g) => g.paths.includes('a/red.png')), 'the red pair is not shown');
            assert.ok(!groups.some((g) => g.paths.includes('c/blue (2).png')), 'the excluded file is not scanned');
            assert.deepEqual(groups.map((g) => g.paths).sort(), [['a/blue.png', 'c/blue.png'], ['a/green.png', 'b/green copy.png']]);
        },
    },
    {
        name: 'exclusions manager lists files/folders/pairs and puts them back (undoable); exclusions follow a folder rename',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: SEED3 });
            await page.waitForFunction(() => App.index.ready);
            await page.evaluate(async () => {
                await App.dupes.excludeFiles(['a/red.png']);
                await App.dupes.excludeFolders(['c']);
                await App.dupes.markNotDuplicate([['a/green.png', 'b/green copy.png']]);
                await App.dupes.setFolderRole('b', 'keep');
            });
            // rename folder a → aa: everything that pointed into it follows
            await page.evaluate(() => App.fs.rename('a', 'aa'));
            await until(page, () => App.dupes.store.data.excludedFiles.includes('aa/red.png'), null, { message: 'excluded file followed the rename' });
            await until(page, async () => {
                try {
                    return JSON.parse(await window.__opfs.read('.fluid-organizer/dupes.json')).excludedFiles[0] === 'aa/red.png';
                } catch (e) {
                    return false;
                }
            }, null, { message: 'dupes.json written' });
            const d = await readJSON(page, '.fluid-organizer/dupes.json');
            assert.deepEqual(d.excludedFiles, ['aa/red.png']);
            assert.deepEqual(d.notDuplicates, [['aa/green.png', 'b/green copy.png']]);
            assert.deepEqual(d.excludedFolders, ['c']);
            assert.deepEqual(d.rules.folderPriority, [{ path: 'b', role: 'keep' }]);

            await page.evaluate(() => {
                App.commands.run('dupes.exclusions');
            });
            await page.waitForSelector('.dup-excl-panel .dup-excl-row');
            assert.match(await page.textContent('.dup-excl-panel .dup-excl-top'), /파일 1.*폴더 1.*중복 아님 1/);
            await page.click('.dup-excl-panel .dup-excl-row .btn:has-text("다시 넣기")');
            await until(page, () => App.dupes.store.data.excludedFiles.length === 0, null, { message: 'put back' });
            await page.waitForSelector('.dup-excl-panel .dup-excl-empty:not([hidden])');
            await page.keyboard.press('Control+z');
            await until(page, () => App.dupes.store.data.excludedFiles.length === 1, null, { message: 'undo inside the manager' });
            await page.click('.dup-excl-panel .seg button[data-value="folders"]');
            await page.click('.dup-excl-panel .dup-excl-row .btn:has-text("다시 넣기")');
            await until(page, () => App.dupes.store.data.excludedFolders.length === 0, null, { message: 'folder put back' });
            await page.keyboard.press('Escape');
            await page.waitForSelector('.dup-excl-panel', { state: 'detached' });
            await waitIdle(page);
        },
    },
    {
        name: 'resumable review: decisions are saved per scan; reopening (also after a reload) starts at the first unreviewed group with progress',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: SEED3 });
            await page.waitForFunction(() => App.index.ready);
            await scanUI(page);
            const order = (await reviewGroups(page)).map((g) => g.id);
            assert.equal(order.length, 3);
            assert.match(await page.textContent('.dup-prog-text'), /확실 3개 중 0개 확인/);
            // decide the first group by choosing its keeper (1) — no clean-up, just reviewed
            await page.keyboard.press('1');
            await until(page, (id) => App.dupes.store.data.lastScan.reviewed[id] === 'keep', order[0], { message: 'reviewed saved' });
            assert.match(await page.textContent('.dup-prog-text'), /3개 중 1개 확인/);
            await page.keyboard.press('ArrowRight');
            await page.keyboard.press('d');
            await until(page, () => Object.keys(App.dupes.store.data.lastScan.reviewed).length === 2, null, { message: 'two reviewed' });
            await closePanel(page);
            await until(page, async () => {
                try {
                    const d = JSON.parse(await window.__opfs.read('.fluid-organizer/dupes.json'));
                    return Object.keys(d.lastScan.reviewed).length === 2;
                } catch (e) {
                    return false; // mid-write
                }
            }, null, { message: 'progress written to dupes.json' });

            // Reopen: straight into the review, at the first group not decided yet
            await page.keyboard.press('Control+Alt+D');
            await page.waitForSelector('.dup-panel .dup-review');
            assert.equal((await current(page)).id, order[2], 'opens at the unreviewed group');
            assert.match(await page.textContent('.dup-prog-text'), /3개 중 2개 확인/);
            await closePanel(page);

            // After a reload (same browser), the same
            await page.reload();
            await page.waitForFunction(() => window.App && document.querySelector('#topbar').children.length > 0);
            await page.evaluate(() => window.__useExistingWorkspace());
            await page.evaluate(() => App.workspace.pick());
            await page.waitForFunction(() => App.index.ready && App.view.source.type === 'folder');
            await waitIdle(page);
            await page.keyboard.press('Control+Alt+D');
            await page.waitForSelector('.dup-panel .dup-review');
            assert.equal((await current(page)).id, order[2]);
            assert.match(await page.textContent('.dup-prog-text'), /3개 중 2개 확인/);
            // the setup screen offers to continue as well
            await page.click('.dup-panel .org-foot .btn:has-text("다시 찾기")');
            await page.waitForSelector('.dup-resume');
            assert.match(await page.textContent('.dup-resume'), /2개 확인함/);
            await page.click('.dup-resume .btn');
            await page.waitForSelector('.dup-panel .dup-review');
        },
    },
    {
        name: 'folder roles decide the keeper before resolution; the reason is shown; rules preview counts change live',
        async run({ openApp, assert }) {
            const scene = { color: '#3a6', label: 'SUN' };
            const { page } = await openApp({
                seed: {
                    'downloads/sun big.png': { image: { ...scene, w: 800, h: 600 } },
                    'library/sun.png': { image: { ...scene, w: 400, h: 300 } },
                    'x/one.png': IMG('#c33', 'R'),
                    'y/one.png': IMG('#c33', 'R'),
                },
            });
            await page.waitForFunction(() => App.index.ready);
            await page.evaluate(async () => {
                await App.dupes.setFolderRole('library', 'keep');
                await App.dupes.setFolderRole('downloads', 'remove');
            });
            await scanUI(page);
            await page.click('.dup-tabs button[data-value="unsure"]');
            const sun = (await reviewGroups(page)).find((g) => g.kind === 'image');
            assert.equal(sun.keep, 'library/sun.png', 'the keep folder wins over a bigger file');
            assert.match(await page.textContent('.dup-why'), /보관 폴더에 있어서 남겨요/);
            assert.ok(await page.isVisible('.dup-member[data-path="library/sun.png"] .dup-role-badge.keep'));
            assert.ok(await page.isVisible('.dup-member[data-path="downloads/sun big.png"] .dup-role-badge.remove'));

            // Role change is undoable and re-ranks immediately
            await page.keyboard.press('Control+z');
            await until(page, () => {
                const rv = App.dupes.ui.active.rv;
                const g = rv.order.map((id) => rv.byId.get(id)).find((x) => x.kind === 'image');
                return g && g.keep === 'library/sun.png' && App.dupes.store.data.rules.folderPriority.length === 1;
            }, null, { message: 'one role undone (library still keep)' });
            await page.keyboard.press('Control+z');
            await until(page, () => {
                const rv = App.dupes.ui.active.rv;
                const g = rv.order.map((id) => rv.byId.get(id)).find((x) => x.kind === 'image');
                return g && g.keep === 'downloads/sun big.png';
            }, null, { message: 'without roles the bigger file is kept' });

            // Rules: stricter photo rule → the preview shows one group less, saving applies it (one undo step)
            await page.click('.dup-panel .org-foot .btn[aria-label="규칙"]');
            await page.waitForSelector('.dup-rules-panel .dup-prev-cell');
            const slider = '.dup-rules-panel input[aria-label="비슷한 사진 기준"]';
            await page.$eval(slider, (el) => {
                el.value = '0';
                el.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await page.waitForFunction(() => /2 → 1/.test(document.querySelector('.dup-rules-panel .dup-prev-cell')?.textContent || ''));
            assert.match(await page.textContent('.dup-rules-panel .dup-rules-preview'), /애매1 → 0/);
            await page.click('.dup-rules-panel .org-foot .btn.primary');
            await page.waitForSelector('.dup-rules-panel', { state: 'detached' });
            await until(page, () => App.dupes.store.rules().imageBits === 0, null, { message: 'rule saved' });
            await until(page, () => {
                const rv = App.dupes.ui.active.rv;
                return rv.order.map((id) => rv.byId.get(id)).filter((g) => !g.resolved).length === 1;
            }, null, { message: 'review follows the rule' });
            await page.keyboard.press('Control+z');
            await until(page, () => App.dupes.store.rules().imageBits === 8, null, { message: 'rule change undone' });
        },
    },
    {
        name: 'better copy outside the keep folder: "옮겨서 남기기" moves it in and cleans the rest as ONE undo (owner rule B)',
        async run({ openApp, assert }) {
            const scene = { color: '#3a6', label: 'SUN' };
            const { page } = await openApp({
                seed: {
                    'downloads/sun_hd.png': { image: { ...scene, w: 800, h: 600 } },
                    'library/sun.png': { image: { ...scene, w: 400, h: 300 } },
                },
            });
            await page.waitForFunction(() => App.index.ready);
            await page.evaluate(async () => {
                await App.dupes.setFolderRole('library', 'keep');
                App.catalog.update('library/sun.png', { rating: 5, memo: '보관본' }, { undoable: false });
                App.undo.clear();
            });
            await scanUI(page);
            await page.click('.dup-tabs button[data-value="unsure"]');
            assert.equal((await reviewGroups(page))[0].keep, 'library/sun.png');
            await page.waitForSelector('.dup-upgrade');
            assert.match(await page.textContent('.dup-upgrade'), /800×600/);
            await page.keyboard.press('u');
            await until(page, () => window.__opfs.exists('library/sun_hd.png'), null, { message: 'better copy moved into the keep folder' });
            assert.ok(!(await exists(page, 'downloads/sun_hd.png')), 'moved, not copied');
            assert.deepEqual(await trashList(page), ['library/sun.png'], 'the worse copy went to the trash');
            const meta = await page.evaluate(() => App.catalog.get('library/sun_hd.png'));
            assert.equal(meta.rating, 5, 'the kept file got the rating');
            assert.equal(await page.evaluate(() => App.undo.list().length), 1, 'ONE undo step');
            await page.waitForSelector('.toast:has-text("보관 폴더로 옮겼어요")');
            const log = JSON.parse(await page.evaluate(() => window.__opfs.read('.fluid-organizer/dupes-log.json')));
            assert.equal(log.entries[0].groups[0].movedFrom, 'downloads/sun_hd.png');

            await page.keyboard.press('Control+z');
            await until(page, async () => (await window.__opfs.exists('downloads/sun_hd.png')) && (await window.__opfs.exists('library/sun.png')), null, { message: 'undo puts both back' });
            assert.ok(!(await exists(page, 'library/sun_hd.png')));
            assert.equal(await page.evaluate(() => App.catalog.get('library/sun.png').rating), 5);
            assert.equal(await page.evaluate(() => App.catalog.get('downloads/sun_hd.png').rating || 0), 0, 'metadata merge undone');
        },
    },
    {
        name: 'safety: re-verify before removing — changed or missing keeper skips the group, bulk skips clips and edits, honest result',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED3 });
            await page.waitForFunction(() => App.index.ready);
            await scanUI(page);
            const groups = await reviewGroups(page);
            const red = groups.find((g) => g.paths.includes('a/red.png'));
            const green = groups.find((g) => g.paths.includes('a/green.png'));
            const blue = groups.find((g) => g.paths.includes('a/blue.png'));

            // 1) keeper of the red group changes after the scan → skipped with a reason, nothing removed
            await page.evaluate(async (keep) => {
                const other = await App.fs.getFile('a/blue.png');
                await App.fs.overwrite(keep, other, { undoable: false });
            }, red.keep);
            await page.click(`.dup-row[data-gid="${red.id}"]`);
            await page.click('.dup-dhead .btn.primary');
            await page.waitForSelector('.toast:has-text("그대로 뒀어요")');
            assert.match(await page.textContent('.toast:has-text("그대로 뒀어요")'), /보관할 파일이 바뀌어서/);
            await page.evaluate(() => document.querySelectorAll('.toast .toast-close').forEach((b) => b.click()));
            for (const p of red.paths) assert.ok(await exists(page, p), `${p} untouched`);

            // 2) bulk: a member with clips (보관함) and a member with video edits are skipped, the rest is cleaned in ONE step
            const greenCopy = green.paths.find((p) => p !== green.keep);
            const blueCopies = blue.paths.filter((p) => p !== blue.keep);
            await page.evaluate(({ withClip, withEdit }) => {
                window.__origClips = App.clips;
                App.clips = Object.assign(Object.create(App.clips || {}), { forPath: (p) => (p === withClip ? [{ id: 'c1', path: p, start: 0, end: 1 }] : []) });
                App.catalog.update(withEdit, (e) => {
                    e.meta = { ...(e.meta || {}), edit: { cuts: [0.5], removed: [], updatedAt: Date.now() } };
                }, { undoable: false });
                App.undo.clear();
            }, { withClip: greenCopy, withEdit: blueCopies[0] });
            await page.click('.dup-panel .org-foot .btn.danger');
            await page.waitForSelector('.dup-panel .org-sheet');
            assert.match(await page.textContent('.org-sheet'), /지우기 직전에/);
            await page.keyboard.press('Enter');
            await page.waitForSelector('.toast:has-text("그대로 뒀어요")');
            await page.waitForSelector('.toast:has-text("휴지통으로 옮겼어요")');
            const trashed = await trashList(page);
            assert.deepEqual(trashed, blueCopies.slice(1).sort(), `only the unprotected copy goes (red group skipped: keeper changed): ${trashed}`);
            assert.ok(await exists(page, greenCopy), 'member with clips kept');
            assert.ok(await exists(page, blueCopies[0]), 'member with edits kept');
            assert.equal(await page.evaluate(() => App.undo.list().length), 1, 'ONE undo step');
            await page.click('.toast:has-text("그대로 뒀어요") .toast-action');
            await page.waitForSelector('.dup-skipped-row');
            const reasons = await page.$$eval('.dup-skipped-why', (els) => els.map((e) => e.textContent));
            assert.ok(reasons.some((r) => /보관함/.test(r)) && reasons.some((r) => /편집/.test(r)), reasons.join(' / '));
            await page.keyboard.press('Escape');
            await page.evaluate(() => {
                App.clips = window.__origClips;
            });

            // 3) a missing keeper: never remove the last copies
            await page.keyboard.press('Control+z');
            await until(page, () => App.fs.listTrash().then((l) => l.every((i) => !/blue/.test(i.originalPath))), null, { message: 'undo restores' });
            const res = await page.evaluate(async (g) => {
                const rv = App.dupes.ui.active.rv;
                const group = rv.byId.get(g.id);
                await App.fs.trash([group.keep], { undoable: false, silent: true });
                return App.dupes.apply([{ group, keep: group.keep, remove: group.members.map((m) => m.path).filter((p) => p !== group.keep) }]);
            }, blue);
            assert.equal(res.removed.length, 0);
            assert.ok(res.skipped.every((s) => /보관할 파일이 없어서/.test(s.reason)), JSON.stringify(res.skipped));
            for (const p of blueCopies) assert.ok(await exists(page, p), `${p} kept because its keeper is gone`);
        },
    },
    {
        name: 'redo re-verifies (a keeper changed after the undo is protected); review progress follows a folder rename',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED3 });
            await page.waitForFunction(() => App.index.ready);
            await scanUI(page);
            const groups = await reviewGroups(page);
            const red = groups.find((g) => g.paths.includes('a/red.png'));
            await page.click(`.dup-row[data-gid="${red.id}"]`);
            await page.keyboard.press('Enter');
            await until(page, () => App.fs.listTrash().then((l) => l.length === 1), null, { message: 'cleaned' });
            await page.keyboard.press('Control+z');
            await until(page, () => App.fs.listTrash().then((l) => l.length === 0), null, { message: 'undone' });
            // the keeper changes while the clean-up sits in the redo stack
            await page.evaluate(async (keep) => {
                await App.fs.overwrite(keep, await App.fs.getFile('a/blue.png'), { undoable: false });
            }, red.keep);
            await page.evaluate(() => document.querySelectorAll('.toast .toast-close').forEach((b) => b.click()));
            await page.evaluate(() => App.undo.redo());
            await page.waitForSelector('.toast:has-text("그대로 뒀어요")');
            assert.match(await page.textContent('.toast:has-text("그대로 뒀어요")'), /보관할 파일이 바뀌어서/);
            const trashed = await trashList(page);
            assert.ok(!trashed.some((p) => red.paths.includes(p) && p !== red.keep), `the copy is still there: ${trashed}`);

            // decide the blue group (in folder c) by choosing its keeper, then rename c → cc while the review is open
            const blue = groups.find((g) => g.paths.includes('c/blue.png'));
            await page.click(`.dup-row[data-gid="${blue.id}"]`);
            await page.keyboard.press('2');
            await until(page, (id) => App.dupes.store.data.lastScan.reviewed[id] === 'keep', blue.id, { message: 'reviewed' });
            const chosen = await page.evaluate((id) => App.dupes.ui.active.rv.choice.get(id).keep, blue.id);
            await page.evaluate(() => App.fs.rename('c', 'cc'));
            await until(page, () => {
                const rv = App.dupes.ui.active.rv;
                const g = rv.order.map((id) => rv.byId.get(id)).find((x) => x.members.some((m) => m.path === 'cc/blue.png'));
                return g && !g.resolved && rv.decisions.get(g.id) === 'keep';
            }, null, { message: 'decision follows the renamed group' });
            const after = await page.evaluate(() => {
                const rv = App.dupes.ui.active.rv;
                const g = rv.order.map((id) => rv.byId.get(id)).find((x) => x.members.some((m) => m.path === 'cc/blue.png'));
                return { id: g.id, keep: rv.choice.get(g.id)?.keep, saved: App.dupes.store.data.lastScan.reviewed[g.id] };
            });
            assert.notEqual(after.id, blue.id, 'new id (paths changed)');
            assert.equal(after.saved, 'keep', 'saved progress moved to the new id');
            assert.equal(after.keep, chosen.replace(/^c\//, 'cc/'), 'the chosen keeper follows the rename');
        },
    },
    {
        name: 'entry points: gallery menu (find same, exclude file/folder, folder roles), viewer toolbar exclude toggle',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: SEED3 });
            await page.waitForFunction(() => App.index.ready);
            await page.evaluate(() => App.nav.go('a'));
            await page.waitForFunction(() => App.state.cwd === 'a');
            await waitIdle(page);
            const items = await page.evaluate(() => {
                const e = App.index.get('a/red.png');
                const out = App.dupes.tools.contextItems([e]);
                return out.map((x) => ({ label: x.label, sub: (x.submenu || []).filter((s) => s !== '-').map((s) => s.label) }));
            });
            assert.equal(items[0].label, '중복검사');
            assert.ok(items[0].sub.includes('이 파일과 같은 것 찾기'));
            assert.ok(items[0].sub.includes('이 파일은 중복검사에서 빼기'));
            const dirItems = await page.evaluate(() => App.dupes.tools.contextItems([{ kind: 'dir', path: 'b', name: 'b', type: 'dir' }])[0].submenu.filter((s) => s !== '-').map((s) => s.label));
            assert.ok(dirItems.includes('이 폴더에서 중복 찾기'));
            assert.ok(dirItems.includes('이 폴더는 중복검사에서 빼기'));
            assert.ok(dirItems.some((l) => /보관 폴더/.test(l)));

            // right-click a card → 중복검사 → 이 파일과 같은 것 찾기
            await page.click('.card[data-path="a/red.png"]', { button: 'right' });
            await page.click('.menu-item:has-text("중복검사")');
            await page.click('.menu-item:has-text("이 파일과 같은 것 찾기")');
            await page.waitForSelector('.dup-panel .dup-review', { timeout: 30000 });
            assert.deepEqual((await reviewGroups(page)).map((g) => g.paths), [['a/red.png', 'b/red.png']]);
            assert.match(await page.textContent('.org-head-title'), /red\.png/);
            await closePanel(page);

            // viewer toolbar: exclude / include the current file
            await page.evaluate(() => App.viewer.open('a/green.png'));
            await page.waitForSelector('.dup-vw-btn');
            assert.match(await page.textContent('.dup-vw-btn'), /중복검사 제외/);
            await page.click('.dup-vw-btn');
            await until(page, () => App.dupes.store.data.excludedFiles.includes('a/green.png'), null, { message: 'excluded from the viewer' });
            await page.waitForSelector('.dup-vw-btn.active');
            await page.keyboard.press('Control+z');
            await until(page, () => !App.dupes.store.data.excludedFiles.includes('a/green.png'), null, { message: 'undo from the viewer' });
            await page.waitForSelector('.dup-vw-btn:not(.active)');
            await page.keyboard.press('Escape');
            // folder role via command
            await page.evaluate(() => App.commands.run('dupes.role.keep', { path: 'b' }));
            await until(page, () => App.dupes.store.roleOf('b/red.png') === 'keep', null, { message: 'role set' });
        },
    },
];
