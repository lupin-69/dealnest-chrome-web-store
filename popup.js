import { productReference } from './core.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const SUPPORTED = /^https:\/\/([a-z0-9-]+\.)*(facebook|instagram)\.com\/|^https:\/\/www\.daraz\.com\.bd\/catalog\/|^https:\/\/bikroy\.com\/mobile-phones-tablets/;
const SITES = [
  { id: 'facebook', label: 'Facebook posts', initials: 'f', url: (q) => `https://www.facebook.com/search/posts/?q=${q}` },
  { id: 'instagram', label: 'Instagram', initials: 'ig', url: (q) => `https://www.instagram.com/explore/search/keyword/?q=${q}` },
  { id: 'facebookMarketplace', label: 'Facebook Marketplace', initials: 'fm', url: (q) => `https://www.facebook.com/marketplace/search/?query=${q}` },
  { id: 'daraz', label: 'Daraz', initials: 'd', url: (q) => `https://www.daraz.com.bd/catalog/?q=${q}` },
  { id: 'bikroy', label: 'Bikroy · Phones', initials: 'b', url: (q) => `https://bikroy.com/mobile-phones-tablets?query=${q}` },
];
const DEFAULT_SITES = SITES.map(({ id }) => id);
const LEGACY_SITE_PREFS = {
  facebook: 'searchFacebook',
  instagram: 'searchInstagram',
  facebookMarketplace: 'searchFbMarketplace',
  daraz: 'searchDaraz',
  bikroy: 'searchBikroy',
};
let tab = null;
let lastRows = [];
let selectedSites = [...DEFAULT_SITES];

const send = (msg) => chrome.runtime.sendMessage(msg);

async function toContent(msg, inject = false) {
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    if (!inject) throw e;
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tab.id, msg);
  }
}

// ---------- UI prefs ----------
const PREF_IDS = [
  'useCap', 'useApi', 'useFbMarketplace', 'useDarazMarketplace', 'useBikroy',
  'demo', 'exact', 'strict',
];
async function loadPrefs() {
  const { ui = {} } = await chrome.storage.local.get('ui');
  if (ui.q) $('q').value = ui.q;
  if (ui.description) $('description').value = ui.description;
  if (ui.minPrice !== undefined) $('minPrice').value = ui.minPrice;
  if (ui.maxPrice !== undefined) $('maxPrice').value = ui.maxPrice;
  selectedSites = Array.isArray(ui.searchSites)
    ? ui.searchSites.filter((id) => SITES.some((site) => site.id === id))
    : SITES.filter((site) => ui[LEGACY_SITE_PREFS[site.id]] !== false).map(({ id }) => id);
  for (const id of PREF_IDS) if (id in ui) $(id).checked = ui[id];
  if (ui.thr) $('thr').value = ui.thr;
  $('auto').checked = ui.autoCapture !== false;
  if (ui.maxPosts) $('maxPosts').value = ui.maxPosts;
  renderSitePicker();
}
function savePrefs() {
  const ui = {
    q: $('q').value,
    description: $('description').value,
    minPrice: $('minPrice').value,
    maxPrice: $('maxPrice').value,
    thr: $('thr').value,
    autoCapture: $('auto').checked,
    maxPosts: Math.min(1000, Math.max(10, Number($('maxPosts').value) || 200)),
    searchSites: [...selectedSites],
  };
  $('maxPosts').value = ui.maxPosts;
  for (const id of PREF_IDS) ui[id] = $(id).checked;
  chrome.storage.local.set({ ui });
}

function renderSitePicker() {
  const available = $('availableSites');
  const selected = $('selectedSites');
  available.replaceChildren();
  selected.replaceChildren();

  for (const site of SITES) {
    const isSelected = selectedSites.includes(site.id);
    const button = el('button', {
      type: 'button',
      className: `site-chip${isSelected ? ' is-selected' : ''}`,
      draggable: true,
      title: `${isSelected ? 'Remove' : 'Add'} ${site.label}`,
    });
    button.dataset.site = site.id;
    button.dataset.tray = isSelected ? 'selected' : 'available';
    button.setAttribute('aria-pressed', String(isSelected));
    button.append(
      el('span', { className: `site-icon site-${site.id}`, 'aria-hidden': 'true' }, site.initials),
      el('span', { className: 'site-name' }, site.label),
      el('span', { className: 'site-action', 'aria-hidden': 'true' }, isSelected ? '×' : '+'),
    );
    (isSelected ? selected : available).append(button);
  }
  $('selectedCount').textContent = `${selectedSites.length} selected`;
  $('searchMarketplaces').disabled = selectedSites.length === 0;
  available.classList.toggle('is-empty', available.childElementCount === 0);
  selected.classList.toggle('is-empty', selected.childElementCount === 0);
  available.dataset.emptyMessage = available.childElementCount === 0
    ? 'All sources are selected'
    : 'Drop here to add a source';
  selected.dataset.emptyMessage = selected.childElementCount === 0
    ? 'Drag or tap a source to add it'
    : 'Drop sources here';
}

