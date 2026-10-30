// Shared logic (ES module): price extraction, product matching, history, robots.txt.

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';

export function normalize(s) {
  return String(s ?? '')
    .replace(/[০-৯]/g, (d) => BN_DIGITS.indexOf(d))
    .replace(/\u200c/g, '')
    .toLowerCase();
}

// ---------- prices ----------
const NUM = String.raw`\d+(?:,\d{2,3})*(?:\.\d+)?`;
const PRICE_BEFORE = new RegExp(
  String.raw`(?:৳|tk\.?|bdt|taka|price\s*[:\-]?|মূল্য\s*[:\-]?|দাম\s*[:\-]?)\s*(${NUM})`, 'gi');
const PRICE_AFTER = new RegExp(
  String.raw`(${NUM})\s*(?:/-|৳|tk\b|taka\b|bdt\b|টাকা)`, 'gi');

export function extractPrices(text, minPrice = 10) {
  const t = normalize(text);
  const priceText = t.replace(
    new RegExp(String.raw`(?:coins?\s+)?save(?:\s+up\s+to)?\s*(?:৳|tk\.?|bdt|taka)\s*${NUM}`, 'gi'),
    ' ',
  );
  const found = new Set();
  for (const rx of [PRICE_BEFORE, PRICE_AFTER]) {
    for (const m of priceText.matchAll(rx)) {
      const v = parseFloat(m[1].replace(/,/g, ''));
      if (v >= minPrice) found.add(v);
    }
  }
  return [...found].sort((a, b) => a - b);
}

// ---------- matching ----------
export function tokens(s) {
  return normalize(s)
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(Boolean);
}

