'use strict';

module.exports = [
    {
        name: 'memocaps: attachment-only entries persist with defaults and no sentinel',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'a.png': { image: { color: '#345' } } } });
            const result = await page.evaluate(async () => {
                App.memoCaps.attach('source.png', { path: 'a.png', at: 1 });
                await App.catalog.flush();
                const stored = JSON.parse(await App.fs.readText('.fluid-organizer/catalog.json'));
                await App.catalog.load();
                return { stored: stored.items['source.png'], caps: App.catalog.get('source.png').memoCaps, empty: App.catalog.get('unknown').memoCaps };
            });
            assert.equal(result.caps.length, 1);
            assert.equal(result.stored.memoCaps.length, 1);
            assert.equal(result.stored.meta, undefined);
            assert.equal(result.empty.length, 0);
            await page.evaluate(() => App.memoCaps.detach('source.png', 'a.png'));
            assert.equal(await page.evaluate(() => App.catalog.peek('source.png')), undefined);
        },
    },
    {
        name: 'memocaps: folder paths and shared attachments follow filesystem undo and restore clashes',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'a.png': { image: { color: '#345' } }, 'caps/c.png': { image: { color: '#567' } }, 'dest/': null } });
            await page.evaluate(async () => {
                App.memoCaps.attach('a.png', { path: 'caps/c.png' });
                App.memoCaps.attach('other.png', { path: 'caps/c.png' }, { piece: 2 });
                await App.fs.rename('caps', 'shots');
                await App.fs.move(['shots'], 'dest');
            });
            await page.waitForFunction(() => App.memoCaps.list('other.png', { piece: 2 })[0]?.path === 'dest/shots/c.png');
            await page.evaluate(() => App.undo.undo());
            await page.waitForFunction(() => App.memoCaps.list('a.png')[0]?.path === 'shots/c.png');
            await page.evaluate(async () => {
                window.__trashIds = await App.fs.trash(['shots/c.png'], { undoable: false, silent: true });
            });
            assert.equal(await page.evaluate(() => App.memoCaps.list('a.png')[0].missing), true);
            await page.evaluate(async () => {
                await App.fs.createFile('shots', 'c.png', await App.fs.getFile('a.png'), { undoable: false });
                await App.fs.restore(window.__trashIds);
            });
            await page.waitForFunction(() => App.memoCaps.list('a.png')[0]?.path === 'shots/c (2).png' && !App.memoCaps.list('a.png')[0].missing);
            assert.equal(await page.evaluate(() => App.memoCaps.list('other.png', { piece: 2 })[0].path), 'shots/c (2).png');
            await page.evaluate(() => App.fs.removePermanently(['shots/c (2).png']));
            assert.equal(await page.evaluate(() => App.memoCaps.list('a.png')[0].missing), true);
        },
    },
    {
        name: 'memocaps: scene tokens restore crop orientation zoom and pan after opening',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'a.png': { image: { w: 2400, h: 1800, color: '#345' } }, 'b.png': { image: { color: '#567' } }, 'caps/c.png': { image: { color: '#678' } } } });
            await page.evaluate(() => App.viewer.open('a.png'));
            await page.waitForFunction(() => App.viewer.view?.path === 'a.png' && App.viewer.view.nat);
            await page.evaluate(() => {
                App.chipsViewer.toggle(true);
                App.memoCaps.attach('a.png', { path: 'caps/c.png' });
                App.catalog.update('a.png', { memo: '[캡처]' }, { undoable: false });
                App.catalog.setMeta('caps/c.png', { capture: { path: 'a.png', crop: { x: 500, y: 600, w: 100, h: 100 }, zoom: 2, rot: 90, flipH: true, flipV: false } });
            });
            await page.waitForSelector('.mc-token');
            await page.evaluate(() => {
                const view = App.viewer.view;
                view.fitToScreen(false);
                document.querySelector('.mc-token').click();
            });
            await page.waitForFunction(() => {
                const v = App.viewer.view;
                return v?.nat && !v.raf && Math.abs(v.scale - 2) < 0.001 && v.angle === 90 && v.sx === -1;
            });
            const result = await page.evaluate(() => {
                const v = App.viewer.view;
                const expected = v.clampPan(2, 90, { tx: (900 - 550) * 2, ty: (1200 - 650) * 2 });
                return Math.abs(v.tx - expected.tx) < 0.01 && Math.abs(v.ty - expected.ty) < 0.01;
            });
            assert.ok(result);
            await page.evaluate(() => App.viewer.open('b.png'));
            await page.waitForFunction(() => App.viewer.view?.path === 'b.png' && App.viewer.view.nat);
            await page.evaluate(() => App.viewer.view.restore({ crop: { x: 0, y: 0, w: 640, h: 480 }, zoom: 100 }));
            await page.waitForFunction(() => !App.viewer.view.raf);
            assert.ok(await page.evaluate(() => {
                const v = App.viewer.view;
                const s = v.stageSize();
                return v.scale * 640 <= s.w + 0.01 && v.scale * 480 <= s.h + 0.01;
            }));
        },
    },
    {
        name: 'memocaps: focused memo captures once while other viewer keys remain blocked',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'a.png': { image: { color: '#345' } } } });
            await page.evaluate(() => App.viewer.open('a.png'));
            await page.waitForFunction(() => App.viewer.view?.nat);
            await page.evaluate(() => App.chipsViewer.toggle(true));
            await page.waitForSelector('.chip-dock-memo-input:not([disabled])');
            await page.evaluate(() => {
                window.__grabs = 0;
                App.capture.available = () => true;
                App.capture.grab = async () => { window.__grabs++; return null; };
                window.__scale = App.viewer.view.scale;
            });
            await page.focus('.chip-dock-memo-input');
            await page.keyboard.press('Control+Shift+C');
            await page.waitForFunction(() => window.__grabs === 1);
            await page.keyboard.press('z');
            await page.keyboard.press('ArrowRight');
            assert.equal(await page.evaluate(() => App.viewer.view.scale), await page.evaluate(() => window.__scale));
            assert.equal(await page.evaluate(() => App.viewer.current.path), 'a.png');
            assert.equal(await page.inputValue('.chip-dock-memo-input'), 'z');
            assert.equal(await page.evaluate(() => window.__grabs), 1);
        },
    },
    {
        name: 'memocaps: capture token and attachment undo together and redo survives a filename clash',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'a.png': { image: { color: '#345' } } } });
            await page.evaluate(() => App.viewer.open('a.png'));
            await page.waitForFunction(() => App.viewer.isOpen && App.viewer.media);
            await page.evaluate(() => App.chipsViewer.toggle(true));
            await page.waitForSelector('.chip-dock-memo-input:not([disabled])');
            await page.evaluate(() => {
                App.capture = {
                    available: () => true,
                    grab: async () => ({ blob: await App.fs.getFile('a.png'), w: 640, h: 480, dir: '_캡처', name: 'a_캡처.png', source: { path: 'a.png', kind: 'image' } }),
                    save: async (shot, options) => {
                        if (options.undoable !== false) throw new Error('combined undo required');
                        const createdDir = !await App.fs.exists(shot.dir);
                        if (createdDir) await App.fs.mkdir('', shot.dir, { undoable: false });
                        const path = await App.fs.createFile(shot.dir, shot.name, shot.blob, { undoable: false });
                        App.catalog.setMeta(path, { capture: shot.source, w: shot.w, h: shot.h });
                        return { path, createdDir };
                    },
                };
                window.__depth = App.undo.list().length;
            });
            await page.click('.chip-dock-memo-input');
            await page.evaluate(() => App.memoCaps.captureToMemo());
            await page.waitForFunction(() => App.catalog.peek('a.png')?.memo === '[캡처]' && App.memoCaps.list('a.png').length === 1);
            assert.equal(await page.evaluate(() => App.undo.list().length - window.__depth), 1);
            await page.evaluate(() => App.undo.undo());
            await page.waitForFunction(() => !App.catalog.peek('a.png')?.memo && App.memoCaps.list('a.png').length === 0);
            assert.equal(await page.evaluate(() => App.fs.exists('_캡처')), false);
            await page.evaluate(async () => {
                await App.fs.mkdir('', '_캡처', { undoable: false });
                await App.fs.createFile('_캡처', 'a_캡처.png', await App.fs.getFile('a.png'), { undoable: false });
                await App.undo.redo();
            });
            await page.waitForFunction(() => App.memoCaps.list('a.png')[0]?.path === '_캡처/a_캡처 (2).png');
            assert.equal(await page.evaluate(() => App.fs.exists(App.memoCaps.list('a.png')[0].path)), true);
        },
    },
    {
        name: 'memocaps: piece attachment persistence, detach undo and lecture export',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'a.png': { image: { color: '#345' } }, '_캡처/a.png': { image: { color: '#567' } } } });
            await page.evaluate(async () => {
                App.memoCaps.attach('a.png', { path: '_캡처/a.png', t: 83 }, { piece: 12 });
                await App.catalog.flush();
            });
            assert.equal(await page.evaluate(() => App.memoCaps.list('a.png').length), 0);
            assert.equal(await page.evaluate(() => App.memoCaps.list('a.png', { piece: 12 })[0].t), 83);
            assert.ok(await page.evaluate(async () => JSON.parse(await App.fs.readText('.fluid-organizer/catalog.json')).items['a.png'].memoCaps.length === 1));
            await page.evaluate(() => App.memoCaps.detach('a.png', '_캡처/a.png', { trash: true }));
            assert.equal(await page.evaluate(() => App.fs.exists('_캡처/a.png')), false);
            await page.evaluate(() => App.undo.undo());
            await page.waitForFunction(() => App.memoCaps.list('a.png', { piece: 12 }).length === 1);
            assert.equal(await page.evaluate(() => App.fs.exists('_캡처/a.png')), true);
            await page.evaluate(() => App.memoCaps.exportFolder(''));
            assert.ok((await page.evaluate(() => App.fs.readText('강의노트.md'))).includes('![캡처 1:23]('));
            await page.evaluate(() => App.undo.undo());
            assert.equal(await page.evaluate(() => App.fs.exists('강의노트.md')), false);
        },
    },
];
