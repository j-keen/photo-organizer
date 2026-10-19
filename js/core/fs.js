/*
 * File system layer.
 *   App.fs            — path-based facade every feature uses. Paths are workspace-relative, '/'-separated,
 *                       '' is the workspace root. All mutations go through here so that the catalog, undo stack
 *                       and 'fs:changed' listeners (gallery, tree, ...) stay in sync.
 *   BrowserBackend    — File System Access API implementation (default).
 *   Other backends (e.g. the local Python server) implement the same interface; see docs/ARCHITECTURE.md.
 *
 * 'fs:changed' payload: { type: 'create'|'rename'|'move'|'copy'|'trash'|'restore'|'delete'|'modify',
 *                          paths: [resulting paths], from?: [old paths], to?: [new paths], dirs: [parent dirs whose listing changed] }
 */
(() => {
    'use strict';
    const { path: P, mediaType, pool } = App.util;

    const DATA_DIR = '.fluid-organizer';
    const TRASH_DIR = DATA_DIR + '/trash';
    const TRASH_MANIFEST = TRASH_DIR + '/manifest.json';
    const HIDDEN_NAMES = new Set(['desktop.ini', 'thumbs.db', '.ds_store', '$recycle.bin', 'system volume information']);
    const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

    function fsError(code, message) {
        const e = new Error(message);
        e.code = code;
        return e;
    }

    // ---------- Browser backend (File System Access API) ----------
    class BrowserBackend {
        constructor(rootHandle) {
            this.kind = 'browser';
            this.root = rootHandle;
            this.name = rootHandle.name;
            this.dirs = new Map([['', rootHandle]]);
        }

        async dir(p, create = false) {
            if (this.dirs.has(p)) return this.dirs.get(p);
            const parent = await this.dir(P.parent(p), create);
            let handle;
            try {
                handle = await parent.getDirectoryHandle(P.base(p), { create });
            } catch (e) {
                if (e.name === 'NotFoundError') throw fsError('ENOENT', `찾을 수 없어요: ${p}`);
                if (e.name === 'TypeMismatchError') throw fsError('ENOTDIR', `폴더가 아니에요: ${p}`);
                throw e;
            }
            this.dirs.set(p, handle);
            return handle;
        }

        invalidate(p) {
            for (const k of [...this.dirs.keys()]) if (k !== '' && P.isInside(k, p)) this.dirs.delete(k);
        }

        async handle(p) {
            if (p === '') return this.root;
            const parent = await this.dir(P.parent(p));
            const name = P.base(p);
            try {
                return await parent.getFileHandle(name);
            } catch (e) {
                if (e.name !== 'TypeMismatchError' && e.name !== 'NotFoundError') throw e;
                try {
                    const d = await parent.getDirectoryHandle(name);
                    this.dirs.set(p, d);
                    return d;
                } catch (e2) {
                    if (e2.name === 'NotFoundError' || e2.name === 'TypeMismatchError') throw fsError('ENOENT', `찾을 수 없어요: ${p}`);
                    throw e2;
                }
            }
        }

        async list(dirPath, { stat = true } = {}) {
            const d = await this.dir(dirPath);
            const out = [];
            try {
                for await (const [name, h] of d.entries()) out.push({ name, kind: h.kind === 'directory' ? 'dir' : 'file', _h: h });
            } catch (e) {
                // A cached handle of a folder that was deleted outside the app
                if (e.name === 'NotFoundError') {
                    this.invalidate(dirPath);
                    throw fsError('ENOENT', `찾을 수 없어요: ${dirPath}`);
                }
                throw e;
            }
            if (stat) {
                await pool(out.filter((r) => r.kind === 'file'), 32, async (r) => {
                    const f = await r._h.getFile();
                    r.size = f.size;
                    r.mtime = f.lastModified;
                });
            }
            for (const r of out) delete r._h;
            return out;
        }

        async stat(p) {
            const h = await this.handle(p);
            if (h.kind === 'directory') return { kind: 'dir' };
            const f = await h.getFile();
            return { kind: 'file', size: f.size, mtime: f.lastModified };
        }

        async exists(p) {
            try {
                await this.handle(p);
                return true;
            } catch (e) {
                if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
                throw e;
            }
        }

        async getFile(p) {
            const h = await this.handle(p);
            if (h.kind !== 'file') throw fsError('EISDIR', `폴더예요: ${p}`);
            return h.getFile();
        }

        async write(p, data) {
            const d = await this.dir(P.parent(p), true);
            const fh = await d.getFileHandle(P.base(p), { create: true });
            const w = await fh.createWritable();
            try {
                await w.write(data);
                await w.close();
            } catch (e) {
                try {
                    await w.abort();
                } catch (_) {
                    /* already closed */
                }
                throw e;
            }
        }

        async mkdir(p) {
            await this.dir(p, true);
        }

        async remove(p) {
            const d = await this.dir(P.parent(p));
            await d.removeEntry(P.base(p), { recursive: true });
            this.invalidate(p);
        }

        // Native move keeps timestamps and is instant; fall back to copy+delete where the browser can't move.
        async move(src, destDir, newName) {
            const h = await this.handle(src);
            const sameDir = P.parent(src) === destDir;
            if (typeof h.move === 'function') {
                try {
                    if (sameDir) await h.move(newName);
                    else await h.move(await this.dir(destDir, true), newName);
                    this.invalidate(src);
                    return { native: true };
                } catch (e) {
                    if (e.name === 'NotFoundError') throw fsError('ENOENT', `찾을 수 없어요: ${src}`);
                    console.info('[fs] native move unavailable, copying instead:', e.name, e.message);
                }
            }
            await this.copy(src, destDir, newName);
            await this.remove(src);
            return { native: false };
        }

        async copy(src, destDir, newName) {
            const h = await this.handle(src);
            const destHandle = await this.dir(destDir, true);
            if (h.kind === 'file') {
                const file = await h.getFile();
                const fh = await destHandle.getFileHandle(newName, { create: true });
                const w = await fh.createWritable();
                await file.stream().pipeTo(w);
                return;
            }
            const childDest = P.join(destDir, newName);
            await this.dir(childDest, true);
            for await (const [name] of h.entries()) {
                await this.copy(P.join(src, name), childDest, name);
            }
        }

        // Object URL for <img>/<video>. Caller must call release().
        async url(p) {
            const file = await this.getFile(p);
            const url = URL.createObjectURL(file);
            return { url, release: () => URL.revokeObjectURL(url) };
        }
    }

    // ---------- Write serialization (per-path) so JSON read-modify-writes never interleave ----------
    const locks = new Map();
    function withLock(key, fn) {
        const prev = locks.get(key) || Promise.resolve();
        const next = prev.then(fn, fn);
        locks.set(key, next.catch(() => {}));
        return next;
    }

    // ---------- Facade ----------
    const fs = {
        DATA_DIR,
        TRASH_DIR,
        BrowserBackend,
        backend: null,

        get ready() {
            return !!this.backend;
        },

        use(backend) {
            this.backend = backend;
        },

        isHiddenName(name) {
            return name.startsWith('.') || HIDDEN_NAMES.has(name.toLowerCase());
        },

        isDataPath(p) {
            return P.isInside(p, DATA_DIR);
        },

        // Returns an error message (Korean) or null.
        validateName(name) {
            if (!name || !name.trim()) return '이름을 입력하세요';
            if (name.length > 200) return '이름이 너무 길어요';
            if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) return '\\ / : * ? " < > | 문자는 쓸 수 없어요';
            if (/[. ]$/.test(name)) return '이름 끝에 마침표나 공백은 쓸 수 없어요';
            if (RESERVED.test(name)) return '시스템 예약 이름이라 쓸 수 없어요';
            if (name.startsWith('.')) return '마침표로 시작하는 이름은 숨김 파일이 돼요';
            return null;
        },

        toEntry(dirPath, raw) {
            const p = P.join(dirPath, raw.name);
            const isDir = raw.kind === 'dir';
            return {
                path: p,
                name: raw.name,
                kind: isDir ? 'dir' : 'file',
                type: isDir ? 'dir' : mediaType(raw.name),
                ext: isDir ? '' : P.ext(raw.name),
                size: raw.size,
                mtime: raw.mtime,
            };
        },

        /**
         * List a folder. By default returns folders + photos + videos (hidden files, app data and other
         * file types are filtered out). opts: { stat = true, all = false }
         * Returns entries; `entries.hiddenCount` = number of non-media files skipped.
         */
        async list(dirPath, opts = {}) {
            const raws = await this.backend.list(dirPath, { stat: opts.stat !== false });
            return this.fromRaws(dirPath, raws, opts);
        },

        /** The filtering half of list(): raw backend rows ({ name, kind, size?, mtime? }) → entries. opts: { all } */
        fromRaws(dirPath, raws, opts = {}) {
            const names = new Set(raws.map((r) => r.name));
            let hidden = 0;
            const entries = [];
            const sidecars = [];
            for (const r of raws) {
                if (this.isHiddenName(r.name)) continue;
                const type = r.kind === 'dir' ? 'dir' : mediaType(r.name);
                if (!opts.all && type === 'other') {
                    // legacy "<media>.txt" memo sidecars are not counted as hidden user files
                    if (!(r.name.toLowerCase().endsWith('.txt') && names.has(r.name.slice(0, -4)))) hidden++;
                    continue;
                }
                if (type !== 'dir' && names.has(r.name + '.txt')) sidecars.push(P.join(dirPath, r.name));
                entries.push(this.toEntry(dirPath, r));
            }
            entries.hiddenCount = hidden;
            entries.sidecars = sidecars;
            return entries;
        },

        async stat(p) {
            const s = await this.backend.stat(p);
            return this.toEntry(P.parent(p), { name: P.base(p), ...s });
        },

        exists(p) {
            return this.backend.exists(p);
        },

        getFile(p) {
            return this._watchMissing(p, this.backend.getFile(p));
        },

        url(p) {
            return this._watchMissing(p, this.backend.url(p));
        },

        // ----- Items that vanished behind the app (deleted in Explorer while a cached listing still shows them) -----
        _watchMissing(p, promise) {
            return Promise.resolve(promise).catch((e) => {
                if (e && e.code === 'ENOENT') this._missing([p]);
                throw e;
            });
        },

        /**
         * Report paths that turned out to be gone. Emits 'fs:missing' { paths, dirs, silent } — the listing cache
         * re-checks those folders right away and drops what is really gone (nothing is dropped on a guess:
         * an unplugged drive fails the re-check and keeps everything). silent: the caller shows its own message.
         */
        _missing(paths, { silent = false } = {}) {
            const list = [...new Set(paths)].filter((p) => p && !this.isDataPath(p));
            if (!list.length) return;
            App.bus.emit('fs:missing', { paths: list, dirs: [...new Set(list.map((p) => P.parent(p)))], silent });
        },

        // ----- One writer per workspace (js/core/core-lock.js); a read-only tab never writes -----
        _guardWrite(p = null, { quiet = false } = {}) {
            const lock = App.lock;
            if (!lock || typeof lock.canWrite !== 'function' || lock.canWrite()) return;
            if (p && lock.isLockPath?.(p)) return;
            if (!quiet) lock.nudge?.(); // background saves (cached metadata...) fail quietly
            throw fsError('EREADONLY', '다른 창에서 이 작업 폴더를 쓰고 있어서 여기서는 바꿀 수 없어요');
        },

        async readText(p) {
            const f = await this.backend.getFile(p);
            return f.text();
        },

        async readJSON(p, fallback = null) {
            try {
                const text = await this.readText(p);
                // A 0-byte file is what an interrupted *first* write leaves behind — treat it as missing
                if (!text.trim()) return fallback;
                return JSON.parse(text);
            } catch (e) {
                if (e.code === 'ENOENT') return fallback;
                if (e instanceof SyntaxError) {
                    console.error('[fs] corrupt JSON', p, e);
                    const err = fsError('ECORRUPT', `파일이 손상됐어요: ${p}`);
                    err.cause = e;
                    throw err;
                }
                throw e;
            }
        },

        // Raw writes for app data (no events/undo). Serialized per path.
        writeRaw(p, data) {
            // Read-only window: app data (catalog, chips...) is never written here. Background saves such as cached
            // media info are skipped quietly instead of failing again and again; the writer window keeps the truth
            // and taking over re-reads everything from disk. (User edits are flagged by core-lock's nudge.)
            // Checked again when the queued write actually runs: ownership may have moved meanwhile.
            const skip = () => {
                if (this.canWriteData(p)) return false;
                if (!this._readonlySkipLogged) console.info('[fs] read-only window: app data is not saved here');
                this._readonlySkipLogged = true;
                return true;
            };
            if (skip()) return Promise.resolve();
            return withLock(p, () => (skip() ? undefined : this.backend.write(p, data)));
        },

        /** false while another window owns the workspace (see js/core/core-lock.js) */
        canWriteData(p = null) {
            const lock = App.lock;
            if (!lock || typeof lock.canWrite !== 'function' || lock.canWrite()) return true;
            return !!(p && lock.isLockPath?.(p));
        },

        writeJSON(p, obj) {
            return this.writeRaw(p, JSON.stringify(obj, null, 1));
        },

        emitChange(change) {
            change.dirs = [...new Set(change.dirs || [])];
            App.bus.emit('fs:changed', change);
        },

        /** Find a free name in dirPath: "photo.jpg" -> "photo (2).jpg". `reserved` = names already claimed in this batch. */
        async uniqueName(dirPath, name, { isDir = false, reserved = null } = {}) {
            const dot = isDir ? -1 : name.lastIndexOf('.');
            const stem = dot > 0 ? name.slice(0, dot) : name;
            const ext = dot > 0 ? name.slice(dot) : '';
            let candidate = name;
            for (let i = 2; i < 10000; i++) {
                const taken = (reserved && reserved.has(candidate.toLowerCase())) || (await this.backend.exists(P.join(dirPath, candidate)));
                if (!taken) break;
                candidate = `${stem} (${i})${ext}`;
            }
            if (reserved) reserved.add(candidate.toLowerCase());
            return candidate;
        },

        // Legacy v1 kept memos in "<file>.txt" next to the file; carry them along on move/rename.
        async _moveSidecar(src, destDir, newName) {
            const sidecar = src + '.txt';
            try {
                if (await this.backend.exists(sidecar)) await this.backend.move(sidecar, destDir, newName + '.txt');
            } catch (e) {
                console.warn('[fs] sidecar move failed', sidecar, e);
            }
        },

        /** Create a folder. Returns its path. */
        async mkdir(parentPath, name, { undoable = true } = {}) {
            this._guardWrite();
            const err = this.validateName(name);
            if (err) throw fsError('EINVAL', err);
            const p = P.join(parentPath, name);
            if (await this.backend.exists(p)) throw fsError('EEXIST', `"${name}"이(가) 이미 있어요`);
            await this.backend.mkdir(p);
            this.emitChange({ type: 'create', paths: [p], dirs: [parentPath] });
            if (undoable) {
                App.undo.push({
                    label: `새 폴더 "${name}"`,
                    undo: async () => {
                        const children = await this.backend.list(p, { stat: false });
                        if (children.length) throw fsError('ENOTEMPTY', '폴더가 비어 있지 않아 되돌릴 수 없어요');
                        await this.backend.remove(p);
                        this.emitChange({ type: 'delete', paths: [p], dirs: [parentPath] });
                    },
                    redo: () => this.mkdir(parentPath, name, { undoable: false }),
                });
            }
            return p;
        },

        /**
         * Write a new file (e.g. a captured frame, an imported file). Picks a unique name. Returns the path.
         * Undoable by default (undo moves the new file to the app trash, redo brings it back).
         */
        async createFile(dirPath, name, data, { undoable = true, label } = {}) {
            this._guardWrite();
            const finalName = await this.uniqueName(dirPath, name);
            const p = P.join(dirPath, finalName);
            await this.backend.write(p, data);
            this.emitChange({ type: 'create', paths: [p], dirs: [dirPath] });
            if (undoable) {
                let ids = null;
                let current = p;
                App.undo.push({
                    label: label || `"${finalName}" 만들기`,
                    undo: async () => {
                        ids = await this.trash([current], { undoable: false, silent: true });
                    },
                    redo: async () => {
                        if (!ids) return;
                        const restored = await this.restore(ids);
                        if (restored[0]) current = restored[0];
                    },
                });
            }
            return p;
        },

        /**
         * Keep a copy of a file (or of `data`) in the app trash — e.g. the original before an in-place edit.
         * The copy shows up in the trash panel and can be restored next to the file. Returns the trash item id.
         */
        async trashCopy(p, { name, data, reason = 'copy' } = {}) {
            this._guardWrite();
            const batchDir = P.join(TRASH_DIR, 'c' + Date.now().toString(36));
            const finalName = name || P.base(p);
            const target = P.join(batchDir, finalName);
            if (data != null) await this.backend.write(target, data);
            else await this.backend.copy(p, batchDir, finalName);
            const st = await this.backend.stat(target);
            const meta = App.catalog?.peek(p);
            const item = { id: App.util.uid('t'), name: finalName, kind: 'file', size: st.size, originalPath: p, trashPath: target, deletedAt: Date.now(), reason, catalog: meta ? { '': JSON.parse(JSON.stringify(meta)) } : null };
            await this._updateTrashManifest((m) => {
                m.items.push(item);
            });
            App.bus.emit('trash:changed');
            return item.id;
        },

        /**
         * Replace a file's contents in place (e.g. rotated image). The previous version is kept in the app trash
         * (restorable from the trash panel) and Ctrl+Z puts it back.
         */
        async overwrite(p, data, { undoable = true, label } = {}) {
            this._guardWrite();
            const name = P.base(p);
            let backup = null;
            if (undoable) {
                const batchDir = P.join(TRASH_DIR, 'v' + Date.now().toString(36));
                const st = await this.backend.stat(p);
                await this.backend.copy(p, batchDir, name);
                backup = { id: App.util.uid('t'), name, kind: 'file', size: st.size, originalPath: p, trashPath: P.join(batchDir, name), deletedAt: Date.now(), reason: 'overwrite' };
                await this._updateTrashManifest((m) => {
                    m.items.push(backup);
                });
                App.bus.emit('trash:changed');
            }
            await this.backend.write(p, data);
            this.emitChange({ type: 'modify', paths: [p], dirs: [P.parent(p)] });
            if (undoable) {
                App.undo.push({
                    label: label || `"${name}" 변경`,
                    undo: async () => {
                        await this.backend.write(p, await this.backend.getFile(backup.trashPath));
                        this.emitChange({ type: 'modify', paths: [p], dirs: [P.parent(p)] });
                    },
                    redo: async () => {
                        await this.backend.write(p, data);
                        this.emitChange({ type: 'modify', paths: [p], dirs: [P.parent(p)] });
                    },
                });
            }
        },

        /** Rename a file or folder. Returns the new path. */
        async rename(p, newName, { undoable = true } = {}) {
            this._guardWrite();
            const oldName = P.base(p);
            if (newName === oldName) return p;
            const err = this.validateName(newName);
            if (err) throw fsError('EINVAL', err);
            const dir = P.parent(p);
            const dest = P.join(dir, newName);
            const caseOnly = newName.toLowerCase() === oldName.toLowerCase();
            if (!caseOnly && (await this.backend.exists(dest))) throw fsError('EEXIST', `"${newName}"이(가) 이미 있어요`);

            const st = await this.backend.stat(p);
            if (caseOnly) {
                // Windows file systems are case-insensitive: go through a temporary name
                const tmp = `${oldName}.renaming-${Date.now()}`;
                await this.backend.move(p, dir, tmp);
                await this.backend.move(P.join(dir, tmp), dir, newName);
            } else {
                await this.backend.move(p, dir, newName);
            }
            if (st.kind === 'file') await this._moveSidecar(p, dir, newName);

            App.catalog?.relocate(p, dest);
            this.emitChange({ type: 'rename', paths: [dest], from: [p], to: [dest], dirs: [dir] });
            if (undoable) {
                App.undo.push({
                    label: `이름 바꾸기 "${oldName}" → "${newName}"`,
                    undo: () => this.rename(dest, oldName, { undoable: false }),
                    redo: () => this.rename(p, newName, { undoable: false }),
                });
            }
            return dest;
        },

        /**
         * Ask the caller how to resolve name clashes before a move/copy.
         * onConflict(conflicts: [{ src, name, dest, isDir }]) -> Map(src -> 'keep' | 'skip' | 'replace') | null (cancel)
         * Without onConflict every clash keeps both (numbered name). Returns null when the user cancelled.
         */
        async _planConflicts(paths, destDir, onConflict) {
            if (!onConflict) return new Map();
            const conflicts = [];
            for (const src of paths) {
                if (P.parent(src) === destDir || P.isInside(destDir, src)) continue;
                const dest = P.join(destDir, P.base(src));
                if (await this.backend.exists(dest)) {
                    const st = await this.backend.stat(src).catch(() => null);
                    conflicts.push({ src, name: P.base(src), dest, isDir: st?.kind === 'dir' });
                }
            }
            if (!conflicts.length) return new Map();
            const decisions = await onConflict(conflicts);
            return decisions || null;
        },

        _reportFailures(failed, verb) {
            if (!failed.length) return;
            // Items that were already gone (deleted outside the app) are skipped, not errors
            const gone = failed.filter((f) => f.error && f.error.code === 'ENOENT');
            const errors = failed.filter((f) => !(f.error && f.error.code === 'ENOENT'));
            if (gone.length) {
                this._missing(gone.map((f) => f.path), { silent: true });
                const what = gone.length === 1 ? `"${P.base(gone[0].path)}"은(는)` : `${gone.length}개는`;
                App.ui?.toast(`${what} 이미 없어져서 건너뛰었어요 · 목록을 새로 고쳤어요`, { type: 'warning', id: 'fs-missing' });
            }
            if (!errors.length) return;
            const first = errors[0];
            const more = errors.length > 1 ? ` 외 ${errors.length - 1}개` : '';
            App.ui?.toast(`"${P.base(first.path)}"${more}을(를) ${verb}지 못했어요: ${first.error.message || first.error}`, { type: 'error' });
        },

        /**
         * Move paths into destDir. Returns [{ from, to }] for moved items (+ `.failed` = [{ path, error }]).
         * Name clashes get " (2)" suffixes unless opts.onConflict decides (see _planConflicts).
         * One failing item never aborts the rest: everything that moved is still announced and undoable.
         * opts: { undoable = true, label, onConflict }
         */
        async move(paths, destDir, { undoable = true, label, onConflict } = {}) {
            this._guardWrite();
            const results = [];
            const failed = [];
            const replacedIds = [];
            const decisions = await this._planConflicts(paths, destDir, onConflict);
            if (!decisions) return Object.assign([], { failed, cancelled: true });
            const reserved = new Set();
            const job = paths.length > 20 ? App.jobs?.start({ title: '이동하는 중', total: paths.length }) : null;
            try {
                for (const src of paths) {
                    if (job?.cancelled || !this.canWriteData()) break; // another window took over: stop here
                    if (P.parent(src) === destDir) continue;
                    if (P.isInside(destDir, src)) {
                        App.ui?.toast(`"${P.base(src)}"을(를) 자기 안으로 옮길 수 없어요`, { type: 'warning' });
                        continue;
                    }
                    try {
                        const decision = decisions.get(src) || 'keep';
                        if (decision === 'skip') continue;
                        const st = await this.backend.stat(src);
                        if (decision === 'replace') {
                            replacedIds.push(...(await this.trash([P.join(destDir, P.base(src))], { undoable: false, silent: true })));
                        }
                        const name = await this.uniqueName(destDir, P.base(src), { isDir: st.kind === 'dir', reserved });
                        await this.backend.move(src, destDir, name);
                        if (st.kind === 'file') await this._moveSidecar(src, destDir, name);
                        const to = P.join(destDir, name);
                        App.catalog?.relocate(src, to);
                        results.push({ from: src, to });
                    } catch (e) {
                        (e.code === 'ENOENT' ? console.warn : console.error)('[fs] move failed', src, e);
                        failed.push({ path: src, error: e });
                    }
                    job?.update(results.length + failed.length);
                }
            } finally {
                job?.finish();
            }
            results.failed = failed;
            this._reportFailures(failed, '옮기');
            if (!results.length) return results;
            this.emitChange({
                type: 'move',
                paths: results.map((r) => r.to),
                from: results.map((r) => r.from),
                to: results.map((r) => r.to),
                dirs: [destDir, ...results.map((r) => P.parent(r.from))],
            });
            if (undoable) {
                const n = results.length;
                let replaced = replacedIds;
                App.undo.push({
                    label: label || (n === 1 ? `"${P.base(results[0].from)}" 이동` : `${n}개 이동`),
                    undo: async () => {
                        for (const r of [...results].reverse()) {
                            const back = await this.move([r.to], P.parent(r.from), { undoable: false });
                            // Restore the original name if the suffix was only needed at the destination
                            if (back[0] && P.base(back[0].to) !== P.base(r.from)) {
                                try {
                                    await this.rename(back[0].to, P.base(r.from), { undoable: false });
                                } catch (e) {
                                    /* keep suffixed name */
                                }
                            }
                        }
                        if (replaced.length) await this.restore(replaced);
                    },
                    redo: async () => {
                        const again = await this.move(results.map((r) => r.from), destDir, { undoable: false, onConflict: onConflict ? async () => decisions : undefined });
                        replaced = again.replacedIds || [];
                    },
                });
            }
            results.replacedIds = replacedIds;
            return results;
        },

        /** Copy paths into destDir (catalog metadata is copied too). Returns [{ from, to }] (+ `.failed`). opts: { undoable, onConflict } */
        async copy(paths, destDir, { undoable = true, onConflict } = {}) {
            this._guardWrite();
            const results = [];
            const failed = [];
            const replacedIds = [];
            const decisions = await this._planConflicts(paths, destDir, onConflict);
            if (!decisions) return Object.assign([], { failed, cancelled: true });
            const reserved = new Set();
            const job = paths.length > 5 ? App.jobs?.start({ title: '복사하는 중', total: paths.length }) : null;
            try {
                for (const src of paths) {
                    if (job?.cancelled || !this.canWriteData()) break; // another window took over: stop here
                    if (P.isInside(destDir, src)) continue;
                    try {
                        const decision = decisions.get(src) || 'keep';
                        if (decision === 'skip') continue;
                        const st = await this.backend.stat(src);
                        if (decision === 'replace') {
                            replacedIds.push(...(await this.trash([P.join(destDir, P.base(src))], { undoable: false, silent: true })));
                        }
                        const name = await this.uniqueName(destDir, P.base(src), { isDir: st.kind === 'dir', reserved });
                        await this.backend.copy(src, destDir, name);
                        const to = P.join(destDir, name);
                        App.catalog?.copy(src, to);
                        results.push({ from: src, to });
                    } catch (e) {
                        (e.code === 'ENOENT' ? console.warn : console.error)('[fs] copy failed', src, e);
                        failed.push({ path: src, error: e });
                    }
                    job?.update(results.length + failed.length);
                }
            } finally {
                job?.finish();
            }
            results.failed = failed;
            this._reportFailures(failed, '복사하');
            if (!results.length) return results;
            this.emitChange({ type: 'copy', paths: results.map((r) => r.to), from: results.map((r) => r.from), to: results.map((r) => r.to), dirs: [destDir] });
            if (undoable) {
                let copies = results.map((r) => r.to);
                let replaced = replacedIds;
                App.undo.push({
                    label: results.length === 1 ? `"${P.base(results[0].from)}" 복사` : `${results.length}개 복사`,
                    undo: async () => {
                        // Copies go to the trash too (soft delete), so even this undo can be recovered
                        await this.trash(copies, { undoable: false, silent: true });
                        if (replaced.length) await this.restore(replaced);
                    },
                    redo: async () => {
                        const again = await this.copy(results.map((r) => r.from), destDir, { undoable: false, onConflict: onConflict ? async () => decisions : undefined });
                        copies = again.map((r) => r.to);
                        replaced = again.replacedIds || [];
                    },
                });
            }
            results.replacedIds = replacedIds;
            return results;
        },

        /**
         * Rename many items in one go (batch rename). pairs: [{ path, name }]. Swaps and chains (a→b, b→a) work
         * through hidden temporary names. Emits ONE fs:changed and pushes ONE undo entry. Returns [{ from, to }].
         * Throws (EINVAL / EEXIST) before touching anything if a name is invalid or would collide.
         */
        async renameMany(pairs, { undoable = true, label } = {}) {
            this._guardWrite();
            const items = pairs.filter((x) => P.base(x.path) !== x.name);
            if (!items.length) return [];
            const sources = new Set(items.map((x) => x.path.toLowerCase()));
            const targets = new Set();
            for (const it of items) {
                const err = this.validateName(it.name);
                if (err) throw fsError('EINVAL', `${it.name}: ${err}`);
                const dest = P.join(P.parent(it.path), it.name);
                const key = dest.toLowerCase();
                if (targets.has(key)) throw fsError('EEXIST', `같은 이름이 두 번 나와요: ${it.name}`);
                targets.add(key);
                if (!sources.has(key) && (await this.backend.exists(dest))) throw fsError('EEXIST', `"${it.name}"이(가) 이미 있어요`);
            }
            const stamp = Date.now().toString(36);
            const staged = [];
            const job = items.length > 20 ? App.jobs?.start({ title: '이름 바꾸는 중', total: items.length * 2, cancellable: false }) : null;
            try {
                for (const [i, it] of items.entries()) {
                    const dir = P.parent(it.path);
                    const tmp = `.fi-rename-${stamp}-${i}`;
                    const st = await this.backend.stat(it.path);
                    await this.backend.move(it.path, dir, tmp);
                    if (st.kind === 'file') await this._moveSidecar(it.path, dir, tmp);
                    App.catalog?.relocate(it.path, P.join(dir, tmp));
                    staged.push({ from: it.path, tmp: P.join(dir, tmp), to: P.join(dir, it.name), kind: st.kind });
                    job?.step();
                }
                for (const s of staged) {
                    await this.backend.move(s.tmp, P.parent(s.to), P.base(s.to));
                    if (s.kind === 'file') await this._moveSidecar(s.tmp, P.parent(s.to), P.base(s.to));
                    App.catalog?.relocate(s.tmp, s.to);
                    s.done = true;
                    job?.step();
                }
            } catch (e) {
                // Never leave anything under a temporary name
                for (const s of [...staged].reverse()) {
                    if (s.done) continue;
                    try {
                        await this.backend.move(s.tmp, P.parent(s.from), P.base(s.from));
                        if (s.kind === 'file') await this._moveSidecar(s.tmp, P.parent(s.from), P.base(s.from));
                        App.catalog?.relocate(s.tmp, s.from);
                    } catch (e2) {
                        console.error('[fs] rename rollback failed', s, e2);
                    }
                }
                const done = staged.filter((s) => s.done);
                if (done.length) this.emitChange({ type: 'rename', paths: done.map((s) => s.to), from: done.map((s) => s.from), to: done.map((s) => s.to), dirs: done.map((s) => P.parent(s.to)) });
                throw e;
            } finally {
                job?.finish();
            }
            const results = staged.map((s) => ({ from: s.from, to: s.to }));
            this.emitChange({ type: 'rename', paths: results.map((r) => r.to), from: results.map((r) => r.from), to: results.map((r) => r.to), dirs: results.map((r) => P.parent(r.to)) });
            if (undoable) {
                App.undo.push({
                    label: label || (results.length === 1 ? `이름 바꾸기 "${P.base(results[0].from)}"` : `${results.length}개 이름 바꾸기`),
                    undo: () => this.renameMany(results.map((r) => ({ path: r.to, name: P.base(r.from) })), { undoable: false }),
                    redo: () => this.renameMany(results.map((r) => ({ path: r.from, name: P.base(r.to) })), { undoable: false }),
                });
            }
            return results;
        },

        /** Delete for real (no trash). Internal use: emptying the trash. */
        async removePermanently(paths) {
            this._guardWrite();
            for (const p of paths) {
                await this.backend.remove(p);
                App.catalog?.remove(p);
            }
            this.emitChange({ type: 'delete', paths, dirs: paths.map((p) => P.parent(p)) });
        },

        // ----- Trash: items move into .fluid-organizer/trash/<batch>/ and are listed in manifest.json -----
        async readTrashManifest() {
            const m = await this.readJSON(TRASH_MANIFEST, null).catch(() => null);
            return m && Array.isArray(m.items) ? m : { version: 1, items: [] };
        },

        async _updateTrashManifest(fn) {
            return withLock(TRASH_MANIFEST + '#update', async () => {
                const m = await this.readTrashManifest();
                const out = await fn(m);
                // Always written (even if ownership moved mid-batch): it is the only record of files already in the trash
                await withLock(TRASH_MANIFEST, () => this.backend.write(TRASH_MANIFEST, JSON.stringify(m, null, 1)));
                return out;
            });
        },

        /** Move paths to the app trash (restorable). Returns trash item ids. opts: { undoable, silent, label } */
        async trash(paths, { undoable = true, silent = false, label: customLabel } = {}) {
            this._guardWrite();
            if (!paths.length) return [];
            const batch = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
            const batchDir = P.join(TRASH_DIR, batch);
            const items = [];
            const failed = [];
            const job = paths.length > 20 ? App.jobs?.start({ title: '휴지통으로 옮기는 중', total: paths.length }) : null;
            try {
                for (const src of paths) {
                    if (job?.cancelled || !this.canWriteData()) break; // another window took over: stop here
                    try {
                        const st = await this.backend.stat(src);
                        const name = await this.uniqueName(batchDir, P.base(src), { isDir: st.kind === 'dir' });
                        await this.backend.move(src, batchDir, name);
                        if (st.kind === 'file') await this._moveSidecar(src, batchDir, name);
                        items.push({
                            id: App.util.uid('t'),
                            name: P.base(src),
                            kind: st.kind,
                            size: st.size,
                            originalPath: src,
                            trashPath: P.join(batchDir, name),
                            deletedAt: Date.now(),
                            catalog: App.catalog ? App.catalog.take(src) : null,
                        });
                    } catch (e) {
                        (e.code === 'ENOENT' ? console.warn : console.error)('[fs] trash failed', src, e);
                        failed.push({ path: src, error: e });
                    }
                    job?.update(items.length + failed.length);
                }
            } finally {
                job?.finish();
            }
            this._reportFailures(failed, '휴지통으로 옮기');
            if (!items.length) return [];
            await this._updateTrashManifest((m) => {
                m.items.push(...items);
            });
            App.bus.emit('trash:changed');
            const trashed = items.map((i) => i.originalPath);
            this.emitChange({ type: 'trash', paths: trashed, from: trashed, dirs: trashed.map((p) => P.parent(p)) });

            const ids = items.map((i) => i.id);
            const label = customLabel || (items.length === 1 ? `"${items[0].name}" 삭제` : `${items.length}개 삭제`);
            if (undoable) {
                let currentIds = ids;
                let restoredPaths = [];
                App.undo.push({
                    label,
                    undo: async () => {
                        restoredPaths = await this.restore(currentIds);
                    },
                    redo: async () => {
                        if (restoredPaths.length) currentIds = await this.trash(restoredPaths, { undoable: false, silent: true });
                    },
                });
            }
            if (!silent) {
                App.ui?.toast(`${label} — 휴지통으로 옮겼어요`, {
                    type: 'success',
                    action: undoable ? { label: '실행 취소', run: () => App.undo.undo() } : undefined,
                });
            }
            return ids;
        },

        /** Restore trash items to where they came from (or a unique name next to it). */
        async restore(ids) {
            this._guardWrite();
            const restored = [];
            const from = []; // original path of each restored item (same order) — a taken name makes `to` differ
            await this._updateTrashManifest(async (m) => {
                for (const id of ids) {
                    const item = m.items.find((i) => i.id === id);
                    if (!item) continue;
                    const destDir = P.parent(item.originalPath);
                    await this.backend.mkdir(destDir).catch(() => {});
                    const name = await this.uniqueName(destDir, item.name, { isDir: item.kind === 'dir' });
                    await this.backend.move(item.trashPath, destDir, name);
                    if (item.kind === 'file') await this._moveSidecar(item.trashPath, destDir, name);
                    const to = P.join(destDir, name);
                    if (item.catalog && App.catalog) App.catalog.put(item.catalog, item.originalPath, to);
                    item.restoredTo = to;
                    restored.push(to);
                    from.push(item.originalPath);
                }
                m.items = m.items.filter((i) => !ids.includes(i.id));
            });
            App.bus.emit('trash:changed');
            if (restored.length) this.emitChange({ type: 'restore', paths: restored, from, dirs: restored.map((p) => P.parent(p)) });
            return restored;
        },

        async listTrash() {
            return (await this.readTrashManifest()).items;
        },

        /** Permanently delete trash items (all when ids is omitted). */
        async purgeTrash(ids) {
            this._guardWrite();
            await this._updateTrashManifest(async (m) => {
                const targets = ids ? m.items.filter((i) => ids.includes(i.id)) : m.items;
                for (const item of targets) {
                    try {
                        await this.backend.remove(item.trashPath);
                    } catch (e) {
                        if (e.code !== 'ENOENT') throw e;
                    }
                }
                const gone = new Set(targets.map((i) => i.id));
                m.items = m.items.filter((i) => !gone.has(i.id));
            });
            App.bus.emit('trash:changed');
        },
    };

    App.fs = fs;
})();
