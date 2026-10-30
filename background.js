import { buildRows, applyHistory, productReference } from './core.js';

const DEFAULTS = { token: '', igUserId: '', graphVersion: 'v26.0', igUsers: [], fbPages: [], limit: 50 };
const MAX_CAPTURED = 5000;
const hostIs = (hostname, domain) => hostname === domain || hostname.endsWith(`.${domain}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let chain = Promise.resolve();
const serial = (fn) => (chain = chain.catch(() => {}).then(fn)); // serialize storage writes

async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...settings };
}

// ---------- captured posts ----------
const addPosts = (posts) => serial(async () => {
  const { captured = {} } = await chrome.storage.local.get('captured');
  const now = Date.now();
  let added = 0;
  for (const p of posts || []) {
    // The page is untrusted input: validate everything coming from the content script.
    if (!p || typeof p.key !== 'string' || typeof p.text !== 'string' || !p.text) continue;
    if (!['facebook', 'instagram', 'facebook marketplace', 'daraz marketplace', 'bikroy'].includes(p.source)) continue;
    let url = '';
    if (typeof p.url === 'string') {
      try {
        const parsed = new URL(p.url);
        const facebookUrl = ['facebook', 'facebook marketplace'].includes(p.source)
          && parsed.protocol === 'https:' && hostIs(parsed.hostname, 'facebook.com');
        const instagramUrl = p.source === 'instagram'
          && parsed.protocol === 'https:' && hostIs(parsed.hostname, 'instagram.com');
        const darazUrl = p.source === 'daraz marketplace'
          && parsed.protocol === 'https:' && hostIs(parsed.hostname, 'daraz.com.bd');
        const bikroyUrl = p.source === 'bikroy'
          && parsed.protocol === 'https:' && parsed.hostname === 'bikroy.com'
          && parsed.pathname.endsWith('.html');
        if (facebookUrl || instagramUrl || darazUrl || bikroyUrl) url = parsed.href;
      } catch {
        url = '';
      }
    }
    if (!captured[p.key]) added++;
    captured[p.key] = {
      source: p.source,
      handle: String(p.handle || '').slice(0, 80),
      text: p.text.slice(0, 3000),
      url,
      ts: typeof p.ts === 'string' ? p.ts.slice(0, 30) : '',
      seen: captured[p.key]?.seen ?? now,
      updated: now,
    };
  }
  const keys = Object.keys(captured);
  if (keys.length > MAX_CAPTURED) {
    keys.sort((a, b) => captured[a].updated - captured[b].updated)
      .slice(0, keys.length - MAX_CAPTURED)
      .forEach((k) => delete captured[k]);
  }
  await chrome.storage.local.set({ captured });
  return { added, total: Object.keys(captured).length };
});

// ---------- Meta Graph API ----------
async function graph(path, params, warnings, source) {
  const s = await getSettings();
  const version = /^v\d+\.\d+$/.test(s.graphVersion) ? s.graphVersion : DEFAULTS.graphVersion;
  const u = new URL(`https://graph.facebook.com/${version}/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  try {
    const r = await fetch(u, { credentials: 'omit' });
    const j = await r.json().catch(() => null);
    if (!r.ok) { warnings.push(`${source}: ${j?.error?.message || `Meta API HTTP ${r.status}`}`); return null; }
    return j;
  } catch {
    warnings.push(`${source}: network request failed. Check your connection and extension permissions.`);
    return null;
  }
}

async function fetchInstagram(s, warnings) {
  const out = [];
  if (!/^\d+$/.test(s.igUserId)) {
    warnings.push('Instagram: your Instagram Professional account ID must contain digits only.');
    return out;
  }
  for (const user of s.igUsers) {
    if (!/^[A-Za-z0-9._]{1,30}$/.test(user)) {
      warnings.push(`Instagram: "${user}" is not a valid username.`);
      continue;
    }
    const fields = `business_discovery.username(${user}){username,media.limit(${s.limit}){caption,permalink,timestamp}}`;
    const data = await graph(s.igUserId, { fields, access_token: s.token }, warnings, `Instagram @${user}`);
    const bd = data?.business_discovery;
    for (const m of bd?.media?.data || []) {
      out.push({ source: 'instagram', handle: bd.username || user, text: m.caption || '', url: m.permalink || '', ts: m.timestamp || '' });
    }
    if (data && !bd?.media?.data?.length) warnings.push(`Instagram @${user}: no media returned.`);
    await sleep(500);
  }
  return out;
}

async function fetchFacebook(s, warnings) {
  const out = [];
  for (const page of s.fbPages) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(page)) {
      warnings.push(`Facebook Page "${page}" is not a valid Page ID or username.`);
      continue;
    }
    const data = await graph(`${encodeURIComponent(page)}/feed`, {
      fields: 'message,permalink_url,created_time', limit: s.limit, access_token: s.token,
    }, warnings, `Facebook Page ${page}`);
    for (const m of data?.data || []) {
      out.push({ source: 'facebook', handle: String(page), text: m.message || '', url: m.permalink_url || '', ts: m.created_time || '' });
    }
    if (data && !data?.data?.length) warnings.push(`Facebook Page ${page}: no posts returned.`);
    await sleep(500);
  }
  return out;
}

