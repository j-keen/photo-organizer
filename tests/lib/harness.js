/*
 * E2E test harness.
 *  - Serves the repo over http://127.0.0.1:<random port> (static).
 *  - Launches the installed Chrome (or Edge) through Playwright.
 *  - Replaces window.showDirectoryPicker with an OPFS-backed fake workspace seeded from a spec, so tests
 *    exercise the real File System Access code paths without a native dialog.
 *
 * Spec format for seed files:
 *   { 'a.jpg': { image: { w: 640, h: 480, color: '#c33', label: 'A' } },
 *     'sub/b.png': { image: {} },
 *     'clips/c.webm': { video: { seconds: 1.5 } },
 *     'notes.txt': 'plain text',
 *     'empty-folder/': null }
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

let playwright;
try {
    playwright = require('playwright');
} catch (e) {
    console.error('Playwright is missing. Run "npm install" in the repo root first.');
    process.exit(2);
}

const ROOT = path.resolve(__dirname, '..', '..');
const APP_FILE = '사진영상정리기.html';
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.webm': 'video/webm',
    '.mp4': 'video/mp4',
};

function startServer(root = ROOT) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
            const file = path.join(root, rel || APP_FILE);
            if (!file.startsWith(root)) {
                res.writeHead(403);
                res.end();
                return;
            }
            fs.readFile(file, (err, data) => {
                if (err) {
                    res.writeHead(404);
                    res.end('not found');
                    return;
                }
                res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
                res.end(data);
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, url: `http://127.0.0.1:${port}/${encodeURIComponent(APP_FILE)}`, origin: `http://127.0.0.1:${port}` });
        });
    });
}

async function launchBrowser() {
    for (const channel of ['chrome', 'msedge']) {
        try {
            return await playwright.chromium.launch({ channel, headless: process.env.HEADED ? false : true });
        } catch (e) {
            /* try next */
        }
    }
    return playwright.chromium.launch();
}

