// Viewer team: photos (zoom/pan/rotate/instant open), filmstrip/info/slideshow, video player, markers,
// capture/poster, A-B loop, video editor (with and without the local server), TS helpers.
'use strict';

const PHOTOS = {
    'a-photo.png': { image: { w: 2400, h: 1600, color: '#b33', label: 'A' } },
    'b-photo.jpg': { image: { w: 640, h: 480, color: '#3b3', label: 'B', mime: 'image/jpeg' } },
    'c-photo.png': { image: { w: 800, h: 600, color: '#33b', label: 'C' } },
};

async function openViewer(page, path) {
    await page.evaluate((p) => App.viewer.open(p), path);
    await page.waitForFunction((p) => App.viewer.isOpen && App.viewer.current?.path === p && !!App.viewer.media, path);
}

async function openPhoto(page, path) {
    await openViewer(page, path);
    await page.waitForFunction(() => !!document.querySelector('#viewer img.vw-media') && App.viewer.image && App.viewer.image.full);
    // let any zoom animation settle
    await page.waitForTimeout(260);
}

async function openVideo(page, path) {
    await openViewer(page, path);
    await page.waitForFunction(() => App.viewer.player && App.viewer.player.metaReady && App.viewer.player.duration > 0.5, null, { timeout: 15000 });
    await page.evaluate(() => App.viewer.player.pause());
}

const near = (a, b, eps = 0.12) => Math.abs(a - b) <= eps;

