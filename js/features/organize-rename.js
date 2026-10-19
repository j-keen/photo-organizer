/*
 * Organize — batch rename.
 *   Pattern tokens: {name} {n} {n:3} {ext} {date:YYYYMMDD} {taken:YYYY-MM-DD} {folder} {w} {h} {chip} {chip:분류}
 *   + find & replace (plain / regex), case transforms, extension case, auto-numbering on clashes.
 *   Live preview with conflicts highlighted; the whole batch is ONE undo entry (two-phase renames handle swaps).
 *   App.organize.rename(paths?), App.organize.computeRenames(entries, opts, ctx) (pure, used by tests)
 */
(() => {
    'use strict';
    const { h, path: P, formatCount, compareNames } = App.util;
    const ui = App.ui;
    const kit = App.organize.kit;
    const { icon, btn } = kit;

    const TOKEN_RE = /\{(name|n|ext|date|taken|folder|w|h|chip)(?::([^}]*))?\}/gi;
    const TOKENS = [
        { token: '{name}', label: '원래 이름' },
        { token: '{n}', label: '번호' },
        { token: '{n:3}', label: '001' },
        { token: '{ext}', label: '확장자' },
        { token: '{date:YYYYMMDD}', label: '수정한 날짜' },
        { token: '{taken:YYYY-MM-DD}', label: '찍은 날짜' },
        { token: '{folder}', label: '폴더 이름' },
        { token: '{w}x{h}', label: '해상도' },
        { token: '{chip}', label: '첫 번째 칩' },
    ];
    const PRESETS = [
        { value: '{folder}_{n:3}', label: '폴더이름_001' },
        { value: '{taken:YYYYMMDD}_{n:3}', label: '찍은날짜_001' },
        { value: '{date:YYYY-MM-DD} {name}', label: '수정한날짜 원래이름' },
        { value: '{name}_{w}x{h}', label: '원래이름_해상도' },
        { value: '{chip}_{n:3}', label: '칩이름_001' },
    ];
    const RECENT_KEY = 'organize.rename.recent';
    const LAST_KEY = 'organize.rename.last';

    function splitName(entry) {
        const name = entry.name;
        if (entry.kind === 'dir') return { stem: name, ext: '' };
        const dot = name.lastIndexOf('.');
        return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot + 1) } : { stem: name, ext: '' };
    }

    function applyCase(s, mode) {
        if (mode === 'lower') return s.toLowerCase();
        if (mode === 'upper') return s.toUpperCase();
        if (mode === 'title') return s.toLowerCase().replace(/(^|[\s_\-.([{])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());
        return s;
    }

    function usesToken(pattern, key) {
        TOKEN_RE.lastIndex = 0;
        let m;
        while ((m = TOKEN_RE.exec(pattern))) if (m[1].toLowerCase() === key) return true;
        return false;
    }

    function chipNameFor(path, catName, model) {
        if (!model) return '';
        const ids = App.catalog.get(path).chips || [];
        let best = null;
        let bestRank = Infinity;
        model.categories.forEach((cat, ci) => {
            if (catName && cat.name !== catName) return;
            for (const id of ids) {
                const c = model.byId.get(id);
                if (!c || c.cat !== cat || c.parent) continue;
                const rank = ci * 100000 + c.order;
                if (rank < bestRank) {
                    bestRank = rank;
                    best = c;
                }
            }
        });
        return best ? best.name : '';
    }

    /**
     * Pure name computation.
     * opts: { pattern, start, step, order: 'view'|'name'|'mtime'|'taken', perFolder, find, replace, regex, matchCase,
     *         caseMode: 'keep'|'lower'|'upper'|'title', extCase: 'keep'|'lower'|'upper', autoNumber }
     * ctx:  { info: Map(path -> {w,h}), taken: Map(path -> ms|null), chips: model|null, existing: Map(dir -> Map(lower -> name)) }
     * -> { rows: [{ entry, from, to, status: 'ok'|'same'|'error'|'conflict', message, fallback }], error: string|null }
     */
    function computeRenames(entries, opts, ctx = {}) {
        const pattern = opts.pattern && opts.pattern.trim() ? opts.pattern : '{name}';
        const start = Number.isFinite(+opts.start) ? +opts.start : 1;
        const step = Number.isFinite(+opts.step) && +opts.step !== 0 ? +opts.step : 1;
        const usesExt = usesToken(pattern, 'ext');
        const info = ctx.info || new Map();
        const taken = ctx.taken || new Map();
        let finder = null;
        let error = null;
        if (opts.find) {
            try {
                finder = opts.regex
                    ? new RegExp(opts.find, opts.matchCase ? 'g' : 'gi')
                    : new RegExp(opts.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts.matchCase ? 'g' : 'gi');
            } catch (e) {
                error = '정규식이 올바르지 않아요';
            }
        }

        // Numbering order
        let ordered = entries.slice();
        const timeOf = (e) => (taken.get(e.path) || e.mtime || 0);
        if (opts.order === 'name') ordered.sort((a, b) => compareNames(a.name, b.name));
        else if (opts.order === 'mtime') ordered.sort((a, b) => (a.mtime || 0) - (b.mtime || 0) || compareNames(a.name, b.name));
        else if (opts.order === 'taken') ordered.sort((a, b) => timeOf(a) - timeOf(b) || compareNames(a.name, b.name));
        const counters = new Map();
        const numberOf = new Map();
        for (const e of ordered) {
            const key = opts.perFolder ? P.parent(e.path) : '';
            const i = counters.get(key) || 0;
            counters.set(key, i + 1);
            numberOf.set(e.path, start + i * step);
        }

        const rows = entries.map((entry, idx) => {
            const { stem, ext } = splitName(entry);
            const extOut = applyCase(ext, opts.extCase || 'keep');
            const n = numberOf.get(entry.path);
            let fallback = false;
            let out = pattern.replace(TOKEN_RE, (m, keyRaw, arg) => {
                const key = keyRaw.toLowerCase();
                switch (key) {
                    case 'name':
                        return stem;
                    case 'n': {
                        const width = arg && /^\d+$/.test(arg) ? parseInt(arg, 10) : 0;
                        const s = String(Math.abs(n));
                        return (n < 0 ? '-' : '') + (width ? s.padStart(width, '0') : s);
                    }
                    case 'ext':
                        return extOut;
                    case 'date':
                        return entry.mtime ? kit.fmtDate(entry.mtime, arg || 'YYYY-MM-DD') : '';
                    case 'taken': {
                        let t = taken.get(entry.path);
                        if (!t) {
                            t = entry.mtime;
                            fallback = true;
                        }
                        return t ? kit.fmtDate(t, arg || 'YYYY-MM-DD') : '';
                    }
                    case 'folder':
                        return kit.folderLabel(P.parent(entry.path));
                    case 'w':
                        return info.get(entry.path)?.w ? String(info.get(entry.path).w) : '';
                    case 'h':
                        return info.get(entry.path)?.h ? String(info.get(entry.path).h) : '';
                    case 'chip':
                        return chipNameFor(entry.path, arg || '', ctx.chips);
                    default:
                        return m;
                }
            });
            if (finder) out = out.replace(finder, opts.regex ? opts.replace || '' : () => opts.replace || '');
            out = applyCase(out, opts.caseMode || 'keep');
            const to = usesExt || !ext ? out : `${out}.${extOut}`;
            return { idx, entry, from: entry.name, to, ext: usesExt ? '' : extOut, status: 'ok', message: '', fallback };
        });

        // Validation
        for (const r of rows) {
            if (!r.to.trim()) {
                r.status = 'error';
                r.message = '이름이 비어 있어요';
                continue;
            }
            const err = App.fs.validateName(r.to);
            if (err) {
                r.status = 'error';
                r.message = err;
                continue;
            }
            if (r.to === r.from) r.status = 'same';
        }

        // Conflicts (case-insensitive, per folder)
        const changing = new Set(rows.filter((r) => r.status === 'ok').map((r) => r.entry.path));
        const byDir = kit.groupBy(rows, (r) => P.parent(r.entry.path));
        for (const [dir, list] of byDir) {
            const existing = (ctx.existing && ctx.existing.get(dir)) || new Map();
            // Names that stay put: everything in the folder that isn't being renamed away
            const rowByName = new Map(list.map((r) => [r.from.toLowerCase(), r]));
            const fixed = new Set();
            for (const [lower] of existing) {
                const owner = rowByName.get(lower);
                if (!owner || !changing.has(owner.entry.path)) fixed.add(lower);
            }
            for (const r of list) if (r.status === 'same' || r.status === 'error') fixed.add(r.from.toLowerCase());
            const claimed = new Map();
            for (const r of list) {
                if (r.status !== 'ok') continue;
                let target = r.to;
                const own = r.from.toLowerCase();
                const clash = (name) => {
                    const l = name.toLowerCase();
                    return (fixed.has(l) && l !== own) || claimed.has(l);
                };
                if (clash(target)) {
                    if (opts.autoNumber) {
                        const dot = r.ext ? target.length - r.ext.length - 1 : target.length;
                        const base = target.slice(0, dot);
                        const tail = target.slice(dot);
                        for (let k = 2; k < 10000 && clash(target); k++) target = `${base} (${k})${tail}`;
                        r.to = target;
                        r.numbered = true;
                    } else {
                        r.status = 'conflict';
                        r.message = claimed.has(target.toLowerCase()) ? '같은 이름이 여러 개 생겨요' : '이 폴더에 이미 있는 이름이에요';
                        const other = claimed.get(target.toLowerCase());
                        if (other && other.status === 'ok') {
                            other.status = 'conflict';
                            other.message = '같은 이름이 여러 개 생겨요';
                        }
                    }
                }
                claimed.set(target.toLowerCase(), r);
            }
        }
        return { rows, error };
    }

    /**
     * Rename many items safely: direct renames first, then names that are still taken by another item of the
     * batch go through a temporary name (handles swaps and chains). pairs: [{ from: path, toName }]
     * Returns [{ from, to }] of what actually changed.
     */
    async function applyRenames(pairs, { job, total } = {}) {
        if (typeof App.fs.renameMany === 'function') {
            const res = await App.fs.renameMany(pairs, { undoable: false });
            job?.update(pairs.length, { total: total || pairs.length });
            return { done: res, failed: [] };
        }
        const done = [];
        const failed = [];
        let count = 0;
        const tick = () => {
            count++;
            if (count % 5 === 0 || count === pairs.length) job?.update(count, { total: total || pairs.length, detail: `${formatCount(count)} / ${formatCount(total || pairs.length)}` });
        };
        const sourceNames = new Map();
        for (const p of pairs) {
            const dir = P.parent(p.from);
            if (!sourceNames.has(dir)) sourceNames.set(dir, new Set());
            sourceNames.get(dir).add(P.base(p.from).toLowerCase());
        }
        const direct = [];
        const staged = [];
        for (const p of pairs) {
            const tl = p.toName.toLowerCase();
            if (tl !== P.base(p.from).toLowerCase() && sourceNames.get(P.parent(p.from)).has(tl)) staged.push(p);
            else direct.push(p);
        }
        const depth = (p) => p.from.split('/').length;
        direct.sort((a, b) => depth(b) - depth(a));
        for (const p of direct) {
            if (job?.cancelled) break;
            try {
                const to = await App.fs.rename(p.from, p.toName, { undoable: false });
                done.push({ from: p.from, to });
            } catch (e) {
                failed.push({ path: p.from, error: e.message || String(e) });
            }
            tick();
            if (count % 40 === 0) await App.util.sleep(0);
        }
        if (staged.length && !job?.cancelled) {
            const batch = Date.now().toString(36);
            const temps = [];
            for (let i = 0; i < staged.length; i++) {
                const p = staged[i];
                const ext = P.ext(p.from);
                const tmpName = `__fi-${batch}-${i}${ext ? '.' + ext : ''}`;
                try {
                    const tmp = await App.fs.rename(p.from, tmpName, { undoable: false });
                    temps.push({ p, tmp });
                } catch (e) {
                    failed.push({ path: p.from, error: e.message || String(e) });
                }
            }
            for (const { p, tmp } of temps) {
                try {
                    const to = await App.fs.rename(tmp, p.toName, { undoable: false });
                    done.push({ from: p.from, to });
                } catch (e) {
                    failed.push({ path: p.from, error: e.message || String(e) });
                    try {
                        await App.fs.rename(tmp, P.base(p.from), { undoable: false });
                    } catch (e2) {
                        console.error('[organize] could not restore name after a failed rename', tmp, e2);
                    }
                }
                tick();
            }
        }
        return { done, failed };
    }

    async function commitRenames(pairs, label) {
        const job = App.jobs.start({ title: '이름 바꾸는 중', total: pairs.length, cancellable: true });
        let res;
        try {
            res = await applyRenames(pairs, { job });
        } finally {
            job.finish();
        }
        if (res.done.length) {
            let current = res.done;
            App.undo.push({
                label,
                undo: async () => {
                    const j = App.jobs.start({ title: '이름 되돌리는 중', total: current.length, cancellable: false });
                    try {
                        await applyRenames(current.map((d) => ({ from: d.to, toName: P.base(d.from) })), { job: j });
                    } finally {
                        j.finish();
                    }
                },
                redo: async () => {
                    const j = App.jobs.start({ title: '이름 바꾸는 중', total: current.length, cancellable: false });
                    try {
                        const again = await applyRenames(current.map((d) => ({ from: d.from, toName: P.base(d.to) })), { job: j });
                        current = again.done;
                    } finally {
                        j.finish();
                    }
                },
            });
        }
        return res;
    }

    // =====================================================================
    // Dialog
    // =====================================================================
    async function rename(args = {}) {
        if (!App.fs.ready) return null;
        let entries = await kit.targetEntries(args);
        // An item inside another selected folder would move with it — keep the outermost only
        const dirs = entries.filter((e) => e.kind === 'dir').map((e) => e.path);
        entries = entries.filter((e) => !dirs.some((d) => d !== e.path && P.isInside(e.path, d)));
        if (!entries.length) {
            ui.toast('이름을 바꿀 항목을 먼저 선택하세요', { type: 'warning' });
            return null;
        }
        const last = App.settings.get(LAST_KEY, {});
        const opts = {
            pattern: args.pattern ?? last.pattern ?? '{name}',
            start: last.start ?? 1,
            step: last.step ?? 1,
            order: last.order ?? 'view',
            perFolder: last.perFolder ?? false,
            find: '',
            replace: '',
            regex: false,
            matchCase: false,
            caseMode: last.caseMode ?? 'keep',
            extCase: last.extCase ?? 'keep',
            autoNumber: last.autoNumber ?? false,
        };
        const multiDir = new Set(entries.map((e) => P.parent(e.path))).size > 1;
        const ctx = { info: new Map(), taken: new Map(), chips: null, existing: new Map() };

        const result = await kit.panel({
            title: '이름 일괄 변경',
            subtitle: `${entries.length === 1 ? entries[0].name : `${formatCount(entries.length)}개 항목`}`,
            icon: 'edit',
            width: 980,
            height: 'min(720px, calc(100vh - 48px))',
            className: 'org-rename',
            build(panel) {
                let computed = { rows: [], error: null };
                let shown = [];
                let filter = 'all';
                let loadingText = '';

                // ----- form -----
                const patternInput = h('input', { class: 'input org-mono', type: 'text', value: opts.pattern, spellcheck: 'false', autocomplete: 'off', 'aria-label': '이름 패턴' });
                const presetSel = h('select', { class: 'select org-preset', 'aria-label': '추천 패턴', 'data-tip': '추천·최근 패턴' });
                const fillPresets = () => {
                    presetSel.innerHTML = '';
                    presetSel.append(h('option', { value: '', text: '패턴 고르기' }));
                    const g1 = h('optgroup', { label: '추천 패턴' });
                    for (const p of PRESETS) g1.append(h('option', { value: p.value, text: `${p.label}  ·  ${p.value}` }));
                    presetSel.append(g1);
                    const recents = App.settings.get(RECENT_KEY, []).filter((x) => typeof x === 'string');
                    if (recents.length) {
                        const g2 = h('optgroup', { label: '최근에 쓴 패턴' });
                        for (const r of recents) g2.append(h('option', { value: r, text: r }));
                        presetSel.append(g2);
                    }
                };
                fillPresets();
                presetSel.addEventListener('change', () => {
                    if (!presetSel.value) return;
                    patternInput.value = presetSel.value;
                    presetSel.value = '';
                    onInput();
                    patternInput.focus();
                });
                const tokens = h('div', { class: 'org-tokens' });
                for (const t of TOKENS) {
                    tokens.append(h('button', {
                        type: 'button',
                        class: 'org-token',
                        'data-tip': `${t.label} 넣기`,
                        onclick: () => insertToken(t.token),
                    }, h('code', { text: t.token }), h('span', { text: t.label })));
                }

                const num = (value, label, min) => {
                    const el = h('input', { class: 'input org-num', type: 'number', value: String(value), step: '1', 'aria-label': label });
                    if (min != null) el.min = String(min);
                    return el;
                };
                const startInput = num(opts.start, '시작 번호');
                const stepInput = num(opts.step, '번호 간격');
                const orderSel = kit.select([
                    { value: 'view', label: '지금 보이는 순서' },
                    { value: 'name', label: '이름순' },
                    { value: 'taken', label: '찍은 날짜순' },
                    { value: 'mtime', label: '수정한 날짜순' },
                ], opts.order, (v) => {
                    opts.order = v;
                    ensureData().then(recompute);
                });
                const perFolderT = kit.toggle('폴더마다 번호 새로 시작', opts.perFolder, (v) => {
                    opts.perFolder = v;
                    recompute();
                });
                perFolderT.el.hidden = !multiDir;

                const findInput = h('input', { class: 'input', type: 'text', placeholder: '찾을 말', spellcheck: 'false', 'aria-label': '찾을 말' });
                const replInput = h('input', { class: 'input', type: 'text', placeholder: '바꿀 말 (비우면 지워요)', spellcheck: 'false', 'aria-label': '바꿀 말' });
                const regexT = kit.toggle('정규식', false, (v) => {
                    opts.regex = v;
                    recompute();
                }, { tip: '예: ^IMG_ → 앞의 IMG_만, (\\d+) → $1로 다시 쓰기' });
                const caseT = kit.toggle('대소문자 구분', false, (v) => {
                    opts.matchCase = v;
                    recompute();
                });
                const findError = h('div', { class: 'org-field-error' });

                const caseSeg = kit.seg([
                    { value: 'keep', label: '그대로' },
                    { value: 'lower', label: 'abc' },
                    { value: 'upper', label: 'ABC' },
                    { value: 'title', label: 'Abc Def' },
                ], opts.caseMode, (v) => {
                    opts.caseMode = v;
                    recompute();
                });
                const extSeg = kit.seg([
                    { value: 'keep', label: '그대로' },
                    { value: 'lower', label: '.jpg' },
                    { value: 'upper', label: '.JPG' },
                ], opts.extCase, (v) => {
                    opts.extCase = v;
                    recompute();
                });
                const autoT = kit.toggle('이름이 겹치면 번호 붙이기', opts.autoNumber, (v) => {
                    opts.autoNumber = v;
                    recompute();
                }, { hint: '예: 여행 (2).jpg' });

                const form = h('div', { class: 'org-rename-form' },
                    h('section', { class: 'org-sec' },
                        h('div', { class: 'org-sec-title', text: '이름 패턴' }),
                        h('div', { class: 'org-pattern-row' }, patternInput, presetSel),
                        tokens,
                        h('div', { class: 'org-field-hint', text: '{ext}가 없으면 원래 확장자가 붙어요 · {n:3}은 001처럼 자리를 맞춰요' })),
                    h('section', { class: 'org-sec' },
                        h('div', { class: 'org-sec-title', text: '번호' }),
                        h('div', { class: 'org-inline' }, h('label', { class: 'org-mini' }, h('span', { text: '시작' }), startInput), h('label', { class: 'org-mini' }, h('span', { text: '간격' }), stepInput), h('label', { class: 'org-mini grow' }, h('span', { text: '순서' }), orderSel)),
                        perFolderT.el,
                        autoT.el),
                    h('section', { class: 'org-sec' },
                        h('div', { class: 'org-sec-title', text: '찾아 바꾸기' }),
                        h('div', { class: 'org-find' }, findInput, h('span', { class: 'org-find-arrow', html: icon('arrow-right', 14) }), replInput),
                        h('div', { class: 'org-inline' }, regexT.el, caseT.el),
                        findError),
                    h('section', { class: 'org-sec' },
                        h('div', { class: 'org-sec-title', text: '대소문자' }),
                        h('div', { class: 'org-case-row' }, h('span', { class: 'org-case-label', text: '이름' }), caseSeg.el),
                        h('div', { class: 'org-case-row' }, h('span', { class: 'org-case-label', text: '확장자' }), extSeg.el)));

                // ----- preview -----
                const counts = { all: 0, changed: 0, problems: 0 };
                const filterSeg = kit.seg([
                    { value: 'all', label: '전체' },
                    { value: 'changed', label: '바뀌는 것' },
                    { value: 'problems', label: '문제' },
                ], 'all', (v) => {
                    filter = v;
                    renderList();
                });
                const loadingEl = h('span', { class: 'org-preview-loading', hidden: true }, h('span', { class: 'spinner' }), h('span'));
                const list = kit.virtualList({ rowHeight: 42, render: renderRow, className: 'org-rename-list', label: '이름 미리보기' });
                const emptyEl = h('div', { class: 'org-state', hidden: true }, h('span', { class: 'org-state-ico', html: icon('check-circle', 20) }), h('strong', { text: '문제없어요' }), h('span', { class: 'faint', text: '겹치거나 쓸 수 없는 이름이 없어요.' }));
                const preview = h('div', { class: 'org-rename-preview' },
                    h('div', { class: 'org-preview-head' }, h('span', { class: 'org-sec-title', text: '미리보기' }), loadingEl, h('div', { class: 'grow' }), filterSeg.el),
                    h('div', { class: 'org-preview-cols' }, h('span', { text: '지금 이름' }), h('span'), h('span', { text: '바뀔 이름' })),
                    h('div', { class: 'org-picker-body' }, list.el, emptyEl));

                panel.main.append(h('div', { class: 'org-rename-grid' }, form, preview));

                const info = h('div', { class: 'org-foot-info' });
                const okBtn = btn({ label: '이름 바꾸기', kind: 'primary', onClick: () => apply() });
                panel.foot.append(info, btn({ label: '취소', kind: 'ghost', onClick: () => panel.close(null) }), okBtn);

                function renderRow(i) {
                    const r = shown[i];
                    const cls = r.status === 'conflict' || r.status === 'error' ? ' bad' : r.status === 'same' ? ' same' : '';
                    const row = h('div', { class: `org-rn-row${cls}`, title: r.message || '' },
                        h('span', { class: 'org-rn-idx', text: String(r.idx + 1) }),
                        h('span', { class: 'org-rn-from truncate', text: r.from }),
                        h('span', { class: 'org-rn-arrow', html: icon('arrow-right', 13) }),
                        h('span', { class: 'org-rn-to truncate' }, r.status === 'same' ? h('span', { class: 'faint', text: '변경 없음' }) : r.to),
                        h('span', { class: 'org-rn-status' },
                            r.status === 'conflict' || r.status === 'error'
                                ? h('span', { class: 'org-rn-msg', html: `${icon('alert', 13)}<span>${App.util.escapeHtml(r.message)}</span>` })
                                : r.numbered
                                    ? h('span', { class: 'badge', text: '번호 붙음' })
                                    : r.fallback
                                        ? h('span', { class: 'badge', 'data-tip': '찍은 날짜가 없어서 수정한 날짜를 썼어요', text: '수정일' })
                                        : r.status === 'ok'
                                            ? h('span', { class: 'org-rn-ok', html: icon('check', 13) })
                                            : null));
                    return row;
                }

                function renderList() {
                    shown = filter === 'changed' ? computed.rows.filter((r) => r.status === 'ok') : filter === 'problems' ? computed.rows.filter((r) => r.status === 'conflict' || r.status === 'error') : computed.rows;
                    list.setCount(shown.length);
                    emptyEl.hidden = !(filter === 'problems' && !shown.length);
                    list.el.hidden = !emptyEl.hidden;
                }

                function recompute() {
                    opts.pattern = patternInput.value;
                    opts.start = parseInt(startInput.value, 10);
                    opts.step = parseInt(stepInput.value, 10);
                    opts.find = findInput.value;
                    opts.replace = replInput.value;
                    computed = computeRenames(entries, opts, ctx);
                    findError.textContent = computed.error || '';
                    findInput.classList.toggle('invalid', !!computed.error);
                    counts.all = computed.rows.length;
                    counts.changed = computed.rows.filter((r) => r.status === 'ok').length;
                    counts.problems = computed.rows.filter((r) => r.status === 'conflict' || r.status === 'error').length;
                    const segBtns = filterSeg.el.querySelectorAll('button');
                    segBtns[0].querySelector('span').textContent = `전체 ${formatCount(counts.all)}`;
                    segBtns[1].querySelector('span').textContent = `바뀌는 것 ${formatCount(counts.changed)}`;
                    segBtns[2].querySelector('span').textContent = `문제 ${formatCount(counts.problems)}`;
                    segBtns[2].classList.toggle('org-seg-bad', counts.problems > 0);
                    renderList();
                    const blocked = !!computed.error || counts.problems > 0 || !counts.changed || !!loadingText;
                    okBtn.disabled = blocked;
                    kit.setBtnLabel(okBtn, counts.changed ? `이름 바꾸기 (${formatCount(counts.changed)}개)` : '이름 바꾸기');
                    info.classList.toggle('bad', counts.problems > 0 || !!computed.error);
                    info.textContent = computed.error
                        ? computed.error
                        : counts.problems
                            ? `문제가 있는 이름 ${formatCount(counts.problems)}개를 고쳐야 바꿀 수 있어요${opts.autoNumber ? '' : ' · "겹치면 번호 붙이기"를 켜도 돼요'}`
                            : loadingText
                                ? loadingText
                                : counts.changed
                                    ? 'Enter로 바로 적용 · 나중에 Ctrl+Z로 한 번에 되돌릴 수 있어요'
                                    : '패턴을 바꾸면 미리보기가 바로 바뀌어요';
                }

                const recomputeSoon = App.util.debounce(recompute, 60);
                function onInput() {
                    recomputeSoon();
                    ensureData().then(recomputeSoon);
                }

                function insertToken(token) {
                    const s = patternInput.selectionStart ?? patternInput.value.length;
                    const e = patternInput.selectionEnd ?? s;
                    patternInput.value = patternInput.value.slice(0, s) + token + patternInput.value.slice(e);
                    patternInput.focus();
                    patternInput.setSelectionRange(s + token.length, s + token.length);
                    onInput();
                }

                // Load the data some tokens need (dimensions, capture dates, chips, folder listings)
                let dataToken = 0;
                async function ensureData() {
                    const pattern = patternInput.value;
                    const needInfo = usesToken(pattern, 'w') || usesToken(pattern, 'h');
                    const needTaken = usesToken(pattern, 'taken') || opts.order === 'taken';
                    const needChips = usesToken(pattern, 'chip') && !ctx.chips;
                    const my = ++dataToken;
                    const tasks = [];
                    if (needChips) tasks.push(kit.chipModel().then((m) => (ctx.chips = m)));
                    const files = entries.filter((e) => e.kind === 'file');
                    const missInfo = needInfo ? files.filter((e) => !ctx.info.has(e.path)) : [];
                    const missTaken = needTaken ? files.filter((e) => !ctx.taken.has(e.path)) : [];
                    if (!tasks.length && !missInfo.length && !missTaken.length) return;
                    const total = missInfo.length + missTaken.length;
                    let done = 0;
                    const progress = () => {
                        done++;
                        if (my === dataToken && (done % 10 === 0 || done === total)) setLoading(`${needInfo ? '해상도' : '찍은 날짜'}를 읽는 중… ${formatCount(done)} / ${formatCount(total)}`);
                    };
                    setLoading(total ? `정보를 읽는 중… 0 / ${formatCount(total)}` : '칩 정보를 읽는 중…');
                    tasks.push(App.util.pool(missInfo, 6, async (e) => {
                        ctx.info.set(e.path, await kit.mediaInfo(e));
                        progress();
                    }));
                    tasks.push(App.util.pool(missTaken, 6, async (e) => {
                        ctx.taken.set(e.path, await kit.takenDate(e));
                        progress();
                    }));
                    await Promise.all(tasks);
                    if (my === dataToken) setLoading('');
                }

                function setLoading(text) {
                    loadingText = text;
                    loadingEl.hidden = !text;
                    loadingEl.lastChild.textContent = text;
                    if (!text) recomputeSoon();
                    else okBtn.disabled = true;
                }

                function apply() {
                    if (okBtn.disabled) return;
                    const pairs = computed.rows.filter((r) => r.status === 'ok').map((r) => ({ from: r.entry.path, toName: r.to }));
                    panel.close({ pairs, opts: { ...opts } });
                }

                patternInput.addEventListener('input', onInput);
                for (const el of [startInput, stepInput, findInput, replInput]) el.addEventListener('input', recomputeSoon);
                panel.onEnter(() => {
                    recomputeSoon.flush();
                    apply();
                });
                panel.onClose(() => list.destroy());

                // Existing names per folder (for clash detection)
                const dirsList = [...new Set(entries.map((e) => P.parent(e.path)))];
                setLoading('폴더를 확인하는 중…');
                Promise.all(dirsList.map(async (d) => ctx.existing.set(d, new Map([...(await kit.namesIn(d)).values()].map((r) => [r.name.toLowerCase(), r.name]))))).then(() => {
                    setLoading('');
                    ensureData().then(recomputeSoon);
                });
                recompute();
                patternInput.focus();
                patternInput.select();
            },
        });
        if (!result || !result.pairs.length) return null;
        const o = result.opts;
        App.settings.set(LAST_KEY, { pattern: o.pattern, start: o.start, step: o.step, order: o.order, perFolder: o.perFolder, caseMode: o.caseMode, extCase: o.extCase, autoNumber: o.autoNumber });
        if (o.pattern && o.pattern.trim() && o.pattern !== '{name}') {
            const rec = App.settings.get(RECENT_KEY, []).filter((x) => x !== o.pattern);
            rec.unshift(o.pattern);
            App.settings.set(RECENT_KEY, rec.slice(0, 8));
        }
        const label = `이름 일괄 변경 (${formatCount(result.pairs.length)}개)`;
        const res = await commitRenames(result.pairs, label);
        if (res.done.length) {
            ui.toast(`${formatCount(res.done.length)}개 이름을 바꿨어요${res.failed.length ? ` · ${formatCount(res.failed.length)}개는 실패했어요` : ''}`, {
                type: res.failed.length ? 'warning' : 'success',
                action: { label: '실행 취소', run: () => App.undo.undo() },
            });
        } else if (res.failed.length) {
            ui.toast(`이름을 바꾸지 못했어요: ${res.failed[0].error}`, { type: 'error' });
        }
        return res;
    }

    function cleanArgs(a) {
        if (!a || typeof a !== 'object') return {};
        const { event, ...rest } = a;
        return rest;
    }

    App.commands.register({
        id: 'organize.rename',
        title: '이름 일괄 변경…',
        group: '정리',
        icon: 'edit',
        keys: ['Mod+Shift+R', 'F2'],
        when: () => App.fs.ready && App.select.count > 0,
        run: (a) => {
            // F2 on a single item belongs to file.rename (registered earlier); we take F2 only for multi-selections
            if (a && a.event && a.event.key === 'F2' && App.select.count < 2) return;
            return rename(cleanArgs(a));
        },
    });

    Object.assign(App.organize, {
        rename: (paths, opts = {}) => rename({ ...opts, paths }),
        computeRenames,
        applyRenames,
        commitRenames,
    });
})();
