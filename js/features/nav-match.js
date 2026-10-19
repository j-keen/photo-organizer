/*
 * Korean-aware text matching shared by the nav team (folder-tree filter, search box, suggestions).
 *
 *   App.navMatch.match(text, query) -> { score, ranges: [[start, end], ...], exact } | null
 *   App.navMatch.initials('김수현')    -> 'ㄱㅅㅎ'
 *   App.navMatch.normalize(text)      -> NFC text (macOS writes Hangul file names decomposed — NFD)
 *   App.navMatch.highlight(text, ranges) -> DocumentFragment with <mark class="hl"> around the matched runs
 *   App.navMatch.josa(word, '을/를' | '이/가' | '은/는' | '와/과' | '으로/로') -> the right particle for word
 *   App.navMatch.hasHangul(text)
 *
 * Query semantics: whitespace-separated words; every word must match somewhere (any order). A word matches a run
 * of characters where each query character equals the text character (case-insensitive) or is the initial
 * consonant (초성) of that syllable — 'ㄱㅅ' finds '김수현', '김ㅅ' too. The last query character may still be
 * in IME composition: '기' already finds '김', and '갑' finds '가비' (the ㅂ is about to become the next syllable).
 * App.util.matchKo / App.palette.match are consulted as extra recall when another team provides them.
 */
