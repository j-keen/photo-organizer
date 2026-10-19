// Clip library "보관함" (clips team): App.clips model, sidebar list, playback, export, frames, inspector, badges.
'use strict';

const SEED = {
    'videos/여행.webm': { video: { seconds: 3 } },
    'videos/콘서트.webm': { video: { seconds: 2 } },
    'videos/old.avi': { bytes: [1, 2, 3, 4, 5, 6, 7, 8] },
    'a.png': { image: {} },
};

async function ready(page) {
    await page.waitForFunction(() => App.clips?.ready && App.chipset?.ready);
}

// Three clips: two from 여행.webm, one from 콘서트.webm. Returns their ids (library order) and the chip id.
async function seedClips(page) {
    await ready(page);
    return page.evaluate(() => {
        const chip = App.chipset.createAndApply(null, '배우A', [], { hud: false });
        const made = App.clips.add([
            { path: 'videos/여행.webm', start: 0.4, end: 1.6, memo: '바다 장면\n노을이 예뻐요', chips: [chip] },
            { path: 'videos/콘서트.webm', start: 0.2, end: 1.4 },
            { path: 'videos/여행.webm', start: 1.8, end: 2.6, title: '마지막 인사', chips: [chip] },
        ], { notify: false });
        return { ids: made.map((c) => c.id), chip };
    });
}

async function reopen(page, waitIdle) {
    await page.reload();
    await page.waitForFunction(() => window.App && document.querySelector('#topbar').children.length > 0);
    await page.evaluate(() => window.__useExistingWorkspace());
    await page.evaluate(() => App.workspace.pick());
    await page.waitForFunction(() => App.state.cwd === '' && App.view.source.type === 'folder');
    await waitIdle(page);
}

const rowTitles = (page) => page.$$eval('.clips-row', (els) => els.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map((e) => e.querySelector('.clips-title').textContent));

