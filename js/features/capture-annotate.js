/*
 * Capture annotation: App.captureAnnotate.open(path) -> Promise<boolean>.
 * Resolves true once the editor is displayed, false if unavailable or loading fails.
 * Drawing history stays inside the editor; saving uses fs.overwrite for one global undo entry
 * and a recoverable original in the app trash. Supports JPEG and PNG captures.
 */
(() => {
    'use strict';
    const { h } = App.util;
    const colors = [
        ['red', '빨강'], ['orange', '주황'], ['yellow', '노랑'],
        ['green', '초록'], ['blue', '파랑'], ['purple', '보라'],
    ];
    let active = null;

    async function open(path) {
        if (active) {
            active.root?.focus();
            return false;
        }
        const session = {};
        active = session;
        let resource = null;
        try {
            const file = await App.fs.getFile(path);
            const mime = file.type === 'image/png' || /\.png$/i.test(path) ? 'image/png' :
                file.type === 'image/jpeg' || /\.jpe?g$/i.test(path) ? 'image/jpeg' : null;
            if (!mime) throw new Error('JPG 또는 PNG 캡처를 열어 주세요');
            resource = await App.fs.url(path);
            const image = new Image();
            await new Promise((resolve, reject) => {
                image.onload = resolve;
                image.onerror = () => reject(new Error('이미지를 읽지 못했어요'));
                image.src = resource.url;
            });
            if (!image.naturalWidth || !image.naturalHeight) throw new Error('이미지를 읽지 못했어요');
            build(session, path, mime, image, resource);
            return true;
        } catch (error) {
            resource?.release();
            active = null;
            App.ui.toast(`그리기를 열지 못했어요: ${error.message || error}`, { type: 'error' });
            return false;
        }
    }

    function build(session, path, mime, image, resource) {
        const previousFocus = document.activeElement;
        const root = h('section', { class: 'capture-annotate', role: 'dialog', 'aria-modal': 'true', 'aria-label': '캡처에 그리기', tabindex: '-1' });
        session.root = root;
        const toolbar = h('div', { class: 'capture-annotate-toolbar', role: 'toolbar', 'aria-label': '그리기 도구' });
        const stage = h('div', { class: 'capture-annotate-stage' });
        const canvas = h('canvas', { 'aria-label': '이미지 위에 드래그해서 그려요' });
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('그리기 화면을 만들지 못했어요');
        let operations = [];
        let undone = [];
        let draft = null;
        let pointer = null;
        let tool = 'pen';
        let color = getComputedStyle(document.documentElement).getPropertyValue('--label-red').trim();
        let width = 4;
        let busy = false;
        let asking = false;
        let closed = false;
        let prompting = false;
        const toolButtons = [];
        const colorButtons = [];

        function button(text, action, extra = {}) {
            const el = h('button', { type: 'button', class: 'btn', text, onclick: action, ...extra });
            toolbar.append(el);
            return el;
        }

        for (const [id, label] of [['pen', '펜'], ['arrow', '화살표'], ['rectangle', '사각형'], ['ellipse', '타원'], ['text', '글자']]) {
            const el = button(label, () => {
                tool = id;
                toolButtons.forEach(([key, node]) => node.setAttribute('aria-pressed', String(key === tool)));
            }, { 'aria-pressed': String(id === tool) });
            toolButtons.push([id, el]);
        }
        for (const [id, label] of colors) {
            const value = getComputedStyle(document.documentElement).getPropertyValue(`--label-${id}`).trim();
            const el = button('', () => {
                color = value;
                colorButtons.forEach((node) => node.setAttribute('aria-pressed', String(node === el)));
            }, { class: 'btn capture-annotate-color', 'aria-label': label, 'aria-pressed': String(id === 'red') });
            el.style.setProperty('--annotation-color', value);
            colorButtons.push(el);
        }
        const widthControl = h('select', { class: 'select', 'aria-label': '선 굵기' });
        for (const n of [2, 4, 8, 12, 20]) widthControl.append(h('option', { value: String(n), text: `${n}px` }));
        widthControl.value = String(width);
        widthControl.addEventListener('change', () => { width = Number(widthControl.value); });
        toolbar.append(widthControl);
        const undoButton = button('실행 취소', undo);
        const redoButton = button('다시 실행', redo);
        toolbar.append(h('span', { class: 'grow' }));
        const cancelButton = button('취소', cancel);
        const saveButton = button('저장', save, { class: 'btn primary' });

        function draw(op) {
            ctx.save();
            ctx.strokeStyle = op.color;
            ctx.fillStyle = op.color;
            ctx.lineWidth = op.width;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            const a = op.points[0];
            const b = op.points[op.points.length - 1];
            ctx.beginPath();
            if (op.tool === 'text') {
                const size = Math.max(16, op.width * 6);
                ctx.font = `${size}px ${getComputedStyle(root).fontFamily}`;
                ctx.textBaseline = 'top';
                op.text.split('\n').forEach((line, i) => ctx.fillText(line, a.x, a.y + i * size * 1.3));
            } else if (op.tool === 'rectangle') {
                ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
            } else if (op.tool === 'ellipse') {
                ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
                ctx.stroke();
            } else if (op.tool === 'arrow') {
                const angle = Math.atan2(b.y - a.y, b.x - a.x);
                const head = Math.min(Math.hypot(b.x - a.x, b.y - a.y), Math.max(12, op.width * 4));
                ctx.moveTo(a.x, a.y);
                ctx.lineTo(b.x, b.y);
                ctx.moveTo(b.x - head * Math.cos(angle - Math.PI / 6), b.y - head * Math.sin(angle - Math.PI / 6));
                ctx.lineTo(b.x, b.y);
                ctx.lineTo(b.x - head * Math.cos(angle + Math.PI / 6), b.y - head * Math.sin(angle + Math.PI / 6));
                ctx.stroke();
            } else if (op.points.length === 1) {
                ctx.arc(a.x, a.y, op.width / 2, 0, Math.PI * 2);
                ctx.fill();
            } else {
                ctx.moveTo(a.x, a.y);
                op.points.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
                ctx.stroke();
            }
            ctx.restore();
        }

        function render() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            if (mime === 'image/jpeg') {
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
            }
            ctx.drawImage(image, 0, 0);
            operations.forEach(draw);
            if (draft) draw(draft);
            undoButton.disabled = busy || !operations.length || !!draft;
            redoButton.disabled = busy || !undone.length || !!draft;
            saveButton.disabled = busy || !operations.length || !!draft || prompting;
            cancelButton.disabled = busy;
            root.setAttribute('aria-busy', String(busy));
        }

        function undo() {
            if (busy || draft || prompting || !operations.length) return;
            undone.push(operations.pop());
            render();
        }

        function redo() {
            if (busy || draft || prompting || !undone.length) return;
            operations.push(undone.pop());
            render();
        }

        function point(event) {
            // CSS fitting must not reduce the saved image's resolution.
            const r = canvas.getBoundingClientRect();
            return {
                x: Math.max(0, Math.min(canvas.width, (event.clientX - r.left) * canvas.width / r.width)),
                y: Math.max(0, Math.min(canvas.height, (event.clientY - r.top) * canvas.height / r.height)),
            };
        }

        canvas.addEventListener('pointerdown', async (event) => {
            if (busy || asking || prompting || draft || event.button !== 0) return;
            event.preventDefault();
            canvas.focus();
            const op = { tool, color, width, points: [point(event)] };
            if (tool === 'text') {
                prompting = true;
                render();
                try {
                    const text = await App.ui.prompt({ title: '글자를 넣어요', label: '내용', placeholder: '이미지에 넣을 글자를 입력해요', okLabel: '넣기' });
                    if (!closed && text) {
                        op.text = text;
                        operations.push(op);
                        undone = [];
                    }
                } finally {
                    prompting = false;
                    if (!closed) render();
                }
                return;
            }
            pointer = event.pointerId;
            draft = op;
            canvas.setPointerCapture(pointer);
            render();
        });
        canvas.addEventListener('pointermove', (event) => {
            if (!draft || event.pointerId !== pointer) return;
            const p = point(event);
            if (draft.tool === 'pen') draft.points.push(p);
            else draft.points[1] = p;
            render();
        });
        canvas.addEventListener('pointerup', (event) => {
            if (!draft || event.pointerId !== pointer) return;
            const p = point(event);
            if (draft.tool === 'pen') draft.points.push(p);
            else draft.points[1] = p;
            operations.push(draft);
            undone = [];
            draft = null;
            pointer = null;
            if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
            render();
        });
        function abortStroke() {
            draft = null;
            pointer = null;
            render();
        }
        canvas.addEventListener('pointercancel', abortStroke);
        canvas.addEventListener('lostpointercapture', () => { if (draft) abortStroke(); });

        function close() {
            if (closed) return;
            closed = true;
            observer.disconnect();
            window.removeEventListener('keydown', onKey, true);
            root.remove();
            resource.release();
            App.layers.pop('capture-annotate');
            active = null;
            if (previousFocus?.isConnected) previousFocus.focus();
        }

        async function cancel() {
            if (busy || asking || prompting) return;
            asking = true;
            try {
                if ((operations.length || draft) && !await App.ui.confirm({ title: '그리기를 닫을까요?', message: '저장하지 않은 그리기가 있어요. 닫으면 사라져요.', okLabel: '닫기', cancelLabel: '계속 그리기' })) return;
                close();
            } finally {
                asking = false;
            }
        }

        async function save() {
            if (busy || asking || prompting || draft || !operations.length) return;
            busy = true;
            render();
            try {
                const blob = await new Promise((resolve, reject) => {
                    canvas.toBlob((result) => result ? resolve(result) : reject(new Error('이미지를 만들지 못했어요')), mime, 0.92);
                });
                await App.fs.overwrite(path, blob, { label: '캡처에 그리기' });
                close();
                App.ui.toast('그리기를 저장했어요', { type: 'success' });
            } catch (error) {
                App.ui.toast(`저장하지 못했어요: ${error.message || error}`, { type: 'error' });
            } finally {
                busy = false;
                if (!closed) render();
            }
        }

        function onKey(event) {
            // Nested App.ui dialogs own their keys; the underlying viewer must never receive ours.
            if (App.layers.top() !== 'capture-annotate') return;
            const mod = event.ctrlKey || event.metaKey;
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopImmediatePropagation();
                cancel();
            } else if (mod && ['z', 'y', 's'].includes(event.key.toLowerCase())) {
                event.preventDefault();
                event.stopImmediatePropagation();
                const key = event.key.toLowerCase();
                if (key === 's') save();
                else if (key === 'y' || event.shiftKey) redo();
                else undo();
            } else if (event.key === 'Tab') {
                const nodes = [...root.querySelectorAll('button:not(:disabled), select:not(:disabled)')];
                const first = nodes[0];
                const last = nodes[nodes.length - 1];
                if (event.shiftKey && (document.activeElement === first || !nodes.includes(document.activeElement))) {
                    event.preventDefault();
                    last?.focus();
                } else if (!event.shiftKey && (document.activeElement === last || !nodes.includes(document.activeElement))) {
                    event.preventDefault();
                    first?.focus();
                }
                event.stopImmediatePropagation();
            } else {
                event.stopImmediatePropagation();
            }
        }

        stage.append(canvas);
        canvas.tabIndex = -1;
        root.append(toolbar, stage, h('div', { class: 'capture-annotate-hint', text: '이미지 위에 그려요 · Ctrl+Z 실행 취소 · Ctrl+Shift+Z 다시 실행 · Esc 취소' }));
        document.body.append(root);
        const fit = () => {
            const scale = Math.min(stage.clientWidth / canvas.width, stage.clientHeight / canvas.height, 1);
            canvas.style.width = `${canvas.width * scale}px`;
            canvas.style.height = `${canvas.height * scale}px`;
        };
        const observer = new ResizeObserver(fit);
        observer.observe(stage);
        App.layers.push('capture-annotate');
        window.addEventListener('keydown', onKey, true);
        render();
        fit();
        root.focus();
    }

    App.captureAnnotate = { open };
})();
