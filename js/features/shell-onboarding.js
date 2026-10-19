/*
 * First-run tour: a few coach marks (folder tree → chipset panel → command palette → gallery) shown once after the
 * first workspace opens. Never blocks the app: the spotlight lets clicks through, Esc or "건너뛰기" ends it.
 *
 *   App.onboarding.start({ force })  replay (settings: onboarding.done)
 *   App.onboarding.addStep({ id, order, target: () => Element|null, title, text, keys: [combo], placement })
 *       placement: 'right' | 'left' | 'top' | 'bottom' | 'center'. Steps whose target is hidden are skipped.
 */
(() => {
    'use strict';
    const { h } = App.util;
    const ui = App.ui;
    const DONE_KEY = 'onboarding.done';

    function visible(sel) {
        const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return null;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') return null;
        return el;
    }

    const steps = [
        {
            id: 'tree',
            order: 10,
            placement: 'right',
            target: () => visible('#sidebar .tree-section') || visible('#sidebar'),
            title: '폴더 트리',
            text: '왼쪽에서 폴더를 눌러 이동해요. 파일을 폴더로 끌어다 놓으면 옮겨지고, 우클릭하면 새 폴더·이름 바꾸기 메뉴가 나와요.',
        },
        {
            id: 'chips',
            order: 20,
            placement: 'left',
            target: () => visible('#inspector [data-section*="chip"]') || visible('#inspector .chip-panel') || visible('#inspector'),
            title: '칩셋으로 분류',
            text: '파일을 고른 뒤 오른쪽 칩을 누르면 분류가 붙고, 한 번 더 누르면 떨어져요. 칩은 작업 폴더에 저장돼서 다른 PC에서도 그대로예요.',
        },
        {
            id: 'palette',
            order: 30,
            placement: 'top',
            target: () => visible('[data-sb-id="palette"]') || visible('#topbar .topbar-search') || visible('#topbar'),
            title: '명령 팔레트',
            text: '명령·폴더·파일을 한 곳에서 찾아요. 초성(ㄱㅅㅎ)만 쳐도 되고, 한/영을 잘못 눌러도 알아들어요. ?를 누르면 단축키가 나와요.',
            keys: ['Mod+K'],
        },
        {
            id: 'gallery',
            order: 40,
            placement: 'center',
            target: () => visible('#gallery-scroll'),
            title: '이제 정리를 시작해 볼까요?',
            text: '더블클릭이나 Enter로 크게 보고, Ctrl+휠로 썸네일 크기를 바꿔요. 지운 파일은 휴지통에 남고 Ctrl+Z로 언제든 되돌릴 수 있어요.',
        },
    ];

    let tour = null; // { list, i, spot, card, cleanup }

    function addStep(step) {
        const i = steps.findIndex((s) => s.id === step.id);
        if (i >= 0) steps.splice(i, 1);
        steps.push({ order: 50, placement: 'bottom', ...step });
        steps.sort((a, b) => a.order - b.order);
    }

    function start({ force = false } = {}) {
        if (tour) return false;
        if (!force && App.settings.get(DONE_KEY, false)) return false;
        const list = steps.filter((s) => {
            try {
                return !!s.target();
            } catch (e) {
                return false;
            }
        });
        if (!list.length) return false;
        const spot = h('div', { class: 'ob-spot', 'aria-hidden': 'true' });
        const card = h('div', { class: 'ob-card', role: 'dialog', 'aria-modal': 'false', 'aria-label': '시작 안내', tabindex: '-1' });
        document.body.append(spot, card);
        const onKey = (e) => {
            if (!tour) return;
            if (e.key === 'Escape' && App.layers.top() === 'main') {
                e.preventDefault();
                e.stopPropagation();
                finish();
                return;
            }
            if (!card.contains(document.activeElement)) return;
            if (e.key === 'ArrowRight' || (e.key === 'Enter' && !e.target.closest('button'))) {
                e.preventDefault();
                e.stopPropagation();
                go(tour.i + 1);
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                e.stopPropagation();
                go(tour.i - 1);
            }
        };
        const reposition = App.util.throttle(() => tour && place(), 50);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('resize', reposition);
        const offLayout = App.bus.on('layout:changed', reposition);
        const offClose = App.bus.on('workspace:closed', () => finish({ remember: false }));
        tour = {
            list,
            i: 0,
            spot,
            card,
            cleanup() {
                document.removeEventListener('keydown', onKey, true);
                window.removeEventListener('resize', reposition);
                offLayout();
                offClose();
                spot.remove();
                card.remove();
            },
        };
        go(0);
        return true;
    }

    function go(i) {
        if (!tour) return;
        if (i >= tour.list.length) {
            finish();
            ui.toast('준비 끝! 언제든 설정 › 일반에서 안내를 다시 볼 수 있어요', { type: 'success' });
            return;
        }
        tour.i = Math.max(0, i);
        renderCard();
        place();
        tour.card.focus({ preventScroll: true });
    }

    function renderCard() {
        const { list, i, card } = tour;
        const s = list[i];
        card.innerHTML = '';
        const dots = h('div', { class: 'ob-dots' }, ...list.map((_, k) => h('span', { class: `ob-dot${k === i ? ' on' : ''}` })));
        const keys = (s.keys || []).map((k) => (App.palette ? App.palette.kbdEl(k) : h('span', { class: 'kbd', text: App.commands.displayCombo(k) })));
        const last = i === list.length - 1;
        card.append(
            h('div', { class: 'ob-top' }, h('span', { class: 'ob-step', text: `${i + 1} / ${list.length}` }), dots),
            h('div', { class: 'ob-title' }, h('span', { text: s.title }), ...keys),
            h('p', { class: 'ob-text', text: s.text }),
            h('div', { class: 'ob-actions' },
                h('button', { class: 'btn ghost sm', type: 'button', text: '건너뛰기', onclick: () => finish() }),
                h('div', { class: 'grow' }),
                i > 0 ? h('button', { class: 'btn sm', type: 'button', text: '이전', onclick: () => go(i - 1) }) : null,
                h('button', { class: 'btn primary sm ob-next', type: 'button', text: last ? '시작하기' : '다음', onclick: () => go(i + 1) })));
    }

    function place() {
        const { list, i, spot, card } = tour;
        const s = list[i];
        let target = null;
        try {
            target = s.target();
        } catch (e) {
            target = null;
        }
        if (!target) {
            // the panel disappeared (e.g. window got narrow): move on
            if (i < list.length - 1) go(i + 1);
            else finish();
            return;
        }
        const pad = 6;
        const r = target.getBoundingClientRect();
        const box = {
            left: Math.max(4, r.left - pad),
            top: Math.max(4, r.top - pad),
            right: Math.min(window.innerWidth - 4, r.right + pad),
            bottom: Math.min(window.innerHeight - 4, r.bottom + pad),
        };
        Object.assign(spot.style, { left: box.left + 'px', top: box.top + 'px', width: box.right - box.left + 'px', height: box.bottom - box.top + 'px' });
        const cw = card.offsetWidth;
        const ch = card.offsetHeight;
        const gap = 14;
        let x;
        let y;
        switch (s.placement) {
            case 'right':
                x = box.right + gap;
                y = box.top + 24;
                break;
            case 'left':
                x = box.left - gap - cw;
                y = box.top + 24;
                break;
            case 'top':
                x = box.right - cw;
                y = box.top - gap - ch;
                break;
            case 'bottom':
                x = box.left;
                y = box.bottom + gap;
                break;
            default:
                x = (box.left + box.right) / 2 - cw / 2;
                y = (box.top + box.bottom) / 2 - ch / 2;
        }
        // keep the card on screen; if it would cover a side panel target, flip to the other side
        if (s.placement === 'right' && x + cw > window.innerWidth - 8) x = box.left + 16;
        if (s.placement === 'left' && x < 8) x = box.right - cw - 16;
        card.style.left = App.util.clamp(x, 8, window.innerWidth - cw - 8) + 'px';
        card.style.top = App.util.clamp(y, 8, window.innerHeight - ch - 8) + 'px';
        card.dataset.placement = s.placement;
    }

    function finish({ remember = true } = {}) {
        if (!tour) return;
        tour.cleanup();
        tour = null;
        if (remember) App.settings.set(DONE_KEY, true);
    }

    App.bus.on('workspace:opened', () => {
        if (App.settings.get(DONE_KEY, false) || App.shell?.isAutomated?.()) return;
        setTimeout(() => {
            if (App.fs.ready && App.layers.top() === 'main' && !App.settings.get(DONE_KEY, false)) start();
        }, 1200);
    });

    App.commands.register({ id: 'onboarding.start', title: '시작 안내 다시 보기', group: '일반', icon: 'sparkles', when: () => App.fs.ready, run: () => start({ force: true }) });

    App.onboarding = {
        start,
        stop: () => finish({ remember: false }),
        finish,
        addStep,
        steps,
        get active() {
            return !!tour;
        },
        get step() {
            return tour ? tour.list[tour.i].id : null;
        },
    };
})();
