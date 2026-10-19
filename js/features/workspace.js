/*
 * Workspace: choosing/restoring the root folder, recent workspaces, the welcome screen.
 * App.workspace.openBackend(backend) is the single entry point — the local server backend uses it too.
 */
(() => {
    'use strict';
    const { h } = App.util;
    const ui = App.ui;
    const RECENTS_KEY = 'workspace.recents';
    const MAX_RECENTS = 8;

    async function getRecents() {
        try {
            return (await App.idb.get(RECENTS_KEY)) || [];
        } catch (e) {
            return [];
        }
    }

    async function addRecent(handle) {
        const list = (await getRecents()).filter((r) => r.name !== handle.name || !r.handle);
        // Same-name folders may differ; isSameEntry tells them apart
        const deduped = [];
        for (const r of list) {
            try {
                if (r.handle && (await r.handle.isSameEntry(handle))) continue;
            } catch (e) {
                /* stale handle */
            }
            deduped.push(r);
        }
        deduped.unshift({ name: handle.name, handle, openedAt: Date.now() });
        await App.idb.set(RECENTS_KEY, deduped.slice(0, MAX_RECENTS)).catch(() => {});
    }

    async function removeRecent(handle) {
        const list = await getRecents();
        const out = [];
        for (const r of list) {
            try {
                if (await r.handle.isSameEntry(handle)) continue;
            } catch (e) {
                /* keep */
            }
            out.push(r);
        }
        await App.idb.set(RECENTS_KEY, out).catch(() => {});
    }

    async function ensurePermission(handle) {
        const opts = { mode: 'readwrite' };
        if ((await handle.queryPermission(opts)) === 'granted') return true;
        return (await handle.requestPermission(opts)) === 'granted';
    }

    const workspace = {
        supported: 'showDirectoryPicker' in window,

        async pick() {
            if (!workspace.supported) {
                await ui.alert({ title: '지원하지 않는 브라우저', message: '이 앱은 Chrome 또는 Edge에서 실행해야 폴더를 열 수 있어요.' });
                return;
            }
            let handle;
            try {
                handle = await window.showDirectoryPicker({ id: 'fluid-identity-root', mode: 'readwrite' });
            } catch (e) {
                if (e.name !== 'AbortError') ui.toast(`폴더를 열 수 없어요: ${e.message}`, { type: 'error' });
                return;
            }
            await workspace.openHandle(handle);
        },

        async openHandle(handle) {
            try {
                if (!(await ensurePermission(handle))) {
                    ui.toast('폴더 권한이 없어서 열 수 없어요', { type: 'error' });
                    return false;
                }
            } catch (e) {
                ui.toast(`폴더를 열 수 없어요: ${e.message}`, { type: 'error' });
                await removeRecent(handle);
                return false;
            }
            await workspace.openBackend(new App.fs.BrowserBackend(handle));
            await addRecent(handle);
            await App.idb.set('workspace.last', handle).catch(() => {});
            return true;
        },

        /** Activate any backend implementing the App.fs backend interface. */
        async openBackend(backend) {
            if (App.fs.ready) await App.catalog.flush();
            App.fs.use(backend);
            let meta = await App.fs.readJSON(`${App.fs.DATA_DIR}/workspace.json`, null).catch(() => null);
            if (!meta || !meta.id) {
                meta = { id: App.util.uid('ws'), createdAt: Date.now(), app: 'Fluid Identity', version: App.version };
                await App.fs.writeJSON(`${App.fs.DATA_DIR}/workspace.json`, meta);
            }
            App.undo.clear();
            App.index.reset();
            App.catalog.reset();
            await App.catalog.load();
            App.nav.back = [];
            App.nav.fwd = [];
            App.setState({ workspace: { name: backend.name, id: meta.id, kind: backend.kind }, cwd: null });
            document.title = `${backend.name} — Fluid Identity`;
            App.bus.emit('workspace:opened', { name: backend.name, id: meta.id });
            await App.nav.go('', { push: false });
            App.index.scan();
        },

        async close() {
            await App.catalog.flush();
            App.fs.use(null);
            App.index.reset();
            App.catalog.reset();
            App.undo.clear();
            App.select.clear();
            App.view.setEntries([], { type: 'none', path: null, title: '' });
            App.setState({ workspace: null, cwd: null });
            document.title = 'Fluid Identity';
            App.bus.emit('workspace:closed');
            renderWelcome();
        },

        getRecents,
    };

    // ---------- Welcome screen ----------
    async function renderWelcome() {
        const host = document.getElementById('welcome');
        if (!host) return;
        host.hidden = false;
        const recents = await getRecents();
        host.innerHTML = '';
        host.append(
            h('div', { class: 'welcome-card' },
                h('div', { class: 'welcome-logo', html: ui.icon('aperture', { size: 30 }) }),
                h('h1', { text: 'Fluid Identity' }),
                h('p', { class: 'welcome-sub', text: '사진과 영상을 폴더째로 빠르게 보고, 칩으로 분류하고, 중복을 걸러내는 정리 도구' }),
                h('button', {
                    class: 'btn primary lg',
                    html: `${ui.icon('folder-open')} 작업 폴더 열기`,
                    onclick: () => workspace.pick(),
                }),
                h('div', { class: 'welcome-hint', html: `단축키 <span class="kbd">${App.commands.displayCombo('Mod+O')}</span> · 폴더 안의 파일은 내 PC에만 있고 어디에도 업로드되지 않아요` }),
                recents.length
                    ? h('div', { class: 'welcome-recents' },
                        h('div', { class: 'welcome-recents-title', text: '최근 작업 폴더' }),
                        ...recents.map((r) =>
                            h('button', {
                                class: 'welcome-recent',
                                onclick: async () => {
                                    await workspace.openHandle(r.handle);
                                },
                            },
                                h('span', { html: ui.icon('folder') }),
                                h('span', { class: 'grow truncate', text: r.name }),
                                h('span', { class: 'faint', text: App.util.formatDate(r.openedAt) }))))
                    : null,
                !workspace.supported ? h('div', { class: 'welcome-warn', html: `${ui.icon('alert')} 이 브라우저는 폴더 접근을 지원하지 않아요. Chrome이나 Edge로 열어 주세요.` }) : null));
    }

    App.bus.on('workspace:opened', () => {
        const host = document.getElementById('welcome');
        if (host) host.hidden = true;
    });

    App.commands.register({ id: 'workspace.open', title: '작업 폴더 열기', group: '파일', icon: 'folder-open', keys: 'Mod+O', scope: 'global', run: () => workspace.pick() });
    App.commands.register({ id: 'workspace.close', title: '작업 폴더 닫기', group: '파일', icon: 'x', when: () => App.fs.ready, run: () => workspace.close() });

    App.register('workspace', {
        init() {
            renderWelcome();
        },
    });

    App.workspace = workspace;
})();
