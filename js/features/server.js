/*
 * Local server integration (App.server) — detection, connection status, workspace opening through the server,
 * API wrappers for the heavy features, and the UI around them (status item, setup sheet, chooser, badges).
 *
 * Modes: 'served' (page loaded from the server: <meta name="fi-server">), 'file' (opened from disk), 'web' (any other http
 * origin, e.g. tests). Override the probed port with ?fiServerPort=<n>.
 * State: 'idle' | 'connecting' | 'connected' | 'offline' | 'detected' (file/web: a server answers) | 'none'.
 * Events: 'server:status' {state}, 'server:online' {online}, 'server:session' (session).
 *
 * Public API — other modules call these (check App.server?.available / App.server?.backend first):
 *   App.server.mode / url / state / info / available / capabilities / backend (App.fs.backend when kind==='server')
 *   App.server.connect()
 *   App.server.request(method, path, body, opts)                 JSON call with the open workspace's token
 *   App.server.job(id) / waitJob(jobOrId, {title, onProgress(p0to1, message, job), cancellable}) → result (mirrors into App.jobs)
 *   App.server.cancelJob(id) / canUse(cap) / canStream() / streamUrl(path, start) / thumbUrl(entry, size)
 *   App.server.video.trim(path, start, end, {mode:'fast'|'accurate', notify})   → new path (undo moves it to the trash)
 *   App.server.video.concat([{path, start, end}], {output, notify})            → new path
 *   App.server.video.transform(path, 'rotate90'|'rotate180'|'rotate270'|'hflip'|'vflip', {mode:'metadata'|'reencode', inPlace, notify})
 *   App.server.video.frame(path, seconds, {format:'jpg'|'png', notify})        → new image path
 *     (raw style: video.trim({path, start, end, mode}) etc. just POST and return the job — caller waits/undoes/toasts)
 *   App.server.dupes.scan({dirs, mode:'exact'|'similar'|'both', threshold, videos}, {onProgress, title}) → {groups, stats}  (v1)
 *   App.server.dupes (v2, docs/server-api.md "Duplicates v2"; check App.server.supports('dupes-v2')):
 *     fingerprint({dirs, roots, kinds, workers}, jobOpts) / scanV2({dirs, roots, compare, kinds, rules, exclude}, jobOpts)
 *     start(endpoint, body) → raw job · frameUrl(path, t, {w, v}) · quarantine(paths, {keep, reason, undoable}) (one undo step)
 *     restore(ids) · quarantined() · roots() · pickRoot({initialDir}) · forgetRoot(root) · isExternal(path)
 *   App.server.waitJob(job, {pausable, background, kind}) — pausing the status-bar job pauses the server job
 *   App.server.API_VERSION / apiVersion / outdated / supports(feature) / restart() / handoffUrl()
 *   App.server.thumbs.pregenerate({dirs, size}, {onProgress, title}) → {made, cached, failed, total}
 *   App.server.media.probe(path) / streamUrl(path, start) / thumbUrl(entry, size)
 *   App.server.reveal(path) / openDefault(path) / copyPath(paths)
 *   App.server.canDisplay(entryOrName)    browser can decode it, or the connected server can render/stream it
 *   App.server.openRoot(root) / pickWorkspace() / recents()
 *   App.server.showSetup()                '로컬 서버 켜기' sheet — call it from any disabled "needs the server" state
 *   App.server.showStatus()
 * Opt-outs for teams that integrate natively: App.thumbs.backendAware, App.viewer.serverAware, App.workspace.serverAware.
 */
