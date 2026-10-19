/*
 * One writer per workspace. Two windows writing the same catalog.json overwrite each other's edits — e.g. the
 * leftover file:// tab after switching to the local server. The first window owns the workspace; any other window
 * becomes read-only with a banner '다른 창에서 열려 있어요 · 여기서 이어서 하기' (one click moves ownership here).
 *
 *   <workspace>/.fluid-organizer/lock.json = { tabId, origin, kind, heartbeatAt, since }   (heartbeat every 5 s)
 *   BroadcastChannel 'fluid-identity-lock' — instant hand-over between windows of the same origin
 *   (different origins, e.g. file:// and http://127.0.0.1:8765, see each other through lock.json).
 *
 *   App.lock.canWrite()   → false only while another live window owns the current workspace
 *   App.lock.state        → 'none' | 'owner' | 'readonly'
 *   App.lock.owner        → the other window's lock record while read-only
 *   App.lock.takeOver()   → make this window the writer (reloads the workspace data from disk)
 *   App.lock.isLockPath(p), App.lock.nudge()   (used by App.fs: refused writes flash the banner)
 * App.fs refuses every write while read-only (error code EREADONLY). Event: 'lock:changed' { state, canWrite }.
 * The tab id lives in sessionStorage, so reloading a tab keeps its ownership.
 */
