/*
 * Workspace: choosing / restoring the root folder, recent workspaces, the welcome screen, dropping a folder
 * from Explorer to open it, and remembering where you left off in each workspace.
 *
 *   App.workspace.pick()                             system folder dialog → open at the workspace root
 *   App.workspace.openHandle(handle, { restore })    open a FileSystemDirectoryHandle (asks for permission if needed)
 *   App.workspace.openBackend(backend, { restore })  activate any App.fs backend — the single entry point (server too)
 *   App.workspace.close() · reopenLast() · getRecents() · removeRecent(handle)
 *   App.workspace.viewState(id) · saveViewState()    per-workspace "where was I" (folder, sort, filter, selection)
 *
 * Opening is serialized: a newer request waits for the one in progress, and the automatic reopen at startup
 * yields to anything the user (or the server module) opens meanwhile.
 * Settings: workspace.autoReopen (default true), workspace.restoreView (default true).
 */
(() => {
    'use strict';
    const { h, path: P } = App.util;
    const ui = App.ui;
    const RECENTS_KEY = 'workspace.recents';
    const LAST_KEY = 'workspace.last';
    const VIEW_PREFIX = 'workspace.view.';
    const MAX_RECENTS = 8;
    const MAX_VIEW_STATES = 30;

    let resume = null; // { handle, perm } — last workspace waiting for a one-click reopen
    let openGen = 0;
    let openChain = Promise.resolve();
    let opening = false;
    let restoring = false;

    // =====================================================================================================
    // Recents (IndexedDB: directory handles survive reloads)
    // =====================================================================================================
    async function getRecents() {
        try {
            const list = await App.idb.get(RECENTS_KEY);
            return Array.isArray(list) ? list.filter((r) => r && r.handle) : [];
        } catch (e) {
            return [];
        }
    }

    async function sameEntry(a, b) {
        try {
            return !!a && !!b && typeof a.isSameEntry === 'function' && (await a.isSameEntry(b));
        } catch (e) {
            return false;
        }
    }

    async function addRecent(handle, extra = {}) {
        const out = [];
        let prev = null;
        for (const r of await getRecents()) {
            if (await sameEntry(r.handle, handle)) prev = r;
            else out.push(r);
        }
        out.unshift({ ...(prev || {}), ...extra, name: handle.name, handle, openedAt: Date.now() });
        await App.idb.set(RECENTS_KEY, out.slice(0, MAX_RECENTS)).catch(() => {});
    }

    /** Remove a workspace from the recent list (and forget it as "last" so it isn't reopened). Returns the removed record. */
    async function removeRecent(handle) {
        const list = await getRecents();
        let removed = null;
        const out = [];
        for (const [i, r] of list.entries()) {
            if (!removed && (await sameEntry(r.handle, handle))) removed = { ...r, index: i };
            else out.push(r);
        }
        await App.idb.set(RECENTS_KEY, out).catch(() => {});
        const last = await App.idb.get(LAST_KEY).catch(() => null);
        if (last && (await sameEntry(last, handle))) {
            await App.idb.del(LAST_KEY).catch(() => {});
            if (removed) removed.wasLast = true;
            if (resume && (await sameEntry(resume.handle, handle))) {
                if (removed) removed.resumePerm = resume.perm;
                resume = null;
            }
        }
        return removed;
    }

    async function restoreRecent(rec) {
        const list = await getRecents();
        const { index = 0, wasLast, resumePerm, ...r } = rec;
        const out = [];
        for (const x of list) if (!(await sameEntry(x.handle, r.handle))) out.push(x);
        out.splice(Math.min(index, out.length), 0, r);
        await App.idb.set(RECENTS_KEY, out.slice(0, MAX_RECENTS)).catch(() => {});
        if (wasLast) {
            await App.idb.set(LAST_KEY, r.handle).catch(() => {});
            if (resumePerm && !App.fs.ready) resume = { handle: r.handle, perm: resumePerm };
        }
    }

    /** Remove from the recent list as an undoable action (Ctrl+Z on the welcome screen brings it back). */
    async function forgetRecent(r) {
        const removed = await removeRecent(r.handle);
        renderWelcome();
        if (!removed) return;
        const entry = {
            label: `최근 목록에서 ‘${r.name}’ 빼기`,
            undo: async () => {
                await restoreRecent(removed);
                renderWelcome();
            },
            redo: async () => {
                await removeRecent(r.handle);
                renderWelcome();
            },
        };
        App.undo.push(entry);
        ui.toast(`‘${r.name}’을(를) 최근 목록에서 뺐어요`, {
            action: { label: '실행 취소', run: () => (App.undo.peek?.() === entry ? App.undo.undo() : entry.undo()) },
        });
    }

    async function permissionOf(handle) {
        try {
            return await handle.queryPermission({ mode: 'readwrite' });
        } catch (e) {
            return 'error';
        }
    }

    async function ensurePermission(handle) {
        const opts = { mode: 'readwrite' };
        if ((await handle.queryPermission(opts)) === 'granted') return true;
        return (await handle.requestPermission(opts)) === 'granted';
    }

    // =====================================================================================================
    // Per-workspace view state ("where was I")
    // =====================================================================================================
    function viewState(id) {
        const st = id ? App.settings.get(VIEW_PREFIX + id, null) : null;
        return st && typeof st === 'object' ? st : null;
    }

    function saveViewState() {
        const ws = App.state.workspace;
        if (!ws || !App.fs.ready || opening || restoring || App.state.cwd == null) return;
        const st = {
            cwd: App.state.cwd || '',
            sort: App.view.sort ? { key: App.view.sort.key, dir: App.view.sort.dir } : null,
            type: App.view.filters.get('type')?.id || 'all',
            focus: App.view.source.type === 'folder' ? App.select.focus || null : null,
            selection: App.view.source.type === 'folder' ? App.select.list().slice(0, 500) : [],
            t: Date.now(),
        };
        const prev = viewState(ws.id);
        if (prev && JSON.stringify({ ...prev, t: 0 }) === JSON.stringify({ ...st, t: 0 })) return;
        App.settings.set(VIEW_PREFIX + ws.id, st);
        pruneViewStates();
    }

    function pruneViewStates() {
        const all = App.settings.all();
        const keys = Object.keys(all).filter((k) => k.startsWith(VIEW_PREFIX));
        if (keys.length <= MAX_VIEW_STATES) return;
        keys.sort((a, b) => (all[a]?.t || 0) - (all[b]?.t || 0));
        for (const k of keys.slice(0, keys.length - MAX_VIEW_STATES)) App.settings.set(k, undefined);
    }

    const saveViewSoon = App.util.debounce(saveViewState, 500);

    async function startPoint(id, restore, force = false) {
        if (!restore || (!force && App.settings.get('workspace.restoreView', true) === false)) return null;
        const st = viewState(id);
        if (!st) return null;
        let cwd = typeof st.cwd === 'string' ? st.cwd : '';
        while (cwd && !App.fs.isDataPath(cwd)) {
            try {
                if ((await App.fs.backend.stat(cwd)).kind === 'dir') break;
            } catch (e) {
                /* gone: walk up */
            }
            cwd = P.parent(cwd);
        }
        if (App.fs.isDataPath(cwd)) cwd = '';
        return { ...st, cwd };
    }

    function applyViewPrefs(st) {
        if (st.sort && st.sort.key && App.view.sortKeys().some((k) => k.key === st.sort.key)) {
            if (App.view.sort.key !== st.sort.key || App.view.sort.dir !== st.sort.dir) App.view.setSort(st.sort.key, st.sort.dir);
        }
        const type = ['all', 'image', 'video'].includes(st.type) ? st.type : 'all';
        if ((App.view.filters.get('type')?.id || 'all') !== type) {
            if (App.topbar?.setTypeFilter) App.topbar.setTypeFilter(type);
            else App.view.setFilter('type', type === 'all' ? null : { id: type, label: type === 'image' ? '사진만' : '영상만', test: (e) => e.type === type });
        }
    }

    function restoreSelection(st) {
        const sel = (st.selection || []).filter((p) => App.view.index.has(p));
        const focus = st.focus && App.view.index.has(st.focus) ? st.focus : sel[sel.length - 1] || null;
        if (sel.length) App.select.set(sel, { focus });
        else if (focus) App.select.set([focus], { focus });
        if (focus) requestAnimationFrame(() => App.gallery?.scrollTo?.(focus, { center: true }));
    }

    // =====================================================================================================
    // Opening / closing
    // =====================================================================================================
    function workspaceTitle() {
        const ws = App.state.workspace;
        if (!ws) return 'Fluid Identity';
        const cwd = App.state.cwd;
        return cwd ? `${P.base(cwd)} — ${ws.name} — Fluid Identity` : `${ws.name} — Fluid Identity`;
    }

    // Modules with their own debounced .fluid-organizer files (e.g. clips.json) register a flush here,
    // so pending writes reach the old folder before the backend switches
    async function flushModules() {
        await Promise.all((workspace.flushHooks || []).map((f) => Promise.resolve().then(f).catch((e) => console.warn('[workspace] flush hook failed', e))));
    }

    async function doOpen(backend, { restore = false, auto = false, reload = false, keepUndo = false } = {}, gen) {
        if (auto && gen !== openGen) return false; // something newer was requested: let it win
        if (reload && App.fs.backend !== backend) return false; // the workspace changed meanwhile
        saveViewState(); // remember where we were in the previous workspace
        const history = reload ? { back: [...App.nav.back], fwd: [...App.nav.fwd] } : null;
        opening = true;
        try {
            if (App.fs.ready) {
                await App.catalog.flush();
                await flushModules();
            }
            App.fs.use(backend);
            let meta = await App.fs.readJSON(`${App.fs.DATA_DIR}/workspace.json`, null).catch(() => null);
            if (!meta || !meta.id) {
                meta = { id: App.util.uid('ws'), createdAt: Date.now(), app: 'Fluid Identity', version: App.version };
                await App.fs.writeJSON(`${App.fs.DATA_DIR}/workspace.json`, meta);
            }
            const start = await startPoint(meta.id, restore || reload, reload);
            if (!keepUndo) App.undo.clear();
            App.index.reset();
            App.catalog.reset();
            await App.catalog.load();
            App.nav.back = history ? history.back : [];
            App.nav.fwd = history ? history.fwd : [];
            App.setState({ workspace: { name: backend.name, id: meta.id, kind: backend.kind }, cwd: null });
            document.title = workspaceTitle();
            App.bus.emit('workspace:opened', { name: backend.name, id: meta.id });
            restoring = !!start;
            try {
                if (start) applyViewPrefs(start);
                await App.nav.go(start ? start.cwd : '', { push: false, focus: start?.focus || null });
                if (start) restoreSelection(start);
            } finally {
                restoring = false;
            }
            App.index.scan();
            return true;
        } catch (e) {
            console.error('[workspace] open failed', e);
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
            throw e;
        } finally {
            opening = false;
        }
    }

    function openBackend(backend, opts = {}) {
        const gen = ++openGen;
        const run = () => doOpen(backend, opts, gen);
        const p = openChain.then(run, run);
        openChain = p.catch(() => {});
        return p;
    }

    let persistAsked = false;

    // Open a handle we already have permission for. Calls openBackend synchronously (keeps request order).
    async function openWith(handle, opts) {
        let ok;
        try {
            ok = await openBackend(new App.fs.BrowserBackend(handle), opts);
        } catch (e) {
            reportOpenError(handle, e);
            return false;
        }
        if (!ok) return false;
        resume = null;
        await addRecent(handle, { id: App.state.workspace?.id });
        await App.idb.set(LAST_KEY, handle).catch(() => {});
        if (!persistAsked && navigator.storage?.persist) {
            persistAsked = true;
            navigator.storage.persist().catch(() => {});
        }
        return true;
    }

    function reportOpenError(handle, e) {
        const gone = e && (e.name === 'NotFoundError' || e.code === 'ENOENT');
        if (gone) {
            ui.toast(`‘${handle.name}’ 폴더를 찾을 수 없어요. 옮겨졌거나 지워졌을 수 있어요.`, {
                type: 'error',
                action: {
                    label: '목록에서 빼기',
                    run: () => forgetRecent({ name: handle.name, handle }),
                },
            });
        } else {
            ui.toast(`폴더를 열 수 없어요: ${e?.message || e}`, { type: 'error' });
        }
    }

    const workspace = {
        supported: 'showDirectoryPicker' in window,
        flushHooks: [], // () => Promise — awaited before a workspace switch/close (see flushModules)

        async pick() {
            if (!workspace.supported) {
                await ui.alert({ title: '지원하지 않는 브라우저', message: '이 앱은 Chrome 또는 Edge에서 실행해야 폴더를 열 수 있어요.' });
                return false;
            }
            let handle;
            try {
                handle = await window.showDirectoryPicker({ id: 'fluid-identity-root', mode: 'readwrite' });
            } catch (e) {
                if (e.name !== 'AbortError') ui.toast(`폴더를 열 수 없어요: ${e.message}`, { type: 'error' });
                return false;
            }
            return workspace.openHandle(handle, { restore: false });
        },

        async openHandle(handle, { restore = true } = {}) {
            try {
                if (!(await ensurePermission(handle))) {
                    ui.toast('폴더 권한이 없어서 열 수 없어요', { type: 'error' });
                    return false;
                }
            } catch (e) {
                reportOpenError(handle, e);
                return false;
            }
            return openWith(handle, { restore });
        },

        openBackend,

        /**
         * Re-open the current workspace in place (every module reloads its data from .fluid-organizer), keeping the
         * folder, selection and back/forward history. keepUndo keeps the undo stack (used by backup restore).
         */
        reload({ keepUndo = true } = {}) {
            if (!App.fs.ready) return Promise.resolve(false);
            return openBackend(App.fs.backend, { reload: true, keepUndo });
        },

        /** One-click reopen of the last workspace (asks for permission when needed). */
        async reopenLast() {
            const handle = resume?.handle || (await App.idb.get(LAST_KEY).catch(() => null));
            if (!handle) return workspace.pick();
            return workspace.openHandle(handle, { restore: true });
        },

        close() {
            const run = async () => {
                saveViewState();
                await App.catalog.flush();
                await flushModules();
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
            };
            const p = openChain.then(run, run);
            openChain = p.catch(() => {});
            return p;
        },

        getRecents,
        removeRecent,
        viewState,
        saveViewState,
        get resume() {
            return resume;
        },
        get opening() {
            return opening;
        },
    };

    // =====================================================================================================
    // Startup: reopen the last workspace
    // =====================================================================================================
    async function boot() {
        const startGen = openGen;
        if (App.fs.ready) return;
        if (startGen > 0) {
            // an open started before we got here; show the full welcome in case it fails or is cancelled
            renderWelcome();
            return;
        }
        const last = await App.idb.get(LAST_KEY).catch(() => null);
        if (!last || typeof last.queryPermission !== 'function') {
            renderWelcome();
            return;
        }
        const perm = await permissionOf(last);
        if (openGen !== startGen || App.fs.ready) return; // the user (or the server module) opened something
        if (perm === 'granted' && App.settings.get('workspace.autoReopen', true) !== false) {
            renderWelcome('opening', { name: last.name });
            const ok = await openWith(last, { restore: true, auto: true });
            if (!ok && !App.fs.ready && openGen === startGen + 1) {
                resume = { handle: last, perm: await permissionOf(last) };
                renderWelcome();
            }
            return;
        }
        if (perm === 'granted' || perm === 'prompt') resume = { handle: last, perm };
        renderWelcome();
    }

    // =====================================================================================================
    // Welcome screen
    // =====================================================================================================
    let renderToken = 0;

    function welcomeEl() {
        return document.getElementById('welcome');
    }

    function kbdEl(combo) {
        return App.palette?.kbdEl ? App.palette.kbdEl(combo, 'wl-kbd') : h('span', { class: 'kbd', text: App.commands.displayCombo(combo) });
    }

    function hero() {
        return h('div', { class: 'wl-hero' },
            h('div', { class: 'welcome-logo', html: ui.icon('aperture', { size: 30 }) }),
            h('h1', { text: 'Fluid Identity' }),
            h('p', { class: 'welcome-sub', text: '사진과 영상을 폴더째로 빠르게 보고, 칩으로 분류하고, 중복을 걸러내는 정리 도구' }));
    }

    const FEATURES = [
        ['folder-open', '폴더 그대로', '탐색기 폴더를 그대로 열어 보고 정리해요. 어디에도 올리지 않아요.'],
        ['tag', '칩으로 분류', '분류와 칩을 만들어 두고 클릭 한 번으로 붙여요.'],
        ['layers', '중복 걸러내기', '비슷한 사진·영상을 묶어서 골라 지워요.'],
        ['shield-check', '안전한 정리', '지운 파일은 휴지통에, 모든 작업은 Ctrl+Z로 되돌려요.'],
    ];

    function resumeCard(r) {
        const st = viewState(r.id);
        const meta = [st?.cwd ? `마지막 위치 · ${st.cwd}` : null, r.openedAt ? App.shell.relTime(r.openedAt) : null].filter(Boolean).join(' · ');
        const btn = h('button', {
            class: 'btn primary wl-resume-btn',
            type: 'button',
            'data-tip': `‘${r.name}’ 다시 열기`,
            html: `${ui.icon('folder-open', { size: 15 })}<span>다시 열기</span>`,
            onclick: () => workspace.reopenLast(),
        });
        return h('div', { class: 'wl-resume' },
            h('div', { class: 'wl-resume-ico', html: ui.icon('history', { size: 20 }) }),
            h('div', { class: 'wl-resume-text' },
                h('div', { class: 'wl-resume-title' }, h('span', { text: '이어서 보기 · ' }), h('b', { text: r.name })),
                h('div', { class: 'wl-resume-meta', text: meta || '지난번에 보던 작업 폴더예요' }),
                r.perm === 'prompt'
                    ? h('div', { class: 'wl-resume-tip', html: `${ui.icon('lock', { size: 12 })}<span>브라우저가 권한을 한 번 더 물어봐요. ‘방문할 때마다 허용’을 고르면 다음부터는 자동으로 열려요.</span>` })
                    : null),
            btn);
    }

    function recentRow(r) {
        const st = viewState(r.id);
        const meta = [r.openedAt ? App.shell.relTime(r.openedAt) : null, st?.cwd ? st.cwd : null].filter(Boolean).join(' · ');
        const row = h('div', { class: 'wl-recent', role: 'listitem' });
        const openBtn = h('button', {
            class: 'wl-recent-open',
            type: 'button',
            'aria-label': `${r.name} 열기`,
            onclick: () => workspace.openHandle(r.handle, { restore: true }),
        },
            h('span', { class: 'wl-recent-ico', html: ui.icon('folder', { size: 16 }) }),
            h('span', { class: 'wl-recent-text' }, h('span', { class: 'wl-recent-name', text: r.name }), meta ? h('span', { class: 'wl-recent-meta', text: meta }) : null),
            h('span', { class: 'wl-recent-go', html: ui.icon('arrow-right', { size: 14 }) }));
        const removeBtn = h('button', {
            class: 'wl-recent-remove',
            type: 'button',
            'aria-label': `${r.name} 최근 목록에서 빼기`,
            'data-tip': '목록에서 빼기',
            html: ui.icon('x', { size: 14 }),
            onclick: () => forgetRecent(r),
        });
        row.append(openBtn, removeBtn);
        return row;
    }

    function fullView(recents, resumeIndex) {
        const card = h('div', { class: `welcome-card${recents.length ? '' : ' is-first'}` });
        card.append(hero());
        const resumeRec = resume ? { ...(recents[resumeIndex] || {}), name: resume.handle.name, handle: resume.handle, perm: resume.perm } : null;
        if (resumeRec) card.append(resumeCard(resumeRec));

        const openBtn = h('button', {
            class: `btn ${resumeRec ? '' : 'primary'} lg wl-open`,
            type: 'button',
            'data-tip': '작업 폴더 열기',
            'data-tip-keys': 'Mod+O',
            disabled: !workspace.supported,
            onclick: () => workspace.pick(),
        }, h('span', { html: ui.icon('folder-open') }), h('span', { text: resumeRec ? '다른 폴더 열기' : '작업 폴더 열기' }));
        card.append(h('div', { class: 'wl-actions' },
            openBtn,
            workspace.supported ? h('div', { class: 'wl-drop-hint', html: `${ui.icon('download', { size: 14 })}<span>또는 폴더를 이 창으로 끌어다 놓으세요</span>` }) : null));

        const shown = recents.filter((r, i) => i !== resumeIndex);
        if (shown.length) {
            const list = h('div', { class: 'wl-recent-list', role: 'list' }, ...shown.map(recentRow));
            list.addEventListener('keydown', (e) => {
                const btns = [...list.querySelectorAll('.wl-recent-open')];
                const i = btns.indexOf(document.activeElement);
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    const next = btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length];
                    next?.focus();
                } else if (e.key === 'Delete' && i >= 0) {
                    e.preventDefault();
                    btns[i].parentElement.querySelector('.wl-recent-remove')?.click();
                }
            });
            card.append(h('section', { class: 'wl-recents' },
                h('div', { class: 'wl-section-head' }, h('span', { text: '최근 작업 폴더' }), h('span', { class: 'wl-count', text: String(shown.length) })),
                list));
        }

        if (!recents.length) {
            card.append(h('div', { class: 'wl-features' }, ...FEATURES.map(([icon, title, text]) => h('div', { class: 'wl-feature' },
                h('span', { class: 'wl-feature-ico', html: ui.icon(icon, { size: 16 }) }),
                h('div', null, h('div', { class: 'wl-feature-title', text: title }), h('div', { class: 'wl-feature-text', text })),
            ))));
        }

        if (!workspace.supported) card.append(h('div', { class: 'welcome-warn', html: `${ui.icon('alert')} 이 브라우저는 폴더 접근을 지원하지 않아요. Chrome이나 Edge로 열어 주세요.` }));

        card.append(h('div', { class: 'wl-foot' },
            h('span', { class: 'wl-foot-item', html: `${ui.icon('shield-check', { size: 13 })}<span>사진은 내 PC 밖으로 나가지 않아요</span>` }),
            h('span', { class: 'wl-foot-item' }, kbdEl('Mod+K'), h('span', { text: '명령 팔레트' })),
            h('span', { class: 'wl-foot-item' }, kbdEl('?'), h('span', { text: '단축키' }))));
        return card;
    }

    async function renderWelcome(mode = 'full', info = {}) {
        const host = welcomeEl();
        if (!host) return;
        const token = ++renderToken;
        if (App.fs.ready && mode !== 'opening') {
            host.hidden = true;
            return;
        }
        host.hidden = false;
        if (!host.querySelector('.wl-drop')) host.append(dropOverlay());
        const drop = host.querySelector('.wl-drop');
        const keep = (el) => {
            host.replaceChildren(el, drop);
        };
        if (mode === 'boot') {
            keep(h('div', { class: 'wl-boot' }, h('div', { class: 'welcome-logo', html: ui.icon('aperture', { size: 30 }) })));
            return;
        }
        if (mode === 'opening') {
            keep(h('div', { class: 'wl-opening' },
                hero(),
                h('div', { class: 'wl-opening-line' }, h('span', { class: 'spinner' }), h('span', { text: `‘${info.name || '작업 폴더'}’ 여는 중…` }))));
            return;
        }
        const recents = await getRecents();
        let resumeIndex = -1;
        if (resume) {
            for (const [i, r] of recents.entries()) {
                if (await sameEntry(r.handle, resume.handle)) {
                    resumeIndex = i;
                    break;
                }
            }
        }
        if (token !== renderToken || App.fs.ready) return;
        keep(fullView(recents, resumeIndex));
    }

    function dropOverlay() {
        return h('div', { class: 'wl-drop', 'aria-hidden': 'true' },
            h('div', { class: 'wl-drop-box' },
                h('div', { class: 'wl-drop-ico', html: ui.icon('folder-input', { size: 28 }) }),
                h('div', { class: 'wl-drop-title', text: '여기에 놓으면 작업 폴더로 열어요' }),
                h('div', { class: 'wl-drop-text', text: '폴더 하나를 끌어다 놓아 주세요' })));
    }

    App.bus.on('workspace:opened', () => {
        const host = welcomeEl();
        if (host) host.hidden = true;
        renderToken++;
    });
    App.bus.on('nav:changed', () => {
        if (App.state.workspace) document.title = workspaceTitle();
        saveViewSoon();
    });
    App.bus.on('selection:changed', saveViewSoon);
    App.bus.on('view:changed', ({ reason }) => {
        if (reason === 'sort' || reason === 'filter') saveViewSoon();
    });
    window.addEventListener('beforeunload', () => saveViewSoon.flush());
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') saveViewSoon.flush();
    });

    // =====================================================================================================
    // Drop a folder from Explorer to open it as the workspace
    // =====================================================================================================
    let dragTimer = null;

    function dragTypes(e) {
        const types = e.dataTransfer?.types;
        return types ? Array.from(types) : [];
    }

    function isExternalFileDrag(e) {
        const list = dragTypes(e);
        return list.includes('Files') && !list.includes('application/x-fi-paths');
    }

    // A link dropped on the page would navigate away from the app: swallow it (fields keep text drops)
    function isStrayLinkDrag(e) {
        const list = dragTypes(e);
        return list.includes('text/uri-list') && !list.includes('Files') && !list.includes('application/x-fi-paths') && !App.util.isTypingTarget(e.target);
    }

    document.addEventListener('dragover', (e) => {
        if (e.defaultPrevented || App.util.isTypingTarget(e.target)) return;
        if (isStrayLinkDrag(e)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'none';
            return;
        }
        if (!isExternalFileDrag(e)) return;
        // Accept the drop here so the browser never navigates away to the dropped file
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!App.fs.ready) {
            const host = welcomeEl();
            host?.classList.add('wl-dragging');
            clearTimeout(dragTimer);
            dragTimer = setTimeout(() => host?.classList.remove('wl-dragging'), 200);
        }
    });

    document.addEventListener('drop', (e) => {
        clearTimeout(dragTimer);
        welcomeEl()?.classList.remove('wl-dragging');
        if (e.defaultPrevented || App.util.isTypingTarget(e.target)) return;
        if (isStrayLinkDrag(e)) {
            e.preventDefault();
            return;
        }
        if (!isExternalFileDrag(e)) return;
        e.preventDefault();
        // Handles must be requested synchronously, while the drop event is still being dispatched
        const items = Array.from(e.dataTransfer.items || []).filter((i) => i.kind === 'file');
        const pending = items.map((i) => (typeof i.getAsFileSystemHandle === 'function' ? Promise.resolve(i.getAsFileSystemHandle()).catch(() => null) : Promise.resolve(null)));
        handleDrop(pending, items.length);
    });

    async function handleDrop(pending, count) {
        const handles = (await Promise.all(pending)).filter(Boolean);
        const dirs = handles.filter((x) => x.kind === 'directory');
        if (!dirs.length) {
            if (count) {
                ui.toast(App.fs.ready ? '사진·영상 파일은 가운데 목록에 끌어다 놓으면 지금 폴더로 가져와요' : '폴더를 끌어다 놓아 주세요 — 그 폴더가 작업 폴더가 돼요', { type: 'info' });
            }
            return;
        }
        const dir = dirs[0];
        if (dirs.length > 1) ui.toast(`폴더는 하나만 열 수 있어서 ‘${dir.name}’을(를) 열게요`, { type: 'info' });
        if (App.fs.ready) {
            if (await sameEntry(App.fs.backend?.root, dir)) {
                ui.toast('이미 열려 있는 작업 폴더예요', { type: 'info' });
                return;
            }
            const ok = await ui.confirm({ title: '작업 폴더 바꾸기', message: `‘${dir.name}’ 폴더를 작업 폴더로 열까요? 지금 보고 있는 ‘${App.state.workspace?.name}’은(는) 닫혀요.`, okLabel: '열기' });
            if (!ok) return;
        }
        await openDropped(dir);
    }

    async function openDropped(dir) {
        let perm = await permissionOf(dir);
        if (perm !== 'granted') {
            try {
                perm = await dir.requestPermission({ mode: 'readwrite' });
            } catch (e) {
                // The drop may not count as a user gesture: ask once more with a real click
                const ok = await ui.confirm({ title: '폴더 열기', message: `‘${dir.name}’ 폴더를 열려면 읽기·쓰기 권한이 필요해요. 다음 창에서 허락해 주세요.`, okLabel: '권한 허락하기' });
                if (!ok) return false;
                perm = await dir.requestPermission({ mode: 'readwrite' }).catch(() => 'denied');
            }
        }
        if (perm !== 'granted') {
            ui.toast('폴더 권한이 없어서 열 수 없어요', { type: 'error' });
            return false;
        }
        return openWith(dir, { restore: true });
    }

    // =====================================================================================================
    // Commands & lifecycle
    // =====================================================================================================
    App.commands.register({ id: 'workspace.open', title: '작업 폴더 열기', group: '파일', icon: 'folder-open', keys: 'Mod+O', scope: 'global', run: () => workspace.pick() });
    App.commands.register({ id: 'workspace.close', title: '작업 폴더 닫기', group: '파일', icon: 'x', when: () => App.fs.ready, run: () => workspace.close() });
    App.commands.register({
        id: 'workspace.reopen',
        title: '지난 작업 폴더 다시 열기',
        group: '파일',
        icon: 'history',
        when: () => !App.fs.ready && !!resume,
        run: () => workspace.reopenLast(),
    });

    App.register('workspace', {
        init() {
            renderWelcome('boot');
            App.bus.once('app:ready', () => {
                boot().catch((e) => {
                    console.error('[workspace] startup failed', e);
                    renderWelcome();
                });
            });
        },
    });

    /** Open a directory handle that came from a drag & drop (asks for permission with a click if needed). */
    workspace.openDropped = openDropped;
    /** Handle dropped FileSystemHandles like a drop on the window would (folder → open, files → hint). */
    workspace.handleDrop = (handles) => handleDrop(handles.map((x) => Promise.resolve(x)), handles.length);

    App.workspace = workspace;
})();