module.exports = [
    {
        name: 'photo zoom: keys, + fallback, wheel, double-click and drag to pan',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: PHOTOS });
            await openPhoto(page, 'a-photo.png');
            const fit = await page.evaluate(() => App.viewer.image.fitScale);
            assert.ok(fit < 1, `a 2400px photo is fitted below 100% (${fit})`);
            assert.ok(await page.evaluate(() => App.viewer.image.fit));
            await page.keyboard.press('z');
            await page.waitForFunction(() => Math.abs(App.viewer.image.scale - 1) < 0.001);
            assert.ok(await page.isVisible('.vw-zoom'), 'zoom control shows in the top bar');
            assert.equal(await page.textContent('.vw-zoom-label'), '100%');
            await page.keyboard.press('0');
            await page.waitForFunction(() => App.viewer.image.fit && Math.abs(App.viewer.image.scale - App.viewer.image.fitScale) < 0.001);
            await page.keyboard.press('=');
            await page.waitForFunction((f) => App.viewer.image.scale > f * 1.05, fit);
            await page.keyboard.press('0');
            await page.waitForFunction(() => App.viewer.image.fit);
            await page.keyboard.press('+'); // Shift+= : handled even though the core parser can't register "+"
            await page.waitForFunction((f) => App.viewer.image.scale > f * 1.05, fit);
            await page.keyboard.press('-');
            await page.keyboard.press('0');
            await page.waitForTimeout(260);

            // Wheel zooms around the cursor
            const box = await page.locator('.vw-stage').boundingBox();
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.wheel(0, -400);
            await page.waitForFunction((f) => App.viewer.image.scale > f * 1.3, fit);

            // Double-click toggles fit <-> 100%
            await page.keyboard.press('0');
            await page.waitForTimeout(260);
            await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
            await page.waitForFunction(() => Math.abs(App.viewer.image.scale - 1) < 0.001);
            assert.ok(await page.evaluate(() => App.viewer.image.pannable));

            // Drag pans (and stays clamped inside the photo)
            const before = await page.evaluate(() => ({ tx: App.viewer.image.tx, ty: App.viewer.image.ty }));
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 + 60, { steps: 6 });
            await page.mouse.up();
            const after = await page.evaluate(() => ({ tx: App.viewer.image.tx, ty: App.viewer.image.ty }));
            assert.ok(after.tx > before.tx + 100, `dragging right pans (${before.tx} -> ${after.tx})`);
            await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
            await page.waitForFunction(() => App.viewer.image.fit && App.viewer.image.tx === 0);
        },
    },
    {
        name: 'photo arrows change file, Space toggles zoom, mouse back button closes',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: PHOTOS });
            await openPhoto(page, 'a-photo.png');
            await page.keyboard.press('ArrowRight');
            await page.waitForFunction(() => App.viewer.current.path === 'b-photo.jpg');
            await page.keyboard.press('PageDown');
            await page.waitForFunction(() => App.viewer.current.path === 'c-photo.png');
            await page.keyboard.press('Control+ArrowLeft');
            await page.waitForFunction(() => App.viewer.current.path === 'b-photo.jpg');
            await page.keyboard.press('End');
            await page.waitForFunction(() => App.viewer.current.path === 'c-photo.png');
            await page.keyboard.press('Home');
            await page.waitForFunction(() => App.viewer.current.path === 'a-photo.png' && App.viewer.image?.entry.path === 'a-photo.png' && App.viewer.image.full);
            await page.keyboard.press('Space');
            await page.waitForFunction(() => Math.abs(App.viewer.image.scale - 1) < 0.001);
            assert.equal(await page.textContent('.vw-counter'), '1 / 3');
            await page.mouse.move(700, 450);
            await page.mouse.down({ button: 'back' }).catch(() => {});
            await page.mouse.up({ button: 'back' }).catch(() => {});
            await page.evaluate(() => document.getElementById('viewer').dispatchEvent(new MouseEvent('mouseup', { button: 3, bubbles: true })));
            await page.waitForSelector('#viewer', { state: 'hidden' });
        },
    },
    {
        name: 'rotation is stored in catalog meta.rot, shown in viewer, filmstrip and gallery card',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: PHOTOS });
            await openPhoto(page, 'b-photo.jpg');
            await page.keyboard.press('r');
            await page.waitForFunction(() => App.catalog.get('b-photo.jpg').meta.rot === 90);
            assert.equal(await page.evaluate(() => App.viewer.rotationOf('b-photo.jpg')), 90);
            await page.waitForTimeout(320);
            assert.ok((await page.evaluate(() => document.querySelector('#viewer img.vw-media').style.transform)).includes('rotate(90deg)'));
            assert.ok(await page.isVisible('.vw-apply-rot'), '"파일에 적용" appears for a rotated JPEG');
            await page.keyboard.press('Shift+R');
            await page.keyboard.press('Shift+R');
            await page.waitForFunction(() => App.catalog.get('b-photo.jpg').meta.rot === 270);
            await page.waitForSelector('.vw-cell.vw-rot-270[data-path="b-photo.jpg"]'); // filmstrip cell follows the rotation
            await page.keyboard.press('r');
            await page.keyboard.press('r');
            await page.waitForFunction(() => App.catalog.get('b-photo.jpg').meta.rot === 90);
            await page.keyboard.press('Escape');
            await page.waitForSelector('#viewer', { state: 'hidden' });
            await page.waitForSelector('.card.vw-rot-90[data-path="b-photo.jpg"]');
            // Batch rotation from the gallery context menu/command
            await page.evaluate(() => App.select.set(['a-photo.png', 'c-photo.png']));
            await page.evaluate(() => App.commands.run('viewer.rotateSelectedCCW'));
            assert.equal(await page.evaluate(() => App.viewer.rotationOf('a-photo.png')), 270);
            assert.equal(await page.evaluate(() => App.viewer.rotationOf('c-photo.png')), 270);
            // back to 0 removes the key
            await page.evaluate(() => App.viewer.setRotation('c-photo.png', 0));
            assert.equal(await page.evaluate(() => 'rot' in (App.catalog.get('c-photo.png').meta || {})), false);
        },
    },
    {
        name: 'apply rotation to file: JPEG lossless via EXIF, PNG re-encoded, original kept in trash, undo',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: PHOTOS });
            const dims = (p) => page.evaluate(async (q) => {
                const f = await App.fs.getFile(q);
                const b = await createImageBitmap(f, { imageOrientation: 'from-image' });
                const out = [b.width, b.height];
                b.close();
                return out;
            }, p);
            const orientation = (p) => page.evaluate(async (q) => (await window.exifr.orientation(await App.fs.getFile(q))) || 1, p);
            const before = await page.evaluate(async () => (await App.fs.getFile('b-photo.jpg')).size);

            await page.evaluate(() => App.viewer.setRotation('b-photo.jpg', 90));
            await openPhoto(page, 'b-photo.jpg');
            await page.click('.vw-apply-rot');
            await page.waitForSelector('.dialog');
            await page.click('.dialog .btn.primary');
            await page.waitForFunction(() => App.viewer.rotationOf('b-photo.jpg') === 0);
            assert.equal(await orientation('b-photo.jpg'), 6, 'EXIF orientation 6 = rotate 90° clockwise');
            assert.deepEqual(await dims('b-photo.jpg'), [480, 640]);
            const after = await page.evaluate(async () => (await App.fs.getFile('b-photo.jpg')).size);
            assert.ok(after - before < 200, `lossless: only a tiny EXIF segment was added (${before} -> ${after})`);
            const trash = await page.evaluate(() => App.fs.listTrash());
            assert.equal(trash.length, 1);
            assert.equal(trash[0].name, 'b-photo (회전 전 원본).jpg');
            assert.equal(trash[0].originalPath, 'b-photo.jpg');
            assert.deepEqual(await page.evaluate(() => [App.catalog.get('b-photo.jpg').meta.w, App.catalog.get('b-photo.jpg').meta.h]), [480, 640]);

            // A second rotation patches the existing tag (6 -> 3)
            await page.evaluate(() => App.viewer.setRotation('b-photo.jpg', 90));
            assert.ok(await page.evaluate(() => App.viewer.rotateFile.apply(App.viewer.current, { ask: false })));
            assert.equal(await orientation('b-photo.jpg'), 3);
            assert.deepEqual(await dims('b-photo.jpg'), [640, 480]);

            // Undo (inside the viewer) restores the previous bytes and the view rotation
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => App.viewer.rotationOf('b-photo.jpg') === 90);
            assert.equal(await orientation('b-photo.jpg'), 6);
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => App.viewer.rotationOf('b-photo.jpg') === 90 && App.fs.listTrash().then((t) => t.length === 0));
            await page.waitForFunction(async () => (await App.fs.listTrash()).length === 0);
            assert.equal(await orientation('b-photo.jpg'), 1);
            assert.equal(await page.evaluate(async () => (await App.fs.getFile('b-photo.jpg')).size), before);
            // Redo applies it again
            await page.keyboard.press('Control+Shift+z');
            await page.waitForFunction(() => App.viewer.rotationOf('b-photo.jpg') === 0);
            assert.equal(await orientation('b-photo.jpg'), 6);

            // PNG: pixels are rotated
            await page.evaluate(() => App.viewer.setRotation('c-photo.png', 270));
            await page.evaluate(() => App.viewer.rotateFile.apply(App.view.get('c-photo.png'), { ask: false }));
            assert.deepEqual(await dims('c-photo.png'), [600, 800]);

            // EXIF block without an Orientation tag: IFD0 is rewritten, other tags survive
            const res = await page.evaluate(async () => {
                const f = await App.fs.getFile('a-photo.png');
                const bmp = await createImageBitmap(f);
                const c = new OffscreenCanvas(64, 48);
                c.getContext('2d').drawImage(bmp, 0, 0, 64, 48);
                const jpg = new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg' })).arrayBuffer());
                // APP1: Exif\0\0 + big-endian TIFF with IFD0 = [Make "Tes" (ASCII, 4 bytes inline)]
                const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x0f, 0, 2, 0, 0, 0, 4, 0x54, 0x65, 0x73, 0, 0, 0, 0, 0];
                const seg = [0xff, 0xe1, 0, 2 + 6 + tiff.length, 0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
                const withExif = new Uint8Array(jpg.length + seg.length);
                withExif.set(jpg.subarray(0, 2), 0);
                withExif.set(seg, 2);
                withExif.set(jpg.subarray(2), 2 + seg.length);
                const out = App.viewer.rotateFile._jpegRotate(withExif, 90);
                const x = await window.exifr.parse(new Blob([out], { type: 'image/jpeg' }), { tiff: true, translateValues: false });
                const b2 = await createImageBitmap(new Blob([out], { type: 'image/jpeg' }), { imageOrientation: 'from-image' });
                const r = { make: x && x.Make, orientation: x && x.Orientation, w: b2.width, h: b2.height };
                b2.close();
                return r;
            });
            assert.deepEqual(res, { make: 'Tes', orientation: 6, w: 48, h: 64 });
            assert.equal(await page.evaluate(() => App.viewer.rotateFile._composeOrientation(8, 90)), 1);
            assert.equal(await page.evaluate(() => App.viewer.rotateFile._composeOrientation(2, 180)), 4);
        },
    },
    {
        name: 'instant open: cached thumbnail first, full image swapped in without a blank frame',
        async run({ openApp, assert }) {
            const { page } = await openApp({
                seed: {
                    'big1.png': { image: { w: 4200, h: 2800, color: '#a52', label: 'BIG 1' } },
                    'big2.png': { image: { w: 4200, h: 2800, color: '#25a', label: 'BIG 2' } },
                    'big3.png': { image: { w: 4200, h: 2800, color: '#2a5', label: 'BIG 3' } },
                },
            });
            await page.waitForFunction(() => ['big1.png', 'big2.png', 'big3.png'].every((p) => App.thumbs.peek(App.view.get(p))), null, { timeout: 20000 });
            await page.evaluate(() => {
                const log = (window.__vwLog = { events: [], blankFrames: 0, frames: 0, started: false });
                new MutationObserver((muts) => {
                    for (const m of muts) {
                        for (const n of m.addedNodes) if (n.tagName === 'IMG') log.events.push(['add', n.className, n.src]);
                        for (const n of m.removedNodes) if (n.tagName === 'IMG') log.events.push(['remove', n.className]);
                    }
                }).observe(document.querySelector('#viewer .vw-stage'), { childList: true, subtree: true });
                const tick = () => {
                    const stage = document.querySelector('#viewer .vw-stage');
                    const has = !!stage && [...stage.querySelectorAll('img')].some((i) => i.isConnected && i.style.width);
                    if (log.started) {
                        log.frames++;
                        if (!has) log.blankFrames++;
                    } else if (has) log.started = true;
                    if (log.frames < 400) requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
            });
            await page.evaluate(() => App.viewer.open('big1.png'));
            await page.waitForFunction(() => document.querySelector('#viewer img.vw-media')?.parentNode && !document.querySelector('#viewer .vw-ph'));
            const events = await page.evaluate(() => window.__vwLog.events);
            const thumb = await page.evaluate(() => App.thumbs.peek(App.view.get('big1.png')));
            assert.ok(events.length >= 2, JSON.stringify(events));
            assert.deepEqual(events[0].slice(0, 1), ['add']);
            assert.ok(events[0][1].includes('vw-ph') && events[0][2] === thumb, `the cached grid thumbnail is painted first: ${JSON.stringify(events[0])}`);
            const fullAt = events.findIndex((e) => e[0] === 'add' && e[1].includes('vw-media'));
            const phGone = events.findIndex((e) => e[0] === 'remove' && e[1].includes('vw-ph'));
            assert.ok(fullAt > 0 && phGone > fullAt, 'placeholder is removed only after the full image is in place');
            // Every step: no blank frame either
            await page.keyboard.press('ArrowRight');
            await page.waitForFunction(() => App.viewer.image?.entry.path === 'big2.png' && App.viewer.image.full);
            await page.keyboard.press('ArrowRight');
            await page.waitForFunction(() => App.viewer.image?.entry.path === 'big3.png' && App.viewer.image.full);
            await page.keyboard.press('ArrowLeft');
            await page.waitForFunction(() => App.viewer.image?.entry.path === 'big2.png' && App.viewer.image.full);
            await page.waitForTimeout(150);
            const log = await page.evaluate(() => ({ blank: window.__vwLog.blankFrames, frames: window.__vwLog.frames }));
            assert.ok(log.frames > 5, 'frames were sampled');
            assert.equal(log.blank, 0, `no frame without a picture (${log.blank}/${log.frames})`);
        },
    },
    {
        name: 'filmstrip, info overlay and slideshow',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: PHOTOS });
            await openPhoto(page, 'a-photo.png');
            await page.waitForSelector('.vw-strip .vw-cell[data-path="c-photo.png"]');
            assert.ok(await page.isVisible('.vw-cell.is-current[data-path="a-photo.png"]'));
            await page.click('.vw-cell[data-path="c-photo.png"]');
            await page.waitForFunction(() => App.viewer.current.path === 'c-photo.png');
            await page.keyboard.press('t');
            await page.waitForSelector('.vw-strip', { state: 'hidden' });
            assert.equal(await page.evaluate(() => App.settings.get('viewer.filmstrip')), false);
            await page.keyboard.press('t');
            await page.waitForSelector('.vw-strip', { state: 'visible' });

            await page.keyboard.press('i');
            await page.waitForSelector('.vw-info:not([hidden])');
            const info = await page.textContent('.vw-info');
            assert.ok(info.includes('c-photo.png') && info.includes('800 × 600'), info);
            await page.waitForFunction(() => App.catalog.peek('c-photo.png')?.meta?.exifAt, null, { timeout: 5000 });
            await page.keyboard.press('i');
            await page.waitForSelector('.vw-info', { state: 'hidden' });

            await page.evaluate(() => App.viewer.slideshow.setInterval(1));
            await page.keyboard.press('s');
            assert.ok(await page.evaluate(() => App.viewer.slideshow.running));
            await page.waitForSelector('.vw-show-hud:not([hidden])');
            await page.keyboard.press('=');
            assert.equal(await page.evaluate(() => App.viewer.slideshow.interval), 2);
            await page.keyboard.press('-');
            assert.equal(await page.evaluate(() => App.viewer.slideshow.interval), 1);
            await page.waitForFunction(() => App.viewer.current.path === 'a-photo.png', null, { timeout: 4000 }); // loops around
            await page.keyboard.press('Space');
            assert.ok(await page.evaluate(() => App.viewer.slideshow.paused));
            await page.keyboard.press('Space');
            await page.keyboard.press('s');
            assert.equal(await page.evaluate(() => App.viewer.slideshow.running), false);
            await page.waitForSelector('.vw-show-hud', { state: 'hidden' });
        },
    },
    {
        name: 'video player: custom controls, seek step, Ctrl+arrows change file, frames, speed, volume memory',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'a-clip.webm': { video: { seconds: 3 } }, 'b-photo.png': { image: {} } } });
            await openVideo(page, 'a-clip.webm');
            assert.equal(await page.evaluate(() => App.viewer.media.hasAttribute('controls')), false, 'no native controls');
            assert.ok(await page.isVisible('.vw-ctl'));
            const d = await page.evaluate(() => App.viewer.player.duration);
            assert.ok(d > 2 && d < 4, `MediaRecorder WebM gets a real duration (${d})`);

            await page.evaluate(() => App.settings.set('viewer.seekStep', 1));
            await page.evaluate(() => App.viewer.player.seek(0.5));
            await page.keyboard.press('ArrowRight');
            await page.waitForFunction(() => Math.abs(App.viewer.player.time - 1.5) < 0.12);
            await page.keyboard.press('ArrowLeft');
            await page.waitForFunction(() => Math.abs(App.viewer.player.time - 0.5) < 0.12);
            assert.ok((await page.textContent('.vw-hints')).includes('1초'), 'hint row shows the seek step');

            await page.keyboard.press('.');
            await page.waitForFunction(() => App.viewer.player.time > 0.5 && App.viewer.player.time < 0.62);
            assert.ok(!(await page.evaluate(() => App.viewer.player.playing)));
            await page.keyboard.press(',');
            await page.waitForFunction(() => Math.abs(App.viewer.player.time - 0.5) < 0.05);

            await page.keyboard.press(']');
            assert.equal(await page.evaluate(() => App.viewer.player.rate), 1.25);
            await page.keyboard.press('[');
            await page.keyboard.press('[');
            assert.equal(await page.evaluate(() => App.viewer.player.rate), 0.75);
            await page.keyboard.press('l');
            await page.waitForFunction(() => App.viewer.player.playing && App.viewer.player.rate === 1);
            await page.keyboard.press('l');
            assert.equal(await page.evaluate(() => App.viewer.player.rate), 1.5);
            await page.keyboard.press('k');
            await page.waitForFunction(() => !App.viewer.player.playing);
            await page.evaluate(() => App.viewer.player.seek(2.4));
            await page.keyboard.press('j');
            assert.ok(await page.evaluate(() => App.viewer.player.reverseRate === 1));
            await page.keyboard.press('k');
            await page.waitForFunction(() => !App.viewer.player.playing && App.viewer.player.reverseRate === 0);
            await page.keyboard.press('Space');
            await page.waitForFunction(() => App.viewer.player.playing);
            await page.keyboard.press('Space');
            await page.waitForFunction(() => !App.viewer.player.playing);

            await page.keyboard.press('m');
            assert.equal(await page.evaluate(() => App.viewer.player.video.muted), true);
            await page.keyboard.press('m');
            await page.evaluate(() => App.viewer.player.setVolume(0.6));
            await page.keyboard.press('ArrowDown');
            await page.waitForFunction(() => Math.abs(App.settings.get('viewer.volume') - 0.55) < 0.001);
            assert.equal(await page.evaluate(() => App.settings.get('viewer.muted')), false);

            await page.keyboard.press('Control+ArrowRight');
            await page.waitForFunction(() => App.viewer.current.path === 'b-photo.png');
            await page.keyboard.press('PageUp');
            await page.waitForFunction(() => App.viewer.player && App.viewer.player.metaReady);
            assert.ok(near(await page.evaluate(() => App.viewer.player.video.volume), 0.55, 0.001), 'volume is remembered');
            await page.keyboard.press('Escape');
            await page.waitForSelector('#viewer', { state: 'hidden' });
        },
    },
    {
        name: 'markers: B adds one at the current time with a title, seek-bar ticks, list panel, jump, delete + undo',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'clip.webm': { video: { seconds: 3 } } } });
            await openVideo(page, 'clip.webm');
            await page.evaluate(() => App.viewer.player.seek(1));
            await page.keyboard.press('b');
            await page.waitForSelector('.vw-mk-pop .vw-mk-title');
            await page.waitForFunction(() => document.activeElement?.classList.contains('vw-mk-title'));
            await page.keyboard.type('하이라이트');
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => App.catalog.get('clip.webm').markers[0]?.title === '하이라이트');
            const m = await page.evaluate(() => App.catalog.get('clip.webm').markers[0]);
            assert.ok(near(m.t, 1, 0.08), `marker at the current time (${m.t})`);
            assert.equal(await page.locator('.vw-mark').count(), 1);

            await page.evaluate(() => App.viewer.player.seek(2.2));
            await page.keyboard.press('b');
            await page.waitForSelector('.vw-mk-pop');
            await page.keyboard.press('Escape'); // keep it without a title
            await page.waitForFunction(() => App.catalog.get('clip.webm').markers.length === 2);
            assert.ok(await page.evaluate(() => App.viewer.isOpen), 'Esc only closed the popover');

            await page.keyboard.press('Shift+ArrowLeft');
            await page.waitForFunction(() => Math.abs(App.viewer.player.time - 1) < 0.1);
            await page.keyboard.press('Shift+ArrowRight');
            await page.waitForFunction(() => Math.abs(App.viewer.player.time - 2.2) < 0.1);

            await page.keyboard.press('Shift+B');
            await page.waitForSelector('.vw-dock .vw-mk-row');
            assert.equal(await page.locator('.vw-mk-row').count(), 2);
            await page.click('.vw-mk-row:first-child .vw-mk-name');
            await page.waitForFunction(() => Math.abs(App.viewer.player.time - 1) < 0.1);
            await page.hover('.vw-mk-row:first-child');
            await page.click('.vw-mk-row:first-child .vw-mk-actions button[aria-label="삭제"]');
            await page.waitForFunction(() => App.catalog.get('clip.webm').markers.length === 1);
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => App.catalog.get('clip.webm').markers.length === 2);
            assert.equal(await page.evaluate(() => App.catalog.get('clip.webm').markers[0].title), '하이라이트');
            await page.keyboard.press('Escape'); // closes the panel first
            assert.ok(await page.evaluate(() => App.viewer.isOpen && !App.viewer.isPanelOpen()));
        },
    },
    {
        name: 'scene capture saves <stem>_frame_<mm>m<ss>s.jpg next to the video; Shift+C sets the poster frame',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'trip/clip.webm': { video: { seconds: 2 } } } });
            await page.evaluate(() => App.nav.go('trip'));
            await page.waitForFunction(() => App.view.get('trip/clip.webm'));
            await openVideo(page, 'trip/clip.webm');
            await page.evaluate(() => App.viewer.player.seek(1.3));
            await page.waitForTimeout(150);
            await page.keyboard.press('c');
            await page.waitForSelector('.toast:has-text("장면을 저장했어요")'); // shown once the file is written
            assert.ok(await page.evaluate(() => window.__opfs.exists('trip/clip_frame_00m01s.jpg')));
            const size = await page.evaluate(async () => {
                const b = await createImageBitmap(await App.fs.getFile('trip/clip_frame_00m01s.jpg'));
                return [b.width, b.height];
            });
            assert.deepEqual(size, [320, 240]);
            assert.deepEqual(await page.evaluate(() => App.catalog.peek('trip/clip_frame_00m01s.jpg')?.meta?.source?.path), 'trip/clip.webm');
            // the capture joins the viewer's list and the gallery
            await page.waitForFunction(() => App.viewer.files.some((f) => f.path === 'trip/clip_frame_00m01s.jpg'));
            await page.keyboard.press('Shift+C');
            await page.waitForFunction(() => App.catalog.get('trip/clip.webm').meta.posterT != null);
            assert.ok(near(await page.evaluate(() => App.catalog.get('trip/clip.webm').meta.posterT), 1.3, 0.1));
            await page.waitForSelector('.toast:has-text("대표 장면으로 정했어요")');
            await page.click('.toast:has-text("장면을 저장했어요") .toast-action');
            await page.waitForFunction(() => App.viewer.current?.path === 'trip/clip_frame_00m01s.jpg' && App.viewer.image?.full);
        },
    },
    {
        name: 'A-B loop keeps playback inside the range',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'clip.webm': { video: { seconds: 3 } } } });
            await openVideo(page, 'clip.webm');
            await page.evaluate(() => App.viewer.player.seek(0.4));
            await page.keyboard.press('a');
            await page.evaluate(() => App.viewer.player.seek(1.1));
            await page.keyboard.press('a');
            assert.deepEqual(await page.evaluate(() => [App.viewer.player.loopA, App.viewer.player.loopB].map((x) => Math.round(x * 10) / 10)), [0.4, 1.1]);
            assert.equal(await page.locator('.vw-range.is-loop').count(), 1);
            await page.evaluate(() => App.viewer.player.play());
            const samples = [];
            for (let i = 0; i < 12; i++) {
                await page.waitForTimeout(110);
                samples.push(await page.evaluate(() => App.viewer.player.time));
            }
            assert.ok(samples.every((t) => t >= 0.3 && t <= 1.25), `stays in [A, B]: ${samples.map((t) => t.toFixed(2)).join(', ')}`);
            await page.keyboard.press('a');
            assert.equal(await page.evaluate(() => App.viewer.player.loopA), null);
        },
    },
    {
        name: 'video editor: in/out, segments, reorder, delete; server actions stay disabled without the server',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'clip.webm': { video: { seconds: 3 } } } });
            await openVideo(page, 'clip.webm');
            await page.keyboard.press('e');
            await page.waitForSelector('.vw-dock .ve-sec');
            assert.ok(await page.isVisible('.ve-server'), 'explains that the local server is needed');
            assert.ok(await page.isDisabled('.ve-actions .btn.primary'));
            // I is "in point" while the editor is open (info overlay otherwise)
            const mark = async (t, key) => {
                await page.evaluate((x) => App.viewer.player.seek(x), t);
                await page.waitForFunction((x) => Math.abs(App.viewer.player.time - x) < 0.05, t);
                await page.keyboard.press(key);
            };
            await mark(0.4, 'i');
            await mark(1.4, 'o');
            assert.ok(await page.evaluate(() => !App.settings.get('viewer.info', false)), 'I did not toggle the info overlay');
            await page.keyboard.press('Enter');
            await mark(2.0, 'i');
            await mark(2.6, 'o');
            await page.keyboard.press('Enter');
            const segs = () => page.evaluate(() => App.videoEditor.segments.map((s) => [Math.round(s.start * 10) / 10, Math.round(s.end * 10) / 10]));
            assert.deepEqual(await segs(), [[0.4, 1.4], [2, 2.6]]);
            assert.equal(await page.locator('.ve-seg').count(), 2);
            assert.ok(await page.locator('.vw-range.is-segment, .vw-range.is-active').count() >= 2, 'segments are drawn on the seek bar');
            await page.focus('.ve-seg:nth-child(2)');
            await page.keyboard.press('Alt+ArrowUp');
            assert.deepEqual(await segs(), [[2, 2.6], [0.4, 1.4]]);
            // drag the grip back down
            const g = await page.locator('.ve-seg:nth-child(1) .ve-grip').boundingBox();
            await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
            await page.mouse.down();
            await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 + 50, { steps: 5 });
            await page.mouse.up();
            assert.deepEqual(await segs(), [[0.4, 1.4], [2, 2.6]]);
            await page.click('.ve-seg:nth-child(2) button[aria-label="목록에서 빼기"]');
            assert.deepEqual(await segs(), [[0.4, 1.4]]);
            await page.click('.toast-action:has-text("되돌리기")');
            assert.equal((await segs()).length, 2);
            // Shift+I jumps to the in point, Alt+X clears marks
            await mark(0.8, 'i');
            await page.evaluate(() => App.viewer.player.seek(2.5));
            await page.keyboard.press('Shift+I');
            await page.waitForFunction(() => Math.abs(App.viewer.player.time - 0.8) < 0.06);
            await page.keyboard.press('Alt+x');
            assert.equal(await page.evaluate(() => App.videoEditor.marksFor('clip.webm').in), null);
            await page.keyboard.press('e');
            await page.waitForSelector('.vw-dock', { state: 'hidden' });
            await page.keyboard.press('i');
            await page.waitForSelector('.vw-info:not([hidden])');
        },
    },
    {
        name: 'video editor talks to App.server.video.* when the server is there (trim, concat via job, transform)',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'clip.webm': { video: { seconds: 2 } } } });
            await openVideo(page, 'clip.webm');
            await page.evaluate(() => {
                window.__calls = [];
                App.server = {
                    available: true,
                    capabilities: { ffmpeg: true },
                    video: {
                        trim: async (b) => (window.__calls.push(['trim', b]), { path: 'clip_cut01.webm' }),
                        concat: async (b) => (window.__calls.push(['concat', b]), { id: 'job1', state: 'running' }),
                        transform: async (b) => (window.__calls.push(['transform', b]), { result: { path: 'clip_rot.webm' } }),
                    },
                    waitJob: async (id, onProgress) => {
                        onProgress({ progress: 0.5 });
                        return { id, state: 'done', result: { path: 'clip_merged01.mp4' } };
                    },
                };
                App.fs.backend.kind = 'server';
            });
            await page.keyboard.press('e');
            await page.waitForSelector('.vw-dock .ve-sec');
            assert.equal(await page.locator('.ve-server').count(), 0);
            const seg = async (a, b) => {
                await page.evaluate((x) => App.viewer.player.seek(x), a);
                await page.waitForFunction((x) => Math.abs(App.viewer.player.time - x) < 0.05, a);
                await page.keyboard.press('i');
                await page.evaluate((x) => App.viewer.player.seek(x), b);
                await page.waitForFunction((x) => Math.abs(App.viewer.player.time - x) < 0.05, b);
                await page.keyboard.press('o');
                await page.keyboard.press('Enter');
            };
            await seg(0.2, 0.9);
            await page.click('.ve-mode button:has-text("정확하게")');
            await page.click('.ve-actions .btn.primary');
            await page.waitForSelector('.toast:has-text("잘라낸 영상을 저장했어요")');
            await seg(1.0, 1.6);
            await page.click('.ve-actions .btn:has-text("구간 합치기")');
            await page.waitForSelector('.toast:has-text("합친 영상을 저장했어요")');
            await page.click('.ve-op:has-text("좌우")');
            await page.click('.ve-sec .btn:has-text("적용")');
            await page.waitForSelector('.toast:has-text("회전한 영상을 저장했어요")');
            const calls = await page.evaluate(() => window.__calls);
            assert.equal(calls[0][0], 'trim');
            assert.deepEqual({ ...calls[0][1], start: Math.round(calls[0][1].start * 10) / 10, end: Math.round(calls[0][1].end * 10) / 10 }, { path: 'clip.webm', start: 0.2, end: 0.9, mode: 'accurate' });
            assert.equal(calls[1][0], 'concat');
            assert.deepEqual(calls[1][1].segments.map((s) => [s.path, Math.round(s.start * 10) / 10]), [['clip.webm', 0.2], ['clip.webm', 1]]);
            assert.deepEqual(calls[2], ['transform', { path: 'clip.webm', op: 'hflip', mode: 'reencode' }]);
            await page.evaluate(() => {
                App.fs.backend.kind = 'browser';
                delete App.server;
            });
        },
    },
    {
        name: 'unsupported formats: friendly card, "서버로 재생" only when the server can stream',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'old.avi': { bytes: [1, 2, 3, 4] }, 'scan.heic': { bytes: [5, 6, 7] }, 'z.png': { image: {} } } });
            await openViewer(page, 'old.avi');
            await page.waitForSelector('.vw-card');
            assert.ok((await page.textContent('.vw-card')).includes('AVI 영상은 브라우저에서 바로 재생할 수 없어요'));
            assert.equal(await page.locator('.vw-card button:has-text("서버로 재생")').count(), 0);
            assert.ok(await page.isHidden('.vw-ctl'), 'no player controls for a file that cannot play');
            await page.evaluate(() => {
                App.server = { available: true };
                App.fs.backend.kind = 'server';
            });
            await page.keyboard.press('ArrowRight');
            await page.waitForFunction(() => App.viewer.current.path === 'scan.heic');
            await page.waitForSelector('.vw-card:has-text("HEIC 사진은")');
            await page.keyboard.press('ArrowLeft');
            await page.waitForSelector('.vw-card button:has-text("서버로 재생")');
            await page.evaluate(() => {
                App.fs.backend.kind = 'browser';
                delete App.server;
            });
        },
    },
    {
        name: 'TS helpers: video PTS scan (188/192-byte packets) gives the duration',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: {} });
            const out = await page.evaluate(async () => {
                function pes(pts, sid, pusi = true) {
                    const p = new Uint8Array(188).fill(0xff);
                    p[0] = 0x47;
                    p[1] = (pusi ? 0x40 : 0) | 0x01;
                    p[2] = sid === 0xe0 ? 0x00 : 0x01;
                    p[3] = 0x10;
                    if (!pusi) return p;
                    p.set([0, 0, 1, sid, 0, 0, 0x80, 0x80, 5], 4);
                    const b = 13;
                    p[b] = 0x21 | ((Math.floor(pts / 2 ** 30) & 0x07) << 1);
                    p[b + 1] = Math.floor(pts / 2 ** 22) & 0xff;
                    p[b + 2] = ((Math.floor(pts / 2 ** 15) & 0x7f) << 1) | 1;
                    p[b + 3] = Math.floor(pts / 2 ** 7) & 0xff;
                    p[b + 4] = ((pts % 128) << 1) | 1;
                    return p;
                }
                const start = 900000 + 2 ** 32; // above 32 bits: exercises the 33rd bit
                const packets = [pes(0, 0xc0), pes(start, 0xe0), pes(0, 0xe0, false), pes(start + 45000, 0xe0), pes(start + 1125000, 0xe0), pes(5, 0xc0)];
                const ts = new Uint8Array(packets.length * 188);
                packets.forEach((p, i) => ts.set(p, i * 188));
                const m2ts = new Uint8Array(packets.length * 192);
                packets.forEach((p, i) => m2ts.set(p, i * 192 + 4));
                const a = App.viewer.ts._scanPts(ts, { last: true });
                const b = App.viewer.ts._scanPts(m2ts, { last: true });
                const probe = await App.viewer.ts.probe(new File([ts], 'x.ts'));
                return { a, b, start, duration: probe.duration, isTs: [App.viewer.ts.isTs({ ext: 'm2ts' }), App.viewer.ts.isTs({ ext: 'mp4' })] };
            });
            assert.deepEqual(out.a, { first: out.start, last: out.start + 1125000 });
            assert.deepEqual(out.b, out.a);
            assert.equal(out.duration, 12.5);
            assert.deepEqual(out.isTs, [true, false]);
        },
    },
    {
        name: 'viewer list follows the folder: delete in the viewer, undo brings the file back',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: PHOTOS });
            await openPhoto(page, 'b-photo.jpg');
            await page.keyboard.press('Delete');
            await page.waitForFunction(() => App.viewer.current?.path === 'c-photo.png');
            await page.waitForFunction(() => document.querySelector('.vw-counter').textContent === '2 / 2');
            assert.ok(!(await page.evaluate(() => window.__opfs.exists('b-photo.jpg'))));
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => App.viewer.files.some((f) => f.path === 'b-photo.jpg'));
            await page.waitForFunction(() => document.querySelector('.vw-counter').textContent === '3 / 3');
            assert.equal(await page.evaluate(() => App.viewer.current.path), 'c-photo.png', 'stays on the file you were looking at');
            // the viewer's own commands are listed for the palette with Korean titles
            const cmds = await page.evaluate(() => App.commands.list().filter((c) => c.scope === 'viewer').map((c) => [c.id, c.title, c.keys.some((k) => !k)]));
            for (const id of ['viewer.zoom100', 'viewer.setPoster', 'video.capture', 'video.marker', 'video.editor', 'video.markIn', 'viewer.slideshow']) {
                assert.ok(cmds.some((c) => c[0] === id && /[가-힣]/.test(c[1])), `${id} is registered`);
            }
            assert.deepEqual(cmds.filter((c) => c[2]).map((c) => c[0]), [], 'no empty key combos');
        },
    },
];
