// Viewer team, round 2: editing right in the viewer (Q / W / Ctrl+B on the seek bar), piece memo + chips, 메모 목록,
// 편집본 미리보기, saving (local server mocked, browser-only lossless engine), 보관함 (G) and the playback API
// (App.viewer.openAt / playSequence) for the clips and dupes teams.
'use strict';

async function openVideo(page, path) {
    await page.evaluate((p) => App.viewer.open(p), path);
    await page.waitForFunction((p) => App.viewer.isOpen && App.viewer.current?.path === p && App.viewer.player?.path === p && App.viewer.player.metaReady && App.viewer.player.duration > 0.5, path, { timeout: 15000 });
    await page.evaluate(() => App.viewer.player.pause());
}

async function seekTo(page, t) {
    await page.evaluate((x) => App.viewer.player.seek(x), t);
    await page.waitForFunction((x) => Math.abs(App.viewer.player.time - x) < 0.05, t);
}

const edit = (page, p = 'clip.webm') => page.evaluate((x) => App.catalog.get(x).meta.edit || null, p);
const depth = (page) => page.evaluate(() => App.undo.list().length);
const near = (a, b, eps = 0.06) => Math.abs(a - b) <= eps;

async function clickBarAt(page, t) {
    const d = await page.evaluate(() => App.viewer.player.duration);
    const box = await page.locator('.vw-seek').boundingBox();
    await page.mouse.click(box.x + (box.width * t) / d, box.y + box.height / 2);
}

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
        name: 'video edit: Q / W / Ctrl+B on the seek bar, click + Delete a piece, one Ctrl+Z per edit, survives a reload',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: { 'clip.webm': { video: { seconds: 4 } }, 'b.png': { image: {} } } });
            await openVideo(page, 'clip.webm');
            const d0 = await depth(page);
            assert.equal(await page.locator('.vw-seek.has-edit').count(), 0, 'plain seek bar before any edit');
            assert.equal(await page.locator('.vw-dock').isVisible(), false, 'no editor panel');

            await seekTo(page, 1);
            await page.keyboard.press('q');
            await page.waitForFunction(() => App.catalog.get('clip.webm').meta.edit?.removed?.length === 1);
            let e = await edit(page);
            assert.ok(near(e.cuts[0], 1), `cut at the playhead (${e.cuts})`);
            assert.deepEqual(e.removed[0].map((x) => Math.round(x * 10) / 10), [0, 1]);
            assert.match(await page.textContent('.vw-osd'), /앞부분 .*잘라냄 · Ctrl\+Z/);
            assert.ok(e.src && e.src.size > 0, 'file size is stamped for the stale check');
            await page.waitForSelector('.vw-seek.has-edit');
            assert.equal(await page.locator('.vw-piece').count(), 2);
            assert.equal(await page.locator('.vw-piece.is-removed').count(), 1);
            assert.ok(await page.isVisible('.vw-edit-badge'), '편집됨 badge');
            assert.ok(await page.evaluate(() => document.querySelector('.vw-save-btn').classList.contains('primary')), 'save button lights up');

            await seekTo(page, 3);
            await page.keyboard.press('w');
            await page.waitForFunction(() => App.catalog.get('clip.webm').meta.edit?.removed?.length === 2);
            assert.match(await page.textContent('.vw-osd'), /뒷부분 .*잘라냄/);
            await seekTo(page, 2);
            await page.keyboard.press('Control+b');
            await page.waitForFunction(() => App.catalog.get('clip.webm').meta.edit?.cuts?.length === 3);
            e = await edit(page);
            assert.deepEqual(e.cuts.map((x) => Math.round(x * 10) / 10), [1, 2, 3]);
            assert.equal(await page.locator('.vw-piece').count(), 4);
            assert.equal(await page.evaluate(() => App.commands.get('view.toggleSidebar').scope), 'main', 'Ctrl+B is the razor here, the sidebar toggle is main-only');
            assert.equal(await depth(page), d0 + 3, 'three edits, three undo steps');

            // click the bar → selects the piece under the pointer (and seeks there)
            await clickBarAt(page, 2.5);
            await page.waitForSelector('.vw-pstrip');
            assert.match(await page.textContent('.vw-pstrip-tag'), /조각 2\/2/);
            assert.equal(await page.locator('.vw-piece.is-selected').count(), 1);
            // Delete removes the piece — not the file
            await page.keyboard.press('Delete');
            await page.waitForFunction(() => App.videoEdit.keptOf('clip.webm').length === 1);
            assert.ok(await page.evaluate(() => window.__opfs.exists('clip.webm')), 'the video itself stays');
            assert.ok(await page.evaluate(() => App.viewer.isOpen && App.viewer.current.path === 'clip.webm'));
            // Delete again on the (now removed, still selected) piece brings exactly it back
            await page.keyboard.press('Delete');
            await page.waitForFunction(() => App.videoEdit.keptOf('clip.webm').length === 2);
            assert.deepEqual(await page.evaluate(() => App.videoEdit.keptOf('clip.webm').map((x) => [Math.round(x.start * 10) / 10, Math.round(x.end * 10) / 10])), [[1, 2], [2, 3]]);
            // Esc first drops the selection, the viewer stays open
            await page.keyboard.press('Escape');
            await page.waitForSelector('.vw-pstrip', { state: 'detached' });
            assert.ok(await page.evaluate(() => App.viewer.isOpen));
            assert.equal(await depth(page), d0 + 5);

            // Ctrl+Z walks back every edit one by one, Ctrl+Y redoes
            for (let i = 0; i < 5; i++) await page.keyboard.press('Control+z');
            await page.waitForFunction(() => !App.catalog.get('clip.webm').meta.edit);
            await page.waitForSelector('.vw-seek.has-edit', { state: 'detached' });
            for (let i = 0; i < 5; i++) await page.keyboard.press('Control+y');
            await page.waitForFunction(() => App.catalog.get('clip.webm').meta.edit?.cuts?.length === 3 && App.videoEdit.keptOf('clip.webm').length === 2);

            // 원래대로 is one undo step too
            await page.evaluate(() => App.commands.run('video.resetEdit'));
            await page.waitForFunction(() => !App.catalog.get('clip.webm').meta.edit);
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => App.catalog.get('clip.webm').meta.edit?.cuts?.length === 3);

            // persists with the library (catalog.json next to the videos)
            await page.evaluate(() => App.catalog.flush());
            await reopen(page, waitIdle);
            await openVideo(page, 'clip.webm');
            await page.waitForSelector('.vw-seek.has-edit');
            assert.equal(await page.locator('.vw-piece').count(), 4);
            assert.deepEqual((await edit(page)).cuts.map((x) => Math.round(x * 10) / 10), [1, 2, 3]);
        },
    },
    {
        name: 'video edit guards: keys wait for the duration, never fire while typing the memo, a changed file shows 원본이 바뀌었어요',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'clip.webm': { video: { seconds: 3 } }, 'other.webm': { video: { seconds: 2 } } } });
            await openVideo(page, 'clip.webm');
            // duration not known yet → Q/W/Ctrl+B do nothing
            await page.evaluate(() => {
                App.viewer.player.metaReady = false;
            });
            assert.equal(await page.evaluate(() => App.commands.isEnabled('video.cutBefore') || App.commands.isEnabled('video.split')), false);
            await page.keyboard.press('q');
            await page.keyboard.press('Control+b');
            await page.waitForTimeout(120);
            assert.equal(await edit(page), null, 'no edit before the duration is known');
            await page.evaluate(() => {
                App.viewer.player.metaReady = true;
            });

            await seekTo(page, 1.2);
            await page.keyboard.press('Control+b');
            await page.waitForFunction(() => App.catalog.get('clip.webm').meta.edit?.cuts?.length === 1);
            await clickBarAt(page, 0.5);
            await page.waitForSelector('.vw-pstrip-memo');
            await page.click('.vw-pstrip-memo');
            await page.keyboard.type('qw 바다 #여름');
            await page.waitForFunction(() => App.catalog.get('clip.webm').meta.edit?.pieces?.['0']?.memo === 'qw 바다 #여름');
            const e = await edit(page);
            assert.equal(e.cuts.length, 1, 'typing q/w in the memo did not cut');
            assert.equal(e.removed.length, 0);
            await page.keyboard.press('Enter');
            assert.ok(await page.evaluate(() => !document.activeElement?.closest('.vw-pstrip')), 'Enter leaves the memo field');

            // the file changes on disk → the old pieces are not applied
            await page.evaluate(async () => App.fs.overwrite('clip.webm', await App.fs.getFile('other.webm')));
            await page.waitForSelector('.vw-pstrip.is-stale', { timeout: 15000 });
            assert.match(await page.textContent('.vw-pstrip.is-stale'), /원본이 바뀌었어요/);
            await page.waitForFunction(() => App.viewer.player?.metaReady);
            assert.equal(await page.locator('.vw-seek.has-edit').count(), 0, 'stale pieces are not drawn');
            assert.equal(await page.evaluate(() => App.commands.isEnabled('video.cutBefore')), false, 'no edits on top of a stale edit');
            const before = await depth(page);
            await page.click('.vw-pstrip.is-stale button:has-text("그래도 적용")');
            await page.waitForSelector('.vw-seek.has-edit');
            assert.equal(await depth(page), before + 1, 'accepting is one undo step');
            assert.equal(await page.locator('.vw-pstrip.is-stale').count(), 0);
        },
    },
    {
        name: 'piece memo + chips inline above the bar; 메모 목록 lists markers and pieces together; memo typing is one undo step',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'clip.webm': { video: { seconds: 3 } } } });
            const chipId = await page.evaluate(() => {
                const C = App.chipset;
                const cat = C.addCategory({ name: '인물', mode: 'search' });
                return C.addChips(cat.id, ['김수현', '박보영'])[0].id;
            });
            await openVideo(page, 'clip.webm');
            await seekTo(page, 1.5);
            await page.keyboard.press('Control+b');
            await page.waitForFunction(() => App.catalog.get('clip.webm').meta.edit?.cuts?.length === 1);
            await page.evaluate(() => App.viewer.player.addMarker({ popover: false, at: 0.6, title: '웃음' }));
            await clickBarAt(page, 2.2);
            await page.waitForSelector('.vw-pstrip-memo');
            const d0 = await depth(page);
            await page.click('.vw-pstrip-memo');
            await page.keyboard.type('하이라이트 #명장면', { delay: 30 });
            await page.waitForFunction(() => App.catalog.get('clip.webm').meta.edit?.pieces?.['1.5']?.memo === '하이라이트 #명장면');
            await page.keyboard.press('Enter');
            assert.equal(await depth(page), d0 + 1, 'typing collapses into one undo step');

            // chips through the picker (initials work)
            await page.click('.vw-pstrip-addchip');
            await page.waitForSelector('.vw-chip-pop input');
            await page.keyboard.type('ㄱㅅ');
            await page.waitForSelector('.vw-chip-opt');
            await page.keyboard.press('Enter');
            await page.waitForFunction((id) => App.catalog.get('clip.webm').meta.edit?.pieces?.['1.5']?.chips?.includes(id), chipId);
            await page.keyboard.press('Escape');
            await page.waitForSelector('.vw-pstrip .vw-chip-pill:has-text("김수현")');
            assert.ok(await page.evaluate(() => document.querySelector('.vw-piece.is-selected').classList.contains('has-note')), 'pieces with a note get a dot on the bar');

            // 메모 목록: marker + both pieces, in time order
            await page.keyboard.press('Shift+B');
            await page.waitForSelector('.vw-dock .vw-piece-row');
            const rows = await page.$$eval('.vw-dock .vw-mk-row', (els) => els.map((el) => el.querySelector('.vw-mk-name').textContent));
            assert.deepEqual(rows.map((r) => r.replace(/ ·.*/, '')), ['조각 1', '웃음', '조각 2']);
            assert.ok(await page.isVisible('.vw-dock .vw-piece-row.is-selected:has-text("하이라이트")'));
            await page.click('.vw-dock .vw-piece-row:has-text("조각 1") .vw-mk-name');
            await page.waitForFunction(() => App.viewer.player.time < 0.05 && App.videoEdit.selected()?.start === 0);
            await page.waitForFunction(() => /조각 1\/2/.test(document.querySelector('.vw-pstrip-tag')?.textContent || ''));

            // undo the chip, then the memo
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => !(App.catalog.get('clip.webm').meta.edit?.pieces?.['1.5']?.chips || []).length);
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => !App.catalog.get('clip.webm').meta.edit?.pieces?.['1.5']?.memo);

            // joining the last two pieces: the whole video is one piece again, its memo moves onto the file (one step)
            await page.evaluate(() => App.videoEdit.setPieceInfo('clip.webm', 1.5, { memo: '두 번째' }));
            await clickBarAt(page, 2.2);
            await page.waitForSelector('.vw-pstrip button[aria-label="앞 조각과 합치기"]');
            const d1 = await depth(page);
            await page.click('.vw-pstrip button[aria-label="앞 조각과 합치기"]');
            await page.waitForFunction(() => !App.catalog.get('clip.webm').meta.edit);
            assert.equal(await page.evaluate(() => App.catalog.get('clip.webm').memo), '두 번째');
            assert.equal(await depth(page), d1 + 1);
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => App.catalog.get('clip.webm').meta.edit?.pieces?.['1.5']?.memo === '두 번째' && !App.catalog.get('clip.webm').memo);
        },
    },
    {
        name: '편집본 미리보기: playback jumps over removed parts and stops after the last kept piece; P shows the original again',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'clip.webm': { video: { seconds: 4 } } } });
            await openVideo(page, 'clip.webm');
            const cut = async (t, key) => {
                await seekTo(page, t);
                await page.keyboard.press(key);
                await page.waitForTimeout(60);
            };
            await cut(0.8, 'q');
            await cut(3.0, 'w');
            await cut(1.6, 'Control+b');
            await cut(2.3, 'Control+b');
            await clickBarAt(page, 1.95);
            await page.waitForSelector('.vw-pstrip');
            await page.keyboard.press('Delete');
            await page.waitForFunction(() => JSON.stringify(App.videoEdit.keptOf('clip.webm').map((x) => [Math.round(x.start * 10) / 10, Math.round(x.end * 10) / 10])) === '[[0.8,1.6],[2.3,3]]');
            await page.keyboard.press('Escape');

            const watch = () => page.evaluate(() => new Promise((resolve) => {
                const p = App.viewer.player;
                const seen = [];
                let ended = false;
                const off = App.bus.on('viewer:edit-ended', () => (ended = true));
                const tick = () => {
                    seen.push(p.time);
                    if (ended || seen.length > 600) {
                        off();
                        resolve({ seen, ended, time: p.time, playing: p.playing });
                        return;
                    }
                    requestAnimationFrame(tick);
                };
                p.seek(0);
                p.play();
                requestAnimationFrame(tick);
            }));
            const r = await watch();
            assert.ok(r.ended && !r.playing, 'stops after the last kept piece');
            assert.ok(near(r.time, 3.0, 0.12), `stopped at the end of the edit (${r.time})`);
            const inside = r.seen.filter((t) => (t > 0.08 && t < 0.72) || (t > 1.7 && t < 2.2));
            assert.equal(inside.length, 0, `never played a removed part: ${inside.slice(0, 5)}`);
            assert.ok(r.seen.some((t) => t > 1.0 && t < 1.5) && r.seen.some((t) => t > 2.4 && t < 2.9), 'played both kept pieces');

            // P: original again (the removed middle plays)
            await page.keyboard.press('p');
            await page.waitForFunction(() => App.settings.get('video.previewEdit', true) === false);
            const plain = await page.evaluate(() => new Promise((resolve) => {
                const p = App.viewer.player;
                const seen = [];
                p.seek(1.5);
                p.play();
                const t0 = performance.now();
                const tick = () => {
                    seen.push(p.time);
                    if (performance.now() - t0 > 900) {
                        p.pause();
                        resolve(seen);
                        return;
                    }
                    requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
            }));
            assert.ok(plain.some((t) => t > 1.75 && t < 2.2), 'with preview off the removed middle plays');
            await page.keyboard.press('p');
            await page.waitForFunction(() => App.settings.get('video.previewEdit', true) === true);
        },
    },
    {
        name: 'save: local server (mocked) gets trim / per-piece trims / concat, one undo per file, memo goes along, 원본 보관 option',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'clip.webm': { video: { seconds: 3 } } } });
            await openVideo(page, 'clip.webm');
            await page.evaluate(() => {
                window.__calls = [];
                let n = 0;
                const make = async (b) => {
                    const name = `clip_cut${String(++n).padStart(2, '0')}.webm`;
                    await App.fs.backend.copy('clip.webm', '', name);
                    return name;
                };
                App.server = {
                    available: true,
                    capabilities: { ffmpeg: true },
                    video: {
                        trim: async (b) => (window.__calls.push(['trim', b]), { path: await make(b) }),
                        concat: async (b) => (window.__calls.push(['concat', b]), { id: 'job1', state: 'running', _b: b }),
                    },
                    waitJob: async (id) => ({ id, state: 'done', result: { path: await make() } }),
                    showSetup: () => (window.__setup = true),
                };
                App.fs.backend.kind = 'server';
            });
            await seekTo(page, 0.5);
            await page.keyboard.press('q');
            await seekTo(page, 2.5);
            await page.keyboard.press('w');
            await page.waitForFunction(() => App.videoEdit.keptOf('clip.webm').length === 1);
            await clickBarAt(page, 1.5);
            await page.waitForSelector('.vw-pstrip-memo');
            await page.fill('.vw-pstrip-memo', '바다 #여름');
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => App.videoEdit.keptOf('clip.webm')[0].memo === '바다 #여름');

            // the toolbar 저장 menu
            const d0 = await depth(page);
            await page.click('.vw-save-btn');
            await page.click('.menu :text("남은 부분 이어서 새 파일로")');
            await page.waitForSelector('.toast:has-text("편집본을 새 파일로 저장했어요")');
            let calls = await page.evaluate(() => window.__calls);
            assert.equal(calls[0][0], 'trim');
            assert.deepEqual({ ...calls[0][1], start: Math.round(calls[0][1].start * 10) / 10, end: Math.round(calls[0][1].end * 10) / 10 }, { path: 'clip.webm', start: 0.5, end: 2.5, mode: 'fast' });
            assert.ok(await page.evaluate(() => window.__opfs.exists('clip_cut01.webm')));
            assert.equal(await page.evaluate(() => App.catalog.get('clip_cut01.webm').memo), '바다 #여름', 'the piece memo goes onto the new file');
            assert.equal(await depth(page), d0 + 1, 'one undo step for the new file');
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => window.__opfs.exists('clip_cut01.webm').then((x) => !x));
            await page.keyboard.press('Control+y');
            await page.waitForFunction(() => window.__opfs.exists('clip_cut01.webm'));
            assert.ok(await page.evaluate(() => window.__opfs.exists('clip.webm')), 'original untouched');

            // per piece: split, then 조각마다 새 파일로 → two trims, two undo steps
            await page.keyboard.press('Escape');
            await seekTo(page, 1.5);
            await page.keyboard.press('Control+b');
            await page.waitForFunction(() => App.videoEdit.keptOf('clip.webm').length === 2);
            const d1 = await depth(page);
            await page.keyboard.press('Shift+S');
            await page.click('.menu :text("조각마다 새 파일로")');
            await page.waitForSelector('.toast:has-text("조각 2개를 새 파일로 저장했어요")');
            calls = await page.evaluate(() => window.__calls.slice(1));
            assert.deepEqual(calls.map((c) => [c[0], Math.round(c[1].start * 10) / 10, Math.round(c[1].end * 10) / 10]), [['trim', 0.5, 1.5], ['trim', 1.5, 2.5]]);
            assert.equal(await depth(page), d1 + 2);

            // remove the first kept piece's tail → two kept pieces with a gap → concat (through a job)
            await seekTo(page, 1.0);
            await page.keyboard.press('Control+b');
            await clickBarAt(page, 1.25);
            await page.keyboard.press('Delete');
            await page.waitForFunction(() => App.videoEdit.keptOf('clip.webm').length === 2);
            await page.evaluate(() => App.settings.set('video.archiveOriginal', true));
            await page.evaluate(() => App.commands.run('video.saveKept'));
            await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'concat'));
            const concat = await page.evaluate(() => window.__calls.find((c) => c[0] === 'concat')[1]);
            assert.deepEqual(concat.segments.map((s) => [s.path, Math.round(s.start * 10) / 10, Math.round(s.end * 10) / 10]), [['clip.webm', 0.5, 1], ['clip.webm', 1.5, 2.5]]);
            // 원본 보관: the original moves to '원본 보관/' (its own undo step), the viewer follows it
            await page.waitForFunction(() => window.__opfs.exists('원본 보관/clip.webm'));
            await page.waitForFunction(() => App.viewer.current?.path === '원본 보관/clip.webm');
            assert.ok(await page.evaluate(() => App.catalog.get('원본 보관/clip.webm').meta.edit?.cuts?.length >= 3), 'the edit follows the move');
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => window.__opfs.exists('clip.webm'));
            await page.evaluate(() => {
                App.settings.set('video.archiveOriginal', false);
                App.fs.backend.kind = 'browser';
                delete App.server;
            });
        },
    },
    {
        name: 'save without the server: browser-only lossless cut (Mediabunny) for WebM; unsupported → small notice with 서버 켜기',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'clip.webm': { video: { seconds: 3 } } } });
            await openVideo(page, 'clip.webm');
            assert.equal(await page.evaluate(() => App.server?.available || false), false, 'no local server in this test');
            assert.equal(await page.evaluate(() => !!window.Mediabunny), false, 'the engine is lazy-loaded');
            await seekTo(page, 1);
            await page.keyboard.press('q');
            await page.waitForFunction(() => App.videoEdit.keptOf('clip.webm').length === 1);
            const d0 = await depth(page);
            await page.keyboard.press('Shift+S');
            await page.click('.menu :text("남은 부분 이어서 새 파일로")');
            await page.waitForSelector('.toast:has-text("편집본을 새 파일로 저장했어요")', { timeout: 30000 });
            assert.ok(await page.evaluate(() => window.__opfs.exists('clip_edit01.webm')));
            assert.equal(await depth(page), d0 + 1, 'one undo step');
            const info = await page.evaluate(async () => {
                const f = await App.fs.getFile('clip_edit01.webm');
                const v = document.createElement('video');
                v.muted = true;
                v.src = URL.createObjectURL(f);
                await new Promise((r, j) => {
                    v.onloadeddata = r;
                    v.onerror = () => j(new Error('cannot decode'));
                });
                return { duration: App.catalog.get('clip_edit01.webm').meta.duration, size: f.size, w: v.videoWidth };
            });
            assert.ok(info.w > 0, 'the new file decodes');
            assert.ok(info.duration > 1.5 && info.duration < 3.2, `kept part only (keyframe-aligned): ${info.duration}`);
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => window.__opfs.exists('clip_edit01.webm').then((x) => !x));

            // a format the browser engine can't take → no big panel, a small notice with 서버 켜기
            await page.evaluate(() => {
                window.__supports = App.videoLossless.supports;
                App.videoLossless.supports = () => false;
                window.__setupOrig = App.server?.showSetup;
                if (App.server) App.server.showSetup = () => (window.__setup = true);
            });
            await page.click('.vw-save-btn');
            await page.click('.menu :text("남은 부분 이어서 새 파일로")');
            await page.waitForSelector('.ve-need:has-text("로컬 서버")');
            if (await page.evaluate(() => !!App.server)) {
                await page.click('.ve-need button:has-text("서버 켜기")');
                await page.waitForFunction(() => window.__setup === true);
            }
            await page.evaluate(() => {
                App.videoLossless.supports = window.__supports;
                if (App.server && window.__setupOrig) App.server.showSetup = window.__setupOrig;
            });
        },
    },
    {
        name: 'lossless engine on H.264/AAC MP4: keyframe-aligned cut + join of two ranges, same codecs, playable, no re-encode',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'x.png': { image: {} } } });
            const res = await page.evaluate(async () => {
                const MB = await App.videoLossless.load();
                if (!(await MB.canEncodeVideo('avc'))) return { skip: 'no H.264 encoder' };
                const withAudio = await MB.canEncodeAudio('aac');
                const canvas = new OffscreenCanvas(320, 240);
                const g = canvas.getContext('2d');
                const target = new MB.BufferTarget();
                const out = new MB.Output({ format: new MB.Mp4OutputFormat(), target });
                const vs = new MB.CanvasSource(canvas, { codec: 'avc', bitrate: 1e6, keyFrameInterval: 0.5 });
                out.addVideoTrack(vs, { frameRate: 30 });
                let as = null;
                if (withAudio) {
                    as = new MB.AudioBufferSource({ codec: 'aac', bitrate: 96e3 });
                    out.addAudioTrack(as);
                }
                await out.start();
                for (let i = 0; i < 120; i++) {
                    g.fillStyle = `hsl(${i * 3},70%,45%)`;
                    g.fillRect(0, 0, 320, 240);
                    await vs.add(i / 30, 1 / 30);
                }
                if (as) {
                    const ctx = new OfflineAudioContext(2, 48000 * 4, 48000);
                    const osc = ctx.createOscillator();
                    osc.connect(ctx.destination);
                    osc.start();
                    await as.add(await ctx.startRendering());
                }
                await out.finalize();
                const p = await App.fs.createFile('', 'cam.mp4', new Blob([target.buffer], { type: 'video/mp4' }), { undoable: false });
                const file = await App.fs.getFile(p);
                const cut = await App.videoLossless.cut(file, [[1.2, 2.0], [3.1, 3.6]]);
                const input = new MB.Input({ source: new MB.BlobSource(cut.blob), formats: MB.ALL_FORMATS });
                const vt = await input.getPrimaryVideoTrack();
                const at = await input.getPrimaryAudioTrack();
                const dur = await input.computeDuration();
                // touching ranges are copied once; a range whose key frame falls inside the previous one is merged into it
                const touching = await App.videoLossless.cut(file, [[1.2, 2.0], [2.0, 2.6]]);
                const overlap = await App.videoLossless.cut(file, [[1.1, 1.3], [1.4, 1.8]]);
                window.__extra = { touching: { ranges: touching.ranges, dur: touching.duration }, overlap: { ranges: overlap.ranges, dur: overlap.duration, restored: overlap.restored } };
                const url = URL.createObjectURL(cut.blob);
                const v = document.createElement('video');
                v.muted = true;
                v.src = url;
                await new Promise((r, j) => {
                    v.onloadeddata = r;
                    v.onerror = () => j(new Error('cannot decode'));
                });
                return { withAudio, ranges: cut.ranges, ext: cut.ext, vcodec: vt.codec, acodec: at?.codec || null, dur, elDur: v.duration, w: v.videoWidth, inSize: file.size, outSize: cut.blob.size };
            });
            if (res.skip) {
                console.log(`      (skipped: ${res.skip})`);
                return;
            }
            assert.equal(res.ext, 'mp4');
            assert.equal(res.vcodec, 'avc');
            if (res.withAudio) assert.equal(res.acodec, 'aac');
            assert.ok(near(res.ranges[0][0], 1.0, 0.04) && near(res.ranges[1][0], 3.0, 0.04), `ranges start on key frames: ${JSON.stringify(res.ranges)}`);
            assert.ok(near(res.ranges[0][1], 2.0, 0.05) && near(res.ranges[1][1], 3.6, 0.05), `ranges end where asked: ${JSON.stringify(res.ranges)}`);
            assert.ok(near(res.dur, 1.6, 0.12), `joined duration ${res.dur}`);
            assert.ok(res.w === 320 && res.elDur > 1.4, 'Chrome plays the result');
            assert.ok(res.outSize < res.inSize, 'smaller than the source (packets copied, not re-encoded)');
            const extra = await page.evaluate(() => window.__extra);
            assert.equal(extra.touching.ranges.length, 1, `touching ranges become one: ${JSON.stringify(extra.touching)}`);
            assert.ok(near(extra.touching.dur, 1.6, 0.08), `no footage copied twice: ${extra.touching.dur}`);
            assert.equal(extra.overlap.ranges.length, 1, `overlapping key frame → merged: ${JSON.stringify(extra.overlap)}`);
            assert.ok(near(extra.overlap.restored, 0.1, 0.03), `the removed gap that came back is reported: ${extra.overlap.restored}`);
        },
    },
    {
        name: '보관함 (G): the selected piece or [t−15 s, t+5 s] through App.clips.add (one undo), toast with 메모 쓰기; a marker without App.clips',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'clip.webm': { video: { seconds: 3 } } } });
            await openVideo(page, 'clip.webm');
            // without the clips module: G leaves a marker (no popover, playback not interrupted)
            const hadClips = await page.evaluate(() => !!App.clips?.add);
            if (!hadClips) {
                await seekTo(page, 1.2);
                await page.keyboard.press('g');
                await page.waitForFunction(() => App.catalog.get('clip.webm').markers.length === 1);
                assert.equal(await page.locator('.vw-mk-pop').count(), 0, 'no popover');
            }
            // mock App.clips (the clips team's module follows ARCHITECTURE §8)
            await page.evaluate(() => {
                window.__clips = [];
                window.__realClips = App.clips;
                App.clips = {
                    add: async (c) => {
                        const list = (Array.isArray(c) ? c : [c]).map((x, i) => ({ id: `c${window.__clips.length + i + 1}`, ...x }));
                        window.__clips.push(...list);
                        App.undo.push({ label: '보관함에 담기', undo: () => { window.__clips = window.__clips.filter((x) => !list.includes(x)); }, redo: () => window.__clips.push(...list) });
                        return Array.isArray(c) ? list : list[0];
                    },
                    update: async (id, patch) => Object.assign(window.__clips.find((x) => x.id === id), patch),
                };
                App.settings.set('video.clipBefore', 15);
                App.settings.set('video.clipAfter', 5);
            });
            await seekTo(page, 2);
            await page.evaluate(() => App.viewer.player.play());
            await page.keyboard.press('g');
            await page.waitForFunction(() => window.__clips.length === 1);
            const c1 = await page.evaluate(() => window.__clips[0]);
            assert.equal(c1.path, 'clip.webm');
            assert.equal(c1.start, 0, 'clamped at the start of the video');
            assert.ok(c1.end > 2.9, `ends at min(duration, t + 5): ${c1.end}`);
            assert.ok(await page.evaluate(() => App.viewer.player.playing), 'G does not pause playback');
            await page.evaluate(() => App.viewer.player.pause());
            await page.waitForSelector('.toast:has-text("보관함에 담았어요") .toast-action:has-text("메모 쓰기")');
            assert.ok(await page.isVisible('.toast:has-text("보관함에 담았어요") .toast-action:has-text("되돌리기")'));
            await page.click('.toast-action:has-text("메모 쓰기")');
            await page.waitForSelector('.dialog input');
            await page.keyboard.type('#하이라이트');
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => window.__clips[0].memo === '#하이라이트');

            // a selected piece goes as it is (memo + chips too)
            await seekTo(page, 1.0);
            await page.keyboard.press('Control+b');
            await clickBarAt(page, 2.0);
            await page.waitForSelector('.vw-pstrip-memo');
            await page.fill('.vw-pstrip-memo', '끝부분');
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => App.videoEdit.selected()?.memo === '끝부분');
            await page.keyboard.press('g');
            await page.waitForFunction(() => window.__clips.length === 2);
            const c2 = await page.evaluate(() => window.__clips[1]);
            assert.ok(near(c2.start, 1.0) && c2.end > 2.9 && c2.memo === '끝부분', JSON.stringify(c2));
            // save menu → 보관함에 담기: every kept piece in ONE call (one undo step)
            const d0 = await depth(page);
            await page.click('.vw-save-btn');
            await page.click('.menu :text("보관함에 담기")');
            await page.waitForFunction(() => window.__clips.length === 4);
            assert.equal(await depth(page), d0 + 1);
            await page.evaluate(() => {
                App.clips = window.__realClips;
            });
        },
    },
    {
        name: 'playback API: openAt stops (or loops) at end with a dismissible 구간 재생 chip; playSequence plays items back to back',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'a.webm': { video: { seconds: 3 } }, 'b.webm': { video: { seconds: 3 } }, 'p.png': { image: {} } } });
            await page.evaluate(() => App.viewer.openAt('b.webm', { start: 1.0, end: 1.6 }));
            await page.waitForFunction(() => App.viewer.player?.path === 'b.webm' && App.viewer.player.metaReady);
            await page.waitForSelector('.vw-segchip:has-text("구간 재생")');
            assert.match(await page.textContent('.vw-segchip'), /0:01.00–0:01.60/);
            await page.waitForFunction(() => !App.viewer.player.playing && Math.abs(App.viewer.player.time - 1.6) < 0.1, null, { timeout: 8000 });
            // loop
            await page.evaluate(() => App.viewer.openAt('b.webm', { start: 0.5, end: 1.0, loop: true }));
            await page.waitForSelector('.vw-segchip:has-text("구간 반복")');
            const looped = await page.evaluate(() => new Promise((resolve) => {
                const p = App.viewer.player;
                let max = 0;
                let wrapped = false;
                let last = p.time;
                const t0 = performance.now();
                const tick = () => {
                    max = Math.max(max, p.time);
                    if (p.time < last - 0.2) wrapped = true;
                    last = p.time;
                    if (performance.now() - t0 > 1400) return resolve({ max, wrapped, playing: p.playing });
                    requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
            }));
            assert.ok(looped.wrapped && looped.playing && looped.max < 1.15, JSON.stringify(looped));
            await page.click('.vw-segchip-x');
            await page.waitForSelector('.vw-segchip', { state: 'detached' });
            assert.equal(await page.evaluate(() => App.viewer.player.segment), null);
            await page.evaluate(() => App.viewer.player.pause());

            // sequence across files
            await page.evaluate(() => {
                window.__seqEnded = false;
                App.bus.on('viewer:sequence-ended', () => (window.__seqEnded = true));
                App.viewer.playSequence([
                    { path: 'a.webm', start: 0.2, end: 0.7, title: '첫 장면' },
                    { path: 'b.webm', start: 1.0, end: 1.4 },
                    { path: 'a.webm', start: 2.0, end: 2.4 },
                ], { title: '하이라이트' });
            });
            await page.waitForSelector('.vw-segchip.is-seq:has-text("1 / 3")');
            assert.match(await page.textContent('.vw-segchip'), /하이라이트.*첫 장면/);
            await page.waitForSelector('.vw-segchip.is-seq:has-text("2 / 3")', { timeout: 10000 });
            await page.waitForFunction(() => App.viewer.current.path === 'b.webm');
            // next with the key, then the queue ends by itself
            await page.keyboard.press('Shift+PageDown');
            await page.waitForSelector('.vw-segchip.is-seq:has-text("3 / 3")');
            await page.waitForFunction(() => App.viewer.current.path === 'a.webm' && App.viewer.player?.metaReady);
            await page.waitForFunction(() => window.__seqEnded === true, null, { timeout: 10000 });
            await page.waitForSelector('.vw-segchip', { state: 'detached' });
            assert.ok(await page.evaluate(() => Math.abs(App.viewer.player.time - 2.4) < 0.12 && !App.viewer.player.playing));
            // walking to another file by hand drops a queue
            await page.evaluate(() => App.viewer.playSequence([{ path: 'a.webm', start: 0, end: 2.5 }, { path: 'b.webm', start: 0, end: 1 }], { title: 'x' }));
            await page.waitForSelector('.vw-segchip.is-seq');
            await page.waitForFunction(() => App.viewer.player?.path === 'a.webm' && App.viewer.player.metaReady);
            await page.keyboard.press('PageDown');
            await page.waitForSelector('.vw-segchip', { state: 'detached' });
            assert.equal(await page.evaluate(() => App.viewer.sequence), null);

            // an item without an end plays to the end of its file, then the queue moves on
            await page.evaluate(() => App.viewer.playSequence([{ path: 'a.webm', start: 2.4 }, { path: 'b.webm', start: 0.5, end: 0.9 }], { title: 'y' }));
            await page.waitForSelector('.vw-segchip.is-seq:has-text("2 / 2")', { timeout: 10000 });
            // a direct openAt replaces the queue
            await page.evaluate(() => App.viewer.openAt('b.webm', { start: 1.5, end: 2.0, autoplay: false }));
            await page.waitForSelector('.vw-segchip:not(.is-seq):has-text("구간 재생")');
            assert.equal(await page.evaluate(() => App.viewer.sequence), null);
        },
    },
    {
        name: 'E shows the edit keys; the old editor panel is gone; Delete without a selected piece still trashes the file (undoable)',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'clip.webm': { video: { seconds: 2 } }, 'z.png': { image: {} } } });
            await openVideo(page, 'clip.webm');
            assert.equal(await page.evaluate(() => !!App.commands.get('video.markIn') || !!App.commands.get('video.addSegment')), false, 'I/O segment commands retired');
            await page.keyboard.press('e');
            await page.waitForFunction(() => /앞부분 잘라내기/.test(document.querySelector('.vw-hints').textContent));
            assert.equal(await page.locator('.vw-dock').isVisible(), false, 'E opens no panel');
            assert.ok(await page.evaluate(() => document.querySelector('.vw-ctl .vw-edit').classList.contains('active')));
            await page.keyboard.press('e');
            await page.waitForFunction(() => !/앞부분 잘라내기/.test(document.querySelector('.vw-hints').textContent));
            await page.keyboard.press('i');
            await page.waitForSelector('.vw-info:not([hidden])');
            await page.keyboard.press('i');
            await page.keyboard.press('Delete');
            await page.waitForFunction(() => window.__opfs.exists('clip.webm').then((x) => !x));
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => window.__opfs.exists('clip.webm'));
        },
    },
];