export function productReference(query) {
  const amount = String.raw`\d+(?:,\d{2,3})*(?:\.\d+)?`;
  return normalize(query)
    .replace(new RegExp(String.raw`(?:৳|tk\.?|bdt|taka|price\s*[:\-]?|মূল্য\s*[:\-]?|দাম\s*[:\-]?)\s*${amount}(?:\s*(?:৳|tk\b|taka\b|bdt\b|টাকা))?`, 'gi'), ' ')
    .replace(new RegExp(String.raw`${amount}\s*(?:/-|৳|tk\b|taka\b|bdt\b|টাকা)`, 'gi'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lev(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

function fuzzyEq(a, b) {
  if (/\d/.test(a) || /\d/.test(b)) return false; // model numbers must match exactly
  const m = Math.max(a.length, b.length);
  if (m < 5) return false;
  const maxEdits = m >= 9 ? 2 : 1; // allow 1 typo (2 for long words)
  return Math.abs(a.length - b.length) <= maxEdits && lev(a, b) <= maxEdits;
}

// 0-100: share of query tokens found in the text (typos tolerated).
// Strict mode: every token containing a digit (15, 128, a55) must appear as a whole token.
export function matchScore(query, text, strict = true) {
  const q = [...new Set(tokens(productReference(query)))];
  if (!q.length) return 0;
  const tt = tokens(text);
  const ts = new Set(tt);
  if (strict) for (const t of q) if (/\d/.test(t) && !ts.has(t)) return 0;
  let hit = 0;
  for (const t of q) {
    if (ts.has(t) || tt.some((x) => fuzzyEq(t, x))) hit++;
  }
  return Math.round((100 * hit) / q.length);
}

export function exactMatch(query, text) {
  const queryTerms = [...new Set(tokens(productReference(query)))];
  if (!queryTerms.length) return false;
  const textTerms = tokens(text);
  return textTerms.some((_, start) =>
    queryTerms.every((term, offset) => textTerms[start + offset] === term));
}

export function containsTerms(query, text) {
  const required = [...new Set(tokens(query))];
  if (!required.length) return true;
  const available = new Set(tokens(text));
  return required.every((term) => available.has(term));
}

// ---------- rows ----------
export function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function buildRows(posts, query, {
  threshold = 80, strict = true, exact = false, description = '',
  minPrice = null, maxPrice = null,
} = {}) {
  const reference = productReference(query);
  if (!tokens(reference).length) return [];
  const rows = [];
  const seen = new Set();
  for (const p of posts) {
    const text = p.text || '';
    const dk = `${p.handle}|${p.url || text.slice(0, 80)}`;
    if (seen.has(dk)) continue;
    seen.add(dk);
    const score = matchScore(reference, text, strict);
    if (score < threshold
      || (exact && !exactMatch(reference, text))
      || !containsTerms(description, text)) continue;
    let prices;
    let via = 'caption';
    if (typeof p.price === 'number') { prices = [p.price]; via = 'listing'; }
    else prices = extractPrices(text);
    if (!prices.length) continue;
    const price = Math.min(...prices);
    if ((minPrice !== null && price < minPrice)
      || (maxPrice !== null && price > maxPrice)) continue;
    rows.push({
      key: p.url || text.slice(0, 60),
      price, // lowest = offer price when old/new are both listed
      allPrices: prices,
      score,
      priceFrom: via,
      source: p.source,
      handle: p.handle || '',
      date: (p.ts || '').slice(0, 10),
      url: p.url || '',
      snippet: text.replace(/\s+/g, ' ').slice(0, 180),
      details: text.replace(/\s+/g, ' ').slice(0, 1000),
      prev: null,
      change: '',
    });
  }
  rows.sort((a, b) => b.score - a.score || a.price - b.price);
  return rows;
}

// ---------- history ----------
// store: { [normalizedQuery]: { last: {"handle|key": price}, low, series: [{ts,min,median,n}] } }
export function applyHistory(store, query, rows, now = new Date().toISOString()) {
  const id = normalize(query).trim();
  const h = store[id] ?? { last: {}, low: null, series: [] };
  const first = h.low === null;
  let changed = 0;
  let fresh = 0;
  const seenNow = {};
  for (const r of rows) {
    const k = `${r.handle}|${r.key}`;
    const old = h.last[k];
    if (old === undefined) {
      if (!first) { r.change = 'new'; fresh++; }
    } else {
      r.prev = old;
      if (r.price === old) r.change = 'same';
      else { const d = r.price - old; r.change = (d > 0 ? '+' : '') + d; changed++; }
    }
    seenNow[k] = r.price;
  }
  const prices = rows.map((r) => r.price);
  const min = Math.min(...prices);
  const summary = {
    first, changed, fresh, prevLow: h.low, newLow: !first && min < h.low,
    min, median: median(prices), max: Math.max(...prices), n: rows.length,
  };
  h.low = first ? min : Math.min(h.low, min);
  h.last = { ...h.last, ...seenNow };
  const keys = Object.keys(h.last);
  if (keys.length > 3000) h.last = seenNow;
  h.series = [...h.series, { ts: now, min, median: summary.median, n: rows.length }].slice(-60);
  store[id] = h;
  summary.series = h.series;
  return summary;
}

// ---------- robots.txt (minimal: User-agent: * group, longest match wins) ----------
export function robotsAllows(txt, path) {
  const rules = [];
  let agents = [];
  let sawRule = false;
  for (let line of String(txt).split(/\r?\n/)) {
    line = line.replace(/#.*/, '').trim();
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (k === 'user-agent') {
      if (sawRule) { agents = []; sawRule = false; }
      agents.push(v.toLowerCase());
    } else if (k === 'allow' || k === 'disallow') {
      sawRule = true;
      if (agents.includes('*') && v) rules.push({ allow: k === 'allow', pat: v });
    }
  }
  let best = null;
  for (const r of rules) {
    const re = new RegExp('^' + r.pat
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\\\$$/, '$'));
    if (!re.test(path)) continue;
    if (!best || r.pat.length > best.pat.length || (r.pat.length === best.pat.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}
