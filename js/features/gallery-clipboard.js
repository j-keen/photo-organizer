/*
 * File clipboard (team: gallery): Mod+C / Mod+X / Mod+V copy, cut and paste files between folders.
 *   App.gallery.clipboard — { mode: 'copy'|'cut'|null, paths, count, has(p), set(mode, paths), clear() }
 * Paste goes through App.gallery.transfer (App.fs.copy / App.fs.move: one undo entry, toast with [실행 취소]).
 * Cut items stay dimmed until they're pasted; Esc cancels a cut when nothing is selected.
 * When the file clipboard is empty, Ctrl+V pastes images from the system clipboard (e.g. screenshots) into the folder.
 * Event: 'clipboard:changed' { mode, count }
 */
(() => {
    'use strict';
    const { path: P, formatCount } = App.util;
    const ui = App.ui;

    const clip = { mode: null, paths: [], set: new Set() };

    function syncCutClasses() {
        App.gallery?.forEachRendered?.((el, p) => el.classList.toggle('is-cut', clip.mode === 'cut' && clip.set.has(p)));
    }

    function changed() {
        syncCutClasses();
        App.bus.emit('clipboard:changed', { mode: clip.mode, count: clip.paths.length });
    }

    const clipboard = {
        get mode() {
            return clip.mode;
        },
        get paths() {
            return [...clip.paths];
        },
        get count() {
            return clip.paths.length;
        },
        has(p) {
            return clip.set.has(p);
        },
        set(mode, paths) {
            clip.mode = paths.length ? (mode === 'cut' ? 'cut' : 'copy') : null;
            clip.paths = paths.slice();
            clip.set = new Set(clip.paths);
            changed();
        },
        clear() {
            if (!clip.paths.length && !clip.mode) return;
            clipboard.set(null, []);
        },
    };

    function take(mode) {
        const paths = App.select.list();
        if (!paths.length) return;
        clipboard.set(mode, paths);
        const n = formatCount(paths.length);
        const keys = App.commands.displayCombo('Mod+V');
        ui.toast(mode === 'cut' ? `${n}개를 잘라냈어요. 옮길 폴더에서 ${keys}를 눌러 주세요.` : `${n}개를 복사했어요. 붙여 넣을 폴더에서 ${keys}를 눌러 주세요.`, { type: 'info', duration: 2600, id: 'gallery-clipboard' });
        // Other apps get the file names as text (best effort; the browser may refuse without a user gesture)
        try {
            const w = navigator.clipboard && navigator.clipboard.writeText(paths.map((p) => P.base(p)).join('\n'));
            if (w && w.catch) w.catch(() => {});
        } catch (e) {
            /* clipboard API unavailable (file://) */
        }
    }

    async function paste(dir) {
        if (!clip.paths.length) return [];
        const dest = dir != null ? dir : App.view.source.type === 'folder' ? App.state.cwd : null;
        if (dest == null) {
            ui.toast('붙여 넣을 폴더를 먼저 열어 주세요', { type: 'warning' });
            return [];
        }
        const cut = clip.mode === 'cut';
        const results = await App.gallery.transfer(clip.paths.slice(), dest, cut ? 'move' : 'copy');
        if (cut && results.length) clipboard.clear(); // a cut pastes once; a copy can be pasted again
        return results;
    }

    const canTake = () => App.fs.ready && App.select.count > 0;

    App.commands.register({ id: 'file.copy', title: '복사', group: '편집', icon: 'copy', keys: ['Mod+C'], when: canTake, run: () => take('copy') });
    App.commands.register({ id: 'file.cut', title: '잘라내기', group: '편집', icon: 'scissors', keys: ['Mod+X'], when: canTake, run: () => take('cut') });
    App.commands.register({
        id: 'file.paste',
        title: '붙여넣기',
        group: '편집',
        icon: 'g-paste',
        keys: ['Mod+V'],
        // Disabled while the file clipboard is empty so Ctrl+V reaches the browser (system clipboard images)
        when: () => App.fs.ready && clip.paths.length > 0,
        run: (args) => paste(args && args.dir != null ? args.dir : null),
    });
    App.commands.register({
        id: 'clipboard.cancel',
        title: '잘라내기 취소',
        group: '편집',
        keys: ['Escape'],
        when: () => clip.mode === 'cut' && App.select.count === 0,
        run: () => {
            clipboard.clear();
            ui.toast('잘라내기를 취소했어요', { type: 'info', duration: 1800, id: 'gallery-clipboard' });
        },
    });

    // ---------- System clipboard: paste screenshots / copied images into the current folder ----------
    const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/avif': 'avif', 'video/mp4': 'mp4', 'video/webm': 'webm' };

    function stamp() {
        const d = new Date();
        const p2 = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}.${p2(d.getSeconds())}`;
    }

    function onSystemPaste(e) {
        if (clip.paths.length) return; // the file clipboard wins (handled by the Mod+V command)
        if (!App.fs.ready || App.layers.top() !== 'main' || App.view.source.type !== 'folder') return;
        if (App.util.isTypingTarget(e.target) || App.util.isTypingTarget(document.activeElement)) return;
        const files = [...((e.clipboardData && e.clipboardData.files) || [])].filter((f) => App.util.mediaType(f.name) !== 'other' || MIME_EXT[f.type]);
        if (!files.length) return;
        e.preventDefault();
        const when = stamp();
        const named = files.map((f, i) => {
            // Screenshots arrive as "image.png": give them a readable, unique name
            if (f.name && App.util.mediaType(f.name) !== 'other' && !/^image\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name)) return f;
            const ext = MIME_EXT[f.type] || P.ext(f.name) || 'png';
            return new File([f], `붙여넣은 이미지 ${when}${files.length > 1 ? ` (${i + 1})` : ''}.${ext}`, { type: f.type, lastModified: Date.now() });
        });
        App.gallery.importFiles(named, App.state.cwd, { verb: '붙여 넣었어요' });
    }

    App.register('gallery-clipboard', {
        init() {
            App.gallery._itemHooks.push((el, entry) => {
                if (clip.mode === 'cut' && clip.set.has(entry.path)) el.classList.add('is-cut');
            });
            document.addEventListener('paste', onSystemPaste);
            // Keep clipboard paths valid when things are renamed, moved or deleted meanwhile
            App.bus.on('fs:changed', (c) => {
                if (!clip.paths.length) return;
                let paths = clip.paths;
                let dirty = false;
                if (c.from && c.to && (c.type === 'move' || c.type === 'rename')) {
                    paths = paths.map((p) => {
                        for (let i = 0; i < c.from.length; i++) {
                            const r = P.rebase(p, c.from[i], c.to[i]);
                            if (r != null && r !== p) {
                                dirty = true;
                                return r;
                            }
                        }
                        return p;
                    });
                }
                if (c.type === 'trash' || c.type === 'delete') {
                    const before = paths.length;
                    paths = paths.filter((p) => !c.paths.some((x) => P.isInside(p, x)));
                    dirty = dirty || paths.length !== before;
                }
                if (dirty) clipboard.set(clip.mode, paths);
            });
            App.bus.on('workspace:closed', () => clipboard.clear());
            App.bus.on('workspace:opened', () => clipboard.clear());
        },
    });

    App.gallery.clipboard = clipboard;
})();
