/*
 * Viewer: full-screen look at one photo/video with previous/next navigation over the visible files.
 * Opens on 'item:open' { path }. Esc closes, ←/→ move, Space plays/pauses video.
 *   App.viewer.open(path), App.viewer.close(), App.viewer.current -> Entry|null
 *   App.viewer.toolbarItems.push((entry) => [Element...]) — add buttons to the viewer header
 */
(() => {
    'use strict';
    const { h, path: P, formatBytes } = App.util;
    const ui = App.ui;

    let root;
    let stage;
    let titleEl;
    let counterEl;
    let toolsEl;
    let release = null;
    let files = [];
    let index = -1;
    let loadToken = 0;

    const viewer = {
        toolbarItems: [],
        get isOpen() {
            return !!root && !root.hidden;
        },
        get current() {
            return files[index] || null;
        },
        get media() {
            return stage?.querySelector('video, img') || null;
        },

        open(p) {
            files = App.view.visible.filter((e) => e.kind === 'file');
            index = files.findIndex((e) => e.path === p);
            if (index < 0) return;
            if (!viewer.isOpen) {
                root.hidden = false;
                App.layers.push('viewer');
            }
            show();
        },

        close() {
            if (!viewer.isOpen) return;
            const cur = viewer.current;
            stage.innerHTML = '';
            if (release) release();
            release = null;
            root.hidden = true;
            App.layers.pop('viewer');
            if (cur && App.view.indexOf(cur.path) >= 0) {
                App.select.set([cur.path]);
                App.gallery.scrollTo(cur.path);
            }
            App.bus.emit('viewer:closed', { path: cur?.path });
        },

        step(delta) {
            if (!files.length) return;
            index = (index + delta + files.length) % files.length;
            show();
        },
    };

    async function show() {
        const entry = files[index];
        if (!entry) return;
        const token = ++loadToken;
        titleEl.textContent = entry.name;
        counterEl.textContent = `${index + 1} / ${files.length}`;
        toolsEl.innerHTML = '';
        for (const fn of viewer.toolbarItems) {
            try {
                for (const el of fn(entry) || []) toolsEl.append(el);
            } catch (e) {
                console.error('[viewer] toolbar contributor failed', e);
            }
        }
        if (release) release();
        release = null;
        stage.innerHTML = '';
        if (!App.util.browserCanDecode(entry.name)) {
            stage.append(h('div', { class: 'vw-unsupported', html: `${ui.icon(entry.type === 'video' ? 'film' : 'image', { size: 40 })}<p>${App.util.escapeHtml(entry.ext.toUpperCase())} 형식은 브라우저에서 바로 볼 수 없어요.</p><p class="faint">${formatBytes(entry.size)}</p>` }));
            App.bus.emit('viewer:shown', { entry, media: null });
            return;
        }
        let src;
        try {
            src = await App.fs.url(entry.path);
        } catch (e) {
            ui.toast(`파일을 열 수 없어요: ${e.message}`, { type: 'error' });
            return;
        }
        if (token !== loadToken) {
            src.release();
            return;
        }
        release = src.release;
        let media;
        if (entry.type === 'video') {
            media = h('video', { class: 'vw-media', src: src.url, controls: true, autoplay: true, playsinline: true });
            media.volume = App.settings.get('viewer.volume', 1);
            media.muted = App.settings.get('viewer.muted', false);
            media.addEventListener('volumechange', () => {
                App.settings.set('viewer.volume', media.volume);
                App.settings.set('viewer.muted', media.muted);
            });
        } else {
            media = h('img', { class: 'vw-media', src: src.url, alt: entry.name, draggable: 'false' });
        }
        stage.append(media);
        App.select.set([entry.path]);
        App.bus.emit('viewer:shown', { entry, media });
    }

    App.commands.register({ id: 'viewer.close', title: '보기 닫기', scope: 'viewer', keys: ['Escape'], run: () => viewer.close() });
    App.commands.register({ id: 'viewer.prev', title: '이전 파일', scope: 'viewer', keys: ['ArrowLeft', 'PageUp'], run: () => viewer.step(-1) });
    App.commands.register({ id: 'viewer.next', title: '다음 파일', scope: 'viewer', keys: ['ArrowRight', 'PageDown'], run: () => viewer.step(1) });
    App.commands.register({
        id: 'viewer.playPause',
        title: '재생/일시정지',
        scope: 'viewer',
        keys: ['Space'],
        run: () => {
            const v = stage.querySelector('video');
            if (v) v.paused ? v.play() : v.pause();
        },
    });
    App.commands.register({ id: 'viewer.trash', title: '휴지통으로 이동', scope: 'viewer', keys: ['Delete'], run: async () => {
        const cur = viewer.current;
        if (!cur) return;
        await App.fs.trash([cur.path]);
        files.splice(index, 1);
        if (!files.length) return viewer.close();
        index = Math.min(index, files.length - 1);
        show();
    } });

    App.register('viewer', {
        init() {
            root = document.getElementById('viewer');
            titleEl = h('div', { class: 'vw-title truncate' });
            counterEl = h('div', { class: 'vw-counter' });
            toolsEl = h('div', { class: 'vw-tools' });
            stage = h('div', { class: 'vw-stage' });
            root.append(
                h('div', { class: 'vw-bar' },
                    h('button', { class: 'btn ghost icon', 'data-tip': '닫기', 'data-tip-keys': 'Escape', html: ui.icon('x'), onclick: () => viewer.close() }),
                    titleEl, counterEl, h('div', { class: 'grow' }), toolsEl),
                h('div', { class: 'vw-main' },
                    h('button', { class: 'vw-nav prev', 'aria-label': '이전', html: ui.icon('chevron-left', { size: 28 }), onclick: () => viewer.step(-1) }),
                    stage,
                    h('button', { class: 'vw-nav next', 'aria-label': '다음', html: ui.icon('chevron-right', { size: 28 }), onclick: () => viewer.step(1) })));
            App.bus.on('item:open', ({ path }) => viewer.open(path));
            App.bus.on('workspace:closed', () => viewer.close());
            App.bus.on('fs:changed', (c) => {
                if (!viewer.isOpen || !c.from) return;
                files = files.map((f) => {
                    const i = c.from.indexOf(f.path);
                    return i >= 0 && c.to ? { ...f, path: c.to[i], name: P.base(c.to[i]) } : f;
                });
            });
        },
    });

    App.viewer = viewer;
})();
