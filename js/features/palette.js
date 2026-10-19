/*
 * Command palette (Ctrl+K): one box to run commands, jump to folders and find files — plus the shared,
 * Hangul-aware fuzzy matcher every module can use.
 *
 *   App.palette.open({ scope, query })   scope: 'all' | 'commands' | 'folders' | 'files' | <provider id>
 *   App.palette.close() · toggle() · isOpen
 *   App.palette.match(query, text) -> { score, ranges: [[start, end], ...] } | null
 *       Fuzzy subsequence match that understands Korean: initials ('ㄱㅅㅎ' → 김수현), the syllable the IME is
 *       still composing ('기' → 김…, '숳' → 수현), and text typed in the wrong keyboard mode
 *       ('rlatngus' → 김수현, 'ㅅ갸ㅔ' → trip). Higher score = better. ranges index the NFC-normalized text.
 *   App.palette.addProvider({ id, label, icon, prefix, order, limit, items(ctx) | search(pq, ctx, limit), empty(ctx, scoped), resolve(key) })
 *       Adds a result section (e.g. chips with prefix '#'). An item is
 *       { key, title, subtitle, icon | iconHtml, entry, keys: [combo], badge, keywords: [], run({ alt }) }.
 *   App.palette.record(key) — count a pick so recent/frequent items rank first (frecency).
 */
