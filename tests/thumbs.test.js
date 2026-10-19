// Thumbnail engine, caches, pre-generation, media info, sort keys, colour placeholders, status bar & activity center
// (thumbs team)
'use strict';

// The harness records seed videos with MediaRecorder; the first recording in a page sometimes comes out empty, so a
// hidden warm-up clip (dot-files are ignored by the app) goes first wherever a test depends on a video.
const WARMUP = { '.warmup.webm': { video: { seconds: 0.5 } } };

const SEED = {
    ...WARMUP,
    'red.png': { image: { color: '#c22', label: 'R' } },
    'green.jpg': { image: { color: '#2a2', label: 'G', mime: 'image/jpeg', w: 1200, h: 800 } },
    'clip.webm': { video: { seconds: 1.2 } },
    'trip/': null,
};

// Runs in the page: a canvas JPEG with an EXIF block (Make, Model, Orientation, DateTimeOriginal, GPS) spliced in.
async function makeExifJpeg(o) {
    const opt = Object.assign({ w: 400, h: 200, color: '#c33', make: 'Canon', model: 'Canon EOS R5', orientation: 6, date: '2023:07:15 14:30:05' }, o || {});
    const T = { ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5 };
    const size = { 2: 1, 3: 2, 4: 4, 5: 8 };
    const enc = (type, v) => {
        if (type === T.ASCII) return [...new TextEncoder().encode(v), 0];
        if (type === T.SHORT) return [].concat(...[].concat(v).map((n) => [n & 255, (n >> 8) & 255]));
        if (type === T.LONG) return [].concat(...[].concat(v).map((n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]));
        return [].concat(...v.map(([a, b]) => [...enc(T.LONG, a), ...enc(T.LONG, b)]));
    };
    const count = (type, v) => (type === T.ASCII ? enc(type, v).length : type === T.RATIONAL ? v.length : [].concat(v).length);
    const ifdLen = (n) => 2 + n * 12 + 4;
    const dataLen = (entries) => entries.reduce((s, [, type, v]) => {
        const l = count(type, v) * size[type];
        return s + (l > 4 ? l + (l % 2) : 0);
    }, 0);
    const exif = [[0x9003, T.ASCII, opt.date]];
    const gps = [[0x0001, T.ASCII, 'N'], [0x0002, T.RATIONAL, [[37, 1], [33, 1], [3000, 100]]], [0x0003, T.ASCII, 'E'], [0x0004, T.RATIONAL, [[126, 1], [58, 1], [4500, 100]]]];
    const ifd0 = [[0x010f, T.ASCII, opt.make], [0x0110, T.ASCII, opt.model], [0x0112, T.SHORT, opt.orientation], [0x8769, T.LONG, 0], [0x8825, T.LONG, 0]];
    const offExif = 8 + ifdLen(ifd0.length) + dataLen(ifd0);
    const offGps = offExif + ifdLen(exif.length) + dataLen(exif);
    ifd0[3][2] = offExif;
    ifd0[4][2] = offGps;
    const writeIfd = (entries, start) => {
        let data = start + ifdLen(entries.length);
        const head = [...enc(T.SHORT, entries.length)];
        const tail = [];
        for (const [tag, type, v] of entries) {
            const bytes = enc(type, v);
            head.push(...enc(T.SHORT, tag), ...enc(T.SHORT, type), ...enc(T.LONG, count(type, v)));
            if (bytes.length <= 4) head.push(...bytes, ...new Array(4 - bytes.length).fill(0));
            else {
                head.push(...enc(T.LONG, data));
                tail.push(...bytes);
                if (bytes.length % 2) tail.push(0);
                data += bytes.length + (bytes.length % 2);
            }
        }
        head.push(0, 0, 0, 0);
        return [...head, ...tail];
    };
    const tiff = [0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, ...writeIfd(ifd0, 8), ...writeIfd(exif, offExif), ...writeIfd(gps, offGps)];
    const c = new OffscreenCanvas(opt.w, opt.h);
    const g = c.getContext('2d');
    g.fillStyle = opt.color;
    g.fillRect(0, 0, opt.w, opt.h);
    g.fillStyle = '#fff';
    g.fillRect(0, 0, opt.w / 4, opt.h / 4);
    const jpg = new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer());
    const body = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
    const len = body.length + 2;
    const app1 = [0xff, 0xe1, (len >> 8) & 255, len & 255, ...body];
    const out = new Uint8Array(jpg.length + app1.length);
    out.set(jpg.subarray(0, 2), 0);
    out.set(app1, 2);
    out.set(jpg.subarray(2), 2 + app1.length);
    return new Blob([out], { type: 'image/jpeg' });
}

