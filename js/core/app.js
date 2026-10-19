/*
 * App core: namespace, event bus, shared state, utilities, settings, module lifecycle,
 * commands/shortcuts and undo. Every other script attaches to window.App.
 * Classic script (no ES modules) so the app runs straight from file:// as well as from the local server.
 */
(() => {
    'use strict';

    // ---------- Event bus ----------
    const listeners = new Map();

    const bus = {
        on(event, fn) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event).add(fn);
            return () => bus.off(event, fn);
        },
        off(event, fn) {
            const set = listeners.get(event);
            if (set) set.delete(fn);
        },
        once(event, fn) {
            const off = bus.on(event, (payload) => {
                off();
                fn(payload);
            });
            return off;
        },
        emit(event, payload) {
            for (const key of [event, '*']) {
                const set = listeners.get(key);
                if (!set) continue;
                for (const fn of [...set]) {
                    try {
                        key === '*' ? fn(event, payload) : fn(payload);
                    } catch (e) {
                        console.error(`[bus] handler for "${event}" failed`, e);
                    }
                }
            }
        },
    };

    // ---------- Utilities ----------
    const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'heic', 'heif', 'tif', 'tiff', 'svg', 'jfif'];
    const VIDEO_EXT = ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi', 'wmv', 'flv', '3gp', 'ts', 'm2ts', 'mts', 'mpg', 'mpeg'];
    // Formats Chromium can decode natively (others need the local server)
    const BROWSER_IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'svg', 'jfif'];
    const BROWSER_VIDEO_EXT = ['mp4', 'm4v', 'webm', 'mov', 'mkv'];

    const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

    const path = {
        join(...parts) {
            return parts.filter((p) => p !== '' && p != null).join('/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
        },
        parent(p) {
            const i = p.lastIndexOf('/');
            return i < 0 ? '' : p.slice(0, i);
        },
        base(p) {
            const i = p.lastIndexOf('/');
            return i < 0 ? p : p.slice(i + 1);
        },
        ext(p) {
            const b = path.base(p);
            const i = b.lastIndexOf('.');
            return i <= 0 ? '' : b.slice(i + 1).toLowerCase();
        },
        stem(p) {
            const b = path.base(p);
            const i = b.lastIndexOf('.');
            return i <= 0 ? b : b.slice(0, i);
        },
        // true if child === parent or child is inside parent ('' is the workspace root)
        isInside(child, parent) {
            if (parent === '') return true;
            return child === parent || child.startsWith(parent + '/');
        },
        // Rewrite p if it lives under `from` (used after moves/renames)
        rebase(p, from, to) {
            if (p === from) return to;
            if (p.startsWith(from + '/')) return to + p.slice(from.length);
            return null;
        },
        segments(p) {
            return p ? p.split('/') : [];
        },
    };

    const util = {
        IMAGE_EXT,
        VIDEO_EXT,
        BROWSER_IMAGE_EXT,
        BROWSER_VIDEO_EXT,
        path,

        mediaType(name) {
            const ext = path.ext(name);
            if (IMAGE_EXT.includes(ext)) return 'image';
            if (VIDEO_EXT.includes(ext)) return 'video';
            return 'other';
        },

        browserCanDecode(name) {
            const ext = path.ext(name);
            return BROWSER_IMAGE_EXT.includes(ext) || BROWSER_VIDEO_EXT.includes(ext);
        },

        compareNames(a, b) {
            return collator.compare(a, b);
        },

        debounce(fn, ms) {
            let t = null;
            const debounced = (...args) => {
                clearTimeout(t);
                t = setTimeout(() => fn(...args), ms);
            };
            debounced.flush = (...args) => {
                clearTimeout(t);
                return fn(...args);
            };
            debounced.cancel = () => clearTimeout(t);
            return debounced;
        },

        throttle(fn, ms) {
            let last = 0;
            let t = null;
            return (...args) => {
                const now = performance.now();
                const wait = ms - (now - last);
                clearTimeout(t);
                if (wait <= 0) {
                    last = now;
                    fn(...args);
                } else {
                    t = setTimeout(() => {
                        last = performance.now();
                        fn(...args);
                    }, wait);
                }
            };
        },

        sleep(ms) {
            return new Promise((r) => setTimeout(r, ms));
        },

        nextFrame() {
            return new Promise((r) => requestAnimationFrame(() => r()));
        },

        clamp(v, min, max) {
            return Math.min(max, Math.max(min, v));
        },

        uid(prefix = '') {
            return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        },

        escapeHtml(s) {
            return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
        },

        formatBytes(n) {
            if (n == null || isNaN(n)) return '—';
            if (n < 1024) return `${n} B`;
            const units = ['KB', 'MB', 'GB', 'TB'];
            let v = n / 1024;
            let i = 0;
            while (v >= 1024 && i < units.length - 1) {
                v /= 1024;
                i++;
            }
            return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
        },

        formatDuration(sec) {
            if (sec == null || !isFinite(sec)) return '';
            sec = Math.max(0, Math.round(sec));
            const h = Math.floor(sec / 3600);
            const m = Math.floor((sec % 3600) / 60);
            const s = sec % 60;
            const mm = h ? String(m).padStart(2, '0') : String(m);
            return (h ? `${h}:` : '') + `${mm}:${String(s).padStart(2, '0')}`;
        },

        formatDate(ms, withTime = false) {
            if (!ms) return '—';
            const d = new Date(ms);
            const date = `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
            if (!withTime) return date;
            return `${date} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        },

        formatCount(n) {
            return Number(n || 0).toLocaleString('ko-KR');
        },

        // Run fn over items with at most `limit` concurrent promises. Results keep input order.
        async pool(items, limit, fn) {
            const results = new Array(items.length);
            let next = 0;
            const worker = async () => {
                while (next < items.length) {
                    const i = next++;
                    try {
                        results[i] = await fn(items[i], i);
                    } catch (e) {
                        results[i] = undefined;
                        console.warn('[pool] item failed', items[i], e);
                    }
                }
            };
            await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
            return results;
        },

        // Stable identity for a file's content version (survives renames/moves done natively)
        fingerprint(entry) {
            return `${entry.size ?? 0}-${entry.mtime ?? 0}`;
        },

        // Tiny DOM builder: h('div', {class: 'x', onclick: fn, dataset: {...}}, child, 'text', ...)
        h(tag, attrs, ...children) {
            const el = document.createElement(tag);
            if (attrs) {
                for (const [k, v] of Object.entries(attrs)) {
                    if (v == null || v === false) continue;
                    if (k === 'class') el.className = v;
                    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
                    else if (k === 'dataset') Object.assign(el.dataset, v);
                    else if (k === 'html') el.innerHTML = v;
                    else if (k === 'text') el.textContent = v;
                    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
                    else if (v === true) el.setAttribute(k, '');
                    else el.setAttribute(k, v);
                }
            }
            for (const c of children.flat()) {
                if (c == null || c === false) continue;
                el.append(c instanceof Node ? c : document.createTextNode(String(c)));
            }
            return el;
        },

        isTypingTarget(el) {
            if (!el) return false;
            const tag = el.tagName;
            return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
        },
    };

    // ---------- Settings (per-browser preferences, localStorage) ----------
    const SETTINGS_KEY = 'fi.settings.v1';
    let settingsCache = null;

    const settings = {
        all() {
            if (!settingsCache) {
                try {
                    settingsCache = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
                } catch (e) {
                    settingsCache = {};
                }
            }
            return settingsCache;
        },
        get(key, fallback) {
            const v = settings.all()[key];
            return v === undefined ? fallback : v;
        },
        set(key, value) {
            settings.all()[key] = value;
            try {
                localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsCache));
            } catch (e) {
                /* storage may be unavailable (private mode) */
            }
            bus.emit('settings:changed', { key, value });
        },
    };

    // ---------- Shared state ----------
    // Small, explicit store. Feature modules read App.state.x and listen for 'state:x'.
    const state = {
        workspace: null, // { name, id }
        cwd: null, // current folder path ('' = workspace root), null when no workspace
        layer: 'main', // top-most interactive layer: 'main' | 'viewer' | 'dialog' | 'menu'
    };

    function setState(patch) {
        for (const [key, value] of Object.entries(patch)) {
            if (state[key] === value) continue;
            state[key] = value;
            bus.emit('state:' + key, value);
        }
    }

    // ---------- Layers (decide who receives keyboard shortcuts) ----------
    const layerStack = ['main'];
    const layers = {
        push(name) {
            layerStack.push(name);
            setState({ layer: name });
        },
        pop(name) {
            const i = layerStack.lastIndexOf(name);
            if (i > 0) layerStack.splice(i, 1);
            setState({ layer: layerStack[layerStack.length - 1] });
        },
        top() {
            return layerStack[layerStack.length - 1];
        },
    };

    // ---------- Commands & keyboard shortcuts ----------
    const commandMap = new Map();
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

    // Canonical combo string: modifiers in fixed order + key, e.g. "Mod+Shift+Z", "Alt+ArrowLeft", "Delete", "?"
    function comboFromEvent(e) {
        const parts = [];
        if (isMac ? e.metaKey : e.ctrlKey) parts.push('Mod');
        if (e.altKey) parts.push('Alt');
        let key = e.key;
        if (key === ' ') key = 'Space';
        if (key.length === 1) key = key.toUpperCase();
        // Shift is implied by printable symbols like "?" — only record it for named keys and letters
        if (e.shiftKey && (key.length > 1 || /[A-Z0-9]/.test(key))) parts.push('Shift');
        parts.push(key);
        return parts.join('+');
    }

    function normalizeCombo(combo) {
        const parts = combo.split('+');
        const key = parts.pop();
        const mods = ['Mod', 'Alt', 'Shift'].filter((m) => parts.includes(m) || (m === 'Mod' && parts.includes('Ctrl')));
        return [...mods, key.length === 1 ? key.toUpperCase() : key].join('+');
    }

    function displayCombo(combo) {
        return normalizeCombo(combo)
            .split('+')
            .map((p) => ({ Mod: isMac ? '⌘' : 'Ctrl', Alt: isMac ? '⌥' : 'Alt', Shift: isMac ? '⇧' : 'Shift', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Space: 'Space', Escape: 'Esc', Delete: 'Del', Backspace: '⌫', Enter: 'Enter' })[p] || p)
            .join(isMac ? '' : '+');
    }

    const commands = {
        /**
         * Register a command.
         * @param {object} cmd { id, title, group?, icon?, keys?: string|string[], scope?: 'main'|'viewer'|'global',
         *                       allowInInput?: bool | string[] (combos that still fire while typing in a field),
         *                       when?: () => bool, run: (args) => any }
         */
        register(cmd) {
            if (!cmd.id || typeof cmd.run !== 'function') throw new Error('command needs id and run');
            const existing = commandMap.get(cmd.id);
            if (existing && existing.core && !cmd.core) {
                // Core commands (undo/redo, ...) can't be replaced by feature modules
                console.debug(`[commands] "${cmd.id}" is a core command; feature registration ignored`);
                return existing;
            }
            cmd.keys = (Array.isArray(cmd.keys) ? cmd.keys : cmd.keys ? [cmd.keys] : []).map(normalizeCombo);
            cmd.scope = cmd.scope || 'main';
            commandMap.set(cmd.id, cmd);
            bus.emit('commands:changed');
            return cmd;
        },
        get(id) {
            return commandMap.get(id);
        },
        list() {
            return [...commandMap.values()];
        },
        isEnabled(id) {
            const cmd = commandMap.get(id);
            if (!cmd) return false;
            try {
                return !cmd.when || !!cmd.when();
            } catch (e) {
                return false;
            }
        },
        async run(id, args) {
            const cmd = commandMap.get(id);
            if (!cmd) {
                console.warn('[commands] unknown command', id);
                return;
            }
            if (!commands.isEnabled(id)) return;
            try {
                return await cmd.run(args);
            } catch (e) {
                console.error(`[commands] ${id} failed`, e);
                App.ui?.toast?.(`작업 실패: ${e.message || e}`, { type: 'error' });
            }
        },
        displayKeys(id) {
            const cmd = commandMap.get(id);
            return cmd && cmd.keys.length ? displayCombo(cmd.keys[0]) : '';
        },
        displayCombo,
        comboFromEvent,
    };

    document.addEventListener('keydown', (e) => {
        if (e.defaultPrevented || e.isComposing) return;
        const layer = layers.top();
        if (layer === 'dialog' || layer === 'menu') return; // dialogs/menus handle their own keys
        const combo = comboFromEvent(e);
        const typing = util.isTypingTarget(e.target);
        for (const cmd of commandMap.values()) {
            if (!cmd.keys.includes(combo)) continue;
            if (cmd.scope !== 'global' && cmd.scope !== layer) continue;
            if (typing && !(cmd.allowInInput === true || (Array.isArray(cmd.allowInInput) && cmd.allowInInput.map(normalizeCombo).includes(combo)))) continue;
            if (!commands.isEnabled(cmd.id)) continue;
            e.preventDefault();
            e.stopPropagation();
            commands.run(cmd.id, { event: e });
            return;
        }
    });

    // ---------- Undo / redo ----------
    // Every user-visible change pushes one entry; Ctrl+Z / Ctrl+Y work from any screen (core commands below).
    const undoStack = [];
    const redoStack = [];
    const UNDO_LIMIT = 200;
    const COALESCE_MS = 4000;
    let undoBusy = Promise.resolve();

    function runSerial(fn) {
        // Undo/redo steps never interleave, even if the user mashes Ctrl+Z
        const next = undoBusy.then(fn, fn);
        undoBusy = next.catch(() => {});
        return next;
    }

    const undo = {
        /**
         * push({ label, undo: async () => void, redo: async () => void, coalesceKey? })
         * Entries with the same coalesceKey pushed within a few seconds merge into one (e.g. typing a memo):
         * the merged entry keeps the oldest undo() and the newest redo().
         */
        push(entry) {
            entry.time = Date.now();
            const last = undoStack[undoStack.length - 1];
            if (entry.coalesceKey && last && last.coalesceKey === entry.coalesceKey && entry.time - last.time < COALESCE_MS && !redoStack.length) {
                last.redo = entry.redo;
                last.time = entry.time;
                last.label = entry.label || last.label;
                bus.emit('undo:changed');
                return last;
            }
            undoStack.push(entry);
            if (undoStack.length > UNDO_LIMIT) undoStack.shift();
            redoStack.length = 0;
            bus.emit('undo:changed');
            return entry;
        },
        canUndo: () => undoStack.length > 0,
        canRedo: () => redoStack.length > 0,
        peek: () => undoStack[undoStack.length - 1] || null,
        peekRedo: () => redoStack[redoStack.length - 1] || null,
        /** Newest first: [{ label, time }] (undo stack), and redo items via list({ redo: true }) */
        list({ redo = false } = {}) {
            return [...(redo ? redoStack : undoStack)].reverse().map((e) => ({ label: e.label, time: e.time }));
        },
        undo({ quiet = false } = {}) {
            return runSerial(async () => {
                const entry = undoStack.pop();
                if (!entry) return;
                try {
                    await entry.undo();
                    redoStack.push(entry);
                    if (!quiet) App.ui?.toast?.(`실행 취소: ${entry.label}`, { type: 'info', duration: 2200, id: 'undo-toast' });
                } catch (e) {
                    console.error('[undo] failed', e);
                    App.ui?.toast?.(`실행 취소 실패: ${e.message || e}`, { type: 'error' });
                }
                bus.emit('undo:changed');
            });
        },
        redo({ quiet = false } = {}) {
            return runSerial(async () => {
                const entry = redoStack.pop();
                if (!entry) return;
                try {
                    await entry.redo();
                    undoStack.push(entry);
                    if (!quiet) App.ui?.toast?.(`다시 실행: ${entry.label}`, { type: 'info', duration: 2200, id: 'undo-toast' });
                } catch (e) {
                    console.error('[redo] failed', e);
                    App.ui?.toast?.(`다시 실행 실패: ${e.message || e}`, { type: 'error' });
                }
                bus.emit('undo:changed');
            });
        },
        /** Undo the n newest entries (n = index in list() + 1) */
        async undoTo(n) {
            for (let i = 0; i < n && undoStack.length; i++) await undo.undo({ quiet: i < n - 1 });
        },
        clear() {
            undoStack.length = 0;
            redoStack.length = 0;
            bus.emit('undo:changed');
        },
    };

    // Global: fire in the gallery, viewer, quick look, panels... (text fields keep their native undo)
    commands.register({ id: 'edit.undo', core: true, title: '실행 취소', group: '편집', icon: 'undo', keys: ['Mod+Z'], scope: 'global', when: () => undo.canUndo(), run: () => undo.undo() });
    commands.register({ id: 'edit.redo', core: true, title: '다시 실행', group: '편집', icon: 'redo', keys: ['Mod+Shift+Z', 'Mod+Y'], scope: 'global', when: () => undo.canRedo(), run: () => undo.redo() });

    // ---------- Tiny IndexedDB key-value store ----------
    // App.idb.get/set/del/keys on a named object store. Used for directory handles, caches, recents.
    const dbPromises = new Map();

    function openDb(name, stores) {
        const key = name;
        if (!dbPromises.has(key)) {
            dbPromises.set(key, new Promise((resolve, reject) => {
                const req = indexedDB.open(name, 1);
                req.onupgradeneeded = () => {
                    for (const s of stores) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            }));
        }
        return dbPromises.get(key);
    }

    function idbStore(dbName, storeName, allStores) {
        const tx = async (mode, fn) => {
            const db = await openDb(dbName, allStores);
            return new Promise((resolve, reject) => {
                const t = db.transaction(storeName, mode);
                const req = fn(t.objectStore(storeName));
                t.oncomplete = () => resolve(req && req.result);
                t.onerror = () => reject(t.error);
                t.onabort = () => reject(t.error);
            });
        };
        return {
            get: (k) => tx('readonly', (s) => s.get(k)),
            set: (k, v) => tx('readwrite', (s) => s.put(v, k)),
            del: (k) => tx('readwrite', (s) => s.delete(k)),
            keys: () => tx('readonly', (s) => s.getAllKeys()),
            clear: () => tx('readwrite', (s) => s.clear()),
        };
    }

    const idb = idbStore('fluid-identity', 'kv', ['kv']);
    idb.store = (dbName, storeName, allStores = [storeName]) => idbStore(dbName, storeName, allStores);

    // ---------- Module lifecycle ----------
    const moduleList = [];

    function register(name, mod) {
        moduleList.push({ name, mod });
        return mod;
    }

    async function start() {
        document.documentElement.dataset.theme = settings.get('theme', 'dark');
        for (const { name, mod } of moduleList) {
            if (typeof mod.init !== 'function') continue;
            try {
                await mod.init();
            } catch (e) {
                console.error(`[app] module "${name}" failed to init`, e);
            }
        }
        bus.emit('app:ready');
    }

    window.App = {
        version: '2.0.0-alpha',
        bus,
        util,
        settings,
        state,
        setState,
        layers,
        commands,
        undo,
        idb,
        register,
        start,
        modules: moduleList,
    };
})();
