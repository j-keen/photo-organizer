/*
 * Chipsets — the tagging model (no panel UI here; see chips-panel.js).
 *   presets → categories (mode 'select' shows every chip | 'search' for big lists like actor names)
 *           → chips → sub-chips (a sub-chip always brings its parent along).
 * Definitions are shared through IndexedDB key chipsets.library; each workspace carries the full library and
 * its own activePreset in .fluid-organizer/chipsets.json (+ a per-workspace IndexedDB rescue copy).
 * Version 2 adds preset.updatedAt and deleted: [{ id, at }] tombstones; chip IDs survive merges and imports.
 * exportPreset(id) -> independent plain preset object; importPreset(obj, { replace = false }) -> preset
 * (throws on an existing ID unless replace is true). Import is ONE undo entry and selects the imported set.
 *   { version, activePreset, deleted, presets: [{ id, name, updatedAt, hotkeys: { '1': chipId }, categories: [{ id, name, mode,
 *     color?, single?, chips: [{ id, name, children: [{ id, name }] }] }] }] }
 * Files carry chip IDs in App.catalog (entry.chips), so renaming a chip renames it everywhere.
 * A duplicated preset shares its chip IDs with the original (same tags on the files, like v1 name tokens);
 * renaming a chip renames it in every preset that contains it.
 *
 * App.chipset:
 *   ready, doc, active(), presets(), setActive(id)
 *   list({ preset }) -> [{ id, name, label, catId, catName, mode, color, parentId, depth, hotkey }]
 *   info(id) -> { preset, cat, chip, parent } | null, nameOf(id), labelOf(id, sep), hudLabel(id), category(catId)
 *   chipsOf(path) -> known chip ids (structure order), counts(paths) -> Map id -> files having it, usage() -> Map
 *   filesWith(id) -> paths, sortIds(ids), inActive(id)
 *   apply(pathsOrEntries, id, 'toggle'|'add'|'remove', { hud }) -> { mode, changed, total }   (ONE undo entry)
 *   addCategory, addChips, renameChip, renameCategory, setCategory, moveChip, moveCategory, moveChipTo,
 *   removeChip, removeCategory, mergeChip, setHotkey, hotkeyOf, createPreset, renamePreset, movePreset, deletePreset,
 *   createAndApply(catId, name, files | pieceTarget)
 *   pieceTarget() -> the viewer's selected video piece as a chip target, or null (provider: setPieceProvider(fn), set by
 *     video-edit.js) · countsFor(files | pieceTarget) · applyPiece(pieceTarget, id, mode, { hud }) (ONE undo entry)
 *     While a piece is selected in the viewer, the digit hotkeys tag the piece instead of the file.
 *   transaction(label, fn(tx)) — structure + per-file changes as ONE undo entry
 * Undo: every edit above is exactly ONE App.undo entry (whole-document snapshots for the structure, before/after
 *   values for files). Catalog writes pass { undoable: false } so a catalog that records undo never doubles them.
 *   Switching the active preset is navigation, not an edit (not undoable; undo/redo keep the preset on screen).
 *   validateName, cleanName, normKey, match(query, text) (fuzzy, Hangul-initials aware: ㄱㅅㅎ → 김수현), hud(text, opts)
 * Events: 'chipset:loaded', 'chipset:changed' { reason }
 */
