/* Next files in the viewer's playback order; only reuse cached thumbnails. */
(() => {
    'use strict';
    const { h, path: P, formatDuration } = App.util;
    const PANEL = 'upnext';
    const KEYS = 'Alt+N';
    let host = null;
    let rendered = new Map();

    function entries() {
        const viewer = App.viewer;
        if (!viewer?.current) return [];
        const next = typeof viewer.upNext === 'function'
            ? viewer.upNext(10)
            : viewer.files.slice(viewer.index + 1, viewer.index + 11);
        // Repeated paths are meaningful when playback loops over a short list.
        return [viewer.current, ...(next || [])].filter((entry) => entry?.path).slice(0, 11);
    }

    function metaText(entry, current) {
        const duration = App.catalog.peek(entry.path)?.meta?.duration;
        return [current ? '지금 보는 파일' : '', entry.type === 'video' && Number.isFinite(duration) && duration > 0 ? formatDuration(duration) : ''].filter(Boolean).join(' · ');
    }

    function render() {
        if (!host) return;
        const list = entries();
        rendered = new Map(list.map((entry) => [entry.path, entry]));
        host.replaceChildren();
        host.append(h('p', { class: 'upnext-note', text: '지금 보는 파일부터 다음 10개까지 보여요.' }));
        for (const [index, entry] of list.entries()) {
            const current = index === 0;
            const url = App.thumbs?.peek?.(entry);
            const preview = h('span', { class: 'upnext-thumb', html: url ? '' : App.ui.icon(entry.type === 'video' ? 'video' : 'image') });
            if (url) preview.append(h('img', { src: url, alt: '', loading: 'lazy' }));
            const row = h('button', {
                type: 'button', class: `upnext-row${current ? ' current' : ''}`,
                dataset: { path: entry.path }, 'aria-current': current ? 'true' : null,
                'aria-label': `${current ? '지금 보는 파일: ' : ''}${entry.name}`,
                onclick: () => App.commands.run('viewer.upnextGo', { path: entry.path }),
            }, preview, h('span', { class: 'upnext-info' },
                h('span', { class: 'upnext-name truncate', text: entry.name }),
                h('span', { class: 'upnext-folder truncate', text: P.parent(entry.path) || App.state.workspace?.name || '작업 폴더' }),
                h('span', { class: 'upnext-meta', text: metaText(entry, current) })));
            host.append(row);
        }
        if (list.length === 1) host.append(h('p', { class: 'upnext-note', text: '목록의 마지막 파일이에요.' }));
    }

    function refreshMetadata(change = {}) {
        if (!host) return;
        const affected = change.path ? new Set([change.path]) : change.paths ? new Set(change.paths) : null;
        for (const row of host.querySelectorAll('.upnext-row')) {
            if (affected && !affected.has(row.dataset.path)) continue;
            const entry = rendered.get(row.dataset.path);
            if (!entry) continue;
            row.querySelector('.upnext-meta').textContent = metaText(entry, row.classList.contains('current'));
            const url = App.thumbs?.peek?.(entry);
            const preview = row.querySelector('.upnext-thumb');
            if (url && preview.querySelector('img')?.getAttribute('src') !== url) preview.replaceChildren(h('img', { src: url, alt: '', loading: 'lazy' }));
        }
    }

    App.commands.register({ id: 'viewer.upnext', title: '다음 재생 패널 열고 닫기', group: '보기', icon: 'list', keys: KEYS,
        scope: 'viewer', when: () => !!App.viewer?.isOpen, run: () => App.viewer.togglePanel(PANEL) });
    App.commands.register({ id: 'viewer.upnextGo', title: '다음 재생 파일로 이동', icon: 'play', scope: 'viewer', palette: false,
        when: () => !!App.viewer?.isOpen, run: ({ path } = {}) => {
            if (!entries().some((entry) => entry.path === path)) return;
            if (typeof App.viewer.goPath === 'function') return App.viewer.goPath(path);
            const index = App.viewer.files.findIndex((entry) => entry.path === path);
            if (index >= 0) return App.viewer.go(index);
        } });

    App.register('viewer-upnext', {
        init() {
            App.viewer.registerPanel({ id: PANEL, title: '다음 재생', icon: 'list', keys: KEYS, order: 40, kinds: ['video'],
                render(body) {
                    host = h('div', { class: 'upnext-list', 'aria-label': '다음 재생 목록' });
                    body.append(host);
                    render();
                    return () => { host = null; rendered.clear(); };
                },
            });
            for (const event of ['viewer:entry', 'viewer:upnext-changed']) App.bus.on(event, render);
            for (const event of ['thumbs:ready', 'thumbs:meta', 'catalog:changed']) App.bus.on(event, refreshMetadata);
        },
    });
})();
