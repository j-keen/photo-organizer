// Shell team: command palette, Hangul-aware matcher, shortcut sheet, settings, startup/welcome, drop-to-open,
// onboarding, responsive layout, per-workspace "where was I", backups.
'use strict';

const SEED = {
    '배우/김수현.png': { image: { label: 'K', color: '#3a6' } },
    '배우/이지은.jpg': { image: { label: 'L', mime: 'image/jpeg', color: '#a36' } },
    '여행/제주/바다.png': { image: { label: 'S', color: '#2ad', w: 900, h: 600 } },
    '여행/제주/한라산.png': { image: { label: 'M', color: '#4a4', w: 320, h: 240 } },
    'trip/2024/sunset.png': { image: { label: 'Sun' } },
    'clips/c-clip.webm': { video: { seconds: 1 } },
    'a-photo.png': { image: { label: 'A' } },
};

async function openPalette(page) {
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.dialog.pal .pal-input');
}

async function palTitles(page) {
    return page.$$eval('.pal-item .pal-title', (els) => els.map((e) => e.textContent));
}

/**
 * Reload like a browser restart: flush pending catalog writes first (a reload mid-write would leave a torn JSON),
 * then point the fake picker / __opfs helpers back at the same seeded folder (harness __useExistingWorkspace).
 */
async function restart(page) {
    await page.evaluate(() => (App.fs.ready && App.catalog?.flush ? App.catalog.flush() : null));
    await page.reload();
    await page.waitForFunction(() => window.App && typeof window.__useExistingWorkspace === 'function');
    await page.evaluate(() => window.__useExistingWorkspace());
}

async function closeDialogs(page) {
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.dialog-backdrop'));
}

