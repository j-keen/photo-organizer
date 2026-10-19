/*
 * Duplicate finder v2 — tools and entry points (App.dupes.tools).
 *   openRules({ result })   adjustable rules (bits, minimum matching frames, duration tolerance, 확실 window, photo
 *                           likeness, folder roles) with a live preview of how many groups change — one undo step
 *   openExclusions()        files / folders left out of the check and "중복 아님" pairs, each can be put back (undoable)
 *   Entry points            gallery context menu (files and folders), viewer toolbar '중복검사에서 빼기', sidebar folder
 *                           menu (when App.sidebar.folderMenuItems exists), settings page, pre-build when a workspace opens
 */
(() => {
    'use strict';
    const { h, path: P, formatCount, formatBytes } = App.util;
    const ui = App.ui;
    const kit = App.organize.kit;
    const { icon, btn } = kit;
    const D = () => App.dupes;
    const E = () => App.dupes.engine;

    // =================================================================================================
    // Rules (live preview)
    // =================================================================================================
    const SLIDERS = [
        { key: 'frameBits', label: '같은 장면으로 볼 차이', min: 0, max: 20, step: 1, fmt: (v) => `${v}비트 이하`, hint: '장면 지문 64비트 중 이만큼까지 달라도 같은 장면이에요. 낮을수록 엄격해요.' },
        { key: 'minFrames', label: '같아야 하는 장면 수', min: 1, max: 5, step: 1, fmt: (v) => `5곳 중 ${v}곳 이상`, hint: '15·35·50·65·85% 지점 중 몇 곳이 같아야 같은 영상인지 정해요.' },
        { key: 'durSec', label: '길이 차이 허용 (초)', min: 0, max: 10, step: 0.5, fmt: (v) => `${v}초`, hint: '길이가 이만큼(또는 아래 % 중 큰 쪽)까지 다르면 비교해요.' },
        { key: 'durPct', label: '길이 차이 허용 (%)', min: 0, max: 5, step: 0.5, fmt: (v) => `${v}%`, hint: '긴 영상은 길이의 몇 %까지 달라도 비교할지 정해요.' },
        { key: 'sureSec', label: '확실 기준 (길이 차이)', min: 0, max: 2, step: 0.1, fmt: (v) => `${v.toFixed(1)}초 이하면 확실`, hint: '같은 영상이면서 길이 차이가 이 안이면 ‘확실’, 아니면 ‘애매’로 나눠요.' },
        { key: 'imageBits', label: '비슷한 사진 기준', min: 0, max: 16, step: 1, fmt: (v) => `${v}비트 이하`, hint: '사진 생김새 지문이 이만큼까지 달라도 비슷한 사진이에요.' },
    ];

    async function openRules({ result = null } = {}) {
        const store = D().store;
        await store.ready();
        if (!result) result = await E().cache.getResult().catch(() => null);
        if (result && (!result.raw || result.ws !== (App.state.workspace?.id || ''))) result = null;
        const current = store.rules();
        const draft = { ...current };
        return kit.panel({
            title: '중복검사 규칙',
            subtitle: '기본값은 장면 5곳 · 10비트 이하 · 3곳 이상 · 확실 0.3초예요. 바꾸면 결과에 바로 반영해요',
            icon: 'sliders',
            width: 640,
            className: 'dup-rules-panel',
            build(ctx) {
                const body = h('div', { class: 'dup-rules' });
                const preview = h('div', { class: 'dup-rules-preview', 'aria-live': 'polite' });
                const inputs = new Map();
                for (const s of SLIDERS) {
                    const val = h('span', { class: 'dup-rule-val' });
                    const range = h('input', { type: 'range', min: String(s.min), max: String(s.max), step: String(s.step), value: String(draft[s.key]), class: 'dup-range', 'aria-label': s.label });
                    const sync = () => (val.textContent = s.fmt(Number(range.value)));
                    range.addEventListener('input', () => {
                        draft[s.key] = Number(range.value);
                        sync();
                        updatePreview();
                    });
                    sync();
                    inputs.set(s.key, { range, sync });
                    body.append(h('div', { class: 'dup-rule' },
                        h('div', { class: 'dup-rule-head' }, h('span', { class: 'dup-rule-label', text: s.label }), val),
                        range,
                        h('div', { class: 'dup-rule-hint', text: s.hint })));
                }
                // folder roles
                const roles = h('div', { class: 'dup-rule-roles' });
                const renderRoles = () => {
                    roles.innerHTML = '';
                    const list = store.data.rules.folderPriority;
                    roles.append(h('div', { class: 'dup-rule-head' }, h('span', { class: 'dup-rule-label', text: '폴더 역할' }), h('span', { class: 'dup-rule-val', text: list.length ? `${formatCount(list.length)}곳` : '없음' })));
                    if (!list.length) roles.append(h('div', { class: 'dup-rule-hint', text: '폴더 메뉴(⋯)나 오른쪽 클릭에서 ‘보관 폴더’·‘정리 폴더’를 정하면 남길 파일을 고를 때 해상도보다 먼저 봐요.' }));
                    for (const r of list) {
                        const seg = kit.seg([{ value: 'keep', label: '보관' }, { value: 'remove', label: '정리' }], r.role, (v) => D().setFolderRole(r.path, v));
                        seg.el.classList.add('sm');
                        roles.append(h('div', { class: 'dup-role-row' },
                            h('span', { html: icon(D().isAbs(r.path) ? 'hard-drive' : 'folder', 14) }),
                            h('span', { class: 'truncate grow', text: D().isAbs(r.path) ? r.path : kit.folderPathLabel(r.path) }),
                            seg.el,
                            btn({ icon: 'x', kind: 'ghost icon sm', tip: '역할 지우기', onClick: () => D().setFolderRole(r.path, null) })));
                    }
                };
                renderRoles();
                const off = App.bus.on('dupes:changed', (e) => {
                    if (e.reason === 'roles') {
                        renderRoles();
                        updatePreview();
                    }
                });
                ctx.onClose(off);

                function counts(rules) {
                    const groups = E().assemble(result.raw, { rules, store, compare: result.scope?.type === 'compare', focus: result.focus });
                    return { all: groups.length, sure: groups.filter((g) => g.sure).length, unsure: groups.filter((g) => !g.sure).length, bytes: groups.reduce((s, g) => s + g.bytes, 0) };
                }
                const base = result ? counts(current) : null;
                function updatePreview() {
                    preview.innerHTML = '';
                    if (!result) {
                        preview.append(h('span', { class: 'faint', text: '검사 결과가 있으면 규칙을 바꿀 때 몇 묶음이 달라지는지 바로 보여 줘요.' }));
                        return;
                    }
                    const n = counts(E().normalizeRules(draft));
                    const delta = (a, b) => {
                        const d = b - a;
                        return h('span', { class: `dup-delta ${d > 0 ? 'up' : d < 0 ? 'down' : ''}`, text: d ? `${d > 0 ? '+' : '−'}${formatCount(Math.abs(d))}` : '그대로' });
                    };
                    preview.append(
                        h('div', { class: 'dup-prev-cell' }, h('span', { class: 'k', text: '묶음' }), h('b', { text: `${formatCount(base.all)} → ${formatCount(n.all)}` }), delta(base.all, n.all)),
                        h('div', { class: 'dup-prev-cell' }, h('span', { class: 'k', text: '확실' }), h('b', { text: `${formatCount(base.sure)} → ${formatCount(n.sure)}` }), delta(base.sure, n.sure)),
                        h('div', { class: 'dup-prev-cell' }, h('span', { class: 'k', text: '애매' }), h('b', { text: `${formatCount(base.unsure)} → ${formatCount(n.unsure)}` }), delta(base.unsure, n.unsure)));
                    const scanned = result.rules || current;
                    const looser = draft.durSec > scanned.durSec || draft.durPct > scanned.durPct || draft.imageBits > (scanned.imageBits || 0) + 4;
                    if (looser) preview.append(h('div', { class: 'dup-prev-note', text: '길이 차이나 사진 기준을 더 느슨하게 하면, 새로 비교할 짝은 ‘다시 찾기’를 해야 반영돼요.' }));
                }
                updatePreview();
                ctx.main.append(h('div', { class: 'dup-rules-wrap' }, preview, body, roles));
                const reset = btn({ label: '기본값으로', kind: 'ghost', icon: 'undo', onClick: () => {
                    Object.assign(draft, E().DEFAULT_RULES);
                    for (const [k, x] of inputs) {
                        x.range.value = String(draft[k]);
                        x.sync();
                    }
                    updatePreview();
                } });
                const save = btn({ label: '저장', kind: 'primary', icon: 'check', onClick: async () => {
                    const patch = E().normalizeRules(draft);
                    const changed = await D().setRules(patch);
                    ctx.close(true);
                    if (changed) ui.toast('중복검사 규칙을 바꿨어요 · 결과에 바로 반영했어요', { type: 'success', action: { label: '실행 취소', run: () => App.undo.undo() } });
                } });
                ctx.foot.append(reset, h('div', { class: 'grow' }), btn({ label: '취소', kind: 'ghost', onClick: () => ctx.close(null) }), save);
                ctx.onEnter(() => save.click());
                save.focus();
            },
        });
    }

    // =================================================================================================
    // Exclusions manager
    // =================================================================================================
    async function openExclusions() {
        const store = D().store;
        await store.ready();
        let tab = store.data.excludedFiles.length ? 'files' : store.data.excludedFolders.length ? 'folders' : store.data.notDuplicates.length ? 'pairs' : 'files';
        let query = '';
        return kit.panel({
            title: '중복검사 제외 목록',
            subtitle: '여기 있는 건 중복검사에서 빼요. 다시 넣으면 다음 검사부터 함께 찾아요',
            icon: 'eye-off',
            width: 720,
            height: 'min(640px, calc(100vh - 48px))',
            className: 'dup-excl-panel',
            undoKeys: true,
            build(ctx) {
                const seg = kit.seg([
                    { value: 'files', label: '파일' },
                    { value: 'folders', label: '폴더' },
                    { value: 'pairs', label: '중복 아님' },
                ], tab, (v) => {
                    tab = v;
                    render();
                });
                const search = h('input', { class: 'input', type: 'search', placeholder: '이름으로 찾기', 'aria-label': '제외 목록에서 찾기' });
                search.addEventListener('input', () => {
                    query = search.value.trim();
                    render();
                });
                let rows = [];
                const list = kit.virtualList({ rowHeight: 52, render: renderRow, className: 'dup-excl-list', label: '제외 목록' });
                const empty = h('div', { class: 'org-empty-state dup-excl-empty' });
                const allBtn = btn({ label: '모두 다시 넣기', kind: 'ghost sm', icon: 'undo', onClick: () => putBack(rows.map((r) => r.value)) });
                ctx.main.append(h('div', { class: 'dup-excl-top' }, seg.el, h('div', { class: 'search-box grow' }, h('span', { html: icon('search', 14) }), search), allBtn), list.el, empty);
                ctx.foot.append(h('div', { class: 'org-foot-info', text: '되돌리기: Ctrl+Z' }), btn({ label: '닫기', kind: 'primary', onClick: () => ctx.close(null) }));

                function label(p) {
                    return D().isAbs(p) ? p : p;
                }
                function render() {
                    const d = store.data;
                    const match = (s) => !query || App.util.matchKo(query, s);
                    if (tab === 'files') rows = d.excludedFiles.filter((p) => match(P.base(p))).map((p) => ({ value: p, title: p.split(/[\\/]/).pop(), sub: D().isAbs(p) ? p : kit.folderPathLabel(P.parent(p)), ico: 'file' }));
                    else if (tab === 'folders') rows = d.excludedFolders.filter((p) => match(p)).map((p) => ({ value: p, title: D().isAbs(p) ? p : P.base(p), sub: D().isAbs(p) ? '다른 드라이브' : kit.folderPathLabel(p), ico: 'folder' }));
                    else rows = d.notDuplicates.filter(([a, b]) => match(P.base(a)) || match(P.base(b))).map((pair) => ({ value: pair, title: `${pair[0].split(/[\\/]/).pop()}  ↔  ${pair[1].split(/[\\/]/).pop()}`, sub: '중복 아님으로 기억한 짝', ico: 'x-circle' }));
                    const btns = seg.el.querySelectorAll('button span');
                    btns[0].textContent = `파일 ${formatCount(d.excludedFiles.length)}`;
                    btns[1].textContent = `폴더 ${formatCount(d.excludedFolders.length)}`;
                    btns[2].textContent = `중복 아님 ${formatCount(d.notDuplicates.length)}`;
                    list.setCount(rows.length);
                    list.el.hidden = !rows.length;
                    allBtn.hidden = rows.length < 2;
                    empty.hidden = !!rows.length;
                    empty.innerHTML = '';
                    empty.append(h('div', { class: 'org-empty-art', html: icon('eye', 26) }), h('h4', { text: query ? '찾는 항목이 없어요' : '빼 둔 항목이 없어요' }),
                        h('p', { text: tab === 'pairs' ? '검토 화면에서 D를 누르면 ‘중복 아님’으로 기억해요.' : '검토 화면에서 X, 갤러리·보기 화면의 메뉴에서 ‘중복검사에서 빼기’를 고를 수 있어요.' }));
                }
                function renderRow(i) {
                    const r = rows[i];
                    const back = btn({ label: '다시 넣기', kind: 'sm', onClick: () => putBack([r.value]) });
                    return h('div', { class: 'dup-excl-row' },
                        h('span', { class: 'dup-excl-ico', html: icon(r.ico, 16) }),
                        h('div', { class: 'dup-excl-text' }, h('div', { class: 'truncate dup-excl-title', text: label(r.title), title: Array.isArray(r.value) ? r.value.join('\n') : r.value }), h('div', { class: 'truncate dup-excl-sub', text: r.sub })),
                        back);
                }
                async function putBack(values) {
                    if (!values.length) return;
                    if (tab === 'files') await D().excludeFiles(values, false);
                    else if (tab === 'folders') await D().excludeFolders(values, false);
                    else await D().markNotDuplicate(values, false);
                    ui.toast(values.length > 1 ? `${formatCount(values.length)}개를 다시 넣었어요` : '다시 넣었어요', { type: 'success', action: { label: '실행 취소', run: () => App.undo.undo() } });
                }
                const off = App.bus.on('dupes:changed', () => render());
                ctx.onClose(off);
                render();
                search.focus();
            },
        });
    }

    // =================================================================================================
    // Entry points
    // =================================================================================================
    function contextItems(entries) {
        if (!App.fs.ready || !entries.length) return [];
        const store = D().store;
        const files = entries.filter((e) => e.kind === 'file' && (e.type === 'image' || e.type === 'video'));
        const dirs = entries.filter((e) => e.kind === 'dir');
        const one = entries.length === 1 ? entries[0] : null;
        const sub = [];
        if (one && one.kind === 'file' && files.length) sub.push({ label: '이 파일과 같은 것 찾기', icon: 'search', command: 'dupes.findSimilar', args: { path: one.path } });
        if (one && one.kind === 'dir') sub.push({ label: '이 폴더에서 중복 찾기', icon: 'layers', action: () => D().open({ scope: { type: 'folder', path: one.path, sub: true }, autostart: true }) });
        if (dirs.length > 1) sub.push({ label: `고른 폴더 ${formatCount(dirs.length)}곳에서 중복 찾기`, icon: 'layers', action: () => D().open({ scope: { type: 'folders', paths: dirs.map((d) => d.path) }, autostart: true }) });
        if (dirs.length === 2) sub.push({ label: '두 폴더 비교하기 (A ↔ B)', icon: 'merge', action: () => D().open({ scope: { type: 'compare', a: [dirs[0].path], b: [dirs[1].path] }, autostart: true }) });
        if (sub.length) sub.push('-');
        if (files.length) {
            const allOut = files.every((e) => store.files.has(e.path));
            sub.push({ label: allOut ? '중복검사에 다시 넣기' : files.length > 1 ? `이 파일 ${formatCount(files.length)}개는 중복검사에서 빼기` : '이 파일은 중복검사에서 빼기', icon: 'eye-off', action: () => toggleFiles(files.map((e) => e.path), !allOut) });
        }
        if (dirs.length) {
            const allOut = dirs.every((e) => store.data.excludedFolders.includes(e.path));
            sub.push({ label: allOut ? '중복검사에 폴더 다시 넣기' : dirs.length > 1 ? `이 폴더 ${formatCount(dirs.length)}곳은 중복검사에서 빼기` : '이 폴더는 중복검사에서 빼기', icon: 'eye-off', action: () => toggleFolders(dirs.map((e) => e.path), !allOut) });
        }
        if (one && one.kind === 'dir') sub.push(...roleItems(one.path));
        if (!sub.length) return [];
        return [{ label: '중복검사', icon: 'layers', submenu: sub }];
    }

    function roleItems(path) {
        const store = D().store;
        const role = store.data.rules.folderPriority.find((x) => x.path === path)?.role || null;
        return [
            '-',
            { label: '보관 폴더로 지정 (중복이면 이쪽을 남김)', icon: 'shield-check', checked: role === 'keep', command: 'dupes.role.keep', args: { path } },
            { label: '정리 폴더로 지정 (중복이면 이쪽을 지움)', icon: 'trash', checked: role === 'remove', command: 'dupes.role.remove', args: { path } },
        ];
    }

    async function toggleFiles(paths, on) {
        await D().excludeFiles(paths, on);
        ui.toast(on ? `${paths.length > 1 ? `파일 ${formatCount(paths.length)}개를` : `‘${P.base(paths[0])}’ 파일을`} 중복검사에서 뺐어요` : '중복검사에 다시 넣었어요', { type: 'success', action: { label: '실행 취소', run: () => App.undo.undo() } });
    }
    async function toggleFolders(paths, on) {
        await D().excludeFolders(paths, on);
        ui.toast(on ? `${paths.length > 1 ? `폴더 ${formatCount(paths.length)}곳을` : `‘${kit.folderLabel(paths[0])}’ 폴더를`} 중복검사에서 뺐어요` : '중복검사에 폴더를 다시 넣었어요', { type: 'success', action: { label: '실행 취소', run: () => App.undo.undo() } });
    }

    function viewerButton(entry) {
        if (!entry || entry.kind !== 'file' || (entry.type !== 'image' && entry.type !== 'video')) return [];
        const b = h('button', { type: 'button', class: 'btn ghost sm dup-vw-btn', dataset: { path: entry.path } });
        syncViewerButton(b);
        b.addEventListener('click', () => App.commands.run('dupes.excludeFile', { path: b.dataset.path }));
        return [b];
    }
    function syncViewerButton(b) {
        const store = D().store;
        const p = b.dataset.path;
        const by = store.excludedBy(p);
        b.classList.toggle('active', !!by);
        b.setAttribute('aria-pressed', String(!!by));
        b.setAttribute('aria-label', by ? '중복검사에 다시 넣기' : '중복검사에서 빼기');
        b.dataset.tip = by ? (by.type === 'folder' ? `‘${kit.folderLabel(by.path)}’ 폴더째 빠져 있어요` : '중복검사에서 빠져 있어요 · 눌러서 다시 넣기') : '이 파일은 중복검사에서 빼기';
        b.innerHTML = `${icon('eye-off', 15)}<span>${by ? '검사 제외됨' : '중복검사 제외'}</span>`;
        b.disabled = !!(by && by.type === 'folder');
    }

    // =================================================================================================
    // Settings page
    // =================================================================================================
    function settingsPage() {
        if (!App.settingsUI || typeof App.settingsUI.addPage !== 'function') return;
        App.settingsUI.addPage({
            id: 'dupes',
            title: '중복검사',
            icon: 'layers',
            order: 45,
            desc: '똑같은 파일과 같은 영상을 찾는 방법과 지문(기록)을 정해요.',
            render(body, k, sctx) {
                const g1 = k.group('지문', '한 번 만든 지문은 이 브라우저에 기억해 둬서, 다음 검사는 새 파일만 보면 돼요.');
                const count = h('span', { class: 'badge', text: '…' });
                E().cache.count().then((n) => (count.textContent = `${formatCount(n)}개`));
                g1.body.append(
                    k.row({ label: '준비된 지문', desc: '이 작업 폴더에서 만들어 둔 지문 수예요.', control: count }),
                    k.row({ label: '작업 폴더를 열면 지문 미리 만들기', desc: '뒤에서 천천히 만들어요. 상태 표시줄에서 멈추거나 그만둘 수 있어요.', control: k.toggle({ key: 'dupes.prebuildOnOpen', fallback: false, label: '작업 폴더를 열면 지문 미리 만들기' }) }),
                    k.row({ label: '지금 미리 만들기', control: k.button('만들기', { icon: 'zap', onClick: () => E().prebuild({ quiet: false }) }) }),
                    k.row({ label: '지문 지우기', desc: '지문이 꼬였을 때만 쓰세요. 다음 검사에서 다시 만들어요.', control: k.button('지우기', { icon: 'trash', kind: 'ghost', onClick: async () => {
                        const ok = await ui.confirm({ title: '중복검사 지문을 지울까요?', message: '파일은 그대로예요. 다음 검사에서 지문을 다시 만들어요.', okLabel: '지우기', danger: true });
                        if (!ok) return;
                        await E().cache.clear();
                        count.textContent = '0개';
                        ui.toast('지문을 지웠어요', { type: 'success' });
                    } }) }));
                const g2 = k.group('찾기와 정리');
                g2.body.append(
                    k.row({ label: '로컬 서버가 켜져 있으면 서버로 찾기', desc: '모든 영상 형식을 읽고, 다른 드라이브 폴더도 비교할 수 있어요.', control: k.toggle({ key: 'dupes.useServer', fallback: true, label: '로컬 서버로 찾기' }) }),
                    k.row({ label: '정리할 때 칩·별점·메모 합치기', desc: '지우는 파일에 붙어 있던 정보를 남기는 파일로 옮겨요.', control: k.toggle({ key: 'dupes.merge', fallback: true, label: '정보 합치기' }) }),
                    k.row({ label: '규칙', desc: '장면 일치 기준, 길이 차이, 확실 기준', control: k.button('규칙 열기', { icon: 'sliders', onClick: () => openRules() }) }),
                    k.row({ label: '제외 목록', desc: '중복검사에서 뺀 파일·폴더와 ‘중복 아님’ 짝', control: k.button('열기', { icon: 'eye-off', onClick: () => openExclusions() }) }));
                body.append(g1.el, g2.el);
            },
        });
    }

    App.register('dupes-tools', {
        init() {
            if (App.gallery && Array.isArray(App.gallery.contextMenuItems)) App.gallery.contextMenuItems.push(contextItems);
            if (App.viewer && Array.isArray(App.viewer.toolbarItems)) App.viewer.toolbarItems.push(viewerButton);
            if (App.viewer && Array.isArray(App.viewer.contextItems)) {
                App.viewer.contextItems.push((entry) => {
                    if (!entry || entry.kind !== 'file' || (entry.type !== 'image' && entry.type !== 'video') || !App.fs.ready) return [];
                    const by = D().store.excludedBy(entry.path);
                    return [{
                        label: '중복검사',
                        icon: 'layers',
                        submenu: [
                            { label: '이 파일과 같은 것 찾기', icon: 'search', action: () => {
                                App.viewer.close?.();
                                D().open({ focus: entry.path, autostart: true });
                            } },
                            { label: by ? '중복검사에 다시 넣기' : '이 파일은 중복검사에서 빼기', icon: 'eye-off', disabled: !!(by && by.type === 'folder'), action: () => App.commands.run('dupes.excludeFile', { path: entry.path }) },
                        ],
                    }];
                });
            }
            // Sidebar folder menu (extension point requested from the orchestrator; feature-detected)
            if (App.sidebar && Array.isArray(App.sidebar.folderMenuItems)) {
                App.sidebar.folderMenuItems.push((path) => {
                    if (!App.fs.ready || path == null) return [];
                    const store = D().store;
                    const out = path ? store.data.excludedFolders.includes(path) : false;
                    return [{
                        label: '중복검사',
                        icon: 'layers',
                        submenu: [
                            { label: '이 폴더에서 중복 찾기', icon: 'layers', action: () => D().open({ scope: { type: 'folder', path, sub: true }, autostart: true }) },
                            path ? { label: out ? '중복검사에 다시 넣기' : '이 폴더는 중복검사에서 빼기', icon: 'eye-off', action: () => toggleFolders([path], !out) } : null,
                            ...roleItems(path),
                        ].filter(Boolean),
                    }];
                });
            }
            settingsPage();
            App.bus.on('dupes:changed', () => {
                for (const b of document.querySelectorAll('.dup-vw-btn')) syncViewerButton(b);
            });
            App.bus.on('workspace:opened', () => {
                D().store.ready().then(() => {
                    for (const b of document.querySelectorAll('.dup-vw-btn')) syncViewerButton(b);
                });
                if (!App.settings.get('dupes.prebuildOnOpen', false)) return;
                const ws = App.state.workspace?.id;
                App.index.whenReady().then(() => setTimeout(() => {
                    if (App.state.workspace?.id === ws && App.settings.get('dupes.prebuildOnOpen', false)) E().prebuild({ quiet: true });
                }, window.__TEST__ ? 50 : 4000));
            });
        },
    });

    App.dupes = App.dupes || {};
    App.dupes.tools = { openRules, openExclusions, contextItems };
})();
