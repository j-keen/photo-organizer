'use strict';

module.exports = [
    {
        name: 'upnext: requests above 1000 return every remaining file and stay bounded by the list',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: {
                '000-start.png': { image: { color: '#336699' } },
            } });
            await page.evaluate(() => {
                const first = App.view.entries.find((entry) => entry.path === '000-start.png');
                const entries = [first, ...Array.from({ length: 1105 }, (_, i) => {
                    const name = `extra-${String(i).padStart(4, '0')}.png`;
                    return { ...first, path: name, name };
                })];
                App.view.setEntries(entries, { type: 'search', path: null, title: '다음 파일 테스트', query: 'extra' });
                App.view.setSort('name', 'asc');
                App.viewer.open(first.path, { play: false });
            });
            await page.waitForFunction(() => App.viewer.isOpen && App.viewer.current?.path === '000-start.png');
            const result = await page.evaluate(() => {
                const next = App.viewer.upNext(1105);
                const paths = next.map((entry) => typeof entry === 'string' ? entry : entry.path);
                return {
                    files: App.viewer.files.length,
                    count: next.length,
                    unique: new Set(paths).size,
                    zero: App.viewer.upNext(0).length,
                    negative: App.viewer.upNext(-1).length,
                    huge: App.viewer.upNext(Number.MAX_SAFE_INTEGER).length,
                    infinite: App.viewer.upNext(Infinity).length,
                };
            });
            assert.equal(result.files, 1106);
            assert.equal(result.count, 1105);
            assert.equal(result.unique, 1105);
            assert.equal(result.zero, 0);
            assert.equal(result.negative, 0);
            assert.equal(result.huge, 1105);
            assert.equal(result.infinite, 1105);
        },
    },
];
