/*
 * Viewer clipboard: viewer.copy (viewer scope, Mod+C) copies oriented full-resolution PNG pixels.
 * Photos also populate App.gallery.clipboard so gallery paste copies the original file.
 * Contributes full-image/frame, visible-area and file-path copy actions to viewer.contextItems.
 * No files or catalog data are changed; copying does not add an undo step.
 */
(() => {
    'use strict';
    const V = App.viewer;
    const ui = App.ui;
    const { h } = App.util;

    function nativeCopy() {
        return App.util.isTypingTarget(document.activeElement) || !!window.getSelection()?.toString();
    }

    function canCopy() {
        const type = V.current?.type;
        return V.isOpen && (type === 'image' || type === 'video') && !nativeCopy();
    }

    async function loadImage(url) {
        const img = new Image();
        img.src = url;
        await img.decode();
        return img;
    }

    async function photo(entry, backend) {
        let src;
        try {
            src = await App.fs.url(entry.path);
            return await loadImage(src.url);
        } catch (error) {
            // A server preview is the only available pixel source for unsupported originals.
            const url = backend?.thumbUrl?.(entry, 4096);
            if (url) return await loadImage(typeof url === 'string' ? url : url.url);
            if (V.image?.entry.path === entry.path && V.image.full?.naturalWidth) return V.image.full;
            throw new Error('이 사진을 해독할 수 없어요. 로컬 서버로 열어 주세요');
        } finally {
            src?.release?.();
        }
    }

    async function frame(entry, player) {
        const s = App.server;
        const owner = s?.media?.frame ? s.media : s?.video;
        if (!s?.available || typeof owner?.frame !== 'function') throw new Error('이 영상은 로컬 서버로 열어야 복사할 수 있어요');
        const result = await owner.frame({ path: entry.path, time: player.time, format: 'png' });
        if (result instanceof Blob) return createImageBitmap(result);
        if (result?.blob instanceof Blob) return createImageBitmap(result.blob);
        if (!result?.path || result.path === entry.path) throw new Error('장면을 가져오지 못했어요');
        try {
            return await createImageBitmap(await App.fs.getFile(result.path));
        } finally {
            await App.fs.removePermanently([result.path]);
        }
    }

    function png(media, t) {
        const w = media.videoWidth || media.naturalWidth || media.width;
        const hh = media.videoHeight || media.naturalHeight || media.height;
        if (!(w > 0 && hh > 0)) throw new Error('사진이나 영상이 준비되면 다시 복사해 주세요');
        const swap = t.rot % 180 !== 0;
        const canvas = document.createElement('canvas');
        canvas.width = swap ? hh : w;
        canvas.height = swap ? w : hh;
        const g = canvas.getContext('2d');
        if (!g) throw new Error('이미지를 만들지 못했어요');
        g.translate(canvas.width / 2, canvas.height / 2);
        g.rotate(t.rot * Math.PI / 180);
        g.scale(t.flipH ? -1 : 1, t.flipV ? -1 : 1);
        g.drawImage(media, -w / 2, -hh / 2, w, hh);
        return new Promise((resolve, reject) => {
            canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('이미지를 만들지 못했어요')), 'image/png');
        });
    }

    async function pixels(entry, backend, player, t, session) {
        let bitmap;
        try {
            let blob;
            if (entry.type === 'image') {
                blob = await png(await photo(entry, backend), t);
            } else {
                // A previous renderer can remain visible while the current file loads.
                const deadline = performance.now() + 10000;
                while (!player || !player.metaReady || V.media !== player.video) {
                    if (App.fs.backend !== backend || !V.isOpen || V.current?.path !== entry.path || performance.now() >= deadline) {
                        throw new Error('영상이 준비되면 다시 복사해 주세요');
                    }
                    await new Promise((resolve) => setTimeout(resolve, 25));
                    player = V.player;
                }
                session = V.session;
                try {
                    if (player.failed || player.source === 'stream' || player.video.readyState < 2) throw new Error('server-frame');
                    // Draw synchronously before encoding so a playing video contributes exactly one frame.
                    blob = await png(player.video, t);
                } catch (error) {
                    if (!player) throw error;
                    bitmap = await frame(entry, player);
                    blob = await png(bitmap, t);
                }
            }
            if (App.fs.backend !== backend || !V.isOpen || V.current?.path !== entry.path || V.session !== session) throw new Error('보는 파일이 바뀌었어요. 다시 복사해 주세요');
            return blob;
        } finally {
            bitmap?.close();
        }
    }

    async function copy() {
        if (!canCopy()) return false;
        const entry = { ...V.current };
        const backend = App.fs.backend;
        const player = V.player;
        V.view?.finish?.();
        const t = V.orientationOf(entry.path);
        // Keep file paste available even when this browser refuses system clipboard access.
        if (entry.type === 'image') App.gallery.clipboard.set('copy', [entry.path]);
        try {
            if (!navigator.clipboard?.write || !window.ClipboardItem) throw new Error('이 브라우저에서는 이미지 복사를 지원하지 않아요');
            const blob = pixels(entry, backend, player, t, V.session);
            // Pass a promise while the user gesture is active; decoding may finish later.
            const item = new ClipboardItem({ 'image/png': blob });
            const results = await Promise.allSettled([navigator.clipboard.write([item]), blob]);
            for (const result of results) if (result.status === 'rejected') throw result.reason;
            ui.toast(entry.type === 'video' ? '지금 장면을 복사했어요' : '이미지를 복사했어요 · 다른 앱에 Ctrl+V로 붙여 넣으세요', { type: 'success' });
            return true;
        } catch (error) {
            ui.toast(`이미지를 복사하지 못했어요: ${error.message}`, { type: 'warning' });
            return false;
        }
    }

    async function copyPath(entry) {
        try {
            if (App.server?.backend && typeof App.server.copyPath === 'function') return await App.server.copyPath([entry.path]);
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(entry.path);
            } else {
                const previous = document.activeElement;
                const field = h('textarea', { 'aria-label': '복사할 파일 경로', style: 'position:fixed;left:-10000px' });
                field.value = entry.path;
                document.body.append(field);
                try {
                    field.select();
                    if (!document.execCommand('copy')) throw new Error('클립보드를 사용할 수 없어요');
                } finally {
                    field.remove();
                    previous?.focus?.({ preventScroll: true });
                }
            }
            ui.toast('경로를 복사했어요', { type: 'success' });
        } catch (error) {
            ui.toast(`경로를 복사하지 못했어요: ${error.message}`, { type: 'warning' });
        }
    }

    App.commands.register({
        id: 'viewer.copy', title: '이미지 복사', group: '보기', icon: 'copy',
        scope: 'viewer', keys: ['Mod+C'], when: canCopy, run: () => copy(),
    });

    V.contextItems.push((entry, kind) => {
        if (kind !== 'image' && kind !== 'video') return [];
        const items = [{ label: kind === 'video' ? '지금 장면 복사' : '이미지 복사', icon: 'copy', command: 'viewer.copy' }];
        if (typeof App.capture?.grab === 'function' && typeof App.capture?.copy === 'function') {
            items.push({
                label: '보이는 부분만 복사', icon: 'copy',
                action: async () => {
                    try {
                        await App.capture.copy(await App.capture.grab());
                    } catch (error) {
                        ui.toast(`이미지를 복사하지 못했어요: ${error.message}`, { type: 'warning' });
                    }
                },
            });
        }
        items.push({ label: '파일 경로 복사', icon: 'copy', action: () => copyPath(entry) });
        return items;
    });
})();
