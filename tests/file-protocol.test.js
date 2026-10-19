// The app must also start when the HTML file is opened directly (file://), which is how most people launch it.
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

async function expectCleanStart(launchBrowser, assert, fileUrl) {
    const browser = await launchBrowser();
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (m) => {
            if (m.type() === 'error' && !/pretendard|net::ERR_/i.test(m.text())) errors.push(m.text());
        });
        await page.goto(fileUrl);
        await page.waitForSelector('#welcome:not([hidden]) .welcome-card');
        assert.ok(await page.evaluate(() => typeof App === 'object' && App.modules.length > 5));
        assert.deepEqual(errors, []);
    } finally {
        await browser.close();
    }
}

module.exports = [
    {
        name: 'single-file build (dist) starts from file:// too',
        async run({ launchBrowser, assert }) {
            const { build } = require('../tools/build-single');
            const { out } = build();
            await expectCleanStart(launchBrowser, assert, pathToFileURL(out).href);
        },
    },
    {
        name: 'starts from file:// without script errors',
        async run({ launchBrowser, assert, ROOT, APP_FILE }) {
            const browser = await launchBrowser();
            try {
                const page = await browser.newPage();
                const errors = [];
                page.on('pageerror', (e) => errors.push(e.message));
                page.on('console', (m) => {
                    if (m.type() === 'error' && !/pretendard|net::ERR_/i.test(m.text())) errors.push(m.text());
                });
                await page.goto(pathToFileURL(path.join(ROOT, APP_FILE)).href);
                await page.waitForSelector('#welcome:not([hidden]) .welcome-card');
                assert.ok(await page.evaluate(() => typeof App === 'object' && App.modules.length > 5));
                assert.deepEqual(errors, []);
            } finally {
                await browser.close();
            }
        },
    },
];
