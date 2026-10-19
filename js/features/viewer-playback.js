/*
 * Viewer playback API for other teams (ARCHITECTURE §8):
 *   App.viewer.openAt(path, { start, end, loop = false, autoplay = true })
 *       opens the viewer on that video at `start`; with `end` it stops (or loops) there and shows a small dismissible
 *       chip '구간 재생 01:23–01:45' at the top of the stage. Used by the 보관함 (clips) and 중복 검사 (dupes) teams.
 *   App.viewer.playSequence(items = [{ path, start, end, title? }], { title })
 *       plays them back to back in the viewer with a queue chip (n / total, previous / next, close).
 *   App.viewer.stopSegment() — drop the range/queue (playback continues normally)
 *   App.viewer.sequence → { title, index, total, item } | null
 * Keys: Shift+PageUp / Shift+PageDown = previous / next item of the queue.
 * Events: 'viewer:segment-ended' { path, start, end }, 'viewer:sequence-ended' { title, total }
 */
(() => {
    'use strict';
    const { h, path: P, clamp } = App.util;
    const ui = App.ui;
    const V = App.viewer;
    const fmt = (t, precise = false) => (V.fmtTime ? V.fmtTime(t, precise) : String(t));
    const span = (a, b) => {
        if (!Number.isFinite(b)) return `${fmt(a)}부터`;
        const p = b - a < 10;
        return `${fmt(a, p)}–${fmt(b, p)}`;
    };

    let seg = null; // { path, start, end, loop }
    let seq = null; // { items, i, title }
    let chip = null;
    let expectPath = null; // the viewer:entry we caused ourselves

    function validItem(it) {
        return it && typeof it.path === 'string' && Number.isFinite(Number(it.start)) && (it.end == null || Number.isFinite(Number(it.end)));
    }

    function openAt(path, { start = 0, end = null, loop = false, autoplay = true, onEnd = null, _seq = false } = {}) {
        if (!path) return;
        if (!_seq) seq = null; // a direct call replaces any running queue
        start = Math.max(0, Number(start) || 0);
        end = end == null ? null : Number(end);
        // queue items without an end play to the end of the file (the player's 'ended' finishes the range)
        const range = end != null && Number.isFinite(end) && end - start > 0.05 ? { start, end } : _seq && end == null ? { start, end: Infinity } : null;
        seg = range ? { path, ...range, loop: !!loop } : null;
        const segment = range ? {
            ...range,
            loop: !!loop,
            onEnd: () => {
                App.bus.emit('viewer:segment-ended', { path, start: range.start, end: range.end });
                if (onEnd) onEnd();
                else renderChip();
            },
        } : null;
        const p = V.player;
        if (V.isOpen && V.current?.path === path && p && p.path === path && p.metaReady) {
            p.seek(start);
            p.setSegment(segment);
            if (autoplay) p.play();
            else p.pause();
        } else {
            expectPath = path;
            V.open(path, { time: start, play: !!autoplay, segment });
        }
        renderChip();
    }

    function playSequence(items, { title = '' } = {}) {
        const list = (items || []).filter(validItem).map((it) => ({ ...it, start: Number(it.start) || 0, end: it.end == null ? null : Number(it.end) }));
        if (!list.length) {
            ui.toast('재생할 구간이 없어요', { type: 'info' });
            return;
        }
        seq = { items: list, i: 0, title: title || '이어서 재생' };
        playIndex(0);
    }

    function playIndex(i) {
        if (!seq) return;
        seq.i = clamp(i, 0, seq.items.length - 1);
        const it = seq.items[seq.i];
        openAt(it.path, { start: it.start, end: it.end, autoplay: true, onEnd: () => next(true), _seq: true });
    }

    function next(auto = false) {
        if (!seq) return;
        if (seq.i + 1 < seq.items.length) {
            playIndex(seq.i + 1);
            return;
        }
        if (auto) {
            const done = seq;
            V.osd(`${done.title} · ${done.items.length}개 모두 재생했어요`, { icon: 'check', duration: 1600 });
            App.bus.emit('viewer:sequence-ended', { title: done.title, total: done.items.length });
            seq = null;
            seg = null;
            V.player?.setSegment(null);
            renderChip();
        }
    }

    function prev() {
        if (!seq) return;
        const p = V.player;
        const it = seq.items[seq.i];
        // like a music player: back to the start of this item first, then the previous one
        if (p && it && p.time - it.start > 2) {
            p.seek(it.start);
            p.play();
            return;
        }
        playIndex(seq.i - 1);
    }

    function stopSegment() {
        seq = null;
        seg = null;
        V.player?.setSegment(null);
        renderChip();
    }

    // ---------- chip ----------
    function renderChip() {
        const host = V.overlayEl;
        if (!host) return;
        if (!seg && !seq) {
            chip?.remove();
            chip = null;
            V.root?.classList.remove('vw-has-segment');
            return;
        }
        if (!chip || !host.contains(chip)) {
            chip = h('div', { class: 'vw-segchip', role: 'status' });
            chip.addEventListener('dblclick', (e) => e.stopPropagation());
            chip.addEventListener('pointerdown', (e) => e.stopPropagation());
            host.append(chip);
        }
        V.root?.classList.add('vw-has-segment');
        chip.textContent = '';
        const close = V.button('x', seq ? '이어서 재생 끝내기' : '구간 재생 끝내기', null, () => stopSegment(), { class: 'sm vw-segchip-x' });
        if (seq) {
            const it = seq.items[seq.i];
            const name = it.title || P.base(it.path);
            chip.classList.add('is-seq');
            chip.append(
                h('span', { class: 'vw-segchip-icon', html: V.icon('vw-slideshow', { size: 14 }) }),
                h('span', { class: 'vw-segchip-title truncate', text: seq.title }),
                h('span', { class: 'vw-segchip-dot' }),
                h('span', { class: 'vw-segchip-name truncate', text: name, title: it.path }),
                it.end != null ? h('span', { class: 'vw-segchip-range', text: span(it.start, it.end) }) : null,
                h('span', { class: 'vw-segchip-count', text: `${seq.i + 1} / ${seq.items.length}` }),
                V.button('skip-back', '이전 구간', 'Shift+PageUp', () => prev(), { class: 'sm' }),
                V.button('skip-forward', '다음 구간', 'Shift+PageDown', () => next(), { class: 'sm' }),
                close);
            chip.querySelector('[aria-label="다음 구간"]').disabled = seq.i >= seq.items.length - 1;
        } else {
            chip.classList.remove('is-seq');
            chip.append(
                h('span', { class: 'vw-segchip-icon', html: V.icon(seg.loop ? 'vw-repeat' : 'play', { size: 13 }) }),
                h('span', { class: 'vw-segchip-title', text: seg.loop ? '구간 반복' : '구간 재생' }),
                h('span', { class: 'vw-segchip-range', text: span(seg.start, seg.end) }),
                V.button('play', '이 구간 다시 재생', null, () => openAt(seg.path, { start: seg.start, end: seg.end, loop: seg.loop }), { class: 'sm' }),
                close);
        }
    }

    // Leaving the range/queue: another file shown by the user, or the viewer closed
    App.bus.on('viewer:entry', ({ entry }) => {
        if (!seg && !seq) return;
        if (entry?.path === expectPath) {
            expectPath = null;
            return;
        }
        const want = seq ? seq.items[seq.i]?.path : seg?.path;
        if (entry?.path !== want) {
            seq = null;
            seg = null;
            renderChip();
        }
    });
    App.bus.on('viewer:closed', () => {
        seq = null;
        seg = null;
        expectPath = null;
        chip?.remove();
        chip = null;
    });

    const inSeq = () => V.isOpen && !!seq;
    App.commands.register({ id: 'viewer.seqPrev', title: '이전 구간 (이어서 재생)', group: '영상', icon: 'skip-back', scope: 'viewer', keys: ['Shift+PageUp'], when: inSeq, run: () => prev() });
    App.commands.register({ id: 'viewer.seqNext', title: '다음 구간 (이어서 재생)', group: '영상', icon: 'skip-forward', scope: 'viewer', keys: ['Shift+PageDown'], when: inSeq, run: () => next() });
    App.commands.register({ id: 'viewer.stopSegment', title: '구간 재생 끝내기', group: '영상', icon: 'x', scope: 'viewer', when: () => V.isOpen && !!(seg || seq), run: () => stopSegment() });

    V.openAt = openAt;
    V.playSequence = playSequence;
    V.stopSegment = stopSegment;
    Object.defineProperty(V, 'sequence', {
        configurable: true,
        get: () => (seq ? { title: seq.title, index: seq.i, total: seq.items.length, item: seq.items[seq.i] } : null),
    });
    Object.defineProperty(V, 'segment', {
        configurable: true,
        get: () => (seg ? { ...seg } : null),
    });
})();
