/*
 * Video file output for the in-viewer editor (video-edit.js) and the "회전·반전을 파일에 적용" action.
 * Round 2 retired the old editor panel (E): cutting now happens on the seek bar; this file turns the pieces into files.
 *
 *   saveKept(path)    '남은 부분 이어서 새 파일로' — one kept piece → trim, several → concat
 *   savePieces(path)  '조각마다 새 파일로' — one new file per kept piece (piece memo/chips go onto the new file)
 *   toClips(path)     '보관함에 담기' — App.clips.add(kept pieces) as ONE undo step (hidden when App.clips is missing)
 *
 * Engines: the local server (docs/server-api.md, App.server.video.* raw style: POST → job → wait) when it's ready;
 *   otherwise the browser-only lossless engine (video-lossless.js: keyframe-aligned packet copy, MP4/MOV/WebM/MKV).
 *   When neither can do it, a small inline notice offers '서버 켜기' (App.server.showSetup) — no big panel.
 * Originals are never touched. Every created file is ONE undo step (Ctrl+Z moves it to the app trash, Ctrl+Y brings it
 * back). Option video.archiveOriginal: afterwards the original moves to '<folder>/원본 보관' (App.fs.move — undoable).
 *
 * App.videoEditor — { saveKept, savePieces, toClips, serverState, busy,
 *                     canApplyViewTransform(entry), applyViewTransform(entry) — bake the viewer's rotation/flip (server) }
 */
