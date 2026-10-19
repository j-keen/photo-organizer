/*
 * Browser-only lossless cut & join for videos — no re-encode, no server (owner: '서버 없이도 자르기').
 * Uses Mediabunny (MPL-2.0, vendor/mediabunny.min.js, a classic script lazy-loaded on first use so start-up stays fast
 * and it works from file://). Packets are copied as they are, so quality and speed match ffmpeg's "-c copy":
 *   - each range starts at the key frame at or before its start (keyframe-aligned, a little earlier than asked),
 *   - and ends at its end (reference frames needed by the last kept frames come along).
 * Containers: MP4/M4V/MOV (H.264, HEVC, AV1, VP9 + AAC/Opus/MP3 …) → same container; WebM/MKV (VP8/VP9/AV1 + Opus/Vorbis) → same.
 * The output is built in memory (BufferTarget), so very large outputs are left to the local server.
 *
 * App.videoLossless — {
 *   supports(name) → bool                         by extension (mp4 m4v mov webm mkv)
 *   load() → Promise<Mediabunny>                   lazy-loads the vendored bundle
 *   cut(file, ranges [[a, b]], { onProgress(0..1), isCancelled() }) → { blob, ext, mime, ranges: [[a', b']], duration,
 *       lead (s added before the asked starts), restored (s of removed footage that came back because a key frame was missing) }
 *   MAX_BYTES                                       estimated output size limit for the in-memory path
 * }
 * Errors carry .code: 'EUNSUPPORTED' (container/codec), 'ETOOBIG', 'ECANCELED', 'ELOAD'.
 */
