/*
 * Inspector (right panel), laid out the way the owner remembers it from v1:
 *   top     — preview + quick strip (name, star rating, color label)
 *   middle  — scrollable: chip panel (main), other modules' sections, details (collapsible)
 *   bottom  — memo pinned at the bottom-right (autosaves to catalog.memo, resizable)
 *
 * Other modules add sections:
 *   App.inspector.addSection({ id, title, order, render(body, ctx, el), when?(ctx),
 *       dock?: 'top' | 'bottom'            (default: the scrollable middle)
 *       collapsible?, defaultCollapsed?     (titled sections only; state is remembered per browser)
 *       deps?: ['select','catalog','view','chipset']   (what re-renders it; default: everything)
 *       update?(body, ctx, reasons, el)     (self-managed DOM: called instead of clearing body + render)
 *       onHide?() })
 *   ctx = { entries: Entry[] (selected, [] when none), files: Entry[] (selected files), primary: Entry|null, folder }
 *   Built-ins: preview (top, 0), quick (top, 5), info "자세한 정보" (90, collapsible), memo (bottom, 100).
 *   App.inspector.refresh(reason = 'all')
 *
 * Rating & color-label shortcuts (digits 1–9 belong to chip hotkeys, Alt+1..3 to type filters):
 *   Ctrl+Alt+1..5 = stars (same again clears), Ctrl+Alt+0 = clear stars, ] / [ = one star up / down,
 *   Ctrl+Alt+6..9 = red / yellow / green / blue label (same again clears; orange & purple by click or menu).
 *   Alt+M = jump into the memo.
 */
