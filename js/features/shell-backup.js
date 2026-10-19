/*
 * Backups of the library data — every *.json in .fluid-organizer (catalog, chipsets, favorites, workspace, ...).
 *
 *   App.backup.snapshot()          manual snapshot → .fluid-organizer/backups/snap-YYYYMMDD-HHMMSS/*.json (20 kept)
 *   App.backup.list()              [{ id, kind: 'auto'|'manual', time, bytes, files: [{ name, size, path }] }], newest first
 *                                  ('auto' = the daily <name>-YYYYMMDD.json copies App.wsdata.backup keeps)
 *   App.backup.secondary.get() · pick() · forget() · run({ interactive }) · status()
 *       A folder on another drive, picked once (handle kept in App.idb). Receives copies through a second
 *       App.fs.BrowserBackend into "<folder>/<workspace> (<id>)/latest/" and ".../history/YYYYMMDD/" (14 days):
 *       when a workspace opens, every 30 minutes after changes, and on demand.
 *
 * UI: settings page '데이터와 백업', status-bar line '보조 백업 · <폴더> · 2분 전'. Events: 'backup:changed'.
 */
(() => {
    'use strict';
    const { h, formatBytes, formatCount } = App.util;
    const ui = App.ui;
    const DATA_DIR = '.fluid-organizer';
    const BACKUP_DIR = DATA_DIR + '/backups';
    const SNAP_PREFIX = 'snap-';
    const KEEP_SNAPSHOTS = 20;
    const KEEP_HISTORY_DAYS = 14;
    const SEC_KEY = 'backup.secondary';
    const LAST_KEY = 'backup.secondary.last';
    const PERIOD = 30 * 60 * 1000;

    function stampTime(day, time = '000000') {
        const d = new Date(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8), +time.slice(0, 2), +time.slice(2, 4), +time.slice(4, 6));
        return d.getTime();
    }

    function byteSize(text) {
        return new Blob([text]).size;
    }

    /** Current library documents: [{ name, text }] (catalog is flushed first). */
    async function dataDocs() {
        await App.catalog.flush();
        const raws = await App.fs.backend.list(DATA_DIR, { stat: false }).catch(() => []);
        const out = [];
        for (const r of raws) {
            if (r.kind !== 'file' || !r.name.toLowerCase().endsWith('.json')) continue;
            try {
                out.push({ name: r.name, text: await App.fs.readText(`${DATA_DIR}/${r.name}`) });
            } catch (e) {
                console.warn('[backup] cannot read', r.name, e);
            }
        }
        return out;
    }

    // =====================================================================================================
    // Snapshots inside the workspace
    // =====================================================================================================
    /** Write every library document to backups/snap-YYYYMMDD-HHMMSS[-reason]/. reason: 'restore' = taken before a restore. */
    async function snapshot({ reason = '' } = {}) {
        if (!App.fs.ready) throw new Error('작업 폴더가 열려 있지 않아요');
        const docs = await dataDocs();
        let id = SNAP_PREFIX + App.shell.stamp() + (reason ? `-${reason}` : '');
        if (await App.fs.exists(`${BACKUP_DIR}/${id}`).catch(() => false)) id += '-' + Math.random().toString(36).slice(2, 5);
        for (const d of docs) await App.fs.writeRaw(`${BACKUP_DIR}/${id}/${d.name}`, d.text);
        await pruneSnapshots();
        App.bus.emit('backup:changed');
        return { id, files: docs.length, bytes: docs.reduce((s, d) => s + byteSize(d.text), 0) };
    }

    async function pruneSnapshots() {
        const raws = await App.fs.backend.list(BACKUP_DIR, { stat: false }).catch(() => []);
        const snaps = raws.filter((r) => r.kind === 'dir' && r.name.startsWith(SNAP_PREFIX)).map((r) => r.name).sort();
        for (const old of snaps.slice(0, Math.max(0, snaps.length - KEEP_SNAPSHOTS))) {
            await App.fs.backend.remove(`${BACKUP_DIR}/${old}`).catch(() => {});
        }
    }

    async function list() {
        if (!App.fs.ready) return [];
        const raws = await App.fs.backend.list(BACKUP_DIR, { stat: true }).catch(() => []);
        const groups = new Map();
        for (const r of raws) {
            if (r.kind === 'file') {
                const m = /^(.+)-(\d{8})\.json$/.exec(r.name);
                if (!m) continue;
                const id = 'day-' + m[2];
                let g = groups.get(id);
                if (!g) groups.set(id, (g = { id, kind: 'auto', time: 0, bytes: 0, files: [] }));
                g.files.push({ name: m[1] + '.json', size: r.size || 0, path: `${BACKUP_DIR}/${r.name}` });
                g.bytes += r.size || 0;
                g.time = Math.max(g.time, r.mtime || stampTime(m[2]));
            } else if (r.kind === 'dir') {
                const m = /^snap-(\d{8})-(\d{6})(?:-([a-z]+))?/.exec(r.name);
                if (!m) continue;
                const inner = await App.fs.backend.list(`${BACKUP_DIR}/${r.name}`, { stat: true }).catch(() => []);
                const files = inner.filter((x) => x.kind === 'file' && x.name.endsWith('.json')).map((x) => ({ name: x.name, size: x.size || 0, path: `${BACKUP_DIR}/${r.name}/${x.name}` }));
                groups.set(r.name, { id: r.name, kind: 'manual', reason: m[3] || '', time: stampTime(m[1], m[2]), bytes: files.reduce((s, f) => s + f.size, 0), files });
            }
        }
        return [...groups.values()].sort((a, b) => b.time - a.time || (a.id < b.id ? 1 : -1));
    }

    // =====================================================================================================
    // Restore a backup — one undoable step (Ctrl+Z brings back what was there before)
    // =====================================================================================================
    const NEVER_RESTORE = new Set(['workspace.json']); // the workspace id must never change

    function whenText(group) {
        return group.kind === 'manual' ? App.util.formatDate(group.time, true) : `${App.util.formatDate(group.time)} 자동 백업`;
    }

    async function readGroup(group) {
        const docs = [];
        for (const f of group.files) {
            if (NEVER_RESTORE.has(f.name)) continue;
            const text = await App.fs.readText(f.path);
            JSON.parse(text); // refuse damaged files before touching anything
            docs.push({ name: f.name, text });
        }
        return docs;
    }

    /** Library state as { catalog: items | null, docs: Map(name → text | null) } for the given document names. */
    async function captureState(names) {
        await App.catalog.flush();
        const state = { catalog: null, docs: new Map() };
        for (const name of names) {
            if (name === 'catalog.json') state.catalog = Object.fromEntries(App.catalog.entries().map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
            else state.docs.set(name, await App.fs.readText(`${DATA_DIR}/${name}`).catch(() => null));
        }
        return state;
    }

    function stateFromDocs(docs) {
        const state = { catalog: null, docs: new Map() };
        for (const d of docs) {
            if (d.name === 'catalog.json') {
                const parsed = JSON.parse(d.text);
                state.catalog = parsed && parsed.items && typeof parsed.items === 'object' ? parsed.items : {};
            } else state.docs.set(d.name, d.text);
        }
        return state;
    }

    /**
     * Make `state` current. The catalog is replaced in memory through App.catalog (so its own saving stays
     * consistent); other documents are written and the workspace re-opened in place so their modules reload them.
     */
    async function applyState(state) {
        if (state.catalog) {
            const items = state.catalog;
            const paths = [...new Set([...App.catalog.entries().map(([k]) => k), ...Object.keys(items)])];
            if (paths.length) {
                App.catalog.updateMany(paths, (e, p) => {
                    for (const k of Object.keys(e)) delete e[k];
                    if (items[p]) Object.assign(e, JSON.parse(JSON.stringify(items[p])));
                });
            }
            await App.catalog.flush();
        }
        let changed = false;
        for (const [name, text] of state.docs) {
            const p = `${DATA_DIR}/${name}`;
            const current = await App.fs.readText(p).catch(() => null);
            if (current === text) continue;
            if (text == null) await App.fs.backend.remove(p).catch(() => {});
            else await App.fs.writeRaw(p, text);
            changed = true;
        }
        if (changed && App.workspace?.reload) await App.workspace.reload({ keepUndo: true });
        App.bus.emit('backup:changed');
    }

    async function restore(group, { confirm = true } = {}) {
        if (!App.fs.ready) return false;
        let docs;
        try {
            docs = await readGroup(group);
        } catch (e) {
            ui.toast(`백업 파일이 손상돼서 되돌릴 수 없어요: ${e.message}`, { type: 'error' });
            return false;
        }
        if (!docs.length) {
            ui.toast('이 백업에는 되돌릴 내용이 없어요', { type: 'info' });
            return false;
        }
        const when = whenText(group);
        if (confirm) {
            const cat = docs.find((d) => d.name === 'catalog.json');
            let count = null;
            try {
                count = cat ? Object.keys(JSON.parse(cat.text).items || {}).length : null;
            } catch (e) {
                count = null;
            }
            const others = docs.filter((d) => d.name !== 'catalog.json').map((d) => d.name.replace(/\.json$/i, ''));
            const parts = [];
            if (count != null) parts.push(`파일 정보(칩·별점·메모) ${formatCount(count)}개 — 지금은 ${formatCount(App.catalog.entries().length)}개`);
            if (others.length) parts.push(others.join(' · '));
            const body = h('div', { class: 'bk-confirm' },
                h('p', { text: `‘${when}’ 백업 상태로 되돌릴까요? 사진·영상 파일은 그대로이고, 라이브러리 정보만 그때로 돌아가요.` }),
                h('ul', { class: 'bk-confirm-list' }, ...parts.map((t) => h('li', { text: t }))),
                h('p', { class: 'bk-confirm-safe', html: `${ui.icon('shield-check', { size: 14 })}<span>지금 상태는 먼저 백업해 두고, <b>Ctrl+Z</b>로 언제든 다시 되돌릴 수 있어요.</span>` }));
            const ok = await ui.dialog({
                title: '백업으로 되돌리기',
                body,
                width: 460,
                dismissValue: false,
                actions: [
                    { label: '취소', value: false, kind: 'ghost' },
                    { label: '되돌리기', value: true, kind: 'primary', autofocus: true },
                ],
            });
            if (!ok) return false;
        }
        const t = ui.toast('백업으로 되돌리는 중…', { type: 'loading', id: 'bk-restore' });
        try {
            await snapshot({ reason: 'restore' }); // safety copy of the current state, kept even after undo history is gone
            const before = await captureState(docs.map((d) => d.name));
            const after = stateFromDocs(docs);
            await applyState(after);
            const entry = {
                label: `백업으로 되돌리기 (${when})`,
                undo: () => applyState(before),
                redo: () => applyState(after),
            };
            App.undo.push(entry);
            t.update(`‘${when}’ 백업으로 되돌렸어요`, {
                type: 'success',
                duration: 7000,
                action: { label: '실행 취소', run: () => (App.undo.peek?.() === entry ? App.undo.undo() : null) },
            });
            return true;
        } catch (e) {
            console.error('[backup] restore failed', e);
            t.update(`되돌리지 못했어요: ${e.message}`, { type: 'error', duration: 8000 });
            return false;
        }
    }

    // =====================================================================================================
    // Secondary location (another drive)
    // =====================================================================================================
    let secRec = null; // { handle, name, pickedAt }
    let secState = 'none'; // none | ok | needs-permission | running | error
    let secError = null;
    let running = null;
    let dirty = false;

    async function loadSecondary() {
        const rec = await App.idb.get(SEC_KEY).catch(() => null);
        secRec = rec && rec.handle ? rec : null;
        if (!secRec) secState = 'none';
        else if (secState === 'none') secState = 'ok';
        return secRec;
    }

    function lastTimes() {
        const v = App.settings.get(LAST_KEY, null);
        return v && typeof v === 'object' ? v : {};
    }

    function lastTime(id = App.state.workspace?.id) {
        return id ? lastTimes()[id] || 0 : 0;
    }

    function setState(s, err = null) {
        secState = s;
        secError = err;
        App.bus.emit('backup:changed');
    }

    function safeName(name) {
        return String(name || 'workspace').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || 'workspace';
    }

    function targetFolder(ws) {
        return `${safeName(ws.name)} (${ws.id.slice(-6)})`;
    }

    function readme(ws) {
        const now = new Date();
        return [
            'Fluid Identity 보조 백업',
            '',
            `작업 폴더: ${ws.name}  (id ${ws.id})`,
            `마지막 복사: ${App.util.formatDate(now.getTime(), true)}`,
            '',
            'latest/            가장 최근 복사본',
            'history/YYYYMMDD/  날짜별 복사본 (최근 14일)',
            '',
            '들어 있는 파일: catalog.json (칩·별점·메모·영상 마커), chipsets.json (칩셋), favorites.json (즐겨찾기) 등',
            '',
            '되살리는 방법: 앱에서 작업 폴더를 닫은 뒤, 원하는 날짜 폴더의 .json 파일을',
            '작업 폴더 안 .fluid-organizer 폴더에 덮어쓰고 다시 여세요.',
            '',
        ].join('\r\n');
    }

    async function pruneHistory(backend, folder) {
        const raws = await backend.list(`${folder}/history`, { stat: false }).catch(() => []);
        const days = raws.filter((r) => r.kind === 'dir' && /^\d{8}$/.test(r.name)).map((r) => r.name).sort();
        for (const old of days.slice(0, Math.max(0, days.length - KEEP_HISTORY_DAYS))) {
            await backend.remove(`${folder}/history/${old}`).catch(() => {});
        }
    }

    async function pickSecondary() {
        if (!('showDirectoryPicker' in window)) {
            await ui.alert({ title: '지원하지 않는 브라우저', message: 'Chrome 또는 Edge에서만 보조 백업 위치를 고를 수 있어요.' });
            return false;
        }
        let handle;
        try {
            handle = await window.showDirectoryPicker({ id: 'fluid-identity-backup', mode: 'readwrite' });
        } catch (e) {
            if (e.name !== 'AbortError') ui.toast(`폴더를 고를 수 없어요: ${e.message}`, { type: 'error' });
            return false;
        }
        // A backup that lives inside the workspace dies with it: refuse
        const root = App.fs.backend?.root;
        if (root && typeof root.resolve === 'function') {
            let inside = null;
            try {
                inside = await root.resolve(handle);
            } catch (e) {
                inside = null;
            }
            if (inside) {
                await ui.alert({ title: '다른 곳을 골라 주세요', message: '작업 폴더 안에는 보조 백업을 둘 수 없어요. 작업 폴더와 함께 사라지지 않도록 다른 드라이브나 외장 디스크의 폴더를 골라 주세요.' });
                return false;
            }
        }
        await App.idb.set(SEC_KEY, { handle, name: handle.name, pickedAt: Date.now() });
        await loadSecondary();
        setState('ok');
        if (App.fs.ready) await runSecondary({ interactive: true, announce: true });
        return true;
    }

    async function forgetSecondary() {
        await App.idb.del(SEC_KEY).catch(() => {});
        secRec = null;
        setState('none');
    }

    async function runSecondary({ interactive = false, announce = false } = {}) {
        if (!App.fs.ready || !App.state.workspace) return 'no-workspace';
        if (!secRec) await loadSecondary();
        if (!secRec) return 'none';
        if (running) return running;
        const rec = secRec;
        const ws = { ...App.state.workspace };
        running = (async () => {
            let perm;
            try {
                perm = await rec.handle.queryPermission({ mode: 'readwrite' });
            } catch (e) {
                perm = 'error';
            }
            if (perm !== 'granted' && interactive) {
                try {
                    perm = await rec.handle.requestPermission({ mode: 'readwrite' });
                } catch (e) {
                    perm = 'denied';
                }
            }
            if (perm !== 'granted') {
                setState('needs-permission');
                if (interactive) ui.toast('보조 백업 폴더 권한이 없어서 복사하지 못했어요', { type: 'warning' });
                return 'needs-permission';
            }
            setState('running');
            try {
                const docs = await dataDocs();
                const backend = new App.fs.BrowserBackend(rec.handle);
                const folder = targetFolder(ws);
                const day = App.shell.dayStamp();
                for (const d of docs) {
                    await backend.write(`${folder}/latest/${d.name}`, d.text);
                    await backend.write(`${folder}/history/${day}/${d.name}`, d.text);
                }
                await backend.write(`${folder}/README.txt`, readme(ws));
                await pruneHistory(backend, folder);
                App.settings.set(LAST_KEY, { ...lastTimes(), [ws.id]: Date.now() });
                dirty = false;
                setState('ok');
                if (announce) ui.toast(`‘${rec.name}’에 백업했어요 — 파일 ${docs.length}개`, { type: 'success' });
                return 'ok';
            } catch (e) {
                console.error('[backup] secondary copy failed', e);
                setState('error', e);
                if (interactive) ui.toast(`보조 백업에 실패했어요: ${e.message}`, { type: 'error' });
                return 'error';
            }
        })().finally(() => {
            running = null;
        });
        return running;
    }

    function status() {
        const name = secRec?.name || '';
        const last = lastTime();
        let text;
        if (!secRec) text = '보조 백업 위치가 없어요';
        else if (secState === 'needs-permission') text = `보조 백업 · ${name} · 권한 필요`;
        else if (secState === 'running') text = `보조 백업 · ${name} · 복사하는 중…`;
        else if (secState === 'error') text = `보조 백업 · ${name} · 실패`;
        else text = `보조 백업 · ${name} · ${last ? App.shell.relTime(last) : '아직 안 했어요'}`;
        return { state: secRec ? secState : 'none', name, last, text, error: secError };
    }

    // =====================================================================================================
    // Settings page: 데이터와 백업
    // =====================================================================================================
    let pageCtx = null;

    function snapshotRow(s) {
        const names = s.files.map((f) => f.name.replace(/\.json$/i, '')).filter((n) => n !== 'workspace').join(' · ');
        const kindText = s.reason === 'restore' ? '되돌리기 전' : s.kind === 'manual' ? '직접 백업' : '자동';
        const restoreBtn = h('button', {
            class: 'btn ghost sm bk-restore',
            type: 'button',
            'data-tip': '이 백업 상태로 되돌려요 · Ctrl+Z로 취소할 수 있어요',
            'aria-label': `${whenText(s)} 백업으로 되돌리기`,
            html: `${ui.icon('rotate-ccw', { size: 13 })}<span>되돌리기</span>`,
        });
        restoreBtn.addEventListener('click', () => restore(s));
        return h('div', { class: 'bk-row', dataset: { id: s.id } },
            h('span', { class: `bk-ico ${s.kind}`, html: ui.icon(s.reason === 'restore' ? 'shield-check' : s.kind === 'manual' ? 'bookmark' : 'history', { size: 14 }) }),
            h('div', { class: 'bk-main' },
                h('div', { class: 'bk-when' },
                    h('span', { text: App.util.formatDate(s.time, s.kind === 'manual') }),
                    h('span', { class: `bk-kind ${s.kind}${s.reason ? ' ' + s.reason : ''}`, text: kindText })),
                h('div', { class: 'bk-files', text: names || '파일 없음' })),
            h('span', { class: 'bk-size', text: formatBytes(s.bytes) }),
            restoreBtn);
    }

    App.settingsUI?.addPage({
        id: 'data',
        title: '데이터와 백업',
        icon: 'hard-drive',
        order: 40,
        desc: '칩·별점·메모·칩셋·즐겨찾기 같은 라이브러리 정보를 안전하게 지켜요.',
        render(body, k, ctx) {
            pageCtx = { ctx, body };
            // ----- snapshots in the workspace -----
            const local = k.group('이 작업 폴더의 백업', '작업 폴더 안 .fluid-organizer/backups에 쌓여요. 매일 처음 열 때 자동으로 한 벌, 원할 때 직접 한 벌씩 만들 수 있어요. 되돌리기도 Ctrl+Z로 취소할 수 있어요.');
            if (!App.fs.ready) {
                local.body.append(k.note('작업 폴더를 열면 백업 목록이 보여요.'));
            } else {
                const nowBtn = k.button('지금 백업', {
                    icon: 'download',
                    kind: 'primary',
                    onClick: async (e) => {
                        const btn = e.currentTarget;
                        btn.disabled = true;
                        try {
                            const r = await snapshot();
                            ui.toast(`백업했어요 — 파일 ${r.files}개, ${formatBytes(r.bytes)}`, { type: 'success' });
                        } catch (err) {
                            ui.toast(`백업하지 못했어요: ${err.message}`, { type: 'error' });
                        }
                        btn.disabled = false;
                    },
                });
                local.body.append(k.row({ label: '지금 상태 그대로 백업', desc: `‘${App.state.workspace.name}’의 라이브러리 정보를 시간이 찍힌 백업으로 남겨요.`, control: nowBtn }));
                const listEl = h('div', { class: 'bk-list' }, h('div', { class: 'bk-loading shs-muted', text: '백업 목록을 읽는 중…' }));
                local.body.append(listEl);
                list().then((snaps) => {
                    listEl.innerHTML = '';
                    if (!snaps.length) {
                        listEl.append(h('div', { class: 'bk-empty shs-muted', text: '아직 백업이 없어요. 칩이나 별점을 붙이면 매일 자동으로 백업돼요.' }));
                        return;
                    }
                    for (const s of snaps.slice(0, 12)) listEl.append(snapshotRow(s));
                    if (snaps.length > 12) listEl.append(h('div', { class: 'bk-more shs-muted', text: `이전 백업 ${formatCount(snaps.length - 12)}개 더 있어요` }));
                }).catch(() => {
                    listEl.innerHTML = '';
                    listEl.append(h('div', { class: 'bk-empty shs-muted', text: '백업 목록을 읽지 못했어요.' }));
                });
            }

            // ----- secondary location -----
            const sec = k.group('보조 백업 위치', '작업 폴더가 있는 드라이브가 고장 나도 남도록, 다른 드라이브나 외장 디스크에 한 벌 더 복사해 둬요.');
            const st = status();
            if (!secRec) {
                sec.body.append(k.row({
                    label: '보조 백업 위치',
                    desc: '아직 정하지 않았어요. 한 번 고르면 작업 폴더를 열 때마다 자동으로 복사해요.',
                    icon: 'hard-drive',
                    control: k.button('폴더 고르기', { icon: 'folder-open', onClick: () => pickSecondary() }),
                }));
            } else {
                const dot = h('span', { class: `shs-dot ${st.state === 'ok' && st.last ? 'on' : st.state === 'needs-permission' || st.state === 'error' ? 'warn' : ''}` });
                const actions = h('div', { class: 'shs-actions' });
                if (st.state === 'needs-permission') actions.append(k.button('권한 허락하기', { icon: 'lock', kind: 'primary', onClick: () => runSecondary({ interactive: true, announce: true }) }));
                else actions.append(k.button('지금 복사', { icon: 'refresh', disabled: !App.fs.ready || st.state === 'running', onClick: () => runSecondary({ interactive: true, announce: true }) }));
                actions.append(
                    k.button('바꾸기', { onClick: () => pickSecondary() }),
                    k.button('해제', {
                        kind: 'ghost',
                        onClick: async () => {
                            const ok = await ui.confirm({ title: '보조 백업 해제', message: `‘${secRec.name}’에 더 이상 복사하지 않을까요? 이미 복사된 파일은 그대로 남아 있어요.`, okLabel: '해제' });
                            if (ok) forgetSecondary();
                        },
                    }));
                sec.body.append(h('div', { class: 'shs-card' },
                    h('div', { class: 'shs-card-row' },
                        dot,
                        h('div', { class: 'grow' },
                            h('div', { class: 'shs-card-title bk-sec-name', text: secRec.name }),
                            h('div', { class: 'shs-muted bk-sec-status', text: st.text + (st.error ? ` — ${st.error.message}` : '') })),
                        actions)));
                sec.body.append(k.note(h('span', { html: `작업 폴더를 열 때, 바뀐 게 있으면 30분마다, 그리고 <b>지금 복사</b>를 누를 때 복사해요. 위치: <b>${App.util.escapeHtml(secRec.name)}</b> › <b>${App.util.escapeHtml(App.state.workspace ? targetFolder(App.state.workspace) : '작업 폴더 이름 (id)')}</b> › latest · history` }), { icon: 'info' }));
            }
            body.append(local.el, sec.el);
        },
    });

    App.bus.on('backup:changed', () => {
        if (pageCtx && pageCtx.body.isConnected) pageCtx.ctx.refresh();
        renderStatusItem();
    });

    // =====================================================================================================
    // Status-bar line
    // =====================================================================================================
    let sbItem = null;

    function renderStatusItem() {
        if (!sbItem) return;
        const st = status();
        const show = !!secRec && App.fs.ready;
        sbItem.hidden = !show;
        if (!show) return;
        sbItem.classList.toggle('warn', st.state === 'needs-permission' || st.state === 'error');
        sbItem.classList.toggle('running', st.state === 'running');
        sbItem.innerHTML = '';
        const icon = st.state === 'running' ? 'refresh' : st.state === 'needs-permission' || st.state === 'error' ? 'alert' : 'check-circle';
        sbItem.append(h('span', { html: ui.icon(icon, { size: 12 }) }), h('span', { class: 'sb-backup-text', text: st.text }));
        sbItem.dataset.tip = st.state === 'needs-permission' ? '눌러서 보조 백업 폴더 권한을 다시 허락해요' : '데이터와 백업 설정 열기';
    }

    // =====================================================================================================
    // Triggers, commands
    // =====================================================================================================
    App.bus.on('workspace:opened', () => {
        setTimeout(() => {
            if (App.fs.ready && secRec) runSecondary({ interactive: false });
        }, 2500);
        renderStatusItem();
    });
    App.bus.on('workspace:closed', renderStatusItem);
    App.bus.on('catalog:changed', () => {
        dirty = true;
    });
    setInterval(() => {
        if (!App.fs.ready || !secRec || running || document.visibilityState === 'hidden') return;
        const age = Date.now() - lastTime();
        if ((dirty && age > PERIOD) || age > 6 * 60 * 60 * 1000) runSecondary({ interactive: false });
    }, 60 * 1000);
    setInterval(renderStatusItem, 30 * 1000);

    App.commands.register({
        id: 'backup.now',
        title: '지금 백업',
        group: '파일',
        icon: 'download',
        keywords: ['backup', '스냅샷'],
        when: () => App.fs.ready,
        run: async () => {
            const r = await snapshot();
            ui.toast(`백업했어요 — 파일 ${r.files}개, ${formatBytes(r.bytes)}`, { type: 'success', action: { label: '목록 보기', run: () => App.settingsUI?.open('data') } });
            if (secRec) runSecondary({ interactive: true });
        },
    });
    App.commands.register({ id: 'backup.secondary', title: '보조 백업 위치에 지금 복사', group: '파일', icon: 'hard-drive', keywords: ['backup'], when: () => App.fs.ready && !!secRec, run: () => runSecondary({ interactive: true, announce: true }) });
    App.commands.register({ id: 'backup.settings', title: '데이터와 백업 설정', group: '일반', icon: 'hard-drive', keywords: ['backup', '백업'], run: () => App.settingsUI?.open('data') });

    App.register('shell-backup', {
        init() {
            loadSecondary();
            App.bus.once('app:ready', () => {
                if (!App.statusbar?.addItem) return;
                sbItem = h('button', { class: 'sb-shell sb-backup', type: 'button', hidden: true, 'aria-label': '보조 백업 상태' });
                sbItem.addEventListener('click', () => {
                    if (secState === 'needs-permission') runSecondary({ interactive: true, announce: true });
                    else App.settingsUI?.open('data');
                });
                App.shell.addStatus('backup', sbItem, 20);
                renderStatusItem();
            });
        },
    });

    App.backup = {
        snapshot,
        list,
        restore,
        dataDocs,
        secondary: {
            get: () => secRec,
            pick: pickSecondary,
            forget: forgetSecondary,
            run: runSecondary,
            status,
            reload: loadSecondary,
        },
    };
})();
