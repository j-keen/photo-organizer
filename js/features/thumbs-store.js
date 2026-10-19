/*
 * Thumbnail persistence (thumbs team) — App.thumbStore. Used by js/features/thumbs.js; other modules should use App.thumbs.
 *
 *   idb   IndexedDB blob store with byte accounting and LRU eviction. Limit = setting 'thumbs.cacheLimitMB' (default 1024).
 *         Reads are batched into one transaction per tick, writes are batched, access times are written lazily.
 *   disk  Write-behind copy in <workspace>/.fluid-organizer/thumbs/v2/<hh>/<hash>.webp so thumbnails survive a browser
 *         reinstall (they live next to the photos). Read when IndexedDB misses. Setting 'thumbs.diskCache' (default on).
 *
 * Keys are opaque strings built by thumbs.js (name|size|mtime|thumb size...). They never contain folder paths, so moving
 * a file keeps its thumbnail.
 */
(() => {
    'use strict';

    const DB_NAME = 'fluid-identity-thumbs-v2';
    const LEGACY_DB = 'fluid-identity-thumbs'; // round-0 store (no accounting) — deleted once
    const DISK_DIR = '.fluid-organizer/thumbs/v2';
    const DEFAULT_LIMIT_MB = 1024;
    const WRITE_BATCH = 24;
    const WRITE_DELAY = 250;
    const TOUCH_DELAY = 4000;
    const DISK_QUEUE_MAX = 6000;
    const QUIET_MS = 1200; // disk writes wait until the user and the file system have been quiet this long
    const BACKGROUND_JOB_TITLES = new Set(['라이브러리 색인 중']);

    // Disk writes share the file system with what the user is doing: only write while nothing else is going on
    let lastBusy = 0;
    const markBusy = () => {
        lastBusy = performance.now();
    };
    for (const ev of ['pointerdown', 'keydown', 'wheel']) window.addEventListener(ev, markBusy, { capture: true, passive: true });
    for (const ev of ['folder:loading', 'fs:changed', 'workspace:opened']) App.bus.on(ev, markBusy);

    function quietFor() {
        if (App.jobs && App.jobs.list().some((j) => !j.background && !BACKGROUND_JOB_TITLES.has(j.title))) {
            markBusy();
            return 0;
        }
        return performance.now() - lastBusy;
    }

    // 64-bit string hash (cyrb53 mixing, both halves kept) -> 16 hex chars. Used for on-disk file names.
    function hash64(str) {
        let h1 = 0xdeadbeef;
        let h2 = 0x41c6ce57;
        for (let i = 0; i < str.length; i++) {
            const ch = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
    }

    function limitBytes() {
        const mb = Number(App.settings.get('thumbs.cacheLimitMB', DEFAULT_LIMIT_MB));
        return (isFinite(mb) && mb > 0 ? mb : DEFAULT_LIMIT_MB) * 1024 * 1024;
    }

    const emitStats = App.util.throttle(() => App.bus.emit('thumbs:stats'), 400);

    function txDone(tx) {
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
        });
    }

    // ---------- IndexedDB ----------
    let dbPromise = null;
    let disabled = false; // IndexedDB unavailable (private mode, blocked...) -> memory + disk only

    function openDb() {
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
                let req;
                try {
                    req = indexedDB.open(DB_NAME, 1);
                } catch (e) {
                    reject(e);
                    return;
                }
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
                    if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' }).createIndex('at', 'at');
                };
                req.onsuccess = () => {
                    const db = req.result;
                    db.onversionchange = () => {
                        db.close();
                        dbPromise = null;
                    };
                    resolve(db);
                };
                req.onerror = () => reject(req.error);
                req.onblocked = () => reject(new Error('IndexedDB blocked'));
            }).catch((e) => {
                console.warn('[thumbs] IndexedDB unavailable, using memory + disk cache only', e && e.message);
                disabled = true;
                throw e;
            });
        }
        return dbPromise;
    }

    let known = null; // Map key -> bytes (0 for failure records); null until the key list is loaded
    const failed = new Set(); // keys whose source could not be decoded (persisted; retried when the file changes)
    const pendingKnown = new Map(); // accounted while the key list was still loading
    const unsettled = new Map(); // key -> { blob, fail } queued or in flight (visible to get/has right away)
    let bytes = 0;
    let loading = null;

    function load() {
        if (!loading) {
            loading = (async () => {
                const db = await openDb();
                const tx = db.transaction('meta', 'readonly');
                const req = tx.objectStore('meta').getAll();
                await txDone(tx);
                const map = new Map();
                let total = 0;
                for (const r of req.result || []) {
                    map.set(r.k, r.b || 0);
                    total += r.b || 0;
                    if (r.f) failed.add(r.k);
                }
                for (const [k, b] of pendingKnown) {
                    total += b - (map.get(k) || 0);
                    map.set(k, b);
                }
                pendingKnown.clear();
                known = map;
                bytes = total;
                emitStats();
                if (bytes > limitBytes()) idb.evict();
            })().catch(() => {
                known = new Map();
                bytes = 0;
            });
        }
        return loading;
    }

    function account(key, size, isFail) {
        if (isFail) failed.add(key);
        else failed.delete(key);
        if (!known) {
            pendingKnown.set(key, size);
            return;
        }
        bytes += size - (known.get(key) || 0);
        known.set(key, size);
    }

    // ----- batched reads -----
    let readBatch = null; // Map key -> [resolve]

    function flushReads() {
        const batch = readBatch;
        readBatch = null;
        const settle = (k, v) => {
            for (const fn of batch.get(k) || []) fn(v);
            batch.delete(k);
        };
        openDb()
            .then((db) => {
                const tx = db.transaction('blobs', 'readonly');
                const st = tx.objectStore('blobs');
                for (const k of batch.keys()) {
                    const r = st.get(k);
                    r.onsuccess = () => {
                        const v = r.result instanceof Blob ? r.result : null;
                        if (v) touch(k);
                        settle(k, v);
                    };
                }
                return txDone(tx);
            })
            .catch(() => {})
            .finally(() => {
                for (const k of [...batch.keys()]) settle(k, null);
            });
    }

    // ----- batched writes -----
    let writeQueue = []; // keys waiting for the next transaction
    let writeTimer = null;
    let writing = Promise.resolve();

    function scheduleWrites() {
        if (writeQueue.length >= WRITE_BATCH) {
            clearTimeout(writeTimer);
            writeTimer = null;
            flushWrites();
        } else if (!writeTimer) {
            writeTimer = setTimeout(() => {
                writeTimer = null;
                flushWrites();
            }, WRITE_DELAY);
        }
    }

    function flushWrites() {
        const keys = [...new Set(writeQueue)];
        writeQueue = [];
        const batch = new Map();
        for (const k of keys) if (unsettled.has(k)) batch.set(k, unsettled.get(k));
        if (!batch.size) return writing;
        writing = writing.then(() => writeBatchNow(batch, true)).catch(() => {});
        return writing;
    }

    async function writeBatchNow(batch, retry) {
        let ok = false;
        try {
            const db = await openDb();
            const now = Date.now();
            const tx = db.transaction(['blobs', 'meta'], 'readwrite');
            const bs = tx.objectStore('blobs');
            const ms = tx.objectStore('meta');
            for (const [k, { blob, fail }] of batch) {
                if (fail) {
                    bs.delete(k);
                    ms.put({ k, b: 0, at: now, f: 1 });
                } else {
                    bs.put(blob, k);
                    ms.put({ k, b: blob.size, at: now });
                }
            }
            await txDone(tx);
            ok = true;
        } catch (e) {
            if (retry && e && e.name === 'QuotaExceededError') {
                await idb.evict(Math.min(limitBytes(), bytes) * 0.5);
                return writeBatchNow(batch, false);
            }
            if (!disabled) console.warn('[thumbs] cache write failed', e && e.name);
        } finally {
            for (const [k, entry] of batch) {
                if (unsettled.get(k) === entry) unsettled.delete(k);
            }
        }
        if (!ok) return;
        for (const [k, { blob, fail }] of batch) account(k, fail ? 0 : blob.size, fail);
        emitStats();
        if (known && bytes > limitBytes()) idb.evict();
    }

    // ----- lazy access-time updates (LRU order) -----
    const touched = new Set();
    let touchTimer = null;

    function touch(k) {
        touched.add(k);
        if (!touchTimer) touchTimer = setTimeout(flushTouches, TOUCH_DELAY);
    }

    async function flushTouches() {
        clearTimeout(touchTimer);
        touchTimer = null;
        const keys = [...touched];
        touched.clear();
        if (!keys.length || disabled) return;
        try {
            const db = await openDb();
            const now = Date.now();
            const tx = db.transaction('meta', 'readwrite');
            const ms = tx.objectStore('meta');
            for (const k of keys) {
                const r = ms.get(k);
                r.onsuccess = () => {
                    if (r.result) {
                        r.result.at = now;
                        ms.put(r.result);
                    }
                };
            }
            await txDone(tx);
        } catch (e) {
            /* best effort */
        }
    }

    let evicting = null;

    const idb = {
        get enabled() {
            return !disabled;
        },
        load,

        /** Synchronous: true/false once the key list is loaded, null while still unknown. */
        has(key) {
            if (unsettled.has(key)) return !unsettled.get(key).fail;
            if (disabled) return false;
            if (!known) return null;
            return known.has(key) && !failed.has(key);
        },

        isFailed(key) {
            return failed.has(key);
        },

        /** Blob or null. Batched: every get issued in the same tick shares one transaction. */
        get(key) {
            const pending = unsettled.get(key);
            if (pending) return Promise.resolve(pending.fail ? null : pending.blob);
            if (disabled || failed.has(key) || (known && !known.has(key))) return Promise.resolve(null);
            return new Promise((resolve) => {
                if (!readBatch) {
                    readBatch = new Map();
                    setTimeout(flushReads, 0);
                }
                if (!readBatch.has(key)) readBatch.set(key, []);
                readBatch.get(key).push(resolve);
            });
        },

        put(key, blob) {
            if (!(blob instanceof Blob)) return;
            failed.delete(key);
            if (disabled) return;
            unsettled.set(key, { blob, fail: false });
            writeQueue.push(key);
            scheduleWrites();
        },

        /** Remember that this source can't be decoded (until its size/mtime change, which changes the key). */
        markFailed(key) {
            failed.add(key);
            if (disabled) return;
            unsettled.set(key, { blob: null, fail: true });
            writeQueue.push(key);
            scheduleWrites();
        },

        async del(keys) {
            keys = [...keys];
            for (const k of keys) {
                unsettled.delete(k);
                failed.delete(k);
            }
            if (disabled || !keys.length) return;
            await load();
            try {
                const db = await openDb();
                const tx = db.transaction(['blobs', 'meta'], 'readwrite');
                for (const k of keys) {
                    tx.objectStore('blobs').delete(k);
                    tx.objectStore('meta').delete(k);
                }
                await txDone(tx);
                for (const k of keys) {
                    bytes -= known.get(k) || 0;
                    known.delete(k);
                }
                emitStats();
            } catch (e) {
                /* ignore */
            }
        },

        /** Evict least-recently-used entries until the store holds at most `target` bytes (default 90% of the limit). */
        evict(target) {
            if (evicting) return evicting;
            evicting = (async () => {
                await load();
                const goal = target ?? limitBytes() * 0.9;
                if (disabled || bytes <= goal) return 0;
                const db = await openDb();
                const removed = [];
                let freed = 0;
                const tx = db.transaction(['blobs', 'meta'], 'readwrite');
                const bs = tx.objectStore('blobs');
                const cursorReq = tx.objectStore('meta').index('at').openCursor();
                cursorReq.onsuccess = () => {
                    const c = cursorReq.result;
                    if (!c || bytes - freed <= goal) return;
                    const r = c.value;
                    bs.delete(r.k);
                    c.delete();
                    freed += r.b || 0;
                    removed.push(r.k);
                    c.continue();
                };
                await txDone(tx);
                for (const k of removed) {
                    known.delete(k);
                    failed.delete(k);
                }
                bytes -= freed;
                emitStats();
                return freed;
            })()
                .catch(() => 0)
                .finally(() => {
                    evicting = null;
                });
            return evicting;
        },

        async clear() {
            writeQueue = [];
            clearTimeout(writeTimer);
            writeTimer = null;
            unsettled.clear();
            failed.clear();
            pendingKnown.clear();
            if (disabled) return 0;
            const before = bytes;
            try {
                await writing;
                const db = await openDb();
                const tx = db.transaction(['blobs', 'meta'], 'readwrite');
                tx.objectStore('blobs').clear();
                tx.objectStore('meta').clear();
                await txDone(tx);
            } catch (e) {
                console.warn('[thumbs] clearing the cache failed', e && e.message);
            }
            known = new Map();
            bytes = 0;
            emitStats();
            return before;
        },

        /** Write everything queued now (resolves when it's in IndexedDB). */
        flush() {
            clearTimeout(writeTimer);
            writeTimer = null;
            flushWrites();
            return writing;
        },

        usage() {
            return { count: known ? Math.max(0, known.size - failed.size) : 0, bytes, limit: limitBytes(), loaded: !!known, enabled: !disabled };
        },
    };

    // ---------- On-disk cache in the workspace ----------
    const disk = {
        index: null, // Set of hashes present on disk for the current workspace (null until listed)
        indexing: null,
        queue: new Map(), // hash -> { path, blob, backend }
        active: 0,
        broken: false, // writes failed hard (no permission / quota) -> off for this session
        token: 0,
        written: 0,
        timer: null,
        forced: false,

        get enabled() {
            const b = App.fs.backend;
            return !!b && !disk.broken && typeof b.write === 'function' && typeof b.thumbUrl !== 'function' && App.settings.get('thumbs.diskCache', true) !== false;
        },

        locate(key) {
            const hash = hash64(key);
            return { hash, path: `${DISK_DIR}/${hash.slice(0, 2)}/${hash}.webp` };
        },

        /** List what's already on disk (once per workspace, in the background). */
        loadIndex() {
            if (disk.indexing) return disk.indexing;
            const token = disk.token;
            const backend = App.fs.backend;
            disk.indexing = (async () => {
                const found = new Set();
                if (backend && disk.enabled) {
                    let shards = [];
                    try {
                        shards = await backend.list(DISK_DIR, { stat: false });
                    } catch (e) {
                        /* no cache yet */
                    }
                    for (const s of shards) {
                        if (s.kind !== 'dir' || token !== disk.token) continue;
                        try {
                            for (const f of await backend.list(`${DISK_DIR}/${s.name}`, { stat: false })) {
                                if (f.kind === 'file' && f.name.endsWith('.webp')) found.add(f.name.slice(0, -5));
                            }
                        } catch (e) {
                            /* skip shard */
                        }
                    }
                }
                if (token !== disk.token) return;
                for (const h of disk.queue.keys()) found.add(h);
                disk.index = found;
                emitStats();
            })();
            return disk.indexing;
        },

        /** true/false once the listing is known, null while unknown. */
        has(key) {
            if (!disk.enabled) return false;
            if (!disk.index) return null;
            return disk.index.has(disk.locate(key).hash);
        },

        async read(key) {
            if (!disk.enabled) return null;
            const { hash, path } = disk.locate(key);
            const queued = disk.queue.get(hash);
            if (queued) return queued.blob;
            // One listing answers every miss; probing paths one by one would compete with what the user is opening
            if (!disk.index) await disk.loadIndex();
            if (!disk.enabled || !disk.index || !disk.index.has(hash)) return null;
            try {
                const file = await App.fs.backend.getFile(path);
                if (!file.size) return null;
                // Copy into memory: an object URL of the on-disk file would break if the cache is cleared later
                return new Blob([await file.arrayBuffer()], { type: 'image/webp' });
            } catch (e) {
                if (disk.index) disk.index.delete(hash);
                return null;
            }
        },

        /** Forget a cached file so the next write replaces it (used by "썸네일 다시 만들기"). */
        forget(key) {
            const { hash } = disk.locate(key);
            disk.queue.delete(hash);
            if (disk.index) disk.index.delete(hash);
        },

        write(key, blob) {
            if (!disk.enabled || !(blob instanceof Blob)) return;
            const { hash, path } = disk.locate(key);
            if (disk.index && disk.index.has(hash) && !disk.queue.has(hash)) return;
            if (disk.queue.size >= DISK_QUEUE_MAX) return; // written next time instead
            disk.queue.set(hash, { path, blob, backend: App.fs.backend });
            if (disk.index) disk.index.add(hash);
            disk.pump();
        },

        // One write at a time, only while things are quiet (write-behind: losing the queue on close costs nothing)
        pump() {
            if (disk.active || !disk.queue.size || disk.timer) return;
            const wait = disk.forced ? 0 : QUIET_MS - quietFor();
            if (wait > 0) {
                disk.timer = setTimeout(() => {
                    disk.timer = null;
                    disk.pump();
                }, Math.max(60, wait));
                return;
            }
            const [hash, job] = disk.queue.entries().next().value;
            disk.queue.delete(hash);
            if (job.backend !== App.fs.backend) {
                disk.pump(); // workspace changed meanwhile
                return;
            }
            disk.active++;
            Promise.resolve()
                .then(() => job.backend.write(job.path, job.blob))
                .then(() => {
                    disk.written++;
                })
                .catch((e) => {
                    if (disk.index) disk.index.delete(hash);
                    if (e && (e.name === 'NotAllowedError' || e.name === 'QuotaExceededError' || e.name === 'SecurityError')) {
                        disk.broken = true;
                        disk.queue.clear();
                        console.warn('[thumbs] disk cache disabled for this session:', e.name);
                    }
                })
                .finally(() => {
                    disk.active--;
                    if (disk.queue.size) setTimeout(() => disk.pump(), 4);
                    else emitStats();
                });
        },

        /** Write everything queued now, ignoring the quiet-time rule (tests, before clearing). */
        async drain(timeout = 15000) {
            const t0 = Date.now();
            disk.forced = true;
            clearTimeout(disk.timer);
            disk.timer = null;
            try {
                disk.pump();
                while ((disk.queue.size || disk.active) && Date.now() - t0 < timeout) {
                    if (!disk.active && !disk.timer) disk.pump();
                    await App.util.sleep(30);
                }
            } finally {
                disk.forced = false;
            }
        },

        async clear() {
            disk.queue.clear();
            const count = disk.index ? disk.index.size : 0;
            disk.index = new Set();
            const b = App.fs.backend;
            if (b) {
                await disk.drain(3000);
                try {
                    await b.remove(DISK_DIR);
                } catch (e) {
                    /* nothing there */
                }
            }
            emitStats();
            return count;
        },

        reset() {
            disk.token++;
            disk.index = null;
            disk.indexing = null;
            disk.queue.clear();
            disk.broken = false;
            clearTimeout(disk.timer);
            disk.timer = null;
        },

        usage() {
            return { count: disk.index ? disk.index.size : 0, loaded: !!disk.index, enabled: disk.enabled, queued: disk.queue.size, dir: DISK_DIR };
        },
    };

    App.bus.on('workspace:opened', () => {
        disk.reset();
        disk.loadIndex();
    });
    App.bus.on('workspace:closed', () => disk.reset());
    App.bus.on('settings:changed', ({ key }) => {
        if (key === 'thumbs.cacheLimitMB') {
            idb.evict();
            emitStats();
        } else if (key === 'thumbs.diskCache') {
            disk.reset();
            if (App.fs.ready) disk.loadIndex();
            emitStats();
        }
    });

    // Run fn once the user and the file system have been quiet for `ms` (startup work stays out of the way).
    function whenQuiet(fn, ms = QUIET_MS) {
        const check = () => {
            const q = quietFor();
            if (q >= ms) fn();
            else setTimeout(check, ms - q + 30);
        };
        setTimeout(check, ms);
    }

    // Load the key list (fast "is it cached?" answers) and drop the round-0 database if this browser still has it.
    whenQuiet(() => {
        load();
        try {
            if (typeof indexedDB.databases === 'function') {
                indexedDB
                    .databases()
                    .then((list) => {
                        if (list.some((d) => d.name === LEGACY_DB)) indexedDB.deleteDatabase(LEGACY_DB);
                    })
                    .catch(() => {});
            }
        } catch (e) {
            /* ignore */
        }
    });

    window.addEventListener('pagehide', () => {
        idb.flush();
        flushTouches();
    });

    App.thumbStore = { idb, disk, hash64, DISK_DIR, limitBytes };
})();
