/*
 * Video editing right in the viewer — no panel, no mode: the player's seek bar IS the edit track (owner feedback r2:
 * '편집을 모달로 빼지 말고 뷰어에서 바로', 'Q·W로 앞뒤 날리고 Ctrl+B 면도날로 트랙 자르는 정도면 돼').
 *   Q        cut away everything before the playhead (inside the current piece)
 *   W        cut away everything after the playhead (inside the current piece)
 *   Mod+B    split at the playhead (razor)
 *   click    a piece on the bar selects it → a compact strip right above the bar: memo (#tags), chips, play, 보관함,
 *            join with the previous piece, remove/restore. Drag a cut line to move it.
 *   Delete / Backspace   remove the selected piece (on a removed piece: bring it back)
 *   P        편집본 미리보기 on/off — playback jumps over removed parts and stops after the last kept piece
 *   G        보관함에 담기: the selected piece, else [playhead − 15 s, playhead + 5 s] (settings video.clipBefore/After);
 *            without App.clips it leaves a marker instead
 *   E        edit key hints · Shift+S save menu · Esc deselects the piece
 * Guards: edit keys wait until the duration is known, never fire while typing (memo field), and an edit made for a
 *   different version of the file (size/mtime changed) is not applied: '원본이 바뀌었어요' with 그래도 적용 / 편집 지우기.
 *
 * Edit state (ARCHITECTURE §8 — viewer team owns the format), App.catalog meta.edit =
 *   { cuts: [t…], removed: [[a, b]…], pieces?: { "<start>": { memo, chips } }, src: { size, mtime }, updatedAt }
 *   seconds with 3 decimals. Every change is ONE App.catalog.update → one Ctrl+Z / Ctrl+Y.
 *
 * App.videoEdit — {
 *   piecesOf(path, duration?) → [{ start, end, removed, memo, chips, number, index }], listFor(path), keptOf(path),
 *   isEdited(path), isStale(path), selected() → {path, start, end, …}|null, select(path, start, {seek, focusMemo}),
 *   deselect() → bool, cutBefore(), cutAfter(), split(), removeSelected() → bool, setPieceInfo(path, start, patch),
 *   reset(path), addClip(), openSaveMenu(anchor), render(bar, player), pointerAt(player, t), hintMode, hints()
 * }
 * Events: 'viewer:piece-select' { path, start|null }
 */