(() => {
    'use strict';
    const { h } = App.util;

    const LOCK_PATH = '.fluid-organizer/lock.json';
    const HEARTBEAT_MS = 5000;
    const STALE_MS = 30000; // a window that missed ~6 heartbeats (closed, crashed, or asleep in the background) is gone
    const nonce = Math.random().toString(36).slice(2);

    function readTabId() {
        try {
            return sessionStorage.getItem('fi.tabId');
        } catch (e) {
            return null;
        }
    }
    function writeTabId(id) {
        try {
            sessionStorage.setItem('fi.tabId', id);
        } catch (e) {
            /* private mode: a new id per load is fine */
        }
    }
    let tabId = readTabId();
    if (!tabId) {
        tabId = App.util.uid('tab');
        writeTabId(tabId);
    }

    let channel = null;
    try {
        channel = new BroadcastChannel('fluid-identity-lock');
    } catch (e) {
        channel = null;
    }
    const post = (msg) => {
        try {
            channel?.postMessage({ ...msg, from: tabId, nonce });
        } catch (e) {
            /* closed */
        }
    };

    let state = 'none';
    let owner = null;
    let lockBackend = null; // the backend this state belongs to (switching workspaces starts over)
    let timer = 0;
    let lastBeat = 0;
    let checking = null;

    const wsId = () => App.state.workspace?.id || null;
    const sameWorkspace = () => !!lockBackend && App.fs.backend === lockBackend;

    function setState(next, other = null) {
        const changed = next !== state || (other && other.tabId) !== (owner && owner.tabId);
        if (next === 'owner' && (state !== 'owner' || !sameWorkspace())) lock.since = Date.now();
        state = next;
        owner = other;
        lockBackend = next === 'none' ? null : App.fs.backend;
        renderBanner();
        if (changed) App.bus.emit('lock:changed', { state, canWrite: lock.canWrite() });
    }

    const isLive = (rec) => rec && rec.tabId && rec.tabId !== tabId && Date.now() - (rec.heartbeatAt || 0) < STALE_MS;

    async function readLock() {
        try {
            return await App.fs.readJSON(LOCK_PATH, null);
        } catch (e) {
            return null; // corrupt or unreadable: treat as free
        }
    }

    async function writeLock() {
        const now = Date.now();
        const rec = { tabId, origin: location.origin === 'null' ? location.protocol : location.origin, kind: App.fs.backend?.kind || '', heartbeatAt: now, since: lock.since || now };
        lastBeat = now;
        await App.fs.writeJSON(LOCK_PATH, rec);
    }

    /** Decide owner / read-only for the workspace that just opened (or re-check). */
    async function check({ claim = true } = {}) {
        if (!App.fs.ready || !wsId()) return;
        if (checking) return checking;
        if (state === 'acquiring' && sameWorkspace()) return; // takeOver() finishes this itself
        const backend = App.fs.backend;
        checking = (async () => {
            const rec = await readLock();
            if (App.fs.backend !== backend) return;
            if (state === 'owner' && sameWorkspace()) {
                // Someone else claimed after our last beat → step back
                if (rec && rec.tabId !== tabId && (rec.heartbeatAt || 0) >= lastBeat) return setState('readonly', rec);
                await writeLock().catch((e) => console.warn('[lock] heartbeat failed', e));
                return;
            }
            if (isLive(rec)) return setState('readonly', rec);
            if (!claim && state === 'readonly' && sameWorkspace()) {
                // The other window is gone: take over quietly and reload what it may have changed
                return takeOver({ quiet: true });
            }
            setState('owner');
            await writeLock().catch((e) => console.warn('[lock] claim failed', e));
            post({ type: 'claimed', ws: wsId() });
            // lock.json can't be claimed atomically: read it back a moment later — if another window claimed at the
            // same time and its write landed last, it wins and we step back before doing any real work
            await new Promise((r) => setTimeout(r, 250 + Math.random() * 250));
            if (App.fs.backend !== backend || state !== 'owner') return;
            const after = await readLock();
            if (after && after.tabId !== tabId && isLive(after)) setState('readonly', after);
        })().finally(() => (checking = null));
        return checking;
    }

    function startTimer() {
        clearInterval(timer);
        timer = setInterval(() => check({ claim: false }), HEARTBEAT_MS);
    }

    async function release() {
        clearInterval(timer);
        if (state === 'owner' && sameWorkspace()) {
            post({ type: 'released', ws: wsId() });
            try {
                await App.fs.writeJSON(LOCK_PATH, { tabId, heartbeatAt: 0, released: true });
            } catch (e) {
                /* best effort */
            }
        }
    }

    /**
     * Become the writer. While 'acquiring' this window still writes nothing (so its stale in-memory catalog can't
     * overwrite what the other window saved); the workspace is re-read from disk and only then writes are enabled.
     */
    async function takeOver({ quiet = false } = {}) {
        if (!App.fs.ready || state === 'acquiring') return;
        const backend = App.fs.backend;
        const previous = owner;
        setState('acquiring', previous);
        try {
            await writeLock();
            post({ type: 'claimed', ws: wsId() });
            if (App.fs.backend !== backend) return;
            // Everything the other window saved meanwhile (catalog, chips, trash...) is read again;
            // 'workspace:opened' from this reload switches us to 'owner'
            if (App.workspace?.reload) await App.workspace.reload({ keepUndo: false });
            if (state === 'acquiring' && App.fs.backend === backend) setState('owner');
            App.ui.toast(quiet ? '다른 창이 닫혀서 이제 여기서 바꿀 수 있어요' : '이제 이 창에서 이어서 할 수 있어요', { type: 'success', id: 'lock' });
        } catch (e) {
            console.error('[lock] take over failed', e);
            if (App.fs.backend === backend && state === 'acquiring') setState('readonly', previous);
            App.ui.toast(`이 창으로 가져오지 못했어요: ${e.message || e}`, { type: 'error', id: 'lock' });
        }
    }

    // ---------- Banner ----------
    let banner = null;
    function renderBanner() {
        const show = (state === 'readonly' || state === 'acquiring') && sameWorkspace();
        if (!show) {
            if (banner) banner.hidden = true;
            document.documentElement.classList.remove('core-readonly');
            return;
        }
        if (!banner) {
            banner = h('div', { class: 'core-lock', role: 'status', 'aria-live': 'polite' });
            const btn = h('button', { class: 'btn sm primary core-lock-btn', type: 'button', text: '여기서 이어서 하기', 'data-tip': '이 창에서 편집하고 다른 창은 보기 전용으로 바꿔요' });
            btn.addEventListener('click', () => takeOver());
            banner.append(
                h('span', { class: 'core-lock-ico', html: App.ui.icon('lock', { size: 15 }) }),
                h('div', { class: 'core-lock-text' }, h('b', { text: '다른 창에서 열려 있어요' }), h('span', { class: 'core-lock-sub' })),
                btn,
            );
            document.body.append(banner);
        }
        const where = owner?.kind === 'server' ? '로컬 서버로 연 창' : String(owner?.origin || '').startsWith('file') ? '파일로 연 창' : '다른 창';
        const acquiring = state === 'acquiring';
        banner.querySelector('.core-lock-sub').textContent = acquiring ? '최신 내용을 다시 읽어 오고 있어요…' : `${where}이 편집 중이라 이 창은 보기 전용이에요`;
        const btn = banner.querySelector('.core-lock-btn');
        btn.disabled = acquiring;
        btn.textContent = acquiring ? '이어받는 중…' : '여기서 이어서 하기';
        banner.hidden = false;
        document.documentElement.classList.add('core-readonly');
    }

    const lock = {
        since: 0,
        get state() {
            return sameWorkspace() ? state : 'none';
        },
        get owner() {
            return sameWorkspace() && state === 'readonly' ? owner : null;
        },
        get tabId() {
            return tabId;
        },
        canWrite() {
            return !((state === 'readonly' || state === 'acquiring') && sameWorkspace());
        },
        isLockPath(p) {
            return p === LOCK_PATH;
        },
        takeOver: () => takeOver(),
        check: () => check({ claim: false }),
        nudge() {
            if (!banner || banner.hidden) return;
            banner.classList.remove('nudge');
            void banner.offsetWidth;
            banner.classList.add('nudge');
            App.ui.toast('다른 창에서 편집 중이라 여기서는 바꿀 수 없어요 · ‘여기서 이어서 하기’를 눌러 주세요', { type: 'warning', id: 'lock-refused' });
        },
    };

    // ---------- Wiring ----------
    channel?.addEventListener('message', (ev) => {
        const m = ev.data || {};
        if (m.type === 'whois' && m.from === tabId && m.nonce !== nonce) post({ type: 'taken', to: m.nonce });
        else if (m.type === 'taken' && m.to === nonce) {
            // A duplicated tab copied our sessionStorage id: pick a new one
            tabId = App.util.uid('tab');
            writeTabId(tabId);
        } else if (m.type === 'claimed' && m.from !== tabId && m.ws && m.ws === wsId() && state === 'owner') {
            readLock().then((rec) => {
                if (rec && rec.tabId !== tabId) setState('readonly', rec);
            });
        } else if (m.type === 'released' && m.ws && m.ws === wsId() && state === 'readonly') {
            // The owner window is closing (its lock file can't be updated from pagehide): continue here.
            // A small random delay keeps several read-only windows from all claiming at once.
            setTimeout(async () => {
                if (state !== 'readonly' || !sameWorkspace()) return;
                const rec = await readLock();
                if (rec && rec.tabId === m.from) takeOver({ quiet: true });
                else check({ claim: false });
            }, 50 + Math.random() * 250);
        }
    });
    post({ type: 'whois' });

    App.bus.on('workspace:opened', () => {
        if (state === 'acquiring' && sameWorkspace()) {
            // takeOver()'s reload: the data now comes fresh from disk, so writing is safe again
            setState('owner');
            startTimer();
            return;
        }
        if (state === 'owner' && sameWorkspace()) {
            startTimer();
            return; // reopened by ourselves (take over / reload): keep it
        }
        setState('none');
        check().then(startTimer);
    });
    App.bus.on('workspace:closed', () => {
        release();
        setState('none');
    });
    // Edits of ratings, chips, memos... in a read-only window are not saved: say so right when they happen
    App.bus.on('catalog:changed', ({ legacy } = {}) => {
        if (!legacy && state === 'readonly' && sameWorkspace()) lock.nudge(); // (v1 memo imports are automatic, not edits)
    });
    window.addEventListener('pagehide', () => {
        if (state === 'owner' && sameWorkspace()) post({ type: 'released', ws: wsId() });
    });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && App.fs.ready) check({ claim: false });
    });

    App.commands.register({
        id: 'lock.takeOver',
        title: '이 창에서 이어서 하기',
        group: '일반',
        icon: 'lock',
        when: () => state === 'readonly' && sameWorkspace(),
        run: () => takeOver(),
    });

    App.lock = lock;
})();
