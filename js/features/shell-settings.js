/*
 * Settings dialog (Ctrl+,), keyboard shortcut sheet (?), and the theme mode (dark / light / follow Windows).
 *
 *   App.settingsUI.open(pageId?) · close() · refresh()
 *   App.settingsUI.addPage({ id, title, icon, order, desc, render(body, kit, ctx) })
 *       Other modules add (or replace, by id) a settings page. ctx = { refresh(), close(), open(pageId) }.
 *   App.settingsUI.kit — building blocks so every page looks the same:
 *       group(title, desc) -> { el, body } · row({ label, desc, control }) · toggle({ key, fallback, onChange })
 *       select({ key, fallback, options: [{ value, label }], onChange }) · seg({ value, options, onChange })
 *       button(label, { icon, kind, onClick, tip, keys }) · note(text, { type, icon })
 *   App.help.open(query?) — the shortcut sheet; App.help.render(container, { query }) renders it anywhere.
 *
 * Preference keys owned here: theme.followSystem, workspace.autoReopen, workspace.restoreView, trash.confirm,
 * trash.retentionDays, thumbs.cacheLimitMB, thumbs.autoPregenerate, layout.autoCollapse (read by their modules).
 */
(() => {
    'use strict';
    const { h, formatBytes, formatCount } = App.util;
    const ui = App.ui;

    // =====================================================================================================
    // Theme mode
    // =====================================================================================================
    const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
    let writingTheme = false;

    const systemTheme = () => (mq && mq.matches ? 'light' : 'dark');

    function themeMode() {
        if (App.settings.get('theme.followSystem', false)) return 'system';
        return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    }

    function applyTheme(t, animate) {
        const root = document.documentElement;
        if (animate && root.dataset.theme !== t) {
            root.classList.add('shs-theme-anim');
            setTimeout(() => root.classList.remove('shs-theme-anim'), 320);
        }
        root.dataset.theme = t;
        if (App.settings.get('theme') !== t) {
            writingTheme = true;
            App.settings.set('theme', t);
            writingTheme = false;
        }
    }

    function setThemeMode(mode) {
        App.settings.set('theme.followSystem', mode === 'system');
        applyTheme(mode === 'system' ? systemTheme() : mode, true);
    }

    if (mq && mq.addEventListener) {
        mq.addEventListener('change', () => {
            if (App.settings.get('theme.followSystem', false)) applyTheme(systemTheme(), true);
        });
    }

    App.bus.on('settings:changed', ({ key, value }) => {
        // Theme switched by hand somewhere else (e.g. the theme toggle) → stop following Windows
        if (key === 'theme' && !writingTheme && App.settings.get('theme.followSystem', false) && value !== systemTheme()) {
            App.settings.set('theme.followSystem', false);
        }
        if (key === 'theme' || key === 'theme.followSystem') syncThemeControls();
    });

    // =====================================================================================================
    // Kit
    // =====================================================================================================
    const kit = {
        group(title, desc) {
            const body = h('div', { class: 'shs-group-body' });
            const el = h('section', { class: 'shs-group' },
                title ? h('div', { class: 'shs-group-title', text: title }) : null,
                desc ? h('div', { class: 'shs-group-desc', text: desc }) : null,
                body);
            return { el, body };
        },

        row({ label, desc, control, icon, stack = false }) {
            const text = h('div', { class: 'shs-row-text' },
                h('div', { class: 'shs-row-label' }, icon ? h('span', { class: 'shs-row-ico', html: ui.icon(icon, { size: 15 }) }) : null, h('span', { text: label })),
                desc ? (desc instanceof Node ? h('div', { class: 'shs-row-desc' }, desc) : h('div', { class: 'shs-row-desc', text: desc })) : null);
            return h('div', { class: `shs-row${stack ? ' stack' : ''}` }, text, control ? h('div', { class: 'shs-row-ctrl' }, control) : null);
        },

        toggle({ key, fallback = false, onChange, get, set, label }) {
            const read = get || (() => !!App.settings.get(key, fallback));
            const btn = h('button', { class: 'shs-switch', type: 'button', role: 'switch', 'aria-label': label || key });
            const sync = () => btn.setAttribute('aria-checked', String(!!read()));
            btn.addEventListener('click', () => {
                const next = !read();
                if (set) set(next);
                else App.settings.set(key, next);
                sync();
                onChange?.(next);
            });
            sync();
            btn._sync = sync;
            return btn;
        },

        select({ key, fallback, options, onChange, label }) {
            const sel = h('select', { class: 'select shs-select', 'aria-label': label || key });
            const current = App.settings.get(key, fallback);
            for (const o of options) sel.append(h('option', { value: String(o.value), text: o.label, selected: String(o.value) === String(current) }));
            sel.addEventListener('change', () => {
                const o = options.find((x) => String(x.value) === sel.value);
                const v = o ? o.value : sel.value;
                App.settings.set(key, v);
                onChange?.(v);
            });
            return sel;
        },

        seg({ value, options, onChange, label }) {
            const seg = h('div', { class: 'seg shs-seg', role: 'radiogroup', 'aria-label': label || '' });
            const sync = (v) => {
                for (const b of seg.children) {
                    const on = b.dataset.value === String(v);
                    b.classList.toggle('on', on);
                    b.setAttribute('aria-checked', String(on));
                }
            };
            for (const o of options) {
                seg.append(h('button', {
                    type: 'button',
                    role: 'radio',
                    dataset: { value: String(o.value) },
                    html: (o.icon ? ui.icon(o.icon, { size: 13 }) : '') + App.util.escapeHtml(o.label),
                    onclick: () => {
                        sync(o.value);
                        onChange?.(o.value);
                    },
                }));
            }
            sync(value);
            seg._sync = sync;
            return seg;
        },

        button(label, { icon, kind = '', onClick, tip, keys, disabled } = {}) {
            const btn = h('button', { class: `btn sm ${kind}`, type: 'button', html: (icon ? ui.icon(icon, { size: 14 }) : '') + `<span>${App.util.escapeHtml(label)}</span>`, disabled: !!disabled });
            if (tip) btn.dataset.tip = tip;
            if (keys) btn.dataset.tipKeys = keys;
            if (onClick) btn.addEventListener('click', onClick);
            return btn;
        },

        note(text, { type = 'info', icon } = {}) {
            const el = h('div', { class: `shs-note ${type}` }, h('span', { class: 'shs-note-ico', html: ui.icon(icon || (type === 'warning' ? 'alert' : type === 'success' ? 'check-circle' : 'info'), { size: 15 }) }));
            el.append(text instanceof Node ? text : h('span', { text }));
            return el;
        },

        kbd(combo) {
            return App.palette ? App.palette.kbdEl(combo, 'shs-kbd') : h('span', { class: 'kbd', text: App.commands.displayCombo(combo) });
        },
    };

    // =====================================================================================================
    // Pages
    // =====================================================================================================
    const pages = [];
    let dlg = null; // { close, nav, title, desc, scroll, current } while the dialog is open

    function addPage(page) {
        const i = pages.findIndex((p) => p.id === page.id);
        if (i >= 0) pages.splice(i, 1);
        pages.push({ order: 50, icon: 'settings', ...page });
        pages.sort((a, b) => a.order - b.order);
        if (dlg) renderNav();
    }

    let themeSeg = null;
    function syncThemeControls() {
        if (themeSeg && themeSeg.isConnected) themeSeg._sync(themeMode());
    }

    addPage({
        id: 'general',
        title: '일반',
        icon: 'sliders',
        order: 10,
        desc: '화면과 시작 방식, 안전장치를 정해요.',
        render(body, k, ctx) {
            const look = k.group('화면');
            themeSeg = k.seg({
                value: themeMode(),
                label: '테마',
                options: [
                    { value: 'dark', label: '어둡게', icon: 'moon' },
                    { value: 'light', label: '밝게', icon: 'sun' },
                    { value: 'system', label: 'Windows 설정', icon: 'monitor' },
                ],
                onChange: setThemeMode,
            });
            look.body.append(
                k.row({ label: '테마', desc: 'Windows 설정을 고르면 시스템의 밝은/어두운 모드를 따라가요.', control: themeSeg }),
                k.row({
                    label: '창이 좁으면 패널 자동으로 접기',
                    desc: '창 너비가 1100px보다 좁으면 정보 패널을, 820px보다 좁으면 사이드바를 접어서 사진을 크게 보여 줘요.',
                    control: k.toggle({ key: 'layout.autoCollapse', fallback: true, label: '패널 자동 접기', onChange: () => App.layout?.apply?.() }),
                }));

            const start = k.group('시작');
            start.body.append(
                k.row({
                    label: '지난 작업 폴더 자동으로 열기',
                    desc: '권한이 남아 있으면 바로 열고, 아니면 시작 화면에 ‘다시 열기’ 버튼을 보여 드려요.',
                    control: k.toggle({ key: 'workspace.autoReopen', fallback: true, label: '자동으로 열기' }),
                }),
                k.row({
                    label: '보던 곳에서 이어 보기',
                    desc: '작업 폴더마다 마지막 폴더·정렬·필터·선택을 기억했다가 다시 열 때 그대로 보여 줘요.',
                    control: k.toggle({ key: 'workspace.restoreView', fallback: true, label: '이어 보기' }),
                }));

            const safety = k.group('안전');
            safety.body.append(
                k.row({
                    label: '휴지통으로 옮기기 전에 확인',
                    desc: '끄면 Delete 키로 바로 휴지통에 옮겨요. 어느 쪽이든 Ctrl+Z로 되돌리고 휴지통에서 되살릴 수 있어요.',
                    control: k.toggle({ key: 'trash.confirm', fallback: false, label: '삭제 전 확인' }),
                }),
                k.row({
                    label: '실행 취소 기록',
                    desc: '최근 작업을 시간순으로 보고, 고른 작업까지 한 번에 되돌리거나 다시 실행해요.',
                    control: k.button('기록 보기', {
                        icon: 'history',
                        tip: '실행 취소 기록',
                        keys: 'Mod+Alt+Z',
                        disabled: !App.history,
                        onClick: () => {
                            ctx.close();
                            App.history?.open();
                        },
                    }),
                }));

            const help = k.group('도움말');
            help.body.append(
                k.row({ label: '시작 안내 다시 보기', desc: '폴더 트리, 칩셋, 명령 팔레트를 짧게 소개해요.', control: k.button('다시 보기', { icon: 'sparkles', onClick: () => { ctx.close(); App.onboarding?.start({ force: true }); }, disabled: !App.onboarding }) }),
                k.row({ label: '단축키', desc: '모든 단축키를 한눈에 보고 검색할 수 있어요.', control: k.button('단축키 보기', { icon: 'keyboard', onClick: () => ctx.open('shortcuts'), tip: '단축키', keys: '?' }) }));
            body.append(look.el, start.el, safety.el, help.el);
        },
    });

    addPage({
        id: 'thumbs',
        title: '썸네일',
        icon: 'image',
        order: 20,
        desc: '썸네일을 미리 만들어 두면 큰 폴더도 바로바로 보여요.',
        render(body, k, ctx) {
            const gen = k.group('만들기');
            gen.body.append(k.row({
                label: '썸네일 미리 만들기',
                desc: '작업 폴더를 열면 쉬는 동안 모든 사진·영상의 썸네일을 미리 만들어 둬요.',
                control: k.toggle({ key: 'thumbs.autoPregenerate', fallback: true, label: '미리 만들기' }),
            }));
            if (App.commands.get('thumbs.pregenerate')) {
                gen.body.append(k.row({
                    label: '지금 만들기',
                    desc: '현재 작업 폴더 전체의 썸네일을 지금 바로 만들어요.',
                    control: k.button('지금 만들기', {
                        icon: 'zap',
                        disabled: !App.commands.isEnabled('thumbs.pregenerate'),
                        onClick: () => {
                            ctx.close();
                            App.commands.run('thumbs.pregenerate');
                        },
                    }),
                }));
            }

            const cache = k.group('캐시');
            const usage = h('span', { class: 'shs-muted', text: '확인하는 중…' });
            cache.body.append(
                k.row({
                    label: '캐시 최대 크기',
                    desc: '이 크기를 넘으면 오래 안 본 썸네일부터 지워요.',
                    control: k.select({
                        key: 'thumbs.cacheLimitMB',
                        fallback: 1024,
                        label: '캐시 최대 크기',
                        options: [
                            { value: 256, label: '256 MB' },
                            { value: 512, label: '512 MB' },
                            { value: 1024, label: '1 GB' },
                            { value: 2048, label: '2 GB' },
                            { value: 4096, label: '4 GB' },
                            { value: 8192, label: '8 GB' },
                        ],
                    }),
                }),
                k.row({ label: '이 브라우저 저장 공간', desc: usage }),
                k.row({
                    label: '썸네일 캐시 비우기',
                    desc: '사진 파일은 그대로예요. 썸네일은 볼 때 다시 만들어져요.',
                    control: k.button('캐시 비우기', {
                        icon: 'trash',
                        disabled: !App.thumbs?.clearCache,
                        onClick: async (e) => {
                            const btn = e.currentTarget;
                            btn.disabled = true;
                            try {
                                await App.thumbs.clearCache();
                                App.gallery?.refresh?.();
                                ui.toast('썸네일 캐시를 비웠어요', { type: 'success' });
                            } catch (err) {
                                ui.toast(`캐시를 비우지 못했어요: ${err.message}`, { type: 'error' });
                            }
                            btn.disabled = false;
                            showUsage();
                        },
                    }),
                }));
            async function showUsage() {
                try {
                    const est = await navigator.storage.estimate();
                    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
                    usage.textContent = `${formatBytes(est.usage || 0)} 사용 중 · 남은 공간 ${formatBytes(Math.max(0, (est.quota || 0) - (est.usage || 0)))}${persisted ? ' · 영구 보관 중' : ''}`;
                } catch (e) {
                    usage.textContent = '확인할 수 없어요';
                }
            }
            showUsage();
            body.append(gen.el, cache.el);
        },
    });

    addPage({
        id: 'trash',
        title: '휴지통',
        icon: 'trash',
        order: 30,
        desc: '지운 파일은 작업 폴더 안 휴지통(.fluid-organizer/trash)에 보관돼서 언제든 되살릴 수 있어요.',
        render(body, k, ctx) {
            const keep = k.group('보관');
            keep.body.append(k.row({
                label: '휴지통 보관 기간',
                desc: '기간이 지난 항목은 작업 폴더를 열 때 정리돼요.',
                control: k.select({
                    key: 'trash.retentionDays',
                    fallback: 30,
                    label: '보관 기간',
                    options: [
                        { value: 7, label: '7일' },
                        { value: 14, label: '14일' },
                        { value: 30, label: '30일' },
                        { value: 60, label: '60일' },
                        { value: 90, label: '90일' },
                        { value: 0, label: '직접 비울 때까지' },
                    ],
                }),
            }));
            const now = k.group('지금 휴지통');
            const summary = h('span', { class: 'shs-muted', text: App.fs.ready ? '확인하는 중…' : '작업 폴더를 열면 휴지통 상태가 보여요.' });
            const actions = h('div', { class: 'shs-actions' });
            now.body.append(k.row({ label: App.state.workspace ? `‘${App.state.workspace.name}’ 휴지통` : '휴지통', desc: summary, control: actions }));
            if (App.fs.ready) {
                App.fs.listTrash().then((items) => {
                    const size = items.reduce((s, i) => s + (i.size || 0), 0);
                    summary.textContent = items.length ? `${formatCount(items.length)}개 · ${formatBytes(size)} — 휴지통에서 하나씩 되살리거나 완전히 지울 수 있어요` : '비어 있어요';
                    if (App.commands.get('trash.open')) {
                        actions.append(k.button('휴지통 열기', {
                            icon: 'trash',
                            onClick: () => {
                                ctx.close();
                                App.commands.run('trash.open');
                            },
                        }));
                    }
                }).catch(() => {
                    summary.textContent = '휴지통을 읽지 못했어요';
                });
            }
            body.append(keep.el, now.el);
        },
    });

    addPage({
        id: 'server',
        title: '로컬 서버',
        icon: 'server',
        order: 50,
        desc: '내 PC에서만 도는 도우미 프로그램이에요. 켜 두면 무거운 기능이 열려요.',
        render(body, k, ctx) {
            const srv = App.server;
            const status = k.group('상태');
            const connected = !!srv?.available;
            const caps = srv?.capabilities || {};
            const dot = h('span', { class: `shs-dot ${connected ? 'on' : ''}` });
            const card = h('div', { class: 'shs-card' },
                h('div', { class: 'shs-card-row' },
                    dot,
                    h('div', { class: 'grow' },
                        h('div', { class: 'shs-card-title', text: connected ? '연결됐어요' : srv ? '연결 안 됨' : '아직 준비 중' }),
                        h('div', { class: 'shs-muted', text: connected ? `로컬 서버${srv.version ? ' ' + srv.version : ''} · 127.0.0.1` : srv ? '서버를 켠 뒤 연결을 눌러 주세요.' : '이 버전에는 서버 연결 모듈이 아직 없어요.' })),
                    srv && !connected && App.commands.get('server.connect') ? k.button('연결', { icon: 'refresh', kind: 'primary', onClick: async () => { await App.commands.run('server.connect'); ctx.refresh(); } }) : null));
            status.body.append(card);

            const feats = k.group('켜지는 기능');
            const list = [
                ['중복 사진·영상 찾기', 'FAISS로 비슷한 사진과 영상을 빠르게 묶어요.', caps.faiss],
                ['영상 자르기·합치기·회전', 'ffmpeg로 화질 손실 없이 편집해요.', caps.ffmpeg],
                ['HEIC·특수 형식 썸네일', '아이폰 사진(HEIC)도 썸네일과 미리보기를 보여 줘요.', caps.heif],
            ];
            for (const [label, desc, on] of list) {
                feats.body.append(k.row({ label, desc, control: h('span', { class: `badge ${connected && on ? 'shs-ok' : ''}`, text: connected ? (on ? '사용 가능' : '설치 필요') : '서버 필요' }) }));
            }
            const how = k.group('켜는 방법');
            how.body.append(k.note(h('span', { html: '이 앱이 들어 있는 폴더에서 <b>server\\start.bat</b>을 실행하면 브라우저에 <b>http://127.0.0.1:8765</b> 주소로 앱이 열려요. 서버는 내 PC 안에서만 동작하고 인터넷으로 아무것도 보내지 않아요.' }), { icon: 'info' }));
            body.append(status.el, feats.el, how.el);
        },
    });

    addPage({
        id: 'shortcuts',
        title: '단축키',
        icon: 'keyboard',
        order: 60,
        desc: '자주 쓰는 동작은 키보드로 더 빨라요. 언제든 ?를 누르면 이 목록이 나와요.',
        render(body, k) {
            const search = h('input', { class: 'input', type: 'search', placeholder: '단축키 검색 (예: 이름, Ctrl+Z)', spellcheck: 'false', 'aria-label': '단축키 검색' });
            const holder = h('div', { class: 'shs-shortcuts' });
            search.addEventListener('input', () => renderShortcuts(holder, { query: search.value, columns: 1 }));
            body.append(h('div', { class: 'search-box shs-shortcut-search' }, h('span', { html: ui.icon('search', { size: 14 }) }), search), holder);
            renderShortcuts(holder, { columns: 1 });
        },
    });

    addPage({
        id: 'about',
        title: '정보',
        icon: 'info',
        order: 90,
        desc: '버전과 내 데이터가 저장되는 곳을 알려 드려요.',
        render(body, k) {
            body.append(h('div', { class: 'shs-about' },
                h('div', { class: 'shs-about-logo', html: ui.icon('aperture', { size: 26 }) }),
                h('div', null,
                    h('div', { class: 'shs-about-name', text: 'Fluid Identity' }),
                    h('div', { class: 'shs-muted', text: `버전 ${App.version} · 사진영상정리기` }))));

            const data = k.group('내 데이터는 어디에 있나요?', '사진 정보는 브라우저가 아니라 사진이 있는 작업 폴더에 저장돼요. 브라우저나 PC를 다시 설치해도 그대로예요.');
            const ws = App.state.workspace;
            const tree = h('div', { class: 'shs-tree' });
            const line = (name, desc, depth = 1, icon = 'file') => tree.append(h('div', { class: 'shs-tree-row', style: { paddingLeft: depth * 18 + 'px' } }, h('span', { html: ui.icon(icon, { size: 14 }) }), h('code', { text: name }), h('span', { class: 'shs-muted', text: desc })));
            line(ws ? ws.name : '작업 폴더', '', 0, 'folder');
            line('.fluid-organizer/', '라이브러리 데이터 (숨김 폴더)', 1, 'folder');
            line('catalog.json', '칩 · 별점 · 메모 · 영상 마커', 2);
            line('chipsets.json', '칩셋과 프리셋', 2);
            line('favorites.json', '즐겨찾는 폴더', 2);
            line('trash/', '휴지통 (되살리기 가능)', 2, 'trash');
            line('backups/', '자동 백업 (매일, 최근 10개)', 2, 'history');
            data.body.append(tree);

            const browser = k.group('이 브라우저에만 있는 것', '지워져도 사진 정보에는 영향이 없어요.');
            browser.body.append(
                k.row({ label: '설정', desc: '테마, 패널, 단축키 기록 같은 화면 설정 (localStorage)', icon: 'sliders' }),
                k.row({ label: '최근 작업 폴더 · 썸네일 캐시', desc: '폴더 접근 권한과 만들어 둔 썸네일 (IndexedDB)', icon: 'database' }));
            const persist = h('span', { class: 'shs-muted', text: '확인하는 중…' });
            const persistBtn = k.button('영구 보관 요청', {
                icon: 'shield-check',
                onClick: async () => {
                    const ok = await navigator.storage?.persist?.().catch(() => false);
                    ui.toast(ok ? '브라우저가 저장 공간을 영구 보관하기로 했어요' : '브라우저가 아직 허락하지 않았어요. 자주 쓰면 자동으로 허락돼요.', { type: ok ? 'success' : 'info' });
                    showPersist();
                },
            });
            browser.body.append(k.row({ label: '저장 공간 보호', desc: persist, control: persistBtn, icon: 'shield-check' }));
            async function showPersist() {
                try {
                    const on = await navigator.storage.persisted();
                    persist.textContent = on ? '영구 보관 중이에요 — 브라우저가 임의로 지우지 않아요.' : '공간이 부족하면 브라우저가 캐시를 지울 수 있어요.';
                    persistBtn.hidden = on;
                } catch (e) {
                    persist.textContent = '확인할 수 없어요';
                }
            }
            showPersist();

            const credits = k.group('함께 쓰는 오픈 소스');
            credits.body.append(h('div', { class: 'shs-credits', text: 'Pretendard (OFL) · Lucide 아이콘 (ISC) · exifr (MIT) · mpegts.js (Apache-2.0)' }));
            body.append(data.el, browser.el, credits.el);
        },
    });

    // =====================================================================================================
    // Settings dialog
    // =====================================================================================================
    function renderNav() {
        if (!dlg) return;
        dlg.nav.innerHTML = '';
        for (const p of pages) {
            const tab = h('button', {
                class: `shs-tab${p.id === dlg.current ? ' on' : ''}`,
                type: 'button',
                role: 'tab',
                'aria-selected': String(p.id === dlg.current),
                tabindex: p.id === dlg.current ? '0' : '-1',
                dataset: { page: p.id },
                html: `${ui.icon(p.icon, { size: 15 })}<span>${App.util.escapeHtml(p.title)}</span>`,
                onclick: () => showPage(p.id),
            });
            dlg.nav.append(tab);
        }
    }

    function showPage(id, { focusTab = false } = {}) {
        if (!dlg) return;
        const page = pages.find((p) => p.id === id) || pages[0];
        dlg.current = page.id;
        App.settings.set('settings.lastPage', page.id);
        renderNav();
        dlg.title.textContent = page.title;
        dlg.desc.textContent = page.desc || '';
        dlg.scroll.innerHTML = '';
        dlg.scroll.scrollTop = 0;
        const body = h('div', { class: 'shs-page-body', role: 'tabpanel', 'aria-label': page.title });
        dlg.scroll.append(body);
        try {
            page.render(body, kit, ctxApi);
        } catch (e) {
            console.error('[settings] page failed', page.id, e);
            body.append(kit.note(`이 설정 화면을 그리지 못했어요: ${e.message}`, { type: 'warning' }));
        }
        if (focusTab) dlg.nav.querySelector('.shs-tab.on')?.focus();
    }

    const ctxApi = {
        refresh: () => dlg && showPage(dlg.current),
        close: () => dlg?.close(null),
        open: (id) => showPage(id),
    };

    function open(pageId) {
        if (dlg) {
            showPage(pageId || dlg.current);
            return;
        }
        const nav = h('div', { class: 'shs-nav-list', role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': '설정 항목' });
        const title = h('h2', { class: 'shs-page-title' });
        const desc = h('p', { class: 'shs-page-desc' });
        const scroll = h('div', { class: 'shs-scroll' });
        const closeBtn = h('button', { class: 'btn ghost icon shs-close', type: 'button', 'aria-label': '닫기', 'data-tip': '닫기', 'data-tip-keys': 'Escape', html: ui.icon('x') });
        const root = h('div', { class: 'shs' },
            h('nav', { class: 'shs-nav' },
                h('div', { class: 'shs-nav-head' }, h('span', { class: 'shs-nav-mark', html: ui.icon('settings', { size: 15 }) }), h('span', { text: '설정' })),
                nav,
                h('div', { class: 'shs-nav-foot' }, h('span', { text: `Fluid Identity ${App.version}` }))),
            h('section', { class: 'shs-main' },
                h('header', { class: 'shs-page-head' }, h('div', { class: 'grow' }, title, desc), closeBtn),
                scroll));

        nav.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            const i = pages.findIndex((p) => p.id === dlg.current);
            const next = pages[(i + (e.key === 'ArrowDown' ? 1 : -1) + pages.length) % pages.length];
            showPage(next.id, { focusTab: true });
        });

        ui.dialog({
            body: root,
            actions: [],
            width: 900,
            init(box, close) {
                box.classList.add('shs-dialog');
                box.setAttribute('aria-label', '설정');
                dlg = { close, nav, title, desc, scroll, current: null };
                closeBtn.addEventListener('click', () => close(null));
                App.shell.passUndoKeys(box);
                box.addEventListener('keydown', (e) => {
                    if (App.commands.comboFromEvent(e) === 'Mod+,') {
                        e.preventDefault();
                        close(null);
                    }
                });
                showPage(pageId || App.settings.get('settings.lastPage', 'general'));
                nav.querySelector('.shs-tab.on')?.focus();
            },
        }).then(() => {
            dlg = null;
            themeSeg = null;
        });
    }

    // =====================================================================================================
    // Keyboard shortcut sheet
    // =====================================================================================================
    const GROUP_ORDER = ['일반', '파일', '편집', '선택', '이동', '보기', '갤러리', '정리', '칩', '뷰어', '영상', '서버'];
    const GROUP_ICONS = { 일반: 'command', 파일: 'file', 편집: 'edit', 선택: 'check', 이동: 'arrow-right', 보기: 'eye', 갤러리: 'grid', 정리: 'layers', 칩: 'tag', 뷰어: 'image', 영상: 'film', 서버: 'server', 마우스: 'mouse-pointer' };
    const MOUSE = [
        ['여러 개 골라 선택', ['Ctrl', '클릭']],
        ['처음부터 끝까지 선택', ['Shift', '클릭']],
        ['크게 보기 · 폴더 열기', ['더블클릭']],
        ['썸네일 크기 바꾸기', ['Ctrl', '휠']],
        ['폴더로 옮기기', ['끌어다 놓기']],
        ['복사해서 넣기', ['Ctrl', '끌어다 놓기']],
        ['뒤로 · 앞으로', ['마우스 옆 버튼']],
    ];

    function collectShortcuts() {
        const groups = new Map();
        for (const c of App.commands.list()) {
            if (!c.keys || !c.keys.length || !c.title || c.hidden) continue;
            const g = c.group || (c.scope === 'viewer' ? '뷰어' : '갤러리');
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push({ id: c.id, title: c.title, combos: c.keys });
        }
        const rank = (g) => {
            const i = GROUP_ORDER.indexOf(g);
            return i < 0 ? 100 : i;
        };
        const list = [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || App.util.compareNames(a[0], b[0]));
        list.push(['마우스', MOUSE.map(([title, parts]) => ({ id: 'mouse:' + title, title, mouse: parts }))]);
        return list;
    }

    function keysEl(row) {
        const box = h('span', { class: 'kb-keys' });
        if (row.mouse) {
            box.append(h('span', { class: 'pal-keys' }, ...row.mouse.map((p) => h('span', { class: 'kbd', text: p }))));
            return box;
        }
        row.combos.forEach((combo, i) => {
            if (i) box.append(h('span', { class: 'kb-or', text: '또는' }));
            box.append(App.palette ? App.palette.kbdEl(combo) : h('span', { class: 'kbd', text: App.commands.displayCombo(combo) }));
        });
        return box;
    }

    function comboText(row) {
        if (row.mouse) return row.mouse.join('+');
        return row.combos.map((c) => App.commands.displayCombo(c)).join(' ');
    }

    /** Render the grouped shortcut list into container. Returns the number of rows shown. */
    function renderShortcuts(container, { query = '', columns = 2 } = {}) {
        container.innerHTML = '';
        const q = query.trim();
        const qKeys = q.toLowerCase().replace(/\s+/g, '');
        const cols = h('div', { class: columns === 2 ? 'kb-cols' : 'kb-cols one' });
        let shown = 0;
        for (const [group, rows] of collectShortcuts()) {
            const groupHit = q && App.palette ? App.palette.match(q, group) : null;
            const items = [];
            for (const row of rows) {
                let ranges = null;
                if (q) {
                    const m = App.palette ? App.palette.match(q, row.title) : (row.title.includes(q) ? { ranges: [] } : null);
                    const keyHit = comboText(row).toLowerCase().replace(/\s+/g, '').includes(qKeys);
                    if (!m && !keyHit && !groupHit) continue;
                    ranges = m ? m.ranges : null;
                }
                items.push([row, ranges]);
            }
            if (!items.length) continue;
            const g = h('div', { class: 'kb-group' }, h('div', { class: 'kb-group-title', html: `${ui.icon(GROUP_ICONS[group] || 'command', { size: 13 })}<span>${App.util.escapeHtml(group)}</span>` }));
            for (const [row, ranges] of items) {
                const title = h('span', { class: 'kb-title' });
                if (App.palette) App.palette.highlight(title, row.title, ranges);
                else title.textContent = row.title;
                g.append(h('div', { class: 'kb-row', dataset: { command: row.id } }, title, keysEl(row)));
                shown++;
            }
            cols.append(g);
        }
        if (!shown) container.append(h('div', { class: 'kb-empty', text: `‘${q}’에 맞는 단축키가 없어요` }));
        else container.append(cols);
        return shown;
    }

    let helpState = null;

    function openHelp(query = '') {
        if (helpState) {
            helpState.search.value = query;
            helpState.search.dispatchEvent(new Event('input'));
            helpState.search.focus();
            return;
        }
        const search = h('input', { class: 'input', type: 'search', placeholder: '단축키 검색', spellcheck: 'false', 'aria-label': '단축키 검색', value: query });
        const scroll = h('div', { class: 'kb-scroll' });
        const root = h('div', { class: 'kb-root' },
            h('div', { class: 'kb-head' },
                h('span', { class: 'kb-head-mark', html: ui.icon('keyboard', { size: 18 }) }),
                h('div', null, h('h3', { text: '단축키' }), h('p', { text: '키보드로 더 빠르게 정리해 보세요.' })),
                h('div', { class: 'search-box kb-search' }, h('span', { html: ui.icon('search', { size: 14 }) }), search)),
            scroll,
            h('div', { class: 'kb-foot' },
                h('span', { html: ui.icon('command', { size: 14 }) }),
                h('span', null, '모든 명령은 ', kit.kbd('Mod+K'), ' 명령 팔레트에서 이름으로 찾아 실행할 수 있어요.')));
        search.addEventListener('input', () => renderShortcuts(scroll, { query: search.value }));
        search.addEventListener('keydown', (e) => {
            // ? (or F1) again closes the sheet, like a toggle
            if ((e.key === '?' && !search.value) || e.key === 'F1') {
                e.preventDefault();
                helpState?.close(null);
            }
        });
        ui.dialog({
            body: root,
            actions: [],
            width: 880,
            init(box, close) {
                box.classList.add('kb-dialog');
                box.setAttribute('aria-label', '단축키');
                helpState = { search, close };
                App.shell.passUndoKeys(box);
                renderShortcuts(scroll, { query });
                search.focus();
            },
        }).then(() => {
            helpState = null;
        });
    }

    // =====================================================================================================
    // Commands
    // =====================================================================================================
    App.commands.register({ id: 'settings.open', title: '설정', group: '일반', icon: 'settings', keys: ['Mod+,'], scope: 'global', run: (args) => open(args && args.page) });
    App.commands.register({ id: 'help.shortcuts', title: '단축키 보기', group: '일반', icon: 'keyboard', keys: ['?', 'F1'], scope: 'global', run: () => openHelp() });
    App.commands.register({ id: 'settings.theme', title: '테마: Windows 설정 따라가기', group: '보기', icon: 'monitor', keywords: ['theme', 'system', 'dark', 'light'], when: () => !App.settings.get('theme.followSystem', false), run: () => setThemeMode('system') });

    App.register('shell-settings', {
        init() {
            if (App.settings.get('theme.followSystem', false)) applyTheme(systemTheme(), false);
        },
    });

    App.settingsUI = { open, close: () => dlg?.close(null), refresh: () => ctxApi.refresh(), addPage, pages, kit, setThemeMode, themeMode };
    App.help = { open: openHelp, render: renderShortcuts, collect: collectShortcuts };
})();
