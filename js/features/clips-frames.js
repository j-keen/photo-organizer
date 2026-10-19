/*
 * Clip library — frame thumbnails at a clip's start (clips team).
 *
 *   App.clipsFrames.get(path, t, { signal }) -> Promise<{ url } | { failed: true, label }>
 *   App.clipsFrames.peek(path, t)            -> { url } | { failed, label } | null   (memory only, synchronous)
 *   App.clipsFrames.label(path)              -> short format name for the placeholder ('HEVC', 'MKV', ...)
 *   App.clipsFrames.stats()                  -> { captures, hits, failures }
 *
 * Sources, in order: the local server's frame endpoint (App.server.dupes.frameUrl, feature-detected) when connected;
 * otherwise a capture in the browser — at most 2 hidden <video> elements at a time, started from requestIdleCallback,
 * only for rows on screen (callers abort when a row scrolls away). Captures are cached in IndexedDB by
 * path|size|mtime|t so they come back instantly next time. Files Chrome can't decode (HEVC, AVI, some MKV...) get a
 * placeholder with the format name instead of a broken image (also remembered).
 */
(() => {
    'use strict';
    const { path: P } = App.util;

    const W = 160; // capture width (rows show 64px; 2.5x for HiDPI and the inspector)
    const MAX_ACTIVE = 2;
    const MEM_LIMIT = 400;
    const store = App.idb.store('fluid-identity-clips', 'frames');

    const mem = new Map(); // key -> { url } | { failed, label }
    const inflight = new Map(); // key -> Promise
    const queue = []; // { key, run, signal }
    let active = 0;
    const counters = { captures: 0, hits: 0, failures: 0 };
    const codecs = new Map(); // path -> codec name from the server probe

    function remember(key, value) {
        if (mem.has(key)) mem.delete(key);
        mem.set(key, value);
        while (mem.size > MEM_LIMIT) {
            const [k, v] = mem.entries().next().value;
            mem.delete(k);
            if (v && v.url && v.url.startsWith('blob:')) URL.revokeObjectURL(v.url);
        }
        return value;
    }

    // Cache keys carry the workspace id: two libraries can hold "a.mp4" with the same size and date
    function wsKey() {
        return App.state.workspace?.id || '-';
    }

    function tKey(t) {
        return (Math.round(Number(t || 0) * 10) / 10).toFixed(1);
    }

    function entryOf(p) {
        return App.index?.get?.(p) || App.view?.get?.(p) || null;
    }

    async function versionOf(p) {
        let e = entryOf(p);
        if (!e || e.size == null) {
            try {
                e = await App.fs.stat(p);
            } catch (err) {
                e = null;
            }
        }
        return e ? `${e.size ?? 0}|${e.mtime ?? 0}` : null;
    }

    function label(p) {
        return codecs.get(p) || (P.ext(p) || 'video').toUpperCase();
    }

    function serverFrame(p, t) {
        const S = App.server;
        if (!S?.available || !S.backend || typeof S.dupes?.frameUrl !== 'function') return null;
        try {
            return S.dupes.frameUrl(p, t, W) || null;
        } catch (e) {
            return null;
        }
    }

    // ---------- Scheduling: idle time, 2 at a time ----------
    const idle = window.requestIdleCallback ? (fn) => window.requestIdleCallback(fn, { timeout: 600 }) : (fn) => setTimeout(fn, 30);

    function pump() {
        while (active < MAX_ACTIVE && queue.length) {
            const job = queue.shift();
            if (job.signal?.aborted) {
                job.reject(Object.assign(new Error('aborted'), { aborted: true }));
                continue;
            }
            active++;
            idle(() => {
                if (job.signal?.aborted) {
                    active--;
                    job.reject(Object.assign(new Error('aborted'), { aborted: true }));
                    pump();
                    return;
                }
                job.run().then(job.resolve, job.reject).finally(() => {
                    active--;
                    pump();
                });
            });
        }
    }

    function enqueue(run, signal) {
        return new Promise((resolve, reject) => {
            queue.push({ run, resolve, reject, signal });
            pump();
        });
    }

    // ---------- Browser capture ----------
    function waitEvent(v, name, timeout) {
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timer);
                v.removeEventListener(name, ok);
                v.removeEventListener('error', bad);
            };
            const ok = () => {
                cleanup();
                resolve();
            };
            const bad = () => {
                cleanup();
                const code = v.error && v.error.code;
                reject(Object.assign(new Error(`video error ${code || ''}`), { decode: code === 3 || code === 4 }));
            };
            const timer = setTimeout(() => {
                cleanup();
                reject(Object.assign(new Error(`${name} timeout`), { timeout: true }));
            }, timeout);
            v.addEventListener(name, ok);
            v.addEventListener('error', bad);
        });
    }

    function painted(v) {
        if (typeof v.requestVideoFrameCallback !== 'function') return App.util.sleep(60);
        return Promise.race([new Promise((r) => v.requestVideoFrameCallback(() => r())), App.util.sleep(250)]);
    }

    async function capture(p, t) {
        const src = await App.fs.url(p);
        const v = document.createElement('video');
        v.muted = true;
        v.playsInline = true;
        v.preload = 'auto';
        try {
            const meta = waitEvent(v, 'loadedmetadata', 12000);
            v.src = src.url;
            await meta;
            if (!v.videoWidth || !v.videoHeight) throw Object.assign(new Error('no video track'), { decode: true });
            let at = Math.max(0, Number(t) || 0);
            if (isFinite(v.duration) && v.duration > 0) at = Math.min(at, Math.max(0, v.duration - 0.05));
            // Seeking exactly to 0 doesn't always fire 'seeked'; nudge it
            const seeked = waitEvent(v, 'seeked', 9000);
            v.currentTime = at || 0.001;
            await seeked;
            if (v.readyState < 2) await Promise.race([waitEvent(v, 'loadeddata', 3000).catch(() => {}), App.util.sleep(3000)]);
            await painted(v);
            const s = W / v.videoWidth;
            const cw = W;
            const ch = Math.max(1, Math.round(v.videoHeight * s));
            const canvas = document.createElement('canvas');
            canvas.width = cw;
            canvas.height = ch;
            const g = canvas.getContext('2d');
            g.drawImage(v, 0, 0, cw, ch);
            const blob = await new Promise((r) => canvas.toBlob(r, 'image/webp', 0.82));
            if (!blob || blob.size < 64) throw new Error('empty frame');
            return blob;
        } finally {
            try {
                v.removeAttribute('src');
                v.load();
            } catch (e) {
                /* ignore */
            }
            src.release?.();
        }
    }

    async function probeCodec(p) {
        const S = App.server;
        if (!S?.available || !S.backend || typeof S.media?.probe !== 'function') return;
        try {
            const d = await S.media.probe(p);
            if (d?.vcodec) codecs.set(p, String(d.vcodec).toUpperCase().replace(/^H265$/, 'HEVC'));
        } catch (e) {
            /* keep the extension */
        }
    }

    async function get(p, t, { signal } = {}) {
        const direct = serverFrame(p, t);
        if (direct) return remember(`srv|${p}|${tKey(t)}`, { url: direct, server: true });
        const version = await versionOf(p);
        const ws = wsKey();
        const key = `${ws}|${p}|${version || "?"}|${tKey(t)}`;
        if (mem.has(key)) {
            counters.hits++;
            return mem.get(key);
        }
        if (!App.util.browserCanDecode(P.base(p))) {
            await probeCodec(p);
            return remember(key, { failed: true, label: label(p) });
        }
        if (inflight.has(key)) return inflight.get(key);
        const task = (async () => {
            if (version) {
                try {
                    const hit = await store.get(key);
                    if (hit) {
                        counters.hits++;
                        if (hit.failed) return remember(key, { failed: true, label: hit.label || label(p) });
                        if (hit instanceof Blob) return remember(key, { url: URL.createObjectURL(hit) });
                    }
                } catch (e) {
                    /* cache unavailable */
                }
            }
            try {
                const blob = await enqueue(() => (wsKey() === ws ? capture(p, t) : Promise.reject(Object.assign(new Error("workspace changed"), { aborted: true }))), signal);
                if (wsKey() !== ws) throw Object.assign(new Error("workspace changed"), { aborted: true });
                counters.captures++;
                if (version) store.set(key, blob).catch(() => {});
                return remember(key, { url: URL.createObjectURL(blob) });
            } catch (e) {
                if (e.aborted) throw e;
                counters.failures++;
                if (e.decode) {
                    await probeCodec(p);
                    const value = { failed: true, label: label(p) };
                    if (version) store.set(key, value).catch(() => {});
                    return remember(key, value);
                }
                // Timeouts / transient errors: show the placeholder now, try again next session
                return remember(key, { failed: true, label: label(p), transient: true });
            }
        })();
        inflight.set(key, task);
        try {
            return await task;
        } finally {
            inflight.delete(key);
        }
    }

    function peek(p, t) {
        const direct = serverFrame(p, t);
        if (direct) return { url: direct, server: true };
        const e = entryOf(p);
        if (!e) return null;
        return mem.get(`${wsKey()}|${p}|${e.size ?? 0}|${e.mtime ?? 0}|${tKey(t)}`) || null;
    }

    App.register('clips-frames', {
        init() {
            const reset = () => {
                for (const job of queue.splice(0)) job.reject(Object.assign(new Error('workspace changed'), { aborted: true }));
                for (const v of mem.values()) if (v.url && v.url.startsWith('blob:')) URL.revokeObjectURL(v.url);
                mem.clear();
                codecs.clear();
            };
            App.bus.on('workspace:closed', reset);
            App.bus.on('workspace:opened', reset);
        },
    });

    App.clipsFrames = { get, peek, label, stats: () => ({ ...counters, queued: queue.length, active }) };
})();