(() => {
    'use strict';
    const { h, clamp, escapeHtml } = App.util;
    const ui = App.ui;
    const V = App.viewer;

    const EPS = 0.05; // closest a Q/W/split may get to a piece boundary (s)
    const r3 = (t) => Math.round(t * 1000) / 1000;
    const keyOf = (t) => String(r3(t));
    const fmt = (t, precise = false) => (V.fmtTime ? V.fmtTime(t, precise) : String(t));
    const fmtLen = (sec) => (sec < 60 ? `${(Math.round(Math.max(0, sec) * 10) / 10).toFixed(1)}초` : fmt(sec));
    const undoKey = () => App.commands.displayKeys('edit.undo') || 'Ctrl+Z';
    const HUD_MS = 1500;

    let sel = null; // { path, at } — `at` is a time inside the selected piece (survives merges/splits)
    let strip = null; // { key, el, memo, ... } inline strip for the selected piece
    let hintMode = false;
    const stats = new Map(); // path -> { size, mtime } of the file on disk (for the stale check)
    const verified = new Set(); // paths whose stat was read since they were opened in the viewer
    const pendingStat = new Map(); // path -> Promise

    // =====================================================================================================
    // Model
    // =====================================================================================================
    function rawEdit(path) {
        return App.catalog.peek(path)?.meta?.edit || null;
    }

    function hasEdit(e) {
        return !!e && ((Array.isArray(e.cuts) && e.cuts.length > 0) || (Array.isArray(e.removed) && e.removed.length > 0));
    }

    function durationOf(path) {
        const p = V.player;
        if (p && p.path === path && p.metaReady && Number.isFinite(p.duration) && p.duration > 0) return p.duration;
        const d = App.catalog.peek(path)?.meta?.duration;
        return Number.isFinite(d) && d > 0 ? d : 0;
    }

    function piecesFrom(edit, d) {
        if (!(d > 0)) return [];
        const cuts = [...new Set((edit?.cuts || []).map(Number).filter(Number.isFinite).map(r3))].filter((c) => c > 0.001 && c < d - 0.001).sort((a, b) => a - b);
        const bounds = [0, ...cuts, d];
        const removed = Array.isArray(edit?.removed) ? edit.removed : [];
        const info = edit?.pieces || {};
        const out = [];
        let n = 0;
        for (let i = 0; i < bounds.length - 1; i++) {
            const a = bounds[i];
            const b = bounds[i + 1];
            const mid = (a + b) / 2;
            const isRemoved = removed.some((r) => Array.isArray(r) && mid > r[0] && (mid < r[1] || r[1] >= d - EPS));
            const pi = info[keyOf(a)] || {};
            out.push({ start: a, end: b, removed: isRemoved, memo: pi.memo || '', chips: Array.isArray(pi.chips) ? pi.chips : [], number: isRemoved ? 0 : ++n, index: i });
        }
        return out;
    }

    // Cuts stay even between two removed pieces (Delete twice brings back exactly that piece); removed ranges are merged runs.
    function editFrom(pieces, src) {
        const cuts = pieces.slice(1).map((p) => r3(p.start));
        const removed = [];
        for (const p of pieces) {
            if (!p.removed) continue;
            const last = removed[removed.length - 1];
            if (last && Math.abs(last[1] - r3(p.start)) < 0.0005) last[1] = r3(p.end);
            else removed.push([r3(p.start), r3(p.end)]);
        }
        if (!removed.length && !cuts.length) return null;
        const info = {};
        for (const p of pieces) {
            const memo = (p.memo || '').trim() ? p.memo : '';
            if (memo || (p.chips && p.chips.length)) info[keyOf(p.start)] = { memo, chips: [...(p.chips || [])] };
        }
        const out = { cuts, removed, updatedAt: Date.now() };
        if (Object.keys(info).length) out.pieces = info;
        if (src) out.src = src;
        return out;
    }

    function srcStamp(path) {
        const s = stats.get(path);
        if (s) return { size: s.size ?? null, mtime: s.mtime ?? null };
        const e = V.current?.path === path ? V.current : App.view?.get?.(path);
        return e && Number.isFinite(e.size) ? { size: e.size, mtime: Number.isFinite(e.mtime) ? e.mtime : null } : null;
    }

    /**
     * 'ok' | 'pending' | 'stale'. A saved edit is applied only after the file on disk was checked in THIS opening
     * (size + mtime against edit.src). mtime may differ by up to 2 s: FAT/exFAT drives store it in 2-second steps and the
     * local server reports it through another API.
     */
    function verifyState(path) {
        const e = rawEdit(path);
        if (!hasEdit(e) || !e.src) return 'ok';
        if (!verified.has(path)) return 'pending';
        const s = stats.get(path);
        if (!s) return 'ok'; // stat failed (gone/unreadable): nothing to compare against
        if (e.src.size != null && s.size != null && e.src.size !== s.size) return 'stale';
        if (e.src.mtime != null && s.mtime != null && Math.abs(e.src.mtime - s.mtime) > 2000) return 'stale';
        return 'ok';
    }

    function isStale(path) {
        return verifyState(path) === 'stale';
    }

    function refreshStat(path) {
        if (pendingStat.has(path)) return pendingStat.get(path);
        const run = (async () => {
            try {
                const st = await App.fs.stat(path);
                if (st) stats.set(path, { size: st.size, mtime: st.mtime });
                else stats.delete(path);
            } catch (e) {
                stats.delete(path);
            }
            verified.add(path);
            pendingStat.delete(path);
            if (V.player?.path === path) rerender();
        })();
        pendingStat.set(path, run);
        return run;
    }

    function piecesOf(path, d = durationOf(path)) {
        const e = rawEdit(path);
        return hasEdit(e) && verifyState(path) === 'ok' ? piecesFrom(e, d) : [];
    }

    /** One undo step: write meta.edit (null removes it). */
    function commit(path, pieces, label, { hud, icon = 'scissors', coalesceKey = null } = {}) {
        const prev = rawEdit(path);
        const edit = pieces ? editFrom(pieces, prev?.src || srcStamp(path)) : null;
        // Joining the last two pieces leaves the whole video as one piece: its memo/chips move onto the file itself
        // (same undo step) instead of vanishing with the edit record.
        const left = pieces && !edit ? pieces.filter((x) => !x.removed) : [];
        const memo = left.map((x) => (x.memo || '').trim()).filter(Boolean).join(' · ');
        const chips = [...new Set(left.flatMap((x) => x.chips || []))];
        App.catalog.update(path, (entry) => {
            const meta = { ...(entry.meta || {}) };
            if (edit) meta.edit = edit;
            else delete meta.edit;
            entry.meta = meta;
            if (memo) entry.memo = entry.memo ? `${entry.memo}\n${memo}` : memo;
            if (chips.length) entry.chips = [...new Set([...(entry.chips || []), ...chips])];
        }, { label, coalesceKey });
        if (hud) V.osd(memo || chips.length ? `${hud} · 메모는 파일 메모로 옮겼어요` : hud, { icon, duration: HUD_MS });
    }

    // A memo still being typed is written before anything else changes the pieces (its own coalesced undo step),
    // and a strip that goes away never writes later.
    let flushing = false;
    function flushStrip() {
        if (flushing || !strip?.flush) return;
        flushing = true;
        try {
            strip.flush();
        } finally {
            flushing = false;
        }
    }

    function disposeStrip() {
        flushStrip();
        strip?.cancel?.();
        strip = null;
    }

    // =====================================================================================================
    // Selection
    // =====================================================================================================
    function locate(pieces, t) {
        return pieces.find((x, i) => t >= x.start - 1e-6 && (t < x.end || i === pieces.length - 1)) || null;
    }

    function selectedPiece(pieces) {
        if (!sel || V.player?.path !== sel.path) return null;
        return locate(pieces || piecesOf(sel.path), sel.at);
    }

    function setSel(next, { silent = false } = {}) {
        flushStrip();
        const before = sel ? `${sel.path}|${sel.at}` : '';
        sel = next;
        if (!silent && before !== (sel ? `${sel.path}|${sel.at}` : '')) {
            rerender();
            App.bus.emit('viewer:piece-select', { path: sel?.path ?? null, start: selectedPiece()?.start ?? null });
        }
    }

    function selectAt(path, t) {
        const pieces = piecesOf(path);
        const x = locate(pieces, t);
        if (!x || pieces.length < 2) return setSel(null);
        setSel({ path, at: (x.start + x.end) / 2 });
    }

    function rerender() {
        if (V.player && barRef) render(barRef, V.player);
    }

    // =====================================================================================================
    // Edit actions
    // =====================================================================================================
    function ctx() {
        const p = V.player;
        if (!V.isOpen || V.kind !== 'video' || !p || p.failed || !p.metaReady) return null;
        const d = p.duration;
        if (!Number.isFinite(d) || !(d > 0)) return null;
        const path = p.path;
        if (verifyState(path) !== 'ok') return null;
        flushStrip();
        const pieces = piecesFrom(rawEdit(path), d);
        return { p, path, d, t: clamp(p.time, 0, d), pieces: pieces.length ? pieces : [{ start: 0, end: d, removed: false, memo: '', chips: [], number: 1, index: 0 }] };
    }

    function cutBefore() {
        const c = ctx();
        if (!c) return;
        const x = locate(c.pieces, c.t);
        if (!x) return;
        if (x.removed) return V.osd('이미 잘라낸 부분이에요', { icon: 'scissors' });
        if (c.t - x.start < EPS) return V.osd('조각의 맨 앞이에요', { icon: 'scissors' });
        if (x.end - c.t < EPS) return V.osd('남는 부분이 너무 짧아요', { icon: 'scissors' });
        const next = c.pieces.flatMap((y) => (y === x ? [{ ...y, end: c.t, removed: true, memo: '', chips: [] }, { ...y, start: c.t }] : [y]));
        setSel(null, { silent: true });
        commit(c.path, next, `앞부분 잘라내기 ${fmt(c.t)}`, { hud: `앞부분 ${fmtLen(c.t - x.start)} 잘라냄 · ${undoKey()}` });
    }

    function cutAfter() {
        const c = ctx();
        if (!c) return;
        const x = locate(c.pieces, c.t);
        if (!x) return;
        if (x.removed) return V.osd('이미 잘라낸 부분이에요', { icon: 'scissors' });
        if (x.end - c.t < EPS) return V.osd('조각의 맨 끝이에요', { icon: 'scissors' });
        if (c.t - x.start < EPS) return V.osd('남는 부분이 너무 짧아요', { icon: 'scissors' });
        const next = c.pieces.flatMap((y) => (y === x ? [{ ...y, end: c.t }, { ...y, start: c.t, removed: true, memo: '', chips: [] }] : [y]));
        setSel(null, { silent: true });
        commit(c.path, next, `뒷부분 잘라내기 ${fmt(c.t)}`, { hud: `뒷부분 ${fmtLen(x.end - c.t)} 잘라냄 · ${undoKey()}` });
    }

    function split() {
        const c = ctx();
        if (!c) return;
        const x = locate(c.pieces, c.t);
        if (!x) return;
        if (x.removed) return V.osd('잘라낸 부분은 나눌 필요가 없어요', { icon: 'scissors' });
        if (c.t - x.start < EPS || x.end - c.t < EPS) return V.osd('조각 경계와 너무 가까워요', { icon: 'scissors' });
        const next = c.pieces.flatMap((y) => (y === x ? [{ ...y, end: c.t }, { ...y, start: c.t, memo: '', chips: [] }] : [y]));
        setSel(null, { silent: true });
        commit(c.path, next, `자르기 ${fmt(c.t)}`, { hud: `${fmt(c.t, true)}에서 잘랐어요 · ${undoKey()}` });
    }

    /** Delete key: remove the selected piece, or bring a removed one back. Returns true when it handled the key. */
    function removeSelected() {
        const c = ctx();
        if (!c) return false;
        const x = selectedPiece(c.pieces);
        if (!x) return false;
        if (!x.removed) {
            if (c.pieces.filter((y) => !y.removed).length <= 1) {
                V.osd('마지막 남은 조각은 뺄 수 없어요', { icon: 'scissors', duration: HUD_MS });
                return true;
            }
            commit(c.path, c.pieces.map((y) => (y === x ? { ...y, removed: true } : y)), '조각 빼기', { hud: `조각을 뺐어요 (${fmtLen(x.end - x.start)}) · ${undoKey()}`, icon: 'x' });
        } else {
            commit(c.path, c.pieces.map((y) => (y === x ? { ...y, removed: false } : y)), '조각 되살리기', { hud: '잘라낸 부분을 되살렸어요', icon: 'refresh' });
        }
        return true;
    }

    /** Join the selected piece with the previous kept piece (removes the cut between them). */
    function joinSelected() {
        const c = ctx();
        if (!c) return;
        const x = selectedPiece(c.pieces);
        if (!x) return;
        const i = c.pieces.indexOf(x);
        const prev = c.pieces[i - 1];
        if (!prev || prev.removed || x.removed) {
            V.osd('바로 앞 조각과만 합칠 수 있어요', { icon: 'merge' });
            return;
        }
        const joined = { ...prev, end: x.end, memo: [prev.memo, x.memo].filter((m) => m && m.trim()).join(' '), chips: [...new Set([...prev.chips, ...x.chips])] };
        const next = c.pieces.filter((y) => y !== x).map((y) => (y === prev ? joined : y));
        commit(c.path, next, '조각 합치기', { hud: `조각을 합쳤어요 · ${undoKey()}`, icon: 'merge' });
    }

    function moveCut(path, from, to) {
        flushStrip();
        const d = durationOf(path);
        const pieces = piecesOf(path, d);
        const i = pieces.findIndex((x) => Math.abs(x.start - from) < 0.0005);
        if (i < 1) return;
        const lo = pieces[i - 1].start + EPS;
        const hi = pieces[i].end - EPS;
        const t = r3(clamp(to, lo, hi));
        if (Math.abs(t - from) < 0.001) return;
        const next = pieces.map((x, k) => (k === i - 1 ? { ...x, end: t } : k === i ? { ...x, start: t } : x));
        if (sel && sel.path === path) {
            const s = locate(next, sel.at);
            if (s) sel = { path, at: (s.start + s.end) / 2 };
        }
        commit(path, next, '조각 경계 옮기기', { hud: `경계 ${fmt(t, true)}` });
    }

    function setPieceInfo(path, start, patch, { coalesceKey = null, label = '조각 메모' } = {}) {
        flushStrip();
        const pieces = piecesOf(path);
        const x = pieces.find((y) => Math.abs(y.start - start) < 0.0005);
        if (!x) return;
        const next = pieces.map((y) => (y === x ? { ...y, ...patch } : y));
        commit(path, next, label, { coalesceKey });
    }

    function reset(path = V.player?.path) {
        if (!path || !hasEdit(rawEdit(path))) return;
        setSel(null, { silent: true });
        commit(path, null, '편집 원래대로', { hud: `원래대로 돌렸어요 · ${undoKey()}`, icon: 'refresh' });
    }

    function acceptStale(path) {
        const e = rawEdit(path);
        if (!e) return;
        const s = stats.get(path);
        App.catalog.update(path, (entry) => {
            entry.meta = { ...(entry.meta || {}), edit: { ...e, src: s ? { size: s.size, mtime: s.mtime } : null, updatedAt: Date.now() } };
        }, { label: '바뀐 원본에 편집 적용' });
    }

    function togglePreview() {
        const on = !(App.settings.get('video.previewEdit', true) !== false);
        App.settings.set('video.previewEdit', on);
        const p = V.player;
        rerender();
        V.osd(on ? '편집본 미리보기 · 잘라낸 부분은 건너뛰어요' : '원본 그대로 보기', { icon: on ? 'eye' : 'eye-off', duration: HUD_MS });
        if (on && p && p.editBounds) {
            const pieces = piecesOf(p.path);
            const cur = locate(pieces, p.time);
            if (!cur || cur.removed) p.seek(p.editBounds.first);
            p.play();
        }
    }

    // ---------- 보관함 (G) ----------
    async function addClip() {
        const p = V.player;
        if (!p || !p.metaReady) return;
        const path = p.path;
        const d = p.duration;
        const t = p.time;
        const x = selectedPiece();
        let range;
        if (x && !x.removed) range = { start: x.start, end: x.end, memo: x.memo, chips: x.chips };
        else {
            const before = clamp(Number(App.settings.get('video.clipBefore', 15)) || 15, 1, 600);
            const after = clamp(Number(App.settings.get('video.clipAfter', 5)) || 5, 0, 600);
            range = { start: Math.max(0, t - before), end: Math.min(d || t + after, t + after), memo: '', chips: [] };
        }
        if (!(range.end - range.start > 0.2)) return V.osd('담을 구간이 너무 짧아요', { icon: 'scissors' });
        if (!App.clips?.add) {
            p.addMarker({ popover: false, at: t });
            V.osd(`마커로 남겼어요 · ${fmt(t)} (보관함이 아직 없어요)`, { icon: 'bookmark', duration: HUD_MS });
            return;
        }
        let created;
        try {
            created = await App.clips.add({ path, start: r3(range.start), end: r3(range.end), title: '', memo: range.memo || '', chips: [...(range.chips || [])] });
        } catch (e) {
            ui.toast(`보관함에 담지 못했어요: ${e.message}`, { type: 'error' });
            return;
        }
        const clip = Array.isArray(created) ? created[0] : created;
        V.osd(`보관함에 담았어요 · ${fmt(range.start)}–${fmt(range.end)}`, { icon: 'check', duration: HUD_MS });
        const toast = ui.toast(`보관함에 담았어요 · ${fmt(range.start)}–${fmt(range.end)}`, {
            type: 'success',
            id: 'video-clip-added',
            duration: 6000,
            action: clip && App.clips.update ? { label: '메모 쓰기', run: () => writeClipMemo(clip) } : null,
        });
        // second action: undo (core toasts carry one action — integration request for `actions`)
        const undoBtn = h('button', { class: 'toast-action', text: '되돌리기', onclick: () => {
            toast.close();
            App.undo.undo();
        } });
        toast.el?.querySelector('.toast-close')?.before(undoBtn);
    }

    async function writeClipMemo(clip) {
        const memo = await ui.prompt({ title: '클립 메모', message: '#태그를 붙이면 보관함에서 찾기 쉬워요.', value: clip.memo || '', okLabel: '저장' });
        if (memo == null) return;
        try {
            await App.clips.update(clip.id, { memo: String(memo).trim() });
        } catch (e) {
            ui.toast(`메모를 저장하지 못했어요: ${e.message}`, { type: 'error' });
        }
    }

    // =====================================================================================================
    // Rendering: track, strip, state, toolbar button
    // =====================================================================================================
    let barRef = null;

    function render(bar, p) {
        barRef = bar;
        if (!bar?.el || !p) return;
        const path = p.path;
        if (!verified.has(path)) refreshStat(path);
        const d = p.metaReady && Number.isFinite(p.duration) && p.duration > 0 ? p.duration : 0;
        const e = rawEdit(path);
        const state = verifyState(path);
        const stale = state === 'stale';
        const pieces = d && hasEdit(e) && state === 'ok' ? piecesFrom(e, d) : [];
        const edited = pieces.length > 0;
        if (sel && (sel.path !== path || !edited)) sel = null;
        const selX = edited ? selectedPiece(pieces) : null;

        // playback: jump over removed parts while '편집본 미리보기' is on
        const preview = App.settings.get('video.previewEdit', true) !== false;
        const kept = pieces.filter((x) => !x.removed);
        p.skip = edited && preview ? editFrom(pieces).removed.map(([a, b]) => [a, b >= d - EPS ? d : b]) : null;
        p.editBounds = edited && kept.length ? { first: kept[0].start, last: kept[kept.length - 1].end } : null;

        bar.seekEl.classList.toggle('has-edit', edited);
        const pct = (t) => (d ? clamp((t / d) * 100, 0, 100) : 0);
        bar.editEl.textContent = '';
        bar.cutsEl.textContent = '';
        if (edited) {
            for (const x of pieces) {
                bar.editEl.append(h('div', {
                    class: `vw-piece${x.removed ? ' is-removed' : ''}${x === selX ? ' is-selected' : ''}${x.memo || x.chips.length ? ' has-note' : ''}`,
                    style: { left: `${pct(x.start)}%`, width: `${pct(x.end) - pct(x.start)}%` },
                    dataset: { start: String(x.start) },
                }));
            }
            for (let i = 1; i < pieces.length; i++) {
                if (pieces[i - 1].removed && pieces[i].removed) continue;
                const c = h('div', { class: 'vw-cut', style: { left: `${pct(pieces[i].start)}%` }, dataset: { t: String(pieces[i].start) }, 'aria-label': `경계 ${fmt(pieces[i].start, true)}` });
                bindCutDrag(c, bar, p, pieces[i].start);
                bar.cutsEl.append(c);
            }
        }
        renderStrip(bar, p, pieces, selX, stale);
        renderState(bar, edited, kept.length, pieces.length, preview);
        syncToolbar(path, edited);
    }


    function bindCutDrag(el, bar, p, from) {
        el.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            el.setPointerCapture(e.pointerId);
            el.classList.add('is-dragging');
            const wasPlaying = p.playing;
            if (wasPlaying) p.video.pause();
            let to = from;
            let raf = 0;
            const move = (ev) => {
                to = bar.timeAt(ev.clientX);
                const d = p.duration || 1;
                el.style.left = `${clamp((to / d) * 100, 0, 100)}%`;
                if (!raf) {
                    raf = requestAnimationFrame(() => {
                        raf = 0;
                        p.seek(to);
                    });
                }
            };
            const up = () => {
                el.removeEventListener('pointermove', move);
                el.removeEventListener('pointerup', up);
                el.removeEventListener('pointercancel', up);
                el.classList.remove('is-dragging');
                cancelAnimationFrame(raf);
                if (Math.abs(to - from) > 0.01) moveCut(p.path, from, to);
                else rerender();
                if (wasPlaying) p.play();
            };
            el.addEventListener('pointermove', move);
            el.addEventListener('pointerup', up);
            el.addEventListener('pointercancel', up);
        });
    }

    function chipInfo(id) {
        const all = App.chipset?.list?.() || [];
        return all.find((c) => c.id === id) || null;
    }

    function chipPill(path, x, id) {
        const info = chipInfo(id);
        return h('span', {
            class: 'vw-chip-pill',
            style: `--c:${info?.color ? `var(--label-${info.color})` : 'var(--accent)'}`,
            'data-tip': info?.label || App.chipset?.nameOf?.(id) || '',
        },
            h('span', { text: App.chipset?.nameOf?.(id) || '칩' }),
            h('button', {
                class: 'vw-chip-x',
                'aria-label': '칩 빼기',
                html: ui.icon('x', { size: 10 }),
                onmousedown: (e) => e.preventDefault(),
                onclick: () => setPieceInfo(path, x.start, { chips: x.chips.filter((c) => c !== id) }, { label: '조각 칩 빼기' }),
            }));
    }

    function stripButton(icon, tip, keys, onclick, cls = '') {
        const b = V.button(icon, tip, keys, onclick, { class: `sm ${cls}` });
        return b;
    }

    function renderStrip(bar, p, pieces, x, stale) {
        const host = bar.pieceHost;
        const path = p.path;
        if (stale) {
            const key = `stale|${path}`;
            if (strip?.key !== key || !host.contains(strip.el)) {
                host.textContent = '';
                const el = h('div', { class: 'vw-pstrip is-stale', role: 'status' },
                    h('span', { class: 'vw-pstrip-warn', html: ui.icon('alert', { size: 15 }) }),
                    h('span', { class: 'vw-pstrip-text', text: '원본이 바뀌었어요. 예전에 자른 위치가 맞지 않을 수 있어서 편집을 적용하지 않았어요.' }),
                    h('div', { class: 'grow' }),
                    h('button', { class: 'btn sm ghost', text: '편집 지우기', onmousedown: (e) => e.preventDefault(), onclick: () => {
                        const e = rawEdit(path);
                        if (!e) return;
                        App.catalog.update(path, (entry) => {
                            const meta = { ...(entry.meta || {}) };
                            delete meta.edit;
                            entry.meta = meta;
                        }, { label: '편집 지우기' });
                    } }),
                    h('button', { class: 'btn sm', text: '그래도 적용', onmousedown: (e) => e.preventDefault(), onclick: () => acceptStale(path) }));
                host.append(el);
                strip = { key, el };
            }
            host.hidden = false;
            return;
        }
        if (!x) {
            if (host.contains(document.activeElement)) V.root?.focus({ preventScroll: true });
            host.hidden = true;
            host.textContent = '';
            strip?.cancel?.(); // never write later from a strip that is gone (flushes happen before edits)
            strip = null;
            return;
        }
        const key = `${path}|${x.start}|${x.removed}`;
        if (strip?.key !== key || !host.contains(strip.el)) {
            host.textContent = '';
            strip?.cancel?.();
            strip = buildStrip(path, x, pieces);
            strip.key = key;
            host.append(strip.el);
        }
        updateStrip(strip, path, x, pieces);
        host.hidden = false;
    }

    function buildStrip(path, x, pieces) {
        const s = { path, start: x.start };
        s.tag = h('span', { class: 'vw-pstrip-tag' });
        s.range = h('span', { class: 'vw-pstrip-range' });
        s.memo = h('input', {
            class: 'input sm vw-pstrip-memo',
            type: 'text',
            placeholder: x.removed ? '잘라낸 이유 (선택)' : '이 조각 메모 · #태그로 나중에 찾기',
            spellcheck: 'false',
            'aria-label': '조각 메모',
        });
        s.memo.value = x.memo || '';
        const save = App.util.debounce(() => flushMemo(s), 350);
        s.cancel = () => save.cancel?.();
        s.flush = () => {
            save.cancel?.();
            flushMemo(s);
        };
        s.memo.addEventListener('input', save);
        s.memo.addEventListener('blur', () => s.flush());
        s.memo.addEventListener('keydown', (e) => {
            if (e.isComposing) return;
            if (e.key === 'Enter' || e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                s.flush();
                V.root?.focus({ preventScroll: true });
            }
        });
        s.chips = h('div', { class: 'vw-pstrip-chips' });
        s.addChip = App.chipset?.list ? h('button', {
            class: 'btn ghost sm vw-pstrip-addchip',
            html: `${ui.icon('plus', { size: 12 })}<span>칩</span>`,
            'data-tip': '이 조각에 칩 붙이기',
            onmousedown: (e) => e.preventDefault(),
            onclick: (e) => openChipPicker(e.currentTarget, path, s.start),
        }) : null;
        s.play = stripButton('play', '이 조각만 재생', null, () => {
            const cur = selectedPiece();
            if (cur) App.viewer.openAt?.(path, { start: cur.start, end: cur.end });
        });
        s.clip = App.clips?.add ? stripButton('vw-clip', '보관함에 담기', 'G', () => App.commands.run('video.clip')) : null;
        s.join = stripButton('merge', '앞 조각과 합치기', null, () => joinSelected());
        s.remove = stripButton('trash', '이 조각 빼기', 'Delete', () => removeSelected());
        s.close = stripButton('x', '선택 해제', 'Escape', () => setSel(null));
        s.el = h('div', { class: 'vw-pstrip', role: 'group', 'aria-label': '선택한 조각' },
            s.tag, s.range, s.memo, s.chips, s.addChip,
            h('span', { class: 'vw-sep' }),
            s.play, s.clip, s.join, s.remove, s.close);
        return s;
    }

    function flushMemo(s) {
        const x = piecesOf(s.path).find((y) => Math.abs(y.start - s.start) < 0.0005);
        if (!x) return;
        const memo = s.memo.value;
        if ((x.memo || '') === memo) return;
        setPieceInfo(s.path, s.start, { memo }, { coalesceKey: `pmemo:${s.path}:${s.start}`, label: '조각 메모' });
    }

    function updateStrip(s, path, x, pieces) {
        s.el.classList.toggle('is-removed', x.removed);
        s.tag.textContent = x.removed ? '잘라낸 부분' : `조각 ${x.number}/${pieces.filter((y) => !y.removed).length}`;
        const precise = x.end - x.start < 10;
        s.range.textContent = `${fmt(x.start, precise)} – ${fmt(x.end, precise)} · ${fmtLen(x.end - x.start)}`;
        if (document.activeElement !== s.memo && s.memo.value !== (x.memo || '')) s.memo.value = x.memo || '';
        s.chips.textContent = '';
        for (const id of x.chips) s.chips.append(chipPill(path, x, id));
        s.chips.hidden = !x.chips.length;
        const i = pieces.indexOf(x);
        const canJoin = !x.removed && i > 0 && !pieces[i - 1].removed;
        s.join.hidden = !canJoin;
        if (s.clip) s.clip.hidden = x.removed;
        s.play.hidden = false;
        s.remove.innerHTML = V.icon(x.removed ? 'refresh' : 'trash');
        s.remove.dataset.tip = x.removed ? '되살리기' : '이 조각 빼기';
        s.remove.setAttribute('aria-label', s.remove.dataset.tip);
    }

    // ---------- chip picker for one piece (feature-detects App.chipset) ----------
    let chipPop = null;

    function openChipPicker(anchor, path, start) {
        const C = App.chipset;
        if (!C?.list) return;
        chipPop?.close();
        const all = C.list() || [];
        const input = h('input', { class: 'input sm', type: 'text', placeholder: '칩 이름 · 초성으로도 찾아요', spellcheck: 'false' });
        const list = h('div', { class: 'vw-chip-list', role: 'listbox' });
        let active = 0;
        let rows = [];
        const current = () => piecesOf(path).find((y) => Math.abs(y.start - start) < 0.0005);
        const toggle = (id) => {
            const x = current();
            if (!x) return;
            const has = x.chips.includes(id);
            setPieceInfo(path, start, { chips: has ? x.chips.filter((c) => c !== id) : [...x.chips, id] }, { label: has ? '조각 칩 빼기' : '조각 칩 붙이기' });
            draw();
        };
        const draw = () => {
            const q = input.value.trim();
            const x = current();
            rows = all
                .map((c) => ({ c, m: q ? (C.match ? C.match(q, c.label || c.name) : App.util.matchKo(q, c.label || c.name)) : { score: 0 } }))
                .filter((r) => r.m)
                .sort((a, b) => (b.m.score || 0) - (a.m.score || 0))
                .slice(0, 9)
                .map((r) => r.c);
            active = clamp(active, 0, Math.max(0, rows.length - 1));
            list.textContent = '';
            if (!rows.length) {
                list.append(h('div', { class: 'vw-chip-empty', text: all.length ? '맞는 칩이 없어요' : '아직 칩이 없어요. 칩 패널에서 먼저 만들어 주세요.' }));
                return;
            }
            rows.forEach((c, i) => {
                const on = !!x?.chips.includes(c.id);
                list.append(h('button', {
                    class: `vw-chip-opt${i === active ? ' is-active' : ''}${on ? ' is-on' : ''}`,
                    role: 'option',
                    'aria-selected': on ? 'true' : 'false',
                    onmousedown: (e) => e.preventDefault(),
                    onclick: () => toggle(c.id),
                },
                    h('span', { class: 'vw-chip-dot', style: `--c:${c.color ? `var(--label-${c.color})` : 'var(--accent)'}` }),
                    h('span', { class: 'vw-chip-name truncate', text: c.label || c.name }),
                    on ? h('span', { class: 'vw-chip-check', html: ui.icon('check', { size: 13 }) }) : null));
            });
        };
        input.addEventListener('input', () => {
            active = 0;
            draw();
        });
        input.addEventListener('keydown', (e) => {
            if (e.isComposing) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                active = clamp(active + (e.key === 'ArrowDown' ? 1 : -1), 0, Math.max(0, rows.length - 1));
                draw();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (rows[active]) toggle(rows[active].id);
            }
        });
        const box = h('div', { class: 'vw-chip-pop' }, input, list);
        const pop = ui.popover(anchor, box, { above: true, align: 'end', class: 'vw-chip-popover', padding: '8px', onClose: () => {
            if (chipPop === pop) chipPop = null;
            V.root?.focus({ preventScroll: true });
        } });
        chipPop = pop;
        draw();
        requestAnimationFrame(() => input.focus());
    }

    // ---------- '편집됨' state in the control row ----------
    function renderState(bar, edited, keptCount, total, preview) {
        const host = bar.editState;
        if (!host) return;
        host.hidden = !edited;
        if (!edited) {
            host.textContent = '';
            host._sig = '';
            return;
        }
        const sig = `${keptCount}|${total}|${preview}`;
        if (host._sig === sig) return;
        host._sig = sig;
        host.textContent = '';
        host.append(
            h('button', {
                class: 'vw-edit-badge',
                'data-tip': '편집됨 — 저장·원래대로',
                'data-tip-keys': 'Shift+S',
                html: `${ui.icon('scissors', { size: 12 })}<span>편집됨</span><span class="vw-edit-count">${keptCount}조각</span>`,
                onmousedown: (e) => e.preventDefault(),
                onclick: (e) => openSaveMenu(e.currentTarget),
            }),
            V.button(preview ? 'eye' : 'eye-off', preview ? '편집본 미리보기 켜짐 (잘라낸 부분 건너뛰기)' : '편집본 미리보기 꺼짐 (원본 그대로)', 'P', () => App.commands.run('video.previewEdit'), { class: `sm vw-preview-btn${preview ? ' active' : ''}` }),
            V.button('vw-reset-orient', '원래대로 (편집 모두 지우기)', null, () => App.commands.run('video.resetEdit'), { class: 'sm vw-reset-btn' }));
    }

    // ---------- toolbar '저장' button (viewer top bar) ----------
    let saveBtn = null;

    function makeSaveBtn() {
        if (saveBtn) return saveBtn;
        saveBtn = h('button', {
            class: 'btn sm vw-save-btn',
            'data-tip': '편집본 저장 · 보관함',
            'data-tip-keys': 'Shift+S',
            html: `${V.icon('vw-save', { size: 14 })}<span>저장</span>${ui.icon('chevron-down', { size: 13, class: 'vw-save-caret' })}`,
            onmousedown: (e) => e.preventDefault(),
            onclick: (e) => openSaveMenu(e.currentTarget),
        });
        return saveBtn;
    }

    function syncToolbar(path, edited) {
        if (!saveBtn) return;
        saveBtn.classList.toggle('primary', !!edited);
        saveBtn.classList.toggle('is-edited', !!edited);
    }

    V.toolbarItems.push((entry) => {
        if (!entry || entry.type !== 'video') return [];
        const b = makeSaveBtn();
        syncToolbar(entry.path, piecesOf(entry.path).length > 0);
        return [b];
    });

    function saveAnchor() {
        return saveBtn && document.body.contains(saveBtn) && saveBtn.offsetParent ? saveBtn : V.root?.querySelector('.vw-edit-badge') || saveBtn;
    }

    function openSaveMenu(anchor = saveAnchor()) {
        const p = V.player;
        if (!p) return;
        const path = p.path;
        const pieces = piecesOf(path);
        const kept = pieces.filter((x) => !x.removed);
        const edited = pieces.length > 0;
        const E = App.videoEditor;
        const keptLen = kept.reduce((s, x) => s + (x.end - x.start), 0);
        const mode = App.settings.get('video.trimMode', 'fast') === 'accurate' ? 'accurate' : 'fast';
        const archive = !!App.settings.get('video.archiveOriginal', false);
        const items = [{ header: edited ? `편집본 · ${kept.length}조각 · ${fmtLen(keptLen)}` : '먼저 Q·W·Ctrl+B로 잘라 주세요' }];
        items.push(
            { label: '남은 부분 이어서 새 파일로', icon: 'film', disabled: !edited, action: () => E?.saveKept(path) },
            { label: '조각마다 새 파일로', icon: 'copy', disabled: !edited || kept.length < 1, hint: kept.length > 1 ? `${kept.length}개` : '', action: () => E?.savePieces(path) });
        if (App.clips?.add) items.push({ label: '보관함에 담기', icon: 'vw-clip', disabled: !edited, hint: kept.length ? `${kept.length}개` : '', action: () => E?.toClips(path) });
        items.push('-',
            { label: '저장 후 원본은 원본 보관 폴더로', icon: 'folder', checked: archive, action: () => App.settings.set('video.archiveOriginal', !archive) },
            {
                label: mode === 'accurate' ? '자르는 방식: 정확하게 (서버)' : '자르는 방식: 빠르게 (무손실)',
                icon: 'vw-gauge',
                checked: false,
                submenu: () => [
                    { header: '자르는 방식' },
                    { label: '빠르게 · 화질 그대로 (키프레임 기준)', checked: mode === 'fast', action: () => App.settings.set('video.trimMode', 'fast') },
                    { label: '정확하게 · 다시 인코딩 (서버)', checked: mode === 'accurate', action: () => App.settings.set('video.trimMode', 'accurate') },
                ],
            },
            '-',
            { label: '편집본 미리보기', icon: 'eye', command: 'video.previewEdit', checked: App.settings.get('video.previewEdit', true) !== false, disabled: !edited },
            { label: '원래대로 (편집 모두 지우기)', icon: 'vw-reset-orient', command: 'video.resetEdit', disabled: !edited });
        ui.menu(items, anchor ? { anchor, align: 'end' } : { x: innerWidth / 2, y: innerHeight / 2 });
    }

    // ---------- E: edit key hints ----------
    function hints() {
        const dk = V.dk;
        return [
            { keys: ['Q'], label: '앞부분 잘라내기' },
            { keys: ['W'], label: '뒷부분 잘라내기' },
            { keys: [dk('Mod+B')], label: '자르기' },
            { keys: ['Delete'], label: '조각 빼기·되살리기' },
            { keys: ['P'], label: '편집본 미리보기' },
            ...(App.clips?.add ? [{ keys: ['G'], label: '보관함에 담기' }] : []),
            { keys: [dk('Mod+Z')], label: '되돌리기' },
            { keys: [dk('Shift+S')], label: '저장' },
            { keys: ['E'], label: '힌트 닫기' },
        ];
    }

    function toggleHints() {
        hintMode = !hintMode;
        V.refreshHints();
        if (V.player) barRef?.update?.();
        if (hintMode) V.osd(`Q 앞 · W 뒤 잘라내기 · ${V.dk('Mod+B')} 자르기`, { icon: 'scissors', duration: 2200 });
    }

    // =====================================================================================================
    // Commands
    // =====================================================================================================
    const canEdit = () => !!ctx();
    const hasSel = () => canEdit() && !!selectedPiece();
    const isVideo = () => V.isOpen && V.kind === 'video' && !!V.player && !V.player.failed;
    const reg = (cmd) => App.commands.register({ group: '영상 편집', scope: 'viewer', ...cmd });
    reg({ id: 'video.cutBefore', title: '앞부분 잘라내기 (재생 위치 앞)', icon: 'scissors', keys: ['Q'], when: canEdit, run: () => cutBefore() });
    reg({ id: 'video.cutAfter', title: '뒷부분 잘라내기 (재생 위치 뒤)', icon: 'scissors', keys: ['W'], when: canEdit, run: () => cutAfter() });
    reg({ id: 'video.split', title: '여기서 자르기 (면도날)', icon: 'scissors', keys: ['Mod+B'], when: canEdit, run: () => split() });
    reg({ id: 'video.deletePiece', title: '선택한 조각 빼기·되살리기', icon: 'trash', keys: ['Backspace'], when: hasSel, run: () => removeSelected() });
    reg({ id: 'video.joinPiece', title: '선택한 조각을 앞 조각과 합치기', icon: 'merge', when: hasSel, run: () => joinSelected() });
    reg({ id: 'video.previewEdit', title: '편집본 미리보기 (잘라낸 부분 건너뛰기)', icon: 'eye', keys: ['P'], when: () => isVideo() && piecesOf(V.player.path).length > 0, run: () => togglePreview() });
    reg({ id: 'video.resetEdit', title: '편집 원래대로 (모두 지우기)', icon: 'vw-reset-orient', when: () => isVideo() && hasEdit(rawEdit(V.player.path)), run: () => reset() });
    reg({ id: 'video.clip', title: '보관함에 담기 (보관함이 없으면 마커)', icon: 'vw-clip', keys: ['G'], when: () => isVideo() && V.player.metaReady, run: () => addClip() });
    reg({ id: 'video.editHelp', title: '편집 단축키 보기', icon: 'scissors', keys: ['E'], when: isVideo, run: () => toggleHints() });
    reg({ id: 'video.saveMenu', title: '편집본 저장 메뉴', icon: 'vw-save', keys: ['Shift+S'], when: isVideo, run: () => openSaveMenu() });
    reg({ id: 'video.saveKept', title: '남은 부분 이어서 새 파일로', icon: 'film', when: () => isVideo() && piecesOf(V.player.path).length > 0, run: () => App.videoEditor?.saveKept(V.player.path) });
    reg({ id: 'video.savePieces', title: '조각마다 새 파일로', icon: 'copy', when: () => isVideo() && piecesOf(V.player.path).length > 0, run: () => App.videoEditor?.savePieces(V.player.path) });
    reg({ id: 'video.saveToClips', title: '편집 조각을 보관함에 담기', icon: 'vw-clip', when: () => isVideo() && !!App.clips?.add && piecesOf(V.player.path).length > 0, run: () => App.videoEditor?.toClips(V.player.path) });

    // =====================================================================================================
    // Events
    // =====================================================================================================
    App.bus.on('viewer:entry', ({ entry }) => {
        chipPop?.close();
        disposeStrip();
        if (sel && sel.path !== entry?.path) sel = null;
    });
    App.bus.on('viewer:closed', () => {
        disposeStrip();
        sel = null;
        hintMode = false;
    });
    App.bus.on('fs:changed', (c) => {
        if (c.type === 'modify') {
            for (const p of c.paths || []) {
                if (!verified.has(p) && !stats.has(p)) continue;
                verified.delete(p);
                refreshStat(p);
            }
        }
        if (c.from && c.to) {
            for (let i = 0; i < c.from.length; i++) {
                if (stats.has(c.from[i])) {
                    stats.set(c.to[i], stats.get(c.from[i]));
                    stats.delete(c.from[i]);
                }
                if (verified.delete(c.from[i])) verified.add(c.to[i]);
                if (sel && sel.path === c.from[i]) sel = { ...sel, path: c.to[i] };
            }
        }
    });
    // every opening re-checks the file on disk before a saved edit is applied
    App.bus.on('viewer:player', ({ player }) => {
        if (!player) return;
        verified.delete(player.path);
        refreshStat(player.path);
    });
    App.bus.on('settings:changed', ({ key }) => {
        if (key === 'video.previewEdit') rerender();
    });

    // Settings page (feature-detected): G range
    App.bus.on('app:ready', () => {
        const S = App.settingsUI;
        if (!S?.addPage || S.pages?.some?.((pg) => pg.id === 'video-edit')) return;
        S.addPage({
            id: 'video-edit',
            title: '영상 편집',
            icon: 'scissors',
            order: 45,
            desc: '뷰어에서 Q·W·Ctrl+B로 자르고 G로 보관함에 담을 때 쓰는 설정이에요.',
            render(body, kit) {
                const g = kit.group('보관함에 담기 (G)', '조각을 고르지 않았을 때 재생 위치 앞뒤로 얼마나 담을지 정해요.');
                const num = (key, fallback, label, desc) => {
                    const input = h('input', { class: 'input sm', type: 'number', min: '0', max: '600', step: '1', style: { width: '84px' } });
                    input.value = String(App.settings.get(key, fallback));
                    input.addEventListener('change', () => {
                        const v = clamp(Math.round(Number(input.value) || 0), 0, 600);
                        input.value = String(v);
                        App.settings.set(key, v);
                    });
                    g.body.append(kit.row({ label, desc, control: h('div', { class: 'row', style: { gap: '6px', alignItems: 'center' } }, input, h('span', { class: 'muted', text: '초' })) }));
                };
                num('video.clipBefore', 15, '앞쪽', '재생 위치보다 이만큼 앞에서 시작해요');
                num('video.clipAfter', 5, '뒤쪽', '재생 위치보다 이만큼 뒤에서 끝나요');
                body.append(g.el);
                const g2 = kit.group('편집본 저장', '원본은 그대로 두고 새 파일을 만들어요.');
                g2.body.append(kit.row({ label: '편집본 미리보기', desc: '재생할 때 잘라낸 부분을 건너뛰어요 (P)', control: kit.toggle({ key: 'video.previewEdit', fallback: true }) }));
                g2.body.append(kit.row({ label: '저장 후 원본은 원본 보관 폴더로', desc: '같은 폴더의 「원본 보관」으로 옮겨요. Ctrl+Z로 되돌릴 수 있어요.', control: kit.toggle({ key: 'video.archiveOriginal', fallback: false }) }));
                g2.body.append(kit.row({
                    label: '자르는 방식',
                    desc: '빠르게는 화질 그대로 키프레임 기준으로, 정확하게는 서버가 다시 인코딩해서 잘라요.',
                    control: kit.select({ key: 'video.trimMode', fallback: 'fast', options: [{ value: 'fast', label: '빠르게 (무손실)' }, { value: 'accurate', label: '정확하게 (서버)' }] }),
                }));
                body.append(g2.el);
            },
        });
    });

    App.videoEdit = {
        piecesOf,
        listFor: (path) => piecesOf(path),
        keptOf: (path) => piecesOf(path).filter((x) => !x.removed),
        isEdited: (path) => piecesOf(path).length > 0,
        isStale,
        rawEdit,
        selected() {
            const x = selectedPiece();
            return x ? { path: sel.path, ...x } : null;
        },
        select(path, start, { seek = false, focusMemo = false } = {}) {
            const pieces = piecesOf(path);
            const x = pieces.find((y) => Math.abs(y.start - start) < 0.0005) || locate(pieces, start);
            if (!x) return;
            if (seek && V.player?.path === path) V.player.seek(x.start);
            setSel({ path, at: (x.start + x.end) / 2 });
            if (focusMemo) requestAnimationFrame(() => strip?.memo?.focus());
        },
        deselect() {
            if (!sel) return false;
            setSel(null);
            return true;
        },
        cutBefore,
        cutAfter,
        split,
        removeSelected,
        joinSelected,
        setPieceInfo,
        moveCut,
        reset,
        addClip,
        openSaveMenu,
        render,
        pointerAt(p, t) {
            if (!piecesOf(p.path).length) return;
            selectAt(p.path, t);
        },
        get hintMode() {
            return hintMode;
        },
        hints,
        _stats: stats,
        _piecesFrom: piecesFrom,
        _editFrom: editFrom,
    };
})();
