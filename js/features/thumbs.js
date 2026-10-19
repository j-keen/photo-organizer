/*
 * Thumbnails.
 *   App.thumbs.get(entry, { size }) -> Promise<url|null>  (object URL owned by the cache — never revoke it)
 *   App.thumbs.peek(entry)          -> url|null synchronously when already in memory
 *   App.thumbs.prioritize(paths)    -> move queued requests for these paths to the front
 * Cache: memory LRU of object URLs + IndexedDB blobs keyed by name|size|mtime (survives reloads and renames).
 * Video thumbnails grab a frame at ~10% (max 3s) and record duration/size via App.catalog.setMeta.
 */
(() => {
    'use strict';
    const { path: P } = App.util;
    const DEFAULT_SIZE = 360;
    const MEM_LIMIT = 1500;

    const store = App.idb.store('fluid-identity-thumbs', 'thumbs');
    const mem = new Map(); // key -> url (insertion order = LRU)
    const pending = new Map(); // key -> Promise
    const queue = []; // { key, entry, size, resolve }
    let running = { image: 0, video: 0 };
    const LIMIT = { image: 4, video: 2 };

    function keyOf(entry, size) {
        return `${entry.name}|${entry.size ?? 0}|${entry.mtime ?? 0}|${size}`;
    }

    function remember(key, url) {
        if (mem.has(key)) mem.delete(key);
        mem.set(key, url);
        while (mem.size > MEM_LIMIT) {
            const [oldKey, oldUrl] = mem.entries().next().value;
            mem.delete(oldKey);
            URL.revokeObjectURL(oldUrl);
        }
    }

    async function makeImageThumb(entry, size) {
        const file = await App.fs.getFile(entry.path);
        const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
        const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const hgt = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = new OffscreenCanvas(w, hgt);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0, w, hgt);
        App.catalog.setMeta(entry.path, { w: bitmap.width, h: bitmap.height });
        bitmap.close();
        return canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
    }

    function makeVideoThumb(entry, size) {
        return new Promise(async (resolve, reject) => {
            let src;
            try {
                src = await App.fs.url(entry.path);
            } catch (e) {
                reject(e);
                return;
            }
            const video = document.createElement('video');
            video.muted = true;
            video.preload = 'auto';
            video.playsInline = true;
            let done = false;
            const finish = (err, blob) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                video.removeAttribute('src');
                video.load();
                src.release();
                err ? reject(err) : resolve(blob);
            };
            const timer = setTimeout(() => finish(new Error('video thumbnail timeout')), 15000);
            video.onerror = () => finish(new Error('video decode failed'));
            video.onloadedmetadata = () => {
                App.catalog.setMeta(entry.path, { w: video.videoWidth, h: video.videoHeight, duration: video.duration });
                App.bus.emit('thumbs:meta', { path: entry.path, duration: video.duration });
                video.currentTime = Math.min(3, (video.duration || 0) * 0.1);
            };
            video.onseeked = () => {
                try {
                    const scale = Math.min(1, size / Math.max(video.videoWidth, video.videoHeight));
                    const w = Math.max(1, Math.round(video.videoWidth * scale));
                    const hgt = Math.max(1, Math.round(video.videoHeight * scale));
                    const canvas = new OffscreenCanvas(w, hgt);
                    canvas.getContext('2d').drawImage(video, 0, 0, w, hgt);
                    canvas.convertToBlob({ type: 'image/webp', quality: 0.8 }).then((b) => finish(null, b), finish);
                } catch (e) {
                    finish(e);
                }
            };
            video.src = src.url;
        });
    }

    function pump() {
        for (let i = 0; i < queue.length; i++) {
            const job = queue[i];
            const kind = job.entry.type === 'video' ? 'video' : 'image';
            if (running[kind] >= LIMIT[kind]) continue;
            queue.splice(i, 1);
            i--;
            running[kind]++;
            const maker = kind === 'video' ? makeVideoThumb : makeImageThumb;
            maker(job.entry, job.size)
                .then(async (blob) => {
                    if (!blob) return job.resolve(null);
                    store.set(job.key, blob).catch(() => {});
                    const url = URL.createObjectURL(blob);
                    remember(job.key, url);
                    job.resolve(url);
                })
                .catch((e) => {
                    console.debug('[thumbs] failed', job.entry.path, e.message);
                    job.resolve(null);
                })
                .finally(() => {
                    running[kind]--;
                    pending.delete(job.key);
                    pump();
                });
        }
    }

    const thumbs = {
        canThumb(entry) {
            return entry.kind === 'file' && App.util.browserCanDecode(entry.name);
        },

        peek(entry, size = DEFAULT_SIZE) {
            return mem.get(keyOf(entry, size)) || null;
        },

        get(entry, { size = DEFAULT_SIZE } = {}) {
            if (!thumbs.canThumb(entry)) return Promise.resolve(null);
            const key = keyOf(entry, size);
            const hit = mem.get(key);
            if (hit) {
                remember(key, hit);
                return Promise.resolve(hit);
            }
            if (pending.has(key)) return pending.get(key);
            const promise = (async () => {
                try {
                    const blob = await store.get(key);
                    if (blob) {
                        const url = URL.createObjectURL(blob);
                        remember(key, url);
                        return url;
                    }
                } catch (e) {
                    /* cache unavailable */
                }
                return new Promise((resolve) => {
                    queue.push({ key, entry, size, resolve });
                    pump();
                });
            })();
            pending.set(key, promise);
            promise.finally(() => {
                if (mem.has(key)) pending.delete(key);
            });
            return promise;
        },

        prioritize(paths) {
            const set = new Set(paths);
            queue.sort((a, b) => (set.has(b.entry.path) ? 1 : 0) - (set.has(a.entry.path) ? 1 : 0));
        },

        // Drop queued work for paths no longer on screen
        cancelExcept(paths) {
            const keep = new Set(paths);
            for (let i = queue.length - 1; i >= 0; i--) {
                if (!keep.has(queue[i].entry.path)) {
                    pending.delete(queue[i].key);
                    queue[i].resolve(null);
                    queue.splice(i, 1);
                }
            }
        },

        async clearCache() {
            await store.clear();
            for (const url of mem.values()) URL.revokeObjectURL(url);
            mem.clear();
        },

        stats() {
            return { memory: mem.size, queued: queue.length, running: running.image + running.video };
        },
    };

    // When a file's content changes in place (e.g. rotation), forget its cached thumbnails
    App.bus.on('fs:changed', (c) => {
        if (c.type !== 'modify') return;
        for (const p of c.paths) {
            const name = P.base(p);
            for (const k of [...mem.keys()]) {
                if (k.startsWith(name + '|')) {
                    URL.revokeObjectURL(mem.get(k));
                    mem.delete(k);
                }
            }
        }
    });

    App.thumbs = thumbs;
})();
