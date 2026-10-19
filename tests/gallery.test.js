// Gallery team: lasso, folder mosaics, badges, hover scrub, list view, clipboard, Quick Look, type-ahead,
// context menu, action bar, fit toggle, drag & drop (label, toast, spring-loading), import/paste, scroll memory.
'use strict';

const SEED = {
    'a-photo.png': { image: { label: 'A', color: '#b33', w: 640, h: 480 } },
    'b-photo.jpg': { image: { label: 'B', mime: 'image/jpeg', color: '#3b3', w: 480, h: 720 } },
    'c-clip.webm': { video: { seconds: 1 } },
    'd-photo.png': { image: { label: 'D', color: '#33b' } },
    'e-photo.png': { image: { label: 'E', color: '#bb3' } },
    'f-photo.png': { image: { label: 'F', color: '#3bb' } },
    'trip/beach.png': { image: { label: 'Beach', color: '#36c' } },
    'trip/2024/sunset.png': { image: { label: 'Sun' } },
    'empty/': null,
};

/** Client coordinates of a point inside visible item i (fractions of its box) — from layout geometry */
function itemPoint(page, i, fx = 0.5, fy = 0.5) {
    return page.evaluate(([i, fx, fy]) => {
        const r = App.gallery.itemRect(i);
        const c = document.getElementById('gallery').getBoundingClientRect();
        return { x: c.left + r.x + r.w * fx, y: c.top + r.y + r.h * fy, left: c.left + r.x, top: c.top + r.y, w: r.w, h: r.h };
    }, [i, fx, fy]);
}

const visiblePaths = (page, idx) => page.evaluate((ix) => ix.map((i) => App.view.visible[i].path), idx);
const selection = (page) => page.evaluate(() => App.select.list());

async function lasso(page, from, to, { modifiers = [] } = {}) {
    for (const m of modifiers) await page.keyboard.down(m);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    for (const m of modifiers) await page.keyboard.up(m);
}

/**
 * The harness records seed videos in real time; on an overloaded machine MediaRecorder can hand back an empty file.
 * Make sure `name` is a playable clip, re-recording it (setTimeout-driven, with retries) when needed.
 */
function ensurePlayableClip(page, name) {
    return page.evaluate(async (name) => {
        const playable = async () => {
            const { url, release } = await App.fs.url(name);
            const ok = await new Promise((resolve) => {
                const v = document.createElement('video');
                v.muted = true;
                v.onloadedmetadata = () => resolve(true);
                v.onerror = () => resolve(false);
                setTimeout(() => resolve(false), 5000);
                v.src = url;
            });
            release();
            return ok;
        };
        if ((App.view.get(name)?.size || 0) > 1000 && (await playable())) return 'seeded';
        for (let attempt = 0; attempt < 3; attempt++) {
            const canvas = document.createElement('canvas');
            canvas.width = 320;
            canvas.height = 240;
            const g = canvas.getContext('2d');
            const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm' });
            const chunks = [];
            rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
            const stopped = new Promise((r) => (rec.onstop = r));
            rec.start(100);
            const t0 = performance.now();
            while (performance.now() - t0 < 1300) {
                const t = performance.now() - t0;
                g.fillStyle = `hsl(${(t / 4) % 360},70%,45%)`;
                g.fillRect(0, 0, 320, 240);
                g.fillStyle = '#fff';
                g.font = '40px sans-serif';
                g.fillText((t / 1000).toFixed(1), 20, 120);
                await new Promise((r) => setTimeout(r, 30));
            }
            rec.requestData();
            rec.stop();
            await stopped;
            const blob = new Blob(chunks, { type: 'video/webm' });
            if (blob.size < 1000) continue;
            await App.fs.overwrite(name, blob);
            if (await playable()) return 'rerecorded';
        }
        return 'failed';
    }, name);
}

function stubChipNames(page) {
    return page.evaluate(() => {
        App.chipset = App.chipset || {};
        if (typeof App.chipset.nameOf !== 'function') App.chipset.nameOf = (id) => ({ c1: '인물/지민', c2: '장소/제주' })[id] || null;
    });
}

