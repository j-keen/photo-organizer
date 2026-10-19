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
            for await (const [name, h] of d.entries()) out.push({ name, kind: h.kind === 'directory' ? 'dir' : 'file', _h: h });
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
            return this.backend.getFile(p);
        },

        url(p) {
            return this.backend.url(p);
        },

        async readText(p) {
            const f = await this.backend.getFile(p);
            return f.text();
        },

        async readJSON(p, fallback = null) {
            try {
                return JSON.parse(await this.readText(p));
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
            return withLock(p, () => this.backend.write(p, data));
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
            const finalName = await this.uniqueName(dirPath, name);
            const p = P.join(dirPath, finalName);
            await this.backend.write(p, data);
            this.emitChange({ type: 'create', paths: [p], dirs: [dirPath] });
            if (undoable) {
                let ids = null;
                App.undo.push({
                    label: label || `"${finalName}" 만들기`,
                    undo: async () => {
                        ids = await this.trash([p], { undoable: false, silent: true });
                    },
                    redo: async () => {
                        if (ids) await this.restore(ids);
                    },
                });
            }
            return p;
        },

        /**
         * Replace a file's contents in place (e.g. rotated image). The previous version is kept in the app trash
         * (restorable from the trash panel) and Ctrl+Z puts it back.
         */
        async overwrite(p, data, { undoable = true, label } = {}) {
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
         * Move paths into destDir. Name clashes get " (2)" suffixes. Returns [{ from, to }] for moved items.
         * opts: { undoable = true, label }
         */
        async move(paths, destDir, { undoable = true, label } = {}) {
            const results = [];
            const reserved = new Set();
            const job = paths.length > 20 ? App.jobs?.start({ title: '이동하는 중', total: paths.length }) : null;
            try {
                for (const src of paths) {
                    if (job?.cancelled) break;
                    if (P.parent(src) === destDir) continue;
                    if (P.isInside(destDir, src)) {
                        App.ui?.toast(`"${P.base(src)}"을(를) 자기 안으로 옮길 수 없어요`, { type: 'warning' });
                        continue;
                    }
                    const st = await this.backend.stat(src);
                    const name = await this.uniqueName(destDir, P.base(src), { isDir: st.kind === 'dir', reserved });
                    await this.backend.move(src, destDir, name);
                    if (st.kind === 'file') await this._moveSidecar(src, destDir, name);
                    const to = P.join(destDir, name);
                    App.catalog?.relocate(src, to);
                    results.push({ from: src, to });
                    job?.update(results.length);
                }
            } finally {
                job?.finish();
            }
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
                    },
                    redo: () => this.move(results.map((r) => r.from), destDir, { undoable: false }),
                });
            }
            return results;
        },

        /** Copy paths into destDir (catalog metadata is copied too). Returns [{ from, to }]. */
        async copy(paths, destDir, { undoable = true } = {}) {
            const results = [];
            const reserved = new Set();
            const job = paths.length > 5 ? App.jobs?.start({ title: '복사하는 중', total: paths.length }) : null;
            try {
                for (const src of paths) {
                    if (job?.cancelled) break;
                    if (P.isInside(destDir, src)) continue;
                    const st = await this.backend.stat(src);
                    const name = await this.uniqueName(destDir, P.base(src), { isDir: st.kind === 'dir', reserved });
                    await this.backend.copy(src, destDir, name);
                    const to = P.join(destDir, name);
                    App.catalog?.copy(src, to);
                    results.push({ from: src, to });
                    job?.update(results.length);
                }
            } finally {
                job?.finish();
            }
            if (!results.length) return results;
            this.emitChange({ type: 'copy', paths: results.map((r) => r.to), from: results.map((r) => r.from), to: results.map((r) => r.to), dirs: [destDir] });
            if (undoable) {
                App.undo.push({
                    label: results.length === 1 ? `"${P.base(results[0].from)}" 복사` : `${results.length}개 복사`,
                    undo: () => this.removePermanently(results.map((r) => r.to)),
                    redo: () => this.copy(results.map((r) => r.from), destDir, { undoable: false }),
                });
            }
            return results;
        },

        /** Delete for real (no trash). Internal use: undoing copies, emptying trash. */
        async removePermanently(paths) {
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
                await this.writeJSON(TRASH_MANIFEST, m);
                return out;
            });
        },

        /** Move paths to the app trash (restorable). Returns trash item ids. */
        async trash(paths, { undoable = true, silent = false } = {}) {
            if (!paths.length) return [];
            const batch = 'b' + Date.now().toString(36);
            const batchDir = P.join(TRASH_DIR, batch);
            const items = [];
            const job = paths.length > 20 ? App.jobs?.start({ title: '휴지통으로 옮기는 중', total: paths.length }) : null;
            try {
                for (const src of paths) {
                    if (job?.cancelled) break;
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
                    job?.update(items.length);
                }
            } finally {
                job?.finish();
            }
            if (!items.length) return [];
            await this._updateTrashManifest((m) => {
                m.items.push(...items);
            });
            App.bus.emit('trash:changed');
            const trashed = items.map((i) => i.originalPath);
            this.emitChange({ type: 'trash', paths: trashed, from: trashed, dirs: trashed.map((p) => P.parent(p)) });

            const ids = items.map((i) => i.id);
            const label = items.length === 1 ? `"${items[0].name}" 삭제` : `${items.length}개 삭제`;
            if (undoable) {
                App.undo.push({
                    label,
                    undo: () => this.restore(ids),
                    redo: async () => {
                        const m = await this.readTrashManifest();
                        const paths2 = m.items.filter((i) => ids.includes(i.id)).map((i) => i.restoredTo || i.originalPath);
                        await this.trash(paths2, { undoable: false, silent: true });
                    },
                });
            }
            if (!silent) {
                App.ui?.toast(`${label} — 휴지통으로 옮겼어요`, {
                    type: 'success',
                    action: { label: '실행 취소', run: () => App.undo.undo() },
                });
            }
            return ids;
        },

        /** Restore trash items to where they came from (or a unique name next to it). */
        async restore(ids) {
            const restored = [];
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
                }
                m.items = m.items.filter((i) => !ids.includes(i.id));
            });
            App.bus.emit('trash:changed');
            if (restored.length) this.emitChange({ type: 'restore', paths: restored, dirs: restored.map((p) => P.parent(p)) });
            return restored;
        },

        async listTrash() {
            return (await this.readTrashManifest()).items;
        },

        /** Permanently delete trash items (all when ids is omitted). */
        async purgeTrash(ids) {
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
