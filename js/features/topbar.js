/*
 * Top bar: brand, panel toggles, back/forward/up (right-click or long-press = history menu), breadcrumb, search, app menu.
 * View bar above the gallery: title + counts, extra items, type filter, sort, zoom.
 *
 *   App.topbar.clearSearch(), setTypeFilter('all'|'image'|'video'), addViewbarItem(() => Element|null),
 *   renderViewbar(), search(text), setSearchScope('all'|'folder')
 *
 * Breadcrumb: every crumb is a drop target (move, Ctrl = copy, files from the OS are imported); the chevron after a
 * crumb lists that folder's subfolders; middle crumbs fold into '…' when the path doesn't fit; right-click = folder menu.
 * Search: name/memo/tags plus Hangul initials (ㄱㅅㅎ → 김수현) and chip names (via App.chipset.nameOf when present),
 * scope 전체/현재 폴더, result count, clear button, suggestions (folders → go there, chips → show that chip's files),
 * recent searches. Esc: leaves the suggestion list → clears the text → returns to the gallery.
 */
(() => {
    'use strict';
    const { h, path: P, formatCount, compareNames, escapeHtml } = App.util;
    const ui = App.ui;
    const SEARCH_LIMIT = 20000;

    let backBtn;
    let fwdBtn;
    let upBtn;
    let crumbs;
    let searchBox;
    let searchInput;
    let searchCount;
    let searchClear;
    let suggestEl = null;
    let viewbar;
    const viewbarItems = []; // () => Element|null, rendered left of the type filter on every view change

    const label = (p) => (p === '' ? App.state.workspace?.name || '작업 폴더' : App.navMatch.normalize(P.base(p)));
    const byName = (a, b) => compareNames(P.base(a), P.base(b));

    function noMouseFocus(root) {
        // Any mouse button: a right-click (history menu, crumb menu) must not leave a focus ring behind either
        root.addEventListener('mousedown', (e) => {
            if (e.target.closest?.('button')) e.preventDefault();
        });
        // Enter/Space on a keyboard-focused button press it instead of running gallery shortcuts
        root.addEventListener('keydown', (e) => {
            if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('button')) e.stopPropagation();
        });
        return root;
    }

    function iconBtn(iconName, tip, command, extraClass = '') {
        const btn = h('button', { class: `btn ghost icon ${extraClass}`, type: 'button', 'data-tip': tip, html: ui.icon(iconName), 'aria-label': tip });
        if (command) {
            const keys = App.commands.get(command)?.keys?.[0];
            if (keys) btn.dataset.tipKeys = keys;
            btn.addEventListener('click', () => App.commands.run(command));
        }
        return btn;
    }

    // ---------- History (back / forward) ----------
    // Several steps at once. Uses core App.nav.jump(delta) when it exists (integration request), else edits the stacks.
    function jumpBack(i) {
        const nav = App.nav;
        const target = nav.back[i];
        if (target == null) return;
        if (typeof nav.jump === 'function') return nav.jump(-(nav.back.length - i));
        const skipped = nav.back.slice(i + 1).reverse();
        nav.fwd.push(App.state.cwd, ...skipped);
        nav.back = nav.back.slice(0, i);
        return nav.go(target, { push: false });
    }

    function jumpForward(i) {
        const nav = App.nav;
        const target = nav.fwd[i];
        if (target == null) return;
        if (typeof nav.jump === 'function') return nav.jump(nav.fwd.length - i);
        const skipped = nav.fwd.slice(i + 1).reverse();
        nav.back.push(App.state.cwd, ...skipped);
        nav.fwd = nav.fwd.slice(0, i);
        return nav.go(target, { push: false });
    }

    function historyItem(p, run, extra = {}) {
        const parent = p === '' ? '' : P.parent(p);
        return { label: label(p), icon: p === '' ? 'home' : 'folder', hint: p === '' ? '' : parent === '' ? App.state.workspace?.name || '' : App.navMatch.normalize(P.base(parent)), action: run, ...extra };
    }

    function historyMenu(kind, anchor) {
        const nav = App.nav;
        const list = kind === 'back' ? nav.back : nav.fwd;
        if (!list.length) return;
        const items = list.map((p, i) => ({ p, i })).reverse().slice(0, 15)
            .map(({ p, i }) => historyItem(p, () => (kind === 'back' ? jumpBack(i) : jumpForward(i))));
        ui.menu([{ header: kind === 'back' ? '뒤로 가기 기록' : '앞으로 가기 기록' }, ...items], { anchor, align: 'start' });
    }

    function fullHistoryMenu() {
        const nav = App.nav;
        if (App.state.cwd == null) return;
        const fwd = nav.fwd.map((p, i) => ({ p, i })).slice(-10).map(({ p, i }) => historyItem(p, () => jumpForward(i), { checked: false }));
        const back = nav.back.map((p, i) => ({ p, i })).reverse().slice(0, 10).map(({ p, i }) => historyItem(p, () => jumpBack(i), { checked: false }));
        const items = [];
        if (fwd.length) items.push({ header: '앞으로' }, ...fwd);
        items.push({ header: '지금 보는 폴더' }, historyItem(App.state.cwd, () => {}, { checked: true }));
        if (back.length) items.push({ header: '뒤로' }, ...back);
        if (!fwd.length && !back.length) items.push({ label: '아직 이동 기록이 없어요', disabled: true });
        ui.menu(items, { anchor: backBtn, align: 'start' });
    }

    function bindHistoryButton(btn, kind) {
        btn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            historyMenu(kind, btn);
        });
        // Long press opens the menu too (like browsers)
        let timer = null;
        let fired = false;
        btn.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            fired = false;
            clearTimeout(timer);
            timer = setTimeout(() => {
                fired = true;
                historyMenu(kind, btn);
            }, 480);
        });
        for (const evt of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(evt, () => clearTimeout(timer));
        btn.addEventListener('click', (e) => {
            if (fired) {
                fired = false;
                e.stopImmediatePropagation();
            }
        }, true);
    }

    function updateNavButtons() {
        backBtn.disabled = !App.nav.canBack();
        fwdBtn.disabled = !App.nav.canForward();
        upBtn.disabled = !App.nav.canUp();
        // Disabled buttons swallow right-clicks; keep tooltips meaningful
        backBtn.dataset.tip = App.nav.canBack() ? `뒤로 · ${label(App.nav.back[App.nav.back.length - 1])} (우클릭: 기록)` : '뒤로';
        fwdBtn.dataset.tip = App.nav.canForward() ? `앞으로 · ${label(App.nav.fwd[App.nav.fwd.length - 1])} (우클릭: 기록)` : '앞으로';
    }

    // ---------- Breadcrumb ----------
    async function subfolderMenu(dir, anchor, activeChild) {
        let kids = App.tree?.children?.get(dir);
        if (!kids) {
            try {
                kids = (await App.fs.list(dir, { stat: false })).filter((e) => e.kind === 'dir').map((e) => e.path).sort(byName);
            } catch (e) {
                kids = [];
            }
        }
        const items = kids.length
            ? kids.map((k) => ({ label: label(k), icon: 'folder', checked: k === activeChild, hint: App.tree?.countText?.(k)?.text || '', action: () => goFolder(k) }))
            : [{ label: '하위 폴더가 없어요', disabled: true }];
        ui.menu([{ header: `${label(dir)} 안의 폴더` }, ...items], { anchor, align: 'start' });
    }

    function goFolder(p) {
        clearSearch();
        App.nav.go(p);
    }

    function searchTail(source) {
        if (source.type === 'search') {
            const scoped = source.scope === 'folder' && (App.state.cwd || '') !== '';
            return `“${source.query}” 검색 결과${scoped ? ' · 이 폴더 안' : ''}`;
        }
        if (source.type === 'smart') return source.title || '';
        return null;
    }

    function renderCrumbs() {
        if (!crumbs) return;
        crumbs.innerHTML = '';
        const ws = App.state.workspace;
        if (!ws || App.state.cwd == null) return;
        const source = App.view.source;
        const cwd = App.state.cwd || '';
        const segs = P.segments(cwd);
        const list = [{ path: '', text: ws.name }, ...segs.map((s, i) => ({ path: segs.slice(0, i + 1).join('/'), text: App.navMatch.normalize(s) }))];
        const tail = searchTail(source);
        list.forEach((c, i) => {
            if (i > 0) crumbs.append(h('button', { class: 'crumb-sep', type: 'button', dataset: { path: list[i - 1].path, next: c.path }, 'aria-label': `‘${list[i - 1].text}’ 안의 폴더 보기`, html: ui.icon('chevron-right', { size: 12 }) }));
            const isLast = i === list.length - 1;
            const cls = `crumb${i === 0 ? ' root' : ''}${isLast && !tail ? ' current' : ''}`;
            const btn = i === 0
                ? h('button', { class: cls, type: 'button', dataset: { path: '' }, html: `${ui.icon('home', { size: 14 })}<span>${escapeHtml(c.text)}</span>` })
                : h('button', { class: cls, type: 'button', dataset: { path: c.path }, text: c.text });
            if (isLast && !tail) btn.setAttribute('aria-current', 'page');
            crumbs.append(btn);
            if (i === 1) crumbs.append(h('button', { class: 'crumb crumb-more', type: 'button', hidden: true, 'aria-label': '숨겨진 상위 폴더', 'data-tip': '숨겨진 상위 폴더', text: '…' }));
        });
        if (tail) {
            crumbs.append(h('span', { class: 'crumb-sep static', html: ui.icon('chevron-right', { size: 12 }) }));
            crumbs.append(h('span', { class: 'crumb current', text: tail }));
        } else {
            if (App.tree?.hasKids?.(cwd) !== false) crumbs.append(h('button', { class: 'crumb-sep trail', type: 'button', dataset: { path: cwd }, 'aria-label': '하위 폴더 보기', 'data-tip': '하위 폴더', html: ui.icon('chevron-down', { size: 12 }) }));
        }
        fitCrumbs();
    }

    // Fold middle crumbs into '…' until the path fits
    function fitCrumbs() {
        if (!crumbs) return;
        const crumbEls = [...crumbs.querySelectorAll('.crumb[data-path]')];
        const seps = [...crumbs.querySelectorAll('.crumb-sep[data-next]')];
        const more = crumbs.querySelector('.crumb-more');
        crumbs.classList.remove('folded');
        if (!more || crumbEls.length <= 2) {
            crumbs.scrollLeft = crumbs.scrollWidth;
            return;
        }
        const fits = () => crumbs.scrollWidth <= crumbs.clientWidth + 1;
        if (fits()) return;
        const hidden = [];
        // crumbEls[0] = root, last = current; seps[k] sits between crumbEls[k] and crumbEls[k+1]
        for (let k = 1; k < crumbEls.length - 1; k++) {
            crumbEls[k].hidden = true;
            if (k >= 2) seps[k - 1].hidden = true;
            hidden.push(crumbEls[k].dataset.path);
            more.hidden = false;
            more.dataset.paths = JSON.stringify(hidden);
            // the '…' button sits after crumb 1; keep it right after the root's separator
            if (k === 1) crumbEls[1].after(more);
            if (fits()) break;
        }
        crumbs.classList.add('folded');
        crumbs.scrollLeft = crumbs.scrollWidth;
    }

    function bindCrumbs() {
        crumbs.addEventListener('click', (e) => {
            const sep = e.target.closest('.crumb-sep[data-path]');
            if (sep) {
                subfolderMenu(sep.dataset.path, sep, sep.dataset.next || null);
                return;
            }
            const more = e.target.closest('.crumb-more');
            if (more) {
                const paths = JSON.parse(more.dataset.paths || '[]');
                ui.menu([{ header: '상위 폴더' }, ...paths.map((p) => ({ label: label(p), icon: 'folder', hint: App.tree?.countText?.(p)?.text || '', action: () => goFolder(p) }))], { anchor: more, align: 'start' });
                return;
            }
            const btn = e.target.closest('.crumb[data-path]');
            if (!btn) return;
            goFolder(btn.dataset.path);
        });
        crumbs.addEventListener('contextmenu', (e) => {
            const btn = e.target.closest('.crumb[data-path], .crumb-sep.trail');
            if (!btn || !App.tree) return;
            e.preventDefault();
            e.stopPropagation();
            App.tree.openMenu(btn.dataset.path, { x: e.clientX, y: e.clientY });
        });
        // Drop targets
        const targetOf = (e) => e.target.closest?.('.crumb[data-path]');
        let over = null;
        const setOver = (el) => {
            if (over === el) return;
            over?.classList.remove('drop-target');
            over = el;
            over?.classList.add('drop-target');
        };
        crumbs.addEventListener('dragover', (e) => {
            const t = targetOf(e);
            if (!t) {
                setOver(null);
                return;
            }
            const v = App.navDnd.over(e, t.dataset.path, { label: label(t.dataset.path) });
            setOver(v.ok ? t : null);
        });
        crumbs.addEventListener('dragleave', (e) => {
            if (!crumbs.contains(e.relatedTarget)) setOver(null);
        });
        crumbs.addEventListener('drop', (e) => {
            const t = targetOf(e);
            setOver(null);
            if (!t) return;
            if (!App.navDnd.verdict(e, t.dataset.path).ok) return;
            App.navDnd.drop(e, t.dataset.path, { label: label(t.dataset.path) });
        });
        document.addEventListener('dragend', () => setOver(null), true);
    }

    // ---------- Search ----------
    let searchToken = 0;
    let searchScope = App.settings.get('search.scope', 'all'); // 'all' | 'folder'
    let lastCount = null;
    let suggestOptions = [];
    let activeOption = -1;
    let suppressRecent = false;
    const nameCache = new Map(); // path -> prepared (NFC, lower-case) file name
    const pathCache = new Map(); // path -> prepared path

    function prepared(e) {
        let v = nameCache.get(e.path);
        if (v === undefined) {
            v = App.navMatch.prepare(e.name);
            nameCache.set(e.path, v);
        }
        return v;
    }

    function preparedPath(p) {
        let v = pathCache.get(p);
        if (v === undefined) {
            v = App.navMatch.prepare(p);
            pathCache.set(p, v);
        }
        return v;
    }

    function chipNames() {
        const nameOf = App.chipset && App.chipset.nameOf;
        const map = new Map();
        if (typeof nameOf !== 'function') return map;
        const ids = new Map();
        for (const [, entry] of App.catalog.entries()) {
            for (const id of entry.chips || []) ids.set(id, (ids.get(id) || 0) + 1);
        }
        for (const [id, n] of ids) {
            try {
                const name = nameOf.call(App.chipset, id);
                if (name) map.set(id, { name: App.navMatch.normalize(String(name)), lower: App.navMatch.prepare(String(name)), count: n });
            } catch (e) {
                /* unknown chip */
            }
        }
        return map;
    }

    function inScope(p) {
        const cwd = App.state.cwd || '';
        return searchScope !== 'folder' || cwd === '' || P.isInside(p, cwd);
    }

    /** Workspace search: core index search + Hangul initials on names + chip names. */
    function searchEntries(q) {
        const base = App.index.search(q, { limit: SEARCH_LIMIT });
        const seen = new Set(base.map((e) => e.path));
        const words = App.navMatch.prepare(q).split(/\s+/).filter(Boolean);
        const chips = chipNames();
        const hangulWords = words.map((w) => App.navMatch.hasHangul(w));
        const extra = [];
        if (hangulWords.some(Boolean) || chips.size) {
            const M = App.navMatch;
            for (const e of App.index.items) {
                if (seen.has(e.path)) continue;
                const meta = App.catalog.peek(e.path);
                const ok = words.every((w, wi) => {
                    if (preparedPath(e.path).includes(w)) return true;
                    if (meta && ((meta.memo && meta.memo.toLowerCase().includes(w)) || (meta.legacyTags || []).some((t) => t.toLowerCase().includes(w)))) return true;
                    // initials against file and folder names: 'ㄱㅅㅎ' finds files in '김수현 화보/'
                    if (hangulWords[wi] && M.matchPrepared(preparedPath(e.path), w)) return true;
                    if (meta?.chips?.length && chips.size) return meta.chips.some((id) => { const c = chips.get(id); return c && (c.lower.includes(w) || (hangulWords[wi] && M.matchPrepared(c.lower, w))); });
                    return false;
                });
                if (ok) extra.push(e);
                if (base.length + extra.length >= SEARCH_LIMIT) break;
            }
        }
        return base.concat(extra).filter((e) => inScope(e.path));
    }

    const runSearch = App.util.debounce(async () => {
        const q = searchInput.value.trim();
        const token = ++searchToken;
        if (!q) {
            lastCount = null;
            updateSearchMeta();
            const src = App.view.source;
            if (src.type === 'search' || (src.type === 'smart' && src.fromSearch)) App.nav.load();
            return;
        }
        const source = { type: 'search', path: null, title: `“${q}” 검색 결과`, query: q, scope: searchScope };
        if (!App.index.ready) {
            lastCount = null;
            updateSearchMeta(true);
            App.view.setEntries([], { ...source, title: `“${q}” 검색 중…` });
            await App.index.whenReady();
            if (token !== searchToken) return;
        }
        const results = searchEntries(q);
        lastCount = results.length;
        App.view.setEntries(results, source);
        updateSearchMeta();
        if (document.activeElement === searchInput) renderSuggest();
    }, 180);

    function updateSearchMeta(indexing = false) {
        if (!searchInput) return;
        const has = !!searchInput.value;
        searchClear.hidden = !has;
        searchBox.classList.toggle('has-text', has);
        if (!has) {
            searchCount.hidden = true;
            return;
        }
        searchCount.hidden = false;
        if (indexing || (!App.index.ready && lastCount == null)) searchCount.innerHTML = '<span class="spinner"></span>';
        else if (lastCount == null) searchCount.textContent = '';
        else searchCount.textContent = lastCount >= SEARCH_LIMIT ? `${formatCount(SEARCH_LIMIT)}+` : `${formatCount(lastCount)}개`;
        searchCount.dataset.tip = lastCount == null ? '색인 중이에요' : `찾은 사진·영상 ${formatCount(lastCount)}개 · ${searchScope === 'folder' && App.state.cwd ? '현재 폴더 안' : '작업 폴더 전체'}`;
    }

    function clearSearch() {
        if (!searchInput || !searchInput.value) return false;
        searchInput.value = '';
        lastCount = null;
        runSearch.flush();
        updateSearchMeta();
        closeSuggest();
        return true;
    }

    function setSearchScope(scope) {
        searchScope = scope === 'folder' ? 'folder' : 'all';
        App.settings.set('search.scope', searchScope);
        if (searchInput.value.trim()) runSearch.flush();
        if (suggestEl) renderSuggest();
        renderViewbar();
    }

    // Recent searches (per workspace, this browser)
    const recentKey = () => `search.recent.${App.state.workspace?.id || 'none'}`;
    const recents = () => App.settings.get(recentKey(), []);
    function rememberSearch(q) {
        q = (q || '').trim();
        if (!q || !App.state.workspace) return;
        App.settings.set(recentKey(), [q, ...recents().filter((x) => x !== q)].slice(0, 8));
    }
    function forgetSearch(q) {
        App.settings.set(recentKey(), recents().filter((x) => x !== q));
    }

    function showChip(id, name) {
        const files = App.index.items.filter((e) => (App.catalog.peek(e.path)?.chips || []).includes(id));
        App.view.setEntries(files, { type: 'smart', path: null, title: `칩 · ${name}`, chip: id, fromSearch: true });
    }

    function folderSuggestions(q) {
        const universe = App.index.ready ? App.index.folders : [...(App.tree?.children?.values() || [])].flat();
        const out = [];
        for (const f of universe) {
            if (!f || App.fs.isDataPath(f)) continue;
            const m = App.navMatch.match(P.base(f), q);
            if (m) out.push({ p: f, m });
        }
        out.sort((a, b) => b.m.score - a.m.score || P.segments(a.p).length - P.segments(b.p).length || byName(a.p, b.p));
        return out.slice(0, 5);
    }

    function chipSuggestions(q) {
        const out = [];
        for (const [id, c] of chipNames()) {
            const m = App.navMatch.match(c.name, q);
            if (m) out.push({ id, c, m });
        }
        out.sort((a, b) => b.m.score - a.m.score || b.c.count - a.c.count);
        return out.slice(0, 5);
    }

    function ensureSuggestEl() {
        if (suggestEl) return suggestEl;
        suggestEl = h('div', { class: 'menu search-suggest', id: 'search-suggest', role: 'listbox', 'aria-label': '검색 제안' });
        suggestEl.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
        suggestEl.addEventListener('click', (e) => {
            const rm = e.target.closest('[data-forget]');
            if (rm) {
                e.stopPropagation();
                forgetSearch(rm.dataset.forget);
                renderSuggest();
                return;
            }
            const scope = e.target.closest('[data-scope]');
            if (scope) {
                setSearchScope(scope.dataset.scope);
                return;
            }
            const opt = e.target.closest('[data-opt]');
            if (opt) runOption(Number(opt.dataset.opt));
        });
        suggestEl.addEventListener('mousemove', (e) => {
            const opt = e.target.closest('[data-opt]');
            if (opt && Number(opt.dataset.opt) !== activeOption) setActive(Number(opt.dataset.opt));
        });
        document.body.append(suggestEl);
        return suggestEl;
    }

    function closeSuggest() {
        activeOption = -1;
        suggestOptions = [];
        if (suggestEl) {
            suggestEl.remove();
            suggestEl = null;
        }
        if (searchInput) {
            searchInput.setAttribute('aria-expanded', 'false');
            searchInput.removeAttribute('aria-activedescendant');
        }
    }

    function setActive(i) {
        activeOption = i;
        if (!suggestEl) return;
        for (const el of suggestEl.querySelectorAll('[data-opt]')) el.classList.toggle('active', Number(el.dataset.opt) === i);
        const el = suggestEl.querySelector(`[data-opt="${i}"]`);
        if (el) {
            searchInput.setAttribute('aria-activedescendant', el.id);
            el.scrollIntoView({ block: 'nearest' });
        } else searchInput.removeAttribute('aria-activedescendant');
    }

    function runOption(i) {
        const opt = suggestOptions[i];
        if (!opt) return;
        opt.run();
    }

    function optionRow(i, iconName, main, sub, right, extraClass = '') {
        const el = h('div', { class: `menu-item sg-opt ${extraClass}`, role: 'option', id: `sg-opt-${i}`, dataset: { opt: String(i) } });
        el.append(h('span', { class: 'sg-ico', html: ui.icon(iconName, { size: 15 }) }));
        const text = h('span', { class: 'menu-label sg-text' });
        text.append(h('span', { class: 'sg-main truncate' }, main));
        if (sub) text.append(h('span', { class: 'sg-sub', text: sub }));
        el.append(text);
        if (right) el.append(h('span', { class: 'menu-hint', text: right }));
        return el;
    }

    function renderSuggest() {
        if (!searchInput || document.activeElement !== searchInput || !App.fs.ready) return closeSuggest();
        const q = searchInput.value.trim();
        suggestOptions = [];
        const parts = [];
        if (!q) {
            const list = suppressRecent ? [] : recents();
            if (!list.length) return closeSuggest();
            parts.push(h('div', { class: 'menu-header', text: '최근 검색' }));
            list.forEach((r) => {
                const i = suggestOptions.length;
                suggestOptions.push({
                    run: () => {
                        searchInput.value = r;
                        runSearch.flush();
                        rememberSearch(r);
                        updateSearchMeta();
                        closeSuggest();
                    },
                });
                const row = optionRow(i, 'clock', r, null, null);
                row.append(h('button', { class: 'sg-forget', type: 'button', tabindex: '-1', 'aria-label': `‘${r}’ 기록 지우기`, 'data-tip': '기록에서 지우기', dataset: { forget: r }, html: ui.icon('x', { size: 12 }) }));
                parts.push(row);
            });
        } else {
            if ((App.state.cwd || '') !== '') {
                parts.push(h('div', { class: 'sg-scope' },
                    h('span', { class: 'sg-scope-label', text: '검색 범위' }),
                    h('div', { class: 'seg' },
                        h('button', { type: 'button', class: searchScope === 'all' ? 'on' : '', dataset: { scope: 'all' }, text: '전체' }),
                        h('button', { type: 'button', class: searchScope === 'folder' ? 'on' : '', dataset: { scope: 'folder' }, html: `${ui.icon('folder', { size: 12 })}<span>${escapeHtml(label(App.state.cwd))}</span>` })),
                    h('span', { class: 'kbd', text: App.commands.displayCombo('Alt+S') })));
            }
            const folders = folderSuggestions(q);
            if (folders.length) {
                parts.push(h('div', { class: 'menu-header', text: '폴더로 이동' }));
                for (const { p, m } of folders) {
                    const i = suggestOptions.length;
                    suggestOptions.push({
                        run: () => {
                            rememberSearch(q);
                            closeSuggest();
                            searchInput.value = '';
                            lastCount = null;
                            updateSearchMeta();
                            searchInput.blur();
                            App.nav.go(p);
                        },
                    });
                    const parent = P.parent(p);
                    parts.push(optionRow(i, 'folder', App.navMatch.highlight(label(p), m.ranges), parent ? App.navMatch.normalize(parent) : App.state.workspace?.name || '', App.tree?.countText?.(p)?.text || ''));
                }
            }
            const chips = chipSuggestions(q);
            if (chips.length) {
                parts.push(h('div', { class: 'menu-header', text: '칩' }));
                for (const { id, c, m } of chips) {
                    const i = suggestOptions.length;
                    suggestOptions.push({
                        run: () => {
                            rememberSearch(q);
                            closeSuggest();
                            searchInput.value = '';
                            lastCount = null;
                            updateSearchMeta();
                            searchInput.blur();
                            showChip(id, c.name);
                        },
                    });
                    parts.push(optionRow(i, 'tag', App.navMatch.highlight(c.name, m.ranges), null, `${formatCount(c.count)}개`, 'sg-chip'));
                }
            }
            const i = suggestOptions.length;
            suggestOptions.push({
                run: () => {
                    runSearch.flush();
                    rememberSearch(q);
                    closeSuggest();
                },
            });
            const countText = lastCount == null ? (App.index.ready ? '' : '색인 중…') : `${formatCount(lastCount)}개`;
            parts.push(h('div', { class: 'menu-sep' }), optionRow(i, 'search', `“${q}” 파일 검색 결과 보기`, null, countText, 'sg-all'));
        }
        const el = ensureSuggestEl();
        el.innerHTML = '';
        el.append(...parts);
        if (activeOption >= suggestOptions.length) activeOption = -1;
        setActive(activeOption);
        searchInput.setAttribute('aria-expanded', 'true');
        positionSuggest();
    }

    function positionSuggest() {
        if (!suggestEl || !searchBox) return;
        const r = searchBox.getBoundingClientRect();
        const w = Math.max(r.width, 340);
        suggestEl.style.width = w + 'px';
        suggestEl.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
        suggestEl.style.top = r.bottom + 6 + 'px';
    }

    function onSearchKey(e) {
        if (e.isComposing) return;
        const open = !!suggestEl && suggestOptions.length > 0;
        // With a query, the last option is the plain "show results" row; arrowing only into it is pointless
        const navigable = open && suggestOptions.length > (searchInput.value.trim() ? 1 : 0);
        switch (e.key) {
            case 'Escape':
                e.preventDefault();
                e.stopPropagation();
                if (open && activeOption >= 0) {
                    closeSuggest();
                    return;
                }
                if (searchInput.value) {
                    suppressRecent = true;
                    clearSearch();
                    return;
                }
                closeSuggest();
                if (App.view.source.type === 'smart' && App.view.source.fromSearch) {
                    App.nav.load();
                    return;
                }
                searchInput.blur();
                document.getElementById('gallery-scroll')?.focus({ preventScroll: true });
                return;
            case 'ArrowDown':
                e.preventDefault();
                if (navigable) setActive(activeOption + 1 >= suggestOptions.length ? 0 : activeOption + 1);
                else {
                    closeSuggest();
                    searchInput.blur();
                    document.getElementById('gallery-scroll')?.focus({ preventScroll: true });
                }
                return;
            case 'ArrowUp':
                if (!navigable) return;
                e.preventDefault();
                setActive(activeOption <= 0 ? suggestOptions.length - 1 : activeOption - 1);
                return;
            case 'Enter':
                e.preventDefault();
                if (open && activeOption >= 0) runOption(activeOption);
                else {
                    runSearch.flush();
                    rememberSearch(searchInput.value);
                    closeSuggest();
                }
                return;
            default:
                break;
        }
        if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 's' || e.key === 'S' || e.code === 'KeyS')) {
            e.preventDefault();
            e.stopPropagation();
            setSearchScope(searchScope === 'all' ? 'folder' : 'all');
        }
    }

    // ---------- View bar ----------
    const TYPE_FILTERS = [
        { id: 'all', label: '전체' },
        { id: 'image', label: '사진', icon: 'image' },
        { id: 'video', label: '영상', icon: 'video' },
    ];

    function currentTypeFilter() {
        return App.view.filters.get('type')?.id || 'all';
    }

    function setTypeFilter(id) {
        if (id === 'all') App.view.setFilter('type', null);
        else App.view.setFilter('type', { id, label: id === 'image' ? '사진만' : '영상만', test: (e) => e.type === id });
        App.settings.set('view.type', id);
    }

    function renderViewbar() {
        if (!viewbar) return;
        viewbar.innerHTML = '';
        if (!App.fs.ready) return;
        const source = App.view.source;
        const all = App.view.entries;
        const counts = { dir: 0, image: 0, video: 0 };
        for (const e of all) counts[e.type] = (counts[e.type] || 0) + 1;
        const title = source.type === 'search' ? source.title : source.title || App.state.workspace?.name || '';
        const countParts = [];
        if (counts.dir) countParts.push(`폴더 ${formatCount(counts.dir)}`);
        countParts.push(`사진 ${formatCount(counts.image)}`);
        countParts.push(`영상 ${formatCount(counts.video)}`);
        if (source.recursive) countParts.push('하위 폴더 포함');

        const seg = h('div', { class: 'seg', role: 'group', 'aria-label': '종류' });
        const active = currentTypeFilter();
        TYPE_FILTERS.forEach((f, i) => {
            seg.append(h('button', { type: 'button', class: active === f.id ? 'on' : '', 'aria-pressed': String(active === f.id), 'data-tip': `${f.label} 보기`, 'data-tip-keys': `Alt+${i + 1}`, html: (f.icon ? ui.icon(f.icon, { size: 13 }) : '') + f.label, onclick: () => setTypeFilter(f.id) }));
        });

        const sortKey = App.view.sortKeys().find((k) => k.key === App.view.sort.key);
        const sortBtn = h('button', {
            class: 'btn ghost sm vb-sort',
            type: 'button',
            'data-tip': '정렬',
            html: `${ui.icon('sort', { size: 14 })}<span>${sortKey?.label || '이름'}</span>${ui.icon('arrow-up', { size: 12, class: App.view.sort.dir === 'desc' ? 'flip' : '' })}`,
            onclick: (e) => {
                ui.menu([
                    { header: '정렬 기준' },
                    ...App.view.sortKeys().map((k) => ({ label: k.label, checked: App.view.sort.key === k.key, action: () => App.view.setSort(k.key) })),
                    '-',
                    { label: '오름차순', checked: App.view.sort.dir === 'asc', action: () => App.view.setSort(App.view.sort.key, 'asc') },
                    { label: '내림차순', checked: App.view.sort.dir === 'desc', action: () => App.view.setSort(App.view.sort.key, 'desc') },
                ], { anchor: e.currentTarget, align: 'end' });
            },
        });

        const zoom = h('input', { type: 'range', class: 'zoom-slider', min: '96', max: '480', step: '4', value: String(App.gallery.zoom), 'aria-label': '썸네일 크기', 'data-tip': '썸네일 크기 (Ctrl+휠)' });
        zoom.addEventListener('input', () => App.gallery.setZoom(Number(zoom.value)));

        const extras = [];
        if (source.type === 'search' && (App.state.cwd || '') !== '') {
            extras.push(h('div', { class: 'seg vb-scope', role: 'group', 'aria-label': '검색 범위' },
                h('button', { type: 'button', class: searchScope === 'all' ? 'on' : '', 'data-tip': '작업 폴더 전체에서 찾기', 'data-tip-keys': 'Alt+S', text: '전체', onclick: () => setSearchScope('all') }),
                h('button', { type: 'button', class: searchScope === 'folder' ? 'on' : '', 'data-tip': `‘${label(App.state.cwd)}’ 안에서만 찾기`, 'data-tip-keys': 'Alt+S', html: `${ui.icon('folder', { size: 12 })}<span>이 폴더</span>`, onclick: () => setSearchScope('folder') })));
        }
        for (const fn of viewbarItems) {
            try {
                const el = fn();
                if (el) extras.push(el);
            } catch (e) {
                console.error('[topbar] viewbar item failed', e);
            }
        }
        viewbar.append(
            h('div', { class: 'vb-title' }, h('span', { class: 'vb-name truncate', text: title }), h('span', { class: 'vb-count', text: countParts.join(' · ') })),
            h('div', { class: 'vb-filters', id: 'vb-filters' }),
            h('div', { class: 'grow' }),
            ...extras,
            seg,
            sortBtn,
            h('span', { class: 'vb-zoom', html: ui.icon('image', { size: 12 }) }, zoom),
        );
        renderFilterChips();
    }

    // Active non-type filters as removable chips (other modules add filters via App.view.setFilter)
    function renderFilterChips() {
        const host = document.getElementById('vb-filters');
        if (!host) return;
        host.innerHTML = '';
        for (const [id, f] of App.view.filters) {
            if (id === 'type') continue;
            host.append(h('button', { class: 'filter-chip', type: 'button', 'data-tip': '필터 끄기', html: `${escapeHtml(f.label || id)}${ui.icon('x', { size: 12 })}`, onclick: () => App.view.setFilter(id, null) }));
        }
    }

    function appMenu(anchor) {
        const theme = document.documentElement.dataset.theme;
        ui.menu([
            { label: '작업 폴더 열기…', icon: 'folder-open', command: 'workspace.open' },
            { label: '작업 폴더 닫기', icon: 'x', command: 'workspace.close', disabled: !App.fs.ready },
            '-',
            { label: theme === 'light' ? '어두운 테마' : '밝은 테마', icon: theme === 'light' ? 'moon' : 'sun', command: 'view.toggleTheme' },
            { label: '사이드바', icon: 'sidebar', command: 'view.toggleSidebar', checked: !document.querySelector('.app').classList.contains('no-sidebar') },
            { label: '정보 패널', icon: 'panel-right', command: 'view.toggleInspector', checked: !document.querySelector('.app').classList.contains('no-inspector') },
            '-',
            { label: '이동 기록', icon: 'clock', command: 'nav.history', disabled: !App.fs.ready },
            { label: '실행 취소', icon: 'undo', command: 'edit.undo', disabled: !App.undo.canUndo() },
            { label: '다시 실행', icon: 'redo', command: 'edit.redo', disabled: !App.undo.canRedo() },
        ], { anchor, align: 'end' });
    }

    App.commands.register({
        id: 'search.focus',
        title: '검색',
        group: '보기',
        icon: 'search',
        keys: ['Mod+F'],
        scope: 'global',
        when: () => App.fs.ready,
        run: () => {
            suppressRecent = false;
            searchInput.focus();
            searchInput.select();
        },
    });
    App.commands.register({ id: 'search.scope', title: '검색 범위 바꾸기 (전체 ↔ 현재 폴더)', group: '보기', icon: 'filter', keys: ['Alt+S'], allowInInput: true, when: () => App.fs.ready, run: () => setSearchScope(searchScope === 'all' ? 'folder' : 'all') });
    App.commands.register({ id: 'nav.history', title: '이동 기록 보기', group: '이동', icon: 'clock', keys: ['Mod+H'], when: () => App.fs.ready && App.state.cwd != null, run: () => fullHistoryMenu() });
    App.commands.register({
        id: 'view.toggleTheme',
        title: '테마 바꾸기',
        group: '보기',
        icon: 'sun',
        scope: 'global',
        run: () => {
            const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
            document.documentElement.dataset.theme = next;
            App.settings.set('theme', next);
        },
    });
    App.commands.register({ id: 'view.filterAll', title: '전체 보기', group: '보기', keys: ['Alt+1'], allowInInput: true, when: () => App.fs.ready, run: () => setTypeFilter('all') });
    App.commands.register({ id: 'view.filterImages', title: '사진만 보기', group: '보기', icon: 'image', keys: ['Alt+2'], allowInInput: true, when: () => App.fs.ready, run: () => setTypeFilter('image') });
    App.commands.register({ id: 'view.filterVideos', title: '영상만 보기', group: '보기', icon: 'video', keys: ['Alt+3'], allowInInput: true, when: () => App.fs.ready, run: () => setTypeFilter('video') });

    App.register('topbar', {
        init() {
            const bar = document.getElementById('topbar');
            viewbar = document.getElementById('viewbar');
            backBtn = iconBtn('arrow-left', '뒤로', 'nav.back');
            fwdBtn = iconBtn('arrow-right', '앞으로', 'nav.forward');
            upBtn = iconBtn('corner-up', '상위 폴더', 'nav.up');
            bindHistoryButton(backBtn, 'back');
            bindHistoryButton(fwdBtn, 'fwd');
            crumbs = h('nav', { class: 'crumbs', 'aria-label': '경로' });
            bindCrumbs();

            searchInput = h('input', {
                class: 'input',
                id: 'search-input',
                type: 'search',
                placeholder: '파일·메모·칩 검색',
                spellcheck: 'false',
                autocomplete: 'off',
                role: 'combobox',
                'aria-label': '검색',
                'aria-autocomplete': 'list',
                'aria-controls': 'search-suggest',
                'aria-expanded': 'false',
            });
            searchCount = h('span', { class: 'search-count', hidden: true });
            searchClear = h('button', { class: 'search-clear', type: 'button', hidden: true, 'aria-label': '검색어 지우기', 'data-tip': '지우기', 'data-tip-keys': 'Escape', html: ui.icon('x', { size: 13 }) });
            searchClear.addEventListener('click', () => {
                suppressRecent = true;
                clearSearch();
                searchInput.focus();
            });
            searchInput.addEventListener('input', () => {
                suppressRecent = false;
                activeOption = -1;
                lastCount = null;
                updateSearchMeta(!App.index.ready);
                runSearch();
                renderSuggest();
            });
            searchInput.addEventListener('keydown', onSearchKey);
            searchInput.addEventListener('focus', () => {
                searchBox.classList.add('focused');
                renderSuggest();
            });
            searchInput.addEventListener('blur', () => {
                searchBox.classList.remove('focused');
                suppressRecent = false;
                const q = searchInput.value.trim();
                if (q && lastCount) rememberSearch(q);
                closeSuggest();
            });
            window.addEventListener('resize', () => positionSuggest());

            const left = h('div', { class: 'topbar-group' },
                h('div', { class: 'topbar-brand' }, h('span', { class: 'brand-mark', html: ui.icon('aperture', { size: 14 }) }), h('span', { class: 'brand-name', text: 'Fluid Identity' })),
                iconBtn('sidebar', '사이드바 열고 닫기', 'view.toggleSidebar'),
                h('span', { class: 'topbar-sep' }),
                backBtn, fwdBtn, upBtn);

            const center = h('div', { id: 'topbar-center' }, crumbs);
            searchBox = h('div', { class: 'search-box topbar-search', 'data-tip': '파일 이름·메모·칩 검색 · 초성(ㄱㅅㅎ → 김수현)도 돼요', 'data-tip-keys': 'Mod+F' }, h('span', { html: ui.icon('search', { size: 14 }) }), searchInput, searchCount, searchClear);
            const menuBtn = iconBtn('more', '메뉴');
            menuBtn.addEventListener('click', () => appMenu(menuBtn));
            const right = h('div', { id: 'topbar-right' }, searchBox, iconBtn('panel-right', '정보 패널 열고 닫기', 'view.toggleInspector'), menuBtn);

            bar.append(left, center, right);
            noMouseFocus(bar);
            noMouseFocus(viewbar);

            let fitPending = false;
            new ResizeObserver(() => {
                if (fitPending) return;
                fitPending = true;
                requestAnimationFrame(() => {
                    fitPending = false;
                    renderCrumbs();
                });
            }).observe(center);

            App.bus.on('nav:changed', () => {
                renderCrumbs();
                updateNavButtons();
            });
            App.bus.on('view:changed', () => {
                renderCrumbs();
                updateNavButtons();
                renderViewbar();
            });
            App.bus.on('view:filters', renderFilterChips);
            App.bus.on('gallery:zoom', ({ size }) => {
                const z = viewbar.querySelector('.zoom-slider');
                if (z && Number(z.value) !== size) z.value = String(size);
            });
            App.bus.on('index:ready', () => {
                updateSearchMeta();
                renderCrumbs();
            });
            App.bus.on('workspace:opened', () => {
                searchInput.value = '';
                lastCount = null;
                nameCache.clear();
                pathCache.clear();
                updateSearchMeta();
                closeSuggest();
                const t = App.settings.get('view.type', 'all');
                if (t !== 'all') setTypeFilter(t);
            });
            App.bus.on('workspace:closed', () => {
                crumbs.innerHTML = '';
                viewbar.innerHTML = '';
                searchInput.value = '';
                nameCache.clear();
                pathCache.clear();
                updateSearchMeta();
                closeSuggest();
                updateNavButtons();
            });
            App.bus.on('fs:changed', (c) => {
                for (const p of [...(c.from || []), ...(c.paths || [])]) {
                    nameCache.delete(p);
                    pathCache.delete(p);
                }
            });
            updateNavButtons();
        },
    });

    App.topbar = {
        clearSearch,
        setTypeFilter,
        setSearchScope,
        /** search(text) — run a workspace search as if typed into the box */
        search(text) {
            searchInput.value = text || '';
            lastCount = null;
            updateSearchMeta();
            return runSearch.flush();
        },
        /** addViewbarItem(() => Element|null) — re-invoked whenever the view bar re-renders */
        addViewbarItem(fn) {
            viewbarItems.push(fn);
            if (App.fs.ready) renderViewbar();
        },
        renderViewbar: () => renderViewbar(),
        get searchScope() {
            return searchScope;
        },
    };
})();
