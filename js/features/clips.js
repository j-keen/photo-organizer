/*
 * Clip library "보관함" — data model (clips team). UI lives in clips-ui.js, frame thumbnails in clips-frames.js.
 *
 * Stored in <workspace>/.fluid-organizer/clips.json via App.wsdata ({ version: 1, clips: [Clip] }), written debounced,
 * retried with backoff when the folder is briefly unavailable, mirrored to IndexedDB (rescue copy) and backed up daily.
 *   Clip = { id, path, start, end, title, memo, chips: [chipId], order, createdAt, updatedAt, missing? }
 *
 * App.clips (ARCHITECTURE §8):
 *   ready, list({ path, includeMissing } = {}) (library order; for one path: by start), get(id), forPath(path),
 *   search(query, { list }) (title/memo/chips/file name, Hangul initials via App.util.matchKo; library order),
 *   add(clip | clip[], { label, notify }) -> created clips (ONE undo step),
 *   update(id, patch, { coalesceKey, label }) (typing coalesces), updateMany(ids, patch | fn, { label }) (one step),
 *   remove(ids, { notify }) (one undo step), reorder(ids) (the given clips swap places among the slots they occupy,
 *   so a full id list sets the whole order and a filtered subset only reorders those).
 *   Helpers: displayTitle(clip), autoTitle(clip), memoLine(clip), duration(clip), fmt(t), missingCount(),
 *   purgeMissing() (one undo step), playOne(clip), playMany(clips, { title }), sourceExists(path).
 * Follows fs:changed: rename/move rewrite `path` (folders too); trashing/deleting the video sets `missing` (hidden),
 * restoring clears it.
 * Event 'clips:changed' { ids, paths, reason: 'add'|'update'|'remove'|'reorder'|'relocate'|'load' }.
 */
