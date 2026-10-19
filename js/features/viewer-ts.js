/*
 * MPEG-TS playback (.ts / .m2ts / .mts) through the vendored mpegts.js (transmux to fMP4 + MSE).
 * Ported from v1's playTsFile, but streams the file in 1 MiB slices instead of reading it all into memory.
 * TS has no index, so we estimate the duration from the first/last video PTS and seek outside the buffered
 * range by restarting the transmuxer at a proportional byte offset.
 *
 *   App.viewer.ts.isTs(entry), supported(), attach(video, file) -> controller
 *   controller: { duration, time, buffered(t), seek(t), destroy(), onerror }
 */
(() => {
    'use strict';
    const V = App.viewer;
    const CHUNK = 1 << 20;
    const PTS_HZ = 90000;
    const PTS_WRAP = 2 ** 33;

    function detectPacketSize(u8) {
        for (const size of [188, 192, 204]) {
            const limit = Math.min(1200, u8.length - 3 * size);
            for (let s = 0; s < limit; s++) {
                if (u8[s] === 0x47 && u8[s + size] === 0x47 && u8[s + 2 * size] === 0x47) return { size, sync: s };
            }
        }
        return null;
    }

    /** First (and optionally last) video PTS in a buffer of TS packets, in 90 kHz ticks. */
    function scanPts(u8, { last = false } = {}) {
        const det = detectPacketSize(u8);
        if (!det) return null;
        const { size } = det;
        let first = null;
        let lastPts = null;
        let p = det.sync;
        while (p + 188 <= u8.length) {
            if (u8[p] !== 0x47) {
                // lost sync (corrupt data): look for the next packet start
                let q = p + 1;
                while (q + 2 * size < u8.length && !(u8[q] === 0x47 && u8[q + size] === 0x47)) q++;
                if (q + 2 * size >= u8.length) break;
                p = q;
                continue;
            }
            const pusi = (u8[p + 1] & 0x40) !== 0;
            const afc = (u8[p + 3] >> 4) & 0x3;
            if (pusi && afc !== 2 && afc !== 0) {
                let q = p + 4;
                if (afc === 3) q += 1 + u8[p + 4];
                if (q + 14 <= p + 188 && u8[q] === 0 && u8[q + 1] === 0 && u8[q + 2] === 1) {
                    const sid = u8[q + 3];
                    if (sid >= 0xe0 && sid <= 0xef && u8[q + 7] & 0x80) {
                        const b = q + 9;
                        const pts = ((u8[b] >> 1) & 0x07) * 1073741824 + ((u8[b + 1] << 7) | (u8[b + 2] >> 1)) * 32768 + ((u8[b + 3] << 7) | (u8[b + 4] >> 1));
                        if (first == null) {
                            first = pts;
                            if (!last) break;
                        }
                        lastPts = pts;
                    }
                }
            }
            p += size;
        }
        return first == null ? null : { first, last: lastPts ?? first };
    }

    async function readSlice(file, from, len) {
        return new Uint8Array(await file.slice(Math.max(0, from), Math.min(file.size, from + len)).arrayBuffer());
    }

    /** { firstPts, duration (s) } or null when no video PTS is found. */
    async function probe(file) {
        const head = scanPts(await readSlice(file, 0, 2 * CHUNK));
        if (!head) return null;
        const tail = scanPts(await readSlice(file, file.size - 2 * CHUNK, 2 * CHUNK), { last: true });
        let d = (tail ? tail.last : head.last) - head.first;
        if (d < 0) d += PTS_WRAP;
        return { firstPts: head.first, duration: d / PTS_HZ };
    }

    function supported() {
        try {
            return !!(window.mpegts && window.mpegts.isSupported() && window.mpegts.BaseLoader);
        } catch (e) {
            return false;
        }
    }

    // mpegts.js loader that reads a File from byte `base` in 1 MiB slices (supports range re-opens on seek/pause).
    function makeLoaderClass(file, base) {
        const Base = window.mpegts.BaseLoader;
        return class FileSliceLoader extends Base {
            constructor() {
                super('fi-file-slice-loader');
                this._needStash = true;
                this._requestAbort = false;
            }

            static isSupported() {
                return true;
            }

            open(dataSource, range) {
                this._requestAbort = false;
                this._status = 1; // kConnecting
                const from = base + (range && range.from > 0 ? range.from : 0);
                const end = range && range.to >= 0 ? Math.min(file.size, base + range.to + 1) : file.size;
                if (this._onContentLengthKnown) this._onContentLengthKnown(end - from);
                this._pump(from, end, range && range.from > 0 ? range.from : 0);
            }

            async _pump(from, end, rangeFrom) {
                let pos = from;
                let received = 0;
                while (pos < end) {
                    if (this._requestAbort) {
                        this._status = 4; // kComplete
                        return;
                    }
                    const next = Math.min(end, pos + CHUNK);
                    let buf;
                    try {
                        buf = await file.slice(pos, next).arrayBuffer();
                    } catch (e) {
                        this._status = 3; // kError
                        if (this._onError) this._onError('Exception', { code: -1, msg: e.message });
                        return;
                    }
                    if (this._requestAbort) {
                        this._status = 4;
                        return;
                    }
                    this._status = 2; // kBuffering
                    const byteStart = rangeFrom + received;
                    received += buf.byteLength;
                    pos = next;
                    if (this._onDataArrival) this._onDataArrival(buf, byteStart, received);
                    // yield so the transmuxer and UI stay responsive
                    await new Promise((r) => setTimeout(r, 0));
                }
                this._status = 4;
                if (this._onComplete) this._onComplete(rangeFrom, rangeFrom + received - 1);
            }

            abort() {
                this._requestAbort = true;
                this._status = 4;
            }
        };
    }

    async function attach(video, file) {
        if (!supported()) throw new Error('이 브라우저는 TS 재생(MSE)을 지원하지 않아요');
        const info = await probe(file).catch(() => null);
        const ctl = {
            video,
            file,
            info,
            offset: 0, // seconds of the file before the current transmux start
            player: null,
            destroyed: false,
            restarting: false,
            onerror: null,
            get duration() {
                const native = isFinite(video.duration) ? video.duration + ctl.offset : 0;
                return Math.max(info ? info.duration : 0, native);
            },
            get time() {
                return ctl.offset + (video.currentTime || 0);
            },
            buffered(t) {
                const local = t - ctl.offset;
                const b = video.buffered;
                for (let i = 0; i < b.length; i++) if (local >= b.start(i) - 0.05 && local <= b.end(i) + 0.05) return true;
                return false;
            },
            async seek(t) {
                if (ctl.destroyed) return;
                t = Math.max(0, t);
                if (ctl.buffered(t) || !info || !info.duration) {
                    video.currentTime = Math.max(0, t - ctl.offset);
                    return;
                }
                // Outside what has been transmuxed: restart near the target byte position
                const size = file.size;
                let pos = Math.floor((Math.min(t, info.duration) / info.duration) * size);
                pos = Math.max(0, Math.min(size - CHUNK / 4, pos - CHUNK / 2));
                let at = await ptsSeconds(pos);
                if (at != null && at > t + 0.5 && pos > 0) {
                    pos = Math.max(0, pos - Math.floor(((at - t) / info.duration) * size) - CHUNK / 2);
                    at = await ptsSeconds(pos);
                }
                if (at == null) at = (pos / size) * info.duration;
                await start(pos, at, Math.max(0, t - at), !video.paused);
            },
            destroy() {
                ctl.destroyed = true;
                teardown();
            },
        };

        async function ptsSeconds(pos) {
            const r = scanPts(await readSlice(file, pos, CHUNK));
            if (!r || !info) return null;
            let d = r.first - info.firstPts;
            if (d < 0) d += PTS_WRAP;
            return d / PTS_HZ;
        }

        function teardown() {
            const p = ctl.player;
            ctl.player = null;
            if (!p) return;
            try {
                p.pause();
                p.unload();
                p.detachMediaElement();
                p.destroy();
            } catch (e) {
                /* already gone */
            }
        }

        async function start(pos, offsetSec, localTarget, resume) {
            teardown();
            if (ctl.destroyed) return;
            ctl.offset = offsetSec;
            const mpegts = window.mpegts;
            mpegts.LoggingControl.enableVerbose = false;
            mpegts.LoggingControl.enableAll = false;
            const player = mpegts.createPlayer(
                { type: 'mpegts', isLive: false, url: `fi-file://${encodeURIComponent(file.name)}`, filesize: file.size - pos },
                { enableWorker: false, enableStashBuffer: true, stashInitialSize: 384 * 1024, lazyLoad: true, lazyLoadMaxDuration: 120, accurateSeek: true, seekType: 'range', customLoader: makeLoaderClass(file, pos), autoCleanupSourceBuffer: true },
            );
            ctl.player = player;
            player.on(mpegts.Events.ERROR, (type, detail, info2) => {
                console.warn('[viewer-ts] mpegts error', type, detail, info2);
                if (ctl.player === player && ctl.onerror) ctl.onerror(new Error(`${type}: ${detail}`));
            });
            player.attachMediaElement(video);
            player.load();
            if (localTarget > 0.05 || resume) {
                const go = () => {
                    video.removeEventListener('loadedmetadata', go);
                    const b = video.buffered;
                    const startAt = b.length ? Math.max(localTarget, b.start(0)) : localTarget;
                    if (startAt > 0.05) video.currentTime = startAt;
                    if (resume) video.play().catch(() => {});
                };
                video.addEventListener('loadedmetadata', go);
            }
        }

        await start(0, 0, 0, false);
        return ctl;
    }

    V.ts = {
        isTs(entry) {
            return /^(ts|m2ts|mts)$/i.test(entry.ext || App.util.path.ext(entry.name));
        },
        supported,
        attach,
        probe,
        _scanPts: scanPts,
    };
})();
