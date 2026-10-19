/*
 * Duplicate finder v2 — the panel (App.dupes.ui).
 *   setup   어디에서: 지금 보는 폴더(± 하위) · 폴더 골라서(트리 체크) · 전체 작업 폴더 · 두 쪽 비교(A/B) · 선택한 항목
 *           (+ 다른 드라이브 폴더 when the local server's engine v2 is there) · 무엇을: 똑같은 파일 / 같은 영상 / 비슷한 사진
 *           · '지문 n개 준비됨' + 미리 만들기
 *   scan    phases + fingerprints reused / made
 *   review  '확실 / 애매' tabs with progress ('애매 42개 중 13개 확인'), side-by-side members (resolution, length, size,
 *           folder, date, role) with the 5 frame thumbnails aligned and a match mark + bit distance per position,
 *           synchronized playback (both play, jump to matched positions, A/B flip, which one is audible),
 *           keyboard flow ←/→ 묶음 · ↑/↓ 비교할 파일 · 1–9 남길 파일 · Space 재생 · D 중복 아님 · X 이 파일 빼기 ·
 *           Enter 이 묶음 정리; resumable (reviewed groups are saved per scan in dupes.json).
 */
(() => {
    'use strict';
    const { h, path: P, formatCount, formatBytes, formatDate, formatDuration, compareNames } = App.util;
    const ui = App.ui;
    const kit = App.organize.kit;
    const { icon, btn } = kit;
    const D = () => App.dupes;
    const E = () => App.dupes.engine;

    const PHASES = {
        wait: '라이브러리 색인이 끝나기를 기다리는 중',
        prepare: '지문 기록을 불러오는 중',
        quick: '크기가 같은 파일의 앞뒤 1MB를 비교하는 중',
        full: '내용이 같은지 끝까지 확인하는 중',
        probe: '영상 길이를 확인하는 중',
        frames: '영상 장면 지문을 만드는 중',
        image: '사진의 생김새를 분석하는 중',
        match: '짝을 맞추는 중',
        enrich: '해상도를 확인하는 중',
        server: '로컬 서버에서 찾는 중',
    };
    const DECISION_LABEL = { applied: '정리함', notdup: '중복 아님', keep: '확인함', excluded: '뺌', gone: '사라짐' };
    const POS_LABEL = ['15%', '35%', '50%', '65%', '85%'];

    const sepOf = (p) => (/^[a-zA-Z]:\\|\\\\/.test(p) ? '\\' : '/');
    const parentOf = (p) => {
        const s = sepOf(p);
        const i = p.lastIndexOf(s);
        return i <= 0 ? '' : p.slice(0, i);
    };
    const baseOf = (p) => p.split(/[\\/]/).pop();
    const folderLabelOf = (m) => (m.root ? parentOf(m.path) : kit.folderPathLabel(P.parent(m.path)));
    const resOf = (m) => (m.w && m.h ? `${m.w}×${m.h}` : '');
    const entryOf = (m) => (m.root ? null : App.index?.get(m.path) || { kind: 'file', path: m.path, name: m.name || baseOf(m.path), type: m.type, ext: P.ext(m.path), size: m.size, mtime: m.mtime });

    function ago(ms) {
        const d = Date.now() - ms;
        if (d < 60000) return '방금';
        if (d < 3600000) return `${Math.round(d / 60000)}분 전`;
        if (d < 86400000) return `${Math.round(d / 3600000)}시간 전`;
        return `${Math.round(d / 86400000)}일 전`;
    }

    let active = null;

    function open(args = {}) {
        if (!App.fs.ready) return null;
        if (active) {
            active.route(args || {});
            return active.promise;
        }
        let ctl = null;
        const promise = kit.panel({
            title: '중복 정리',
            subtitle: '',
            icon: 'layers',
            width: 1440,
            height: 'min(940px, calc(100vh - 32px))',
            className: 'dup-panel',
            undoKeys: true,
            build(ctx) {
                ctl = controller(ctx);
                active = ctl;
                ctl.route(args || {});
            },
        });
        if (ctl) ctl.promise = promise;
        promise.then(() => {
            if (active === ctl) active = null;
        });
        return promise;
    }

    // =================================================================================================
    function controller(ctx) {
        const c = { ctx, view: null, job: null, cancelled: false, rv: null, cleanup: [] };
        const store = D().store;
        const saved = App.settings.get('dupes.setup', {}) || {};
        const setup = {
            mode: ['folder', 'folders', 'workspace', 'compare'].includes(saved.mode) ? saved.mode : 'folder',
            sub: saved.sub ?? true,
            kinds: { exact: true, video: saved.kinds?.video ?? true, image: saved.kinds?.image ?? true },
            picked: new Set(),
            a: new Set(),
            b: new Set(),
            roots: [],
            selection: null,
        };
        let pickerApi = null;
        let viewCleanup = [];
        const clearView = () => {
            for (const fn of viewCleanup.splice(0)) {
                try {
                    fn();
                } catch (e) {
                    console.error(e);
                }
            }
            pickerApi = null;
            clearDetail();
            if (els) {
                els.list.destroy();
                els = null;
            }
            ctx.onEnter(null);
            ctx.main.innerHTML = '';
            ctx.foot.innerHTML = '';
            ctx.headRight.innerHTML = '';
        };
        c.gen = 0;
        c.closed = false;
        ctx.onClose(() => {
            c.closed = true;
            if (c.job && c.job.state === 'running') c.job.cancel();
            clearView();
            for (const fn of c.cleanup) fn();
            if (c.resumePrebuild) c.resumePrebuild();
        });

        // ---------- routing ----------
        c.route = async (args) => {
            await store.ready();
            if (typeof args.scope === 'string') {
                if (args.scope === 'selection') {
                    const paths = args.paths || App.select.list();
                    if (paths.length) return startScan({ type: 'paths', paths });
                }
                if (args.scope === 'folder') setup.mode = 'folder';
                if (args.scope === 'workspace') setup.mode = 'workspace';
                return args.autostart ? startScan(scopeFromSetup()) : showSetup();
            }
            if (args.scope && typeof args.scope === 'object') {
                if (args.scope.type === 'folder') {
                    setup.mode = 'folder';
                    setup.sub = args.scope.sub !== false;
                }
                return args.autostart ? startScan(args.scope) : showSetup();
            }
            if (args.focus) return startScan({ type: 'workspace' }, { focus: args.focus });
            if (args.setup) {
                setup.mode = args.setup;
                if (Array.isArray(args.paths)) setup.picked = new Set(args.paths);
                if (Array.isArray(args.a)) setup.a = new Set(args.a);
                if (Array.isArray(args.b)) setup.b = new Set(args.b);
                return showSetup();
            }
            if (!args.fresh) {
                const last = await lastResult();
                if (last) return showReview(last, { resumed: true });
            }
            return showSetup();
        };

        async function lastResult() {
            try {
                const r = await E().cache.getResult();
                const ls = store.data.lastScan;
                if (!r || !r.raw || r.ws !== (App.state.workspace?.id || '') || !ls || ls.id !== r.id) return null;
                if (Date.now() - r.at > 30 * 86400000) return null;
                return r;
            } catch (e) {
                return null;
            }
        }

        // =============================================================================================
        // Setup
        // =============================================================================================
        function prefill() {
            const ls = store.data.lastScan;
            const sc = ls && ls.scope;
            if (sc && sc.type === 'folders' && !setup.picked.size) setup.picked = new Set((sc.paths || []).filter((p) => App.index.folders.includes(p)));
            if (sc && sc.type === 'compare' && !setup.a.size && !setup.b.size) {
                setup.a = new Set((sc.a || []).filter((p) => App.index.folders.includes(p)));
                setup.b = new Set((sc.b || []).filter((p) => App.index.folders.includes(p)));
            }
            if (!setup.roots.length && Array.isArray(store.data.extraRoots)) setup.roots = store.data.extraRoots.map((p) => ({ path: p, on: false, side: null }));
        }

        function scopeFromSetup() {
            const roots = setup.roots.filter((r) => r.on);
            switch (setup.mode) {
                case 'folders':
                    return { type: 'folders', paths: [...setup.picked], roots: roots.map((r) => r.path) };
                case 'workspace':
                    return { type: 'workspace', roots: roots.map((r) => r.path) };
                case 'compare':
                    return { type: 'compare', a: [...setup.a], b: [...setup.b], rootsA: roots.filter((r) => r.side === 'a').map((r) => r.path), rootsB: roots.filter((r) => r.side === 'b').map((r) => r.path) };
                default:
                    return { type: 'folder', path: App.state.cwd ?? '', sub: setup.sub };
            }
        }

        function countFor(scope) {
            if (!App.index.ready) return null;
            const media = (e) => e.kind === 'file' && (e.type === 'image' || e.type === 'video') && !store.isExcluded(e.path);
            const items = App.index.items;
            if (scope.type === 'workspace') return items.filter(media).length;
            if (scope.type === 'folder') return App.index.under(scope.path, { recursive: scope.sub !== false }).filter(media).length;
            const dirs = scope.type === 'folders' ? scope.paths : [...(scope.a || []), ...(scope.b || [])];
            if (!dirs.length) return 0;
            let n = 0;
            for (const e of items) if (media(e) && dirs.some((d) => P.isInside(e.path, d))) n++;
            return n;
        }

        function showSetup() {
            c.view = 'setup';
            clearView();
            prefill();
            ctx.setTitle('중복 정리');
            ctx.setSubtitle('원하는 곳을 골라서 똑같은 파일과 같은 영상을 찾고, 직접 보면서 정리해요');
            const server = E().serverV2();
            const wrap = h('div', { class: 'dup-setup' });
            const left = h('div', { class: 'dup-setup-main' });
            const right = h('aside', { class: 'dup-setup-side' });
            wrap.append(left, right);
            ctx.main.append(wrap);

            // resume banner
            lastResult().then((last) => {
                if (!last || c.view !== 'setup') return;
                const ls = store.data.lastScan;
                const counts = ls.counts || {};
                const done = Object.keys(ls.reviewed || {}).length;
                const banner = h('div', { class: 'dup-resume' },
                    h('span', { class: 'dup-resume-ico', html: icon('history', 16) }),
                    h('div', { class: 'dup-resume-text' },
                        h('b', { text: `지난 검사 결과가 있어요 · ${ago(last.at)}` }),
                        h('span', { text: `확실 ${formatCount(counts.sure || 0)} · 애매 ${formatCount(counts.unsure || 0)} · ${formatCount(done)}개 확인함` })),
                    btn({ label: '이어서 확인하기', kind: 'sm primary', icon: 'arrow-right', onClick: () => showReview(last, { resumed: true }) }));
                left.prepend(banner);
            });

            // ---- where ----
            const selCount = App.select.count;
            const cards = [
                { mode: 'folder', icon: 'folder-open', title: '지금 보는 폴더', desc: kit.folderPathLabel(App.state.cwd ?? '') },
                { mode: 'folders', icon: 'folder-plus', title: '폴더 골라서', desc: '여러 폴더를 체크해서 함께 찾아요' },
                { mode: 'workspace', icon: 'home', title: '전체 작업 폴더', desc: App.state.workspace?.name || '작업 폴더 전체' },
                { mode: 'compare', icon: 'merge', title: '두 쪽 비교', desc: '겹치는 것만 (다운로드 ↔ 보관함)' },
            ];
            const cardsEl = h('div', { class: 'dup-scopes', role: 'radiogroup', 'aria-label': '찾을 곳' });
            const detail = h('div', { class: 'dup-scope-detail' });
            const startBtn = btn({ label: '찾기 시작', kind: 'primary', icon: 'search', keys: 'Enter', onClick: () => go() });
            const startNote = h('div', { class: 'org-foot-info dup-start-note' });

            const syncStart = App.util.debounce(() => {
                const scope = scopeFromSetup();
                let problem = '';
                const roots = setup.roots.filter((r) => r.on);
                if (scope.type === 'folders' && !scope.paths.length && !roots.length) problem = '찾을 폴더를 하나 이상 골라 주세요';
                if (scope.type === 'compare') {
                    const aN = scope.a.length + scope.rootsA.length;
                    const bN = scope.b.length + scope.rootsB.length;
                    if (!aN || !bN) problem = `${!aN ? 'A' : 'B'} 쪽 폴더를 골라 주세요`;
                }
                if (roots.length && !server) problem = '다른 드라이브 폴더는 로컬 서버가 켜져 있어야 찾을 수 있어요';
                if (roots.some((r) => r.on && setup.mode === 'compare' && !r.side)) problem = '다른 드라이브 폴더를 A나 B 쪽에 넣어 주세요';
                startBtn.disabled = !!problem;
                const n = countFor(scope);
                startNote.textContent = problem || (n != null ? `사진·영상 ${formatCount(n)}개${roots.length ? ` + 다른 드라이브 ${formatCount(roots.length)}곳` : ''}에서 찾아요. 아무것도 자동으로 지우지 않아요.` : '');
                startNote.classList.toggle('warn', !!problem);
            }, 60);

            function renderDetail() {
                if (pickerApi) {
                    pickerApi.destroy();
                    pickerApi = null;
                }
                detail.innerHTML = '';
                if (setup.mode === 'folder') {
                    const t = kit.toggle('하위 폴더까지 함께 찾기', setup.sub, (v) => {
                        setup.sub = v;
                        syncStart();
                    });
                    detail.append(h('div', { class: 'dup-detail-row' }, h('span', { class: 'dup-path-chip', html: `${icon('folder', 14)}<span>${App.util.escapeHtml(kit.folderPathLabel(App.state.cwd ?? ''))}</span>` }), t.el));
                } else if (setup.mode === 'workspace') {
                    detail.append(h('div', { class: 'dup-detail-row faint', text: '작업 폴더 안의 모든 사진과 영상을 서로 비교해요. 처음엔 오래 걸려도, 지문을 기억해 둬서 다음부터는 빨라요.' }));
                } else {
                    const summary = h('div', { class: 'dup-picked' });
                    const syncSummary = () => {
                        summary.innerHTML = '';
                        if (setup.mode === 'folders') {
                            if (!setup.picked.size) summary.append(h('span', { class: 'faint', text: '아래에서 폴더를 체크하세요. 체크한 폴더의 하위 폴더도 함께 찾아요.' }));
                            for (const p of [...setup.picked].sort(compareNames)) summary.append(pathChip(p, () => {
                                setup.picked.delete(p);
                                pickerApi?.refresh();
                                syncSummary();
                                syncStart();
                            }));
                        } else {
                            for (const side of ['a', 'b']) {
                                const set = side === 'a' ? setup.a : setup.b;
                                const col = h('div', { class: `dup-side-col side-${side}` }, h('span', { class: 'dup-side-tag', text: side.toUpperCase() }));
                                if (!set.size) col.append(h('span', { class: 'faint', text: side === 'a' ? '예: 다운로드 폴더' : '예: 정리해 둔 보관함' }));
                                for (const p of [...set].sort(compareNames)) col.append(pathChip(p, () => {
                                    set.delete(p);
                                    pickerApi?.refresh();
                                    syncSummary();
                                    syncStart();
                                }));
                                summary.append(col);
                            }
                        }
                    };
                    pickerApi = D().picker.create({
                        mode: setup.mode === 'compare' ? 'ab' : 'check',
                        picked: setup.picked,
                        a: setup.a,
                        b: setup.b,
                        onChange: () => {
                            syncSummary();
                            syncStart();
                        },
                    });
                    syncSummary();
                    detail.append(summary, pickerApi.el);
                    if (setup.mode === 'compare') detail.append(h('div', { class: 'dup-detail-hint faint', text: '두 쪽에 모두 들어 있는 묶음만 보여 줘요. 같은 쪽 안에서 겹치는 건 건드리지 않아요.' }));
                }
                renderRoots();
                syncStart();
            }

            function pathChip(p, onRemove) {
                const x = h('button', { type: 'button', class: 'dup-chip-x', 'aria-label': '빼기', html: icon('x', 12) });
                x.addEventListener('click', onRemove);
                return h('span', { class: 'dup-path-chip' }, h('span', { html: icon('folder', 13) }), h('span', { class: 'truncate', text: kit.folderPathLabel(p) }), x);
            }

            // ---- other drives (server engine v2) ----
            const rootsBox = h('div', { class: 'dup-roots' });
            function renderRoots() {
                rootsBox.innerHTML = '';
                if (setup.mode === 'folder') return;
                const head = h('div', { class: 'dup-roots-head' }, h('span', { html: icon('hard-drive', 15) }), h('b', { text: '다른 드라이브 폴더 추가' }));
                rootsBox.append(head);
                if (!server) {
                    rootsBox.append(h('div', { class: 'dup-roots-off', text: '로컬 서버를 켜면 D:\\VideoDownloader 같은 작업 폴더 밖의 폴더도 함께 비교할 수 있어요. (읽기만 하고, 정리하면 그 드라이브의 _중복정리 폴더로 옮겨요)' }));
                    return;
                }
                for (const r of setup.roots) {
                    const on = kit.toggle('', r.on, (v) => {
                        r.on = v;
                        syncStart();
                    });
                    const row = h('div', { class: 'dup-root-row' }, on.el, h('span', { class: 'dup-root-path truncate', text: r.path, title: r.path }));
                    if (setup.mode === 'compare') {
                        const sideSeg = kit.seg([{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], r.side, (v) => {
                            r.side = v;
                            r.on = true;
                            on.set(true);
                            syncStart();
                        });
                        sideSeg.el.classList.add('sm');
                        row.append(sideSeg.el);
                    }
                    row.append(btn({ icon: 'x', kind: 'ghost icon sm', tip: '목록에서 지우기', onClick: () => {
                        setup.roots = setup.roots.filter((x) => x !== r);
                        saveRoots();
                        renderRoots();
                        syncStart();
                    } }));
                    rootsBox.append(row);
                }
                const input = h('input', { class: 'input', placeholder: '예: D:\\VideoDownloader', 'aria-label': '다른 드라이브 폴더 경로', 'data-native-enter': '' });
                const add = () => {
                    const v = input.value.trim().replace(/[\\/]+$/, '');
                    if (!D().isAbs(v)) {
                        ui.toast('D:\\폴더 처럼 전체 경로를 적어 주세요', { type: 'warning' });
                        return;
                    }
                    if (!setup.roots.some((x) => x.path.toLowerCase() === v.toLowerCase())) setup.roots.push({ path: v, on: true, side: setup.mode === 'compare' ? 'a' : null });
                    saveRoots();
                    renderRoots();
                    syncStart();
                };
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        e.stopPropagation();
                        add();
                    }
                });
                const browse = typeof App.server?.request === 'function'
                    ? btn({ label: '찾아보기…', kind: 'sm', icon: 'folder-open', onClick: async () => {
                        try {
                            const r = await App.server.request('POST', '/api/workspace/pick', {});
                            if (r && r.root) {
                                input.value = r.root;
                                add();
                            }
                        } catch (e) {
                            ui.toast(`폴더를 고르지 못했어요: ${e.message || e}`, { type: 'error' });
                        }
                    } })
                    : null;
                rootsBox.append(h('div', { class: 'dup-root-add' }, input, btn({ label: '추가', kind: 'sm', onClick: add }), browse));
            }
            function saveRoots() {
                const list = setup.roots.map((r) => r.path);
                store.data.extraRoots = list;
                store.saveSoon();
            }

            for (const cdef of cards) {
                const b = h('button', { type: 'button', class: `dup-scope${setup.mode === cdef.mode ? ' on' : ''}`, role: 'radio', 'aria-checked': String(setup.mode === cdef.mode), dataset: { mode: cdef.mode } },
                    h('span', { class: 'dup-scope-ico', html: icon(cdef.icon, 18) }),
                    h('span', { class: 'dup-scope-text' }, h('span', { class: 'dup-scope-title', text: cdef.title }), h('span', { class: 'dup-scope-desc truncate', text: cdef.desc })));
                b.addEventListener('click', () => {
                    setup.mode = cdef.mode;
                    for (const x of cardsEl.children) {
                        x.classList.toggle('on', x.dataset.mode === cdef.mode);
                        x.setAttribute('aria-checked', String(x.dataset.mode === cdef.mode));
                    }
                    renderDetail();
                });
                cardsEl.append(b);
            }
            left.append(h('div', { class: 'dup-step' }, h('div', { class: 'dup-step-title', text: '어디에서 찾을까요?' }), cardsEl, detail, rootsBox));
            if (selCount > 1) {
                left.append(h('div', { class: 'dup-detail-row faint' }, `선택한 ${formatCount(selCount)}개 안에서만 찾으려면 `, btn({ label: '선택한 항목에서 찾기', kind: 'ghost sm', onClick: () => startScan({ type: 'paths', paths: App.select.list() }) })));
            }

            // ---- what ----
            const kindRow = (key, title, desc, ic, locked) => {
                const t = kit.toggle(title, locked ? true : setup.kinds[key], (v) => {
                    setup.kinds[key] = v;
                }, { hint: desc });
                if (locked) t.input.disabled = true;
                t.el.classList.add('dup-kind-toggle');
                t.el.prepend(h('span', { class: 'dup-kind-ico', html: icon(ic, 16) }));
                return t.el;
            };
            right.append(h('div', { class: 'dup-step' },
                h('div', { class: 'dup-step-title', text: '무엇을 찾을까요?' }),
                kindRow('exact', '똑같은 파일', '이름이 달라도 내용이 완전히 같으면 찾아요', 'copy', true),
                kindRow('video', '같은 영상', '화질·이름이 달라도 장면 5곳이 같으면 찾아요', 'film'),
                kindRow('image', '비슷한 사진', '크기를 줄였거나 다시 저장한 사진도 찾아요', 'image')));

            // ---- fingerprints ----
            const fpBox = h('div', { class: 'dup-fp' });
            const syncFp = async () => {
                const n = await E().cache.count();
                const job = E().prebuildJob;
                fpBox.innerHTML = '';
                fpBox.append(h('div', { class: 'dup-fp-head' }, h('span', { class: 'dup-fp-ico', html: icon('zap', 16) }), h('div', { class: 'dup-fp-text' },
                    h('b', { class: 'dup-fp-count', text: `지문 ${formatCount(n)}개 준비됨` }),
                    h('span', { text: job ? `${job.paused ? '잠시 멈춤' : '만드는 중'} · ${job.detail || ''}` : '한 번 만든 지문은 기억해 두고, 새로 생기거나 바뀐 파일만 다시 만들어요' }))));
                const actions = h('div', { class: 'dup-fp-actions' });
                if (job) {
                    actions.append(btn({ label: job.paused ? '이어서 만들기' : '잠시 멈추기', kind: 'sm', icon: job.paused ? 'play' : 'pause', onClick: () => (job.paused ? job.resume() : job.pause()) }),
                        btn({ label: '그만 만들기', kind: 'ghost sm', onClick: () => job.cancel() }));
                } else {
                    actions.append(btn({ label: '지문 미리 만들기', kind: 'sm', icon: 'zap', tip: '뒤에서 천천히 만들어 둬요. 다른 일을 해도 돼요', onClick: () => {
                        E().prebuild({ quiet: false });
                        syncFp();
                    } }));
                }
                fpBox.append(actions);
                const auto = kit.toggle('작업 폴더를 열면 지문 미리 만들기', App.settings.get('dupes.prebuildOnOpen', false), (v) => App.settings.set('dupes.prebuildOnOpen', v));
                fpBox.append(auto.el);
            };
            syncFp();
            const offJobs = App.bus.on('jobs:changed', App.util.throttle(() => {
                if (c.view === 'setup') syncFp();
            }, 400));
            viewCleanup.push(offJobs);
            right.append(h('div', { class: 'dup-step' }, h('div', { class: 'dup-step-title', text: '지문' }), fpBox));

            // ---- engine ----
            if (server) {
                const t = kit.toggle('로컬 서버로 찾기', App.settings.get('dupes.useServer', true), (v) => App.settings.set('dupes.useServer', v), { hint: '모든 영상 형식을 ffmpeg로 읽어요. 규칙은 똑같아요' });
                right.append(h('div', { class: 'dup-engine on' }, h('span', { html: icon('server', 15) }), t.el));
            } else {
                right.append(h('div', { class: 'dup-engine' }, h('span', { html: icon('server', 15) }), h('span', { text: '지금은 브라우저에서 찾아요. 브라우저가 못 여는 영상(AVI·WMV 등)은 로컬 서버를 켜면 함께 비교해요.' })));
            }
            const ex = store.data.excludedFiles.length + store.data.excludedFolders.length + store.data.notDuplicates.length;
            right.append(h('ul', { class: 'dup-tips' },
                h('li', null, h('span', { html: icon('shield-check', 14) }), h('span', { text: '지우기 직전에 남길 파일을 다시 확인하고, 모두 휴지통을 거쳐요' })),
                h('li', null, h('span', { html: icon('undo', 14) }), h('span', { text: 'Ctrl+Z 한 번으로 정리한 것을 통째로 되돌려요' })),
                h('li', null, h('span', { html: icon('tag', 14) }), h('span', { text: '지우는 쪽의 칩·별점·메모는 남기는 파일로 합쳐요' }))));

            ctx.foot.append(
                btn({ label: '규칙', kind: 'ghost', icon: 'sliders', tip: '장면 일치 기준, 길이 차이, 확실 기준', onClick: () => App.dupes.tools?.openRules() }),
                btn({ label: ex ? `제외 목록 ${formatCount(ex)}` : '제외 목록', kind: 'ghost', icon: 'eye-off', onClick: () => App.dupes.tools?.openExclusions() }),
                startNote,
                btn({ label: '닫기', kind: 'ghost', onClick: () => ctx.close(null) }),
                startBtn);
            const go = () => {
                if (startBtn.disabled) return;
                App.settings.set('dupes.setup', { mode: setup.mode, sub: setup.sub, kinds: { video: setup.kinds.video, image: setup.kinds.image } });
                startScan(scopeFromSetup());
            };
            ctx.onEnter(() => go());
            renderDetail();
            startBtn.focus();
            const offIdx = App.bus.on('index:ready', () => syncStart());
            viewCleanup.push(offIdx);
        }

        // =============================================================================================
        // Scanning
        // =============================================================================================
        function showScanning(title) {
            c.view = 'scan';
            clearView();
            ctx.setSubtitle(title);
            const phaseEl = h('div', { class: 'dup-scan-phase', text: '준비하는 중…' });
            const countEl = h('div', { class: 'dup-scan-count' });
            const bar = h('i', { style: { width: '0%' } });
            const t0 = Date.now();
            ctx.main.append(h('div', { class: 'dup-scan' },
                h('div', { class: 'dup-scan-ico', html: icon('layers', 26) }),
                phaseEl,
                h('div', { class: 'progress dup-scan-bar' }, bar),
                countEl,
                h('div', { class: 'dup-scan-hint', text: '한 번 만든 지문은 기억해 두니까 다음에는 새 파일만 보면 돼요.' })));
            const stop = btn({ label: '그만 찾기', kind: 'ghost', onClick: () => c.job?.cancel(), tip: '찾기를 멈추고 처음 화면으로 돌아가요', keys: 'Escape' });
            ctx.foot.append(h('div', { class: 'grow' }), stop);
            return (phase, done, total, msg) => {
                phaseEl.textContent = msg || PHASES[phase] || '찾는 중…';
                const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
                bar.style.width = `${total ? pct : 100}%`;
                bar.parentElement.classList.toggle('indeterminate', !total);
                countEl.textContent = total && phase !== 'server' ? `${formatCount(done)} / ${formatCount(total)} · ${Math.round((Date.now() - t0) / 1000)}초` : '';
                c.job?.update(done, { total, detail: phaseEl.textContent });
            };
        }

        async function startScan(scope, { focus = null } = {}) {
            if (c.job && c.job.state === 'running') c.job.cancel(); // a newer scan replaces the running one
            const gen = ++c.gen;
            const live = () => !c.closed && c.gen === gen;
            let cancelled = false;
            const show = showScanning(focus ? `‘${baseOf(focus)}’와 같은 파일을 찾는 중` : '중복을 찾는 중이에요');
            const progress = (...a) => {
                if (live()) show(...a);
            };
            const pj = E().prebuildJob;
            if (pj && pj.state === 'running') {
                pj.pause();
                c.resumePrebuild = () => {
                    c.resumePrebuild = null;
                    if (pj.paused) pj.resume();
                };
            }
            const job = App.jobs.start({ title: focus ? '같은 파일 찾는 중' : '중복 찾는 중', total: 0, cancellable: true });
            c.job = job;
            job.onCancel(() => (cancelled = true));
            const ws = App.state.workspace?.id;
            try {
                const result = await E().scan(scope, {
                    kinds: setup.kinds,
                    rules: store.rules(),
                    focus,
                    useServer: App.settings.get('dupes.useServer', true),
                    onProgress: progress,
                    isCancelled: () => cancelled || !live() || App.state.workspace?.id !== ws,
                });
                if (cancelled || App.state.workspace?.id !== ws) throw Object.assign(new Error('cancelled'), { cancelled: true });
                job.finish();
                if (live()) showReview(result, { fresh: true });
            } catch (e) {
                job.finish();
                if (!live()) return;
                if (e.cancelled || cancelled) ui.toast('중복 찾기를 멈췄어요', { type: 'info' });
                else {
                    console.error('[dupes] scan failed', e);
                    ui.toast(`중복을 찾지 못했어요: ${e.message || e}`, { type: 'error' });
                }
                showSetup();
            } finally {
                if (c.gen === gen || c.closed) c.resumePrebuild?.();
            }
        }

        // =============================================================================================
        // Review
        // =============================================================================================
        function showReview(result, { fresh = false } = {}) {
            c.view = 'review';
            clearView();
            const persist = !result.focus;
            const rv = {
                result,
                persist,
                order: [],
                byId: new Map(),
                tab: App.settings.get('dupes.tab', 'unsure') === 'sure' ? 'sure' : 'unsure',
                cur: { sure: null, unsure: null },
                choice: new Map(), // gid → { keep, leave: Set }
                focus: new Map(), // gid → path of the member being compared ("B")
                decisions: new Map(),
                gone: new Set(),
                mode: 'grid',
                expanded: new Set(),
                abSide: 'b',
                audible: 0,
            };
            c.rv = rv;
            if (persist && store.data.lastScan && store.data.lastScan.id === result.id) {
                for (const [gid, v] of Object.entries(store.data.lastScan.reviewed || {})) rv.decisions.set(gid, v);
            }
            // members that are no longer there (trashed since the scan, or deleted outside the app)
            for (const m of result.raw.items) if (!m.root && App.index.ready && !App.index.get(m.path)) rv.gone.add(m.path);
            // a resumed review keeps the groups already decided in the list (honest progress)
            if (!fresh && Array.isArray(result.snapshot)) {
                for (const g of result.snapshot) {
                    rv.order.push(g.id);
                    rv.byId.set(g.id, { ...g, resolved: 'gone' });
                }
            }
            assembleAll();
            if (persist && fresh) {
                const groups = liveGroups();
                result.snapshot = groups.map((g) => ({ id: g.id, kind: g.kind, kindLabel: g.kindLabel, sure: g.sure, keep: g.keep, why: g.why, bytes: g.bytes, evidence: g.evidence, members: g.members }));
                E().cache.putResult(result).catch(() => {});
                D().setLastScan({ id: result.id, at: result.at, scope: result.scope, engine: result.engine, counts: { sure: groups.filter((g) => g.sure).length, unsure: groups.filter((g) => !g.sure).length, files: result.stats?.scanned || 0 }, groupIds: groups.map((g) => g.id) });
                // decisions carried over for groups that are still the same
                rv.decisions.clear();
                for (const [gid, v] of Object.entries(store.data.lastScan?.reviewed || {})) rv.decisions.set(gid, v);
            }
            if (persist && store.data.lastScan && store.data.lastScan.id === result.id) {
                for (const [gid, ch] of Object.entries(store.data.lastScan.choices || {})) rv.choice.set(gid, { keep: ch.keep || null, leave: new Set(ch.leave || []) });
            }
            if (!rv.order.length) return showEmpty(result);
            // open at the first unreviewed group; prefer the remembered tab when it still has work
            const pending = (tab) => tabIds(tab).filter((id) => !isDone(id));
            if (!pending(rv.tab).length && pending(rv.tab === 'sure' ? 'unsure' : 'sure').length) rv.tab = rv.tab === 'sure' ? 'unsure' : 'sure';
            if (!tabIds(rv.tab).length) rv.tab = rv.tab === 'sure' ? 'unsure' : 'sure';
            for (const tab of ['sure', 'unsure']) rv.cur[tab] = pending(tab)[0] || tabIds(tab)[0] || null;
            buildReview();
        }

        function liveGroups() {
            const rv = c.rv;
            return rv.order.map((id) => rv.byId.get(id)).filter((g) => g && !g.resolved);
        }

        function assembleAll() {
            const rv = c.rv;
            const groups = E().assemble(rv.result.raw, { rules: store.rules(), store, compare: rv.result.scope?.type === 'compare', focus: rv.result.focus, gone: rv.gone });
            const live = new Set();
            for (const g of groups) {
                live.add(g.id);
                const prev = rv.byId.get(g.id);
                if (!prev) {
                    // new group (split by an exclusion, or back after an undo): place it next to a relative
                    let at = -1;
                    const paths = new Set(g.members.map((m) => m.path));
                    for (let i = 0; i < rv.order.length; i++) {
                        const o = rv.byId.get(rv.order[i]);
                        if (o && o.members.some((m) => paths.has(m.path))) at = i;
                    }
                    if (at >= 0) rv.order.splice(at + 1, 0, g.id);
                    else rv.order.push(g.id);
                }
                g.resolved = null;
                rv.byId.set(g.id, g);
                const d = rv.decisions.get(g.id);
                if (d === 'applied' || d === 'notdup' || d === 'excluded') {
                    // it is back (undo): no longer decided
                    rv.decisions.delete(g.id);
                    if (rv.persist) D().setReviewed(rv.result.id, g.id, null);
                }
            }
            for (const id of rv.order) {
                if (live.has(id)) continue;
                const g = rv.byId.get(id);
                if (g) g.resolved = rv.decisions.get(id) || 'gone';
            }
        }

        const tabIds = (tab) => c.rv.order.filter((id) => !!c.rv.byId.get(id)?.sure === (tab === 'sure'));
        const isDone = (id) => {
            const g = c.rv.byId.get(id);
            return !!(g && (g.resolved || c.rv.decisions.has(id)));
        };
        const curGroup = () => {
            const rv = c.rv;
            const id = rv.cur[rv.tab];
            return id ? rv.byId.get(id) : null;
        };
        function choiceOf(g) {
            let ch = c.rv.choice.get(g.id);
            if (!ch) {
                ch = { keep: null, leave: new Set() };
                c.rv.choice.set(g.id, ch);
            }
            return ch;
        }
        function keeperOf(g) {
            const ch = c.rv.choice.get(g.id);
            return ch && ch.keep && g.members.some((m) => m.path === ch.keep) ? ch.keep : g.keep;
        }
        function stateOf(g, p) {
            if (p === keeperOf(g)) return 'keep';
            const ch = c.rv.choice.get(g.id);
            return ch && ch.leave.has(p) ? 'leave' : 'remove';
        }
        const removing = (g) => g.members.filter((m) => stateOf(g, m.path) === 'remove');
        const quality = (m) => [(m.h || 0) * 100000 + (m.w || 0), Math.round(m.dur || 0)];
        /** The keeper sits in a keep folder but a better copy (resolution or length) is elsewhere → move it in. */
        function upgradeOf(g) {
            if (!g || g.resolved) return null;
            const km = g.members.find((m) => m.path === keeperOf(g));
            if (!km || km.root || store.roleOf(km.path) !== 'keep') return null;
            let best = km;
            for (const m of g.members) {
                if (m === km || m.root || stateOf(g, m.path) === 'leave') continue;
                const [r1, d1] = quality(m);
                const [r0, d0] = quality(best);
                if (r1 > r0 || (r1 === r0 && d1 > d0)) best = m;
            }
            if (best === km) return null;
            return { best, keeper: km, into: P.parent(km.path) };
        }
        function upgradePlan(g, up) {
            const remove = g.members.filter((m) => m !== up.best && (m === up.keeper || stateOf(g, m.path) === 'remove')).map((m) => m.path);
            return { group: g, keep: up.best.path, remove, moveTo: up.into };
        }
        const bytesOf = (g) => removing(g).reduce((s, m) => s + (m.size || 0), 0);
        function focusOf(g) {
            const k = keeperOf(g);
            const f = c.rv.focus.get(g.id);
            if (f && f !== k && g.members.some((m) => m.path === f)) return f;
            return (g.members.find((m) => m.path !== k) || g.members[0]).path;
        }

        // ---------- layout ----------
        let els = null;
        let detailCleanup = [];
        let sync = null;

        function buildReview() {
            const rv = c.rv;
            ctx.main.innerHTML = '';
            ctx.foot.innerHTML = '';
            const tabs = kit.seg([
                { value: 'sure', label: '확실' },
                { value: 'unsure', label: '애매' },
            ], rv.tab, (v) => switchTab(v));
            tabs.el.classList.add('dup-tabs');
            const progressText = h('div', { class: 'dup-prog-text' });
            const progressBar = h('i');
            const progress = h('div', { class: 'dup-prog' }, progressText, h('div', { class: 'dup-prog-bar' }, progressBar));
            const list = kit.virtualList({ rowHeight: 62, render: renderRow, className: 'dup-glist', label: '중복 묶음' });
            const side = h('aside', { class: 'dup-side' }, tabs.el, progress, list.el);
            const detail = h('section', { class: 'dup-detail', 'aria-live': 'polite' });
            ctx.main.append(h('div', { class: 'dup-review' }, side, detail));

            const hints = h('div', { class: 'dup-hints' },
                ...[['←/→', '묶음'], ['↑/↓', '비교할 파일'], ['1–9', '남길 파일'], ['Space', '재생'], ['F', '장면 이동'], ['A', 'A/B'], ['D', '중복 아님'], ['X', '이 파일 빼기'], ['Enter', '이 묶음 정리']]
                    .map(([k, t]) => h('span', { class: 'dup-hint' }, h('span', { class: 'kbd', text: k }), h('span', { text: t }))));
            const bulkBtn = btn({ label: '', kind: 'danger', icon: 'trash', tip: '확실한 묶음을 모두 정리해요 (지우기 직전에 다시 확인)', onClick: () => applyBulk() });
            ctx.foot.append(hints,
                btn({ icon: 'sliders', kind: 'ghost icon', tip: '규칙 (장면 일치 기준·확실 기준)', aria: '규칙', onClick: () => App.dupes.tools?.openRules({ result: rv.result }) }),
                btn({ icon: 'eye-off', kind: 'ghost icon', tip: '제외 목록', aria: '제외 목록', onClick: () => App.dupes.tools?.openExclusions() }),
                btn({ label: '다시 찾기', kind: 'ghost', icon: 'refresh', onClick: () => showSetup() }),
                bulkBtn);
            els = { tabs, progressText, progressBar, list, detail, bulkBtn };
            refreshAll();
            list.el.focus({ preventScroll: true });
        }

        function refreshAll() {
            if (c.view !== 'review' || !els) return;
            const rv = c.rv;
            const ids = tabIds(rv.tab);
            if (rv.cur[rv.tab] && !ids.includes(rv.cur[rv.tab])) rv.cur[rv.tab] = ids.find((id) => !isDone(id)) || ids[0] || null;
            if (!rv.cur[rv.tab]) rv.cur[rv.tab] = ids.find((id) => !isDone(id)) || ids[0] || null;
            els.list.setCount(ids.length);
            const idx = ids.indexOf(rv.cur[rv.tab]);
            if (idx >= 0) els.list.scrollToIndex(idx);
            syncChrome();
            renderDetail();
        }

        function syncChrome() {
            if (!els || c.view !== 'review') return; // the view changed while we were waiting
            const rv = c.rv;
            const sureIds = tabIds('sure');
            const unsureIds = tabIds('unsure');
            const btns = els.tabs.el.querySelectorAll('button');
            const left = (ids) => ids.filter((id) => !isDone(id)).length;
            btns[0].querySelector('span').textContent = `확실 ${formatCount(left(sureIds))}`;
            btns[1].querySelector('span').textContent = `애매 ${formatCount(left(unsureIds))}`;
            const ids = rv.tab === 'sure' ? sureIds : unsureIds;
            const done = ids.filter(isDone).length;
            els.progressText.textContent = ids.length ? `${rv.tab === 'sure' ? '확실' : '애매'} ${formatCount(ids.length)}개 중 ${formatCount(done)}개 확인` : `${rv.tab === 'sure' ? '확실한' : '애매한'} 묶음이 없어요`;
            els.progressBar.style.width = ids.length ? `${Math.round((done / ids.length) * 100)}%` : '0%';
            const live = liveGroups();
            const sure = live.filter((g) => g.sure && (!rv.decisions.has(g.id) || rv.decisions.get(g.id) === 'keep'));
            const n = sure.reduce((s, g) => s + removing(g).length, 0);
            const bytes = sure.reduce((s, g) => s + bytesOf(g), 0);
            els.bulkBtn.disabled = !n;
            kit.setBtnLabel(els.bulkBtn, n ? `확실한 묶음 ${formatCount(sure.length)}개 한 번에 정리 · ${formatBytes(bytes)}` : '확실한 묶음 없음');
            const r = rv.result;
            const st = r.stats || {};
            const reuse = st.reused ? ` · 지문 ${formatCount(st.reused)}개 재사용${st.savedMs > 1500 ? ` (약 ${E().formatSaved(st.savedMs)} 절약)` : ''}` : '';
            const allBytes = live.reduce((s, g) => s + bytesOf(g), 0);
            ctx.setTitle(r.focus ? `‘${baseOf(r.focus)}’와 같은 파일` : '중복 정리');
            ctx.setSubtitle(`${r.scope?.type === 'compare' ? '두 쪽 비교 · ' : ''}${formatCount(st.scanned || 0)}개 살펴봄${reuse} · 정리하면 최대 ${formatBytes(allBytes)} · ${ago(r.at)} 검사${r.engine === 'server' ? ' · 로컬 서버' : ''}`);
        }

        function switchTab(tab) {
            if (!els || c.view !== 'review') return; // the view changed while we were waiting
            const rv = c.rv;
            rv.tab = tab;
            App.settings.set('dupes.tab', tab);
            els.tabs.set(tab);
            rv.mode = 'grid';
            refreshAll();
        }

        function renderRow(i) {
            const rv = c.rv;
            const id = tabIds(rv.tab)[i];
            const g = rv.byId.get(id);
            if (!g) return h('div');
            const k = g.members.find((m) => m.path === keeperOf(g)) || g.members[0];
            const d = g.resolved || rv.decisions.get(id);
            const ent = entryOf(k);
            const th = ent ? kit.thumb(ent, { cls: 'dup-row-thumb' }) : h('div', { class: 'org-thumb dup-row-thumb', html: icon('hard-drive', 16) });
            const row = h('div', { class: `dup-row${id === rv.cur[rv.tab] ? ' current' : ''}${g.resolved ? ' resolved' : ''}`, role: 'option', 'aria-selected': String(id === rv.cur[rv.tab]), dataset: { gid: id } },
                th,
                h('div', { class: 'dup-row-text' },
                    h('div', { class: 'dup-row-name truncate', text: k.name || baseOf(k.path) }),
                    h('div', { class: 'dup-row-sub' },
                        h('span', { class: `dup-kind-dot ${g.kind}` }),
                        h('span', { text: `${formatCount(g.members.length)}개 · ${g.kindLabel}` }),
                        g.resolved ? null : h('span', { class: 'dup-row-size', text: formatBytes(bytesOf(g)) }))),
                d ? h('span', { class: `dup-row-state ${d}`, text: DECISION_LABEL[d] || '' }) : null);
            row.addEventListener('click', () => select(id));
            return row;
        }

        function select(id, { keepMode = false } = {}) {
            if (!els || c.view !== 'review') return; // the view changed while we were waiting
            const rv = c.rv;
            const prevIds = tabIds(rv.tab);
            const prev = prevIds.indexOf(rv.cur[rv.tab]);
            rv.cur[rv.tab] = id;
            if (!keepMode) rv.mode = 'grid';
            const ids = tabIds(rv.tab);
            const idx = ids.indexOf(id);
            if (prev >= 0) els.list.update(prev);
            if (idx >= 0) {
                els.list.update(idx);
                els.list.scrollToIndex(idx);
            }
            renderDetail();
        }

        function step(d) {
            if (!els || c.view !== 'review') return; // the view changed while we were waiting
            const rv = c.rv;
            const ids = tabIds(rv.tab);
            if (!ids.length) return;
            const i = ids.indexOf(rv.cur[rv.tab]);
            const j = Math.max(0, Math.min(ids.length - 1, (i < 0 ? 0 : i) + d));
            if (j !== i) select(ids[j], { keepMode: true });
        }

        /** After a decision: the next group not decided yet (wraps), else stay. */
        function advance() {
            if (!els || c.view !== 'review') return; // the view changed while we were waiting
            const rv = c.rv;
            const ids = tabIds(rv.tab);
            const i = Math.max(0, ids.indexOf(rv.cur[rv.tab]));
            const next = [...ids.slice(i + 1), ...ids.slice(0, i)].find((id) => !isDone(id));
            if (next) select(next);
            else {
                els.list.refresh();
                syncChrome();
                renderDetail();
            }
        }

        function decide(g, decision) {
            const rv = c.rv;
            rv.decisions.set(g.id, decision);
            if (rv.persist) D().setReviewed(rv.result.id, g.id, decision);
        }

        // ---------- detail ----------
        function clearDetail() {
            for (const fn of detailCleanup.splice(0)) {
                try {
                    fn();
                } catch (e) {
                    /* ignore */
                }
            }
            sync = null;
        }

        function renderDetail() {
            if (!els || c.view !== 'review') return; // the view changed while we were waiting
            clearDetail();
            const rv = c.rv;
            const box = els.detail;
            box.innerHTML = '';
            const g = curGroup();
            if (!g) {
                const other = rv.tab === 'sure' ? 'unsure' : 'sure';
                const left = tabIds(other).filter((id) => !isDone(id)).length;
                box.append(h('div', { class: 'org-empty-state dup-done' },
                    h('div', { class: 'org-empty-art good', html: icon('check-circle', 30) }),
                    h('h4', { text: rv.tab === 'sure' ? '확실한 묶음이 없어요' : '애매한 묶음이 없어요' }),
                    left ? btn({ label: `${other === 'sure' ? '확실' : '애매'} 묶음 ${formatCount(left)}개 보기`, kind: 'sm', onClick: () => switchTab(other) }) : null));
                return;
            }
            if (!tabIds(rv.tab).some((id) => !isDone(id)) && g.resolved) {
                // everything in this tab is done
                const other = rv.tab === 'sure' ? 'unsure' : 'sure';
                const left = tabIds(other).filter((id) => !isDone(id)).length;
                box.append(h('div', { class: 'dup-alldone' },
                    h('span', { class: 'dup-alldone-ico', html: icon('check-circle', 22) }),
                    h('b', { text: `${rv.tab === 'sure' ? '확실한' : '애매한'} 묶음을 모두 확인했어요` }),
                    left ? btn({ label: `${other === 'sure' ? '확실' : '애매'} 묶음 ${formatCount(left)}개 이어서 보기`, kind: 'sm primary', onClick: () => switchTab(other) }) : h('span', { class: 'faint', text: '휴지통을 비우기 전까지는 Ctrl+Z나 휴지통에서 되살릴 수 있어요' })));
            }
            const keep = keeperOf(g);
            const focus = focusOf(g);
            const keeperM = g.members.find((m) => m.path === keep);
            const focusM = g.members.find((m) => m.path === focus);
            const ev = keeperM && focusM && keeperM !== focusM ? E().pairEvidence(g, keep, focus, store.rules()) : null;
            const rules = store.rules();

            // head
            const pairLabel = keeperM && focusM && keeperM !== focusM ? `${g.members.indexOf(keeperM) + 1} ↔ ${g.members.indexOf(focusM) + 1} · ` : '';
            const evText = pairLabel + (() => {
                if (g.kind === 'exact') return `파일 내용이 완전히 같아요 · ${formatBytes(keeperM?.size || 0)}`;
                if (!ev) return g.kindLabel;
                if (ev.kind === 'exact') return '파일 내용이 완전히 같아요';
                if (ev.kind === 'video') {
                    const fr = (ev.frames || []).filter((f) => f.bits != null);
                    const ok = fr.filter((f) => f.bits <= rules.frameBits).length;
                    return `장면 ${fr.length}곳 중 ${ok}곳 일치 · 길이 차이 ${(ev.dDur ?? Math.abs((keeperM.dur || 0) - (focusM.dur || 0))).toFixed(2)}초`;
                }
                if (ev.kind === 'image') return `생김새 ${Math.round((1 - (ev.d || 0) / 64) * 100)}% 비슷 (${ev.d}비트 차이)`;
                return '로컬 서버가 같다고 판단했어요';
            })();
            const resolvedNote = g.resolved ? h('div', { class: `dup-resolved-note ${g.resolved}` },
                h('span', { html: icon(g.resolved === 'applied' ? 'trash' : g.resolved === 'notdup' ? 'x-circle' : 'eye-off', 15) }),
                h('span', { text: g.resolved === 'applied' ? '이 묶음은 정리했어요. Ctrl+Z나 휴지통에서 되살릴 수 있어요.' : g.resolved === 'notdup' ? '중복 아님으로 표시한 묶음이에요. 다시 찾아도 묶지 않아요.' : g.resolved === 'excluded' ? '파일을 중복검사에서 빼서 묶음이 풀렸어요.' : '파일이 옮겨지거나 지워져서 묶음이 풀렸어요.' }),
                g.resolved !== 'gone' ? btn({ label: '되돌리기', kind: 'ghost sm', icon: 'undo', keys: 'Mod+Z', onClick: () => App.undo.undo() }) : null) : null;
            const notDupBtn = btn({ label: '중복 아님', kind: 'sm', icon: 'x-circle', tip: '이 묶음은 다음부터 묶지 않아요', keys: 'D', onClick: () => notDup(g) });
            const applyBtn = btn({ label: `이 묶음 정리 · ${formatBytes(bytesOf(g))}`, kind: 'sm primary', icon: 'check', tip: '고른 파일만 남기고 나머지는 휴지통으로', keys: 'Enter', onClick: () => applyOne(g) });
            if (g.resolved) {
                notDupBtn.disabled = true;
                applyBtn.disabled = true;
            } else if (!removing(g).length) {
                applyBtn.disabled = true;
                kit.setBtnLabel(applyBtn, '지울 파일이 없어요');
            }
            box.append(h('div', { class: 'dup-dhead' },
                h('span', { class: `badge dup-sure ${g.sure ? 'sure' : 'unsure'}`, text: g.sure ? '확실' : '애매' }),
                h('div', { class: 'dup-dhead-text' },
                    h('div', { class: 'dup-dtitle' }, h('span', { text: g.kindLabel }), h('span', { class: 'dup-dcount', text: `${formatCount(g.members.length)}개` })),
                    h('div', { class: 'dup-dsub', text: evText })),
                h('div', { class: 'grow' }),
                notDupBtn,
                applyBtn));
            if (resolvedNote) box.append(resolvedNote);
            if (!g.resolved && keeperM) {
                const ch = rv.choice.get(g.id);
                const why = ch && ch.keep && ch.keep !== g.keep ? '직접 고른 파일을 남겨요' : g.why;
                box.append(h('div', { class: 'dup-why' }, h('span', { class: 'dup-why-ico', html: icon('check', 13) }), h('span', null, h('b', { text: keeperM.name || baseOf(keeperM.path) }), h('span', { text: ` 남겨요 — ${why}` }))));
                const up = upgradeOf(g);
                if (up) {
                    const better = resOf(up.best) !== resOf(up.keeper) ? `해상도 ${resOf(up.best)}` : `길이 ${formatDuration(up.best.dur || 0)}`;
                    box.append(h('div', { class: 'dup-upgrade' },
                        h('span', { class: 'dup-upgrade-ico', html: icon('sparkles', 14) }),
                        h('span', { class: 'dup-upgrade-text' }, h('b', { text: `더 좋은 화질(${better})이 다른 폴더에 있어요. ` }), h('span', { text: `‘${kit.folderLabel(up.into)}’ 보관 폴더로 옮겨서 남기고, 나머지는 정리할 수 있어요.` })),
                        btn({ label: '옮겨서 남기기', kind: 'sm', icon: 'folder-input', tip: '더 좋은 파일을 보관 폴더로 옮기고 나머지는 휴지통으로 (Ctrl+Z로 되돌려요)', keys: 'U', onClick: () => applyUpgrade(g) })));
                }
            }

            // stage
            const stage = h('div', { class: `dup-stage ${rv.mode === 'ab' ? 'ab' : 'grid'}${g.members.length > 3 ? ' many' : ''}` });
            const best = {
                res: Math.max(...g.members.map((m) => (m.w || 0) * (m.h || 0))),
                dur: Math.max(...g.members.map((m) => Math.round(m.dur || 0))),
                size: Math.max(...g.members.map((m) => m.size || 0)),
            };
            const players = [];
            const ordered = [...g.members].sort((a, b) => (a.path === keep ? -1 : b.path === keep ? 1 : a.path === focus ? -1 : b.path === focus ? 1 : 0));
            const numberOf = new Map(g.members.map((m, i) => [m.path, i + 1]));
            const LIMIT = 8;
            const shown = rv.expanded.has(g.id) || rv.mode === 'ab' ? ordered : ordered.slice(0, LIMIT);
            for (const m of shown) {
                const card = memberCard(g, m, { keep, focus, best, rules, players, number: numberOf.get(m.path) });
                stage.append(card);
            }
            if (shown.length < ordered.length) {
                const more = h('button', { type: 'button', class: 'dup-more-members' },
                    h('span', { class: 'dup-more-n', text: `+${formatCount(ordered.length - shown.length)}` }),
                    h('span', { text: '개 더 보기' }));
                more.addEventListener('click', () => {
                    rv.expanded.add(g.id);
                    rerender();
                });
                stage.append(more);
            }
            box.append(stage);

            // player bar (videos)
            const vids = players.filter((p) => p.video);
            if (vids.length && !g.resolved) box.append(playerBar(g, vids));
            if (rv.mode === 'ab') applyAB(stage);
            prefetchNext();
        }

        const prefetchNext = App.util.debounce(() => {
            const rv = c.rv;
            if (!rv || rv.result.engine === 'server') return;
            const ids = tabIds(rv.tab);
            const i = ids.indexOf(rv.cur[rv.tab]);
            const next = ids.slice(i + 1).find((id) => !isDone(id));
            const g = next && rv.byId.get(next);
            if (!g) return;
            for (const m of g.members.slice(0, 4)) if (m.type === 'video' && !m.root) E().frameBlobs(m).catch(() => {});
        }, 600);

        function memberCard(g, m, { keep, focus, best, rules, players, number }) {
            const rv = c.rv;
            const st = g.resolved ? 'none' : stateOf(g, m.path);
            const isKeep = m.path === keep;
            const role = m.role || store.roleOf(m.path);
            const card = h('div', { class: `dup-member st-${st}${m.path === focus ? ' focused' : ''}${isKeep ? ' is-keep' : ''}`, dataset: { path: m.path } });
            if (rv.mode === 'ab') card.classList.add(isKeep ? 'ab-a' : m.path === focus ? 'ab-b' : 'ab-off');
            const pill = h('button', { type: 'button', class: `dup-state ${st}`, 'data-tip': isKeep ? '남길 파일이에요' : st === 'remove' ? '눌러서 지우지 않고 그대로 두기' : '눌러서 지울 목록에 넣기' });
            pill.innerHTML = st === 'keep' ? `${icon('check', 12)}<span>남김</span>` : st === 'remove' ? `${icon('trash', 12)}<span>지움</span>` : st === 'leave' ? '<span>그대로</span>' : '<span>—</span>';
            pill.addEventListener('click', (e) => {
                e.stopPropagation();
                if (g.resolved || isKeep) return;
                toggleLeave(g, m.path);
            });
            const more = btn({ icon: 'more', kind: 'ghost icon sm', aria: '이 파일 메뉴', tip: '이 파일 메뉴' });
            more.addEventListener('click', (e) => {
                e.stopPropagation();
                memberMenu(g, m, more);
            });
            const head = h('div', { class: 'dup-mhead' },
                h('span', { class: 'kbd dup-mnum', text: String(number), 'data-tip': `${number} 누르면 이 파일을 남겨요` }),
                pill,
                role ? h('span', { class: `dup-role-badge ${role}`, text: role === 'keep' ? '보관 폴더' : '정리 폴더' }) : null,
                m.side && m.side !== 'ab' ? h('span', { class: `dup-side-badge side-${m.side}`, text: m.side.toUpperCase() }) : null,
                m.root ? h('span', { class: 'dup-role-badge ext', text: '다른 드라이브' }) : null,
                rv.mode === 'ab' && (isKeep || m.path === focus) ? h('span', { class: `dup-ab-label ${isKeep ? 'a' : 'b'}`, text: isKeep ? 'A · 남길 파일' : 'B · 비교하는 파일', 'data-tip': 'A를 누르면 A와 B를 번갈아 봐요', 'data-tip-keys': 'A' }) : null,
                h('div', { class: 'grow' }),
                !isKeep && !g.resolved ? btn({ label: '이걸 남기기', kind: 'ghost sm', onClick: (e) => {
                    e.stopPropagation();
                    setKeep(g, m.path);
                } }) : null,
                more);
            const media = h('div', { class: 'dup-mmedia' });
            fillMedia(g, m, media, players);
            const facts = h('div', { class: 'dup-mfacts' },
                fact('해상도', resOf(m) || '—', m.w && (m.w * m.h) === best.res && g.members.some((x) => (x.w || 0) * (x.h || 0) < best.res)),
                m.type === 'video' ? fact('길이', m.dur ? formatDuration(m.dur) + (m.dur < 60 ? ` (${m.dur.toFixed(1)}초)` : '') : '—', m.dur && Math.round(m.dur) === best.dur && g.members.some((x) => Math.round(x.dur || 0) < best.dur)) : null,
                fact('크기', formatBytes(m.size || 0), (m.size || 0) === best.size && g.members.some((x) => (x.size || 0) < best.size)),
                fact('날짜', m.mtime ? formatDate(m.mtime) : '—', false));
            const name = h('div', { class: 'dup-mname truncate', text: m.name || baseOf(m.path), title: m.path });
            const folder = h('div', { class: 'dup-mfolder truncate', title: m.path }, h('span', { html: icon(m.root ? 'hard-drive' : 'folder', 12) }), h('span', { text: folderLabelOf(m) }));
            card.append(head, media, name, folder, facts);
            if (m.type === 'video' && (g.kind !== 'image')) card.append(frameStrip(g, m, keep, rules));
            else if (g.kind === 'image' && !isKeep) {
                const ev = E().pairEvidence(g, keep, m.path, rules);
                if (ev && ev.kind === 'image') card.append(h('div', { class: 'dup-likeness', text: `남길 사진과 ${ev.d}비트 차이 · ${Math.round((1 - ev.d / 64) * 100)}% 비슷` }));
                else if (ev && ev.kind === 'exact') card.append(h('div', { class: 'dup-likeness ok', html: `${icon('check', 12)}<span>남길 사진과 파일 내용이 똑같아요</span>` }));
            }
            card.addEventListener('click', () => {
                if (m.path === keep || g.resolved) return;
                rv.focus.set(g.id, m.path);
                for (const x of card.parentElement.children) x.classList.toggle('focused', x === card);
                if (rv.mode === 'ab') rerender();
            });
            return card;
        }

        function fact(k, v, bestMark) {
            return h('div', { class: 'dup-fact' }, h('span', { class: 'k', text: k }), h('span', { class: `v${bestMark ? ' best' : ''}`, text: v }), bestMark ? h('span', { class: 'dup-best', text: '최고' }) : null);
        }

        function fillMedia(g, m, box, players) {
            const ent = entryOf(m);
            if (m.root) {
                const sd = App.server?.dupes;
                if (sd && typeof sd.frameUrl === 'function') box.append(h('img', { src: sd.frameUrl(m.path, (m.dur || 0) * 0.5), alt: '', draggable: 'false' }));
                else box.append(h('div', { class: 'dup-mmedia-ph', html: icon('hard-drive', 22) }));
                box.append(h('span', { class: 'dup-mmedia-note', text: '다른 드라이브 파일은 장면만 볼 수 있어요' }));
                return;
            }
            if (m.type === 'video') {
                const canPlay = App.util.browserCanDecode(m.name || baseOf(m.path)) || App.server?.canStream?.();
                if (!canPlay) {
                    box.append(kit.thumb(ent, { cls: 'dup-mthumb', size: 480 }), h('span', { class: 'dup-mmedia-note', text: '브라우저가 이 형식을 재생하지 못해요' }));
                    return;
                }
                const v = h('video', { muted: true, playsinline: true, preload: 'metadata' });
                v.muted = true;
                const poster = kit.thumb(ent, { cls: 'dup-mposter', size: 480 });
                box.append(poster, v);
                const rec = { path: m.path, video: v, dur: m.dur || 0, member: m };
                players.push(rec);
                let release = null;
                (async () => {
                    try {
                        if (App.util.browserCanDecode(m.name || baseOf(m.path))) {
                            const src = await App.fs.url(m.path);
                            release = src.release;
                            if (!box.isConnected) return src.release();
                            v.src = src.url;
                        } else {
                            v.src = App.server.streamUrl(m.path);
                        }
                    } catch (e) {
                        box.append(h('span', { class: 'dup-mmedia-note', text: '열 수 없어요' }));
                    }
                })();
                v.addEventListener('loadeddata', () => poster.classList.add('hidden'), { once: true });
                v.addEventListener('click', (e) => {
                    e.stopPropagation();
                    sync?.toggle();
                });
                detailCleanup.push(() => {
                    v.pause();
                    v.removeAttribute('src');
                    try {
                        v.load();
                    } catch (e) {
                        /* gone */
                    }
                    release && release();
                });
                return;
            }
            if (App.util.browserCanDecode(m.name || baseOf(m.path))) {
                const img = h('img', { alt: m.name || '', draggable: 'false', decoding: 'async' });
                box.append(img);
                App.fs.url(m.path).then((src) => {
                    if (!box.isConnected) return src.release();
                    img.src = src.url;
                    detailCleanup.push(src.release);
                }).catch(() => {});
            } else box.append(kit.thumb(ent, { cls: 'dup-mthumb', size: 480 }));
        }

        function frameStrip(g, m, keep, rules) {
            const strip = h('div', { class: 'dup-strip' });
            const isKeep = m.path === keep;
            const ev = !isKeep ? E().pairEvidence(g, keep, m.path, rules) : null;
            const urls = [];
            const cells = E().POSITIONS.map((pos, i) => {
                let mark = null;
                if (isKeep) mark = h('span', { class: 'dup-fmark base', text: '기준' });
                else if (ev && ev.kind === 'exact') mark = h('span', { class: 'dup-fmark ok', html: `${icon('check', 10)}<span>같음</span>` });
                else if (ev && ev.frames && ev.frames[i]) {
                    const bits = ev.frames[i].bits;
                    if (bits == null) mark = h('span', { class: 'dup-fmark flat', text: '단색', 'data-tip': '거의 한 색이라 비교하지 않았어요' });
                    else mark = h('span', { class: `dup-fmark ${bits <= rules.frameBits ? 'ok' : 'bad'}`, html: `${icon(bits <= rules.frameBits ? 'check' : 'x', 10)}<span>${bits}비트</span>`, 'data-tip': `64비트 중 ${bits}비트 다름 (${rules.frameBits}비트 이하면 같은 장면)` });
                } else mark = h('span', { class: 'dup-fmark none', text: '—' });
                const img = h('div', { class: 'dup-fimg' });
                const cell = h('button', { type: 'button', class: 'dup-fcell', 'data-tip': `${POS_LABEL[i]} 지점으로 함께 이동`, 'aria-label': `${POS_LABEL[i]} 지점` }, img, h('span', { class: 'dup-fpos', text: POS_LABEL[i] }), mark);
                cell.addEventListener('click', (e) => {
                    e.stopPropagation();
                    sync?.seekFrac(pos, true);
                });
                return { cell, img };
            });
            for (const x of cells) strip.append(x.cell);
            detailCleanup.push(() => urls.forEach((u) => URL.revokeObjectURL(u)));
            const sd = App.server?.dupes;
            if ((m.root || c.rv.result.engine === 'server') && sd && typeof sd.frameUrl === 'function' && m.dur) {
                cells.forEach((x, i) => x.img.append(h('img', { src: sd.frameUrl(m.path, m.dur * E().POSITIONS[i]), alt: '', draggable: 'false', loading: 'lazy' })));
            } else if (!m.root) {
                E().frameBlobs(m).then((blobs) => {
                    if (!strip.isConnected || !blobs) return;
                    blobs.forEach((b, i) => {
                        if (!b) return;
                        const u = URL.createObjectURL(b);
                        urls.push(u);
                        cells[i].img.append(h('img', { src: u, alt: '', draggable: 'false' }));
                    });
                }).catch(() => {});
            }
            return strip;
        }

        // ---------- synchronized playback ----------
        function playerBar(g, vids) {
            const rv = c.rv;
            const keep = keeperOf(g);
            vids.sort((a, b) => (a.path === keep ? -1 : b.path === keep ? 1 : 0));
            const master = vids[0];
            const playBtn = btn({ icon: 'play', kind: 'sm primary icon', tip: '함께 재생 / 멈춤', keys: 'Space', aria: '함께 재생' });
            const scrub = h('input', { type: 'range', min: '0', max: '1000', value: '0', class: 'dup-scrub', 'aria-label': '재생 위치' });
            const time = h('span', { class: 'dup-time', text: '0:00' });
            const posBtns = E().POSITIONS.map((pos, i) => {
                const b = h('button', { type: 'button', class: 'dup-pos-btn', text: POS_LABEL[i], 'data-tip': '두 영상을 이 지점으로', 'data-tip-keys': 'F' });
                b.addEventListener('click', () => s.seekFrac(pos, true));
                return b;
            });
            const modeSeg = kit.seg([{ value: 'grid', label: '나란히' }, { value: 'ab', label: 'A/B' }], rv.mode, (v) => {
                rv.mode = v;
                rerender();
            });
            modeSeg.el.classList.add('sm');
            const audioBtn = btn({ label: '', kind: 'ghost sm', icon: 'volume', tip: '소리 나는 쪽 바꾸기', keys: 'M' });
            const bar = h('div', { class: 'dup-player' }, playBtn, scrub, time, h('div', { class: 'dup-pos' }, ...posBtns), h('div', { class: 'grow' }), modeSeg.el, audioBtn);
            let posIdx = -1;
            let correcting = false;
            const fracOf = (p) => (p.video.duration && Number.isFinite(p.video.duration) ? p.video.duration : p.dur) || 1;
            const s = {
                playing: false,
                toggle() {
                    if (master.video.paused) s.play();
                    else s.pause();
                },
                play() {
                    for (const p of vids) p.video.play().catch(() => {});
                },
                pause() {
                    for (const p of vids) p.video.pause();
                },
                seekFrac(f, exact) {
                    for (const p of vids) {
                        const d = fracOf(p);
                        p.video.currentTime = Math.max(0, Math.min(d - 0.05, f * d));
                    }
                    if (exact) posIdx = E().POSITIONS.indexOf(f);
                },
                nextPos(dir = 1) {
                    posIdx = (posIdx + dir + 5) % 5;
                    s.seekFrac(E().POSITIONS[posIdx], true);
                    posBtns.forEach((b, i) => b.classList.toggle('on', i === posIdx));
                },
                audio() {
                    rv.audible = (rv.audible + 1) % (vids.length + 1);
                    applyAudio();
                },
            };
            function applyAudio() {
                if (rv.audible > vids.length) rv.audible = 0;
                vids.forEach((p, i) => (p.video.muted = rv.audible !== i + 1));
                const who = rv.audible ? (rv.audible === 1 ? 'A (남김)' : `${String.fromCharCode(64 + rv.audible)}`) : '끔';
                kit.setBtnLabel(audioBtn, `소리: ${who}`);
            }
            audioBtn.addEventListener('click', () => s.audio());
            playBtn.addEventListener('click', () => s.toggle());
            applyAudio();
            const mv = master.video;
            const onPlay = () => {
                playBtn.innerHTML = icon('pause', 15);
                for (const p of vids.slice(1)) if (p.video.paused) p.video.play().catch(() => {});
            };
            const onPause = () => {
                playBtn.innerHTML = icon('play', 15);
                for (const p of vids.slice(1)) if (!p.video.paused) p.video.pause();
            };
            const onTime = () => {
                const d = fracOf(master);
                const f = mv.currentTime / d;
                if (document.activeElement !== scrub) scrub.value = String(Math.round(f * 1000));
                time.textContent = `${formatDuration(mv.currentTime)} / ${formatDuration(d)}`;
                if (correcting) return;
                for (const p of vids.slice(1)) {
                    const want = f * fracOf(p);
                    if (Math.abs(p.video.currentTime - want) > 0.35) {
                        correcting = true;
                        p.video.currentTime = want;
                        setTimeout(() => (correcting = false), 300);
                    }
                }
            };
            const onSeeked = () => {
                const f = mv.currentTime / fracOf(master);
                for (const p of vids.slice(1)) {
                    const want = f * fracOf(p);
                    if (Math.abs(p.video.currentTime - want) > 0.08) p.video.currentTime = want;
                }
            };
            mv.addEventListener('play', onPlay);
            mv.addEventListener('pause', onPause);
            mv.addEventListener('timeupdate', onTime);
            mv.addEventListener('seeked', onSeeked);
            scrub.addEventListener('input', () => s.seekFrac(Number(scrub.value) / 1000));
            scrub.addEventListener('change', () => scrub.blur()); // keyboard flow (←/→ = groups) continues after a drag
            detailCleanup.push(() => {
                mv.removeEventListener('play', onPlay);
                mv.removeEventListener('pause', onPause);
                mv.removeEventListener('timeupdate', onTime);
                mv.removeEventListener('seeked', onSeeked);
            });
            playBtn.innerHTML = icon('play', 15);
            sync = s;
            return bar;
        }

        function applyAB(stage) {
            const rv = c.rv;
            stage.classList.toggle('show-b', rv.abSide === 'b');
            stage.classList.toggle('show-a', rv.abSide !== 'b');
        }

        function flipAB() {
            if (!els || c.view !== 'review') return; // the view changed while we were waiting
            const rv = c.rv;
            if (rv.mode !== 'ab') {
                rv.mode = 'ab';
                rv.abSide = 'b';
                rerender();
                return;
            }
            rv.abSide = rv.abSide === 'b' ? 'a' : 'b';
            const stage = els.detail.querySelector('.dup-stage');
            if (stage) applyAB(stage);
        }

        function rerender() {
            if (!els || c.view !== 'review') return; // the view changed while we were waiting
            // keep the playback position across a re-render
            const v = els?.detail.querySelector('.dup-member.is-keep video');
            const t = v ? v.currentTime : 0;
            const playing = v ? !v.paused : false;
            renderDetail();
            if (t && sync) {
                const nv = els.detail.querySelector('.dup-member.is-keep video');
                if (nv) {
                    const go = () => {
                        const d = Number.isFinite(nv.duration) ? nv.duration : 0;
                        if (d) sync.seekFrac(t / d);
                        if (playing) sync.play();
                    };
                    if (nv.readyState >= 1) go();
                    else nv.addEventListener('loadedmetadata', go, { once: true });
                }
            }
            const ids = tabIds(c.rv.tab);
            const i = ids.indexOf(c.rv.cur[c.rv.tab]);
            if (i >= 0) els.list.update(i);
            syncChrome();
        }

        // ---------- decisions ----------
        function setKeep(g, p) {
            if (g.resolved) return;
            const ch = choiceOf(g);
            const old = keeperOf(g);
            ch.keep = p;
            ch.leave.delete(p);
            if (old !== p) ch.leave.delete(old);
            if (c.rv.focus.get(g.id) === p) c.rv.focus.set(g.id, old);
            if (!c.rv.decisions.has(g.id)) decide(g, 'keep');
            saveChoice(g);
            rerender();
        }

        function toggleLeave(g, p) {
            if (g.resolved || p === keeperOf(g)) return;
            const ch = choiceOf(g);
            if (ch.leave.has(p)) ch.leave.delete(p);
            else ch.leave.add(p);
            saveChoice(g);
            rerender();
        }

        /** The keeper / '그대로' choices are part of the saved review progress (restored when you come back). */
        function saveChoice(g) {
            const rv = c.rv;
            if (!rv.persist) return;
            const ch = rv.choice.get(g.id);
            D().setReviewed(rv.result.id, g.id, rv.decisions.get(g.id) || null, ch ? { keep: ch.keep || null, leave: [...ch.leave] } : null);
        }

        async function notDup(g) {
            if (!g || g.resolved) return;
            if (g.members.length > 40) {
                ui.toast(`묶음이 커요(${formatCount(g.members.length)}개). ‘중복 아님’ 대신 X로 파일을 빼거나 Shift+X로 폴더를 검사에서 빼 주세요`, { type: 'info', duration: 6000 });
                return;
            }
            const paths = g.members.map((m) => m.path);
            decide(g, 'notdup');
            await D().markNotDuplicate(paths, true);
            ui.toast('중복 아님으로 기억할게요 · 다음부터 묶지 않아요', { type: 'info', action: { label: '실행 취소', run: () => App.undo.undo() } });
            advance();
        }

        async function excludeMember(g, path, { folder = false } = {}) {
            if (!g || g.resolved) return;
            const m = g.members.find((x) => x.path === path);
            if (!m) return;
            if (folder) {
                const dir = m.root ? parentOf(m.path) : P.parent(m.path);
                if (!dir) {
                    ui.toast('작업 폴더 전체는 뺄 수 없어요', { type: 'info' });
                    return;
                }
                await D().excludeFolders([dir], true);
                ui.toast(`‘${m.root ? dir : kit.folderLabel(dir)}’ 폴더를 중복검사에서 뺐어요`, { type: 'info', action: { label: '실행 취소', run: () => App.undo.undo() } });
            } else {
                await D().excludeFiles([path], true);
                ui.toast(`‘${m.name || baseOf(path)}’ 파일을 중복검사에서 뺐어요`, { type: 'info', action: { label: '실행 취소', run: () => App.undo.undo() } });
            }
            if (c.view !== 'review' || !c.rv) return;
            assembleAll();
            const still = c.rv.byId.get(g.id);
            if (still && still.resolved) {
                // the group dissolved: decided, move on
                decide(g, 'excluded');
                still.resolved = 'excluded';
                els.list.refresh();
                advance();
            } else {
                els.list.refresh();
                refreshAll();
            }
        }

        function memberMenu(g, m, anchor) {
            const keep = keeperOf(g);
            const isKeep = m.path === keep;
            const st = stateOf(g, m.path);
            const role = store.roleEntry(m.path);
            const dir = m.root ? parentOf(m.path) : P.parent(m.path);
            const items = [
                { header: m.name || baseOf(m.path) },
                !isKeep && !g.resolved ? { label: '이 파일 남기기', icon: 'check', hint: String(g.members.indexOf(m) + 1), action: () => setKeep(g, m.path) } : null,
                !isKeep && !g.resolved ? { label: st === 'remove' ? '지우지 않고 그대로 두기' : '지울 목록에 넣기', icon: st === 'remove' ? 'eye' : 'trash', action: () => toggleLeave(g, m.path) } : null,
                '-',
                !g.resolved && g.members.length > 2 ? { label: '이 파일만 중복 아님', icon: 'x-circle', action: async () => {
                    await D().markNotDuplicate(g.members.filter((x) => x !== m).map((x) => [m.path, x.path]), true);
                    ui.toast('이 파일은 이 묶음과 중복이 아니라고 기억할게요', { type: 'info', action: { label: '실행 취소', run: () => App.undo.undo() } });
                } } : null,
                { label: '이 파일은 중복검사에서 빼기', icon: 'eye-off', hint: 'X', action: () => excludeMember(g, m.path) },
                dir ? { label: '이 폴더는 중복검사에서 빼기', icon: 'folder', hint: 'Shift+X', action: () => excludeMember(g, m.path, { folder: true }) } : null,
                '-',
                dir || dir === '' ? { label: role && role.path === dir && role.role === 'keep' ? '보관 폴더 지정 풀기' : '이 폴더를 보관 폴더로', icon: 'shield-check', action: () => D().setFolderRole(dir, role && role.path === dir && role.role === 'keep' ? null : 'keep') } : null,
                dir || dir === '' ? { label: role && role.path === dir && role.role === 'remove' ? '정리 폴더 지정 풀기' : '이 폴더를 정리 폴더로', icon: 'trash', action: () => D().setFolderRole(dir, role && role.path === dir && role.role === 'remove' ? null : 'remove') } : null,
                !m.root ? '-' : null,
                !m.root ? { label: '폴더에서 보기', icon: 'folder-open', action: () => {
                    ctx.close(null);
                    App.nav.go(P.parent(m.path), { focus: m.path });
                } } : null,
            ].filter(Boolean);
            ui.menu(items, { anchor, align: 'end' });
        }

        async function applyOne(g) {
            if (!g || g.resolved) return;
            const remove = removing(g).map((m) => m.path);
            if (!remove.length) {
                ui.toast('지울 파일이 없어요. 지울 파일의 ‘그대로’를 눌러 바꿀 수 있어요', { type: 'info' });
                return;
            }
            const clipN = remove.reduce((s, p) => s + (App.clips?.forPath?.(p)?.filter?.((x) => !x.missing).length || 0), 0);
            if (clipN) {
                const ok = await kit.sheet(ctx.box, { title: '보관함 구간이 있는 파일이에요', message: `지울 파일에 잘라 둔 구간 ${formatCount(clipN)}개가 있어요. 그래도 휴지통으로 옮길까요? 구간은 파일을 되살리면 다시 보여요.`, okLabel: '그래도 정리', icon: 'scissors', danger: true });
                if (!ok) return;
            }
            const busy = kit.busy(ctx.box, '지우기 전에 다시 확인하는 중…');
            let res;
            try {
                res = await D().apply([{ group: g, keep: keeperOf(g), remove }], { merge: App.settings.get('dupes.merge', true), scanId: c.rv.result.id });
            } finally {
                busy.close();
            }
            if (res.removed.length) {
                decide(g, 'applied');
                markGone(res.removed.map((r) => r.path));
            }
            D().reportApply(res);
            if (res.removed.length) advance();
            else refreshAll();
        }

        async function applyUpgrade(g) {
            const up = upgradeOf(g);
            if (!up) return;
            const busy = kit.busy(ctx.box, '옮기기 전에 다시 확인하는 중…');
            let res;
            try {
                res = await D().apply([upgradePlan(g, up)], { merge: App.settings.get('dupes.merge', true), scanId: c.rv.result.id, label: '더 좋은 화질을 보관 폴더로 옮기고 중복 정리' });
            } finally {
                busy.close();
            }
            if (res.removed.length || (res.moved || []).length) {
                decide(g, 'applied');
                markGone(res.removed.map((r) => r.path));
            }
            D().reportApply(res);
            if (res.removed.length) advance();
            else refreshAll();
        }

        async function applyBulk() {
            const rv = c.rv;
            const groups = liveGroups().filter((g) => g.sure && (!rv.decisions.has(g.id) || rv.decisions.get(g.id) === 'keep'));
            let upgrade = App.settings.get('dupes.upgradeToKeep', true);
            let indirect = [];
            const rules = store.rules();
            const planFor = (g) => {
                const up = upgrade && !(rv.choice.get(g.id)?.keep) ? upgradeOf(g) : null;
                const plan = up ? upgradePlan(g, up) : { group: g, keep: keeperOf(g), remove: removing(g).map((m) => m.path) };
                if (g.kind !== 'exact') {
                    // A↔B and B↔C don't prove A↔C: in bulk, a copy must match the kept file itself
                    const ok = plan.remove.filter((p) => E().directMatch(g, plan.keep, p, rules));
                    for (const p of plan.remove) if (!ok.includes(p)) indirect.push({ path: p, reason: D().REASONS.indirect, group: g.id });
                    plan.remove = ok;
                }
                return plan;
            };
            const upN = groups.filter((g) => !(rv.choice.get(g.id)?.keep) && upgradeOf(g)).length;
            let plans = groups.map(planFor).filter((p) => p.remove.length);
            const count = plans.reduce((s, p) => s + p.remove.length, 0);
            if (!count) return;
            const bytes = groups.reduce((s, g) => s + bytesOf(g), 0);
            const ext = plans.reduce((s, p) => s + p.remove.filter((x) => p.group.members.find((m) => m.path === x)?.root).length, 0);
            const mergeT = kit.toggle('지우는 파일의 칩·별점·메모를 남기는 파일로 합치기', App.settings.get('dupes.merge', true), (v) => App.settings.set('dupes.merge', v));
            const ok = await kit.sheet(ctx.box, {
                title: `확실한 묶음 ${formatCount(plans.length)}개를 정리할까요?`,
                message: `중복 ${formatCount(count)}개를 ${ext ? '휴지통(다른 드라이브는 _중복정리 폴더)' : '휴지통'}으로 옮겨요 · 비우면 ${formatBytes(bytes)} 확보. 지우기 직전에 남길 파일을 다시 확인하고, 보관함 구간이나 편집 기록이 있는 파일은 건너뛰어요. Ctrl+Z 한 번으로 모두 되돌릴 수 있어요.`,
                okLabel: '모두 휴지통으로',
                icon: 'trash',
                details: h('div', { class: 'dup-sheet-opts' }, mergeT.el, upN ? kit.toggle(`더 좋은 화질이 보관 폴더 밖에 있으면 보관 폴더로 옮겨서 남기기 (${formatCount(upN)}묶음)`, upgrade, (v) => {
                    upgrade = v;
                    App.settings.set('dupes.upgradeToKeep', v);
                }).el : null),
            });
            if (!ok) return;
            indirect = [];
            plans = groups.map(planFor).filter((p) => p.remove.length);
            const busy = kit.busy(ctx.box, '지우기 전에 다시 확인하는 중…');
            let res;
            try {
                res = await D().apply(plans, { merge: App.settings.get('dupes.merge', true), bulk: true, scanId: rv.result.id, label: `확실한 중복 ${formatCount(count)}개 정리` });
            } finally {
                busy.close();
            }
            const removed = new Set(res.removed.map((r) => r.path));
            for (const p of plans) if (p.remove.some((x) => removed.has(x))) decide(p.group, 'applied');
            markGone([...removed]);
            res.skipped = [...indirect, ...res.skipped];
            D().reportApply(res);
            refreshAll();
        }

        function markGone(paths) {
            for (const p of paths) c.rv.gone.add(p);
            assembleAll();
        }

        // ---------- keep in sync (undo/redo, exclusions, renames, other screens) ----------
        const resync = App.util.debounce(() => {
            if (c.view !== 'review' || !c.rv) return;
            assembleAll();
            els?.list.refresh();
            refreshAll();
        }, 40);

        c.cleanup.push(App.bus.on('dupes:changed', () => {
            if (c.view === 'review') resync();
        }));
        c.cleanup.push(App.bus.on('fs:changed', (ch) => {
            const rv = c.rv;
            if (c.view !== 'review' || !rv) return;
            const paths = new Set(ch.paths || []);
            const hit = (p) => {
                for (let q = p; ; q = P.parent(q)) {
                    if (paths.has(q)) return true;
                    if (!q) return false;
                }
            };
            let changed = false;
            if (ch.type === 'trash' || ch.type === 'delete') {
                for (const m of rv.result.raw.items) if (!m.root && !rv.gone.has(m.path) && hit(m.path)) {
                    rv.gone.add(m.path);
                    changed = true;
                }
            } else if (ch.from && ch.to && (ch.type === 'move' || ch.type === 'rename')) {
                const pairs = ch.from.map((f, i) => [f, ch.to[i]]);
                const rb = D().rebaseResult(rv.result, pairs);
                if (rb.changed) {
                    changed = true;
                    const fix = (p) => {
                        let cur = p;
                        for (const [f, t] of pairs) {
                            const r = P.rebase(cur, f, t);
                            if (r != null) cur = r;
                        }
                        return cur;
                    };
                    remapIds(rb.idMap);
                    for (const ch2 of rv.choice.values()) {
                        if (ch2.keep) ch2.keep = fix(ch2.keep);
                        ch2.leave = new Set([...ch2.leave].map(fix));
                    }
                    rv.gone = new Set([...rv.gone].map(fix));
                    if (rv.persist) E().cache.putResult(rv.result).catch(() => {});
                }
            } else if (ch.type === 'restore' || ch.type === 'create' || ch.type === 'copy') {
                for (const p of [...rv.gone]) if (hit(p)) {
                    rv.gone.delete(p);
                    changed = true;
                }
            }
            if (changed) resync();
        }));

        /** Group ids come from member paths: after a rename, carry the review state over to the new ids. */
        function remapIds(idMap) {
            const rv = c.rv;
            if (!idMap || !idMap.size) return;
            const mv = (map) => {
                for (const [from, to] of idMap) {
                    if (!map.has(from)) continue;
                    map.set(to, map.get(from));
                    map.delete(from);
                }
            };
            mv(rv.decisions);
            mv(rv.choice);
            mv(rv.focus);
            for (const [from, to] of idMap) {
                if (rv.expanded.has(from)) {
                    rv.expanded.delete(from);
                    rv.expanded.add(to);
                }
                const g = rv.byId.get(from);
                if (g) {
                    rv.byId.delete(from);
                    g.id = to;
                    rv.byId.set(to, g);
                }
            }
            rv.order = rv.order.map((id) => idMap.get(id) || id);
            for (const tab of ['sure', 'unsure']) if (idMap.has(rv.cur[tab])) rv.cur[tab] = idMap.get(rv.cur[tab]);
            if (rv.persist) D().remapReviewed(idMap);
        }

        // ---------- keyboard ----------
        ctx.onKey((e) => {
            if (c.view === 'scan' && e.key === 'Escape') {
                c.job?.cancel();
                return true;
            }
            if (c.view !== 'review' || !els) return false;
            const t = e.target;
            if (t && (t.tagName === 'INPUT' && t.type !== 'range' && t.type !== 'checkbox') || (t && (t.tagName === 'SELECT' || t.tagName === 'TEXTAREA'))) return false;
            if (e.ctrlKey || e.metaKey || e.altKey) return false;
            if (t && t.type === 'range' && /^(Arrow|Home|End|Page)/.test(e.key)) return false;
            const rv = c.rv;
            const g = curGroup();
            const k = e.key;
            const code = e.code || '';
            const is = (letter) => k.toLowerCase() === letter || code === `Key${letter.toUpperCase()}`;
            if (k === 'Escape' && rv.mode === 'ab') {
                rv.mode = 'grid';
                rerender();
                return true;
            }
            if (k === 'ArrowRight' || k === 'ArrowLeft') {
                step(k === 'ArrowRight' ? 1 : -1);
                return true;
            }
            if (k === 'Home' || k === 'End') {
                const ids = tabIds(rv.tab);
                if (ids.length) select(k === 'Home' ? ids[0] : ids[ids.length - 1]);
                return true;
            }
            if (!g) return false;
            if (k === 'ArrowDown' || k === 'ArrowUp') {
                const keep = keeperOf(g);
                const others = g.members.filter((m) => m.path !== keep);
                if (others.length > 1) {
                    const i = others.findIndex((m) => m.path === focusOf(g));
                    const n = others[(i + (k === 'ArrowDown' ? 1 : -1) + others.length) % others.length];
                    rv.focus.set(g.id, n.path);
                    rerender();
                }
                return true;
            }
            if (/^[1-9]$/.test(k) || /^Digit[1-9]$/.test(code)) {
                const n = Number(/^[1-9]$/.test(k) ? k : code.slice(5));
                const m = g.members[n - 1];
                if (m && !g.resolved) setKeep(g, m.path);
                return true;
            }
            if (k === ' ' || code === 'Space') {
                if (t && t.tagName === 'BUTTON' && !t.classList.contains('dup-state')) return false;
                sync?.toggle();
                return true;
            }
            if (k === 'Enter') {
                if (t && t.tagName === 'BUTTON' && t !== els.list.el) return false;
                applyOne(g);
                return true;
            }
            if (is('d')) {
                notDup(g);
                return true;
            }
            if (is('x')) {
                excludeMember(g, focusOf(g), { folder: e.shiftKey });
                return true;
            }
            if (is('a')) {
                flipAB();
                return true;
            }
            if (is('g')) {
                rv.mode = 'grid';
                rerender();
                return true;
            }
            if (is('f')) {
                sync?.nextPos(e.shiftKey ? -1 : 1);
                return true;
            }
            if (is('m')) {
                sync?.audio();
                return true;
            }
            if (is('n')) {
                advance();
                return true;
            }
            if (is('u')) {
                if (upgradeOf(g)) applyUpgrade(g);
                return true;
            }
            if (is('t')) {
                switchTab(rv.tab === 'sure' ? 'unsure' : 'sure');
                return true;
            }
            return false;
        });

        // ---------- empty ----------
        function showEmpty(result) {
            c.view = 'empty';
            clearView();
            const st = result.stats || {};
            const title = result.focus ? '같은 파일을 찾지 못했어요' : '중복된 파일이 없어요';
            const text = result.focus
                ? '내용이 같거나 같은 영상인 파일이 없어요. 규칙을 느슨하게 바꾸거나 다른 범위에서 찾아볼 수 있어요.'
                : `${formatCount(st.scanned || 0)}개를 살펴봤는데 겹치는 게 없어요.${st.reused ? ` 지문 ${formatCount(st.reused)}개는 기억해 둔 걸 썼어요.` : ''}`;
            ctx.setSubtitle(`${formatCount(st.scanned || 0)}개 살펴봄 · ${ago(result.at)}`);
            ctx.main.append(h('div', { class: 'org-empty-state dup-empty' },
                h('div', { class: 'org-empty-art good', html: icon('check-circle', 30) }),
                h('h4', { text: title }),
                h('p', { text })));
            const close = btn({ label: '닫기', kind: 'primary', onClick: () => ctx.close(null) });
            ctx.foot.append(h('div', { class: 'grow' }), btn({ label: '다시 찾기', kind: 'ghost', icon: 'refresh', onClick: () => showSetup() }), close);
            close.focus();
        }

        return c;
    }

    App.dupes = App.dupes || {};
    App.dupes.ui = {
        open,
        get active() {
            return active;
        },
    };
})();
