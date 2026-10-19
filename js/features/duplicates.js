/*
 * Duplicate finder v2 — data, safe clean-up and commands (App.dupes).
 *
 *   duplicates.js      this file: dupes.json store (exclusions, "중복 아님" pairs, rules, folder roles, review progress),
 *                      verified clean-up (ONE undo step, metadata merge, dupes-log.json), commands
 *   dupes-engine.js    fingerprints (IndexedDB cache), the owner's matching rule, browser + server engines, pre-build job
 *   dupes-review.js    the panel: scope picker, scanning, side-by-side review with synced playback
 *   dupes-tools.js     rules dialog (live preview), exclusions manager, context menus, viewer toolbar, settings page
 *
 * .fluid-organizer/dupes.json = { version: 1, excludedFiles, excludedFolders, notDuplicates: [[a, b]],
 *                                 rules: { frameBits, minFrames, durSec, durPct, sureSec, imageBits, folderPriority: [{ path, role }] },
 *                                 lastScan: { id, at, scope, engine, counts, reviewed: { groupId: decision } } }
 * Paths follow renames/moves. Every user change is ONE undo step (Ctrl+Z from any screen).
 */
(() => {
    'use strict';
    const { path: P, formatCount, formatBytes } = App.util;
    const ui = App.ui;
    const kit = App.organize.kit;

    // =================================================================================================
    // Store (dupes.json)
    // =================================================================================================
    const ROLE_LABEL = { keep: '보관 폴더', remove: '정리 폴더' };
    const blank = () => ({ version: 1, excludedFiles: [], excludedFolders: [], notDuplicates: [], rules: { folderPriority: [] }, lastScan: null });
    const clone = (o) => JSON.parse(JSON.stringify(o));
    const pairKey = (a, b) => (a < b ? `${a}\n${b}` : `${b}\n${a}`);
    const isAbs = (p) => /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p || '');
    const normAbs = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

    /** child inside dir (workspace paths with '/', absolute paths case-insensitively); '' never matches everything. */
    function inside(child, dir) {
        if (dir == null) return false;
        if (isAbs(dir) || isAbs(child)) {
            if (isAbs(dir) !== isAbs(child)) return false;
            const c = normAbs(child);
            const d = normAbs(dir);
            return c === d || c.startsWith(d + '/');
        }
        if (dir === '') return true;
        return child === dir || child.startsWith(dir + '/');
    }

    function normalize(d) {
        const out = blank();
        if (!d || typeof d !== 'object') return out;
        const strs = (a) => (Array.isArray(a) ? [...new Set(a.filter((x) => typeof x === 'string'))] : []);
        out.excludedFiles = strs(d.excludedFiles);
        out.excludedFolders = strs(d.excludedFolders).filter((x) => x !== '');
        const seen = new Set();
        for (const p of Array.isArray(d.notDuplicates) ? d.notDuplicates : []) {
            if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'string' || typeof p[1] !== 'string' || p[0] === p[1]) continue;
            const k = pairKey(p[0], p[1]);
            if (seen.has(k)) continue;
            seen.add(k);
            out.notDuplicates.push(p[0] < p[1] ? [p[0], p[1]] : [p[1], p[0]]);
        }
        const r = d.rules && typeof d.rules === 'object' ? d.rules : {};
        out.rules = { ...r, folderPriority: [] };
        const fp = new Map();
        for (const x of Array.isArray(r.folderPriority) ? r.folderPriority : []) {
            if (x && typeof x.path === 'string' && (x.role === 'keep' || x.role === 'remove')) fp.set(x.path, x.role);
        }
        out.rules.folderPriority = [...fp].map(([path, role]) => ({ path, role }));
        if (d.lastScan && typeof d.lastScan === 'object') {
            out.lastScan = { ...d.lastScan, reviewed: d.lastScan.reviewed && typeof d.lastScan.reviewed === 'object' ? { ...d.lastScan.reviewed } : {} };
        }
        if (Array.isArray(d.extraRoots)) out.extraRoots = strs(d.extraRoots);
        return out;
    }

    const store = {
        data: blank(),
        ws: null,
        loading: null,
        files: new Set(),
        pairs: new Set(),
        pairPaths: new Set(),
        roles: [],
        saving: Promise.resolve(),
        backedUp: false,

        ready() {
            const ws = App.state.workspace?.id || null;
            if (this.ws !== ws || !this.loading) {
                this.ws = ws;
                this.loading = this.load(ws);
            }
            return this.loading;
        },
        async load(ws) {
            let d = null;
            if (ws && App.fs.ready) d = await App.wsdata.read('dupes', null);
            if (this.ws !== ws) return;
            this.data = normalize(d);
            this.reindex();
        },
        reindex() {
            const d = this.data;
            this.files = new Set(d.excludedFiles);
            this.pairs = new Set(d.notDuplicates.map(([a, b]) => pairKey(a, b)));
            this.pairPaths = new Set(d.notDuplicates.flat());
            this.roles = d.rules.folderPriority.slice().sort((a, b) => b.path.length - a.path.length);
        },
        save() {
            const ws = this.ws;
            const snapshot = clone(this.data);
            this.saving = this.saving.then(async () => {
                if (!App.fs.ready || App.state.workspace?.id !== ws) return;
                await App.wsdata.write('dupes', snapshot);
                if (!this.backedUp) {
                    this.backedUp = true;
                    App.wsdata.backup('dupes', snapshot);
                }
            }).catch((e) => {
                console.error('[dupes] saving dupes.json failed', e);
                ui.toast('중복검사 설정을 저장하지 못했어요', { type: 'error' });
            });
            return this.saving;
        },
        saveSoon: null,
        isExcluded(p) {
            if (this.files.has(p)) return true;
            for (const f of this.data.excludedFolders) if (inside(p, f)) return true;
            return false;
        },
        excludedBy(p) {
            if (this.files.has(p)) return { type: 'file', path: p };
            for (const f of this.data.excludedFolders) if (inside(p, f)) return { type: 'folder', path: f };
            return null;
        },
        isNotDup(a, b) {
            return this.pairs.has(pairKey(a, b));
        },
        roleOf(p) {
            for (const r of this.roles) if (inside(p, r.path)) return r.role;
            return null;
        },
        roleEntry(p) {
            for (const r of this.roles) if (inside(p, r.path)) return r;
            return null;
        },
        rules() {
            const eng = App.dupes.engine;
            return eng ? eng.normalizeRules(this.data.rules) : { ...this.data.rules };
        },
    };
    store.saveSoon = App.util.debounce(() => store.save(), 400);

    function emit(reason, extra) {
        App.bus.emit('dupes:changed', { reason, ...(extra || {}) });
    }

    /**
     * One user change = one undo step. fn(data) mutates; resolves false when nothing changed.
     * Mutations run one after another (no interleaved snapshots), and the before/after snapshots kept for undo follow
     * later renames/moves (see undoSnaps).
     */
    let mutateChain = Promise.resolve();
    const undoSnaps = new Set();
    function mutate(label, fn, opts = {}) {
        const run = mutateChain.then(() => mutateNow(label, fn, opts));
        mutateChain = run.catch(() => {});
        return run;
    }

    async function mutateNow(label, fn, { reason = 'data', undoable = true } = {}) {
        await store.ready();
        const ws = store.ws;
        const part = (d) => clone({ excludedFiles: d.excludedFiles, excludedFolders: d.excludedFolders, notDuplicates: d.notDuplicates, rules: d.rules });
        const before = part(store.data);
        fn(store.data);
        store.data = normalize({ ...store.data });
        const after = part(store.data);
        if (JSON.stringify(before) === JSON.stringify(after)) return false;
        store.reindex();
        await store.save();
        emit(reason);
        if (undoable) {
            const rec = { before, after };
            undoSnaps.add(rec);
            if (undoSnaps.size > 300) undoSnaps.delete(undoSnaps.values().next().value);
            const put = (key) => {
                const run = mutateChain.then(async () => {
                    if ((App.state.workspace?.id || null) !== ws) throw new Error('다른 작업 폴더라서 되돌릴 수 없어요');
                    await store.ready();
                    Object.assign(store.data, clone(rec[key]));
                    store.data = normalize(store.data);
                    store.reindex();
                    await store.save();
                    emit(reason, { undo: true });
                });
                mutateChain = run.catch(() => {});
                return run;
            };
            App.undo.push({ label, undo: () => put('before'), redo: () => put('after') });
        }
        return true;
    }

    // ---- public data operations ----
    const uniq = (a) => [...new Set(a)];

    function excludeFiles(paths, on = true) {
        paths = uniq(paths.filter(Boolean));
        if (!paths.length) return Promise.resolve(false);
        const label = on ? `중복검사에서 ${paths.length > 1 ? `파일 ${formatCount(paths.length)}개` : `‘${P.base(paths[0])}’`} 빼기` : '중복검사에 다시 넣기';
        return mutate(label, (d) => {
            const set = new Set(d.excludedFiles);
            for (const p of paths) (on ? set.add(p) : set.delete(p));
            d.excludedFiles = [...set];
        }, { reason: 'exclude' });
    }

    function excludeFolders(paths, on = true) {
        paths = uniq(paths.filter((p) => typeof p === 'string' && p !== ''));
        if (!paths.length) return Promise.resolve(false);
        const label = on ? `중복검사에서 ‘${kit.folderLabel(paths[0]) || paths[0]}’ 폴더 빼기` : '중복검사에 폴더 다시 넣기';
        return mutate(label, (d) => {
            const set = new Set(d.excludedFolders);
            for (const p of paths) (on ? set.add(p) : set.delete(p));
            d.excludedFolders = [...set];
        }, { reason: 'exclude' });
    }

    /** "중복 아님": every pair among `paths` (or [a, b] pairs) is remembered and never grouped again. */
    function markNotDuplicate(pairsOrPaths, on = true) {
        let pairs = [];
        if (pairsOrPaths.length && Array.isArray(pairsOrPaths[0])) pairs = pairsOrPaths;
        else for (let i = 0; i < pairsOrPaths.length; i++) for (let j = i + 1; j < pairsOrPaths.length; j++) pairs.push([pairsOrPaths[i], pairsOrPaths[j]]);
        if (!pairs.length) return Promise.resolve(false);
        return mutate(on ? '중복 아님으로 표시' : '‘중복 아님’ 표시 지우기', (d) => {
            const map = new Map(d.notDuplicates.map(([a, b]) => [pairKey(a, b), [a, b]]));
            for (const [a, b] of pairs) {
                if (on) map.set(pairKey(a, b), [a, b]);
                else map.delete(pairKey(a, b));
            }
            d.notDuplicates = [...map.values()];
        }, { reason: 'pairs' });
    }

    function setFolderRole(path, role) {
        if (typeof path !== 'string') return Promise.resolve(false);
        const label = role ? `‘${kit.folderLabel(path)}’ 폴더를 ${ROLE_LABEL[role]}로 지정` : `‘${kit.folderLabel(path)}’ 폴더 역할 지우기`;
        return mutate(label, (d) => {
            const list = d.rules.folderPriority.filter((x) => x.path !== path);
            if (role === 'keep' || role === 'remove') list.push({ path, role });
            d.rules.folderPriority = list;
        }, { reason: 'roles' });
    }

    function setRules(patch, { label = '중복검사 규칙 바꾸기' } = {}) {
        return mutate(label, (d) => {
            const fp = d.rules.folderPriority;
            d.rules = { ...d.rules, ...patch, folderPriority: patch.folderPriority || fp };
        }, { reason: 'rules' });
    }

    function resetRules() {
        return mutate('중복검사 규칙 기본값으로', (d) => {
            d.rules = { folderPriority: d.rules.folderPriority };
        }, { reason: 'rules' });
    }

    // ---- review progress (not undoable: it is where you are, not a change to your library) ----
    /**
     * Start a new review: decisions (and keeper choices) carry over for groups that are still exactly the same.
     * Synchronous on purpose (the store is loaded before any scan starts) so the panel reads the result right away.
     */
    function setLastScan(meta) {
        const prev = store.data.lastScan;
        const reviewed = {};
        const choices = {};
        if (prev && meta.groupIds) {
            const ids = new Set(meta.groupIds);
            for (const [gid, v] of Object.entries(prev.reviewed || {})) if (ids.has(gid) && v !== 'applied') reviewed[gid] = v;
            for (const [gid, v] of Object.entries(prev.choices || {})) if (ids.has(gid)) choices[gid] = v;
        }
        const { groupIds, ...rest } = meta;
        store.data.lastScan = { ...rest, reviewed, choices };
        store.saveSoon();
        return store.data.lastScan;
    }

    function setReviewed(scanId, gid, decision, choice) {
        const ls = store.data.lastScan;
        if (!ls || ls.id !== scanId) return;
        if (decision) ls.reviewed[gid] = decision;
        else delete ls.reviewed[gid];
        if (choice !== undefined) {
            if (!ls.choices) ls.choices = {};
            if (choice && (choice.keep || (choice.leave && choice.leave.length))) ls.choices[gid] = choice;
            else delete ls.choices[gid];
        }
        store.saveSoon();
        App.bus.emit('dupes:reviewed', { scanId, gid, decision });
    }

    // ---- follow renames / moves ----
    /** Applies every (from → to) in order, so A→B then B→C ends at C. */
    function rebaser(pairs) {
        const state = { changed: false };
        state.fix = (p) => {
            if (typeof p !== 'string') return p;
            let cur = p;
            for (const [from, to] of pairs) {
                const r = P.rebase(cur, from, to);
                if (r != null && r !== cur) cur = r;
            }
            if (cur !== p) state.changed = true;
            return cur;
        };
        return state;
    }

    function rebaseData(d, pairs) {
        const rb = rebaser(pairs);
        d.excludedFiles = d.excludedFiles.map(rb.fix);
        d.excludedFolders = d.excludedFolders.map(rb.fix);
        d.notDuplicates = d.notDuplicates.map(([a, b]) => [rb.fix(a), rb.fix(b)]);
        d.rules.folderPriority = d.rules.folderPriority.map((x) => ({ ...x, path: rb.fix(x.path) }));
        return rb.changed;
    }

    function rebaseScope(sc, fix) {
        if (!sc || typeof sc !== 'object') return sc;
        const out = { ...sc };
        if (typeof out.path === 'string') out.path = fix(out.path);
        for (const k of ['paths', 'a', 'b']) if (Array.isArray(out[k])) out[k] = out[k].map(fix);
        return out;
    }

    /**
     * Rebase a saved scan result in place: raw items/sets/edges, scope, focus and the group snapshot. Group ids are made
     * from member paths, so they change too -> returns { changed, idMap: Map(oldId → newId) }.
     */
    function rebaseResult(result, pairs) {
        const idMap = new Map();
        if (!result || !result.raw) return { changed: false, idMap };
        const rb = rebaser(pairs);
        for (const m of result.raw.items) {
            if (m.root) continue;
            const n = rb.fix(m.path);
            if (n !== m.path) {
                m.path = n;
                m.name = P.base(n);
            }
        }
        result.raw.exactSets = result.raw.exactSets.map((s) => s.map(rb.fix));
        for (const e of result.raw.edges) {
            e.a = rb.fix(e.a);
            e.b = rb.fix(e.b);
        }
        result.scope = rebaseScope(result.scope, rb.fix);
        if (result.focus) result.focus = rb.fix(result.focus);
        if (Array.isArray(result.snapshot)) {
            for (const g of result.snapshot) {
                let moved = false;
                for (const m of g.members) {
                    if (m.root) continue;
                    const n = rb.fix(m.path);
                    if (n !== m.path) {
                        m.path = n;
                        m.name = P.base(n);
                        moved = true;
                    }
                }
                if (g.keep) g.keep = rb.fix(g.keep);
                if (!moved || !App.dupes.engine) continue;
                const id = App.dupes.engine.groupIdOf(g.members.map((m) => m.path));
                if (id !== g.id) {
                    idMap.set(g.id, id);
                    g.id = id;
                }
            }
        }
        return { changed: rb.changed, idMap };
    }

    /** Review progress follows renamed groups (ids are derived from member paths). */
    function remapReviewed(idMap) {
        const ls = store.data.lastScan;
        if (!ls || !idMap.size) return;
        for (const key of ['reviewed', 'choices']) {
            const obj = ls[key];
            if (!obj) continue;
            for (const [from, to] of idMap) {
                if (from in obj) {
                    obj[to] = obj[from];
                    delete obj[from];
                }
            }
        }
        store.saveSoon();
    }

    const pendingRebase = [];
    const flushRebase = App.util.debounce(async () => {
        const pairs = pendingRebase.splice(0);
        if (!pairs.length || !App.dupes.engine) return;
        try {
            const r = await App.dupes.engine.cache.getResult();
            if (!r || (App.dupes.ui?.active?.rv?.result?.id === r.id)) return; // the open review rebases (and saves) its own copy
            const { changed, idMap } = rebaseResult(r, pairs);
            if (changed) {
                await App.dupes.engine.cache.putResult(r);
                if (store.data.lastScan && store.data.lastScan.id === r.id) remapReviewed(idMap);
            }
        } catch (e) {
            /* best effort */
        }
    }, 500);

    App.bus.on('fs:changed', (c) => {
        if (!c.from || !c.to || (c.type !== 'move' && c.type !== 'rename') || !App.state.workspace) return;
        const pairs = c.from.map((f, i) => [f, c.to[i]]).filter(([f, t]) => f != null && t != null && f !== t);
        if (!pairs.length) return;
        pendingRebase.push(...pairs);
        flushRebase();
        for (const rec of undoSnaps) {
            rebaseData(rec.before, pairs);
            rebaseData(rec.after, pairs);
        }
        store.ready().then(() => {
            let changed = rebaseData(store.data, pairs);
            const ls = store.data.lastScan;
            if (ls && ls.scope) {
                const rb = rebaser(pairs);
                ls.scope = rebaseScope(ls.scope, rb.fix);
                changed = changed || rb.changed;
            }
            if (changed) {
                store.data = normalize(store.data);
                store.reindex();
                store.saveSoon();
                emit('rebase', { pairs });
            }
        });
    });
    App.bus.on('workspace:opened', () => {
        store.loading = null;
        store.backedUp = false;
        store.ready().then(() => emit('load'));
    });
    App.bus.on('workspace:closed', () => {
        store.loading = null;
        store.ws = null;
        store.data = blank();
        store.reindex();
    });

    // =================================================================================================
    // Metadata merge (copies → keeper), part of the clean-up's undo step
    // =================================================================================================
    const MERGE_KEYS = ['chips', 'rating', 'memo', 'markers', 'label', 'legacyTags', 'legacyImported'];

    /** Pure: the patch that merges donor catalog entries into the keeper's entry (null when nothing changes). */
    function mergedPatchFrom(k, ds) {
        k = k || {};
        ds = ds.filter(Boolean);
        if (!ds.length) return null;
        const patch = {};
        const chips = [...(k.chips || [])];
        for (const d of ds) for (const c of d.chips || []) if (!chips.includes(c)) chips.push(c);
        if (chips.length !== (k.chips || []).length) patch.chips = chips;
        const rating = Math.max(k.rating || 0, ...ds.map((d) => d.rating || 0));
        if (rating !== (k.rating || 0)) patch.rating = rating;
        const memos = [];
        for (const m of [k.memo, ...ds.map((d) => d.memo)]) {
            const t = (m || '').trim();
            if (t && !memos.some((x) => x === t || x.includes(t))) memos.push(t);
        }
        const memo = memos.join('\n\n');
        if (memo !== (k.memo || '').trim() && memo) patch.memo = memo;
        const markers = [...(k.markers || [])];
        const sig = (m) => `${Math.round((m.t || 0) * 10)}|${m.title || ''}`;
        const seen = new Set(markers.map(sig));
        const ids = new Set(markers.map((m) => m.id));
        for (const d of ds) {
            for (const m of d.markers || []) {
                if (seen.has(sig(m))) continue;
                seen.add(sig(m));
                const copy = { ...m };
                if (!copy.id || ids.has(copy.id)) copy.id = App.util.uid('m');
                ids.add(copy.id);
                markers.push(copy);
            }
        }
        if (markers.length !== (k.markers || []).length) patch.markers = markers;
        if (!k.label) {
            const label = ds.map((d) => d.label).find(Boolean);
            if (label) patch.label = label;
        }
        const tags = [...(k.legacyTags || [])];
        for (const d of ds) for (const t of d.legacyTags || []) if (!tags.includes(t)) tags.push(t);
        if (tags.length !== (k.legacyTags || []).length) {
            patch.legacyTags = tags;
            patch.legacyImported = true;
        }
        return Object.keys(patch).length ? patch : null;
    }

    function mergedPatch(keeper, donors) {
        return mergedPatchFrom(App.catalog.peek(keeper), donors.map((p) => App.catalog.peek(p)));
    }

    function snapshot(p) {
        const e = App.catalog.peek(p);
        if (!e) return null;
        const out = {};
        for (const key of MERGE_KEYS) if (e[key] !== undefined) out[key] = clone(e[key]);
        return out;
    }

    function restoreSnapshot(p, snap) {
        App.catalog.update(p, (e) => {
            for (const key of MERGE_KEYS) {
                if (snap && snap[key] !== undefined) e[key] = snap[key];
                else delete e[key];
            }
        }, { undoable: false });
    }

    // =================================================================================================
    // Clean-up: verify → trash / quarantine → merge → (move into the keep folder) → ONE undo step → dupes-log.json
    // =================================================================================================
    const REASONS = {
        keeperMissing: '보관할 파일이 없어서 건너뛰었어요',
        keeperChanged: '보관할 파일이 바뀌어서 건너뛰었어요',
        keeperDisconnected: '보관할 파일이 있는 드라이브가 연결돼 있지 않아서 건너뛰었어요',
        unverifiable: '다른 드라이브 파일을 다시 확인할 수 없어서 건너뛰었어요',
        changed: '파일이 바뀌어서 건너뛰었어요',
        clips: '보관함에 잘라 둔 구간이 있어서 건너뛰었어요',
        edit: '편집해 둔 기록이 있어서 건너뛰었어요',
        disconnected: '로컬 서버가 꺼져 있어서 다른 드라이브 파일은 건너뛰었어요',
        all: '묶음의 파일을 모두 지울 수는 없어서 건너뛰었어요',
        overlap: '다른 묶음에서 남기기로 한 파일이라 건너뛰었어요',
        indirect: '남길 파일과 직접 맞춰 보지 않은 파일이라 건너뛰었어요',
        workspace: '작업 폴더가 바뀌어서 멈췄어요',
    };

    const serverDupes = () => (App.server?.available && App.server.dupes) || null;
    const canQuarantine = () => typeof serverDupes()?.quarantine === 'function';
    const wsNow = () => App.state.workspace?.id || null;

    /** { size, mtime } | null (gone) | undefined (can't be checked: external file without server stat → fail closed) */
    async function statOf(m) {
        if (m.root) {
            const sd = serverDupes();
            if (!sd || typeof sd.stat !== 'function') return undefined;
            try {
                const s = await sd.stat(m.path);
                return s && s.kind !== 'dir' ? s : null;
            } catch (e) {
                return e && (e.code === 'ENOENT' || e.status === 404) ? null : undefined;
            }
        }
        try {
            const s = await App.fs.stat(m.path);
            return s && s.kind !== 'dir' ? s : null;
        } catch (e) {
            return null;
        }
    }

    /** Clips in the 보관함 for a path; when the clips module can't answer, assume there are (fail closed). */
    function hasClips(p) {
        const cl = App.clips;
        if (!cl || typeof cl.forPath !== 'function') return 0;
        try {
            const c = cl.forPath(p);
            return Array.isArray(c) ? c.length : 0;
        } catch (e) {
            return 1;
        }
    }

    /** Any video edit state (viewer team's meta.edit) that isn't empty. */
    function hasEdit(p) {
        const e = App.catalog.peek(p)?.meta?.edit;
        if (!e || typeof e !== 'object') return false;
        for (const [k, v] of Object.entries(e)) {
            if (k === 'updatedAt' || v == null || v === false) continue;
            if (Array.isArray(v) ? v.length : typeof v === 'object' ? Object.keys(v).length : true) return true;
        }
        return false;
    }

    const changedSince = (s, m) => s.size !== m.size || (m.mtime && s.mtime && s.mtime !== m.mtime);

    /**
     * Re-check everything right before removing. plans: [{ group, keep, remove: [path], moveTo? }]
     * -> { ok: [{ group, keep, keeper, remove: [member], moveTo }], skipped: [{ path, reason, group }] }
     */
    async function verify(plans, { bulk = false } = {}) {
        const ok = [];
        const skipped = [];
        const keepers = new Set(plans.map((p) => p.keep));
        const taken = new Set();
        for (const plan of plans) {
            const g = plan.group;
            const byPath = new Map(g.members.map((m) => [m.path, m]));
            const keeper = byPath.get(plan.keep);
            const want = uniq(plan.remove.filter((p) => p !== plan.keep && byPath.has(p)));
            const skipAll = (reason) => {
                for (const p of want) skipped.push({ path: p, reason, group: g.id });
            };
            if (!keeper || !want.length) continue;
            if (keeper.root && !serverDupes()) {
                skipAll(REASONS.keeperDisconnected);
                continue;
            }
            const ks = await statOf(keeper);
            if (ks === undefined) {
                skipAll(REASONS.unverifiable);
                continue;
            }
            if (ks === null) {
                skipAll(REASONS.keeperMissing);
                continue;
            }
            if (changedSince(ks, keeper)) {
                skipAll(REASONS.keeperChanged);
                continue;
            }
            if (g.kind === 'exact' && keeper.q && !keeper.root) {
                try {
                    const q = (await App.dupes.engine.quickHash(await App.fs.getFile(keeper.path))).q;
                    if (q !== keeper.q) {
                        skipAll(REASONS.keeperChanged);
                        continue;
                    }
                } catch (e) {
                    skipAll(REASONS.keeperMissing);
                    continue;
                }
            }
            const remove = [];
            for (const p of want) {
                const m = byPath.get(p);
                if (keepers.has(p) || taken.has(p)) {
                    skipped.push({ path: p, reason: REASONS.overlap, group: g.id });
                    continue;
                }
                if (m.root && !canQuarantine()) {
                    skipped.push({ path: p, reason: REASONS.disconnected, group: g.id });
                    continue;
                }
                if (bulk && !m.root && hasClips(p)) {
                    skipped.push({ path: p, reason: REASONS.clips, group: g.id });
                    continue;
                }
                if (bulk && !m.root && hasEdit(p)) {
                    skipped.push({ path: p, reason: REASONS.edit, group: g.id });
                    continue;
                }
                const s = await statOf(m);
                if (s === undefined) {
                    skipped.push({ path: p, reason: REASONS.unverifiable, group: g.id });
                    continue;
                }
                if (s === null) continue; // already gone: nothing to do
                if (changedSince(s, m)) {
                    skipped.push({ path: p, reason: REASONS.changed, group: g.id });
                    continue;
                }
                remove.push(m);
            }
            // Never remove every member of a group
            const staying = g.members.filter((m) => !remove.includes(m));
            if (!staying.length || !staying.includes(keeper)) {
                for (const m of remove) skipped.push({ path: m.path, reason: REASONS.all, group: g.id });
                continue;
            }
            for (const m of remove) taken.add(m.path);
            const moveTo = !keeper.root && typeof plan.moveTo === 'string' && plan.moveTo !== P.parent(keeper.path) ? plan.moveTo : null;
            if (remove.length) ok.push({ group: g, keep: keeper.path, keeper, remove, moveTo });
        }
        return { ok, skipped };
    }

    /** Runs a verified plan. Donor metadata is read before anything moves and merged only from donors really removed. */
    async function execute(plan, { merge, job, ws }) {
        const failed = [];
        const skipped = [];
        const donorData = new Map();
        for (const g of plan) for (const m of g.remove) if (!m.root) donorData.set(m.path, clone(App.catalog.peek(m.path) || null));
        // last look at the keepers right before the first removal
        const live = [];
        for (const g of plan) {
            if (!g.keeper.root && !(await App.fs.exists(g.keep).catch(() => false))) {
                for (const m of g.remove) skipped.push({ path: m.path, reason: REASONS.keeperMissing, group: g.group.id });
                continue;
            }
            live.push(g);
        }
        const local = [];
        const external = [];
        for (const g of live) for (const m of g.remove) (m.root ? external : local).push(m.path);
        if (wsNow() !== ws) return { snaps: new Map(), merged: 0, ids: [], paths: [], qids: [], quarantined: [], moves: [], failed, skipped: [...skipped, ...local.concat(external).map((p) => ({ path: p, reason: REASONS.workspace }))], cancelled: true, plan: [] };
        const res = await kit.trashPaths(local, { job, onProgress: (n, t) => job?.update(n, { total: t + external.length, detail: `${formatCount(n)} / ${formatCount(t + external.length)}` }) });
        failed.push(...res.failed);
        const cancelled = !!res.cancelled || !!(job && job.cancelled) || wsNow() !== ws;
        let qids = [];
        let quarantined = [];
        if (external.length && !cancelled) {
            try {
                const r = await serverDupes().quarantine(external);
                qids = (r && (r.ids || (r.items || []).map((i) => i.id))) || [];
                quarantined = (r && r.items && r.items.map((i) => i.path || i.from)) || (qids.length === external.length ? external : []);
            } catch (e) {
                for (const p of external) failed.push({ path: p, error: e.message || String(e) });
            }
        }
        const gone = new Set([...res.paths, ...quarantined]);
        // merge what really left into the keeper (same undo step)
        const snaps = new Map();
        let merged = 0;
        if (merge) {
            for (const g of live) {
                if (g.keeper.root) continue;
                const donors = g.remove.filter((m) => !m.root && gone.has(m.path)).map((m) => donorData.get(m.path));
                const patch = mergedPatchFrom(App.catalog.peek(g.keep), donors);
                if (!patch) continue;
                if (!snaps.has(g.keep)) snaps.set(g.keep, snapshot(g.keep));
                App.catalog.update(g.keep, (e) => Object.assign(e, patch), { undoable: false });
                merged++;
            }
        }
        // owner's rule B: the better copy goes into the keep folder (the worse copy there is already in the trash)
        const moves = [];
        for (const g of live) {
            if (!g.moveTo || cancelled || !g.remove.some((m) => gone.has(m.path))) continue;
            try {
                const r = await App.fs.move([g.keep], g.moveTo, { undoable: false });
                const to = r && r[0] && r[0].to;
                if (to && to !== g.keep) {
                    moves.push({ from: g.keep, to, group: g.group.id });
                    if (snaps.has(g.keep)) {
                        snaps.set(to, snaps.get(g.keep));
                        snaps.delete(g.keep);
                    }
                    g.keep = to;
                    g.keeper.path = to;
                }
            } catch (e) {
                failed.push({ path: g.keep, error: `보관 폴더로 옮기지 못했어요 (${e.message || e})` });
            }
        }
        return { snaps, merged, ids: res.ids, paths: res.paths, qids, quarantined, moves, failed, skipped, cancelled, plan: live };
    }

    let logChain = Promise.resolve();
    function appendLog(entry) {
        const ws = App.state.workspace?.id;
        logChain = logChain.then(async () => {
            if (!App.fs.ready || App.state.workspace?.id !== ws) return;
            const log = await App.wsdata.read('dupes-log', null);
            const data = log && Array.isArray(log.entries) ? log : { version: 1, entries: [] };
            data.entries.push(entry);
            await App.wsdata.write('dupes-log', data);
        }).catch((e) => console.warn('[dupes] log append failed', e));
        return logChain;
    }

    /** After an undo the restored files may carry new timestamps: refresh what verify() compares against. */
    async function refreshMembers(members) {
        await App.util.pool(members.filter((m) => !m.root), 8, async (m) => {
            try {
                const s = await App.fs.stat(m.path);
                if (s && s.kind !== 'dir') {
                    m.size = s.size;
                    m.mtime = s.mtime;
                }
            } catch (e) {
                /* gone: verify() will skip it */
            }
        });
    }

    /**
     * Verified clean-up. plans: [{ group, keep, remove: [path], moveTo? }]; bulk = '확실한 묶음 한 번에 정리'.
     * -> { removed: [{ path, size, root }], bytes, skipped: [{ path, reason }], merged, moved, groups: [groupId], failed }
     */
    async function apply(plans, { merge = true, bulk = false, label, scanId = null } = {}) {
        const ws = wsNow();
        const total = plans.reduce((s, p) => s + p.remove.length, 0);
        const job = App.jobs.start({ title: '중복 정리 중', total, cancellable: true, detail: '지우기 전에 파일을 다시 확인하는 중' });
        let checked;
        let state = null;
        try {
            checked = await verify(plans, { bulk });
            if (wsNow() !== ws) {
                for (const g of checked.ok) for (const m of g.remove) checked.skipped.push({ path: m.path, reason: REASONS.workspace, group: g.group.id });
                checked.ok = [];
            }
            if (checked.ok.length) state = await execute(checked.ok, { merge, job, ws });
        } finally {
            job.finish();
        }
        const skipped = [...checked.skipped, ...(state ? state.skipped : [])];
        if (!state || (!state.ids.length && !state.qids.length && !state.moves.length)) {
            // nothing left the library; a merge without removals is rolled back so nothing changes silently
            if (state) for (const [p, snap] of state.snaps) restoreSnapshot(p, snap);
            return { removed: [], bytes: 0, skipped, merged: 0, moved: [], groups: [], failed: state ? state.failed : [] };
        }
        const gone = new Set([...state.paths, ...state.quarantined]);
        const movedKeep = new Set(state.moves.map((mv) => mv.to));
        const live = state.plan
            .map((g) => ({ ...g, remove: g.remove.filter((m) => gone.has(m.path)), moveTo: movedKeep.has(g.keep) ? g.moveTo : null }))
            .filter((g) => g.remove.length || g.moveTo);
        const removed = live.flatMap((g) => g.remove.map((m) => ({ path: m.path, size: m.size || 0, root: m.root || null })));
        const bytes = removed.reduce((s, r) => s + r.size, 0);
        const at = Date.now();
        appendLog({
            at,
            type: 'apply',
            bulk,
            scanId,
            bytes,
            groups: live.map((g) => ({
                id: g.group.id,
                kind: g.group.kind,
                sure: !!g.group.sure,
                kept: g.keep,
                movedFrom: (state.moves.find((mv) => mv.to === g.keep) || {}).from,
                removed: g.remove.map((m) => ({ path: m.path, size: m.size, to: m.root ? 'quarantine' : 'trash' })),
            })),
            skipped: skipped.map((s) => ({ path: s.path, reason: s.reason })),
        });
        let cur = state;
        const n = removed.length;
        App.undo.push({
            label: label || (n ? `중복 ${formatCount(n)}개 정리` : '더 좋은 화질을 보관 폴더로 옮기기'),
            undo: async () => {
                if (wsNow() !== ws) throw new Error('다른 작업 폴더라서 되돌릴 수 없어요');
                // the moved keeper goes back first, so the copy that sat in the keep folder can return under its own name
                for (const mv of [...(cur.moves || [])].reverse()) {
                    const r = await App.fs.move([mv.to], P.parent(mv.from), { undoable: false });
                    let actual = r && r[0] && r[0].to;
                    if (!actual) throw new Error(`‘${P.base(mv.to)}’ 파일을 원래 폴더로 되돌리지 못했어요`);
                    if (P.base(actual) !== P.base(mv.from)) {
                        try {
                            actual = await App.fs.rename(actual, P.base(mv.from), { undoable: false });
                        } catch (e) {
                            /* keep the numbered name; we track where it really is */
                        }
                    }
                    for (const g of live) {
                        if (g.keep !== mv.to) continue;
                        g.keep = actual;
                        g.keeper.path = actual;
                    }
                    if (cur.snaps.has(mv.to)) {
                        cur.snaps.set(actual, cur.snaps.get(mv.to));
                        cur.snaps.delete(mv.to);
                    }
                }
                const back = await kit.restoreIds(cur.ids);
                for (const g of live) for (const m of g.remove) if (back.has(m.path)) m.path = back.get(m.path);
                if (cur.qids.length && typeof serverDupes()?.restore === 'function') await serverDupes().restore(cur.qids);
                for (const [p, snap] of cur.snaps) restoreSnapshot(p, snap);
                await refreshMembers(live.flatMap((g) => [g.keeper, ...g.remove]));
                appendLog({ at: Date.now(), type: 'undo', ref: at });
                App.bus.emit('dupes:applied', { undo: true, paths: removed.map((r) => r.path) });
            },
            redo: async () => {
                if (wsNow() !== ws) throw new Error('다른 작업 폴더라서 다시 할 수 없어요');
                // the same checks as the first time: the library may have changed since the undo
                const again = await verify(live.map((g) => ({ group: g.group, keep: g.keep, remove: g.remove.map((m) => m.path), moveTo: g.moveTo })), { bulk });
                const j = App.jobs.start({ title: '중복 정리 중', total: n, cancellable: false });
                try {
                    cur = again.ok.length ? await execute(again.ok, { merge, job: j, ws }) : { snaps: new Map(), merged: 0, ids: [], paths: [], qids: [], quarantined: [], moves: [], failed: [], skipped: [] };
                } finally {
                    j.finish();
                }
                const skippedAgain = [...again.skipped, ...cur.skipped];
                if (skippedAgain.length) reportApply({ removed: [], bytes: 0, skipped: skippedAgain, failed: [] });
                appendLog({ at: Date.now(), type: 'redo', ref: at, skipped: skippedAgain.map((s) => ({ path: s.path, reason: s.reason })) });
                App.bus.emit('dupes:applied', { redo: true, paths: removed.map((r) => r.path) });
            },
        });
        App.bus.emit('dupes:applied', { paths: removed.map((r) => r.path), groups: live.map((g) => g.group.id), moves: state.moves });
        return { removed, bytes, skipped, merged: state.merged, moved: state.moves, groups: live.map((g) => g.group.id), failed: state.failed };
    }

    /**
     * Round-1 API (kept for other modules/tests): trash the copies of plain plans [{ keep, remove: [paths] }] as ONE
     * undo step with metadata merge (verified like any clean-up).
     */
    async function trashDuplicates(plan, { merge = true } = {}) {
        const groups = [];
        for (const p of plan) {
            const members = [];
            for (const path of [p.keep, ...p.remove]) {
                let s = null;
                try {
                    s = await App.fs.stat(path);
                } catch (e) {
                    s = null;
                }
                if (s) members.push({ path, size: s.size, mtime: s.mtime });
            }
            groups.push({ group: { id: 'legacy', kind: 'exact', members }, keep: p.keep, remove: p.remove });
        }
        const total = plan.reduce((s, g) => s + g.remove.length, 0);
        const res = await apply(groups, { merge, label: `복제본 ${formatCount(total)}개 정리` });
        return { trashed: res.removed.length, ids: [], merged: res.merged, failed: res.failed, cancelled: false };
    }

    /** Honest result toast: '휴지통으로 옮겼어요 · 비우면 n GB 확보' (+ what was skipped and why). */
    function reportApply(res) {
        const n = res.removed.length;
        const ext = res.removed.filter((r) => r.root).length;
        const movedN = (res.moved || []).length;
        if (n) {
            const where = ext && ext === n ? '_중복정리 폴더로 옮겼어요' : ext ? '휴지통과 _중복정리 폴더로 옮겼어요' : '휴지통으로 옮겼어요';
            const moved = movedN ? ` · 더 좋은 화질 ${formatCount(movedN)}개는 보관 폴더로 옮겼어요` : '';
            ui.toast(`중복 ${formatCount(n)}개를 ${where} · 비우면 ${formatBytes(res.bytes)} 확보${moved}${res.merged ? ` · ${formatCount(res.merged)}개에 칩·메모를 합쳤어요` : ''}`, {
                type: 'success',
                duration: 7000,
                action: { label: '실행 취소', run: () => App.undo.undo() },
            });
        }
        if (res.skipped.length) {
            const by = new Map();
            for (const s of res.skipped) by.set(s.reason, (by.get(s.reason) || 0) + 1);
            const [reason, count] = [...by].sort((a, b) => b[1] - a[1])[0];
            ui.toast(`${formatCount(res.skipped.length)}개는 그대로 뒀어요 — ${reason}${by.size > 1 ? ` (그 밖의 이유 ${by.size - 1}가지)` : count > 1 ? '' : ''}`, {
                type: 'warning',
                duration: 8000,
                action: { label: '자세히', run: () => showSkipped(res.skipped) },
            });
        }
        const failed = (res.failed || []).filter((f) => !f.reported);
        if (failed.length) ui.toast(`${formatCount(failed.length)}개는 옮기지 못했어요 (${failed[0].error})`, { type: 'warning', duration: 7000 });
    }

    function showSkipped(skipped) {
        const { h } = App.util;
        const body = h('div', { class: 'dup-skipped' },
            ...skipped.slice(0, 200).map((s) => h('div', { class: 'dup-skipped-row' },
                h('span', { class: 'dup-skipped-name truncate', text: P.base(s.path), title: s.path }),
                h('span', { class: 'dup-skipped-why', text: s.reason }))));
        return ui.dialog({ title: `건너뛴 파일 ${formatCount(skipped.length)}개`, body, width: 560, actions: [{ label: '닫기', value: null, kind: 'primary', autofocus: true }] });
    }

    // =================================================================================================
    // Commands (UI lives in dupes-review.js / dupes-tools.js, resolved at run time)
    // =================================================================================================
    function cleanArgs(a) {
        if (!a || typeof a !== 'object') return {};
        const { event, ...rest } = a;
        return rest;
    }
    const ready = () => App.fs.ready;
    const uiApi = () => App.dupes.ui;
    const tools = () => App.dupes.tools;

    /** The file a command should act on: args.path, the open viewer's file, else the single selected file. */
    function targetFile(args) {
        if (args && args.path) return args.path;
        if (App.viewer?.isOpen && App.viewer.current?.path) return App.viewer.current.path;
        const one = App.select.count === 1 ? App.select.entries()[0] : null;
        return one && one.kind === 'file' ? one.path : null;
    }
    function targetFolder(args) {
        if (args && typeof args.path === 'string') return args.path;
        const one = App.select.count === 1 ? App.select.entries()[0] : null;
        if (one && one.kind === 'dir') return one.path;
        return App.state.cwd ?? null;
    }

    const reg = (c) => App.commands.register({ group: '중복', icon: 'layers', when: ready, ...c });
    reg({ id: 'dupes.open', title: '중복 정리…', keys: 'Mod+Alt+D', run: (a) => uiApi()?.open(cleanArgs(a)) });
    reg({ id: 'dupes.scanHere', title: '지금 보는 폴더에서 중복 찾기', icon: 'folder', keys: 'Mod+Alt+Shift+D', run: (a) => uiApi()?.open({ scope: { type: 'folder', path: targetFolder(a) ?? '', sub: cleanArgs(a).sub ?? true }, autostart: true }) });
    reg({ id: 'dupes.pickFolders', title: '폴더 골라서 중복 찾기…', icon: 'folder-plus', run: (a) => uiApi()?.open({ setup: 'folders', paths: cleanArgs(a).paths }) });
    reg({ id: 'dupes.compare', title: '두 쪽 비교해서 중복 찾기…', icon: 'merge', run: (a) => uiApi()?.open({ setup: 'compare', a: cleanArgs(a).a, b: cleanArgs(a).b }) });
    reg({
        id: 'dupes.findSimilar',
        title: '이 파일과 같은 것 찾기',
        icon: 'search',
        when: () => ready() && !!targetFile(),
        run: (a) => {
            const p = targetFile(cleanArgs(a));
            return p ? uiApi()?.open({ focus: p, autostart: true }) : null;
        },
    });
    reg({
        id: 'dupes.excludeFile',
        title: '이 파일은 중복검사에서 빼기',
        icon: 'eye-off',
        when: () => ready() && !!targetFile(),
        run: async (a) => {
            const p = targetFile(cleanArgs(a));
            if (!p) return;
            await store.ready();
            const on = !store.files.has(p);
            await excludeFiles([p], on);
            ui.toast(on ? `‘${P.base(p)}’ 파일은 이제 중복검사에서 빼요` : `‘${P.base(p)}’ 파일을 다시 중복검사에 넣었어요`, { type: 'success', action: { label: '실행 취소', run: () => App.undo.undo() } });
        },
    });
    reg({
        id: 'dupes.excludeFolder',
        title: '이 폴더는 중복검사에서 빼기',
        icon: 'eye-off',
        when: () => ready() && !!targetFolder(),
        run: async (a) => {
            const p = targetFolder(cleanArgs(a));
            if (!p) {
                ui.toast('작업 폴더 전체는 뺄 수 없어요. 하위 폴더를 골라 주세요', { type: 'info' });
                return;
            }
            await store.ready();
            const on = !store.data.excludedFolders.includes(p);
            await excludeFolders([p], on);
            ui.toast(on ? `‘${kit.folderLabel(p)}’ 폴더는 이제 중복검사에서 빼요` : `‘${kit.folderLabel(p)}’ 폴더를 다시 중복검사에 넣었어요`, { type: 'success', action: { label: '실행 취소', run: () => App.undo.undo() } });
        },
    });
    reg({ id: 'dupes.exclusions', title: '중복검사 제외 목록…', icon: 'eye-off', run: () => tools()?.openExclusions() });
    reg({ id: 'dupes.rules', title: '중복검사 규칙…', icon: 'sliders', run: () => tools()?.openRules() });
    reg({ id: 'dupes.prebuild', title: '중복검사 지문 미리 만들기', icon: 'zap', run: () => App.dupes.engine?.prebuild({ quiet: false }) });
    for (const role of ['keep', 'remove']) {
        reg({
            id: `dupes.role.${role}`,
            title: role === 'keep' ? '이 폴더를 보관 폴더로 (중복검사)' : '이 폴더를 정리 폴더로 (중복검사)',
            icon: role === 'keep' ? 'shield-check' : 'trash',
            when: () => ready() && targetFolder() != null,
            run: async (a) => {
                const p = targetFolder(cleanArgs(a));
                if (p == null) return;
                await store.ready();
                const cur = store.data.rules.folderPriority.find((x) => x.path === p)?.role || null;
                const next = cur === role ? null : role;
                await setFolderRole(p, next);
                ui.toast(next ? `‘${kit.folderLabel(p)}’ 폴더를 ${ROLE_LABEL[next]}로 정했어요 · ${next === 'keep' ? '중복이면 이 폴더 것을 남겨요' : '중복이면 이 폴더 것을 먼저 지워요'}` : `‘${kit.folderLabel(p)}’ 폴더의 역할을 지웠어요`, { type: 'success', action: { label: '실행 취소', run: () => App.undo.undo() } });
            },
        });
    }

    App.dupes = Object.assign(App.dupes || {}, {
        store,
        inside,
        isAbs,
        ROLE_LABEL,
        REASONS,
        excludeFiles,
        excludeFolders,
        markNotDuplicate,
        setFolderRole,
        setRules,
        resetRules,
        setLastScan,
        setReviewed,
        rebaseResult,
        remapReviewed,
        mergedPatch,
        verify,
        apply,
        reportApply,
        showSkipped,
        trashDuplicates,
        open: (args) => App.dupes.ui?.open(args || {}),
        /** Round-1 helpers kept for callers/tests */
        phash: (file) => App.dupes.engine.phashFile(file),
        hamming: (a, b) => App.dupes.engine.hamHex(a, b),
        clearCache: () => App.dupes.engine.cache.clear(),
    });
})();
