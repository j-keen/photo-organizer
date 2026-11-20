'use strict';

const SEED = { 'pics/': { bulk: { count: 12, image: { color: '#369' } } } };

async function setup(openApp) {
    const { page } = await openApp({ seed: SEED });
    await page.evaluate(async () => {
        await App.nav.go('pics');
        App.gallery.setMode('grid');
        App.gallery.setZoom(96);
        App.view.setSort('name', 'asc');
    });
    await page.waitForFunction(() => App.view.visible.length === 12 && !!App.gallery.cardFor(App.view.visible[5].path));
    await page.locator('#gallery-scroll').focus();
    await page.evaluate(() => {
        window.__rangeErrors = [];
        window.addEventListener('error', (e) => window.__rangeErrors.push(e.message));
        window.addEventListener('unhandledrejection', (e) => window.__rangeErrors.push(String(e.reason)));
        for (const key of ['alert', 'confirm', 'prompt']) window[key] = () => { throw new Error('Native dialog: ' + key); };
    });
    return page;
}

function itemPoint(page, i, check = false) {
    return page.evaluate(([i, check]) => {
        const r = App.gallery.itemRect(i);
        const c = document.getElementById('gallery').getBoundingClientRect();
        return { x: c.left + r.x + (check ? 24 : r.w / 2), y: c.top + r.y + (check ? 24 : r.h * 0.6) };
    }, [i, check]);
}

async function click(page, i, check = false, modifier = null) {
    const p = await itemPoint(page, i, check);
    await page.mouse.move(p.x, p.y);
    if (modifier) await page.keyboard.down(modifier);
    await page.mouse.click(p.x, p.y);
    if (modifier) await page.keyboard.up(modifier);
}

const selected = (page) => page.evaluate(() => App.view.visible.map((e, i) => App.select.has(e.path) ? i : -1).filter((i) => i >= 0));

async function clean(page, assert) {
    assert.deepEqual(await page.evaluate(() => window.__rangeErrors), []);
}

