/*
 * Video editor panel (E) in the viewer's right dock:
 *   In/Out points (I/O, Shift+I/O to jump, Alt+X to clear) -> "구간 추가" (Enter) into a segment bin that can
 *   hold segments from several videos; reorder (drag or Alt+↑/↓), preview (one or all), delete.
 *   Actions run on the local server (docs/server-api.md, App.server.video.* — feature-detected):
 *     잘라내기 (trim: fast = stream copy, accurate = re-encode), 구간 합치기 (concat), 회전/뒤집기 (transform).
 *   Without the server the actions stay disabled and the panel explains how to start it.
 *
 *   App.videoEditor — { isOpen, segments, marksFor(path), markIn(), markOut(), addSegment(), trim(), concat(), transform() }
 */
(() => {
    'use strict';
    const { h, path: P, clamp, escapeHtml, formatCount } = App.util;
    const ui = App.ui;
    const V = App.viewer;
    const fmt = (t, precise = true) => (V.fmtTime ? V.fmtTime(t, precise) : String(t));
    // Lengths: "2.4초" for short clips, "1:05" beyond a minute
    const fmtLen = (sec) => (sec < 60 ? `${(Math.round(Math.max(0, sec) * 10) / 10).toFixed(1)}초` : fmt(sec, false));

    const marks = new Map(); // path -> { in, out } (session only)
    const segments = []; // { id, path, name, start, end }
    let selectedId = null;
    let body = null;
    let busy = null; // { label, progress, cancel }
    let transformOp = null;
    let transformMode = 'metadata';

    const TRANSFORMS = [
        { op: 'rotate90', label: '90°', icon: 'rotate-cw', tip: '오른쪽으로 90° 회전' },
        { op: 'rotate180', label: '180°', icon: 'refresh', tip: '180° 회전' },
        { op: 'rotate270', label: '270°', icon: 'rotate-ccw', tip: '왼쪽으로 90° 회전' },
        { op: 'hflip', label: '좌우', icon: 'flip-h', tip: '좌우 뒤집기' },
        { op: 'vflip', label: '상하', icon: 'flip-v', tip: '상하 뒤집기' },
    ];

    // ---------- Server ----------
    function serverState() {
        const s = App.server;
        if (!s) return { ready: false, why: 'missing' };
        if (!s.available) return { ready: false, why: 'offline' };
        if (s.capabilities && s.capabilities.ffmpeg === false) return { ready: false, why: 'ffmpeg' };
        if (typeof s.canUse === 'function') return s.canUse('ffmpeg') ? { ready: true } : { ready: false, why: 'workspace' };
        if (App.fs.backend?.kind !== 'server') return { ready: false, why: 'workspace' };
        if (!(s.video || typeof s.request === 'function')) return { ready: false, why: 'missing' };
        return { ready: true };
    }

    async function waitForJob(res, onProgress) {
        const s = App.server;
        const id = res && (res.jobId ?? res.job?.id ?? (typeof res.job === 'string' ? res.job : null) ?? (res.id && res.state ? res.id : null));
        if (!id || res.state === 'done' || res.result) return { res, id };
        busy && (busy.jobId = id);
        if (typeof s.waitJob === 'function') return { res: await s.waitJob(id, onProgress), id };
        if (typeof s.job === 'function') {
            for (;;) {
                const j = await s.job(id);
                onProgress(j);
                if (!j || j.state !== 'running') return { res: j, id };
                await App.util.sleep(500);
            }
        }
        return { res, id };
    }

    async function callServer(op, payload, label) {
        const s = App.server;
        const onProgress = (prog) => {
            const pr = typeof prog === 'number' ? prog : prog?.progress;
            if (busy && pr != null && isFinite(pr)) {
                busy.progress = clamp(pr, 0, 1);
                renderBusy();
            }
        };
        let res;
        if (s.video && typeof s.video[op] === 'function') res = await s.video[op](payload);
        else if (typeof s.request === 'function') res = await s.request('POST', `/api/video/${op}`, payload);
        else throw new Error('서버 연결 기능이 아직 준비되지 않았어요');
        ({ res } = await waitForJob(res, onProgress));
        if (res && (res.state === 'error' || (res.error && !res.path && !res.result))) throw new Error(res.error?.message || res.message || (typeof res.error === 'string' ? res.error : '') || `${label}에 실패했어요`);
        if (res && res.state === 'cancelled') return null;
        const out = res?.result?.path ?? res?.path ?? res?.output ?? res?.result?.output ?? (typeof res === 'string' ? res : null);
        return out || null;
    }

    async function cancelBusy() {
        const id = busy?.jobId;
        if (!id) return;
        try {
            const s = App.server;
            if (typeof s.cancelJob === 'function') await s.cancelJob(id);
            else if (typeof s.request === 'function') await s.request('POST', `/api/jobs/${id}/cancel`, {});
            ui.toast('작업을 취소했어요', { type: 'info' });
        } catch (e) {
            ui.toast(`취소하지 못했어요: ${e.message}`, { type: 'error' });
        }
    }

    async function runAction(label, op, payload, doneText) {
        if (busy) return null;
        const st = serverState();
        if (!st.ready) {
            ui.toast('영상 편집은 로컬 서버가 켜져 있어야 해요', { type: 'warning' });
            return null;
        }
        busy = { label, progress: null, jobId: null };
        render();
        const t = ui.toast(`${label} 중…`, { type: 'loading' });
        try {
            const out = await callServer(op, payload, label);
            t.close();
            if (!out) {
                ui.toast(`${label}을(를) 취소했어요`, { type: 'info' });
                return null;
            }
            // The server wrote the file directly — tell the app so the gallery/tree/index pick it up
            if (typeof App.fs.emitChange === 'function') App.fs.emitChange({ type: 'create', paths: [out], dirs: [P.parent(out)] });
            else App.nav?.reload?.();
            ui.toast(`${doneText} · ${P.base(out)}`, { type: 'success', duration: 6000, action: { label: '보기', run: () => V.open(out) } });
            return out;
        } catch (e) {
            t.close();
            ui.toast(`${label}에 실패했어요: ${e.message}`, { type: 'error' });
            return null;
        } finally {
            busy = null;
            render();
        }
    }

    // ---------- Model ----------
    function cur() {
        const e = V.current;
        return e && e.type === 'video' ? e : null;
    }

    function marksFor(p) {
        if (!marks.has(p)) marks.set(p, { in: null, out: null });
        return marks.get(p);
    }

    function selected() {
        return segments.find((s) => s.id === selectedId) || null;
    }

    function syncRanges() {
        const p = V.player;
        if (!p) return;
        if (!editor.isOpen) {
            p.setRanges('editor', null);
            return;
        }
        const m = marksFor(p.path);
        const ranges = segments.filter((s) => s.path === p.path).map((s) => ({ start: s.start, end: s.end, kind: s.id === selectedId ? 'active' : 'segment' }));
        if (m.in != null || m.out != null) {
            const a = m.in ?? 0;
            const b = m.out ?? (m.in != null ? Math.min(p.duration || m.in, m.in + Math.max(0.2, (p.duration || 0) * 0.004)) : 0);
            ranges.push({ start: a, end: b, kind: m.out != null && m.in != null ? 'inout' : 'point' });
        }
        p.setRanges('editor', ranges);
    }

    const editor = {
        segments,
        marksFor,

        get isOpen() {
            return V.isPanelOpen('editor');
        },

        markIn() {
            const p = V.player;
            if (!p) return;
            const m = marksFor(p.path);
            m.in = Math.round(p.time * 1000) / 1000;
            if (m.out != null && m.out <= m.in + 0.05) m.out = null;
            V.osd(`시작점 ${fmt(m.in)}`, { icon: 'vw-in-point' });
            changed();
        },

        markOut() {
            const p = V.player;
            if (!p) return;
            const m = marksFor(p.path);
            m.out = Math.round(p.time * 1000) / 1000;
            if (m.in != null && m.in >= m.out - 0.05) m.in = null;
            V.osd(`끝점 ${fmt(m.out)}`, { icon: 'vw-out-point' });
            changed();
        },

        gotoMark(which) {
            const p = V.player;
            if (!p) return;
            const m = marksFor(p.path);
            const t = m[which];
            if (t == null) {
                V.osd(which === 'in' ? '시작점이 없어요' : '끝점이 없어요', { icon: which === 'in' ? 'vw-in-point' : 'vw-out-point' });
                return;
            }
            if (p.playing) p.pause();
            p.seek(t);
        },

        clearMarks() {
            const p = V.player;
            if (!p) return;
            marks.set(p.path, { in: null, out: null });
            V.osd('시작점·끝점 지움', { icon: 'x' });
            changed();
        },

        addSegment() {
            const p = V.player;
            const e = cur();
            if (!p || !e) return null;
            const m = marksFor(e.path);
            const d = p.duration || 0;
            const start = m.in ?? 0;
            const end = m.out ?? d;
            if (m.in == null && m.out == null) {
                ui.toast('먼저 I로 시작점, O로 끝점을 찍어 주세요', { type: 'info' });
                return null;
            }
            if (!(end - start >= 0.1)) {
                ui.toast('구간이 너무 짧아요 (0.1초 이상)', { type: 'warning' });
                return null;
            }
            const seg = { id: App.util.uid('s'), path: e.path, name: e.name, start, end };
            segments.push(seg);
            selectedId = seg.id;
            marks.set(e.path, { in: null, out: null });
            V.osd(`구간 추가 ${fmt(start, false)} – ${fmt(end, false)}`, { icon: 'plus' });
            changed();
            return seg;
        },

        removeSegment(id) {
            const i = segments.findIndex((s) => s.id === id);
            if (i < 0) return;
            const [seg] = segments.splice(i, 1);
            if (selectedId === id) selectedId = segments[Math.min(i, segments.length - 1)]?.id ?? null;
            changed();
            ui.toast(`구간 ${fmt(seg.start, false)} – ${fmt(seg.end, false)}을(를) 뺐어요`, {
                type: 'info',
                duration: 3500,
                action: {
                    label: '되돌리기',
                    run: () => {
                        segments.splice(Math.min(i, segments.length), 0, seg);
                        selectedId = seg.id;
                        changed();
                    },
                },
            });
        },

        moveSegment(id, delta) {
            const i = segments.findIndex((s) => s.id === id);
            const j = clamp(i + delta, 0, segments.length - 1);
            if (i < 0 || i === j) return;
            const [seg] = segments.splice(i, 1);
            segments.splice(j, 0, seg);
            changed({ focus: id });
        },

        reorder(from, to) {
            if (from === to || from < 0 || to < 0 || from >= segments.length || to >= segments.length) return;
            const [seg] = segments.splice(from, 1);
            segments.splice(to, 0, seg);
            changed();
        },

        clearSegments() {
            if (!segments.length) return;
            const saved = [...segments];
            segments.length = 0;
            selectedId = null;
            changed();
            ui.toast(`구간 ${saved.length}개를 모두 뺐어요`, { type: 'info', action: { label: '되돌리기', run: () => {
                segments.push(...saved);
                changed();
            } } });
        },

        /** Play one segment (switching to its file when needed). */
        async preview(id, onEnd) {
            const seg = segments.find((s) => s.id === id);
            if (!seg) return;
            selectedId = seg.id;
            changed();
            const start = () => V.player?.playRange(seg.start, seg.end, onEnd);
            if (V.current?.path === seg.path && V.player && V.player.path === seg.path && V.player.duration) {
                start();
                return;
            }
            const off = App.bus.on('viewer:video-meta', ({ path }) => {
                if (path !== seg.path) return;
                off();
                start();
            });
            setTimeout(off, 15000);
            V.open(seg.path, { time: seg.start, play: false });
        },

        previewAll() {
            if (!segments.length) return;
            const queue = segments.map((s) => s.id);
            let i = 0;
            const next = () => {
                if (i >= queue.length) {
                    V.osd('미리보기 끝', { icon: 'check' });
                    return;
                }
                editor.preview(queue[i++], next);
            };
            V.osd(`구간 ${queue.length}개 이어서 미리보기`, { icon: 'play' });
            next();
        },

        trimTarget() {
            if (segments.length === 1) return segments[0];
            if (segments.length > 1) return selected();
            const e = cur();
            const p = V.player;
            if (!e || !p) return null;
            const m = marksFor(e.path);
            if (m.in == null && m.out == null) return null;
            const start = m.in ?? 0;
            const end = m.out ?? p.duration;
            return end - start >= 0.1 ? { path: e.path, name: e.name, start, end } : null;
        },

        async trim() {
            const seg = editor.trimTarget();
            if (!seg) {
                ui.toast(segments.length > 1 ? '잘라낼 구간을 하나 골라 주세요' : '먼저 I·O로 구간을 표시해 주세요', { type: 'info' });
                return null;
            }
            const mode = App.settings.get('video.trimMode', 'fast') === 'accurate' ? 'accurate' : 'fast';
            return runAction('잘라내기', 'trim', { path: seg.path, start: round3(seg.start), end: round3(seg.end), mode }, '잘라낸 영상을 저장했어요');
        },

        async concat() {
            if (segments.length < 2) {
                ui.toast('합치려면 구간이 2개 이상 있어야 해요', { type: 'info' });
                return null;
            }
            return runAction('구간 합치기', 'concat', { segments: segments.map((s) => ({ path: s.path, start: round3(s.start), end: round3(s.end) })) }, '합친 영상을 저장했어요');
        },

        async transform(op = transformOp, mode = transformMode) {
            const e = cur();
            if (!e || !op) {
                ui.toast('회전할 방향을 골라 주세요', { type: 'info' });
                return null;
            }
            const m = op.startsWith('rotate') ? mode : 'reencode';
            return runAction('회전·뒤집기', 'transform', { path: e.path, op, mode: m }, '회전한 영상을 저장했어요');
        },
    };

    function round3(t) {
        return Math.round(t * 1000) / 1000;
    }

    function changed(opts) {
        syncRanges();
        render(opts);
    }

    // ---------- Rendering ----------
    function render(opts = {}) {
        if (!body) return;
        const scrollTop = body.scrollTop;
        body.innerHTML = '';
        const e = cur();
        const p = V.player;
        if (!e) {
            body.append(h('div', { class: 'vw-dock-empty' },
                h('div', { class: 'vw-dock-empty-icon', html: ui.icon('scissors', { size: 22 }) }),
                h('p', { text: '영상을 열면 구간을 자르고 합칠 수 있어요.' }),
                segments.length ? h('p', { class: 'faint', text: `담아 둔 구간 ${segments.length}개는 그대로 있어요.` }) : null));
            return;
        }
        const st = serverState();
        const m = marksFor(e.path);

        // In / Out
        const point = (which, label, iconName, key) => {
            const t = m[which];
            return h('div', { class: `ve-point${t != null ? ' is-set' : ''}` },
                h('div', { class: 've-point-label', html: `${V.icon(iconName, { size: 14 })}<span>${label}</span>` }),
                h('button', {
                    class: 've-point-time',
                    text: t != null ? fmt(t) : '––:––',
                    'data-tip': t != null ? '이 지점으로 이동' : '아직 안 찍었어요',
                    'data-tip-keys': which === 'in' ? 'Shift+I' : 'Shift+O',
                    disabled: t == null,
                    onmousedown: (ev) => ev.preventDefault(),
                    onclick: () => editor.gotoMark(which),
                }),
                h('button', {
                    class: 'btn sm ve-point-set',
                    html: `<span>지금</span><span class="kbd">${key}</span>`,
                    'data-tip': `${label}을 지금 위치로`,
                    onmousedown: (ev) => ev.preventDefault(),
                    onclick: () => (which === 'in' ? editor.markIn() : editor.markOut()),
                }));
        };
        const len = m.in != null || m.out != null ? (m.out ?? p?.duration ?? 0) - (m.in ?? 0) : null;
        body.append(h('section', { class: 've-sec' },
            h('div', { class: 've-sec-title', html: '<span>구간 표시</span>' }),
            h('div', { class: 've-points' }, point('in', '시작점', 'vw-in-point', 'I'), point('out', '끝점', 'vw-out-point', 'O')),
            h('div', { class: 've-row' },
                h('span', { class: 've-len muted', text: len != null && len > 0 ? `길이 ${fmtLen(len)}` : 'I·O로 구간을 표시해요' }),
                h('div', { class: 'grow' }),
                h('button', { class: 'btn sm ghost', text: '지우기', 'data-tip': '시작점·끝점 지우기', 'data-tip-keys': 'Alt+X', disabled: m.in == null && m.out == null, onmousedown: (ev) => ev.preventDefault(), onclick: () => editor.clearMarks() }),
                h('button', { class: 'btn sm primary', html: `${ui.icon('plus', { size: 13 })}<span>구간 추가</span><span class="kbd">Enter</span>`, disabled: m.in == null && m.out == null, onmousedown: (ev) => ev.preventDefault(), onclick: () => editor.addSegment() }))));

        // Segment bin
        const total = segments.reduce((s, x) => s + (x.end - x.start), 0);
        const segSec = h('section', { class: 've-sec' },
            h('div', { class: 've-sec-title' },
                h('span', { text: '구간 목록' }),
                segments.length ? h('span', { class: 'badge', text: `${formatCount(segments.length)}개 · ${fmtLen(total)}` }) : null,
                h('div', { class: 'grow' }),
                segments.length > 1 ? V.button('play', '모두 이어서 미리보기', 'Shift+Enter', () => editor.previewAll(), { class: 'sm' }) : null,
                segments.length ? V.button('trash', '모두 빼기', null, () => editor.clearSegments(), { class: 'sm' }) : null));
        if (!segments.length) {
            segSec.append(h('div', { class: 've-empty', html: `<span class="kbd">I</span>·<span class="kbd">O</span>로 구간을 표시하고 <span class="kbd">Enter</span>를 누르면 여기에 담겨요. 다른 영상의 구간도 함께 담아서 한 영상으로 합칠 수 있어요.` }));
        } else {
            const list = h('div', { class: 've-list', role: 'listbox', 'aria-label': '구간 목록' });
            segments.forEach((s, i) => list.append(segRow(s, i, e)));
            segSec.append(list);
        }
        body.append(segSec);

        // Export
        const disabled = !st.ready || !!busy;
        const trimTarget = editor.trimTarget();
        const mode = App.settings.get('video.trimMode', 'fast');
        const exp = h('section', { class: 've-sec' },
            h('div', { class: 've-sec-title', html: '<span>내보내기</span>' }),
            !st.ready ? serverNotice(st.why) : null,
            h('div', { class: 'seg ve-mode', role: 'radiogroup', 'aria-label': '자르는 방식' },
                ...[['fast', '빠르게 (무손실)'], ['accurate', '정확하게']].map(([k, label]) => h('button', {
                    class: mode === k ? 'on' : '',
                    text: label,
                    'aria-pressed': mode === k ? 'true' : 'false',
                    onmousedown: (ev) => ev.preventDefault(),
                    onclick: () => {
                        App.settings.set('video.trimMode', k);
                        render();
                    },
                }))),
            h('p', { class: 've-help', text: mode === 'accurate' ? '다시 인코딩해서 프레임 단위로 정확하게 잘라요. 시간이 조금 걸려요.' : '다시 인코딩하지 않아 빠르고 화질 그대로예요. 키프레임 기준이라 앞뒤가 조금 더 잘릴 수 있어요.' }),
            h('div', { class: 've-actions' },
                h('button', {
                    class: 'btn primary',
                    html: `${ui.icon('scissors', { size: 14 })}<span>잘라내기</span>`,
                    disabled: disabled || !trimTarget,
                    'data-tip': trimTarget ? `${fmt(trimTarget.start, false)} – ${fmt(trimTarget.end, false)}을 새 파일로 저장` : segments.length > 1 ? '목록에서 구간을 하나 골라 주세요' : '구간을 먼저 표시해 주세요',
                    onmousedown: (ev) => ev.preventDefault(),
                    onclick: () => editor.trim(),
                }),
                h('button', {
                    class: 'btn',
                    html: `${ui.icon('merge', { size: 14 })}<span>구간 합치기${segments.length > 1 ? ` (${segments.length})` : ''}</span>`,
                    disabled: disabled || segments.length < 2,
                    'data-tip': segments.length < 2 ? '구간이 2개 이상 있어야 해요' : '목록 순서대로 이어 붙여 새 MP4로 저장',
                    onmousedown: (ev) => ev.preventDefault(),
                    onclick: () => editor.concat(),
                })));
        if (busy) {
            const pct = busy.progress != null ? Math.round(busy.progress * 100) : null;
            exp.append(h('div', { class: 've-busy' },
                h('span', { class: 'spinner' }),
                h('span', { class: 've-busy-label', text: `${busy.label} 중${pct != null ? ` · ${pct}%` : '…'}` }),
                h('div', { class: 'grow' }),
                busy.jobId ? h('button', { class: 'btn sm ghost', text: '취소', onclick: () => cancelBusy() }) : null,
                pct != null ? h('div', { class: 'progress ve-progress' }, h('i', { style: { width: `${pct}%` } })) : null));
        }
        body.append(exp);

        // Rotate / flip
        const viewRot = V.rotationOf(e.path);
        if (!transformOp && viewRot) transformOp = `rotate${viewRot}`;
        const tf = h('section', { class: 've-sec' },
            h('div', { class: 've-sec-title', html: '<span>회전·뒤집기</span>' }),
            viewRot ? h('p', { class: 've-help', text: `지금 보기 회전(${viewRot}°)을 실제 파일로 만들 수 있어요.` }) : null,
            h('div', { class: 've-ops', role: 'radiogroup', 'aria-label': '회전·뒤집기' },
                ...TRANSFORMS.map((t) => h('button', {
                    class: `ve-op${transformOp === t.op ? ' on' : ''}`,
                    'data-tip': t.tip,
                    'aria-pressed': transformOp === t.op ? 'true' : 'false',
                    html: `${ui.icon(t.icon, { size: 15 })}<span>${t.label}</span>`,
                    onmousedown: (ev) => ev.preventDefault(),
                    onclick: () => {
                        transformOp = transformOp === t.op ? null : t.op;
                        render();
                    },
                }))),
            h('div', { class: 've-row' },
                h('div', { class: 'seg ve-mode' },
                    ...[['metadata', '무손실'], ['reencode', '다시 인코딩']].map(([k, label]) => h('button', {
                        class: (transformOp && !transformOp.startsWith('rotate') ? k === 'reencode' : transformMode === k) ? 'on' : '',
                        text: label,
                        disabled: !!transformOp && !transformOp.startsWith('rotate') && k === 'metadata',
                        'data-tip': k === 'metadata' ? '화면 방향 정보만 바꿔요 (회전만 가능)' : '픽셀을 다시 만들어요 (뒤집기는 이 방식만)',
                        onmousedown: (ev) => ev.preventDefault(),
                        onclick: () => {
                            transformMode = k;
                            render();
                        },
                    }))),
                h('div', { class: 'grow' }),
                h('button', {
                    class: 'btn',
                    html: `${ui.icon('check', { size: 14 })}<span>적용</span>`,
                    disabled: disabled || !transformOp,
                    'data-tip': '새 파일(_rot)로 저장해요. 원본은 그대로예요',
                    onmousedown: (ev) => ev.preventDefault(),
                    onclick: () => editor.transform(),
                })));
        body.append(tf);

        body.scrollTop = scrollTop;
        if (opts.focus) body.querySelector(`.ve-seg[data-id="${CSS.escape(opts.focus)}"]`)?.focus();
    }

    function serverNotice(why) {
        const connect = App.commands.get('server.connect');
        const text = {
            missing: '자르기·합치기·회전은 로컬 서버(ffmpeg)가 해요. <b>server\\start.bat</b>을 실행하면 서버가 켜지고 브라우저가 열려요.',
            offline: '자르기·합치기·회전은 로컬 서버(ffmpeg)가 해요. <b>server\\start.bat</b>을 실행한 뒤 열리는 주소(http://127.0.0.1:8765)에서 이 폴더를 열어 주세요.',
            workspace: '서버가 켜져 있어요. 서버 주소(<b>http://127.0.0.1:8765</b>)에서 작업 폴더를 열면 편집 기능을 쓸 수 있어요.',
            ffmpeg: '서버에 ffmpeg가 없어요. <b>server\\start.bat</b>을 다시 실행하면 자동으로 설치해요.',
        }[why] || '로컬 서버가 있어야 편집할 수 있어요.';
        return h('div', { class: 've-server' },
            h('div', { class: 've-server-icon', html: ui.icon('server', { size: 16 }) }),
            h('div', { class: 've-server-body' },
                h('div', { class: 've-server-title', text: '로컬 서버가 필요해요' }),
                h('div', { class: 've-server-text', html: text }),
                connect ? h('button', { class: 'btn sm', html: `${ui.icon('zap', { size: 13 })}<span>서버 연결</span>`, onclick: () => App.commands.run('server.connect') }) : null));
    }

    function segRow(s, i, curEntry) {
        const other = s.path !== curEntry.path;
        const row = h('div', {
            class: `ve-seg${s.id === selectedId ? ' is-selected' : ''}${other ? ' is-other' : ''}`,
            role: 'option',
            tabindex: '0',
            'aria-selected': s.id === selectedId ? 'true' : 'false',
            dataset: { id: s.id },
        },
            h('span', { class: 've-grip', html: ui.icon('drag-handle', { size: 14 }), 'data-tip': '끌어서 순서 바꾸기', 'data-tip-keys': 'Alt+ArrowUp' }),
            h('span', { class: 've-idx', text: String(i + 1) }),
            h('div', { class: 've-seg-body' },
                h('div', { class: 've-seg-range', text: `${fmt(s.start)} – ${fmt(s.end)}` }),
                h('div', { class: 've-seg-src truncate', text: other ? s.name : '이 영상', title: s.path })),
            h('span', { class: 've-seg-len', text: fmtLen(s.end - s.start) }),
            V.button('play', '미리보기', null, () => editor.preview(s.id), { class: 'sm' }),
            V.button('x', '목록에서 빼기', 'Delete', () => editor.removeSegment(s.id), { class: 'sm' }));
        row.addEventListener('click', (ev) => {
            if (ev.target.closest('button, .ve-grip')) return;
            selectedId = s.id;
            changed({ focus: s.id });
            if (!other && V.player) V.player.seek(s.start);
        });
        row.addEventListener('dblclick', (ev) => {
            if (ev.target.closest('button')) return;
            editor.preview(s.id);
        });
        row.addEventListener('keydown', (ev) => {
            if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
                ev.preventDefault();
                editor.moveSegment(s.id, ev.key === 'ArrowUp' ? -1 : 1);
            } else if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
                ev.preventDefault();
                const j = clamp(i + (ev.key === 'ArrowUp' ? -1 : 1), 0, segments.length - 1);
                selectedId = segments[j].id;
                changed({ focus: selectedId });
            } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
                ev.preventDefault();
                editor.removeSegment(s.id);
            } else if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                editor.preview(s.id);
            }
        });
        bindDrag(row, row.querySelector('.ve-grip'));
        return row;
    }

    // Pointer-driven reordering (smooth, works with the virtual-free short list)
    function bindDrag(row, grip) {
        grip.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            const list = row.parentNode;
            const rows = [...list.children];
            const from = rows.indexOf(row);
            const step = row.offsetHeight + parseFloat(getComputedStyle(list).rowGap || '0');
            const y0 = e.clientY;
            let to = from;
            grip.setPointerCapture(e.pointerId);
            row.classList.add('is-dragging');
            list.classList.add('is-sorting');
            const move = (ev) => {
                const dy = ev.clientY - y0;
                row.style.transform = `translateY(${dy}px)`;
                to = clamp(from + Math.round(dy / step), 0, rows.length - 1);
                rows.forEach((r, k) => {
                    if (r === row) return;
                    let shift = 0;
                    if (from < to && k > from && k <= to) shift = -step;
                    if (from > to && k < from && k >= to) shift = step;
                    r.style.transform = shift ? `translateY(${shift}px)` : '';
                });
            };
            const up = () => {
                grip.removeEventListener('pointermove', move);
                grip.removeEventListener('pointerup', up);
                grip.removeEventListener('pointercancel', up);
                rows.forEach((r) => (r.style.transform = ''));
                row.classList.remove('is-dragging');
                list.classList.remove('is-sorting');
                editor.reorder(from, to);
            };
            grip.addEventListener('pointermove', move);
            grip.addEventListener('pointerup', up);
            grip.addEventListener('pointercancel', up);
        });
    }

    function renderBusy() {
        const lab = body?.querySelector('.ve-busy-label');
        if (!lab || !busy) return;
        const pct = busy.progress != null ? Math.round(busy.progress * 100) : null;
        lab.textContent = `${busy.label} 중${pct != null ? ` · ${pct}%` : '…'}`;
        const bar = body.querySelector('.ve-progress > i');
        if (bar && pct != null) bar.style.width = `${pct}%`;
        else if (pct != null) render();
    }

    // ---------- Panel ----------
    V.registerPanel({
        id: 'editor',
        title: '영상 편집',
        icon: 'scissors',
        keys: 'E',
        toolbar: true,
        render(b) {
            body = b;
            render();
            syncRanges();
            const offs = [
                App.bus.on('viewer:player', () => {
                    syncRanges();
                    render();
                }),
                App.bus.on('viewer:video-meta', () => render()),
                App.bus.on('*', (evt) => {
                    if (typeof evt === 'string' && evt.startsWith('server:')) render();
                }),
                App.bus.on('fs:changed', (c) => {
                    if (!c.from || !c.to) return;
                    // keep segment paths valid across renames/moves
                    let touched = false;
                    for (const s of segments) {
                        const i = c.from.indexOf(s.path);
                        if (i >= 0 && c.to[i]) {
                            s.path = c.to[i];
                            s.name = P.base(c.to[i]);
                            touched = true;
                        }
                    }
                    if (touched) render();
                }),
            ];
            return () => {
                offs.forEach((off) => off());
                body = null;
                V.player?.setRanges('editor', null);
            };
        },
        onEntry() {
            render();
            syncRanges();
        },
        hints: () => [
            { keys: ['I'], label: '시작점' },
            { keys: ['O'], label: '끝점' },
            { keys: ['Enter'], label: '구간 추가' },
            { keys: [V.dk('Shift+I'), V.dk('Shift+O')], label: '점으로 이동' },
            { keys: [V.dk('Alt+X')], label: '지우기' },
            { keys: ['Space'], label: '재생' },
            { keys: [',', '.'], label: '프레임' },
            { keys: ['E'], label: '편집 닫기' },
        ],
    });

    // ---------- Commands ----------
    const editing = () => V.isOpen && V.kind === 'video' && !!V.player && editor.isOpen;
    const notOnControl = () => {
        const a = document.activeElement;
        return !a || !(a.closest?.('button, a, input, textarea, select, [role="option"], [contenteditable="true"]'));
    };
    const reg = (cmd) => App.commands.register({ group: '영상 편집', scope: 'viewer', when: editing, ...cmd });
    App.commands.register({
        id: 'video.editor',
        title: '영상 편집 열기/닫기',
        group: '영상 편집',
        icon: 'scissors',
        scope: 'viewer',
        keys: ['E'],
        when: () => V.isOpen && V.kind === 'video',
        run: () => V.togglePanel('editor'),
    });
    reg({ id: 'video.markIn', title: '시작점 찍기', icon: 'vw-in-point', keys: ['I'], run: () => editor.markIn() });
    reg({ id: 'video.markOut', title: '끝점 찍기', icon: 'vw-out-point', keys: ['O'], run: () => editor.markOut() });
    reg({ id: 'video.gotoIn', title: '시작점으로 이동', icon: 'vw-in-point', keys: ['Shift+I'], run: () => editor.gotoMark('in') });
    reg({ id: 'video.gotoOut', title: '끝점으로 이동', icon: 'vw-out-point', keys: ['Shift+O'], run: () => editor.gotoMark('out') });
    reg({ id: 'video.clearInOut', title: '시작점·끝점 지우기', icon: 'x', keys: ['Alt+X'], run: () => editor.clearMarks() });
    reg({ id: 'video.addSegment', title: '구간 추가', icon: 'plus', keys: ['Enter'], when: () => editing() && notOnControl(), run: () => editor.addSegment() });
    reg({ id: 'video.previewSegments', title: '구간 모두 미리보기', icon: 'play', keys: ['Shift+Enter'], when: () => editing() && segments.length > 0, run: () => editor.previewAll() });
    reg({ id: 'video.trim', title: '구간 잘라내기 (서버)', icon: 'scissors', when: () => V.isOpen && V.kind === 'video' && serverState().ready, run: () => editor.trim() });
    reg({ id: 'video.concat', title: '구간 합치기 (서버)', icon: 'merge', when: () => V.isOpen && segments.length > 1 && serverState().ready, run: () => editor.concat() });
    reg({ id: 'video.transform', title: '영상 회전·뒤집기 (서버)', icon: 'rotate-cw', when: () => V.isOpen && V.kind === 'video' && serverState().ready, run: () => (editor.isOpen ? editor.transform() : V.togglePanel('editor', true)) });

    App.bus.on('viewer:closed', () => {
        // keep marks and segments for the session; just drop overlays
    });

    App.videoEditor = editor;
})();
