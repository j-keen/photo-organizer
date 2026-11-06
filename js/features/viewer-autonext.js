/*
 * Viewer auto-next: viewer.autoNext (default true), persisted through App.settings.
 * Natural video/edit endings immediately show the next file without wrapping; videos start playing.
 * viewer.autoDoneOnEnd defaults false; completion marks the previous file in place through App.chipsDone.move.
 * The shared 'viewer' settings page also configures resume, folder rates and controlsBelow (default true).
 * No additional public viewer API.
 */
(() => {
    'use strict';
    const V = App.viewer;
    const KEY = 'viewer.autoNext';
    let pending = null;
    let closing = false;

    function cancel() {
        pending = null;
    }

    function complete(rec) {
        if (!App.chipsDone?.move || App.state.workspace?.id !== rec.workspace) return;
        // A toast can outlive navigation back to the previous file.
        if (V.isOpen && (V.current?.path === rec.previous.path || V.player?.path === rec.previous.path)) return;
        return App.chipsDone.move([rec.previous.path]);
    }

    App.bus.on('viewer:shown', ({ entry }) => {
        const rec = pending;
        if (!rec || entry.path !== rec.next.path || V.current?.path !== entry.path ||
            (entry.type === 'video' && V.player?.path !== entry.path)) return;
        cancel();
        V.osd(`다음 파일 · ${entry.name}`, { duration: 1200 });
        if (!App.chipsDone?.move) return;
        if (App.settings.get('viewer.autoDoneOnEnd', false)) complete(rec);
        else App.ui.toast(`${rec.previous.name} 다 봤어요`, {
            duration: 6000,
            action: { label: '완료로 표시', run: () => complete(rec) },
        });
    });

    function allowed(p) {
        return !closing && V.isOpen && V.kind === 'video' && V.player === p &&
            V.current?.path === p.path && !p.destroyed && !p.failed &&
            App.settings.get(KEY, true) !== false && !V.segment && !p.segment &&
            !V.sequence && !V.slideshow?.running && p.loopA == null && p.loopB == null &&
            !p.video.loop && !p.reverseRate && p.stopAt == null;
    }

    function ended(event, edited = false) {
        const p = V.player;
        if (!p || event?.path !== p.path || !allowed(p)) return;
        if (edited ? (!p.skip || !p.editBounds || p.playing) : !p.video.ended) return;
        if (pending) return;
        const next = V.files[V.index + 1];
        if (!next) {
            V.osd('마지막 파일이에요', { duration: 1200 });
            return;
        }
        p.resumeEnded = true;
        p.saveResume?.(true);
        pending = { previous: V.current, next, workspace: App.state.workspace?.id };
        V.step(1, { play: next.type === 'video', time: 0 });
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
        App.undo.push({ label: '다 보면 다음 파일로', undo: () => write(before), redo: () => write(after) });
    }

    V.contextItems.push((entry, kind) => kind === 'video' ? [{
        label: '다 보면 다음 파일로',
        checked: App.settings.get(KEY, true) !== false,
        action: () => setEnabled(App.settings.get(KEY, true) === false),
    }] : []);

    App.bus.on('viewer:video-ended', (e) => ended(e));
    App.bus.on('viewer:edit-ended', (e) => ended(e, true));
    App.bus.on('viewer:segment-ended', cancel);
    App.bus.on('viewer:entry', ({ entry }) => {
        closing = false;
        if (pending?.next.path !== entry.path) cancel();
    });
    App.bus.on('viewer:closing', () => { closing = true; cancel(); });
    App.bus.on('viewer:closed', cancel);
    App.bus.on('fs:changed', cancel);
    App.bus.on('view:changed', cancel);
    App.bus.on('settings:changed', ({ key }) => {
        if (key === KEY && App.settings.get(KEY, true) === false) cancel();
    });


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
                const toggle = (key, label, desc, fallback = true) => {
                    const control = kit.toggle({ key, fallback });
                    // The kit writes the setting; capture its previous value for one global undo step.
                    control.addEventListener('change', (event) => {
                        const before = !!App.settings.get(key, fallback);
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
                toggle(KEY, '다 보면 다음 파일로', '영상을 다 보면 바로 다음 파일을 보여요. 영상이면 재생해요.');
                toggle('viewer.autoDoneOnEnd', '다 본 영상은 바로 완료로 표시', '다음 파일로 넘어가면 이전 영상을 완료로 표시해요.', false);
                toggle('viewer.rememberResume', '이어 보기 위치 기억', '다시 열면 보던 위치부터 이어서 봐요.');
                toggle('viewer.rememberFolderRate', '폴더별 재생 속도 기억', '같은 폴더의 영상은 선택한 속도로 재생해요.');
                toggle('viewer.controlsBelow', '재생바를 영상 아래에 보여요', '일반 보기에서 재생바가 영상과 자막을 가리지 않아요.');
                body.append(g.el);
            },
        });
    });
})();
