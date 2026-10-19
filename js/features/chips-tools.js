/*
 * Chip tools.
 *   Legacy import — v1 kept tags in "<file>.txt" sidecars (#가족, and today's chip tokens '분류/칩/하위').
 *     chips.importLegacy: cancellable App.jobs job over every folder of App.index (runs once per workspace on its own),
 *       feeding each folder's entries.sidecars to App.catalog.importLegacySidecars, then reports what it found.
 *     chips.convertLegacy: one click turns catalog.legacyTags into chips (plain tags → category '가져온 태그',
 *       '분류/칩/하위' tokens → that category/chip/sub-chip) — ONE undo entry. Sidecar files are left untouched.
 *   Autofill wizard (chips.autofill) — proposes chips from the folder structure (each subfolder of a chosen parent
 *     becomes a chip for every file under it) and from file names (chip names of 2+ characters found in a file
 *     name, ignoring case, spaces, _ and -). Dry-run preview with counts and checkboxes; applied as ONE undo entry.
 * App.chipsTools: { scanLegacy, convertLegacy, legacyStats, autofill, computeProposals }
 */
(() => {
    'use strict';
    const { h, path: P, uid, formatCount, compareNames, debounce } = App.util;
    const ui = App.ui;
    const icon = (name, size = 13) => ui.icon(name, { size });
    const IMPORTED = '가져온 태그';
    const C = () => App.chipset;

    function exists(p) {
        return !App.index.ready || !!App.index.get(p);
    }

    // ---------- Legacy: scan ----------
    function legacyStats() {
        let tags = 0;
        let files = 0;
        const distinct = new Set();
        for (const [p, e] of App.catalog.entries()) {
            if (!e.legacyTags || !e.legacyTags.length || e.legacyConverted || !exists(p)) continue;
            files++;
            tags += e.legacyTags.length;
            for (const t of e.legacyTags) distinct.add(t);
        }
        return { tags, files, distinct: distinct.size, list: [...distinct] };
    }

    let scanning = null;
    let foundToast = null;

    function scanLegacy({ auto = false } = {}) {
        if (scanning) return scanning;
        const ws = App.state.workspace?.id;
        if (!ws) return Promise.resolve(null);
        scanning = (async () => {
            await App.index.whenReady();
            if (App.state.workspace?.id !== ws) return null;
            // Optional fast path: the index may remember which folders hold v1 sidecars
            const folders = Array.isArray(App.index.sidecarFolders) ? App.index.sidecarFolders : App.index.folders;
            if (auto && !folders.length) return null;
            const job = App.jobs.start({ title: '이전 버전 태그 찾는 중', total: folders.length, cancellable: true });
            let done = 0;
            try {
                for (const dir of folders) {
                    if (job.cancelled || App.state.workspace?.id !== ws) break;
                    try {
                        const entries = await App.fs.list(dir, { stat: false });
                        if (entries.sidecars?.length) await App.catalog.importLegacySidecars(entries.sidecars);
                    } catch (e) {
                        /* unreadable folder — skip */
                    }
                    job.update(++done, { detail: dir || App.state.workspace?.name || '' });
                }
            } finally {
                job.finish();
            }
            if (job.cancelled || App.state.workspace?.id !== ws) return null;
            App.settings.set(`chips.legacyScanned.${ws}`, Date.now());
            const st = legacyStats();
            if (st.tags) {
                foundToast = ui.toast(`이전 버전 태그 ${formatCount(st.tags)}개를 찾았어요`, { type: 'info', duration: 15000, id: 'chips-legacy', action: { label: '칩으로 바꾸기', run: () => convertLegacy() } });
            } else if (!auto) {
                ui.toast('칩으로 바꿀 이전 버전 태그가 없어요', { type: 'success' });
            }
            return st;
        })().finally(() => {
            scanning = null;
        });
        return scanning;
    }

    // ---------- Legacy: convert ----------
    function parseToken(token) {
        const parts = String(token).split('/').map((s) => C().cleanName(s.replace(/_/g, ' '))).filter(Boolean);
        if (!parts.length) return null;
        if (parts.length === 1) return { cat: IMPORTED, chip: parts[0], sub: null };
        return { cat: parts[0], chip: parts[1], sub: parts.length > 2 ? parts.slice(2).join(' ') : null };
    }

    function makeResolver(tx) {
        const cs = C();
        const cache = new Map();
        const created = { cats: new Set(), chips: 0 };
        const catFor = (name) => {
            let cat = tx.preset.categories.find((c) => cs.normKey(c.name) === cs.normKey(name));
            if (!cat) {
                cat = { id: uid('c'), name, mode: 'select', chips: [] };
                tx.preset.categories.push(cat);
                created.cats.add(cat);
            }
            return cat;
        };
        const chipIn = (list, name, top) => {
            let chip = list.find((c) => cs.normKey(c.name) === cs.normKey(name));
            if (!chip) {
                chip = top ? { id: uid('k'), name, children: [] } : { id: uid('k'), name };
                list.push(chip);
                created.chips++;
            }
            return chip;
        };
        const resolve = (token) => {
            if (cache.has(token)) return cache.get(token);
            const t = parseToken(token);
            let ids = [];
            if (t) {
                const cat = catFor(t.cat);
                const chip = chipIn(cat.chips, t.chip, true);
                ids = [chip.id];
                if (t.sub) ids.push(chipIn(chip.children, t.sub, false).id);
            }
            cache.set(token, ids);
            return ids;
        };
        resolve.finish = () => {
            // Big imported lists are easier to use as search-type categories
            for (const cat of created.cats) if (cat.chips.length > 24) cat.mode = 'search';
        };
        resolve.created = created;
        return resolve;
    }

    function previewLegacy(list) {
        const cs = C();
        const groups = new Map();
        for (const token of list) {
            const t = parseToken(token);
            if (!t) continue;
            const g = groups.get(t.cat) || new Set();
            g.add(t.sub ? `${t.chip} › ${t.sub}` : t.chip);
            groups.set(t.cat, g);
        }
        const preset = cs.active();
        const wrap = h('div', { class: 'chip-legacy-preview' });
        for (const [cat, names] of [...groups].sort((a, b) => b[1].size - a[1].size)) {
            const isNew = !preset.categories.some((c) => cs.normKey(c.name) === cs.normKey(cat));
            const row = h('div', { class: 'chip-row' });
            const arr = [...names].sort(compareNames);
            for (const n of arr.slice(0, 18)) row.append(h('span', { class: 'chip is-off static', text: n }));
            if (arr.length > 18) row.append(h('span', { class: 'chip-more', text: `+${arr.length - 18}` }));
            wrap.append(h('div', { class: 'chip-legacy-group' },
                h('div', { class: 'chip-legacy-cat' }, h('b', { text: cat }), isNew ? h('span', { class: 'badge accent', text: '새 분류' }) : h('span', { class: 'badge', text: '기존 분류' }), h('span', { class: 'faint', text: `${formatCount(names.size)}개` })),
                row));
        }
        return wrap;
    }

    async function convertLegacy() {
        const cs = C();
        if (!cs?.ready) return;
        const st = legacyStats();
        if (!st.tags) {
            const scanned = App.settings.get(`chips.legacyScanned.${App.state.workspace?.id}`);
            ui.toast(scanned ? '칩으로 바꿀 이전 버전 태그가 없어요' : '아직 찾은 이전 버전 태그가 없어요', {
                type: 'info',
                action: scanned ? null : { label: '지금 찾기', run: () => scanLegacy() },
            });
            return;
        }
        const ok = await ui.dialog({
            title: '이전 버전 태그를 칩으로 바꾸기',
            width: 560,
            body: h('div', { class: 'chip-dialog' },
                h('p', { text: `파일 ${formatCount(st.files)}개에 붙은 태그 ${formatCount(st.tags)}개(${formatCount(st.distinct)}종류)를 「${cs.active().name}」 프리셋의 칩으로 바꿔요. '분류/칩' 모양은 그 분류에, 나머지는 「${IMPORTED}」에 넣어요.` }),
                previewLegacy(st.list),
                h('p', { class: 'faint', text: `원래 .txt 파일은 그대로 둬요. ${App.commands.displayCombo('Mod+Z')}로 한 번에 되돌릴 수 있어요.` })),
            actions: [
                { label: '취소', value: false, kind: 'ghost' },
                { label: `칩으로 바꾸기`, value: true, kind: 'primary', autofocus: true },
            ],
        });
        if (!ok) return;
        foundToast?.close();
        foundToast = null;
        const { changed } = cs.transaction(`이전 태그 → 칩 (파일 ${formatCount(st.files)}개)`, (tx) => {
            const resolve = makeResolver(tx);
            for (const [p, e] of App.catalog.entries()) {
                if (!e.legacyTags || !e.legacyTags.length || e.legacyConverted || !exists(p)) continue;
                const next = tx.chipsOf(p);
                for (const tok of e.legacyTags) for (const id of resolve(tok)) if (!next.includes(id)) next.push(id);
                tx.patch(p, { chips: next, legacyConverted: true });
            }
            resolve.finish();
        });
        ui.toast(`이전 태그를 칩으로 바꿨어요 — 파일 ${formatCount(changed)}개`, { type: 'success', action: { label: '되돌리기', run: () => App.undo.undo() } });
    }

    // ---------- Autofill ----------
    /**
     * computeProposals({ folders: bool, parent: path, catId: id | '__new__', names: bool, scope: 'parent'|'all' })
     *   -> [{ key, name, existing: { chip, cat, parent } | null, files: Set, folder, byName }]
     */
    function computeProposals(o) {
        const cs = C();
        const preset = cs.active();
        const targetCat = o.catId && o.catId !== '__new__' ? preset.categories.find((c) => c.id === o.catId) : null;
        const byNorm = new Map();
        const remember = (chip, cat, parent) => {
            const k = cs.normKey(chip.name);
            if (k && !byNorm.has(k)) byNorm.set(k, { chip, cat, parent });
        };
        if (targetCat) for (const ch of targetCat.chips) remember(ch, targetCat, null);
        for (const cat of preset.categories) for (const ch of cat.chips) remember(ch, cat, null);
        for (const cat of preset.categories) for (const ch of cat.chips) for (const s of ch.children) remember(s, cat, ch);

        const props = new Map();
        const prop = (k, name, existing) => {
            let pr = props.get(k);
            if (!pr) {
                pr = { key: k, name, existing, files: new Set(), folder: 0, byName: 0 };
                props.set(k, pr);
            }
            return pr;
        };
        const items = App.index.items;

        if (o.folders) {
            const prefix = o.parent ? `${o.parent}/` : '';
            for (const e of items) {
                if (prefix && !e.path.startsWith(prefix)) continue;
                const rest = e.path.slice(prefix.length);
                const slash = rest.indexOf('/');
                if (slash <= 0) continue; // directly inside the parent: no subfolder to name it after
                const sub = cs.cleanName(rest.slice(0, slash));
                const k = cs.normKey(sub);
                if (!k) continue;
                const ex = byNorm.get(k) || null;
                const pr = prop(k, ex ? ex.chip.name : sub, ex);
                if (!pr.files.has(e.path)) {
                    pr.files.add(e.path);
                    pr.folder++;
                }
            }
        }

        if (o.names) {
            const scopePrefix = o.scope === 'parent' && o.parent ? `${o.parent}/` : '';
            const cands = [];
            for (const [k, ex] of byNorm) if ([...k].length >= 2) cands.push({ k, ex });
            for (const [k, pr] of props) if (!pr.existing && [...k].length >= 2) cands.push({ k, name: pr.name });
            if (cands.length) {
                for (const e of items) {
                    if (scopePrefix && !e.path.startsWith(scopePrefix)) continue;
                    const stem = cs.normKey(P.stem(e.name));
                    if (stem.length < 2) continue;
                    for (const c of cands) {
                        if (!stem.includes(c.k)) continue;
                        const pr = prop(c.k, c.ex ? c.ex.chip.name : c.name, c.ex || null);
                        if (!pr.files.has(e.path)) {
                            pr.files.add(e.path);
                            pr.byName++;
                        }
                    }
                }
            }
        }

        // Files that already carry the chip need nothing
        for (const pr of props.values()) {
            if (!pr.existing) continue;
            for (const p of [...pr.files]) if ((App.catalog.peek(p)?.chips || []).includes(pr.existing.chip.id)) pr.files.delete(p);
        }
        return [...props.values()].filter((pr) => pr.files.size).sort((a, b) => b.files.size - a.files.size || compareNames(a.name, b.name));
    }

    function applyProposals(chosen, { catId, newCatName }) {
        const cs = C();
        const newCount = chosen.filter((p) => !p.existing).length;
        return cs.transaction(`칩 자동 채우기 (칩 ${formatCount(chosen.length)}개)`, (tx) => {
            let cat = catId && catId !== '__new__' ? tx.preset.categories.find((c) => c.id === catId) : null;
            const ensureCat = () => {
                if (cat) return cat;
                let name = cs.cleanName(newCatName) || '자동 칩';
                const base = name;
                for (let i = 2; tx.preset.categories.some((c) => cs.normKey(c.name) === cs.normKey(name)); i++) name = `${base} ${i}`;
                cat = { id: uid('c'), name, mode: newCount > 12 ? 'search' : 'select', chips: [] };
                tx.preset.categories.push(cat);
                return cat;
            };
            for (const pr of chosen) {
                let id;
                let parentId = null;
                if (pr.existing) {
                    id = pr.existing.chip.id;
                    parentId = pr.existing.parent?.id || null;
                } else {
                    const c = ensureCat();
                    let chip = c.chips.find((x) => cs.normKey(x.name) === pr.key);
                    if (!chip) {
                        chip = { id: uid('k'), name: pr.name, children: [] };
                        c.chips.push(chip);
                    }
                    id = chip.id;
                }
                for (const p of pr.files) {
                    const next = tx.chipsOf(p);
                    if (parentId && !next.includes(parentId)) next.push(parentId);
                    if (!next.includes(id)) next.push(id);
                    tx.setChips(p, next);
                }
            }
        });
    }

    async function autofill() {
        const cs = C();
        if (!cs?.ready) return;
        if (!App.index.ready) {
            const t = ui.toast('라이브러리를 살펴보는 중이에요…', { type: 'loading' });
            await App.index.whenReady();
            t.close();
        }
        const preset = cs.active();
        const wsName = App.state.workspace?.name || '작업 폴더';
        // Parent folder candidates = folders that have subfolders
        const kids = new Map();
        for (const f of App.index.folders) {
            if (!f) continue;
            const par = P.parent(f);
            kids.set(par, (kids.get(par) || 0) + 1);
        }
        const parents = [...kids.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : compareNames(a, b)));
        // Default parent: the folder with the most subfolders (e.g. 배우/ with 김수현/, 박보영/, …) — searched in the
        // folder you're in and below first, then the whole library. The workspace root (whose subfolders are usually
        // broad buckets) and single-subfolder folders only as a last resort.
        const cwd = App.state.cwd || '';
        const richest = (list) => list.slice().sort((a, b) => kids.get(b) - kids.get(a) || a.length - b.length)[0];
        const several = parents.filter((p) => p !== '' && kids.get(p) >= 2);
        const parent = richest(several.filter((p) => P.isInside(p, cwd))) ?? richest(several) ?? (kids.has(cwd) ? cwd : parents[0] ?? '');

        const o = { folders: parents.length > 0, parent, catId: '__new__', names: true, scope: 'all' };
        const catFor = (par) => {
            const name = par ? P.base(par) : '';
            const same = name && preset.categories.find((c) => cs.normKey(c.name) === cs.normKey(name));
            return same ? same.id : '__new__';
        };
        o.catId = catFor(parent);

        const parentSel = h('select', { class: 'select' }, ...parents.map((p) => h('option', { value: p, text: `${p || wsName} · 하위 폴더 ${formatCount(kids.get(p))}개`, selected: p === parent })));
        const catSel = h('select', { class: 'select' });
        const fillCats = () => {
            catSel.innerHTML = '';
            const newName = o.parent ? P.base(o.parent) : '자동 칩';
            catSel.append(h('option', { value: '__new__', text: `새 분류 「${newName}」 만들기`, selected: o.catId === '__new__' }));
            for (const c of preset.categories) catSel.append(h('option', { value: c.id, text: `${c.name} (${cs.MODE_NAMES[c.mode]} · 칩 ${formatCount(c.chips.length)}개)`, selected: o.catId === c.id }));
        };
        fillCats();
        const scopeSel = h('select', { class: 'select' },
            h('option', { value: 'all', text: '작업 폴더 전체', selected: true }),
            h('option', { value: 'parent', text: '고른 상위 폴더 안에서만' }));
        const folderChk = h('input', { type: 'checkbox', checked: o.folders, disabled: !parents.length });
        const nameChk = h('input', { type: 'checkbox', checked: o.names });
        const list = h('div', { class: 'af-list' });
        const summary = h('span', { class: 'af-summary' });
        const allChk = h('input', { type: 'checkbox', checked: true, 'aria-label': '모두 고르기' });
        let proposals = [];
        let checked = new Set();
        let primary = null;

        const recompute = debounce(() => {
            list.classList.add('busy');
            requestAnimationFrame(() => {
                proposals = computeProposals(o);
                checked = new Set(proposals.map((p) => p.key));
                draw();
                list.classList.remove('busy');
            });
        }, 60);

        function draw() {
            list.innerHTML = '';
            if (!proposals.length) {
                list.append(h('div', { class: 'af-empty' },
                    h('div', { class: 'af-empty-title', text: '제안할 칩이 없어요' }),
                    h('div', { text: o.folders || o.names ? '다른 상위 폴더를 고르거나, 칩 이름이 들어간 파일이 있는지 확인해 보세요.' : '위에서 규칙을 하나 이상 켜 주세요.' })));
            }
            const catName = o.catId === '__new__' ? (o.parent ? P.base(o.parent) : '자동 칩') : preset.categories.find((c) => c.id === o.catId)?.name;
            for (const pr of proposals) {
                const box = h('input', { type: 'checkbox', checked: checked.has(pr.key), dataset: { key: pr.key } });
                const where = pr.existing ? cs.labelOf(pr.existing.chip.id) : `${catName} › ${pr.name}`;
                const src = [pr.folder ? `폴더 ${formatCount(pr.folder)}` : '', pr.byName ? `이름 ${formatCount(pr.byName)}` : ''].filter(Boolean).join(' · ');
                const sample = [...pr.files].slice(0, 6).map((p) => P.base(p)).join(', ') + (pr.files.size > 6 ? ` … 외 ${formatCount(pr.files.size - 6)}개` : '');
                list.append(h('label', { class: `af-row${checked.has(pr.key) ? '' : ' off'}`, 'data-tip': sample },
                    box,
                    h('span', { class: 'af-name truncate', text: where }),
                    pr.existing ? null : h('span', { class: 'badge accent', text: '새 칩' }),
                    h('span', { class: 'grow' }),
                    h('span', { class: 'af-src', text: src }),
                    h('span', { class: 'af-count', text: `${formatCount(pr.files.size)}개` })));
            }
            refreshSummary();
        }

        function refreshSummary() {
            const chosen = proposals.filter((p) => checked.has(p.key));
            const files = new Set();
            for (const p of chosen) for (const f of p.files) files.add(f);
            const fresh = chosen.filter((p) => !p.existing).length;
            summary.textContent = proposals.length ? `칩 ${formatCount(chosen.length)}개${fresh ? ` (새 칩 ${formatCount(fresh)}개)` : ''} → 파일 ${formatCount(files.size)}개` : '';
            allChk.checked = chosen.length === proposals.length && proposals.length > 0;
            allChk.indeterminate = chosen.length > 0 && chosen.length < proposals.length;
            if (primary) {
                primary.disabled = !chosen.length;
                primary.textContent = chosen.length ? `적용 — 파일 ${formatCount(files.size)}개` : '적용';
            }
        }

        list.addEventListener('change', (e) => {
            const k = e.target.dataset?.key;
            if (!k) return;
            if (e.target.checked) checked.add(k);
            else checked.delete(k);
            e.target.closest('.af-row')?.classList.toggle('off', !e.target.checked);
            refreshSummary();
        });
        allChk.addEventListener('change', () => {
            checked = allChk.checked ? new Set(proposals.map((p) => p.key)) : new Set();
            draw();
        });
        parentSel.addEventListener('change', () => {
            o.parent = parentSel.value;
            o.catId = catFor(o.parent);
            fillCats();
            recompute();
        });
        catSel.addEventListener('change', () => {
            o.catId = catSel.value;
            recompute();
        });
        scopeSel.addEventListener('change', () => {
            o.scope = scopeSel.value;
            recompute();
        });
        folderChk.addEventListener('change', () => {
            o.folders = folderChk.checked;
            parentSel.disabled = catSel.disabled = !o.folders;
            recompute();
        });
        nameChk.addEventListener('change', () => {
            o.names = nameChk.checked;
            scopeSel.disabled = !o.names;
            recompute();
        });

        const body = h('div', { class: 'chip-dialog af' },
            h('p', { class: 'af-lead', text: '폴더 구조와 파일 이름을 보고 칩을 제안해요. 미리 보고 고른 것만 붙여요.' }),
            h('div', { class: 'af-rule' },
                h('label', { class: 'chip-check' }, folderChk, h('span', {}, h('b', { text: '하위 폴더 이름을 칩으로' }), h('span', { class: 'faint', text: ' — 예: 배우/김수현/… → 「김수현」' }))),
                h('div', { class: 'af-fields' },
                    h('div', { class: 'field' }, h('label', { text: '상위 폴더' }), parentSel),
                    h('div', { class: 'field' }, h('label', { text: '새 칩을 넣을 분류' }), catSel))),
            h('div', { class: 'af-rule' },
                h('label', { class: 'chip-check' }, nameChk, h('span', {}, h('b', { text: '파일 이름에 칩 이름이 들어 있으면 붙이기' }), h('span', { class: 'faint', text: ' — 2글자 이상, 대소문자·띄어쓰기·_·- 무시' }))),
                h('div', { class: 'af-fields' }, h('div', { class: 'field' }, h('label', { text: '찾을 범위' }), scopeSel))),
            h('div', { class: 'af-preview-head' }, h('label', { class: 'chip-check' }, allChk, h('b', { text: '미리 보기' })), h('span', { class: 'grow' }), summary),
            list);
        if (!parents.length) {
            parentSel.disabled = true;
            catSel.disabled = true;
        }

        const result = await ui.dialog({
            title: '칩 자동 채우기',
            width: 640,
            body,
            actions: [
                { label: '취소', value: null, kind: 'ghost' },
                { label: '적용', value: 'apply', kind: 'primary' },
            ],
            init(box, close, refs) {
                primary = refs?.primaryBtn || null;
                proposals = computeProposals(o);
                checked = new Set(proposals.map((p) => p.key));
                draw();
            },
        });
        if (result !== 'apply') return;
        const chosen = proposals.filter((p) => checked.has(p.key));
        if (!chosen.length) return;
        const res = applyProposals(chosen, { catId: o.catId, newCatName: o.parent ? P.base(o.parent) : '자동 칩' });
        ui.toast(`칩 ${formatCount(chosen.length)}개를 파일 ${formatCount(res.changed)}개에 붙였어요`, { type: 'success', action: { label: '되돌리기', run: () => App.undo.undo() } });
    }

    // ---------- Commands ----------
    const ready = () => App.fs.ready && !!C()?.ready;
    App.commands.register({ id: 'chips.importLegacy', title: '이전 버전 태그 찾기 (라이브러리 전체)', group: '칩', icon: 'download', when: ready, run: () => scanLegacy() });
    App.commands.register({ id: 'chips.convertLegacy', title: '이전 버전 태그를 칩으로 바꾸기', group: '칩', icon: 'tag', when: ready, run: () => convertLegacy() });
    App.commands.register({ id: 'chips.autofill', title: '칩 자동 채우기 (폴더·파일 이름)', group: '칩', icon: 'sparkles', when: ready, run: () => autofill() });

    App.register('chips-tools', {
        init() {
            // First time a workspace is opened in this browser: look for v1 sidecar tags in the background
            App.bus.on('index:ready', () => {
                const ws = App.state.workspace?.id;
                if (!ws || App.settings.get(`chips.legacyScanned.${ws}`)) return;
                scanLegacy({ auto: true });
            });
        },
    });

    App.chipsTools = { scanLegacy, convertLegacy, legacyStats, autofill, computeProposals, applyProposals, parseToken };
})();