module.exports = [
    {
        name: 'lasso selects from geometry: replace, Shift adds, Ctrl toggles, Esc cancels',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            const cols = await page.evaluate(() => App.gallery.columns);
            assert.ok(cols >= 3, `expected a multi-column grid (got ${cols})`);
            // From the empty padding at the top-left to the middle of the item in row 1 / col 1
            const first = await itemPoint(page, 0);
            const start = { x: first.left - 8, y: first.top - 8 };
            const target = await itemPoint(page, cols + 1);
            await page.mouse.move(start.x, start.y);
            await page.mouse.down();
            await page.mouse.move(target.x, target.y, { steps: 8 });
            assert.ok(await page.isVisible('#gallery .lasso'), 'the rubber band is drawn while dragging');
            await page.mouse.up();
            assert.ok(!(await page.isVisible('#gallery .lasso')));
            const expected = await visiblePaths(page, [0, 1, cols, cols + 1]);
            assert.deepEqual(await selection(page), expected, 'replace mode selects exactly the intersected items');

            // Shift adds the last item to the current selection
            const n = await page.evaluate(() => App.view.visible.length);
            const last = await itemPoint(page, n - 1);
            await lasso(page, { x: last.left - 5, y: last.top + 10 }, { x: last.x, y: last.y }, { modifiers: ['Shift'] });
            assert.deepEqual(await selection(page), [...expected, ...(await visiblePaths(page, [n - 1]))]);

            // Ctrl toggles: item 1 (selected) is removed, item 2 is added
            const one = await itemPoint(page, 1);
            const two = await itemPoint(page, 2);
            await lasso(page, { x: one.left - 5, y: one.top + 12 }, { x: two.x, y: two.y }, { modifiers: ['Control'] });
            const sel = await selection(page);
            const [p1, p2] = await visiblePaths(page, [1, 2]);
            assert.ok(!sel.includes(p1) && sel.includes(p2), `Ctrl toggles (${sel.join(', ')})`);

            // Esc during a lasso restores the selection it started from
            const before = await selection(page);
            await page.mouse.move(start.x, start.y);
            await page.mouse.down();
            await page.mouse.move(target.x, target.y, { steps: 5 });
            await page.keyboard.press('Escape');
            await page.mouse.up();
            assert.deepEqual(await selection(page), before);
        },
    },
    {
        name: 'lasso auto-scrolls near the bottom edge and keeps selecting',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'many/': { bulk: { count: 240 } } } });
            await page.evaluate(() => App.nav.go('many'));
            await page.waitForFunction(() => App.view.visible.length === 240);
            const first = await itemPoint(page, 0);
            const box = await page.evaluate(() => {
                const r = document.getElementById('gallery-scroll').getBoundingClientRect();
                return { bottom: r.bottom, left: r.left, right: r.right };
            });
            await page.mouse.move(first.left - 8, first.top - 8);
            await page.mouse.down();
            await page.mouse.move(first.x + 200, box.bottom - 30, { steps: 6 });
            const countNow = await page.evaluate(() => App.select.count);
            await page.mouse.move(first.x + 200, box.bottom - 6, { steps: 2 });
            await page.waitForFunction(() => document.getElementById('gallery-scroll').scrollTop > 400, null, { timeout: 8000 });
            await page.mouse.up();
            const after = await page.evaluate(() => App.select.count);
            assert.ok(after > countNow, `selection grew while auto-scrolling (${countNow} -> ${after})`);
        },
    },
    {
        name: 'folder cards show a mosaic of the first media and recursive counts',
        async run({ openApp, assert, card }) {
            const seed = {
                'trip/a.png': { image: { color: '#a33' } },
                'trip/b.png': { image: { color: '#3a3' } },
                'trip/c.png': { image: { color: '#33a' } },
                'trip/d.png': { image: { color: '#aa3' } },
                'trip/e.png': { image: { color: '#3aa' } },
                'trip/v.webm': { video: { seconds: 1 } },
                'nested/inner/x.png': { image: {} },
                'empty/': null,
                'loose.png': { image: {} },
            };
            const { page } = await openApp({ seed });
            await page.waitForFunction(() => App.index.ready);
            await page.waitForSelector('.card[data-path="trip"] .card-mosaic.n4');
            assert.equal(await page.textContent('.card[data-path="trip"] .card-sub'), '사진 5 · 영상 1');
            await page.waitForFunction(() => document.querySelectorAll('.card[data-path="trip"] .mosaic-cell.has-thumb').length === 4, null, { timeout: 15000 });
            assert.equal(await page.textContent('.card[data-path="nested"] .card-sub'), '사진 1', 'counts include subfolders');
            assert.ok(await page.isVisible('.card[data-path="nested"] .card-mosaic.n1'), 'nested media fill the mosaic');
            assert.equal(await page.textContent('.card[data-path="empty"] .card-sub'), '비어 있어요');
            assert.ok(await page.isVisible('.card[data-path="empty"] .card-folder.is-empty'));
            assert.match(await (await card(page, 'trip')).locator('.card-sub').getAttribute('data-tip'), /하위 폴더까지 사진 5장 · 영상 1개/);
            // Counts follow file operations
            await page.evaluate(() => App.fs.move(['loose.png'], 'empty'));
            await page.waitForFunction(() => document.querySelector('.card[data-path="empty"] .card-sub')?.textContent === '사진 1', null, { timeout: 8000 });
            assert.ok(await page.isVisible('.card[data-path="empty"] .card-mosaic.n1'));
        },
    },
    {
        name: 'cards show rating, color label, chips (names in tooltip), memo, markers and duration',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await stubChipNames(page);
            await page.evaluate(() => {
                App.catalog.update('a-photo.png', { rating: 4, label: 'blue', chips: ['c1', 'c2'], memo: '바다에서 찍은 사진' });
                App.catalog.update('c-clip.webm', { markers: [{ id: 'm1', t: 0.2 }, { id: 'm2', t: 0.7 }] });
            });
            const a = '.card[data-path="a-photo.png"]';
            await page.waitForSelector(`${a} .card-stars`);
            assert.equal(await page.locator(`${a} .card-stars .ico`).count(), 4);
            assert.ok(await page.isVisible(`${a} .card-label.lbl-blue`));
            assert.equal((await page.textContent(`${a} .card-pill.is-chips`)).trim(), '2');
            assert.equal(await page.getAttribute(`${a} .card-pill.is-chips`, 'data-tip'), '인물/지민, 장소/제주');
            assert.equal(await page.getAttribute(`${a} .card-pill.is-memo`, 'data-tip'), '바다에서 찍은 사진');
            const v = '.card[data-path="c-clip.webm"]';
            assert.equal((await page.textContent(`${v} .card-pill.is-markers`)).trim(), '2');
            assert.ok(await page.isVisible(`${v} .card-dur`), 'videos keep their play/duration badge');
            // Recorded test clips may lack a duration header, so set the cached length explicitly
            await page.evaluate(() => {
                App.catalog.setMeta('c-clip.webm', { duration: 72.4 });
                App.gallery.invalidate(['c-clip.webm']);
            });
            await page.waitForFunction(() => document.querySelector('.card[data-path="c-clip.webm"] .card-time')?.textContent === '1:12');
            // Unrated items stay clean
            assert.equal(await page.locator('.card[data-path="b-photo.jpg"] .card-stars, .card[data-path="b-photo.jpg"] .card-pill').count(), 0);
        },
    },
    {
        name: "owner rule: hovering a video card plays ONLY that card (muted, looping) and leaving stops it",
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            const clip = await ensurePlayableClip(page, 'c-clip.webm');
            assert.notEqual(clip, 'failed', 'could not get a playable test clip');
            await page.waitForFunction(() => (App.view.get('c-clip.webm')?.size || 0) > 1000);
            await page.waitForSelector('.card[data-path="c-clip.webm"] .card-media');
            const box = await page.locator('.card[data-path="c-clip.webm"] .card-media').boundingBox();
            const playing = () => page.evaluate(() => {
                const v = document.querySelector('#gallery video.card-scrub-video');
                return !!v && !v.paused && v.muted && v.loop && v.currentTime > 0.05;
            });
            for (let k = 0; k < 60 && !(await playing()); k++) {
                await page.mouse.move(box.x + box.width * 0.5 + (k % 2), box.y + box.height / 2);
                await page.waitForTimeout(150);
            }
            assert.ok(await playing(), 'the hovered clip plays by itself (muted, looping)');
            assert.equal(await page.locator('#gallery video').count(), 1, 'only the hovered card has a <video>');
            await page.mouse.move(5, 5);
            await page.waitForFunction(() => !document.querySelector('#gallery video'));
        },
    },
    {
        name: 'Shift-hovering a video card scrubs a single lightweight preview with a progress line',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            // Scrub mode (what Shift does while hovering); the setting turns hover-play off for this check
            await page.evaluate(() => App.settings.set('gallery.hoverPlay', false));
            const clip = await ensurePlayableClip(page, 'c-clip.webm');
            assert.notEqual(clip, 'failed', 'could not get a playable test clip');
            await page.waitForFunction(() => (App.view.get('c-clip.webm')?.size || 0) > 1000); // listing caught up
            await page.waitForSelector('.card[data-path="c-clip.webm"] .card-media');
            const box = await page.locator('.card[data-path="c-clip.webm"] .card-media').boundingBox();
            await page.mouse.move(box.x + box.width * 0.15, box.y + box.height / 2);
            await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
            await page.waitForSelector('.card[data-path="c-clip.webm"] video.card-scrub-video');
            assert.equal(await page.locator('#gallery video').count(), 1, 'only the hovered card loads a <video>');
            await page.mouse.move(box.x + box.width * 0.85, box.y + box.height / 2, { steps: 3 });
            const scrubbed = () => page.evaluate(() => {
                const v = document.querySelector('#gallery video.card-scrub-video');
                return !!v && v.currentTime > 0.5 && v.classList.contains('ready');
            });
            // A hovering hand never holds perfectly still; keep nudging like one while the clip loads
            for (let k = 0; k < 60 && !(await scrubbed()); k++) {
                await page.mouse.move(box.x + box.width * 0.85 + (k % 2), box.y + box.height / 2);
                await page.waitForTimeout(150);
            }
            if (!(await scrubbed())) {
                const diag = await page.evaluate(async () => {
                    const probe = await new Promise(async (resolve) => {
                        const { url, release } = await App.fs.url('c-clip.webm');
                        const v = document.createElement('video');
                        v.muted = true;
                        v.onloadedmetadata = () => resolve({ ok: true, duration: v.duration }) || release();
                        v.onerror = () => resolve({ ok: false, code: v.error && v.error.code }) || release();
                        v.src = url;
                    });
                    return { scrub: App.gallery._scrubState(), card: document.querySelector('.card[data-path="c-clip.webm"]').className, size: App.view.get('c-clip.webm').size, freshVideo: probe };
                });
                assert.fail(`the preview seeks to where the pointer is: ${JSON.stringify(diag)}`);
            }
            const scale = await page.evaluate(() => document.querySelector('.card-scrub > i').style.transform);
            assert.match(scale, /scaleX\(0\.8/);
            await page.mouse.move(5, 5);
            await page.waitForFunction(() => !document.querySelector('#gallery video') && !document.querySelector('.card-scrub'));
            // Can be switched off
            await page.evaluate(() => App.commands.run('gallery.toggleScrub'));
            await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
            await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
            await page.waitForTimeout(250);
            assert.equal(await page.locator('#gallery video').count(), 0);
        },
    },
    {
        name: 'list view: toggle, sortable headers, keyboard, click-to-rate with undo, virtualization',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { ...SEED, 'many/': { bulk: { count: 400 } } } });
            await page.keyboard.press('Control+Shift+L');
            await page.waitForSelector('#gallery .lrow');
            assert.equal(await page.evaluate(() => App.gallery.mode), 'list');
            assert.equal(await page.evaluate(() => App.settings.get('gallery.mode')), 'list');
            assert.ok(await page.isVisible('.lhead [data-sort="name"]'));
            assert.equal(await page.locator('#gallery .card').count(), 0);
            // Sort by size: first click = biggest first, second click flips
            await page.click('.lhead [data-sort="size"]');
            assert.deepEqual(await page.evaluate(() => App.view.sort), { key: 'size', dir: 'desc' });
            const sizes = await page.evaluate(() => App.view.visible.filter((e) => e.kind === 'file').map((e) => e.size));
            assert.deepEqual(sizes, [...sizes].sort((x, y) => y - x));
            await page.click('.lhead [data-sort="size"]');
            assert.equal(await page.evaluate(() => App.view.sort.dir), 'asc');
            assert.ok(await page.isVisible('.lhead [data-sort="size"].sorted .lh-arrow'));
            await page.click('.lhead [data-sort="name"]');
            // Keyboard moves one row at a time
            await page.click('.lrow[data-path="a-photo.png"] .lr-name');
            await page.keyboard.press('ArrowDown');
            assert.deepEqual(await selection(page), ['b-photo.jpg']);
            // Click-to-rate, undoable
            await page.click('.lrow[data-path="b-photo.jpg"] .lstar[data-n="3"]');
            assert.equal(await page.evaluate(() => App.catalog.get('b-photo.jpg').rating), 3);
            await page.waitForSelector('.lrow[data-path="b-photo.jpg"] .lstar.on[data-n="3"]');
            // Rated stars keep the warning color in both themes
            for (const theme of ['dark', 'light']) {
                const [star, token] = await page.evaluate((t) => {
                    document.documentElement.dataset.theme = t;
                    const probe = document.createElement('i');
                    probe.style.color = 'var(--warning)';
                    document.body.append(probe);
                    const want = getComputedStyle(probe).color;
                    probe.remove();
                    return [getComputedStyle(document.querySelector('.lrow[data-path="b-photo.jpg"] .lstar.on')).color, want];
                }, theme);
                assert.equal(star, token, `${theme}: rated star uses --warning`);
            }
            await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
            await page.keyboard.press('Control+z');
            assert.equal(await page.evaluate(() => App.catalog.get('b-photo.jpg').rating), 0);
            // Big folder stays virtualized in list mode
            await page.evaluate(() => App.nav.go('many'));
            await page.waitForFunction(() => App.view.visible.length === 400);
            await page.waitForSelector('.lrow[data-path="many/IMG_00001.png"]');
            assert.ok((await page.locator('#gallery .lrow').count()) < 120, 'only rows near the viewport exist');
            await page.evaluate(() => {
                const s = document.getElementById('gallery-scroll');
                s.scrollTop = s.scrollHeight;
            });
            await page.waitForSelector('.lrow[data-path="many/IMG_00400.png"]');
            // Back to the grid from the view bar
            await page.click('.gv-mode button[aria-label="격자 보기"]');
            await page.waitForSelector('#gallery .card');
            assert.equal(await page.evaluate(() => App.gallery.mode), 'grid');
        },
    },
    {
        name: 'clipboard: copy/paste into another folder, cut/paste moves, paste into a folder from its menu',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            await (await card(page, 'a-photo.png')).click();
            await page.keyboard.press('Control+c');
            assert.equal(await page.evaluate(() => App.gallery.clipboard.count), 1);
            await (await card(page, 'trip')).dblclick();
            await page.waitForFunction(() => App.state.cwd === 'trip' && App.view.source.type === 'folder');
            await page.keyboard.press('Control+v');
            await page.waitForFunction(() => window.__opfs.exists('trip/a-photo.png'));
            assert.ok(await page.evaluate(() => window.__opfs.exists('a-photo.png')), 'copy keeps the original');
            await page.waitForSelector('.toast:has-text("1개를 복사했어요")');
            await page.waitForFunction(() => App.select.list().includes('trip/a-photo.png'), null, { timeout: 5000 });
            // [실행 취소] in the toast removes the copy
            await page.click('.toast:has-text("1개를 복사했어요") .toast-action:has-text("실행 취소")');
            await page.waitForFunction(async () => !(await window.__opfs.exists('trip/a-photo.png')));

            // Cut dims the card, paste moves it and empties the clipboard
            await page.keyboard.press('Alt+ArrowUp');
            await page.waitForFunction(() => App.state.cwd === '' && !!App.view.get('b-photo.jpg'));
            await (await card(page, 'b-photo.jpg')).click();
            await page.keyboard.press('Control+x');
            await page.waitForSelector('.card.is-cut[data-path="b-photo.jpg"]');
            await page.evaluate(() => App.nav.go('trip'));
            await page.waitForFunction(() => App.state.cwd === 'trip' && App.view.source.type === 'folder');
            await page.keyboard.press('Control+v');
            await page.waitForFunction(async () => (await window.__opfs.exists('trip/b-photo.jpg')) && !(await window.__opfs.exists('b-photo.jpg')));
            await page.waitForFunction(() => App.gallery.clipboard.count === 0);
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => window.__opfs.exists('b-photo.jpg'));

            // Paste into a folder through its context menu
            await page.evaluate(() => App.nav.go(''));
            await page.waitForFunction(() => App.state.cwd === '' && !!App.view.get('c-clip.webm'));
            await (await card(page, 'c-clip.webm')).click();
            await page.keyboard.press('Control+c');
            await (await card(page, 'empty')).click({ button: 'right' });
            await page.click('.menu .menu-item:has-text("이 폴더에 붙여넣기")');
            await page.waitForFunction(() => window.__opfs.exists('empty/c-clip.webm'));
        },
    },
    {
        name: 'Quick Look: Space toggles, arrows follow the grid, Enter opens the viewer, shortcuts pass through',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            await (await card(page, 'a-photo.png')).click();
            await page.keyboard.press('Space');
            await page.waitForSelector('#gallery-quicklook:not([hidden]) img.ql-media');
            assert.equal(await page.evaluate(() => App.layers.top()), 'quicklook');
            assert.equal(await page.textContent('.ql-title'), 'a-photo.png');
            await page.keyboard.press('ArrowRight');
            await page.waitForFunction(() => document.querySelector('.ql-title').textContent === 'b-photo.jpg');
            assert.deepEqual(await selection(page), ['b-photo.jpg'], 'the grid selection follows');
            await page.keyboard.press('Space');
            await page.waitForSelector('#gallery-quicklook', { state: 'hidden' });
            assert.equal(await page.evaluate(() => App.layers.top()), 'main');
            // Video plays muted
            await (await card(page, 'c-clip.webm')).click();
            await page.keyboard.press('Space');
            await page.waitForSelector('#gallery-quicklook video.ql-media');
            assert.ok(await page.evaluate(() => document.querySelector('video.ql-media').muted));
            await page.keyboard.press('Escape');
            await page.waitForSelector('#gallery-quicklook', { state: 'hidden' });
            // Delete passes through to file.trash and Quick Look moves on
            await (await card(page, 'd-photo.png')).click();
            await page.keyboard.press('Space');
            await page.waitForSelector('#gallery-quicklook:not([hidden])');
            await page.keyboard.press('Delete');
            await page.waitForFunction(() => document.querySelector('.ql-title').textContent === 'e-photo.png');
            assert.ok(!(await page.evaluate(() => window.__opfs.exists('d-photo.png'))));
            // Enter opens the full viewer and closes Quick Look
            await page.keyboard.press('Enter');
            await page.waitForSelector('#viewer:not([hidden])');
            assert.ok(await page.isHidden('#gallery-quicklook'));
            await page.keyboard.press('Escape');
            await page.waitForSelector('#viewer', { state: 'hidden' });
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => window.__opfs.exists('d-photo.png'));
        },
    },
    {
        name: 'type-ahead jumps to the next item whose name starts with the typed text',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await page.keyboard.press('c');
            assert.deepEqual(await selection(page), ['c-clip.webm']);
            assert.ok(await page.isVisible('.type-pill.show'));
            await page.waitForTimeout(950);
            await page.keyboard.type('tr');
            assert.deepEqual(await selection(page), ['trip']);
            await page.waitForTimeout(950);
            // Repeating a letter cycles through matches
            await page.keyboard.press('e');
            const firstE = (await selection(page))[0];
            await page.keyboard.press('e');
            const secondE = (await selection(page))[0];
            assert.ok(firstE !== secondE && /^e/.test(firstE) && /^e/.test(secondE), `${firstE} -> ${secondE}`);
        },
    },
    {
        name: 'context menus: item actions incl. organize commands when registered, empty-space actions',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            await page.evaluate(() => {
                App.commands.register({ id: 'organize.moveTo', title: '다른 폴더로 이동', group: '정리', icon: 'folder-input', keys: ['Mod+Shift+M'], run: () => (window.__movedTo = App.select.list()) });
            });
            await (await card(page, 'a-photo.png')).click({ button: 'right' });
            await page.waitForSelector('.menu');
            const labels = await page.$$eval('.menu .menu-label', (els) => els.map((e) => e.textContent));
            for (const want of ['보기', '훑어보기', '복사', '잘라내기', '다른 폴더로 이동…', '이름 바꾸기', '휴지통으로 이동']) assert.ok(labels.includes(want), `menu has ${want} (${labels.join(', ')})`);
            assert.ok(!labels.includes('다른 폴더에 복사…'), 'unregistered organize.copyTo is hidden');
            await page.click('.menu .menu-item:has-text("다른 폴더로 이동…")');
            assert.deepEqual(await page.evaluate(() => window.__movedTo), ['a-photo.png']);
            // Empty space
            const first = await itemPoint(page, 0);
            await page.mouse.click(first.left - 8, first.top - 8, { button: 'right' });
            await page.waitForSelector('.menu');
            const empty = await page.$$eval('.menu .menu-label', (els) => els.map((e) => e.textContent));
            for (const want of ['새 폴더', '붙여넣기', '새로 고침', '모두 선택', '보기 방식', '정렬']) assert.ok(empty.includes(want), `empty-space menu has ${want} (${empty.join(', ')})`);
            await page.keyboard.press('Escape');
        },
    },
    {
        name: 'selection action bar: count + size, only registered commands, trash and clear',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            await (await card(page, 'a-photo.png')).click();
            assert.ok(!(await page.isVisible('.gab.show')), 'hidden for a single item');
            const h0 = await page.evaluate(() => document.getElementById('gallery').offsetHeight);
            await (await card(page, 'd-photo.png')).click({ modifiers: ['Control'] });
            await page.waitForSelector('.gab.show');
            assert.match(await page.textContent('.gab-count'), /2개 선택/);
            assert.match(await page.textContent('.gab-size'), /KB/);
            assert.ok((await page.evaluate(() => document.getElementById('gallery').offsetHeight)) > h0, 'extra scroll room under the last row');
            assert.ok(await page.isHidden('.gab-btn[data-command="chips.picker"]'));
            assert.ok(await page.isVisible('.gab-btn[data-command="file.trash"]'));
            await page.evaluate(() => App.commands.register({ id: 'chips.picker', title: '칩 붙이기', keys: ['Mod+Shift+C'], run: () => (window.__chips = App.select.count) }));
            await page.waitForSelector('.gab-btn[data-command="chips.picker"]:not([hidden])');
            assert.equal(await page.getAttribute('.gab-btn[data-command="chips.picker"]', 'data-tip-keys'), 'Mod+Shift+C');
            await page.click('.gab-btn[data-command="chips.picker"]');
            assert.equal(await page.evaluate(() => window.__chips), 2);
            await page.click('.gab-btn[data-command="file.trash"]');
            await page.waitForFunction(async () => !(await window.__opfs.exists('a-photo.png')) && !(await window.__opfs.exists('d-photo.png')));
            await page.waitForSelector('.gab:not(.show)', { state: 'attached' });
            await page.keyboard.press('Control+a');
            await page.waitForSelector('.gab.show');
            await page.click('.gab-close');
            assert.equal(await page.evaluate(() => App.select.count), 0);
        },
    },
    {
        name: 'fit toggle switches between 꽉 채우기 and 원본 비율 and is remembered',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.card-img')).objectFit), 'cover');
            await page.keyboard.press('Control+Alt+F');
            assert.equal(await page.evaluate(() => App.gallery.fit), 'contain');
            assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.card-img')).objectFit), 'contain');
            assert.equal(await page.evaluate(() => App.settings.get('gallery.fit')), 'contain');
            await page.click('.gv-fit button[aria-label="꽉 채우기"]');
            assert.equal(await page.evaluate(() => App.gallery.fit), 'cover');
            assert.ok(await page.isVisible('.gv-fit button[aria-pressed="true"][aria-label="꽉 채우기"]'));
        },
    },
    {
        name: 'drag & drop: fanned drag image, drop label, toast with undo and "폴더로 가기"',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            await page.waitForSelector('.card[data-path="trip"] .card-mosaic'); // folder stats settled
            await page.waitForSelector('.card[data-path="a-photo.png"].has-thumb');
            await page.waitForSelector('.card[data-path="d-photo.png"].has-thumb');
            await (await card(page, 'a-photo.png')).click();
            await (await card(page, 'd-photo.png')).click({ modifiers: ['Control'] });
            const src = await (await card(page, 'a-photo.png')).boundingBox();
            const dst = await (await card(page, 'trip')).boundingBox();
            await page.mouse.move(src.x + src.width / 2, src.y + src.height / 3);
            await page.mouse.down();
            await page.mouse.move(dst.x + dst.width / 2, dst.y + dst.height / 3, { steps: 10 });
            for (let k = 0; k < 80 && !(await page.isVisible('.card[data-path="trip"] .drop-label')); k++) {
                await page.mouse.move(dst.x + dst.width / 2 + (k % 2), dst.y + dst.height / 3);
                await page.waitForTimeout(60);
            }
            assert.ok(await page.isVisible('.card[data-path="trip"] .drop-label'), 'the folder under the pointer shows the drop label');
            assert.equal((await page.textContent('.card[data-path="trip"] .drop-label')).trim(), '2개를 ‘trip’(으)로 이동 · Ctrl: 복사');
            await page.mouse.up();
            const toast = page.locator('.toast:has-text("2개를 옮겼어요")');
            await toast.waitFor();
            assert.ok(await page.evaluate(async () => (await window.__opfs.exists('trip/a-photo.png')) && (await window.__opfs.exists('trip/d-photo.png'))));
            assert.deepEqual(await page.evaluate(() => App.gallery._lastDragImage), { count: 2, tiles: 2, drawn: 2 });
            await toast.waitFor();
            assert.equal(await toast.locator('.toast-action').count(), 2);
            await toast.locator('.toast-action:has-text("폴더로 가기")').click();
            await page.waitForFunction(() => App.state.cwd === 'trip');
            await page.waitForFunction(() => App.select.list().join() === 'trip/a-photo.png,trip/d-photo.png');
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => window.__opfs.exists('a-photo.png'));
        },
    },
    {
        name: 'hovering a folder while dragging opens it (spring-loaded) and the drop lands inside',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: SEED });
            await page.waitForSelector('.card[data-path="trip"] .card-mosaic'); // folder stats settled
            const src = await (await card(page, 'f-photo.png')).boundingBox();
            const dst = await (await card(page, 'trip')).boundingBox();
            await page.mouse.move(src.x + src.width / 2, src.y + src.height / 3);
            await page.mouse.down();
            await page.mouse.move(dst.x + dst.width / 2, dst.y + dst.height / 3, { steps: 8 });
            // Browsers repeat dragover while hovering; the emulated drag only does so on moves, so hover gently
            for (let k = 0; k < 40 && (await page.evaluate(() => App.state.cwd)) !== 'trip'; k++) {
                await page.mouse.move(dst.x + dst.width / 2 + (k % 2), dst.y + dst.height / 3);
                await page.waitForTimeout(100);
            }
            assert.equal(await page.evaluate(() => App.state.cwd), 'trip', 'hovering the folder opened it');
            // Drop into "2024" inside trip
            await page.waitForSelector('.card[data-path="trip/2024"]');
            const inner = await (await card(page, '2024')).boundingBox();
            await page.mouse.move(inner.x + inner.width / 2, inner.y + inner.height / 3, { steps: 6 });
            await page.mouse.up();
            await page.waitForFunction(() => window.__opfs.exists('trip/2024/f-photo.png'));
            assert.ok(!(await page.evaluate(() => window.__opfs.exists('f-photo.png'))));
        },
    },
    {
        name: 'dropping and pasting files from outside imports media only, with undo',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await page.evaluate(async () => {
                const c = new OffscreenCanvas(40, 30);
                c.getContext('2d').fillRect(0, 0, 40, 30);
                const blob = await c.convertToBlob({ type: 'image/png' });
                const dt = new DataTransfer();
                dt.items.add(new File([blob], 'dropped.png', { type: 'image/png' }));
                dt.items.add(new File(['hello'], 'readme.txt', { type: 'text/plain' }));
                document.getElementById('gallery-scroll').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
            });
            await page.waitForFunction(() => window.__opfs.exists('dropped.png'));
            assert.ok(!(await page.evaluate(() => window.__opfs.exists('readme.txt'))), 'non-media files are skipped');
            await page.waitForSelector('.toast:has-text("1개 파일을 가져왔어요")');
            await page.keyboard.press('Control+z');
            await page.waitForFunction(async () => !(await window.__opfs.exists('dropped.png')));
            // Screenshot-style paste from the system clipboard (file clipboard is empty)
            await page.evaluate(async () => {
                const c = new OffscreenCanvas(40, 30);
                c.getContext('2d').fillRect(0, 0, 40, 30);
                const blob = await c.convertToBlob({ type: 'image/png' });
                const dt = new DataTransfer();
                dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
                document.body.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
            });
            await page.waitForFunction(() => App.view.visible.some((e) => e.name.startsWith('붙여넣은 이미지 ')));
            await page.waitForSelector('.toast:has-text("붙여 넣었어요")');
        },
    },
    {
        name: 'returning to a parent folder focuses (then selects) the subfolder you came from',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await page.evaluate(() => App.nav.go('trip/2024'));
            await page.waitForFunction(() => App.view.source.path === 'trip/2024');
            // Breadcrumb-style jump two levels up: focus is there as soon as loading starts
            const early = await page.evaluate(() => {
                App.nav.go('');
                return App.select.focus;
            });
            assert.equal(early, 'trip');
            await page.waitForFunction(() => App.view.source.path === '' && App.select.list().join() === 'trip');
            // Going forward into a child does not invent a focus
            await page.keyboard.press('Alt+ArrowLeft');
            await page.waitForFunction(() => App.view.source.path === 'trip/2024');
            assert.equal(await page.evaluate(() => App.select.count), 0);
        },
    },
    {
        name: 'empty states, scroll memory on back, and zoom keeps the grid anchored',
        async run({ openApp, assert, card }) {
            const { page } = await openApp({ seed: { ...SEED, 'many/': { bulk: { count: 300 } }, 'many/sub/x.png': { image: {} } } });
            // A filter that matches nothing shows a way out
            await page.evaluate(() => App.view.setFilter('nothing', { label: '없음', test: () => false, includeDirs: true }));
            await page.waitForSelector('#gallery-empty:not([hidden]) .gallery-empty-action');
            assert.equal(await page.textContent('#gallery-empty h2'), '조건에 맞는 항목이 없어요');
            await page.click('#gallery-empty .gallery-empty-action');
            assert.equal(await page.evaluate(() => App.view.filters.size), 0);
            await page.waitForSelector('#gallery-empty', { state: 'hidden' });
            // Scroll memory
            await page.evaluate(() => App.nav.go('many'));
            await page.waitForFunction(() => App.view.visible.length === 301);
            await page.evaluate(() => (document.getElementById('gallery-scroll').scrollTop = 2400));
            await page.waitForTimeout(100);
            const saved = await page.evaluate(() => document.getElementById('gallery-scroll').scrollTop);
            await page.evaluate(() => App.nav.go('many/sub'));
            await page.waitForFunction(() => App.state.cwd === 'many/sub' && App.view.visible.length === 1);
            await page.keyboard.press('Alt+ArrowLeft');
            await page.waitForFunction(() => App.state.cwd === 'many' && App.view.visible.length === 301);
            await page.waitForFunction((s) => Math.abs(document.getElementById('gallery-scroll').scrollTop - s) < 4, saved);
            // Zooming keeps the focused item in view
            const target = 'many/IMG_00150.png';
            await page.evaluate((p) => {
                App.select.set([p]);
                App.gallery.scrollTo(p, { center: true });
            }, target);
            await page.waitForTimeout(100);
            await page.keyboard.press('Control+=');
            await page.keyboard.press('Control+=');
            await page.waitForTimeout(150);
            const inView = await page.evaluate((p) => {
                const el = App.gallery.cardFor(p);
                if (!el) return false;
                const r = el.getBoundingClientRect();
                const s = document.getElementById('gallery-scroll').getBoundingClientRect();
                return r.bottom > s.top && r.top < s.bottom;
            }, target);
            assert.ok(inView, 'focused card stays visible after zooming');
        },
    },
];