function moveSite(siteId, destination, targetSite = '') {
  if (!SITES.some((site) => site.id === siteId)) return;
  const currentIndex = selectedSites.indexOf(siteId);
  if (destination === 'selected') {
    if (currentIndex === -1) {
      const targetIndex = selectedSites.indexOf(targetSite);
      if (targetIndex === -1) selectedSites.push(siteId);
      else selectedSites.splice(targetIndex, 0, siteId);
    } else if (targetSite && targetSite !== siteId) {
      selectedSites.splice(currentIndex, 1);
      const targetIndex = selectedSites.indexOf(targetSite);
      selectedSites.splice(targetIndex < 0 ? selectedSites.length : targetIndex, 0, siteId);
    } else {
      return;
    }
  } else if (currentIndex !== -1) {
    selectedSites.splice(currentIndex, 1);
  } else {
    return;
  }
  renderSitePicker();
  savePrefs();
}

function initializeSitePicker() {
  const trays = [$('availableSites'), $('selectedSites')];
  for (const tray of trays) {
    tray.addEventListener('click', (event) => {
      const button = event.target.closest('[data-site]');
      if (!button) return;
      moveSite(button.dataset.site, button.dataset.tray === 'selected' ? 'available' : 'selected');
    });
    tray.addEventListener('dragstart', (event) => {
      const button = event.target.closest('[data-site]');
      if (!button || !event.dataTransfer) return;
      event.dataTransfer.setData('text/plain', button.dataset.site);
      event.dataTransfer.effectAllowed = 'move';
      button.classList.add('is-dragging');
    });
    tray.addEventListener('dragend', (event) => {
      event.target.closest('[data-site]')?.classList.remove('is-dragging');
    });
    tray.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    });
    tray.addEventListener('drop', (event) => {
      event.preventDefault();
      const siteId = event.dataTransfer?.getData('text/plain');
      const targetSite = event.target.closest('[data-site]')?.dataset.site || '';
      moveSite(siteId, tray.id === 'selectedSites' ? 'selected' : 'available', targetSite);
    });
  }
}

// ---------- capture panel ----------
async function refreshCapture() {
  const st = await send({ type: 'stats' }).catch(() => null);
  if (st) $('capCount').textContent = st.total;
  if (!tab || !SUPPORTED.test(tab.url || '')) {
    $('capMsg').textContent = 'Auto-capture is enabled for Facebook, Instagram, Daraz and Bikroy search results.';
    $('capture').disabled = true;
    $('auto').disabled = true;
    return;
  }
  $('capture').disabled = false;
  $('auto').disabled = false;
  try {
    const p = await toContent({ type: 'ping' });
    $('capMsg').textContent = p.auto
      ? `${p.status} ${p.pageCaptured}/${p.maxPosts} unique listings/posts captured on this page (${p.found} currently visible).`
      : `${p.found} post(s) visible on this page.`;
  } catch {
    $('capMsg').textContent = 'Automatic capture will start when the page loads. Refresh this tab if it was open before reloading the extension.';
  }
}

async function capture() {
  $('capture').disabled = true;
  try {
    const r = await toContent({ type: 'capture' }, true);
    $('capMsg').textContent = r.error
      ? r.error
      : r.found === 0
        ? 'No posts found on this page. Scroll so posts are visible, or open a page/profile.'
        : `Found ${r.found} post(s), ${r.added ?? 0} new. Total stored: ${r.total ?? '?'}.`;
  } catch (e) {
    $('capMsg').textContent = `Could not read this tab (${e.message}).`;
  }
  $('capture').disabled = false;
  refreshCapture();
}

// ---------- compare ----------
function el(tag, props = {}, text) {
  const n = Object.assign(document.createElement(tag), props);
  if (text !== undefined) n.textContent = text;
  return n;
}

