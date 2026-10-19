/*
 * Status bar + activity center (thumbs team).
 *   Left   item counts (shown / total, total size, breakdown in the tooltip) and the selection summary.
 *   Right  activity (running jobs; click or Mod+J opens the activity center), save state of the library data
 *          (catalog), thumbnail cache. Other modules add items: App.statusbar.addItem(id, el, { side: 'left'|'right' }).
 *
 * Activity center: running jobs (title, detail, progress, pause/resume, cancel), the last 10 finished jobs with
 * their result, plus the library index and thumbnail cache summary. Optional job fields it understands:
 *   job.background (doesn't block closing the tab), job.pausable + pause()/resume()/paused,
 *   job.result (text shown once finished), job.doneTitle (title used in the history), job.kind.
 * Closing the tab while a foreground job runs (moves, copies, imports...) asks for confirmation.
 */
(() => {
    'use strict';
    const { h, formatCount, formatBytes, formatDuration } = App.util;
    const ui = App.ui;
    const HISTORY_MAX = 10;
    // Core jobs that are safe to interrupt (until the core marks them with job.background)
    const BACKGROUND_TITLES = new Set(['라이브러리 색인 중']);

    let left;
    let right;
    let countsEl;
    let selEl;
    let actEl;
    let saveEl;
    let cacheEl;

    const isBackground = (j) => j.background === true || BACKGROUND_TITLES.has(j.title);
    const fmt = formatCount;

    function iconSpan(name, size = 13, cls = '') {
        return h('span', { class: `sb-ico ${cls}`, html: ui.icon(name, { size }) });
    }

    function elapsedText(ms) {
        const s = Math.max(0, Math.round(ms / 1000));
        if (s < 1) return '1초 미만';
        if (s < 60) return `${s}초`;
        const m = Math.floor(s / 60);
        if (m < 60) return s % 60 ? `${m}분 ${s % 60}초` : `${m}분`;
        return `${Math.floor(m / 60)}시간 ${m % 60}분`;
    }

    function agoText(t) {
        const s = Math.round((Date.now() - t) / 1000);
        if (s < 45) return '방금';
        if (s < 3600) return `${Math.max(1, Math.round(s / 60))}분 전`;
        const d = new Date(t);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    // ---------- Job history (core keeps only running jobs; we remember the ones that finish) ----------
    const history = [];
    let snapshot = new Map();
    let unseenFailures = 0;

    function resultText(j, state, endedAt = Date.now()) {
        if (state === 'cancelled') return j.total ? `취소됨 · ${fmt(Math.min(j.done, j.total))}/${fmt(j.total)}개` : '취소됨';
        if (state === 'failed') return `실패 · ${(j.error && (j.error.message || String(j.error))) || '알 수 없는 오류'}`;
        const parts = [j.result || (j.total ? `${fmt(j.total)}개 완료` : j.done ? `${fmt(j.done)}개 처리` : '완료')];
        const ms = endedAt - (j.startedAt || endedAt);
        if (ms >= 1000) parts.push(elapsedText(ms));
        return parts.join(' · ');
    }

    // "이동하는 중" -> "이동하기", "라이브러리 색인 중" -> "라이브러리 색인" once a job is over (unless it set doneTitle).
    // ㄹ-irregular verbs keep their ㄹ: "만드는 중" -> "만들기", "푸는 중" -> "풀기".
    const IRREGULAR = [['만드는 중', '만들기'], ['푸는 중', '풀기'], ['여는 중', '열기'], ['거는 중', '걸기'], ['다는 중', '달기'], ['파는 중', '팔기']];

    function finishedTitle(j) {
        if (j.doneTitle) return j.doneTitle;
        const t = String(j.title || '작업');
        for (const [from, to] of IRREGULAR) if (t.endsWith(from)) return t.slice(0, -from.length) + to;
        if (t.endsWith('는 중')) return t.slice(0, -3) + '기';
        if (t.endsWith(' 중')) return t.slice(0, -2);
        return t;
    }

    function trackJobs() {
        const list = App.jobs.list();
        const now = new Map(list.map((j) => [j.id, j]));
        for (const [id, j] of snapshot) {
            if (now.has(id)) continue;
            const state = j.cancelled ? 'cancelled' : j.state === 'failed' ? 'failed' : 'done';
            history.unshift({ id, title: finishedTitle(j), state, result: resultText(j, state), endedAt: Date.now(), kind: j.kind || '' });
            if (state === 'failed') unseenFailures++;
        }
        if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
        snapshot = now;
    }

    function getHistory() {
        // Prefer the core's history once it has one (see integration requests)
        if (typeof App.jobs.history === 'function') {
            try {
                return App.jobs.history().slice(0, HISTORY_MAX).map((j) => {
                    const state = j.cancelled ? 'cancelled' : j.state === 'failed' ? 'failed' : 'done';
                    const endedAt = j.endedAt || Date.now();
                    return { id: j.id, title: finishedTitle(j), state, result: resultText(j, state, endedAt), endedAt, kind: j.kind || '' };
                });
            } catch (e) {
                /* fall back */
            }
        }
        return history;
    }

    // ---------- Left: counts & selection ----------
    function renderCounts() {
        if (!App.fs.ready) {
            countsEl.hidden = true;
            return;
        }
        countsEl.hidden = false;
        const all = App.view.entries;
        const vis = App.view.visible;
        let img = 0;
        let vid = 0;
        let dirs = 0;
        let bytes = 0;
        for (const e of vis) {
            if (e.kind === 'dir') dirs++;
            else {
                bytes += e.size || 0;
                if (e.type === 'image') img++;
                else if (e.type === 'video') vid++;
            }
        }
        const filtered = vis.length !== all.length;
        let text = filtered ? `${fmt(vis.length)}개 표시 · 전체 ${fmt(all.length)}개` : `${fmt(vis.length)}개 항목`;
        if (bytes) text += ` · ${formatBytes(bytes)}`;
        countsEl.querySelector('.sb-text').textContent = text;
        const tip = [];
        if (img) tip.push(`사진 ${fmt(img)}`);
        if (vid) tip.push(`영상 ${fmt(vid)}`);
        if (dirs) tip.push(`폴더 ${fmt(dirs)}`);
        const hidden = App.view.source.hiddenCount;
        if (hidden) tip.push(`사진·영상이 아닌 파일 ${fmt(hidden)}개는 숨겨져 있어요`);
        if (filtered) tip.push('검색어나 필터로 일부만 보고 있어요');
        if (tip.length) countsEl.dataset.tip = tip.join(' · ');
        else delete countsEl.dataset.tip;
    }

    function renderSelection() {
        const n = App.select.count;
        if (!n || !App.fs.ready) {
            selEl.hidden = true;
            return;
        }
        selEl.hidden = false;
        const entries = App.select.entries();
        let bytes = 0;
        let img = 0;
        let vid = 0;
        let dirs = 0;
        for (const e of entries) {
            if (e.kind === 'dir') dirs++;
            else {
                bytes += e.size || 0;
                if (e.type === 'image') img++;
                else if (e.type === 'video') vid++;
            }
        }
        const parts = [`${fmt(n)}개 선택됨`];
        if (bytes) parts.push(formatBytes(bytes));
        if (entries.length === 1 && entries[0].kind === 'file') {
            const meta = App.catalog.peek(entries[0].path)?.meta || {};
            if (meta.w && meta.h) parts.push(`${meta.w}×${meta.h}`);
            if (meta.duration) parts.push(formatDuration(meta.duration));
        }
        selEl.querySelector('.sb-text').textContent = parts.join(' · ');
        const tip = [];
        if (img) tip.push(`사진 ${fmt(img)}`);
        if (vid) tip.push(`영상 ${fmt(vid)}`);
        if (dirs) tip.push(`폴더 ${fmt(dirs)}`);
        selEl.dataset.tip = tip.join(' · ') + ' · Esc로 선택 해제';
    }

    // ---------- Right: activity ----------
    function primaryJob(list) {
        return list.find((j) => !isBackground(j)) || list[0];
    }

    function pctOf(j) {
        return j.total ? Math.round((Math.min(j.done, j.total) / j.total) * 100) : null;
    }

    function renderActivity() {
        const list = App.jobs.list();
        actEl.innerHTML = '';
        actEl.classList.toggle('busy', list.length > 0);
        actEl.classList.toggle('open', !!pop);
        if (!list.length) {
            actEl.append(iconSpan('activity', 14));
            if (unseenFailures) actEl.append(h('span', { class: 'sb-dot', 'aria-hidden': 'true' }));
            actEl.dataset.tip = unseenFailures ? `실패한 작업이 있어요 · 작업 현황 열기` : '작업 현황 · 최근 작업과 썸네일 캐시';
            actEl.setAttribute('aria-label', '작업 현황');
            return;
        }
        const j = primaryJob(list);
        const pct = pctOf(j);
        actEl.append(j.paused ? iconSpan('pause', 12, 'sb-paused') : h('span', { class: 'spinner sb-spinner' }));
        const label = j.paused ? `일시정지됨 · ${j.title}` : j.title;
        actEl.append(h('span', { class: 'sb-text sb-act-title', text: list.length > 1 ? `${label} 외 ${list.length - 1}개` : label }));
        if (pct != null) {
            actEl.append(h('span', { class: 'progress sb-progress' }, h('i', { style: { width: pct + '%' } })), h('span', { class: 'sb-pct', text: `${pct}%` }));
        } else if (j.done) {
            actEl.append(h('span', { class: 'sb-pct', text: `${fmt(j.done)}개` }));
        }
        actEl.dataset.tip = '작업 현황 열기';
        actEl.setAttribute('aria-label', `작업 현황: ${label}${pct != null ? ` ${pct}%` : ''}`);
    }

    // ---------- Right: save state ----------
    const save = { state: 'saved', at: Date.now(), mode: 'fallback', error: null };

    function setSave(state, error) {
        save.state = state;
        save.error = error || null;
        if (state === 'saved') save.at = Date.now();
        invalidate('save');
    }

    function renderSave() {
        if (!saveEl) return;
        saveEl.hidden = !App.fs.ready;
        saveEl.className = `sb-item sb-btn sb-pill sb-save is-${save.state}`;
        saveEl.innerHTML = '';
        if (App.lock && App.lock.canWrite && !App.lock.canWrite()) {
            // Another window owns this workspace (core-lock.js): nothing here is saved, so never claim 저장됨
            saveEl.classList.add('is-readonly');
            saveEl.append(iconSpan('lock', 12), h('span', { class: 'sb-text', text: '보기 전용' }));
            saveEl.dataset.tip = '다른 창에서 이 작업 폴더를 쓰고 있어서 이 창은 보기만 할 수 있어요';
        } else if (save.state === 'saving') {
            saveEl.append(h('span', { class: 'spinner sb-spinner' }), h('span', { class: 'sb-text', text: '저장 중…' }));
            saveEl.dataset.tip = '변경 사항을 작업 폴더에 저장하고 있어요';
        } else if (save.state === 'error') {
            saveEl.append(iconSpan('alert', 13), h('span', { class: 'sb-text', text: '저장 실패 · 다시 시도' }));
            saveEl.dataset.tip = `작업 폴더에 저장하지 못했어요${save.error ? ` (${save.error})` : ''}. 클릭하면 다시 저장해요.`;
        } else {
            saveEl.append(h('span', { class: 'sb-text', text: '저장됨' }), iconSpan('check', 12, 'sb-ok'));
            const d = new Date(save.at);
            saveEl.dataset.tip = `모든 변경 사항이 작업 폴더에 저장됐어요 · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        }
        saveEl.dataset.tipKeys = 'Mod+S';
        saveEl.setAttribute('aria-label', saveEl.textContent);
    }

    async function saveNow({ announce = false } = {}) {
        if (!App.fs.ready) return;
        setSave('saving');
        try {
            await App.catalog.flush();
            if (save.mode === 'fallback') setSave('saved');
            if (announce) ui.toast('모든 변경 사항을 저장했어요', { type: 'success', duration: 1600 });
        } catch (e) {
            setSave('error', e && e.message);
        }
    }

    // Until the catalog announces its saves (catalog:saving/saved/error), assume a debounced flush tells the truth
    const fallbackFlush = App.util.debounce(() => {
        if (save.mode !== 'fallback' || !App.fs.ready) return;
        App.catalog.flush().then(
            () => save.mode === 'fallback' && setSave('saved'),
            (e) => setSave('error', e && e.message),
        );
    }, 900);

    // ---------- Right: thumbnail cache ----------
    const renderCache = App.util.throttle(() => invalidate('cache'), 700);

    function renderCacheNow() {
        if (!cacheEl) return;
        if (!App.fs.ready || !App.thumbs) {
            cacheEl.hidden = true;
            return;
        }
        cacheEl.hidden = false;
        const s = App.thumbs.stats();
        const cov = App.thumbs.coverage ? App.thumbs.coverage() : null;
        const text = cacheEl.querySelector('.sb-text');
        const parts = [];
        if (s.server) {
            text.textContent = '서버';
            parts.push('썸네일은 로컬 서버가 만들어요');
        } else {
            const pct = cov && cov.total ? Math.floor((cov.cached / cov.total) * 100) : null;
            text.textContent = pct == null ? '' : pct >= 100 ? '썸네일 준비됨' : `썸네일 ${pct}%`;
            if (cov) parts.push(`썸네일 ${fmt(cov.cached)} / ${fmt(cov.total)}개 준비`);
            parts.push(`브라우저 캐시 ${formatBytes(s.idb.bytes)} / ${formatBytes(s.idb.limit)}`);
            if (s.disk.enabled) parts.push(`작업 폴더 ${fmt(s.disk.count)}개`);
        }
        cacheEl.dataset.tip = parts.join(' · ');
        cacheEl.setAttribute('aria-label', parts.join(', '));
    }

    // ---------- Frame-coalesced rendering ----------
    const dirty = new Set();
    let frame = 0;

    function invalidate(...parts) {
        for (const p of parts) dirty.add(p);
        if (!frame) frame = requestAnimationFrame(flush);
    }

    function flush() {
        frame = 0;
        const parts = new Set(dirty);
        dirty.clear();
        if (!countsEl) return;
        if (parts.has('counts')) renderCounts();
        if (parts.has('selection')) renderSelection();
        if (parts.has('activity')) renderActivity();
        if (parts.has('save')) renderSave();
        if (parts.has('cache')) renderCacheNow();
        if (parts.has('popover') && pop) renderPopover();
    }

    // ---------- Activity center (popover) ----------
    let pop = null; // { el, close, body, refs }

    function confirmCancel(j) {
        if (isBackground(j)) return Promise.resolve(true);
        return ui.confirm({ title: `"${j.title}"을(를) 멈출까요?`, message: '이미 처리한 항목은 그대로 남아요. 실행 취소(Ctrl+Z)로 되돌릴 수 있어요.', okLabel: '멈추기', cancelLabel: '계속하기' });
    }

    function jobRow(j) {
        const icon = h('span', { class: 'act-job-icon' });
        const title = h('span', { class: 'act-job-title truncate' });
        const pct = h('span', { class: 'act-job-pct' });
        const bar = h('div', { class: 'progress act-bar' }, h('i'));
        const detail = h('div', { class: 'act-job-detail truncate' });
        const pauseBtn = h('button', { class: 'btn ghost sm icon act-btn', type: 'button' });
        pauseBtn.addEventListener('click', () => (j.paused ? j.resume() : j.pause()));
        const cancelBtn = h('button', { class: 'btn ghost sm icon act-btn act-cancel', type: 'button', 'aria-label': '작업 취소', 'data-tip': '취소', html: ui.icon('x', { size: 14 }) });
        cancelBtn.addEventListener('click', async () => {
            if (await confirmCancel(j)) j.cancel();
        });
        const el = h('div', { class: 'act-job', dataset: { id: j.id } }, icon, h('div', { class: 'act-job-main' }, h('div', { class: 'act-job-top' }, title, pct), bar, detail), h('div', { class: 'act-job-actions' }, pauseBtn, cancelBtn));
        let lastIcon = '';
        const update = () => {
            const p = pctOf(j);
            const iconKey = j.paused ? 'paused' : 'busy';
            if (iconKey !== lastIcon) {
                icon.innerHTML = '';
                icon.append(j.paused ? h('span', { html: ui.icon('pause', { size: 14 }) }) : h('span', { class: 'spinner' }));
                el.classList.toggle('paused', !!j.paused);
                lastIcon = iconKey;
            }
            title.textContent = j.title;
            title.title = j.title;
            pct.textContent = p != null ? `${p}%` : j.done ? `${fmt(j.done)}개` : '';
            bar.classList.toggle('indeterminate', p == null);
            bar.firstChild.style.width = (p ?? 100) + '%';
            const d = j.paused && !j.detail ? '일시정지됨' : j.detail || (j.total ? `${fmt(Math.min(j.done, j.total))} / ${fmt(j.total)}개` : '진행 중…');
            detail.textContent = d;
            detail.title = d;
            const canPause = typeof j.pause === 'function' && typeof j.resume === 'function' && j.pausable !== false;
            pauseBtn.hidden = !canPause;
            if (canPause) {
                pauseBtn.innerHTML = ui.icon(j.paused ? 'play' : 'pause', { size: 13 });
                pauseBtn.dataset.tip = j.paused ? '이어서 하기' : '잠시 멈추기';
                pauseBtn.setAttribute('aria-label', pauseBtn.dataset.tip);
                if (j.kind === 'thumbs') pauseBtn.dataset.tipKeys = 'Mod+Alt+P';
            }
            cancelBtn.hidden = !j.cancellable;
        };
        update();
        return { el, update };
    }

    function buildPopover() {
        const refs = {};
        refs.running = h('div', { class: 'act-list' });
        refs.empty = h('div', { class: 'act-empty' },
            h('span', { class: 'act-empty-icon', html: ui.icon('check-circle', { size: 18 }) }),
            h('div', { class: 'act-empty-title', text: '진행 중인 작업이 없어요' }),
            h('div', { class: 'act-empty-sub', text: '썸네일 만들기, 이동·복사처럼 오래 걸리는 작업이 여기에 나와요.' }));
        refs.histList = h('div', { class: 'act-list' });
        refs.histClear = h('button', { class: 'act-link', type: 'button', text: '지우기', 'aria-label': '최근 작업 기록 지우기', onclick: () => {
            history.length = 0;
            if (typeof App.jobs.clearHistory === 'function') App.jobs.clearHistory();
            renderPopover();
        } });
        refs.hist = h('div', { class: 'act-section' }, h('div', { class: 'act-label' }, h('span', { text: '최근 작업' }), h('span', { class: 'grow' }), refs.histClear), refs.histList);
        refs.runSection = h('div', { class: 'act-section' }, h('div', { class: 'act-label' }, h('span', { text: '진행 중' }), refs.runCount = h('span', { class: 'act-count' })), refs.running, refs.empty);
        refs.lib = h('div', { class: 'act-stat' });
        refs.cache = h('div', { class: 'act-stat' });
        refs.meter = h('div', { class: 'progress act-meter' }, h('i', { style: { width: '0%' } }));
        refs.pregen = h('button', { class: 'btn sm primary', type: 'button', onclick: () => {
            closePopover();
            App.commands.run('thumbs.pregenerate');
        } });
        refs.settings = h('button', { class: 'btn sm ghost', type: 'button', html: `${ui.icon('sliders', { size: 13 })}<span>캐시 설정</span>`, onclick: () => {
            closePopover();
            App.commands.run('thumbs.settings');
        } });
        refs.foot = h('div', { class: 'act-foot' }, refs.lib, refs.cache, refs.meter, h('div', { class: 'act-actions' }, refs.settings, refs.pregen));
        const head = h('div', { class: 'act-head' },
            h('span', { class: 'act-head-icon', html: ui.icon('activity', { size: 15 }) }),
            h('span', { class: 'act-title', text: '작업 현황' }),
            h('span', { class: 'kbd act-kbd', text: App.commands.displayCombo('Mod+J') }),
            h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': '닫기', 'data-tip': '닫기', html: ui.icon('x', { size: 14 }), onclick: () => closePopover() }));
        const body = h('div', { class: 'act', role: 'dialog', 'aria-label': '작업 현황' }, head, h('div', { class: 'act-scroll' }, refs.runSection, refs.hist), refs.foot);
        return { body, refs, rows: new Map() };
    }

    function renderFooter(refs) {
        if (!App.fs.ready) {
            refs.foot.hidden = true;
            return;
        }
        refs.foot.hidden = false;
        // Library index
        let img = 0;
        let vid = 0;
        if (App.index.ready) {
            for (const e of App.index.items) {
                if (e.type === 'image') img++;
                else if (e.type === 'video') vid++;
            }
        }
        refs.lib.innerHTML = '';
        refs.lib.append(
            h('span', { class: 'act-stat-icon', html: ui.icon('layers', { size: 14 }) }),
            h('span', { class: 'act-stat-main' }, h('span', { text: '라이브러리' }), h('span', { class: 'act-stat-sub', text: App.index.ready ? ` · 사진 ${fmt(img)} · 영상 ${fmt(vid)}` : ' · 색인 중…' })),
            h('span', { class: `badge ${App.index.ready ? '' : 'accent'}`, text: App.index.ready ? '색인 완료' : '색인 중' }));
        // Thumbnail cache
        const t = App.thumbs;
        refs.cache.innerHTML = '';
        if (!t) return;
        const s = t.stats();
        const cov = t.coverage ? t.coverage() : null;
        const pct = cov && cov.total ? Math.floor((cov.cached / cov.total) * 100) : null;
        refs.cache.append(
            h('span', { class: 'act-stat-icon', html: ui.icon('image', { size: 14 }) }),
            h('span', { class: 'act-stat-main' },
                h('span', { text: '썸네일' }),
                h('span', { class: 'act-stat-sub', text: s.server ? ' · 로컬 서버가 만들어요' : cov ? ` · ${fmt(cov.cached)} / ${fmt(cov.total)}개 · ${formatBytes(s.idb.bytes)}` : ` · ${formatBytes(s.idb.bytes)}` })),
            h('span', { class: `badge ${pct === 100 ? '' : 'accent'}`, text: s.server ? '서버' : pct == null ? '—' : `${pct}%` }));
        refs.meter.hidden = s.server || pct == null;
        refs.meter.firstChild.style.width = (pct || 0) + '%';
        refs.meter.classList.toggle('full', pct === 100);
        const running = t.pregenerating;
        refs.pregen.hidden = s.server || running || pct === 100;
        refs.pregen.innerHTML = `${ui.icon('image', { size: 13 })}<span>썸네일 미리 만들기</span>`;
        refs.pregen.dataset.tip = '라이브러리 전체 썸네일을 미리 만들어 둬요';
        refs.pregen.dataset.tipKeys = 'Mod+Alt+T';
    }

    function renderPopover() {
        if (!pop) return;
        const { refs, rows } = pop;
        const list = App.jobs.list();
        // Running jobs: keyed rows so progress bars animate instead of jumping
        const ids = new Set(list.map((j) => j.id));
        for (const [id, row] of rows) {
            if (!ids.has(id)) {
                row.el.remove();
                rows.delete(id);
            }
        }
        for (const j of list) {
            let row = rows.get(j.id);
            if (!row) {
                row = jobRow(j);
                rows.set(j.id, row);
            }
            refs.running.append(row.el); // keeps order
            row.update();
        }
        refs.empty.hidden = list.length > 0;
        refs.runCount.textContent = list.length ? fmt(list.length) : '';
        // History
        const hist = getHistory();
        refs.empty.classList.toggle('compact', hist.length > 0);
        refs.hist.hidden = !hist.length;
        refs.histList.innerHTML = '';
        for (const it of hist) {
            const icon = it.state === 'done' ? 'check' : it.state === 'failed' ? 'alert' : 'x';
            refs.histList.append(h('div', { class: `act-hist is-${it.state}` },
                h('span', { class: 'act-hist-icon', html: ui.icon(icon, { size: 13 }) }),
                h('div', { class: 'act-hist-main' }, h('div', { class: 'act-hist-title truncate', text: it.title, title: it.title }), h('div', { class: 'act-hist-result truncate', text: it.result, title: it.result })),
                h('span', { class: 'act-hist-time', text: agoText(it.endedAt) })));
        }
        renderFooter(refs);
        positionPopover();
    }

    function positionPopover() {
        if (!pop) return;
        const r = actEl.getBoundingClientRect();
        const el = pop.el;
        ui.positionFloating(el, r.right - el.offsetWidth, r.top - el.offsetHeight - 8);
    }

    function closePopover() {
        if (pop) pop.close();
    }

    function openActivity({ focus = false } = {}) {
        if (pop) {
            closePopover();
            return;
        }
        if (!actEl) return;
        const built = buildPopover();
        const returnFocus = document.activeElement;
        const p = ui.popover(actEl, built.body, {
            above: true,
            align: 'end',
            class: 'act-pop',
            padding: '0',
            onClose: () => {
                const hadFocus = pop && pop.el.contains(document.activeElement);
                pop = null;
                actEl.classList.remove('open');
                window.removeEventListener('resize', positionPopover);
                if (hadFocus && returnFocus && returnFocus.isConnected) returnFocus.focus();
            },
        });
        pop = { ...p, ...built };
        unseenFailures = 0;
        actEl.classList.add('open');
        window.addEventListener('resize', positionPopover);
        renderPopover();
        renderActivity();
        // Opened from the keyboard: put focus inside so Tab reaches pause/cancel right away
        if (focus) (pop.el.querySelector('.act-job .act-btn:not([hidden])') || pop.el.querySelector('.act-head .btn'))?.focus();
        // Numbers that need IndexedDB / the disk listing arrive a moment later
        App.thumbs?.usage?.().then(() => renderPopover());
    }

    const refreshPopover = App.util.throttle(() => renderPopover(), 200);

    // ---------- Public API ----------
    const statusbar = {
        addItem(id, el, { side = 'right' } = {}) {
            el.classList.add('sb-item');
            el.dataset.sbId = id;
            (side === 'left' ? left : right).append(el);
            return el;
        },
        openActivity,
        closeActivity: closePopover,
        get activityOpen() {
            return !!pop;
        },
        history: () => getHistory().slice(),
        get saveState() {
            return save.state;
        },
        isBackgroundJob: isBackground,
    };

    // ---------- Commands ----------
    App.commands.register({
        id: 'jobs.activity',
        title: '작업 현황 보기',
        group: '보기',
        icon: 'activity',
        keys: 'Mod+J',
        run: (args) => openActivity({ focus: !!(args && args.event) }),
    });

    const SAVE_ID = 'catalog.saveNow';
    App.commands.register({
        id: SAVE_ID,
        title: '지금 저장',
        group: '파일',
        icon: 'check',
        keys: 'Mod+S',
        scope: 'global',
        allowInInput: true,
        // Defers to any other team's Ctrl+S that is active in the current layer
        when: () => App.fs.ready && !App.commands.list().some((c) => c.id !== SAVE_ID && c.keys.includes('Mod+S') && (c.scope === 'global' || c.scope === App.layers.top()) && App.commands.isEnabled(c.id)),
        run: () => saveNow({ announce: true }),
    });

    // Closing the tab while a foreground job (move, copy, import...) runs or data failed to save asks first.
    // Background work (thumbnails, indexing) just resumes next time.
    window.addEventListener('beforeunload', (e) => {
        const busy = App.jobs.list().some((j) => !isBackground(j));
        if (!busy && save.state !== 'error') return;
        e.preventDefault();
        e.returnValue = '';
    });

    App.register('statusbar', {
        init() {
            const bar = document.getElementById('statusbar');
            bar.setAttribute('role', 'contentinfo');
            countsEl = h('span', { class: 'sb-item sb-counts', hidden: true }, iconSpan('grid', 12), h('span', { class: 'sb-text' }));
            selEl = h('span', { class: 'sb-item sb-selection', hidden: true }, iconSpan('check-circle', 12, 'sb-accent'), h('span', { class: 'sb-text' }));
            actEl = h('button', { class: 'sb-item sb-btn sb-pill sb-activity', type: 'button', 'data-tip-keys': 'Mod+J', onclick: () => openActivity() });
            saveEl = h('button', { class: 'sb-item sb-btn sb-pill sb-save', type: 'button', hidden: true, 'aria-live': 'polite', onclick: () => saveNow({ announce: save.state === 'error' }) });
            cacheEl = h('button', { class: 'sb-item sb-btn sb-pill sb-cache', type: 'button', hidden: true, 'data-tip-keys': 'Mod+J', onclick: () => openActivity() }, iconSpan('image', 13), h('span', { class: 'sb-text' }));
            left = h('div', { class: 'sb-group sb-left' }, countsEl, selEl);
            right = h('div', { class: 'sb-group sb-right' }, actEl, saveEl, cacheEl);
            bar.append(left, h('span', { class: 'sb-spacer' }), right);
            snapshot = new Map(App.jobs.list().map((j) => [j.id, j]));
            renderActivity();

            // Everything renders at most once per frame, never inside the event that caused it
            App.bus.on('view:changed', () => invalidate('counts', 'selection'));
            App.bus.on('selection:changed', () => invalidate('selection'));
            App.bus.on('jobs:changed', () => {
                trackJobs();
                invalidate('activity', 'popover');
            });
            App.bus.on('catalog:saving', () => {
                save.mode = 'events';
                setSave('saving');
            });
            App.bus.on('catalog:saved', () => {
                save.mode = 'events';
                setSave('saved');
            });
            App.bus.on('catalog:error', (p) => {
                save.mode = 'events';
                setSave('error', p && p.error && (p.error.message || String(p.error)));
            });
            App.bus.on('lock:changed', () => invalidate('save'));
            App.bus.on('catalog:changed', () => {
                if (!App.fs.ready) return;
                if (save.state !== 'saving') setSave('saving');
                if (save.mode === 'fallback') fallbackFlush();
            });
            for (const evt of ['thumbs:stats', 'index:ready', 'index:changed', 'thumbs:pregen']) {
                App.bus.on(evt, () => {
                    renderCache();
                    if (pop) refreshPopover();
                });
            }
            App.bus.on('workspace:opened', () => {
                setSave('saved');
                renderCache();
            });
            App.bus.on('workspace:closed', () => {
                closePopover();
                invalidate('counts', 'selection', 'save', 'cache');
            });
        },
    });

    App.statusbar = statusbar;
})();
