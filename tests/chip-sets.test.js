'use strict';

async function saved(page) {
    await page.waitForFunction(async () => {
        try {
            const current = JSON.stringify(App.chipset.doc);
            const disk = JSON.stringify(JSON.parse(await window.__opfs.read('.fluid-organizer/chipsets.json')));
            const global = JSON.stringify(await App.idb.get('chipsets.library'));
            return current === disk && current === global;
        } catch (e) {
            return false;
        }
    });
}

async function openWorkspace(page, name, seed = false) {
    await saved(page);
    await page.evaluate(async ({ name, seed }) => {
        if (seed) await window.__seedWorkspace({}, name);
        else await window.__useExistingWorkspace(name);
        await App.workspace.pick();
    }, { name, seed });
    await page.waitForFunction(() => App.chipset.ready && App.chipset.workspaceId === App.state.workspace.id);
}

module.exports = [
    {
        name: 'chip sets: global IDs, workspace selection and deletion tombstones survive reopening',
        async run({ openApp, assert }) {
            const { page } = await openApp();
            await page.waitForFunction(() => App.chipset.ready);
            const ids = await page.evaluate(() => {
                const C = App.chipset;
                const basic = C.active().id;
                const set = C.createPreset('주식강의용');
                const cat = C.addCategory({ name: '종목' });
                const chip = C.addChip(cat.id, '삼성전자');
                return { basic, set: set.id, chip: chip.id };
            });
            await openWorkspace(page, 'second', true);
            assert.equal(await page.evaluate((id) => App.chipset.info(id)?.chip.name, ids.chip), '삼성전자');
            await page.evaluate((id) => App.chipset.setActive(id), ids.basic);
            await openWorkspace(page, 'ws');
            assert.equal(await page.evaluate(() => App.chipset.active().id), ids.set);
            await openWorkspace(page, 'second');
            assert.equal(await page.evaluate(() => App.chipset.active().id), ids.basic);
            await page.evaluate((id) => App.chipset.deletePreset(id), ids.set);
            await openWorkspace(page, 'ws');
            assert.equal(await page.evaluate((id) => App.chipset.doc.presets.some((p) => p.id === id), ids.set), false);
            assert.ok(await page.evaluate((id) => App.chipset.doc.deleted.some((x) => x.id === id), ids.set));
            assert.equal(await page.evaluate(() => App.chipset.doc.version), 2);
        },
    },
    {
        name: 'chip sets: export/import preserves IDs, replace and Ctrl+Z each take one step',
        async run({ openApp, assert }) {
            const { page } = await openApp();
            await page.waitForFunction(() => App.chipset.ready);
            await page.evaluate(() => {
                const C = App.chipset;
                window.__base = C.active().id;
                C.createPreset('주식강의용');
            });
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => App.chipset.doc.presets.length === 1);
            assert.equal(await page.evaluate(() => App.chipset.active().id === window.__base), true);
            const exported = await page.evaluate(() => {
                const C = App.chipset;
                C.createPreset('AI강의용');
                const cat = C.addCategory({ name: '주제' });
                C.addChip(cat.id, '모델');
                const obj = C.exportPreset(C.active().id);
                window.__exported = obj;
                C.deletePreset(obj.id);
                return obj;
            });
            await page.evaluate(() => App.chipset.importPreset(window.__exported));
            assert.deepEqual(await page.evaluate(() => App.chipset.list().map((x) => x.id)), exported.categories[0].chips.map((x) => x.id));
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => !App.chipset.doc.presets.some((p) => p.id === window.__exported.id));
            await page.evaluate(() => {
                const C = App.chipset;
                C.importPreset(window.__exported);
                window.__replacement = C.exportPreset(window.__exported.id);
                window.__replacement.categories[0].chips[0].name = '추론';
                C.importPreset(window.__replacement, { replace: true });
            });
            assert.equal(await page.evaluate(() => App.chipset.list()[0].name), '추론');
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => App.chipset.list()[0]?.name === '모델');
            assert.equal(await page.evaluate(() => {
                try {
                    App.chipset.importPreset(window.__exported);
                    return false;
                } catch (e) {
                    return true;
                }
            }), true);
            await saved(page);
        },
    },
    {
        name: 'chip sets: v1 data and duplicate names merge, newer presets beat older tombstones',
        async run({ openApp, assert }) {
            const legacy = { version: 1, activePreset: 'legacy', presets: [{ id: 'legacy', name: '강의', categories: [{ id: 'cat', name: '주제', chips: [{ id: 'unchanged', name: '주식', children: [] }] }], hotkeys: { '1': 'unchanged' } }] };
            const { page } = await openApp({ seed: { '.fluid-organizer/chipsets.json': JSON.stringify(legacy) } });
            await page.waitForFunction(() => App.chipset.ready);
            assert.equal(await page.evaluate(() => App.chipset.list()[0].id), 'unchanged');
            await page.evaluate(async () => {
                await App.idb.set('chipsets.library', {
                    version: 2,
                    presets: [{ id: 'other', name: '강의', updatedAt: 10, categories: [], hotkeys: {} }],
                    deleted: [{ id: 'legacy', at: -1 }],
                });
                await App.chipset.load();
            });
            assert.deepEqual(await page.evaluate(() => App.chipset.presets().map((p) => p.name)), ['강의', '강의 2']);
            assert.equal(await page.evaluate(() => App.chipset.active().id), 'legacy');
            assert.equal(await page.evaluate(() => App.chipset.info('unchanged').chip.name), '주식');
            await saved(page);
        },
    },
];
