/*
 * Background jobs with progress (thumbnail pre-generation, scans, batch moves, server tasks...).
 *   const job = App.jobs.start({ title: '썸네일 만드는 중', total: 120, cancellable: true });
 *   job.update(done, { total, detail });  job.finish(message?);  job.fail(error);  if (job.cancelled) ...
 * Events: 'jobs:changed' (list changed or progress moved)
 */
(() => {
    'use strict';
    const active = new Map();
    const emit = App.util.throttle(() => App.bus.emit('jobs:changed'), 120);

    const jobs = {
        start({ title, total = 0, cancellable = true, detail = '' }) {
            const job = {
                id: App.util.uid('j'),
                title,
                total,
                done: 0,
                detail,
                cancellable,
                cancelled: false,
                startedAt: Date.now(),
                state: 'running',
                cancelHandlers: [],
                update(done, opts = {}) {
                    job.done = done;
                    if (opts.total != null) job.total = opts.total;
                    if (opts.detail != null) job.detail = opts.detail;
                    emit();
                },
                step(n = 1, opts) {
                    job.update(job.done + n, opts);
                },
                finish() {
                    if (job.state !== 'running') return;
                    job.state = 'done';
                    active.delete(job.id);
                    App.bus.emit('jobs:changed');
                },
                fail(err) {
                    job.state = 'failed';
                    job.error = err;
                    active.delete(job.id);
                    App.bus.emit('jobs:changed');
                },
                cancel() {
                    if (!job.cancellable || job.cancelled) return;
                    job.cancelled = true;
                    for (const fn of job.cancelHandlers) {
                        try {
                            fn();
                        } catch (e) {
                            console.error(e);
                        }
                    }
                    job.finish();
                },
                onCancel(fn) {
                    job.cancelHandlers.push(fn);
                },
            };
            active.set(job.id, job);
            App.bus.emit('jobs:changed');
            return job;
        },

        list() {
            return [...active.values()];
        },

        get(id) {
            return active.get(id);
        },

        // Aggregate progress 0..1 (null when indeterminate) for the status bar
        summary() {
            const list = jobs.list();
            if (!list.length) return null;
            const total = list.reduce((s, j) => s + (j.total || 0), 0);
            const done = list.reduce((s, j) => s + Math.min(j.done, j.total || 0), 0);
            return { count: list.length, title: list[0].title, ratio: total ? done / total : null, done, total };
        },
    };

    App.jobs = jobs;
})();