async function testMeta() {
  const s = await getSettings();
  if (!s.token) return { error: 'Add a Meta access token in Settings, then test again.' };
  if (!s.igUsers.length && !s.fbPages.length) {
    return { error: 'Add at least one Instagram username or Facebook Page ID in Settings.' };
  }

  const testSettings = { ...s, limit: 1 };
  const results = [];
  if (s.igUsers.length) {
    if (!s.igUserId) {
      results.push({ source: 'Instagram', error: 'Add your Instagram Professional account ID in Settings.' });
    } else {
      const warnings = [];
      const posts = await fetchInstagram(testSettings, warnings);
      results.push({ source: 'Instagram', posts: posts.length, warnings });
    }
  }
  if (s.fbPages.length) {
    const warnings = [];
    const posts = await fetchFacebook(testSettings, warnings);
    results.push({ source: 'Facebook', posts: posts.length, warnings });
  }
  return { results };
}

function createDemoListings(query) {
  const listings = [];
  for (const source of ['facebook', 'instagram', 'facebook marketplace', 'daraz marketplace']) {
    for (let i = 1; i <= 3; i++) {
      const price = Math.floor(1000 + Math.random() * 49000);
      listings.push({
        source: `${source} (demo)`,
        handle: `sample_${source}_${i}`,
        text: `${query} ৳${price}`,
        url: '',
        ts: '',
      });
    }
  }
  return listings;
}

// ---------- compare ----------
async function compare({ query, description = '', opts }) {
  const warnings = [];
  const reference = productReference(query);
  const details = String(description || '').trim();
  const minPrice = opts.minPrice ?? null;
  const maxPrice = opts.maxPrice ?? null;
  if ((minPrice !== null && (!Number.isFinite(minPrice) || minPrice < 0))
    || (maxPrice !== null && (!Number.isFinite(maxPrice) || maxPrice < 0))) {
    return { error: 'Preferred prices must be valid non-negative amounts in taka.' };
  }
  if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
    return { error: 'Minimum preferred price cannot be greater than maximum preferred price.' };
  }
  if (!reference) {
    return {
      rows: [],
      summary: null,
      warnings: ['Enter a product name or model as the search reference. Prices are extracted from matching posts.'],
      scanned: 0,
    };
  }
  const s = await getSettings();
  const posts = [];
  if (opts.useCaptured || opts.facebookMarketplace || opts.darazMarketplace || opts.bikroyMarketplace) {
    const { captured = {} } = await chrome.storage.local.get('captured');
    posts.push(...Object.values(captured).filter((post) => {
      if (post.source === 'facebook marketplace') return !!opts.facebookMarketplace;
      if (post.source === 'daraz marketplace') return !!opts.darazMarketplace;
      if (post.source === 'bikroy') return !!opts.bikroyMarketplace;
      return !!opts.useCaptured;
    }));
  }
  if (opts.api) {
    if (!s.token) warnings.push('Meta API: no access token set (Settings).');
    else {
      if (s.igUserId && s.igUsers.length) posts.push(...await fetchInstagram(s, warnings));
      else if (s.igUsers.length) warnings.push('Meta API: Instagram needs your IG user ID (Settings).');
      if (s.fbPages.length) posts.push(...await fetchFacebook(s, warnings));
      if (!s.igUsers.length && !s.fbPages.length) warnings.push('Meta API: no Instagram handles or Page IDs set (Settings).');
    }
  }
  if (opts.demo) posts.push(...createDemoListings(`${reference} ${details}`.trim()));

  const rows = buildRows(posts, reference, {
    threshold: opts.threshold,
    strict: opts.strict,
    exact: opts.exact,
    description: details,
    minPrice,
    maxPrice,
  });
  if (!rows.length) return { rows: [], summary: null, warnings, scanned: posts.length };

  const summary = await serial(async () => {
    const { history = {} } = await chrome.storage.local.get('history');
    const priceRange = minPrice === null && maxPrice === null
      ? ''
      : ` [৳${minPrice ?? 0}-${maxPrice ?? 'any'}]`;
    const historyReference = `${reference} ${details}${priceRange}`.trim();
    const historyQuery = opts.demo ? `[demo] ${historyReference}` : historyReference;
    const sm = applyHistory(history, historyQuery, rows);
    await chrome.storage.local.set({ history });
    return sm;
  });
  return { rows, summary, warnings, scanned: posts.length };
}

// ---------- messages ----------
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  (async () => {
    switch (msg?.type) {
      case 'posts': return addPosts(msg.posts);
      case 'compare': return compare(msg);
      case 'testMeta': return testMeta();
      case 'stats': {
        const { captured = {} } = await chrome.storage.local.get('captured');
        return { total: Object.keys(captured).length };
      }
      case 'clear': await serial(() => chrome.storage.local.remove('captured')); return { total: 0 };
      default: return { error: 'unknown message' };
    }
  })().then(respond).catch((e) => respond({ error: String(e?.message || e) }));
  return true;
});
