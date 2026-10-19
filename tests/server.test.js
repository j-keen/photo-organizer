/* Real Python server integration. Every own browser is checked for console and native-dialog errors. */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { pathToFileURL } = require('url');
const execute = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function python(root) {
    return [process.env.FI_PYTHON, path.join(root, 'server', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
        'C:\\Users\\330jk\\orca\\_tools\\pyprobe\\Scripts\\python.exe'].find((candidate) => candidate && fs.existsSync(candidate));
}
async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
}
function health(port) {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 700 }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => { try { resolve(res.statusCode === 200 && JSON.parse(text).app === 'fluid-identity'); } catch (_) { resolve(false); } });
            res.on('error', () => resolve(false));
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve(false));
    });
}
// Minimal API call from Node (same headers the app sends): used to stop the server gracefully.
function apiCall(port, method, urlPath, { cookie, body } = {}) {
    return new Promise((resolve, reject) => {
        const headers = { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' };
        if (cookie) headers.Cookie = cookie;
        if (method !== 'GET') Object.assign(headers, { 'X-FI-Client': '1', 'Content-Type': 'application/json' });
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers, timeout: 3000 }, (res) => {
            res.resume();
            res.on('end', () => resolve(res));
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end(body ? JSON.stringify(body) : undefined);
    });
}
function removeTemp(dir) {
    // The server may need a moment to release hashes.sqlite after exiting
    try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 150 });
    } catch (e) {
        console.log(`    note: could not remove ${dir} (${e.code})`);
    }
}
async function startPy({ py, root, port, dataDir, env = {} }) {
    const child = spawn(py, ['-m', 'server', '--port', String(port)], {
        cwd: root, env: { ...process.env, FI_DATA_DIR: dataDir, FI_DRY_SHELL: '1', PYTHONIOENCODING: 'utf-8', ...env }, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let spawnError;
    let exited = false;
    const exit = new Promise((resolve) => { child.once('exit', () => { exited = true; resolve(); }); child.once('error', (err) => { spawnError = err; exited = true; resolve(); }); });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output = (output + chunk.toString()).slice(-12000); });
    async function stop() {
        if (exited) return;
        // Graceful first (closes hashes.sqlite and stops ffmpeg), then force.
        try {
            const session = await apiCall(port, 'GET', '/api/session');
            const cookie = String(session.headers['set-cookie'] || '').split(';')[0];
            await apiCall(port, 'POST', '/api/server/shutdown', { cookie, body: {} });
            await Promise.race([exit, delay(5000)]);
        } catch (e) {
            /* fall through to kill */
        }
        if (!exited) {
            child.kill();
            await Promise.race([exit, delay(4000)]);
        }
    }
    try {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            if (spawnError) throw spawnError;
            if (exited) throw new Error('Python server exited:\n' + output);
            if (await health(port)) return { stop };
            await delay(120);
        }
        throw new Error('Python server did not become ready:\n' + output);
    } catch (err) { await stop(); throw err; }
}
async function fixtures(py, root, kind) {
    const script = [
        'import os, sys, subprocess',
        'from PIL import Image',
        'import pillow_heif, imageio_ffmpeg',
        'root, kind = sys.argv[1:]',
        'pillow_heif.register_heif_opener()',
        'os.makedirs(os.path.join(root, "trip"), exist_ok=True)',
        'Image.new("RGB", (480,320), "coral").save(os.path.join(root,"a.jpg"))',
        'Image.new("RGB", (320,240), "navy").save(os.path.join(root,"b.tif"))',
        'Image.new("RGB", (320,240), "teal").save(os.path.join(root,"trip","beach.png"))',
        'Image.new("RGB", (64,48), "green").save(os.path.join(root,"sample.heic")) if kind == "heic" else None',
        'open(os.path.join(root,"notes.txt"),"w").write("not media")',
        'ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()',
        'flags = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}',
        'def run(args):',
        '    subprocess.run([ffmpeg,"-hide_banner","-loglevel","error","-y"] + args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **flags)',
        'if kind == "avi":',
        '    run(["-f","lavfi","-i","testsrc=duration=2:size=320x240:rate=25","-c:v","mpeg4",os.path.join(root,"c.avi")])',
        'if kind in ("mp4", "dupes"):',
        '    run(["-f","lavfi","-i","testsrc=duration=3:size=320x240:rate=25","-f","lavfi","-i","sine=frequency=440:duration=3","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac","-shortest",os.path.join(root,"clip.mp4")])',
        'if kind == "dupes":',
        '    import shutil',
        '    shutil.copy2(os.path.join(root, "clip.mp4"), os.path.join(root, "copy.mp4"))',
        '    ext = os.path.join(os.path.dirname(root), "외부 영상")',
        '    os.makedirs(ext, exist_ok=True)',
        '    shutil.copy2(os.path.join(root, "clip.mp4"), os.path.join(ext, "clip (1).mp4"))',
    ].join('\n');
    await execute(py, ['-c', script, root, kind], { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
}
function collect(page) {
    const errors = [];
    page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));
    page.on('console', (message) => {
        if (message.type() === 'error' && !/pretendard|favicon|net::ERR_/i.test(message.text())) errors.push('console: ' + message.text());
    });
    page.on('dialog', (dialog) => { errors.push('native dialog: ' + dialog.type()); dialog.dismiss().catch(() => {}); });
    // Name the request behind "Failed to load resource" console errors
    page.on('response', (r) => {
        if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push(`http ${r.status()} ${r.request().method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`);
    });
    return errors;
}
async function withServer(h, kind, run, picker = false) {
    const py = python(h.ROOT);
    if (!py) { console.log('    skip: Python environment is unavailable'); return; }
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-client-'));
    const root = path.join(temp, '사진 작업');
    fs.mkdirSync(root);
    let server;
    let browser;
    try {
        await fixtures(py, root, kind);
        const port = await freePort();
        server = await startPy({ py, root: h.ROOT, port, dataDir: path.join(temp, 'data'), env: picker ? { FI_PICK_RESULT: typeof picker === 'function' ? picker({ temp, root }) : root } : {} });
        browser = await h.launchBrowser();
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        const errors = collect(page);
        await page.goto(`http://127.0.0.1:${port}/`);
        await page.waitForFunction(() => window.App?.server?.state === 'connected');
        await run({ page, root, port, temp, py, errors });
        h.assert.deepEqual(errors, [], 'browser must remain quiet');
    } finally {
        if (browser) await browser.close();
        if (server) await server.stop();
        removeTemp(temp);
    }
}
async function open(page, root) {
    await page.evaluate((value) => App.server.openRoot(value), root);
    await page.waitForFunction(() => App.fs.backend?.kind === 'server' && App.state.cwd === '' && App.view.source.type === 'folder');
}
module.exports = [
    {
        name: 'server: workspace opens through the server backend and thumbnails come from /api/thumb',
        async run(h) {
            await withServer(h, 'avi', async ({ page, root }) => {
                const requests = new Set();
                page.on('request', (req) => { const url = new URL(req.url()); if (url.pathname === '/api/thumb') requests.add(url.searchParams.get('path')); });
                await open(page, root);
                h.assert.deepEqual(await page.evaluate(() => App.view.visible.map((entry) => entry.name)), ['trip', 'a.jpg', 'b.tif', 'c.avi']);
                await page.waitForFunction(() => document.querySelectorAll('.card.has-thumb').length >= 3, null, { timeout: 15000 });
                for (const name of ['a.jpg', 'b.tif', 'c.avi']) h.assert.ok(requests.has(name), name + ' must use the server thumbnail endpoint');
                h.assert.ok(await page.locator('.srv-status[data-state="connected"]').isVisible());
            });
        },
    },
    {
        name: 'server: rename, trash and undo through the server backend',
        async run(h) {
            await withServer(h, 'image', async ({ page, root }) => {
                await open(page, root);
                await page.locator('.card[data-path="a.jpg"]').click();
                await page.keyboard.press('F2');
                await page.locator('.dialog .input').fill('renamed.jpg');
                await page.keyboard.press('Enter');
                await page.waitForFunction(() => !!App.view.get('renamed.jpg'));
                h.assert.ok(fs.existsSync(path.join(root, 'renamed.jpg')));
                h.assert.ok(!fs.existsSync(path.join(root, 'a.jpg')));
                await page.keyboard.press('Delete');
                await page.waitForFunction(() => !App.view.get('renamed.jpg'));
                h.assert.ok(!fs.existsSync(path.join(root, 'renamed.jpg')));
                const items = await page.evaluate(() => App.fs.listTrash());
                h.assert.equal(items.length, 1);
                h.assert.ok(fs.existsSync(path.join(root, ...items[0].trashPath.split('/'))));
                await page.keyboard.press('Control+z');
                await page.waitForFunction(() => !!App.view.get('renamed.jpg'));
                h.assert.ok(fs.existsSync(path.join(root, 'renamed.jpg')));
            });
        },
    },
    {
        name: 'server: chooser opens recents and the folder picker',
        async run(h) {
            await withServer(h, 'image', async ({ page, root }) => {
                await open(page, root);
                await page.reload();
                await page.waitForFunction(() => App.fs.backend?.kind === 'server' && App.state.cwd === '');
                await page.evaluate(() => App.workspace.close());
                await page.getByRole('button', { name: '작업 폴더 열기', exact: true }).click();
                await page.waitForSelector('.srv-chooser .srv-recent');
                h.assert.ok((await page.locator('.srv-chooser').innerText()).includes(root));
                await page.getByRole('button', { name: '폴더 찾아보기…', exact: true }).click();
                await page.waitForFunction(() => App.fs.backend?.kind === 'server' && App.state.cwd === '' && !document.querySelector('.srv-chooser'));
                h.assert.equal(await page.evaluate(() => App.fs.backend.root), root);
            }, true);
        },
    },
    {
        name: 'server: video tools create files and undo moves them to the trash',
        async run(h) {
            await withServer(h, 'mp4', async ({ page, root }) => {
                await open(page, root);
                const output = await page.evaluate(() => App.server.video.trim('clip.mp4', .5, 2, { mode: 'accurate' }));
                h.assert.equal(output, 'clip_cut01.mp4');
                h.assert.ok(fs.existsSync(path.join(root, output)));
                await page.waitForFunction((value) => !!App.view.get(value), output);
                const frame = await page.evaluate(() => App.server.video.frame('clip.mp4', 1, { format: 'jpg' }));
                h.assert.ok(frame.endsWith('.jpg'));
                h.assert.ok(fs.existsSync(path.join(root, frame)));
                await page.evaluate(() => App.undo.undo());
                h.assert.ok(!fs.existsSync(path.join(root, frame)));
                const items = await page.evaluate(() => App.fs.listTrash());
                const item = items.find((value) => value.originalPath === frame);
                h.assert.ok(item);
                h.assert.ok(fs.existsSync(path.join(root, ...item.trashPath.split('/'))));
                await page.evaluate(() => App.undo.redo());
                h.assert.ok(fs.existsSync(path.join(root, frame)));

                // Raw style (used by the viewer's editor): POST returns the job, the caller waits with progress
                const raw = await page.evaluate(async () => {
                    const job = await App.server.video.trim({ path: 'clip.mp4', start: 0.5, end: 1.5, mode: 'fast' });
                    const seen = [];
                    const result = await App.server.waitJob(job.id, (p) => seen.push(p));
                    return { state: job.state, result, seen: seen.every((p) => typeof p === 'number') };
                });
                h.assert.equal(raw.state, 'running');
                h.assert.equal(raw.result.path, 'clip_cut02.mp4');
                h.assert.ok(raw.seen);

                // In-place rotation keeps the name and the catalog data; the original waits in the app trash (one undo step)
                await page.evaluate(() => App.catalog.update('clip.mp4', { rating: 4 }, { undoable: false }));
                const rotated = await page.evaluate(() => App.server.video.transform('clip.mp4', 'rotate90', { mode: 'metadata', inPlace: true }));
                h.assert.equal(rotated, 'clip.mp4');
                h.assert.equal(await page.evaluate(() => App.catalog.get('clip.mp4').rating), 4);
                h.assert.ok((await page.evaluate(() => App.fs.listTrash())).some((i) => i.originalPath === 'clip.mp4'));
                const probe = await page.evaluate(() => App.server.media.probe('clip.mp4'));
                h.assert.equal(probe.rotation, 90);
                await page.evaluate(() => App.undo.undo());
                const back = await page.evaluate(() => App.server.request('GET', '/api/media/probe', null, { query: { path: 'clip.mp4' } }));
                h.assert.equal(back.rotation, 0, 'undo brings the original back');
                h.assert.ok(fs.existsSync(path.join(root, 'clip.mp4')));
            });
        },
    },
    {
        name: 'server: file:// page detects a running server',
        async run(h) {
            await withServer(h, 'image', async ({ page, port }) => {
                await page.goto(pathToFileURL(path.join(h.ROOT, h.APP_FILE)).href + '?fiServerPort=' + port);
                await page.waitForSelector('.srv-status[data-state="detected"]');
                h.assert.equal(await page.locator('.srv-status').innerText(), '서버로 열기');
            });
        },
    },
    {
        name: 'server: setup sheet and server badges without a server',
        async run(h) {
            const py = python(h.ROOT);
            if (!py) { console.log('    skip: Python environment is unavailable'); return; }
            const app = await h.openApp({ seed: { 'x.heic': { bytes: [0, 0, 0, 24] }, 'a.png': { image: {} } } });
            await app.page.waitForSelector('.card[data-path="x.heic"] .srv-badge');
            h.assert.equal(await app.page.locator('.card[data-path="a.png"] .srv-badge').count(), 0);
            await app.page.locator('.srv-badge').click();
            await app.page.waitForSelector('.srv-setup');
            await app.page.keyboard.press('Escape');
            const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-setup-'));
            let browser;
            let server;
            try {
                const port = await freePort();
                browser = await h.launchBrowser();
                const page = await browser.newPage();
                const errors = collect(page);
                await page.goto(pathToFileURL(path.join(h.ROOT, h.APP_FILE)).href + '?fiServerPort=' + port);
                await page.waitForFunction(() => !!window.App?.server);
                // The dialog API resolves on close; do not await it inside evaluate.
                await page.evaluate(() => { App.server.showSetup(); });
                await page.waitForSelector('.srv-setup [data-state="waiting"]');
                server = await startPy({ py, root: h.ROOT, port, dataDir: path.join(temp, 'data') });
                await page.waitForSelector('.srv-setup [data-state="ready"]', { timeout: 10000 });
                h.assert.ok(await page.getByRole('button', { name: '서버로 계속하기', exact: true }).isVisible());
                await page.keyboard.press('Escape');
                await page.waitForSelector('.srv-setup', { state: 'detached' });
                h.assert.deepEqual(errors, []);
            } finally {
                if (browser) await browser.close();
                if (server) await server.stop();
                removeTemp(temp);
            }
        },
    },
    {
        name: 'server: AVI plays via the stream, media info, Explorer commands, shutdown and auto-reconnect',
        async run(h) {
            const py = python(h.ROOT);
            if (!py) { console.log('    skip: Python environment is unavailable'); return; }
            const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-client-'));
            const root = path.join(temp, '사진 작업');
            fs.mkdirSync(root);
            let server;
            let browser;
            try {
                await fixtures(py, root, 'avi');
                const port = await freePort();
                const dataDir = path.join(temp, 'data');
                server = await startPy({ py, root: h.ROOT, port, dataDir });
                browser = await h.launchBrowser();
                const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
                await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://127.0.0.1:${port}` });
                const page = await context.newPage();
                const errors = collect(page);
                await page.goto(`http://127.0.0.1:${port}/`);
                await page.waitForFunction(() => window.App?.server?.state === 'connected');
                await open(page, root);

                // Inspector: codec info only the server knows
                await page.locator('.card[data-path="c.avi"]').click();
                await page.waitForFunction(() => /mpeg4/.test(document.querySelector('.insp-sec-server-media')?.textContent || ''));

                // Viewer: an AVI plays through the fragmented-MP4 stream
                await page.keyboard.press('Enter');
                await page.waitForSelector('#viewer video.vw-media[src*="/api/media/stream"]');
                await page.waitForFunction(() => document.querySelector('#viewer video.vw-media').readyState >= 2, null, { timeout: 20000 });
                await page.keyboard.press('Escape');
                await page.waitForSelector('#viewer', { state: 'hidden' });

                // Explorer commands (the test server runs with FI_DRY_SHELL, so nothing pops up)
                await page.keyboard.press('Alt+Shift+C');
                await page.waitForFunction(() => document.querySelector('#toasts')?.textContent.includes('경로를 복사했어요'));
                h.assert.equal(await page.evaluate(() => navigator.clipboard.readText()), path.join(root, 'c.avi'));
                await page.keyboard.press('Alt+Shift+R');

                // '서버 끄기' from the app, then the app reconnects by itself when the server is back
                await page.evaluate(() => { App.commands.run('server.shutdown'); });
                await page.getByRole('button', { name: '서버 끄기', exact: true }).click();
                await page.waitForSelector('.srv-status[data-state="offline"]');
                await server.stop();
                server = await startPy({ py, root: h.ROOT, port, dataDir });
                await page.waitForSelector('.srv-status[data-state="connected"]', { timeout: 30000 });
                await page.waitForFunction(() => App.fs.backend?.kind === 'server' && !!App.view.get('c.avi'));
                h.assert.deepEqual(errors, [], 'browser must remain quiet');
            } finally {
                if (browser) await browser.close();
                if (server) await server.stop();
                removeTemp(temp);
            }
        },
    },
    {
        name: 'server: dupes v2 client — external root, fingerprints, compare scan, frames, quarantine with Ctrl+Z',
        async run(h) {
            const extOf = ({ temp }) => path.join(temp, '외부 영상');
            await withServer(h, 'dupes', async ({ page, root, temp }) => {
                await open(page, root);
                const ext = fs.realpathSync.native(extOf({ temp }));
                h.assert.ok(await page.evaluate(() => App.server.supports('dupes-v2')));
                // The native picker is simulated (FI_PICK_RESULT); the folder becomes an allowed read-only root
                const picked = await page.evaluate(() => App.server.dupes.pickRoot());
                h.assert.equal(path.normalize(picked.root).toLowerCase(), ext.toLowerCase());
                h.assert.ok((await page.evaluate(() => App.server.dupes.roots())).some((r) => r.root === picked.root && r.source === 'picked'));

                const first = await page.evaluate((r) => App.server.dupes.fingerprint({ dirs: [''], roots: [r] }), picked.root);
                h.assert.equal(first.files, 6); // 3 photos + clip + copy in the workspace, 1 video outside
                h.assert.equal(first.failed, 0);
                const again = await page.evaluate((r) => App.server.dupes.fingerprint({ dirs: [''], roots: [r] }), picked.root);
                h.assert.equal(again.computed, 0, 'second run reuses every fingerprint');

                const result = await page.evaluate((r) => App.server.dupes.scanV2({ compare: { a: [''], b: [r] } }), picked.root);
                h.assert.equal(result.stats.engine, 'server-v2');
                h.assert.equal(result.groups.length, 1);
                const group = result.groups[0];
                h.assert.equal(group.kind, 'exact');
                h.assert.ok(group.sure);
                h.assert.deepEqual(group.members.map((m) => m.side).sort(), ['a', 'a', 'b']);
                const outside = group.members.find((m) => m.side === 'b');
                h.assert.ok(await page.evaluate((p) => App.server.dupes.isExternal(p), outside.path));
                h.assert.ok(!fs.existsSync(path.join(ext, '.fluid-organizer')), 'external roots stay read-only');

                // Review strip frames load as images (same-origin, session cookie)
                const width = await page.evaluate(async (p) => {
                    const img = new Image();
                    img.src = App.server.dupes.frameUrl(p, 1, { w: 120 });
                    await img.decode();
                    return img.naturalWidth;
                }, outside.path);
                h.assert.equal(width, 120);

                // Quarantine = one undo step: Ctrl+Z brings the file back, redo moves it again
                const moved = await page.evaluate(({ p }) => App.server.dupes.quarantine([p], { keep: 'clip.mp4', reason: '테스트' }), { p: outside.path });
                h.assert.equal(moved.moved.length, 1, JSON.stringify(moved));
                h.assert.ok(fs.existsSync(path.join(ext, '_중복정리', '001_clip (1).mp4')));
                h.assert.ok(!fs.existsSync(path.join(ext, 'clip (1).mp4')));
                h.assert.equal((await page.evaluate(() => App.server.dupes.quarantined())).length, 1);
                h.assert.ok(fs.readFileSync(path.join(ext, '_중복정리', '정리기록.json'), 'utf8').includes('"state": "moved"'));
                await page.locator('#gallery').click({ position: { x: 5, y: 5 } }).catch(() => {});
                await page.keyboard.press('Control+z');
                await page.waitForFunction(() => App.undo.canRedo());
                h.assert.ok(fs.existsSync(path.join(ext, 'clip (1).mp4')), 'undo restores the file');
                h.assert.equal((await page.evaluate(() => App.server.dupes.quarantined())).length, 0);
                await page.evaluate(() => App.undo.redo());
                h.assert.ok(fs.existsSync(path.join(ext, '_중복정리', '002_clip (1).mp4')), 'redo quarantines again');
                // Another file takes the original name meanwhile: undo restores as '(복원)', redo moves only that one
                fs.writeFileSync(path.join(ext, 'clip (1).mp4'), 'someone else');
                await page.evaluate(() => App.undo.undo());
                h.assert.ok(fs.existsSync(path.join(ext, 'clip (1) (복원).mp4')), 'restore never overwrites');
                h.assert.equal(fs.readFileSync(path.join(ext, 'clip (1).mp4'), 'utf8'), 'someone else');
                await page.evaluate(() => App.undo.redo());
                h.assert.ok(!fs.existsSync(path.join(ext, 'clip (1) (복원).mp4')));
                h.assert.equal(fs.readFileSync(path.join(ext, 'clip (1).mp4'), 'utf8'), 'someone else', 'redo never touches the other file');
                fs.unlinkSync(path.join(ext, 'clip (1).mp4'));

                // Workspace files are refused (they go to the app trash instead)
                const refused = await page.evaluate((p) => App.server.request('POST', '/api/dupes/quarantine', { paths: [p] }), path.join(root, 'copy.mp4'));
                h.assert.equal(refused.failed[0].code, 'EINVAL');
                h.assert.ok(fs.existsSync(path.join(root, 'copy.mp4')));

                // Pausing the status-bar job pauses the server job
                for (let i = 0; i < 4; i++) fs.copyFileSync(path.join(root, 'clip.mp4'), path.join(root, `fresh-${i}.mp4`));
                fs.appendFileSync(path.join(root, 'fresh-1.mp4'), Buffer.alloc(16)); // a different size: needs its own fingerprint
                const paused = await page.evaluate(async () => {
                    const job = await App.server.dupes.start('/api/dupes/fingerprint', { dirs: [''], workers: 1 });
                    const done = App.server.waitJob(job, { title: '지문 만들기', pausable: true });
                    const local = App.jobs.list().find((j) => j.title === '지문 만들기');
                    local.pause();
                    let remote;
                    for (let i = 0; i < 50; i++) {
                        remote = await App.server.job(job.id);
                        if (remote.paused || remote.state !== 'running') break;
                        await App.util.sleep(50);
                    }
                    const snapshot = { paused: remote.paused, state: remote.state, pausable: local.pausable };
                    local.resume();
                    const result = await done;
                    return { ...snapshot, files: result.files };
                });
                h.assert.ok(paused.pausable);
                h.assert.ok(paused.paused, JSON.stringify(paused));
                h.assert.equal(paused.state, 'running');
                h.assert.equal(paused.files, 9);
            }, extOf);
        },
    },
    {
        name: 'server: one-click handoff from the file:// page keeps the folder and the settings',
        async run(h) {
            await withServer(h, 'image', async ({ page, port, root }) => {
                await open(page, root);
                const ws = await page.evaluate(() => App.state.workspace);
                const encode = (payload) => Buffer.from(JSON.stringify(payload)).toString('base64url');
                const context = await page.context().browser().newContext({ viewport: { width: 1280, height: 800 } });
                try {
                    const fresh = await context.newPage();
                    const errors = collect(fresh);
                    const payload = { v: 1, at: Date.now(), settings: { theme: 'light', 'handoff.test': 42, 'server.hintAt': 7 }, workspace: { id: ws.id, name: ws.name }, cwd: 'trip' };
                    await fresh.goto(`http://127.0.0.1:${port}/#fi-handoff=${encode(payload)}`);
                    await fresh.waitForFunction((id) => App.state.workspace?.id === id && App.state.cwd === 'trip', ws.id, { timeout: 15000 });
                    h.assert.equal(await fresh.evaluate(() => App.settings.get('handoff.test')), 42);
                    h.assert.equal(await fresh.evaluate(() => App.settings.get('server.hintAt', null)), null, 'server.* settings are not carried');
                    h.assert.equal(await fresh.evaluate(() => document.documentElement.dataset.theme), 'light');
                    h.assert.equal(await fresh.evaluate(() => location.hash), '', 'the fragment is removed from the address bar');
                    await fresh.waitForFunction(() => document.querySelector('#toasts')?.textContent.includes('서버로 이어서 열었어요'));

                    // A folder the server doesn't know yet → the chooser asks for it once, by name
                    const unknown = await context.newPage();
                    const errors2 = collect(unknown);
                    await unknown.goto(`http://127.0.0.1:${port}/#fi-handoff=${encode({ ...payload, at: Date.now(), workspace: { id: 'wsnope', name: '모르는 폴더' } })}`);
                    await unknown.waitForSelector('.srv-chooser .srv-hint');
                    h.assert.ok((await unknown.locator('.srv-hint').innerText()).includes('모르는 폴더'));
                    // Stale handoffs are ignored
                    const stale = await context.newPage();
                    const errors3 = collect(stale);
                    await stale.goto(`http://127.0.0.1:${port}/#fi-handoff=${encode({ ...payload, at: Date.now() - 60 * 60 * 1000, settings: { 'handoff.stale': 1 } })}`);
                    await stale.waitForFunction(() => window.App?.server?.state === 'connected');
                    h.assert.equal(await stale.evaluate(() => App.settings.get('handoff.stale', null)), null);
                    h.assert.deepEqual([...errors, ...errors2, ...errors3], []);
                } finally {
                    await context.close();
                }
            });
        },
    },
    {
        name: 'server: the file:// page builds a handoff link with the open folder and settings',
        async run(h) {
            const app = await h.openApp({ seed: { 'a.png': { image: {} }, 'trip/b.png': { image: {} } } });
            const { page } = app;
            await page.evaluate(() => {
                App.settings.set('handoff.carry', 'yes');
                App.settings.set('server.hintAt', 123);
            });
            await page.evaluate(() => App.nav.go('trip'));
            await page.waitForFunction(() => App.state.cwd === 'trip');
            const data = await page.evaluate(() => {
                const url = App.server.handoffUrl();
                const value = url.split('#fi-handoff=')[1];
                const bin = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
                return { url, payload: JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))), ws: App.state.workspace };
            });
            h.assert.ok(data.url.startsWith('http://127.0.0.1:8765/#fi-handoff='));
            h.assert.equal(data.payload.v, 1);
            h.assert.deepEqual(data.payload.workspace, { id: data.ws.id, name: data.ws.name });
            h.assert.equal(data.payload.cwd, 'trip');
            h.assert.equal(data.payload.settings['handoff.carry'], 'yes');
            h.assert.ok(!('server.hintAt' in data.payload.settings));
        },
    },
    {
        name: 'server: an older server process shows "다시 켜기" and reconnects after the restart',
        async run(h) {
            await withServer(h, 'image', async ({ page }) => {
                // Pretend the running server is a round-1 process (no apiVersion)
                await page.route('**/api/session', async (route) => {
                    // route.fetch() leaves out the browser's Sec-Fetch-Site header, which /api/session requires
                    const response = await route.fetch({ headers: { ...route.request().headers(), 'sec-fetch-site': 'same-origin' } });
                    const json = await response.json();
                    delete json.apiVersion;
                    await route.fulfill({ response, json });
                });
                await page.reload();
                await page.waitForSelector('.srv-status[data-state="connected"][data-outdated]');
                h.assert.equal(await page.locator('.srv-status').innerText(), '서버 업데이트');
                h.assert.ok(!(await page.evaluate(() => App.server.supports('dupes-v2'))));
                await page.waitForFunction(() => document.querySelector('#toasts')?.textContent.includes('서버를 새 버전으로 다시 켜 주세요'));
                await page.unroute('**/api/session');
                await page.locator('.srv-status').click();
                await page.waitForSelector('.srv-update');
                await page.locator('.srv-update').getByRole('button', { name: '다시 켜기', exact: true }).click();
                // The test server restarts "dry" (stays up): the app reconnects and the warning is gone
                await page.waitForSelector('.srv-status[data-state="connected"]:not([data-outdated])', { timeout: 20000 });
                await page.waitForFunction(() => document.querySelector('#toasts')?.textContent.includes('다시 연결했어요'));
                h.assert.equal(await page.evaluate(() => App.server.apiVersion), 2);
            });
        },
    },
];