(() => {
    'use strict';
    const { h, path: P, formatBytes, formatDate, formatDuration, formatCount, debounce, clamp } = App.util;
    const ui = App.ui;

    const LABELS = [
        { id: 'red', name: '빨강', keys: 'Mod+Alt+6' },
        { id: 'orange', name: '주황' },
        { id: 'yellow', name: '노랑', keys: 'Mod+Alt+7' },
        { id: 'green', name: '초록', keys: 'Mod+Alt+8' },
        { id: 'blue', name: '파랑', keys: 'Mod+Alt+9' },
        { id: 'purple', name: '보라' },
    ];
    const labelName = (id) => LABELS.find((l) => l.id === id)?.name || '';
    const ZONES = ['top', 'scroll', 'bottom'];
    const ALL_DEPS = ['select', 'catalog', 'view', 'chipset'];

    let host = null;
    let offEl = null;
    const zones = {};
    const sections = [];
    const pending = new Set();

    function ctx() {
        const entries = App.select.entries();
        // primary = the focused item (also inside a multi-selection); single = the one selected item, else null
        return { entries, files: entries.filter((e) => e.kind === 'file'), primary: App.select.primary(), single: entries.length === 1 ? entries[0] : null, folder: App.state.cwd };
    }

    // ---------- Section plumbing ----------
    function isCollapsed(s) {
        if (!s.collapsible) return false;
        const map = App.settings.get('inspector.collapsed', {});
        return s.id in map ? !!map[s.id] : !!s.defaultCollapsed;
    }

    function setCollapsed(s, v) {
        App.settings.set('inspector.collapsed', { ...App.settings.get('inspector.collapsed', {}), [s.id]: v });
        s.el.classList.toggle('collapsed', v);
        s.head?.setAttribute('aria-expanded', String(!v));
        if (!v && s.stale) renderSection(s, ctx(), new Set(['all']));
    }

    function mount(s) {
        if (s.el) return;
        s.body = h('div', { class: 'insp-body' });
        s.el = h('section', { class: `insp-section insp-sec-${s.id}${s.dock ? ` docked-${s.dock}` : ''}`, dataset: { section: s.id } });
        if (s.title) {
            const head = h(s.collapsible ? 'button' : 'div', {
                class: `panel-section-head insp-head${s.collapsible ? ' collapsible' : ''}`,
                type: s.collapsible ? 'button' : null,
                'aria-expanded': s.collapsible ? String(!isCollapsed(s)) : null,
            },
                s.collapsible ? h('span', { class: 'insp-twisty', html: ui.icon('chevron-right', { size: 12 }) }) : null,
                h('span', { class: 'grow', text: s.title }));
            if (s.collapsible) head.addEventListener('click', () => setCollapsed(s, !isCollapsed(s)));
            s.head = head;
            s.el.append(head);
        }
        s.el.append(s.body);
        s.el.classList.toggle('collapsed', isCollapsed(s));
    }

    function renderSection(s, c, reasons) {
        if (isCollapsed(s)) {
            s.stale = true;
            return;
        }
        s.stale = false;
        try {
            if (s.update) s.update(s.body, c, reasons, s.el);
            else {
                s.body.innerHTML = '';
                s.render(s.body, c, s.el);
            }
        } catch (e) {
            console.error('[inspector] section failed', s.id, e);
        }
    }

    // Put `els` into `zone` in order, touching only nodes that are missing or out of place
    // (moving a playing <video> would pause it).
    function place(zone, els) {
        for (const child of [...zone.children]) if (!els.includes(child)) child.remove();
        let ref = zone.firstChild;
        for (const el of els) {
            if (el === ref) {
                ref = ref.nextSibling;
                continue;
            }
            zone.insertBefore(el, ref);
        }
    }

    function hideSection(s) {
        if (s.el && s.el.isConnected) s.el.remove();
        if (s.shown) {
            s.shown = false;
            try {
                s.onHide?.();
            } catch (e) {
                console.error('[inspector] onHide failed', s.id, e);
            }
        }
    }

    function render(reasons = new Set(['all'])) {
        if (!host) return;
        const ready = App.fs.ready;
        host.classList.toggle('is-off', !ready);
        if (!ready) {
            for (const s of sections) hideSection(s);
            return;
        }
        const c = ctx();
        const all = reasons.has('all');
        const wanted = { top: [], scroll: [], bottom: [] };
        const visible = [];
        for (const s of sections) {
            let show = true;
            try {
                show = !s.when || !!s.when(c);
            } catch (e) {
                show = false;
            }
            if (!show) {
                hideSection(s);
                continue;
            }
            mount(s);
            wanted[s.dock === 'top' || s.dock === 'bottom' ? s.dock : 'scroll'].push(s);
            visible.push(s);
        }
        for (const z of ZONES) place(zones[z], wanted[z].map((s) => s.el));
        host.classList.toggle('has-top', wanted.top.length > 0);
        host.classList.toggle('has-bottom', wanted.bottom.length > 0);
        for (const s of visible) {
            const fresh = !s.shown;
            s.shown = true;
            if (fresh || all || s.update || (s.deps || ALL_DEPS).some((d) => reasons.has(d))) renderSection(s, c, reasons);
        }
    }

    const flush = debounce(() => {
        const reasons = new Set(pending);
        pending.clear();
        render(reasons);
    }, 40);

    function refresh(reason = 'all') {
        pending.add(reason);
        flush();
    }

    const inspector = {
        addSection(section) {
            const old = sections.findIndex((s) => s.id === section.id);
            if (old >= 0) {
                hideSection(sections[old]);
                sections.splice(old, 1);
            }
            sections.push({ ...section });
            sections.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
            refresh('all');
        },
        refresh,
        LABELS,
        labelName,
    };

    // ---------- Metadata writes (one undo entry per batch) ----------
    function targetFiles(scope) {
        if (scope === 'viewer') {
            const cur = App.viewer?.current;
            return cur && cur.kind === 'file' ? [cur.path] : [];
        }
        return App.select.entries().filter((e) => e.kind === 'file').map((e) => e.path);
    }

    /** setField(paths, 'rating'|'label', (prev, path) => next, label) -> number of files changed */
    function setField(paths, field, valueOf, label) {
        const prev = new Map(paths.map((p) => [p, App.catalog.peek(p)?.[field] || null]));
        const next = new Map(paths.map((p) => [p, valueOf(prev.get(p), p) || null]));
        const changed = paths.filter((p) => prev.get(p) !== next.get(p));
        if (!changed.length) return 0;
        // ONE undo entry for the whole batch is pushed below, so the catalog must not record its own
        const write = (m) => App.catalog.updateMany(changed, (e, p) => {
            const v = m.get(p);
            if (v) e[field] = v;
            else delete e[field];
        }, { undoable: false });
        write(next);
        App.undo.push({ label, undo: async () => write(prev), redo: async () => write(next) });
        return changed.length;
    }

    const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
    const hud = (text, opts) => App.chipset?.hud?.(text, opts);
    const countSub = (paths) => (paths.length > 1 ? `${formatCount(paths.length)}개 파일` : '');

    function setRating(paths, n, { toggle = false } = {}) {
        if (!paths.length) return;
        if (toggle && n && paths.every((p) => (App.catalog.peek(p)?.rating || 0) === n)) n = 0;
        setField(paths, 'rating', () => n, n ? `별점 ${n}개` : '별점 지우기');
        hud(n ? stars(n) : '별점 지움', { kind: n ? 'add' : 'remove', sub: countSub(paths) });
    }

    function stepRating(paths, delta) {
        if (!paths.length) return;
        setField(paths, 'rating', (r) => clamp((r || 0) + delta, 0, 5), delta > 0 ? '별점 올리기' : '별점 내리기');
        const values = paths.map((p) => App.catalog.peek(p)?.rating || 0);
        const same = values.every((v) => v === values[0]);
        hud(same ? (values[0] ? stars(values[0]) : '별점 없음') : `별점 ${delta > 0 ? '+1' : '−1'}`, { kind: delta > 0 ? 'add' : 'remove', sub: countSub(paths) });
    }

    function setLabel(paths, id, { toggle = false } = {}) {
        if (!paths.length) return;
        if (toggle && id && paths.every((p) => App.catalog.peek(p)?.label === id)) id = null;
        setField(paths, 'label', () => id, id ? `색상 라벨 ${labelName(id)}` : '색상 라벨 지우기');
        hud(id ? `● ${labelName(id)}` : '라벨 지움', { kind: id ? `add label-${id}` : 'remove', sub: countSub(paths) });
    }

    function commonValue(paths, field) {
        let first;
        for (let i = 0; i < paths.length; i++) {
            const v = App.catalog.peek(paths[i])?.[field] || null;
            if (i === 0) first = v;
            else if (v !== first) return undefined; // mixed
        }
        return first;
    }

    // ---------- Built-in: preview ----------
    let previewRelease = null;
    let previewToken = 0;

    function releasePreview() {
        previewToken++;
        if (previewRelease) {
            previewRelease();
            previewRelease = null;
        }
    }

    function noPreview(box, entry) {
        box.classList.add('ready');
        box.append(h('div', { class: 'insp-noprev', html: `${ui.icon(entry.type === 'video' ? 'film' : 'image', { size: 30 })}<span>${App.util.escapeHtml((entry.ext || '').toUpperCase())} 미리보기를 만들 수 없어요</span>` }));
    }

    function renderSinglePreview(body, entry) {
        const box = h('div', { class: 'insp-preview', 'data-tip': '두 번 클릭하면 크게 봐요' }, h('div', { class: 'insp-ph' }, h('span', { class: 'spinner' })));
        body.append(box);
        box.addEventListener('dblclick', () => App.nav.open(entry));
        const token = previewToken;
        const fullRes = () => App.fs.url(entry.path).then(({ url, release }) => {
            if (token !== previewToken || !box.isConnected) return release();
            previewRelease = release;
            return url;
        });
        if (entry.type === 'video' && App.util.browserCanDecode(entry.name)) {
            fullRes().then((url) => {
                if (!url) return;
                const v = h('video', { src: url, controls: true, muted: true, preload: 'metadata', playsinline: true, class: 'insp-video' });
                v.addEventListener('loadeddata', () => box.classList.add('ready'), { once: true });
                v.addEventListener('error', () => box.classList.add('ready'), { once: true });
                box.append(v);
            }).catch(() => noPreview(box, entry));
            return;
        }
        const img = h('img', { alt: '', class: 'insp-img', draggable: 'false' });
        img.addEventListener('load', () => box.classList.add('ready'));
        box.append(img);
        App.thumbs.get(entry, { size: 720 }).then(async (url) => {
            if (token !== previewToken) return;
            if (!url && App.util.browserCanDecode(entry.name) && entry.type === 'image') url = await fullRes().catch(() => null);
            if (token !== previewToken) return;
            if (url) img.src = url;
            else noPreview(box, entry);
        }).catch(() => noPreview(box, entry));
    }

    const previewSection = {
        id: 'preview',
        dock: 'top',
        order: 0,
        when: (c) => c.entries.length > 0,
        onHide() {
            releasePreview();
            if (this.body) {
                this.body.dataset.key = '';
                this.body.innerHTML = '';
            }
        },
        update(body, c) {
            const { single: primary, entries } = c;
            const key = primary
                ? `1|${primary.path}|${primary.mtime || 0}|${primary.size || 0}`
                : `n|${entries.length}|${entries.slice(0, 6).map((e) => e.path).join('|')}`;
            if (body.dataset.key === key) return;
            body.dataset.key = key;
            releasePreview();
            body.innerHTML = '';
            if (primary && primary.kind === 'file') {
                renderSinglePreview(body, primary);
                return;
            }
            if (primary && primary.kind === 'dir') {
                body.append(h('div', { class: 'insp-preview folder ready', 'data-tip': '두 번 클릭하면 폴더를 열어요', html: ui.icon('folder', { size: 52 }) }));
                body.firstChild.addEventListener('dblclick', () => App.nav.open(primary));
                return;
            }
            const grid = h('div', { class: 'insp-stack' });
            const shown = entries.slice(0, 6);
            shown.forEach((e, i) => {
                const cell = h('div', { class: 'insp-stack-cell' });
                if (e.kind === 'dir') cell.innerHTML = ui.icon('folder', { size: 26 });
                else {
                    cell.innerHTML = ui.icon(e.type === 'video' ? 'film' : 'image', { size: 22 });
                    App.thumbs.get(e).then((url) => {
                        if (url && cell.isConnected) cell.replaceChildren(h('img', { src: url, alt: '' }));
                    });
                }
                if (i === shown.length - 1 && entries.length > shown.length) cell.append(h('span', { class: 'insp-stack-more', text: `+${formatCount(entries.length - shown.length)}` }));
                grid.append(cell);
            });
            body.append(grid);
        },
    };

    // ---------- Built-in: quick strip (name, rating, label) ----------
    function subline({ entries, files, single: primary }) {
        if (primary) {
            if (primary.kind === 'dir') return '폴더';
            const meta = App.catalog.peek(primary.path)?.meta || {};
            const parts = [(primary.ext || '').toUpperCase()];
            if (meta.w && meta.h) parts.push(`${meta.w}×${meta.h}`);
            if (meta.duration) parts.push(formatDuration(meta.duration));
            parts.push(formatBytes(primary.size));
            return parts.filter(Boolean).join(' · ');
        }
        const imgs = files.filter((e) => e.type === 'image').length;
        const vids = files.filter((e) => e.type === 'video').length;
        const dirs = entries.length - files.length;
        const size = files.reduce((s, e) => s + (e.size || 0), 0);
        return [imgs && `사진 ${formatCount(imgs)}`, vids && `영상 ${formatCount(vids)}`, dirs && `폴더 ${formatCount(dirs)}`, size && formatBytes(size)].filter(Boolean).join(' · ');
    }

    function renderQuick(body, c) {
        const { entries, files, single: primary } = c;
        const title = primary ? primary.name : `${formatCount(entries.length)}개 선택됨`;
        body.append(h('div', { class: 'insp-title', text: title, title }), h('div', { class: 'insp-sub', text: subline(c) }));
        if (!files.length) return;
        const paths = files.map((f) => f.path);
        const rating = commonValue(paths, 'rating');
        const label = commonValue(paths, 'label');

        const starsEl = h('div', { class: `insp-rating${rating === undefined ? ' mixed' : ''}`, role: 'group', 'aria-label': '별점' });
        for (let n = 1; n <= 5; n++) {
            starsEl.append(h('button', {
                type: 'button',
                class: `insp-star${rating && n <= rating ? ' on' : ''}`,
                dataset: { rating: n },
                'aria-label': `별점 ${n}개`,
                'aria-pressed': String(rating === n),
                'data-tip': rating === n ? `별점 ${n}개 · 한 번 더 누르면 지워요` : `별점 ${n}개`,
                'data-tip-keys': `Mod+Alt+${n}`,
                html: ui.icon('star', { size: 16 }),
            }));
        }
        starsEl.addEventListener('mouseover', (e) => {
            const b = e.target.closest('[data-rating]');
            starsEl.style.setProperty('--hover', b ? b.dataset.rating : 0);
            starsEl.classList.toggle('hovering', !!b);
            if (b) starsEl.querySelectorAll('.insp-star').forEach((s) => s.classList.toggle('hot', Number(s.dataset.rating) <= Number(b.dataset.rating)));
        });
        starsEl.addEventListener('mouseleave', () => {
            starsEl.classList.remove('hovering');
            starsEl.querySelectorAll('.insp-star.hot').forEach((s) => s.classList.remove('hot'));
        });
        starsEl.addEventListener('click', (e) => {
            const b = e.target.closest('[data-rating]');
            if (b) setRating(paths, Number(b.dataset.rating), { toggle: true });
        });

        const labelsEl = h('div', { class: 'insp-labels', role: 'group', 'aria-label': '색상 라벨' });
        for (const l of LABELS) {
            labelsEl.append(h('button', {
                type: 'button',
                class: `insp-label${label === l.id ? ' on' : ''}`,
                dataset: { label: l.id },
                style: `--lc: var(--label-${l.id})`,
                'aria-label': `색상 라벨 ${l.name}`,
                'aria-pressed': String(label === l.id),
                'data-tip': label === l.id ? `${l.name} · 한 번 더 누르면 지워요` : l.name,
                'data-tip-keys': l.keys || null,
            }));
        }
        labelsEl.addEventListener('click', (e) => {
            const b = e.target.closest('[data-label]');
            if (b) setLabel(paths, b.dataset.label, { toggle: true });
        });

        const row = h('div', { class: 'insp-rate-row' }, starsEl, h('span', { class: 'grow' }), labelsEl);
        body.append(row);
        if (files.length > 1 && (rating === undefined || label === undefined)) {
            body.append(h('div', { class: 'insp-mixed', text: `${rating === undefined ? '별점' : ''}${rating === undefined && label === undefined ? '·' : ''}${label === undefined ? '라벨' : ''}이 파일마다 달라요 — 누르면 ${formatCount(files.length)}개 모두 바뀌어요` }));
        }
    }

    const quickSection = { id: 'quick', dock: 'top', order: 5, deps: ['select', 'catalog', 'view'], when: (c) => c.entries.length > 0, render: renderQuick };

    // ---------- Built-in: details ----------
    function infoTable(rows) {
        const t = h('div', { class: 'insp-table' });
        for (const [k, v] of rows) {
            if (v == null || v === '') continue;
            t.append(h('div', { class: 'insp-k', text: k }), h('div', { class: 'insp-v', text: v, title: String(v) }));
        }
        return t;
    }

    function renderInfo(body, { entries, files, single: primary }) {
        if (primary) {
            const meta = App.catalog.peek(primary.path)?.meta || {};
            const chips = App.chipset?.chipsOf?.(primary.path) || [];
            body.append(infoTable([
                ['이름', primary.name],
                ['종류', primary.kind === 'dir' ? '폴더' : `${primary.type === 'video' ? '영상' : primary.type === 'image' ? '사진' : '파일'} · ${(primary.ext || '').toUpperCase()}`],
                ['크기', primary.kind === 'dir' ? null : formatBytes(primary.size)],
                ['해상도', meta.w && meta.h ? `${meta.w} × ${meta.h}` : null],
                ['길이', meta.duration ? formatDuration(meta.duration) : null],
                ['찍은 날짜', meta.taken ? formatDate(meta.taken, true) : null],
                ['카메라', meta.camera || null],
                ['수정한 날짜', primary.mtime ? formatDate(primary.mtime, true) : null],
                ['칩', chips.length ? `${formatCount(chips.length)}개` : null],
                ['위치', P.parent(primary.path) || App.state.workspace?.name],
            ]));
            return;
        }
        if (entries.length > 1) {
            const size = files.reduce((s, e) => s + (e.size || 0), 0);
            body.append(infoTable([
                ['선택', `${formatCount(entries.length)}개`],
                ['사진', formatCount(files.filter((e) => e.type === 'image').length)],
                ['영상', formatCount(files.filter((e) => e.type === 'video').length)],
                ['폴더', formatCount(entries.length - files.length)],
                ['전체 크기', size ? formatBytes(size) : null],
            ]));
            return;
        }
        const v = App.view.entries;
        let imgs = 0;
        let vids = 0;
        let dirs = 0;
        let size = 0;
        for (const e of v) {
            if (e.kind === 'dir') dirs++;
            else if (e.type === 'video') vids++;
            else if (e.type === 'image') imgs++;
            size += e.size || 0;
        }
        body.append(h('div', { class: 'insp-folder-title', html: `${ui.icon(App.view.source.type === 'folder' ? 'folder' : 'search', { size: 14 })}<span></span>` }));
        body.lastChild.querySelector('span').textContent = App.view.source.title || App.state.workspace?.name || '';
        body.append(infoTable([
            ['사진', formatCount(imgs)],
            ['영상', formatCount(vids)],
            ['폴더', formatCount(dirs)],
            ['전체 크기', formatBytes(size)],
        ]));
        body.append(h('p', { class: 'insp-hint', text: '파일을 선택하면 미리보기와 칩·메모가 여기에 나와요.' }));
    }

    const infoSection = { id: 'info', title: '자세한 정보', order: 90, collapsible: true, deps: ['select', 'catalog', 'view'], render: renderInfo };

    // ---------- Built-in: memo (pinned bottom, autosave) ----------
    const memo = { el: null, input: null, stateEl: null, hintEl: null, path: null, dirty: false };
    const MEMO_STATES = {
        off: ['', ''],
        idle: ['', '자동 저장'],
        editing: ['editing', '입력 중…'],
        saving: ['saving', '저장 중…'],
        saved: ['saved', '저장됨'],
    };

    function memoState(s) {
        if (!memo.stateEl) return;
        const [cls, text] = MEMO_STATES[s] || MEMO_STATES.idle;
        memo.stateEl.className = `insp-memo-state ${cls}`;
        memo.stateEl.innerHTML = s === 'saved' ? `${ui.icon('check', { size: 12 })}<span>${text}</span>` : `<i></i><span>${text}</span>`;
        memo.stateEl.dataset.state = s;
    }

    const saveMemoSoon = debounce(() => memoFlush(), 600);

    function writeMemo(p, v) {
        App.catalog.update(p, (e) => {
            if (v && v.trim()) e.memo = v;
            else delete e.memo;
        }, { undoable: false });
    }

    // Undo: ONE entry per editing burst, not per keystroke or autosave. The first save of a burst pushes an entry;
    // later saves of the same burst only move its "after" value while it is still the newest entry.
    // A burst ends when the memo loses focus, another file is shown, or typing pauses for BURST_MS.
    const BURST_MS = 4000;
    const burst = { entry: null, path: null, at: 0, open: false };

    function endBurst() {
        burst.open = false;
    }

    function recordMemoUndo(p, before, after) {
        const now = Date.now();
        const top = typeof App.undo.peek === 'function' ? App.undo.peek() : null;
        if (burst.open && burst.entry && burst.path === p && top === burst.entry && now - burst.at < BURST_MS) {
            burst.entry.after = after;
            burst.at = now;
            return;
        }
        const entry = {
            label: `메모 고치기 · ${P.base(p)}`,
            before,
            after,
            undo: async () => writeMemo(p, entry.before),
            redo: async () => writeMemo(p, entry.after),
        };
        App.undo.push(entry);
        Object.assign(burst, { entry, path: p, at: now, open: true });
    }

    function memoFlush() {
        saveMemoSoon.cancel();
        if (!memo.dirty || !memo.path) return;
        memo.dirty = false;
        const p = memo.path;
        const v = memo.input.value;
        const before = App.catalog.peek(p)?.memo || '';
        if (before === v) {
            memoState('saved');
            return;
        }
        writeMemo(p, v);
        recordMemoUndo(p, before, v);
        memoState('saving');
        Promise.resolve(App.catalog.flush()).then(() => {
            if (memo.path === p && !memo.dirty) memoState('saved');
        });
    }

    function memoHeightVar(px) {
        if (px) host.style.setProperty('--insp-memo-h', `${px}px`);
        else host.style.removeProperty('--insp-memo-h');
    }

    function buildMemo(body) {
        memo.stateEl = h('span', { class: 'insp-memo-state' });
        memo.input = h('textarea', { class: 'textarea insp-memo-input', spellcheck: 'false', 'aria-label': '메모' });
        memo.hintEl = h('div', { class: 'insp-memo-hint' });
        const grip = h('div', { class: 'insp-memo-grip', 'data-tip': '드래그해서 높이 조절 · 두 번 클릭하면 원래대로' });
        memo.el = h('div', { class: 'insp-memobox' },
            grip,
            h('div', { class: 'insp-memo-head' },
                h('span', { class: 'insp-memo-title', html: `${ui.icon('note', { size: 13 })}<span>메모</span>` }),
                h('span', { class: 'grow' }),
                memo.stateEl),
            memo.input,
            memo.hintEl);
        body.append(memo.el);
        memo.input.addEventListener('input', () => {
            memo.dirty = true;
            memoState('editing');
            saveMemoSoon();
        });
        memo.input.addEventListener('blur', () => {
            memoFlush();
            endBurst();
        });
        memo.input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                memoFlush();
                memo.input.blur();
                document.getElementById('gallery-scroll')?.focus();
            }
        });
        grip.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const startY = e.clientY;
            const start = memo.el.getBoundingClientRect().height;
            const max = Math.round(window.innerHeight * 0.6);
            document.body.style.cursor = 'row-resize';
            grip.classList.add('dragging');
            const move = (ev) => memoHeightVar(clamp(start - (ev.clientY - startY), 96, max));
            const up = () => {
                window.removeEventListener('mousemove', move);
                window.removeEventListener('mouseup', up);
                document.body.style.cursor = '';
                grip.classList.remove('dragging');
                App.settings.set('inspector.memoHeight', Math.round(memo.el.getBoundingClientRect().height));
            };
            window.addEventListener('mousemove', move);
            window.addEventListener('mouseup', up);
        });
        grip.addEventListener('dblclick', () => {
            memoHeightVar(null);
            App.settings.set('inspector.memoHeight', null);
        });
    }

    const memoSection = {
        id: 'memo',
        dock: 'bottom',
        order: 100,
        when: (c) => c.entries.length > 0,
        onHide() {
            memoFlush();
            endBurst();
            memo.path = null;
        },
        update(body, c) {
            if (!memo.el) buildMemo(body);
            else if (memo.el.parentNode !== body) body.append(memo.el);
            const single = c.single;
            const p = single ? single.path : null;
            if (p !== memo.path) {
                memoFlush();
                endBurst();
                memo.path = p;
                memo.dirty = false;
                memo.input.value = p ? App.catalog.peek(p)?.memo || '' : '';
                memoState(p ? 'idle' : 'off');
            } else if (p && !memo.dirty && document.activeElement !== memo.input) {
                const v = App.catalog.peek(p)?.memo || '';
                if (v !== memo.input.value) memo.input.value = v;
            }
            const multi = c.entries.length > 1;
            memo.input.disabled = !p;
            memo.el.classList.toggle('disabled', !p);
            memo.input.placeholder = multi ? '메모는 파일을 하나만 골랐을 때 쓸 수 있어요' : '간단 메모를 남겨 보세요 — 자동으로 저장돼요';
            memo.hintEl.textContent = multi ? `${formatCount(c.entries.length)}개를 골랐어요. 한 파일만 선택하면 메모를 쓸 수 있어요.` : '';
            memo.hintEl.hidden = !multi;
        },
    };

    inspector.addSection(previewSection);
    inspector.addSection(quickSection);
    inspector.addSection(infoSection);
    inspector.addSection(memoSection);

    // ---------- Commands ----------
    // Each shortcut works on the gallery selection (scope main) and on the photo shown full-screen (scope viewer).
    function regTwin({ exec, ...cmd }, { viewer = true } = {}) {
        App.commands.register({ group: '평가', ...cmd, when: () => App.fs.ready && targetFiles('main').length > 0, run: () => exec('main') });
        if (viewer) {
            App.commands.register({ group: '평가', ...cmd, id: `${cmd.id}.viewer`, title: `${cmd.title} (보기 화면)`, scope: 'viewer', when: () => !!App.viewer?.isOpen && targetFiles('viewer').length > 0, run: () => exec('viewer') });
        }
    }

    for (let n = 0; n <= 5; n++) {
        regTwin({ id: `inspector.rate${n}`, title: n ? `별점 ${n}개` : '별점 지우기', icon: 'star', keys: `Mod+Alt+${n}`, exec: (scope) => setRating(targetFiles(scope), n, { toggle: true }) });
    }
    regTwin({ id: 'inspector.rateUp', title: '별점 하나 올리기', icon: 'star', keys: ']', exec: (scope) => stepRating(targetFiles(scope), 1) }, { viewer: false });
    regTwin({ id: 'inspector.rateDown', title: '별점 하나 내리기', icon: 'star', keys: '[', exec: (scope) => stepRating(targetFiles(scope), -1) }, { viewer: false });
    for (const l of LABELS) {
        regTwin({ id: `inspector.label.${l.id}`, title: `색상 라벨: ${l.name}`, icon: 'flag', keys: l.keys || [], exec: (scope) => setLabel(targetFiles(scope), l.id, { toggle: true }) }, { viewer: !!l.keys });
    }
    regTwin({ id: 'inspector.labelClear', title: '색상 라벨 지우기', icon: 'flag', exec: (scope) => setLabel(targetFiles(scope), null) }, { viewer: false });

    App.commands.register({
        id: 'inspector.focusMemo',
        title: '메모 쓰기',
        group: '정보 패널',
        icon: 'note',
        keys: 'Alt+M',
        when: () => App.fs.ready,
        run: () => {
            if (App.select.count !== 1) {
                hud(App.select.count ? '메모는 파일을 하나만 골랐을 때 쓸 수 있어요' : '메모를 쓸 파일을 먼저 선택해 주세요', { kind: 'info' });
                return;
            }
            if (App.layout && !App.layout.isVisible('inspector')) App.layout.setPanel('inspector', true);
            render(new Set(['all']));
            requestAnimationFrame(() => {
                if (!memo.input || memo.input.disabled) return;
                memo.input.focus();
                memo.input.setSelectionRange(memo.input.value.length, memo.input.value.length);
            });
        },
    });

    // Gallery context menu: rating & label submenus
    function contextItems(entries) {
        const paths = entries.filter((e) => e.kind === 'file').map((e) => e.path);
        if (!paths.length) return [];
        const r = commonValue(paths, 'rating');
        const l = commonValue(paths, 'label');
        return [
            {
                label: '별점',
                icon: 'star',
                submenu: () => [
                    ...[5, 4, 3, 2, 1].map((n) => ({ label: stars(n), checked: r === n, hint: App.commands.displayCombo(`Mod+Alt+${n}`), action: () => setRating(paths, n) })),
                    '-',
                    { label: '별점 지우기', checked: false, hint: App.commands.displayCombo('Mod+Alt+0'), action: () => setRating(paths, 0) },
                ],
            },
            {
                label: '색상 라벨',
                icon: 'flag',
                submenu: () => [
                    ...LABELS.map((x) => ({ label: x.name, checked: l === x.id, hint: x.keys ? App.commands.displayCombo(x.keys) : '', action: () => setLabel(paths, x.id) })),
                    '-',
                    { label: '라벨 지우기', checked: false, action: () => setLabel(paths, null) },
                ],
            },
        ];
    }

    App.register('inspector', {
        init() {
            host = document.getElementById('inspector');
            for (const z of ZONES) zones[z] = h('div', { class: `insp-zone insp-zone-${z}` });
            offEl = h('div', { class: 'insp-off' },
                h('div', { class: 'insp-off-icon', html: ui.icon('panel-right', { size: 22 }) }),
                h('div', { class: 'insp-off-title', text: '정보 패널' }),
                h('div', { class: 'insp-off-text', text: '작업 폴더를 열면 선택한 파일의 미리보기, 칩, 메모가 여기에 나와요.' }));
            host.append(zones.top, zones.scroll, zones.bottom, offEl);
            const mh = App.settings.get('inspector.memoHeight');
            if (mh) memoHeightVar(mh);
            render();
            App.bus.on('selection:changed', () => refresh('select'));
            App.bus.on('view:changed', ({ reason }) => {
                if (reason === 'entries') refresh('all');
                else if (!App.select.count) refresh('view');
            });
            App.bus.on('catalog:changed', ({ paths }) => {
                if (!App.select.count) return;
                const sel = App.select.paths;
                if (!paths || paths.some((p) => sel.has(p))) refresh('catalog');
            });
            App.bus.on('catalog:loaded', () => refresh('all'));
            App.bus.on('chipset:changed', () => refresh('chipset'));
            App.bus.on('thumbs:meta', ({ path }) => {
                if (App.select.primary()?.path === path) refresh('catalog');
            });
            App.bus.on('workspace:opened', () => refresh('all'));
            App.bus.on('workspace:closed', () => {
                memoFlush();
                render(new Set(['all']));
            });
            App.gallery?.contextMenuItems.push(contextItems);
        },
    });

    App.inspector = inspector;
    App.inspector.setRating = setRating;
    App.inspector.setLabel = setLabel;
})();