(() => {
    'use strict';
    const { h, uid, formatCount } = App.util;
    const ui = App.ui;

    const COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];
    const COLOR_NAMES = { red: '빨강', orange: '주황', yellow: '노랑', green: '초록', blue: '파랑', purple: '보라' };
    const MODE_NAMES = { select: '선택형', search: '검색형' };

    let doc = null;
    let wsId = null;
    let loadToken = 0;
    let saves = Promise.resolve();
    let clock = 0;

    function tick() {
        clock = Math.max(Date.now(), clock + 1);
        return clock;
    }
    let byId = new Map(); // chip id -> { preset, cat, chip, parent }  (active preset wins)
    let catById = new Map(); // category id -> { preset, cat }
    let orderOf = new Map(); // chip id -> structure position (active preset first)
    let activeIds = new Set(); // chip ids in the active preset
    let usageCache = null;

    const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
    const newId = (prefix) => uid(prefix);

    // ---------- Names ----------
    function cleanName(s) {
        return String(s ?? '')
            .normalize('NFC')
            .replace(/[\\/]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 60);
    }

    /** Key for "same name" checks: case, spaces, _ and - are ignored; NFC so macOS (NFD) folder names match. */
    function normKey(s) {
        return String(s ?? '').normalize('NFC').toLowerCase().replace(/[\s_\-]+/g, '');
    }

    function validateName(name, siblings = [], self = null) {
        const raw = String(name ?? '');
        if (/[\\/]/.test(raw)) return '/ 와 \\ 는 이름에 쓸 수 없어요';
        const n = cleanName(raw);
        if (!n) return '이름을 입력해 주세요';
        if (raw.trim().length > 60) return '이름은 60자까지 쓸 수 있어요';
        if (siblings.some((s) => s !== self && s.id !== self?.id && normKey(s.name) === normKey(n))) return '같은 이름이 이미 있어요';
        return null;
    }

    // ---------- Fuzzy matching (Hangul initials aware) ----------
    const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';

    function syllable(ch) {
        const c = ch.charCodeAt(0) - 0xac00;
        if (c < 0 || c > 11171) return null;
        return { cho: Math.floor(c / 588), jung: Math.floor((c % 588) / 28), jong: c % 28 };
    }

    // q: query char, t: text char (both lower-cased). `last` = q is the query's last char (may still be composing).
    function charMatch(q, t, last) {
        if (q === t) return true;
        const qi = CHO.indexOf(q);
        if (qi >= 0) {
            const s = syllable(t);
            return !!s && s.cho === qi;
        }
        if (last) {
            const qs = syllable(q);
            if (qs && !qs.jong) {
                const ts = syllable(t);
                return !!ts && ts.cho === qs.cho && ts.jung === qs.jung;
            }
        }
        return false;
    }

    const BOUNDARY = /[\s_\-./›(·]/;

    /** True for queries made only of Hangul jamo (ㄱㅅㅎ) — a search, never a name worth creating. */
    function isInitials(q) {
        return /^[ㄱ-ㆎ\s]+$/.test(String(q ?? '').trim());
    }

    /** match(query, text) -> { score, indices } | null. Higher score = better. */
    function match(query, text) {
        const q = [...String(query ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, '')];
        const t = [...String(text ?? '').normalize('NFC').toLowerCase()];
        if (!q.length) return { score: 0, indices: [] };
        if (q.length > t.length) return null;
        // 1) contiguous run (prefix > word start > anywhere)
        for (let start = 0; start + q.length <= t.length; start++) {
            let ok = true;
            for (let i = 0; i < q.length; i++) {
                if (!charMatch(q[i], t[start + i], i === q.length - 1)) {
                    ok = false;
                    break;
                }
            }
            if (!ok) continue;
            const exact = start === 0 && q.length === t.length;
            const base = exact ? 1000 : start === 0 ? 800 : BOUNDARY.test(t[start - 1]) ? 650 : 500;
            return { score: base - start - (t.length - q.length) * 0.5, indices: Array.from({ length: q.length }, (_, i) => start + i) };
        }
        // 2) subsequence
        const idx = [];
        let ti = 0;
        for (let i = 0; i < q.length; i++) {
            while (ti < t.length && !charMatch(q[i], t[ti], i === q.length - 1)) ti++;
            if (ti >= t.length) return null;
            idx.push(ti++);
        }
        const gaps = idx[idx.length - 1] - idx[0] - (idx.length - 1);
        const starts = idx.filter((i) => i === 0 || BOUNDARY.test(t[i - 1])).length;
        return { score: 300 - gaps * 6 - idx[0] + starts * 15, indices: idx };
    }

    // ---------- Document ----------
    function emptyDoc() {
        const id = newId('p');
        return { version: 2, activePreset: id, deleted: [], presets: [{ id, name: '기본', updatedAt: 0, hotkeys: {}, categories: [] }] };
    }

    function normalize(input) {
        const d = input && typeof input === 'object' && Array.isArray(input.presets) ? input : null;
        if (!d) return emptyDoc();
        const seenCats = new Set();
        const presets = [];
        for (const p of d.presets) {
            if (!p || typeof p !== 'object') continue;
            const preset = { ...p, id: typeof p.id === 'string' && p.id ? p.id : newId('p'), name: cleanName(p.name) || '세트', updatedAt: Number.isFinite(p.updatedAt) ? p.updatedAt : 0, categories: [], hotkeys: {} };
            const seenChips = new Set();
            for (const c of Array.isArray(p.categories) ? p.categories : []) {
                if (!c || typeof c !== 'object') continue;
                let cid = typeof c.id === 'string' && c.id ? c.id : newId('c');
                if (seenCats.has(cid)) cid = newId('c');
                seenCats.add(cid);
                const cat = { ...c, id: cid, name: cleanName(c.name) || '분류', mode: c.mode === 'search' ? 'search' : 'select', chips: [] };
                if (!COLORS.includes(cat.color)) delete cat.color;
                if (cat.single) cat.single = true;
                else delete cat.single;
                for (const ch of Array.isArray(c.chips) ? c.chips : []) {
                    if (!ch || typeof ch !== 'object' || !cleanName(ch.name)) continue;
                    let id = typeof ch.id === 'string' && ch.id ? ch.id : newId('k');
                    if (seenChips.has(id)) id = newId('k');
                    seenChips.add(id);
                    const chip = { ...ch, id, name: cleanName(ch.name), children: [] };
                    for (const s of Array.isArray(ch.children) ? ch.children : []) {
                        if (!s || typeof s !== 'object' || !cleanName(s.name)) continue;
                        let sid = typeof s.id === 'string' && s.id ? s.id : newId('k');
                        if (seenChips.has(sid)) sid = newId('k');
                        seenChips.add(sid);
                        const sub = { ...s, id: sid, name: cleanName(s.name) };
                        delete sub.children;
                        chip.children.push(sub);
                    }
                    cat.chips.push(chip);
                }
                preset.categories.push(cat);
            }
            for (const [k, v] of Object.entries(p.hotkeys || {})) if (/^[1-9]$/.test(k) && seenChips.has(v)) preset.hotkeys[k] = v;
            presets.push(preset);
        }
        if (!presets.length) return emptyDoc();
        const activePreset = presets.some((p) => p.id === d.activePreset) ? d.activePreset : presets[0].id;
        return { ...d, version: 2, activePreset, presets, deleted: Array.isArray(d.deleted) ? d.deleted.filter((x) => x && typeof x.id === 'string' && Number.isFinite(x.at)) : [] };
    }

    function uniqueName(name, siblings) {
        const base = cleanName(name) || '세트';
        let next = base;
        for (let i = 2; siblings.some((p) => normKey(p.name) === normKey(next)); i++) {
            const suffix = ` ${i}`;
            next = base.slice(0, 60 - suffix.length) + suffix;
        }
        return next;
    }

    function mergeLibrary(inputs, preferred, lastActive) {
        const items = new Map();
        const deleted = new Map();
        for (const input of inputs) {
            if (!input || !Array.isArray(input.presets)) continue;
            for (const x of Array.isArray(input.deleted) ? input.deleted : []) {
                if (!x || typeof x.id !== 'string' || !Number.isFinite(x.at)) continue;
                deleted.set(x.id, Math.max(deleted.get(x.id) ?? -Infinity, x.at));
                clock = Math.max(clock, x.at);
            }
            if (!input.presets.length) continue;
            for (const p of normalize(clone(input)).presets) {
                clock = Math.max(clock, p.updatedAt);
                if (!items.has(p.id) || p.updatedAt > items.get(p.id).updatedAt) items.set(p.id, p);
            }
        }
        const presets = [];
        for (const p of items.values()) {
            if ((deleted.get(p.id) ?? -Infinity) > p.updatedAt) continue;
            p.name = uniqueName(p.name, presets);
            presets.push(p);
        }
        if (!presets.length) presets.push(emptyDoc().presets[0]);
        const activePreset = [preferred, lastActive].find((id) => presets.some((p) => p.id === id)) || presets[0].id;
        return { version: 2, activePreset, presets, deleted: [...deleted].map(([id, at]) => ({ id, at })) };
    }

    // Undo is a fresh library edit too: stale workspace files must never reverse it on the next merge.
    function stampChanges(before) {
        const at = tick();
        const old = new Map(before.presets.map((p) => [p.id, p]));
        const oldOrder = before.presets.map((p) => p.id);
        doc.deleted = doc.deleted || [];
        for (const p of doc.presets) {
            if (JSON.stringify(old.get(p.id)) !== JSON.stringify(p) || oldOrder.indexOf(p.id) !== doc.presets.indexOf(p)) {
                p.updatedAt = at;
            }
        }
        for (const p of before.presets) {
            if (doc.presets.some((x) => x.id === p.id)) continue;
            doc.deleted = doc.deleted.filter((x) => x.id !== p.id);
            doc.deleted.push({ id: p.id, at });
        }
        // Keep deletion history when undo restores an older whole-document snapshot.
        for (const x of before.deleted || []) {
            const existing = doc.deleted.find((y) => y.id === x.id);
            if (!existing) doc.deleted.push(clone(x));
            else existing.at = Math.max(existing.at, x.at);
        }
        for (const p of doc.presets) {
            const tombstone = doc.deleted.find((x) => x.id === p.id);
            if (tombstone && tombstone.at >= p.updatedAt) p.updatedAt = tick();
        }
    }

    function active() {
        if (!doc) return null;
        return doc.presets.find((p) => p.id === doc.activePreset) || doc.presets[0];
    }

    function rebuild() {
        byId = new Map();
        catById = new Map();
        orderOf = new Map();
        activeIds = new Set();
        usageCache = null;
        if (!doc) return;
        const act = active();
        let n = 0;
        for (const preset of [act, ...doc.presets.filter((p) => p !== act)]) {
            for (const cat of preset.categories) {
                catById.set(cat.id, { preset, cat });
                for (const chip of cat.chips) {
                    if (preset === act) activeIds.add(chip.id);
                    if (!byId.has(chip.id)) {
                        byId.set(chip.id, { preset, cat, chip, parent: null });
                        orderOf.set(chip.id, n++);
                    }
                    for (const sub of chip.children) {
                        if (preset === act) activeIds.add(sub.id);
                        if (!byId.has(sub.id)) {
                            byId.set(sub.id, { preset, cat, chip: sub, parent: chip });
                            orderOf.set(sub.id, n++);
                        }
                    }
                }
            }
        }
        syncHotkeyTitles();
    }

    function emit(reason) {
        App.bus.emit('chipset:changed', { reason });
    }

    function persist() {
        if (!doc || !App.fs.ready || App.state.workspace?.id !== wsId) return saves;
        const ws = wsId;
        const snapshot = clone(doc);
        saves = saves.catch(() => {}).then(async () => {
            // Capture snapshots at invocation and serialize writes so rapid edits cannot save out of order.
            await Promise.all([
                App.idb.set('chipsets.library', clone(snapshot)).catch(() => {}),
                App.idb.set('chipsets.lastActive', snapshot.activePreset).catch(() => {}),
                App.idb.set(`chipsets.${ws}`, clone(snapshot)).catch(() => {}),
            ]);
            if (App.state.workspace?.id !== ws) return;
            try {
                await App.wsdata.write('chipsets', snapshot);
            } catch (e) {
                console.error('[chipset] save failed', e);
                ui.toast('칩 세트를 저장하지 못했어요. 폴더 권한을 확인해 주세요.', { type: 'error' });
            }
        });
        return saves;
    }

    /**
     * Put a whole-document snapshot back (undo/redo). Switching presets is not an undoable edit, so by default the
     * preset on screen stays; preset create/duplicate/delete restore the snapshot's own active preset instead.
     */
    function restore(snapshot, reason = 'undo', { keepActive = true } = {}) {
        const before = clone(doc);
        const current = doc?.activePreset;
        doc = clone(snapshot);
        if (keepActive && current && doc.presets.some((p) => p.id === current)) doc.activePreset = current;
        stampChanges(before);
        rebuild();
        persist();
        emit(reason);
    }

    /**
     * Structure-only change with ONE undo entry (whole-document snapshots before/after).
     * mutate(doc, activePreset) returns any result. opts: { undoable = true, reason = 'edit', presetOp = false }
     */
    function commit(label, mutate, { undoable = true, reason = 'edit', presetOp = false } = {}) {
        if (!doc) return null;
        const before = clone(doc);
        let result;
        try {
            result = mutate(doc, active());
        } catch (e) {
            doc = before;
            rebuild();
            throw e;
        }
        if (JSON.stringify(doc) === JSON.stringify(before)) return result;
        stampChanges(before);
        rebuild();
        persist();
        emit(reason);
        if (undoable) {
            const after = clone(doc);
            const keepActive = !presetOp;
            App.undo.push({ label, undo: async () => restore(before, 'undo', { keepActive }), redo: async () => restore(after, 'redo', { keepActive }) });
        }
        return result;
    }

    // ---------- Per-file writes ----------
    function sameValue(a, b) {
        if (Array.isArray(a) || Array.isArray(b)) {
            const x = a || [];
            const y = b || [];
            return x.length === y.length && x.every((v, i) => v === y[i]);
        }
        const empty = (v) => v === undefined || v === null || v === false || v === 0 || v === '';
        if (empty(a) && empty(b)) return true;
        return a === b;
    }

    // Our own undo entries cover these writes, so the catalog must not record its own (undoable: false;
    // ignored by catalogs that don't record undo yet).
    function writeFields(map) {
        if (!map.size) return;
        App.catalog.updateMany([...map.keys()], (e, p) => {
            for (const [k, v] of Object.entries(map.get(p))) {
                if (v === undefined || v === null || v === false || (Array.isArray(v) && !v.length)) delete e[k];
                else e[k] = Array.isArray(v) ? v.slice() : v;
            }
        }, { undoable: false });
    }

    /**
     * transaction(label, fn, { presetOp }): fn(tx) may change the structure (tx.doc / tx.preset, call tx.rebuild()
     * before lookups) and stage per-file changes with tx.setChips(path, ids) or tx.patch(path, fields).
     * Everything is applied as ONE undo entry. Returns { changed, result }.
     */
    function transaction(label, fn, { presetOp = false } = {}) {
        if (!doc) return { changed: 0 };
        const beforeJson = JSON.stringify(doc);
        const patches = new Map();
        const tx = {
            doc,
            preset: active(),
            rebuild,
            patch(p, fields) {
                patches.set(p, { ...(patches.get(p) || {}), ...fields });
            },
            setChips(p, ids) {
                tx.patch(p, { chips: ids });
            },
            chipsOf(p) {
                return (patches.get(p)?.chips || App.catalog.peek(p)?.chips || []).slice();
            },
        };
        let result;
        try {
            result = fn(tx);
        } catch (e) {
            doc = JSON.parse(beforeJson);
            rebuild();
            throw e;
        }
        const structural = JSON.stringify(doc) !== beforeJson;
        const before = structural ? JSON.parse(beforeJson) : null;
        if (structural) {
            stampChanges(before);
            rebuild();
        }
        for (const [p, f] of [...patches]) {
            const cur = App.catalog.peek(p) || {};
            if (Object.keys(f).every((k) => sameValue(cur[k], f[k]))) patches.delete(p);
        }
        if (!structural && !patches.size) return { changed: 0, result };
        const prev = new Map();
        for (const [p, f] of patches) {
            const cur = App.catalog.peek(p) || {};
            const o = {};
            for (const k of Object.keys(f)) o[k] = clone(cur[k]);
            prev.set(p, o);
        }
        writeFields(patches);
        if (structural) {
            persist();
            emit('edit');
        }
        const after = structural ? clone(doc) : null;
        const keepActive = !presetOp;
        // Structure first, then files: when 'catalog:changed' fires, every chip id it mentions exists again.
        App.undo.push({
            label,
            undo: async () => {
                if (structural) restore(before, 'undo', { keepActive });
                writeFields(prev);
            },
            redo: async () => {
                if (structural) restore(after, 'redo', { keepActive });
                writeFields(patches);
            },
        });
        return { changed: patches.size, result };
    }

    // ---------- Lookups ----------
    function info(id) {
        return byId.get(id) || null;
    }

    function nameOf(id) {
        return byId.get(id)?.chip.name ?? null;
    }

    function labelOf(id, sep = ' › ') {
        const i = byId.get(id);
        if (!i) return null;
        return [i.cat.name, i.parent?.name, i.chip.name].filter(Boolean).join(sep);
    }

    function hudLabel(id) {
        const i = byId.get(id);
        if (!i) return '';
        return `${i.cat.name} · ${i.parent ? `${i.parent.name} › ` : ''}${i.chip.name}`;
    }

    function sortIds(ids) {
        return [...ids].sort((a, b) => (orderOf.get(a) ?? 1e9) - (orderOf.get(b) ?? 1e9));
    }

    function chipsOf(p) {
        const raw = App.catalog.peek(p)?.chips;
        if (!raw || !raw.length) return [];
        return sortIds(raw.filter((id) => byId.has(id)));
    }

    function chipsRaw(p) {
        return App.catalog.peek(p)?.chips || [];
    }

    /** Map chipId -> number of the given files that carry it (tri-state source for multi-selection). */
    function counts(paths) {
        const m = new Map();
        for (const p of paths) for (const id of chipsRaw(p)) m.set(id, (m.get(id) || 0) + 1);
        return m;
    }

    function fileExists(p) {
        return !App.index.ready || !!App.index.get(p);
    }

    /** Library-wide usage: Map chipId -> number of existing files carrying it (cached until something changes). */
    function usage() {
        if (usageCache) return usageCache;
        const m = new Map();
        for (const [p, e] of App.catalog.entries()) {
            if (!e.chips || !e.chips.length || !fileExists(p)) continue;
            for (const id of e.chips) m.set(id, (m.get(id) || 0) + 1);
        }
        usageCache = m;
        return m;
    }

    function filesWith(id) {
        const out = [];
        for (const [p, e] of App.catalog.entries()) if (e.chips && e.chips.includes(id) && fileExists(p)) out.push(p);
        return out;
    }

    function list({ preset } = {}) {
        const pr = preset || active();
        if (!pr) return [];
        const out = [];
        for (const cat of pr.categories) {
            for (const chip of cat.chips) {
                out.push({ id: chip.id, name: chip.name, label: `${cat.name} › ${chip.name}`, catId: cat.id, catName: cat.name, mode: cat.mode, color: cat.color || null, parentId: null, depth: 0, hotkey: hotkeyOf(chip.id, pr) });
                for (const sub of chip.children) {
                    out.push({ id: sub.id, name: sub.name, label: `${cat.name} › ${chip.name} › ${sub.name}`, catId: cat.id, catName: cat.name, mode: cat.mode, color: cat.color || null, parentId: chip.id, depth: 1, hotkey: hotkeyOf(sub.id, pr) });
                }
            }
        }
        return out;
    }

    function hotkeyOf(id, preset = active()) {
        if (!preset) return null;
        for (const [k, v] of Object.entries(preset.hotkeys || {})) if (v === id) return k;
        return null;
    }

    // Paths (or entries) -> file paths only (chips are for files, not folders)
    function toFilePaths(list) {
        const out = [];
        for (const x of list || []) {
            if (!x) continue;
            if (typeof x === 'object') {
                if (x.kind === 'file') out.push(x.path);
                continue;
            }
            const i = App.view.indexOf(x);
            const e = i >= 0 ? App.view.visible[i] : App.index.get(x);
            if (e ? e.kind === 'file' : App.util.mediaType(x) !== 'other') out.push(x);
        }
        return out;
    }

    /**
     * What adding / removing chip `id` does to one chip list: a sub-chip brings its parent along, removing a parent takes
     * its sub-chips, and in a single-choice category one top-level chip (with its subs) pushes the others out.
     */
    function chipEditor(i, id, mode) {
        const parentId = i.parent ? i.parent.id : null;
        const childIds = i.parent ? [] : i.chip.children.map((c) => c.id);
        const top = parentId || id;
        const drop = new Set();
        if (mode === 'add' && i.cat.single) {
            for (const c of i.cat.chips) {
                if (c.id === top) continue;
                drop.add(c.id);
                for (const s of c.children) drop.add(s.id);
            }
        }
        return (cur) => {
            if (mode !== 'add') return cur.filter((x) => x !== id && !childIds.includes(x));
            const next = cur.filter((x) => !drop.has(x));
            if (parentId && !next.includes(parentId)) next.push(parentId);
            if (!next.includes(id)) next.push(id);
            return next;
        };
    }

    const sameIds = (a, b) => a.length === b.length && a.every((x, k) => x === b[k]);

    // ---------- Applying chips to files ----------
    function apply(targets, id, mode = 'toggle', { hud: showHud = true } = {}) {
        const i = byId.get(id);
        const paths = toFilePaths(targets);
        if (!i || !doc || !paths.length) return { mode, changed: 0, total: paths.length };
        if (mode === 'toggle') mode = paths.every((p) => chipsRaw(p).includes(id)) ? 'remove' : 'add';
        const edit = chipEditor(i, id, mode);
        const verb = mode === 'add' ? '붙이기' : '떼기';
        const { changed } = transaction(`칩 ${verb} "${hudLabel(id)}"`, (tx) => {
            for (const p of paths) tx.setChips(p, edit(tx.chipsOf(p)));
        });
        if (mode === 'add' && changed) rememberRecent(id);
        if (showHud) {
            if (!changed) hud(mode === 'add' ? '이미 모두 붙어 있어요' : '떼어 낼 칩이 없어요', { kind: 'info', sub: hudLabel(id) });
            else hud(`${mode === 'add' ? '＋' : '－'} ${hudLabel(id)}${paths.length > 1 ? ` — ${formatCount(paths.length)}개` : ''}`, { kind: mode });
        }
        return { mode, changed, total: paths.length };
    }

    // ---------- A chip target other than files: the viewer's selected video piece ----------
    // video-edit.js registers the provider. While a piece is selected, # · 1–9 · the chip drawer tag the piece.
    // Piece target: { kind: 'piece', path, start, end, label ('조각 2/3'), range, chips() → ids, stage(tx, ids), flush() }
    let pieceProvider = null;

    function setPieceProvider(fn) {
        pieceProvider = typeof fn === 'function' ? fn : null;
    }

    function pieceTarget() {
        if (!pieceProvider || !App.viewer?.isOpen) return null;
        try {
            const t = pieceProvider();
            return t && t.kind === 'piece' ? t : null;
        } catch (e) {
            return null;
        }
    }

    const isPiece = (t) => !!t && !Array.isArray(t) && t.kind === 'piece';

    /** counts() for files, or for a piece target (each of its chips → 1) */
    function countsFor(target) {
        if (!isPiece(target)) return counts(toFilePaths(target));
        const m = new Map();
        for (const id of target.chips()) m.set(id, 1);
        return m;
    }

    // The piece can be gone by the time a chip is chosen (an undone cut under the open picker …)
    function pieceGone(t, showHud) {
        if (!t.valid || t.valid()) return false;
        if (showHud) hud('고른 조각이 바뀌었어요', { kind: 'info', sub: '재생바에서 조각을 다시 골라 주세요' });
        return true;
    }

    /** apply() for a piece target — the same rules (parents, sub-chips, single-choice), ONE undo entry */
    function applyPiece(t, id, mode = 'toggle', { hud: showHud = true } = {}) {
        const i = byId.get(id);
        if (!i || !doc || !isPiece(t)) return { mode, changed: 0, total: 0 };
        t.flush?.();
        if (pieceGone(t, showHud)) return { mode, changed: 0, total: 0 };
        const cur = t.chips();
        if (mode === 'toggle') mode = cur.includes(id) ? 'remove' : 'add';
        const next = chipEditor(i, id, mode)(cur);
        const verb = mode === 'add' ? '붙이기' : '떼기';
        const changed = sameIds(cur, next) ? 0 : transaction(`조각 칩 ${verb} "${hudLabel(id)}"`, (tx) => t.stage(tx, next)).changed;
        if (mode === 'add' && changed) rememberRecent(id);
        if (showHud) {
            if (!changed) hud(mode === 'add' ? '이미 붙어 있어요' : '떼어 낼 칩이 없어요', { kind: 'info', sub: `${hudLabel(id)} · ${t.label}` });
            else hud(`${mode === 'add' ? '＋' : '－'} ${hudLabel(id)}`, { kind: mode, sub: `${t.label}${mode === 'add' ? '에 붙였어요' : '에서 뗐어요'}` });
        }
        return { mode, changed, total: 1 };
    }

    /**
     * Create a chip (in catId, or in a new search-type category "태그" when there is none) and put it on the files or
     * on a piece target — ONE undo entry. Reuses an existing chip with the same name. Returns the chip id.
     */
    function createAndApply(catId, name, targets, { hud: showHud = true } = {}) {
        const n = cleanName(name);
        if (!doc || !n) return null;
        const piece = isPiece(targets) ? targets : null;
        const paths = piece ? [] : toFilePaths(targets);
        piece?.flush?.();
        if (piece && pieceGone(piece, showHud)) return null;
        let id = null;
        transaction(`칩 만들고 붙이기 "${n}"`, (tx) => {
            let cat = catId ? findCat(tx.preset, catId) : null;
            if (!cat) {
                let catName = '태그';
                for (let i = 2; tx.preset.categories.some((c) => normKey(c.name) === normKey(catName)); i++) catName = `태그 ${i}`;
                cat = { id: newId('c'), name: catName, mode: 'search', chips: [] };
                tx.preset.categories.push(cat);
            }
            let chip = cat.chips.find((c) => normKey(c.name) === normKey(n));
            if (!chip) {
                chip = { id: newId('k'), name: n, children: [] };
                cat.chips.push(chip);
            }
            id = chip.id;
            const drop = new Set(cat.single ? cat.chips.filter((c) => c.id !== chip.id).flatMap(idsUnder) : []);
            for (const p of paths) {
                const cur = tx.chipsOf(p).filter((x) => !drop.has(x));
                if (!cur.includes(id)) cur.push(id);
                tx.setChips(p, cur);
            }
            if (piece) {
                const before = piece.chips();
                const next = before.filter((x) => !drop.has(x));
                if (!next.includes(id)) next.push(id);
                if (!sameIds(before, next)) piece.stage(tx, next);
            }
        });
        if (id) {
            if (paths.length || piece) rememberRecent(id);
            const sub = piece ? `새 칩을 만들어 ${piece.label}에 붙였어요` : paths.length ? '새 칩을 만들어 붙였어요' : '새 칩을 만들었어요';
            if (showHud) hud(`＋ ${hudLabel(id)}${paths.length > 1 ? ` — ${formatCount(paths.length)}개` : ''}`, { kind: 'add', sub });
        }
        return id;
    }

    // Recently applied chips (per workspace, newest first) — search-type categories show them as quick picks
    function recent() {
        return App.settings.get(`chips.recent.${wsId}`, []).filter((id) => byId.has(id));
    }

    function rememberRecent(id) {
        if (!wsId) return;
        const next = [id, ...recent().filter((x) => x !== id)].slice(0, 24);
        App.settings.set(`chips.recent.${wsId}`, next);
    }

    // ---------- Structure edits ----------
    function findCat(preset, catId) {
        return preset.categories.find((c) => c.id === catId) || null;
    }

    function siblingsOf(id, preset = active()) {
        for (const cat of preset.categories) {
            const top = cat.chips.find((c) => c.id === id);
            if (top) return { list: cat.chips, cat, parent: null, item: top };
            for (const c of cat.chips) {
                const sub = c.children.find((s) => s.id === id);
                if (sub) return { list: c.children, cat, parent: c, item: sub };
            }
        }
        return null;
    }

    function addCategory({ name, mode = 'select', color = null, single = false } = {}) {
        const n = cleanName(name);
        const err = validateName(name, active()?.categories || []);
        if (err) throw new Error(err);
        return commit(`분류 추가 "${n}"`, (d, preset) => {
            const cat = { id: newId('c'), name: n, mode: mode === 'search' ? 'search' : 'select', chips: [] };
            if (COLORS.includes(color)) cat.color = color;
            if (single) cat.single = true;
            preset.categories.push(cat);
            return cat;
        });
    }

    /** Add one or more chips (names) to a category (or under a parent chip). Existing names are reused. Returns chips. */
    function addChips(catId, names, { parentId = null } = {}) {
        const preset = active();
        const cat = preset && findCat(preset, catId);
        if (!cat) throw new Error('분류를 찾을 수 없어요');
        const parent = parentId ? cat.chips.find((c) => c.id === parentId) : null;
        if (parentId && !parent) throw new Error('상위 칩을 찾을 수 없어요');
        const clean = [...new Set((Array.isArray(names) ? names : [names]).map(cleanName).filter(Boolean))];
        if (!clean.length) return [];
        const list = parent ? parent.children : cat.chips;
        const created = clean.filter((n) => !list.some((c) => normKey(c.name) === normKey(n)));
        const label = created.length === 1 ? `칩 추가 "${created[0]}"` : `칩 ${created.length}개 추가`;
        const run = (d, pr) => {
            const c2 = findCat(pr, catId);
            const l2 = parentId ? c2.chips.find((c) => c.id === parentId).children : c2.chips;
            return clean.map((n) => {
                const existing = l2.find((c) => normKey(c.name) === normKey(n));
                if (existing) return existing;
                const chip = parentId ? { id: newId('k'), name: n } : { id: newId('k'), name: n, children: [] };
                l2.push(chip);
                return chip;
            });
        };
        if (!created.length) return run(doc, preset);
        return commit(label, run);
    }

    function renameChip(id, name) {
        const loc = siblingsOf(id);
        if (!loc) throw new Error('칩을 찾을 수 없어요');
        const err = validateName(name, loc.list, loc.item);
        if (err) throw new Error(err);
        const n = cleanName(name);
        const old = loc.item.name;
        if (n === old) return;
        commit(`칩 이름 바꾸기 "${old}" → "${n}"`, (d) => {
            // The same chip may live in several presets (duplicated presets share chip IDs)
            for (const pr of d.presets) {
                for (const cat of pr.categories) {
                    for (const c of cat.chips) {
                        if (c.id === id) c.name = n;
                        for (const s of c.children) if (s.id === id) s.name = n;
                    }
                }
            }
        });
    }

    function renameCategory(catId, name) {
        const preset = active();
        const cat = findCat(preset, catId);
        if (!cat) throw new Error('분류를 찾을 수 없어요');
        const err = validateName(name, preset.categories, cat);
        if (err) throw new Error(err);
        const n = cleanName(name);
        if (n === cat.name) return;
        commit(`분류 이름 바꾸기 "${cat.name}" → "${n}"`, (d, pr) => {
            findCat(pr, catId).name = n;
        });
    }

    function setCategory(catId, patch) {
        const cat = findCat(active(), catId);
        if (!cat) return;
        const label = 'mode' in patch ? `"${cat.name}"을 ${MODE_NAMES[patch.mode]}으로` : 'color' in patch ? `"${cat.name}" 색 바꾸기` : `"${cat.name}" 설정 바꾸기`;
        commit(label, (d, pr) => {
            const c = findCat(pr, catId);
            if ('mode' in patch) c.mode = patch.mode === 'search' ? 'search' : 'select';
            if ('color' in patch) {
                if (COLORS.includes(patch.color)) c.color = patch.color;
                else delete c.color;
            }
            if ('single' in patch) {
                if (patch.single) c.single = true;
                else delete c.single;
            }
        });
    }

    function moveInList(list, item, delta) {
        const i = list.indexOf(item);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= list.length) return false;
        list.splice(i, 1);
        list.splice(j, 0, item);
        return true;
    }

    function moveChip(id, delta) {
        const loc = siblingsOf(id);
        if (!loc) return;
        const i = loc.list.indexOf(loc.item);
        if (i + delta < 0 || i + delta >= loc.list.length) return;
        commit(`칩 순서 바꾸기 "${loc.item.name}"`, () => {
            const l2 = siblingsOf(id);
            moveInList(l2.list, l2.item, delta);
        });
    }

    function moveCategory(catId, delta) {
        const preset = active();
        const cat = findCat(preset, catId);
        if (!cat) return;
        const i = preset.categories.indexOf(cat);
        if (i + delta < 0 || i + delta >= preset.categories.length) return;
        commit(`분류 순서 바꾸기 "${cat.name}"`, (d, pr) => {
            moveInList(pr.categories, findCat(pr, catId), delta);
        });
    }

    /** Move a top-level chip (with its sub-chips) into another category of the active preset. */
    function moveChipTo(id, catId) {
        const loc = siblingsOf(id);
        const target = findCat(active(), catId);
        if (!loc || loc.parent || !target || loc.cat === target) return;
        if (target.chips.some((c) => normKey(c.name) === normKey(loc.item.name))) throw new Error(`"${target.name}"에 같은 이름의 칩이 이미 있어요`);
        commit(`칩 옮기기 "${loc.item.name}" → ${target.name}`, (d, pr) => {
            const l2 = siblingsOf(id, pr);
            l2.list.splice(l2.list.indexOf(l2.item), 1);
            findCat(pr, catId).chips.push(l2.item);
        });
    }

    // ids that would disappear from every preset if `remove` (a set of ids) is taken out of the active preset
    function orphansAfter(removeIds) {
        const act = active();
        const elsewhere = new Set();
        for (const pr of doc.presets) {
            if (pr === act) continue;
            for (const cat of pr.categories) {
                for (const c of cat.chips) {
                    elsewhere.add(c.id);
                    for (const s of c.children) elsewhere.add(s.id);
                }
            }
        }
        return [...removeIds].filter((id) => !elsewhere.has(id));
    }

    function stripFromFiles(tx, ids) {
        const set = new Set(ids);
        if (!set.size) return 0;
        let n = 0;
        for (const [p, e] of App.catalog.entries()) {
            if (!e.chips || !e.chips.some((x) => set.has(x))) continue;
            tx.setChips(p, e.chips.filter((x) => !set.has(x)));
            n++;
        }
        return n;
    }

    /** Files (existing) that would lose a chip if these ids were removed from the active preset. */
    function impactOf(ids) {
        const orphans = new Set(orphansAfter(ids));
        let files = 0;
        for (const [p, e] of App.catalog.entries()) if (e.chips && e.chips.some((x) => orphans.has(x)) && fileExists(p)) files++;
        return { files, shared: ids.length - orphans.size };
    }

    function idsUnder(item) {
        return [item.id, ...(item.children || []).map((s) => s.id)];
    }

    function removeChip(id) {
        const loc = siblingsOf(id);
        if (!loc) return;
        const ids = idsUnder(loc.item);
        const orphans = orphansAfter(ids);
        transaction(`칩 삭제 "${loc.item.name}"`, (tx) => {
            const l2 = siblingsOf(id, tx.preset);
            l2.list.splice(l2.list.indexOf(l2.item), 1);
            for (const [k, v] of Object.entries(tx.preset.hotkeys || {})) if (ids.includes(v)) delete tx.preset.hotkeys[k];
            stripFromFiles(tx, orphans);
        });
    }

    function removeCategory(catId) {
        const preset = active();
        const cat = findCat(preset, catId);
        if (!cat) return;
        const ids = cat.chips.flatMap(idsUnder);
        const orphans = orphansAfter(ids);
        transaction(`분류 삭제 "${cat.name}"`, (tx) => {
            tx.preset.categories = tx.preset.categories.filter((c) => c.id !== catId);
            for (const [k, v] of Object.entries(tx.preset.hotkeys || {})) if (ids.includes(v)) delete tx.preset.hotkeys[k];
            stripFromFiles(tx, orphans);
        });
    }

    /** Merge chip `fromId` into `toId` (same level): files move over, sub-chips are merged by name, `fromId` is removed. */
    function mergeChip(fromId, toId) {
        const a = siblingsOf(fromId);
        const b = siblingsOf(toId);
        if (!a || !b || fromId === toId) return;
        if (!!a.parent !== !!b.parent) throw new Error('같은 단계의 칩끼리만 합칠 수 있어요');
        return transaction(`칩 합치기 "${a.item.name}" → "${b.item.name}"`, (tx) => {
            const from = siblingsOf(fromId, tx.preset);
            const to = siblingsOf(toId, tx.preset);
            const remap = new Map([[fromId, toId]]);
            if (!from.parent) {
                for (const s of from.item.children) {
                    const same = to.item.children.find((x) => normKey(x.name) === normKey(s.name));
                    if (same) remap.set(s.id, same.id);
                    else to.item.children.push(s);
                }
            }
            from.list.splice(from.list.indexOf(from.item), 1);
            // A digit that pointed at the merged chip moves to the target (unless the target already has one)
            const hk = tx.preset.hotkeys || {};
            const targetHasKey = Object.values(hk).includes(toId);
            for (const [k, v] of Object.entries(hk)) {
                if (v !== fromId) continue;
                if (targetHasKey) delete hk[k];
                else hk[k] = toId;
            }
            tx.rebuild();
            const toParent = to.parent ? to.parent.id : null;
            for (const [p, e] of App.catalog.entries()) {
                if (!e.chips || !e.chips.some((x) => remap.has(x))) continue;
                const next = [];
                for (const x of e.chips) {
                    const y = remap.get(x) || x;
                    if (!next.includes(y)) next.push(y);
                }
                if (toParent && !next.includes(toParent)) next.unshift(toParent);
                tx.setChips(p, next);
            }
        });
    }

    function setHotkey(id, digit) {
        const preset = active();
        if (!preset || !byId.has(id)) return;
        const name = nameOf(id);
        commit(digit ? `단축키 ${digit} → "${name}"` : `단축키 없애기 "${name}"`, (d, pr) => {
            pr.hotkeys = pr.hotkeys || {};
            for (const [k, v] of Object.entries(pr.hotkeys)) if (v === id || k === String(digit)) delete pr.hotkeys[k];
            if (digit) pr.hotkeys[String(digit)] = id;
        });
    }

    // ---------- Presets ----------
    function presets() {
        return doc ? doc.presets.map((p) => ({ id: p.id, name: p.name, active: p.id === doc.activePreset, categories: p.categories.length })) : [];
    }

    function setActive(id) {
        if (!doc || doc.activePreset === id || !doc.presets.some((p) => p.id === id)) return;
        doc.activePreset = id;
        rebuild();
        persist();
        emit('preset');
    }

    function createPreset(name, { duplicate = false } = {}) {
        const err = validateName(name, doc.presets);
        if (err) throw new Error(err);
        const n = cleanName(name);
        return commit(duplicate ? `세트 복제 "${n}"` : `새 칩 세트 "${n}"`, (d, cur) => {
            const categories = duplicate ? clone(cur.categories).map((c) => ({ ...c, id: newId('c') })) : [];
            const preset = { id: newId('p'), name: n, hotkeys: duplicate ? { ...(cur.hotkeys || {}) } : {}, categories };
            d.presets.push(preset);
            d.activePreset = preset.id;
            return preset;
        }, { presetOp: true });
    }

    function movePreset(id, delta) {
        const i = doc ? doc.presets.findIndex((p) => p.id === id) : -1;
        const j = i + delta;
        if (i < 0 || j < 0 || j >= doc.presets.length) return;
        commit(`세트 순서 바꾸기 "${doc.presets[i].name}"`, (d) => {
            const [p] = d.presets.splice(i, 1);
            d.presets.splice(j, 0, p);
        });
    }

    function renamePreset(id, name) {
        const p = doc?.presets.find((x) => x.id === id);
        if (!p) return;
        const err = validateName(name, doc.presets, p);
        if (err) throw new Error(err);
        const n = cleanName(name);
        if (n === p.name) return;
        commit(`세트 이름 바꾸기 "${p.name}" → "${n}"`, (d) => {
            d.presets.find((x) => x.id === id).name = n;
        });
    }

    function presetImpact(id) {
        const p = doc?.presets.find((x) => x.id === id);
        if (!p) return { files: 0 };
        const mine = new Set(p.categories.flatMap((c) => c.chips.flatMap(idsUnder)));
        const elsewhere = new Set();
        for (const pr of doc.presets) if (pr !== p) for (const c of pr.categories) for (const ch of c.chips) for (const x of idsUnder(ch)) elsewhere.add(x);
        const orphans = new Set([...mine].filter((x) => !elsewhere.has(x)));
        let files = 0;
        for (const [path, e] of App.catalog.entries()) if (e.chips && e.chips.some((x) => orphans.has(x)) && fileExists(path)) files++;
        return { files, orphans };
    }

    function deletePreset(id) {
        if (!doc || doc.presets.length <= 1) throw new Error('칩 세트가 하나뿐이라 지울 수 없어요');
        const p = doc.presets.find((x) => x.id === id);
        if (!p) return;
        const { orphans } = presetImpact(id);
        transaction(`세트 삭제 "${p.name}"`, (tx) => {
            tx.doc.presets = tx.doc.presets.filter((x) => x.id !== id);
            if (tx.doc.activePreset === id) tx.doc.activePreset = tx.doc.presets[0].id;
            stripFromFiles(tx, [...orphans]);
        }, { presetOp: true });
    }

    function exportPreset(id) {
        const preset = doc?.presets.find((p) => p.id === id);
        if (!preset) throw new Error('칩 세트를 찾을 수 없어요');
        return clone(preset);
    }

    function importPreset(obj, { replace = false } = {}) {
        if (!doc) throw new Error('작업 폴더를 먼저 열어 주세요');
        if (!obj || typeof obj !== 'object' || Array.isArray(obj) || typeof obj.id !== 'string' || !obj.id || typeof obj.name !== 'string' || !cleanName(obj.name) || !Array.isArray(obj.categories)) {
            throw new Error('칩 세트 파일 형식을 확인해 주세요');
        }
        const existing = doc.presets.find((p) => p.id === obj.id);
        if (existing && !replace) throw new Error('같은 세트가 이미 있어요');
        const preset = normalize({ presets: [clone(obj)] }).presets[0];
        preset.name = uniqueName(preset.name, doc.presets.filter((p) => p.id !== preset.id));
        return commit(`세트 불러오기 "${preset.name}"`, (d) => {
            const i = d.presets.findIndex((p) => p.id === preset.id);
            if (i < 0) d.presets.push(preset);
            else d.presets[i] = preset;
            preset.updatedAt = tick();
            d.activePreset = preset.id;
            return preset;
        }, { presetOp: true });
    }

    // ---------- HUD (brief centered confirmation) ----------
    let hudEl = null;
    let hudTimer = null;

    function hud(text, { kind = 'add', sub = '' } = {}) {
        if (!hudEl) {
            hudEl = h('div', { id: 'chip-hud', class: 'chip-hud', role: 'status', 'aria-live': 'polite' });
            document.body.append(hudEl);
        }
        clearTimeout(hudTimer);
        hudEl.className = `chip-hud ${kind}`;
        hudEl.innerHTML = '';
        hudEl.append(h('span', { class: 'chip-hud-text', text }));
        if (sub) hudEl.append(h('span', { class: 'chip-hud-sub', text: sub }));
        // A dialog is up (e.g. it opened right after the action): it already has the user's attention
        if (document.querySelector('.dialog-backdrop')) return;
        void hudEl.offsetWidth;
        hudEl.classList.add('show');
        hudTimer = setTimeout(() => hudEl.classList.remove('show'), kind === 'info' ? 2200 : 1300);
    }

    // ---------- Persistence lifecycle ----------
    async function load() {
        const token = ++loadToken;
        await saves;
        if (token !== loadToken) return;
        const ws = App.state.workspace?.id || null;
        wsId = ws;
        doc = null;
        chipset.ready = false;
        rebuild();
        let d = null;
        let source = 'file';
        try {
            d = await App.wsdata.read('chipsets', null);
        } catch (e) {
            d = null;
        }
        if (token !== loadToken) return;
        if (!d && ws) {
            try {
                const copy = await App.idb.get(`chipsets.${ws}`);
                if (copy && Array.isArray(copy.presets)) {
                    d = copy;
                    source = 'idb';
                }
            } catch (e) {
                /* no copy */
            }
        }
        if (token !== loadToken) return;
        const [library, lastActive] = await Promise.all([
            App.idb.get('chipsets.library').catch(() => null),
            App.idb.get('chipsets.lastActive').catch(() => null),
        ]);
        if (token !== loadToken) return;
        doc = mergeLibrary([library, d], d?.activePreset, lastActive);
        rebuild();
        await persist();
        if (token !== loadToken) return;
        chipset.ready = true;
        if (source === 'idb') {
            ui.toast('칩 세트 파일이 없어서 이 브라우저에 있던 사본으로 되살렸어요', { type: 'warning', duration: 7000 });
        } else if (d && doc.presets.some((p) => p.categories.length)) {
            App.wsdata.backup('chipsets', clone(doc));
        }
        App.bus.emit('chipset:loaded');
        emit('load');
    }

    // ---------- Hotkeys 1–9 (main gallery + full-screen viewer) ----------
    function targetFiles(scope) {
        if (scope === 'viewer') {
            const cur = App.viewer?.current;
            return cur && cur.kind === 'file' ? [cur.path] : [];
        }
        return App.select.entries().filter((e) => e.kind === 'file').map((e) => e.path);
    }

    function runHotkey(digit, scope) {
        const id = active()?.hotkeys?.[digit];
        if (!id || !byId.has(id)) {
            hud(`${digit}번 칩 단축키가 비어 있어요`, { kind: 'info', sub: '칩을 우클릭해서 [단축키 지정]을 골라 보세요' });
            return;
        }
        const piece = scope === 'viewer' ? pieceTarget() : null;
        if (piece) {
            applyPiece(piece, id, 'toggle');
            return;
        }
        const files = targetFiles(scope);
        if (!files.length) {
            hud('칩을 붙일 파일을 먼저 선택해 주세요', { kind: 'info', sub: hudLabel(id) });
            return;
        }
        apply(files, id, 'toggle');
    }

    for (let d = 1; d <= 9; d++) {
        App.commands.register({ id: `chips.toggleHotkey${d}`, title: `칩 단축키 ${d}`, group: '칩', icon: 'tag', keys: String(d), when: () => !!doc && App.fs.ready, run: () => runHotkey(String(d), 'main') });
        App.commands.register({ id: `chips.toggleHotkey${d}.viewer`, title: `칩 단축키 ${d} (보기 화면)`, group: '칩', icon: 'tag', keys: String(d), scope: 'viewer', when: () => !!doc && !!App.viewer?.isOpen, run: () => runHotkey(String(d), 'viewer') });
    }

    // Command titles show which chip a digit toggles ("칩 단축키 1 — 배우 · 김수현")
    function syncHotkeyTitles() {
        const preset = doc ? active() : null;
        for (let d = 1; d <= 9; d++) {
            const id = preset?.hotkeys?.[d];
            const label = id && byId.has(id) ? ` — ${hudLabel(id)}` : '';
            const a = App.commands.get(`chips.toggleHotkey${d}`);
            const b = App.commands.get(`chips.toggleHotkey${d}.viewer`);
            if (a) a.title = `칩 단축키 ${d}${label}`;
            if (b) b.title = `칩 단축키 ${d}${label} (보기 화면)`;
        }
        App.bus.emit('commands:changed');
    }

    const chipset = {
        ready: false,
        COLORS,
        COLOR_NAMES,
        MODE_NAMES,
        get doc() {
            return doc;
        },
        get workspaceId() {
            return wsId;
        },
        active,
        presets,
        setActive,
        list,
        info,
        nameOf,
        labelOf,
        hudLabel,
        category: (catId) => catById.get(catId)?.cat || null,
        inActive: (id) => activeIds.has(id),
        sortIds,
        chipsOf,
        counts,
        usage,
        filesWith,
        recent,
        hotkeyOf,
        toFilePaths,
        targetFiles,
        apply,
        createAndApply,
        pieceTarget,
        setPieceProvider,
        countsFor,
        applyPiece,
        addCategory,
        addChips,
        addChip: (catId, name, opts) => addChips(catId, [name], opts)[0] || null,
        renameChip,
        renameCategory,
        setCategory,
        moveChip,
        moveCategory,
        moveChipTo,
        removeChip,
        removeCategory,
        mergeChip,
        impactOf,
        idsUnder,
        setHotkey,
        createPreset,
        renamePreset,
        movePreset,
        deletePreset,
        presetImpact,
        exportPreset,
        importPreset,
        transaction,
        commit,
        validateName,
        cleanName,
        normKey,
        match,
        isInitials,
        hud,
        load,
    };

    App.register('chipset', {
        init() {
            App.workspace.flushHooks?.push(() => saves);
            App.bus.on('workspace:opened', () => load());
            App.bus.on('workspace:closed', () => {
                loadToken++;
                doc = null;
                wsId = null;
                chipset.ready = false;
                rebuild();
                emit('close');
            });
            const dropUsage = () => {
                usageCache = null;
            };
            App.bus.on('catalog:changed', dropUsage);
            App.bus.on('catalog:loaded', dropUsage);
            App.bus.on('index:changed', dropUsage);
            App.bus.on('index:ready', dropUsage);
        },
    });

    App.chipset = chipset;
})();
