/*
 * Explicit completion — App.chipsDone: FOLDER, isDone(path), summary(path), mark(paths), move(paths),
 * unmark(paths), migrateDone(). move is an alias of mark; completion keeps files in place.
 * Commands: chips.done, chips.done.viewer, chips.undone, chips.migrateDone.
 * Catalog flags and legacy _완료 paths count as done. Migration and each completion action own one undo entry.
 * chips.hideDone defaults true; the done view filter exempts the 완료함 smart view.
 */
(() => {
    'use strict';
    const { path: P } = App.util;
    const FOLDER = '_완료';
    const ui = App.ui;
    let busy = false;

    const legacy = (path) => path.startsWith(FOLDER + '/');
    const isDone = (path) => !!App.catalog.peek(path)?.done || legacy(path);
    const { h } = App.util;
    let syncing = false;
    let offeredWorkspace = null;

    function refresh() {
        if (syncing) return;
        syncing = true;
        try {
            const hide = App.settings.get('chips.hideDone', true);
            if (hide && !App.view.filters.has('done')) {
                App.view.setFilter('done', {
                    label: '완료 숨김',
                    test: (entry) => App.view.source.smart === 'done' || !isDone(entry.path),
                });
            } else if (!hide && App.view.filters.has('done')) App.view.setFilter('done', null);
            else App.view.recompute('patch');
            App.topbar?.renderViewbar?.();
            App.gallery?.refresh();
        } finally {
            syncing = false;
        }
    }

    function completionFields(path) {
        const entry = App.catalog.peek(path) || {};
        return { done: entry.done, doneAt: entry.meta?.doneAt, doneFrom: entry.meta?.doneFrom };
    }

    function writeFields(path, fields) {
        App.catalog.update(path, (entry) => {
            if (fields.done === undefined) delete entry.done;
            else entry.done = fields.done;
            const meta = { ...(entry.meta || {}) };
            for (const key of ['doneAt', 'doneFrom']) {
                if (fields[key] === undefined) delete meta[key];
                else meta[key] = fields[key];
            }
            entry.meta = meta;
        }, { undoable: false });
    }

    async function changeMark(paths, done) {
        if (!ready() || (App.lock?.canWrite && !App.lock.canWrite())) return [];
        busy = true;
        const workspace = App.state.workspace?.id;
        try {
            App.chipset.pieceTarget()?.flush?.();
            const files = App.chipset.toFilePaths([...new Set(paths)]).filter((path) => done ? !isDone(path) : isDone(path));
            if (!files.length) return [];
            const summaries = files.map(summary);
            if (done && summaries.some((s) => !s.tagged) && !await ui.confirm({ title: '완료로 표시하기', message: '칩이 하나도 없어요. 그래도 완료할까요?', okLabel: '완료하기' })) return [];
            if (App.state.workspace?.id !== workspace) return [];
            // Legacy paths cannot be unmarked in place because their location still denotes completion.
            if (!done && files.some(legacy)) return await migrate(files, false, workspace);
            const viewer = App.viewer;
            const current = viewer?.isOpen ? viewer.current?.path : null;
            const candidates = current && files.includes(current)
                ? viewer.files.slice(viewer.index + 1).concat(viewer.files.slice(0, viewer.index)).filter((e) => !files.includes(e.path)) : [];
            const before = files.map(completionFields);
            const at = Date.now();
            const after = before.map((fields) => ({ ...fields, done: done ? true : undefined, doneAt: done ? at : undefined }));
            const apply = (values) => {
                if (App.state.workspace?.id !== workspace) throw new Error('원래 작업 폴더를 열어 주세요');
                files.forEach((path, i) => writeFields(path, values[i]));
            };
            apply(after);
            App.undo.push({ label: `${done ? '완료 표시' : '완료 취소'} (${files.length}개)`, undo: () => apply(before), redo: () => apply(after) });
            if (done && current && files.includes(current) && viewer.isOpen) {
                const next = candidates.find((e) => App.view.visible.some((v) => v.path === e.path));
                viewer.close();
                if (next) viewer.open(next.path);
            }
            const text = [...new Set(summaries.map((s) => s.text))].join(' / ');
            ui.toast(done ? `완료로 표시했어요 · ${text}` : '완료 표시를 취소했어요', {
                type: 'success', action: { label: '되돌리기', run: () => App.undo.undo() },
            });
            return files.map((path) => ({ from: path, to: path }));
        } catch (error) {
            ui.toast(error.message, { type: 'error' });
            return [];
        } finally {
            busy = false;
        }
    }

    const mark = (paths) => changeMark(paths, true);
    const unmark = (paths) => changeMark(paths, false);

    async function migrate(paths, done, workspace) {
        const records = [];
        const created = [];
        const removed = [];
        const check = () => {
            if (App.state.workspace?.id !== workspace) throw new Error('원래 작업 폴더를 열어 주세요');
        };
        const relocate = async (record, target, fields) => {
            check();
            await ensureFolder(P.parent(target), created);
            if (record.current !== target) await transfer(record, P.parent(target), P.base(target));
            writeFields(record.current, fields);
        };
        let failure = null;
        try {
            for (const path of paths) {
                check();
                const before = completionFields(path);
                const relative = legacy(path) ? path.slice(FOLDER.length + 1) : path;
                const folder = typeof before.doneFrom === 'string' ? before.doneFrom : P.parent(relative);
                // Reject malformed origins instead of creating paths outside the workspace or inside completion again.
                if (folder.split('/').some((part) => part === '..' || part === '.') || folder.startsWith('/') || folder.includes('\\') || folder === FOLDER || legacy(folder)) throw new Error('원래 폴더 경로를 확인해 주세요');
                const record = { from: path, current: path, before, after: { done: done ? true : undefined, doneAt: done ? Date.now() : undefined, doneFrom: undefined } };
                if (legacy(path)) {
                    await ensureFolder(folder, created);
                    await transfer(record, folder, P.base(relative));
                }
                records.push(record);
                record.target = record.current;
                writeFields(record.current, record.after);
            }
            const folders = new Set();
            for (const record of records) {
                if (!legacy(record.from)) continue;
                for (let folder = P.parent(record.from); folder; folder = P.parent(folder)) folders.add(folder);
            }
            for (const folder of [...folders].sort((a, b) => b.split('/').length - a.split('/').length)) {
                if (await App.fs.exists(folder) && !(await App.fs.backend.list(folder, { stat: false })).length) {
                    await App.fs.removePermanently([folder]);
                    removed.push(folder);
                }
            }
        } catch (error) {
            failure = error;
        } finally {
            // Commit once after cleanup, including any files restored before a partial failure.
            if (records.length) {
                App.undo.push({
                    label: done ? '예전 완료 파일 돌리기' : '완료 취소',
                    undo: async () => {
                        check();
                        for (const folder of [...removed].reverse()) await ensureFolder(folder, created);
                        for (const record of [...records].reverse()) await relocate(record, record.from, record.before);
                        await cleanFolders(created.filter((folder) => !removed.includes(folder)));
                    },
                    redo: async () => {
                        check();
                        for (const record of records) await relocate(record, record.target, record.after);
                        await cleanFolders([...removed].reverse());
                    },
                });
                refresh();
            }
        }
        if (failure) ui.toast(`일부 파일을 돌리지 못했어요: ${failure.message}`, { type: 'warning' });
        return records.map((record) => ({ from: record.from, to: record.current }));
    }

    async function migrateDone() {
        if (!ready() || (App.lock?.canWrite && !App.lock.canWrite())) return [];
        busy = true;
        const workspace = App.state.workspace?.id;
        try {
            await App.index.whenReady();
            if (App.state.workspace?.id !== workspace) return [];
            return await migrate(App.index.items.filter((entry) => legacy(entry.path)).map((entry) => entry.path), true, workspace);
        } finally {
            busy = false;
        }
    }

    function offerMigration() {
        const workspace = App.state.workspace?.id;
        if (!workspace || !App.index.ready || !App.catalog.loaded || offeredWorkspace === workspace) return;
        const count = App.index.items.filter((entry) => legacy(entry.path)).length;
        if (!count) return;
        offeredWorkspace = workspace;
        ui.toast(`예전 방식으로 완료 폴더에 옮긴 파일 ${count}개가 있어요`, {
            duration: 10000,
            action: { label: '원래 자리로 돌리기', run: () => App.state.workspace?.id === workspace && migrateDone() },
        });
    }
    const ready = () => App.fs.ready && App.chipset?.ready && !busy;
    const selected = () => App.select.entries().filter((e) => e.kind === 'file').map((e) => e.path);

    function summary(path) {
        const entry = App.catalog.peek(path) || {};
        const ids = new Set(entry.chips || []);
        let pieces = 0;
        const edit = entry.meta?.edit;
        if (App.util.mediaType(path) === 'video') {
            for (const [key, piece] of Object.entries(edit?.pieces || {})) {
                const start = Number(key);
                if (!Number.isFinite(start) || start < 0 || (edit.removed || []).some((r) => Array.isArray(r) && start >= r[0] && start < r[1])) continue;
                if (!piece?.chips?.length) continue;
                pieces++;
                for (const id of piece.chips) ids.add(id);
            }
        }
        const groups = new Map();
        for (const id of App.chipset.sortIds(ids)) {
            const info = App.chipset.info(id);
            if (!info) continue;
            // A child already names its parent; avoid repeating the same classification.
            if ((info.chip.children || []).some((child) => ids.has(child.id))) continue;
            const key = info.cat.id;
            if (!groups.has(key)) groups.set(key, { name: info.cat.name, labels: [] });
            groups.get(key).labels.push([info.parent?.name, info.chip.name].filter(Boolean).join(' › '));
        }
        const parts = [...groups.values()].map((g) => `${g.name} ${g.labels.join(', ')}`);
        if (pieces) parts.push(`조각 ${pieces}개`);
        return { tagged: ids.size > 0, text: parts.join(' · ') || '칩 없음' };
    }

    async function ensureFolder(path, created) {
        let parent = '';
        for (const name of path.split('/').filter(Boolean)) {
            const next = P.join(parent, name);
            if (!await App.fs.exists(next)) {
                await App.fs.mkdir(parent, name, { undoable: false });
                created.push(next);
            } else if ((await App.fs.stat(next)).kind !== 'dir') {
                throw new Error(`폴더가 아니에요: ${next}`);
            }
            parent = next;
        }
    }

    async function cleanFolders(created) {
        for (const path of [...created].reverse()) {
            if (!await App.fs.exists(path)) continue;
            // Read raw names: hidden files must also prevent removal of a directory.
            if (!(await App.fs.backend.list(path, { stat: false })).length) await App.fs.removePermanently([path]);
        }
    }

    async function transfer(record, destination, name) {
        const result = await App.fs.move([record.current], destination, { undoable: false });
        if (!result[0]) throw result.failed?.[0]?.error || new Error('파일을 옮기지 못했어요');
        record.current = result[0].to;
        if (P.base(record.current) !== name && !await App.fs.exists(P.join(destination, name))) {
            record.current = await App.fs.rename(record.current, name, { undoable: false });
        }
    }

    const move = mark;
    App.commands.register({ id: 'chips.done', title: '완료로 표시하기', group: '칩', icon: 'check', when: () => ready() && selected().some((path) => !isDone(path)), run: () => mark(selected()) });
    const undonePaths = () => App.viewer?.isOpen ? [App.viewer.current?.path].filter(Boolean) : selected();
    App.commands.register({ id: 'chips.undone', title: '완료 취소', group: '칩', icon: 'check', when: () => ready() && undonePaths().some(isDone), run: () => unmark(undonePaths()) });
    App.commands.register({ id: 'chips.migrateDone', title: '예전 완료 파일을 원래 자리로 돌리기', group: '칩', icon: 'folder', when: () => ready() && App.index.ready && App.index.items.some((entry) => legacy(entry.path)), run: migrateDone });
    App.commands.register({ id: 'chips.done.viewer', title: '완료하고 다음', group: '칩', icon: 'check', keys: 'Ctrl+Enter', scope: 'viewer', when: () => ready() && !!App.viewer?.isOpen && App.viewer.current?.kind === 'file' && !isDone(App.viewer.current.path), run: () => move([App.viewer.current.path]) });

    App.register('chips-done', {
        init() {
            App.topbar?.addViewbarItem?.(() => {
                if (!App.fs.ready) return null;
                const hide = App.settings.get('chips.hideDone', true);
                const count = App.view.entries.filter((entry) => entry.kind === 'file' && isDone(entry.path)).length;
                return h('button', {
                    type: 'button', class: 'btn sm chip-done-toggle',
                    text: hide ? `완료 ${count}개 숨김 · 보기` : '완료 보기 중 · 숨기기',
                    'aria-pressed': String(!hide),
                    onclick: () => {
                        const before = App.settings.get('chips.hideDone', true);
                        App.settings.set('chips.hideDone', !before);
                        App.undo.push({ label: '완료 파일 보기', undo: () => App.settings.set('chips.hideDone', before), redo: () => App.settings.set('chips.hideDone', !before) });
                    },
                });
            });
            App.gallery?.cardDecorators.push((card, entry) => {
                if (entry.kind !== 'file' || !isDone(entry.path)) return;
                card.append(h('span', { class: 'chip-done-badge', text: '완료' }));
            });
            App.viewer?.contextItems.push((entry) => entry?.kind === 'file' && isDone(entry.path)
                ? [{ label: '완료 취소', icon: 'check', action: () => unmark([entry.path]) }] : []);
            App.bus.on('catalog:changed', refresh);
            App.bus.on('catalog:loaded', () => { refresh(); offerMigration(); });
            App.bus.on('index:ready', () => { refresh(); offerMigration(); });
            App.bus.on('index:changed', refresh);
            App.bus.on('workspace:opened', () => { refresh(); offerMigration(); });
            App.bus.on('workspace:closed', () => { offeredWorkspace = null; });
            App.bus.on('settings:changed', ({ key }) => { if (key === 'chips.hideDone') refresh(); });
            App.bus.on('view:filters', () => {
                if (!syncing && App.settings.get('chips.hideDone', true) && !App.view.filters.has('done')) refresh();
            });
            refresh();
            App.gallery?.contextMenuItems.push((entries) => {
                const files = entries.filter((e) => e.kind === 'file' && !isDone(e.path)).map((e) => e.path);
                const done = entries.filter((e) => e.kind === 'file' && isDone(e.path)).map((e) => e.path);
                return [
                    ...(files.length ? [{ label: '완료로 표시하기', icon: 'check', action: () => mark(files) }] : []),
                    ...(done.length ? [{ label: '완료 취소', icon: 'check', action: () => unmark(done) }] : []),
                ];
            });
        },
    });
    App.chipsDone = { FOLDER, isDone, summary, mark, move, unmark, migrateDone };
})();
