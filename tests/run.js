#!/usr/bin/env node
/*
 * Minimal test runner.  node tests/run.js [filter]
 * Each tests/*.test.js exports an array of { name, run(h) } where h = harness helpers + assert.
 * A test fails if run() throws or if the page logged errors (see harness.openApp -> errors).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const harness = require('./lib/harness');

const filter = process.argv[2] || '';
const TIMEOUT = Number(process.env.TEST_TIMEOUT || 90000);

async function main() {
    const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
    let passed = 0;
    let failed = 0;
    const failures = [];
    const started = Date.now();

    for (const file of files) {
        const tests = require(path.join(__dirname, file));
        for (const t of tests) {
            const full = `${file} › ${t.name}`;
            if (filter && !full.toLowerCase().includes(filter.toLowerCase())) continue;
            const t0 = Date.now();
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
                passed++;
                console.log(`  \x1b[32m✓\x1b[0m ${full} \x1b[90m(${Date.now() - t0}ms)\x1b[0m`);
            } catch (e) {
                failed++;
                failures.push({ full, e });
                console.log(`  \x1b[31m✗ ${full}\x1b[0m`);
                console.log('    ' + String(e && e.stack ? e.stack : e).split('\n').slice(0, 8).join('\n    '));
            } finally {
                for (const a of opened) await a.close().catch(() => {});
            }
        }
    }
    console.log(`\n${passed} passed, ${failed} failed (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
