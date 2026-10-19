/*
 * Inspector (right panel): preview + details of the selection. Other modules add sections:
 *   App.inspector.addSection({ id, title, order, render(bodyEl, ctx), when?(ctx) })
 *   ctx = { entries: Entry[] (selected, or [] when nothing selected), primary: Entry|null, folder: string }
 * Sections re-render on selection/catalog/fs changes. Use App.inspector.refresh() to force it.
 */
(() => {
    'use strict';
    const { h, path: P, formatBytes, formatDate, formatDuration, formatCount } = App.util;
    const ui = App.ui;

    let host;
    let previewRelease = null;
    const sections = [];

    function ctx() {
        const entries = App.select.entries();
        return { entries, primary: App.select.primary(), folder: App.state.cwd };
    }

    function infoTable(rows) {
        const t = h('div', { class: 'insp-table' });
        for (const [k, v] of rows) {
            if (v == null || v === '') continue;
            t.append(h('div', { class: 'insp-k', text: k }), h('div', { class: 'insp-v', text: v, title: String(v) }));
        }
        return t;
    }

    // ----- Built-in sections -----
    function renderPreview(body, { entries, primary }) {
        if (previewRelease) {
            previewRelease();
            previewRelease = null;
        }
        if (primary && primary.kind === 'file') {
            const box = h('div', { class: 'insp-preview' });
            body.append(box);
            if (primary.type === 'video' && App.util.browserCanDecode(primary.name)) {
                App.fs.url(primary.path).then(({ url, release }) => {
                    if (!box.isConnected) return release();
                    previewRelease = release;
                    const v = h('video', { src: url, controls: true, muted: true, preload: 'metadata', class: 'insp-video' });
                    box.append(v);
                });
            } else {
                const img = h('img', { alt: '', class: 'insp-img' });
                box.append(img);
                App.thumbs.get(primary, { size: 720 }).then((url) => {
                    if (url) img.src = url;
                    else box.append(h('div', { class: 'insp-noprev', html: `${ui.icon(primary.type === 'video' ? 'film' : 'image', { size: 32 })}<span>${primary.ext.toUpperCase()} 미리보기 없음</span>` }));
                });
            }
            box.addEventListener('dblclick', () => App.nav.open(primary));
            return;
        }
        if (entries.length > 1) {
            const grid = h('div', { class: 'insp-stack' });
            for (const e of entries.slice(0, 6)) {
                const cell = h('div', { class: 'insp-stack-cell' });
                if (e.kind === 'dir') cell.innerHTML = ui.icon('folder', { size: 28 });
                else
                    App.thumbs.get(e).then((url) => {
                        if (url) cell.append(h('img', { src: url, alt: '' }));
                        else cell.innerHTML = ui.icon(e.type === 'video' ? 'film' : 'image', { size: 24 });
                    });
                grid.append(cell);
            }
            body.append(grid);
        }
    }

    function renderInfo(body, { entries, primary, folder }) {
        if (primary) {
            const meta = App.catalog.peek(primary.path)?.meta || {};
            body.append(h('div', { class: 'insp-title', text: primary.name, title: primary.name }));
            body.append(infoTable([
                ['종류', primary.kind === 'dir' ? '폴더' : `${primary.type === 'video' ? '영상' : primary.type === 'image' ? '사진' : '파일'} · ${primary.ext.toUpperCase()}`],
                ['크기', primary.kind === 'dir' ? null : formatBytes(primary.size)],
                ['해상도', meta.w && meta.h ? `${meta.w} × ${meta.h}` : null],
                ['길이', meta.duration ? formatDuration(meta.duration) : null],
                ['수정한 날짜', primary.mtime ? formatDate(primary.mtime, true) : null],
                ['위치', P.parent(primary.path) || App.state.workspace?.name],
            ]));
            return;
        }
        if (entries.length > 1) {
            const size = entries.reduce((s, e) => s + (e.size || 0), 0);
            const imgs = entries.filter((e) => e.type === 'image').length;
            const vids = entries.filter((e) => e.type === 'video').length;
            const dirs = entries.filter((e) => e.kind === 'dir').length;
            body.append(h('div', { class: 'insp-title', text: `${formatCount(entries.length)}개 선택됨` }));
            body.append(infoTable([
                ['사진', imgs ? formatCount(imgs) : null],
                ['영상', vids ? formatCount(vids) : null],
                ['폴더', dirs ? formatCount(dirs) : null],
                ['전체 크기', size ? formatBytes(size) : null],
            ]));
            return;
        }
        // Nothing selected: describe the current folder
        const v = App.view.entries;
        body.append(h('div', { class: 'insp-title', text: App.view.source.title || App.state.workspace?.name || '' }));
        body.append(infoTable([
            ['사진', formatCount(v.filter((e) => e.type === 'image').length)],
            ['영상', formatCount(v.filter((e) => e.type === 'video').length)],
            ['폴더', formatCount(v.filter((e) => e.kind === 'dir').length)],
            ['전체 크기', formatBytes(v.reduce((s, e) => s + (e.size || 0), 0))],
        ]));
        body.append(h('p', { class: 'insp-hint', text: '파일을 선택하면 미리보기와 정보가 여기에 나와요.' }));
    }

    function render() {
        if (!host) return;
        host.innerHTML = '';
        if (!App.fs.ready) {
            host.append(h('div', { class: 'insp-empty', text: '작업 폴더를 열면 선택한 파일의 정보가 여기에 나와요.' }));
            return;
        }
        const c = ctx();
        for (const s of sections) {
            if (s.when && !s.when(c)) continue;
            const body = h('div', { class: 'insp-body' });
            const el = h('section', { class: `insp-section insp-${s.id}`, dataset: { section: s.id } });
            if (s.title) el.append(h('div', { class: 'panel-section-head' }, h('span', { class: 'grow', text: s.title })));
            el.append(body);
            host.append(el);
            try {
                s.render(body, c, el);
            } catch (e) {
                console.error('[inspector] section failed', s.id, e);
            }
        }
    }

    const renderSoon = App.util.debounce(render, 40);

    const inspector = {
        addSection(section) {
            sections.push(section);
            sections.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
            renderSoon();
        },
        refresh: renderSoon,
    };

    inspector.addSection({ id: 'preview', order: 0, render: renderPreview, when: (c) => c.entries.length > 0 });
    inspector.addSection({ id: 'info', order: 10, render: renderInfo });

    App.register('inspector', {
        init() {
            host = document.getElementById('inspector');
            render();
            App.bus.on('selection:changed', renderSoon);
            App.bus.on('view:changed', ({ reason }) => {
                if (reason === 'entries' || !App.select.count) renderSoon();
            });
            App.bus.on('catalog:changed', ({ paths }) => {
                const p = App.select.primary()?.path;
                if (!p || paths.includes(p)) renderSoon();
            });
            App.bus.on('workspace:closed', render);
        },
    });

    App.inspector = inspector;
})();
