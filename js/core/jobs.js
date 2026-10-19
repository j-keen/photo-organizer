/*
 * Background jobs with progress (thumbnail pre-generation, scans, batch moves, server tasks...).
 *   const job = App.jobs.start({ title: '썸네일 만드는 중', total: 120, cancellable: true,
 *                                background: true, pausable: true, onPause, onResume, kind });
 *   job.update(done, { total, detail });  job.step(n);  job.finish(result?);  job.fail(error);
 *   job.pause();  job.resume();  if (job.cancelled) ...;  job.onCancel(fn)
 * background: true marks low-priority housekeeping (index scan, thumbnail pre-generation) — waitIdle-style
 * checks and "unsaved work" prompts can ignore those via App.jobs.list({ foreground: true }).
 * Events: 'jobs:changed' (list changed or progress moved), 'jobs:finished' { job } (done / failed / cancelled)
 */
(() => {
    'use strict';
    const active = new Map();
    const history = []; // last finished jobs, newest first
    const HISTORY_LIMIT = 10;
    const emit = App.util.throttle(() => App.bus.emit('jobs:changed'), 120);

    function settle(job, state) {
        if (job.state !== 'running' && job.state !== 'paused') return false;
        job.state = state;
        job.endedAt = Date.now();
        active.delete(job.id);
        history.unshift(job);
        if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
        App.bus.emit('jobs:changed');
        App.bus.emit('jobs:finished', { job });
        return true;
    }

    const jobs = {
        start({ title, total = 0, cancellable = true, detail = '', background = false, pausable = false, onPause = null, onResume = null, kind = null }) {
            const job = {
                id: App.util.uid('j'),
                title,
                total,
                done: 0,
                detail,
                kind,
                background,
                pausable,
                cancellable,
                cancelled: false,
                paused: false,
                startedAt: Date.now(),
                state: 'running',
                result: null,
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
                finish(result) {
                    if (result != null) job.result = result;
                    settle(job, job.cancelled ? 'cancelled' : 'done');
                },
                fail(err) {
                    job.error = err;
                    job.result = err?.message || String(err);
                    settle(job, 'failed');
                },
                pause() {
                    if (!job.pausable || job.paused || job.state !== 'running') return;
                    job.paused = true;
                    job.state = 'paused';
                    try {
                        onPause?.(job);
                    } catch (e) {
                        console.error(e);
                    }
                    App.bus.emit('jobs:changed');
                },
                resume() {
                    if (!job.paused) return;
                    job.paused = false;
                    job.state = 'running';
                    try {
                        onResume?.(job);
                    } catch (e) {
                        console.error(e);
                    }
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

        /** Running jobs. { foreground: true } leaves out background housekeeping. */
        list({ foreground = false } = {}) {
            const all = [...active.values()];
            return foreground ? all.filter((j) => !j.background) : all;
        },

        get(id) {
            return active.get(id);
        },

        /** Recently finished jobs (newest first) for the activity center */
        history() {
            return [...history];
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