module.exports = [
    {
        name: 'clips: add/update/remove/reorder are one undo step each, typing coalesces, and clips.json is saved',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            const { ids } = await seedClips(page);
            assert.equal(ids.length, 3);
            const r = await page.evaluate(async (ids) => {
                const C = App.clips;
                const out = {};
                out.forPath = C.forPath('videos/여행.webm').map((c) => c.start);
                // typing: three updates with the same coalesceKey = one undo step
                C.update(ids[1], { memo: '앵' }, { coalesceKey: 'm' });
                C.update(ids[1], { memo: '앵콜' }, { coalesceKey: 'm' });
                C.update(ids[1], { memo: '앵콜 무대' }, { coalesceKey: 'm' });
                await App.undo.undo({ quiet: true });
                out.afterUndoMemo = C.get(ids[1]).memo;
                await App.undo.redo({ quiet: true });
                out.afterRedoMemo = C.get(ids[1]).memo;
                // reorder (full list) and undo
                C.reorder([ids[2], ids[0], ids[1]]);
                out.reordered = C.list().map((c) => c.id);
                await App.undo.undo({ quiet: true });
                out.reorderUndone = C.list().map((c) => c.id);
                // partial reorder only swaps those two slots
                C.reorder([ids[2], ids[0]]);
                out.partial = C.list().map((c) => c.id);
                await App.undo.undo({ quiet: true });
                // remove two → one step; undo puts them back in place
                C.remove([ids[0], ids[2]], { notify: false });
                out.afterRemove = C.list().map((c) => c.id);
                await App.undo.undo({ quiet: true });
                out.afterRemoveUndo = C.list().map((c) => c.id);
                // invalid range is refused
                try {
                    C.update(ids[0], { start: 5, end: 1 });
                    out.invalid = 'accepted';
                } catch (e) {
                    out.invalid = e.code;
                }
                out.search = C.search('ㅂㄷ').map((c) => c.id);
                out.searchChip = C.search('배우').length;
                out.title = C.displayTitle(C.get(ids[1]));
                await C.flush();
                out.file = JSON.parse(await window.__opfs.read('.fluid-organizer/clips.json'));
                return out;
            }, ids);
            assert.deepEqual(r.forPath, [0.4, 1.8]);
            assert.equal(r.afterUndoMemo, '');
            assert.equal(r.afterRedoMemo, '앵콜 무대');
            assert.deepEqual(r.reordered, [ids[2], ids[0], ids[1]]);
            assert.deepEqual(r.reorderUndone, ids);
            assert.deepEqual(r.partial, [ids[2], ids[1], ids[0]]);
            assert.deepEqual(r.afterRemove, [ids[1]]);
            assert.deepEqual(r.afterRemoveUndo, ids);
            assert.equal(r.invalid, 'EINVAL');
            assert.deepEqual(r.search, [ids[0]]);
            assert.equal(r.searchChip, 2);
            assert.equal(r.title, '앵콜 무대');
            assert.equal(r.file.version, 1);
            assert.deepEqual(r.file.clips.map((c) => c.id), ids);
            assert.equal(r.file.clips[0].memo, '바다 장면\n노을이 예뻐요');
        },
    },
    {
        name: 'clips: follow renames, folder moves and trash/restore of the video; survive a reload',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: SEED });
            const { ids } = await seedClips(page);
            await page.evaluate(() => App.fs.rename('videos/여행.webm', 'trip.webm'));
            assert.deepEqual(await page.evaluate((id) => App.clips.get(id).path, ids[0]), 'videos/trip.webm');
            await page.evaluate(() => App.fs.mkdir('', 'archive'));
            await page.evaluate(() => App.fs.move(['videos'], 'archive'));
            assert.deepEqual(await page.evaluate(() => App.clips.list().map((c) => c.path)), ['archive/videos/trip.webm', 'archive/videos/콘서트.webm', 'archive/videos/trip.webm']);
            // trash hides its clips; undo (restore) brings them back
            await page.evaluate(() => App.fs.trash(['archive/videos/trip.webm']));
            assert.equal(await page.evaluate(() => App.clips.list().length), 1);
            assert.equal(await page.evaluate(() => App.clips.list({ includeMissing: true }).filter((c) => c.missing).length), 2);
            await page.waitForSelector('.clips-note:not([hidden])');
            await page.evaluate(() => App.undo.undo({ quiet: true }));
            assert.equal(await page.evaluate(() => App.clips.list().length), 3);
            await page.waitForSelector('.clips-note', { state: 'hidden' });
            // undo the move: paths follow back
            await page.evaluate(() => App.undo.undo({ quiet: true }));
            assert.equal(await page.evaluate((id) => App.clips.get(id).path, ids[1]), 'videos/콘서트.webm');
            await page.evaluate(() => App.clips.flush());
            await reopen(page, waitIdle);
            await page.waitForFunction(() => App.clips.ready && App.clips.list().length === 3);
            assert.deepEqual(await page.evaluate(() => App.clips.list().map((c) => c.path)), ['videos/trip.webm', 'videos/콘서트.webm', 'videos/trip.webm']);
            await page.waitForSelector('.clips-row');
            assert.equal(await page.locator('.clips-row').count(), 3);
        },
    },
    {
        name: 'clips: a video restored under a numbered name keeps its clips; a newer rescue copy wins after a lost save',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: SEED });
            const { ids } = await seedClips(page);
            const ids2 = await page.evaluate(() => App.fs.trash(['videos/콘서트.webm'], { undoable: false, silent: true }));
            assert.equal(await page.evaluate((id) => App.clips.get(id).missing, ids[1]), true);
            // the name is taken again before the restore → "콘서트 (2).webm"
            await page.evaluate(() => App.fs.createFile('videos', '콘서트.webm', new Blob(['x']), { undoable: false }));
            const restored = await page.evaluate((t) => App.fs.restore(t), ids2);
            assert.deepEqual(restored, ['videos/콘서트 (2).webm']);
            const c = await page.evaluate((id) => App.clips.get(id), ids[1]);
            assert.equal(c.path, 'videos/콘서트 (2).webm');
            assert.ok(!c.missing);
            // Rescue copy: a save that never reached the folder (newer rev in IndexedDB) is brought back on open
            await page.evaluate(() => App.clips.flush());
            await page.evaluate(async () => {
                const ws = App.state.workspace.id;
                const copy = JSON.parse(await window.__opfs.read('.fluid-organizer/clips.json'));
                copy.rev = Date.now() + 60000;
                copy.clips.push({ id: 'rescued', path: 'videos/여행.webm', start: 0, end: 1, title: '되살린 조각', memo: '', chips: [], order: 9, createdAt: 1, updatedAt: 1 });
                await App.idb.set(`clips.${ws}`, copy);
            });
            await reopen(page, waitIdle);
            await page.waitForFunction(() => App.clips.ready && !!App.clips.get('rescued'));
            await page.evaluate(() => App.clips.flush());
            const file = JSON.parse(await page.evaluate(() => window.__opfs.read('.fluid-organizer/clips.json')));
            assert.ok(file.clips.some((x) => x.id === 'rescued'));
        },
    },
    {
        name: 'clips: sidebar list — empty state, search by initials, chip filter, multi-select, Delete + Ctrl+Z',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await ready(page);
            await page.waitForSelector('.clips-empty:not([hidden])');
            assert.match(await page.textContent('.clips-empty'), /아직 담은 조각이 없어요/);
            assert.match(await page.textContent('.clips-empty'), /뷰어에서/);
            const { ids } = await seedClips(page);
            await page.waitForFunction(() => document.querySelectorAll('.clips-row').length === 3);
            assert.deepEqual(await rowTitles(page), ['바다 장면', '콘서트 00:00–00:01', '마지막 인사']);
            // footer: count + total
            assert.match(await page.textContent('.clips-foot'), /3개/);
            // search with Hangul initials
            await page.fill('.clips-search .input', 'ㅁㅈㅁ');
            await page.waitForFunction(() => document.querySelectorAll('.clips-row').length === 1);
            assert.deepEqual(await rowTitles(page), ['마지막 인사']);
            await page.press('.clips-search .input', 'Escape');
            await page.waitForFunction(() => document.querySelectorAll('.clips-row').length === 3);
            // chip filter + scope label
            await page.click('.clips-token');
            await page.waitForFunction(() => document.querySelectorAll('.clips-row').length === 2);
            assert.equal(await page.evaluate(() => App.clipsUi.scope().label), '배우A 조각 2개');
            assert.equal(await page.evaluate(() => App.commands.get('clips.playSequence').title), '배우A 조각 2개 이어 보기');
            await page.click('.clips-token');
            await page.waitForFunction(() => document.querySelectorAll('.clips-row').length === 3);
            // multi-select: ctrl + shift (no playback for modified clicks)
            const row = (i) => page.locator(`.clips-row[data-id="${ids[i]}"] .clips-title`);
            await row(0).click({ modifiers: ['Control'] });
            await row(2).click({ modifiers: ['Shift'] });
            assert.deepEqual((await page.evaluate(() => App.clipsUi.state.selected)).sort(), ids.slice().sort());
            await row(1).click({ modifiers: ['Control'] });
            assert.equal(await page.locator('.clips-row.sel').count(), 2);
            assert.equal(await page.evaluate(() => App.viewer.isOpen), false);
            assert.match(await page.textContent('.clips-foot'), /2개 선택/);
            // Delete removes the selection (one step), Ctrl+Z brings both back
            await page.keyboard.press('Delete');
            await page.waitForFunction(() => App.clips.list().length === 1);
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => App.clips.list().length === 3);
            assert.deepEqual(await page.evaluate(() => App.clips.list().map((c) => c.id)), ids);
            // keyboard: ↓ moves, Alt+↓ reorders, Esc clears
            await page.focus('.clips-list');
            await page.keyboard.press('Home');
            await page.keyboard.press('Alt+ArrowDown');
            await page.waitForFunction((id) => App.clips.list()[1].id === id, ids[0]);
            await page.keyboard.press('Control+z');
            await page.waitForFunction((id) => App.clips.list()[0].id === id, ids[0]);
            // typing in the list starts the search
            await page.focus('.clips-list');
            await page.keyboard.type('콘');
            assert.equal(await page.inputValue('.clips-search .input'), '콘');
        },
    },
    {
        name: 'clips: click plays the range — openAt when the viewer has it, otherwise the viewer seeks to the start',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            const { ids } = await seedClips(page);
            await page.waitForSelector('.clips-row');
            // 1) With App.viewer.openAt / playSequence (round-2 viewer API)
            await page.evaluate(() => {
                window.__calls = [];
                window.__saved = { openAt: App.viewer.openAt, playSequence: App.viewer.playSequence };
                App.viewer.openAt = (p, o) => window.__calls.push(['openAt', p, o]);
                App.viewer.playSequence = (items, o) => window.__calls.push(['seq', items, o]);
            });
            await page.click(`.clips-row[data-id="${ids[1]}"] .clips-title`);
            let calls = await page.evaluate(() => window.__calls);
            assert.deepEqual(calls[0], ['openAt', 'videos/콘서트.webm', { start: 0.2, end: 1.4, loop: true, autoplay: true }]);
            // 이어 보기 with nothing selected but a chip filter → the filtered clips
            await page.evaluate(() => App.clipsUi.setFilter({ chips: [App.clips.get(App.clips.list()[0].id).chips[0]] }));
            await page.evaluate(() => App.select.clear());
            await page.focus('.clips-list');
            await page.keyboard.press('Escape');
            await page.evaluate(() => App.commands.run('clips.playSequence'));
            calls = await page.evaluate(() => window.__calls);
            const seq = calls.find((c) => c[0] === 'seq');
            assert.ok(seq, 'playSequence called');
            assert.deepEqual(seq[1].map((x) => [x.path, x.start, x.end]), [['videos/여행.webm', 0.4, 1.6], ['videos/여행.webm', 1.8, 2.6]]);
            assert.equal(seq[2].title, '배우A');
            await page.evaluate(() => App.clipsUi.clearFilter());
            // 2) Fallback without openAt: App.viewer.open(path, {time}) at the clip start
            await page.evaluate(() => {
                App.viewer.openAt = undefined;
                App.viewer.playSequence = undefined;
            });
            await page.click(`.clips-row[data-id="${ids[2]}"] .clips-title`);
            await page.waitForFunction(() => App.viewer.isOpen && App.viewer.current?.path === 'videos/여행.webm');
            await page.waitForFunction(() => App.viewer.player && App.viewer.player.time >= 1.7, null, { timeout: 15000 });
            await page.keyboard.press('Escape');
            await page.waitForFunction(() => !App.viewer.isOpen);
        },
    },
    {
        name: 'clips: drag a clip to reorder (one undo step)',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            const { ids } = await seedClips(page);
            await page.waitForFunction(() => document.querySelectorAll('.clips-row').length === 3);
            const src = page.locator(`.clips-row[data-id="${ids[0]}"]`);
            const dst = page.locator(`.clips-row[data-id="${ids[2]}"]`);
            const box = await dst.boundingBox();
            await src.dragTo(dst, { targetPosition: { x: 40, y: box.height - 4 } });
            await page.waitForFunction((id) => App.clips.list()[2].id === id, ids[0]);
            assert.deepEqual(await page.evaluate(() => App.clips.list().map((c) => c.id)), [ids[1], ids[2], ids[0]]);
            assert.equal(await page.evaluate(() => App.undo.peek().label), '보관함 순서 바꾸기');
            await page.evaluate(() => App.undo.undo({ quiet: true }));
            assert.deepEqual(await page.evaluate(() => App.clips.list().map((c) => c.id)), ids);
        },
    },
    {
        name: 'clips: export without the local server opens the setup sheet instead of failing',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await seedClips(page);
            await page.evaluate(() => {
                window.__setup = 0;
                App.server.showSetup = () => {
                    window.__setup++;
                };
            });
            await page.evaluate(() => App.commands.run('clips.exportConcat'));
            await page.evaluate(() => App.commands.run('clips.exportEach'));
            assert.equal(await page.evaluate(() => window.__setup), 2);
            assert.equal(await page.locator('.dialog').count(), 0);
        },
    },
    {
        name: 'clips: 하나로 저장 / 각각 저장 through the server — one undo step each, chips + memo + source carried over',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            const { ids, chip } = await seedClips(page);
            // Fake local server: copies the first source as the "output"
            await page.evaluate(() => {
                const P = App.util.path;
                Object.defineProperty(App.server, 'available', { get: () => true, configurable: true });
                Object.defineProperty(App.server, 'backend', { get: () => ({ kind: 'fake' }), configurable: true });
                App.server.canUse = () => true;
                const jobs = new Map();
                window.__posts = [];
                const make = async (src, out) => {
                    const file = await App.fs.getFile(src);
                    await App.fs.backend.write(out, file);
                    const id = 'j' + (jobs.size + 1);
                    jobs.set(id, out);
                    return { id, state: 'running', progress: 0.3 };
                };
                App.server.job = async (id) => ({ id, state: 'done', progress: 1, result: { path: jobs.get(id) } });
                App.server.video = {
                    concat: async (body) => {
                        window.__posts.push(['concat', body]);
                        return make(body.segments[0].path, body.output);
                    },
                    trim: async (body) => {
                        window.__posts.push(['trim', body]);
                        let n = 1;
                        let out;
                        do out = `${P.parent(body.path)}/${P.stem(body.path)}_cut${String(n++).padStart(2, '0')}.${P.ext(body.path)}`;
                        while (await App.fs.exists(out));
                        return make(body.path, out);
                    },
                };
            });
            // 하나로 저장 of the whole library
            await page.evaluate(() => {
                App.commands.run('clips.exportConcat');
            });
            await page.waitForSelector('.dialog .clipx');
            await page.fill('.dialog .clipx-name .input', '하이라이트');
            await page.click('.dialog-foot .btn.primary');
            await page.waitForFunction(() => App.catalog.peek('videos/하이라이트.mp4')?.meta?.source);
            const posts = await page.evaluate(() => window.__posts);
            assert.deepEqual(posts[0][1].segments.map((s) => s.path), ['videos/여행.webm', 'videos/콘서트.webm', 'videos/여행.webm']);
            assert.equal(posts[0][1].output, 'videos/하이라이트.mp4');
            const meta = await page.evaluate(() => App.catalog.get('videos/하이라이트.mp4'));
            assert.deepEqual(meta.chips, [chip]);
            assert.match(meta.memo, /1\. 여행\.webm 00:00–00:01 — 바다 장면/);
            assert.equal(meta.meta.source.length, 3);
            assert.equal(await page.evaluate(() => App.undo.peek().label), '조각 3개 하나로 저장');
            await page.evaluate(() => App.undo.undo({ quiet: true }));
            assert.equal(await page.evaluate(() => window.__opfs.exists('videos/하이라이트.mp4')), false);
            await page.evaluate(() => App.undo.redo({ quiet: true }));
            assert.equal(await page.evaluate(() => window.__opfs.exists('videos/하이라이트.mp4')), true);
            assert.deepEqual(await page.evaluate(() => App.catalog.get('videos/하이라이트.mp4').chips), [chip]);
            // 각각 저장 of two selected clips with the name template
            await page.click(`.clips-row[data-id="${ids[0]}"] .clips-title`, { modifiers: ['Control'] });
            await page.click(`.clips-row[data-id="${ids[2]}"] .clips-title`, { modifiers: ['Control'] });
            await page.evaluate(() => {
                App.commands.run('clips.exportEach');
            });
            await page.waitForSelector('.dialog .clipx-preview-row');
            assert.match(await page.textContent('.dialog .clipx-preview'), /여행_00m00s-00m01s_바다 장면\.webm/);
            await page.click('.dialog-foot .btn.primary');
            await page.waitForFunction(() => App.undo.peek()?.label === '조각 2개 각각 저장');
            const files = await page.evaluate(() => window.__opfs.list('videos'));
            assert.ok(files.includes('여행_00m00s-00m01s_바다 장면.webm'), files.join());
            assert.ok(files.includes('여행_00m01s-00m02s_마지막 인사.webm'), files.join());
            const one = await page.evaluate(() => App.catalog.get('videos/여행_00m01s-00m02s_마지막 인사.webm'));
            assert.match(one.memo, /마지막 인사\n출처: 여행\.webm 00:01–00:02/);
            assert.deepEqual(one.meta.source, [{ path: 'videos/여행.webm', start: 1.8, end: 2.6 }]);
            assert.equal(await page.evaluate(() => window.__posts.filter((p) => p[0] === 'trim')[0][1].mode), 'accurate');
            await page.evaluate(() => App.undo.undo({ quiet: true }));
            const after = await page.evaluate(() => window.__opfs.list('videos'));
            assert.ok(!after.some((n) => n.startsWith('여행_00m')), after.join());
        },
    },
    {
        name: 'clips: frame thumbnails are captured once and cached; undecodable formats show their name',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: SEED });
            await ready(page);
            await page.evaluate(() => {
                App.settings.set('thumbs.autoPregenerate', true);
                App.clips.add([
                    { path: 'videos/여행.webm', start: 1.2, end: 2 },
                    { path: 'videos/old.avi', start: 3, end: 9 },
                ], { notify: false });
            });
            await page.waitForSelector('.clips-thumb img', { timeout: 20000 });
            await page.waitForSelector('.clips-thumb.failed');
            assert.match(await page.textContent('.clips-thumb.failed'), /AVI/);
            const first = await page.evaluate(() => App.clipsFrames.stats());
            assert.equal(first.captures, 1);
            await page.evaluate(() => App.clips.flush());
            await page.waitForTimeout(300);
            await reopen(page, waitIdle);
            await page.waitForSelector('.clips-thumb img', { timeout: 20000 });
            const second = await page.evaluate(() => App.clipsFrames.stats());
            assert.equal(second.captures, 0);
            assert.ok(second.hits >= 1);
        },
    },
    {
        name: 'clips: inspector lists the selected video\'s clips; video cards get a badge that filters the library',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            await seedClips(page);
            await page.evaluate(() => App.nav.go('videos'));
            await page.waitForFunction(() => App.view.source.path === 'videos');
            await page.waitForSelector('.card[data-path="videos/여행.webm"] .clips-badge');
            assert.equal((await page.textContent('.card[data-path="videos/여행.webm"] .clips-badge')).trim(), '2');
            assert.equal(await page.locator('.card[data-path="videos/old.avi"] .clips-badge').count(), 0);
            await (await card(page, '여행.webm')).click();
            await page.waitForSelector('.insp-sec-clips .clips-insp-row');
            assert.equal(await page.locator('.insp-sec-clips .clips-insp-row').count(), 2);
            // a new clip shows up in the inspector and the badge
            await page.evaluate(() => App.clips.add({ path: 'videos/여행.webm', start: 2.6, end: 2.9 }, { notify: false }));
            await page.waitForFunction(() => document.querySelectorAll('.insp-sec-clips .clips-insp-row').length === 3);
            await page.waitForFunction(() => document.querySelector('.card[data-path="videos/여행.webm"] .clips-badge')?.textContent.trim() === '3');
            // badge → library filtered to that video
            await page.click('.card[data-path="videos/콘서트.webm"] .clips-badge');
            await page.waitForFunction(() => App.clipsUi.state.path === 'videos/콘서트.webm' && document.querySelectorAll('.clips-row').length === 1);
            assert.ok(await page.isVisible('.clips-token.is-path'));
            await page.click('.clips-token.is-path');
            await page.waitForFunction(() => document.querySelectorAll('.clips-row').length === 4);
            // inspector row click plays that range (openAt stubbed)
            await page.evaluate(() => {
                window.__calls = [];
                App.viewer.openAt = (p, o) => window.__calls.push([p, o.start, o.end]);
            });
            await page.click('.insp-sec-clips .clips-insp-row >> nth=0');
            assert.deepEqual(await page.evaluate(() => window.__calls[0]), ['videos/여행.webm', 0.4, 1.6]);
        },
    },
    {
        name: 'clips: memo dialog saves while typing (one undo step) and edits the range',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            const { ids } = await seedClips(page);
            await page.waitForSelector('.clips-row');
            await page.click(`.clips-row[data-id="${ids[1]}"] .clips-title`, { modifiers: ['Control'] });
            await page.focus('.clips-list');
            await page.keyboard.press('F2');
            await page.waitForSelector('.dialog .clips-memo');
            await page.type('.dialog .clips-memo-input', '앵콜 무대');
            await page.fill('.dialog .clips-time-input >> nth=1', '1.2');
            await page.click('.dialog-foot .btn.primary');
            await page.waitForSelector('.dialog', { state: 'detached' });
            const c = await page.evaluate((id) => App.clips.get(id), ids[1]);
            assert.equal(c.memo, '앵콜 무대');
            assert.equal(c.end, 1.2);
            await page.waitForFunction((id) => document.querySelector(`.clips-row[data-id="${id}"] .clips-title`)?.textContent === '앵콜 무대', ids[1]);
            await page.evaluate(() => App.undo.undo({ quiet: true })); // range
            await page.evaluate(() => App.undo.undo({ quiet: true })); // memo (typing coalesced)
            const back = await page.evaluate((id) => App.clips.get(id), ids[1]);
            assert.equal(back.memo, '');
            assert.equal(back.end, 1.4);
        },
    },
];
