// Captures listings rendered on Facebook/Instagram/Daraz and scrolls the current page with a user-set cap.
(() => {
  if (window.__pcLoaded) return;
  window.__pcLoaded = true;

  const IS_DARAZ = location.hostname === 'www.daraz.com.bd';
  const IS_BIKROY = location.hostname === 'bikroy.com';
  const IS_FB_MARKETPLACE = location.hostname.endsWith('facebook.com') && location.pathname.startsWith('/marketplace/');
  const SOURCE = IS_BIKROY ? 'bikroy'
    : IS_DARAZ ? 'daraz marketplace'
    : IS_FB_MARKETPLACE ? 'facebook marketplace'
      : location.hostname.includes('instagram') ? 'instagram' : 'facebook';
  const FB_LINK = /\/(posts|videos|photos?|reel|watch)\/|permalink\.php|story\.php|\/permalink\//;
  const IG_LINK = /\/(p|reel|tv)\/[^/]+/;
  const KEEP_PARAMS = ['story_fbid', 'id', 'fbid', 'v'];
  const IG_RESERVED = new Set(['p', 'reel', 'reels', 'tv', 'explore', 'accounts', 'direct', 'stories']);

  const textOf = (el) => (el.innerText ?? el.textContent ?? '').replace(/\u00a0/g, ' ');
  const hash = (s) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  };

  function postNodes() {
    if (IS_BIKROY) {
      return [...document.querySelectorAll('.qa-advert-list-item')];
    }
    if (IS_DARAZ) {
      const cards = [...document.querySelectorAll('[data-qa-locator="product-item"]')];
      if (cards.length) return cards;
      return [...new Set([...document.querySelectorAll('a[href*="/products/"]')]
        .map((anchor) => listingCard(anchor))
        .filter(Boolean))];
    }
    if (IS_FB_MARKETPLACE) {
      return [...new Set([...document.querySelectorAll('a[href*="/marketplace/item/"]')]
        .map((anchor) => listingCard(anchor))
        .filter(Boolean))];
    }
    if (SOURCE === 'facebook') {
      return [...document.querySelectorAll('div[role="article"]')]
        .filter((n) => !n.parentElement?.closest('[role="article"]')); // skip comments
    }
    const arts = [...document.querySelectorAll('article')];
    if (arts.length) return arts;
    if (IG_LINK.test(location.pathname)) {
      const m = document.querySelector('main');
      return m ? [m] : [];
    }
    return [];
  }

  function listingCard(anchor) {
    let node = anchor;
    for (let depth = 0; depth < 8 && node; depth++, node = node.parentElement) {
      const text = textOf(node).trim();
      const linkCount = node.querySelectorAll(IS_DARAZ
        ? 'a[href*="/products/"]'
        : 'a[href*="/marketplace/item/"]').length;
      if (text.length >= 10 && text.length <= 1800 && linkCount <= 2 && /৳|tk\.?|bdt|taka|টাকা/i.test(text)) {
        return node;
      }
    }
    return null;
  }

  function findLink(root) {
    const anchors = [...(root.matches('a[href]') ? [root] : []), ...root.querySelectorAll('a[href]')];
    for (const a of anchors) {
      let u;
      try { u = new URL(a.getAttribute('href'), location.href); } catch { continue; }
      if (IS_BIKROY) {
        if (u.hostname !== 'bikroy.com' || !u.pathname.endsWith('.html')) continue;
        u.search = '';
        u.hash = '';
        return u.toString();
      }
      if (IS_DARAZ) {
        if (u.hostname !== 'www.daraz.com.bd' || !u.pathname.startsWith('/products/')) continue;
        u.search = '';
        u.hash = '';
        return u.toString();
      }
      if (!/(^|\.)(facebook|instagram)\.com$/.test(u.hostname)) continue;
      const ok = IS_FB_MARKETPLACE
        ? /\/marketplace\/item\/\d+/.test(u.pathname)
        : SOURCE === 'instagram' ? IG_LINK.test(u.pathname) : FB_LINK.test(u.pathname);
      if (!ok) continue;
      for (const k of [...u.searchParams.keys()]) if (!KEEP_PARAMS.includes(k)) u.searchParams.delete(k);
      u.hash = '';
      return u.toString();
    }
    return '';
  }

  function findHandle(root) {
    if (IS_BIKROY) return 'Bikroy';
    if (IS_DARAZ) return 'Daraz Marketplace';
    if (IS_FB_MARKETPLACE) {
      for (const a of root.querySelectorAll('a[href]')) {
        if (/\/marketplace\/item\//.test(a.href)) continue;
        const label = textOf(a).trim();
        if (label && label.length < 80) return label;
      }
      return 'Facebook Marketplace';
    }
    if (SOURCE === 'instagram') {
      for (const a of root.querySelectorAll('a[href]')) {
        const m = (a.getAttribute('href') || '').match(/^\/([A-Za-z0-9._]+)\/?$/);
        if (m && !IG_RESERVED.has(m[1])) return m[1];
      }
    } else {
      const sel = 'h2 a, h3 a, h4 a, strong a, [data-ad-rendering-role="profile_name"] a';
      for (const a of root.querySelectorAll(sel)) {
        const t = textOf(a).trim();
        if (t && t.length < 80) return t;
      }
    }
    const seg = location.pathname.split('/').filter(Boolean)[0] || '';
    return IG_RESERVED.has(seg) || ['groups', 'watch'].includes(seg) ? '' : seg;
  }

  function parse(node) {
    let text = textOf(node);
    node.querySelectorAll('[role="article"]').forEach((x) => {
      const t = textOf(x);
      if (t) text = text.replace(t, ''); // drop comments nested inside the post
    });
    text = text.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim().slice(0, 3000);
    if (text.length < 10) return null;
    const url = findLink(node);
    const handle = findHandle(node);
    const time = node.querySelector('time[datetime]');
    const key = url || `${handle}|${hash(text.slice(0, 200))}`;
    return {
      key,
      source: SOURCE, handle, text, url,
      ts: time ? time.getAttribute('datetime') : '',
    };
  }

  const sent = new Map();
  const pageKeys = new Set();
  const MAX_PAGE_POSTS = 1000;
  let maxPosts = 200;
  let autoOn = false;
  let autoScroll = false;
  let status = 'off';
  let observer = null;
  let observerTimer = null;
  let scrollTimer = null;
  let idleTicks = 0;
  let lastScrollHeight = 0;
  let lastPageCount = 0;
  let captureChain = Promise.resolve();

  function capture(force = false) {
    const task = captureChain.catch(() => {}).then(async () => {
    const nodes = postNodes();
    const parsed = nodes.map(parse).filter(Boolean);
    const posts = [];
    const queued = new Set();
    for (const post of parsed) {
      if (queued.has(post.key)) continue;
      queued.add(post.key);
      if (!pageKeys.has(post.key)) {
        if (autoOn && pageKeys.size >= maxPosts) continue;
        pageKeys.add(post.key);
      }
      if (force || sent.get(post.key) !== post.text) posts.push(post);
    }
    if (!posts.length) return { found: nodes.length, sent: 0, pageCaptured: pageKeys.size };
    try {
      const r = await chrome.runtime.sendMessage({ type: 'posts', posts });
      posts.forEach((post) => sent.set(post.key, post.text));
      return { found: nodes.length, sent: posts.length, pageCaptured: pageKeys.size, ...r };
    } catch {
      setAuto(false);
      return { error: 'Extension was reloaded. Refresh this tab and try again.' };
    }
    });
    captureChain = task;
    return task;
  }

  function stopScrolling(message) {
    autoScroll = false;
    clearTimeout(scrollTimer);
    scrollTimer = null;
    status = message;
  }

  async function scrollStep() {
    if (!autoOn || !autoScroll) return;
    await capture();
    if (!autoOn || !autoScroll) return;
    if (pageKeys.size >= maxPosts) {
      stopScrolling(`Reached the ${maxPosts}-post page limit.`);
      return;
    }

    const scrollHeight = document.scrollingElement?.scrollHeight || document.documentElement.scrollHeight;
    const atBottom = window.scrollY + window.innerHeight >= scrollHeight - 120;
    if (atBottom && pageKeys.size <= lastPageCount && scrollHeight <= lastScrollHeight) idleTicks++;
    else idleTicks = 0;
    if (idleTicks >= 4) {
      stopScrolling('Reached the end of currently available posts.');
      return;
    }

    lastPageCount = pageKeys.size;
    lastScrollHeight = scrollHeight;
    status = 'Scrolling and capturing posts…';
    window.scrollBy({ top: Math.max(500, Math.floor(window.innerHeight * 0.8)), behavior: 'instant' });
    scrollTimer = setTimeout(scrollStep, 500);
  }

  function setAuto(on, limit = maxPosts) {
    maxPosts = Math.min(MAX_PAGE_POSTS, Math.max(10, Math.floor(Number(limit) || 200)));
    if (on) {
      autoOn = true;
      autoScroll = true;
      idleTicks = 0;
      lastScrollHeight = 0;
      lastPageCount = 0;
      status = 'Starting automatic capture…';
      if (!observer && document.body) {
        observer = new MutationObserver(() => {
          if (observerTimer) return;
          observerTimer = setTimeout(() => {
            observerTimer = null;
            capture().catch(() => {});
          }, 100);
        });
        observer.observe(document.body, { childList: true, characterData: true, subtree: true });
      }
      capture().then(() => {
        if (autoOn && autoScroll && !scrollTimer) scrollTimer = setTimeout(scrollStep, 100);
      }).catch(() => {});
    } else {
      autoOn = false;
      stopScrolling('Automatic capture is off.');
      if (observer) observer.disconnect();
      observer = null;
      clearTimeout(observerTimer);
      observerTimer = null;
    }
    return autoOn;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg?.type === 'ping') respond({
      ok: true, auto: autoOn, autoScroll, status, pageCaptured: pageKeys.size,
      maxPosts, source: SOURCE, found: postNodes().length,
    });
    else if (msg?.type === 'capture') capture(true).then(respond);
    else if (msg?.type === 'auto') respond({ auto: setAuto(!!msg.on, msg.maxPosts), status });
    else return false;
    return true;
  });

  chrome.storage.local.get('ui').then(({ ui = {} }) => {
    setAuto(ui.autoCapture !== false, ui.maxPosts);
  }).catch((error) => {
    status = `Could not read capture settings: ${error.message}`;
  });
})();
