// Duplicate finder v2 — videos: the owner's matching rule on real recordings (MediaRecorder), 확실/애매, look-alikes
// that must NOT match, A-vs-B compare, fingerprints reused after a reload (no recompute), background pre-build.
'use strict';

/**
 * Record canvas clips in the page and write them into the seeded OPFS workspace.
 * clips: [{ path, seed, w, h, seconds }] — the same seed draws the same (scale-independent) animation, so two sizes of
 * one seed are "the same video re-encoded"; another seed is a different video. Recorded in parallel.
 */
async function seedClips(page, clips) {
    await page.evaluate(async (list) => {
        function draw(g, w, h, t, seed) {
            const frac = (x) => x - Math.floor(x);
            // Horizontal structure (dHash compares left/right neighbours): a left→right ramp whose direction depends on
            // the seed, plus vertical bars at seed-dependent places that drift slowly.
            const hue = (seed * 97 + t * 4) % 360;
            const grad = g.createLinearGradient(0, 0, w, 0);
            const dark = `hsl(${hue},60%,12%)`;
            const light = `hsl(${(hue + 40) % 360},70%,82%)`;
            grad.addColorStop(0, seed % 2 ? dark : light);
            grad.addColorStop(1, seed % 2 ? light : dark);
            g.fillStyle = grad;
            g.fillRect(0, 0, w, h);
            for (let k = 0; k < 6; k++) {
                const x = frac(seed * 0.37 + k * 0.167 + t * 0.004) * w * 0.9;
                const y = frac(seed * 0.61 + k * 0.29) * h * 0.5;
                g.fillStyle = k % 2 ? `hsl(${(hue + 180) % 360},80%,90%)` : `hsl(${(hue + 90) % 360},80%,8%)`;
                g.fillRect(x, y, w * 0.07, h * 0.5);
            }
        }
        async function record(c) {
            const canvas = document.createElement('canvas');
            canvas.width = c.w;
            canvas.height = c.h;
            const g = canvas.getContext('2d');
            draw(g, c.w, c.h, 0, c.seed);
            const stream = canvas.captureStream(15);
            const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
            const chunks = [];
            rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
            const stopped = new Promise((r) => (rec.onstop = r));
            rec.start(100);
            const start = performance.now();
            for (;;) {
                const t = (performance.now() - start) / 1000;
                draw(g, c.w, c.h, t, c.seed);
                if (t >= c.seconds) break;
                await new Promise((r) => setTimeout(r, 33));
            }
            rec.requestData();
            rec.stop();
            await stopped;
            stream.getTracks().forEach((tr) => tr.stop());
            return new Blob(chunks, { type: 'video/webm' });
        }
        const blobs = await Promise.all(list.map(record));
        for (let i = 0; i < list.length; i++) {
            const parts = list[i].path.split('/');
            let dir = window.__fakeRoot;
            for (const seg of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(seg, { create: true });
            const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
            const wr = await fh.createWritable();
            await wr.write(blobs[i]);
            await wr.close();
        }
    }, clips);
}

/** Seed images (harness spec) + recorded clips, then open the workspace. */
async function openWithClips(h, { seed = {}, clips = [] } = {}) {
    const app = await h.openApp({ seed: { 'readme.png': { image: { w: 40, h: 30, color: '#456', label: 'R' } }, ...seed }, open: false });
    const { page } = app;
    await seedClips(page, clips);
    await page.evaluate(() => App.workspace.pick());
    await page.waitForFunction(() => App.state.cwd === '' && App.view.source.type === 'folder');
    await page.waitForFunction(() => App.index.ready);
    await h.waitIdle(page);
    return app;
}

async function until(page, fn, arg, { timeout = 30000, message } = {}) {
    const t0 = Date.now();
    let last;
    for (;;) {
        last = await page.evaluate(fn, arg);
        if (last) return last;
        if (Date.now() - t0 > timeout) throw new Error(`timed out: ${message || fn.toString().slice(0, 120)}`);
        await page.waitForTimeout(80);
    }
}

/** Run a browser-engine scan directly and assemble the groups: [{ kind, sure, paths }] */
async function scanGroups(page, scope, opts = {}) {
    return page.evaluate(async ({ scope, opts }) => {
        const E = App.dupes.engine;
        const res = await E.scanBrowser(scope, { rules: App.dupes.store.rules(), ...opts });
        window.__lastScan = res;
        const groups = E.assemble(res.raw, { rules: App.dupes.store.rules(), compare: scope.type === 'compare', focus: opts.focus });
        return groups.map((g) => ({ kind: g.kind, sure: g.sure, keep: g.keep, paths: g.members.map((m) => m.path).sort(), ev: g.evidence.map((e) => ({ kind: e.kind, dDur: e.dDur, bits: e.frames ? e.frames.map((f) => f.bits) : null })) }));
    }, { scope, opts });
}

const CLIPS = [
    { path: 'clips/beach.webm', seed: 3, w: 320, h: 240, seconds: 4 },
    { path: 'downloads/beach_small.webm', seed: 3, w: 192, h: 144, seconds: 4 }, // same video, re-encoded smaller
    { path: 'downloads/beach_long.webm', seed: 3, w: 256, h: 192, seconds: 4.9 }, // same video, a bit longer → 애매
    { path: 'clips/forest.webm', seed: 8, w: 320, h: 240, seconds: 4 }, // a different video, nearly the same length
];

const tests = [
    {
        name: 'same clip re-recorded at another size is the same video; a different clip of the same length is not; 확실 vs 애매',
        async run(h) {
            const { assert } = h;
            const { page } = await openWithClips(h, { clips: CLIPS });
            const durs = await page.evaluate(async () => {
                const out = {};
                for (const p of ['clips/beach.webm', 'downloads/beach_small.webm', 'downloads/beach_long.webm', 'clips/forest.webm']) {
                    const e = App.index.get(p);
                    out[p] = (await App.dupes.engine.videoFrames(e)).dur;
                }
                return out;
            });
            const groups = await scanGroups(page, { type: 'workspace' });
            const vids = groups.filter((g) => g.kind === 'video');
            assert.equal(vids.length, 1, `one video group (durations ${JSON.stringify(durs)}; groups ${JSON.stringify(groups)})`);
            const g = vids[0];
            assert.deepEqual(g.paths, ['clips/beach.webm', 'downloads/beach_long.webm', 'downloads/beach_small.webm'], 'the three beach versions, never the forest clip');
            assert.equal(g.keep, 'clips/beach.webm', 'keeps the highest resolution');
            assert.equal(g.sure, false, 'a 0.9 s longer copy makes the group 애매');
            // every compared frame matched within the 10-bit rule for the size-only copy
            const small = g.ev.find((e) => e.bits && e.dDur < 0.3);
            assert.ok(small, 'an edge between same-length copies');
            assert.ok(small.bits.filter((b) => b != null && b <= 10).length >= 3, `≥3 frames match: ${small.bits}`);

            // Without the long copy: the two same-length versions are 확실
            await page.evaluate(() => App.dupes.excludeFiles(['downloads/beach_long.webm']));
            const after = await page.evaluate(() => App.dupes.engine.assemble(window.__lastScan.raw, { rules: App.dupes.store.rules() }).map((x) => ({ sure: x.sure, kind: x.kind, paths: x.members.map((m) => m.path).sort() })));
            const v2 = after.filter((x) => x.kind === 'video');
            assert.equal(v2.length, 1);
            assert.deepEqual(v2[0].paths, ['clips/beach.webm', 'downloads/beach_small.webm']);
            assert.equal(v2[0].sure, true, `same length (Δ ${Math.abs(durs['clips/beach.webm'] - durs['downloads/beach_small.webm']).toFixed(3)} s) → 확실`);
        },
    },
    {
        name: 'fingerprints are made once: a reload reuses them (no decode, no hashing) and reports the time saved',
        async run(h) {
            const { assert } = h;
            const app = await openWithClips(h, {
                seed: { 'pics/a.png': { image: { w: 300, h: 200, color: '#2a6', label: 'A' } }, 'pics/a copy.png': { image: { w: 300, h: 200, color: '#2a6', label: 'A' } } },
                clips: CLIPS.slice(0, 2).concat([CLIPS[3]]),
            });
            let { page } = app;
            await page.evaluate(() => App.dupes.engine.cache.clear());
            const first = await page.evaluate(async () => {
                const c0 = { ...App.dupes.engine.counters };
                const r = await App.dupes.engine.scanBrowser({ type: 'workspace' }, { rules: App.dupes.store.rules() });
                const c1 = App.dupes.engine.counters;
                return { made: r.stats.made, reused: r.stats.reused, video: c1.video - c0.video, quick: c1.quick - c0.quick, image: c1.image - c0.image };
            });
            assert.ok(first.video >= 2 && first.quick >= 2 && first.image >= 2, `first scan computes: ${JSON.stringify(first)}`);
            assert.ok(await page.evaluate(() => App.dupes.engine.cache.count()) >= 5, 'fingerprints stored');

            // Reload the page (same browser profile): nothing is computed again
            await page.reload();
            await page.waitForFunction(() => window.App && document.querySelector('#topbar').children.length > 0);
            await page.evaluate(() => window.__useExistingWorkspace());
            await page.evaluate(() => App.workspace.pick());
            await page.waitForFunction(() => App.index.ready && App.view.source.type === 'folder');
            await h.waitIdle(page);
            const second = await page.evaluate(async () => {
                const c0 = { ...App.dupes.engine.counters };
                const r = await App.dupes.engine.scanBrowser({ type: 'workspace' }, { rules: App.dupes.store.rules() });
                const c1 = App.dupes.engine.counters;
                return { made: r.stats.made, reused: r.stats.reused, savedMs: r.stats.savedMs, video: c1.video - c0.video, quick: c1.quick - c0.quick, image: c1.image - c0.image, probe: c1.probe - c0.probe, full: c1.full - c0.full };
            });
            assert.deepEqual({ video: second.video, quick: second.quick, image: second.image, probe: second.probe, full: second.full, made: second.made }, { video: 0, quick: 0, image: 0, probe: 0, full: 0, made: 0 }, `second scan reuses everything: ${JSON.stringify(second)}`);
            assert.ok(second.reused >= 5 && second.savedMs > 0, 'reports reuse and time saved');

            // A new file: only that one is fingerprinted
            await page.evaluate(async () => {
                const f = await App.fs.getFile('pics/a.png');
                await App.fs.createFile('pics', 'a third.png', f);
            });
            await until(page, () => !!App.index.get('pics/a third.png'), null, { message: 'index sees the new file' });
            const third = await page.evaluate(async () => {
                const c0 = { ...App.dupes.engine.counters };
                const r = await App.dupes.engine.scanBrowser({ type: 'workspace' }, { rules: App.dupes.store.rules() });
                const c1 = App.dupes.engine.counters;
                return { quick: c1.quick - c0.quick, image: c1.image - c0.image, video: c1.video - c0.video };
            });
            assert.deepEqual(third, { quick: 1, image: 1, video: 0 }, 'only the new file');

            // The panel says how many fingerprints are ready
            await page.evaluate(() => { App.commands.run('dupes.open', { fresh: true }); });
            await page.waitForSelector('.dup-panel .dup-fp-count');
            await until(page, () => /지문 [\d,]+개 준비됨/.test(document.querySelector('.dup-fp-count')?.textContent || '') && !/지문 0개/.test(document.querySelector('.dup-fp-count').textContent), null, { message: 'fingerprint count shown' });
        },
    },
    {
        name: 'background pre-build: pausable, cancellable, marked background; scans afterwards only reuse',
        async run(h) {
            const { assert } = h;
            const { page } = await openWithClips(h, {
                seed: { 'many/': { bulk: { count: 120, image: { color: '#555', label: 'M' } } } },
                clips: [CLIPS[0], CLIPS[1]],
            });
            await page.evaluate(() => App.dupes.engine.cache.clear());
            await page.evaluate(() => { App.commands.run('dupes.prebuild'); });
            const meta = await until(page, () => {
                const j = App.jobs.list().find((x) => x.kind === 'dupes.fingerprint');
                return j && { background: j.background, pausable: j.pausable, cancellable: j.cancellable };
            }, null, { message: 'job started' });
            assert.deepEqual(meta, { background: true, pausable: true, cancellable: true });
            assert.equal(await page.evaluate(() => App.jobs.list({ foreground: true }).filter((j) => j.kind === 'dupes.fingerprint').length), 0, 'not a foreground job');
            await page.evaluate(() => App.jobs.list().find((x) => x.kind === 'dupes.fingerprint').pause());
            const a = await page.evaluate(() => App.jobs.list().find((x) => x.kind === 'dupes.fingerprint')?.done ?? -1);
            await page.waitForTimeout(700);
            const b = await page.evaluate(() => App.jobs.list().find((x) => x.kind === 'dupes.fingerprint')?.done ?? -1);
            assert.ok(b - a <= 8, `paused (moved ${b - a})`);
            await page.evaluate(() => App.jobs.list().find((x) => x.kind === 'dupes.fingerprint').resume());
            await until(page, () => !App.jobs.list().some((x) => x.kind === 'dupes.fingerprint'), null, { timeout: 60000, message: 'pre-build finishes' });
            await page.waitForSelector('.toast:has-text("지문")');
            const after = await page.evaluate(async () => {
                const c0 = { ...App.dupes.engine.counters };
                await App.dupes.engine.scanBrowser({ type: 'workspace' }, { rules: App.dupes.store.rules() });
                const c1 = App.dupes.engine.counters;
                return { video: c1.video - c0.video, quick: c1.quick - c0.quick, image: c1.image - c0.image };
            });
            assert.deepEqual(after, { video: 0, quick: 0, image: 0 }, 'the scan only reuses');

            // cancel a fresh run
            await page.evaluate(() => App.dupes.engine.cache.clear());
            await page.evaluate(() => { App.commands.run('dupes.prebuild'); });
            await until(page, () => App.jobs.list().some((x) => x.kind === 'dupes.fingerprint'), null, { message: 'started again' });
            await page.evaluate(() => App.jobs.list().find((x) => x.kind === 'dupes.fingerprint').cancel());
            await until(page, () => !App.jobs.list().some((x) => x.kind === 'dupes.fingerprint'), null, { message: 'cancelled' });
        },
    },
    {
        name: 'A-vs-B: only groups that span both sides, from the setup screen with the tree picker',
        async run(h) {
            const { assert } = h;
            const img = { w: 300, h: 200, color: '#2a6', label: 'P' };
            const other = { w: 300, h: 200, color: '#a26', label: 'Q' };
            const { page } = await openWithClips(h, {
                seed: {
                    'downloads/p.png': { image: img },
                    'library/p.png': { image: img },
                    'downloads/q.png': { image: other },
                    'downloads/q (1).png': { image: other },
                },
                clips: [{ ...CLIPS[0], path: 'downloads/beach.webm' }, { ...CLIPS[1], path: 'library/2024/beach_small.webm' }],
            });
            await page.evaluate(() => { App.commands.run('dupes.compare'); });
            await page.waitForSelector('.dup-panel .dup-tree-row');
            await page.click('.dup-tree-row[data-path="downloads"] .dup-ab-btn.side-a');
            await page.click('.dup-tree-row[data-path="library"] .dup-ab-btn.side-b');
            await page.click('.dup-panel .org-foot .btn.primary:has-text("찾기 시작")');
            await page.waitForSelector('.dup-panel .dup-review', { timeout: 60000 });
            const ids = await page.evaluate(() => {
                const rv = App.dupes.ui.active.rv;
                return rv.order.map((id) => rv.byId.get(id)).map((g) => ({ kind: g.kind, paths: g.members.map((m) => m.path).sort(), sides: g.members.map((m) => m.side).sort() }));
            });
            assert.deepEqual(ids.map((g) => g.paths).sort(), [['downloads/beach.webm', 'library/2024/beach_small.webm'], ['downloads/p.png', 'library/p.png']], `only cross-side groups: ${JSON.stringify(ids)}`);
            for (const g of ids) assert.deepEqual(g.sides, ['a', 'b']);
            assert.ok(await page.isVisible('.dup-member .dup-side-badge.side-a'), 'members show their side');
            assert.match(await page.textContent('.org-head-sub'), /두 쪽 비교/);
        },
    },
];

module.exports = tests;
module.exports.helpers = { seedClips, openWithClips, until, scanGroups, CLIPS };
