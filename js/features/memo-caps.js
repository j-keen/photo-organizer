/*
 * Memo captures: source catalog.memoCaps = [{ path, t?, piece?, at, missing? }].
 * Attachment paths follow filesystem operations; missing is set on trash/delete and cleared on restore.
 * Scene navigation restores the recorded oriented crop and zoom once the media is ready.
 * App.memoCaps: list(path, {piece}), attach(path, cap, {piece}), detach(path, capPath, {trash}),
 * captureToMemo({region}), mount(section, editorGetter), showAll(), exportFolder(folder?).
 * list without a piece returns file-memo attachments; pass a numeric piece start for a piece memo.
 * Capture/paste owns file creation, attachment and memo token as one undo entry.
 */
(() => {
    'use strict';
    const { h, path: P } = App.util;
    const ui = App.ui;
    const clone = (value) => JSON.parse(JSON.stringify(value));
    let pending = Promise.resolve();
    const capSources = new Map();
    const sourceCaps = new Map();

    function indexSource(path) {
        for (const capPath of sourceCaps.get(path) || []) {
            const sources = capSources.get(capPath);
            sources?.delete(path);
            if (!sources?.size) capSources.delete(capPath);
        }
        sourceCaps.delete(path);
        const paths = new Set((App.catalog.peek(path)?.memoCaps || []).map((cap) => cap.path));
        if (!paths.size) return;
        sourceCaps.set(path, paths);
        for (const capPath of paths) {
            if (!capSources.has(capPath)) capSources.set(capPath, new Set());
            capSources.get(capPath).add(path);
        }
    }

    function rebuildIndex() {
        capSources.clear();
        sourceCaps.clear();
        for (const [path, entry] of App.catalog.entries()) if (entry.memoCaps?.length) indexSource(path);
    }

    function followFiles(change) {
        const { type } = change;
        if (!['rename', 'move', 'trash', 'delete', 'restore', 'copy'].includes(type)) return;
        const from = change.from || change.paths || [];
        const to = change.to || change.paths || [];
        const relocating = type === 'rename' || type === 'move';
        const restoring = type === 'restore';
        const removed = type === 'trash' || type === 'delete';
        // Catalog relocation is silent. Refresh source keys before resolving capture references.
        const refresh = new Set();
        for (const path of sourceCaps.keys()) {
            const i = from.findIndex((root) => P.isInside(path, root));
            if (i < 0 || (!relocating && !removed)) continue;
            refresh.add(path);
            if (relocating && to[i] != null) refresh.add(P.rebase(path, from[i], to[i]));
        }
        if (restoring || type === 'copy') {
            for (const [path, entry] of App.catalog.entries()) {
                if (entry.memoCaps?.length && to.some((root) => P.isInside(path, root))) refresh.add(path);
            }
        }
        for (const path of refresh) indexSource(path);
        if (type === 'copy') return;
        const replacements = new Map();
        const affected = new Set();
        for (const [path, sources] of capSources) {
            const i = from.findIndex((root) => P.isInside(path, root));
            if (i < 0) continue;
            replacements.set(path, { path: !removed && to[i] != null ? P.rebase(path, from[i], to[i]) : path, missing: removed });
            for (const source of sources) affected.add(source);
        }
        // These changes belong to the filesystem action's existing undo entry.
        for (const path of affected) {
            App.catalog.update(path, (entry) => {
                entry.memoCaps = (entry.memoCaps || []).map((cap) => {
                    const replacement = replacements.get(cap.path);
                    if (!replacement) return cap;
                    const next = { ...cap, path: replacement.path };
                    if (replacement.missing) next.missing = true;
                    else delete next.missing;
                    return next;
                });
            }, { undoable: false });
        }
    }

    function writable() {
        App.fs._guardWrite();
    }

    function workspaceGuard() {
        const id = App.state.workspace?.id;
        return () => {
            if (id !== App.state.workspace?.id) throw new Error('원래 작업 폴더를 열어 주세요');
            writable();
        };
    }

    function list(path, { piece } = {}) {
        return clone((App.catalog.peek(path)?.memoCaps || []).filter((cap) => (cap.piece ?? null) === (piece ?? null)));
    }

    function memoText(path, piece) {
        const entry = App.catalog.peek(path);
        return piece == null ? entry?.memo || '' : entry?.meta?.edit?.pieces?.[String(piece)]?.memo || '';
    }

    function writeMemo(entry, piece, value) {
        if (piece == null) {
            if (value) entry.memo = value;
            else delete entry.memo;
        } else {
            entry.meta = entry.meta || {};
            entry.meta.edit = entry.meta.edit || {};
            entry.meta.edit.pieces = entry.meta.edit.pieces || {};
            const key = String(piece);
            entry.meta.edit.pieces[key] = { ...entry.meta.edit.pieces[key], memo: value };
        }
    }

    function writeCaps(path, caps) {
        App.catalog.update(path, (entry) => {
            if (caps.length) entry.memoCaps = clone(caps);
            else delete entry.memoCaps;
        }, { undoable: false });
    }

    function attach(path, cap, { piece } = {}) {
        writable();
        if (!cap?.path) throw new Error('캡처 파일을 찾을 수 없어요');
        const value = { path: cap.path, at: cap.at ?? Date.now() };
        if (Number.isFinite(cap.t)) value.t = cap.t;
        if (piece != null) value.piece = piece;
        App.catalog.update(path, (entry) => {
            const caps = entry.memoCaps || [];
            if (!caps.some((item) => item.path === value.path && (item.piece ?? null) === (piece ?? null))) entry.memoCaps = [...caps, value];
        }, { label: '메모에 캡처 붙이기' });
        return value;
    }

    async function detach(path, capPath, { trash = false } = {}) {
        const check = workspaceGuard();
        check();
        const before = clone(App.catalog.peek(path)?.memoCaps || []);
        if (!before.some((cap) => cap.path === capPath)) return;
        let current = capPath;
        let ids = [];
        if (trash) {
            ids = await App.fs.trash([current], { undoable: false, silent: true });
            if (!ids.length) throw new Error('캡처를 삭제하지 못했어요');
        }
        writeCaps(path, before.filter((cap) => cap.path !== capPath));
        App.undo.push({
            label: trash ? '메모 캡처 삭제' : '메모 캡처 떼기',
            undo: async () => {
                check();
                if (trash) {
                    const restored = await App.fs.restore(ids);
                    if (!restored[0]) throw new Error('캡처를 복원하지 못했어요');
                    current = restored[0];
                }
                writeCaps(path, before.map((cap) => cap.path === capPath ? { ...cap, path: current } : cap));
            },
            redo: async () => {
                check();
                if (trash) {
                    ids = await App.fs.trash([current], { undoable: false, silent: true });
                    if (!ids.length) throw new Error('캡처를 삭제하지 못했어요');
                }
                writeCaps(path, before.filter((cap) => cap.path !== capPath));
            },
        });
    }

    function targetNow() {
        const editor = App.chipsViewer?.memoEditor?.();
        const current = App.viewer?.current;
        if (!App.viewer?.isOpen || !current) return null;
        editor?.flush();
        const target = editor?.target?.path === current.path ? editor.target : { path: current.path, start: App.chipset?.pieceTarget?.()?.start ?? null };
        const focused = editor?.input && document.activeElement === editor.input;
        return { path: target.path, piece: target.start, start: focused ? editor.input.selectionStart : null, end: focused ? editor.input.selectionEnd : null };
    }

    function stamp(t) {
        const seconds = Math.max(0, Math.floor(t));
        return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }

    async function cleanDir(dir) {
        if (await App.fs.exists(dir) && !(await App.fs.backend.list(dir, { stat: false })).length) await App.fs.removePermanently([dir]);
    }

    async function commitShot(shot, target, check) {
        check();
        if (!shot || !target) return null;
        if (!App.capture?.save) throw new Error('캡처 기능을 준비하고 있어요');
        const saved = await App.capture.save(shot, { undoable: false });
        let current = saved.path;
        const cap = { path: current, at: Date.now() };
        if (Number.isFinite(shot.source?.t)) cap.t = shot.source.t;
        if (target.piece != null) cap.piece = target.piece;
        const beforeText = memoText(target.path, target.piece);
        const token = Number.isFinite(cap.t) ? `[캡처 ${stamp(cap.t)}]` : '[캡처]';
        const start = Math.min(target.start ?? beforeText.length, beforeText.length);
        const end = Math.min(target.end ?? start, beforeText.length);
        const afterText = beforeText.slice(0, start) + token + beforeText.slice(end);
        const apply = (on) => App.catalog.update(target.path, (entry) => {
            const caps = (entry.memoCaps || []).filter((item) => item.at !== cap.at || item.path !== current);
            if (on) caps.push({ ...cap, path: current });
            if (caps.length) entry.memoCaps = caps;
            else delete entry.memoCaps;
            writeMemo(entry, target.piece, on ? afterText : beforeText);
        }, { undoable: false });
        try {
            check();
            apply(true);
        } catch (error) {
            await App.fs.trash([current], { undoable: false, silent: true });
            if (saved.createdDir) await cleanDir(shot.dir);
            throw error;
        }
        let ids;
        App.undo.push({
            label: '메모에 화면 캡처',
            undo: async () => {
                check();
                ids = await App.fs.trash([current], { undoable: false, silent: true });
                if (!ids.length) throw new Error('캡처를 휴지통으로 옮기지 못했어요');
                apply(false);
                if (saved.createdDir) await cleanDir(shot.dir);
            },
            redo: async () => {
                check();
                const restored = await App.fs.restore(ids);
                if (!restored[0]) throw new Error('캡처를 복원하지 못했어요');
                current = restored[0];
                apply(true);
            },
        });
        const editor = App.chipsViewer?.memoEditor?.();
        if (editor?.target?.path === target.path && (editor.target.start ?? null) === (target.piece ?? null)) {
            editor.input.value = afterText;
            editor.input.setSelectionRange(start + token.length, start + token.length);
        }
        return current;
    }

    function enqueue(task) {
        const result = pending.then(task);
        pending = result.catch(() => {});
        return result;
    }

    function captureToMemo({ region } = {}) {
        const target = targetNow();
        const check = workspaceGuard();
        if (!target || !App.capture?.available?.()) return Promise.resolve(null);
        return enqueue(async () => {
            check();
            if (App.viewer.current?.path !== target.path) return null;
            const shot = await App.capture.grab({ region });
            return shot ? commitShot(shot, target, check) : null;
        });
    }

    function report(task) {
        return Promise.resolve().then(task).catch((error) => ui.toast(`작업을 마치지 못했어요: ${error.message}`, { type: 'error' }));
    }

    async function pasteImage(blob) {
        const target = targetNow();
        if (!target) return;
        const check = workspaceGuard();
        return enqueue(async () => {
            check();
            const bitmap = await createImageBitmap(blob);
            try {
                const format = App.settings.get('capture.format', 'jpg') === 'png' ? 'png' : 'jpg';
                const canvas = document.createElement('canvas');
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
                const context = canvas.getContext('2d');
                context.fillStyle = '#fff';
                context.fillRect(0, 0, canvas.width, canvas.height);
                context.drawImage(bitmap, 0, 0);
                const mime = format === 'png' ? 'image/png' : 'image/jpeg';
                const encoded = await new Promise((resolve) => canvas.toBlob(resolve, mime, App.settings.get('capture.quality', 0.92)));
                if (!encoded) throw new Error('이미지를 저장하지 못했어요');
                return commitShot({ blob: encoded, w: canvas.width, h: canvas.height, ext: format, mime,
                    name: `${P.stem(target.path)}_캡처.${format}`, dir: P.join(P.parent(target.path), '_캡처'),
                    source: { path: target.path, kind: App.util.mediaType(target.path), crop: { x: 0, y: 0, w: canvas.width, h: canvas.height }, zoom: 1, rot: 0, flipH: false, flipV: false },
                }, target, check);
            } finally {
                bitmap.close();
            }
        });
    }

    async function scene(path, cap) {
        const source = clone(App.catalog.peek(cap.path)?.meta?.capture || null);
        await App.viewer.open(path, { time: cap.t, play: false });
        if (!source) return;
        // Opening and seeking can replace the transform after open() returns.
        for (let frame = 0; frame < 300; frame++) {
            if (!App.viewer.isOpen || App.viewer.current?.path !== path) return;
            const view = App.viewer.view;
            const video = App.viewer.kind === 'video' ? App.viewer.player?.video : null;
            if (view?.path === path && view.nat && (!video || (video.readyState >= 2 && !video.seeking))) {
                view.restore?.(source);
                return;
            }
            await new Promise((resolve) => requestAnimationFrame(resolve));
        }
    }

    async function lightbox(path, cap, piece) {
        const resource = await App.fs.url(cap.path);
        const image = h('img', { class: 'mc-lightbox-image', src: resource.url, alt: '메모에 붙인 캡처' });
        const body = h('div', { class: 'mc-lightbox' }, image);
        let closeBox = () => {};
        const action = (text, run) => h('button', { type: 'button', class: 'btn sm', text, onclick: () => report(run) });
        const actions = h('div', { class: 'mc-actions' },
            action('크게 보기', () => image.classList.toggle('mc-original')),
            action('그 장면으로', () => { closeBox(); return scene(path, cap); }),
            action('떼기', async () => { await detach(path, cap.path); closeBox(); }),
            action('삭제', async () => { await detach(path, cap.path, { trash: true }); closeBox(); }));
        if (App.captureAnnotate?.open) actions.append(action('그리기', () => { closeBox(); return App.captureAnnotate.open(cap.path); }));
        if (App.server?.ocr) actions.append(action('글자 추출', async () => {
            const check = workspaceGuard();
            const result = await App.server.ocr(cap.path);
            check();
            if (!result.text?.trim()) return ui.toast('읽을 수 있는 글자가 없어요');
            App.chipsViewer?.memoEditor?.()?.flush();
            App.catalog.update(path, (entry) => writeMemo(entry, piece, [memoText(path, piece), result.text].filter(Boolean).join('\n')), { label: '캡처 글자 넣기' });
            closeBox();
        }));
        body.append(actions);
        try {
            await ui.dialog({ title: '메모 캡처', body, width: 900, actions: [{ label: '닫기', value: null }], init(box, close) { closeBox = close; } });
        } finally {
            resource.release();
        }
    }

    function mount(section, getEditor) {
        let dead = false;
        let generation = 0;
        let signature = '';
        let resources = [];
        const rendered = h('div', { class: 'mc-rendered' });
        const strip = h('div', { class: 'mc-strip', 'aria-label': '메모 캡처 목록' });
        const button = h('button', { type: 'button', class: 'btn sm mc-capture', text: '캡처 ▾', onmousedown: (event) => event.preventDefault(), onclick: () => {
            ui.menu([
                { label: '보이는 영역', command: 'capture.toMemo', disabled: !App.capture?.available?.() },
                { label: '영역 지정', action: () => report(async () => { const region = await App.capture?.pickRegion?.(); if (region) await captureToMemo({ region }); }) },
                { label: App.capture?.intervalRunning ? '연속 캡처 중지' : '연속 캡처 시작', action: () => {
                    if (App.capture?.intervalRunning) App.capture.stopInterval();
                    else if (App.capture?.startInterval) {
                        App.capture.startInterval(App.settings.get('capture.interval', 10), (shot) => {
                            const target = targetNow();
                            const check = workspaceGuard();
                            if (target && shot?.source?.path === target.path) return report(() => enqueue(() => commitShot(shot, target, check)));
                        });
                    }
                } },
                { label: '클립보드로 복사', action: () => report(async () => { const shot = await App.capture?.grab?.(); if (shot) await App.capture.copy(shot); }) },
                '-',
                { label: '캡처 모아 보기', command: 'capture.showAll' },
                { label: '강의 노트 내보내기', command: 'capture.exportNotes' },
            ], { anchor: button });
        } });
        section.querySelector('.chip-dock-memo-head').append(button);
        section.append(rendered, strip);
        const input = getEditor().input;
        const onPaste = (event) => {
            const item = [...(event.clipboardData?.items || [])].find((value) => value.kind === 'file' && value.type.startsWith('image/'));
            const blob = item?.getAsFile();
            if (!blob) return;
            event.preventDefault();
            report(() => pasteImage(blob));
        };
        input.addEventListener('paste', onPaste);
        input.addEventListener('focus', sync);
        input.addEventListener('blur', sync);

        function sync() {
            if (dead) return;
            const editor = getEditor();
            const target = editor.target;
            button.disabled = !target;
            rendered.replaceChildren();
            rendered.hidden = document.activeElement === input || !target;
            if (target && !rendered.hidden) {
                const text = memoText(target.path, target.start);
                const caps = list(target.path, { piece: target.start });
                const pattern = /\[캡처(?: (\d+):(\d{2}))?\]/g;
                let offset = 0;
                for (const match of text.matchAll(pattern)) {
                    rendered.append(document.createTextNode(text.slice(offset, match.index)));
                    const t = match[1] == null ? null : Number(match[1]) * 60 + Number(match[2]);
                    const cap = caps.find((item) => t == null ? item.t == null : Math.floor(item.t) === t);
                    rendered.append(cap ? h('button', { type: 'button', class: 'mc-token', text: match[0], onclick: () => report(() => scene(target.path, cap)) }) : document.createTextNode(match[0]));
                    offset = match.index + match[0].length;
                }
                rendered.append(document.createTextNode(text.slice(offset)));
            }
            const caps = target ? list(target.path, { piece: target.start }) : [];
            const next = JSON.stringify([target, caps]);
            if (next === signature) return;
            signature = next;
            const token = ++generation;
            resources.forEach((resource) => resource.release());
            resources = [];
            strip.replaceChildren();
            for (const cap of caps) {
                const img = h('img', { alt: Number.isFinite(cap.t) ? `캡처 ${stamp(cap.t)}` : '캡처', loading: 'lazy' });
                const thumb = h('button', { type: 'button', class: 'mc-thumb', 'aria-label': img.alt, onclick: () => report(() => lightbox(target.path, cap, target.start)) }, img);
                strip.append(thumb);
                App.fs.url(cap.path).then((resource) => {
                    if (dead || token !== generation) return resource.release();
                    resources.push(resource);
                    img.src = resource.url;
                }).catch(() => { img.alt = '캡처 파일을 찾을 수 없어요'; });
            }
        }
        sync();
        return { sync, destroy() {
            dead = true;
            generation++;
            resources.forEach((resource) => resource.release());
            input.removeEventListener('paste', onPaste);
            input.removeEventListener('focus', sync);
            input.removeEventListener('blur', sync);
        } };
    }

    async function showAll() {
        await App.index.whenReady();
        App.viewer?.close();
        App.view.setEntries(App.index.items.filter((entry) => App.catalog.peek(entry.path)?.meta?.capture), {
            type: 'smart', path: null, title: '캡처 모아 보기', owner: 'memo-caps',
            emptyTitle: '아직 캡처가 없어요', emptyText: '메모 옆 캡처 버튼으로 화면을 저장해 보세요.',
        });
    }

    async function exportFolder(folder = App.state.cwd ?? '') {
        const check = workspaceGuard();
        check();
        const files = (await App.fs.list(folder)).filter((entry) => entry.kind === 'file');
        const link = (path) => path.split('/').map(encodeURIComponent).join('/');
        const sections = ['# 강의 노트'];
        for (const file of files) {
            const entry = App.catalog.peek(file.path) || {};
            sections.push(`## ${file.name.replace(/[\r\n]/g, ' ')}`, entry.memo || '');
            for (const [start, piece] of Object.entries(entry.meta?.edit?.pieces || {})) {
                if (piece.memo) sections.push(`### 조각 ${stamp(Number(start))}`, piece.memo);
            }
            for (const cap of entry.memoCaps || []) {
                const relative = folder && cap.path.startsWith(folder + '/') ? cap.path.slice(folder.length + 1) : cap.path;
                sections.push(`![캡처${Number.isFinite(cap.t) ? ' ' + stamp(cap.t) : ''}](${link(relative)})`);
            }
        }
        const blob = new Blob([sections.join('\n\n') + '\n'], { type: 'text/markdown;charset=utf-8' });
        const path = P.join(folder, '강의노트.md');
        check();
        if (await App.fs.exists(path)) await App.fs.overwrite(path, blob, { label: '강의 노트 내보내기' });
        else await App.fs.createFile(folder, '강의노트.md', blob, { label: '강의 노트 내보내기' });
        const url = URL.createObjectURL(blob);
        const anchor = h('a', { href: url, download: '강의노트.md' });
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        ui.toast('강의 노트를 저장했어요');
        return path;
    }

    App.commands.register({ id: 'capture.toMemo', title: '현재 화면을 메모에 캡처', group: '캡처', keys: 'Ctrl+Shift+C', scope: 'viewer', allowInInput: true, when: () => !!App.capture?.available?.(), run: () => report(() => captureToMemo()) });
    App.commands.register({ id: 'capture.showAll', title: '캡처 모아 보기', group: '캡처', when: () => App.fs.ready, run: () => report(showAll) });
    App.commands.register({ id: 'capture.exportNotes', title: '강의 노트 내보내기', group: '캡처', when: () => App.fs.ready, run: () => report(() => exportFolder()) });
    App.register('memo-caps', { init() {
        rebuildIndex();
        App.bus.on('catalog:loaded', rebuildIndex);
        App.bus.on('catalog:changed', ({ paths } = {}) => {
            if (!paths) rebuildIndex();
            else for (const path of paths) indexSource(path);
        });
        App.bus.on('fs:changed', followFiles);
        App.bus.on('workspace:closed', () => { capSources.clear(); sourceCaps.clear(); });
        App.bus.on('viewer:closed', () => App.capture?.stopInterval?.());
        App.bus.on('workspace:closed', () => App.capture?.stopInterval?.());
        App.sidebar?.folderMenuItems?.push((folder) => [{ label: '강의 노트 내보내기', action: () => report(() => exportFolder(folder)) }]);
    } });
    App.memoCaps = { list, attach, detach, captureToMemo, mount, showAll, exportFolder };
})();
