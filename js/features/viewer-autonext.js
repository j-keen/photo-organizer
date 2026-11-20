/*
 * Viewer auto-next: viewer.autoNext (default true), persisted through App.settings.
 * Natural video/edit endings follow the visible list, with optional shuffle, repeat and waiting cards.
 * viewer.autoDoneOnEnd defaults false; completion marks the previous file in place through App.chipsDone.move.
 * The shared 'viewer' settings page also configures resume, folder rates and controlsBelow (default true).
 * App.viewer.upNext(n = 10) previews the same order without consuming it.
 */
(() => {
    'use strict';
    const V = App.viewer;
    const KEY = 'viewer.autoNext';
    const LOOP = 'viewer.autoNextLoop';
    const SHUFFLE = 'viewer.autoNextShuffle';
    const { h } = App.util;
    let pending = null;
    let arrival = null;
    let closing = false;
    let order = [];
    let signature = '';
    let listRef = null;
    let shuffleOn = false;
    let entries = new Map();
    const played = new Set();
    let card = null;
    let countdown = null;
    let cardTimer = null;
    let consecutive = 0;
    let sessionStopped = false;
    let sleep = null;
    let sleepTimer = null;
    let openingOpts = null;

    function clearCard() {
        clearTimeout(cardTimer);
        cardTimer = null;
        countdown = null;
        card?.remove();
        card = null;
    }

    function cancel() {
        pending = null;
        arrival = null;
        clearCard();
    }

    function ensureOrder() {
        const shuffle = !!App.settings.get(SHUFFLE, false);
        if (listRef === V.files && shuffle === shuffleOn) return;
        listRef = V.files;
        shuffleOn = shuffle;
        entries = new Map(V.files.map((e) => [e.path, e]));
        const paths = [...entries.keys()];
        const key = JSON.stringify([shuffle, paths]);
        if (key === signature) return;
        signature = key;
        played.clear();
        if (V.current) played.add(V.current.path);
        order = paths.slice();
        if (shuffle) {
            // Start a new run at the file on screen, then visit every other file once.
            order = paths.filter((p) => p !== V.current?.path);
            for (let i = order.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [order[i], order[j]] = [order[j], order[i]];
            }
            if (paths.includes(V.current?.path)) order.unshift(V.current.path);
        }
    }

    V.upNext = function upNext(n = 10) {
        if (!V.isOpen) return [];
        ensureOrder();
        const result = [];
        const requested = Math.floor(Number(n));
        const count = requested === Infinity ? order.length
            : Number.isFinite(requested) ? Math.max(0, requested) : 0;
        const at = order.indexOf(V.current?.path);
        if (at < 0 || !order.length) return result;
        const loop = App.settings.get(LOOP, false);
        if (shuffleOn) {
            const seen = new Set(played);
            let cursor = at;
            while (result.length < count) {
                if (seen.size >= order.length) {
                    if (!loop) break;
                    seen.clear();
                }
                for (let i = 0; i < order.length; i++) {
                    cursor = (cursor + 1) % order.length;
                    const path = order[cursor];
                    if (seen.has(path)) continue;
                    seen.add(path);
                    result.push(entries.get(path));
                    break;
                }
            }
            return result;
        }
        for (let i = at + 1; result.length < count && (loop || i < order.length); i++) {
            const entry = entries.get(order[i % order.length]);
            if (entry) result.push(entry);
        }
        return result;
    };

    function changed() {
        if (V.isOpen) ensureOrder();
        App.bus.emit('viewer:upnext-changed', {});
    }

    function setting(key, value, label, fallback = false) {
        const before = App.settings.get(key, fallback);
        if (before === value) return;
        App.settings.set(key, value);
        App.undo.push({ label, undo: () => App.settings.set(key, before), redo: () => App.settings.set(key, value) });
    }

    function makeCard(title, actions, className) {
        clearCard();
        const text = h('div', { class: 'vw-autonext-title', text: title });
        card = h('section', { class: `vw-autonext ${className || ''}`, role: 'status', 'aria-label': title },
            text, h('div', { class: 'vw-autonext-actions' }, ...actions.map(([label, command]) =>
                h('button', { type: 'button', class: 'btn sm', text: label, onclick: () => App.commands.run(command) }))));
        for (const name of ['pointerdown', 'click', 'dblclick', 'wheel']) card.addEventListener(name, (e) => e.stopPropagation());
        V.overlayEl.append(card);
        return text;
    }

    function stopSession() {
        sessionStopped = true;
        if (openingOpts) openingOpts.play = false;
        cancel();
        V.player?.pause();
        changed();
    }

    function fireSleep() {
        clearTimeout(sleepTimer);
        sleepTimer = null;
        sleep = null;
        stopSession();
        V.osd('잠자기 타이머로 멈췄어요', { duration: 2000 });
    }

    function setSleep(value) {
        clearTimeout(sleepTimer);
        sleepTimer = null;
        sleep = value === 'end' ? { end: true } : Number(value) > 0 ? { until: Date.now() + Number(value) * 60000, minutes: Number(value) } : null;
        if (sleep?.until) sleepTimer = setTimeout(fireSleep, Math.max(0, sleep.until - Date.now()));
    }

    function advance(rec) {
        clearCard();
        if (!V.isOpen || closing || sessionStopped || App.settings.get(KEY, true) === false ||
            V.current?.path !== rec.from || !V.files.some((e) => e.path === rec.next.path)) return;
        const ask = Number(App.settings.get('viewer.autoNextAsk', 0));
        rec.ask = ask > 0 && consecutive + 1 >= ask;
        pending = arrival = rec;
        V.goPath(rec.next.path, { autoNext: true, play: rec.next.type === 'video' && !rec.ask, time: 0 });
    }

    function askAgain() {
        V.player?.pause();
        makeCard('계속 보실래요?', [['계속 보기', 'viewer.autoNext.continue'], ['그만 보기', 'viewer.autoNext.stop']], 'vw-autonext-ask');
    }

    function skipUnreadable({ path }) {
        const rec = arrival;
        if (!rec || rec.next.path !== path || V.current?.path !== path || closing || sessionStopped) return;
        App.ui.toast(`열 수 없어서 건너뛰었어요 · ${rec.next.name}`);
        rec.tried.add(path);
        const next = V.upNext(V.files.length).find((entry) => !rec.tried.has(entry.path));
        pending = arrival = null;
        clearCard();
        if (!next) return V.osd('열 수 있는 다음 파일이 없어요', { duration: 1800 });
        advance({ ...rec, from: path, next });
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
        if (V.player?.failed || V.stageEl.querySelector(`.vw-slot:last-child .vw-card`)) return;
        pending = null;
        consecutive++;
        V.osd(`다음 파일 · ${entry.name}`, { duration: 1200 });
        if (rec.ask) askAgain();
        if (!App.chipsDone?.move) return;
        if (App.settings.get('viewer.autoDoneOnEnd', false)) complete(rec);
        else App.ui.toast(`${rec.previous.name} 다 봤어요`, {
            duration: 6000,
            action: { label: '완료로 표시', run: () => complete(rec) },
        });
    });

    function allowed(p) {
        return !closing && !sessionStopped && V.isOpen && V.kind === 'video' && V.player === p &&
            V.current?.path === p.path && !p.destroyed && !p.failed &&
            App.settings.get(KEY, true) !== false && !V.segment && !p.segment &&
            !V.sequence && !V.slideshow?.running && p.loopA == null && p.loopB == null &&
            !p.video.loop && !p.reverseRate && p.stopAt == null;
    }

    function ended(event, edited = false) {
        const p = V.player;
        if (p && event?.path === p.path && sleep?.end &&
            (edited ? p.skip && p.editBounds && !p.playing : p.video.ended)) return fireSleep();
        if (!p || event?.path !== p.path || !allowed(p)) return;
        if (edited ? (!p.skip || !p.editBounds || p.playing) : !p.video.ended) return;
        if (pending || card) return;
        const next = V.upNext(1)[0];
        if (!next) {
            V.osd('마지막 파일이에요', { duration: 1200 });
            return;
        }
        p.resumeEnded = true;
        p.saveResume?.(true);
        const rec = { previous: V.current, from: p.path, next, workspace: App.state.workspace?.id, tried: new Set([p.path]) };
        const delay = Number(App.settings.get('viewer.autoNextDelay', 0));
        if (!(delay > 0)) return advance(rec);
        const title = makeCard('', [['지금 보기', 'viewer.autoNext.now'], ['취소', 'viewer.autoNext.cancel']]);
        countdown = rec;
        const until = Date.now() + delay * 1000;
        const tick = () => {
            const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
            title.textContent = `다음 파일 · ${next.name} · ${left}초`;
            card?.setAttribute('aria-label', title.textContent);
            if (!left) advance(rec);
            else cardTimer = setTimeout(tick, Math.min(1000, until - Date.now()));
        };
        tick();
    }

    function setEnabled(value) {
        setting(KEY, !!value, '다 보면 다음 파일로', true);
        if (value) sessionStopped = false;
    }

    const register = (id, title, run, extra = {}) => App.commands.register({ id, title, group: '보기', scope: 'viewer', when: () => V.isOpen, run, ...extra });
    register('viewer.autoNext.toggle', '다 보면 다음 파일로 켜기/끄기', () => {
        const on = App.settings.get(KEY, true) === false;
        setEnabled(on);
        V.osd(`다음 파일로 넘기기 ${on ? '켬' : '끔'}`);
    }, { keys: ['Alt+Shift+A'] });
    register('viewer.autoNext.loop', '목록 반복 켜기/끄기', () => setting(LOOP, !App.settings.get(LOOP, false), '목록 반복'));
    register('viewer.autoNext.shuffle', '무작위 재생 켜기/끄기', () => setting(SHUFFLE, !App.settings.get(SHUFFLE, false), '무작위 재생'));
    register('viewer.autoNext.now', '다음 파일 지금 보기', () => { if (countdown) advance(countdown); });
    register('viewer.autoNext.cancel', '다음 파일 기다리기 취소', clearCard);
    register('viewer.autoNext.continue', '계속 보기', () => { clearCard(); consecutive = 0; sessionStopped = false; V.player?.play(); });
    register('viewer.autoNext.stop', '그만 보기', stopSession);
    register('viewer.sleepTimer', '잠자기 타이머', (args) => setSleep(args?.value));

    V.contextItems.push(() => [{
        label: '다 보면 다음 파일로',
        checked: App.settings.get(KEY, true) !== false,
        command: 'viewer.autoNext.toggle',
    }, {
        label: '목록 반복', checked: !!App.settings.get(LOOP, false), command: 'viewer.autoNext.loop',
    }, {
        label: '무작위 재생', checked: !!App.settings.get(SHUFFLE, false), command: 'viewer.autoNext.shuffle',
    }, {
        label: `잠자기 타이머${sleep?.end ? ' · 이 영상 끝나면' : sleep?.until ? ` · ${Math.max(1, Math.ceil((sleep.until - Date.now()) / 60000))}분 남음` : ''}`,
        submenu: () => [[0, '끄기'], ['end', '이 영상 끝나면'], [15, '15분'], [30, '30분'], [60, '60분']].map(([value, label]) => ({
            label, checked: value === 0 ? !sleep : value === 'end' ? !!sleep?.end : sleep?.until != null && sleep.minutes === value,
            action: () => App.commands.run('viewer.sleepTimer', { value }),
        })),
    }]);

    App.bus.on('viewer:video-ended', (e) => ended(e));
    App.bus.on('viewer:edit-ended', (e) => ended(e, true));
    App.bus.on('viewer:segment-ended', cancel);
    App.bus.on('viewer:load-error', skipUnreadable);
    App.bus.on('viewer:navigating', ({ opts }) => { if (!opts?.autoNext) cancel(); });
    App.bus.on('viewer:entry', ({ entry, opts }) => {
        closing = false;
        openingOpts = opts;
        if (!opts?.autoNext || arrival?.next.path !== entry.path) { cancel(); consecutive = 0; }
        ensureOrder();
        if (shuffleOn) {
            if (opts?.autoNext && played.size >= order.length) played.clear();
            played.add(entry.path);
        }
        changed();
    });
    App.bus.on('viewer:closing', () => { closing = true; cancel(); });
    App.bus.on('viewer:closed', () => {
        cancel(); setSleep(0); sessionStopped = false; consecutive = 0; signature = ''; listRef = null; order = []; played.clear();
        changed();
    });
    App.bus.on('fs:changed', () => { cancel(); queueMicrotask(changed); });
    App.bus.on('view:changed', () => { cancel(); queueMicrotask(changed); });
    App.bus.on('settings:changed', ({ key }) => {
        if (key === KEY && App.settings.get(KEY, true) === false) cancel();
        if ([LOOP, SHUFFLE, 'viewer.autoNextDelay', 'viewer.autoNextAsk'].includes(key)) { cancel(); changed(); }
        if (key === KEY) changed();
    });

    App.bus.on('app:ready', () => {
        // Capture Esc before the normal close command: the first press dismisses the card.
        const input = (e) => {
            if (!V.isOpen) return;
            consecutive = 0;
            if (pending) pending.ask = false;
            if (e.type === 'keydown' && e.key === 'Escape' && card) {
                e.preventDefault(); e.stopImmediatePropagation();
                if (card.classList.contains('vw-autonext-ask')) stopSession();
                else clearCard();
            }
        };
        for (const name of ['keydown', 'pointerdown', 'wheel']) window.addEventListener(name, input, true);
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
                    const control = kit.toggle({ key, fallback, label,
                        set: (value) => setting(key, !!value, label, fallback) });
                    g.body.append(kit.row({ label, desc, control }));
                };
                toggle(KEY, '다 보면 다음 파일로', '영상을 다 보면 바로 다음 파일을 보여요. 영상이면 재생해요.');
                toggle(LOOP, '목록 반복', '마지막 파일을 다 보면 첫 파일부터 다시 봐요.', false);
                toggle(SHUFFLE, '무작위 재생', '지금 목록을 섞어서 한 번씩 봐요. 직접 이동할 때는 정렬 순서를 따라가요.', false);
                const choice = (key, label, desc, options) => {
                    const control = h('select', { class: 'select', 'aria-label': label }, ...options.map(([value, text]) =>
                        h('option', { value: String(value), text })));
                    control.value = String(App.settings.get(key, 0));
                    control.addEventListener('change', () => setting(key, Number(control.value), label, 0));
                    g.body.append(kit.row({ label, desc, control }));
                };
                choice('viewer.autoNextDelay', '다음 파일 대기 시간', '바로 넘기거나 잠깐 기다린 뒤 넘겨요.', [[0, '바로 보기'], [3, '3초'], [5, '5초'], [10, '10초']]);
                choice('viewer.autoNextAsk', '계속 보기 확인', '키·마우스를 쓰지 않고 연속으로 넘겼을 때 잠깐 멈춰 물어봐요.', [[0, '끄기'], [5, '5개'], [10, '10개'], [20, '20개']]);
                toggle('viewer.autoDoneOnEnd', '다 본 영상은 바로 완료로 표시', '다음 파일로 넘어가면 이전 영상을 완료로 표시해요.', false);
                toggle('viewer.rememberResume', '이어 보기 위치 기억', '다시 열면 보던 위치부터 이어서 봐요.');
                toggle('viewer.rememberFolderRate', '폴더별 재생 속도 기억', '같은 폴더의 영상은 선택한 속도로 재생해요.');
                toggle('viewer.controlsBelow', '재생바를 영상 아래에 보여요', '일반 보기에서 재생바가 영상과 자막을 가리지 않아요.');
                body.append(g.el);
            },
        });
    });
})();
