/*
 * Current view state:
 *   App.nav    — current folder (App.state.cwd), back/forward/up history, (re)loading.
 *     openHooks: synchronous (entry) => ({ time } | null); first finite nonnegative time wins.
 *     open(entry) emits 'item:open' { path, time? }; failed hooks do not prevent opening.
 *   App.view   — entries of the current source (folder or search) -> filters -> sort -> visible list.
 *   App.select — selection of paths within the visible list (+ anchor/focus for keyboard & shift-click).
 *
 * Events: 'folder:loading' {path}, 'folder:loaded' {path, entries}, 'view:changed' {reason},
 *         'selection:changed' {paths, focus}
 */
(() => {
    'use strict';
    const { path: P, compareNames } = App.util;

    // ---------- View ----------
    const sortKeys = new Map();

    const view = {
        entries: [],
        visible: [],
        index: new Map(),
        source: { type: 'none', path: null, title: '' },
        sort: App.settings.get('view.sort', { key: 'name', dir: 'asc' }),
        filters: new Map(),

        /** registerSortKey('rating', '별점', (entry) => number|string) */
        registerSortKey(key, label, get) {
            sortKeys.set(key, { key, label, get });
        },

        sortKeys() {
            return [...sortKeys.values()];
        },

        /** info (optional) is merged into the 'view:changed' payload, e.g. { revalidated: true, diff } */
        setEntries(entries, source, info) {
            view.entries = entries;
            view.source = source;
            view.recompute('entries', info);
        },

        setSort(key, dir) {
            view.sort = { key, dir: dir || view.sort.dir };
            App.settings.set('view.sort', view.sort);
            view.recompute('sort');
        },

        /** filter: { label, test(entry) -> bool, includeDirs?: bool } or null to remove */
        setFilter(id, filter) {
            if (filter) view.filters.set(id, filter);
            else view.filters.delete(id);
            view.recompute('filter');
            App.bus.emit('view:filters');
        },

        clearFilters() {
            view.filters.clear();
            view.recompute('filter');
            App.bus.emit('view:filters');
        },

        recompute(reason = 'refresh', info = null) {
            let list = view.entries;
            for (const f of view.filters.values()) {
                list = list.filter((e) => (e.kind === 'dir' && !f.includeDirs ? true : f.test(e)));
            }
            const sk = sortKeys.get(view.sort.key) || sortKeys.get('name');
            const dir = view.sort.dir === 'desc' ? -1 : 1;
            list = [...list].sort((a, b) => {
                if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
                let c = 0;
                if (sk.key !== 'name') {
                    const va = sk.get(a);
                    const vb = sk.get(b);
                    c = typeof va === 'string' ? compareNames(va, vb) : (va || 0) - (vb || 0);
                }
                if (c === 0) c = compareNames(a.name, b.name);
                return c * dir;
            });
            view.visible = list;
            view.index = new Map(list.map((e, i) => [e.path, i]));
            App.select.prune();
            App.bus.emit('view:changed', info ? { ...info, reason } : { reason });
        },

        indexOf(p) {
            return view.index.has(p) ? view.index.get(p) : -1;
        },

        get(p) {
            const i = view.indexOf(p);
            return i >= 0 ? view.visible[i] : view.entries.find((e) => e.path === p) || null;
        },

        /** Merge fields into an entry (e.g. size after a write) and re-sort. */
        patch(p, fields) {
            const e = view.entries.find((x) => x.path === p);
            if (!e) return;
            Object.assign(e, fields);
            view.recompute('patch');
        },
    };

    view.registerSortKey('name', '이름', (e) => e.name);
    view.registerSortKey('mtime', '수정한 날짜', (e) => e.mtime || 0);
    view.registerSortKey('size', '크기', (e) => e.size || 0);
    view.registerSortKey('type', '종류', (e) => `${e.type}.${e.ext}`);
    view.registerSortKey('rating', '별점', (e) => App.catalog.peek(e.path)?.rating || 0);

    // ---------- Selection ----------
    const select = {
        paths: new Set(),
        anchor: null,
        focus: null,
        /** Last known visible index of the anchor — Shift-ranges still work after the anchor itself disappears */
        anchorIndex: -1,

        noteAnchor() {
            const i = view.indexOf(select.anchor);
            if (i >= 0) select.anchorIndex = i;
        },

        has(p) {
            return select.paths.has(p);
        },

        get count() {
            return select.paths.size;
        },

        /** Selected paths in visible order */
        list() {
            return view.visible.filter((e) => select.paths.has(e.path)).map((e) => e.path);
        },

        entries() {
            return view.visible.filter((e) => select.paths.has(e.path));
        },

        /** The single "active" item shown in the inspector (focus, else the only selected item) */
        primary() {
            if (select.focus && select.paths.has(select.focus)) return view.get(select.focus);
            if (select.paths.size === 1) return view.get([...select.paths][0]);
            return null;
        },

        set(paths, { focus, anchor } = {}) {
            select.paths = new Set(paths);
            select.focus = focus !== undefined ? focus : paths[paths.length - 1] || null;
            const nextAnchor = anchor !== undefined ? anchor : select.focus;
            if (nextAnchor !== select.anchor) select.anchorIndex = -1;
            select.anchor = nextAnchor;
            select.noteAnchor();
            select.emit();
        },

        toggle(p) {
            if (select.paths.has(p)) select.paths.delete(p);
            else select.paths.add(p);
            select.focus = p;
            select.anchor = p;
            select.noteAnchor();
            select.emit();
        },

        /**
         * Select from the anchor to p in visible order. additive keeps the existing selection (Ctrl+Shift).
         * When the anchor is gone (refreshed list, file moved away) the range starts at the focus, else the selected
         * item nearest to p, else the place where the anchor used to be — never a silent single select.
         */
        range(p, { additive = false } = {}) {
            const b = view.indexOf(p);
            if (b < 0) return select.set([p]);
            let a = view.indexOf(select.anchor);
            if (a < 0) a = view.indexOf(select.focus);
            if (a < 0 && select.paths.size) {
                let best = -1;
                for (const q of select.paths) {
                    const i = view.indexOf(q);
                    if (i >= 0 && (best < 0 || Math.abs(i - b) < Math.abs(best - b))) best = i;
                }
                a = best;
            }
            if (a < 0 && select.anchorIndex >= 0 && view.visible.length) a = Math.min(select.anchorIndex, view.visible.length - 1);
            if (a < 0) a = b;
            if (view.visible[a].path !== select.anchor) {
                select.anchor = view.visible[a].path;
                select.anchorIndex = a;
            }
            const [from, to] = a < b ? [a, b] : [b, a];
            const next = additive ? new Set(select.paths) : new Set();
            for (let i = from; i <= to; i++) next.add(view.visible[i].path);
            select.paths = next;
            select.focus = p;
            select.emit();
        },

        all() {
            select.set(view.visible.map((e) => e.path), { focus: select.focus, anchor: select.anchor });
        },

        clear() {
            if (!select.paths.size && !select.focus) return;
            select.paths = new Set();
            select.focus = null;
            select.anchor = null;
            select.anchorIndex = -1;
            select.emit();
        },

        // Drop selected paths that are no longer visible (after filter/reload). The anchor path is kept on purpose.
        prune() {
            select.noteAnchor();
            let changed = false;
            for (const p of [...select.paths]) {
                if (!view.index.has(p)) {
                    select.paths.delete(p);
                    changed = true;
                }
            }
            if (select.focus && !view.index.has(select.focus)) {
                select.focus = null;
                changed = true;
            }
            if (changed) select.emit();
        },

        emit() {
            App.bus.emit('selection:changed', { paths: [...select.paths], focus: select.focus });
        },
    };

    // ---------- Navigation ----------
    let loadToken = 0;
    let inflight = null; // { token, path, full, promise, again } — the running background re-check
    const RECHECK_MS = 30000;

    /** Source + load hooks (e.g. "include subfolders" swaps in a recursive list) for a raw folder listing */
    async function prepare(p, entries) {
        const title = p === '' ? App.state.workspace?.name || '' : P.base(p);
        const source = { type: 'folder', path: p, title, hiddenCount: entries.hiddenCount };
        for (const hook of nav.loadHooks) {
            try {
                const r = await hook(p, entries, source);
                if (r && r.entries) {
                    const sidecars = entries.sidecars;
                    entries = r.entries;
                    if (!entries.sidecars) entries.sidecars = sidecars;
                    Object.assign(source, r.source || {});
                }
            } catch (e) {
                console.error('[nav] load hook failed', e);
            }
        }
        return { entries, source };
    }

    /** Apply a fresh listing to the view if (and only if) something really changed. Keeps unchanged entry objects. */
    async function applyFresh(token, p, fresh) {
        const prep = await prepare(p, fresh);
        if (token !== loadToken || App.state.cwd !== p || view.source.type !== 'folder') return null;
        // An in-app change landed while we listed / ran the hooks: its own reload shows the truth, don't undo it
        if (fresh.gen != null && App.listCache.gen(p) !== fresh.gen) return null;
        // v1 memo sidecars added outside the app are imported even when no photo/video changed (idempotent)
        if (fresh.sidecars?.length) App.catalog.importLegacySidecars(fresh.sidecars);
        const d = App.listCache.diff(view.entries, prep.entries);
        const hiddenChanged = (view.source.hiddenCount || 0) !== (prep.source.hiddenCount || 0) || !!view.source.recursive !== !!prep.source.recursive;
        const result = { changed: d.count > 0, added: d.added, removed: d.removed, updated: d.updated };
        if (!d.count && !hiddenChanged) return result;
        const merged = prep.entries.map((e) => d.keep.get(e.path) || e);
        merged.hiddenCount = prep.entries.hiddenCount;
        merged.sidecars = prep.entries.sidecars;
        view.setEntries(merged, prep.source, d.count ? { revalidated: true, diff: { added: d.added, removed: d.removed, updated: d.updated } } : { revalidated: true });
        return result;
    }

    /** Background re-check of a folder that was shown from the cache. One at a time per folder; extra calls queue once. */
    function revalidate(token, p, { full = false } = {}) {
        if (inflight && inflight.path === p && inflight.token === token) {
            if (full && !inflight.full) inflight.again = true;
            return inflight.promise;
        }
        const job = { token, path: p, full, again: false };
        job.promise = (async () => {
            const total = { path: p, changed: false, added: 0, removed: 0, updated: 0 };
            App.bus.emit('folder:revalidating', { path: p });
            try {
                const LC = App.listCache;
                const passes = full ? ['full'] : ['names'];
                for (let i = 0; i < passes.length; i++) {
                    const fresh = await LC.list(p, { mode: passes[i] });
                    if (token !== loadToken || fresh.stale) break; // a newer load (e.g. after an in-app change) takes over
                    const r = await applyFresh(token, p, fresh);
                    if (!r) break;
                    if (r.changed) {
                        total.changed = true;
                        total.added += r.added;
                        total.removed += r.removed;
                        total.updated += r.updated;
                    }
                    // Names are checked on every open; sizes/dates only when they are older than the cache TTL
                    if (passes[i] === 'names' && (job.again || (await LC.needsFull(p)))) passes.push('full');
                }
            } catch (e) {
                if (token === loadToken && App.state.cwd === p) {
                    // Only call the folder gone when its parent still reads fine — an unplugged or sleeping drive
                    // fails everywhere, and then the cached listing stays (nothing is forgotten on a guess)
                    let up = null; // nearest ancestor that still reads
                    if ((e.code === 'ENOENT' || e.code === 'ENOTDIR') && p !== '') {
                        for (let d = P.parent(p); ; d = P.parent(d)) {
                            if (await App.fs.backend.list(d, { stat: false }).then(() => true, () => false)) {
                                up = d;
                                break;
                            }
                            if (d === '') break;
                        }
                    }
                    if (token !== loadToken || App.state.cwd !== p) {
                        /* moved on meanwhile */
                    } else if (up != null) {
                        const top = P.join(up, (up === '' ? p : p.slice(up.length + 1)).split('/')[0]); // the folder that vanished
                        await App.listCache.drop(top, { recursive: true });
                        App.ui.toast('폴더가 없어져서 상위 폴더로 이동했어요', { type: 'warning' });
                        nav.go(up, { push: false });
                    } else if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
                        App.ui.toast('폴더를 다시 확인하지 못했어요 · 저장해 둔 목록을 보여 드리고 있어요 (드라이브 연결을 확인해 주세요)', { type: 'warning', id: 'nav-recheck' });
                    } else {
                        // Keep showing the cached listing (drive asleep, permission prompt...); F5 tries again
                        console.warn('[nav] background re-check failed', e);
                    }
                }
            } finally {
                if (inflight === job) inflight = null;
                App.bus.emit('folder:revalidated', total);
            }
            return total;
        })();
        inflight = job;
        return job.promise;
    }

    const nav = {
        back: [],
        fwd: [],
        /** async (path, entries, source) => ({ entries, source })? — may replace a folder listing before it's shown */
        loadHooks: [],
        /** (entry) => ({ time } | null), in priority order; folders bypass these hooks */
        openHooks: [],

        get cwd() {
            return App.state.cwd;
        },

        canBack: () => nav.back.length > 0,
        canForward: () => nav.fwd.length > 0,
        canUp: () => App.state.cwd != null && App.state.cwd !== '',

        async go(p, { push = true, focus = null } = {}) {
            if (!App.fs.ready) return;
            if (p === App.state.cwd && view.source.type === 'folder') return nav.load({ focus });
            if (push && App.state.cwd != null && view.source.type === 'folder') {
                nav.back.push(App.state.cwd);
                if (nav.back.length > 200) nav.back.shift();
                nav.fwd = [];
            }
            App.setState({ cwd: p });
            select.clear();
            await nav.load({ focus });
            App.bus.emit('nav:changed');
        },

        /** { path, ms, cached } of the last folder shown (measurements, tests) */
        lastOpen: null,

        /**
         * Show the current folder (App.state.cwd). Stale-while-revalidate: a cached listing (App.listCache) is shown
         * at once ('folder:loaded' { cached: true }), then the folder is re-checked in the background and only real
         * differences are applied ('view:changed' { reason: 'entries', revalidated: true, diff }).
         * opts: { focus, keepSelection, full (re-check sizes/dates too), wait (resolve after the re-check) }
         */
        async load({ focus = null, keepSelection = false, full = false, wait = false, recheck = true } = {}) {
            const token = ++loadToken;
            const p = App.state.cwd;
            const t0 = performance.now();
            App.bus.emit('folder:loading', { path: p });
            const LC = App.listCache;
            let cached = null;
            if (LC?.enabled) {
                try {
                    cached = await LC.get(p);
                } catch (e) {
                    console.warn('[nav] listing cache unavailable', e);
                }
                if (token !== loadToken) return;
            }
            let entries = cached?.entries;
            if (!entries) {
                try {
                    entries = LC?.enabled ? await LC.list(p, { mode: 'full' }) : await App.fs.list(p);
                } catch (e) {
                    if (token !== loadToken) return;
                    if (e.code === 'ENOENT' && p !== '') {
                        App.ui.toast('폴더를 찾을 수 없어서 상위 폴더로 이동했어요', { type: 'warning' });
                        return nav.go(P.parent(p), { push: false });
                    }
                    console.error('[nav] list failed', e);
                    App.ui.toast(`폴더를 읽을 수 없어요: ${e.message}`, { type: 'error' });
                    return;
                }
                if (token !== loadToken) return; // superseded by a newer navigation
            }
            const prevSelection = keepSelection ? select.list() : [];
            const prep = await prepare(p, entries);
            if (token !== loadToken) return;
            view.setEntries(prep.entries, prep.source);
            if (keepSelection && prevSelection.length) select.set(prevSelection.filter((x) => view.index.has(x)), { focus: select.focus, anchor: select.anchor });
            if (focus && view.index.has(focus)) select.set([focus], { focus });
            nav.lastOpen = { path: p, ms: Math.round(performance.now() - t0), cached: !!cached };
            App.bus.emit('folder:loaded', { path: p, entries, cached: !!cached });
            if (entries.sidecars?.length) App.catalog.importLegacySidecars(entries.sidecars);
            // recheck: 'stale' = only when the last real check is older than RECHECK_MS (reloads after in-app changes)
            if (cached && (recheck === true || full || Date.now() - (cached.checkedAt || 0) > RECHECK_MS)) {
                const rv = revalidate(token, p, { full });
                if (wait) await rv;
            }
        },

        /**
         * Re-check the current folder now (names first; sizes/dates too with full) and apply only the differences.
         * Resolves with { changed, added, removed, updated } (null when nothing to check).
         */
        revalidate({ full = false } = {}) {
            if (view.source.type !== 'folder' || !App.listCache?.enabled || App.state.cwd == null) return Promise.resolve(null);
            return revalidate(loadToken, App.state.cwd, { full });
        },

        /** Resolves once the running background re-check (if any) is done */
        whenFresh() {
            return inflight ? inflight.promise.then(() => nav.whenFresh()) : Promise.resolve();
        },

        get revalidating() {
            return !!inflight;
        },

        /** F5: show what we have, re-check everything (names, sizes, dates) and resolve when the list is current */
        reload() {
            if (view.source.type === 'folder') return nav.load({ keepSelection: true, full: true, wait: true });
            App.bus.emit('view:reload-request');
        },

        goBack() {
            if (!nav.back.length) return;
            nav.fwd.push(App.state.cwd);
            return nav.go(nav.back.pop(), { push: false });
        },

        goForward() {
            if (!nav.fwd.length) return;
            nav.back.push(App.state.cwd);
            return nav.go(nav.fwd.pop(), { push: false });
        },

        /** Jump several steps through history: negative = back, positive = forward */
        jump(delta) {
            if (!delta) return;
            const steps = Math.min(Math.abs(delta), delta < 0 ? nav.back.length : nav.fwd.length);
            if (!steps) return;
            let target = App.state.cwd;
            for (let i = 0; i < steps; i++) {
                if (delta < 0) {
                    nav.fwd.push(target);
                    target = nav.back.pop();
                } else {
                    nav.back.push(target);
                    target = nav.fwd.pop();
                }
            }
            return nav.go(target, { push: false });
        },

        goUp() {
            if (!nav.canUp()) return;
            const child = App.state.cwd;
            return nav.go(P.parent(child), { focus: child });
        },

        goHome() {
            return nav.go('');
        },

        /** Open an entry: folders navigate, files go to the viewer */
        open(entry) {
            if (!entry) return;
            if (entry.kind === 'dir') return nav.go(entry.path);
            const payload = { path: entry.path };
            for (const hook of nav.openHooks) {
                try {
                    const result = hook(entry);
                    if (result && Number.isFinite(result.time) && result.time >= 0) {
                        payload.time = result.time;
                        break;
                    }
                } catch (e) {
                    console.error('[nav] open hook failed', e);
                }
            }
            App.bus.emit('item:open', payload);
        },
    };

    // Keep cwd/history/selection valid when things move underneath us.
    // In-app changes already patched the cached listing, so this reload is instant (re-checked only if not recent)
    const reloadSoon = App.util.debounce(() => nav.load({ keepSelection: true, recheck: 'stale' }), 120);

    App.bus.on('fs:changed', (change) => {
        const cwd = App.state.cwd;
        if (cwd == null) return;

        if (change.from && change.to) {
            for (let i = 0; i < change.from.length; i++) {
                const rebased = P.rebase(cwd, change.from[i], change.to[i]);
                if (rebased != null && rebased !== cwd) {
                    nav.back = nav.back.map((h) => P.rebase(h, change.from[i], change.to[i]) ?? h);
                    nav.fwd = nav.fwd.map((h) => P.rebase(h, change.from[i], change.to[i]) ?? h);
                    App.setState({ cwd: rebased });
                    nav.load({ keepSelection: true });
                    App.bus.emit('nav:changed');
                    return;
                }
            }
            // Keep renamed/moved items selected under their new path (anchor and focus follow too)
            if (view.source.type === 'folder' && change.type !== 'copy') {
                const map = new Map(change.from.map((f, i) => [f, change.to[i]]));
                const moved = [...select.paths].filter((p) => map.has(p));
                if (moved.length) select.paths = new Set([...select.paths].map((p) => map.get(p) ?? p));
                if (select.focus && map.has(select.focus)) select.focus = map.get(select.focus);
                if (select.anchor && map.has(select.anchor)) select.anchor = map.get(select.anchor);
            }
        }

        if ((change.type === 'trash' || change.type === 'delete') && change.paths.some((p) => P.isInside(cwd, p) && p !== '')) {
            let up = cwd;
            while (up && change.paths.some((p) => P.isInside(up, p))) up = P.parent(up);
            nav.go(up, { push: false });
            return;
        }

        if (view.source.type === 'folder' && change.dirs.includes(cwd)) reloadSoon();
    });

    // A file from a cached listing turned out to be gone (deleted in Explorer): re-check those folders right away.
    // Nothing is dropped on a guess — only what the re-check really doesn't find (an unplugged drive keeps everything).
    const missing = { paths: new Set(), dirs: new Set(), loud: false };
    const settleMissing = App.util.debounce(async () => {
        const paths = [...missing.paths];
        const dirs = [...missing.dirs];
        const loud = missing.loud;
        missing.paths.clear();
        missing.dirs.clear();
        missing.loud = false;
        const LC = App.listCache;
        if (!LC?.enabled) return;
        const cwd = App.state.cwd;
        const showing = view.source.type === 'folder' && paths.some((p) => view.index.has(p));
        for (const d of dirs) {
            if (d === cwd && view.source.type === 'folder') continue;
            try {
                await LC.list(d, { mode: 'auto' }); // updates the cache and App.index (search / recursive views)
            } catch (e) {
                // Unreadable folder: keep its cache (a sleeping drive looks the same); opening it re-checks properly
            }
        }
        if (showing || dirs.includes(cwd)) {
            await nav.revalidate();
            await nav.whenFresh();
        }
        const stillShown = paths.filter((p) => view.index.has(p));
        const dropped = paths.length - stillShown.length;
        if (loud && dropped > 0 && showing) {
            App.ui.toast(dropped === 1 ? '이 파일은 이미 없어졌어요 · 목록을 새로 고쳤어요' : `${App.util.formatCount(dropped)}개 파일이 이미 없어졌어요 · 목록을 새로 고쳤어요`, { type: 'warning', id: 'fs-missing' });
        }
    }, 150);

    App.bus.on('fs:missing', ({ paths, dirs, silent }) => {
        for (const p of paths) missing.paths.add(p);
        for (const d of dirs) missing.dirs.add(d);
        if (!silent) missing.loud = true;
        settleMissing();
    });

    // Coming back from Explorer (window focus / tab visible again): re-check the folder on screen
    let awayAt = 0;
    const back = () => {
        if (!awayAt || Date.now() - awayAt < 1500) return;
        awayAt = 0;
        if (App.fs.ready && App.layers?.top?.() !== 'dialog') nav.revalidate();
    };
    window.addEventListener('blur', () => (awayAt = Date.now()));
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) awayAt = awayAt || Date.now();
        else back();
    });

    // Commands
    App.commands.register({ id: 'nav.back', title: '뒤로', group: '이동', icon: 'arrow-left', keys: ['Alt+ArrowLeft'], allowInInput: true, when: nav.canBack, run: () => nav.goBack() });
    App.commands.register({ id: 'nav.forward', title: '앞으로', group: '이동', icon: 'arrow-right', keys: ['Alt+ArrowRight'], allowInInput: true, when: nav.canForward, run: () => nav.goForward() });
    App.commands.register({ id: 'nav.up', title: '상위 폴더로', group: '이동', icon: 'corner-up', keys: ['Alt+ArrowUp', 'Backspace'], allowInInput: ['Alt+ArrowUp'], when: nav.canUp, run: () => nav.goUp() });
    App.commands.register({ id: 'nav.home', title: '작업 폴더 처음으로', group: '이동', icon: 'home', keys: ['Alt+Home'], when: () => App.fs.ready, run: () => nav.goHome() });
    App.commands.register({ id: 'nav.reload', title: '새로 고침', group: '이동', icon: 'refresh', keys: ['F5'], when: () => App.fs.ready, run: () => nav.reload() });

    // Mouse side buttons
    window.addEventListener('mouseup', (e) => {
        if (App.layers.top() !== 'main') return;
        if (e.button === 3) {
            e.preventDefault();
            App.commands.run('nav.back');
        } else if (e.button === 4) {
            e.preventDefault();
            App.commands.run('nav.forward');
        }
    });

    App.nav = nav;
    App.view = view;
    App.select = select;
})();
