/*
 * ServerBackend: App.fs backend talking to the local Python server (docs/server-api.md).
 *
 *   const backend = new App.ServerBackend({ token, root, name, id, capabilities });   // from POST /api/workspace/open
 *   await App.workspace.openBackend(backend);
 *
 * Implements the backend interface of docs/ARCHITECTURE.md §4 (list/stat/exists/getFile/write/mkdir/remove/move/copy/url)
 * plus the optional thumbUrl(entry, size), reveal(p), capabilities — and a few server extras:
 * streamUrl(p, {start}), openDefault(p), probe(entryOrPath), canThumb(entry), reopen().
 *
 * App.ServerBackend.api is the low-level JSON client shared with App.server (js/features/server.js):
 *   api.request(method, path, { query, body, raw, signal, cache, retry, onNoWorkspace }) → JSON | Response (raw) | null (204)
 *   api.ensureSession(force) → GET /api/session (sets the HttpOnly session cookie), api.url(path, query)
 * Errors carry .code (ENOENT, EEXIST, EINVAL, EPERM, EBUSY, ESERVER, ENOWS, ENOTSUP, EOFFLINE) and .status.
 * Every request carries the workspace token (?ws=) so tabs with different workspaces never cross wires;
 * an expired session or a restarted server is recovered transparently (one retry).
 * Expected misses use quiet endpoints (exists, missingOk, soft) so the console stays clean.
 */
