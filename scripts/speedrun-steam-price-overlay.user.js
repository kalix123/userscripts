// ==UserScript==
// @name         Speedrun.com Steam Price Overlay
// @namespace    https://example.local/speedrun-price-overlay
// @version      4.0.0
// @description  Shows the current Steam price next to every game/series card on speedrun.com, matched against Steam's full app list locally (instead of hammering Steam's search API), with a "Free games only" filter.
// @author       you
// @match        https://www.speedrun.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      store.steampowered.com
// @connect      api.steampowered.com
// @run-at       document-idle
// ==/UserScript==

/*
 * CHANGELOG (v3.1.0 -> v4.0.0)
 * ----------------------------------------------------------------
 * REWORK: The old "search Steam per card" approach never really
 *      stopped hitting rate limits, because it wasn't really 1
 *      request per card - cards whose first title guess didn't match
 *      would fire up to 4 more search requests (one per title
 *      variant), each with its own retries. Across ~100 cards that's
 *      easily hundreds of requests to an endpoint Steam throttles
 *      hard, so a chunk of the page would always end up stuck on the
 *      "-" failure state no matter how much the pacing was tuned.
 *
 *      New approach:
 *        1. Fetch Steam's full app list ONCE (ISteamApps/GetAppList -
 *           every appid + name Steam has, ~150k entries), cache it
 *           for ~2 weeks.
 *        2. Match speedrun.com titles against that list LOCALLY, in
 *           the browser - no network call at all for this step.
 *        3. Only hit Steam's network API once we have a specific
 *           appid, using the `appdetails` endpoint (which reliably
 *           returns a real formatted price) instead of `storesearch`.
 *        4. Cache the price BY APPID rather than by raw title, so
 *           "Category Extensions" / "Misc" / regional variants of the
 *           same game share one lookup instead of each doing their
 *           own network round trip.
 *      Net effect: usually ~1 request per distinct game on the page
 *      instead of up to ~4, against a more reliable endpoint.
 * NEW: The old search-based method is kept as an opt-in fallback
 *      (menu: "Use live search as fallback...") for the rare game
 *      that isn't found in the local app list under a matching name.
 *      Off by default is not the case - it's ON by default, but only
 *      kicks in for the small residual of unmatched titles, so it no
 *      longer dominates request volume.
 * NEW: "Refresh Steam app list" menu command to force a re-fetch.
 * ----------------------------------------------------------------
 * (v1.0.0 -> v3.1.0 history omitted for brevity - see prior versions)
 * ----------------------------------------------------------------
 */

