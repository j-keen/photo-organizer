/*
 * Visible-area capture for photos and videos; the existing C full-frame capture stays independent.
 * App.capture.available() -> bool; grab({region?}) -> Promise<shot|null> (viewport CSS rect).
 * shot: {blob,w,h,ext,mime,name,dir,source}; source records oriented source-pixel crop and view state.
 * save(shot,{undoable=true,label}) -> Promise<path>; with undoable:false -> {path,createdDir}.
 * pickRegion() -> Promise<rect|null>; copy(shot) -> Promise<bool>.
 * startInterval(seconds,onShot) / stopInterval() / intervalRunning: captures while the current video plays.
 * Settings: capture.format ('jpg'|'png'), quality (0..1), pauseOnCapture, intervalSeconds (10).
 */
(() => {
    'use strict';
    const { h, path: P, clamp } = App.util;
    const V = App.viewer;
    const ui = App.ui;
    let interval = null;
    let cancelPick = null;
    let saveQueue = Promise.resolve();

    function frameAPI() {
        return !!App.server?.available && (typeof App.server.media?.frame === 'function' || typeof App.server.video?.frame === 'function');
    }

    function available() {
        if (!V.isOpen || !V.current || V.view?.path !== V.current.path) return false;
        if (V.kind === 'image') return !!V.image?.full?.naturalWidth;
        return V.kind === 'video' && !!V.player && ((!V.player.failed && V.player.video.readyState >= 2) || frameAPI());
    }

    function intersection(a, b) {
        const x = Math.max(a.x, b.x);
        const y = Math.max(a.y, b.y);
        const right = Math.min(a.x + a.width, b.x + b.width);
        const bottom = Math.min(a.y + a.height, b.y + b.height);
        return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
    }

    function rectOf(el) {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
    }

    function encode(canvas, mime, quality) {
        return new Promise((resolve, reject) => {
            canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('이미지를 만들지 못했어요')), mime, quality);
        });
    }

    // Use the raw frame wrapper: the managed wrapper would introduce a second undo entry.
    async function serverFrame(path, time) {
        const s = App.server;
        if (!frameAPI()) throw new Error('이 형식은 로컬 서버로 열어야 캡처돼요');
        const owner = s.media?.frame ? s.media : s.video;
        const result = await owner.frame({ path, time, format: 'png' });
        if (result instanceof Blob) return createImageBitmap(result);
        if (result?.blob instanceof Blob) return createImageBitmap(result.blob);
        if (!result?.path || result.path === path) throw new Error('서버에서 장면을 가져오지 못했어요');
        try {
            return await createImageBitmap(await App.fs.getFile(result.path));
        } finally {
            await App.fs.removePermanently([result.path]);
        }
    }

    async function grab({ region } = {}) {
        if (!available()) {
            ui.toast(V.kind === 'video' ? '이 형식은 로컬 서버로 열어야 캡처돼요' : '사진이 준비되면 캡처할 수 있어요', { type: 'warning' });
            return null;
        }
        const entry = { ...V.current };
        const backend = App.fs.backend;
        const view = V.view;
        const player = V.kind === 'video' ? V.player : null;
        if (player && App.settings.get('capture.pauseOnCapture', false)) player.pause();
        // Stabilize in-flight orientation/zoom before taking a geometric snapshot.
        view.finish();
        const time = player ? player.time : undefined;
        const rot = ((Math.round(view.angle / 90) * 90 % 360) + 360) % 360;
        const flipH = view.sx < 0;
        const flipV = view.sy < 0;
        const zoom = view.scale;
        const nat = view.nat && { ...view.nat };
        if (!nat || !(zoom > 0)) return null;
        const swap = rot % 180 !== 0;
        const ow = swap ? nat.h : nat.w;
        const oh = swap ? nat.w : nat.h;
        const slot = rectOf(view.slot);
        const mediaRect = {
            x: slot.x + slot.width / 2 + view.tx - ow * zoom / 2,
            y: slot.y + slot.height / 2 + view.ty - oh * zoom / 2,
            width: ow * zoom,
            height: oh * zoom,
        };
        let visible = intersection(mediaRect, rectOf(V.stageEl));
        if (visible) visible = intersection(visible, { x: 0, y: 0, width: innerWidth, height: innerHeight });
        if (region && visible) {
            const r = { x: Number(region.x ?? region.left), y: Number(region.y ?? region.top), width: Number(region.width ?? region.w), height: Number(region.height ?? region.h) };
            if (!Object.values(r).every(Number.isFinite)) return null;
            visible = intersection(visible, r);
        }
        if (!visible) return null;
        const relative = { x: (visible.x - mediaRect.x) / mediaRect.width, y: (visible.y - mediaRect.y) / mediaRect.height, w: visible.width / mediaRect.width, h: visible.height / mediaRect.height };
        const ext = App.settings.get('capture.format', 'jpg') === 'png' ? 'png' : 'jpg';
        const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
        const value = Number(App.settings.get('capture.quality', 0.92));
        const quality = Number.isFinite(value) ? clamp(value, 0, 1) : 0.92;
        let bitmap = null;
        try {
            let media = player ? player.video : V.image.full;
            const render = (input, nw, nh) => {
                const rw = swap ? nh : nw;
                const rh = swap ? nw : nh;
                const crop = { x: relative.x * rw, y: relative.y * rh, w: relative.w * rw, h: relative.h * rh };
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(crop.w));
                canvas.height = Math.max(1, Math.round(crop.h));
                const g = canvas.getContext('2d');
                if (!g) throw new Error('이미지를 만들지 못했어요');
                if (ext === 'jpg') {
                    g.fillStyle = '#fff';
                    g.fillRect(0, 0, canvas.width, canvas.height);
                }
                g.scale(canvas.width / crop.w, canvas.height / crop.h);
                g.translate(-crop.x + rw / 2, -crop.y + rh / 2);
                g.rotate(rot * Math.PI / 180);
                g.scale(flipH ? -1 : 1, flipV ? -1 : 1);
                g.drawImage(input, -nw / 2, -nh / 2, nw, nh);
                return { canvas, crop };
            };
            let rendered;
            let blob;
            try {
                if (player?.source === 'stream') throw new Error('server-frame');
                rendered = render(media, player ? media.videoWidth : media.naturalWidth, player ? media.videoHeight : media.naturalHeight);
                blob = await encode(rendered.canvas, mime, quality);
            } catch (error) {
                if (!player) throw error;
                bitmap = await serverFrame(entry.path, time);
                rendered = render(bitmap, bitmap.width, bitmap.height);
                blob = await encode(rendered.canvas, mime, quality);
            }
            if (App.fs.backend !== backend || !V.isOpen || V.current?.path !== entry.path || V.view !== view) return null;
            const stamp = player ? `_${String(Math.floor(time / 60)).padStart(2, '0')}m${String(Math.floor(time % 60)).padStart(2, '0')}s` : '_캡처';
            return {
                blob, w: rendered.canvas.width, h: rendered.canvas.height, ext, mime,
                name: `${P.stem(entry.name)}${stamp}.${ext}`,
                dir: P.join(P.parent(entry.path), '_캡처'),
                source: { path: entry.path, ...(player ? { t: time } : {}), crop: rendered.crop, zoom, rot, flipH, flipV, kind: player ? 'video' : 'image' },
            };
        } catch (error) {
            ui.toast(error.message === '이 형식은 로컬 서버로 열어야 캡처돼요' ? error.message : `캡처하지 못했어요: ${error.message}`, { type: 'error' });
            return null;
        } finally {
            bitmap?.close();
        }
    }

    async function removeEmpty(dir) {
        if (await App.fs.exists(dir) && !(await App.fs.backend.list(dir, { stat: false })).length) await App.fs.removePermanently([dir]);
    }

    function save(shot, { undoable = true, label = '화면 캡처 저장' } = {}) {
        const backend = App.fs.backend;
        const task = async () => {
            const check = () => {
                if (App.fs.backend !== backend) throw new Error('작업 폴더가 바뀌어서 저장을 멈췄어요');
            };
            check();
            if (!shot?.blob || !shot.source?.path || shot.dir !== P.join(P.parent(shot.source.path), '_캡처')) throw new Error('캡처 정보를 확인해 주세요');
            let createdDir = false;
            let path = null;
            try {
                if (!(await App.fs.exists(shot.dir))) {
                    check();
                    await App.fs.mkdir(P.parent(shot.dir), P.base(shot.dir), { undoable: false });
                    createdDir = true;
                }
                check();
                path = await App.fs.createFile(shot.dir, shot.name, shot.blob, { undoable: false });
                check();
                App.catalog.update(path, (e) => {
                    e.chips = [...(App.catalog.peek(shot.source.path)?.chips || [])];
                    e.meta = { ...(e.meta || {}), capture: JSON.parse(JSON.stringify(shot.source)), w: shot.w, h: shot.h };
                }, { undoable: false });
            } catch (error) {
                if (App.fs.backend === backend) {
                    if (path) await App.fs.trash([path], { undoable: false, silent: true });
                    if (createdDir) await removeEmpty(shot.dir);
                }
                throw error;
            }
            if (!undoable) return { path, createdDir };
            let current = path;
            let ids = [];
            App.undo.push({
                label,
                undo: async () => {
                    check();
                    ids = await App.fs.trash([current], { undoable: false, silent: true });
                    if (!ids.length) throw new Error('캡처 파일을 휴지통으로 옮기지 못했어요');
                    if (createdDir) await removeEmpty(shot.dir);
                },
                redo: async () => {
                    check();
                    const restored = await App.fs.restore(ids);
                    if (!restored.length) throw new Error('캡처 파일을 복원하지 못했어요');
                    current = restored[0];
                },
            });
            return path;
        };
        const result = saveQueue.then(task, task);
        saveQueue = result.catch(() => {});
        return result;
    }

    function pickRegion() {
        cancelPick?.();
        if (!available()) return Promise.resolve(null);
        return new Promise((resolve) => {
            const previous = document.activeElement;
            const stage = rectOf(V.stageEl);
            const overlay = h('div', { class: 'cap-region', tabindex: '0', role: 'dialog', 'aria-label': '캡처할 영역을 드래그해요. Esc로 취소해요' });
            const box = h('div', { class: 'cap-selection', hidden: true });
            overlay.append(box, h('div', { class: 'cap-help', text: '캡처할 영역을 드래그해요 · Esc로 취소해요' }));
            Object.assign(overlay.style, { left: `${stage.x}px`, top: `${stage.y}px`, width: `${stage.width}px`, height: `${stage.height}px` });
            let start = null;
            let pointer = null;
            let done = false;
            const point = (e) => ({ x: clamp(e.clientX, stage.x, stage.x + stage.width), y: clamp(e.clientY, stage.y, stage.y + stage.height) });
            const selected = (p) => ({ x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), width: Math.abs(start.x - p.x), height: Math.abs(start.y - p.y) });
            const key = (e) => {
                e.stopImmediatePropagation();
                if (e.key === 'Escape') { e.preventDefault(); finish(null); }
            };
            const finish = (rect) => {
                if (done) return;
                done = true;
                document.removeEventListener('keydown', key, true);
                window.removeEventListener('resize', cancel);
                offs.forEach((off) => off());
                overlay.remove();
                cancelPick = null;
                previous?.focus?.({ preventScroll: true });
                resolve(rect);
            };
            const cancel = () => finish(null);
            const offs = ['viewer:entry', 'viewer:closing', 'workspace:closed'].map((event) => App.bus.on(event, cancel));
            cancelPick = cancel;
            overlay.addEventListener('pointerdown', (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                pointer = e.pointerId;
                start = point(e);
                overlay.setPointerCapture(pointer);
            });
            overlay.addEventListener('pointermove', (e) => {
                if (!start || e.pointerId !== pointer) return;
                const r = selected(point(e));
                box.hidden = false;
                Object.assign(box.style, { left: `${r.x - stage.x}px`, top: `${r.y - stage.y}px`, width: `${r.width}px`, height: `${r.height}px` });
            });
            overlay.addEventListener('pointerup', (e) => {
                if (!start || e.pointerId !== pointer) return;
                const r = selected(point(e));
                finish(r.width >= 2 && r.height >= 2 ? r : null);
            });
            overlay.addEventListener('pointercancel', cancel);
            overlay.addEventListener('contextmenu', (e) => e.preventDefault());
            document.addEventListener('keydown', key, true);
            window.addEventListener('resize', cancel);
            document.body.append(overlay);
            overlay.focus();
        });
    }

    async function copy(shot) {
        if (!shot?.blob) return false;
        try {
            if (!navigator.clipboard?.write || !window.ClipboardItem) throw new Error('이 브라우저에서는 이미지 복사를 지원하지 않아요');
            // PNG is the interoperable clipboard image type, even when the saved capture is JPEG.
            const png = shot.blob.type === 'image/png' ? Promise.resolve(shot.blob) : (async () => {
                const bmp = await createImageBitmap(shot.blob);
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = bmp.width;
                    canvas.height = bmp.height;
                    canvas.getContext('2d').drawImage(bmp, 0, 0);
                    return await encode(canvas, 'image/png');
                } finally { bmp.close(); }
            })();
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
            ui.toast('캡처 이미지를 복사했어요', { type: 'success' });
            return true;
        } catch (error) {
            ui.toast(`이미지를 복사하지 못했어요: ${error.message}`, { type: 'warning' });
            return false;
        }
    }

    function stopInterval() {
        if (!interval) return;
        clearTimeout(interval.timer);
        interval = null;
        App.bus.emit('capture:interval', { running: false });
    }

    function startInterval(seconds = App.settings.get('capture.intervalSeconds', 10), onShot) {
        stopInterval();
        if (!available() || V.kind !== 'video') return false;
        const n = Number(seconds);
        if (!Number.isFinite(n) || n < 1) return false;
        const rec = { path: V.current.path, player: V.player, timer: null };
        interval = rec;
        const tick = async () => {
            if (interval !== rec) return;
            if (!V.isOpen || V.current?.path !== rec.path || V.player !== rec.player) return stopInterval();
            try {
                if (rec.player.playing) {
                    const shot = await grab();
                    if (shot && interval === rec) {
                        if (typeof onShot === 'function') await onShot(shot);
                        else await save(shot);
                    }
                }
            } catch (error) {
                ui.toast(`연속 캡처를 멈췄어요: ${error.message}`, { type: 'error' });
                if (interval === rec) stopInterval();
            } finally {
                if (interval === rec) rec.timer = setTimeout(tick, n * 1000);
            }
        };
        rec.timer = setTimeout(tick, n * 1000);
        App.bus.emit('capture:interval', { running: true });
        return true;
    }

    App.capture = { available, grab, save, pickRegion, copy, startInterval, stopInterval, get intervalRunning() { return !!interval; } };
    for (const event of ['viewer:entry', 'viewer:closing', 'workspace:closed']) App.bus.on(event, stopInterval);
    window.addEventListener('pagehide', stopInterval);

    App.bus.on('app:ready', () => {
        const S = App.settingsUI;
        if (!S?.addPage || S.pages?.some?.((p) => p.id === 'capture')) return;
        S.addPage({
            id: 'capture', title: '캡처', icon: 'camera', order: 45, desc: '보이는 영역을 사진으로 저장해요.',
            render(body, kit) {
                const group = kit.group('캡처', '원본 해상도로 저장하고 원본 파일의 칩도 함께 가져와요.');
                const add = (key, label, desc, fallback, control, read) => {
                    control.addEventListener('change', () => {
                        const before = App.settings.get(key, fallback);
                        const after = read(control);
                        if (after === null) { control.value = String(before); return; }
                        if (before === after) return;
                        App.settings.set(key, after);
                        App.undo.push({ label, undo: () => App.settings.set(key, before), redo: () => App.settings.set(key, after) });
                    });
                    group.body.append(kit.row({ label, desc, control }));
                };
                const format = h('select', { class: 'select', 'aria-label': '저장 형식' }, h('option', { value: 'jpg', text: 'JPG' }), h('option', { value: 'png', text: 'PNG' }));
                format.value = App.settings.get('capture.format', 'jpg');
                add('capture.format', '저장 형식', 'PNG는 화질 손실 없이 저장해요.', 'jpg', format, (el) => el.value);
                const quality = h('input', { class: 'input', type: 'number', min: '0', max: '1', step: '0.01', 'aria-label': 'JPG 품질' });
                quality.value = String(App.settings.get('capture.quality', 0.92));
                add('capture.quality', 'JPG 품질', '0에서 1 사이로 정해요. 기본값은 0.92예요.', 0.92, quality, (el) => el.value !== '' && el.validity.valid ? Number(el.value) : null);
                const pause = h('input', { type: 'checkbox', 'aria-label': '캡처할 때 일시정지' });
                pause.checked = !!App.settings.get('capture.pauseOnCapture', false);
                add('capture.pauseOnCapture', '캡처할 때 일시정지', '연속 캡처도 일시정지하면 다음 재생까지 기다려요.', false, pause, (el) => el.checked);
                const seconds = h('input', { class: 'input', type: 'number', min: '1', max: '86400', step: '1', 'aria-label': '연속 캡처 간격' });
                seconds.value = String(App.settings.get('capture.intervalSeconds', 10));
                add('capture.intervalSeconds', '연속 캡처 간격', '재생 중에 몇 초마다 캡처할지 정해요.', 10, seconds, (el) => el.value !== '' && el.validity.valid ? Number(el.value) : null);
                body.append(group.el);
            },
        });
    });
})();