(() => {
    'use strict';
    const { h, path: P } = App.util;
    const ui = App.ui;
    const api = App.ServerBackend.api;
    const DAY = 24 * 60 * 60 * 1000;
    // The server endpoints this app needs (docs/server-api.md "apiVersion"). An older server process → "다시 켜기".
    const API_VERSION = 2;
    const HANDOFF_KEY = 'fi-handoff';
    const HANDOFF_MAX_AGE = 10 * 60 * 1000;

    // ---------- Mode / state ----------
    const meta = document.querySelector('meta[name="fi-server"]');
    const portOverride = new URLSearchParams(location.search).get('fiServerPort');
    const mode = meta ? 'served' : location.protocol === 'file:' ? 'file' : 'web';
    const port = (() => {
        const n = Number(portOverride || meta?.dataset.port || 8765);
        return Number.isInteger(n) && n > 0 && n < 65536 ? n : 8765;
    })();
    const serverUrl = mode === 'served' ? location.origin + '/' : `http://127.0.0.1:${port}/`;
    const probesNetwork = mode === 'file' || (mode === 'web' && !!portOverride);

    // ---------- file:// → server handoff (docs/server-api.md) ----------
    // The page opened from disk and the server address are different origins with separate storage. The one-click switch
    // carries the settings and the open folder once, in the URL fragment (never sent to the server).
    const b64url = {
        encode(text) {
            const bytes = new TextEncoder().encode(text);
            let bin = '';
            for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        },
        decode(value) {
            const bin = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
            return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
        },
    };

    function handoffUrl() {
        const settings = {};
        for (const [key, value] of Object.entries(App.settings.all?.() || {})) if (!key.startsWith('server.')) settings[key] = value;
        const ws = App.state.workspace;
        const payload = { v: 1, at: Date.now(), settings, workspace: ws ? { id: ws.id, name: ws.name } : null, cwd: ws ? App.state.cwd || '' : '' };
        return `${serverUrl}#${HANDOFF_KEY}=${b64url.encode(JSON.stringify(payload))}`;
    }

    // Read once, as early as possible (before other modules init), so they start with the carried settings.
    const handoff = (() => {
        if (mode !== 'served') return null;
        const match = location.hash.match(new RegExp(`[#&]${HANDOFF_KEY}=([A-Za-z0-9_-]+)`));
        if (!match) return null;
        try {
            history.replaceState(history.state, '', location.pathname + location.search);
        } catch (e) {
            /* keep going: the fragment is harmless */
        }
        try {
            const data = JSON.parse(b64url.decode(match[1]));
            if (!data || data.v !== 1 || !(Math.abs(Date.now() - Number(data.at)) < HANDOFF_MAX_AGE)) return null;
            if (data.settings && typeof data.settings === 'object') {
                for (const [key, value] of Object.entries(data.settings)) if (!key.startsWith('server.')) App.settings.set(key, value);
            }
            return data;
        } catch (e) {
            return null;
        }
    })();

    let state = 'idle';
    let info = null; // /api/session (served) or /api/health (file/web)
    let connecting = null;
    let lastProbe = 0;
    let recoveryTimer = null;
    let recovering = false;
    let offlineToast = null;
    let statusEl = null;
    let statusPop = null;
    let setupOpen = null;
    let chooserOpen = null;
    let browserPick = null;
    let disposed = false; // page is unloading
    let stoppedByUser = false; // '서버 끄기' was used: no warning toast, but reconnect when it comes back
    let recoveryDelay = 3000;

    // Only a real ServerBackend counts (tests and other modules may plug in look-alike backends)
    const backend = () => {
        const b = App.fs.backend;
        return b?.kind === 'server' && typeof b.canThumb === 'function' && typeof b.probe === 'function' ? b : null;
    };
    const failure = (code, message) => Object.assign(new Error(message), { code });
    const reportError = (err) => {
        if (err?.code !== 'ECANCELED') ui.toast(err?.message || '작업을 마치지 못했어요', { type: 'error' });
    };

    function setState(next) {
        if (state === next) return;
        state = next;
        renderStatus();
        App.bus.emit('server:status', { state });
        App.gallery?.refresh?.(); // '서버' badges depend on the state
    }

    function requireBackend() {
        const active = backend();
        if (!active) throw failure('ENOWS', '로컬 서버로 작업 폴더를 열면 쓸 수 있어요');
        return active;
    }

    async function health() {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1500);
        try {
            const res = await fetch(serverUrl + 'api/health', { mode: 'cors', credentials: 'omit', cache: 'no-store', signal: controller.signal });
            if (!res.ok) return null;
            const data = await res.json();
            return data?.app === 'fluid-identity' ? data : null;
        } catch (e) {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    /** Switch this page to the server address in one click, keeping the open folder and the settings (file/web mode). */
    async function openServerUrl() {
        await App.catalog?.flush?.();
        location.href = mode === 'served' ? serverUrl : handoffUrl();
    }

    const apiVersionOf = (data) => (Number.isInteger(data?.apiVersion) ? data.apiVersion : 1); // round-1 servers had none
    const outdated = () => !!info && (state === 'connected' || state === 'detected') && apiVersionOf(info) < API_VERSION;
    let outdatedToast = null;

    function noticeOutdated() {
        if (!outdated() || outdatedToast || mode !== 'served') return;
        outdatedToast = ui.toast('서버를 새 버전으로 다시 켜 주세요', {
            id: 'srv-outdated',
            type: 'warning',
            duration: 0,
            action: { label: '다시 켜기', run: () => App.commands.run('server.restart') },
        });
    }

    function connect() {
        if (connecting) return connecting;
        connecting = (async () => {
            if (mode === 'served') {
                setState('connecting');
                try {
                    info = await api.ensureSession(true);
                    setState('connected');
                    renderStatus();
                    noticeOutdated();
                    return info;
                } catch (err) {
                    goOffline();
                    throw err;
                }
            }
            if (!probesNetwork) {
                setState('none');
                return null;
            }
            lastProbe = Date.now();
            info = await health();
            setState(info ? 'detected' : 'none');
            if (info && Date.now() - App.settings.get('server.hintAt', 0) > DAY) {
                App.settings.set('server.hintAt', Date.now());
                ui.toast('로컬 서버가 켜져 있어요. 서버로 열면 HEIC·AVI 미리보기와 영상 편집을 쓸 수 있어요', {
                    type: 'info',
                    duration: 9000,
                    action: { label: '서버로 열기', run: () => App.commands.run('server.open') },
                });
            }
            return info;
        })().finally(() => {
            connecting = null;
        });
        return connecting;
    }

    // ---------- Offline / recovery (served mode) ----------
    function goOffline() {
        if (mode !== 'served' || disposed || state === 'offline') return;
        setState('offline');
        if (stoppedByUser) return scheduleRecovery();
        offlineToast = ui.toast("로컬 서버와 연결이 끊겼어요. 바탕화면의 '사진영상정리기' 아이콘으로 다시 켤 수 있어요", {
            id: 'srv-offline',
            type: 'warning',
            duration: 0,
            action: { label: '다시 연결', run: () => recover() },
        });
        scheduleRecovery();
    }

    function scheduleRecovery() {
        clearTimeout(recoveryTimer);
        if (disposed || state !== 'offline') return;
        recoveryTimer = setTimeout(recover, recoveryDelay);
        recoveryDelay = Math.min(15000, Math.round(recoveryDelay * 1.5));
    }

    async function recover() {
        clearTimeout(recoveryTimer);
        if (recovering || disposed) return;
        recovering = true;
        try {
            if (!(await health())) return;
            info = await api.ensureSession(true);
            const active = backend();
            if (active) {
                await active.reopen();
                await App.nav?.reload?.();
            }
            setState('connected');
            renderStatus();
            recoveryDelay = 3000;
            stoppedByUser = false;
            offlineToast?.close();
            offlineToast = null;
            ui.toast('로컬 서버에 다시 연결했어요', { type: 'success' });
            noticeOutdated();
        } catch (e) {
            /* still down — try again shortly */
        } finally {
            recovering = false;
            scheduleRecovery();
        }
    }

    // ---------- Requests & jobs ----------
    function request(method, path, body, opts = {}) {
        const active = backend();
        return api.request(method, path, {
            ...opts,
            body,
            query: { ...(active ? { ws: active.token } : null), ...opts.query },
            onNoWorkspace: active ? () => active.reopen() : undefined,
        });
    }

    const job = (id) => request('GET', `/api/jobs/${encodeURIComponent(id)}`);

    /**
     * Poll a server job until it ends, mirroring progress into App.jobs (status bar). Resolves with job.result,
     * rejects with code ECANCELED on cancel. opts: { title, onProgress(progress0to1, message, job), cancellable }
     * (a function as the second argument is taken as onProgress).
     */
    async function waitJob(jobOrId, opts = {}) {
        if (typeof opts === 'function') opts = { onProgress: opts };
        const { title = '로컬 서버 작업', onProgress, cancellable = true, pausable = false, background = false, kind = null } = opts;
        let current = typeof jobOrId === 'string' ? { id: jobOrId, state: 'running', progress: 0 } : jobOrId;
        if (!current?.id) throw failure('EINVAL', '작업을 찾을 수 없어요');
        const id = encodeURIComponent(current.id);
        // Pausing the status-bar job pauses the server job (it stops at its next check point)
        const local = App.jobs.start({
            title,
            total: 100,
            cancellable,
            background,
            kind,
            pausable,
            onPause: () => request('POST', `/api/jobs/${id}/pause`, {}).catch(reportError),
            onResume: () => request('POST', `/api/jobs/${id}/resume`, {}).catch(reportError),
        });
        let cancelled = false;
        local.onCancel(() => {
            cancelled = true;
            request('POST', `/api/jobs/${id}/cancel`).catch(() => {});
        });
        let wait = 200;
        try {
            for (;;) {
                if (cancelled || current.state === 'cancelled') throw failure('ECANCELED', '작업을 취소했어요');
                local.update(Math.round((current.progress || 0) * 100), { detail: current.message || '' });
                onProgress?.(current.progress || 0, current.message || '', current);
                if (current.state === 'done') {
                    local.finish();
                    return current.result;
                }
                if (current.state === 'error') throw failure(current.error?.code || 'ESERVER', current.error?.message || '로컬 서버 작업이 실패했어요');
                await App.util.sleep(wait);
                wait = Math.min(800, Math.round(wait * 1.25));
                if (cancelled) throw failure('ECANCELED', '작업을 취소했어요');
                current = await job(current.id);
            }
        } catch (err) {
            if (local.state === 'running' || local.state === 'paused') {
                if (err.code === 'ECANCELED') local.finish();
                else local.fail(err);
            }
            throw err;
        }
    }

    async function runJob(path, body, title, opts = {}) {
        requireBackend();
        return waitJob(await request('POST', path, body), { title, ...opts });
    }

    // ---------- Video tools ----------
    // Outputs behave like any other file operation: the gallery/index learn about them and one undo step moves them
    // to the app trash (redo restores them).
    function announce(path) {
        App.fs.emitChange({ type: 'create', paths: [path], dirs: [P.parent(path)] });
    }

    function pushOutputUndo(label, path, active) {
        let current = path;
        let ids = [];
        App.undo.push({
            label,
            undo: async () => {
                if (backend() !== active) throw failure('EINVAL', '다른 작업 폴더라서 되돌릴 수 없어요');
                ids = await App.fs.trash([current], { undoable: false, silent: true });
            },
            redo: async () => {
                if (backend() !== active) throw failure('EINVAL', '다른 작업 폴더라서 다시 할 수 없어요');
                current = (await App.fs.restore(ids))[0] || current;
            },
        });
    }

    // Replace `original` with `output` keeping the original name and its catalog data (chips, rating, memo).
    // The original goes to the app trash, so undo is always possible.
    async function replaceOriginal(original, output, label, active) {
        const saved = App.catalog.peek(original);
        const stillHere = () => {
            if (backend() !== active) throw failure('EINVAL', '작업 폴더가 바뀌어서 원본 바꾸기를 멈췄어요. 새 파일은 원래 폴더에 그대로 있어요');
        };
        let originalIds = await App.fs.trash([original], { undoable: false, silent: true });
        let replaced;
        try {
            stillHere();
            replaced = await App.fs.rename(output, P.base(original), { undoable: false });
        } catch (err) {
            if (backend() === active) await App.fs.restore(originalIds);
            throw err;
        }
        if (saved) {
            const { meta: _ignored, ...userData } = saved;
            App.catalog.update(replaced, userData, { undoable: false }); // part of this single undo step
        }
        let newIds = [];
        App.undo.push({
            label,
            undo: async () => {
                if (backend() !== active) throw failure('EINVAL', '다른 작업 폴더라서 되돌릴 수 없어요');
                newIds = await App.fs.trash([replaced], { undoable: false, silent: true });
                await App.fs.restore(originalIds);
            },
            redo: async () => {
                if (backend() !== active) throw failure('EINVAL', '다른 작업 폴더라서 다시 할 수 없어요');
                originalIds = await App.fs.trash([original], { undoable: false, silent: true });
                replaced = (await App.fs.restore(newIds))[0] || replaced;
            },
        });
        return replaced;
    }

    async function videoTool(endpoint, body, { busy, label, done, notify = true, sync = false, inPlaceOf = null }) {
        const active = requireBackend();
        const response = await request('POST', `/api/video/${endpoint}`, body);
        const result = sync ? response : await waitJob(response, { title: busy });
        if (!result?.path) throw failure('ESERVER', '만든 파일을 찾을 수 없어요');
        if (backend() !== active) return result.path; // workspace switched meanwhile — the file is saved, nothing to refresh
        announce(result.path);
        let path = result.path;
        if (inPlaceOf) path = await replaceOriginal(inPlaceOf, result.path, label, active);
        else pushOutputUndo(label, path, active);
        if (notify) {
            ui.toast(done, {
                type: 'success',
                action: { label: '보기', run: () => App.nav.go(P.parent(path), { focus: path }) },
            });
        }
        return path;
    }

    // Two calling styles:
    //   managed  — video.trim('a.mp4', 1, 5, {mode}) waits, refreshes the gallery, pushes one undo step and toasts → new path
    //   raw      — video.trim({path, start, end, mode, ...}) only POSTs and returns the job (or the frame result);
    //              the caller polls with waitJob(job.id, onProgress) and owns undo/toasts (the viewer's editor does this)
    const raw = (endpoint) => (payload) => request('POST', `/api/video/${endpoint}`, payload);
    const isPayload = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

    const video = {
        trim: (path, start, end, { mode: cut = 'fast', notify } = {}) =>
            isPayload(path) ? raw('trim')(path)
                : videoTool('trim', { path, start, end, mode: cut }, { busy: '영상 자르는 중', label: '영상 자르기', done: '잘라낸 영상을 만들었어요', notify }),
        concat: (segments, { output, notify } = {}) =>
            isPayload(segments) ? raw('concat')(segments)
                : videoTool('concat', { segments, output }, { busy: '영상 합치는 중', label: '영상 합치기', done: '영상을 하나로 합쳤어요', notify }),
        transform: (path, op, { mode: how = 'metadata', inPlace = false, notify } = {}) =>
            isPayload(path) ? raw('transform')(path)
                : videoTool('transform', { path, op, mode: how }, {
                    busy: op.startsWith('rotate') ? '영상 회전하는 중' : '영상 뒤집는 중',
                    label: op.startsWith('rotate') ? '영상 회전' : '영상 뒤집기',
                    done: inPlace ? '영상을 바꿨어요' : '바꾼 영상을 새 파일로 만들었어요',
                    notify,
                    inPlaceOf: inPlace ? path : null,
                }),
        frame: (path, time, { format = 'jpg', notify } = {}) =>
            isPayload(path) ? raw('frame')(path)
                : videoTool('frame', { path, time, format }, { label: '장면 저장', done: '장면을 사진으로 저장했어요', notify, sync: true }),
    };

    // ---------- Duplicates v2 (docs/server-api.md "Duplicates v2"; the dupes team builds the UI) ----------
    // Refs: workspace files are workspace-relative paths, files in external roots (D:\VideoDownloader…) absolute paths.
    const isExternal = (p) => typeof p === 'string' && /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(p);
    const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

    async function quarantine(paths, { keep, reason, undoable = true } = {}) {
        const all = Array.isArray(paths) ? paths : [paths];
        const list = all.filter(isExternal);
        // Workspace files go to the app trash (App.fs.trash) — report them instead of dropping them silently
        const refused = all.filter((p) => !isExternal(p)).map((p) => ({ path: p, code: 'EINVAL', message: '작업 폴더 안 파일은 앱 휴지통으로 보내 주세요' }));
        if (!list.length) return { moved: [], failed: refused };
        const result = await request('POST', '/api/dupes/quarantine', compact({ paths: list, keep, reason }));
        result.failed = [...(result.failed || []), ...refused];
        if (undoable && result.moved?.length) {
            let ids = result.moved.map((m) => m.id);
            // Redo moves exactly the files undo brought back — restore may have used 'name (복원).ext' because
            // another file took the original name meanwhile; that other file must never be touched.
            let current = result.moved.map((m) => m.path);
            App.undo.push({
                label: `중복 파일 ${App.util.formatCount(current.length)}개 정리`,
                undo: async () => {
                    const r = await restore(ids);
                    current = (r.restored || []).map((x) => x.path);
                    ids = [];
                    if (r.failed?.length) throw failure(r.failed[0].code, r.failed[0].message);
                },
                redo: async () => {
                    if (!current.length) return;
                    const r = await request('POST', '/api/dupes/quarantine', compact({ paths: current, keep, reason }));
                    ids = (r.moved || []).map((m) => m.id);
                    current = (r.moved || []).map((m) => m.path);
                    if (r.failed?.length) throw failure(r.failed[0].code, r.failed[0].message);
                },
            });
        }
        return result;
    }

    const restore = (ids) => request('POST', '/api/dupes/restore', { ids: Array.isArray(ids) ? ids : [ids] });

    function frameUrl(path, t = 0, { w = 160, v } = {}) {
        const active = backend();
        if (!active || typeof path !== 'string') return null;
        const seconds = Number.isFinite(Number(t)) ? Math.max(0, Math.round(Number(t) * 1000) / 1000) : 0;
        return api.url('/api/dupes/frame', { path, t: seconds, w: Math.round(w), v: v ?? null, ws: active.token });
    }

    const dupes = {
        /** v1 (round 1): whole-workspace scan → {groups: [{kind, items}], stats}. */
        scan: ({ dirs, mode: how = 'both', threshold = 10, videos = true } = {}, opts = {}) =>
            runJob('/api/dupes/scan', { dirs, mode: how, threshold, videos }, '중복 파일 찾는 중', opts),
        /** Pre-make fingerprints (incremental) → {files, computed, cached, failed, errors, elapsed}. Pausable. */
        fingerprint: ({ dirs, roots, kinds, workers } = {}, opts = {}) =>
            runJob('/api/dupes/fingerprint', compact({ dirs, roots, kinds, workers }), '중복 검사 준비 (지문 만들기)', { pausable: true, kind: 'dupes', ...opts }),
        /** Scan v2 → {groups, stats}. */
        scanV2: ({ dirs, roots, compare, kinds, rules, exclude } = {}, opts = {}) =>
            runJob('/api/dupes/scan', compact({ v: 2, dirs, roots, compare, kinds, rules, exclude }), '중복 찾는 중', { pausable: true, kind: 'dupes', ...opts }),
        /** Raw job for callers that poll themselves: start('/api/dupes/fingerprint' | '/api/dupes/scan', body). */
        start: (endpoint, body) => {
            requireBackend();
            return request('POST', endpoint, endpoint === '/api/dupes/scan' ? { v: 2, ...body } : body);
        },
        frameUrl,
        /** {kind, size, mtime} of a file under a picked external root; rejects with code ENOENT (404) when it's gone. */
        stat: (path) => request('GET', '/api/dupes/stat', null, { query: { path } }),
        /** Playable URL (Range) for a file under a picked external root — review players. */
        mediaUrl: (path) => {
            const active = backend();
            return active && typeof path === 'string' ? api.url('/api/dupes/media', { path, ws: active.token }) : null;
        },
        quarantine,
        restore,
        quarantined: async () => (await request('GET', '/api/dupes/quarantine'))?.items || [],
        roots: async () => (await request('GET', '/api/dupes/roots'))?.roots || [],
        pickRoot: async ({ initialDir } = {}) => {
            const r = await request('POST', '/api/dupes/roots/pick', compact({ initialDir }));
            return r?.root ? r : null;
        },
        forgetRoot: (root) => request('POST', '/api/dupes/roots/forget', { root }),
        isExternal,
    };

    // ---------- Paths & clipboard ----------
    function absolutePath(root, rel) {
        const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(root);
        const sep = windows ? '\\' : '/';
        const base = root.replace(/[\\/]+$/, '');
        return rel ? base + sep + rel.split('/').join(sep) : base || sep;
    }

    /** 'C:\Users\me\Pictures\2024\Trip' -> 'C:\…\2024\Trip' when long: keeps the drive and the folders that matter. */
    function shortPath(full, max = 46) {
        if (!full || full.length <= max) return full || '';
        const sep = full.includes('\\') ? '\\' : '/';
        const parts = full.split(sep);
        const head = parts[0] || sep;
        let tail = parts[parts.length - 1];
        for (let i = parts.length - 2; i > 0; i--) {
            const next = parts[i] + sep + tail;
            if (head.length + next.length + 3 > max) break;
            tail = next;
        }
        return `${head}${sep}…${sep}${tail}`;
    }

    async function copyText(text, message = '경로를 복사했어요') {
        try {
            await navigator.clipboard.writeText(text);
        } catch (e) {
            const field = h('textarea', { class: 'srv-clipboard', 'aria-hidden': 'true' });
            field.value = text;
            document.body.append(field);
            field.select();
            const ok = document.execCommand('copy');
            field.remove();
            if (!ok) throw failure('EINVAL', '클립보드에 복사하지 못했어요');
        }
        ui.toast(message, { type: 'success', duration: 2200 });
    }

    function targetPaths() {
        const list = App.select.list();
        return list.length ? list : [App.state.cwd || ''];
    }

    function primaryTarget() {
        return App.select.primary()?.path ?? App.select.list()[0] ?? App.state.cwd ?? '';
    }

    function copyPath(paths = targetPaths()) {
        const active = requireBackend();
        const list = Array.isArray(paths) ? paths : [paths];
        return copyText(list.map((p) => absolutePath(active.root, p)).join('\n'), list.length > 1 ? `경로 ${list.length}개를 복사했어요` : '경로를 복사했어요');
    }

    function startBatPath() {
        if (mode === 'file') {
            let dir = decodeURIComponent(location.pathname).replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\');
            dir = dir.slice(0, dir.lastIndexOf('\\'));
            if (/\\dist$/i.test(dir)) dir = dir.slice(0, -5);
            return dir + '\\server\\start.bat';
        }
        if (info?.appRoot) return absolutePath(info.appRoot, 'server/start.bat');
        return null; // unknown (opened from some other web address)
    }

    // ---------- Workspace (served mode) ----------
    async function activateRoot(root) {
        if (mode !== 'served') throw failure('ENOTSUP', '서버 주소로 앱을 열면 쓸 수 있어요');
        await api.ensureSession();
        const ws = await api.request('POST', '/api/workspace/open', { body: { root } });
        const active = new App.ServerBackend({ ...ws, capabilities: server.capabilities });
        await App.workspace.openBackend(active);
        return active;
    }

    async function openRoot(root) {
        try {
            return await activateRoot(root);
        } catch (err) {
            reportError(err);
            return null;
        }
    }

    const recents = () => request('GET', '/api/workspace/recent');

    /**
     * file:// → server: open the folder the page had open, matched by its workspace id (.fluid-organizer/workspace.json)
     * among the server's recent folders (fallback: the only one with the same name). Unknown → ask once with the chooser.
     */
    async function continueHandoff(data) {
        const want = data?.workspace;
        if (!want || typeof want.name !== 'string') return false;
        let items = [];
        try {
            items = (await recents()) || [];
        } catch (e) {
            /* fall through to the chooser */
        }
        const live = items.filter((r) => r && r.exists !== false && typeof r.root === 'string');
        let match = want.id ? live.find((r) => r.id === want.id) : null;
        if (!match) {
            const named = live.filter((r) => r.name === want.name);
            if (named.length === 1) match = named[0];
        }
        if (!match) {
            pickWorkspace({ hint: want.name });
            return true;
        }
        const active = await openRoot(match.root);
        if (!active) return false;
        if (data.cwd && typeof data.cwd === 'string') {
            try {
                if (await App.fs.exists(data.cwd)) await App.nav.go(data.cwd);
            } catch (e) {
                /* the folder moved meanwhile: stay at the root */
            }
        }
        ui.toast(`‘${active.name}’ 폴더를 서버로 이어서 열었어요`, { type: 'success', duration: 3200 });
        return true;
    }

    function relativeTime(ms) {
        const minutes = Math.floor((Date.now() - ms) / 60000);
        if (!Number.isFinite(minutes)) return '';
        if (minutes < 1) return '방금';
        if (minutes < 60) return `${minutes}분 전`;
        if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}시간 전`;
        const days = Math.floor(minutes / (24 * 60));
        if (days === 1) return '어제';
        if (days < 7) return `${days}일 전`;
        return App.util.formatDate(ms);
    }

    function pickWorkspace(opts) {
        if (mode !== 'served') return showSetup();
        if (chooserOpen) return chooserOpen;
        const hint = opts && typeof opts === 'object' && typeof opts.hint === 'string' ? opts.hint : '';
        let alive = true;
        let busy = false;
        let picking = false;
        let close = null;

        const error = h('div', { class: 'srv-field-error', role: 'alert' });
        const input = h('input', { class: 'input', type: 'text', placeholder: 'D:\\사진\\2024', spellcheck: 'false', 'aria-label': '작업 폴더 경로' });
        const openBtn = h('button', { class: 'btn', type: 'button', text: '열기', onclick: () => openPath(input.value) });
        const pickArea = h('div', { class: 'srv-pick' });
        const recentList = h('div', { class: 'srv-recent-list' });
        const recentSection = h('section', { class: 'srv-recents', hidden: true }, h('div', { class: 'srv-section-title', text: '최근 작업 폴더' }), recentList);

        function setBusy(v) {
            busy = v;
            openBtn.disabled = v;
            input.disabled = v;
            for (const b of recentList.querySelectorAll('button')) b.disabled = v || b.dataset.missing === '1';
        }

        async function openPath(root) {
            root = (root || '').trim();
            if (busy || !alive) return;
            if (!root) {
                showError('폴더 경로를 입력해 주세요');
                input.focus();
                return;
            }
            setBusy(true);
            showError('');
            try {
                await activateRoot(root);
                close?.();
            } catch (err) {
                if (alive) {
                    showError(err.message);
                    input.focus();
                }
            } finally {
                if (alive) setBusy(false);
            }
        }

        function showError(text) {
            error.textContent = text;
            input.classList.toggle('invalid', !!text);
        }

        async function pickNative() {
            if (busy || picking) return;
            picking = true;
            showError('');
            renderPick();
            try {
                const result = await api.request('POST', '/api/workspace/pick', { body: {} });
                picking = false;
                if (alive) renderPick();
                if (alive && result?.root) await openPath(result.root);
            } catch (err) {
                if (alive) showError(err.message);
            } finally {
                picking = false;
                if (alive) renderPick();
            }
        }

        function renderPick() {
            pickArea.replaceChildren(
                picking
                    ? h('div', { class: 'srv-pick-waiting', role: 'status' },
                        h('span', { class: 'spinner' }),
                        h('div', { class: 'grow' },
                            h('div', { class: 'srv-strong', text: '폴더 선택 창이 열렸어요' }),
                            h('div', { class: 'srv-muted', text: '바탕화면에 뜬 창에서 폴더를 골라 주세요. 창이 안 보이면 작업 표시줄을 확인해 주세요.' })),
                        h('button', { class: 'btn ghost sm', type: 'button', text: '취소', onclick: () => api.request('POST', '/api/workspace/pick/cancel', { body: {} }).catch(() => {}) }))
                    : h('button', { class: 'btn primary lg srv-pick-btn', type: 'button', html: `${ui.icon('folder-open', { size: 18 })}<span>폴더 찾아보기…</span>`, onclick: pickNative }),
            );
        }

        function renderRecents(items) {
            recentList.replaceChildren();
            for (const item of items.slice(0, 8)) {
                const missing = item.exists === false;
                const row = h('div', { class: `srv-recent${missing ? ' missing' : ''}` });
                const main = h('button', {
                    class: 'srv-recent-main',
                    type: 'button',
                    title: item.root,
                    dataset: { missing: missing ? '1' : '0' },
                    disabled: missing,
                    onclick: () => openPath(item.root),
                },
                h('span', { class: 'srv-recent-icon', html: ui.icon('folder', { size: 16 }) }),
                h('span', { class: 'srv-recent-text' }, h('span', { class: 'srv-recent-name', text: item.name }), h('span', { class: 'srv-recent-path', text: item.root })),
                h('span', { class: 'srv-recent-time', text: missing ? '찾을 수 없음' : relativeTime(item.openedAt) }));
                const forget = h('button', {
                    class: 'btn ghost sm icon srv-recent-forget',
                    type: 'button',
                    'aria-label': '목록에서 지우기',
                    'data-tip': '목록에서 지우기',
                    html: ui.icon('x', { size: 14 }),
                    onclick: async () => {
                        await api.request('POST', '/api/workspace/forget', { body: { root: item.root } }).catch(reportError);
                        row.remove();
                        recentSection.hidden = !recentList.children.length;
                    },
                });
                row.append(main, forget);
                recentList.append(row);
            }
            recentSection.hidden = !recentList.children.length;
        }

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault();
                openPath(input.value);
            }
        });
        input.addEventListener('input', () => showError(''));

        const body = h('div', { class: 'srv-chooser' },
            hint
                ? h('div', { class: 'srv-hint', role: 'status' },
                    h('span', { class: 'srv-hint-icon', html: ui.icon('folder-open', { size: 15 }) }),
                    h('div', { class: 'grow' },
                        h('div', { class: 'srv-strong', text: `‘${hint}’ 폴더를 한 번만 골라 주세요` }),
                        h('div', { class: 'srv-muted', text: '서버가 이 폴더를 아직 몰라요. 한 번 고르면 다음부터는 바로 열려요.' })))
                : h('p', { class: 'srv-lead', text: '로컬 서버로 열면 HEIC·AVI 미리보기, 영상 편집, 중복 찾기를 모두 쓸 수 있어요.' }),
            pickArea,
            h('div', { class: 'srv-path' }, h('label', { class: 'srv-section-title', text: '경로로 열기' }), h('div', { class: 'srv-path-row' }, input, openBtn), error),
            recentSection,
            h('div', { class: 'srv-chooser-foot' },
                h('button', {
                    class: 'btn ghost sm',
                    type: 'button',
                    'data-tip': '서버 없이 브라우저의 폴더 선택 창으로 열어요',
                    text: '브라우저 방식으로 열기',
                    onclick: () => {
                        close?.();
                        browserPick?.();
                    },
                })));
        renderPick();

        chooserOpen = ui.dialog({
            title: '작업 폴더 열기',
            width: 540,
            actions: [],
            body,
            init(box, closeFn) {
                close = closeFn;
                box.classList.add('srv-dialog');
                pickArea.querySelector('button')?.focus();
                recents().then((items) => alive && renderRecents(items || []), () => {});
            },
        }).finally(() => {
            alive = false;
            if (picking) api.request('POST', '/api/workspace/pick/cancel', { body: {} }).catch(() => {});
            chooserOpen = null;
        });
        return chooserOpen;
    }

    // ---------- Thumbnail bridge ----------
    // While a server workspace is open, thumbnails come from /api/thumb (disk-cached on the server, HTTP-cached in the
    // browser because URLs are versioned). A small priority queue keeps ≤4 requests in flight so API calls never starve.
    function installThumbBridge() {
        const T = App.thumbs;
        if (!T || T.backendAware || T.__serverBridge || typeof T.get !== 'function') return;
        const orig = {
            canThumb: T.canThumb?.bind(T),
            peek: T.peek?.bind(T),
            get: T.get.bind(T),
            prioritize: T.prioritize?.bind(T),
            cancelExcept: T.cancelExcept?.bind(T),
            clearCache: T.clearCache?.bind(T),
        };
        const LIMIT = 4;
        const MAX_URLS = 1500;
        const MAX_FAILED = 5000;
        const loaded = new Map(); // thumb url -> { objectUrl, path }
        const pending = new Map(); // thumb url -> task
        const failed = new Set(); // thumb urls the server can't render (undecodable/corrupt files only, bounded)
        const queue = [];
        let running = 0;

        const serves = (entry) => {
            const active = backend();
            return active && entry?.kind === 'file' && active.canThumb(entry) ? active : null;
        };

        function remember(url, objectUrl, path) {
            loaded.delete(url);
            loaded.set(url, { objectUrl, path });
            while (loaded.size > MAX_URLS) {
                const [oldUrl, old] = loaded.entries().next().value;
                loaded.delete(oldUrl);
                URL.revokeObjectURL(old.objectUrl);
            }
        }

        function forget(predicate) {
            for (const [url, item] of [...loaded]) {
                if (!predicate(item.path)) continue;
                loaded.delete(url);
                URL.revokeObjectURL(item.objectUrl);
            }
            for (const url of [...failed]) if (predicate(new URL(url, location.href).searchParams.get('path'))) failed.delete(url);
        }

        function applyMeta(entry, res) {
            const num = (name) => {
                const v = Number(res.headers.get(name));
                return res.headers.has(name) && Number.isFinite(v) && v > 0 ? v : null;
            };
            const w = num('X-FI-Width');
            const hgt = num('X-FI-Height');
            const duration = num('X-FI-Duration');
            const cur = App.catalog.peek(entry.path)?.meta || {};
            const patch = {};
            if (w && hgt && (cur.w !== w || cur.h !== hgt)) Object.assign(patch, { w, h: hgt });
            if (duration && Math.abs((cur.duration || 0) - duration) > 0.05) patch.duration = duration;
            if (!Object.keys(patch).length) return false;
            App.catalog.setMeta(entry.path, patch);
            return !!patch.duration;
        }

        async function load(task, retried = false) {
            const res = await fetch(task.url + '&soft=1', { credentials: 'same-origin', signal: task.abort.signal });
            if (res.status === 401 && !retried) {
                await api.ensureSession(true);
                return load(task, true);
            }
            if (res.status === 204) {
                // Remember only "can't decode this file"; missing/locked/busy files may work on the next look
                if (res.headers.get('X-FI-Error') === 'EINVAL') {
                    failed.add(task.url);
                    if (failed.size > MAX_FAILED) failed.delete(failed.values().next().value);
                }
                return null;
            }
            if (!res.ok) return null;
            const blob = await res.blob();
            if (task.active !== backend()) return null;
            const objectUrl = URL.createObjectURL(blob);
            remember(task.url, objectUrl, task.entry.path);
            // After caching: the gallery redraws the card (duration badge) and asks for this thumbnail again
            if (applyMeta(task.entry, res) && task.entry.type === 'video') {
                App.bus.emit('thumbs:meta', { path: task.entry.path, duration: App.catalog.peek(task.entry.path)?.meta?.duration });
            }
            return objectUrl;
        }

        function pump() {
            while (running < LIMIT && queue.length) {
                const task = queue.shift();
                running++;
                load(task)
                    .catch(() => null)
                    .then((url) => task.resolve(url))
                    .finally(() => {
                        pending.delete(task.url);
                        running--;
                        pump();
                    });
            }
        }

        T.canThumb = (entry) => !!serves(entry) || !!orig.canThumb?.(entry);

        T.peek = (entry, size = 360) => {
            const active = serves(entry);
            if (!active) return orig.peek ? orig.peek(entry, size) : null;
            const url = active.thumbUrl(entry, size);
            const hit = loaded.get(url);
            if (!hit) return null;
            remember(url, hit.objectUrl, hit.path);
            return hit.objectUrl;
        };

        T.get = (entry, opts = {}) => {
            const active = serves(entry);
            if (!active) return orig.get(entry, opts);
            const url = active.thumbUrl(entry, opts.size || 360);
            const hit = loaded.get(url);
            if (hit) return Promise.resolve(hit.objectUrl);
            if (failed.has(url)) return Promise.resolve(null);
            if (pending.has(url)) return pending.get(url).promise;
            const task = { url, entry, active, abort: new AbortController() };
            task.promise = new Promise((resolve) => (task.resolve = resolve));
            pending.set(url, task);
            queue.push(task);
            pump();
            return task.promise;
        };

        T.prioritize = (paths) => {
            const wanted = new Set(paths);
            queue.sort((a, b) => Number(wanted.has(b.entry.path)) - Number(wanted.has(a.entry.path)));
            orig.prioritize?.(paths);
        };

        T.cancelExcept = (paths) => {
            const keep = new Set(paths);
            for (let i = queue.length - 1; i >= 0; i--) {
                if (keep.has(queue[i].entry.path)) continue;
                const [task] = queue.splice(i, 1);
                pending.delete(task.url);
                task.resolve(null);
            }
            orig.cancelExcept?.(paths);
        };

        T.clearCache = async (opts) => {
            forget(() => true);
            failed.clear();
            // pass options through (e.g. { disk: false } keeps the workspace thumbnail cache)
            return orig.clearCache?.(opts);
        };

        function reset() {
            for (const task of queue.splice(0)) task.resolve(null);
            for (const task of pending.values()) task.abort.abort();
            pending.clear();
            forget(() => true);
            failed.clear();
        }

        App.bus.on('workspace:opened', reset);
        App.bus.on('workspace:closed', reset);
        App.bus.on('fs:changed', (c) => {
            if (c.type !== 'modify') return;
            const changed = new Set(c.paths);
            forget((p) => changed.has(p));
        });
        T.__serverBridge = true;
    }

    // ---------- Viewer bridge ----------
    // The viewer shows "can't open this format" for HEIC/AVI…; with the server we can render/stream them instead.
    function installViewerBridge() {
        if (!App.viewer || App.viewer.serverAware) return;
        App.bus.on('viewer:shown', ({ entry, media }) => {
            const active = backend();
            if (media || !active || !entry || App.util.browserCanDecode(entry.name) || !server.canDisplay(entry)) return;
            const placeholder = document.querySelector('#viewer .vw-unsupported');
            if (!placeholder) return;
            const el = entry.type === 'video'
                ? h('video', { class: 'vw-media', src: active.streamUrl(entry.path), controls: true, autoplay: true, playsinline: true })
                : h('img', { class: 'vw-media', src: active.thumbUrl(entry, 2560), alt: entry.name, draggable: 'false' });
            placeholder.replaceWith(el);
        });
    }

    // ---------- Inspector: media info ----------
    function installInspector() {
        if (typeof App.inspector?.addSection !== 'function') return;
        const fmtFps = (fps) => `${Number(fps).toFixed(2).replace(/\.?0+$/, '')}fps`;
        App.inspector.addSection({
            id: 'server-media',
            title: '미디어 정보',
            order: 15,
            when: ({ primary }) => !!backend() && primary?.kind === 'file' && (primary.type === 'image' || primary.type === 'video'),
            // Resolution and length are already in the info section above; this adds what only the server knows.
            render(body, { primary }, section) {
                const active = backend();
                const box = h('div', { class: 'srv-media', role: 'status', text: '정보 읽는 중…' });
                body.append(box);
                active.probe(primary).then((d) => {
                    if (!box.isConnected) return;
                    if (!d) {
                        box.textContent = '정보를 읽지 못했어요';
                        return;
                    }
                    const video = primary.type === 'video';
                    const rows = [
                        ['코덱', video ? [d.vcodec, d.acodec].filter(Boolean).join(' · ') : null],
                        ['프레임', d.fps ? fmtFps(d.fps) : null],
                        ['비트레이트', d.bitrate ? `${(d.bitrate / 1e6).toFixed(1)} Mbps` : null],
                        ['소리', video ? (d.hasAudio ? '있음' : '없음') : null],
                        ['회전', d.rotation ? `${d.rotation}°` : null],
                        ['촬영', d.taken ? App.util.formatDate(d.taken, true) : null],
                        ['카메라', d.camera],
                    ].filter(([, v]) => v != null && v !== '');
                    if (!rows.length) {
                        (section || body).remove();
                        return;
                    }
                    const table = h('div', { class: 'insp-table' });
                    for (const [k, v] of rows) table.append(h('div', { class: 'insp-k', text: k }), h('div', { class: 'insp-v', text: v, title: String(v) }));
                    box.replaceWith(table);
                }, () => {
                    if (box.isConnected) box.textContent = '정보를 읽지 못했어요';
                });
            },
        });
    }

    // ---------- Gallery: context menu & '서버' badges ----------
    function installGallery() {
        const G = App.gallery;
        if (!G) return;
        if (Array.isArray(G.contextMenuItems)) {
            G.contextMenuItems.push((entries) => {
                if (!backend()) return [];
                if (!entries.length) return [{ label: '탐색기에서 이 폴더 보기', icon: 'folder-open', command: 'server.reveal', args: { path: App.state.cwd || '' } }];
                const one = entries.length === 1 ? entries[0] : null;
                return [
                    { label: '탐색기에서 보기', icon: 'folder-open', command: 'server.reveal', args: { path: entries[0].path } },
                    one && one.kind === 'file' ? { label: '기본 앱으로 열기', icon: 'external', command: 'server.openDefault', args: { path: one.path } } : null,
                    { label: '전체 경로 복사', icon: 'copy', command: 'server.copyPath', args: { paths: entries.map((e) => e.path) } },
                ].filter(Boolean);
            });
        }
        if (Array.isArray(G.cardDecorators)) {
            G.cardDecorators.push((card, entry) => {
                if (backend() || entry.kind !== 'file' || (entry.type !== 'image' && entry.type !== 'video')) return;
                if (App.util.browserCanDecode(entry.name)) return;
                const media = card.querySelector('.card-media');
                if (!media) return;
                const badge = h('button', {
                    class: 'srv-badge',
                    type: 'button',
                    draggable: 'false',
                    'aria-label': '로컬 서버가 필요한 형식이에요',
                    'data-tip': '로컬 서버를 켜면 미리보기와 재생을 할 수 있어요',
                    html: `${ui.icon('server', { size: 11 })}<span>서버</span>`,
                });
                badge.addEventListener('click', (e) => {
                    e.stopPropagation();
                    showSetup();
                });
                badge.addEventListener('dblclick', (e) => e.stopPropagation());
                badge.addEventListener('mousedown', (e) => e.stopPropagation());
                media.append(badge);
            });
        }
    }

    // ---------- Status bar item + popover ----------
    const STATUS = {
        idle: { label: '', tip: '' },
        connecting: { label: '서버 연결 중…', tip: '로컬 서버에 연결하고 있어요' },
        connected: { label: '서버 연결됨', tip: '로컬 서버에 연결됐어요 · 눌러서 자세히 보기' },
        offline: { label: '서버 연결 끊김', tip: '로컬 서버와 연결이 끊겼어요 · 눌러서 다시 연결' },
        detected: { label: '서버로 열기', tip: '로컬 서버가 켜져 있어요. 서버 주소로 열면 모든 기능을 쓸 수 있어요' },
        none: { label: '서버 꺼짐', tip: '로컬 서버를 켜면 HEIC·AVI 미리보기, 영상 편집, 중복 찾기를 쓸 수 있어요' },
    };

    const OUTDATED = { label: '서버 업데이트', tip: '서버를 새 버전으로 다시 켜 주세요 · 눌러서 다시 켜기' };

    function renderStatus() {
        if (!statusEl) return;
        const old = mode === 'served' && outdated();
        const s = old ? OUTDATED : STATUS[state];
        statusEl.dataset.state = state;
        statusEl.toggleAttribute('data-outdated', old);
        statusEl.hidden = state === 'idle';
        statusEl.dataset.tip = s.tip;
        statusEl.setAttribute('aria-label', s.label);
        statusEl.replaceChildren(h('span', { class: 'srv-dot', 'aria-hidden': 'true' }), h('span', { class: 'srv-status-label', text: s.label }));
    }

    function onStatusClick() {
        if (state === 'detected') return openServerUrl();
        if (state === 'none' || state === 'idle') return showSetup();
        return showStatus();
    }

    const CAPS = [
        ['ffmpeg', '영상 처리', 'ffmpeg'],
        ['faiss', '중복 찾기', 'FAISS'],
        ['heif', 'HEIC 사진', 'pillow-heif'],
        ['avif', 'AVIF 사진', 'Pillow'],
    ];

    function capabilityList({ compact = false } = {}) {
        const caps = server.capabilities;
        return h('ul', { class: `srv-caps${compact ? ' compact' : ''}` }, CAPS.map(([key, label, tech]) => {
            const on = !!caps[key];
            return h('li', { class: on ? 'on' : 'off', title: on ? `${label} · ${tech}` : `${label}: 설치되지 않았어요` },
                h('span', { class: 'srv-cap-icon', html: ui.icon(on ? 'check' : 'x', { size: 12 }) }),
                h('span', { class: 'grow', text: label }),
                compact ? null : h('span', { class: 'srv-cap-tech', text: on ? tech : '없음' }));
        }));
    }

    function showStatus() {
        if (!statusEl) return;
        if (statusPop) {
            statusPop.close();
            return;
        }
        const active = backend();
        const offline = state === 'offline';
        outdatedToast?.close(); // the popover says the same thing (and the toast would cover its buttons)
        const el = h('div', { class: 'srv-pop' },
            h('div', { class: 'srv-pop-head' },
                h('span', { class: 'srv-pop-logo', html: ui.icon('server', { size: 16 }) }),
                h('div', { class: 'grow' },
                    h('div', { class: 'srv-strong', text: '로컬 서버' }),
                    h('div', { class: `srv-pop-state ${offline ? 'bad' : 'good'}`, text: offline ? '연결이 끊겼어요' : `${location.host}에서 실행 중이에요` })),
                info?.version ? h('span', { class: 'badge', text: `v${info.version}` }) : null),
            mode === 'served' && outdated()
                ? h('div', { class: 'srv-update', role: 'status' },
                    h('span', { class: 'srv-update-icon', html: ui.icon('refresh', { size: 14 }) }),
                    h('div', { class: 'grow' },
                        h('div', { class: 'srv-strong', text: '서버를 새 버전으로 다시 켜 주세요' }),
                        h('div', { class: 'srv-muted', text: '앱은 새 버전인데 서버는 예전 버전이에요. 다시 켜면 새 기능을 모두 쓸 수 있어요.' }),
                        h('button', { class: 'btn sm primary', type: 'button', text: '다시 켜기', onclick: () => App.commands.run('server.restart') })))
                : null,
            capabilityList(),
            active
                ? h('div', { class: 'srv-pop-ws' },
                    h('div', { class: 'srv-section-title', text: '작업 폴더' }),
                    h('div', { class: 'srv-pop-name', text: active.name }),
                    h('div', { class: 'srv-pop-root', text: shortPath(active.root), title: active.root }))
                : null,
            h('div', { class: 'srv-pop-actions' },
                offline ? h('button', { class: 'btn sm primary', type: 'button', html: `${ui.icon('refresh', { size: 14 })}<span>다시 연결</span>`, onclick: () => recover() }) : null,
                active && !offline ? h('button', { class: 'btn sm', type: 'button', html: `${ui.icon('folder-open', { size: 14 })}<span>탐색기에서 열기</span>`, onclick: () => App.commands.run('server.reveal', { path: '' }) }) : null,
                h('span', { class: 'grow' }),
                !offline && mode === 'served' ? h('button', { class: 'btn sm ghost', type: 'button', text: '서버 끄기', onclick: () => App.commands.run('server.shutdown') }) : null));
        statusPop = ui.popover(statusEl, el, {
            above: true,
            align: 'end',
            padding: '0',
            class: 'srv-popover',
            onClose: () => {
                statusPop = null;
            },
        });
    }

    async function shutdownServer() {
        statusPop?.close();
        const ok = await ui.confirm({
            title: '로컬 서버 끄기',
            message: '서버를 끄면 이 창의 작업 폴더는 서버를 다시 켤 때까지 쓸 수 없어요. 끌까요?',
            okLabel: '서버 끄기',
            danger: true,
        });
        if (!ok) return;
        await App.catalog?.flush?.();
        await request('POST', '/api/server/shutdown', {});
        stoppedByUser = true;
        setState('offline');
        offlineToast = ui.toast("로컬 서버를 껐어요. 다시 쓰려면 바탕화면의 '사진영상정리기' 아이콘을 눌러 주세요", { id: 'srv-offline', type: 'info', duration: 0 });
        scheduleRecovery();
    }

    /**
     * '다시 켜기': the server starts a fresh copy of itself (new code from disk, same address, same folder) and exits;
     * the app reconnects by itself. A round-1 server can't restart itself — it is switched off and the owner starts it
     * again with the desktop icon (the app reconnects as soon as it is back).
     */
    async function restartServer() {
        if (mode !== 'served') throw failure('ENOTSUP', '서버 주소로 앱을 열면 쓸 수 있어요');
        statusPop?.close();
        await App.catalog?.flush?.();
        let manual = false;
        try {
            await request('POST', '/api/server/restart', {});
        } catch (err) {
            if (err.status !== 404 && err.status !== 405) throw err;
            manual = true; // round-1 server: no restart endpoint
            await request('POST', '/api/server/shutdown', {});
        }
        outdatedToast?.close();
        outdatedToast = null;
        stoppedByUser = true; // no "connection lost" warning: this was on purpose
        setState('offline');
        recoveryDelay = 800;
        offlineToast?.close();
        offlineToast = manual
            ? ui.toast("서버를 껐어요. 바탕화면의 '사진영상정리기' 아이콘을 누르면 새 버전으로 켜져요", { id: 'srv-offline', type: 'info', duration: 0 })
            : ui.toast('서버를 새 버전으로 다시 켜고 있어요…', { id: 'srv-offline', type: 'loading', duration: 0 });
        scheduleRecovery();
    }

    // ---------- Setup sheet ----------
    // Owner feedback: "로컬 서버 기다리라는 게 뭐야?" — one sentence on what it is, two steps, and a single button once it is on.
    const PERKS = [
        ['image', 'HEIC·AVI 보기'],
        ['scissors', '영상 자르기·합치기'],
        ['layers', '빠른 중복 찾기'],
        ['folder-open', '탐색기 열기'],
    ];

    function showSetup() {
        if (setupOpen) return setupOpen;
        statusPop?.close();
        let alive = true;
        let timer = null;
        let close = null;

        const live = h('div', { class: 'srv-live', role: 'status', 'aria-live': 'polite', dataset: { state: 'waiting' } });

        function renderWaiting() {
            live.dataset.state = 'waiting';
            live.replaceChildren(
                h('span', { class: 'srv-live-icon' }, h('span', { class: 'srv-pulse', 'aria-hidden': 'true' })),
                h('div', { class: 'grow' },
                    h('div', { class: 'srv-strong', text: '아직 꺼져 있어요' }),
                    h('div', { class: 'srv-muted', text: '켜지면 여기서 바로 이어서 열 수 있어요' })));
        }

        function renderReady(alreadyServed) {
            live.dataset.state = 'ready';
            const ws = App.state.workspace;
            const children = [
                h('span', { class: 'srv-live-icon', html: ui.icon('check', { size: 16 }) }),
                h('div', { class: 'grow' },
                    h('div', { class: 'srv-strong', text: alreadyServed ? '이미 로컬 서버로 실행 중이에요' : '서버가 켜졌어요' }),
                    h('div', { class: 'srv-muted', text: alreadyServed ? '아래 기능을 모두 쓸 수 있어요.' : ws ? `‘${ws.name}’ 폴더와 설정을 그대로 가져가요.` : '설정을 그대로 가져가요.' }),
                    alreadyServed ? capabilityList({ compact: true }) : null),
            ];
            if (!alreadyServed) {
                children.push(h('button', {
                    class: 'btn primary',
                    type: 'button',
                    'data-tip': '서버 주소(127.0.0.1)로 이 창을 바꿔요',
                    html: `<span>서버로 계속하기</span>${ui.icon('arrow-right', { size: 14 })}`,
                    onclick: () => openServerUrl(),
                }));
            }
            live.replaceChildren(...children);
            live.querySelector('.btn.primary')?.focus();
        }

        async function poll() {
            if (!alive) return;
            if (mode === 'served' && state === 'connected') return renderReady(true);
            const ok = await health();
            if (!alive) return;
            if (ok) {
                if (mode === 'served') {
                    recover();
                    return renderReady(true);
                }
                info = ok;
                setState('detected');
                return renderReady(false);
            }
            timer = setTimeout(poll, 2000);
        }

        const pathText = startBatPath();
        const shortcutName = h('span', { class: 'srv-app-name' }, h('span', { class: 'srv-app-icon', 'aria-hidden': 'true', html: ui.icon('image', { size: 12 }) }), '사진영상정리기');
        const body = h('div', { class: 'srv-setup' },
            h('p', { class: 'srv-lead', text: '로컬 서버는 이 PC에서만 도는 도우미예요. 사진·영상은 어디에도 올라가지 않아요.' }),
            h('ul', { class: 'srv-perks', 'aria-label': '서버를 켜면 쓸 수 있는 기능' },
                PERKS.map(([icon, text]) => h('li', null, h('span', { class: 'srv-perk-icon', html: ui.icon(icon, { size: 13 }) }), h('span', { text })))),
            h('ol', { class: 'srv-steps' },
                h('li', null,
                    h('span', { class: 'srv-step-no', text: '1' }),
                    h('div', { class: 'grow' },
                        h('div', null, h('code', { class: 'srv-code', text: 'server\\start.bat' }), '을 한 번 실행해요'),
                        h('div', { class: 'srv-muted', text: '처음에만 1~2분 준비해요. 끝나면 바탕화면에 아이콘이 생겨요.' }),
                        pathText
                            ? h('div', { class: 'srv-step-path' },
                                h('span', { class: 'srv-path-text', text: shortPath(pathText, 58), title: pathText }),
                                h('button', { class: 'btn ghost sm', type: 'button', html: `${ui.icon('copy', { size: 13 })}<span>경로 복사</span>`, onclick: () => copyText(pathText).catch(reportError) }))
                            : h('div', { class: 'srv-muted', text: '앱 폴더(사진영상정리기.html이 있는 곳) 안의 server 폴더에 있어요.' }))),
                h('li', null,
                    h('span', { class: 'srv-step-no', text: '2' }),
                    h('div', { class: 'grow' },
                        h('div', null, '다음부터는 바탕화면의 ', shortcutName, ' 아이콘만 누르면 돼요'),
                        h('div', { class: 'srv-muted', text: '서버와 앱이 함께 켜지고, 마지막에 보던 폴더가 바로 열려요.' })))),
            live,
            h('div', { class: 'srv-setup-foot' }, h('button', { class: 'btn ghost', type: 'button', text: '닫기', onclick: () => close?.() })));

        renderWaiting();
        setupOpen = ui.dialog({
            title: '로컬 서버 켜기',
            width: 540,
            actions: [],
            body,
            init(box, closeFn) {
                close = closeFn;
                box.classList.add('srv-dialog');
                body.querySelector('.srv-setup-foot .btn')?.focus();
                poll();
            },
        }).finally(() => {
            alive = false;
            clearTimeout(timer);
            setupOpen = null;
        });
        return setupOpen;
    }

    // ---------- Public API ----------
    const server = {
        mode,
        url: serverUrl,
        get state() {
            return state;
        },
        get info() {
            return info;
        },
        get available() {
            return state === 'connected';
        },
        get capabilities() {
            return info?.capabilities || api.session?.capabilities || {};
        },
        get backend() {
            return backend();
        },
        connect,
        request,
        job,
        waitJob,
        cancelJob: (id) => request('POST', `/api/jobs/${encodeURIComponent(id)}/cancel`, {}),
        /** True when the connected server can do `cap` ('ffmpeg', 'faiss', 'heif'...) for the open workspace. */
        canUse: (cap) => state === 'connected' && !!backend() && (!cap || server.capabilities[cap] !== false),
        canStream: () => state === 'connected' && !!backend() && server.capabilities.ffmpeg !== false,
        streamUrl: (path, start) => requireBackend().streamUrl(path, { start }),
        thumbUrl: (entry, size) => requireBackend().thumbUrl(entry, size),
        video,
        dupes,
        API_VERSION,
        /** apiVersion of the connected/detected server (1 for round-1 servers), or 0 when there is none. */
        get apiVersion() {
            return info ? apiVersionOf(info) : 0;
        },
        get outdated() {
            return outdated();
        },
        /** Feature check for other teams: 'dupes-v2', 'job-pause', 'restart'. */
        supports(feature) {
            const v = state === 'connected' && !!backend() && info ? apiVersionOf(info) : 0;
            return ({ 'dupes-v2': 2, 'job-pause': 2, restart: 2 })[feature] <= v;
        },
        handoffUrl,
        restart: () => restartServer(),
        thumbs: {
            pregenerate: ({ dirs, size = 360 } = {}, opts = {}) => runJob('/api/thumbs/pregenerate', { dirs, size }, '썸네일 만드는 중', opts),
        },
        media: {
            probe: (path) => requireBackend().probe(path),
            streamUrl: (path, start) => requireBackend().streamUrl(path, { start }),
            thumbUrl: (entry, size) => requireBackend().thumbUrl(entry, size),
        },
        reveal: (path = primaryTarget()) => requireBackend().reveal(path),
        openDefault: (path = primaryTarget()) => requireBackend().openDefault(path),
        copyPath,
        canDisplay(value) {
            const entry = typeof value === 'string' ? { kind: 'file', name: P.base(value), path: value } : value;
            if (!entry || entry.kind === 'dir') return false;
            if (App.util.browserCanDecode(entry.name)) return true;
            const active = backend();
            return state === 'connected' && !!active && active.canThumb(entry);
        },
        openRoot,
        pickWorkspace,
        recents,
        showSetup,
        showStatus,
    };
    App.server = server;

    // ---------- Commands ----------
    const run = (fn) => async (args) => {
        try {
            return await fn(args || {});
        } catch (err) {
            reportError(err);
        }
    };
    const hasServerWorkspace = () => !!backend();

    App.commands.register({
        id: 'server.connect',
        title: '로컬 서버 연결',
        group: '서버',
        icon: 'server',
        keys: 'Mod+Alt+S',
        scope: 'global',
        run: run(async () => {
            if (mode === 'served') {
                await connect();
                if (backend()) await App.nav.reload();
                ui.toast('로컬 서버에 연결됐어요', { type: 'success', duration: 2200 });
            } else if ((await connect()) && state === 'detected') {
                await openServerUrl();
            } else {
                showSetup();
            }
        }),
    });
    App.commands.register({ id: 'server.status', title: '로컬 서버 상태', group: '서버', icon: 'server', run: run(onStatusClick) });
    App.commands.register({ id: 'server.setup', title: '로컬 서버 켜는 방법', group: '서버', icon: 'server', run: run(() => showSetup()) });
    App.commands.register({
        id: 'server.open',
        title: '서버 주소로 다시 열기',
        group: '서버',
        icon: 'external',
        when: () => mode !== 'served',
        run: run(openServerUrl),
    });
    App.commands.register({
        id: 'server.reveal',
        title: '탐색기에서 보기',
        group: '파일',
        icon: 'folder-open',
        keys: 'Alt+Shift+R',
        when: hasServerWorkspace,
        run: run(({ path }) => server.reveal(path ?? primaryTarget())),
    });
    App.commands.register({
        id: 'server.openDefault',
        title: '기본 앱으로 열기',
        group: '파일',
        icon: 'external',
        keys: 'Alt+Enter',
        when: () => hasServerWorkspace() && (App.select.primary()?.kind === 'file'),
        run: run(({ path }) => server.openDefault(path ?? App.select.primary()?.path)),
    });
    App.commands.register({
        id: 'server.copyPath',
        title: '전체 경로 복사',
        group: '파일',
        icon: 'copy',
        keys: 'Alt+Shift+C',
        when: hasServerWorkspace,
        run: run(({ paths }) => copyPath(paths || targetPaths())),
    });
    App.commands.register({
        id: 'server.pregenerateThumbs',
        title: '이 폴더 썸네일 미리 만들기 (서버)',
        group: '서버',
        icon: 'zap',
        when: hasServerWorkspace,
        run: run(async () => {
            const r = await server.thumbs.pregenerate({ dirs: [App.state.cwd || ''] });
            ui.toast(r.made ? `썸네일 ${App.util.formatCount(r.made)}개를 새로 만들었어요` : '썸네일이 모두 준비돼 있어요', { type: 'success' });
        }),
    });
    App.commands.register({
        id: 'server.shutdown',
        title: '로컬 서버 끄기',
        group: '서버',
        icon: 'x-circle',
        when: () => mode === 'served' && state === 'connected',
        run: run(shutdownServer),
    });
    App.commands.register({
        id: 'server.restart',
        title: '로컬 서버 다시 켜기 (새 버전)',
        group: '서버',
        icon: 'refresh',
        when: () => mode === 'served' && state === 'connected',
        run: run(restartServer),
    });
    App.commands.register({
        id: 'server.shortcut',
        title: '바탕화면 아이콘 만들기',
        group: '서버',
        icon: 'download',
        when: () => mode === 'served' && state === 'connected' && apiVersionOf(info) >= 2 && info?.platform === 'win32',
        run: run(async () => {
            const r = await request('POST', '/api/server/shortcut', {});
            ui.toast(r?.created?.length ? "바탕화면과 시작 메뉴에 '사진영상정리기' 아이콘을 만들었어요" : '아이콘을 만들 수 없는 환경이에요', {
                type: r?.created?.length ? 'success' : 'info',
            });
        }),
    });

    // ---------- Init ----------
    App.register('server', {
        async init() {
            installThumbBridge();
            installViewerBridge();
            installInspector();
            installGallery();
            if (typeof App.statusbar?.addItem === 'function') {
                statusEl = h('button', { class: 'sb-btn srv-status', type: 'button', onclick: onStatusClick });
                App.statusbar.addItem('server', statusEl, { side: 'right' });
                renderStatus();
            }
            App.bus.on('server:session', (session) => {
                info = session;
            });
            App.bus.on('server:online', ({ online }) => {
                if (mode !== 'served') return;
                if (!online) goOffline();
                else if (state === 'offline') recover();
            });
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible' && probesNetwork && state !== 'detected' && Date.now() - lastProbe > 30000) connect();
            });
            window.addEventListener('pagehide', () => {
                disposed = true;
                clearTimeout(recoveryTimer);
            });

            if (mode !== 'served') {
                connect();
                return;
            }
            if (App.workspace && !App.workspace.serverAware && typeof App.workspace.pick === 'function') {
                browserPick = App.workspace.pick.bind(App.workspace);
                App.workspace.pick = pickWorkspace;
            }
            try {
                const session = await connect();
                // Arrived from the file:// page with one click: open the same folder there
                if (handoff && (await continueHandoff(handoff))) return;
                // Reload / new tab / desktop icon: continue in the workspace this server already has open
                if (session?.workspace?.root && !App.state.workspace && App.settings.get('server.resume', true)) await openRoot(session.workspace.root);
            } catch (e) {
                /* offline: the status item and toast explain how to recover */
            }
        },
    });
})();