(() => {
    'use strict';

    const EXTS = ['mp4', 'm4v', 'mov', 'webm', 'mkv'];
    const MAX_BYTES = 1024 * 1024 * 1024; // the output is assembled in memory (and copied once into a Blob)
    let loading = null;

    function fail(code, message) {
        const e = new Error(message);
        e.code = code;
        return e;
    }

    function load() {
        if (window.Mediabunny) return Promise.resolve(window.Mediabunny);
        if (loading) return loading;
        loading = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'vendor/mediabunny.min.js';
            s.async = true;
            s.onload = () => (window.Mediabunny ? resolve(window.Mediabunny) : reject(fail('ELOAD', '영상 도구를 불러오지 못했어요')));
            s.onerror = () => {
                loading = null;
                s.remove();
                reject(fail('ELOAD', '영상 도구(vendor/mediabunny.min.js)를 불러오지 못했어요'));
            };
            document.head.append(s);
        });
        return loading;
    }

    function supports(name) {
        const ext = String(name || '').split('.').pop().toLowerCase();
        return EXTS.includes(ext) && typeof window.WebAssembly !== 'undefined' && typeof Blob !== 'undefined';
    }

    function outputFor(MB, inputFormat, ext) {
        if (inputFormat instanceof MB.MatroskaInputFormat) {
            return ext === 'webm' || inputFormat instanceof MB.WebMInputFormat
                ? { format: new MB.WebMOutputFormat(), ext: 'webm', mime: 'video/webm' }
                : { format: new MB.MkvOutputFormat(), ext: 'mkv', mime: 'video/x-matroska' };
        }
        if (inputFormat instanceof MB.IsobmffInputFormat) {
            if (ext === 'mov' || (MB.QuickTimeInputFormat && inputFormat instanceof MB.QuickTimeInputFormat)) {
                return { format: new MB.MovOutputFormat({ fastStart: 'in-memory' }), ext: 'mov', mime: 'video/quicktime' };
            }
            return { format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), ext: ext === 'm4v' ? 'm4v' : 'mp4', mime: 'video/mp4' };
        }
        return null;
    }

    /**
     * Copy the packets of `ranges` (seconds, ascending, non-overlapping) into one new file of the same container.
     */
    async function cut(file, ranges, { onProgress, isCancelled } = {}) {
        const list = (ranges || []).filter(([a, b]) => isFinite(a) && isFinite(b) && b - a > 0.05).sort((x, y) => x[0] - y[0]);
        if (!list.length) throw fail('EINVAL', '저장할 부분이 없어요');
        const MB = await load();
        const ext = String(file.name || '').split('.').pop().toLowerCase();
        const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
        let output = null;
        try {
            const inFormat = await input.getFormat().catch(() => null);
            const out = inFormat && outputFor(MB, inFormat, ext);
            if (!out) throw fail('EUNSUPPORTED', '이 형식은 브라우저에서 바로 자를 수 없어요');
            const vTrack = await input.getPrimaryVideoTrack();
            if (!vTrack || !vTrack.codec) throw fail('EUNSUPPORTED', '영상 트랙을 찾지 못했어요');
            if (!out.format.getSupportedVideoCodecs().includes(vTrack.codec)) throw fail('EUNSUPPORTED', `${vTrack.codec} 영상은 브라우저에서 바로 자를 수 없어요`);
            let aTrack = await input.getPrimaryAudioTrack();
            if (aTrack && (!aTrack.codec || !out.format.getSupportedAudioCodecs().includes(aTrack.codec))) throw fail('EUNSUPPORTED', `${aTrack.codec || '알 수 없는'} 소리는 브라우저에서 바로 옮길 수 없어요`);

            const duration = await input.computeDuration().catch(() => 0);
            const total = list.reduce((s, [a, b]) => s + (Math.min(b, duration || b) - a), 0);
            if (duration > 0 && file.size * (total / duration) > MAX_BYTES) throw fail('ETOOBIG', '결과 파일이 너무 커서 브라우저에서 만들 수 없어요');

            const target = new MB.BufferTarget();
            output = new MB.Output({ format: out.format, target });
            const vSink = new MB.EncodedPacketSink(vTrack);
            const vSrc = new MB.EncodedVideoPacketSource(vTrack.codec);
            output.addVideoTrack(vSrc, vTrack.rotation ? { rotation: vTrack.rotation } : {});
            const aSink = aTrack ? new MB.EncodedPacketSink(aTrack) : null;
            const aSrc = aTrack ? new MB.EncodedAudioPacketSource(aTrack.codec) : null;
            if (aSrc) output.addAudioTrack(aSrc);
            await output.start();
            const vMeta = { decoderConfig: await vTrack.getDecoderConfig() };
            const aMeta = aTrack ? { decoderConfig: await aTrack.getDecoderConfig() } : null;
            let firstV = true;
            let firstA = true;
            let offset = 0;
            let done = 0;
            const actual = [];
            const check = () => {
                if (isCancelled?.()) throw fail('ECANCELED', '작업을 취소했어요');
            };

            // Plan first: touching ranges become one, and a range whose key frame lies inside the previous range is merged
            // into it — so nothing is copied twice. What that brings back (extra lead-in, removed footage) is reported.
            const plan = [];
            let lead = 0;
            let restored = 0;
            for (const [a, b] of list) {
                const last = plan[plan.length - 1];
                if (last && a - last.b < 0.02) {
                    last.b = Math.max(last.b, b);
                    continue;
                }
                const key = (await vSink.getKeyPacket(a, { verifyKeyPackets: true })) || (await vSink.getFirstKeyPacket());
                if (!key) throw fail('EUNSUPPORTED', '키프레임을 찾지 못했어요');
                if (last && key.timestamp < last.b - 1e-6) {
                    restored += a - last.b; // the removed gap between them comes back
                    last.b = Math.max(last.b, b);
                    continue;
                }
                lead += Math.max(0, a - key.timestamp);
                plan.push({ a, b, key });
            }

            for (const { b, key } of plan) {
                check();
                const start = key.timestamp;
                // decode order from the key frame; stop at the next key frame at/after b (nothing after it is needed)
                const packets = [];
                for await (const pkt of vSink.packets(key)) {
                    if (pkt.type === 'key' && pkt.timestamp >= b - 1e-6 && packets.length) break;
                    if (pkt.timestamp > b + 5) break; // safety net for odd streams
                    packets.push(pkt);
                }
                let last = -1;
                for (let i = 0; i < packets.length; i++) if (packets[i].timestamp < b - 1e-6) last = i;
                // keep everything up to the last frame shown before b (B-frame references included); drop open-GOP leaders
                const keep = packets.slice(0, last + 1).filter((p) => p.timestamp >= start - 1e-6);
                let end = start;
                for (const p of keep) end = Math.max(end, p.timestamp + (p.duration || 0));
                if (!keep.length || end - start <= 0) continue;
                for (const p of keep) {
                    await vSrc.add(p.clone({ timestamp: Math.max(0, p.timestamp - start + offset) }), firstV ? vMeta : undefined);
                    firstV = false;
                }
                if (aSrc) {
                    const first = (await aSink.getPacket(start)) || (await aSink.getFirstPacket());
                    if (first) {
                        for await (const p of aSink.packets(first)) {
                            if (p.timestamp >= end - 1e-6) break;
                            if (p.timestamp + (p.duration || 0) <= start + 1e-6) continue;
                            const ts = p.timestamp - start + offset;
                            if (ts < -0.001) continue;
                            await aSrc.add(p.clone({ timestamp: Math.max(0, ts) }), firstA ? aMeta : undefined);
                            firstA = false;
                        }
                    }
                }
                actual.push([start, end]);
                offset += end - start;
                done += end - start;
                onProgress?.(Math.min(0.98, done / total));
            }
            if (firstV) throw fail('EUNSUPPORTED', '복사할 영상 프레임이 없어요');
            check();
            await output.finalize();
            onProgress?.(1);
            return { blob: new Blob([target.buffer], { type: out.mime }), ext: out.ext, mime: out.mime, ranges: actual, duration: offset, lead, restored };
        } catch (e) {
            try {
                if (output && output.state !== 'finalized' && output.state !== 'canceled') await output.cancel();
            } catch (_) {
                /* ignore */
            }
            if (!e.code) e.code = 'EUNSUPPORTED';
            throw e;
        } finally {
            try {
                input.dispose?.();
            } catch (_) {
                /* ignore */
            }
        }
    }

    App.videoLossless = { supports, load, cut, MAX_BYTES };
})();
