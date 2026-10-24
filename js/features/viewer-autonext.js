/*
 * Viewer auto-next: viewer.autoNext (default true), persisted through App.settings.
 * Natural video/edit endings offer the next video in viewer.files without wrapping.
 * Contributes a checked viewer menu item and the shared 'viewer' settings page, including viewer.controlsBelow
 * (default true). No additional public viewer API.
 */
(() => {
    'use strict';
    const { h } = App.util;
    const V = App.viewer;
    const KEY = 'viewer.autoNext';
    let pending = null;
    let closing = false;

    function cancel() {
        const rec = pending;
        if (!rec) return;
        pending = null;
        clearInterval(rec.timer);
        rec.card.remove();
        rec.cleanup();
    }

    function allowed(p) {
        return !closing && V.isOpen && V.kind === 'video' && V.player === p &&
            V.current?.path === p.path && !p.destroyed && !p.failed &&
            App.settings.get(KEY, true) !== false && !V.segment && !p.segment &&
            !V.sequence && !V.slideshow?.running && p.loopA == null && p.loopB == null &&
            !p.video.loop && !p.reverseRate && p.stopAt == null;
    }

    function nextVideo() {
        for (let i = V.index + 1; i < V.files.length; i++) {
            if (V.files[i].type === 'video') return { index: i, entry: V.files[i] };
        }
        return null;
    }

    function advance() {
        const rec = pending;
        if (!rec) return;
        const next = nextVideo();
        const valid = allowed(rec.player) && !rec.player.playing && next?.entry.path === rec.next.path;
        cancel();
        // Resolve the index again because the visible file list can change during the countdown.
        if (valid) V.step(next.index - V.index, { play: true });
    }

    function ended(event, edited = false) {
        const p = V.player;
        if (!p || event?.path !== p.path || !allowed(p)) return;
        if (edited ? (!p.skip || !p.editBounds || p.playing) : !p.video.ended) return;
        if (pending) return;
        const next = nextVideo();
        if (!next) {
            V.osd('마지막 영상이에요', { duration: 1200 });
            return;
        }
        if (!V.overlayEl) return;
        const label = h('div', { class: 'vw-autonext-label' });
        const card = h('div', { class: 'vw-autonext', role: 'group', 'aria-label': '다음 영상' },
            label,
            h('div', { class: 'vw-autonext-actions' },
                h('button', { type: 'button', class: 'btn sm primary', text: '지금 보기', onclick: advance }),
                h('button', { type: 'button', class: 'btn sm', text: '취소', onclick: cancel })));
        // Card gestures must not reach the media's play/pause and fullscreen handlers.
        for (const name of ['pointerdown', 'click', 'dblclick']) card.addEventListener(name, (e) => e.stopPropagation());
        const initialTime = p.time;
        let initialSeek = edited && p.video.seeking;
        const onSeek = () => {
            // checkSkip seeks to the edit boundary before emitting edit-ended.
            if (initialSeek && Math.abs(p.time - initialTime) < 0.01) return;
            cancel();
        };
        const onSeeked = () => { initialSeek = false; };
        p.video.addEventListener('seeking', onSeek);
        p.video.addEventListener('seeked', onSeeked);
        p.video.addEventListener('play', cancel);
        const rec = {
            player: p,
            next: next.entry,
            card,
            deadline: performance.now() + 3000,
            timer: null,
            cleanup: () => {
                p.video.removeEventListener('seeking', onSeek);
                p.video.removeEventListener('seeked', onSeeked);
                p.video.removeEventListener('play', cancel);
            },
        };
        pending = rec;
        const tick = () => {
            if (pending !== rec) return;
            if (!allowed(p) || p.playing) return cancel();
            const seconds = Math.max(0, Math.ceil((rec.deadline - performance.now()) / 1000));
            label.textContent = `다음 영상 · ${rec.next.name} · ${seconds}초`;
            const controls = V.overlayEl.querySelector('.vw-ctl:not([hidden])');
            const bottom = controls ? V.overlayEl.getBoundingClientRect().bottom - controls.getBoundingClientRect().top + 12 : 100;
            card.style.setProperty('--vw-autonext-bottom', `${Math.max(100, bottom)}px`);
            if (!seconds) advance();
        };
        V.overlayEl.append(card);
        V.poke();
        tick();
        rec.timer = setInterval(tick, 100);
    }

    function setEnabled(value) {
        const before = App.settings.get(KEY, true) !== false;
        const after = !!value;
        if (before === after) return;
        const write = (on) => {
            App.settings.set(KEY, on);
            if (!on) cancel();
        };
        write(after);
        App.undo.push({ label: '다 보면 다음 영상', undo: () => write(before), redo: () => write(after) });
    }

    V.contextItems.push((entry, kind) => kind === 'video' ? [{
        label: '다 보면 다음 영상',
        checked: App.settings.get(KEY, true) !== false,
        action: () => setEnabled(App.settings.get(KEY, true) === false),
    }] : []);

    App.bus.on('viewer:video-ended', (e) => ended(e));
    App.bus.on('viewer:edit-ended', (e) => ended(e, true));
    App.bus.on('viewer:segment-ended', cancel);
    App.bus.on('viewer:entry', () => { closing = false; cancel(); });
    App.bus.on('viewer:closing', () => { closing = true; cancel(); });
    App.bus.on('viewer:closed', cancel);
    App.bus.on('fs:changed', cancel);
    App.bus.on('view:changed', cancel);
    App.bus.on('settings:changed', ({ key }) => {
        if (key === KEY && App.settings.get(KEY, true) === false) cancel();
    });

    window.addEventListener('pointerdown', (e) => {
        if (pending && !pending.card.contains(e.target)) cancel();
    }, true);
    window.addEventListener('click', (e) => {
        if (pending && !pending.card.contains(e.target)) cancel();
    }, true);
    // Capture before document shortcuts so Escape dismisses only this card.
    window.addEventListener('keydown', (e) => {
        if (!pending || e.isComposing) return;
        if (e.key === 'Escape' || e.key === 'Enter') {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.key === 'Enter') advance();
            else cancel();
        } else if (e.code === 'Space' || e.key === ' ') {
            cancel();
        }
    }, true);

    App.bus.on('app:ready', () => {
        const S = App.settingsUI;
        if (!S?.addPage || S.pages?.some?.((pg) => pg.id === 'viewer')) return;
        S.addPage({
            id: 'viewer',
            title: '보기 화면',
            icon: 'play',
            order: 44,
            desc: '영상 재생바와 이어 보기를 설정해요.',
            render(body, kit) {
                const g = kit.group('영상 보기', '편하게 영상을 볼 수 있도록 설정해요.');
                const toggle = (key, label, desc) => {
                    const control = kit.toggle({ key, fallback: true });
                    // The kit writes the setting; capture its previous value for one global undo step.
                    control.addEventListener('change', (event) => {
                        const before = App.settings.get(key, true) !== false;
                        const after = !!event.target.checked;
                        if (before === after) return;
                        App.undo.push({
                            label,
                            undo: () => App.settings.set(key, before),
                            redo: () => App.settings.set(key, after),
                        });
                    }, true);
                    g.body.append(kit.row({ label, desc, control }));
                };
                toggle(KEY, '다 보면 다음 영상', '영상을 다 보면 3초 뒤에 다음 영상을 재생해요.');
                toggle('viewer.controlsBelow', '재생바를 영상 아래에 보여요', '일반 보기에서 재생바가 영상과 자막을 가리지 않아요.');
                body.append(g.el);
            },
        });
    });
})();
