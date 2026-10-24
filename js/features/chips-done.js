/*
 * Explicit completion — App.chipsDone: FOLDER, isDone(path), summary(path), move(paths).
 * Commands: chips.done (gallery selection), chips.done.viewer (Ctrl+Enter, whole viewer file).
 * Moves preserve relative folders and catalog data. One undo entry owns moves, origin metadata and
 * only the empty destination folders this action created. Partial successes remain undoable.
 */
(() => {
    'use strict';
    const { path: P } = App.util;
    const FOLDER = '_완료';
    const ui = App.ui;
    let busy = false;

    const isDone = (path) => path.startsWith(FOLDER + '/');
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

    function restoreOrigin(path, origin) {
        App.catalog.update(path, (entry) => {
            const meta = { ...(entry.meta || {}) };
            for (const key of ['doneFrom', 'doneAt']) {
                if (origin[key] === undefined) delete meta[key];
                else meta[key] = origin[key];
            }
            entry.meta = meta;
        }, { undoable: false });
    }

    async function transfer(record, destination, name) {
        const result = await App.fs.move([record.current], destination, { undoable: false });
        if (!result[0]) throw result.failed?.[0]?.error || new Error('파일을 옮기지 못했어요');
        record.current = result[0].to;
        if (P.base(record.current) !== name && !await App.fs.exists(P.join(destination, name))) {
            record.current = await App.fs.rename(record.current, name, { undoable: false });
        }
    }

    async function move(paths) {
        if (!ready()) return [];
        busy = true;
        const records = [];
        const created = [];
        const workspace = App.state.workspace?.id;
        let failure = null;
        try {
            App.chipset.pieceTarget()?.flush?.();
            const files = App.chipset.toFilePaths([...new Set(paths)]).filter((path) => !isDone(path));
            if (!files.length) return [];
            const summaries = files.map(summary);
            if (summaries.some((s) => !s.tagged) && !await ui.confirm({ title: '완료 폴더로 옮기기', message: '칩이 하나도 없어요. 그래도 완료할까요?', okLabel: '완료하기' })) return [];
            if (App.state.workspace?.id !== workspace) return [];
            const text = [...new Set(summaries.map((s) => s.text))].join(' / ');
            App.chipset.hud(text, { kind: 'info', sub: '완료 폴더로 옮겨요' });
            const viewer = App.viewer;
            const current = viewer?.isOpen ? viewer.current?.path : null;
            const advance = current && files.includes(current);
            const candidates = advance ? viewer.files.slice(viewer.index + 1).concat(viewer.files.slice(0, viewer.index)).filter((e) => !files.includes(e.path)) : [];
            try {
                for (const path of files) {
                    const folder = P.parent(path);
                    const destination = P.join(FOLDER, folder);
                    await ensureFolder(destination, created);
                    const meta = App.catalog.peek(path)?.meta || {};
                    const origin = { doneFrom: meta.doneFrom, doneAt: meta.doneAt };
                    const result = await App.fs.move([path], destination, { undoable: false });
                    if (!result[0]) {
                        failure = result.failed?.[0]?.error || new Error('파일을 옮기지 못했어요');
                        continue;
                    }
                    const record = { from: path, current: result[0].to, origin, doneAt: Date.now() };
                    records.push(record);
                    App.catalog.setMeta(record.current, { doneFrom: folder, doneAt: record.doneAt });
                }
            } catch (error) {
                failure = error;
            }
            if (records.length) {
                const checkWorkspace = () => {
                    if (App.state.workspace?.id !== workspace) throw new Error('원래 작업 폴더를 열어 주세요');
                };
                App.undo.push({
                    label: `완료 폴더로 이동 (${records.length}개)`,
                    undo: async () => {
                        checkWorkspace();
                        for (const record of [...records].reverse()) {
                            // Publish restored metadata only after relocation owns the final path.
                            if (isDone(record.current)) await transfer(record, P.parent(record.from), P.base(record.from));
                            restoreOrigin(record.current, record.origin);
                        }
                        await cleanFolders(created);
                    },
                    redo: async () => {
                        checkWorkspace();
                        for (const record of records) {
                            if (!isDone(record.current)) {
                                const destination = P.join(FOLDER, P.parent(record.from));
                                await ensureFolder(destination, created);
                                await transfer(record, destination, P.base(record.from));
                            }
                            App.catalog.setMeta(record.current, { doneFrom: P.parent(record.from), doneAt: record.doneAt });
                        }
                    },
                });
                if (advance && records.some((r) => r.from === current) && viewer.isOpen) {
                    // The shell deliberately retains moved files; reopen against the updated folder list.
                    const next = candidates.find((e) => App.view.visible.some((v) => v.path === e.path));
                    viewer.close();
                    if (next) viewer.open(next.path);
                }
                ui.toast(`완료 폴더로 옮겼어요 · ${text}`, { type: 'success', action: { label: '되돌리기', run: () => App.undo.undo() } });
            } else {
                await cleanFolders(created);
            }
            if (failure) ui.toast(`일부 파일을 옮기지 못했어요: ${failure.message}`, { type: 'warning' });
            return records.map((r) => ({ from: r.from, to: r.current }));
        } catch (error) {
            ui.toast(error.message, { type: 'error' });
            return [];
        } finally {
            busy = false;
        }
    }

    App.commands.register({ id: 'chips.done', title: '완료 폴더로 옮기기', group: '칩', icon: 'check', when: () => ready() && selected().some((path) => !isDone(path)), run: () => move(selected()) });
    App.commands.register({ id: 'chips.done.viewer', title: '완료하고 다음', group: '칩', icon: 'check', keys: 'Ctrl+Enter', scope: 'viewer', when: () => ready() && !!App.viewer?.isOpen && App.viewer.current?.kind === 'file' && !isDone(App.viewer.current.path), run: () => move([App.viewer.current.path]) });

    App.register('chips-done', {
        init() {
            App.gallery?.contextMenuItems.push((entries) => {
                const files = entries.filter((e) => e.kind === 'file' && !isDone(e.path)).map((e) => e.path);
                return files.length ? [{ label: '완료 폴더로 옮기기', icon: 'check', action: () => move(files) }] : [];
            });
        },
    });
    App.chipsDone = { FOLDER, isDone, summary, move };
})();
