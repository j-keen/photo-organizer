/*
 * Status bar: view counts, selection summary, background job progress, index state.
 * Other modules can add their own items: App.statusbar.addItem(id, element, { side: 'right' })
 */
(() => {
    'use strict';
    const { h, formatCount, formatBytes } = App.util;
    const ui = App.ui;

    let left;
    let right;
    let countsEl;
    let selEl;
    let jobsEl;

    function renderCounts() {
        if (!App.fs.ready) {
            countsEl.textContent = '';
            return;
        }
        const v = App.view.visible;
        const files = v.filter((e) => e.kind === 'file').length;
        const dirs = v.length - files;
        let text = `${formatCount(v.length)}개 항목`;
        if (dirs) text += ` (폴더 ${formatCount(dirs)}, 파일 ${formatCount(files)})`;
        const hidden = App.view.source.hiddenCount;
        countsEl.textContent = text;
        countsEl.dataset.tip = hidden ? `사진·영상이 아닌 파일 ${formatCount(hidden)}개는 숨겨져 있어요` : '';
        if (!hidden) delete countsEl.dataset.tip;
    }

    function renderSelection() {
        const n = App.select.count;
        if (!n) {
            selEl.textContent = '';
            return;
        }
        const entries = App.select.entries();
        const size = entries.reduce((s, e) => s + (e.size || 0), 0);
        selEl.textContent = `${formatCount(n)}개 선택됨${size ? ` · ${formatBytes(size)}` : ''}`;
    }

    function renderJobs() {
        const s = App.jobs.summary();
        jobsEl.innerHTML = '';
        if (!s) {
            jobsEl.hidden = true;
            return;
        }
        jobsEl.hidden = false;
        const pct = s.ratio == null ? null : Math.round(s.ratio * 100);
        jobsEl.append(
            h('span', { class: 'spinner' }),
            h('span', { text: s.count > 1 ? `${s.title} 외 ${s.count - 1}개` : s.title }),
            pct != null ? h('span', { class: 'sb-progress' }, h('span', { class: 'progress' }, h('i', { style: { width: pct + '%' } }))) : null,
            pct != null ? h('span', { text: `${pct}%` }) : s.done ? h('span', { text: formatCount(s.done) }) : null,
        );
    }

    function showJobsPopover() {
        const list = App.jobs.list();
        if (!list.length) return;
        const body = h('div', { class: 'jobs-pop' });
        for (const j of list) {
            const pct = j.total ? Math.round((Math.min(j.done, j.total) / j.total) * 100) : null;
            body.append(h('div', { class: 'jobs-pop-row' },
                h('div', { class: 'row' }, h('span', { class: 'grow truncate', text: j.title }), h('span', { class: 'faint', text: pct != null ? `${pct}%` : formatCount(j.done) }),
                    j.cancellable ? h('button', { class: 'btn ghost sm icon', 'data-tip': '취소', html: ui.icon('x', { size: 14 }), onclick: () => j.cancel() }) : null),
                h('div', { class: 'progress' }, h('i', { style: { width: (pct ?? 100) + '%' } })),
                j.detail ? h('div', { class: 'faint', text: j.detail }) : null));
        }
        ui.popover(jobsEl, body, { above: true, align: 'end' });
    }

    const statusbar = {
        addItem(id, el, { side = 'right' } = {}) {
            el.classList.add('sb-item');
            el.dataset.sbId = id;
            (side === 'left' ? left : right).append(el);
            return el;
        },
    };

    App.register('statusbar', {
        init() {
            const bar = document.getElementById('statusbar');
            countsEl = h('span', { class: 'sb-item' });
            selEl = h('span', { class: 'sb-item sb-selection' });
            jobsEl = h('span', { class: 'sb-item sb-btn sb-jobs', hidden: true, onclick: showJobsPopover });
            left = h('div', { class: 'row', style: { gap: '14px' } }, countsEl, selEl);
            right = h('div', { class: 'row', style: { gap: '14px' } }, jobsEl);
            bar.append(left, h('span', { class: 'sb-spacer' }), right);

            App.bus.on('view:changed', renderCounts);
            App.bus.on('selection:changed', renderSelection);
            App.bus.on('jobs:changed', renderJobs);
            App.bus.on('workspace:closed', () => {
                renderCounts();
                renderSelection();
            });
        },
    });

    App.statusbar = statusbar;
})();
