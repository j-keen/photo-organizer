#!/usr/bin/env node
/*
 * Minimal test runner.  node tests/run.js [filter]
 * Each tests/*.test.js exports an array of { name, run(h) } where h = harness helpers + assert.
 * A test fails if run() throws or if the page logged errors (see harness.openApp -> errors).
 * A failing test is retried TEST_RETRIES times (default 1). One that passes on a retry is reported as
 * "flaky" (yellow) — it doesn't fail the run, but it is listed so it can be made deterministic.
 * Env: TEST_TIMEOUT (ms per attempt, default 90000), TEST_RETRIES (default 1).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const harness = require('./lib/harness');

const filter = process.argv[2] || '';
const TIMEOUT = Number(process.env.TEST_TIMEOUT || 90000);
const RETRIES = Number(process.env.TEST_RETRIES ?? 1);

async function attempt(t) {
    const opened = [];
    const h = {
        ...harness,
        assert,
        // Track apps so they always get closed
        openApp: async (opts) => {
            const app = await harness.openApp(opts);
            opened.push(app);
            return app;
        },
    };
    try {
        await Promise.race([
            t.run(h),
            new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${TIMEOUT}ms`)), TIMEOUT)),
        ]);
        const pageErrors = opened.flatMap((a) => a.errors).filter((e) => !(t.allowErrors || []).some((re) => re.test(e)));
        if (pageErrors.length) throw new Error('page errors:\n    ' + pageErrors.join('\n    '));
        return null;
    } catch (e) {
        return e;
    } finally {
        for (const a of opened) await a.close().catch(() => {});
    }
}

async function main() {
    const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
    let passed = 0;
    let failed = 0;
    const flaky = [];
    const started = Date.now();

    for (const file of files) {
        const tests = require(path.join(__dirname, file));
        for (const t of tests) {
            const full = `${file} › ${t.name}`;
            if (filter && !full.toLowerCase().includes(filter.toLowerCase())) continue;
            const t0 = Date.now();
            let err = await attempt(t);
            let tries = 1;
            while (err && tries <= RETRIES) {
                tries++;
                err = await attempt(t);
            }
            if (!err) {
                passed++;
                if (tries > 1) {
                    flaky.push(full);
                    console.log(`  \x1b[33m✓ ${full} (flaky: passed on attempt ${tries})\x1b[0m \x1b[90m(${Date.now() - t0}ms)\x1b[0m`);
                } else {
                    console.log(`  \x1b[32m✓\x1b[0m ${full} \x1b[90m(${Date.now() - t0}ms)\x1b[0m`);
                }
            } else {
                failed++;
                console.log(`  \x1b[31m✗ ${full}\x1b[0m`);
                console.log('    ' + String(err && err.stack ? err.stack : err).split('\n').slice(0, 8).join('\n    '));
            }
        }
    }
    const flakyNote = flaky.length ? `, ${flaky.length} flaky` : '';
    console.log(`\n${passed} passed, ${failed} failed${flakyNote} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    if (flaky.length) console.log('flaky:\n  ' + flaky.join('\n  '));
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