// Runs in the page before any app script: fake directory picker over OPFS + seeding helpers.
function initScript() {
    window.__TEST__ = true;
    window.__seedDone = null;

    async function makeImage(opts = {}) {
        const w = opts.w || 640;
        const h = opts.h || 480;
        const c = new OffscreenCanvas(w, h);
        const g = c.getContext('2d');
        g.fillStyle = opts.color || `hsl(${Math.floor(Math.random() * 360)},60%,45%)`;
        g.fillRect(0, 0, w, h);
        g.fillStyle = '#fff';
        g.font = `${Math.round(h / 5)}px sans-serif`;
        g.fillText(opts.label || 'TEST', w * 0.1, h * 0.6);
        return c.convertToBlob({ type: opts.mime || 'image/png' });
    }

    async function makeVideo(opts = {}) {
        const canvas = document.createElement('canvas');
        canvas.width = opts.w || 320;
        canvas.height = opts.h || 240;
        const g = canvas.getContext('2d');
        const stream = canvas.captureStream(15);
        const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
        const chunks = [];
        rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        const stopped = new Promise((r) => (rec.onstop = r));
        rec.start(100);
        const start = performance.now();
        const ms = (opts.seconds || 1) * 1000;
        await new Promise((resolve) => {
            const tick = () => {
                const t = performance.now() - start;
                g.fillStyle = `hsl(${(t / 10) % 360},70%,45%)`;
                g.fillRect(0, 0, canvas.width, canvas.height);
                g.fillStyle = '#fff';
                g.font = '40px sans-serif';
                g.fillText((t / 1000).toFixed(1), 20, 120);
                if (t < ms) requestAnimationFrame(tick);
                else resolve();
            };
            tick();
        });
        rec.stop();
        await stopped;
        return new Blob(chunks, { type: 'video/webm' });
    }

    async function writePath(root, rel, data) {
        const parts = rel.split('/').filter(Boolean);
        let dir = root;
        const isDir = rel.endsWith('/');
        for (const [i, seg] of parts.entries()) {
            if (i === parts.length - 1 && !isDir) {
                const fh = await dir.getFileHandle(seg, { create: true });
                const w = await fh.createWritable();
                await w.write(data);
                await w.close();
            } else {
                dir = await dir.getDirectoryHandle(seg, { create: true });
            }
        }
    }

    window.__seedWorkspace = async (spec, name = 'ws') => {
        const opfs = await navigator.storage.getDirectory();
        try {
            await opfs.removeEntry(name, { recursive: true });
        } catch (e) {
            /* fresh */
        }
        const root = await opfs.getDirectoryHandle(name, { create: true });
        for (const [rel, v] of Object.entries(spec)) {
            if (v === null) await writePath(root, rel.endsWith('/') ? rel : rel + '/', null);
            else if (typeof v === 'string') await writePath(root, rel, v);
            else if (v.image) await writePath(root, rel, await makeImage(v.image));
            else if (v.video) await writePath(root, rel, await makeVideo(v.video));
            else if (v.bytes) await writePath(root, rel, new Uint8Array(v.bytes));
            else if (v.bulk) {
                // { bulk: { count, image: {...}, pattern: 'IMG_{n}.png' } } — many small files sharing one generated blob
                const blob = await makeImage({ w: 48, h: 36, ...(v.bulk.image || {}) });
                const pattern = v.bulk.pattern || 'IMG_{n}.png';
                for (let i = 0; i < v.bulk.count; i++) {
                    const name2 = pattern.replace('{n}', String(i + 1).padStart(5, '0'));
                    await writePath(root, rel.replace(/\/?$/, '/') + name2, blob);
                }
            }
        }
        window.__fakeRoot = root;
        return true;
    };

    // Re-attach to an OPFS workspace seeded before a page reload
    window.__useExistingWorkspace = async (name = 'ws') => {
        window.__fakeRoot = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
        return true;
    };

    window.showDirectoryPicker = async () => {
        if (!window.__fakeRoot) throw new DOMException('no seeded workspace', 'AbortError');
        return window.__fakeRoot;
    };

    // Read helpers for assertions
    window.__opfs = {
        async handleFor(rel) {
            let dir = window.__fakeRoot;
            const parts = rel.split('/').filter(Boolean);
            for (const [i, seg] of parts.entries()) {
                if (i === parts.length - 1) {
                    try {
                        return await dir.getFileHandle(seg);
                    } catch (e) {
                        return await dir.getDirectoryHandle(seg);
                    }
                }
                dir = await dir.getDirectoryHandle(seg);
            }
            return dir;
        },
        async exists(rel) {
            try {
                await window.__opfs.handleFor(rel);
                return true;
            } catch (e) {
                return false;
            }
        },
        async read(rel) {
            const h = await window.__opfs.handleFor(rel);
            return (await h.getFile()).text();
        },
        async list(rel = '') {
            const h = rel ? await window.__opfs.handleFor(rel) : window.__fakeRoot;
            const out = [];
            for await (const [name, child] of h.entries()) out.push(child.kind === 'directory' ? name + '/' : name);
            return out.sort();
        },
    };
}

/**
 * Start everything and open the app with a seeded workspace.
 * Returns { page, browser, server, errors, close() }.
 */
async function openApp({ seed = {}, open = true, viewport = { width: 1440, height: 900 } } = {}) {
    const { server, url } = await startServer();
    const browser = await launchBrowser();
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const text = m.text();
        if (/pretendard|favicon|ERR_INTERNET_DISCONNECTED|net::ERR_/i.test(text)) return; // optional web font / offline noise
        errors.push(`console: ${text}`);
    });
    page.on('dialog', (d) => {
        errors.push(`native dialog used: ${d.type()} "${d.message()}"`);
        d.dismiss();
    });
    await page.addInitScript(initScript);
    await page.goto(url);
    await page.waitForFunction(() => window.App && document.querySelector('#topbar').children.length > 0);
    if (Object.keys(seed).length || open) {
        await page.evaluate((s) => window.__seedWorkspace(s), seed);
    }
    if (open) {
        await page.evaluate(() => App.workspace.pick());
        await page.waitForFunction(() => App.state.cwd === '' && App.view.source.type === 'folder');
        await waitIdle(page);
    }
    return {
        page,
        browser,
        server,
        errors,
        async close() {
            await browser.close();
            server.close();
        },
    };
}

/** Wait until there are no running jobs and the gallery has rendered */
async function waitIdle(page, timeout = 15000) {
    await page.waitForFunction(() => App.jobs.list().length === 0, null, { timeout });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** Names of the cards currently rendered in the gallery, in visual order */
async function cardNames(page) {
    return page.evaluate(() => App.view.visible.map((e) => e.name));
}

async function card(page, name) {
    return page.locator(`.card[data-path$="${name}"]`).first();
}

module.exports = { startServer, launchBrowser, openApp, waitIdle, cardNames, card, ROOT, APP_FILE };
