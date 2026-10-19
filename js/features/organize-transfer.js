/*
 * Organize — transfers.
 *   App.organize.pickFolder(opts)          searchable folder picker (recent destinations, inline "새 폴더")
 *   App.organize.resolveConflicts(plan)    one conflict sheet for name clashes in the destination
 *   App.organize.runProgram / commit       transfer engine: many moves/copies = ONE undo entry
 *   commands: organize.moveTo, organize.copyTo, organize.unwrap, organize.byDate, organize.byChip, organize.cleanEmpty
 */
(() => {
    'use strict';
    const { h, path: P, formatCount, formatBytes, formatDate, compareNames } = App.util;
    const ui = App.ui;
    const kit = App.organize.kit;
    const { icon, btn } = kit;

    function cmpPath(a, b) {
        if (a === b) return 0;
        if (a === '') return -1;
        if (b === '') return 1;
        const sa = a.split('/');
        const sb = b.split('/');
        for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
            const c = compareNames(sa[i], sb[i]);
            if (c) return c;
        }
        return sa.length - sb.length;
    }

    function highlight(text, query) {
        const frag = document.createDocumentFragment();
        const words = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
        const lower = text.toLowerCase();
        const w = words.find((x) => lower.includes(x));
        if (!w) {
            frag.append(text);
            return frag;
        }
        const i = lower.indexOf(w);
        frag.append(text.slice(0, i), h('mark', { text: text.slice(i, i + w.length) }), text.slice(i + w.length));
        return frag;
    }

    function badge(text, tone = '') {
        return h('span', { class: `badge org-badge ${tone}`.trim(), text });
    }

    /** '"a.jpg" 파일을' / '"여행" 폴더를' / '12개를' */
    function objPhrase(entries) {
        if (entries.length === 1) {
            const e = entries[0];
            const name = typeof e === 'string' ? P.base(e) : e.name;
            const isDir = typeof e === 'string' ? false : e.kind === 'dir';
            return `"${name}" ${isDir ? '폴더를' : '파일을'}`;
        }
        return `${formatCount(entries.length)}개를`;
    }

    // =====================================================================
    // Folder picker
    // =====================================================================
    /**
     * pickFolder({ title, subtitle, okLabel, icon, mode: 'move'|'copy'|'pick', sources: [paths], initial, created })
     * -> Promise<folder path | null>
     * Folders made with the inline "새 폴더" are pushed into `created` (array) when given, so the caller can fold
     * them into its own single undo entry (see adoptCreated); without it each folder gets its own undo entry.
     */
    function pickFolder(opts = {}) {
        const mode = opts.mode || 'pick';
        const sources = opts.sources || [];
        const collect = Array.isArray(opts.created) ? opts.created : null;
        return kit.panel({
            title: opts.title || '폴더 선택',
            subtitle: opts.subtitle || '',
            icon: opts.icon || 'folder',
            width: 580,
            height: 'min(660px, calc(100vh - 48px))',
            className: 'org-picker',
            build(ctx) {
                let sorted = [];
                let folderSet = new Set();
                let query = '';
                let rows = [];
                let active = -1;
                let ready = false;

                const input = h('input', { class: 'input', type: 'search', placeholder: '폴더 이름이나 경로로 찾기', spellcheck: 'false', autocomplete: 'off', 'aria-label': '폴더 검색' });
                const searchBox = h('div', { class: 'search-box org-picker-search' }, ui.iconEl('search', { size: 15 }), input);
                const list = kit.virtualList({ rowHeight: 34, render: renderRow, className: 'org-picker-list', label: '폴더 목록' });
                const loading = h('div', { class: 'org-state' }, h('span', { class: 'spinner' }), h('span', { text: '폴더 목록을 읽고 있어요…' }));
                const noMatch = h('div', { class: 'org-state', hidden: true }, h('span', { class: 'org-state-ico', html: icon('search', 18) }), h('span', { text: '찾는 폴더가 없어요' }), h('span', { class: 'faint', text: '아래 "새 폴더"로 바로 만들 수 있어요.' }));

                // Inline "new folder" bar
                const nfInput = h('input', { class: 'input', type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': '새 폴더 이름' });
                const nfWhere = h('span', { class: 'org-nf-where truncate' });
                const nfError = h('div', { class: 'org-nf-error' });
                const nfOk = btn({ label: '만들기', kind: 'primary sm', onClick: () => createInline() });
                const nfCancel = btn({ label: '취소', kind: 'ghost sm', onClick: () => endInline() });
                const nfBar = h('div', { class: 'org-nf', hidden: true },
                    h('div', { class: 'org-nf-row' }, h('span', { class: 'org-nf-ico', html: icon('folder-plus', 16) }), nfInput, nfCancel, nfOk),
                    h('div', { class: 'org-nf-meta' }, nfWhere, nfError));
                let nfParent = '';
                let nfRelease = null;

                ctx.main.append(h('div', { class: 'org-picker-top' }, searchBox), nfBar, h('div', { class: 'org-picker-body' }, list.el, loading, noMatch));

                const newBtn = btn({ label: '새 폴더', icon: 'folder-plus', kind: 'ghost', tip: '선택한 폴더 안에 새 폴더 만들기', keys: 'Mod+Shift+N', onClick: () => startInline() });
                const destInfo = h('div', { class: 'org-foot-info truncate' });
                const okBtn = btn({ label: opts.okLabel || '선택', kind: 'primary', onClick: () => confirm() });
                const cancelBtn = btn({ label: '취소', kind: 'ghost', onClick: () => ctx.close(null) });
                ctx.foot.append(newBtn, destInfo, cancelBtn, okBtn);

                function disabledReason(p) {
                    if (sources.some((s) => P.isInside(p, s))) return mode === 'copy' ? '복사할 폴더 안' : '옮길 폴더 안';
                    if (mode === 'move' && sources.length && sources.every((s) => P.parent(s) === p)) return '지금 있는 폴더';
                    return null;
                }
                const selectable = (r) => r && r.type === 'folder' && !r.disabled;

                function rebuild(keepPath) {
                    const prevPath = keepPath !== undefined ? keepPath : rows[active]?.path;
                    rows = [];
                    const q = query.trim().toLowerCase();
                    if (!q) {
                        const rec = kit.recent.get().filter((p) => folderSet.has(p) && !disabledReason(p)).slice(0, 5);
                        if (rec.length) {
                            rows.push({ type: 'header', label: '최근 위치' });
                            for (const p of rec) rows.push({ type: 'folder', path: p, flat: true, recent: true, disabled: disabledReason(p) });
                            rows.push({ type: 'header', label: '모든 폴더' });
                        }
                        for (const p of sorted) rows.push({ type: 'folder', path: p, depth: p ? p.split('/').length : 0, disabled: disabledReason(p) });
                    } else {
                        const words = q.split(/\s+/).filter(Boolean);
                        const scored = [];
                        for (const p of sorted) {
                            const name = kit.folderLabel(p).toLowerCase();
                            const full = (p || name).toLowerCase();
                            if (!words.every((w) => full.includes(w) || name.includes(w))) continue;
                            const score = name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : 3;
                            scored.push([score, p]);
                        }
                        scored.sort((a, b) => a[0] - b[0] || cmpPath(a[1], b[1]));
                        for (const [, p] of scored.slice(0, 3000)) rows.push({ type: 'folder', path: p, flat: true, disabled: disabledReason(p) });
                    }
                    list.setCount(rows.length);
                    noMatch.hidden = !ready || rows.some((r) => r.type === 'folder');
                    let idx = prevPath != null ? rows.findIndex((r) => selectable(r) && r.path === prevPath) : -1;
                    if (idx < 0) idx = rows.findIndex(selectable);
                    setActive(idx, { scroll: true });
                }

                function setActive(i, { scroll = false } = {}) {
                    const prev = active;
                    active = i;
                    if (prev >= 0) list.update(prev);
                    if (i >= 0) {
                        list.update(i);
                        if (scroll) list.scrollToIndex(i);
                    }
                    const r = rows[i];
                    okBtn.disabled = !selectable(r);
                    destInfo.textContent = r && r.type === 'folder' ? `→ ${kit.folderPathLabel(r.path)}` : '';
                    destInfo.title = destInfo.textContent;
                }

                function move(delta) {
                    if (!rows.length) return;
                    const dir = delta > 0 ? 1 : -1;
                    const start = active < 0 ? (dir > 0 ? -1 : rows.length) : active;
                    const target = Math.max(0, Math.min(rows.length - 1, start + delta));
                    let j = target;
                    while (j >= 0 && j < rows.length && !selectable(rows[j])) j += dir;
                    if (j < 0 || j >= rows.length) {
                        j = target;
                        while (j >= 0 && j < rows.length && !selectable(rows[j])) j -= dir;
                    }
                    if (j >= 0 && j < rows.length && selectable(rows[j])) setActive(j, { scroll: true });
                }

                function renderRow(i) {
                    const r = rows[i];
                    if (r.type === 'header') return h('div', { class: 'org-picker-head', text: r.label });
                    const isActive = i === active;
                    const el = h('div', {
                        class: `org-picker-row${isActive ? ' active' : ''}${r.disabled ? ' disabled' : ''}`,
                        role: 'option',
                        'aria-selected': String(isActive),
                        'aria-disabled': r.disabled ? 'true' : null,
                        title: r.path ? kit.folderPathLabel(r.path) : kit.folderLabel(''),
                        style: { paddingLeft: 12 + (r.flat ? 0 : r.depth * 16) + 'px' },
                    },
                        h('span', { class: 'org-picker-ico', html: icon(r.path === '' ? 'home' : r.recent ? 'clock' : 'folder', 15) }),
                        h('span', { class: 'org-picker-name truncate' }, highlight(kit.folderLabel(r.path), query)),
                        r.flat && r.path && P.parent(r.path) ? h('span', { class: 'org-picker-path truncate' }, highlight(kit.folderPathLabel(P.parent(r.path)), query)) : null,
                        r.disabled ? badge(r.disabled) : null);
                    el.addEventListener('mousedown', (e) => {
                        if (r.disabled) return;
                        e.preventDefault();
                        setActive(i);
                    });
                    el.addEventListener('dblclick', () => {
                        if (!r.disabled) confirm();
                    });
                    return el;
                }

                function confirm() {
                    const r = rows[active];
                    if (!selectable(r)) return;
                    ctx.close(r.path);
                }

                // ----- inline new folder -----
                async function startInline() {
                    const r = rows[active];
                    nfParent = r && r.type === 'folder' ? r.path : App.state.cwd || '';
                    nfWhere.textContent = `만들 위치: ${kit.folderPathLabel(nfParent)}`;
                    nfError.textContent = '';
                    nfInput.classList.remove('invalid');
                    nfInput.value = await App.fs.uniqueName(nfParent, '새 폴더', { isDir: true });
                    nfBar.hidden = false;
                    nfInput.focus();
                    nfInput.select();
                    nfRelease?.();
                    nfRelease = kit.keyScope((e) => {
                        if (e.target !== nfInput) return false;
                        if (e.key === 'Escape') {
                            endInline();
                            return true;
                        }
                        if (e.key === 'Enter') {
                            createInline();
                            return true;
                        }
                        return false;
                    });
                }

                function endInline() {
                    nfRelease?.();
                    nfRelease = null;
                    nfBar.hidden = true;
                    input.focus();
                }

                async function createInline() {
                    const name = nfInput.value.trim();
                    const err = App.fs.validateName(name);
                    if (err) {
                        nfError.textContent = err;
                        nfInput.classList.add('invalid');
                        return;
                    }
                    try {
                        const p = await App.fs.mkdir(nfParent, name, { undoable: !collect });
                        if (collect) collect.push(p);
                        if (!folderSet.has(p)) {
                            folderSet.add(p);
                            sorted.push(p);
                            sorted.sort(cmpPath);
                        }
                        query = '';
                        input.value = '';
                        endInline();
                        rebuild(p);
                    } catch (e) {
                        nfError.textContent = e.message;
                        nfInput.classList.add('invalid');
                    }
                }

                input.addEventListener('input', () => {
                    query = input.value;
                    rebuild();
                });

                ctx.onKey((e) => {
                    if (e.target === nfInput) return false;
                    const k = e.key;
                    if (k === 'ArrowDown' || k === 'ArrowUp') {
                        move(k === 'ArrowDown' ? 1 : -1);
                        return true;
                    }
                    if (k === 'PageDown' || k === 'PageUp') {
                        move(k === 'PageDown' ? 10 : -10);
                        return true;
                    }
                    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (k === 'N' || k === 'n')) {
                        startInline();
                        return true;
                    }
                    // Typing anywhere goes to the search box
                    if (e.target !== input && k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && k !== ' ') input.focus();
                    return false;
                });
                ctx.onEnter(() => confirm());
                ctx.onClose(() => {
                    nfRelease?.();
                    list.destroy();
                });

                input.focus();
                kit.allFolders().then((folders) => {
                    folderSet = new Set(folders);
                    sorted = folders.slice().sort(cmpPath);
                    ready = true;
                    loading.hidden = true;
                    const rec = kit.recent.get().find((p) => folderSet.has(p) && !disabledReason(p));
                    const initial = opts.initial ?? rec ?? null;
                    query = input.value;
                    rebuild();
                    if (initial != null && !query) {
                        const i = rows.findIndex((r) => selectable(r) && r.path === initial);
                        if (i >= 0) setActive(i, { scroll: true });
                    }
                });
            },
        });
    }

    // =====================================================================
    // Conflicts
    // =====================================================================
    /** items: [{from, toDir, name?}] -> [{ item, existing, existingKind }] (clashes with what is already there) */
    async function detectConflicts(items) {
        const out = [];
        for (const [dir, list] of kit.groupBy(items, (i) => i.toDir)) {
            const names = await kit.namesIn(dir);
            if (!names.size) continue;
            for (const item of list) {
                const name = item.name || P.base(item.from);
                const hit = names.get(name.toLowerCase());
                if (!hit) continue;
                const existing = P.join(dir, hit.name);
                if (existing === item.from || P.isInside(item.from, existing)) continue;
                out.push({ item, existing, existingKind: hit.kind });
            }
        }
        return out;
    }

    function statEntry(p) {
        return App.fs.stat(p).catch(() => null);
    }

    function sideCard(label, p, other, tone) {
        const rows = h('div', { class: 'org-cside-rows' });
        const nameEl = h('div', { class: 'org-cside-name truncate', text: P.base(p), title: p });
        const card = h('div', { class: `org-cside ${tone || ''}`.trim() },
            h('div', { class: 'org-cside-label', text: label }),
            kit.thumb(statEntry(p), { cls: 'org-cside-thumb' }),
            nameEl,
            rows);
        const row = (k, v, better) => h('div', { class: 'org-cside-row' }, h('span', { class: 'k', text: k }), h('span', { class: 'v truncate', text: v, title: v }), better ? badge(better, 'success') : null);
        Promise.all([statEntry(p), statEntry(other)]).then(async ([a, b]) => {
            if (!a) {
                rows.append(row('상태', '찾을 수 없어요'));
                return;
            }
            const isDir = a.kind === 'dir';
            rows.append(row('종류', isDir ? '폴더' : `${a.type === 'video' ? '영상' : a.type === 'image' ? '사진' : '파일'} · ${(a.ext || '').toUpperCase()}`));
            if (!isDir) {
                rows.append(row('크기', formatBytes(a.size), b && b.kind !== 'dir' && a.size > b.size ? '더 큼' : null));
                rows.append(row('수정한 날짜', formatDate(a.mtime, true), b && b.kind !== 'dir' && a.mtime > b.mtime + 1000 ? '더 최근' : null));
                const resRow = row('해상도', '…');
                rows.append(resRow);
                const [ia, ib] = await Promise.all([kit.mediaInfo(a), b ? kit.mediaInfo(b) : null]);
                const v = resRow.querySelector('.v');
                v.textContent = ia && ia.w ? `${ia.w} × ${ia.h}` : '—';
                if (ia && ib && ia.w * ia.h > ib.w * ib.h) resRow.append(badge('해상도 높음', 'success'));
            }
            rows.append(row('위치', kit.folderPathLabel(P.parent(p))));
        });
        return card;
    }

    const CONFLICT_OPTIONS = [
        { key: 'keep-both', icon: 'copy', title: '둘 다 유지', desc: '옮기는 항목 이름 뒤에 번호를 붙여서 함께 보관해요' },
        { key: 'skip', icon: 'x', title: '건너뛰기', desc: '이 항목은 그대로 두고 넘어가요' },
        { key: 'replace', icon: 'refresh', title: '바꾸기', desc: '원래 있던 항목은 휴지통으로 보내요 · 되돌릴 수 있어요', fileOnly: true },
        { key: 'skip-if-same', icon: 'check-circle', title: '내용이 같으면 건너뛰기', desc: '크기와 내용이 같으면 건너뛰고, 다르면 둘 다 유지해요', fileOnly: true },
    ];

    function conflictAllowed(c, key) {
        const opt = CONFLICT_OPTIONS.find((o) => o.key === key);
        if (!opt || !opt.fileOnly) return true;
        return c.existingKind !== 'dir' && c.fromKind !== 'dir';
    }

    /** Conflict sheet: one dialog walking through the clashes. -> Map(conflict -> action) | null */
    async function conflictSheet(conflicts, { op = 'move' } = {}) {
        for (const c of conflicts) {
            const st = await App.fs.stat(c.item.from).catch(() => null);
            c.fromKind = st ? st.kind : 'file';
        }
        const decisions = new Map();
        return kit.panel({
            title: '같은 이름이 이미 있어요',
            icon: 'alert',
            iconTone: 'warning',
            width: 740,
            className: 'org-conflict',
            build(ctx) {
                let index = 0;
                const applyAll = kit.toggle('', false, null);
                applyAll.el.classList.add('org-applyall');
                const body = h('div', { class: 'org-conflict-body' });
                ctx.main.append(body);
                ctx.foot.append(applyAll.el, h('div', { class: 'grow' }), btn({ label: op === 'copy' ? '복사 취소' : '작업 취소', kind: 'ghost', onClick: () => ctx.close(null) }));

                function render() {
                    const c = conflicts[index];
                    const remaining = conflicts.length - index - 1;
                    ctx.setSubtitle(`${formatCount(conflicts.length)}개 중 ${index + 1}번째 · ${kit.folderPathLabel(c.item.toDir)} 폴더`);
                    applyAll.el.hidden = remaining < 1;
                    applyAll.el.querySelector('.org-toggle-text span').textContent = `남은 ${formatCount(remaining)}개에도 모두 적용`;
                    body.innerHTML = '';
                    body.append(h('div', { class: 'org-conflict-compare' },
                        sideCard(op === 'copy' ? '복사할 항목' : '옮길 항목', c.item.from, c.existing, 'incoming'),
                        h('div', { class: 'org-conflict-vs', html: icon('arrow-right', 18) }),
                        sideCard('이미 있는 항목', c.existing, c.item.from, 'existing')));
                    const opts = h('div', { class: 'org-options', role: 'group', 'aria-label': '처리 방법' });
                    CONFLICT_OPTIONS.forEach((o, i) => {
                        const allowed = conflictAllowed(c, o.key);
                        const b = h('button', { type: 'button', class: `org-option${o.key === 'replace' ? ' warn' : ''}`, disabled: !allowed, dataset: { action: o.key }, onclick: () => choose(o.key) },
                            h('span', { class: 'org-option-ico', html: icon(o.icon, 16) }),
                            h('span', { class: 'org-option-text' }, h('span', { class: 'org-option-title', text: o.title }), h('span', { class: 'org-option-desc', text: allowed ? o.desc : '폴더에는 쓸 수 없어요' })),
                            h('span', { class: 'kbd', text: String(i + 1) }));
                        opts.append(b);
                    });
                    body.append(opts);
                    opts.querySelector('.org-option:not(:disabled)')?.focus();
                }

                function choose(key) {
                    const c = conflicts[index];
                    if (!conflictAllowed(c, key)) return;
                    decisions.set(c, key);
                    if (applyAll.get()) {
                        for (let j = index + 1; j < conflicts.length; j++) decisions.set(conflicts[j], conflictAllowed(conflicts[j], key) ? key : 'keep-both');
                        ctx.close(decisions);
                        return;
                    }
                    index++;
                    if (index >= conflicts.length) ctx.close(decisions);
                    else render();
                }

                ctx.onKey((e) => {
                    if (e.ctrlKey || e.metaKey || e.altKey) return false;
                    if (/^[1-4]$/.test(e.key)) {
                        choose(CONFLICT_OPTIONS[Number(e.key) - 1].key);
                        return true;
                    }
                    if (e.key === 'a' || e.key === 'A') {
                        if (!applyAll.el.hidden) applyAll.set(!applyAll.get());
                        return true;
                    }
                    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                        const btns = [...body.querySelectorAll('.org-option:not(:disabled)')];
                        const i = btns.indexOf(document.activeElement);
                        const step = e.key === 'ArrowDown' ? 2 : e.key === 'ArrowUp' ? -2 : e.key === 'ArrowRight' ? 1 : -1;
                        btns[Math.max(0, Math.min(btns.length - 1, (i < 0 ? 0 : i + step)))]?.focus();
                        return true;
                    }
                    return false;
                });
                render();
            },
        });
    }

    /**
     * App.organize.resolveConflicts(plan)
     *   plan = { op: 'move'|'copy', items: [{ from, toDir, name? }] }
     *   -> { items: [{ ...item, action: 'move'|'keep-both'|'skip'|'replace'|'skip-if-same', existing? }], conflicts: n }
     *      or null when the user cancelled. Shows the sheet only when something clashes.
     */
    async function resolveConflicts(plan) {
        const items = plan.items.map((i) => ({ ...i, action: i.action || 'move' }));
        const ignore = new Set(plan.ignoreExisting || []);
        const conflicts = (await detectConflicts(items)).filter((c) => !ignore.has(c.existing));
        if (!conflicts.length) return { items, conflicts: 0 };
        const decisions = await conflictSheet(conflicts, { op: plan.op });
        if (!decisions) return null;
        for (const c of conflicts) {
            c.item.action = decisions.get(c) || 'keep-both';
            c.item.existing = c.existing;
        }
        return { items, conflicts: conflicts.length };
    }

    // =====================================================================
    // Transfer engine — every batch is ONE undo entry
    // =====================================================================
    // Deletion policy: nothing is ever removed for good here. Replaced files, unwrapped folders and (on undo)
    // copies all go to the app trash; only empty folders this engine created itself are removed on undo.
    /**
     * program = { op: 'move'|'copy', label, items: [{from, toDir, action, existing}],
     *             ensureDirs: [dir], preCreated: [dir] (made earlier for this action, e.g. in the picker),
     *             unwrap: [{dir}] }
     */
    async function ensureDirs(dirs, record) {
        const list = [...new Set(dirs)].filter((d) => d !== '').sort((a, b) => a.split('/').length - b.split('/').length || compareNames(a, b));
        for (const d of list) {
            if (await App.fs.exists(d)) continue;
            const segs = d.split('/');
            for (let i = 1; i <= segs.length; i++) {
                const sub = segs.slice(0, i).join('/');
                if (await App.fs.exists(sub)) continue;
                await App.fs.mkdir(P.parent(sub), segs[i - 1], { undoable: false });
                record.createdDirs.push(sub);
            }
        }
    }

    async function transferChunk(op, paths, dir, record) {
        const live = [];
        for (const p of paths) {
            if (await App.fs.exists(p)) live.push(p);
            else record.failed.push({ path: p, error: '찾을 수 없어요' });
        }
        if (!live.length) return [];
        try {
            return await App.fs[op](live, dir, { undoable: false });
        } catch (e) {
            console.warn('[organize] batch transfer failed, retrying one by one', e);
            const out = [];
            for (const p of live) {
                try {
                    if (await App.fs.exists(p)) out.push(...(await App.fs[op]([p], dir, { undoable: false })));
                    else if (op === 'move' && (await App.fs.exists(P.join(dir, P.base(p))))) {
                        // moved before the failure but never reported: record it and resync listeners
                        const to = P.join(dir, P.base(p));
                        out.push({ from: p, to });
                        App.fs.emitChange({ type: 'move', paths: [to], from: [p], to: [to], dirs: [dir, P.parent(p)] });
                    }
                } catch (err) {
                    record.failed.push({ path: p, error: err.message || String(err) });
                }
            }
            return out;
        }
    }

    function newRecord(op) {
        return { op, moved: [], createdDirs: [], replaced: [], unwrapped: [], renamedBack: [], keptDirs: [], skipped: 0, failed: [], cancelled: false, error: null, undoTrash: null };
    }

    async function runProgram(program, { job } = {}) {
        const record = newRecord(program.op);
        const total = program.items.length;
        let done = 0;
        const tick = (n) => {
            done += n;
            job?.update(done, { total, detail: `${formatCount(done)} / ${formatCount(total)}` });
        };
        try {
            // Folders made for this action before it ran (picker "새 폴더") belong to its undo entry
            for (const d of program.preCreated || []) if (await App.fs.exists(d)) record.createdDirs.push(d);
            if (program.ensureDirs?.length) await ensureDirs(program.ensureDirs, record);
            const work = [];
            for (const it of program.items) {
                if (job?.cancelled) {
                    record.cancelled = true;
                    break;
                }
                let action = it.action || 'move';
                if (action === 'skip-if-same') action = it.existing && (await kit.sameContent(it.from, it.existing)) ? 'skip' : 'keep-both';
                if (action === 'skip') {
                    record.skipped++;
                    tick(1);
                    continue;
                }
                work.push({ ...it, action });
            }
            if (!record.cancelled) {
                const existing = [];
                for (const w of work) if (w.action === 'replace' && w.existing && !existing.includes(w.existing) && (await App.fs.exists(w.existing))) existing.push(w.existing);
                if (existing.length) {
                    const res = await kit.trashPaths(existing);
                    res.ids.forEach((id, i) => record.replaced.push({ id, path: res.paths[i] }));
                    // A file we couldn't move out of the way must not be "kept both" by accident: skip its incoming item
                    const stuck = new Set(res.failed.map((f) => f.path));
                    for (let i = work.length - 1; i >= 0; i--) {
                        if (work[i].action === 'replace' && stuck.has(work[i].existing)) {
                            record.failed.push({ path: work[i].from, error: '원래 있던 항목을 휴지통으로 옮기지 못했어요' });
                            work.splice(i, 1);
                        }
                    }
                }
            }
            outer: for (const [dir, list] of kit.groupBy(work, (w) => w.toDir)) {
                for (const part of kit.chunk(list, 20)) {
                    if (job?.cancelled) {
                        record.cancelled = true;
                        break outer;
                    }
                    record.moved.push(...(await transferChunk(program.op, part.map((w) => w.from), dir, record)));
                    tick(part.length);
                }
            }
            for (const u of program.unwrap || []) {
                if (record.cancelled) break;
                if (!(await App.fs.exists(u.dir))) continue;
                if (await kit.hasVisibleContent(u.dir)) {
                    record.keptDirs.push(u.dir);
                    continue;
                }
                const { ids: [id] } = await kit.trashPaths([u.dir]);
                if (!id) {
                    record.keptDirs.push(u.dir);
                    continue;
                }
                record.unwrapped.push({ id, path: u.dir });
                // Items renamed "x (2)" only because the folder being unwrapped had the same name get their name back
                const folderName = P.base(u.dir).toLowerCase();
                for (const m of record.moved) {
                    if (P.parent(m.to) !== P.parent(u.dir) || P.base(m.from).toLowerCase() !== folderName || P.base(m.to) === P.base(m.from)) continue;
                    try {
                        const back = await App.fs.rename(m.to, P.base(m.from), { undoable: false });
                        record.renamedBack.push({ from: m.to, to: back });
                    } catch (e) {
                        /* keep the numbered name */
                    }
                }
            }
        } catch (e) {
            console.error('[organize] transfer failed', e);
            record.error = e;
        }
        return record;
    }

    async function undoRecord(record, { job } = {}) {
        let done = 0;
        const total = record.moved.length || 1;
        for (const r of [...record.renamedBack].reverse()) {
            try {
                await App.fs.rename(r.to, P.base(r.from), { undoable: false });
            } catch (e) {
                console.warn('[organize] undo rename failed', r, e);
            }
        }
        if (record.unwrapped.length) await kit.restoreIds(record.unwrapped.map((u) => u.id));
        if (record.op === 'copy') {
            // Undoing a copy sends the copies to the app trash (like Finder) — never a permanent delete
            const live = [];
            for (const m of record.moved) if (await App.fs.exists(m.to)) live.push(m);
            const res = await kit.trashPaths(live.map((m) => m.to), { job, onProgress: (n) => job?.update(n, { total: live.length }) });
            const byPath = new Map(live.map((m) => [m.to, m]));
            record.undoTrash = res.ids.map((id, i) => ({ id, from: byPath.get(res.paths[i]).from, to: res.paths[i] }));
        } else {
            for (const [dir, list] of kit.groupBy([...record.moved].reverse(), (m) => P.parent(m.from))) {
                for (const part of kit.chunk(list, 20)) {
                    const live = [];
                    for (const m of part) if (await App.fs.exists(m.to)) live.push(m);
                    if (live.length) {
                        const res = await App.fs.move(live.map((m) => m.to), dir, { undoable: false });
                        for (const r of res) {
                            const orig = live.find((m) => m.to === r.from);
                            if (orig && P.base(r.to) !== P.base(orig.from)) {
                                try {
                                    await App.fs.rename(r.to, P.base(orig.from), { undoable: false });
                                } catch (e) {
                                    /* original name taken meanwhile: keep the numbered one */
                                }
                            }
                        }
                    }
                    done += part.length;
                    job?.update(done, { total });
                }
            }
        }
        if (record.replaced.length) await kit.restoreIds(record.replaced.map((r) => r.id));
        await removeCreatedDirs(record.createdDirs);
    }

    /** Remove folders we created, deepest first, only while they are completely empty (reverting a creation). */
    async function removeCreatedDirs(dirs) {
        const order = [...new Set(dirs)].sort((a, b) => b.split('/').length - a.split('/').length);
        for (const d of order) {
            try {
                const raws = await App.fs.backend.list(d, { stat: false });
                if (!raws.length) await App.fs.removePermanently([d]);
            } catch (e) {
                /* already gone */
            }
        }
    }

    /** Redo of a copy: bring the copies back out of the trash when they are all still there, else copy again. */
    async function redoCopy(record) {
        const pairs = record.undoTrash || [];
        if (!pairs.length) return null;
        const items = await App.fs.listTrash();
        if (!pairs.every((p) => items.some((i) => i.id === p.id))) return null;
        // folders that held the copies were removed on undo when they became empty
        await ensureDirs(record.createdDirs, { createdDirs: [] });
        const next = newRecord('copy');
        next.createdDirs = record.createdDirs.slice();
        if (record.replaced.length) {
            // the files the copy replaced go back to the trash first, so the copies get their names back
            const live = [];
            for (const r of record.replaced) if (await App.fs.exists(r.path)) live.push(r.path);
            const res = await kit.trashPaths(live);
            next.replaced = res.ids.map((id, i) => ({ id, path: res.paths[i] }));
        }
        const map = await kit.restoreIds(pairs.map((p) => p.id));
        next.moved = pairs.map((p) => ({ from: p.from, to: map.get(p.to) || p.to }));
        return next;
    }

    /**
     * Folders made in a picker for an action that then didn't run (cancelled, nothing to do): give them their own
     * undo entry so every visible change stays undoable.
     */
    function adoptCreated(created) {
        const dirs = [...new Set(created || [])];
        if (!dirs.length) return;
        App.undo.push({
            label: dirs.length === 1 ? `새 폴더 "${P.base(dirs[0])}"` : `새 폴더 ${dirs.length}개`,
            undo: () => removeCreatedDirs(dirs),
            redo: () => ensureDirs(dirs, { createdDirs: [] }),
        });
    }

    async function withJob(title, total, fn) {
        const job = App.jobs.start({ title, total, cancellable: false });
        try {
            return await fn(job);
        } finally {
            job.finish();
        }
    }

    function hasEffect(r, program) {
        const pre = new Set(program.preCreated || []);
        return r.moved.length || r.replaced.length || r.unwrapped.length || r.renamedBack.length || r.createdDirs.some((d) => !pre.has(d));
    }

    /** Run a program as one cancellable job and push ONE undo entry. Returns the record. */
    async function commitProgram(program, { jobTitle } = {}) {
        const job = App.jobs.start({ title: jobTitle || program.label, total: program.items.length, cancellable: true });
        let record;
        try {
            record = await runProgram(program, { job });
        } finally {
            job.finish();
        }
        if (hasEffect(record, program)) {
            let current = record;
            App.undo.push({
                label: program.label,
                undo: () => withJob('되돌리는 중', current.moved.length, (j) => undoRecord(current, { job: j })),
                redo: async () => {
                    const restored = current.op === 'copy' ? await redoCopy(current) : null;
                    current = restored || (await withJob(jobTitle || program.label, program.items.length, (j) => runProgram(program, { job: j })));
                },
            });
        } else {
            adoptCreated(program.preCreated);
        }
        if (record.error) ui.toast(`일부 작업을 마치지 못했어요: ${record.error.message || record.error}`, { type: 'error' });
        else if (record.failed.length) ui.toast(`${formatCount(record.failed.length)}개는 처리하지 못했어요 (${record.failed[0].error})`, { type: 'warning', duration: 6000 });
        return record;
    }

    // =====================================================================
    // Move / copy to…
    // =====================================================================
    async function transferTo(op, args = {}) {
        if (!App.fs.ready) return null;
        const entries = await kit.targetEntries(args);
        if (!entries.length) {
            ui.toast(op === 'copy' ? '복사할 항목을 먼저 선택하세요' : '옮길 항목을 먼저 선택하세요', { type: 'warning' });
            return null;
        }
        const paths = entries.map((e) => e.path);
        const created = []; // folders made in the picker become part of this action's undo entry
        const dest = args.dest != null
            ? args.dest
            : await pickFolder({
                mode: op,
                sources: paths,
                created,
                title: op === 'copy' ? '어디에 복사할까요?' : '어디로 옮길까요?',
                subtitle: kit.describeItems(entries),
                okLabel: op === 'copy' ? '여기에 복사' : '여기로 이동',
                icon: op === 'copy' ? 'copy' : 'folder-input',
            });
        if (dest == null) {
            adoptCreated(created);
            return null;
        }
        kit.recent.add(dest);
        const items = paths.filter((p) => !P.isInside(dest, p) && (op === 'copy' || P.parent(p) !== dest)).map((p) => ({ from: p, toDir: dest }));
        if (!items.length) {
            adoptCreated(created);
            ui.toast(op === 'copy' ? '그 폴더에는 복사할 수 없어요' : '이미 그 폴더에 있어요', { type: 'info' });
            return null;
        }
        const decided = await resolveConflicts({ op, items });
        if (!decided) {
            adoptCreated(created);
            return null;
        }
        const label = `${kit.folderLabel(dest)} 폴더로 ${op === 'copy' ? '복사' : '이동'} (${formatCount(items.length)}개)`;
        const record = await commitProgram({ op, label, items: decided.items, preCreated: created, ensureDirs: [...created, dest] }, { jobTitle: op === 'copy' ? '복사하는 중' : '이동하는 중' });
        const results = record.moved;
        if (results.length) {
            const byPath = new Map(entries.map((e) => [e.path, e]));
            ui.toast(`${kit.folderLabel(dest)} 폴더로 ${objPhrase(results.map((r) => byPath.get(r.from) || r.from))} ${op === 'copy' ? '복사했어요' : '옮겼어요'}`, {
                type: 'success',
                action: { label: '실행 취소', run: () => App.undo.undo() },
            });
        } else if (decided.conflicts) {
            ui.toast('모두 건너뛰었어요', { type: 'info' });
        }
        return results;
    }

    // =====================================================================
    // Unwrap (폴더 풀기)
    // =====================================================================
    /** Children to lift out of a folder (non-recursive or flattened), skipping v1 sidecars that travel with their file. */
    async function liftItems(dir, flatten) {
        const out = [];
        const stats = { images: 0, videos: 0, others: 0, dirs: 0, hidden: 0 };
        async function walk(d) {
            let res;
            try {
                res = await kit.listRaw(d);
            } catch (e) {
                return;
            }
            stats.hidden += res.hidden.length;
            const files = new Set(res.visible.filter((r) => r.kind === 'file').map((r) => r.name));
            for (const r of res.visible) {
                const p = P.join(d, r.name);
                if (r.kind === 'dir') {
                    if (flatten) await walk(p);
                    else {
                        stats.dirs++;
                        out.push({ path: p, kind: 'dir', name: r.name });
                    }
                    continue;
                }
                if (r.name.toLowerCase().endsWith('.txt') && files.has(r.name.slice(0, -4))) continue; // moves with its media file
                const t = App.util.mediaType(r.name);
                if (t === 'image') stats.images++;
                else if (t === 'video') stats.videos++;
                else stats.others++;
                out.push({ path: p, kind: 'file', name: r.name });
            }
        }
        await walk(dir);
        return { items: out, stats };
    }

    function statsText(s) {
        const parts = [];
        if (s.images) parts.push(`사진 ${formatCount(s.images)}`);
        if (s.videos) parts.push(`영상 ${formatCount(s.videos)}`);
        if (s.others) parts.push(`기타 ${formatCount(s.others)}`);
        if (s.dirs) parts.push(`폴더 ${formatCount(s.dirs)}`);
        return parts.join(' · ') || '비어 있음';
    }

    async function unwrap(args = {}) {
        if (!App.fs.ready) return null;
        let dirs = (await kit.targetEntries(args)).filter((e) => e.kind === 'dir').map((e) => e.path);
        if (!dirs.length && !args.paths && App.view.source.type === 'folder' && App.state.cwd) dirs = [App.state.cwd];
        dirs = dirs.filter((d) => d !== '' && !dirs.some((o) => o !== d && P.isInside(d, o)));
        if (!dirs.length) {
            ui.toast('풀 폴더를 먼저 선택하세요', { type: 'warning' });
            return null;
        }
        let flatten = args.flatten ?? App.settings.get('organize.unwrap.flatten', false);
        if (!args.yes) {
            const ok = await kit.panel({
                title: dirs.length === 1 ? `"${P.base(dirs[0])}" 폴더 풀기` : `폴더 ${dirs.length}개 풀기`,
                subtitle: '안에 있는 항목을 한 단계 위로 꺼내고, 빈 폴더는 휴지통으로 보내요',
                icon: 'folder-output',
                width: 600,
                className: 'org-unwrap',
                build(ctx) {
                    const listEl = h('div', { class: 'org-unwrap-list' });
                    const note = h('div', { class: 'org-note' });
                    const flatT = kit.toggle('하위 폴더까지 모두 평탄화', flatten, (v) => {
                        flatten = v;
                        refresh();
                    }, { hint: '안쪽 폴더에 있는 파일까지 전부 꺼내고, 남은 빈 폴더도 함께 정리해요' });
                    ctx.main.append(listEl, flatT.el, note);
                    const okBtn = btn({ label: '폴더 풀기', kind: 'primary', icon: 'folder-output', onClick: () => ctx.close(true) });
                    ctx.foot.append(h('div', { class: 'org-foot-info', text: '나중에 Ctrl+Z로 한 번에 되돌릴 수 있어요' }), btn({ label: '취소', kind: 'ghost', onClick: () => ctx.close(false) }), okBtn);
                    ctx.onEnter(() => okBtn.click());
                    let token = 0;
                    async function refresh() {
                        const my = ++token;
                        listEl.innerHTML = '';
                        note.textContent = '';
                        let total = 0;
                        let hidden = 0;
                        for (const d of dirs) {
                            const row = h('div', { class: 'org-unwrap-row' },
                                h('span', { class: 'org-unwrap-ico', html: icon('folder', 18) }),
                                h('div', { class: 'grow' }, h('div', { class: 'org-unwrap-name truncate', text: P.base(d) }), h('div', { class: 'org-unwrap-path truncate', text: `${kit.folderPathLabel(P.parent(d))} 폴더로 꺼내요` })),
                                h('span', { class: 'org-unwrap-stats', text: '세는 중…' }));
                            listEl.append(row);
                            liftItems(d, flatten).then(({ items, stats }) => {
                                if (my !== token) return;
                                row.querySelector('.org-unwrap-stats').textContent = statsText(stats);
                                total += items.length;
                                hidden += stats.hidden;
                                note.textContent = `항목 ${formatCount(total)}개를 꺼내요. 같은 이름이 있으면 어떻게 할지 물어볼게요.${hidden ? ` 숨김 시스템 파일 ${formatCount(hidden)}개는 폴더와 함께 휴지통으로 가요.` : ''}`;
                            });
                        }
                    }
                    refresh();
                    okBtn.focus();
                },
            });
            if (!ok) return null;
            App.settings.set('organize.unwrap.flatten', flatten);
        }
        const items = [];
        for (const d of dirs) {
            const { items: lifted } = await liftItems(d, flatten);
            for (const it of lifted) items.push({ from: it.path, toDir: P.parent(d) });
        }
        // Clashes with the folders being unwrapped are fine (they go away); only real neighbours count.
        const decided = await resolveConflicts({ op: 'move', items, ignoreExisting: dirs });
        if (!decided) return null;
        const label = dirs.length === 1 ? `폴더 풀기 "${P.base(dirs[0])}"` : `폴더 ${dirs.length}개 풀기`;
        const record = await commitProgram({ op: 'move', label, items: decided.items, unwrap: dirs.map((d) => ({ dir: d })) }, { jobTitle: '폴더 푸는 중' });
        const kept = record.keptDirs.length;
        if (record.unwrapped.length || record.moved.length) {
            ui.toast(`${record.unwrapped.length ? `폴더 ${record.unwrapped.length}개를 풀었어요` : `${formatCount(record.moved.length)}개를 꺼냈어요`}${kept ? ` · 남은 항목이 있는 폴더 ${kept}개는 그대로 뒀어요` : ''}`, {
                type: 'success',
                action: { label: '실행 취소', run: () => App.undo.undo() },
            });
        } else if (kept) {
            ui.toast('남은 항목이 있어서 폴더를 그대로 뒀어요', { type: 'info' });
        }
        return record;
    }

    // =====================================================================
    // Plan preview (shared by "by date" and "by chip")
    // =====================================================================
    function planPreview({ emptyTitle, emptyText }) {
        let groups = [];
        let rows = [];
        const expanded = new Set();
        const list = kit.virtualList({ rowHeight: 38, render, className: 'org-plan-list', label: '정리 미리보기' });
        const stateEl = h('div', { class: 'org-state', hidden: true });
        const el = h('div', { class: 'org-plan-preview' }, list.el, stateEl);

        function crumbs(rel) {
            const frag = document.createDocumentFragment();
            rel.split('/').forEach((s, i) => {
                if (i) frag.append(h('span', { class: 'org-plan-sep', html: icon('chevron-right', 12) }));
                frag.append(h('span', { text: s }));
            });
            return frag;
        }

        function rebuild() {
            rows = [];
            for (const g of groups) {
                rows.push({ type: 'dir', g });
                if (expanded.has(g.dir)) for (const e of g.entries) rows.push({ type: 'file', e, g });
            }
            list.setCount(rows.length);
        }

        function render(i) {
            const r = rows[i];
            if (r.type === 'dir') {
                const open = expanded.has(r.g.dir);
                const el2 = h('div', { class: `org-plan-dir${open ? ' open' : ''}`, role: 'option', 'aria-expanded': String(open) },
                    h('span', { class: 'org-plan-twisty', html: icon('chevron-right', 13) }),
                    h('span', { class: 'org-plan-ico', html: icon(open ? 'folder-open' : 'folder', 16) }),
                    h('span', { class: 'org-plan-label truncate' }, r.g.prefix ? h('span', { class: 'org-plan-base', text: r.g.prefix }) : null, crumbs(r.g.rel)),
                    r.g.isNew ? badge('새 폴더', 'accent') : null,
                    r.g.conflicts ? badge(`이름 겹침 ${formatCount(r.g.conflicts)}`, 'warning') : null,
                    h('span', { class: 'org-plan-count', text: `${formatCount(r.g.entries.length)}개` }));
                el2.addEventListener('click', () => {
                    if (expanded.has(r.g.dir)) expanded.delete(r.g.dir);
                    else expanded.add(r.g.dir);
                    rebuild();
                });
                return el2;
            }
            return h('div', { class: 'org-plan-file' },
                kit.thumb(r.e, { cls: 'sm' }),
                h('span', { class: 'org-plan-fname truncate', text: r.e.name, title: r.e.path }),
                h('span', { class: 'org-plan-from truncate', text: `${kit.folderPathLabel(P.parent(r.e.path))}에서` }),
                r.g.labels?.get(r.e.path) ? h('span', { class: 'org-plan-meta truncate', text: r.g.labels.get(r.e.path) }) : null);
        }

        return {
            el,
            list,
            set(next) {
                groups = next;
                stateEl.hidden = true;
                list.el.hidden = false;
                if (!groups.length) {
                    list.el.hidden = true;
                    stateEl.hidden = false;
                    stateEl.innerHTML = '';
                    stateEl.append(h('span', { class: 'org-state-ico', html: icon('check-circle', 20) }), h('strong', { text: emptyTitle }), h('span', { class: 'faint', text: emptyText }));
                }
                rebuild();
            },
            loading(text) {
                list.el.hidden = true;
                stateEl.hidden = false;
                stateEl.innerHTML = '';
                stateEl.append(h('span', { class: 'spinner' }), h('span', { text }));
            },
            update() {
                list.refresh();
            },
        };
    }

    async function annotateGroups(groups, folderSet) {
        const items = [];
        for (const g of groups) {
            g.isNew = !folderSet.has(g.dir);
            if (!g.isNew) for (const e of g.entries) items.push({ from: e.path, toDir: g.dir, g });
        }
        const conflicts = await detectConflicts(items);
        for (const g of groups) g.conflicts = 0;
        for (const c of conflicts) c.item.g.conflicts++;
        return conflicts.length;
    }

    /** Files an organize-into-folders command works on, plus a scope description. */
    function scopeFiles(selection, includeSub) {
        const selFiles = selection.filter((e) => e.kind === 'file');
        if (selFiles.length) return { files: selFiles, label: `선택한 파일 ${formatCount(selFiles.length)}개`, selection: true };
        const selDirs = selection.filter((e) => e.kind === 'dir');
        if (selDirs.length && App.index?.ready) {
            const seen = new Set();
            const files = [];
            for (const d of selDirs) {
                for (const e of App.index.under(d.path, { recursive: true })) {
                    if (seen.has(e.path)) continue;
                    seen.add(e.path);
                    files.push(e);
                }
            }
            return { files, label: `선택한 폴더 ${formatCount(selDirs.length)}개 안의 파일 ${formatCount(files.length)}개`, selection: true };
        }
        const cwd = App.state.cwd ?? '';
        let files;
        if (includeSub && App.index?.ready && App.view.source.type === 'folder') {
            files = App.index.under(cwd, { recursive: true });
            for (const f of App.view.filters.values()) files = files.filter((e) => f.test(e));
        } else {
            files = App.view.visible.filter((e) => e.kind === 'file');
        }
        const where = App.view.source.type === 'folder' ? `${kit.folderLabel(cwd)} 폴더` : '검색 결과';
        return { files, label: `${where}의 파일 ${formatCount(files.length)}개${includeSub ? ' (하위 폴더 포함)' : ''}`, selection: false };
    }

    /** Shared shell for "by date" / "by chip": options on top, live preview, one commit. */
    function planDialog({ title, icon: iconName, okLabel, buildOptions, computePlan, emptyTitle, emptyText, label, args = {}, selection: given }) {
        const created = []; // folders made in the base-folder picker join this action's undo entry
        return kit.panel({
            title,
            icon: iconName,
            width: 800,
            height: 'min(720px, calc(100vh - 48px))',
            className: 'org-plan',
            build(ctx) {
                const cwd = App.state.cwd ?? '';
                const state = { base: args.base ?? cwd, includeSub: false };
                const selection = given || App.select.entries();
                const hasSubDirs = !selection.length && App.view.source.type === 'folder' && App.view.entries.some((e) => e.kind === 'dir');
                const options = h('div', { class: 'org-plan-options' });
                const summary = h('div', { class: 'org-plan-summary' });
                const preview = planPreview({ emptyTitle, emptyText });
                ctx.main.append(options, summary, preview.el);
                const okBtn = btn({ label: okLabel, kind: 'primary', icon: iconName, onClick: () => commit() });
                okBtn.disabled = true;
                const footInfo = h('div', { class: 'org-foot-info' });
                ctx.foot.append(footInfo, btn({ label: '취소', kind: 'ghost', onClick: () => ctx.close(null) }), okBtn);

                const baseBtn = h('button', { type: 'button', class: 'btn org-base-btn', 'data-tip': '다른 폴더 고르기' });
                const renderBase = () => {
                    baseBtn.innerHTML = '';
                    baseBtn.insertAdjacentHTML('beforeend', icon(state.base === '' ? 'home' : 'folder', 15));
                    baseBtn.append(h('span', { class: 'truncate', text: kit.folderPathLabel(state.base) }), h('span', { class: 'faint', html: icon('chevron-down', 13) }));
                };
                renderBase();
                baseBtn.addEventListener('click', async () => {
                    const picked = await pickFolder({ title: '어디에 정리할까요?', subtitle: '이 폴더 안에 새 폴더를 만들어서 옮겨요', okLabel: '이 폴더 선택', icon: 'folder', initial: state.base, created });
                    if (picked != null) {
                        state.base = picked;
                        renderBase();
                        recompute();
                    }
                    baseBtn.focus();
                });

                let scope = scopeFiles(selection, false);
                ctx.setSubtitle(scope.label);
                const optApi = buildOptions({ el: options, state, recompute: () => recompute(), baseBtn });
                if (hasSubDirs) {
                    const t = kit.toggle('하위 폴더의 파일도 포함', false, (v) => {
                        state.includeSub = v;
                        scope = scopeFiles(selection, v);
                        ctx.setSubtitle(scope.label);
                        recompute();
                    }, { tip: App.index?.ready ? '' : '라이브러리 색인이 끝나면 쓸 수 있어요' });
                    if (!App.index?.ready) t.input.disabled = true;
                    options.append(h('div', { class: 'org-plan-optrow' }, t.el));
                }

                let plan = null;
                let token = 0;
                async function recompute() {
                    const my = ++token;
                    okBtn.disabled = true;
                    preview.loading('미리보기를 만드는 중…');
                    let res;
                    try {
                        res = await computePlan({ files: scope.files, state, opts: optApi, progress: (t) => my === token && preview.loading(t) });
                    } catch (e) {
                        console.error(e);
                        if (my === token) preview.loading(`미리보기를 만들 수 없어요: ${e.message}`);
                        return;
                    }
                    if (my !== token) return;
                    const folderSet = new Set(await kit.allFolders());
                    const nConflicts = await annotateGroups(res.groups, folderSet);
                    if (my !== token) return;
                    plan = res;
                    preview.set(res.groups);
                    const moving = res.groups.reduce((s, g) => s + g.entries.length, 0);
                    const newDirs = res.groups.filter((g) => g.isNew).length;
                    summary.innerHTML = '';
                    summary.append(...[
                        h('span', { class: 'org-sum-main', text: moving ? `${formatCount(moving)}개 파일을 폴더 ${formatCount(res.groups.length)}개로 정리해요` : '옮길 파일이 없어요' }),
                        newDirs ? badge(`새 폴더 ${formatCount(newDirs)}`, 'accent') : null,
                        nConflicts ? badge(`이름 겹침 ${formatCount(nConflicts)}`, 'warning') : null,
                        ...(res.notes || []).filter((n) => n.count).map((n) => badge(`${n.label} ${formatCount(n.count)}`)),
                    ].filter(Boolean));
                    footInfo.textContent = nConflicts ? '이름이 겹치는 파일은 정리할 때 어떻게 할지 물어볼게요' : '한 번에 되돌릴 수 있어요 (Ctrl+Z)';
                    okBtn.disabled = !moving;
                    kit.setBtnLabel(okBtn, moving ? `${okLabel} (${formatCount(moving)}개)` : okLabel);
                }

                async function commit() {
                    if (!plan || okBtn.disabled) return;
                    ctx.close({ plan, state });
                }

                ctx.onEnter(() => commit());
                ctx.onClose(() => preview.list.destroy());
                recompute();
                // Focus the preview so Enter commits right away (focusing an option would make Enter toggle it)
                setTimeout(() => preview.list.el.isConnected && preview.list.el.focus({ preventScroll: true }), 0);
            },
        }).then(async (res) => {
            if (!res) {
                adoptCreated(created);
                return null;
            }
            const items = [];
            for (const g of res.plan.groups) for (const e of g.entries) items.push({ from: e.path, toDir: g.dir });
            const decided = await resolveConflicts({ op: 'move', items });
            if (!decided) {
                adoptCreated(created);
                return null;
            }
            const program = { op: 'move', label: label(items.length, res), items: decided.items, preCreated: created, ensureDirs: [...created, ...res.plan.groups.map((g) => g.dir)] };
            const record = await commitProgram(program, { jobTitle: `${title} 중` });
            return { record, plan: res.plan, state: res.state };
        });
    }

    // =====================================================================
    // Organize by date
    // =====================================================================
    const DATE_PATTERNS = [
        { value: 'YYYY', label: '2024' },
        { value: 'YYYY-MM', label: '2024-03' },
        { value: 'YYYY/MM', label: '2024/03' },
        { value: 'YYYY-MM-DD', label: '2024-03-15' },
    ];

    async function byDate(args = {}) {
        if (!App.fs.ready) return null;
        const saved = App.settings.get('organize.byDate', {});
        const dateCache = new Map();
        const res = await planDialog({
            title: '날짜별로 정리',
            icon: 'calendar',
            okLabel: '정리하기',
            emptyTitle: '이미 날짜별로 정리돼 있어요',
            emptyText: '옮길 파일이 없어요. 폴더 형식이나 위치를 바꿔 보세요.',
            args,
            selection: await kit.targetEntries(args),
            label: (n) => `날짜별 정리 (${formatCount(n)}개)`,
            buildOptions({ el, state, recompute, baseBtn }) {
                state.pattern = args.pattern || saved.pattern || 'YYYY-MM';
                state.source = args.source || saved.source || 'taken';
                const pat = kit.seg(DATE_PATTERNS, state.pattern, (v) => {
                    state.pattern = v;
                    recompute();
                });
                const src = kit.seg([
                    { value: 'taken', label: '찍은 날짜 우선', tip: '사진의 촬영 날짜(EXIF)를 쓰고, 없으면 수정한 날짜를 써요' },
                    { value: 'mtime', label: '수정한 날짜' },
                ], state.source, (v) => {
                    state.source = v;
                    recompute();
                });
                el.append(h('div', { class: 'org-plan-grid' }, kit.field('폴더 이름', pat.el), kit.field('날짜 기준', src.el), kit.field('정리할 위치', baseBtn)));
                return {};
            },
            async computePlan({ files, state, progress }) {
                App.settings.set('organize.byDate', { pattern: state.pattern, source: state.source });
                if (state.source === 'taken') {
                    const need = files.filter((e) => !dateCache.has(e.path));
                    let done = 0;
                    await App.util.pool(need, 6, async (e) => {
                        const t = await kit.takenDate(e);
                        dateCache.set(e.path, t);
                        if (++done % 25 === 0) progress(`찍은 날짜를 읽는 중… ${formatCount(done)} / ${formatCount(need.length)}`);
                    });
                }
                const groups = new Map();
                let already = 0;
                let nodate = 0;
                let fromMtime = 0;
                for (const e of files) {
                    let d = state.source === 'taken' ? dateCache.get(e.path) : null;
                    if (!d) {
                        d = e.mtime || null;
                        if (d && state.source === 'taken') fromMtime++;
                    }
                    if (!d) {
                        nodate++;
                        continue;
                    }
                    const rel = kit.fmtDate(d, state.pattern);
                    const dir = P.join(state.base, rel);
                    if (P.parent(e.path) === dir) {
                        already++;
                        continue;
                    }
                    if (!groups.has(dir)) groups.set(dir, { dir, rel, prefix: state.base ? `${kit.folderLabel(state.base)} › ` : '', entries: [], labels: new Map() });
                    const g = groups.get(dir);
                    g.entries.push(e);
                    g.labels.set(e.path, kit.fmtDate(d, 'YYYY. M. D.'));
                }
                const list = [...groups.values()].sort((a, b) => cmpPath(a.rel, b.rel));
                return {
                    groups: list,
                    notes: [
                        { label: '이미 정리됨', count: already },
                        { label: '날짜 모름', count: nodate },
                        { label: '수정한 날짜 사용', count: state.source === 'taken' ? fromMtime : 0 },
                    ],
                };
            },
        });
        if (res && res.record && res.record.moved.length) {
            ui.toast(`${formatCount(res.record.moved.length)}개를 날짜별 폴더 ${formatCount(res.plan.groups.length)}개로 정리했어요`, { type: 'success', action: { label: '실행 취소', run: () => App.undo.undo() } });
        }
        return res;
    }

    // =====================================================================
    // Organize by chip
    // =====================================================================
    function safeName(name) {
        let n = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().replace(/[. ]+$/, '');
        if (n.startsWith('.')) n = '_' + n.slice(1);
        if (!n) n = '이름 없음';
        if (App.fs.validateName(n)) n = n + '_';
        return n.slice(0, 120);
    }

    const normTok = (s) => String(s || '').trim().replace(/[\s_]+/g, ' ').toLowerCase();

    /** The chips of `cat` on a file, in panel order: [{chip, subs: [sub]}] */
    function chipsOf(path, cat, model) {
        const entry = App.catalog.get(path);
        const tops = new Map();
        const subs = [];
        for (const id of entry.chips || []) {
            const c = model.byId.get(id);
            if (!c || c.cat !== cat) continue;
            if (c.parent) subs.push(c);
            else tops.set(c.id, c);
        }
        for (const s of subs) if (!tops.has(s.parent.id)) tops.set(s.parent.id, s.parent);
        if (!tops.size) {
            // v1 tags imported from sidecars: "분류/칩" or "분류/칩/하위"
            const legacy = App.catalog.peek(path)?.legacyTags || [];
            for (const tag of legacy) {
                const parts = String(tag).split('/');
                if (parts.length < 2 || normTok(parts[0]) !== normTok(cat.name)) continue;
                const chip = cat.chips.find((c) => normTok(c.name) === normTok(parts[1]));
                if (!chip) continue;
                tops.set(chip.id, chip);
                if (parts[2]) {
                    const sub = chip.children.find((s) => normTok(s.name) === normTok(parts[2]));
                    if (sub) subs.push(sub);
                }
            }
        }
        return [...tops.values()].sort((a, b) => a.order - b.order).map((chip) => ({ chip, subs: subs.filter((s) => s.parent === chip).sort((a, b) => a.order - b.order) }));
    }

    async function byChip(args = {}) {
        if (!App.fs.ready) return null;
        const model = await kit.chipModel();
        const cats = model.categories.filter((c) => c.chips.length);
        if (!cats.length) {
            await ui.alert({ title: '칩 분류가 아직 없어요', message: '칩셋 패널에서 분류(예: 배우)와 칩을 먼저 만들고 파일에 붙여 주세요. 그다음 칩별로 폴더를 나눌 수 있어요.' });
            return null;
        }
        const saved = App.settings.get('organize.byChip', {});
        const res = await planDialog({
            title: '칩별로 정리',
            icon: 'tag',
            okLabel: '정리하기',
            emptyTitle: '옮길 파일이 없어요',
            emptyText: '이 분류의 칩이 붙은 파일이 없거나 이미 칩 폴더에 들어 있어요.',
            args,
            selection: await kit.targetEntries(args),
            label: (n, r) => `칩별 정리 · ${r.state.catName} (${formatCount(n)}개)`,
            buildOptions({ el, state, recompute, baseBtn }) {
                const initialCat = cats.find((c) => c.id === (args.category ?? saved.category)) || cats.find((c) => c.name === (args.category ?? saved.category)) || cats[0];
                state.cat = initialCat;
                state.catName = initialCat.name;
                state.subfolders = args.subfolders ?? saved.subfolders ?? true;
                state.multi = args.multi || saved.multi || 'first';
                state.multiName = args.multiName || saved.multiName || '여러 명';
                const catSel = kit.select(cats.map((c) => ({ value: c.id, label: `${c.name} · 칩 ${c.chips.length}개` })), initialCat.id, (v) => {
                    state.cat = cats.find((c) => String(c.id) === String(v)) || cats[0];
                    state.catName = state.cat.name;
                    subT.el.hidden = !state.cat.chips.some((c) => c.children.length);
                    recompute();
                });
                const subT = kit.toggle('하위 칩 폴더도 만들기', state.subfolders, (v) => {
                    state.subfolders = v;
                    recompute();
                }, { hint: '배우/작품처럼 한 단계 더 나눠요' });
                subT.el.hidden = !state.cat.chips.some((c) => c.children.length);
                const multiName = h('input', { class: 'input org-multi-name', type: 'text', value: state.multiName, spellcheck: 'false', 'aria-label': '여러 칩 폴더 이름' });
                multiName.disabled = state.multi !== 'multi';
                multiName.addEventListener('input', App.util.debounce(() => {
                    state.multiName = multiName.value.trim() || '여러 명';
                    recompute();
                }, 250));
                const multi = kit.seg([
                    { value: 'first', label: '첫 번째 칩 폴더로', tip: '칩셋 패널에서 먼저 나오는 칩의 폴더로 옮겨요' },
                    { value: 'multi', label: '따로 모으기', tip: '칩이 여러 개인 파일은 한 폴더에 모아요' },
                ], state.multi, (v) => {
                    state.multi = v;
                    multiName.disabled = v !== 'multi';
                    recompute();
                });
                el.append(
                    h('div', { class: 'org-plan-grid' }, kit.field('분류', catSel), kit.field('칩이 여러 개면', h('div', { class: 'row' }, multi.el, multiName)), kit.field('정리할 위치', baseBtn)),
                    h('div', { class: 'org-plan-optrow' }, subT.el));
                return {};
            },
            async computePlan({ files, state }) {
                App.settings.set('organize.byChip', { category: state.cat.id, subfolders: state.subfolders, multi: state.multi, multiName: state.multiName });
                const groups = new Map();
                let untagged = 0;
                let already = 0;
                let multiCount = 0;
                for (const e of files) {
                    const found = chipsOf(e.path, state.cat, model);
                    if (!found.length) {
                        untagged++;
                        continue;
                    }
                    let rel;
                    const first = found[0];
                    if (found.length > 1 && state.multi === 'multi') {
                        rel = safeName(state.multiName);
                        multiCount++;
                    } else {
                        rel = safeName(first.chip.name);
                        if (state.subfolders && first.subs.length) rel += '/' + safeName(first.subs[0].name);
                    }
                    const dir = P.join(state.base, rel);
                    if (P.parent(e.path) === dir) {
                        already++;
                        continue;
                    }
                    if (!groups.has(dir)) groups.set(dir, { dir, rel, prefix: state.base ? `${kit.folderLabel(state.base)} › ` : '', entries: [], labels: new Map() });
                    const g = groups.get(dir);
                    g.entries.push(e);
                    g.labels.set(e.path, found.length > 1 ? `칩 ${found.length}개 · ${found.map((f) => f.chip.name).join(', ')}` : first.subs.length ? `${first.chip.name} › ${first.subs[0].name}` : first.chip.name);
                }
                const order = (g) => {
                    const top = g.rel.split('/')[0];
                    const chip = state.cat.chips.find((c) => safeName(c.name) === top);
                    return chip ? chip.order : 1e9;
                };
                const list = [...groups.values()].sort((a, b) => order(a) - order(b) || cmpPath(a.rel, b.rel));
                return {
                    groups: list,
                    notes: [
                        { label: '칩 없음 · 그대로', count: untagged },
                        { label: '이미 정리됨', count: already },
                        { label: '칩 여러 개', count: multiCount },
                    ],
                };
            },
        });
        if (res && res.record && res.record.moved.length) {
            const sources = [...new Set(res.record.moved.map((m) => P.parent(m.from)))].filter((d) => d !== '' && !P.isInside(res.state.base, d));
            const emptied = [];
            for (const d of sources) if ((await App.fs.exists(d)) && !(await kit.hasVisibleContent(d))) emptied.push(d);
            const msg = `${formatCount(res.record.moved.length)}개를 칩 폴더 ${formatCount(res.plan.groups.length)}개로 정리했어요`;
            if (emptied.length) {
                ui.toast(`${msg} · 비게 된 폴더가 ${emptied.length}개 있어요`, {
                    type: 'success',
                    duration: 9000,
                    action: { label: '빈 폴더 휴지통으로', run: () => trashFolders(emptied, `빈 폴더 ${emptied.length}개 정리`) },
                });
            } else {
                ui.toast(msg, { type: 'success', action: { label: '실행 취소', run: () => App.undo.undo() } });
            }
            res.emptied = emptied;
        }
        return res;
    }

    // =====================================================================
    // Empty folders
    // =====================================================================
    /** Soft-delete folders that hold nothing worth keeping, as ONE undo entry. */
    async function trashFolders(paths, label) {
        const live = [];
        for (const p of paths) if ((await App.fs.exists(p)) && !(await kit.hasVisibleContent(p))) live.push(p);
        // a folder inside another one being trashed travels with its parent
        const top = live.filter((p) => !live.some((o) => o !== p && P.isInside(p, o)));
        if (!top.length) return [];
        let res = await kit.trashPaths(top);
        if (!res.ids.length) {
            ui.toast(`폴더를 휴지통으로 옮기지 못했어요: ${res.failed[0]?.error || ''}`, { type: 'error' });
            return [];
        }
        let current = res.paths;
        App.undo.push({
            label,
            undo: async () => {
                const map = await kit.restoreIds(res.ids);
                current = current.map((p) => map.get(p) || p);
            },
            redo: async () => {
                res = await kit.trashPaths(current);
                current = res.paths;
            },
        });
        ui.toast(`${label} — 휴지통으로 옮겼어요`, { type: 'success', action: { label: '실행 취소', run: () => App.undo.undo() } });
        return res.ids;
    }

    async function cleanEmpty(args = {}) {
        if (!App.fs.ready) return null;
        const root = args.root ?? (App.view.source.type === 'folder' ? App.state.cwd ?? '' : '');
        const picked = await kit.panel({
            title: '빈 폴더 정리',
            subtitle: `${kit.folderPathLabel(root)} 안에서 찾아요`,
            icon: 'folder',
            width: 600,
            height: 'min(560px, calc(100vh - 48px))',
            className: 'org-empty',
            build(ctx) {
                let found = [];
                const checked = new Set();
                const list = kit.virtualList({ rowHeight: 40, render, className: 'org-empty-list', label: '빈 폴더' });
                const stateEl = h('div', { class: 'org-state' }, h('span', { class: 'spinner' }), h('span', { text: '빈 폴더를 찾는 중…' }));
                ctx.main.append(h('div', { class: 'org-picker-body' }, list.el, stateEl));
                const okBtn = btn({ label: '휴지통으로', kind: 'primary', icon: 'trash', onClick: () => ctx.close([...checked]) });
                okBtn.disabled = true;
                const info = h('div', { class: 'org-foot-info', text: '숨김 시스템 파일만 있는 폴더도 비어 있는 것으로 봐요' });
                ctx.foot.append(info, btn({ label: '취소', kind: 'ghost', onClick: () => ctx.close(null) }), okBtn);
                function render(i) {
                    const p = found[i];
                    const on = checked.has(p);
                    const row = h('div', { class: `org-row org-empty-row${on ? ' selected' : ''}`, role: 'option', 'aria-selected': String(on) },
                        kit.checkMark(on),
                        h('span', { class: 'org-picker-ico', html: icon('folder', 16) }),
                        h('span', { class: 'org-row-name truncate', text: P.base(p) }),
                        h('span', { class: 'org-row-sub truncate', text: kit.folderPathLabel(P.parent(p)) }));
                    row.addEventListener('click', () => {
                        if (checked.has(p)) checked.delete(p);
                        else checked.add(p);
                        list.update(i);
                        sync();
                    });
                    return row;
                }
                function sync() {
                    okBtn.disabled = !checked.size;
                    kit.setBtnLabel(okBtn, checked.size ? `휴지통으로 (${formatCount(checked.size)}개)` : '휴지통으로');
                }
                kit.findEmptyFolders(root).then((res) => {
                    found = res;
                    for (const p of found) checked.add(p);
                    stateEl.hidden = !!found.length;
                    if (!found.length) {
                        stateEl.innerHTML = '';
                        stateEl.append(h('span', { class: 'org-state-ico', html: icon('check-circle', 20) }), h('strong', { text: '빈 폴더가 없어요' }), h('span', { class: 'faint', text: '깔끔하게 정리돼 있어요.' }));
                    }
                    list.setCount(found.length);
                    ctx.setSubtitle(found.length ? `${kit.folderPathLabel(root)} 안에서 빈 폴더 ${formatCount(found.length)}개를 찾았어요` : `${kit.folderPathLabel(root)} 안에서 찾아봤어요`);
                    sync();
                    okBtn.focus();
                });
                ctx.onEnter(() => okBtn.click());
                ctx.onClose(() => list.destroy());
            },
        });
        if (!picked || !picked.length) return null;
        return trashFolders(picked, `빈 폴더 ${picked.length}개 정리`);
    }

    // =====================================================================
    // Commands & API
    // =====================================================================
    const ready = () => App.fs.ready;
    const hasSel = () => App.fs.ready && App.select.count > 0;

    App.commands.register({ id: 'organize.moveTo', title: '다른 폴더로 이동…', group: '정리', icon: 'folder-input', keys: 'Mod+Shift+M', when: hasSel, run: (a) => transferTo('move', cleanArgs(a)) });
    App.commands.register({ id: 'organize.copyTo', title: '다른 폴더로 복사…', group: '정리', icon: 'copy', keys: 'Mod+Shift+C', when: hasSel, run: (a) => transferTo('copy', cleanArgs(a)) });
    App.commands.register({
        id: 'organize.unwrap',
        title: '폴더 풀기',
        group: '정리',
        icon: 'folder-output',
        keys: 'Mod+Shift+U',
        when: () => App.fs.ready && (App.select.entries().some((e) => e.kind === 'dir') || (!App.select.count && App.view.source.type === 'folder' && !!App.state.cwd)),
        run: (a) => unwrap(cleanArgs(a)),
    });
    App.commands.register({ id: 'organize.byDate', title: '날짜별로 정리…', group: '정리', icon: 'calendar', keys: 'Mod+Shift+D', when: ready, run: (a) => byDate(cleanArgs(a)) });
    App.commands.register({ id: 'organize.byChip', title: '칩별로 정리…', group: '정리', icon: 'tag', keys: 'Mod+Shift+G', when: ready, run: (a) => byChip(cleanArgs(a)) });
    App.commands.register({ id: 'organize.cleanEmpty', title: '빈 폴더 정리…', group: '정리', icon: 'folder', when: ready, run: (a) => cleanEmpty(cleanArgs(a)) });

    // Commands receive { event } when triggered by a shortcut — strip it so it isn't mistaken for options
    function cleanArgs(a) {
        if (!a || typeof a !== 'object') return {};
        const { event, ...rest } = a;
        return rest;
    }

    Object.assign(App.organize, {
        pickFolder,
        resolveConflicts,
        detectConflicts,
        runProgram,
        undoRecord,
        commit: commitProgram,
        moveTo: (paths, dest) => transferTo('move', { paths, dest }),
        copyTo: (paths, dest) => transferTo('copy', { paths, dest }),
        unwrap: (paths, opts = {}) => unwrap({ ...opts, paths }),
        byDate: (opts) => byDate(opts),
        byChip: (opts) => byChip(opts),
        cleanEmpty: (opts) => cleanEmpty(opts),
        trashFolders,
        adoptCreated,
        safeName,
        chipsOf,
    });
})();
