/*
 * Viewer extras: virtualized filmstrip of the neighbours (T), info overlay with metadata/EXIF (I),
 * slideshow with adjustable interval, shuffle/loop and a crossfade (S).
 *   App.viewer.slideshow — { running, paused, start(), stop(), togglePause(), setInterval(sec), menu(anchor) }
 */
(() => {
    'use strict';
    const { h, path: P, clamp, formatBytes, formatDate, formatDuration, escapeHtml, formatCount } = App.util;
    const ui = App.ui;
    const V = App.viewer;

    // ---------- Filmstrip ----------
    const CELL_W = 76;
    const GAP = 6;
    const PAD = 14;
    const BUFFER = 6;

    let strip = null;
    let scroller = null;
    let canvas = null;
    const cells = new Map(); // path -> element
    let rafPending = false;

    function stripOn() {
        return App.settings.get('viewer.filmstrip', true);
    }

    function ensureStrip() {
        if (strip || !V.root) return;
        const host = V.root.querySelector('.vw-strip-host');
        canvas = h('div', { class: 'vw-strip-canvas', role: 'listbox', 'aria-label': '필름 스트립' });
        scroller = h('div', { class: 'vw-strip-scroll' }, canvas);
        strip = h('div', { class: 'vw-strip' }, scroller);
        host.append(strip);
        scroller.addEventListener('scroll', scheduleStrip, { passive: true });
        scroller.addEventListener('wheel', (e) => {
            if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
            e.preventDefault();
            scroller.scrollLeft += e.deltaY;
        }, { passive: false });
        canvas.addEventListener('click', (e) => {
            const cell = e.target.closest('.vw-cell');
            if (!cell) return;
            const i = V.files.findIndex((f) => f.path === cell.dataset.path);
            if (i >= 0 && i !== V.index) V.go(i);
        });
        canvas.addEventListener('mousedown', (e) => e.preventDefault());
        new ResizeObserver(scheduleStrip).observe(scroller);
    }

    function scheduleStrip() {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
            rafPending = false;
            renderStrip();
        });
    }

    function describeOrientation(p) {
        const t = V.orientationOf(p);
        return V.isIdentityTransform(t) ? null : `${V.describeTransform(t)} (보기만, 파일은 그대로)`;
    }

    function buildCell(entry) {
        const cell = h('div', { class: 'vw-cell', role: 'option', dataset: { path: entry.path }, title: entry.name });
        V.applyTransformVars(cell, V.orientationOf(entry.path)); // rotated/flipped like in the viewer
        const img = h('img', { alt: '', draggable: 'false' });
        cell.append(img);
        if (entry.type === 'video') cell.append(h('span', { class: 'vw-cell-badge', html: ui.icon('play', { size: 8 }) }));
        const show = (url) => {
            if (!url) {
                cell.classList.add('no-thumb');
                cell.insertAdjacentHTML('beforeend', `<span class="vw-cell-ext">${escapeHtml((entry.ext || '').toUpperCase())}</span>`);
                return;
            }
            img.src = url;
            cell.classList.add('has-thumb');
        };
        const cached = App.thumbs?.peek?.(entry);
        if (cached) show(cached);
        else if (App.thumbs?.canThumb?.(entry)) App.thumbs.get(entry).then((url) => cell.isConnected && show(url));
        else show(null);
        return cell;
    }

    // Left edge of the first cell: centered when everything fits, otherwise the normal padding
    function stripStart() {
        const n = V.files.length;
        const total = PAD * 2 + n * CELL_W + Math.max(0, n - 1) * GAP;
        return PAD + Math.max(0, (scroller.clientWidth - total) / 2);
    }

    function renderStrip() {
        if (!strip || !V.isOpen || !stripOn()) return;
        const files = V.files;
        const n = files.length;
        const start = stripStart();
        canvas.style.width = `${start + PAD + n * CELL_W + Math.max(0, n - 1) * GAP}px`;
        const left = scroller.scrollLeft;
        const width = scroller.clientWidth;
        const first = Math.max(0, Math.floor((left - start) / (CELL_W + GAP)) - BUFFER);
        const last = Math.min(n - 1, Math.ceil((left + width - start) / (CELL_W + GAP)) + BUFFER);
        const wanted = new Set();
        for (let i = first; i <= last; i++) wanted.add(files[i].path);
        for (const [p, el] of cells) {
            if (!wanted.has(p)) {
                el.remove();
                cells.delete(p);
            }
        }
        const onScreen = [];
        for (let i = first; i <= last; i++) {
            const e = files[i];
            let el = cells.get(e.path);
            if (!el) {
                el = buildCell(e);
                cells.set(e.path, el);
                canvas.append(el);
            }
            el.style.transform = `translateX(${start + i * (CELL_W + GAP)}px)`;
            const cur = i === V.index;
            el.classList.toggle('is-current', cur);
            el.setAttribute('aria-selected', cur ? 'true' : 'false');
            onScreen.push(e.path);
        }
        App.thumbs?.prioritize?.(onScreen);
    }

    function scrollStripToCurrent() {
        if (!strip || !stripOn()) return;
        const target = stripStart() + V.index * (CELL_W + GAP) + CELL_W / 2 - scroller.clientWidth / 2;
        const far = Math.abs(target - scroller.scrollLeft) > scroller.clientWidth * 1.5;
        scroller.scrollTo({ left: Math.max(0, target), behavior: far ? 'auto' : 'smooth' });
        scheduleStrip();
    }

    function resetStrip() {
        for (const el of cells.values()) el.remove();
        cells.clear();
        scheduleStrip();
    }

    // ---------- Info overlay ----------
    let infoEl = null;
    const exifPending = new Set();

    function infoOn() {
        return App.settings.get('viewer.info', false);
    }

    function ensureInfo() {
        if (infoEl || !V.overlayEl) return;
        infoEl = h('div', { class: 'vw-info', hidden: true });
        V.overlayEl.append(infoEl);
    }

    function fmtExposure(t) {
        if (!t) return null;
        return t >= 1 ? `${Math.round(t * 10) / 10}초` : `1/${Math.round(1 / t)}초`;
    }

    function stars(n) {
        return n ? '★'.repeat(n) + '☆'.repeat(5 - n) : null;
    }

    function renderInfo() {
        if (!infoEl) return;
        const entry = V.current;
        if (!V.isOpen || !entry || !infoOn()) {
            infoEl.hidden = true;
            return;
        }
        const cat = App.catalog.get(entry.path);
        const meta = cat.meta || {};
        const video = entry.type === 'video';
        const player = video ? V.player : null;
        const nat = V.image?.full && V.image.entry.path === entry.path ? V.image.view.nat : null; // decoded photo size
        const w = meta.w || player?.video?.videoWidth || nat?.w || null;
        const hh = meta.h || player?.video?.videoHeight || nat?.h || null;
        const exposure = [meta.fnumber ? `f/${Math.round(meta.fnumber * 10) / 10}` : null, fmtExposure(meta.exposure), meta.iso ? `ISO ${meta.iso}` : null, meta.focal ? `${Math.round(meta.focal)}mm` : null].filter(Boolean).join(' · ');
        const duration = meta.duration && isFinite(meta.duration) ? meta.duration : player?.duration;
        const rows = [
            ['종류', `${video ? '영상' : entry.type === 'image' ? '사진' : '파일'} · ${(entry.ext || '').toUpperCase()}`],
            ['크기', formatBytes(entry.size)],
            ['해상도', w && hh ? `${w} × ${hh}${!video ? ` · ${(Math.round((w * hh) / 1e5) / 10).toLocaleString('ko-KR')}MP` : ''}` : null],
            ['길이', video && duration && isFinite(duration) ? formatDuration(duration) : null],
            ['프레임', video && (meta.fps || player?.fps) ? `${Math.round((meta.fps || player.fps) * 100) / 100} fps` : null],
            ['코덱', video && (meta.vcodec || meta.acodec) ? [meta.vcodec, meta.acodec].filter(Boolean).join(' / ') : null],
            ['찍은 날짜', meta.taken ? formatDate(meta.taken, true) : null],
            ['수정한 날짜', entry.mtime ? formatDate(entry.mtime, true) : null],
            ['카메라', meta.camera || null],
            ['렌즈', meta.lens || null],
            ['노출', exposure || null],
            ['방향', describeOrientation(entry.path)],
            ['별점', stars(cat.rating)],
            ['마커', video && cat.markers.length ? `${formatCount(cat.markers.length)}개` : null],
            ['대표 장면', video && meta.posterT != null ? formatDuration(meta.posterT) : null],
        ];
        infoEl.innerHTML = '';
        infoEl.append(h('div', { class: 'vw-info-name', text: entry.name, title: entry.path }));
        infoEl.append(h('div', { class: 'vw-info-path truncate', text: P.parent(entry.path) || App.state.workspace?.name || '' }));
        const table = h('div', { class: 'vw-info-table' });
        for (const [k, v] of rows) {
            if (v == null || v === '') continue;
            table.append(h('div', { class: 'vw-info-k', text: k }), h('div', { class: 'vw-info-v', text: v, title: String(v) }));
        }
        if (Array.isArray(meta.gps) && meta.gps.length === 2) {
            const [lat, lon] = meta.gps;
            table.append(h('div', { class: 'vw-info-k', text: '위치' }), h('div', { class: 'vw-info-v' },
                h('a', { href: `https://www.google.com/maps?q=${lat},${lon}`, target: '_blank', rel: 'noopener', html: `${V.icon('map-pin', { size: 13 })}<span>${lat.toFixed(4)}, ${lon.toFixed(4)}</span>` })));
        }
        infoEl.append(table);
        if (cat.memo) infoEl.append(h('div', { class: 'vw-info-memo', text: cat.memo.length > 240 ? cat.memo.slice(0, 240) + '…' : cat.memo }));
        if (!video && entry.type === 'image' && meta.exifAt == null && App.util.browserCanDecode(entry.name)) {
            infoEl.append(h('div', { class: 'vw-info-loading', html: '<span class="spinner"></span><span>촬영 정보를 읽는 중…</span>' }));
            readExif(entry);
        }
        infoEl.hidden = false;
    }

    async function readExif(entry) {
        if (exifPending.has(entry.path) || !window.exifr) {
            if (!window.exifr) App.catalog.setMeta(entry.path, { exifAt: Date.now() });
            return;
        }
        exifPending.add(entry.path);
        const meta = { exifAt: Date.now() };
        try {
            const file = await App.fs.getFile(entry.path);
            const x = await window.exifr.parse(file, { tiff: true, exif: true, gps: true, ifd1: false, xmp: false, icc: false, iptc: false, jfif: false, ihdr: false });
            if (x) {
                const taken = x.DateTimeOriginal || x.CreateDate || x.DateTimeDigitized;
                if (taken instanceof Date && !isNaN(taken)) meta.taken = taken.getTime();
                const make = String(x.Make || '').trim();
                const model = String(x.Model || '').trim();
                if (model) meta.camera = !make || model.toLowerCase().startsWith(make.toLowerCase().split(' ')[0]) ? model : `${make} ${model}`;
                if (x.LensModel) meta.lens = String(x.LensModel).trim();
                if (x.FNumber) meta.fnumber = Number(x.FNumber);
                if (x.ExposureTime) meta.exposure = Number(x.ExposureTime);
                const iso = x.ISO ?? x.ISOSpeedRatings ?? x.PhotographicSensitivity;
                if (iso) meta.iso = Array.isArray(iso) ? iso[0] : Number(iso);
                if (x.FocalLength) meta.focal = Number(x.FocalLength);
                if (typeof x.latitude === 'number' && typeof x.longitude === 'number' && isFinite(x.latitude) && isFinite(x.longitude)) {
                    meta.gps = [Math.round(x.latitude * 1e6) / 1e6, Math.round(x.longitude * 1e6) / 1e6];
                }
            }
        } catch (e) {
            console.debug('[viewer] exif read failed', entry.path, e.message);
        } finally {
            exifPending.delete(entry.path);
        }
        const cur = App.catalog.peek(entry.path)?.meta || {};
        if (cur.taken) delete meta.taken; // keep values other modules already measured
        App.catalog.setMeta(entry.path, meta);
        if (V.current?.path === entry.path) renderInfo();
    }

    // ---------- Slideshow ----------
    const INTERVALS = [2, 3, 4, 5, 8, 10, 15, 30];
    let hud = null;
    let hudLabel = null;
    let hudPause = null;
    let showTimer = null;
    let wakeLock = null;
    let order = null; // shuffled file paths

    const slideshow = {
        running: false,
        paused: false,

        get interval() {
            return clamp(Number(App.settings.get('viewer.slideshowInterval', 4)) || 4, 1, 60);
        },
        get shuffle() {
            return !!App.settings.get('viewer.slideshowShuffle', false);
        },
        get loop() {
            return App.settings.get('viewer.slideshowLoop', true) !== false;
        },
        get includeVideos() {
            return App.settings.get('viewer.slideshowVideos', true) !== false;
        },

        start() {
            if (!V.isOpen) return;
            const playable = V.files.filter((f) => f.type === 'image' || (slideshow.includeVideos && f.type === 'video'));
            if (playable.length < 2) {
                ui.toast('슬라이드쇼를 하려면 사진이 2장 이상 있어야 해요', { type: 'info' });
                return;
            }
            slideshow.running = true;
            slideshow.paused = false;
            order = slideshow.shuffle ? shuffled(V.files.map((f) => f.path)) : null;
            V.root.classList.add('vw-slideshow');
            ensureHud();
            hud.hidden = false;
            updateHud();
            acquireWakeLock();
            V.refreshChrome();
            V.osd(`슬라이드쇼 · ${slideshow.interval}초`, { icon: 'vw-slideshow', duration: 1100 });
            if (V.kind === 'video' && slideshow.includeVideos) V.player?.play?.();
            schedule();
            V.poke();
        },

        stop({ quiet = false } = {}) {
            if (!slideshow.running) return;
            slideshow.running = false;
            slideshow.paused = false;
            clearTimeout(showTimer);
            order = null;
            V.root?.classList.remove('vw-slideshow');
            if (hud) hud.hidden = true;
            releaseWakeLock();
            V.refreshChrome?.();
            if (!quiet) V.osd('슬라이드쇼 끝', { icon: 'x' });
        },

        toggle() {
            slideshow.running ? slideshow.stop() : slideshow.start();
        },

        togglePause() {
            if (!slideshow.running) return;
            slideshow.paused = !slideshow.paused;
            if (slideshow.paused) {
                clearTimeout(showTimer);
                if (V.kind === 'video') V.player?.pause?.();
            } else {
                if (V.kind === 'video' && slideshow.includeVideos) V.player?.play?.();
                schedule();
            }
            updateHud();
            V.osd(slideshow.paused ? '일시정지' : '다시 재생', { icon: slideshow.paused ? 'pause' : 'play' });
        },

        setInterval(sec) {
            const s = clamp(Math.round(sec), 1, 60);
            App.settings.set('viewer.slideshowInterval', s);
            updateHud();
            if (slideshow.running) {
                schedule();
                V.osd(`${s}초 간격`, { icon: 'clock' });
            }
        },

        nudge(dir) {
            const cur = slideshow.interval;
            const next = dir > 0 ? INTERVALS.find((s) => s > cur) ?? Math.min(60, cur + 5) : [...INTERVALS].reverse().find((s) => s < cur) ?? Math.max(1, cur - 1);
            slideshow.setInterval(next);
        },

        menu(anchor) {
            const cur = slideshow.interval;
            ui.menu([
                slideshow.running ? { label: '슬라이드쇼 끝내기', icon: 'x', command: 'viewer.slideshow' } : { label: '슬라이드쇼 시작', icon: 'play', command: 'viewer.slideshow' },
                '-',
                { header: '넘기는 간격' },
                ...INTERVALS.map((s) => ({ label: `${s}초`, checked: cur === s, action: () => slideshow.setInterval(s) })),
                '-',
                { label: '무작위 순서', checked: slideshow.shuffle, action: () => App.settings.set('viewer.slideshowShuffle', !slideshow.shuffle) },
                { label: '끝나면 처음부터', checked: slideshow.loop, action: () => App.settings.set('viewer.slideshowLoop', !slideshow.loop) },
                { label: '영상도 끝까지 재생', checked: slideshow.includeVideos, action: () => App.settings.set('viewer.slideshowVideos', !slideshow.includeVideos) },
            ], { anchor, align: 'end' });
        },
    };

    function shuffled(list) {
        const a = [...list];
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    function schedule() {
        clearTimeout(showTimer);
        if (!slideshow.running || slideshow.paused) return;
        if (V.kind === 'video' && slideshow.includeVideos) return; // advances on 'ended'
        showTimer = setTimeout(advance, slideshow.interval * 1000);
    }

    function nextIndex() {
        const files = V.files;
        const n = files.length;
        const ok = (f) => f && (f.type === 'image' || (slideshow.includeVideos && f.type === 'video'));
        if (order) {
            const pos = order.indexOf(V.current?.path);
            for (let k = 1; k <= order.length; k++) {
                const at = pos + k;
                if (at >= order.length && !slideshow.loop) return -1;
                const p = order[at % order.length];
                const i = files.findIndex((f) => f.path === p);
                if (i >= 0 && ok(files[i])) return i;
            }
            return -1;
        }
        for (let k = 1; k <= n; k++) {
            const at = V.index + k;
            if (at >= n && !slideshow.loop) return -1;
            const i = at % n;
            if (ok(files[i])) return i;
        }
        return -1;
    }

    function advance() {
        if (!slideshow.running || slideshow.paused || !V.isOpen) return;
        const i = nextIndex();
        if (i < 0) {
            slideshow.stop({ quiet: true });
            ui.toast('슬라이드쇼가 끝났어요', { type: 'info' });
            return;
        }
        V.go(i, { transition: 'fade', play: true });
    }

    function ensureHud() {
        if (hud || !V.overlayEl) return;
        hudPause = V.button('pause', '일시정지', 'Space', () => slideshow.togglePause(), { class: 'sm' });
        hudLabel = h('span', { class: 'vw-show-label' });
        hud = h('div', { class: 'vw-show-hud', hidden: true },
            hudPause,
            h('span', { class: 'vw-show-title', html: `${V.icon('slideshow', { size: 14 })}<span>슬라이드쇼</span>` }),
            h('span', { class: 'vw-sep' }),
            V.button('minus', '더 빨리 넘기기', '-', () => slideshow.nudge(-1), { class: 'sm' }),
            hudLabel,
            V.button('plus', '더 천천히 넘기기', '=', () => slideshow.nudge(1), { class: 'sm' }),
            h('span', { class: 'vw-sep' }),
            V.button('x', '슬라이드쇼 끝내기', 'S', () => slideshow.stop(), { class: 'sm' }));
        V.overlayEl.append(hud);
    }

    function updateHud() {
        if (!hud) return;
        hudLabel.textContent = `${slideshow.interval}초`;
        hudPause.innerHTML = ui.icon(slideshow.paused ? 'play' : 'pause');
        hudPause.dataset.tip = slideshow.paused ? '다시 재생' : '일시정지';
        hudPause.setAttribute('aria-label', hudPause.dataset.tip);
    }

    async function acquireWakeLock() {
        try {
            if (navigator.wakeLock && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen');
        } catch (e) {
            wakeLock = null;
        }
    }

    function releaseWakeLock() {
        try {
            wakeLock?.release();
        } catch (e) {
            /* ignore */
        }
        wakeLock = null;
    }

    document.addEventListener('visibilitychange', () => {
        if (slideshow.running && document.visibilityState === 'visible' && !wakeLock) acquireWakeLock();
    });

    V.slideshow = slideshow;

    // ---------- Wiring ----------
    App.bus.on('viewer:entry', () => {
        ensureStrip();
        ensureInfo();
        if (stripOn()) scrollStripToCurrent();
        renderInfo();
        if (slideshow.running) schedule();
    });
    App.bus.on('viewer:shown', () => {
        renderInfo();
        if (slideshow.running && V.kind === 'video' && slideshow.includeVideos && !slideshow.paused) V.player?.play?.();
    });
    App.bus.on('viewer:video-ended', () => {
        if (slideshow.running && !slideshow.paused) advance();
    });
    App.bus.on('viewer:video-meta', () => renderInfo());
    App.bus.on('viewer:closed', () => {
        slideshow.stop({ quiet: true });
        if (infoEl) infoEl.hidden = true;
        resetStrip();
    });
    App.bus.on('view:changed', () => {
        if (V.isOpen) scheduleStrip();
    });
    App.bus.on('catalog:changed', ({ paths }) => {
        if (!V.isOpen) return;
        if (paths?.includes(V.current?.path)) renderInfo();
        // refresh rotated cells
        for (const p of paths || []) {
            const el = cells.get(p);
            if (!el) continue;
            el.remove();
            cells.delete(p);
        }
        scheduleStrip();
    });
    App.bus.on('settings:changed', ({ key }) => {
        if (key === 'viewer.filmstrip' && V.isOpen) {
            if (stripOn()) {
                ensureStrip();
                requestAnimationFrame(() => scrollStripToCurrent());
            }
        }
        if (key === 'viewer.info') renderInfo();
        if (key.startsWith('viewer.slideshow')) updateHud();
    });

    V.hintProviders.push((kind) => (slideshow.running ? [{ keys: ['Space'], label: '일시정지' }, { keys: ['-', '='], label: '간격' }, { keys: ['S'], label: '끝내기' }] : []));

    // ---------- Commands ----------
    const open = () => V.isOpen;
    App.commands.register({
        id: 'viewer.filmstrip',
        title: '필름 스트립 보이기/숨기기',
        group: '보기',
        icon: 'film',
        scope: 'viewer',
        keys: ['T'],
        when: open,
        run: () => {
            const on = !stripOn();
            App.settings.set('viewer.filmstrip', on);
            V.osd(on ? '필름 스트립 켬' : '필름 스트립 끔', { icon: 'film' });
        },
    });
    App.commands.register({
        id: 'viewer.info',
        title: '정보 보이기/숨기기',
        group: '보기',
        icon: 'info',
        scope: 'viewer',
        keys: ['I'],
        when: () => open() && !V.isPanelOpen('editor'),
        run: () => {
            App.settings.set('viewer.info', !infoOn());
            ensureInfo();
            renderInfo();
            V.refreshChrome();
        },
    });
    App.commands.register({ id: 'viewer.slideshow', title: '슬라이드쇼 시작/끝내기', group: '보기', icon: 'vw-slideshow', scope: 'viewer', keys: ['S'], when: open, run: () => slideshow.toggle() });
    App.commands.register({ id: 'viewer.slideshowShorter', title: '슬라이드쇼 더 빨리 넘기기', group: '보기', icon: 'minus', scope: 'viewer', keys: ['-'], when: () => slideshow.running, run: () => slideshow.nudge(-1) });
    App.commands.register({ id: 'viewer.slideshowLonger', title: '슬라이드쇼 더 천천히 넘기기', group: '보기', icon: 'plus', scope: 'viewer', keys: ['=', '+'], when: () => slideshow.running, run: () => slideshow.nudge(1) });
})();