async function addExifJpeg(page, dir, name, opts) {
    await page.evaluate(
        async ({ src, dir: d, name: n, opts: o }) => {
            // eslint-disable-next-line no-new-func
            const make = new Function(`return (${src})`)();
            await App.fs.createFile(d, n, await make(o));
        },
        { src: makeExifJpeg.toString(), dir, name, opts },
    );
    const p = dir ? `${dir}/${name}` : name;
    await page.waitForFunction((x) => !!App.index.get(x), p);
    return p;
}

async function openClosed(openApp, waitIdle, seed) {
    const app = await openApp({ seed, open: false });
    return app;
}

async function pickWorkspace(page, waitIdle) {
    await page.evaluate(() => App.workspace.pick());
    await page.waitForFunction(() => App.state.cwd === '' && App.view.source.type === 'folder');
    await waitIdle(page);
}

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

module.exports = [
    {
        name: 'engine: worker thumbnails, IndexedDB + workspace disk cache, media info and colour',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await page.waitForFunction(() => document.querySelectorAll('.card.has-thumb').length >= 3, null, { timeout: 20000 });
            const s = await page.evaluate(() => App.thumbs.stats());
            assert.ok(s.worker && s.workers >= 1, 'images decode in workers');
            assert.equal(s.mainThread, 0, 'no main-thread fallback was needed');
            const red = await page.evaluate(() => App.catalog.peek('red.png').meta);
            assert.equal(red.w, 640);
            assert.equal(red.h, 480);
            const [r, g, b] = rgb(red.dc);
            assert.ok(r > 150 && g < 100 && b < 100, `average colour of a red image is red (${red.dc})`);
            const clip = await page.evaluate(() => App.catalog.peek('clip.webm').meta);
            assert.ok(clip.duration > 0.6 && clip.duration < 3, `video duration ${clip.duration}`);
            assert.equal(clip.w, 320);
            assert.match(clip.dc, /^#[0-9a-f]{6}$/);
            const info = await page.evaluate(async () => {
                const blob = await (await fetch(App.thumbs.peek(App.view.get('green.jpg')))).blob();
                const bm = await createImageBitmap(blob);
                return { type: blob.type, w: bm.width, h: bm.height };
            });
            assert.deepEqual(info, { type: 'image/webp', w: 360, h: 240 }, 'long edge scaled to 360px, aspect kept');

            await page.evaluate(() => App.thumbs._debug.flush());
            const usage = await page.evaluate(() => App.thumbs.usage());
            assert.ok(usage.idb.count >= 3 && usage.idb.bytes > 0, 'thumbnails stored in IndexedDB');
            assert.ok(usage.disk.count >= 3, 'and in the workspace');
            assert.ok((await page.evaluate(() => window.__opfs.list('.fluid-organizer/thumbs/v2'))).length >= 1);

            // Browser cache wiped (e.g. browser reinstalled): thumbnails come back from the workspace without decoding
            await page.evaluate(() => App.thumbs.clearCache({ disk: false }));
            const before = await page.evaluate(() => App.thumbs.stats());
            const url = await page.evaluate(() => App.thumbs.get(App.view.get('red.png')));
            assert.ok(url && url.startsWith('blob:'));
            await page.waitForFunction(() => document.querySelectorAll('.card.has-thumb').length >= 3);
            const after = await page.evaluate(() => App.thumbs.stats());
            assert.equal(after.generated, before.generated, 'nothing had to be decoded again');
            assert.ok(after.hits.disk > before.hits.disk, 'served from .fluid-organizer/thumbs');
        },
    },
    {
        name: 'pre-generation covers the whole library, reads EXIF / video info, then skips what is cached',
        async run({ openApp, assert }) {
            const { page } = await openApp({
                seed: {
                    ...WARMUP,
                    'cover.png': { image: { color: '#888' } },
                    'trip/a.png': { image: { color: '#25c' } },
                    'trip/deep/tall.png': { image: { color: '#c80', w: 300, h: 600 } },
                    'clips/c.webm': { video: { seconds: 1 } },
                },
            });
            await addExifJpeg(page, 'trip', 'exif.jpg');
            const r = await page.evaluate(() => App.commands.run('thumbs.pregenerate'));
            assert.equal(r.total, 5);
            assert.equal(r.failed, 0);
            assert.deepEqual(await page.evaluate(() => App.thumbs.coverage()), { total: 5, cached: 5 });

            const exif = await page.evaluate(() => App.catalog.peek('trip/exif.jpg').meta);
            assert.equal(exif.taken, await page.evaluate(() => new Date(2023, 6, 15, 14, 30, 5).getTime()), 'DateTimeOriginal');
            assert.equal(exif.camera, 'Canon EOS R5', 'make is not repeated');
            assert.deepEqual(exif.gps, { lat: 37.558333, lng: 126.979167 });
            assert.equal(exif.orient, 6);
            assert.deepEqual([exif.w, exif.h], [200, 400], 'size as displayed (EXIF rotation applied)');
            const thumb = await page.evaluate(async () => {
                const url = await App.thumbs.get(App.index.get('trip/exif.jpg'));
                const bm = await createImageBitmap(await (await fetch(url)).blob());
                return [bm.width, bm.height];
            });
            assert.deepEqual(thumb, [180, 360], 'thumbnail is upright');
            const tall = await page.evaluate(() => App.catalog.peek('trip/deep/tall.png').meta);
            assert.deepEqual([tall.w, tall.h, tall.mv], [300, 600, 1]);
            const clip = await page.evaluate(() => App.catalog.peek('clips/c.webm').meta);
            assert.ok(clip.duration > 0.5 && clip.dc, 'nested video got duration and colour');

            const hist = await page.evaluate(() => App.statusbar.history());
            assert.equal(hist[0].title, '썸네일 미리 만들기');
            assert.equal(hist[0].state, 'done');
            assert.match(hist[0].result, /만듦/);

            const again = await page.evaluate(() => App.commands.run('thumbs.pregenerate'));
            assert.equal(again.total, 0, 'cached items are skipped');
            await page.waitForSelector('.toast >> text=모든 썸네일이 이미 준비돼 있어요');
        },
    },
    {
        name: 'pre-generation yields to on-screen requests, pauses, resumes and cancels from the activity center',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({ seed: { 'look.png': { image: {} }, 'bulk/': { bulk: { count: 400 } } } });
            await page.evaluate(() => {
                window.__pg = App.commands.run('thumbs.pregenerate');
            });
            await page.waitForFunction(() => App.jobs.list().some((j) => j.kind === 'thumbs' && j.done > 5), null, { timeout: 20000 });
            await page.keyboard.press('Control+Alt+P');
            await page.waitForFunction(() => App.jobs.list().find((j) => j.kind === 'thumbs')?.paused === true);
            // Work already in flight finishes, then progress stands still
            const done = () => page.evaluate(() => App.thumbs.stats().generated);
            await page.waitForTimeout(900);
            const d1 = await done();
            await page.waitForTimeout(700);
            const d2 = await done();
            assert.equal(d2, d1, `nothing new starts while paused (${d1} -> ${d2})`);
            assert.ok(d2 < 401, 'paused before the end');
            assert.equal(await page.evaluate(() => App.statusbar.isBackgroundJob(App.jobs.list().find((j) => j.kind === 'thumbs'))), true);

            // What the user looks at is never blocked by background work
            const url = await page.evaluate(() => App.thumbs.get(App.index.get('bulk/IMG_00400.png')));
            assert.ok(url && url.startsWith('blob:'), 'on-screen request served while pre-generation is paused');

            await page.keyboard.press('Control+j');
            await page.waitForSelector('.act-pop .act-job.paused');
            assert.equal(await page.textContent('.act-pop .act-job-title'), '썸네일 만드는 중');
            await page.click('.act-pop .act-job .act-btn:not(.act-cancel)');
            await page.waitForFunction(() => App.jobs.list().find((j) => j.kind === 'thumbs')?.paused === false);
            await page.waitForFunction((d) => App.thumbs.stats().generated > d + 6, d2, { timeout: 20000 });
            await page.click('.act-pop .act-cancel');
            await page.waitForFunction(() => !App.jobs.list().some((j) => j.kind === 'thumbs'));
            await page.waitForSelector('.act-pop .act-hist.is-cancelled');
            assert.match(await page.textContent('.act-pop .act-hist.is-cancelled .act-hist-result'), /취소됨/);
            const res = await page.evaluate(() => window.__pg);
            assert.equal(res.cancelled, true);
            await waitIdle(page);
        },
    },
    {
        name: 'sort keys 촬영 날짜 / 해상도 / 영상 길이 read missing info and order correctly',
        async run({ openApp, assert }) {
            const { page } = await openApp({
                seed: {
                    ...WARMUP,
                    'small.png': { image: { w: 200, h: 100 } },
                    'large.png': { image: { w: 1600, h: 1200 } },
                    'short.webm': { video: { seconds: 1 } },
                    'long.webm': { video: { seconds: 2.4 } },
                },
            });
            await addExifJpeg(page, '', 'old.jpg', { date: '2001:02:03 04:05:06', orientation: 1 });
            const labels = await page.evaluate(() => App.view.sortKeys().map((k) => `${k.key}:${k.label}`));
            assert.ok(labels.includes('taken:촬영 날짜') && labels.includes('resolution:해상도') && labels.includes('duration:영상 길이'));
            const files = () => page.evaluate(() => App.view.visible.filter((e) => e.kind === 'file').map((e) => e.name));

            await page.evaluate(() => App.view.setSort('taken', 'asc'));
            await page.waitForFunction(() => App.view.visible[0]?.name === 'old.jpg', null, { timeout: 15000 });
            assert.equal(await page.evaluate(() => App.catalog.peek('old.jpg').meta.taken), await page.evaluate(() => new Date(2001, 1, 3, 4, 5, 6).getTime()));

            await page.evaluate(() => App.view.setSort('resolution', 'desc'));
            await page.waitForFunction(() => App.view.visible[0]?.name === 'large.png', null, { timeout: 15000 });
            assert.equal((await files()).slice(-2).every((n) => n.endsWith('.webm') || n === 'small.png'), true);

            await page.evaluate(() => App.view.setSort('duration', 'desc'));
            await page.waitForFunction(() => App.view.visible[0]?.name === 'long.webm' && App.view.visible[1]?.name === 'short.webm', null, { timeout: 15000 });
            await page.evaluate(() => App.view.setSort('name', 'asc'));
        },
    },
    {
        name: 'a poster frame (meta.posterT) re-captures the video thumbnail and refreshes its card',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { ...WARMUP, 'clip.webm': { video: { seconds: 2.4 } } } });
            await page.waitForSelector('.card[data-path="clip.webm"].has-thumb', { timeout: 20000 });
            const src0 = await page.getAttribute('.card[data-path="clip.webm"] .card-img', 'src');
            const dc0 = await page.evaluate(() => App.catalog.peek('clip.webm').meta.dc);
            const gen0 = await page.evaluate(() => App.thumbs.stats().generated);
            await page.evaluate(() => App.catalog.update('clip.webm', (e) => {
                e.meta = { ...(e.meta || {}), posterT: 1.8 };
            }));
            await page.waitForFunction((s) => {
                const img = document.querySelector('.card[data-path="clip.webm"].has-thumb .card-img');
                return img && img.getAttribute('src') !== s;
            }, src0, { timeout: 20000 });
            assert.equal(await page.evaluate(() => App.thumbs.stats().generated), gen0 + 1);
            assert.match(await page.evaluate(() => App.thumbs.keyOf(App.view.get('clip.webm'))), /\|t1\.8$/);
            const dc1 = await page.evaluate(() => App.catalog.peek('clip.webm').meta.dc);
            assert.notEqual(dc1, dc0, 'colour follows the new frame');
        },
    },
    {
        name: 'cards show the average colour, or a shimmer (static with reduced motion), until the thumbnail arrives',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'red.png': { image: { color: '#c22' } }, 'blue.png': { image: { color: '#23c' } } } });
            await page.waitForFunction(() => document.querySelectorAll('.card.has-thumb').length === 2, null, { timeout: 15000 });
            const dc = await page.evaluate(() => App.catalog.peek('red.png').meta.dc);
            // Hold thumbnails back so the placeholder state can be inspected
            await page.evaluate(() => {
                App.catalog.setMeta('blue.png', { dc: undefined });
                App.thumbs.peek = () => null;
                App.thumbs.get = () => new Promise(() => {});
                App.gallery.refresh();
            });
            await page.waitForSelector('.card[data-path="red.png"].thumb-dc');
            const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.card[data-path="red.png"] .card-media')).backgroundColor);
            assert.equal(bg, `rgb(${rgb(dc).join(', ')})`);
            await page.waitForSelector('.card[data-path="blue.png"].thumb-wait .thumb-shimmer');
            const anim = () => page.evaluate(() => getComputedStyle(document.querySelector('.card[data-path="blue.png"] .thumb-shimmer'), '::before').animationName);
            assert.equal(await anim(), 'thumb-shimmer');
            await page.emulateMedia({ reducedMotion: 'reduce' });
            assert.equal(await anim(), 'none');
        },
    },
    {
        name: 'status bar: counts, selection size, save state, cache tooltip and Ctrl+S',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await page.waitForFunction(() => /4개 항목/.test(document.querySelector('.sb-counts')?.textContent || ''));
            await page.keyboard.press('Control+a');
            await page.waitForFunction(() => /4개 선택됨 · \d/.test(document.querySelector('.sb-selection')?.textContent || ''));
            await page.click('.card[data-path="red.png"]');
            await page.waitForFunction(() => /1개 선택됨 · .* · 640×480/.test(document.querySelector('.sb-selection').textContent));
            await page.keyboard.press('Alt+2');
            await page.waitForFunction(() => /표시 · 전체 4개/.test(document.querySelector('.sb-counts').textContent));
            await page.keyboard.press('Alt+1');

            assert.match(await page.textContent('.sb-save'), /저장됨/);
            await page.evaluate(() => App.catalog.update('red.png', { rating: 3 }));
            await page.waitForFunction(() => document.querySelector('.sb-save').textContent.includes('저장 중'));
            await page.waitForFunction(() => document.querySelector('.sb-save').textContent.includes('저장됨'));
            const saved = JSON.parse(await page.evaluate(() => window.__opfs.read('.fluid-organizer/catalog.json')));
            assert.equal(saved.items['red.png'].rating, 3);

            // Once the catalog reports its own saves, failures show up and clicking retries
            await page.evaluate(() => App.bus.emit('catalog:error', { error: new Error('디스크가 가득 찼어요') }));
            await page.waitForSelector('.sb-save.is-error');
            assert.match(await page.textContent('.sb-save'), /저장 실패 · 다시 시도/);
            assert.equal(await page.evaluate(() => {
                const e = new Event('beforeunload', { cancelable: true });
                window.dispatchEvent(e);
                return e.defaultPrevented;
            }), true, 'unsaved data asks before closing');
            await page.click('.sb-save');
            await page.evaluate(() => App.bus.emit('catalog:saved'));
            await page.waitForFunction(() => document.querySelector('.sb-save').textContent.includes('저장됨'));

            await page.keyboard.press('Control+s');
            await page.waitForSelector('.toast >> text=모든 변경 사항을 저장했어요');
            await page.waitForFunction(() => /썸네일/.test(document.querySelector('.sb-cache')?.dataset.tip || ''));
        },
    },
    {
        name: 'activity center: running and finished jobs, Ctrl+J, failure dot, beforeunload only for foreground jobs',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'a.png': { image: {} } } });
            const unloadBlocked = () => page.evaluate(() => {
                const e = new Event('beforeunload', { cancelable: true });
                window.dispatchEvent(e);
                return e.defaultPrevented;
            });
            assert.equal(await unloadBlocked(), false);
            await page.evaluate(() => {
                window.__j = App.jobs.start({ title: '테스트 복사하는 중', total: 10 });
                window.__j.update(4, { detail: '4 / 10개 · 사진.jpg' });
            });
            await page.waitForFunction(() => /테스트 복사하는 중.*40%/.test(document.querySelector('.sb-activity').textContent));
            assert.equal(await unloadBlocked(), true, 'closing the tab during a copy asks first');

            await page.keyboard.press('Control+j');
            await page.waitForSelector('.act-pop .act-job');
            assert.equal(await page.textContent('.act-pop .act-job-pct'), '40%');
            assert.equal(await page.textContent('.act-pop .act-job-detail'), '4 / 10개 · 사진.jpg');
            await page.evaluate(() => {
                window.__j.result = '10개 복사함';
                window.__j.update(10);
                window.__j.finish();
            });
            await page.waitForSelector('.act-pop .act-hist.is-done:has-text("테스트 복사하기")');
            assert.equal(await page.textContent('.act-pop .act-hist.is-done .act-hist-title'), '테스트 복사하기', 'newest first, "~하는 중" becomes "~하기"');
            assert.match(await page.textContent('.act-pop .act-hist.is-done .act-hist-result'), /^10개 복사함/);
            assert.ok(await page.isVisible('.act-pop .act-empty'), 'empty state when nothing runs');
            await page.keyboard.press('Control+j');
            await page.waitForSelector('.act-pop', { state: 'detached' });

            await page.evaluate(() => {
                const b = App.jobs.start({ title: '배경 작업', total: 5 });
                b.background = true;
                window.__b = b;
            });
            assert.equal(await unloadBlocked(), false, 'background work never blocks closing');
            await page.evaluate(() => {
                window.__b.finish();
                App.jobs.start({ title: '실패할 작업' }).fail(new Error('권한이 없어요'));
            });
            await page.waitForSelector('.sb-activity .sb-dot');
            await page.click('.sb-activity');
            await page.waitForSelector('.act-pop .act-hist.is-failed');
            assert.match(await page.textContent('.act-pop .act-hist.is-failed .act-hist-result'), /실패 · 권한이 없어요/);
            assert.equal(await page.isVisible('.sb-activity .sb-dot'), false, 'opening the center clears the dot');
            await page.keyboard.press('Escape');
            await page.waitForSelector('.act-pop', { state: 'detached' });
        },
    },
    {
        name: 'settings API + dialog, LRU eviction under the size limit, clearing every cache',
        async run({ openApp, assert }) {
            const seed = { 'empty/': null };
            for (let i = 0; i < 6; i++) seed[`p${i}.png`] = { image: { color: `hsl(${i * 60},70%,45%)`, w: 800, h: 600 } };
            const { page } = await openApp({ seed });
            const schema = await page.evaluate(() => App.thumbs.settings.schema.map((s) => [s.key, s.type, s.default]));
            assert.deepEqual(schema.map((s) => s[0]), ['thumbs.autoPregenerate', 'thumbs.diskCache', 'thumbs.cacheLimitMB']);
            assert.equal(schema[2][2], 1024);
            assert.equal(await page.evaluate(() => App.thumbs.settings.cacheLimitMB), 1024);

            await page.waitForFunction(() => document.querySelectorAll('.card.has-thumb').length === 6, null, { timeout: 20000 });
            await page.evaluate(() => App.thumbs._debug.flush());
            const u0 = await page.evaluate(() => App.thumbs.usage());
            assert.equal(u0.idb.count, 6);
            // Limit to roughly three thumbnails: the oldest ones go
            const limitMB = (u0.idb.bytes / 2 / 1048576).toFixed(6);
            await page.evaluate((mb) => App.settings.set('thumbs.cacheLimitMB', Number(mb)), limitMB);
            await page.waitForFunction(() => {
                const u = App.thumbStore.idb.usage();
                return u.bytes <= u.limit && u.count < 6;
            });

            // Look at an empty folder so nothing on screen asks for thumbnails right after the cache is cleared
            await page.evaluate(() => App.nav.go('empty'));
            await page.waitForFunction(() => App.view.source.path === 'empty');
            await page.evaluate(() => {
                App.commands.run('thumbs.settings');
            });
            await page.waitForSelector('.dialog .thumb-set');
            assert.equal(await page.locator('.dialog .thumb-set-row').count(), 3);
            await page.click('.dialog .thumb-set-row:nth-child(1) .thumb-switch');
            assert.equal(await page.evaluate(() => App.settings.get('thumbs.autoPregenerate')), true);
            await page.selectOption('.dialog .thumb-set-select', '512');
            assert.equal(await page.evaluate(() => App.thumbs.settings.cacheLimitMB), 512);
            await page.waitForFunction(() => /라이브러리 100% 준비/.test(document.querySelector('.thumb-set-usage-text').textContent));
            // Inside the dialog the clear button asks for a second click instead of stacking another dialog
            await page.click('.dialog .thumb-set-clear');
            await page.waitForSelector('.dialog .thumb-set-clear.danger >> text=한 번 더 누르면 비워요');
            await page.click('.dialog .thumb-set-clear');
            await page.waitForSelector('.toast >> text=썸네일 캐시를 비웠어요');
            const u1 = await page.evaluate(() => App.thumbs.usage());
            assert.equal(u1.idb.count, 0);
            assert.equal(u1.disk.count, 0);
            assert.equal(await page.evaluate(() => window.__opfs.exists('.fluid-organizer/thumbs/v2')), false);
            await page.keyboard.press('Escape');
        },
    },
    {
        name: 'rename keeps the thumbnail; main-thread fallback; local server thumbUrl is used directly',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await page.waitForFunction(() => document.querySelectorAll('.card.has-thumb').length >= 3, null, { timeout: 20000 });
            const gen = await page.evaluate(() => App.thumbs.stats().generated);
            await page.evaluate(() => App.fs.rename('red.png', 'renamed.png'));
            await page.waitForFunction(() => !!App.view.get('renamed.png'));
            assert.ok(await page.evaluate(() => App.thumbs.peek(App.view.get('renamed.png'))), 'renamed file keeps its thumbnail');
            await page.waitForSelector('.card[data-path="renamed.png"].has-thumb');
            assert.equal(await page.evaluate(() => App.thumbs.stats().generated), gen);

            await page.evaluate(() => App.thumbs._debug.disableWorkers());
            const n = await page.evaluate(() => App.thumbs.regenerate(['green.jpg']));
            assert.equal(n, 1);
            assert.ok((await page.evaluate(() => App.thumbs.stats().mainThread)) >= 1, 'decoded on the page when workers are unavailable');
            await page.waitForSelector('.card[data-path="green.jpg"].has-thumb');

            const res = await page.evaluate(async () => {
                App.fs.backend.thumbUrl = (e, size) => `/api/thumb?path=${encodeURIComponent(e.path)}&size=${size}`;
                const e = App.view.get('green.jpg');
                const out = { get: await App.thumbs.get(e, { size: 200 }), peek: App.thumbs.peek(e), heic: App.thumbs.canThumb({ kind: 'file', type: 'image', name: 'x.heic', path: 'x.heic' }) };
                delete App.fs.backend.thumbUrl;
                return out;
            });
            assert.deepEqual(res, { get: '/api/thumb?path=green.jpg&size=360', peek: '/api/thumb?path=green.jpg&size=360', heic: true });
        },
    },
    {
        name: 'auto pre-generation runs in the background after a workspace opens (setting on)',
        async run({ openApp, assert, waitIdle }) {
            const { page } = await openApp({
                seed: { ...WARMUP, 'top.png': { image: {} }, 'a/b/c/deep.png': { image: {} }, 'a/clip.webm': { video: { seconds: 1.2 } }, 'z/': { bulk: { count: 40 } } },
                open: false,
            });
            await page.evaluate(() => App.settings.set('thumbs.autoPregenerate', true));
            await pickWorkspace(page, waitIdle);
            await page.waitForFunction(() => App.statusbar.history().some((h) => h.title === '썸네일 미리 만들기' && h.state === 'done'), null, { timeout: 40000 });
            assert.deepEqual(await page.evaluate(() => App.thumbs.coverage()), { total: 43, cached: 43 });
            assert.ok(await page.evaluate(() => App.catalog.peek('a/b/c/deep.png').meta.mv === 1), 'media info read too');
            await page.waitForFunction(() => /썸네일 준비됨/.test(document.querySelector('.sb-cache').textContent));
        },
    },
];
