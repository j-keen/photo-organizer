/*
 * Viewer — videos: custom player (no native controls).
 *   play/pause, seek bar with hover time + frame preview, ←/→ seek step (viewer.seekStep, 1–60 s), frame step (, .),
 *   speed (J/K/L, [ ]), mute (M), volume (↑/↓, remembered), A-B loop (A), fullscreen (F),
 *   markers (B) with title/memo/color stored in catalog.markers (seek-bar ticks + "마커" panel, Shift+B),
 *   scene capture (C) -> "<stem>_frame_<mm>m<ss>s.jpg" next to the video, "이 장면을 썸네일로" (Shift+C -> meta.posterT),
 *   .ts/.m2ts/.mts through viewer-ts.js, '서버로 재생' (/api/media/stream) for formats the browser can't play.
 *
 *   App.viewer.player — active player { playing, time, duration, fps, video, play(), pause(), toggle(), seek(t), seekBy(dt),
 *                        seekStep(dir), frameStep(dir), playRange(a, b), setRanges(key, ranges), markers() ... }
 * Events: 'viewer:player' {player|null}, 'viewer:video-time' {time}, 'viewer:video-meta' {duration}, 'viewer:video-ended'
 */
(() => {
    'use strict';
    const { h, path: P, clamp, escapeHtml } = App.util;
    const ui = App.ui;
    const V = App.viewer;

    const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
    const JKL_RATES = [1, 1.5, 2, 3, 4];
    const SEEK_STEPS = [1, 2, 3, 5, 10, 15, 30, 60];
    const MARK_COLORS = ['accent', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'];

    function fmt(t, precise = false) {
        if (t == null || !isFinite(t)) t = 0;
        const neg = t < 0;
        t = Math.abs(t);
        const hh = Math.floor(t / 3600);
        const m = Math.floor((t % 3600) / 60);
        const s = Math.floor(t % 60);
        let out = (hh ? `${hh}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(s).padStart(2, '0');
        if (precise) out += '.' + String(Math.floor((t % 1) * 100)).padStart(2, '0');
        return (neg ? '-' : '') + out;
    }

    function markColor(c) {
        return !c || c === 'accent' ? 'var(--accent)' : `var(--label-${c})`;
    }

    function seekStepSec() {
        return clamp(Math.round(Number(App.settings.get('viewer.seekStep', 5)) || 5), 1, 60);
    }

    function serverStreamReady() {
        const s = App.server;
        if (!s || !s.available) return false;
        if (typeof s.canStream === 'function') return !!s.canStream();
        return App.fs.backend?.kind === 'server';
    }

    function streamUrl(p) {
        const s = App.server;
        if (s && typeof s.streamUrl === 'function') return s.streamUrl(p);
        if (s && typeof s.mediaUrl === 'function') return s.mediaUrl(p, 'stream');
        return `${s?.base || ''}/api/media/stream?path=${encodeURIComponent(p)}`;
    }

    // ---------- Player (one per video slot) ----------
    class Player {
        constructor(ctx) {
            this.ctx = ctx;
            this.entry = ctx.entry;
            this.path = ctx.entry.path;
            this.slot = ctx.slot;
            this.destroyed = false;
            this.release = null;
            this.ts = null;
            this.source = null;
            this.loopA = null;
            this.loopB = null;
            this.reverseRate = 0;
            this.reverseRaf = 0;
            this.raf = 0;
            this.stopAt = null;
            this.ranges = new Map();
            this.meta = App.catalog.peek(this.path)?.meta || {};
            this.fps = this.meta.fps || null;
            this.fpsSamples = [];
            this.metaReady = false;
            this.failed = false;

            const v = document.createElement('video');
            v.className = 'vw-media vw-video';
            v.playsInline = true;
            v.preload = 'auto';
            v.controls = false;
            v.disableRemotePlayback = true;
            v.volume = clamp(Number(App.settings.get('viewer.volume', 1)), 0, 1);
            v.muted = !!App.settings.get('viewer.muted', false);
            this.video = v;
            this.stateEl = h('div', { class: 'vw-vstate' });
            this.slot.classList.add('vw-video-slot');
            this.slot.append(v, this.stateEl);
            // Zoom / pan / rotation / flip shared with photos (viewer-transform.js)
            this.view = new V.ViewTransform({
                ctx,
                slot: this.slot,
                path: this.path,
                upscale: true,
                pad: 0,
                // click = play/pause, double-click = back to fit when zoomed in, else fullscreen
                onTap: () => {
                    if (!this.failed) this.toggle();
                },
                onDoubleTap: () => (this.view.zoomed ? this.view.fitToScreen(true) : V.toggleFullscreen()),
                onPlainWheel: (e) => this.onWheel(e),
            });
            this.view.setElements([v]);
            // Before metadata arrives use the cached size so a rotated poster already sits right
            if (this.meta.w && this.meta.h) this.view.setNatural(this.meta.w, this.meta.h);
            this.bindVideo();

            // Poster from the grid thumbnail so the frame appears instantly
            const thumb = App.thumbs?.peek?.(this.entry);
            if (thumb) {
                v.poster = thumb;
                const im = new Image();
                im.src = thumb;
                im.decode().then(() => {
                    if (!this.destroyed) this.ctx.ready();
                }, () => this.ctx.ready());
            } else {
                this.ctx.ready();
            }
            this.load();
        }

        get media() {
            return this.video;
        }

        // ----- time model (TS playback adds an offset) -----
        get time() {
            return this.ts ? this.ts.time : this.video.currentTime || 0;
        }

        get duration() {
            if (this.ts) return this.ts.duration || 0;
            const d = this.video.duration;
            if (isFinite(d) && d > 0) return d;
            return this.meta.duration && isFinite(this.meta.duration) ? this.meta.duration : 0;
        }

        get playing() {
            return this.reverseRate > 0 || (!this.video.paused && !this.video.ended);
        }

        get paused() {
            return !this.playing;
        }

        get rate() {
            return this.video.playbackRate;
        }

        // ----- loading -----
        async load() {
            const e = this.entry;
            if (V.ts?.isTs(e)) return this.loadTs();
            if (!App.util.browserCanDecode(e.name)) return this.showUnsupported();
            try {
                const src = await App.fs.url(e.path);
                if (this.destroyed) {
                    src.release();
                    return;
                }
                this.release = src.release;
                this.source = 'file';
                this.video.src = src.url;
            } catch (err) {
                this.showFailure(err);
            }
        }

        async loadTs() {
            if (!V.ts.supported()) return this.showUnsupported('이 브라우저는 TS 재생을 지원하지 않아요.');
            this.setState('loading');
            try {
                const file = await App.fs.getFile(this.path);
                if (this.destroyed) return;
                this.ts = await V.ts.attach(this.video, file);
                if (this.destroyed) {
                    this.ts.destroy();
                    this.ts = null;
                    return;
                }
                this.source = 'ts';
                this.ts.onerror = (err) => {
                    if (!this.metaReady) this.showUnsupported(`TS 파일을 재생하지 못했어요 (${err.message}).`);
                };
                if (this.ts.info) this.meta = { ...this.meta, duration: this.ts.info.duration };
                bar.update();
            } catch (err) {
                this.showUnsupported(err.message);
            }
        }

        useServerStream() {
            if (!serverStreamReady()) return;
            this.clearCard();
            this.failed = false;
            if (this.ts) {
                this.ts.destroy();
                this.ts = null;
            }
            if (this.release) this.release();
            this.release = null;
            this.source = 'stream';
            this.video.src = streamUrl(this.path);
            this.setState('loading');
            this.play();
        }

        clearCard() {
            this.slot.querySelectorAll('.vw-card').forEach((n) => n.remove());
            this.video.hidden = false;
        }

        showUnsupported(reason) {
            const e = this.entry;
            this.failed = true;
            this.clearCard();
            this.video.hidden = true;
            this.setState('none');
            const server = serverStreamReady();
            const actions = [];
            if (server) actions.push(h('button', { class: 'btn primary sm', html: `${ui.icon('server', { size: 14 })}<span>서버로 재생</span>`, onclick: () => this.useServerStream() }));
            this.slot.append(V.card({
                icon: 'film',
                title: `${(e.ext || '').toUpperCase()} 영상은 브라우저에서 바로 재생할 수 없어요`,
                text: (reason ? `${escapeHtml(reason)} ` : '') + (server
                    ? '로컬 서버가 ffmpeg로 바꿔서 재생해 줄 수 있어요.'
                    : App.server?.available
                        ? '서버 주소(http://127.0.0.1:8765)에서 작업 폴더를 열면 AVI·WMV·HEVC 같은 형식도 재생돼요.'
                        : '로컬 서버(<b>server\\start.bat</b>)를 켜고 서버 주소에서 열면 AVI·WMV·HEVC 같은 형식도 재생돼요.'),
                actions,
            }));
            bar.update();
        }

        showFailure(err) {
            const code = this.video.error?.code;
            if (code === 4 || code === 3) {
                this.showUnsupported(code === 3 ? '영상을 해독하다가 문제가 생겼어요.' : '코덱(H.265/HEVC 등)을 브라우저가 지원하지 않는 것 같아요.');
                return;
            }
            this.failed = true;
            this.clearCard();
            this.video.hidden = true;
            this.setState('none');
            this.slot.append(V.card({
                icon: 'alert',
                tone: 'is-error',
                title: '이 영상을 열 수 없어요',
                text: escapeHtml(err?.message || '파일을 읽지 못했어요.'),
                actions: [h('button', { class: 'btn sm', text: '다시 시도', onclick: () => V.open(this.path) })],
            }));
        }

        // ----- video element wiring -----
        bindVideo() {
            const v = this.video;
            const isActive = () => V.player === this;
            v.addEventListener('loadedmetadata', () => this.onMeta());
            v.addEventListener('durationchange', () => isActive() && bar.update());
            v.addEventListener('timeupdate', () => {
                if (!isActive()) return;
                if (!this.raf) bar.updateTime();
                App.bus.emit('viewer:video-time', { time: this.time });
            });
            v.addEventListener('seeked', () => {
                if (!isActive()) return;
                bar.update();
                App.bus.emit('viewer:video-time', { time: this.time });
            });
            v.addEventListener('progress', () => isActive() && bar.updateBuffered());
            v.addEventListener('play', () => {
                this.setState('none');
                this.loop();
                if (isActive()) bar.update();
                V.poke();
            });
            v.addEventListener('playing', () => this.setState('none'));
            v.addEventListener('pause', () => {
                if (this.reverseRate) return;
                cancelAnimationFrame(this.raf);
                this.raf = 0;
                if (isActive()) bar.update();
                V.poke();
            });
            v.addEventListener('waiting', () => this.setState('loading', 260));
            v.addEventListener('seeking', () => this.setState('loading', 350));
            v.addEventListener('canplay', () => this.state === 'loading' && this.setState('none'));
            v.addEventListener('ended', () => {
                if (this.loopB != null && this.loopA != null) {
                    this.seek(this.loopA);
                    this.play();
                    return;
                }
                if (isActive()) bar.update();
                this.setState('ended');
                App.bus.emit('viewer:video-ended', { path: this.path });
            });
            v.addEventListener('ratechange', () => isActive() && bar.update());
            v.addEventListener('volumechange', () => {
                if (!isActive()) return;
                bar.update();
                saveVolume(v.volume, v.muted);
            });
            v.addEventListener('error', () => {
                if (this.destroyed || this.ts) return;
                if (this.source === 'stream') {
                    this.showUnsupported('서버에서도 이 영상을 재생하지 못했어요.');
                    return;
                }
                this.showFailure(new Error(this.video.error?.message || '영상을 재생할 수 없어요'));
            });
        }

        // Plain wheel over the picture: volume (setting "viewer.videoWheel"); Ctrl+wheel zooms (ViewTransform)
        onWheel(e) {
            if (this.failed || App.settings.get('viewer.videoWheel', 'volume') !== 'volume') return;
            e.preventDefault();
            const now = performance.now();
            if (e.deltaMode === 0 && Math.abs(e.deltaY) < 40) {
                // trackpads: accumulate small deltas
                this.wheelAcc = (now - (this.wheelAt || 0) > 200 ? 0 : this.wheelAcc || 0) + e.deltaY;
                this.wheelAt = now;
                if (Math.abs(this.wheelAcc) < 60) return;
                this.volumeBy(this.wheelAcc < 0 ? 0.05 : -0.05);
                this.wheelAcc = 0;
                return;
            }
            if (!e.deltaY) return;
            this.volumeBy(e.deltaY < 0 ? 0.05 : -0.05);
        }

        onMeta() {
            const v = this.video;
            if (!this.ts && !isFinite(v.duration)) {
                // MediaRecorder-made WebM has no duration in its header: seek far to make Chrome compute it
                let done = false;
                const finish = () => {
                    if (done) return;
                    done = true;
                    v.removeEventListener('durationchange', onDur);
                    clearTimeout(timer);
                    v.currentTime = 0;
                    this.afterMeta();
                };
                const onDur = () => isFinite(v.duration) && finish();
                const timer = setTimeout(finish, 2500);
                v.addEventListener('durationchange', onDur);
                v.currentTime = 1e7;
                return;
            }
            this.afterMeta();
        }

        afterMeta() {
            if (this.destroyed || this.metaReady) return;
            this.metaReady = true;
            const v = this.video;
            this.layout();
            const d = this.duration;
            const patch = {};
            if (d && isFinite(d) && Math.abs((this.meta.duration || 0) - d) > 0.01) patch.duration = d;
            if (v.videoWidth && !this.meta.w) {
                patch.w = v.videoWidth;
                patch.h = v.videoHeight;
            }
            if (Object.keys(patch).length) {
                App.catalog.setMeta(this.path, patch);
                this.meta = { ...this.meta, ...patch };
            }
            const opts = this.ctx.opts || {};
            if (opts.time != null && isFinite(opts.time)) this.seek(opts.time);
            const auto = opts.play !== false && App.settings.get('viewer.autoplay', true) !== false;
            if (auto && (!V.slideshow?.running || V.slideshow.includeVideos)) this.play();
            else this.setState('paused');
            if (V.player === this) {
                bar.update();
                bar.renderMarks();
                App.bus.emit('viewer:video-meta', { path: this.path, duration: d });
            }
            this.sampleFps();
        }

        // Estimate the frame rate from presented frames (for frame stepping) when the server didn't tell us.
        sampleFps() {
            const v = this.video;
            if (this.fps || typeof v.requestVideoFrameCallback !== 'function') return;
            let last = null;
            const cb = (now, m) => {
                if (this.destroyed || this.fps) return;
                if (last && m.presentedFrames > last.frames && m.mediaTime > last.time) {
                    const rate = (m.presentedFrames - last.frames) / (m.mediaTime - last.time);
                    if (rate > 5 && rate < 241) this.fpsSamples.push(rate);
                }
                last = { frames: m.presentedFrames, time: m.mediaTime };
                if (this.fpsSamples.length >= 24) {
                    const s = [...this.fpsSamples].sort((a, b) => a - b);
                    const med = s[Math.floor(s.length / 2)];
                    const common = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120];
                    this.fps = common.find((c) => Math.abs(c - med) / c < 0.02) || Math.round(med * 100) / 100;
                    return;
                }
                v.requestVideoFrameCallback(cb);
            };
            v.requestVideoFrameCallback(cb);
        }

        // ----- layout (fit / zoom / orientation live in this.view) -----
        layout() {
            const v = this.video;
            if (v.videoWidth && v.videoHeight) this.view.setNatural(v.videoWidth, v.videoHeight, { keepScreenSize: true });
            else this.view.layout();
        }

        resize() {
            this.view.resize();
        }

        get frozen() {
            return this.view.frozen;
        }

        set frozen(v) {
            this.view.frozen = !!v;
        }

        onCatalog() {
            const meta = App.catalog.peek(this.path)?.meta || {};
            this.meta = { ...this.meta, ...meta };
            if (meta.posterT == null) delete this.meta.posterT;
            this.view.follow();
            if (V.player === this) bar.renderMarks();
        }

        onShown() {
            V.player = this;
            bar.bind(this);
            App.bus.emit('viewer:player', { player: this });
        }

        // ----- state overlay (spinner / play / replay) -----
        setState(state, delay = 0) {
            this.state = state;
            clearTimeout(this.stateTimer);
            const apply = () => {
                if (this.destroyed || this.state !== state) return;
                this.stateEl.dataset.state = state;
                this.stateEl.innerHTML = state === 'loading' ? '<span class="spinner"></span>' : state === 'paused' ? ui.icon('play', { size: 30 }) : state === 'ended' ? ui.icon('refresh', { size: 28 }) : '';
            };
            if (delay) this.stateTimer = setTimeout(apply, delay);
            else apply();
        }

        // ----- transport -----
        play() {
            this.stopReverse();
            if (this.failed) return;
            if (this.video.ended || (this.duration && this.time >= this.duration - 0.05)) this.seek(this.loopA ?? 0);
            const p = this.video.play();
            if (p && p.catch) p.catch(() => this.setState('paused'));
        }

        pause() {
            this.stopReverse();
            this.stopAt = null;
            this.video.pause();
            this.setState('paused');
        }

        toggle() {
            if (this.playing) {
                this.pause();
                V.osd('일시정지', { icon: 'pause', duration: 500 });
            } else {
                this.play();
                V.osd('재생', { icon: 'play', duration: 500 });
            }
        }

        seek(t) {
            const d = this.duration;
            t = clamp(t, 0, d ? Math.max(0, d - 0.001) : Math.max(0, t));
            if (this.ts) this.ts.seek(t);
            else this.video.currentTime = t;
            if (this.state === 'ended') this.setState(this.playing ? 'none' : 'paused');
            if (V.player === this) bar.update(t);
        }

        seekBy(dt) {
            this.seek(this.time + dt);
        }

        seekStep(dir) {
            const step = seekStepSec();
            this.seekBy(dir * step);
            // Repeated presses add up in ONE overlay ("+15초 · 1:23") instead of a new message per press
            const now = performance.now();
            if (this.seekAccDir === dir && now - (this.seekAccAt || 0) < 900) this.seekAcc += step;
            else this.seekAcc = step;
            this.seekAccDir = dir;
            this.seekAccAt = now;
            V.osd(`${dir > 0 ? '+' : '−'}${this.seekAcc}초 · ${fmt(this.time)}`, { icon: dir > 0 ? 'vw-seek-fwd' : 'vw-seek-back', duration: 700 });
        }

        frameStep(dir) {
            if (this.playing) this.pause();
            const fps = this.fps || 30;
            const frame = Math.round(this.time * fps);
            this.seek((frame + dir) / fps + 0.0005);
            V.osd(dir > 0 ? '다음 프레임' : '이전 프레임', { icon: dir > 0 ? 'vw-frame-next' : 'vw-frame-prev', duration: 400 });
        }

        setRate(r) {
            this.stopReverse();
            const rate = clamp(r, 0.0625, 16);
            this.video.playbackRate = rate;
            this.video.defaultPlaybackRate = rate;
            V.osd(`${rate}×`, { icon: 'vw-gauge', duration: 600 });
        }

        nudgeRate(dir) {
            const cur = this.rate;
            const next = dir > 0 ? RATES.find((r) => r > cur + 1e-6) ?? RATES[RATES.length - 1] : [...RATES].reverse().find((r) => r < cur - 1e-6) ?? RATES[0];
            this.setRate(next);
        }

        // NLE-style J/K/L: L plays and speeds up forward, J plays backwards (simulated) and speeds up, K stops.
        jkl(dir) {
            if (dir > 0) {
                if (this.reverseRate) {
                    this.stopReverse();
                    this.video.playbackRate = 1;
                    this.play();
                    V.osd('1×', { icon: 'play', duration: 500 });
                    return;
                }
                if (!this.playing) {
                    this.video.playbackRate = 1;
                    this.play();
                    V.osd('1×', { icon: 'play', duration: 500 });
                    return;
                }
                const next = JKL_RATES.find((r) => r > this.rate + 1e-6) ?? JKL_RATES[JKL_RATES.length - 1];
                this.setRate(next);
                return;
            }
            if (this.reverseRate) {
                this.reverseRate = JKL_RATES.find((r) => r > this.reverseRate + 1e-6) ?? JKL_RATES[JKL_RATES.length - 1];
                V.osd(`◀ ${this.reverseRate}×`, { icon: 'vw-gauge', duration: 600 });
                return;
            }
            this.startReverse(1);
        }

        startReverse(rate) {
            this.video.pause();
            this.reverseRate = rate;
            this.setState('none');
            V.osd(`◀ ${rate}×`, { icon: 'vw-gauge', duration: 600 });
            let lastT = performance.now();
            let waiting = false;
            const v = this.video;
            const onSeeked = () => {
                waiting = false;
            };
            v.addEventListener('seeked', onSeeked);
            this._reverseCleanup = () => v.removeEventListener('seeked', onSeeked);
            const tick = (now) => {
                if (!this.reverseRate || this.destroyed) return;
                if (!waiting) {
                    const dt = (now - lastT) / 1000;
                    lastT = now;
                    const t = this.time - dt * this.reverseRate;
                    if (t <= 0) {
                        this.seek(0);
                        this.stopReverse();
                        this.setState('paused');
                        if (V.player === this) bar.update();
                        return;
                    }
                    waiting = true;
                    this.seek(t);
                } else {
                    lastT = Math.min(lastT, now);
                }
                this.reverseRaf = requestAnimationFrame(tick);
            };
            this.reverseRaf = requestAnimationFrame(tick);
            if (V.player === this) bar.update();
        }

        stopReverse() {
            if (!this.reverseRate) return;
            this.reverseRate = 0;
            cancelAnimationFrame(this.reverseRaf);
            this._reverseCleanup?.();
            this._reverseCleanup = null;
        }

        // Smooth progress while playing; enforces A-B loop and playRange() ends.
        loop() {
            cancelAnimationFrame(this.raf);
            const tick = () => {
                this.raf = 0;
                if (this.destroyed || this.video.paused) return;
                const t = this.time;
                if (this.loopA != null && this.loopB != null && t >= this.loopB) this.seek(this.loopA);
                if (this.stopAt != null && t >= this.stopAt) {
                    const end = this.stopAt;
                    this.stopAt = null;
                    this.video.pause();
                    this.seek(end);
                    this.setState('paused');
                    if (this.onRangeEnd) {
                        const fn = this.onRangeEnd;
                        this.onRangeEnd = null;
                        fn();
                    }
                }
                if (V.player === this) bar.updateTime();
                this.raf = requestAnimationFrame(tick);
            };
            this.raf = requestAnimationFrame(tick);
        }

        /** Play [a, b] once (editor preview). onEnd fires when b is reached. */
        playRange(a, b, onEnd) {
            this.stopReverse();
            this.seek(a);
            this.stopAt = b;
            this.onRangeEnd = onEnd || null;
            this.play();
            this.stopAt = b;
        }

        /** Overlay ranges on the seek bar: key -> [{start, end, kind: 'inout'|'segment'|'active'}] */
        setRanges(key, ranges) {
            if (ranges && ranges.length) this.ranges.set(key, ranges);
            else this.ranges.delete(key);
            if (V.player === this) bar.renderRanges();
        }

        // ----- volume -----
        toggleMute() {
            this.video.muted = !this.video.muted;
            V.osd(this.video.muted ? '음소거' : `소리 ${Math.round(this.video.volume * 100)}%`, { icon: this.video.muted ? 'volume-x' : 'volume', duration: 600 });
        }

        setVolume(vol) {
            this.video.volume = clamp(vol, 0, 1);
            if (this.video.volume > 0) this.video.muted = false;
        }

        volumeBy(d) {
            this.setVolume(Math.round((this.video.volume + d) * 100) / 100);
            V.osd(`소리 ${Math.round(this.video.volume * 100)}%`, { icon: this.video.volume ? 'volume' : 'volume-x', duration: 600 });
        }

        // ----- A-B loop -----
        cycleLoop() {
            const t = this.time;
            if (this.loopA == null) {
                this.loopA = t;
                V.osd(`A 지점 ${fmt(t)}`, { icon: 'vw-repeat' });
            } else if (this.loopB == null) {
                let a = this.loopA;
                let b = t;
                if (b < a) [a, b] = [b, a];
                if (b - a < 0.2) {
                    V.osd('구간이 너무 짧아요', { icon: 'vw-repeat' });
                    return;
                }
                this.loopA = a;
                this.loopB = b;
                V.osd(`구간 반복 ${fmt(a)} – ${fmt(b)}`, { icon: 'vw-repeat', duration: 1000 });
                if (t >= b || t < a) this.seek(a);
            } else {
                this.loopA = null;
                this.loopB = null;
                V.osd('구간 반복 끔', { icon: 'vw-repeat' });
            }
            if (V.player === this) {
                bar.update();
                bar.renderRanges();
            }
        }

        // ----- markers -----
        markers() {
            return [...(App.catalog.get(this.path).markers || [])].sort((a, b) => a.t - b.t);
        }

        addMarker() {
            const t = Math.round(this.time * 1000) / 1000;
            const marker = { id: App.util.uid('m'), t, title: '', memo: '', color: null };
            const path = this.path;
            putMarker(path, marker);
            const entry = App.undo.push({ label: `마커 ${fmt(t)} 추가`, undo: () => deleteMarker(path, marker.id), redo: () => putMarker(path, entry.marker || marker) });
            V.osd(`마커 ${fmt(t)}`, { icon: 'bookmark' });
            if (V.player === this) {
                bar.renderMarks();
                const el = bar.markEl(marker.id);
                if (el && App.settings.get('viewer.markerPopover', true) !== false) editMarker(path, marker.id, el, { addEntry: entry });
            }
            return marker;
        }

        jumpMarker(dir) {
            const t = this.time;
            const ms = this.markers();
            if (!ms.length) {
                V.osd('마커가 없어요', { icon: 'bookmark' });
                return;
            }
            const m = dir > 0 ? ms.find((x) => x.t > t + 0.05) : [...ms].reverse().find((x) => x.t < t - 0.25);
            if (!m) {
                V.osd(dir > 0 ? '마지막 마커예요' : '첫 마커예요', { icon: 'bookmark' });
                return;
            }
            this.seek(m.t);
            V.osd(m.title ? `${m.title} · ${fmt(m.t)}` : `마커 ${fmt(m.t)}`, { icon: 'bookmark' });
        }

        // ----- capture & poster -----
        async capture() {
            const v = this.video;
            if (!v.videoWidth) {
                ui.toast('아직 영상이 준비되지 않았어요', { type: 'warning' });
                return null;
            }
            const t = this.time;
            const o = V.orientationOf(this.path); // the capture looks like what you see (rotation + flips)
            const swap = o.rot % 180 !== 0;
            const w = swap ? v.videoHeight : v.videoWidth;
            const hh = swap ? v.videoWidth : v.videoHeight;
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = hh;
            const g = canvas.getContext('2d');
            g.translate(w / 2, hh / 2);
            g.rotate((o.rot * Math.PI) / 180);
            g.scale(o.flipH ? -1 : 1, o.flipV ? -1 : 1);
            g.drawImage(v, -v.videoWidth / 2, -v.videoHeight / 2, v.videoWidth, v.videoHeight);
            const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
            if (!blob) {
                ui.toast('장면을 캡처하지 못했어요', { type: 'error' });
                return null;
            }
            flash();
            const mm = Math.floor(t / 60);
            const ss = Math.floor(t % 60);
            const name = `${P.stem(this.entry.name)}_frame_${String(mm).padStart(2, '0')}m${String(ss).padStart(2, '0')}s.jpg`;
            const dir = P.parent(this.path);
            let p;
            try {
                // one undo step: Ctrl+Z moves the captured file to the app trash
                p = await App.fs.createFile(dir, name, blob, { label: `장면 캡처 ${fmt(t)}` });
            } catch (e) {
                ui.toast(`장면을 저장하지 못했어요: ${e.message}`, { type: 'error' });
                return null;
            }
            App.catalog.setMeta(p, { w, h: hh, source: { path: this.path, t: Math.round(t * 1000) / 1000 } });
            ui.toast(`장면을 저장했어요 · ${P.base(p)}`, { type: 'success', duration: 5000, action: { label: '보기', run: () => V.open(p) } });
            return p;
        }

        setPoster() {
            const t = Math.round(this.time * 1000) / 1000;
            App.catalog.update(this.path, (e) => {
                e.meta = { ...(e.meta || {}), posterT: t };
            }, { label: `대표 장면 ${fmt(t)}` });
            this.meta = { ...this.meta, posterT: t };
            flash(true);
            ui.toast('대표 장면으로 정했어요', { type: 'success', duration: 2600 });
            if (V.player === this) bar.update();
        }

        hints() {
            const step = seekStepSec();
            const dk = V.dk;
            return [
                { keys: ['Space'], label: '재생' },
                { keys: ['←', '→'], label: `${step}초` },
                { keys: [dk('Mod+ArrowLeft'), dk('Mod+ArrowRight')], label: '이전/다음 파일' },
                { keys: ['J', 'K', 'L'], label: '속도' },
                { keys: [',', '.'], label: '프레임' },
                { keys: ['B'], label: '마커' },
                { keys: ['A'], label: '구간 반복' },
                { keys: ['C'], label: '캡처' },
                { keys: [dk('Mod')], mouse: true, label: '확대' },
                { keys: ['R', 'H'], label: '회전·반전' },
                { keys: ['E'], label: '편집' },
                { keys: ['M'], label: '음소거' },
            ];
        }

        deactivate() {
            this.view.finish();
            this.stopReverse();
            this.stopAt = null;
            try {
                this.video.pause();
            } catch (e) {
                /* ignore */
            }
        }

        destroy() {
            this.destroyed = true;
            this.deactivate();
            this.view.destroy();
            cancelAnimationFrame(this.raf);
            clearTimeout(this.stateTimer);
            if (this.ts) {
                this.ts.destroy();
                this.ts = null;
            }
            preview.drop(this);
            this.video.removeAttribute('src');
            try {
                this.video.load();
            } catch (e) {
                /* ignore */
            }
            if (this.release) this.release();
            this.release = null;
            if (V.player === this) {
                V.player = null;
                bar.bind(null);
                App.bus.emit('viewer:player', { player: null });
            }
        }
    }

    const saveVolume = App.util.debounce((volume, muted) => {
        App.settings.set('viewer.volume', Math.round(volume * 100) / 100);
        App.settings.set('viewer.muted', !!muted);
    }, 250);

    function flash(soft = false) {
        const st = V.stageEl;
        if (!st) return;
        const f = h('div', { class: `vw-flash${soft ? ' soft' : ''}` });
        st.parentNode.append(f);
        setTimeout(() => f.remove(), 450);
    }

    // ---------- Marker storage ----------
    // Raw writes skip the catalog's own undo entry: every user action below pushes exactly ONE entry itself.
    function putMarker(path, marker) {
        App.catalog.update(path, (e) => {
            const list = (e.markers || []).filter((m) => m.id !== marker.id);
            list.push({ ...marker });
            list.sort((a, b) => a.t - b.t);
            e.markers = list;
        }, { undoable: false });
    }

    function deleteMarker(path, id) {
        App.catalog.update(path, (e) => {
            e.markers = (e.markers || []).filter((m) => m.id !== id);
        }, { undoable: false });
    }

    /**
     * Edit title/memo/color as one undo step. addEntry: the "marker added" undo entry when the popover was opened right
     * after adding — naming a new marker then stays part of that ONE step (Ctrl+Z removes the named marker).
     */
    function patchMarkerUndoable(path, id, patch, addEntry = null) {
        const before = App.catalog.get(path).markers.find((x) => x.id === id);
        if (!before) return;
        const after = { ...before, ...patch };
        putMarker(path, after);
        if (addEntry && App.undo.peek() === addEntry) {
            addEntry.marker = after;
            return;
        }
        App.undo.push({ label: `마커 ${fmt(before.t)} 편집`, undo: () => putMarker(path, before), redo: () => putMarker(path, after) });
    }

    function removeMarkerUndoable(path, id) {
        const m = App.catalog.get(path).markers.find((x) => x.id === id);
        if (!m) return;
        deleteMarker(path, id);
        App.undo.push({ label: `마커 ${fmt(m.t)} 삭제`, undo: () => putMarker(path, m), redo: () => deleteMarker(path, id) });
        ui.toast(`마커 ${fmt(m.t)}을(를) 지웠어요`, { type: 'info', duration: 3500, action: { label: '실행 취소', run: () => App.undo.undo() } });
    }

    let markerPop = null;

    function editMarker(path, id, anchor, { addEntry = null } = {}) {
        const m = App.catalog.get(path).markers.find((x) => x.id === id);
        if (!m || !anchor) return;
        markerPop?.close();
        let color = m.color || 'accent';
        let removed = false;
        const title = h('input', { class: 'input vw-mk-title', type: 'text', placeholder: '마커 이름 (선택)', spellcheck: 'false' });
        title.value = m.title || '';
        const memo = h('textarea', { class: 'textarea vw-mk-memo', placeholder: '메모 (선택)', rows: '2' });
        memo.value = m.memo || '';
        const swatches = h('div', { class: 'vw-mk-colors', role: 'radiogroup', 'aria-label': '색' },
            ...MARK_COLORS.map((c) => h('button', {
                class: `vw-mk-color${c === color ? ' on' : ''}`,
                style: `--c:${markColor(c)}`,
                'aria-label': c,
                onmousedown: (e) => e.preventDefault(),
                onclick: (e) => {
                    color = c;
                    swatches.querySelectorAll('.vw-mk-color').forEach((n) => n.classList.toggle('on', n === e.currentTarget));
                },
            })));
        const box = h('div', { class: 'vw-mk-pop' },
            h('div', { class: 'vw-mk-head' }, h('span', { class: 'vw-mk-time', html: `${ui.icon('bookmark', { size: 13 })}<span>${fmt(m.t, true)}</span>` }), h('div', { class: 'grow' }), swatches),
            title,
            memo,
            h('div', { class: 'vw-mk-foot' },
                h('button', {
                    class: 'btn sm ghost vw-mk-del',
                    html: `${ui.icon('trash', { size: 13 })}<span>삭제</span>`,
                    onclick: () => {
                        removed = true;
                        pop.close();
                        removeMarkerUndoable(path, id);
                    },
                }),
                h('div', { class: 'grow' }),
                h('span', { class: 'vw-mk-hint', html: `<span class="kbd">Enter</span> 저장` }),
                h('button', { class: 'btn sm primary', text: '완료', onclick: () => pop.close() })));
        const pop = ui.popover(anchor, box, {
            above: true,
            class: 'vw-mk-popover',
            padding: '12px',
            onClose: () => {
                if (markerPop === pop) markerPop = null;
                if (removed) return;
                const patch = { title: title.value.trim(), memo: memo.value.trim(), color: color === 'accent' ? null : color };
                const cur = App.catalog.get(path).markers.find((x) => x.id === id);
                if (cur && (cur.title !== patch.title || (cur.memo || '') !== patch.memo || (cur.color || null) !== patch.color)) patchMarkerUndoable(path, id, patch, addEntry);
            },
        });
        markerPop = pop;
        title.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault();
                pop.close();
            }
        });
        memo.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
                e.preventDefault();
                pop.close();
            }
        });
        requestAnimationFrame(() => title.focus());
    }

    // ---------- Seek-bar frame preview (second, muted video element) ----------
    const preview = {
        owner: null,
        video: null,
        canvas: null,
        busy: false,
        want: null,
        ensure(player) {
            if (player.source !== 'file' || !player.video.currentSrc) return false;
            if (this.owner !== player) {
                this.drop(this.owner);
                this.owner = player;
                this.video = document.createElement('video');
                this.video.muted = true;
                this.video.preload = 'auto';
                this.video.src = player.video.currentSrc;
                this.video.addEventListener('seeked', () => this.draw());
            }
            return true;
        },
        request(player, t, canvas) {
            if (!this.ensure(player)) return false;
            this.canvas = canvas;
            this.want = t;
            if (!this.busy && this.video.readyState >= 1) {
                this.busy = true;
                this.video.currentTime = t;
            } else if (!this.busy) {
                this.video.addEventListener('loadedmetadata', () => this.request(player, this.want, this.canvas), { once: true });
            }
            return true;
        },
        draw() {
            const v = this.video;
            const c = this.canvas;
            this.busy = false;
            if (!c || !v.videoWidth) return;
            const o = this.owner ? V.orientationOf(this.owner.path) : { rot: 0 };
            const rot = o.rot;
            const swap = rot % 180 !== 0;
            const vw = swap ? v.videoHeight : v.videoWidth;
            const vh = swap ? v.videoWidth : v.videoHeight;
            const W = 168;
            const H = Math.round(Math.min(120, (W * vh) / vw));
            const Wd = Math.round((H * vw) / vh);
            c.width = Wd * 2;
            c.height = H * 2;
            c.style.width = `${Wd}px`;
            c.style.height = `${H}px`;
            const g = c.getContext('2d');
            g.save();
            g.translate(c.width / 2, c.height / 2);
            g.rotate((rot * Math.PI) / 180);
            g.scale(o.flipH ? -1 : 1, o.flipV ? -1 : 1);
            const dw = swap ? c.height : c.width;
            const dh = swap ? c.width : c.height;
            g.drawImage(v, -dw / 2, -dh / 2, dw, dh);
            g.restore();
            c.classList.add('ready');
            if (this.want != null && Math.abs(v.currentTime - this.want) > 0.25) {
                this.busy = true;
                v.currentTime = this.want;
            }
        },
        drop(player) {
            if (!player || this.owner !== player) return;
            if (this.video) {
                this.video.removeAttribute('src');
                try {
                    this.video.load();
                } catch (e) {
                    /* ignore */
                }
            }
            this.owner = null;
            this.video = null;
            this.busy = false;
        },
    };

    // ---------- Control bar (one, rebinds to the active player) ----------
    const bar = {
        el: null,
        player: null,
        showRemaining: false,

        build() {
            if (this.el || !V.overlayEl) return;
            const B = (ic, tip, keys, fn, cls = '') => V.button(ic, tip, keys, fn, { class: `sm ${cls}` });

            // seek bar
            this.buffered = h('div', { class: 'vw-seek-buffered' });
            this.played = h('div', { class: 'vw-seek-played' });
            this.knob = h('div', { class: 'vw-seek-knob' });
            this.rangesEl = h('div', { class: 'vw-seek-ranges' });
            this.marksEl = h('div', { class: 'vw-seek-marks' });
            this.hoverTime = h('span', { class: 'vw-seek-hover-time' });
            this.hoverCanvas = h('canvas', { class: 'vw-seek-preview' });
            this.hoverEl = h('div', { class: 'vw-seek-hover', hidden: true }, this.hoverCanvas, this.hoverTime);
            this.hoverLine = h('div', { class: 'vw-seek-hover-line', hidden: true });
            this.track = h('div', { class: 'vw-seek-track' }, this.buffered, this.played, this.rangesEl, this.hoverLine);
            this.seekEl = h('div', { class: 'vw-seek', role: 'slider', 'aria-label': '재생 위치', 'aria-valuemin': '0' }, this.track, this.marksEl, this.knob, this.hoverEl);

            // controls
            this.playBtn = B('play', '재생', 'Space', () => App.commands.run('viewer.playPause'), 'vw-play');
            this.backBtn = h('button', { class: 'btn ghost sm vw-btn vw-step-btn', onmousedown: (e) => e.preventDefault(), onclick: () => App.commands.run('video.seekBack') });
            this.fwdBtn = h('button', { class: 'btn ghost sm vw-btn vw-step-btn', onmousedown: (e) => e.preventDefault(), onclick: () => App.commands.run('video.seekForward') });
            this.timeEl = h('button', { class: 'vw-time', 'data-tip': '남은 시간 보기', onmousedown: (e) => e.preventDefault(), onclick: () => {
                this.showRemaining = !this.showRemaining;
                this.update();
            } });
            this.rateBtn = h('button', { class: 'btn ghost sm vw-btn vw-rate', 'data-tip': '재생 속도', 'data-tip-keys': ']', onmousedown: (e) => e.preventDefault(), onclick: (e) => this.rateMenu(e.currentTarget) });
            this.stepBtn = h('button', { class: 'btn ghost sm vw-btn vw-stepset', 'data-tip': '← → 로 이동하는 간격', onmousedown: (e) => e.preventDefault(), onclick: (e) => this.stepMenu(e.currentTarget) });
            this.abBtn = B('vw-repeat', '구간 반복 (A 지점 → B 지점 → 끄기)', 'A', () => App.commands.run('video.loop'), 'vw-ab');
            this.abLabel = h('span', { class: 'vw-ab-label' });
            this.abBtn.append(this.abLabel);
            this.markBtn = B('bookmark', '마커 추가', 'B', () => App.commands.run('video.marker'));
            this.listBtn = B('vw-list-marker', '마커 목록', 'Shift+B', () => App.commands.run('video.markerList'), 'vw-list');
            this.listCount = h('span', { class: 'vw-count' });
            this.listBtn.append(this.listCount);
            this.capBtn = B('camera', '장면 캡처 (JPG로 저장)', 'C', () => App.commands.run('video.capture'));
            this.posterBtn = B('vw-poster', '이 장면을 썸네일로', 'Shift+C', () => App.commands.run('viewer.setPoster'));
            this.volBtn = B('volume', '음소거', 'M', () => App.commands.run('video.mute'), 'vw-volbtn');
            this.volFill = h('div', { class: 'vw-vol-fill' });
            this.volKnob = h('div', { class: 'vw-vol-knob' });
            this.volTrack = h('div', { class: 'vw-vol-track', role: 'slider', 'aria-label': '소리 크기', 'data-tip': '소리 크기', 'data-tip-keys': 'ArrowUp' }, h('div', { class: 'vw-vol-rail' }, this.volFill), this.volKnob);
            this.vol = h('div', { class: 'vw-vol' }, this.volBtn, this.volTrack);
            this.editBtn = B('scissors', '영상 편집', 'E', () => App.commands.run('video.editor'), 'vw-edit');
            this.fsBtn = B('maximize', '전체 화면', 'F', () => App.commands.run('viewer.fullscreen'));
            this.frameBack = B('vw-frame-prev', '이전 프레임', ',', () => App.commands.run('video.frameBack'), 'vw-opt');
            this.frameFwd = B('vw-frame-next', '다음 프레임', '.', () => App.commands.run('video.frameForward'), 'vw-opt');

            this.el = h('div', { class: 'vw-ctl', hidden: true },
                this.seekEl,
                h('div', { class: 'vw-ctl-row' },
                    h('div', { class: 'vw-ctl-group' }, this.playBtn, this.backBtn, this.fwdBtn, this.frameBack, this.frameFwd, this.timeEl),
                    h('div', { class: 'grow' }),
                    h('div', { class: 'vw-ctl-group' }, this.markBtn, this.listBtn, this.abBtn, this.capBtn, this.posterBtn),
                    h('span', { class: 'vw-sep' }),
                    h('div', { class: 'vw-ctl-group' }, this.rateBtn, this.stepBtn),
                    h('span', { class: 'vw-sep' }),
                    this.vol,
                    h('span', { class: 'vw-sep' }),
                    h('div', { class: 'vw-ctl-group' }, this.editBtn, this.fsBtn)));
            V.overlayEl.append(this.el);
            this.bindSeek();
            this.bindVolume();
            this.el.addEventListener('dblclick', (e) => e.stopPropagation());
        },

        bind(player) {
            if (player) this.build();
            if (!this.el) return;
            this.player = player;
            this.el.hidden = !player;
            if (!player) return;
            this.update();
            this.updateBuffered();
            this.renderMarks();
            this.renderRanges();
        },

        pct(t) {
            const d = this.player?.duration;
            return d ? clamp((t / d) * 100, 0, 100) : 0;
        },

        // Full refresh (play state, rate, volume, buttons) — on events, not every frame.
        update(forcedTime) {
            const p = this.player;
            if (!p || !this.el) return;
            this.updateTime(forcedTime);
            const set = (el, key, html) => {
                if (el[key] !== html) {
                    el[key] = html;
                    el.innerHTML = html;
                }
            };
            const playing = p.playing;
            set(this.playBtn, '_html', V.icon(playing ? 'pause' : 'play'));
            this.playBtn.dataset.tip = playing ? '일시정지' : '재생';
            this.playBtn.setAttribute('aria-label', this.playBtn.dataset.tip);
            const step = seekStepSec();
            set(this.backBtn, '_html', `${V.icon('vw-seek-back')}<span>${step}</span>`);
            set(this.fwdBtn, '_html', `${V.icon('vw-seek-fwd')}<span>${step}</span>`);
            this.backBtn.dataset.tip = `${step}초 뒤로`;
            this.backBtn.dataset.tipKeys = 'ArrowLeft';
            this.fwdBtn.dataset.tip = `${step}초 앞으로`;
            this.fwdBtn.dataset.tipKeys = 'ArrowRight';
            this.backBtn.setAttribute('aria-label', this.backBtn.dataset.tip);
            this.fwdBtn.setAttribute('aria-label', this.fwdBtn.dataset.tip);
            const rate = p.reverseRate ? -p.reverseRate : p.rate;
            this.rateBtn.textContent = rate < 0 ? `◀ ${-rate}×` : `${rate}×`;
            this.rateBtn.classList.toggle('active', rate !== 1);
            set(this.stepBtn, '_html', `${V.icon('clock', { size: 14 })}<span>${step}초</span>`);
            const v = p.video;
            const vol = v.muted ? 0 : v.volume;
            set(this.volBtn, '_html', V.icon(vol === 0 ? 'volume-x' : vol < 0.5 ? 'vw-volume-1' : 'volume'));
            this.volBtn.dataset.tip = v.muted ? '소리 켜기' : '음소거';
            this.volFill.style.width = `${vol * 100}%`;
            this.volKnob.style.left = `${vol * 100}%`;
            this.volTrack.setAttribute('aria-valuenow', String(Math.round(vol * 100)));
            this.abBtn.classList.toggle('active', p.loopA != null);
            this.abLabel.textContent = p.loopA != null && p.loopB == null ? 'A' : p.loopB != null ? 'A-B' : '';
            const n = p.markers().length;
            this.listCount.textContent = n ? String(n) : '';
            this.listBtn.classList.toggle('active', V.isPanelOpen('markers'));
            this.editBtn.classList.toggle('active', V.isPanelOpen('editor'));
            const fs = !!document.fullscreenElement;
            set(this.fsBtn, '_html', V.icon(fs ? 'vw-minimize' : 'maximize'));
            this.fsBtn.dataset.tip = fs ? '전체 화면 끝내기' : '전체 화면';
            this.el.classList.toggle('is-failed', !!p.failed);
        },

        // Cheap per-frame refresh: progress, knob and the clock.
        updateTime(forcedTime) {
            const p = this.player;
            if (!p || !this.el) return;
            const t = forcedTime ?? p.time;
            const d = p.duration;
            const w = `${this.pct(t)}%`;
            if (this._w !== w) {
                this._w = w;
                this.played.style.width = w;
                this.knob.style.left = w;
            }
            const html = `<span class="vw-time-cur">${this.showRemaining && d ? fmt(t - d) : fmt(t)}</span><span class="vw-time-sep">/</span><span class="vw-time-dur">${d ? fmt(d) : '–:––'}</span>`;
            if (this._timeHtml !== html) {
                this._timeHtml = html;
                this.timeEl.innerHTML = html;
                this.seekEl.setAttribute('aria-valuemax', String(Math.round(d || 0)));
                this.seekEl.setAttribute('aria-valuenow', String(Math.round(t)));
                this.seekEl.setAttribute('aria-valuetext', fmt(t));
                this.posterBtn.classList.toggle('active', p.meta.posterT != null && Math.abs(p.meta.posterT - t) < 0.5);
            }
        },

        updateBuffered() {
            const p = this.player;
            if (!p || !this.el) return;
            const v = p.video;
            const d = p.duration;
            const off = p.ts ? p.ts.offset : 0;
            const b = v.buffered;
            const t = v.currentTime;
            let start = 0;
            let end = 0;
            for (let i = 0; i < b.length; i++) {
                if (t >= b.start(i) - 0.5 && t <= b.end(i) + 0.5) {
                    start = b.start(i);
                    end = b.end(i);
                }
            }
            if (!d || end <= start) {
                this.buffered.style.width = '0';
                return;
            }
            this.buffered.style.left = `${clamp(((start + off) / d) * 100, 0, 100)}%`;
            this.buffered.style.width = `${clamp(((end - start) / d) * 100, 0, 100)}%`;
        },

        renderRanges() {
            const p = this.player;
            if (!p || !this.el) return;
            this.rangesEl.innerHTML = '';
            const d = p.duration;
            if (!d) return;
            const add = (a, b, cls) => {
                const lo = Math.min(a, b);
                const hi = Math.max(a, b);
                this.rangesEl.append(h('div', { class: `vw-range ${cls}`, style: { left: `${this.pct(lo)}%`, width: `${Math.max(0.3, this.pct(hi) - this.pct(lo))}%` } }));
            };
            for (const list of p.ranges.values()) for (const r of list) if (r.end != null && r.start != null) add(r.start, r.end, `is-${r.kind || 'segment'}`);
            if (p.loopA != null && p.loopB != null) add(p.loopA, p.loopB, 'is-loop');
            else if (p.loopA != null) add(p.loopA, p.loopA + d * 0.002, 'is-loop-a');
        },

        renderMarks() {
            const p = this.player;
            if (!p || !this.el) return;
            this.marksEl.innerHTML = '';
            const d = p.duration;
            const ms = p.markers();
            this.listCount.textContent = ms.length ? String(ms.length) : '';
            if (!d) return;
            for (const m of ms) {
                const el = h('button', {
                    class: 'vw-mark',
                    dataset: { id: m.id },
                    style: `left:${this.pct(m.t)}%;--c:${markColor(m.color)}`,
                    'aria-label': `마커 ${fmt(m.t)}`,
                    'data-tip': `${m.title ? `${m.title} · ` : ''}${fmt(m.t)}${m.memo ? ` — ${m.memo.slice(0, 60)}` : ''}`,
                    onmousedown: (e) => e.preventDefault(),
                    onpointerdown: (e) => e.stopPropagation(),
                    onclick: (e) => {
                        e.stopPropagation();
                        p.seek(m.t);
                    },
                    ondblclick: (e) => {
                        e.stopPropagation();
                        editMarker(p.path, m.id, e.currentTarget);
                    },
                    oncontextmenu: (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        ui.menu([
                            { label: '이 마커로 이동', icon: 'play', action: () => p.seek(m.t) },
                            { label: '이름·메모 편집', icon: 'edit', action: () => editMarker(p.path, m.id, this.markEl(m.id)) },
                            '-',
                            { label: '마커 삭제', icon: 'trash', danger: true, action: () => removeMarkerUndoable(p.path, m.id) },
                        ], { x: e.clientX, y: e.clientY });
                    },
                });
                this.marksEl.append(el);
            }
        },

        markEl(id) {
            return this.marksEl?.querySelector(`.vw-mark[data-id="${CSS.escape(id)}"]`) || null;
        },

        timeAt(clientX) {
            const r = this.track.getBoundingClientRect();
            const d = this.player?.duration || 0;
            return clamp((clientX - r.left) / r.width, 0, 1) * d;
        },

        bindSeek() {
            const el = this.seekEl;
            let scrub = null;
            let raf = 0;
            let lastX = 0;
            const showHover = (x) => {
                const p = this.player;
                if (!p || !p.duration) return;
                const r = this.track.getBoundingClientRect();
                const t = this.timeAt(x);
                const left = clamp(x - r.left, 0, r.width);
                this.hoverTime.textContent = fmt(t, p.duration < 600);
                this.hoverEl.hidden = false;
                this.hoverLine.hidden = false;
                this.hoverLine.style.left = `${left}px`;
                const hasPreview = !scrub && preview.request(p, t, this.hoverCanvas);
                this.hoverCanvas.hidden = !hasPreview;
                const w = this.hoverEl.offsetWidth || 60;
                this.hoverEl.style.left = `${clamp(left, w / 2 - 6, r.width - w / 2 + 6)}px`;
            };
            el.addEventListener('pointerdown', (e) => {
                const p = this.player;
                if (e.button !== 0 || !p || !p.duration) return;
                e.preventDefault();
                el.setPointerCapture(e.pointerId);
                scrub = { id: e.pointerId, wasPlaying: p.playing };
                el.classList.add('is-scrubbing');
                if (p.playing) p.video.pause();
                p.stopReverse();
                p.seek(this.timeAt(e.clientX));
                showHover(e.clientX);
            });
            el.addEventListener('pointermove', (e) => {
                lastX = e.clientX;
                if (raf) return;
                raf = requestAnimationFrame(() => {
                    raf = 0;
                    if (scrub && this.player) this.player.seek(this.timeAt(lastX));
                    showHover(lastX);
                });
            });
            const end = (e) => {
                if (!scrub || e.pointerId !== scrub.id) return;
                const s = scrub;
                scrub = null;
                el.classList.remove('is-scrubbing');
                try {
                    el.releasePointerCapture(e.pointerId);
                } catch (_) {
                    /* ignore */
                }
                if (s.wasPlaying) this.player?.play();
            };
            el.addEventListener('pointerup', end);
            el.addEventListener('pointercancel', end);
            el.addEventListener('pointerleave', () => {
                if (scrub) return;
                this.hoverEl.hidden = true;
                this.hoverLine.hidden = true;
                this.hoverCanvas.classList.remove('ready');
            });
        },

        bindVolume() {
            const tr = this.volTrack;
            let drag = false;
            const setFrom = (x) => {
                const r = tr.getBoundingClientRect();
                this.player?.setVolume(clamp((x - r.left) / r.width, 0, 1));
            };
            tr.addEventListener('pointerdown', (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                drag = true;
                tr.setPointerCapture(e.pointerId);
                this.vol.classList.add('is-dragging');
                setFrom(e.clientX);
            });
            tr.addEventListener('pointermove', (e) => drag && setFrom(e.clientX));
            const end = (e) => {
                drag = false;
                this.vol.classList.remove('is-dragging');
                try {
                    tr.releasePointerCapture(e.pointerId);
                } catch (_) {
                    /* ignore */
                }
            };
            tr.addEventListener('pointerup', end);
            tr.addEventListener('pointercancel', end);
            this.vol.addEventListener('wheel', (e) => {
                e.preventDefault();
                this.player?.volumeBy(e.deltaY < 0 ? 0.05 : -0.05);
            }, { passive: false });
        },

        rateMenu(anchor) {
            const p = this.player;
            if (!p) return;
            ui.menu([
                { header: '재생 속도' },
                ...[...RATES].reverse().map((r) => ({ label: r === 1 ? '보통 (1×)' : `${r}×`, checked: Math.abs(p.rate - r) < 1e-6 && !p.reverseRate, action: () => p.setRate(r) })),
            ], { anchor, align: 'end' });
        },

        stepMenu(anchor) {
            const cur = seekStepSec();
            ui.menu([
                { header: '← → 로 이동하는 간격' },
                ...SEEK_STEPS.map((s) => ({ label: `${s}초`, checked: s === cur, action: () => setSeekStep(s) })),
                '-',
                {
                    label: '직접 입력…',
                    icon: 'edit',
                    action: async () => {
                        const v = await ui.prompt({
                            title: '이동 간격',
                            message: '←/→ 키로 영상을 몇 초씩 건너뛸지 정해요 (1–60초).',
                            value: String(cur),
                            okLabel: '저장',
                            validate: (x) => (/^\d+$/.test(x) && Number(x) >= 1 && Number(x) <= 60 ? null : '1에서 60 사이의 숫자를 입력해 주세요'),
                        });
                        if (v) setSeekStep(Number(v));
                    },
                },
            ], { anchor, align: 'end' });
        },
    };

    function setSeekStep(s) {
        App.settings.set('viewer.seekStep', clamp(Math.round(s), 1, 60));
        bar.update();
        V.refreshHints();
        V.osd(`이동 간격 ${seekStepSec()}초`, { icon: 'clock' });
    }

    // ---------- Marker panel (dock) ----------
    function renderMarkerPanel(body) {
        body.innerHTML = '';
        const entry = V.current;
        const p = V.player;
        if (!entry || entry.type !== 'video') {
            body.append(h('div', { class: 'vw-dock-empty' }, h('div', { class: 'vw-dock-empty-icon', html: ui.icon('bookmark', { size: 22 }) }), h('p', { text: '영상을 열면 마커가 여기에 나와요.' })));
            return;
        }
        const list = [...App.catalog.get(entry.path).markers].sort((a, b) => a.t - b.t);
        const head = h('div', { class: 'vw-mk-panel-head' },
            h('span', { class: 'muted', text: list.length ? `마커 ${list.length}개` : '마커 없음' }),
            h('div', { class: 'grow' }),
            h('button', { class: 'btn sm', html: `${ui.icon('plus', { size: 13 })}<span>지금 장면에 추가</span>`, onmousedown: (e) => e.preventDefault(), onclick: () => App.commands.run('video.marker') }));
        body.append(head);
        if (!list.length) {
            body.append(h('div', { class: 'vw-dock-empty' },
                h('div', { class: 'vw-dock-empty-icon', html: ui.icon('bookmark', { size: 22 }) }),
                h('p', { html: `재생하다가 <span class="kbd">B</span>를 누르면 지금 장면에 마커가 생겨요. 이름과 메모를 붙여 두면 나중에 바로 찾아갈 수 있어요.` })));
            return;
        }
        const ul = h('div', { class: 'vw-mk-list', role: 'list' });
        const t = p ? p.time : 0;
        let currentId = null;
        for (const m of list) if (m.t <= t + 0.05) currentId = m.id;
        for (const m of list) {
            const row = h('div', { class: `vw-mk-row${m.id === currentId ? ' is-current' : ''}`, role: 'listitem', tabindex: '0', dataset: { id: m.id } },
                h('span', { class: 'vw-mk-dot', style: `--c:${markColor(m.color)}` }),
                h('button', { class: 'vw-mk-t', text: fmt(m.t, true), onmousedown: (e) => e.preventDefault(), onclick: () => V.player?.seek(m.t) }),
                h('div', { class: 'vw-mk-body' },
                    h('div', { class: `vw-mk-name${m.title ? '' : ' faint'}`, text: m.title || '이름 없음' }),
                    m.memo ? h('div', { class: 'vw-mk-memo-text', text: m.memo }) : null),
                h('div', { class: 'vw-mk-actions' },
                    V.button('edit', '이름·메모 편집', null, (e) => {
                        const anchor = bar.markEl(m.id) || e.currentTarget;
                        editMarker(entry.path, m.id, anchor);
                    }, { class: 'sm' }),
                    V.button('trash', '삭제', null, () => removeMarkerUndoable(entry.path, m.id), { class: 'sm' })));
            row.addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                V.player?.seek(m.t);
            });
            row.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    V.player?.seek(m.t);
                } else if (e.key === 'Delete' || e.key === 'Backspace') {
                    e.preventDefault();
                    removeMarkerUndoable(entry.path, m.id);
                }
            });
            ul.append(row);
        }
        body.append(ul);
    }

    V.registerPanel({
        id: 'markers',
        title: '마커',
        icon: 'bookmark',
        keys: 'Shift+B',
        toolbar: true,
        render(body) {
            renderMarkerPanel(body);
            const offs = [
                App.bus.on('catalog:changed', ({ paths }) => {
                    if (paths?.includes(V.current?.path)) renderMarkerPanel(body);
                }),
                App.bus.on('viewer:video-time', App.util.throttle(() => {
                    const p = V.player;
                    if (!p) return;
                    const rows = body.querySelectorAll('.vw-mk-row');
                    let cur = null;
                    for (const r of rows) {
                        const m = p.markers().find((x) => x.id === r.dataset.id);
                        if (m && m.t <= p.time + 0.05) cur = r;
                    }
                    rows.forEach((r) => r.classList.toggle('is-current', r === cur));
                }, 250)),
            ];
            return () => offs.forEach((off) => off());
        },
        onEntry() {
            V.refreshPanel('markers');
        },
        hints: () => [{ keys: ['B'], label: '마커 추가' }, { keys: [V.dk('Shift+ArrowLeft'), V.dk('Shift+ArrowRight')], label: '이전/다음 마커' }, { keys: ['Shift+B'], label: '목록 닫기' }],
    });

    V.registerRenderer('video', {
        mount(ctx) {
            return new Player(ctx);
        },
    });

    App.bus.on('viewer:entry', ({ entry }) => {
        if (entry.type !== 'video' && bar.el) bar.el.hidden = true;
        markerPop?.close();
    });
    App.bus.on('catalog:changed', ({ paths }) => {
        const p = V.player;
        if (p && paths?.includes(p.path)) {
            bar.renderMarks();
            bar.update();
        }
    });
    App.bus.on('settings:changed', ({ key }) => {
        if (key === 'viewer.seekStep' && V.player) {
            bar.update();
            V.refreshHints();
        }
    });
    document.addEventListener('fullscreenchange', () => bar.player && bar.update());

    // ---------- Commands ----------
    const hasPlayer = () => V.isOpen && V.kind === 'video' && !!V.player && !V.player.failed;
    const reg = (cmd) => App.commands.register({ group: '영상', scope: 'viewer', when: hasPlayer, ...cmd });
    reg({ id: 'video.playPause', title: '재생/일시정지', icon: 'play', keys: ['K'], run: () => V.player.toggle() });
    // ←/→ reach these through viewer.prev / viewer.next (they seek while a video plays, change file for photos)
    reg({ id: 'video.seekBack', title: '뒤로 건너뛰기', icon: 'vw-seek-back', run: () => V.player.seekStep(-1) });
    reg({ id: 'video.seekForward', title: '앞으로 건너뛰기', icon: 'vw-seek-fwd', run: () => V.player.seekStep(1) });
    reg({ id: 'video.frameBack', title: '이전 프레임', icon: 'vw-frame-prev', keys: [','], run: () => V.player.frameStep(-1) });
    reg({ id: 'video.frameForward', title: '다음 프레임', icon: 'vw-frame-next', keys: ['.'], run: () => V.player.frameStep(1) });
    reg({ id: 'video.slower', title: '느리게 재생', icon: 'vw-gauge', keys: ['['], run: () => V.player.nudgeRate(-1) });
    reg({ id: 'video.faster', title: '빠르게 재생', icon: 'vw-gauge', keys: [']'], run: () => V.player.nudgeRate(1) });
    reg({ id: 'video.reverse', title: '뒤로 재생 (누를수록 빠르게)', icon: 'vw-seek-back', keys: ['J'], run: () => V.player.jkl(-1) });
    reg({ id: 'video.forward', title: '앞으로 재생 (누를수록 빠르게)', icon: 'play', keys: ['L'], run: () => V.player.jkl(1) });
    reg({ id: 'video.normalSpeed', title: '보통 속도로', icon: 'vw-gauge', keys: ['Shift+Backspace'], run: () => V.player.setRate(1) });
    reg({ id: 'video.mute', title: '음소거', icon: 'volume-x', keys: ['M'], run: () => V.player.toggleMute() });
    reg({ id: 'video.volumeUp', title: '소리 크게', icon: 'volume', keys: ['ArrowUp'], run: () => V.player.volumeBy(0.05) });
    reg({ id: 'video.volumeDown', title: '소리 작게', icon: 'vw-volume-1', keys: ['ArrowDown'], run: () => V.player.volumeBy(-0.05) });
    reg({ id: 'video.marker', title: '마커 추가', icon: 'bookmark', keys: ['B'], run: () => V.player.addMarker() });
    reg({ id: 'video.markerList', title: '마커 목록', icon: 'vw-list-marker', keys: ['Shift+B'], when: () => V.isOpen && V.kind === 'video', run: () => V.togglePanel('markers') });
    reg({ id: 'video.prevMarker', title: '이전 마커로', icon: 'bookmark', keys: ['Shift+ArrowLeft'], run: () => V.player.jumpMarker(-1) });
    reg({ id: 'video.nextMarker', title: '다음 마커로', icon: 'bookmark', keys: ['Shift+ArrowRight'], run: () => V.player.jumpMarker(1) });
    reg({ id: 'video.loop', title: '구간 반복 (A-B)', icon: 'vw-repeat', keys: ['A'], run: () => V.player.cycleLoop() });
    reg({ id: 'video.capture', title: '장면 캡처', icon: 'camera', keys: ['C'], run: () => V.player.capture() });
    reg({ id: 'viewer.setPoster', title: '이 장면을 썸네일로', icon: 'vw-poster', keys: ['Shift+C'], run: () => V.player.setPoster() });
    reg({ id: 'video.seekStep', title: '이동 간격 바꾸기', icon: 'clock', run: () => bar.stepMenu(bar.stepBtn) });
    reg({
        id: 'video.serverStream',
        title: '서버로 재생',
        icon: 'server',
        when: () => hasPlayer() && serverStreamReady() && V.player.source !== 'stream',
        run: () => V.player.useServerStream(),
    });

    V.contextItems.push((entry, kind) => {
        if (kind !== 'video' || !V.player) return [];
        const p = V.player;
        const items = [
            { label: p.playing ? '일시정지' : '재생', icon: p.playing ? 'pause' : 'play', command: 'viewer.playPause' },
            { label: '장면 캡처', icon: 'camera', command: 'video.capture' },
            { label: '이 장면을 썸네일로', icon: 'vw-poster', command: 'viewer.setPoster' },
            { label: '마커 추가', icon: 'bookmark', command: 'video.marker' },
            {
                label: '재생 속도',
                icon: 'vw-gauge',
                submenu: () => [...RATES].reverse().map((r) => ({ label: `${r}×`, checked: Math.abs(p.rate - r) < 1e-6, action: () => p.setRate(r) })),
            },
        ];
        if (serverStreamReady() && p.source !== 'stream') items.push({ label: '서버로 재생', icon: 'server', command: 'video.serverStream' });
        return items;
    });

    V.fmtTime = fmt;
})();