(() => {
    'use strict';
    const { h, path: P, escapeHtml } = App.util;
    const ui = App.ui;
    const V = App.viewer;
    const fmt = (t, precise = false) => (V.fmtTime ? V.fmtTime(t, precise) : String(t));
    const r3 = (t) => Math.round(t * 1000) / 1000;
    const ARCHIVE_DIR = '원본 보관';
    const fmtSec = (s) => (s < 60 ? `${Math.round(s * 10) / 10}초` : fmt(s));

    let busy = null; // { label }

    // ---------- Server ----------
    function serverState() {
        const s = App.server;
        if (!s) return { ready: false, why: 'missing' };
        if (!s.available) return { ready: false, why: 'offline' };
        if (s.capabilities && s.capabilities.ffmpeg === false) return { ready: false, why: 'ffmpeg' };
        if (typeof s.canUse === 'function') return s.canUse('ffmpeg') ? { ready: true } : { ready: false, why: 'workspace' };
        if (App.fs.backend?.kind !== 'server') return { ready: false, why: 'workspace' };
        if (!(s.video || typeof s.request === 'function')) return { ready: false, why: 'missing' };
        return { ready: true };
    }

    async function waitForJob(res, onProgress) {
        const s = App.server;
        const id = res && (res.jobId ?? res.job?.id ?? (typeof res.job === 'string' ? res.job : null) ?? (res.id && res.state ? res.id : null));
        if (!id || res.state === 'done' || res.result) return res;
        if (typeof s.waitJob === 'function') return s.waitJob(id, onProgress);
        if (typeof s.job === 'function') {
            for (;;) {
                const j = await s.job(id);
                onProgress(j);
                if (!j || j.state !== 'running') return j;
                await App.util.sleep(500);
            }
        }
        return res;
    }

    async function callServer(op, payload, label) {
        const s = App.server;
        let res;
        if (s.video && typeof s.video[op] === 'function') res = await s.video[op](payload);
        else if (typeof s.request === 'function') res = await s.request('POST', `/api/video/${op}`, payload);
        else throw new Error('서버 연결 기능이 아직 준비되지 않았어요');
        res = await waitForJob(res, () => {});
        if (res && (res.state === 'error' || (res.error && !res.path && !res.result))) throw new Error(res.error?.message || res.message || (typeof res.error === 'string' ? res.error : '') || `${label}에 실패했어요`);
        if (res && res.state === 'cancelled') return null;
        const out = res?.result?.path ?? res?.path ?? res?.output ?? res?.result?.output ?? (typeof res === 'string' ? res : null);
        return out || null;
    }

    // A file the server just wrote: tell the app and make it ONE undo step (undo = to the app trash, redo = back).
    function adoptServerOutput(out, label) {
        if (typeof App.fs.emitChange === 'function') App.fs.emitChange({ type: 'create', paths: [out], dirs: [P.parent(out)] });
        else App.nav?.reload?.();
        let ids = null;
        App.undo.push({
            label: `${label} · ${P.base(out)}`,
            undo: async () => {
                ids = await App.fs.trash([out], { undoable: false });
            },
            redo: async () => {
                if (ids) await App.fs.restore(ids);
            },
        });
    }

    /** steps: [{ op, payload }] — later steps get { path: <previous output>, inPlace: true }. quiet: no success toast. */
    async function runSteps(label, steps, doneText, { quiet = false } = {}) {
        const st = serverState();
        if (!st.ready) {
            needServer();
            return null;
        }
        const t = ui.toast(`${label} 중…`, { type: 'loading' });
        try {
            let out = null;
            for (const [i, s] of steps.entries()) {
                const payload = i === 0 ? s.payload : { ...s.payload, path: out, inPlace: true };
                const next = await callServer(s.op, payload, label);
                if (!next) {
                    t.close();
                    ui.toast(`${label}을(를) 취소했어요`, { type: 'info' });
                    if (out) adoptServerOutput(out, label);
                    return null;
                }
                out = next;
            }
            t.close();
            adoptServerOutput(out, label);
            if (!quiet) ui.toast(`${doneText} · ${P.base(out)}`, { type: 'success', duration: 6000, action: { label: '보기', run: () => V.open(out) } });
            return out;
        } catch (e) {
            t.close();
            if (e.code === 'ECANCELED') ui.toast(`${label}을(를) 취소했어요`, { type: 'info' });
            else ui.toast(`${label}에 실패했어요: ${e.message}`, { type: 'error' });
            return null;
        }
    }

    // ---------- "needs the server" — a small inline notice at save time ----------
    let needPop = null;

    function anchorEl() {
        const cands = [V.root?.querySelector('.vw-save-btn'), V.root?.querySelector('.vw-edit-badge')];
        return cands.find((el) => el && el.offsetParent) || null;
    }

    function needServer(reason) {
        const st = serverState();
        const openSetup = () => {
            needPop?.close();
            if (App.server?.showSetup) App.server.showSetup();
            else if (App.commands.get('server.setup')) App.commands.run('server.setup');
            else if (App.commands.get('server.connect')) App.commands.run('server.connect');
        };
        const text = reason
            ? `${reason} 로컬 서버를 켜면 어떤 형식이든 저장할 수 있어요.`
            : st.why === 'workspace'
                ? '서버는 켜져 있어요. 서버 주소(127.0.0.1:8765)에서 이 폴더를 열면 바로 저장돼요.'
                : '새 파일을 만들려면 로컬 서버가 필요해요. 켜 두면 바로 저장할 수 있어요.';
        const anchor = anchorEl();
        if (!anchor) {
            ui.toast(text, { type: 'warning', duration: 7000, action: { label: '서버 켜기', run: openSetup } });
            return;
        }
        needPop?.close();
        const box = h('div', { class: 've-need' },
            h('span', { class: 've-need-icon', html: ui.icon('server', { size: 15 }) }),
            h('span', { class: 've-need-text', text }),
            h('button', { class: 'btn sm primary', html: `${ui.icon('zap', { size: 13 })}<span>서버 켜기</span>`, onclick: openSetup }));
        needPop = ui.popover(anchor, box, { align: 'end', class: 've-need-pop', padding: '10px 12px', onClose: () => {
            needPop = null;
        } });
    }

    // ---------- Browser-only lossless engine ----------
    async function freeName(dir, base, ext) {
        for (let i = 1; i < 1000; i++) {
            const name = `${base}${String(i).padStart(2, '0')}.${ext}`;
            if (!(await App.fs.exists(P.join(dir, name)))) return name;
        }
        return `${base}${Date.now()}.${ext}`;
    }

    async function browserCut(path, ranges, label, suffix, doneText, { quiet = false } = {}) {
        const L = App.videoLossless;
        const t = ui.toast(`${label} 중… (브라우저에서 화질 그대로)`, { type: 'loading' });
        const job = App.jobs?.start?.({ title: `${label} · ${P.base(path)}`, total: 100, cancellable: true });
        let cancelled = false;
        job?.onCancel?.(() => {
            cancelled = true;
        });
        try {
            const file = await App.fs.getFile(path);
            const res = await L.cut(file, ranges, { onProgress: (f) => job?.update?.(Math.round(f * 100)), isCancelled: () => cancelled || !!job?.cancelled });
            const dir = P.parent(path);
            const name = await freeName(dir, `${P.stem(P.base(path))}_${suffix}`, res.ext);
            const out = await App.fs.createFile(dir, name, res.blob, { label: `${label} · ${name}` });
            App.catalog.setMeta(out, { duration: r3(res.duration), source: { path, ranges: res.ranges.map(([a, b]) => [r3(a), r3(b)]) } });
            job?.finish?.();
            t.close();
            if (!quiet) ui.toast(`${doneText} · ${P.base(out)}`, { type: 'success', duration: 6000, action: { label: '보기', run: () => V.open(out) } });
            // honest about keyframe alignment: say so when noticeably more than asked went into the file
            if (res.restored > 0.3 || res.lead > 1.5) {
                const more = res.restored > 0.3 ? `잘라낸 부분 ${fmtSec(res.restored)}` : `앞쪽 ${fmtSec(res.lead)}`;
                ui.toast(`키프레임 간격 때문에 ${more}만큼 더 들어갔어요. 딱 맞게 자르려면 로컬 서버의 '정확하게'로 저장해 주세요`, { type: 'warning', duration: 8000 });
            }
            return out;
        } catch (e) {
            t.close();
            if (e.code === 'ECANCELED') {
                job?.finish?.();
                ui.toast(`${label}을(를) 취소했어요`, { type: 'info' });
            } else {
                job?.fail?.(e);
                if (['EUNSUPPORTED', 'ETOOBIG', 'ELOAD'].includes(e.code)) needServer(`${e.message}.`.replace(/\.\.$/, '.'));
                else ui.toast(`${label}에 실패했어요: ${e.message}`, { type: 'error' });
            }
            return null;
        }
    }

    function engineFor(path) {
        if (serverState().ready) return 'server';
        if (App.videoLossless?.supports?.(P.base(path))) return 'browser';
        return null;
    }

    function trimMode() {
        return App.settings.get('video.trimMode', 'fast') === 'accurate' ? 'accurate' : 'fast';
    }

    // ---------- Piece bookkeeping ----------
    function plan(path) {
        const pieces = App.videoEdit?.piecesOf?.(path) || [];
        return { pieces, kept: pieces.filter((x) => !x.removed) };
    }

    // New files keep the memo and chips the pieces had
    function inherit(out, pieces) {
        const memo = pieces.map((x) => (x.memo || '').trim()).filter(Boolean).join(' · ');
        const chips = [...new Set(pieces.flatMap((x) => x.chips || []))];
        if (!memo && !chips.length) return;
        App.catalog.update(out, (e) => {
            if (memo) e.memo = e.memo ? `${e.memo}\n${memo}` : memo;
            if (chips.length) e.chips = [...new Set([...(e.chips || []), ...chips])];
        }, { undoable: false });
    }

    async function maybeArchive(path) {
        if (!App.settings.get('video.archiveOriginal', false)) return;
        try {
            const parent = P.parent(path);
            const dir = P.join(parent, ARCHIVE_DIR);
            if (!(await App.fs.exists(dir))) await App.fs.mkdir(parent, ARCHIVE_DIR, { undoable: false });
            await App.fs.move([path], dir, { label: `원본 보관 · ${P.base(path)}` });
            ui.toast(`원본은 「${ARCHIVE_DIR}」 폴더로 옮겼어요`, { type: 'info', duration: 5000, action: { label: '되돌리기', run: () => App.undo.undo() } });
        } catch (e) {
            ui.toast(`원본을 옮기지 못했어요: ${e.message}`, { type: 'error' });
        }
    }

    function guard() {
        if (busy) {
            ui.toast(`${busy.label} 중이에요. 끝나면 다시 눌러 주세요`, { type: 'info' });
            return false;
        }
        return true;
    }

    // ---------- Actions ----------
    async function saveKept(path) {
        if (!guard()) return null;
        const { pieces, kept } = plan(path);
        if (!pieces.length || !kept.length) {
            ui.toast('먼저 Q·W·Ctrl+B로 잘라 주세요', { type: 'info' });
            return null;
        }
        const end = pieces[pieces.length - 1].end;
        if (kept.length === pieces.length && !pieces.some((x) => x.removed) && kept.length === 1 && kept[0].start < 0.01 && kept[0].end >= end - 0.01) {
            ui.toast('잘라낸 부분이 없어서 원본과 같아요', { type: 'info' });
            return null;
        }
        if (!pieces.some((x) => x.removed) && kept.length > 1) {
            // nothing removed, only split: the joined result equals the original
            ui.toast('잘라낸 부분이 없어서 원본과 같아요. 조각마다 저장하려면 「조각마다 새 파일로」를 골라 주세요', { type: 'info', duration: 5000 });
            return null;
        }
        const engine = engineFor(path);
        if (!engine) {
            needServer();
            return null;
        }
        busy = { label: '편집본 저장' };
        try {
            let out;
            if (engine === 'server') {
                out = kept.length === 1
                    ? await runSteps('편집본 저장', [{ op: 'trim', payload: { path, start: r3(kept[0].start), end: r3(kept[0].end), mode: trimMode() } }], '편집본을 새 파일로 저장했어요')
                    : await runSteps('편집본 저장', [{ op: 'concat', payload: { segments: kept.map((x) => ({ path, start: r3(x.start), end: r3(x.end) })) } }], '편집본을 이어 붙여 새 파일로 저장했어요');
            } else {
                out = await browserCut(path, kept.map((x) => [x.start, x.end]), '편집본 저장', 'edit', '편집본을 새 파일로 저장했어요 (화질 그대로)');
            }
            if (!out) return null;
            inherit(out, kept);
            await maybeArchive(path);
            return out;
        } finally {
            busy = null;
        }
    }

    async function savePieces(path) {
        if (!guard()) return [];
        const { pieces, kept } = plan(path);
        if (!pieces.length || !kept.length) {
            ui.toast('먼저 Q·W·Ctrl+B로 잘라 주세요', { type: 'info' });
            return [];
        }
        const engine = engineFor(path);
        if (!engine) {
            needServer();
            return [];
        }
        busy = { label: '조각 저장' };
        const outs = [];
        try {
            for (const [i, x] of kept.entries()) {
                const label = `조각 ${i + 1}/${kept.length} 저장`;
                const out = engine === 'server'
                    ? await runSteps(label, [{ op: 'trim', payload: { path, start: r3(x.start), end: r3(x.end), mode: trimMode() } }], '', { quiet: true })
                    : await browserCut(path, [[x.start, x.end]], label, 'part', '', { quiet: true });
                if (!out) break;
                inherit(out, [x]);
                outs.push(out);
            }
            if (outs.length) {
                ui.toast(outs.length === 1 ? `조각을 새 파일로 저장했어요 · ${P.base(outs[0])}` : `조각 ${outs.length}개를 새 파일로 저장했어요`, {
                    type: 'success',
                    duration: 6000,
                    action: { label: '보기', run: () => V.open(outs[0]) },
                });
                if (outs.length === kept.length) await maybeArchive(path);
            }
            return outs;
        } finally {
            busy = null;
        }
    }

    async function toClips(path) {
        if (!App.clips?.add) return null;
        const { kept } = plan(path);
        if (!kept.length) {
            ui.toast('먼저 Q·W·Ctrl+B로 잘라 주세요', { type: 'info' });
            return null;
        }
        try {
            const created = await App.clips.add(kept.map((x) => ({ path, start: r3(x.start), end: r3(x.end), title: '', memo: x.memo || '', chips: [...(x.chips || [])] })));
            const n = Array.isArray(created) ? created.length : kept.length;
            const open = App.commands.get('clips.open') ? { label: '보관함 열기', run: () => App.commands.run('clips.open') } : { label: '되돌리기', run: () => App.undo.undo() };
            ui.toast(`보관함에 ${n}개 담았어요`, { type: 'success', duration: 5000, action: open });
            return created;
        } catch (e) {
            ui.toast(`보관함에 담지 못했어요: ${e.message}`, { type: 'error' });
            return null;
        }
    }

    // ---------- Rotation / flip baked into a new video file (viewer "파일에 적용") ----------
    function viewTransformSteps(path, t = V.orientationOf(path)) {
        const steps = [];
        if (t.flipH || t.flipV) steps.push({ op: 'transform', payload: { path, op: t.flipH ? 'hflip' : 'vflip', mode: 'reencode' } });
        if (t.rot) steps.push({ op: 'transform', payload: { path, op: `rotate${t.rot}`, mode: 'metadata' } });
        return steps;
    }

    function canApplyViewTransform(entry) {
        return !!entry && entry.type === 'video' && serverState().ready;
    }

    async function applyViewTransform(entry, { ask = true } = {}) {
        if (!entry || entry.type !== 'video') return null;
        if (!serverState().ready) {
            ui.toast('영상 방향을 파일에 적용하려면 로컬 서버가 켜져 있어야 해요', { type: 'warning' });
            return null;
        }
        const t = V.orientationOf(entry.path);
        if (V.isIdentityTransform(t)) {
            ui.toast('먼저 R(회전)이나 H·V(반전)로 방향을 바꿔 주세요', { type: 'info' });
            return null;
        }
        const desc = V.describeTransform(t);
        if (ask) {
            const flips = t.flipH || t.flipV;
            const ok = await ui.dialog({
                title: `${desc} 방향으로 새 영상을 만들까요?`,
                body: h('div', { class: 'vw-apply-body' },
                    h('p', { text: flips ? '반전은 영상을 다시 인코딩해서 만들어요. 길이에 따라 시간이 걸릴 수 있어요.' : '회전은 화질 손실 없이 방향 정보만 바꿔서 만들어요.' }),
                    h('div', { class: 'vw-apply-note', html: `${ui.icon('check-circle', { size: 15 })}<span>원본은 그대로 두고 <b>${escapeHtml(P.stem(entry.name))}_rot</b> 같은 새 파일로 저장해요. 실행 취소(${escapeHtml(V.dk('Mod+Z'))})로 새 파일을 지울 수 있어요.</span>` })),
                dismissValue: false,
                actions: [
                    { label: '취소', value: false, kind: 'ghost' },
                    { label: '새 파일로 저장', value: true, kind: 'primary', autofocus: true },
                ],
            });
            if (!ok) return null;
        }
        return runSteps('방향 적용', viewTransformSteps(entry.path, t), `${desc} 방향으로 저장했어요`);
    }

    App.videoEditor = {
        saveKept,
        savePieces,
        toClips,
        serverState,
        engineFor,
        get busy() {
            return !!busy;
        },
        viewTransformSteps,
        canApplyViewTransform,
        applyViewTransform,
        _needServer: needServer,
    };
})();
