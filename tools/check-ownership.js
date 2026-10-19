#!/usr/bin/env node
/*
 * Merge helper for parallel rounds: lists files a team branch changed outside its ownership
 * (see docs/ARCHITECTURE.md §2) and whether its HTML edits stayed inside its <!-- team:x --> region.
 *   node tools/check-ownership.js <branch> <team> [base]
 */
'use strict';
const { execSync } = require('child_process');

const OWNERSHIP = {
    nav: ['js/features/topbar.js', 'js/features/sidebar.js', 'css/topbar.css', 'css/sidebar.css', /^tests\/nav[\w.-]*\.test\.js$/],
    gallery: ['js/features/gallery.js', 'css/gallery.css', /^tests\/gallery[\w.-]*\.test\.js$/],
    thumbs: ['js/features/thumbs.js', 'js/features/statusbar.js', 'css/jobs.css', /^tests\/thumbs[\w.-]*\.test\.js$/],
    chips: ['js/features/inspector.js', 'js/features/chipset.js', 'css/inspector.css', 'css/chipset.css', /^tests\/(chipset|chips|inspector)[\w.-]*\.test\.js$/],
    viewer: ['js/features/viewer.js', 'js/features/video-editor.js', 'css/viewer.css', 'css/video-editor.css', /^tests\/viewer[\w.-]*\.test\.js$/],
    server: [/^server\//, 'js/core/fs-server.js', 'js/features/server.js', 'css/server.css', /^tests\/server[\w.-]*\.test\.js$/],
    organize: ['js/features/organize.js', 'js/features/duplicates.js', 'css/organize.css', 'css/duplicates.css', /^tests\/(organize|duplicates)[\w.-]*\.test\.js$/],
    shell: ['js/features/workspace.js', 'js/features/layout.js', 'js/features/palette.js', 'css/welcome.css', 'css/palette.css', /^tests\/shell[\w.-]*\.test\.js$/],
};

function owns(team, file) {
    const rules = OWNERSHIP[team] || [];
    const prefix = new RegExp(`^(js/features|css)/${team}[-.]`);
    return prefix.test(file) || rules.some((r) => (typeof r === 'string' ? r === file : r.test(file)));
}

function htmlEditsInRegion(branch, base, team) {
    const diff = execSync(`git diff ${base}...${branch} -U0 -- "사진영상정리기.html"`, { encoding: 'utf8' });
    if (!diff.trim()) return { ok: true, note: 'no HTML changes' };
    const html = execSync(`git show ${branch}:"사진영상정리기.html"`, { encoding: 'utf8' }).split('\n');
    const regions = [];
    let start = null;
    html.forEach((line, i) => {
        if (line.includes(`<!-- team:${team} -->`)) start = i + 1;
        if (line.includes(`<!-- /team:${team} -->`) && start != null) {
            regions.push([start, i + 1]);
            start = null;
        }
    });
    const bad = [];
    for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
        const from = Number(m[1]);
        const count = m[2] == null ? 1 : Number(m[2]);
        for (let ln = from; ln < from + Math.max(count, 1); ln++) {
            if (count === 0) continue;
            if (!regions.some(([a, b]) => ln > a && ln < b)) bad.push(ln);
        }
    }
    return { ok: bad.length === 0, note: bad.length ? `edits outside team region at lines ${bad.join(', ')}` : 'inside team region' };
}

function main() {
    const [branch, team, base = 'main'] = process.argv.slice(2);
    if (!branch || !team || !OWNERSHIP[team]) {
        console.error('usage: node tools/check-ownership.js <branch> <team> [base]   teams: ' + Object.keys(OWNERSHIP).join(', '));
        process.exit(2);
    }
    const files = execSync(`git diff --name-only ${base}...${branch}`, { encoding: 'utf8' }).split('\n').filter(Boolean);
    const foreign = files.filter((f) => f !== '사진영상정리기.html' && !owns(team, f));
    console.log(`${branch} (${team}): ${files.length} files changed`);
    for (const f of files) console.log(`  ${owns(team, f) || f === '사진영상정리기.html' ? ' ' : '!'} ${f}`);
    const html = files.includes('사진영상정리기.html') ? htmlEditsInRegion(branch, base, team) : { ok: true, note: 'no HTML changes' };
    console.log(`HTML: ${html.note}`);
    if (foreign.length) console.log(`\n${foreign.length} file(s) outside ownership — review before merging.`);
    process.exit(foreign.length || !html.ok ? 1 : 0);
}

main();
