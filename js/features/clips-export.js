/*
 * Clip library — export (clips team): '하나로 저장' (server concat) and '각각 저장' (server trim per clip).
 *
 *   App.clipsExport.run(clips, { mode: 'concat'|'each', label })   asks once (name / folder / template), then exports
 *   App.clipsExport.expand(template, clip, index)                  file name for a clip ('{영상}_{시작}-{끝}_{메모}')
 *   App.clipsExport.TOKENS
 *
 * Every export is ONE undo step: Ctrl+Z moves the new file(s) to the app trash, Ctrl+Y brings them back. Progress shows
 * in App.jobs (cancellable). The new files keep the clips' metadata: chips (union), memos (with source and time) and
 * meta.source = [{ path, start, end }] — written in the same undo step. Without the local server the setup sheet opens.
 */
(() => {
    'use strict';
    const { h, path: P, formatCount } = App.util;
    const ui = App.ui;

    const DEFAULT_TEMPLATE = '{영상}_{시작}-{끝}_{메모}';
    const TOKENS = [
        { key: '{영상}', tip: '원본 영상 이름' },
        { key: '{시작}', tip: '시작 시간 (01m23s)' },
        { key: '{끝}', tip: '끝 시간' },
        { key: '{메모}', tip: '메모 첫 줄' },
        { key: '{칩}', tip: '칩 이름' },
        { key: '{번호}', tip: '01, 02 …' },
        { key: '{날짜}', tip: '오늘 날짜' },
    ];
    const MAX_CONCAT = 50;

    const C = () => App.clips;

    function stamp(t) {
        t = Math.max(0, Math.floor(Number(t) || 0));
        const h2 = Math.floor(t / 3600);
        const m = Math.floor((t % 3600) / 60);
        const s = t % 60;
        return `${h2 ? `${h2}h` : ''}${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`;
    }

    function today() {
        const d = new Date();
        return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    }

    // Windows-safe file name: no reserved characters, no dangling separators, not too long
    function cleanName(s) {
        let out = String(s || '')
            .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
            .replace(/\s+/g, ' ')
            .replace(/([_\-. ])[_\-. ]*(?=[_\-])/g, '$1')
            .replace(/_{2,}/g, '_')
            .replace(/^[\s_\-.]+|[\s_\-.]+$/g, '');
        if ([...out].length > 120) out = [...out].slice(0, 120).join('').replace(/[\s_\-.]+$/, '');
        return out;
    }

    function expand(template, clip, index = 0) {
        const memo = cleanName(C().memoLine(clip) || clip.title || '');
        const short = [...memo].length > 40 ? [...memo].slice(0, 40).join('') : memo;
        const map = {
            '{영상}': P.stem(clip.path),
            '{시작}': stamp(clip.start),
            '{끝}': stamp(clip.end),
            '{메모}': short,
            '{제목}': cleanName(C().displayTitle(clip)),
            '{칩}': C().chipNames(clip).join(','),
            '{번호}': String(index + 1).padStart(2, '0'),
            '{날짜}': today(),
        };
        const raw = String(template || DEFAULT_TEMPLATE).replace(/\{[^}]+\}/g, (k) => (k in map ? map[k] : k));
        return cleanName(raw) || cleanName(`${P.stem(clip.path)}_${stamp(clip.start)}-${stamp(clip.end)}`) || 'clip';
    }

    function memoFor(list) {
        const fmt = C().fmt;
        const note = (c) => [c.title, c.memo].map((x) => String(x || '').trim()).filter(Boolean).join('\n');
        if (list.length === 1) {
            const c = list[0];
            return [note(c), `출처: ${P.base(c.path)} ${fmt(c.start)}–${fmt(c.end)}`].filter(Boolean).join('\n');
        }
        return list.map((c, i) => {
            const n = note(c).replace(/\n+/g, ' / ');
            return `${i + 1}. ${P.base(c.path)} ${fmt(c.start)}–${fmt(c.end)}${n ? ` — ${n}` : ''}`;
        }).join('\n');
    }

    function concatDefaultName(list, label) {
        const sources = new Set(list.map((c) => c.path));
        if (sources.size === 1) return cleanName(`${P.stem(list[0].path)}_모음`);
        if (label) return cleanName(`${label}_모음`);
        return `보관함_모음_${today()}`;
    }

    function folderLabel(dir) {
        return dir ? dir : '작업 폴더 맨 위';
    }

    // ---------- Server checks ----------
    function serverReady() {
        const S = App.server;
        if (!S || !S.video) {
            ui.toast('영상 저장은 로컬 서버가 있어야 해요', { type: 'warning' });
            return null;
        }
        if (!S.available || !S.backend) {
            if (typeof S.showSetup === 'function') S.showSetup();
            else ui.toast('로컬 서버를 켜고 서버로 작업 폴더를 열어 주세요', { type: 'warning' });
            return null;
        }
        if (typeof S.canUse === 'function' && !S.canUse('ffmpeg')) {
            ui.toast('로컬 서버에 ffmpeg가 없어서 영상을 저장할 수 없어요', { type: 'error' });
            return null;
        }
        return S;
    }

    // Poll one server job, reporting 0..1 progress. Rejects with code ECANCELED when cancelled.
    async function follow(S, first, { onProgress, isCancelled }) {
        let job = first;
        let wait = 200;
        for (;;) {
            if (!job || !job.id) throw Object.assign(new Error('작업을 시작하지 못했어요'), { code: 'ESERVER' });
            onProgress(job.progress || 0, job.message || '');
            if (job.state === 'done') return job.result;
            if (job.state === 'error') throw Object.assign(new Error(job.error?.message || '로컬 서버 작업이 실패했어요'), { code: job.error?.code || 'ESERVER' });
            if (job.state === 'cancelled' || isCancelled()) {
                if (job.state !== 'cancelled') (S.cancelJob ? S.cancelJob(job.id) : S.request('POST', `/api/jobs/${encodeURIComponent(job.id)}/cancel`, {})).catch(() => {});
                throw Object.assign(new Error('작업을 취소했어요'), { code: 'ECANCELED' });
            }
            await App.util.sleep(wait);
            wait = Math.min(800, Math.round(wait * 1.25));
            job = await S.job(job.id);
        }
    }

    // ---------- Dialog ----------
    function ask(list, mode, label) {
        const first = list[0];
        const firstDir = P.parent(first.path);
        const cwd = App.state.cwd;
        const sameFolder = list.every((c) => P.parent(c.path) === firstDir);
        const folders = [];
        if (mode === 'each' && !sameFolder) folders.push({ value: '@source', label: '각 원본 영상 옆' });
        folders.push({ value: firstDir, label: `${folderLabel(firstDir)}${mode === 'each' && !sameFolder ? ' (첫 조각 영상 폴더)' : ''}` });
        if (cwd != null && cwd !== firstDir && App.view?.source?.type === 'folder') folders.push({ value: cwd, label: `${folderLabel(cwd)} (지금 보는 폴더)` });

        const total = list.reduce((n, c) => n + C().duration(c), 0);
        const sources = new Set(list.map((c) => c.path)).size;
        const summary = h('div', { class: 'clipx-summary' },
            h('span', { class: 'clipx-sum-ico', html: ui.icon(mode === 'concat' ? 'merge' : 'scissors', { size: 16 }) }),
            h('div', null,
                h('div', { class: 'clipx-sum-title', text: mode === 'concat' ? `조각 ${formatCount(list.length)}개를 영상 하나로` : `조각 ${formatCount(list.length)}개를 파일 ${formatCount(list.length)}개로` }),
                h('div', { class: 'clipx-sum-sub', text: `전체 ${C().fmt(total)} · 원본 영상 ${formatCount(sources)}개${mode === 'concat' && sources > 1 ? ' · 크기가 다르면 첫 영상에 맞춰요' : ''}` })));

        const nameInput = h('input', { class: 'input', type: 'text', spellcheck: 'false', 'aria-label': mode === 'concat' ? '파일 이름' : '이름 규칙' });
        const err = h('div', { class: 'field-error' });
        const preview = h('div', { class: 'clipx-preview' });
        const tokenRow = h('div', { class: 'clipx-tokens' });
        const folderSel = h('select', { class: 'select', 'aria-label': '저장할 폴더' }, ...folders.map((f) => h('option', { value: f.value, text: f.label })));
        const lastFolder = App.settings.get('clips.exportFolder', null);
        if (lastFolder && folders.some((f) => f.value === lastFolder)) folderSel.value = lastFolder;

        let cut = App.settings.get('clips.trimMode', 'accurate');
        const modeSeg = h('div', { class: 'seg clipx-seg', role: 'radiogroup', 'aria-label': '자르는 방식' });
        const modes = [
            { id: 'accurate', label: '정확하게', tip: '프레임 단위로 정확하게 잘라요 (다시 인코딩, 조금 느려요)' },
            { id: 'fast', label: '빠르게', tip: '화질 그대로 빠르게 잘라요 (키프레임 기준이라 앞뒤가 조금 달라질 수 있어요)' },
        ];
        const paintSeg = () => modeSeg.querySelectorAll('button').forEach((b) => {
            b.classList.toggle('on', b.dataset.mode === cut);
            b.setAttribute('aria-checked', String(b.dataset.mode === cut));
        });
        for (const m of modes) {
            modeSeg.append(h('button', { type: 'button', role: 'radio', dataset: { mode: m.id }, 'data-tip': m.tip, text: m.label, onclick: () => {
                cut = m.id;
                paintSeg();
            } }));
        }
        paintSeg();

        if (mode === 'concat') {
            nameInput.value = concatDefaultName(list, label);
        } else {
            nameInput.value = App.settings.get('clips.nameTemplate', DEFAULT_TEMPLATE);
            for (const t of TOKENS) {
                tokenRow.append(h('button', { type: 'button', class: 'clipx-token', 'data-tip': t.tip, text: t.key, onclick: () => {
                    const s = nameInput.selectionStart ?? nameInput.value.length;
                    const e = nameInput.selectionEnd ?? s;
                    nameInput.setRangeText(t.key, s, e, 'end');
                    nameInput.focus();
                    nameInput.dispatchEvent(new Event('input'));
                } }));
            }
        }

        const body = h('div', { class: 'clipx' },
            summary,
            h('div', { class: 'field' }, h('label', { text: mode === 'concat' ? '파일 이름' : '이름 규칙' }),
                mode === 'concat' ? h('div', { class: 'clipx-name' }, nameInput, h('span', { class: 'clipx-ext', text: '.mp4' })) : nameInput,
                mode === 'each' ? tokenRow : null, err),
            mode === 'each' ? h('div', { class: 'field' }, h('label', { text: '이렇게 저장돼요' }), preview) : null,
            h('div', { class: 'field' }, h('label', { text: '저장할 곳' }), folderSel),
            mode === 'each' ? h('div', { class: 'field clipx-mode' }, h('label', { text: '자르는 방식' }), modeSeg) : null,
            h('p', { class: 'clipx-note', html: `${ui.icon('info', { size: 13 })}<span>원본은 그대로 두고 새 파일을 만들어요. 칩과 메모도 함께 옮겨 적어요 — 마음에 안 들면 Ctrl+Z.</span>` }));

        const validate = () => {
            const v = nameInput.value.trim();
            if (!v) return mode === 'concat' ? '파일 이름을 입력해 주세요' : '이름 규칙을 입력해 주세요';
            if (mode === 'concat') {
                const n = cleanName(v);
                if (!n) return '파일 이름에 쓸 수 있는 글자를 넣어 주세요';
                const e = App.fs.validateName?.(`${n}.mp4`);
                if (e) return e;
            }
            return null;
        };
        const refresh = (primaryBtn) => {
            const e = validate();
            err.textContent = e || '';
            nameInput.classList.toggle('invalid', !!e);
            if (primaryBtn) primaryBtn.disabled = !!e;
            if (mode === 'each') {
                preview.innerHTML = '';
                const tpl = nameInput.value.trim() || DEFAULT_TEMPLATE;
                for (const [i, c] of list.slice(0, 3).entries()) preview.append(h('div', { class: 'clipx-preview-row', html: `${ui.icon('film', { size: 12 })}<span class="truncate"></span>` }));
                [...preview.children].forEach((row, i) => {
                    row.querySelector('span').textContent = `${expand(tpl, list[i], i)}.${P.ext(list[i].path) || 'mp4'}`;
                });
                if (list.length > 3) preview.append(h('div', { class: 'clipx-preview-more', text: `외 ${formatCount(list.length - 3)}개` }));
            }
        };

        return ui.dialog({
            title: mode === 'concat' ? '하나로 저장' : '각각 저장',
            body,
            width: 460,
            actions: [
                { label: '취소', value: null, kind: 'ghost' },
                {
                    label: mode === 'concat' ? '합쳐서 저장' : `${formatCount(list.length)}개 저장`,
                    kind: 'primary',
                    onClick: (close) => {
                        if (validate()) return;
                        const value = nameInput.value.trim();
                        App.settings.set('clips.exportFolder', folderSel.value);
                        if (mode === 'each') {
                            App.settings.set('clips.nameTemplate', value);
                            App.settings.set('clips.trimMode', cut);
                        }
                        close({ name: mode === 'concat' ? cleanName(value) : value, folder: folderSel.value, cut });
                    },
                },
            ],
            init(box, _close, { primaryBtn }) {
                nameInput.addEventListener('input', () => refresh(primaryBtn));
                refresh(primaryBtn);
                nameInput.focus();
                nameInput.select();
            },
        });
    }

    // ---------- Run ----------
    async function run(list, { mode = 'concat', label = '' } = {}) {
        list = (list || []).filter((c) => c && !c.missing);
        if (!list.length) {
            ui.toast('저장할 조각을 골라 주세요', { type: 'info' });
            return null;
        }
        if (mode === 'concat' && list.length > MAX_CONCAT) {
            await ui.alert({ title: '조각이 너무 많아요', message: `한 번에 ${MAX_CONCAT}개까지 합칠 수 있어요. 지금은 ${formatCount(list.length)}개예요 — 조금 나눠서 저장해 주세요.` });
            return null;
        }
        if (!serverReady()) return null;
        const answer = await ask(list, mode, label);
        if (!answer) return null;
        const S = serverReady();
        if (!S) return null;
        return mode === 'concat' ? doConcat(S, list, answer) : doEach(S, list, answer);
    }

    function startJob(title) {
        const job = App.jobs.start({ title, total: 100, cancellable: true });
        let cancelled = false;
        job.onCancel?.(() => {
            cancelled = true;
        });
        return { job, isCancelled: () => cancelled || !!job.cancelled };
    }

    function finishMeta(outputs) {
        // outputs: [{ path, clips }] — chips (union), memo and the source ranges ride along in the same undo step
        const byPath = new Map(outputs.map((o) => [o.path, o.clips]));
        App.catalog.updateMany(outputs.map((o) => o.path), (entry, p) => {
            const src = byPath.get(p) || [];
            const chips = [...new Set(src.flatMap((c) => c.chips || []))];
            if (chips.length) entry.chips = [...new Set([...(entry.chips || []), ...chips])];
            const memo = memoFor(src);
            if (memo) entry.memo = memo;
            entry.meta = { ...(entry.meta || {}), source: src.map((c) => ({ path: c.path, start: c.start, end: c.end })) };
        }, { undoable: false });
    }

    function pushUndo(label, paths) {
        const ws = App.state.workspace?.id;
        let current = paths.slice();
        let ids = [];
        App.undo.push({
            label,
            undo: async () => {
                if (App.state.workspace?.id !== ws) throw new Error('다른 작업 폴더라서 되돌릴 수 없어요');
                ids = await App.fs.trash(current, { undoable: false, silent: true });
            },
            redo: async () => {
                if (App.state.workspace?.id !== ws) throw new Error('다른 작업 폴더라서 다시 할 수 없어요');
                const back = await App.fs.restore(ids);
                if (back.length) current = back;
            },
        });
    }

    function announce(p) {
        App.fs.emitChange({ type: 'create', paths: [p], dirs: [P.parent(p)] });
    }

    function done(msg, paths) {
        const first = paths[0];
        ui.toast(msg, {
            type: 'success',
            id: 'clips-export',
            duration: 6000,
            action: first ? { label: '보기', run: () => App.nav.go(P.parent(first), { focus: first }) } : undefined,
        });
    }

    function failed(e, what) {
        if (e && e.code === 'ECANCELED') {
            ui.toast('저장을 취소했어요', { type: 'info', id: 'clips-export' });
            return;
        }
        console.error('[clips] export failed', e);
        ui.toast(`${what}하지 못했어요: ${e?.message || e}`, { type: 'error', id: 'clips-export' });
    }

    async function doConcat(S, list, { name, folder }) {
        const ws = App.state.workspace?.id;
        const { job, isCancelled } = startJob(`조각 ${list.length}개 합치는 중`);
        try {
            const segments = list.map((c) => ({ path: c.path, start: c.start, end: c.end }));
            const output = P.join(folder, `${name}.mp4`);
            const first = await S.video.concat({ segments, output });
            const result = await follow(S, first, { isCancelled, onProgress: (p, m) => job.update(Math.round(p * 100), { detail: m }) });
            if (!result?.path) throw new Error('만든 파일을 찾을 수 없어요');
            job.finish();
            if (App.state.workspace?.id !== ws) {
                ui.toast('작업 폴더가 바뀌었지만 합친 영상은 원래 폴더에 저장했어요', { type: 'info', id: 'clips-export' });
                return [result.path];
            }
            announce(result.path);
            finishMeta([{ path: result.path, clips: list }]);
            pushUndo(`조각 ${list.length}개 하나로 저장`, [result.path]);
            done(`"${P.base(result.path)}"(으)로 합쳐서 저장했어요`, [result.path]);
            return [result.path];
        } catch (e) {
            if (job.state === 'running' || job.state == null) e?.code === 'ECANCELED' ? job.finish() : job.fail?.(e);
            failed(e, '합쳐서 저장');
            return null;
        }
    }

    async function doEach(S, list, { name: template, folder, cut }) {
        const ws = App.state.workspace?.id;
        const n = list.length;
        const { job, isCancelled } = startJob(`조각 ${n}개 저장하는 중`);
        const outputs = [];
        const problems = [];
        let cancelled = false;
        let switched = false;
        for (const [i, c] of list.entries()) {
            if (isCancelled()) {
                cancelled = true;
                break;
            }
            try {
                const first = await S.video.trim({ path: c.path, start: c.start, end: c.end, mode: cut === 'fast' ? 'fast' : 'accurate' });
                const result = await follow(S, first, { isCancelled, onProgress: (p) => job.update(Math.round(((i + p) / n) * 100), { detail: `${i + 1} / ${n} · ${C().displayTitle(c)}` }) });
                if (!result?.path) throw new Error('만든 파일을 찾을 수 없어요');
                // The folder was switched meanwhile: the file is saved, but this workspace's undo/catalog are gone
                if (App.state.workspace?.id !== ws) {
                    switched = true;
                    break;
                }
                announce(result.path);
                let p = result.path;
                outputs.push({ path: p, clips: [c] });
                const out = outputs[outputs.length - 1];
                const dest = folder === '@source' ? P.parent(c.path) : folder;
                if (P.parent(p) !== dest) {
                    const moved = await App.fs.move([p], dest, { undoable: false });
                    if (moved[0]) p = moved[0].to;
                    out.path = p;
                }
                if (App.state.workspace?.id !== ws) {
                    switched = true;
                    break;
                }
                const want = `${expand(template, c, i)}.${P.ext(p) || 'mp4'}`;
                if (want !== P.base(p)) {
                    const free = await App.fs.uniqueName(P.parent(p), want);
                    p = await App.fs.rename(p, free, { undoable: false });
                    out.path = p;
                }
            } catch (e) {
                if (e && e.code === 'ECANCELED') {
                    cancelled = true;
                    break;
                }
                console.error('[clips] trim failed', c, e);
                problems.push({ clip: c, error: e });
            }
        }
        if (job.state === 'running' || job.state == null) job.finish();
        if (switched) {
            ui.toast('작업 폴더가 바뀌어서 저장을 멈췄어요. 이미 만든 파일은 원래 폴더에 그대로 있어요', { type: 'warning', id: 'clips-export', duration: 8000 });
            return outputs.map((o) => o.path);
        }
        if (outputs.length) {
            finishMeta(outputs);
            pushUndo(`조각 ${outputs.length}개 각각 저장`, outputs.map((o) => o.path));
        }
        if (problems.length) {
            ui.toast(`${formatCount(problems.length)}개는 저장하지 못했어요: ${problems[0].error?.message || problems[0].error}`, { type: 'error', id: 'clips-export-fail', duration: 8000 });
        }
        if (outputs.length) done(cancelled ? `취소하기 전까지 ${formatCount(outputs.length)}개를 저장했어요` : `조각 ${formatCount(outputs.length)}개를 각각 저장했어요`, outputs.map((o) => o.path));
        else if (cancelled) ui.toast('저장을 취소했어요', { type: 'info', id: 'clips-export' });
        return outputs.map((o) => o.path);
    }

    App.clipsExport = { run, expand, memoFor, cleanName, stamp, TOKENS, DEFAULT_TEMPLATE, MAX_CONCAT };
})();