(() => {
    'use strict';
    const { path: P, uid, debounce, formatCount } = App.util;
    const ui = App.ui;

    const FIELDS = ['title', 'memo', 'chips', 'start', 'end'];
    const round3 = (n) => Math.round(Number(n) * 1000) / 1000;

    let doc = { version: 1, clips: [] };
    let byId = new Map();
    let wsId = null;
    let loadToken = 0;
    let dirty = false;
    let failures = 0;
    let retryTimer = null;

    // ---------- Helpers ----------
    function clone(x) {
        return JSON.parse(JSON.stringify(x));
    }

    function sortInPlace() {
        doc.clips.sort((a, b) => a.order - b.order);
    }

    function renumber() {
        sortInPlace();
        doc.clips.forEach((c, i) => {
            c.order = i;
        });
    }

    function rebuild() {
        byId = new Map(doc.clips.map((c) => [c.id, c]));
    }

    function emit(reason, list) {
        const ids = [...new Set(list.map((c) => (typeof c === 'string' ? c : c.id)))];
        const paths = [...new Set(list.map((c) => (typeof c === 'string' ? byId.get(c)?.path : c.path)).filter((p) => p != null))];
        App.bus.emit('clips:changed', { ids, paths, reason });
    }

    function normalizeClip(c, order) {
        if (!c || typeof c.path !== 'string' || !c.path) return null;
        let start = Number(c.start);
        let end = Number(c.end);
        if (!isFinite(start) || start < 0) start = 0;
        if (!isFinite(end) || end <= start) return null;
        const now = Date.now();
        return {
            id: typeof c.id === 'string' && c.id ? c.id : uid('c'),
            path: c.path,
            start: round3(start),
            end: round3(end),
            title: typeof c.title === 'string' ? c.title : '',
            memo: typeof c.memo === 'string' ? c.memo : '',
            chips: Array.isArray(c.chips) ? [...new Set(c.chips.filter((x) => typeof x === 'string'))] : [],
            order: isFinite(c.order) ? Number(c.order) : order,
            createdAt: Number(c.createdAt) || now,
            updatedAt: Number(c.updatedAt) || now,
            ...(c.missing ? { missing: true } : null),
        };
    }

    function normalizeDoc(d) {
        const out = { version: 1, rev: Number(d?.rev) || 0, clips: [] };
        const seen = new Set();
        for (const [i, raw] of (Array.isArray(d?.clips) ? d.clips : []).entries()) {
            const c = normalizeClip(raw, i);
            if (!c || seen.has(c.id)) continue;
            seen.add(c.id);
            out.clips.push(c);
        }
        doc = out;
        renumber();
        rebuild();
        return out;
    }

    function fmt(t) {
        t = Math.max(0, Number(t) || 0);
        const h = Math.floor(t / 3600);
        const m = Math.floor((t % 3600) / 60);
        const s = Math.floor(t % 60);
        return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    function duration(c) {
        return Math.max(0, (c.end || 0) - (c.start || 0));
    }

    function memoLine(c) {
        return String(c.memo || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
    }

    function autoTitle(c) {
        return `${P.stem(c.path)} ${fmt(c.start)}–${fmt(c.end)}`;
    }

    function displayTitle(c) {
        return (c.title || '').trim() || memoLine(c) || autoTitle(c);
    }

    function chipNames(c) {
        const C = App.chipset;
        return (c.chips || []).map((id) => C?.nameOf?.(id)).filter(Boolean);
    }

    function sourceExists(p) {
        if (!App.index?.ready) return true;
        return !!App.index.get(p);
    }

    // ---------- Persistence ----------
    const saveSoon = debounce(() => save(), 500);

    // Every change also goes to an IndexedDB rescue copy (keyed by workspace id, stamped with doc.rev): if the file
    // write can't happen (workspace switched within the save debounce, folder gone, server down) nothing is lost and the
    // newer copy wins the next time this workspace opens.
    function mirror(ws, snapshot) {
        if (ws) App.idb.set(`clips.${ws}`, snapshot).catch(() => {});
    }

    const mirrorSoon = debounce(() => mirror(wsId, clone(doc)), 150);

    async function save() {
        const ws = wsId;
        if (!dirty || !App.fs.ready || !ws || App.state.workspace?.id !== ws) return;
        dirty = false;
        clearTimeout(retryTimer);
        const snapshot = clone(doc);
        try {
            await App.wsdata.write('clips', snapshot);
            if (wsId === ws) {
                if (failures >= 3) ui.toast('보관함을 저장했어요', { type: 'success', id: 'clips-save' });
                failures = 0;
            }
        } catch (e) {
            console.warn('[clips] save failed', e && e.message);
            if (wsId === ws) {
                dirty = true;
                failures++;
                retryTimer = setTimeout(save, Math.min(30000, 2000 * 2 ** (failures - 1)));
                if (failures === 3) ui.toast('보관함을 아직 저장하지 못했어요. 계속 다시 시도하고 있어요 — 폴더 권한이나 로컬 서버를 확인해 주세요.', { type: 'error', id: 'clips-save', duration: 0 });
            }
        } finally {
            mirror(ws, snapshot);
        }
    }

    function touch() {
        doc.rev = Date.now();
        dirty = true;
        saveSoon();
        mirrorSoon();
    }

    // Unsaved edits of the workspace being left: the file backend may already be gone, so keep them in the rescue copy
    function rescuePending() {
        if (!wsId) return;
        mirrorSoon.cancel();
        if (dirty) mirror(wsId, clone(doc));
    }

    async function load() {
        rescuePending();
        saveSoon.cancel();
        clearTimeout(retryTimer);
        dirty = false;
        failures = 0;
        const token = ++loadToken;
        wsId = App.state.workspace?.id || null;
        clips.ready = false;
        normalizeDoc(null);
        let d = null;
        let copy = null;
        let source = 'file';
        try {
            d = await App.wsdata.read('clips', null);
        } catch (e) {
            d = null;
        }
        if (token !== loadToken) return;
        try {
            copy = wsId ? await App.idb.get(`clips.${wsId}`) : null;
        } catch (e) {
            copy = null;
        }
        if (token !== loadToken) return;
        const usable = copy && Array.isArray(copy.clips);
        if (!d && usable && copy.clips.length) {
            d = copy;
            source = 'idb';
        } else if (d && usable && (copy.rev || 0) > (d.rev || 0)) {
            d = copy;
            source = 'newer';
        }
        normalizeDoc(d);
        clips.ready = true;
        if (source !== 'file') {
            dirty = true;
            save();
            ui.toast(source === 'idb' ? '보관함 파일이 없어서 이 브라우저에 있던 사본으로 되살렸어요' : '저장하지 못했던 보관함 변경을 되살렸어요', { type: 'warning', duration: 7000 });
        } else if (doc.clips.length) {
            App.wsdata.backup('clips', clone(doc));
        }
        App.bus.emit('clips:changed', { ids: doc.clips.map((c) => c.id), paths: [...new Set(doc.clips.map((c) => c.path))], reason: 'load' });
    }

    function close() {
        loadToken++;
        rescuePending();
        saveSoon.cancel();
        clearTimeout(retryTimer);
        doc = { version: 1, clips: [] };
        rebuild();
        wsId = null;
        dirty = false;
        failures = 0;
        clips.ready = false;
        App.bus.emit('clips:changed', { ids: [], paths: [], reason: 'load' });
    }

    // Undo entries only touch this workspace's library
    function guard(ws) {
        if (wsId !== ws) {
            const e = new Error('다른 작업 폴더의 보관함이라서 되돌릴 수 없어요');
            e.code = 'EINVAL';
            throw e;
        }
    }

    // ---------- Mutations ----------
    function insert(list) {
        for (const c of list) {
            if (byId.has(c.id)) continue;
            doc.clips.push(clone(c));
        }
        renumber();
        rebuild();
        touch();
    }

    function drop(ids) {
        const gone = new Set(ids);
        const removed = doc.clips.filter((c) => gone.has(c.id));
        doc.clips = doc.clips.filter((c) => !gone.has(c.id));
        renumber();
        rebuild();
        touch();
        return removed;
    }

    function applyFields(id, fields) {
        const c = byId.get(id);
        if (!c) return null;
        for (const k of FIELDS) if (k in fields) c[k] = clone(fields[k]);
        c.updatedAt = Date.now();
        return c;
    }

    function pick(c, keys) {
        const out = {};
        for (const k of keys) out[k] = clone(c[k]);
        return out;
    }

    function cleanPatch(c, patch) {
        const out = {};
        for (const k of FIELDS) {
            if (!(k in patch)) continue;
            let v = patch[k];
            if (k === 'title' || k === 'memo') v = String(v ?? '');
            else if (k === 'chips') v = [...new Set((Array.isArray(v) ? v : []).filter((x) => typeof x === 'string'))];
            else {
                v = round3(Math.max(0, Number(v)));
                if (!isFinite(v)) continue;
            }
            out[k] = v;
        }
        const start = 'start' in out ? out.start : c.start;
        const end = 'end' in out ? out.end : c.end;
        if (end <= start) {
            const e = new Error('끝 시간이 시작 시간보다 뒤여야 해요');
            e.code = 'EINVAL';
            throw e;
        }
        return out;
    }

    const clips = {
        ready: false,

        get workspaceId() {
            return wsId;
        },

        list({ path, includeMissing = false } = {}) {
            let out = doc.clips;
            if (!includeMissing) out = out.filter((c) => !c.missing);
            if (path != null) out = out.filter((c) => c.path === path).sort((a, b) => a.start - b.start || a.end - b.end);
            return out.slice();
        },

        get(id) {
            return byId.get(id) || null;
        },

        forPath(p) {
            return clips.list({ path: p });
        },

        count({ includeMissing = false } = {}) {
            return includeMissing ? doc.clips.length : doc.clips.reduce((n, c) => n + (c.missing ? 0 : 1), 0);
        },

        /** Clips matching the query (title, memo, chip names, file name), Hangul initials too. Library order. */
        search(query, { list } = {}) {
            const src = list || clips.list();
            const q = String(query || '').trim();
            if (!q) return src.slice();
            const terms = q.split(/\s+/).filter(Boolean);
            return src.filter((c) => {
                const hay = [displayTitle(c), c.memo, P.base(c.path), ...chipNames(c)];
                return terms.every((t) => hay.some((x) => x && App.util.matchKo(t, x)));
            });
        },

        add(input, { label, notify = true } = {}) {
            if (!clips.ready) throw Object.assign(new Error('작업 폴더를 먼저 열어 주세요'), { code: 'EINVAL' });
            const arr = (Array.isArray(input) ? input : [input]).filter(Boolean);
            let next = doc.clips.length ? Math.max(...doc.clips.map((c) => c.order)) + 1 : 0;
            const created = [];
            for (const raw of arr) {
                const c = normalizeClip({ ...raw, id: raw.id && !byId.has(raw.id) ? raw.id : undefined, order: next++, createdAt: undefined, updatedAt: undefined, missing: false }, 0);
                if (!c) continue;
                created.push(c);
            }
            if (!created.length) return [];
            insert(created);
            const ws = wsId;
            const ids = created.map((c) => c.id);
            const saved = clone(created);
            const text = label || (created.length === 1 ? `보관함에 담기 "${displayTitle(created[0])}"` : `조각 ${created.length}개 보관함에 담기`);
            App.undo.push({
                label: text,
                undo: async () => {
                    guard(ws);
                    const removed = drop(ids);
                    emit('remove', removed);
                },
                redo: async () => {
                    guard(ws);
                    insert(saved);
                    emit('add', saved);
                },
            });
            emit('add', created);
            if (notify) {
                const msg = created.length === 1 ? '보관함에 담았어요' : `조각 ${formatCount(created.length)}개를 보관함에 담았어요`;
                if (App.viewer?.isOpen && typeof App.viewer.osd === 'function') App.viewer.osd(msg, { icon: 'scissors' });
                else ui.toast(msg, { type: 'success', id: 'clips-add', action: { label: '보관함 보기', run: () => App.commands.run('clips.focus', { ids }) } });
            }
            return created.map((c) => byId.get(c.id));
        },

        update(id, patch, { coalesceKey = null, label } = {}) {
            const c = byId.get(id);
            if (!c || !patch) return null;
            const fields = cleanPatch(c, patch);
            const keys = Object.keys(fields).filter((k) => JSON.stringify(c[k]) !== JSON.stringify(fields[k]));
            if (!keys.length) return c;
            // Whole editable state, so coalesced steps (oldest undo + newest redo) stay complete
            const before = pick(c, FIELDS);
            applyFields(id, fields);
            const after = pick(c, FIELDS);
            touch();
            const ws = wsId;
            App.undo.push({
                label: label || (keys.includes('memo') || keys.includes('title') ? `조각 메모 "${displayTitle(c)}"` : keys.includes('chips') ? '조각 칩 바꾸기' : '조각 구간 바꾸기'),
                coalesceKey,
                undo: async () => {
                    guard(ws);
                    if (applyFields(id, before)) {
                        touch();
                        emit('update', [id]);
                    }
                },
                redo: async () => {
                    guard(ws);
                    if (applyFields(id, after)) {
                        touch();
                        emit('update', [id]);
                    }
                },
            });
            emit('update', [c]);
            return c;
        },

        /** Change several clips in ONE undo step. patch = fields or (clip) => fields */
        updateMany(ids, patch, { label = '조각 바꾸기' } = {}) {
            const before = new Map();
            const after = new Map();
            for (const id of ids) {
                const c = byId.get(id);
                if (!c) continue;
                const raw = typeof patch === 'function' ? patch(clone(c)) : patch;
                if (!raw) continue;
                const fields = cleanPatch(c, raw);
                const keys = Object.keys(fields).filter((k) => JSON.stringify(c[k]) !== JSON.stringify(fields[k]));
                if (!keys.length) continue;
                before.set(id, pick(c, keys));
                applyFields(id, fields);
                after.set(id, pick(c, keys));
            }
            if (!before.size) return 0;
            touch();
            const ws = wsId;
            const put = (m) => {
                guard(ws);
                const changed = [];
                for (const [id, f] of m) if (applyFields(id, f)) changed.push(id);
                touch();
                emit('update', changed);
            };
            App.undo.push({ label, undo: async () => put(before), redo: async () => put(after) });
            emit('update', [...before.keys()]);
            return before.size;
        },

        remove(ids, { notify = true, label } = {}) {
            const list = (Array.isArray(ids) ? ids : [ids]).filter((id) => byId.has(id));
            if (!list.length) return 0;
            const removed = drop(list);
            const saved = clone(removed);
            const ws = wsId;
            const text = label || (removed.length === 1 ? `보관함에서 빼기 "${displayTitle(removed[0])}"` : `조각 ${removed.length}개 보관함에서 빼기`);
            App.undo.push({
                label: text,
                undo: async () => {
                    guard(ws);
                    // Put them back in their old slots
                    for (const c of saved) {
                        for (const o of doc.clips) if (o.order >= c.order) o.order++;
                        doc.clips.push(clone(c));
                        sortInPlace();
                    }
                    renumber();
                    rebuild();
                    touch();
                    emit('add', saved);
                },
                redo: async () => {
                    guard(ws);
                    emit('remove', drop(saved.map((c) => c.id)));
                },
            });
            emit('remove', removed);
            if (notify) {
                ui.toast(removed.length === 1 ? '보관함에서 뺐어요' : `조각 ${formatCount(removed.length)}개를 보관함에서 뺐어요`, {
                    type: 'success',
                    id: 'clips-remove',
                    action: { label: '실행 취소', run: () => App.undo.undo() },
                });
            }
            return removed.length;
        },

        /** The given clips take the slots they already occupy, in the given order. */
        reorder(ids, { label = '보관함 순서 바꾸기' } = {}) {
            const list = [...new Set(ids)].filter((id) => byId.has(id));
            if (list.length < 2) return false;
            sortInPlace();
            const beforeOrder = doc.clips.map((c) => c.id);
            const set = new Set(list);
            const slots = doc.clips.map((c, i) => (set.has(c.id) ? i : -1)).filter((i) => i >= 0);
            const arranged = doc.clips.slice();
            slots.forEach((slot, k) => {
                arranged[slot] = byId.get(list[k]);
            });
            const afterOrder = arranged.map((c) => c.id);
            if (afterOrder.join() === beforeOrder.join()) return false;
            const setOrder = (order) => {
                order.forEach((id, i) => {
                    const c = byId.get(id);
                    if (c) c.order = i;
                });
                // Clips added since (redo after other edits) go after
                let n = order.length;
                for (const c of doc.clips) if (!order.includes(c.id)) c.order = n++;
                renumber();
                touch();
            };
            setOrder(afterOrder);
            const ws = wsId;
            App.undo.push({
                label,
                undo: async () => {
                    guard(ws);
                    setOrder(beforeOrder);
                    emit('reorder', list);
                },
                redo: async () => {
                    guard(ws);
                    setOrder(afterOrder);
                    emit('reorder', list);
                },
            });
            emit('reorder', list);
            return true;
        },

        missingCount() {
            return doc.clips.reduce((n, c) => n + (c.missing || !sourceExists(c.path) ? 1 : 0), 0);
        },

        /** Clips whose video is in the trash or gone */
        missingList() {
            return doc.clips.filter((c) => c.missing || !sourceExists(c.path));
        },

        purgeMissing() {
            const ids = clips.missingList().map((c) => c.id);
            if (!ids.length) return 0;
            return clips.remove(ids, { label: `원본이 없는 조각 ${ids.length}개 정리` });
        },

        // ---------- Playback (viewer API is feature-detected; see ARCHITECTURE §8) ----------
        playOne(c, { loop = true } = {}) {
            if (!c) return;
            const V = App.viewer;
            if (!V) return;
            if (typeof V.openAt === 'function') V.openAt(c.path, { start: c.start, end: c.end, loop, autoplay: true });
            else {
                fallback.start([{ path: c.path, start: c.start, end: c.end }], { loop });
            }
        },

        playMany(list, { title } = {}) {
            const items = list.map((c) => ({ path: c.path, start: c.start, end: c.end, title: displayTitle(c) }));
            if (!items.length) return;
            const V = App.viewer;
            if (!V) return;
            if (items.length === 1) return clips.playOne(list[0]);
            if (typeof V.playSequence === 'function') V.playSequence(items, { title });
            else fallback.start(items, { loop: false, title });
        },

        displayTitle,
        autoTitle,
        memoLine,
        duration,
        chipNames,
        fmt,
        sourceExists,
        flush: () => {
            saveSoon.cancel();
            return save();
        },
        get dirty() {
            return dirty;
        },
    };

    // ---------- Fallback range/sequence playback on top of App.viewer.open(path, {time, play}) ----------
    // Used only until the viewer's openAt/playSequence land: seeks to the start, stops (or loops) at the end and
    // walks through a queue, driven by the player's 'viewer:video-time' events.
    const fallback = {
        q: null,
        start(items, { loop = false, title } = {}) {
            fallback.q = { items, i: 0, loop, title, armed: false };
            fallback.open();
            if (items.length > 1) ui.toast(`${title || '조각'} ${items.length}개를 이어서 보여 드려요`, { type: 'info', id: 'clips-seq' });
        },
        open() {
            const q = fallback.q;
            if (!q) return;
            const it = q.items[q.i];
            q.armed = false;
            q.path = it.path;
            App.viewer.open(it.path, { time: it.start, play: true });
            setTimeout(() => {
                if (fallback.q === q) q.armed = true;
            }, 400);
        },
        onTime({ time }) {
            const q = fallback.q;
            if (!q || !q.armed) return;
            const cur = App.viewer?.current;
            if (!cur || cur.path !== q.path) {
                fallback.q = null;
                return;
            }
            const it = q.items[q.i];
            if (time < it.end - 0.04) return;
            const player = App.viewer.player;
            if (q.i + 1 < q.items.length) {
                q.i++;
                const nx = q.items[q.i];
                if (nx.path === cur.path && player?.seek) {
                    player.seek(nx.start);
                    q.armed = false;
                    setTimeout(() => {
                        if (fallback.q === q) q.armed = true;
                    }, 300);
                } else fallback.open();
            } else if (q.loop && player?.seek) {
                player.seek(it.start);
                q.armed = false;
                setTimeout(() => {
                    if (fallback.q === q) q.armed = true;
                }, 300);
            } else {
                player?.pause?.();
                fallback.q = null;
            }
        },
    };

    // ---------- Follow file operations ----------
    function followFs(c) {
        if (!clips.ready || !doc.clips.length) return;
        const changed = [];
        const from = c.from || [];
        const to = c.to || [];
        if (c.type === 'rename' || c.type === 'move') {
            for (let i = 0; i < from.length; i++) {
                for (const clip of doc.clips) {
                    const next = P.rebase(clip.path, from[i], to[i]);
                    if (next != null && next !== clip.path) {
                        changed.push({ ...clip });
                        clip.path = next;
                        changed.push(clip);
                    }
                }
            }
        } else if (c.type === 'trash' || c.type === 'delete') {
            for (const p of c.from || c.paths || []) {
                for (const clip of doc.clips) {
                    if (!clip.missing && P.isInside(clip.path, p)) {
                        clip.missing = true;
                        changed.push(clip);
                    }
                }
            }
        } else if (c.type === 'restore') {
            const paths = c.paths || [];
            for (const [i, p] of paths.entries()) {
                // Restored under a numbered name ("a (2).mp4") when the original name was taken again meanwhile:
                // use the event's original path when core provides it, otherwise strip the " (n)" suffix.
                const original = (c.from && c.from[i]) || P.join(P.parent(p), P.base(p).replace(/ \(\d+\)(?=(\.[^.]*)?$)/, ''));
                for (const clip of doc.clips) {
                    if (!clip.missing) continue;
                    let next = null;
                    if (P.isInside(clip.path, p)) next = clip.path;
                    else if (original !== p && P.isInside(clip.path, original)) next = P.rebase(clip.path, original, p);
                    if (next == null) continue;
                    delete clip.missing;
                    if (next !== clip.path) {
                        changed.push({ ...clip });
                        clip.path = next;
                    }
                    changed.push(clip);
                }
            }
        }
        if (!changed.length) return;
        touch();
        emit('relocate', changed);
    }

    // ---------- Commands that don't need the list UI ----------
    App.commands.register({
        id: 'clips.addFromViewer',
        title: '지금 보는 구간을 보관함에 담기',
        group: '보관함',
        icon: 'scissors',
        scope: 'viewer',
        when: () => clips.ready && !!App.viewer?.isOpen && App.viewer.kind === 'video',
        run: () => {
            const V = App.viewer;
            const cur = V.current;
            const player = V.player;
            const dur = player?.duration || App.catalog.get(cur.path).meta.duration || 0;
            const marks = App.videoEditor?.marksFor?.(cur.path);
            let start;
            let end;
            if (marks && marks.in != null && marks.out != null && marks.out > marks.in) {
                start = marks.in;
                end = marks.out;
            } else if (player?.loopA != null && player?.loopB != null && player.loopB > player.loopA) {
                start = player.loopA;
                end = player.loopB;
            } else {
                const t = player?.time || 0;
                start = Math.max(0, t - 5);
                end = dur ? Math.min(dur, t + 5) : t + 5;
            }
            if (!(end > start)) return;
            clips.add({ path: cur.path, start, end });
        },
    });

    App.register('clips', {
        init() {
            App.bus.on('workspace:opened', () => load());
            App.bus.on('workspace:closed', close);
            // Integration request: workspace.js awaits these before it switches or closes the folder (next to catalog.flush)
            if (App.workspace) (App.workspace.flushHooks ||= []).push(() => clips.flush());
            App.bus.on('fs:changed', followFs);
            App.bus.on('viewer:video-time', (e) => fallback.onTime(e || {}));
            App.bus.on('viewer:closed', () => {
                fallback.q = null;
            });
            App.bus.on('index:ready', () => {
                if (clips.ready && doc.clips.length) App.bus.emit('clips:changed', { ids: [], paths: [], reason: 'relocate' });
            });
            window.addEventListener('beforeunload', () => {
                if (dirty) save();
            });
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden' && dirty) clips.flush();
            });
        },
    });

    App.clips = clips;
})();
