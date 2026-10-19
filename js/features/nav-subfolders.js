/*
 * "하위 폴더 포함" — list every photo/video under the current folder (from App.index), remembered per folder.
 *   App.navSubfolders.isOn(path), set(path, on), toggle(), openRecursive(path)
 * Command: nav.toggleRecursive (Alt+R). View bar toggle button. While a recursive/search/smart list is shown,
 * each card gets a small badge with the folder it lives in (click it to jump there with the file selected).
 *
 * Core hook: when js/core/nav.js offers `App.nav.loadHooks` (see the nav team's integration request) the recursive
 * list is produced inside nav.load(); until then it is re-applied after every 'folder:loaded'.
 */
(() => {
    'use strict';
    const { h, path: P, escapeHtml } = App.util;
    const ui = App.ui;

    let pending = null; // folder waiting for the index
    let savedSelection = null;

    function key() {
        return `nav.recursive.${App.state.workspace?.id || 'none'}`;
    }

    function onList() {
        const v = App.settings.get(key(), []);
        return Array.isArray(v) ? v : [];
    }

    function isOn(p) {
        return p != null && onList().includes(p);
    }

    function set(p, on) {
        const list = onList().filter((x) => x !== p);
        if (on) list.push(p);
        App.settings.set(key(), list.slice(-500));
    }

    const hooked = () => Array.isArray(App.nav.loadHooks);

    function recursiveEntries(dir) {
        return App.index.under(dir, { recursive: true }).filter((e) => e.kind === 'file');
    }

    function sourceFor(dir, extra = {}) {
        const title = dir === '' ? App.state.workspace?.name || '' : App.navMatch.normalize(P.base(dir));
        return { type: 'folder', path: dir, title, hiddenCount: 0, recursive: true, ...extra };
    }

    /** Swap the current folder listing for the recursive one (keeps selection/focus where possible). */
    function apply({ keep = null } = {}) {
        const dir = App.state.cwd;
        if (dir == null || App.view.source.type !== 'folder' || !isOn(dir)) return;
        if (!App.index.ready) {
            if (pending === dir) return;
            pending = dir;
            App.topbar?.renderViewbar?.();
            App.index.whenReady().then(() => {
                const stillHere = pending === dir && App.state.cwd === dir && App.view.source.type === 'folder' && isOn(dir);
                pending = null;
                if (stillHere) apply();
                else App.topbar?.renderViewbar?.();
            });
            return;
        }
        pending = null;
        const sel = keep || { paths: App.select.list(), focus: App.select.focus };
        App.view.setEntries(recursiveEntries(dir), sourceFor(dir));
        const still = sel.paths.filter((p) => App.view.index.has(p));
        if (still.length) App.select.set(still, { focus: still.includes(sel.focus) ? sel.focus : still[still.length - 1] });
    }

    function toggle() {
        const dir = App.state.cwd;
        if (dir == null || !App.fs.ready) return;
        const on = !isOn(dir);
        set(dir, on);
        if (on) apply();
        else if (App.view.source.recursive) App.nav.load({ keepSelection: true });
        else App.topbar?.renderViewbar?.();
    }

    async function openRecursive(p) {
        set(p, true);
        App.topbar?.clearSearch?.();
        if (App.state.cwd === p && App.view.source.type === 'folder') apply();
        else await App.nav.go(p);
    }

    // ---------- Card badge: where does this file live? ----------
    function badgeFolder(entry) {
        const src = App.view.source;
        if (entry.kind !== 'file') return null;
        const parent = P.parent(entry.path);
        if (src.recursive && src.type === 'folder') {
            if (parent === src.path) return null;
            return { dir: parent, text: src.path ? parent.slice(src.path.length + 1) : parent };
        }
        if (src.type === 'search' || src.type === 'smart') {
            return { dir: parent, text: parent || App.state.workspace?.name || '' };
        }
        return null;
    }

    function decorate(card, entry) {
        const b = badgeFolder(entry);
        if (!b) return;
        const segs = b.text.split('/');
        const short = segs.length > 2 ? `…/${segs.slice(-2).join('/')}` : b.text;
        const badge = h('button', {
            class: 'nav-subdir',
            type: 'button',
            tabindex: '-1',
            'data-tip': `${b.text} 폴더로 가기`,
            'aria-label': `${b.text} 폴더로 가기`,
            html: `${ui.icon('folder', { size: 11 })}<span>${escapeHtml(App.navMatch.normalize(short))}</span>`,
        });
        badge.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            if (e.button === 0) e.preventDefault();
        });
        badge.addEventListener('dblclick', (e) => e.stopPropagation());
        badge.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            App.topbar?.clearSearch?.();
            App.nav.go(b.dir, { focus: entry.path }).then(() => App.gallery?.scrollTo?.(entry.path, { center: true }));
        });
        const media = card.querySelector('.card-media') || card;
        media.append(badge);
    }

    // ---------- View bar toggle ----------
    function viewbarItem() {
        const src = App.view.source;
        if (!App.fs.ready || src.type !== 'folder') return null;
        const dir = App.state.cwd;
        const on = isOn(dir);
        const waiting = on && pending === dir;
        const btn = h('button', {
            class: `btn ghost sm nav-rec-toggle${on ? ' active' : ''}`,
            type: 'button',
            'aria-pressed': String(on),
            'data-tip': on ? '바로 안의 항목만 보기' : '하위 폴더의 사진·영상까지 한꺼번에 보기',
            'data-tip-keys': 'Alt+R',
            html: `${waiting ? '<span class="spinner"></span>' : ui.icon('layers', { size: 14 })}<span>하위 폴더 포함</span>`,
        });
        btn.addEventListener('click', toggle);
        return btn;
    }

    App.commands.register({
        id: 'nav.toggleRecursive',
        title: '하위 폴더 포함해서 보기',
        group: '보기',
        icon: 'layers',
        keys: ['Alt+R'],
        allowInInput: false,
        when: () => App.fs.ready && App.state.cwd != null && App.view.source.type === 'folder',
        run: () => toggle(),
    });

    App.register('navSubfolders', {
        init() {
            App.topbar?.addViewbarItem(viewbarItem);
            App.gallery?.cardDecorators?.push(decorate);

            if (hooked()) {
                // Core supports load hooks: produce the recursive list inside nav.load()
                App.nav.loadHooks.push(async (dir) => {
                    if (!isOn(dir)) return null;
                    if (!App.index.ready) {
                        apply();
                        return null;
                    }
                    return { entries: recursiveEntries(dir), source: { recursive: true, hiddenCount: 0 } };
                });
            }

            App.bus.on('folder:loading', ({ path }) => {
                savedSelection = isOn(path) && App.view.source.recursive && App.view.source.path === path ? { paths: App.select.list(), focus: App.select.focus } : null;
            });
            App.bus.on('folder:loaded', ({ path }) => {
                if (!isOn(path)) return;
                if (hooked() && App.view.source.recursive) return;
                apply({ keep: savedSelection });
                savedSelection = null;
            });
            // Files changed somewhere below: refresh the flattened list
            const refreshSoon = App.util.debounce(() => {
                if (App.view.source.type === 'folder' && App.view.source.recursive && isOn(App.state.cwd)) apply();
            }, 150);
            App.bus.on('index:changed', refreshSoon);
            App.bus.on('fs:changed', (c) => {
                if (!(c.from && c.to && (c.type === 'rename' || c.type === 'move'))) return;
                const list = onList();
                let changed = false;
                const next = list.map((p) => {
                    for (let i = 0; i < c.from.length; i++) {
                        const r = P.rebase(p, c.from[i], c.to[i]);
                        if (r != null && r !== p) {
                            changed = true;
                            return r;
                        }
                    }
                    return p;
                });
                if (changed) App.settings.set(key(), next);
            });
        },
    });

    App.navSubfolders = { isOn, set, toggle, openRecursive, apply };
})();