(() => {
    'use strict';
    const { path: P, mediaType, browserCanDecode } = App.util;
    const TRASH_PREFIX = '.fluid-organizer/trash/';

    const apiError = (code, message, status) => Object.assign(new Error(message), { code, status });
    let sessionPromise = null;
    let online = null;

    const api = {
        base: '', // same origin: the page is served by the server

        session: null,

        url(path, query = {}) {
            const params = new URLSearchParams();
            for (const [key, value] of Object.entries(query)) if (value != null) params.set(key, String(value));
            const qs = params.toString();
            return api.base + path + (qs ? '?' + qs : '');
        },

        setOnline(value) {
            if (online === value) return;
            online = value;
            App.bus.emit('server:online', { online: value });
        },

        ensureSession(force = false) {
            if (!sessionPromise || force) {
                const promise = api.request('GET', '/api/session', { retry: false }).then((session) => {
                    api.session = session;
                    App.bus.emit('server:session', session);
                    return session;
                });
                sessionPromise = promise;
                promise.catch(() => {
                    if (sessionPromise === promise) sessionPromise = null;
                });
            }
            return sessionPromise;
        },

        async request(method, path, opts = {}) {
            method = method.toUpperCase();
            const headers = new Headers(opts.headers || {});
            if (method !== 'GET' && method !== 'HEAD') headers.set('X-FI-Client', '1');
            let body = opts.body;
            if (body != null && Object.getPrototypeOf(body) === Object.prototype) {
                headers.set('Content-Type', 'application/json');
                body = JSON.stringify(body);
            }
            let response;
            try {
                response = await fetch(api.url(path, opts.query), {
                    method,
                    headers,
                    body,
                    signal: opts.signal,
                    credentials: 'same-origin',
                    cache: opts.cache || 'no-store',
                });
            } catch (cause) {
                if (opts.signal?.aborted) throw cause;
                api.setOnline(false);
                throw apiError('EOFFLINE', "로컬 서버가 꺼져 있어요. 바탕화면의 '사진영상정리기' 아이콘으로 켜 주세요");
            }
            api.setOnline(true);
            if (response.ok) {
                if (opts.raw) return response;
                return response.status === 204 ? null : response.json();
            }
            const detail = (await response.json().catch(() => null))?.error || {};
            const err = apiError(detail.code || 'ESERVER', detail.message || '로컬 서버가 요청을 처리하지 못했어요', response.status);
            if (opts.retry !== false && err.code === 'ESESSION') {
                await api.ensureSession(true);
                return api.request(method, path, { ...opts, retry: false });
            }
            if (opts.retry !== false && err.code === 'ENOWS' && typeof opts.onNoWorkspace === 'function') {
                await opts.onNoWorkspace();
                return api.request(method, path, { ...opts, retry: false });
            }
            throw err;
        },
    };

    // Body for PUT /api/fs/file: Blob/ArrayBuffer/views go as-is, text becomes a Blob
    function rawBody(data) {
        if (typeof data === 'string') return new Blob([data]);
        if (data instanceof Blob || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data;
        return new Blob([JSON.stringify(data)]);
    }

    class ServerBackend {
        constructor({ token, root, name, id, capabilities } = {}) {
            this.kind = 'server';
            this.token = token;
            this.root = root;
            this.name = name;
            this.id = id;
            this.capabilities = capabilities || api.session?.capabilities || {};
            this._probes = new Map();
            this._reopening = null;
        }

        req(method, path, opts = {}) {
            return api.request(method, path, { ...opts, query: { ...opts.query, ws: this.token }, onNoWorkspace: () => this.reopen() });
        }

        /** The server forgot this workspace (restart): open it again by its folder path. */
        reopen() {
            if (!this._reopening) {
                this._reopening = api
                    .request('POST', '/api/workspace/open', { body: { root: this.root }, retry: false })
                    .then((ws) => {
                        this.token = ws.token;
                        this.name = ws.name;
                        this.id = ws.id;
                        return this;
                    })
                    .finally(() => {
                        this._reopening = null;
                    });
            }
            return this._reopening;
        }

        // ----- backend interface -----
        async list(dir) {
            return (await this.req('GET', '/api/fs/list', { query: { path: dir } })).entries;
        }

        stat(path) {
            return this.req('GET', '/api/fs/stat', { query: { path } });
        }

        async exists(path) {
            return (await this.req('GET', '/api/fs/exists', { query: { path } })).exists;
        }

        async getFile(path) {
            const res = await this.req('GET', '/api/fs/file', { query: { path, missingOk: 1 }, raw: true });
            if (res.status === 204) throw apiError('ENOENT', `찾을 수 없어요: ${path}`, 404);
            const blob = await res.blob();
            return new File([blob], P.base(path), {
                type: blob.type,
                lastModified: Number(res.headers.get('X-FI-Mtime')) || Date.now(),
            });
        }

        write(path, data) {
            return this.req('PUT', '/api/fs/file', { query: { path }, body: rawBody(data) });
        }

        mkdir(path) {
            return this.req('POST', '/api/fs/mkdir', { body: { path } });
        }

        // Emptying the app trash sends files to the Windows Recycle Bin as a last safety net
        remove(path) {
            return this.req('POST', '/api/fs/remove', { body: { path, recycle: path.startsWith(TRASH_PREFIX) } });
        }

        async move(src, destDir, newName) {
            await this.req('POST', '/api/fs/move', { body: { src, destDir, name: newName } });
            return { native: true };
        }

        copy(src, destDir, newName) {
            return this.req('POST', '/api/fs/copy', { body: { src, destDir, name: newName } });
        }

        /** URL for <img>/<video>. Formats the browser can't decode get a server-rendered preview or a live stream. */
        async url(path, { raw = false } = {}) {
            let url = this.fileUrl(path);
            if (!raw && !browserCanDecode(path)) {
                const type = mediaType(path);
                if (type === 'image') url = this.thumbUrl({ path, name: P.base(path), kind: 'file' }, 2560) || url;
                else if (type === 'video' && this.capabilities.ffmpeg !== false) url = this.streamUrl(path);
            }
            return { url, release() {} };
        }

        // ----- optional extras -----
        fileUrl(path) {
            return api.url('/api/fs/file', { path, ws: this.token });
        }

        canThumb(entry) {
            if (!entry || entry.kind !== 'file') return false;
            const name = entry.name || P.base(entry.path || '');
            const ext = P.ext(name);
            const type = mediaType(name);
            if (type === 'video') return this.capabilities.ffmpeg !== false;
            if (type !== 'image' || ext === 'svg') return false;
            if (ext === 'heic' || ext === 'heif') return this.capabilities.heif !== false;
            return true;
        }

        /** Versioned (immutable, browser-cacheable) thumbnail URL, or null when the server can't render this file. */
        thumbUrl(entry, size = 360) {
            if (!this.canThumb(entry)) return null;
            return api.url('/api/thumb', { path: entry.path, size, v: `${entry.size ?? 0}-${entry.mtime ?? 0}`, ws: this.token });
        }

        streamUrl(path, { start } = {}) {
            return api.url('/api/media/stream', { path, start: start || null, ws: this.token });
        }

        reveal(path) {
            return this.req('POST', '/api/fs/reveal', { body: { path } });
        }

        openDefault(path) {
            return this.req('POST', '/api/fs/open', { body: { path } });
        }

        /** Media info (codecs, fps, camera...). Resolves null when the file is gone. Entries are cached per path+size+mtime. */
        probe(entryOrPath) {
            const entry = typeof entryOrPath === 'string' ? null : entryOrPath;
            const path = entry ? entry.path : entryOrPath;
            if (!entry || entry.mtime == null) return this.req('GET', '/api/media/probe', { query: { path, soft: 1 } }); // no version: always fresh
            const key = `${path}|${entry.size ?? 0}|${entry.mtime}`;
            if (!this._probes.has(key)) {
                const promise = this.req('GET', '/api/media/probe', { query: { path, soft: 1 } });
                this._probes.set(key, promise);
                promise.then((v) => v ?? this._probes.delete(key), () => this._probes.delete(key));
                if (this._probes.size > 500) this._probes.delete(this._probes.keys().next().value);
            }
            return this._probes.get(key);
        }
    }

    ServerBackend.api = api;
    App.ServerBackend = ServerBackend;
})();
