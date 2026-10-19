/*
 * Drag & drop helpers shared by the nav team's drop targets (folder tree, favorites, breadcrumb).
 *
 *   App.navDnd.paths()               — paths of the internal drag in progress (read at dragstart from any source)
 *   App.navDnd.over(e, dir, {label}) — dragover helper: decides move/copy/import or refusal, sets dropEffect,
 *                                      shows the floating hint next to the cursor. Returns the verdict.
 *   App.navDnd.drop(e, dir, {label}) — performs the drop: App.fs.move/copy for internal paths (Ctrl = copy),
 *                                      import (files and whole folders, recursively) for files from the OS
 *   App.navDnd.autoScroll(e, scroller), App.navDnd.spring() (hover-to-open timer), hint(e, text, kind), hideHint()
 *
 * Internal drags carry 'application/x-fi-paths' (JSON array). Refused drops: into itself or one of its own
 * subfolders, or a move into the folder the items already live in.
 */
(() => {
    'use strict';
    const { h, path: P, formatCount } = App.util;
    const ui = App.ui;
    const TYPE = 'application/x-fi-paths';

    let dragged = null;
    let hintEl = null;
    let hintTimer = null;

    // Any internal drag (gallery cards, tree rows, other teams' lists) sets TYPE in its own dragstart handler,
    // which runs before this bubbling listener — so we can read the paths while the data store is still readable.
    document.addEventListener('dragstart', (e) => {
        dragged = null;
        try {
            const raw = e.dataTransfer && e.dataTransfer.getData(TYPE);
            if (raw) dragged = JSON.parse(raw);
        } catch (err) {
            dragged = null;
        }
    });
    const reset = () => {
        dragged = null;
        hideHint();
    };
    document.addEventListener('dragend', reset, true);
    document.addEventListener('drop', () => setTimeout(reset, 0), true);

    function label(dir) {
        if (dir === '') return App.state.workspace?.name || '작업 폴더';
        return App.navMatch.normalize(P.base(dir));
    }

    function quoted(name, pair) {
        return `‘${name}’${App.navMatch.josa(name, pair)}`;
    }

    function what(paths) {
        if (!paths || !paths.length) return '';
        return paths.length === 1 ? quoted(App.navMatch.normalize(P.base(paths[0])), '을/를') : `${formatCount(paths.length)}개를`;
    }

    function isCopy(e) {
        return !!(e.ctrlKey || e.metaKey);
    }

    /** verdict(e, dir) -> { ok, silent?, effect, text, reason } */
    function verdict(e, dir, opts = {}) {
        const types = [...(e.dataTransfer?.types || [])];
        const internal = types.includes(TYPE);
        const files = types.includes('Files');
        if (!internal && !files) return { ok: false, silent: true };
        const name = opts.label ?? label(dir);
        if (App.fs.isDataPath(dir)) return { ok: false, reason: '앱 데이터 폴더에는 넣을 수 없어요' };
        if (internal) {
            const copy = isCopy(e);
            const paths = dragged;
            if (paths && paths.length) {
                if (paths.some((p) => P.isInside(dir, p))) return { ok: false, reason: '자기 자신이나 그 안의 폴더로는 옮길 수 없어요' };
                if (!copy && paths.every((p) => P.parent(p) === dir)) return { ok: false, reason: `이미 ‘${name}’에 있어요` };
            }
            const subject = paths && paths.length ? `${what(paths)} ` : '';
            return copy
                ? { ok: true, effect: 'copy', text: `${subject}${quoted(name, '으로/로')} 복사해요` }
                : { ok: true, effect: 'move', text: `${subject}${quoted(name, '으로/로')} 옮겨요`, sub: 'Ctrl을 누르고 놓으면 복사해요' };
        }
        return { ok: true, effect: 'copy', text: `${quoted(name, '으로/로')} 가져와요`, sub: '원본은 그대로 두고 복사해요' };
    }

    function over(e, dir, opts = {}) {
        const v = verdict(e, dir, opts);
        if (v.silent) return v;
        if (v.ok) {
            e.preventDefault();
            try {
                e.dataTransfer.dropEffect = v.effect;
            } catch (err) {
                /* some sources restrict effects */
            }
        }
        if (opts.hint !== false) hint(e, v.ok ? v.text : v.reason, v.ok ? v.effect : 'no', v.ok ? v.sub : null);
        return v;
    }

    // ---------- Floating hint next to the cursor ----------
    function hint(e, text, kind = 'move', sub = null) {
        if (!text) return hideHint();
        if (!hintEl) {
            hintEl = h('div', { class: 'nav-drag-hint', role: 'status', 'aria-live': 'polite' });
            document.body.append(hintEl);
        }
        const icon = kind === 'no' ? 'x-circle' : kind === 'copy' ? 'copy' : 'folder-input';
        const sig = `${kind}|${text}|${sub}`;
        if (hintEl.dataset.sig !== sig) {
            hintEl.dataset.sig = sig;
            hintEl.className = `nav-drag-hint ${kind}`;
            hintEl.innerHTML = '';
            hintEl.append(h('span', { class: 'nav-drag-hint-icon', html: ui.icon(icon, { size: 14 }) }), h('span', { class: 'nav-drag-hint-text' }, h('b', { text }), sub ? h('small', { text: sub }) : null));
        }
        const w = hintEl.offsetWidth;
        hintEl.style.left = App.util.clamp(e.clientX + 14, 6, window.innerWidth - w - 6) + 'px';
        hintEl.style.top = Math.min(e.clientY + 26, window.innerHeight - hintEl.offsetHeight - 6) + 'px';
        clearTimeout(hintTimer);
        // dragover repeats every ~50ms while hovering a target; silence means the pointer left it
        hintTimer = setTimeout(hideHint, 220);
    }

    function hideHint() {
        clearTimeout(hintTimer);
        if (hintEl) {
            hintEl.remove();
            hintEl = null;
        }
    }

    // ---------- Drop ----------
    async function drop(e, dir, opts = {}) {
        e.preventDefault();
        hideHint();
        const dt = e.dataTransfer;
        const name = opts.label ?? label(dir);
        const raw = dt.getData(TYPE);
        if (raw) {
            let paths;
            try {
                paths = JSON.parse(raw);
            } catch (err) {
                return null;
            }
            const copy = isCopy(e);
            paths = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && !P.isInside(dir, p) && (copy || P.parent(p) !== dir));
            if (!paths.length) return null;
            try {
                const res = copy ? await App.fs.copy(paths, dir) : await App.fs.move(paths, dir);
                if (res && res.length) {
                    ui.toast(`${what(res.map((r) => r.from))} ${quoted(name, '으로/로')} ${copy ? '복사했어요' : '옮겼어요'}`, {
                        type: 'success',
                        action: { label: '실행 취소', run: () => App.undo.undo() },
                    });
                }
                return res;
            } catch (err) {
                ui.toast(`${copy ? '복사' : '이동'}하지 못했어요: ${err.message || err}`, { type: 'error' });
                return null;
            }
        }
        // From the OS: entries must be taken synchronously, before the first await
        const entries = [...(dt.items || [])].filter((it) => it.kind === 'file').map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null));
        const files = [...(dt.files || [])];
        if (!files.length && !entries.length) return null;
        return importDropped(entries.length && entries.every(Boolean) ? entries : null, files, dir, name);
    }

    function readEntries(reader) {
        return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    }

    function entryFile(entry) {
        return new Promise((resolve, reject) => entry.file(resolve, reject));
    }

    /** Import dropped OS files/folders into dir. One undo entry (moves the imported items to the app trash). */
    async function importDropped(entries, files, dir, name = label(dir)) {
        const job = App.jobs.start({ title: `‘${name}’에 가져오는 중`, total: 0, cancellable: true });
        const created = [];
        const stats = { files: 0, folders: 0, other: 0, failed: 0 };
        const bump = () => job.update(stats.files + stats.folders, { detail: `${formatCount(stats.files)}개 파일` });

        async function importEntry(entry, into, top) {
            if (job.cancelled || App.fs.isHiddenName(entry.name)) return;
            if (entry.isDirectory) {
                const folderName = await App.fs.uniqueName(into, entry.name, { isDir: true });
                const p = await App.fs.mkdir(into, folderName, { undoable: false });
                stats.folders++;
                if (top) created.push(p);
                bump();
                const reader = entry.createReader();
                for (;;) {
                    const batch = await readEntries(reader);
                    if (!batch.length || job.cancelled) break;
                    for (const child of batch) await importEntry(child, p, false);
                }
                return;
            }
            try {
                const file = await entryFile(entry);
                const p = await App.fs.createFile(into, file.name, file);
                if (top) created.push(p);
                stats.files++;
                if (App.util.mediaType(file.name) === 'other') stats.other++;
            } catch (err) {
                stats.failed++;
                console.warn('[navDnd] import failed', entry.name, err);
            }
            bump();
        }

        try {
            if (entries) {
                for (const entry of entries) await importEntry(entry, dir, true);
            } else {
                for (const file of files) {
                    if (job.cancelled) break;
                    if (App.fs.isHiddenName(file.name)) continue;
                    try {
                        created.push(await App.fs.createFile(dir, file.name, file));
                        stats.files++;
                        if (App.util.mediaType(file.name) === 'other') stats.other++;
                    } catch (err) {
                        stats.failed++;
                        console.warn('[navDnd] import failed', file.name, err);
                    }
                    bump();
                }
            }
        } catch (err) {
            ui.toast(`가져오는 중에 문제가 생겼어요: ${err.message || err}`, { type: 'error' });
        } finally {
            job.finish();
        }

        if (created.length) {
            let trashed = null;
            const n = stats.files;
            App.undo.push({
                label: `가져오기 ${formatCount(n)}개`,
                undo: async () => {
                    trashed = await App.fs.trash(created, { undoable: false, silent: true });
                },
                redo: async () => {
                    if (trashed && trashed.length) await App.fs.restore(trashed);
                },
            });
            const folderPart = stats.folders ? ` · 폴더 ${formatCount(stats.folders)}개 포함` : '';
            const otherPart = stats.other ? ` · 사진·영상이 아닌 파일 ${formatCount(stats.other)}개는 목록에 안 보여요` : '';
            ui.toast(`파일 ${formatCount(n)}개를 ${quoted(name, '으로/로')} 가져왔어요${folderPart}${otherPart}`, {
                type: 'success',
                duration: 5000,
                action: { label: '실행 취소', run: () => App.undo.undo() },
            });
        }
        if (stats.failed) ui.toast(`${formatCount(stats.failed)}개는 가져오지 못했어요 (폴더째 놓았거나 읽을 수 없는 파일)`, { type: 'warning' });
        return created;
    }

    // ---------- Helpers ----------
    function autoScroll(e, scroller, zone = 36) {
        if (!scroller) return;
        const r = scroller.getBoundingClientRect();
        const y = e.clientY;
        let d = 0;
        if (y < r.top + zone) d = -(1 - Math.max(0, y - r.top) / zone);
        else if (y > r.bottom - zone) d = 1 - Math.max(0, r.bottom - y) / zone;
        if (d) scroller.scrollTop += Math.round(d * 20);
    }

    /** Hover-to-open timer: arm(key, fn) fires fn once after `ms` while the same key keeps being armed. */
    function spring(ms = 600) {
        let key = null;
        let timer = null;
        return {
            arm(k, fn) {
                if (k === key) return;
                clearTimeout(timer);
                key = k;
                timer = setTimeout(fn, ms);
            },
            cancel() {
                clearTimeout(timer);
                key = null;
            },
        };
    }

    App.navDnd = { TYPE, paths: () => dragged, verdict, over, drop, importDropped, autoScroll, spring, hint, hideHint, label };
})();