module.exports = [
    {
        name: 'checkbox Shift ranges preserve outside selection, uncheck ranges, move anchor, and leave no text selection',
        async run({ openApp, assert }) {
            const page = await setup(openApp);
            await click(page, 0, false, 'Control');
            await click(page, 2, true);
            await page.keyboard.down('Shift');
            const hover = await itemPoint(page, 5);
            await page.mouse.move(hover.x, hover.y);
            assert.equal(await page.locator('.card.range-preview').count(), 4);
            await page.keyboard.up('Shift');
            await click(page, 5, true, 'Shift');
            assert.deepEqual(await selected(page), [0, 2, 3, 4, 5]);
            assert.equal(await page.evaluate(() => App.gallery.cardFor(App.view.visible[5].path).classList.contains('is-anchor')), true);
            assert.equal(await page.locator('.card.range-preview').count(), 0);
            await click(page, 3, true, 'Shift');
            assert.deepEqual(await selected(page), [0, 2]);
            assert.equal(await page.evaluate(() => App.select.anchor === App.view.visible[3].path && App.select.focus === App.view.visible[3].path), true);
            assert.equal(await page.evaluate(() => window.getSelection().toString()), '');
            await clean(page, assert);
        },
    },
    {
        name: 'card body Shift still replaces selection and Shift+Space uses checkbox semantics only',
        async run({ openApp, assert }) {
            const page = await setup(openApp);
            await click(page, 0, false, 'Control');
            await click(page, 2, true);
            await click(page, 5, false, 'Shift');
            assert.deepEqual(await selected(page), [2, 3, 4, 5]);
            await page.evaluate(() => {
                const p = App.view.visible.map((e) => e.path);
                App.select.set([p[0], p[2]], { anchor: p[2], focus: p[5] });
                window.__plainSpaceCalls = 0;
                const prior = App.commands.get('gallery.quicklook');
                if (prior) App.commands.register({ ...prior, run: () => { window.__plainSpaceCalls++; } });
            });
            await page.keyboard.press('Shift+Space');
            assert.deepEqual(await selected(page), [0, 2, 3, 4, 5]);
            assert.equal(await page.evaluate(() => window.__plainSpaceCalls), 0);
            await page.keyboard.press('Shift+Space');
            assert.deepEqual(await selected(page), [0, 2, 3, 4]);
            await clean(page, assert);
        },
    },
    {
        name: 'same-day context action replaces selection with visible files and keeps clicked focus',
        async run({ openApp, assert }) {
            const page = await setup(openApp);
            await page.evaluate(() => {
                App.view.visible.forEach((e, i) => { e.mtime = new Date(2024, 4, i < 3 ? 10 : 11, 12).getTime(); });
                App.select.set([App.view.visible[0].path, App.view.visible[5].path]);
            });
            const p = await itemPoint(page, 0);
            await page.mouse.click(p.x, p.y, { button: 'right' });
            await page.getByText('같은 날 찍은 것 모두 선택', { exact: true }).click();
            assert.deepEqual(await selected(page), [0, 1, 2]);
            assert.equal(await page.evaluate(() => App.select.focus === App.view.visible[0].path), true);
            await clean(page, assert);
        },
    },
    {
        name: 'mouse check paint recomputes ranges and restores cards that leave the range',
        async run({ openApp, assert }) {
            const page = await setup(openApp);
            await click(page, 5, false, 'Control');
            const start = await itemPoint(page, 0, true);
            const end = await itemPoint(page, 2);
            const middle = await itemPoint(page, 1);
            await page.mouse.move(start.x, start.y);
            await page.mouse.down();
            await page.mouse.move(end.x, end.y, { steps: 10 });
            assert.deepEqual(await selected(page), [0, 1, 2, 5]);
            await page.mouse.move(middle.x, middle.y, { steps: 5 });
            assert.deepEqual(await selected(page), [0, 1, 5]);
            await page.mouse.move(end.x, end.y, { steps: 5 });
            await page.mouse.up();
            assert.deepEqual(await selected(page), [0, 1, 2, 5]);
            assert.equal(await page.locator('#gallery-scroll.is-picking').count(), 0);
            await clean(page, assert);
        },
    },
    {
        name: 'touch long press picks a reversible range and suppresses context menu and release click',
        async run({ openApp, assert }) {
            const page = await setup(openApp);
            await page.evaluate(() => { App.select.set([App.view.visible[5].path]); });
            const start = await itemPoint(page, 0);
            const end = await itemPoint(page, 2);
            const middle = await itemPoint(page, 1);
            async function pointer(type, point) {
                return page.evaluate(({ type, point }) => {
                    const target = document.elementFromPoint(point.x, point.y);
                    return target.dispatchEvent(new PointerEvent(type, {
                        bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 71,
                        isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
                        clientX: point.x, clientY: point.y,
                    }));
                }, { type, point });
            }
            await pointer('pointerdown', start);
            await page.waitForFunction(() => document.getElementById('gallery-scroll').classList.contains('is-picking'));
            assert.equal(await pointer('pointermove', end), false);
            assert.deepEqual(await selected(page), [0, 1, 2, 5]);
            await pointer('pointermove', middle);
            assert.deepEqual(await selected(page), [0, 1, 5]);
            await pointer('pointermove', end);
            assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y })), end), false);
            await pointer('pointerup', end);
            await page.evaluate(({ x, y }) => document.elementFromPoint(x, y).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y })), end);
            assert.deepEqual(await selected(page), [0, 1, 2, 5]);
            assert.equal(await page.locator('#gallery-scroll.is-picking').count(), 0);
            assert.equal(await page.locator('body > .menu').count(), 0);
            await clean(page, assert);
        },
    },
    {
        name: 'checkbox Shift recovery uses the remembered checkbox after its card is removed',
        async run({ openApp, assert }) {
            const page = await setup(openApp);
            await click(page, 1, true);
            const p = await itemPoint(page, 4, true);
            await page.mouse.move(p.x, p.y);
            await page.keyboard.down('Shift');
            await page.mouse.down();
            await page.evaluate(() => App.gallery.cardFor(App.view.visible[4].path).remove());
            await page.mouse.up();
            await page.keyboard.up('Shift');
            await page.waitForFunction(() => App.select.count === 4);
            assert.deepEqual(await selected(page), [1, 2, 3, 4]);
            assert.equal(await page.evaluate(() => window.getSelection().toString()), '');
            await clean(page, assert);
        },
    },
];
