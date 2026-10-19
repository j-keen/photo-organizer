#!/usr/bin/env node
/*
 * Builds dist/사진영상정리기.html — one self-contained HTML file (every local css/js inlined) so the app can be
 * carried around and opened like v1. Remote links (web font) stay remote and are optional.
 *   node tools/build-single.js   (or: npm run build)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = '사진영상정리기.html';

function build() {
    let html = fs.readFileSync(path.join(ROOT, ENTRY), 'utf8');
    let files = 0;
    html = html.replace(/<link rel="stylesheet" href="((?!https?:)[^"]+)">/g, (_, href) => {
        files++;
        return `<style>/* ${href} */\n${fs.readFileSync(path.join(ROOT, href), 'utf8')}\n</style>`;
    });
    html = html.replace(/<script src="((?!https?:)[^"]+)"><\/script>/g, (_, src) => {
        files++;
        const code = fs.readFileSync(path.join(ROOT, src), 'utf8').replace(/<\/script/gi, '<\\/script');
        return `<script>/* ${src} */\n${code}\n</script>`;
    });
    const outDir = path.join(ROOT, 'dist');
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, ENTRY);
    fs.writeFileSync(out, html);
    return { out, files, bytes: Buffer.byteLength(html) };
}

if (require.main === module) {
    const { out, files, bytes } = build();
    console.log(`built ${path.relative(ROOT, out)} — ${files} files inlined, ${(bytes / 1024).toFixed(0)} KB`);
}

module.exports = { build };