(() => {
    'use strict';

    const BASE = 0xac00;
    const LAST = 0xd7a3;
    const CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
    const CHO_SET = new Set(CHO);
    // Final consonant index -> compatibility jamo (only simple finals can turn into the next syllable's initial)
    const JONG = ['', 'ㄱ', 'ㄲ', '', 'ㄴ', '', '', 'ㄷ', 'ㄹ', '', '', '', '', '', '', '', 'ㅁ', 'ㅂ', '', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
    const BOUNDARY = /[\s_\-.()[\]{}·,]/;

    const isSyllable = (code) => code >= BASE && code <= LAST;

    function choOf(ch) {
        const c = ch.charCodeAt(0);
        return isSyllable(c) ? CHO[Math.floor((c - BASE) / 588)] : null;
    }

    function parts(code) {
        const s = code - BASE;
        return { cho: Math.floor(s / 588), jung: Math.floor((s % 588) / 28), jong: s % 28 };
    }

    function normalize(text) {
        const s = String(text ?? '');
        try {
            return s.normalize('NFC');
        } catch (e) {
            return s;
        }
    }

    // Lower-case without changing string length, so match ranges map 1:1 onto the displayed (NFC) text
    function lower(text) {
        let out = '';
        for (const ch of text) {
            const l = ch.toLowerCase();
            out += l.length === ch.length ? l : ch;
        }
        return out;
    }

    function hasHangul(text) {
        return /[ㄱ-ㆎ가-힣]/.test(text || '');
    }

    function initials(text) {
        let out = '';
        for (const ch of normalize(text)) out += choOf(ch) || ch.toLowerCase();
        return out;
    }

    // 0 = no match, 1 = one text char, 2 = consumed two text chars ('갑' ~ '가비'); `exact` reports literal equality
    function charMatch(q, t, isLast, tNext) {
        if (q === t) return 1;
        if (CHO_SET.has(q)) return choOf(t) === q ? 1 : 0;
        if (!isLast) return 0;
        const qc = q.charCodeAt(0);
        const tc = t.charCodeAt(0);
        if (!isSyllable(qc) || !isSyllable(tc)) return 0;
        const a = parts(qc);
        const b = parts(tc);
        if (a.cho !== b.cho || a.jung !== b.jung) return 0;
        if (a.jong === 0) return 1; // '기' while typing '김'
        if (b.jong === 0 && tNext && JONG[a.jong] && choOf(tNext) === JONG[a.jong]) return 2; // '갑' while typing '가비'
        return 0;
    }

    function matchWord(text, word) {
        const n = text.length;
        const m = word.length;
        let best = null;
        for (let i = 0; i < n; i++) {
            let ti = i;
            let exact = true;
            let ok = true;
            for (let qi = 0; qi < m; qi++) {
                if (ti >= n) {
                    ok = false;
                    break;
                }
                const r = charMatch(word[qi], text[ti], qi === m - 1, text[ti + 1]);
                if (!r) {
                    ok = false;
                    break;
                }
                if (r !== 1 || word[qi] !== text[ti]) exact = false;
                ti += r;
            }
            if (!ok) continue;
            let score = 1 + (m / Math.max(n, 1)) * 2;
            if (i === 0) score += 8;
            else if (BOUNDARY.test(text[i - 1])) score += 4;
            if (exact) score += 2;
            if (!best || score > best.score) best = { start: i, end: ti, score, exact };
            if (i === 0) break; // a prefix match can't be beaten
        }
        return best;
    }

    function externalMatch(text, query) {
        const fn = App.util?.matchKo || App.palette?.match;
        if (typeof fn !== 'function' || fn === match) return null;
        try {
            const r = fn(text, query);
            if (r === true) return { score: 0.5, ranges: [], exact: false };
            if (typeof r === 'number') return r > 0 ? { score: 0.5, ranges: [], exact: false } : null;
            if (Array.isArray(r)) return r.length ? { score: 0.5, ranges: [], exact: false } : null;
            if (r && typeof r === 'object' && (r.score == null || r.score > 0)) return { score: 0.5, ranges: Array.isArray(r.ranges) ? r.ranges : [], exact: false };
        } catch (e) {
            /* foreign matcher failed — ignore */
        }
        return null;
    }

    /** match(text, query) -> { score, ranges, exact } | null. Ranges index into normalize(text). */
    function match(text, query) {
        const t = lower(normalize(text));
        const words = lower(normalize(query)).split(/\s+/).filter(Boolean);
        if (!words.length) return null;
        let score = 0;
        let exact = true;
        const ranges = [];
        for (const w of words) {
            const hit = matchWord(t, w);
            if (!hit) return externalMatch(text, query);
            score += hit.score;
            exact = exact && hit.exact;
            ranges.push([hit.start, hit.end]);
        }
        return { score: score - t.length * 0.01, ranges, exact };
    }

    function mergeRanges(ranges) {
        const sorted = (ranges || []).filter((r) => r && r[1] > r[0]).map((r) => [r[0], r[1]]).sort((a, b) => a[0] - b[0]);
        const out = [];
        for (const r of sorted) {
            const last = out[out.length - 1];
            if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
            else out.push(r);
        }
        return out;
    }

    /** Fragment of `text` (already NFC) with <mark class="hl"> around ranges */
    function highlight(text, ranges) {
        const frag = document.createDocumentFragment();
        let pos = 0;
        for (const [s, e] of mergeRanges(ranges)) {
            if (s > pos) frag.append(text.slice(pos, s));
            const mark = document.createElement('mark');
            mark.className = 'hl';
            mark.textContent = text.slice(s, e);
            frag.append(mark);
            pos = e;
        }
        if (pos < text.length) frag.append(text.slice(pos));
        return frag;
    }

    // 'jong' | 'rieul' | 'none' | null (unknown, e.g. Latin letters)
    function finalSound(word) {
        const s = normalize(word).replace(/[\s'"’‘”“)\]]+$/, '');
        const last = s.slice(-1);
        if (!last) return null;
        const c = last.charCodeAt(0);
        if (isSyllable(c)) {
            const j = (c - BASE) % 28;
            return j === 0 ? 'none' : j === 8 ? 'rieul' : 'jong';
        }
        if (/[0-9]/.test(last)) return { 0: 'jong', 1: 'rieul', 3: 'jong', 6: 'jong', 7: 'rieul', 8: 'rieul' }[last] || 'none';
        return null;
    }

    /** josa('여행', '으로/로') -> '으로'; unknown endings get the combined form like '을(를)' */
    function josa(word, pair) {
        const [withJong, without] = pair.split('/');
        const f = finalSound(word);
        if (withJong === '으로') {
            if (f == null) return '(으)로';
            return f === 'jong' ? '으로' : '로';
        }
        if (f == null) return `${withJong}(${without})`;
        return f === 'none' ? without : withJong;
    }

    /** prepare(text) -> NFC + lower-case form; matchPrepared(preparedText, preparedWord) -> hit | null (hot loops) */
    function prepare(text) {
        return lower(normalize(text));
    }

    function matchPrepared(text, word) {
        return word ? matchWord(text, word) : null;
    }

    App.navMatch = { match, matchPrepared, prepare, initials, normalize, highlight, josa, hasHangul, mergeRanges, choOf };
})();