(() => {
    'use strict';
    const { h, path: P, formatCount } = App.util;
    const ui = App.ui;

    // =====================================================================================================
    // Hangul helpers
    // =====================================================================================================
    const SBASE = 0xac00;
    const SLAST = 0xd7a3;
    const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
    const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
    const JONG = '\0ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ'; // index 0 = no final
    const CHO_CODES = new Set(Array.from(CHO, (c) => c.charCodeAt(0)));
    const JONG_PAIRS = { 'ㄳ': 'ㄱㅅ', 'ㄵ': 'ㄴㅈ', 'ㄶ': 'ㄴㅎ', 'ㄺ': 'ㄹㄱ', 'ㄻ': 'ㄹㅁ', 'ㄼ': 'ㄹㅂ', 'ㄽ': 'ㄹㅅ', 'ㄾ': 'ㄹㅌ', 'ㄿ': 'ㄹㅍ', 'ㅀ': 'ㄹㅎ', 'ㅄ': 'ㅂㅅ' };
    const JUNG_PAIRS = { 'ㅘ': 'ㅗㅏ', 'ㅙ': 'ㅗㅐ', 'ㅚ': 'ㅗㅣ', 'ㅝ': 'ㅜㅓ', 'ㅞ': 'ㅜㅔ', 'ㅟ': 'ㅜㅣ', 'ㅢ': 'ㅡㅣ' };
    const invert = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [v, k]));
    const JONG_JOIN = invert(JONG_PAIRS);
    const JUNG_JOIN = invert(JUNG_PAIRS);
    // Standard 2-beolsik (두벌식) keyboard layout
    const KEY_TO_JAMO = {
        q: 'ㅂ', w: 'ㅈ', e: 'ㄷ', r: 'ㄱ', t: 'ㅅ', y: 'ㅛ', u: 'ㅕ', i: 'ㅑ', o: 'ㅐ', p: 'ㅔ',
        a: 'ㅁ', s: 'ㄴ', d: 'ㅇ', f: 'ㄹ', g: 'ㅎ', h: 'ㅗ', j: 'ㅓ', k: 'ㅏ', l: 'ㅣ',
        z: 'ㅋ', x: 'ㅌ', c: 'ㅊ', v: 'ㅍ', b: 'ㅠ', n: 'ㅜ', m: 'ㅡ',
        Q: 'ㅃ', W: 'ㅉ', E: 'ㄸ', R: 'ㄲ', T: 'ㅆ', O: 'ㅒ', P: 'ㅖ',
    };
    const JAMO_TO_KEY = {};
    for (const [k, j] of Object.entries(KEY_TO_JAMO)) if (!JAMO_TO_KEY[j]) JAMO_TO_KEY[j] = k.toLowerCase();

    const isSyllable = (c) => c >= SBASE && c <= SLAST;

    /** 'rlatngus' → '김수현' (text typed while the keyboard was in English mode) */
    function latinToHangul(s) {
        let out = '';
        let cho = -1;
        let jung = -1;
        let jong = 0;
        const flush = () => {
            if (cho >= 0 && jung >= 0) out += String.fromCharCode(SBASE + (cho * 21 + jung) * 28 + jong);
            else if (cho >= 0) out += CHO[cho];
            else if (jung >= 0) out += JUNG[jung];
            cho = -1;
            jung = -1;
            jong = 0;
        };
        for (const ch of s) {
            const j = KEY_TO_JAMO[ch] || KEY_TO_JAMO[ch.toLowerCase()];
            if (!j) {
                flush();
                out += ch;
                continue;
            }
            const ci = CHO.indexOf(j);
            if (ci >= 0) {
                // consonant
                if (jung < 0 || cho < 0) {
                    flush();
                    cho = ci;
                } else if (!jong) {
                    const ji = JONG.indexOf(j);
                    if (ji > 0) jong = ji;
                    else {
                        flush();
                        cho = ci;
                    }
                } else {
                    const joined = JONG_JOIN[JONG[jong] + j];
                    if (joined) jong = JONG.indexOf(joined);
                    else {
                        flush();
                        cho = ci;
                    }
                }
                continue;
            }
            // vowel
            const vi = JUNG.indexOf(j);
            if (cho >= 0 && jung < 0) {
                jung = vi;
            } else if (jung >= 0 && !jong) {
                const joined = JUNG_JOIN[JUNG[jung] + j];
                if (joined) jung = JUNG.indexOf(joined);
                else {
                    flush();
                    jung = vi;
                }
            } else if (jong) {
                // the final consonant moves to the next syllable: 각+ㅏ → 가가
                const fin = JONG[jong];
                const pair = JONG_PAIRS[fin];
                const nextCho = CHO.indexOf(pair ? pair[1] : fin);
                jong = pair ? JONG.indexOf(pair[0]) : 0;
                flush();
                cho = nextCho;
                jung = vi;
            } else {
                flush();
                jung = vi;
            }
        }
        flush();
        return out;
    }

    function jamoKeys(j) {
        if (JAMO_TO_KEY[j]) return JAMO_TO_KEY[j];
        const pair = JONG_PAIRS[j] || JUNG_PAIRS[j];
        return pair ? Array.from(pair, (x) => JAMO_TO_KEY[x] || x).join('') : j;
    }

    /** 'ㅅ갸ㅔ' → 'trip' (text typed while the keyboard was in Korean mode) */
    function hangulToLatin(s) {
        let out = '';
        for (const ch of s) {
            const c = ch.charCodeAt(0);
            if (isSyllable(c)) {
                const idx = c - SBASE;
                const jong = idx % 28;
                out += jamoKeys(CHO[(idx / 588) | 0]) + jamoKeys(JUNG[((idx % 588) / 28) | 0]) + (jong ? jamoKeys(JONG[jong]) : '');
            } else if (c >= 0x3131 && c <= 0x3163) {
                out += jamoKeys(ch);
            } else out += ch;
        }
        return out;
    }

    /** While typing '수현' the IME shows '숳' for a moment: also try '수ㅎ' (final consonant → next initial). */
    function splitLastFinal(s) {
        const c = s.charCodeAt(s.length - 1);
        if (!isSyllable(c)) return null;
        const idx = c - SBASE;
        const jong = idx % 28;
        if (!jong) return null;
        const fin = JONG[jong];
        const pair = JONG_PAIRS[fin];
        const head = String.fromCharCode(SBASE + idx - jong + (pair ? JONG.indexOf(pair[0]) : 0));
        return s.slice(0, -1) + head + (pair ? pair[1] : fin);
    }

    // =====================================================================================================
    // Matcher
    // =====================================================================================================
    const MAX_N = 160; // longer texts are matched on their first 160 chars
    const MAX_M = 48;
    const NEG = -1e9;
    const S_EXACT = 16;
    const S_INITIAL = 13; // 'ㄱ' matching 김
    const S_PARTIAL = 11; // '기' (still composing) matching 김
    const B_START = 10;
    const B_SEP = 8;
    const B_CAMEL = 7;
    const B_NUM = 5;
    const B_SCRIPT = 5;
    const B_CONSEC = 5;

    // character classes for word-boundary bonuses
    const K_SEP = 1;
    const K_LOWER = 2;
    const K_UPPER = 3;
    const K_DIGIT = 4;
    const K_HANGUL = 5;
    const K_OTHER = 6;
    const SEPARATORS = new Set(Array.from(' \t/\\_-.,()[]{}+&#@!~:;\'"=|<>', (c) => c.charCodeAt(0)));

    function kindOf(c) {
        if (SEPARATORS.has(c)) return K_SEP;
        if (c >= 97 && c <= 122) return K_LOWER;
        if (c >= 65 && c <= 90) return K_UPPER;
        if (c >= 48 && c <= 57) return K_DIGIT;
        if (isSyllable(c) || (c >= 0x3131 && c <= 0x318e)) return K_HANGUL;
        return K_OTHER;
    }

    const textCache = new Map();

    /** Normalized text + lowercase + "initials" strings (same length), cached. */
    function prepText(text) {
        const key = String(text ?? '');
        let pt = textCache.get(key);
        if (pt) return pt;
        const raw = key.normalize('NFC');
        let lower = '';
        let cho = '';
        for (let i = 0; i < raw.length; i++) {
            const code = raw.charCodeAt(i);
            let lc = raw[i];
            if (code >= 65 && code <= 90) lc = String.fromCharCode(code + 32);
            else if (code > 127 && !isSyllable(code)) {
                const l = lc.toLowerCase();
                if (l.length === 1) lc = l;
            }
            lower += lc;
            cho += isSyllable(code) ? CHO[((code - SBASE) / 588) | 0] : lc;
        }
        pt = { raw, lower, cho, bonus: null };
        if (textCache.size > 150000) textCache.clear();
        textCache.set(key, pt);
        return pt;
    }

    function bonuses(pt) {
        if (pt.bonus) return pt.bonus;
        const s = pt.raw;
        const n = Math.min(s.length, MAX_N);
        const b = new Int8Array(n);
        let prev = 0;
        for (let i = 0; i < n; i++) {
            const k = kindOf(s.charCodeAt(i));
            let v = 0;
            if (i === 0) v = B_START;
            else if (k === K_SEP) v = 0;
            else if (prev === K_SEP) v = B_SEP;
            else if (prev === K_LOWER && k === K_UPPER) v = B_CAMEL;
            else if ((prev === K_DIGIT) !== (k === K_DIGIT)) v = B_NUM;
            else if ((prev === K_HANGUL) !== (k === K_HANGUL)) v = B_SCRIPT;
            b[i] = v;
            prev = k;
        }
        pt.bonus = b;
        return b;
    }

    function charScore(q, last, relax, lc, cc) {
        if (q === lc) return S_EXACT;
        if (cc === q && CHO_CODES.has(q)) return S_INITIAL; // lc is a syllable starting with that consonant
        if (relax && last && isSyllable(q) && isSyllable(lc)) {
            const qi = q - SBASE;
            if (qi % 28 === 0 && ((qi / 28) | 0) === (((lc - SBASE) / 28) | 0)) return S_PARTIAL;
        }
        return 0;
    }

    const H = new Float64Array(2 * MAX_N);
    const BP = new Int16Array(MAX_M * MAX_N);

    // Best-scoring subsequence alignment (affine gaps, boundary + consecutive bonuses). O(n·m).
    function fuzzy(codes, relax, pt) {
        const m = codes.length;
        const n = Math.min(pt.lower.length, MAX_N);
        if (!m) return { score: 0, pos: [] };
        if (m > n || m > MAX_M) return null;
        const L = pt.lower;
        const C = pt.cho;
        // Cheap greedy check first: most texts fail here
        let j = 0;
        for (let i = 0; i < m; i++) {
            const q = codes[i];
            const last = i === m - 1;
            while (j < n && !charScore(q, last, relax, L.charCodeAt(j), C.charCodeAt(j))) j++;
            if (j === n) return null;
            j++;
        }
        const bonus = bonuses(pt);
        let prev = 0;
        let cur = MAX_N;
        for (let jj = 0; jj < n; jj++) {
            const s = charScore(codes[0], m === 1, relax, L.charCodeAt(jj), C.charCodeAt(jj));
            H[jj] = s ? s + bonus[jj] * 1.5 - Math.min(jj, 20) * 0.3 : NEG;
            BP[jj] = -1;
        }
        for (let i = 1; i < m; i++) {
            const q = codes[i];
            const last = i === m - 1;
            const row = i * n;
            let G = NEG;
            let gArg = -1;
            for (let jj = 0; jj < n; jj++) {
                if (jj >= 2) {
                    const hp = H[prev + jj - 2];
                    if (hp > NEG && hp + (jj - 2) > G) {
                        G = hp + (jj - 2);
                        gArg = jj - 2;
                    }
                }
                let val = NEG;
                let arg = -1;
                if (jj >= i) {
                    const s = charScore(q, last, relax, L.charCodeAt(jj), C.charCodeAt(jj));
                    if (s) {
                        const hc = H[prev + jj - 1];
                        if (hc > NEG) {
                            val = hc + B_CONSEC;
                            arg = jj - 1;
                        }
                        if (G > NEG && G - jj - 1 > val) {
                            val = G - jj - 1; // gap of g chars costs 2 + g
                            arg = gArg;
                        }
                        if (arg >= 0) val += s + bonus[jj];
                    }
                }
                H[cur + jj] = val;
                BP[row + jj] = arg;
            }
            const t = prev;
            prev = cur;
            cur = t;
        }
        let best = NEG;
        let bj = -1;
        for (let jj = 0; jj < n; jj++) {
            if (H[prev + jj] > best) {
                best = H[prev + jj];
                bj = jj;
            }
        }
        if (bj < 0) return null;
        const pos = new Array(m);
        for (let i = m - 1, jj = bj; i >= 0; i--) {
            pos[i] = jj;
            jj = i > 0 ? BP[i * n + jj] : -1;
        }
        return { score: best, pos };
    }

    // Converted queries (wrong keyboard mode) must match as one piece, otherwise they match noise.
    function contiguous(codes, relax, pt) {
        const m = codes.length;
        const n = Math.min(pt.lower.length, MAX_N);
        if (!m || m > n) return null;
        const L = pt.lower;
        const C = pt.cho;
        let bonus = null;
        let best = NEG;
        let bs = -1;
        for (let s = 0; s + m <= n; s++) {
            if (!charScore(codes[0], m === 1, relax, L.charCodeAt(s), C.charCodeAt(s))) continue;
            bonus = bonus || bonuses(pt);
            let total = 0;
            let ok = true;
            for (let i = 0; i < m; i++) {
                const sc = charScore(codes[i], i === m - 1, relax, L.charCodeAt(s + i), C.charCodeAt(s + i));
                if (!sc) {
                    ok = false;
                    break;
                }
                total += sc + (i === 0 ? bonus[s] * 1.5 : B_CONSEC + bonus[s + i]);
            }
            if (ok && total - Math.min(s, 20) * 0.3 > best) {
                best = total - Math.min(s, 20) * 0.3;
                bs = s;
            }
        }
        if (bs < 0) return null;
        return { score: best, pos: Array.from({ length: m }, (_, i) => bs + i) };
    }

    function lowerOf(s) {
        return prepText(s).lower;
    }

    function variantsOf(tok, isLast) {
        const out = [];
        const add = (text, penalty, contig, converted = false) => {
            const lt = lowerOf(text);
            if (!lt || out.some((v) => v.text === lt && v.contiguous === contig)) return;
            out.push({ text: lt, codes: Array.from({ length: Math.min(lt.length, MAX_M) }, (_, i) => lt.charCodeAt(i)), penalty, contiguous: contig, relax: isLast, converted });
        };
        add(tok, 0, false);
        if (isLast) {
            const s = splitLastFinal(tok);
            if (s) add(s, 2, false);
        }
        if (/^[A-Za-z]{2,}$/.test(tok)) {
            const k = latinToHangul(tok);
            if (/[가-힣]/.test(k)) {
                add(k, 6, true, true);
                const s = isLast && splitLastFinal(k);
                if (s) add(s, 7, true, true);
            }
        } else if (/^[ㄱ-ㅣ가-힣]+$/.test(tok) && /[ㅏ-ㅣ가-힣]/.test(tok)) {
            const l = hangulToLatin(tok).toLowerCase();
            if (/^[a-z]{2,}$/.test(l)) add(l, 6, true, true);
        }
        return out;
    }

    function latinOrHangul(tok) {
        return /^[A-Za-z]+$/.test(tok) ? latinToHangul(tok) : hangulToLatin(tok).toLowerCase();
    }

    const queryCache = new Map();

    /** Parse a query once, then match it against many texts with matchPrepared(). */
    function prepQuery(query) {
        const q = String(query ?? '').normalize('NFC').trim();
        let pq = queryCache.get(q);
        if (pq) return pq;
        if (!q) pq = { empty: true, text: '', tokens: [] };
        else {
            const toks = q.split(/\s+/).slice(0, 8);
            const tokens = toks.map((t, i) => variantsOf(t, i === toks.length - 1));
            // what the query reads as in the other keyboard mode ('rlatngus' → '김수현'), for the hint line
            const convertedText = tokens.some((vs) => vs.some((v) => v.converted)) ? tokens.map((vs, i) => (vs.find((v) => v.converted) ? latinOrHangul(toks[i]) : toks[i])).join(' ') : '';
            pq = { empty: false, text: lowerOf(q), tokens, convertedText };
        }
        if (queryCache.size > 64) queryCache.clear();
        queryCache.set(q, pq);
        return pq;
    }

    function toRanges(positions) {
        const sorted = [...new Set(positions)].sort((a, b) => a - b);
        const ranges = [];
        for (const p of sorted) {
            const last = ranges[ranges.length - 1];
            if (last && last[1] === p) last[1] = p + 1;
            else ranges.push([p, p + 1]);
        }
        return ranges;
    }

    function matchPrepared(pq, pt) {
        if (pq.empty) return { score: 0, ranges: [] };
        let total = 0;
        let converted = false;
        const all = [];
        for (const variants of pq.tokens) {
            let best = null;
            let bestVariant = null;
            let bestScore = NEG;
            for (const v of variants) {
                const r = v.contiguous ? contiguous(v.codes, v.relax, pt) : fuzzy(v.codes, v.relax, pt);
                if (r && r.score - v.penalty > bestScore) {
                    best = r;
                    bestVariant = v;
                    bestScore = r.score - v.penalty;
                }
            }
            if (!best) return null;
            if (bestVariant.converted) converted = true;
            total += bestScore;
            for (const p of best.pos) all.push(p);
        }
        if (pt.lower === pq.text) total += 30;
        else if (pq.tokens.length === 1 && (pt.lower.startsWith(pq.tokens[0][0].text) || pt.cho.startsWith(pq.tokens[0][0].text))) total += 12;
        total -= Math.min(10, Math.max(0, pt.lower.length - all.length) * 0.15);
        return converted ? { score: total, ranges: toRanges(all), converted } : { score: total, ranges: toRanges(all) };
    }

    function match(query, text) {
        return matchPrepared(prepQuery(query), prepText(text));
    }

    // =====================================================================================================
    // Frecency — recent and frequent picks rank first
    // =====================================================================================================
    const HIST_KEY = 'palette.history';
    const HIST_MAX = 400;

    function history() {
        const v = App.settings.get(HIST_KEY, null);
        return v && typeof v === 'object' ? v : {};
    }

    let lastRecord = { key: null, t: 0 };

    function record(key) {
        if (!key) return;
        // a palette pick that also opens the viewer would otherwise count twice
        if (lastRecord.key === key && Date.now() - lastRecord.t < 1500) return;
        lastRecord = { key, t: Date.now() };
        const hist = { ...history() };
        const e = hist[key] || { n: 0, t: 0 };
        hist[key] = { n: Math.min(e.n + 1, 999), t: Date.now() };
        const keys = Object.keys(hist);
        if (keys.length > HIST_MAX) {
            keys.sort((a, b) => hist[a].t - hist[b].t);
            for (const k of keys.slice(0, keys.length - HIST_MAX)) delete hist[k];
        }
        App.settings.set(HIST_KEY, hist);
    }

    function frecency(key, hist = history()) {
        const e = hist[key];
        if (!e) return 0;
        const days = (Date.now() - e.t) / 86400000;
        const recency = days < 1 ? 1 : days < 7 ? 0.7 : days < 30 ? 0.45 : 0.25;
        return Math.min(24, recency * Math.log2(e.n + 1) * 10);
    }

    function wsKey(kind, p) {
        return `${kind}:${App.state.workspace?.id || '-'}:${p}`;
    }

    // Keep history keys pointing at renamed/moved folders and files
    App.bus.on('fs:changed', (c) => {
        if (!c.from || !c.to || !App.state.workspace) return;
        const hist = history();
        const ws = App.state.workspace.id;
        let changed = false;
        const out = {};
        for (const [k, v] of Object.entries(hist)) {
            const m = /^(dir|file):([^:]*):(.*)$/.exec(k);
            let nk = k;
            if (m && m[2] === ws) {
                for (let i = 0; i < c.from.length; i++) {
                    const r = P.rebase(m[3], c.from[i], c.to[i]);
                    if (r != null) {
                        nk = `${m[1]}:${ws}:${r}`;
                        break;
                    }
                }
            }
            if (nk !== k) changed = true;
            out[nk] = v;
        }
        if (changed) App.settings.set(HIST_KEY, out);
    });
    App.bus.on('item:open', ({ path }) => {
        if (App.state.workspace && path) record(wsKey('file', path));
    });

    // =====================================================================================================
    // Providers
    // =====================================================================================================
    const providers = [];
    let paletteLayer = 'main'; // layer that was on top when the palette opened (decides which commands apply)
    let state = null; // { close, input, list, tabs, scope, rows, active, ... } while the palette is open

    function addProvider(p) {
        const i = providers.findIndex((x) => x.id === p.id);
        if (i >= 0) providers.splice(i, 1);
        providers.push({ order: 50, limit: 6, scopedLimit: 100, ...p });
        providers.sort((a, b) => a.order - b.order);
        if (state) refresh();
    }

    // Generic search for providers that just list items: title (1×), subtitle (0.6×), keywords (0.5×)
    function searchItems(list, pq, limit) {
        const out = [];
        const hist = history();
        for (const it of list) {
            const r = matchPrepared(pq, prepText(it.title));
            let score = r ? r.score : NEG;
            let ranges = r ? r.ranges : null;
            let subRanges = null;
            let converted = !!r?.converted;
            if (it.subtitle) {
                const rs = matchPrepared(pq, prepText(it.subtitle));
                if (rs && rs.score * 0.6 > score) {
                    score = rs.score * 0.6;
                    ranges = null;
                    subRanges = rs.ranges;
                    converted = !!rs.converted;
                }
            }
            for (const kw of it.keywords || []) {
                const rk = matchPrepared(pq, prepText(kw));
                if (rk && rk.score * 0.5 > score) {
                    score = rk.score * 0.5;
                    ranges = null;
                    subRanges = null;
                    converted = !!rk.converted;
                }
            }
            if (score <= NEG) continue;
            out.push({ ...it, ranges, subRanges, converted, score: score + frecency(it.key, hist) });
        }
        out.sort((a, b) => b.score - a.score);
        return { items: out.slice(0, limit), total: out.length };
    }

    // ----- Undo / redo: always the first items, with what they'll undo -----
    const UNDO_IDS = new Set(['edit.undo', 'edit.redo']); // shown by the 'undo' provider instead of as plain commands

    function undoRedoItems() {
        const out = [];
        const u = App.undo;
        if (u.canUndo()) {
            const top = App.history?.undoList?.()[0] || { label: u.peek?.()?.label };
            out.push({
                key: 'undo:undo',
                kind: 'command',
                noRecord: true,
                title: top.label ? `실행 취소: ${top.label}` : '실행 취소',
                subtitle: top.time ? App.shell.relTime(top.time) : '',
                icon: 'undo',
                keys: App.commands.get('edit.undo')?.keys?.length ? App.commands.get('edit.undo').keys : ['Mod+Z'],
                keywords: ['실행 취소', '되돌리기', 'undo'],
                run: () => (App.commands.get('edit.undo') ? App.commands.run('edit.undo') : u.undo()),
            });
        }
        if (u.canRedo()) {
            const next = App.history?.redoList?.()[0] || { label: u.peekRedo?.()?.label };
            out.push({
                key: 'undo:redo',
                kind: 'command',
                noRecord: true,
                title: next.label ? `다시 실행: ${next.label}` : '다시 실행',
                subtitle: '',
                icon: 'redo',
                keys: App.commands.get('edit.redo')?.keys?.length ? App.commands.get('edit.redo').keys : ['Mod+Shift+Z'],
                keywords: ['다시 실행', 'redo'],
                run: () => (App.commands.get('edit.redo') ? App.commands.run('edit.redo') : u.redo()),
            });
        }
        return out;
    }

    addProvider({
        id: 'undo',
        label: '되돌리기',
        icon: 'undo',
        order: 5,
        limit: 2,
        scopedLimit: 2,
        pinned: true, // above 최근 when the box is empty
        tab: false,
        alsoIn: ['commands'],
        items: undoRedoItems,
        empty: undoRedoItems,
    });

    // ----- Commands -----
    // Good first things to try, shown when the palette opens empty (until the user's own history takes over)
    const SUGGESTED = ['workspace.reopen', 'workspace.open', 'search.focus', 'folder.new', 'edit.history', 'organize.byDate', 'dupes.open', 'trash.open', 'backup.now', 'view.toggleTheme', 'settings.open', 'help.shortcuts'];

    function isPaletteCommand(c) {
        if (!c.title || c.hidden || c.palette === false) return false;
        if (!c.group && c.palette !== true) return false;
        if (c.id.startsWith('palette.') || UNDO_IDS.has(c.id)) return false;
        if (c.scope !== 'global' && c.scope !== paletteLayer) return false;
        return App.commands.isEnabled(c.id);
    }

    function commandItem(c) {
        return {
            key: 'cmd:' + c.id,
            kind: 'command',
            title: c.title,
            subtitle: c.group || '',
            keywords: [c.id, ...(c.keywords || [])],
            icon: c.icon || 'command',
            keys: c.keys,
            run: () => App.commands.run(c.id),
        };
    }

    addProvider({
        id: 'commands',
        label: '명령',
        icon: 'command',
        prefix: '>',
        order: 10,
        limit: 6,
        scopedLimit: 300,
        items: () => App.commands.list().filter(isPaletteCommand).map(commandItem),
        resolve(key) {
            if (!key.startsWith('cmd:')) return null;
            const c = App.commands.get(key.slice(4));
            return c && isPaletteCommand(c) ? commandItem(c) : null;
        },
        empty(ctx, scoped) {
            const hist = history();
            const list = App.commands.list().filter(isPaletteCommand).map(commandItem);
            if (scoped) return list; // registration order = the author's order, grouped below
            // used ones first, then a few useful starting points, then the rest
            const rank = (it) => {
                const i = SUGGESTED.indexOf(it.key.slice(4));
                return i < 0 ? 0 : (SUGGESTED.length - i) * 0.5;
            };
            return list.map((it, i) => ({ it, s: frecency(it.key, hist) * 10 + rank(it) - i * 0.001 })).sort((a, b) => b.s - a.s).map((x) => x.it);
        },
        groupBy: (item) => item.subtitle || '기타',
    });

    // ----- Folders -----
    let countsCache = { version: -1, map: null };
    let indexVersion = 0;
    App.bus.on('index:changed', () => {
        indexVersion++;
        if (state) refreshSoon();
    });
    App.bus.on('index:ready', () => {
        if (state) refreshSoon();
    });
    App.bus.on('workspace:opened', () => {
        indexVersion++;
    });

    // Photos/videos inside each folder, subfolders included (computed once per index change)
    function folderCounts() {
        if (countsCache.version === indexVersion && countsCache.map) return countsCache.map;
        const map = new Map();
        for (const e of App.index.items) {
            const key = e.type === 'image' ? 'image' : e.type === 'video' ? 'video' : null;
            if (!key) continue;
            let d = P.parent(e.path);
            for (;;) {
                let c = map.get(d);
                if (!c) map.set(d, (c = { image: 0, video: 0 }));
                c[key]++;
                if (d === '') break;
                d = P.parent(d);
            }
        }
        countsCache = { version: indexVersion, map };
        return map;
    }

    function knownFolders() {
        if (App.index.ready) return App.index.folders;
        // Index still building: folders we already know about (tree + current folder)
        const set = new Set(['']);
        const kids = App.tree?.children;
        if (kids && typeof kids.forEach === 'function') kids.forEach((list, dir) => {
            set.add(dir);
            for (const c of list || []) set.add(c);
        });
        for (const e of App.view.entries) if (e.kind === 'dir') set.add(e.path);
        if (App.state.cwd) set.add(App.state.cwd);
        return [...set];
    }

    function folderItem(p) {
        const ws = App.state.workspace;
        const counts = App.index.ready ? folderCounts().get(p) : null;
        const parts = [];
        if (counts?.image) parts.push(`사진 ${formatCount(counts.image)}`);
        if (counts?.video) parts.push(`영상 ${formatCount(counts.video)}`);
        return {
            key: wsKey('dir', p),
            kind: 'folder',
            path: p,
            title: p === '' ? ws?.name || '작업 폴더' : P.base(p),
            subtitle: p === '' ? '작업 폴더 처음' : P.parent(p) || ws?.name || '',
            icon: p === '' ? 'home' : 'folder',
            badge: parts.join(' · '),
            altLabel: '상위 폴더에서 보기',
            run: ({ alt } = {}) => goFolder(p, { alt }),
        };
    }

    async function goFolder(p, { alt } = {}) {
        App.topbar?.clearSearch?.();
        if (alt && p !== '') await App.nav.go(P.parent(p), { focus: p });
        else await App.nav.go(p);
        App.tree?.reveal?.(p);
        if (alt) App.gallery?.scrollTo?.(p, { center: true });
    }

    function searchFolders(pq, limit) {
        const hist = history();
        const out = [];
        for (const f of knownFolders()) {
            const base = f === '' ? App.state.workspace?.name || '' : P.base(f);
            const r = matchPrepared(pq, prepText(base));
            if (r) {
                out.push({ f, score: r.score + frecency(wsKey('dir', f), hist), ranges: r.ranges, subRanges: null, converted: r.converted });
                continue;
            }
            if (!f.includes('/')) continue;
            const rp = matchPrepared(pq, prepText(f));
            if (!rp) continue;
            // split path ranges between the parent (subtitle) and the name (title)
            const cut = f.length - base.length;
            out.push({
                f,
                score: rp.score * 0.85 + frecency(wsKey('dir', f), hist),
                ranges: rp.ranges.filter(([a]) => a >= cut).map(([a, b]) => [a - cut, b - cut]),
                subRanges: rp.ranges.filter(([a]) => a < cut - 1).map(([a, b]) => [a, Math.min(b, cut - 1)]),
                converted: rp.converted,
            });
        }
        out.sort((a, b) => b.score - a.score);
        return { items: out.slice(0, limit).map((x) => ({ ...folderItem(x.f), score: x.score, ranges: x.ranges, subRanges: x.subRanges, converted: !!x.converted })), total: out.length };
    }

    addProvider({
        id: 'folders',
        label: '폴더',
        emptyLabel: '모든 폴더',
        icon: 'folder',
        prefix: '/',
        order: 20,
        limit: 5,
        scopedLimit: 120,
        when: () => App.fs.ready,
        search: (pq, ctx, limit) => searchFolders(pq, limit),
        resolve(key) {
            const m = /^dir:([^:]*):(.*)$/.exec(key);
            if (!m || m[1] !== App.state.workspace?.id) return null;
            const p = m[2];
            if (p !== '' && App.index.ready && !App.index.folders.includes(p)) return null;
            return folderItem(p);
        },
        empty(ctx, scoped) {
            if (!scoped) return [];
            return [...knownFolders()].sort((a, b) => App.util.compareNames(a, b)).map(folderItem);
        },
    });

    // ----- Files -----
    function fileItem(e) {
        const ws = App.state.workspace;
        return {
            key: wsKey('file', e.path),
            kind: 'file',
            path: e.path,
            entry: e,
            title: e.name,
            subtitle: P.parent(e.path) || ws?.name || '',
            icon: e.type === 'video' ? 'film' : 'image',
            badge: e.ext ? e.ext.toUpperCase() : '',
            altLabel: '열지 않고 폴더에서 보기',
            run: ({ alt } = {}) => revealFile(e.path, { open: !alt }),
        };
    }

    async function revealFile(p, { open = true } = {}) {
        App.topbar?.clearSearch?.();
        await App.nav.go(P.parent(p), { focus: p });
        if (!App.view.index.has(p) && App.view.entries.some((e) => e.path === p)) {
            // hidden by a filter: show everything so the file can be selected
            App.topbar?.setTypeFilter?.('all');
            App.view.clearFilters();
            ui.toast('필터를 풀고 파일을 보여 드렸어요', { type: 'info', duration: 2400 });
        }
        if (!App.view.index.has(p)) {
            ui.toast('파일을 찾을 수 없어요. 옮겨졌거나 지워졌을 수 있어요.', { type: 'warning' });
            return;
        }
        App.select.set([p], { focus: p });
        App.gallery?.scrollTo?.(p, { center: true });
        if (open) App.nav.open(App.view.get(p));
    }

    function searchFiles(pq, limit) {
        const hist = history();
        const pathFallback = pq.tokens.length > 1 || pq.text.includes('/');
        // While the index is still being built, at least search the folder on screen
        const source = App.index.ready ? App.index.items : App.view.entries.filter((e) => e.kind === 'file');
        const out = [];
        let total = 0;
        let floor = NEG; // keeps memory bounded on huge libraries
        for (const e of source) {
            const r = matchPrepared(pq, prepText(e.name));
            let ranges = r && r.ranges;
            let subRanges = null;
            let score = r ? r.score : NEG;
            let converted = !!r?.converted;
            if (!r && pathFallback) {
                const rp = matchPrepared(pq, prepText(e.path));
                if (rp) {
                    const cut = e.path.length - e.name.length;
                    score = rp.score * 0.85;
                    ranges = rp.ranges.filter(([a]) => a >= cut).map(([a, b]) => [a - cut, b - cut]);
                    subRanges = rp.ranges.filter(([a]) => a < cut - 1).map(([a, b]) => [a, Math.min(b, cut - 1)]);
                    converted = !!rp.converted;
                }
            }
            if (score <= NEG) continue;
            score += frecency(wsKey('file', e.path), hist);
            total++;
            if (score < floor) continue;
            out.push({ e, score, ranges, subRanges, converted });
            if (out.length > limit * 4 + 50) {
                out.sort((a, b) => b.score - a.score);
                out.length = limit;
                floor = out[out.length - 1].score;
            }
        }
        out.sort((a, b) => b.score - a.score);
        return { items: out.slice(0, limit).map((x) => ({ ...fileItem(x.e), score: x.score, ranges: x.ranges, subRanges: x.subRanges, converted: x.converted })), total };
    }

    addProvider({
        id: 'files',
        label: '파일',
        emptyLabel: '최근에 바뀐 파일',
        icon: 'image',
        order: 30,
        limit: 8,
        scopedLimit: 100,
        when: () => App.fs.ready,
        search: (pq, ctx, limit) => searchFiles(pq, limit),
        resolve(key) {
            const m = /^file:([^:]*):(.*)$/.exec(key);
            if (!m || m[1] !== App.state.workspace?.id) return null;
            const e = App.index.get(m[2]) || App.view.get(m[2]);
            return e && e.kind === 'file' ? fileItem(e) : null;
        },
        empty(ctx, scoped) {
            if (!scoped) return [];
            // most recently modified files first
            return App.index.items
                .slice()
                .sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
                .slice(0, 60)
                .map(fileItem);
        },
        status() {
            if (!App.fs.ready) return '';
            if (!App.index.ready) return '라이브러리 색인 중이에요 — 잠시 후 모든 파일을 찾을 수 있어요';
            return '';
        },
    });

    // =====================================================================================================
    // UI
    // =====================================================================================================
    function activeProviders(scope) {
        const usable = providers.filter((p) => !p.when || p.when());
        return scope === 'all' ? usable.filter((p) => p.global !== false) : usable.filter((p) => p.id === scope || (p.alsoIn && p.alsoIn.includes(scope)));
    }

    function recentItems(limit, onlyProvider) {
        const hist = history();
        const keys = Object.keys(hist).sort((a, b) => hist[b].t - hist[a].t);
        const out = [];
        for (const k of keys) {
            for (const p of onlyProvider ? [onlyProvider] : activeProviders('all')) {
                if (!p.resolve) continue;
                let item = null;
                try {
                    item = p.resolve(k);
                } catch (e) {
                    item = null;
                }
                if (item) {
                    out.push({ ...item, providerLabel: p.label });
                    break;
                }
            }
            if (out.length >= limit) break;
        }
        return out;
    }

    /** Build sections [{ id, label, items, more }] for the current scope + query. */
    function compute(scope, query) {
        const pq = prepQuery(query);
        const provs = activeProviders(scope);
        const ctx = { scope, query, workspace: App.state.workspace };
        const sections = [];
        const seen = new Set();

        if (pq.empty) {
            const single = scope !== 'all' ? providerById(scope) : null;
            const emptyItems = (p) => {
                try {
                    return (p.empty ? p.empty(ctx, !!single) : []).filter((it) => !seen.has(it.key));
                } catch (e) {
                    console.error('[palette] provider failed', p.id, e);
                    return [];
                }
            };
            // pinned sections (undo/redo) come first, then recent picks, then everything else
            for (const p of provs.filter((x) => x.pinned)) {
                const items = emptyItems(p).slice(0, p.limit);
                if (!items.length) continue;
                sections.push({ id: p.id, label: p.label, items });
                items.forEach((it) => seen.add(it.key));
            }
            const recents = recentItems(scope === 'all' ? 6 : 8, single).filter((r) => !seen.has(r.key));
            if (recents.length) {
                sections.push({ id: 'recent', label: '최근', items: recents });
                recents.forEach((r) => seen.add(r.key));
            }
            for (const p of provs.filter((x) => !x.pinned)) {
                let items = [];
                try {
                    items = (p.empty ? p.empty(ctx, !!single) : []).filter((it) => !seen.has(it.key));
                } catch (e) {
                    console.error('[palette] provider failed', p.id, e);
                }
                const limit = single ? p.scopedLimit : p.limit;
                if (!items.length) continue;
                if (single && p.groupBy) {
                    const groups = new Map();
                    for (const it of items.slice(0, limit)) {
                        const g = p.groupBy(it);
                        if (!groups.has(g)) groups.set(g, []);
                        groups.get(g).push(it);
                    }
                    for (const [g, list] of groups) sections.push({ id: `${p.id}:${g}`, label: g, items: list });
                } else {
                    sections.push({ id: p.id, label: (single && p.emptyLabel) || p.label, items: items.slice(0, limit), more: !single && items.length > limit ? { provider: p, count: items.length - limit } : null });
                }
            }
            return sections;
        }

        for (const p of provs) {
            const limit = scope === 'all' ? p.limit : p.scopedLimit;
            let res = { items: [], total: 0 };
            try {
                res = p.search ? p.search(pq, ctx, limit) : searchItems(p.items ? p.items(ctx) : [], pq, limit);
                if (Array.isArray(res)) res = { items: res.slice(0, limit), total: res.length };
            } catch (e) {
                console.error('[palette] provider failed', p.id, e);
            }
            if (!res.items.length) continue;
            sections.push({
                id: p.id,
                label: p.label,
                items: res.items,
                best: res.items[0].score ?? 0,
                more: scope === 'all' && res.total > res.items.length ? { provider: p, count: res.total - res.items.length } : null,
            });
        }
        sections.sort((a, b) => b.best - a.best);
        return sections;
    }

    function highlight(el, text, ranges) {
        const raw = prepText(text).raw;
        if (!ranges || !ranges.length) {
            el.textContent = raw;
            return;
        }
        let at = 0;
        for (const [a, b] of ranges) {
            if (a > at) el.append(raw.slice(at, a));
            el.append(h('mark', { text: raw.slice(a, b) }));
            at = b;
        }
        if (at < raw.length) el.append(raw.slice(at));
    }

    function comboParts(combo) {
        const parts = combo.split('+');
        if (combo.endsWith('++')) parts.splice(-2, 2, '+');
        return parts.map((p) => App.commands.displayCombo(p) || p);
    }

    function kbdEl(combo, cls = '') {
        return h('span', { class: `pal-keys ${cls}` }, ...comboParts(combo).map((p) => h('span', { class: 'kbd', text: p })));
    }

    function rowEl(row, idx) {
        if (row.type === 'header') return h('div', { class: 'pal-section', role: 'presentation', text: row.label });
        if (row.type === 'hint') return h('div', { class: 'pal-hint-row', role: 'presentation' }, h('span', { html: ui.icon(row.icon || 'info', { size: 13 }) }), h('span', { text: row.text }));
        if (row.type === 'status') return h('div', { class: 'pal-status', role: 'presentation' }, h('span', { class: 'spinner' }), h('span', { text: row.text }));
        const el = h('div', { class: `pal-item${row.type === 'more' ? ' pal-more' : ''}`, role: 'option', id: `pal-opt-${idx}`, 'aria-selected': 'false', dataset: { idx: String(idx) } });
        if (row.type === 'more') {
            el.append(
                h('span', { class: 'pal-ico', html: ui.icon('arrow-right', { size: 14 }) }),
                h('span', { class: 'pal-text' }, h('span', { class: 'pal-title', text: `${row.provider.label} ${formatCount(row.count)}개 더 보기` })),
            );
            return el;
        }
        const it = row.item;
        const ico = h('span', { class: `pal-ico${it.entry ? ' is-thumb' : ''}` });
        if (it.iconHtml) ico.innerHTML = it.iconHtml;
        else ico.innerHTML = ui.icon(it.icon || 'command', { size: 15 });
        if (it.entry) ico.dataset.path = it.entry.path;
        const title = h('span', { class: 'pal-title' });
        highlight(title, it.title, it.ranges);
        const text = h('span', { class: 'pal-text' }, title);
        if (it.subtitle) {
            const sub = h('span', { class: 'pal-sub' });
            highlight(sub, it.subtitle, it.subRanges);
            text.append(sub);
        }
        const meta = h('span', { class: 'pal-meta' });
        if (it.providerLabel && row.section === 'recent') meta.append(h('span', { class: 'pal-kind', text: it.providerLabel }));
        if (it.badge) meta.append(h('span', { class: 'pal-badge', text: it.badge }));
        if (it.keys && it.keys.length) meta.append(kbdEl(it.keys[0]));
        el.append(ico, text, meta);
        return el;
    }

    function flatten(sections) {
        const rows = [];
        for (const s of sections) {
            rows.push({ type: 'header', label: s.label });
            for (const it of s.items) rows.push({ type: 'item', item: it, section: s.id });
            if (s.more) rows.push({ type: 'more', provider: s.more.provider, count: s.more.count });
        }
        return rows;
    }

    function selectable(row) {
        return row && (row.type === 'item' || row.type === 'more');
    }

    function render() {
        if (!state) return;
        const { scope } = state;
        const query = state.input.value;
        // scope tabs
        for (const tab of state.tabs.children) tab.classList.toggle('on', tab.dataset.scope === scope);
        state.input.placeholder = scope === 'all' ? '명령, 폴더, 파일 검색…' : `${providerById(scope)?.label || ''} 검색…`;

        const sections = compute(scope, query);
        const rows = flatten(sections);
        const pq = prepQuery(query);
        if (pq.convertedText && sections.some((s) => s.items.some((it) => it.converted))) {
            rows.unshift({ type: 'hint', icon: 'keyboard', text: `한/영이 바뀐 것 같아서 ‘${pq.convertedText}’(으)로도 찾아봤어요` });
        }
        const statusText = activeProviders(scope)
            .map((p) => (p.status ? p.status() : ''))
            .find(Boolean);
        if (statusText && query.trim()) rows.push({ type: 'status', text: statusText });
        // Background refreshes (index finished, commands changed) keep the highlighted row
        const sameQuery = state.lastQuery === query && state.lastScope === scope;
        const prevRow = sameQuery ? state.rows[state.active] : null;
        const prevKey = prevRow?.type === 'item' ? prevRow.item.key : null;
        state.lastQuery = query;
        state.lastScope = scope;
        state.rows = rows;
        const list = state.list;
        const scrollTop = sameQuery ? list.scrollTop : 0;
        list.innerHTML = '';
        const frag = document.createDocumentFragment();
        rows.forEach((r, i) => frag.append(rowEl(r, i)));
        list.append(frag);
        if (!rows.some(selectable)) list.append(emptyEl(query, scope));
        const keep = prevKey ? rows.findIndex((r) => r.type === 'item' && r.item.key === prevKey) : -1;
        list.scrollTop = scrollTop;
        setActive(keep >= 0 ? keep : rows.findIndex(selectable), false);
        state.count.textContent = countText(sections, query);
        loadThumbsSoon();
    }

    function emptyEl(query, scope) {
        const box = h('div', { class: 'pal-empty' });
        box.append(h('div', { class: 'pal-empty-icon', html: ui.icon('search', { size: 22 }) }));
        if (query.trim()) {
            box.append(h('div', { class: 'pal-empty-title', text: `‘${query.trim()}’에 맞는 결과가 없어요` }));
            box.append(h('div', { class: 'pal-empty-hint', text: '초성(ㄱㅅㅎ)이나 이름의 일부만 쳐도 찾을 수 있어요.' }));
            if (scope !== 'all') {
                const all = h('button', { class: 'btn sm', type: 'button', html: `${ui.icon('search', { size: 14 })} 전체에서 찾기` });
                all.addEventListener('mousedown', (e) => e.preventDefault());
                all.addEventListener('click', () => setScope('all'));
                box.append(all);
            }
        } else if (!App.fs.ready && (scope === 'folders' || scope === 'files')) {
            box.append(h('div', { class: 'pal-empty-title', text: '작업 폴더를 열면 폴더와 파일을 찾을 수 있어요' }));
            box.append(h('button', { class: 'btn primary sm', html: `${ui.icon('folder-open', { size: 14 })} 작업 폴더 열기`, onclick: () => runRow({ type: 'item', item: { key: 'cmd:workspace.open', run: () => App.commands.run('workspace.open') } }) }));
        } else {
            box.append(h('div', { class: 'pal-empty-title', text: '아직 보여 드릴 항목이 없어요' }));
        }
        return box;
    }

    function countText(sections, query) {
        if (!query.trim()) return '';
        const n = sections.reduce((s, x) => s + x.items.length + (x.more ? x.more.count : 0), 0);
        return n ? `결과 ${formatCount(n)}개` : '';
    }

    function setActive(i, scroll = true) {
        if (!state) return;
        const prevEl = state.list.querySelector('.pal-item.active');
        if (prevEl) {
            prevEl.classList.remove('active');
            prevEl.setAttribute('aria-selected', 'false');
        }
        state.active = i;
        const el = i >= 0 ? state.list.querySelector(`#pal-opt-${i}`) : null;
        if (el) {
            el.classList.add('active');
            el.setAttribute('aria-selected', 'true');
            state.input.setAttribute('aria-activedescendant', el.id);
            if (scroll) el.scrollIntoView({ block: 'nearest' });
        } else state.input.removeAttribute('aria-activedescendant');
        updateFoot();
    }

    function move(delta) {
        if (!state) return;
        const idxs = state.rows.map((r, i) => (selectable(r) ? i : -1)).filter((i) => i >= 0);
        if (!idxs.length) return;
        let pos = idxs.indexOf(state.active);
        if (Math.abs(delta) > 1) pos = App.util.clamp((pos < 0 ? 0 : pos) + delta, 0, idxs.length - 1);
        else pos = pos < 0 ? 0 : (pos + delta + idxs.length) % idxs.length;
        setActive(idxs[pos]);
    }

    function updateFoot() {
        if (!state) return;
        const row = state.rows[state.active];
        const alt = row && row.type === 'item' && row.item.altLabel;
        const hints = [
            ['↑↓', '이동'],
            ['Enter', row && row.type === 'more' ? '더 보기' : row?.item?.kind === 'file' ? '열기' : '실행'],
        ];
        if (alt) hints.push(['Shift+Enter', alt]);
        hints.push(['Tab', '범위 바꾸기'], ['Esc', '닫기']);
        state.hints.innerHTML = '';
        for (const [k, label] of hints) state.hints.append(h('span', { class: 'pal-hint' }, ...k.split('+').map((p) => h('span', { class: 'kbd', text: p === 'Enter' ? '↵' : p })), h('span', { text: label })));
    }

    async function runRow(row, { alt = false } = {}) {
        if (!row) return;
        if (row.type === 'more') {
            setScope(row.provider.id);
            return;
        }
        const it = row.item;
        if (!it.noRecord) record(it.key);
        close();
        await App.util.nextFrame();
        try {
            await it.run({ alt });
        } catch (e) {
            console.error('[palette] run failed', e);
            ui.toast(`실행하지 못했어요: ${e.message || e}`, { type: 'error' });
        }
    }

    function providerById(id) {
        return providers.find((p) => p.id === id);
    }

    function scopesList() {
        return [{ id: 'all', label: '전체', icon: 'search' }, ...providers.filter((p) => p.global !== false && p.tab !== false && (!p.when || p.when() || p.id === 'commands'))];
    }

    function buildTabs() {
        state.tabs.innerHTML = '';
        for (const s of scopesList()) {
            const tab = h('button', { class: 'pal-tab', type: 'button', role: 'tab', dataset: { scope: s.id }, tabindex: '-1' },
                h('span', { html: ui.icon(s.icon || 'search', { size: 13 }) }),
                h('span', { text: s.label }),
                s.prefix ? h('span', { class: 'pal-tab-key', text: s.prefix }) : null);
            tab.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
            tab.addEventListener('click', () => setScope(s.id));
            state.tabs.append(tab);
        }
    }

    function setScope(scope) {
        if (!state) return;
        if (scope !== 'all' && !providerById(scope)) scope = 'all';
        state.scope = scope;
        render();
        state.input.focus();
    }

    function cycleScope(dir) {
        const ids = scopesList().map((s) => s.id);
        const i = ids.indexOf(state.scope);
        setScope(ids[(i + dir + ids.length) % ids.length]);
    }

    // ----- lazy thumbnails for file rows (after typing pauses) -----
    const loadThumbsSoon = App.util.debounce(() => {
        if (!state || !App.thumbs) return;
        for (const ico of state.list.querySelectorAll('.pal-ico.is-thumb[data-path]')) {
            const row = state.rows[Number(ico.parentElement.dataset.idx)];
            const entry = row?.item?.entry;
            if (!entry || (App.thumbs.canThumb && !App.thumbs.canThumb(entry))) continue;
            const apply = (url) => {
                if (!url || !ico.isConnected) return;
                ico.innerHTML = '';
                ico.append(h('img', { src: url, alt: '', draggable: 'false' }));
            };
            const hit = App.thumbs.peek?.(entry);
            if (hit) apply(hit);
            else App.thumbs.get?.(entry)?.then(apply).catch(() => {});
        }
    }, 120);

    const refreshSoon = App.util.debounce(() => render(), 80);

    function refresh() {
        if (state) render();
    }

    function onKey(e) {
        if (!state) return;
        const combo = App.commands.comboFromEvent(e);
        if (combo === 'Mod+K') {
            e.preventDefault();
            close();
            return;
        }
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                move(1);
                break;
            case 'ArrowUp':
                e.preventDefault();
                move(-1);
                break;
            case 'PageDown':
                e.preventDefault();
                move(8);
                break;
            case 'PageUp':
                e.preventDefault();
                move(-8);
                break;
            case 'Enter':
                if (e.isComposing) return;
                e.preventDefault();
                runRow(state.rows[state.active], { alt: e.shiftKey });
                break;
            case 'Tab':
                e.preventDefault();
                cycleScope(e.shiftKey ? -1 : 1);
                break;
            case 'Backspace':
                if (!state.input.value && state.scope !== 'all') {
                    e.preventDefault();
                    setScope('all');
                }
                break;
            default:
        }
    }

    function onInput() {
        if (!state) return;
        const v = state.input.value;
        if (state.scope === 'all' && v.length) {
            const p = providers.find((x) => x.prefix && v.startsWith(x.prefix) && (!x.when || x.when()));
            if (p) {
                state.input.value = v.slice(p.prefix.length);
                state.scope = p.id;
            }
        }
        render();
    }

    function open({ scope = 'all', query = '' } = {}) {
        if (state) {
            state.input.value = query;
            setScope(scope);
            state.input.select();
            return;
        }
        paletteLayer = App.layers.top() === 'viewer' ? 'viewer' : 'main';
        const input = h('input', {
            class: 'pal-input',
            type: 'text',
            spellcheck: 'false',
            autocomplete: 'off',
            role: 'combobox',
            'aria-expanded': 'true',
            'aria-controls': 'pal-list',
            'aria-autocomplete': 'list',
            'aria-label': '명령 팔레트 검색',
        });
        const tabs = h('div', { class: 'pal-tabs', role: 'tablist', 'aria-label': '검색 범위' });
        const list = h('div', { class: 'pal-list', id: 'pal-list', role: 'listbox' });
        const hints = h('div', { class: 'pal-hints' });
        const count = h('div', { class: 'pal-count' });
        const root = h('div', { class: 'pal-root' },
            h('div', { class: 'pal-head' }, h('span', { class: 'pal-head-ico', html: ui.icon('search', { size: 18 }) }), input, h('span', { class: 'kbd pal-esc', text: 'Esc' })),
            tabs,
            list,
            h('div', { class: 'pal-foot' }, hints, h('div', { class: 'grow' }), count));

        state = { input, tabs, list, hints, count, scope, rows: [], active: -1, close: null };
        buildTabs();

        list.addEventListener('mousemove', (e) => {
            const item = e.target.closest('.pal-item');
            if (!item || !state) return;
            const i = Number(item.dataset.idx);
            if (i !== state.active) setActive(i, false);
        });
        list.addEventListener('mousedown', (e) => {
            if (e.target.closest('.pal-item')) e.preventDefault(); // keep focus in the input
        });
        list.addEventListener('click', (e) => {
            const item = e.target.closest('.pal-item');
            if (!item || !state) return;
            runRow(state.rows[Number(item.dataset.idx)], { alt: e.shiftKey });
        });
        input.addEventListener('keydown', onKey);
        input.addEventListener('input', onInput);

        ui.dialog({
            body: root,
            actions: [],
            width: 680,
            init(box, close) {
                state.close = close;
                box.classList.add('pal');
                box.setAttribute('aria-label', '명령 팔레트');
                box.parentElement.classList.add('pal-backdrop');
                input.value = query;
                render();
                input.focus();
            },
        }).then(() => {
            state = null;
        });
    }

    function close() {
        if (state && state.close) state.close(null);
    }

    // ----- Commands -----
    App.commands.register({
        id: 'palette.open',
        title: '명령 팔레트',
        group: '일반',
        icon: 'command',
        keys: ['Mod+K'],
        scope: 'global',
        allowInInput: ['Mod+K'],
        run: () => (state ? close() : open()),
    });
    App.commands.register({ id: 'palette.commands', title: '명령 실행…', group: '일반', icon: 'zap', scope: 'global', run: () => open({ scope: 'commands' }) });
    App.commands.register({ id: 'palette.folders', title: '폴더로 이동…', group: '이동', icon: 'folder', scope: 'global', when: () => App.fs.ready, run: () => open({ scope: 'folders' }) });
    App.commands.register({ id: 'palette.files', title: '파일 찾기…', group: '이동', icon: 'search', scope: 'global', when: () => App.fs.ready, run: () => open({ scope: 'files' }) });

    App.bus.on('commands:changed', () => {
        if (state) refreshSoon();
    });

    // A visible way in for mouse users: status-bar button "명령 Ctrl+K"
    App.bus.once('app:ready', () => {
        if (!App.statusbar?.addItem) return;
        const btn = h('button', { class: 'sb-shell sb-palette', type: 'button', 'data-tip': '명령 팔레트 — 명령·폴더·파일 찾기', 'aria-label': '명령 팔레트 열기' },
            h('span', { html: ui.icon('command', { size: 12 }) }),
            h('span', { class: 'sb-palette-label', text: '명령' }),
            kbdEl('Mod+K'));
        btn.addEventListener('click', () => open());
        App.shell.addStatus('palette', btn, 90);
    });

    App.palette = {
        open,
        close,
        toggle: (opts) => (state ? close() : open(opts)),
        get isOpen() {
            return !!state;
        },
        /** Same result sections the palette would show: [{ id, label, items, more }] */
        search: (query, { scope = 'all' } = {}) => compute(scope, query),
        match,
        prepQuery,
        prepText,
        matchPrepared,
        addProvider,
        providers,
        record,
        frecency: (key) => frecency(key),
        hangul: { latinToHangul, hangulToLatin, splitLastFinal },
        kbdEl,
        comboParts,
        highlight,
    };
})();