(function () {
  'use strict';

  // ---------- Config ----------
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;    // 7 days for real price hits
  const NOTFOUND_TTL_MS = 24 * 60 * 60 * 1000;     // 1 day for "not found" results
  const APPLIST_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 2 weeks for the bulk app list
  const MAX_CONCURRENT_LOOKUPS = 4;
  const MIN_DISPATCH_GAP_MS = 150;                 // min gap between request *starts*, globally
  const MAX_TRANSIENT_RETRIES = 2;
  const MAX_RETRIES = 2;                           // retries within a single network call
  const MAX_VARIANTS_PRIMARY = 4;                  // title variants tried, local match + legacy search
  const MAX_VARIANTS_EXPERIMENTAL = 2;
  const CACHE_KEY_PREFIX = 'srcom_price_cache__';
  const APPLIST_CACHE_KEY = 'srcom_price_applist_v1';
  const EXPERIMENTAL_KEY = 'srcom_price_experimental_fallback';
  const FREE_FILTER_KEY = 'srcom_price_free_filter_active';
  const SEARCH_FALLBACK_KEY = 'srcom_price_use_search_fallback';
  const CC = 'us';
  const LANG = 'english';

  const NAME_LINK_SELECTORS = 'a.x-gameview-link, a.text-panel-link';
  const PROCESSED_ATTR = 'data-price-overlay-done';

  let experimentalFallback = GM_getValue(EXPERIMENTAL_KEY, false);
  let freeOnlyFilterActive = GM_getValue(FREE_FILTER_KEY, false);
  let useSearchFallback = GM_getValue(SEARCH_FALLBACK_KEY, true);

  GM_registerMenuCommand(
    `Experimental suggest-endpoint fallback: ${experimentalFallback ? 'ON' : 'OFF'} (click to toggle)`,
    () => {
      experimentalFallback = !experimentalFallback;
      GM_setValue(EXPERIMENTAL_KEY, experimentalFallback);
      alert(`Experimental fallback is now ${experimentalFallback ? 'ON' : 'OFF'}. Reload to apply to already-scanned cards.`);
    }
  );

  GM_registerMenuCommand(
    `Use live search as fallback when not found locally: ${useSearchFallback ? 'ON' : 'OFF'} (click to toggle)`,
    () => {
      useSearchFallback = !useSearchFallback;
      GM_setValue(SEARCH_FALLBACK_KEY, useSearchFallback);
      alert(`Live search fallback is now ${useSearchFallback ? 'ON' : 'OFF'}. Reload to apply to already-scanned cards.`);
    }
  );

  GM_registerMenuCommand('Toggle "Free games only" filter', () => {
    setFreeFilterActive(!freeOnlyFilterActive);
  });

  GM_registerMenuCommand('Refresh Steam app list', () => {
    GM_deleteValue(APPLIST_CACHE_KEY);
    appListPromise = null;
    appListUnavailable = false;
    alert('Steam Price Overlay: app list cache cleared. Reload the page to refetch it.');
  });

  GM_registerMenuCommand('Clear price cache', () => {
    memCache.clear();
    if (typeof GM_listValues === 'function' && typeof GM_deleteValue === 'function') {
      GM_listValues()
        .filter((k) => k.startsWith(CACHE_KEY_PREFIX))
        .forEach((k) => GM_deleteValue(k));
    }
    alert('Steam Price Overlay: price cache cleared. Reload the page to refetch prices.');
  });

  // ---------- Small helpers ----------
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function cleanTitle(raw) {
    return raw
      .replace(/\bSeries\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function titleVariants(base) {
    const variants = [];
    const push = (t) => {
      const clean = t.replace(/\s+/g, ' ').trim();
      if (clean && !variants.includes(clean)) variants.push(clean);
    };

    const noSuffix = base
      .replace(/\bCategory Extensions?\b/gi, '')
      .replace(/\bMisc\.?\s*$/i, '')
      .replace(/\bSpeedrun(ning)?\b/gi, '')
      .trim();
    push(noSuffix);
    push(base);
    push(noSuffix.replace(/\s*\([^()]*\)\s*$/, ''));
    if (noSuffix.includes(':')) {
      push(noSuffix.split(':')[0]);
    }
    push(
      noSuffix.replace(
        /\b(Definitive|Remastered|Remake|Enhanced|Deluxe|GOTY|Complete)\s+Edition\b/gi,
        ''
      )
    );

    return variants;
  }

  function normalize(str) {
    return String(str || '')
      .toLowerCase()
      .replace(/[™®©]/g, '')
      .replace(/[''`]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  // ---------- Caching (in-memory first, then persisted GM storage) ----------
  const memCache = new Map();

  function cacheGet(name) {
    if (memCache.has(name)) return memCache.get(name);
    const raw = GM_getValue(CACHE_KEY_PREFIX + name, null);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      const ttl = parsed.value && parsed.value.found === false ? NOTFOUND_TTL_MS : CACHE_TTL_MS;
      if (Date.now() - parsed.ts > ttl) return null;
      memCache.set(name, parsed.value);
      return parsed.value;
    } catch (e) {
      return null;
    }
  }

  function cacheSet(name, value) {
    memCache.set(name, value);
    try {
      GM_setValue(CACHE_KEY_PREFIX + name, JSON.stringify({ ts: Date.now(), value }));
    } catch (e) {
      // Storage quota, etc - keep going in-memory only for this session.
    }
  }

  // ---------- Network ----------
  function gmGet(url, headers, timeout = 12000) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers,
        timeout,
        onload: (res) => resolve({ status: res.status, text: res.responseText }),
        onerror: () => resolve({ status: 'error' }),
        ontimeout: () => resolve({ status: 'timeout' }),
      });
    });
  }

  async function gmGetWithRetry(url, headers, retries = MAX_RETRIES) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await gmGet(url, headers);
      if (res.status === 200) return res;
      if (res.status === 429) {
        await sleep(1200 * (attempt + 1));
        continue;
      }
      if (attempt < retries) await sleep(300 * (attempt + 1));
    }
    return { status: 'error' };
  }

  const STEAM_HEADERS = {
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://store.steampowered.com/',
  };

  // ---------- Price parsing ----------
  function formatMoney(cents, currency) {
    if (typeof cents !== 'number' || isNaN(cents)) return null;
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currency || 'USD',
      }).format(cents / 100);
    } catch (e) {
      return `${(cents / 100).toFixed(2)}${currency ? ' ' + currency : ''}`;
    }
  }

  // ---------- Local app-list matching (primary method) ----------
  let appListPromise = null;
  let appListUnavailable = false;

  function buildAppIndex(apps) {
    const exactMap = new Map();
    const list = [];
    for (const app of apps) {
      if (!app || !app.name) continue;
      const norm = normalize(app.name);
      if (!norm) continue;
      // GetAppList has many duplicate/placeholder entries for the same
      // name; keep the first (usually lowest/original) appid we see.
      if (!exactMap.has(norm)) exactMap.set(norm, app.appid);
      list.push({ norm, appid: app.appid });
    }
    list.sort((a, b) => (a.norm < b.norm ? -1 : a.norm > b.norm ? 1 : 0));
    return { exactMap, list };
  }

  function prefixSearch(list, normPrefix, limit = 3) {
    if (!normPrefix) return [];
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].norm < normPrefix) lo = mid + 1;
      else hi = mid;
    }
    const results = [];
    for (let i = lo; i < list.length && results.length < limit; i++) {
      if (!list[i].norm.startsWith(normPrefix)) break;
      results.push(list[i]);
    }
    return results;
  }

  function ensureAppList() {
    if (appListUnavailable) return Promise.resolve(null);
    if (appListPromise) return appListPromise;

    appListPromise = (async () => {
      try {
        const raw = GM_getValue(APPLIST_CACHE_KEY, null);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Date.now() - parsed.ts < APPLIST_TTL_MS && Array.isArray(parsed.apps)) {
            return buildAppIndex(parsed.apps);
          }
        }
      } catch (e) {
        // fall through to a fresh fetch
      }

      const res = await gmGetWithRetry(
        'https://api.steampowered.com/ISteamApps/GetAppList/v2/',
        { Accept: 'application/json' },
        1
      );
      if (res.status !== 200) {
        appListUnavailable = true;
        return null;
      }
      try {
        const data = JSON.parse(res.text);
        const apps = (data && data.applist && data.applist.apps) || [];
        if (!apps.length) {
          appListUnavailable = true;
          return null;
        }
        try {
          GM_setValue(APPLIST_CACHE_KEY, JSON.stringify({ ts: Date.now(), apps }));
        } catch (e) {
          // Too big for this GM storage backend - still usable in-memory
          // for this session, just won't persist across reloads.
        }
        return buildAppIndex(apps);
      } catch (e) {
        appListUnavailable = true;
        return null;
      }
    })();

    return appListPromise;
  }

  function localMatchAppId(rawTitle, index) {
    const base = cleanTitle(rawTitle);
    const variants = titleVariants(base);

    for (const variant of variants) {
      const norm = normalize(variant);
      if (norm && index.exactMap.has(norm)) return index.exactMap.get(norm);
    }
    for (const variant of variants.slice(0, 2)) {
      const norm = normalize(variant);
      if (!norm) continue;
      const hits = prefixSearch(index.list, norm, 3);
      if (hits.length) return hits[0].appid;
    }
    return null;
  }

  async function fetchAppDetailsPrice(appid) {
    const url =
      `https://store.steampowered.com/api/appdetails?appids=${appid}` +
      `&cc=${CC}&l=${LANG}&filters=price_overview`;
    const res = await gmGetWithRetry(url, STEAM_HEADERS);
    if (res.status !== 200) return null; // transient failure
    try {
      const data = JSON.parse(res.text);
      const entry = data && data[String(appid)];
      if (!entry) return null;
      if (!entry.success) {
        return { text: 'Not on Steam', found: false, free: false, appid: null };
      }
      const d = entry.data || {};
      if (d.is_free) {
        return { text: 'Free to Play', found: true, free: true, appid };
      }
      const po = d.price_overview;
      if (!po) {
        // Matched a real listing but Steam gave no price data (unreleased,
        // region-restricted, DLC-only, etc).
        return { text: 'Free / TBA', found: true, free: true, appid };
      }
      const discount = po.discount_percent || 0;
      const priceText = po.final_formatted || formatMoney(po.final, po.currency);
      return {
        text: discount > 0 ? `${priceText} (-${discount}%)` : priceText,
        found: true,
        free: po.final === 0,
        appid,
      };
    } catch (e) {
      return null;
    }
  }

  async function priceForAppId(appid) {
    const key = `appid:${appid}`;
    const cached = cacheGet(key);
    if (cached) return cached;

    const value = await fetchAppDetailsPrice(appid);
    if (value === null) {
      return { text: '—', found: false, appid, free: false, transient: true };
    }
    cacheSet(key, value);
    return value;
  }

  // ---------- Legacy live-search method (opt-in fallback only) ----------
  async function steamStoreSearch(term) {
    const url =
      'https://store.steampowered.com/api/storesearch/?term=' +
      encodeURIComponent(term) +
      `&l=${LANG}&cc=${CC}`;
    const res = await gmGetWithRetry(url, STEAM_HEADERS);
    if (res.status !== 200) return null;
    try {
      const data = JSON.parse(res.text);
      return Array.isArray(data.items) ? data.items : [];
    } catch (e) {
      return null;
    }
  }

  async function steamSuggestSearch(term) {
    const url =
      'https://store.steampowered.com/search/suggest?term=' +
      encodeURIComponent(term) +
      `&f=games&cc=${CC}&realm=1&l=${LANG}&use_store_query=1`;
    const res = await gmGetWithRetry(url, { Accept: 'text/html, */*', Referer: 'https://store.steampowered.com/' });
    if (res.status !== 200 || !res.text) return null;
    try {
      const doc = new DOMParser().parseFromString(res.text, 'text/html');
      const rows = Array.from(doc.querySelectorAll('a.match'));
      return rows
        .map((row) => {
          const appid = row.getAttribute('data-ds-appid');
          const nameEl = row.querySelector('.match_name');
          const priceEl = row.querySelector('.match_price');
          if (!appid || !nameEl) return null;
          return {
            id: Number(appid),
            type: 'app',
            name: nameEl.textContent.trim(),
            price: priceEl ? { final_formatted: priceEl.textContent.trim(), discount_percent: 0 } : null,
          };
        })
        .filter(Boolean);
    } catch (e) {
      return null;
    }
  }

  function isGameType(item) {
    return item.type === 'app' || item.type === 'game';
  }

  function pickConfidentMatch(items, term) {
    const games = items.filter(isGameType);
    const pool = games.length ? games : items;
    const lowerTerm = term.toLowerCase();
    return (
      pool.find((it) => it.name && it.name.toLowerCase() === lowerTerm) ||
      pool.find((it) => it.name && it.name.toLowerCase().startsWith(lowerTerm)) ||
      pool.find((it) => it.name && lowerTerm.startsWith(it.name.toLowerCase())) ||
      null
    );
  }

  function pickWeakFallback(items) {
    if (!items || !items.length) return null;
    const games = items.filter(isGameType);
    return (games.length ? games : items)[0] || null;
  }

  function legacyPriceLabelFromItem(item) {
    if (!item) return { text: 'Not on Steam', found: false, free: false, appid: null };
    const p = item.price;
    if (!p) return { text: 'Free / TBA', found: true, free: true, appid: item.id };
    const cents = typeof p.final === 'number' ? p.final : undefined;
    const discount = p.discount_percent || 0;
    const priceText = p.final_formatted || formatMoney(cents, p.currency);
    if (priceText === null) return { text: 'Free / TBA', found: true, free: true, appid: item.id };
    return {
      text: discount > 0 ? `${priceText} (-${discount}%)` : priceText,
      found: true,
      free: cents === 0,
      appid: item.id,
    };
  }

  async function legacySearchLookup(rawTitle) {
    const base = cleanTitle(rawTitle);
    const variants = titleVariants(base);
    let confident = null;
    let weakFallback = null;

    for (const variant of variants.slice(0, MAX_VARIANTS_PRIMARY)) {
      const items = await steamStoreSearch(variant);
      if (items === null) {
        return { text: '—', found: false, appid: null, free: false, transient: true };
      }
      if (!weakFallback) weakFallback = pickWeakFallback(items);
      const match = pickConfidentMatch(items, variant);
      if (match) {
        confident = match;
        break;
      }
    }

    let best = confident;
    if (!best && experimentalFallback) {
      for (const variant of variants.slice(0, MAX_VARIANTS_EXPERIMENTAL)) {
        const items = await steamSuggestSearch(variant);
        if (!items) continue;
        if (!weakFallback) weakFallback = pickWeakFallback(items);
        const match = pickConfidentMatch(items, variant);
        if (match) {
          best = match;
          break;
        }
      }
    }
    if (!best) best = weakFallback;

    return legacyPriceLabelFromItem(best);
  }

  // ---------- Top-level lookup ----------
  async function lookupPrice(rawTitle) {
    const titleKey = rawTitle.toLowerCase();
    const cached = cacheGet(titleKey);
    if (cached) return cached;

    let value;
    const index = await ensureAppList();
    const appid = index ? localMatchAppId(rawTitle, index) : null;

    if (appid) {
      value = await priceForAppId(appid);
    } else if (useSearchFallback) {
      value = await legacySearchLookup(rawTitle);
    } else {
      value = { text: 'Not on Steam', found: false, free: false, appid: null };
    }

    if (!value.transient) cacheSet(titleKey, value);
    return value;
  }

  async function resolveWithRetries(rawTitle, attempt = 0) {
    const value = await lookupPrice(rawTitle);
    if (value.transient && attempt < MAX_TRANSIENT_RETRIES) {
      await sleep(1500 * (attempt + 1));
      return resolveWithRetries(rawTitle, attempt + 1);
    }
    return value;
  }

  // ---------- Badge rendering ----------
  function makeBadge() {
    const el = document.createElement('a');
    el.className = 'price-overlay-badge';
    el.textContent = '⏳';
    el.style.cssText = [
      'display:inline-block',
      'margin:2px 0 4px',
      'padding:1px 6px',
      'border-radius:4px',
      'font-size:11px',
      'font-weight:600',
      'background:rgba(0,0,0,0.35)',
      'color:#9be29b',
      'text-decoration:none',
      'white-space:nowrap',
      'max-width:100%',
      'overflow:hidden',
      'text-overflow:ellipsis',
    ].join(';');
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!el.getAttribute('href')) e.preventDefault();
    });
    return el;
  }

  function updateBadge(badge, value) {
    badge.textContent = value.text;
    badge.style.color = value.found ? '#9be29b' : '#888';
    if (value.appid) {
      badge.setAttribute('href', `https://store.steampowered.com/app/${value.appid}/`);
      badge.setAttribute('target', '_blank');
      badge.setAttribute('rel', 'noopener noreferrer');
      badge.style.cursor = 'pointer';
      badge.style.textDecoration = 'underline';
      badge.title = 'Open on Steam';
    } else {
      badge.removeAttribute('href');
      badge.removeAttribute('target');
      badge.style.cursor = 'default';
      badge.style.textDecoration = 'none';
      badge.title = '';
    }
  }

  function placeBadge(anchor, badge) {
    const card = anchor.closest('.cursor-pointer');
    const statsLine = card ? card.querySelector('.text-xs.text-secondary') : null;
    if (statsLine) {
      statsLine.insertAdjacentElement('beforebegin', badge);
    } else {
      anchor.insertAdjacentElement('afterend', badge);
    }
    return card;
  }

  // ---------- "Free games only" filter ----------
  function updateCardVisibility(card) {
    const shouldHide = freeOnlyFilterActive && card.dataset.priceFree === '0';
    card.style.display = shouldHide ? 'none' : '';
  }

  function setCardFreeState(card, value) {
    card.dataset.priceFree = value.transient ? 'unknown' : value.free ? '1' : '0';
    updateCardVisibility(card);
  }

  function applyFreeFilterToAllCards() {
    document.querySelectorAll('[data-price-free]').forEach(updateCardVisibility);
  }

  function setFreeFilterActive(active) {
    freeOnlyFilterActive = active;
    GM_setValue(FREE_FILTER_KEY, active);
    if (filterButton) {
      filterButton.textContent = active ? '★ Free games only (ON)' : '☆ Free games only';
      filterButton.setAttribute('aria-pressed', String(active));
    }
    applyFreeFilterToAllCards();
  }

  let filterButton = null;
  function injectFreeFilterButton() {
    if (document.getElementById('price-overlay-free-filter-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'price-overlay-free-filter-btn';
    btn.type = 'button';
    btn.textContent = freeOnlyFilterActive ? '★ Free games only (ON)' : '☆ Free games only';
    btn.setAttribute('aria-pressed', String(freeOnlyFilterActive));
    btn.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:99999',
      'padding:8px 14px',
      'border-radius:999px',
      'border:1px solid rgba(255,255,255,0.2)',
      'background:#1b2838',
      'color:#9be29b',
      'font-size:13px',
      'font-weight:600',
      'font-family:inherit',
      'cursor:pointer',
      'box-shadow:0 2px 10px rgba(0,0,0,0.4)',
    ].join(';');
    btn.addEventListener('click', () => setFreeFilterActive(!freeOnlyFilterActive));
    document.body.appendChild(btn);
    filterButton = btn;
  }

  // ---------- Queue (concurrency-limited AND rate-paced) ----------
  const queue = [];
  let activeCount = 0;
  let nextDispatchAt = 0;

  async function waitForSlot() {
    const now = Date.now();
    const wait = Math.max(0, nextDispatchAt - now);
    nextDispatchAt = Math.max(now, nextDispatchAt) + MIN_DISPATCH_GAP_MS;
    if (wait) await sleep(wait);
  }

  function enqueue(fn) {
    queue.push(fn);
    pump();
  }

  function pump() {
    while (activeCount < MAX_CONCURRENT_LOOKUPS && queue.length) {
      const job = queue.shift();
      activeCount++;
      (async () => {
        try {
          await waitForSlot();
          await job();
        } catch (e) {
          // Never let one bad card kill the queue.
        } finally {
          activeCount--;
          pump();
        }
      })();
    }
  }

  // ---------- Card discovery & processing ----------
  function findCards(root) {
    if (root.nodeType !== 1 && root.nodeType !== 9) return [];
    return root.querySelectorAll(NAME_LINK_SELECTORS);
  }

  function processCard(anchor) {
    if (anchor.hasAttribute(PROCESSED_ATTR)) return;
    anchor.setAttribute(PROCESSED_ATTR, '1');

    const rawTitle = anchor.textContent.trim();
    if (!rawTitle) return;

    const badge = makeBadge();
    const card = placeBadge(anchor, badge);

    enqueue(async () => {
      const value = await resolveWithRetries(rawTitle);
      updateBadge(badge, value);
      if (card) setCardFreeState(card, value);
    });
  }

  function scan(root) {
    findCards(root).forEach(processCard);
    if (root.nodeType === 1 && root.matches && root.matches(NAME_LINK_SELECTORS)) {
      processCard(root);
    }
  }

  // ---------- Init ----------
  injectFreeFilterButton();
  scan(document);

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        scan(node);
      }
    }
    injectFreeFilterButton();
  });

  observer.observe(document.body, { childList: true, subtree: true });
})();
