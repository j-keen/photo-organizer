/*
 * Quick Look (team: gallery): Space shows a large preview of the focused item over the grid, without leaving it.
 * ←/→/↑/↓ move through the grid (the selection follows), Enter opens the full viewer, Esc or Space closes.
 * Main shortcuts Quick Look doesn't use itself (Delete, F2, Ctrl+C, chip/rating keys...) keep working on the
 * previewed item, so you can cull while previewing.
 *   App.gallery.quicklook.open(path?) / close() / toggle() / isOpen / current
 * Layer: 'quicklook' (its commands use scope 'quicklook'). Events: 'quicklook:shown' {entry}, 'quicklook:closed' {path}
 */
(() => {
    'use strict';
    const { h, formatBytes, formatDate, formatDuration, formatCount, escapeHtml } = App.util;
    const ui = App.ui;
    const LABEL_NAMES = { red: '빨강', orange: '주황', yellow: '노랑', green: '초록', blue: '파랑', purple: '보라' };

    let root;
    let stage;
    let titleEl;
    let metaEl;
    let counterEl;
    let openBtn;
    let footEl;
    let currentPath = null;
    let release = null;
    let token = 0;

    function target() {
        const primary = App.select.primary();
        if (primary) return primary;
        if (App.select.focus) {
            const f = App.view.get(App.select.focus);
            if (f) return f;
        }
        return App.select.count ? App.view.get(App.select.list()[0]) : null;
    }

    function releaseMedia() {
        if (release) release();
        release = null;
        const v = stage && stage.querySelector('video');
        if (v) {
            v.pause();
            v.removeAttribute('src');
            v.load();
        }
    }

    const ql = {
        get isOpen() {
            return !!root && !root.hidden;
        },
        get current() {
            return currentPath ? App.view.get(currentPath) : null;
        },
        open(p) {
            if (!root || !App.fs.ready) return;
            const entry = p ? App.view.get(p) : target();
            if (!entry) return;
            if (p && !App.select.has(p)) App.select.set([p]);
            if (!ql.isOpen) {
                root.hidden = false;
                root.classList.remove('open');
                void root.offsetWidth; // restart the entrance animation
                root.classList.add('open');
                App.layers.push('quicklook');
                ui.closeMenus?.();
            }
            show(entry);
        },
        close() {
            if (!ql.isOpen) return;
            token++;
            releaseMedia();
            stage.innerHTML = '';
            root.hidden = true;
            root.classList.remove('open');
            App.layers.pop('quicklook');
            const p = currentPath;
            currentPath = null;
            if (p && App.view.indexOf(p) >= 0) App.gallery.scrollTo(p);
            App.bus.emit('quicklook:closed', { path: p });
        },
        toggle() {
            if (ql.isOpen) ql.close();
            else ql.open();
        },
    };

    function metaParts(entry) {
        if (entry.kind === 'dir') {
            const s = App.gallery.folderInfo(entry.path);
            if (!s) return ['폴더'];
            const parts = [];
            if (s.images) parts.push(`사진 ${formatCount(s.images)}`);
            if (s.videos) parts.push(`영상 ${formatCount(s.videos)}`);
            if (s.dirs) parts.push(`폴더 ${formatCount(s.dirs)}`);
            return parts.length ? parts : ['비어 있어요'];
        }
        const m = App.catalog.peek(entry.path)?.meta || {};
        const parts = [];
        if (entry.type === 'video' && m.duration > 0 && isFinite(m.duration)) parts.push(formatDuration(m.duration));
        if (m.w && m.h) parts.push(`${m.w}×${m.h}`);
        parts.push(formatBytes(entry.size));
        if (entry.mtime) parts.push(formatDate(entry.mtime, true));
        return parts;
    }

    function renderHeader(entry) {
        titleEl.textContent = entry.name;
        titleEl.title = entry.name;
        metaEl.innerHTML = '';
        const cat = App.catalog.peek(entry.path);
        if (cat?.label && LABEL_NAMES[cat.label]) metaEl.append(h('span', { class: `card-label lbl-${cat.label}`, 'data-tip': `${LABEL_NAMES[cat.label]} 라벨` }));
        metaEl.append(h('span', { class: 'truncate', text: metaParts(entry).join(' · ') }));
        if (cat?.rating > 0) metaEl.append(h('span', { class: 'card-stars', 'aria-label': `별점 ${cat.rating}점`, html: ui.icon('star', { size: 11 }).repeat(Math.min(5, cat.rating)) }));
        const i = App.view.indexOf(entry.path);
        counterEl.textContent = i >= 0 ? `${formatCount(i + 1)} / ${formatCount(App.view.visible.length)}` : '';
        const openLabel = entry.kind === 'dir' ? '폴더 열기' : '크게 보기';
        openBtn.querySelector('span').textContent = openLabel;
        const k = (key) => `<span class="kbd">${escapeHtml(App.commands.displayCombo(key))}</span>`;
        footEl.innerHTML = `<span>${k('ArrowLeft')}${k('ArrowRight')} 이동</span><span>${k('Enter')} ${openLabel}</span><span>${k('Space')} 닫기</span>`;
    }

    function message(iconName, title, text) {
        stage.append(h('div', { class: 'ql-message' },
            h('div', { class: 'ql-message-icon', html: ui.icon(iconName, { size: 30 }) }),
            h('div', { class: 'ql-message-title', text: title }),
            text ? h('div', { class: 'ql-message-text', text }) : null));
    }

    function renderFolder(entry) {
        const s = App.gallery.folderInfo(entry.path);
        const samples = s ? s.samples.slice(0, 4) : [];
        const box = h('div', { class: 'ql-folder' });
        if (samples.length) {
            const grid = h('div', { class: `card-mosaic n${samples.length}` });
            for (const e of samples) {
                const cell = h('div', { class: 'mosaic-cell' });
                const img = h('img', { alt: '', draggable: 'false' });
                cell.append(img);
                const url = App.thumbs.peek(e);
                if (url) {
                    img.src = url;
                    cell.classList.add('has-thumb');
                } else {
                    App.thumbs.get(e).then((u) => {
                        if (!u) return;
                        img.src = u;
                        cell.classList.add('has-thumb');
                    });
                }
                grid.append(cell);
            }
            box.append(grid);
        } else {
            box.append(h('div', { class: 'ql-folder-icon', html: ui.icon('folder', { size: 56 }) }));
        }
        box.append(h('div', { class: 'ql-folder-name', text: entry.name }), h('div', { class: 'ql-folder-hint', html: `<span class="kbd">Enter</span> 폴더 열기` }));
        stage.append(box);
    }

    async function show(entry) {
        const t = ++token;
        currentPath = entry.path;
        renderHeader(entry);
        releaseMedia();
        stage.innerHTML = '';
        stage.dataset.kind = entry.kind === 'dir' ? 'dir' : entry.type;
        if (entry.kind === 'dir') {
            renderFolder(entry);
            App.bus.emit('quicklook:shown', { entry });
            return;
        }
        if (!App.util.browserCanDecode(entry.name)) {
            message(entry.type === 'video' ? 'film' : 'image', `${(entry.ext || '').toUpperCase()} 형식은 여기서 미리 볼 수 없어요`, '로컬 서버를 연결하면 이 형식도 볼 수 있어요.');
            App.bus.emit('quicklook:shown', { entry });
            return;
        }
        const thumb = App.thumbs.peek(entry);
        if (entry.type === 'video') {
            const v = h('video', { class: 'ql-media', muted: true, autoplay: true, loop: true, playsinline: true, controls: true, disablepictureinpicture: true });
            v.muted = true;
            if (thumb) v.poster = thumb;
            stage.append(v);
            let src;
            try {
                src = await App.fs.url(entry.path);
            } catch (e) {
                if (t === token) message('alert', '파일을 열 수 없어요', e.message);
                return;
            }
            if (t !== token) return src.release();
            release = src.release;
            v.src = src.url;
            const p = v.play();
            if (p && p.catch) p.catch(() => {});
        } else {
            const img = h('img', { class: `ql-media${thumb ? ' is-thumb' : ''}`, alt: entry.name, draggable: 'false' });
            if (thumb) img.src = thumb;
            stage.append(img);
            let src;
            try {
                src = await App.fs.url(entry.path);
            } catch (e) {
                if (t === token) message('alert', '파일을 열 수 없어요', e.message);
                return;
            }
            if (t !== token) return src.release();
            release = src.release;
            const full = new Image();
            full.src = src.url;
            try {
                await full.decode();
            } catch (e) {
                if (t === token && !thumb) {
                    img.remove();
                    message('image', '이미지를 읽을 수 없어요', '파일이 손상됐거나 지원하지 않는 형식이에요.');
                }
                return;
            }
            if (t !== token) return;
            img.src = src.url;
            img.classList.remove('is-thumb');
        }
        App.bus.emit('quicklook:shown', { entry });
    }

    // ---------- Commands ----------
    const isOpen = () => ql.isOpen;
    App.commands.register({ id: 'gallery.quicklook', title: '훑어보기', group: '보기', icon: 'eye', keys: ['Space'], when: () => App.fs.ready && !!target(), run: () => ql.toggle() });
    App.commands.register({ id: 'quicklook.close', title: '훑어보기 닫기', group: '보기', icon: 'x', scope: 'quicklook', keys: ['Escape', 'Space'], when: isOpen, run: () => ql.close() });
    App.commands.register({ id: 'quicklook.prev', title: '훑어보기: 이전 항목', group: '보기', scope: 'quicklook', keys: ['ArrowLeft'], when: isOpen, run: () => App.gallery.moveFocus(-1) });
    App.commands.register({ id: 'quicklook.next', title: '훑어보기: 다음 항목', group: '보기', scope: 'quicklook', keys: ['ArrowRight'], when: isOpen, run: () => App.gallery.moveFocus(1) });
    App.commands.register({ id: 'quicklook.up', title: '훑어보기: 위 항목', group: '보기', scope: 'quicklook', keys: ['ArrowUp'], when: isOpen, run: () => App.gallery.moveFocus(-App.gallery.columns) });
    App.commands.register({ id: 'quicklook.down', title: '훑어보기: 아래 항목', group: '보기', scope: 'quicklook', keys: ['ArrowDown'], when: isOpen, run: () => App.gallery.moveFocus(App.gallery.columns) });
    App.commands.register({
        id: 'quicklook.open',
        title: '크게 보기',
        group: '보기',
        icon: 'maximize',
        scope: 'quicklook',
        keys: ['Enter'],
        when: isOpen,
        run: () => {
            const e = ql.current;
            ql.close();
            if (e) App.nav.open(e);
        },
    });

    // Main-scope shortcuts that Quick Look doesn't define still act on the previewed item
    const NO_PASS = /^(nav\.|workspace\.)/;
    function passThrough(e) {
        if (!ql.isOpen || App.layers.top() !== 'quicklook' || e.defaultPrevented || e.isComposing) return;
        if (App.util.isTypingTarget(e.target)) return;
        const combo = App.commands.comboFromEvent(e);
        for (const cmd of App.commands.list()) {
            if (cmd.scope !== 'main' || !cmd.keys.includes(combo) || NO_PASS.test(cmd.id)) continue;
            if (!App.commands.isEnabled(cmd.id)) continue;
            e.preventDefault();
            e.stopPropagation();
            App.commands.run(cmd.id, { event: e });
            return;
        }
    }

    App.register('gallery-quicklook', {
        init() {
            titleEl = h('div', { class: 'ql-title truncate' });
            metaEl = h('div', { class: 'ql-meta' });
            counterEl = h('div', { class: 'ql-counter' });
            openBtn = h('button', { class: 'btn ghost sm', type: 'button', 'data-tip': '보기에서 열기', 'data-tip-keys': 'Enter', html: `${ui.icon('maximize', { size: 14 })}<span>크게 보기</span>` });
            openBtn.addEventListener('click', () => App.commands.run('quicklook.open'));
            const closeBtn = h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': '닫기', 'data-tip': '닫기', 'data-tip-keys': 'Escape', html: ui.icon('x', { size: 15 }) });
            closeBtn.addEventListener('click', () => ql.close());
            stage = h('div', { class: 'ql-stage' });
            stage.addEventListener('dblclick', () => App.commands.run('quicklook.open'));
            footEl = h('div', { class: 'ql-foot' });
            const panel = h('div', { class: 'ql-panel', role: 'dialog', 'aria-label': '훑어보기' },
                h('div', { class: 'ql-head' }, h('div', { class: 'ql-titles' }, titleEl, metaEl), counterEl, openBtn, closeBtn),
                stage,
                footEl);
            const backdrop = h('div', { class: 'ql-backdrop' });
            backdrop.addEventListener('click', () => ql.close());
            root = h('div', { class: 'ql', id: 'gallery-quicklook', hidden: true }, backdrop, panel);
            document.body.append(root);

            document.addEventListener('keydown', passThrough);
            App.bus.on('selection:changed', () => {
                if (!ql.isOpen) return;
                const t = target();
                if (!t) ql.close();
                else if (t.path !== currentPath) show(t);
            });
            App.bus.on('catalog:changed', ({ paths }) => {
                if (!ql.isOpen || !currentPath || !paths.includes(currentPath)) return;
                const e = App.view.get(currentPath);
                if (e) renderHeader(e);
            });
            App.bus.on('gallery:folders', () => {
                const e = ql.current;
                if (ql.isOpen && e && e.kind === 'dir') show(e);
            });
            for (const evt of ['folder:loading', 'item:open', 'workspace:closed']) App.bus.on(evt, () => ql.close());
            App.bus.on('view:changed', ({ reason }) => {
                if (ql.isOpen && reason === 'entries' && (!currentPath || App.view.indexOf(currentPath) < 0)) ql.close();
            });
        },
    });

    App.gallery.quicklook = ql;
})();