function sparkline(series) {
  const pts = series.map((s) => s.min);
  if (pts.length < 2) return null;
  const w = 80, h = 20, lo = Math.min(...pts), hi = Math.max(...pts);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', w); svg.setAttribute('height', h);
  const d = pts.map((v, i) => `${(i / (pts.length - 1)) * w},${hi === lo ? h / 2 : h - 2 - ((v - lo) / (hi - lo)) * (h - 4)}`).join(' ');
  const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  pl.setAttribute('points', d); pl.setAttribute('fill', 'none');
  pl.setAttribute('stroke', 'currentColor'); pl.setAttribute('stroke-width', '1.5');
  svg.appendChild(pl);
  const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
  t.textContent = 'Lowest price per run';
  svg.appendChild(t);
  return svg;
}

function render(res) {
  const tb = $('tbl').querySelector('tbody');
  tb.replaceChildren();
  $('warnings').replaceChildren(...(res.warnings || []).map((w) => el('div', { className: 'warn' }, w)));
  $('summary').replaceChildren();
  lastRows = res.rows || [];
  $('tbl').hidden = !lastRows.length;
  $('export').hidden = !lastRows.length;

  if (!lastRows.length) {
    $('status').textContent = $('description').value.trim()
      ? `${res.scanned} posts scanned; none matched the product, price, and every description/condition term.`
      : $('minPrice').value || $('maxPrice').value
      ? `${res.scanned} posts scanned; no matching listings were within the preferred price range.`
      : $('exact').checked
      ? `${res.scanned} posts scanned; no exact product matches with a price. Turn off "Exact product terms only" to include suggestions.`
      : `${res.scanned} posts scanned, none matched with a price. Try lowering "Min match" or turning off strict matching.`;
    return;
  }
  $('status').textContent = `${res.scanned} posts scanned · ${lastRows.length} matching listings.`;
  const s = res.summary;
  const bestMatch = lastRows[0];
  const bestOffer = lastRows.find((row) => row.price === s.min) || bestMatch;
  const line = el('div', {},
    `${s.n} matches · best match ${bestMatch.handle || bestMatch.source} (${bestMatch.score}%) · ` +
    `lowest offer ৳${fmt(s.min)} from ${bestOffer.handle || bestOffer.source} · ` +
    `median ৳${fmt(s.median)} · max ৳${fmt(s.max)}`);
  const sp = sparkline(s.series);
  if (sp) line.appendChild(sp);
  if (!s.first) {
    line.appendChild(el('span', { className: 'sub' },
      `vs last run: ${s.changed} price change(s), ${s.fresh} new listing(s)` +
      (s.newLow ? `, NEW ALL-TIME LOW (prev ৳${fmt(s.prevLow)})` : '')));
  }
  $('summary').appendChild(line);

  for (const [index, r] of lastRows.entries()) {
    const tr = el('tr');
    const priceCell = el('td', {
      className: 'price',
      title: `All prices: ${r.allPrices.map((price) => `৳${fmt(price)}`).join(', ')} · Extracted from ${r.priceFrom}`,
    }, `৳${fmt(r.price)}`);
    if (index === 0) priceCell.title = `Lowest matching price · ${priceCell.title}`;
    tr.appendChild(priceCell);

    let changeText = '—';
    if (r.prev !== null) {
      if (r.change === 'same') changeText = `৳${fmt(r.prev)} · no change`;
      else {
        const difference = Number(r.change);
        changeText = `৳${fmt(r.prev)} · ${difference > 0 ? '+' : '−'}৳${fmt(Math.abs(difference))}`;
      }
    } else if (r.change === 'new') changeText = 'New listing';
    const ch = el('td', {}, changeText);
    if (r.change.startsWith('+')) ch.className = 'up';
    else if (r.change.startsWith('-')) ch.className = 'down';
    tr.appendChild(ch);
    tr.appendChild(el('td', { className: 'seller', title: r.handle }, r.handle || '—'));
    tr.appendChild(el('td', {}, r.source));
    tr.appendChild(el('td', { title: `Product match score: ${r.score}%` }, `${r.score}%`));
    const details = el('td', { className: 'details' });
    const disclosure = el('details');
    disclosure.appendChild(el('summary', {}, r.snippet));
    disclosure.appendChild(el('p', {}, r.details || r.snippet));
    details.appendChild(disclosure);
    tr.appendChild(details);
    tr.appendChild(el('td', {}, r.date || '—'));
    const td = el('td');
    if (/^https:\/\//.test(r.url)) {
      td.appendChild(el('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, 'open'));
    }
    tr.appendChild(td);
    tb.appendChild(tr);
  }
}

async function runCompare() {
  const query = $('q').value.trim();
  if (!query) { $('q').focus(); return; }
  savePrefs();
  $('go').disabled = true;
  $('status').textContent = 'Comparing…';
  try {
    const res = await send({
      type: 'compare', query, description: $('description').value.trim(),
      opts: {
        useCaptured: $('useCap').checked, api: $('useApi').checked,
        facebookMarketplace: $('useFbMarketplace').checked,
        darazMarketplace: $('useDarazMarketplace').checked,
        bikroyMarketplace: $('useBikroy').checked,
        demo: $('demo').checked,
        exact: $('exact').checked,
        strict: $('strict').checked, threshold: Number($('thr').value) || 80,
        minPrice: $('minPrice').value === '' ? null : Number($('minPrice').value),
        maxPrice: $('maxPrice').value === '' ? null : Number($('maxPrice').value),
      },
    });
    if (res?.error) $('status').textContent = `Error: ${res.error}`;
    else render(res);
  } catch (e) {
    $('status').textContent = `Error: ${e.message}`;
  }
  $('go').disabled = false;
}

async function searchMarketplaces() {
  const query = productReference(`${$('q').value} ${$('description').value}`);
  if (!query) {
    $('q').focus();
    $('status').textContent = 'Enter a product name/model before searching the marketplaces.';
    return;
  }
  savePrefs();
  $('searchMarketplaces').disabled = true;
  try {
    const encoded = encodeURIComponent(query);
    const searches = selectedSites
      .map((id) => SITES.find((site) => site.id === id))
      .filter(Boolean);
    if (!searches.length) {
      $('status').textContent = 'Select at least one site to search.';
      return;
    }
    await Promise.all(searches.map((site, index) =>
      chrome.tabs.create({ url: site.url(encoded), active: index === 0 })));
    $('status').textContent = `Opened ${searches.length} selected search page(s). Visible posts and listings will be captured as they load; return and click Compare after capture.`;
  } catch (error) {
    $('status').textContent = `Could not open marketplace search pages: ${error.message}`;
  } finally {
    $('searchMarketplaces').disabled = false;
  }
}

// ---------- CSV ----------
function exportCsv() {
  const cols = ['price', 'prev_price', 'change', 'all_prices', 'score', 'price_from', 'source', 'handle', 'date', 'url', 'snippet', 'details'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [cols.join(',')];
  for (const r of lastRows) {
    lines.push([r.price, r.prev ?? '', r.change, r.allPrices.join('|'), r.score, r.priceFrom,
      r.source, r.handle, r.date, r.url, r.snippet, r.details].map(esc).join(','));
  }
  const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `price_comparison_${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------- init ----------
$('go').addEventListener('click', runCompare);
$('description').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') runCompare();
});
$('description').addEventListener('input', savePrefs);
$('minPrice').addEventListener('input', savePrefs);
$('maxPrice').addEventListener('input', savePrefs);
$('searchMarketplaces').addEventListener('click', searchMarketplaces);
$('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') runCompare(); });
$('capture').addEventListener('click', capture);
$('export').addEventListener('click', exportCsv);
$('settings').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
$('clear').addEventListener('click', async () => {
  if (confirm('Delete all captured posts?')) { await send({ type: 'clear' }); refreshCapture(); }
});
$('auto').addEventListener('change', async (e) => {
  savePrefs();
  try {
    const r = await toContent({ type: 'auto', on: e.target.checked, maxPosts: $('maxPosts').value }, true);
    e.target.checked = r.auto;
  } catch (err) {
    $('capMsg').textContent = `Preference saved; automatic capture will start when this tab is refreshed. (${err.message})`;
  }
  refreshCapture();
});
$('maxPosts').addEventListener('change', () => {
  savePrefs();
  if (tab && SUPPORTED.test(tab.url || '')) {
    toContent({ type: 'auto', on: $('auto').checked, maxPosts: $('maxPosts').value }, true)
      .then(refreshCapture)
      .catch((error) => { $('capMsg').textContent = `Could not update page limit: ${error.message}`; });
  }
});
for (const id of [...PREF_IDS, 'thr']) $(id).addEventListener('change', savePrefs);

initializeSitePicker();
(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await loadPrefs();
  await refreshCapture();
  setInterval(refreshCapture, 2000);
})();