module.exports = [
    {
        name: 'palette: Ctrl+K finds commands fuzzily, Enter runs them, disabled ones stay hidden',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await openPalette(page);
            assert.equal(await page.evaluate(() => App.layers.top()), 'dialog', 'palette owns the keyboard while open');
            await page.keyboard.type('실행 취소');
            await page.waitForTimeout(50);
            assert.ok(!(await palTitles(page)).includes('실행 취소'), 'undo is disabled with nothing to undo, so it is hidden');
            await page.fill('.pal-input', '테마');
            await page.waitForFunction(() => document.querySelector('.pal-item.active .pal-title')?.textContent === '테마 바꾸기');
            const before = await page.evaluate(() => document.documentElement.dataset.theme);
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => !App.palette.isOpen);
            await page.waitForFunction((b) => document.documentElement.dataset.theme !== b, before);
            // the pick is remembered and comes first next time
            await openPalette(page);
            const firstSection = await page.$eval('.pal-section', (e) => e.textContent);
            assert.equal(firstSection, '최근');
            assert.equal(await page.$eval('.pal-item .pal-title', (e) => e.textContent), '테마 바꾸기');
            // Mod+K toggles it closed again
            await page.keyboard.press('Control+k');
            await page.waitForFunction(() => !App.palette.isOpen);
            // after an undoable action, undo shows up
            await page.evaluate(() => App.fs.mkdir('', 'new-folder'));
            await openPalette(page);
            // the undo row comes first and says what it will undo
            await page.waitForFunction(() => /^실행 취소: /.test(document.querySelector('.pal-item .pal-title')?.textContent || ''));
            assert.match(await page.$eval('.pal-item .pal-title', (e) => e.textContent), /new-folder/);
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => !App.palette.isOpen && !App.undo.canUndo() && App.undo.canRedo());
            await openPalette(page);
            await page.waitForFunction(() => /^다시 실행: /.test(document.querySelector('.pal-item .pal-title')?.textContent || ''));
            await closeDialogs(page);
        },
    },
    {
        name: 'palette: "/" scopes to folders, Enter navigates, Tab cycles scopes, Backspace leaves the scope',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await page.waitForFunction(() => App.index.ready);
            await openPalette(page);
            await page.keyboard.type('/');
            assert.equal(await page.$eval('.pal-tab.on', (e) => e.dataset.scope), 'folders');
            assert.equal(await page.inputValue('.pal-input'), '', 'the prefix becomes the scope, not text');
            await page.keyboard.type('제주');
            await page.waitForFunction(() => document.querySelector('.pal-item.active .pal-title')?.textContent === '제주');
            assert.match(await page.$eval('.pal-item.active .pal-sub', (e) => e.textContent), /여행/);
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => App.state.cwd === '여행/제주' && App.view.source.type === 'folder');
            await openPalette(page);
            await page.keyboard.press('Tab');
            assert.equal(await page.$eval('.pal-tab.on', (e) => e.dataset.scope), 'commands');
            await page.keyboard.press('Shift+Tab');
            assert.equal(await page.$eval('.pal-tab.on', (e) => e.dataset.scope), 'all');
            await page.keyboard.press('Tab');
            await page.keyboard.press('Backspace');
            assert.equal(await page.$eval('.pal-tab.on', (e) => e.dataset.scope), 'all');
            await closeDialogs(page);
        },
    },
    {
        name: 'palette: files by Hangul initials or wrong keyboard mode — Enter opens, Shift+Enter only reveals',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await page.waitForFunction(() => App.index.ready);
            await openPalette(page);
            await page.keyboard.type('ㄱㅅㅎ');
            await page.waitForFunction(() => [...document.querySelectorAll('.pal-item .pal-title')].some((e) => e.textContent === '김수현.png'));
            // titles carry <mark> highlights, so match the row by its title text rather than an exact-text selector
            await page.locator('.pal-item', { has: page.locator('.pal-title', { hasText: /^김수현\.png$/ }) }).first().click({ modifiers: ['Shift'] });
            await page.waitForFunction(() => App.state.cwd === '배우' && App.select.list().join() === '배우/김수현.png');
            assert.ok(await page.isHidden('#viewer'), 'Shift+Enter/click reveals without opening the viewer');

            await page.evaluate(() => App.nav.go(''));
            await page.waitForFunction(() => App.state.cwd === '');
            await openPalette(page);
            await page.keyboard.type('rlatngus'); // 김수현 typed with the keyboard in English mode
            await page.waitForSelector('.pal-hint-row');
            assert.match(await page.textContent('.pal-hint-row'), /김수현/);
            // move to the file row and open it
            const idx = await page.evaluate(() => App.palette.search('rlatngus').flatMap((s) => s.items).findIndex((it) => it.title === '김수현.png'));
            assert.ok(idx >= 0);
            for (let i = 0; i < 6 && (await page.$eval('.pal-item.active .pal-title', (e) => e.textContent)) !== '김수현.png'; i++) await page.keyboard.press('ArrowDown');
            await page.keyboard.press('Enter');
            await page.waitForSelector('#viewer:not([hidden])');
            assert.equal(await page.textContent('.vw-title'), '김수현.png');
            await page.keyboard.press('Escape');
            await page.waitForSelector('#viewer', { state: 'hidden' });
            assert.deepEqual(await page.evaluate(() => App.select.list()), ['배우/김수현.png']);
        },
    },
    {
        name: 'matcher: initials, composing syllables, 한/영 mistakes, ranges and ranking',
        async run({ openApp, assert }) {
            const { page } = await openApp({ open: false });
            const r = await page.evaluate(() => {
                const m = App.palette.match;
                const s = (q, t) => m(q, t)?.score ?? null;
                return {
                    initials: m('ㄱㅅㅎ', '김수현'),
                    initialsMiss: m('ㄱㅅㅎ', '이지은'),
                    composing: !!m('기', '김수현'),
                    composingFinal: !!m('숳', '김수현') && !!m('김숳', '김수현'),
                    compoundFinal: !!m('닭', '달걀'),
                    mixed: !!m('김ㅅ현', '배우 김수현 화보'),
                    wrongMode: m('rlatngus', '김수현'),
                    wrongModeEn: !!m('ㅅ갸ㅔ', 'trip'),
                    noise: m('rtg', '김수현'),
                    empty: m('', 'abc'),
                    miss: m('xyz', 'abc'),
                    tokens: !!m('2024 trip', 'trip/2024/sunset.png'),
                    prefixWins: s('sun', 'sunset.png') > s('sun', 'a-sun-x.png'),
                    boundaryWins: s('bp', 'beach-photo.png') > s('bp', 'abcbpx.png'),
                    exactWins: s('trip', 'trip') > s('trip', 'trips'),
                    nfd: !!m('김', '김수현'.normalize('NFD')),
                    l2h: App.palette.hangul.latinToHangul('dkssudgktpdy'),
                    h2l: App.palette.hangul.hangulToLatin('ㅅ갸ㅔ'),
                };
            });
            assert.ok(r.initials && r.initials.score > 0);
            assert.deepEqual(r.initials.ranges, [[0, 3]]);
            assert.equal(r.initialsMiss, null);
            assert.ok(r.composing, '기 (still composing) matches 김');
            assert.ok(r.composingFinal, '숳 is read as 수 + ㅎ');
            assert.ok(r.compoundFinal, '닭 is read as 달 + ㄱ');
            assert.ok(r.mixed);
            assert.ok(r.wrongMode && r.wrongMode.converted, 'rlatngus → 김수현');
            assert.ok(r.wrongModeEn, 'ㅅ갸ㅔ → trip');
            assert.equal(r.noise, null, 'converted queries must match as one piece');
            assert.deepEqual(r.empty, { score: 0, ranges: [] });
            assert.equal(r.miss, null);
            assert.ok(r.tokens, 'space-separated words match in any order');
            assert.ok(r.prefixWins && r.boundaryWins && r.exactWins);
            assert.ok(r.nfd, 'macOS-style decomposed names still match');
            assert.equal(r.l2h, '안녕하세요');
            assert.equal(r.h2l, 'trip');
        },
    },
    {
        name: 'palette stays fast on a 50,000-file library',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: { 'a.png': { image: {} } } });
            await page.waitForFunction(() => App.index.ready);
            const ms = await page.evaluate(() => {
                const fake = [];
                for (let i = 0; i < 50000; i++) {
                    const dir = `폴더${i % 200}/하위${i % 7}`;
                    const name = i % 3 ? `IMG_${String(i).padStart(5, '0')}.jpg` : `여행 사진 ${i}.png`;
                    fake.push({ path: `${dir}/${name}`, name, kind: 'file', type: 'image', ext: name.split('.').pop(), size: 1000, mtime: i });
                }
                Object.defineProperty(App.index, 'items', { get: () => fake, configurable: true });
                const times = [];
                for (const q of ['IMG_4', 'ㅇㅎ', '여행 3', 'dyrgod', 'zzzz']) {
                    const t0 = performance.now();
                    App.palette.search(q);
                    times.push(performance.now() - t0);
                }
                return times;
            });
            const worst = Math.max(...ms);
            assert.ok(worst < 400, `slowest palette search took ${worst.toFixed(0)}ms (${ms.map((x) => x.toFixed(0)).join(', ')})`);
        },
    },
    {
        name: 'shortcut sheet: ? opens it grouped from App.commands, search filters by name or keys',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await page.keyboard.press('Shift+?');
            await page.waitForSelector('.kb-dialog .kb-group');
            const groups = await page.$$eval('.kb-group-title', (els) => els.map((e) => e.textContent));
            assert.ok(groups.includes('일반') && groups.includes('파일') && groups.includes('마우스'), groups.join());
            assert.ok((await page.$$('.kb-row')).length > 20);
            await page.keyboard.type('ctrl+z');
            await page.waitForFunction(() => [...document.querySelectorAll('.kb-row .kb-title')].some((e) => e.textContent === '실행 취소'));
            await page.fill('.kb-search input', '없는단축키');
            await page.waitForSelector('.kb-empty');
            await page.fill('.kb-search input', '');
            await page.keyboard.press('Shift+?'); // ? again closes the sheet
            await page.waitForFunction(() => !document.querySelector('.kb-dialog'));
            await page.keyboard.press('F1');
            await page.waitForSelector('.kb-dialog');
            await closeDialogs(page);
        },
    },
    {
        name: 'settings: Ctrl+, opens, switches pages by keyboard, toggles persist, theme applies',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            let cleared = 0;
            await page.exposeFunction('__countClear', () => cleared++);
            await page.evaluate(() => {
                App.thumbs.clearCache = async () => window.__countClear();
            });
            await page.keyboard.press('Control+,');
            await page.waitForSelector('.shs-dialog .shs-tab.on');
            assert.equal(await page.$eval('.shs-tab.on', (e) => e.dataset.page), 'general');
            await page.click('.shs-seg button[data-value="light"]');
            assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
            assert.equal(await page.evaluate(() => App.settings.get('theme')), 'light');
            const trashSwitch = page.locator('.shs-row:has-text("휴지통으로 옮기기 전에 확인") .shs-switch');
            assert.equal(await trashSwitch.getAttribute('aria-checked'), 'false');
            await trashSwitch.click();
            assert.equal(await page.evaluate(() => App.settings.get('trash.confirm')), true);
            assert.equal(await trashSwitch.getAttribute('aria-checked'), 'true');
            // keyboard: arrows move between pages
            await page.focus('.shs-tab.on');
            await page.keyboard.press('ArrowDown');
            assert.equal(await page.$eval('.shs-tab.on', (e) => e.dataset.page), 'thumbs');
            await page.click('.shs-row:has-text("썸네일 캐시 비우기") button');
            await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('썸네일 캐시를 비웠어요'));
            assert.equal(cleared, 1);
            await page.selectOption('.shs-row:has-text("캐시 최대 크기") select', '2048');
            assert.equal(await page.evaluate(() => App.settings.get('thumbs.cacheLimitMB')), 2048);
            for (const id of ['trash', 'data', 'server', 'shortcuts', 'about']) {
                await page.click(`.shs-tab[data-page="${id}"]`);
                await page.waitForFunction((p) => document.querySelector('.shs-tab.on')?.dataset.page === p && document.querySelector('.shs-page-body').children.length > 0, id);
            }
            await page.click('.shs-tab[data-page="trash"]');
            await page.selectOption('select[aria-label="보관 기간"]', '0');
            assert.equal(await page.evaluate(() => App.settings.get('trash.retentionDays')), 0);
            // "Windows 설정" follows the OS theme and a manual toggle switches it off again
            await page.click('.shs-tab[data-page="general"]');
            await page.click('.shs-seg button[data-value="system"]');
            assert.equal(await page.evaluate(() => App.settings.get('theme.followSystem')), true);
            await page.keyboard.press('Control+,'); // toggles closed
            await page.waitForFunction(() => !document.querySelector('.shs-dialog'));
            await page.evaluate(() => App.commands.run('view.toggleTheme'));
            await page.waitForFunction(() => App.settings.get('theme.followSystem') === false);
        },
    },
    {
        name: 'startup reopens the last workspace and lands where you left off (folder, sort, filter, selection)',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await page.evaluate(() => App.nav.go('여행/제주'));
            await page.waitForFunction(() => App.state.cwd === '여행/제주' && App.view.visible.length === 2);
            await page.evaluate(() => {
                App.view.setSort('size', 'desc');
                App.topbar.setTypeFilter('image');
                App.select.set(['여행/제주/바다.png'], { focus: '여행/제주/바다.png' });
                App.workspace.saveViewState();
                // global preferences differ, so only the per-workspace memory can explain what we see after reload
                App.settings.set('view.sort', { key: 'name', dir: 'asc' });
                App.settings.set('view.type', 'all');
            });
            await restart(page);
            await page.waitForFunction(() => App.fs.ready && App.state.cwd === '여행/제주' && App.view.source.type === 'folder', null, { timeout: 15000 });
            await page.waitForFunction(() => App.select.list().join() === '여행/제주/바다.png');
            assert.ok(await page.isHidden('#welcome'));
            assert.deepEqual(await page.evaluate(() => App.view.sort), { key: 'size', dir: 'desc' });
            assert.equal(await page.evaluate(() => App.view.filters.get('type')?.id), 'image');
            assert.equal(await page.evaluate(() => App.select.focus), '여행/제주/바다.png');
            assert.equal(await page.evaluate(() => document.title), '제주 — ws — Fluid Identity');
            // turning auto-reopen off shows a one-click resume card instead
            await page.evaluate(() => App.settings.set('workspace.autoReopen', false));
            await restart(page);
            await page.waitForSelector('#welcome:not([hidden]) .wl-resume');
            assert.ok(!(await page.evaluate(() => App.fs.ready)));
            await page.click('.wl-resume-btn');
            await page.waitForFunction(() => App.fs.ready && App.state.cwd === '여행/제주');
        },
    },
    {
        name: 'welcome: "다시 열기" asks for permission in one click, recents can be removed and restored',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await page.evaluate(() => App.workspace.close());
            await page.waitForSelector('#welcome:not([hidden]) .wl-recent');
            assert.equal(await page.textContent('.wl-recent-name'), 'ws');
            // Next launch: the browser forgot the permission (the usual case after restarting Chrome)
            await page.addInitScript(() => {
                window.__permAsked = 0;
                FileSystemHandle.prototype.queryPermission = async () => 'prompt';
                FileSystemHandle.prototype.requestPermission = async () => {
                    window.__permAsked++;
                    return 'granted';
                };
            });
            await restart(page);
            await page.waitForSelector('#welcome:not([hidden]) .wl-resume');
            assert.match(await page.textContent('.wl-resume'), /ws/);
            assert.match(await page.textContent('.wl-resume'), /방문할 때마다 허용/);
            assert.equal(await page.evaluate(() => App.fs.ready), false, 'no silent reopen without permission');
            assert.ok(await page.evaluate(() => App.commands.isEnabled('workspace.reopen')));
            await page.click('.wl-resume-btn');
            await page.waitForFunction(() => App.fs.ready && App.state.cwd === '');
            assert.equal(await page.evaluate(() => window.__permAsked), 1);

            // remove from recents (x) with undo
            await page.evaluate(() => App.workspace.close());
            await page.waitForSelector('.wl-recent');
            await page.hover('.wl-recent');
            await page.click('.wl-recent-remove');
            await page.waitForFunction(() => !document.querySelector('.wl-recent'));
            assert.equal((await page.evaluate(() => App.workspace.getRecents())).length, 0);
            await page.click('.toast .toast-action');
            await page.waitForSelector('.wl-recent');
            assert.equal((await page.evaluate(() => App.workspace.getRecents())).length, 1);
        },
    },
    {
        name: 'dropping a folder from Explorer onto the welcome screen opens it; stray drops never navigate away',
        async run({ openApp, assert }) {
            const { page } = await openApp({ open: false });
            await page.waitForSelector('#welcome:not([hidden]) .welcome-card');
            await page.evaluate((s) => window.__seedWorkspace(s), SEED);
            const over = await page.evaluate(() => {
                const ev = new Event('dragover', { bubbles: true, cancelable: true });
                Object.defineProperty(ev, 'dataTransfer', { value: { types: ['Files'], dropEffect: 'none' } });
                document.querySelector('.welcome-card').dispatchEvent(ev);
                return { prevented: ev.defaultPrevented, dragging: document.getElementById('welcome').classList.contains('wl-dragging') };
            });
            assert.deepEqual(over, { prevented: true, dragging: true });
            // a plain file is not a workspace: friendly hint, nothing opens
            await page.evaluate(() => {
                const ev = new Event('drop', { bubbles: true, cancelable: true });
                const file = { kind: 'file', getAsFileSystemHandle: async () => ({ kind: 'file', name: 'x.jpg' }) };
                Object.defineProperty(ev, 'dataTransfer', { value: { types: ['Files'], items: [file], files: [] } });
                document.getElementById('welcome').dispatchEvent(ev);
            });
            await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('폴더를 끌어다 놓아 주세요'));
            assert.equal(await page.evaluate(() => App.fs.ready), false);
            // the folder itself opens as the workspace
            await page.evaluate(() => {
                const ev = new Event('drop', { bubbles: true, cancelable: true });
                const dir = { kind: 'file', getAsFileSystemHandle: async () => window.__fakeRoot };
                Object.defineProperty(ev, 'dataTransfer', { value: { types: ['Files'], items: [dir], files: [] } });
                document.getElementById('welcome').dispatchEvent(ev);
            });
            await page.waitForFunction(() => App.fs.ready && App.state.cwd === '' && App.view.source.type === 'folder');
            assert.ok(await page.isHidden('#welcome'));
            assert.equal((await page.evaluate(() => App.workspace.getRecents()))[0].name, 'ws');
            // with a workspace open, a link dropped outside the gallery is swallowed
            const link = await page.evaluate(() => {
                const ev = new Event('dragover', { bubbles: true, cancelable: true });
                Object.defineProperty(ev, 'dataTransfer', { value: { types: ['text/uri-list'], dropEffect: 'copy' } });
                document.getElementById('sidebar').dispatchEvent(ev);
                return ev.defaultPrevented;
            });
            assert.ok(link);
        },
    },
    {
        name: 'onboarding: stays out of the way under automation, walks its steps when started, remembers done',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await page.waitForTimeout(1500);
            assert.equal(await page.$('.ob-card'), null, 'no auto tour while automated');
            assert.ok(await page.evaluate(() => App.onboarding.start({ force: true })));
            await page.waitForSelector('.ob-card');
            assert.equal(await page.evaluate(() => App.onboarding.step), 'tree');
            const seen = [];
            for (let i = 0; i < 6 && (await page.evaluate(() => App.onboarding.active)); i++) {
                seen.push(await page.evaluate(() => App.onboarding.step));
                await page.click('.ob-next');
            }
            assert.deepEqual(seen, ['tree', 'chips', 'palette', 'gallery']);
            assert.equal(await page.$('.ob-card'), null);
            assert.equal(await page.evaluate(() => App.settings.get('onboarding.done')), true);
            // Esc ends it early; the gallery still works while it shows (clicks pass through)
            await page.evaluate(() => App.onboarding.start({ force: true }));
            await page.waitForSelector('.ob-spot');
            // Click a card the tour card itself doesn't cover (its position depends on the tree's height)
            const target = await page.evaluate(() => {
                const ob = document.querySelector('.ob-card').getBoundingClientRect();
                const free = [...document.querySelectorAll('.card')].find((c) => {
                    const r = c.getBoundingClientRect();
                    return r.right < ob.left || r.left > ob.right || r.bottom < ob.top || r.top > ob.bottom;
                });
                return free?.dataset.path;
            });
            assert.ok(target, 'some card is outside the tour card');
            await page.click(`.card[data-path="${target}"]`);
            assert.deepEqual(await page.evaluate(() => App.select.list()), [target]);
            await page.keyboard.press('Escape');
            await page.waitForFunction(() => !document.querySelector('.ob-card'));
        },
    },
    {
        name: 'responsive: panels fold on narrow windows, open as overlays, and remember explicit choices',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            const state = () =>
                page.evaluate(() => ({
                    sidebar: App.layout.isVisible('sidebar'),
                    inspector: App.layout.isVisible('inspector'),
                    overlay: ['sidebar', 'inspector'].filter((n) => document.querySelector('.app').classList.contains(`${n}-overlay`)),
                    content: Math.round(document.getElementById('content').getBoundingClientRect().width),
                }));
            let s = await state();
            assert.ok(s.sidebar && s.inspector);
            // hiding the sidebar at full width gives the gallery the space (grid placement regression)
            await page.keyboard.press('Control+b');
            s = await state();
            assert.ok(!s.sidebar && s.content > 1000, JSON.stringify(s));
            await page.keyboard.press('Control+b');

            await page.setViewportSize({ width: 1000, height: 800 });
            await page.waitForFunction(() => !App.layout.isVisible('inspector'));
            s = await state();
            assert.ok(s.sidebar && !s.inspector && s.content > 500, JSON.stringify(s));
            await page.keyboard.press('Control+i'); // explicit choice in the compact range: docked, remembered
            s = await state();
            assert.ok(s.inspector && s.overlay.length === 0);
            assert.equal(await page.evaluate(() => App.settings.get('layout.inspector.compact')), true);
            await page.setViewportSize({ width: 1440, height: 900 });
            await page.waitForFunction(() => document.querySelector('.app').dataset.layout === 'wide');
            await page.setViewportSize({ width: 1000, height: 800 });
            await page.waitForFunction(() => document.querySelector('.app').dataset.layout === 'compact');
            assert.ok((await state()).inspector, 'compact-range choice is remembered');

            await page.setViewportSize({ width: 760, height: 800 });
            await page.waitForFunction(() => document.querySelector('.app').dataset.layout === 'narrow');
            s = await state();
            assert.ok(!s.sidebar && !s.inspector && s.content > 700, JSON.stringify(s));
            await page.keyboard.press('Control+b');
            s = await state();
            assert.deepEqual(s.overlay, ['sidebar']);
            assert.ok(await page.isVisible('.lay-scrim'));
            await page.click('.tree-row[data-path="trip"] .tree-name');
            await page.waitForFunction(() => App.state.cwd === 'trip' && !document.querySelector('.app').classList.contains('sidebar-overlay'));
            await page.keyboard.press('Control+i');
            assert.deepEqual((await state()).overlay, ['inspector']);
            await page.keyboard.press('Escape');
            assert.deepEqual((await state()).overlay, []);
            // focus mode hides everything and brings it back
            await page.setViewportSize({ width: 1440, height: 900 });
            await page.waitForFunction(() => document.querySelector('.app').dataset.layout === 'wide');
            await page.keyboard.press('Control+.');
            s = await state();
            assert.ok(!s.sidebar && !s.inspector);
            await page.keyboard.press('Control+.');
            s = await state();
            assert.ok(s.sidebar && s.inspector);
        },
    },
    {
        name: 'backups: snapshot now, list snapshots, copy to a secondary location on another "drive"',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await page.evaluate(() => App.catalog.update('a-photo.png', { rating: 4, memo: '백업 확인' }));
            const snap = await page.evaluate(() => App.backup.snapshot());
            assert.match(snap.id, /^snap-\d{8}-\d{6}$/);
            assert.ok(snap.files >= 2);
            const saved = JSON.parse(await page.evaluate((id) => window.__opfs.read(`.fluid-organizer/backups/${id}/catalog.json`), snap.id));
            assert.equal(saved.items['a-photo.png'].memo, '백업 확인');
            const list = await page.evaluate(() => App.backup.list());
            assert.equal(list[0].kind, 'manual');
            assert.ok(list[0].files.some((f) => f.name === 'catalog.json'));

            // refuse a "secondary" location inside the workspace
            await page.evaluate(() => {
                window.showDirectoryPicker = async () => window.__fakeRoot;
                App.backup.secondary.pick().then((r) => (window.__pick = r));
            });
            await page.waitForSelector('.dialog-title:text("다른 곳을 골라 주세요")');
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => window.__pick === false);

            // a folder elsewhere receives the JSON files
            await page.evaluate(async () => {
                const bk = await (await navigator.storage.getDirectory()).getDirectoryHandle('backup-drive', { create: true });
                window.__bk = bk;
                window.showDirectoryPicker = async () => bk;
            });
            assert.equal(await page.evaluate(() => App.backup.secondary.pick()), true);
            const folder = await page.evaluate(() => `ws (${App.state.workspace.id.slice(-6)})`);
            const copied = await page.evaluate(async (f) => {
                const dir = await (await window.__bk.getDirectoryHandle(f)).getDirectoryHandle('latest');
                const names = [];
                for await (const [n] of dir.entries()) names.push(n);
                const cat = JSON.parse(await (await (await dir.getFileHandle('catalog.json')).getFile()).text());
                return { names: names.sort(), memo: cat.items['a-photo.png'].memo };
            }, folder);
            assert.ok(copied.names.includes('catalog.json') && copied.names.includes('workspace.json'), copied.names.join());
            assert.equal(copied.memo, '백업 확인');
            assert.equal(await page.evaluate(() => App.backup.secondary.status().text), '보조 백업 · backup-drive · 방금 전');
            await page.waitForSelector('[data-sb-id="backup"]:not([hidden])');
            assert.match(await page.textContent('[data-sb-id="backup"]'), /보조 백업 · backup-drive · 방금 전/);
            // the settings page shows both lists
            await page.evaluate(() => App.settingsUI.open('data'));
            await page.waitForSelector('.bk-row');
            assert.match(await page.textContent('.bk-sec-status'), /보조 백업 · backup-drive/);
            await closeDialogs(page);
        },
    },
    {
        name: 'undo history: Ctrl+Alt+Z lists recent actions with times, click undoes back to there, redo list brings them back',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            await page.evaluate(async () => {
                await App.fs.mkdir('', 'h-one');
                await App.fs.mkdir('', 'h-two');
                await App.catalog.update('a-photo.png', { rating: 4 }, { label: '별점 4' });
                await App.fs.mkdir('', 'h-three');
            });
            // the status bar says what Ctrl+Z will undo next
            await page.waitForFunction(() => /h-three/.test(document.querySelector('.sb-undo')?.textContent || ''));
            await page.keyboard.press('Control+Alt+z');
            await page.waitForSelector('.hist-dialog .hist-row');
            const rows = await page.$$eval('.hist-row.undo', (els) => els.map((e) => [e.querySelector('.hist-label').textContent, e.querySelector('.hist-time').textContent]));
            assert.equal(rows.length, 4);
            assert.match(rows[0][0], /h-three/);
            assert.match(rows[1][0], /별점/);
            assert.equal(rows[0][1], '방금 전');
            // click the 3rd newest: undoes h-three, the rating and h-two in one go
            await page.click('.hist-row.undo[data-index="2"]');
            await page.waitForFunction(() => App.undo.list().length === 1 && App.undo.list({ redo: true }).length === 3);
            assert.equal(await page.evaluate(() => __opfs.exists('h-two')), false);
            assert.equal(await page.evaluate(() => __opfs.exists('h-one')), true);
            assert.equal(await page.evaluate(() => App.catalog.get('a-photo.png').rating), 0);
            await page.waitForFunction(() => document.querySelectorAll('.hist-row.redo').length === 3 && !document.querySelector('.hist-list.busy'));
            // redo the next two (h-two, rating) from the redo list
            await page.click('.hist-row.redo[data-index="1"]');
            await page.waitForFunction(() => App.undo.list().length === 3 && App.undo.list({ redo: true }).length === 1);
            assert.equal(await page.evaluate(() => App.catalog.get('a-photo.png').rating), 4);
            // Ctrl+Z inside the dialog undoes the newest step
            await page.waitForFunction(() => !document.querySelector('.hist-list.busy'));
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => App.undo.list().length === 2);
            await page.keyboard.press('Escape');
            await page.waitForFunction(() => !document.querySelector('.hist-dialog'));
            // also reachable from the palette
            await openPalette(page);
            await page.keyboard.type('실행 취소 기록');
            await page.waitForFunction(() => document.querySelector('.pal-item.active .pal-title')?.textContent === '실행 취소 기록');
            await page.keyboard.press('Enter');
            await page.waitForSelector('.hist-dialog .hist-row');
            await page.keyboard.press('Escape');
            await page.waitForFunction(() => !document.querySelector('.hist-dialog'));
            // Ctrl+Z keeps working while the palette (empty box) or settings are open
            await openPalette(page);
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => App.undo.list().length === 1);
            await closeDialogs(page);
            await page.keyboard.press('Control+,');
            await page.waitForSelector('.shs-dialog .shs-tab.on');
            await page.keyboard.press('Control+z');
            await page.waitForFunction(() => App.undo.list().length === 0);
            await closeDialogs(page);
        },
    },
    {
        name: 'shell shortcuts never collide with other commands in the same scope',
        async run({ openApp, assert }) {
            const { page } = await openApp({ seed: SEED });
            const clashes = await page.evaluate(() => {
                const mine = ['palette.open', 'settings.open', 'help.shortcuts', 'edit.history', 'view.zen', 'view.toggleSidebar', 'view.toggleInspector', 'workspace.open'];
                const out = [];
                const all = App.commands.list();
                for (const id of mine) {
                    const c = App.commands.get(id);
                    for (const k of c.keys) {
                        for (const o of all) {
                            if (o.id === id || !o.keys.includes(k)) continue;
                            const overlap = c.scope === 'global' || o.scope === 'global' || c.scope === o.scope;
                            if (overlap) out.push(`${id} ↔ ${o.id} (${k})`);
                        }
                    }
                }
                return out;
            });
            assert.deepEqual(clashes, []);
        },
    },
];
