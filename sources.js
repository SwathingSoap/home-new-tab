'use strict';

/**
 * Data sources, all public and without API keys. Each load(prev) returns plain JSON that is kept in
 * storage.local; prev is the last good value (used to keep parts that failed this time).
 * The extension has host permissions, so these requests are not limited by CORS.
 */

const ext = globalThis.browser ?? globalThis.chrome;

async function http(url, { type = 'json', timeout = 15_000, retry = true, ...init } = {}) {
  let res;
  try {
    res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeout), ...init });
  } catch (e) {
    // One more try on a dropped connection (not on a timeout).
    if (!retry || e.name === 'TimeoutError') throw e;
    await new Promise((ok) => setTimeout(ok, 1500));
    return http(url, { type, timeout, retry: false, ...init });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (type === 'json') return res.json();
  if (type === 'buffer') return res.arrayBuffer();
  return res.text();
}

const pad = (n) => String(n).padStart(2, '0');
const chunked = (list, size) =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
const htmlText = (html) => new DOMParser().parseFromString(html, 'text/html').body.textContent.trim();
const cut = (text, max) => (text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text);

/* ---------- Weather: Open-Meteo ---------- */

async function loadWeather() {
  const { lat, lon } = CONFIG.weather;
  const j = await http(
    'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${lat}&longitude=${lon}` +
      '&current=temperature_2m,weather_code,is_day' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset' +
      '&hourly=temperature_2m,precipitation_probability,weather_code,is_day' +
      '&timezone=auto&forecast_days=4',
  );
  const d = j.daily;
  const h = j.hourly;
  return {
    temp: Math.round(j.current.temperature_2m),
    code: j.current.weather_code,
    isDay: j.current.is_day === 1,
    days: d.time.map((date, i) => ({
      date,
      code: d.weather_code[i],
      max: Math.round(d.temperature_2m_max[i]),
      min: Math.round(d.temperature_2m_min[i]),
      sunrise: d.sunrise[i],
      sunset: d.sunset[i],
    })),
    // Local time of the place; the same as the browser's when the city is where you are.
    hours: h.time.map((t, i) => ({
      time: new Date(t).getTime(),
      temp: Math.round(h.temperature_2m[i]),
      code: h.weather_code[i],
      prec: h.precipitation_probability[i] ?? 0,
      isDay: h.is_day[i] === 1,
    })),
  };
}

/* ---------- Currency: Central Bank of Russia ---------- */

async function loadRates() {
  const day = (ms) => {
    const d = new Date(ms);
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  };
  const now = Date.now();
  const from = day(now - CONFIG.rates.days * 86_400_000);
  // Tomorrow: the CBR publishes the next day's rate in the afternoon.
  const to = day(now + 86_400_000);
  const num = (el) => parseFloat(el?.textContent.replace(',', '.') ?? '');

  return Promise.all(
    Object.entries(CONFIG.rates.currencies).map(async ([code, id]) => {
      const buf = await http(
        `https://www.cbr.ru/scripts/XML_dynamic.asp?date_req1=${from}&date_req2=${to}&VAL_NM_RQ=${id}`,
        { type: 'buffer' },
      );
      const xml = new DOMParser().parseFromString(new TextDecoder('windows-1251').decode(buf), 'text/xml');
      const records = [...xml.querySelectorAll('Record')];
      const history = records.map((r) => num(r.querySelector('Value')) / (num(r.querySelector('Nominal')) || 1));
      if (!history.length || history.some(isNaN)) throw new Error(`No CBR data for ${code}`);
      return { code, history, date: records.at(-1).getAttribute('Date') };
    }),
  );
}

/* ---------- News: DTF (Osnova API) ---------- */

async function loadDtf(prev) {
  const { categories, limit } = CONFIG.dtf;
  const results = await Promise.allSettled(
    categories.map((c) => http(`https://api.dtf.ru/v2.1/timeline?subsitesIds=${c.subsite}&sorting=hotness`)),
  );
  if (results.every((r) => r.status === 'rejected')) throw results[0].reason;
  return categories
    .map((c, i) => ({
      label: c.label,
      items:
        results[i].status === 'fulfilled'
          ? parseDtf(results[i].value).slice(0, limit)
          : (prev?.find((p) => p.label === c.label)?.items ?? []),
    }))
    .filter((c) => c.items.length);
}

function parseDtf(json) {
  return (json.result?.items ?? []).flatMap((item) => {
    const post = item.data ?? item;
    if (!(post.id > 0)) return [];
    const blocks = post.blocks ?? [];
    const title = post.title?.trim() || firstText(blocks, 120);
    if (!title) return [];
    const summary = firstText(blocks, 280);
    return [{
      id: post.id,
      title,
      summary: summary === title ? '' : summary,
      link: post.url || `https://dtf.ru/${post.id}`,
      image: cover(blocks),
      date: post.date * 1000,
      comments: post.counters?.comments ?? 0,
    }];
  });
}

/** First image of the post (cover), first frame for GIF/MP4. */
function cover(blocks) {
  for (const block of blocks) {
    if (block.type !== 'media') continue;
    const uuid = block.data?.items?.[0]?.image?.data?.uuid;
    if (!uuid) continue;
    const base = uuid.startsWith('http') ? uuid.replace(/\/+$/, '') : `https://leonardo.osnova.io/${uuid}`;
    return `${base}/-/scale_crop/320x180/`;
  }
  return null;
}

function firstText(blocks, max) {
  for (const block of blocks) {
    if (block.type !== 'text') continue;
    const text = htmlText(block.data?.text ?? '');
    if (text) return cut(text, max);
  }
  return '';
}

/* ---------- Steam: wishlist deals, upcoming, fresh releases ---------- */

const STEAM_ASSETS = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps';

/** IStoreBrowseService/GetItems in chunks of 50. */
async function steamItems(ids, context, dataRequest) {
  const chunks = await Promise.all(
    chunked(ids, 50).map((chunk) => {
      const input = { ids: chunk.map((appid) => ({ appid })), context };
      if (dataRequest) input.data_request = dataRequest;
      return http(
        'https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=' +
          encodeURIComponent(JSON.stringify(input)),
      );
    }),
  );
  return chunks.flatMap((j) => j.response?.store_items ?? []);
}

const FULL_REQUEST = { include_assets: true, include_release: true, include_reviews: true };
const steamImage = (item) => (item.assets?.header ? `${STEAM_ASSETS}/${item.appid}/${item.assets.header}` : null);
const steamPrice = (s) => (s ?? '').replace(',00', '');

async function loadSteam(prev) {
  const s = CONFIG.steam;
  const wishlist = await http(`https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=${s.id}`);
  const ids = (wishlist.response?.items ?? []).map((i) => i.appid).filter(Boolean);
  const items = await steamItems(ids, { language: 'russian', country_code: s.country }, FULL_REQUEST);

  const deals = items.flatMap(steamDeal).sort((a, b) => b.discount - a.discount);
  const upcoming = items.flatMap(steamUpcoming).sort((a, b) => a.sortKey - b.sortKey).slice(0, s.upcomingMax);

  // When each discount was first seen; the very first run marks everything as old.
  const now = Date.now();
  const seen = {};
  for (const d of deals) {
    seen[d.appId] = prev?.seen ? (prev.seen[d.appId] ?? now) : 0;
    d.firstSeen = seen[d.appId];
  }

  const lows = await historicalLows(deals.map((d) => d.appId)).catch((e) => {
    console.warn('historical lows', e);
    return new Set(prev?.deals.filter((d) => d.historicalLow).map((d) => d.appId));
  });
  for (const d of deals) d.historicalLow = lows.has(d.appId);

  const fresh = await loadFresh().catch((e) => {
    console.warn('fresh releases', e);
    return prev?.fresh ?? [];
  });
  return { deals, upcoming, fresh, seen };
}

function steamDeal(item) {
  const offer = item.best_purchase_option;
  if (!(offer?.discount_pct > 0)) return [];
  return [{
    appId: item.appid,
    name: item.name,
    discount: offer.discount_pct,
    price: steamPrice(offer.formatted_final_price),
    oldPrice: steamPrice(offer.formatted_original_price),
    image: steamImage(item),
    reviews: item.reviews?.summary_filtered?.percent_positive ?? 0,
  }];
}

/** Not released and dated (exact day, month, quarter, year) or "coming soon"; TBA is skipped. */
function steamUpcoming(item) {
  const release = item.release;
  if (!release?.is_coming_soon) return [];
  const ms = (release.steam_release_date ?? 0) * 1000;
  const display = release.coming_soon_display;
  const dated = ['date_full', 'date_month', 'date_quarter', 'date_year'].includes(display) && ms > 0;
  if (!dated && display !== 'text_comingsoon') return []; // "Ещё не объявлена"
  if (dated && ms < Date.now() - 86_400_000) return []; // already out, data lagging
  return [{
    appId: item.appid,
    name: item.name,
    image: steamImage(item),
    display: dated ? display : 'soon',
    release: ms,
    sortKey: dated ? ms : Number.MAX_SAFE_INTEGER,
  }];
}

/**
 * "Is this the lowest price ever?" without API keys: today's Steam USD price vs the all-time low
 * across stores from CheapShark (steamAppID -> gameID -> cheapestPriceEver).
 */
// CheapShark refuses clients that do not name themselves (HTTP 400 "generic User-Agent").
const CHEAPSHARK = { headers: { 'User-Agent': 'HomeNewTab/0.1 (personal Firefox new tab extension)' } };

async function historicalLows(appIds) {
  if (!appIds.length) return new Set();
  const usItems = await steamItems(appIds, { language: 'english', country_code: 'US' });
  const usCents = new Map(
    usItems.filter((i) => i.best_purchase_option).map((i) => [i.appid, i.best_purchase_option.final_price_in_cents]),
  );

  // The steamAppID -> gameID mapping never changes, so it is kept for good.
  const { csmap = {} } = await ext.storage.local.get('csmap');
  for (const id of appIds.filter((id) => !(id in csmap))) {
    try {
      const found = await http(`https://www.cheapshark.com/api/1.0/games?steamAppID=${id}`, CHEAPSHARK);
      csmap[id] = found[0]?.gameID ?? null;
    } catch (e) {
      console.warn('cheapshark map', id, e);
    }
  }
  await ext.storage.local.set({ csmap });

  const gameIds = appIds.map((id) => csmap[id]).filter(Boolean);
  const lows = {};
  for (const chunk of chunked(gameIds, 25)) {
    const json = await http(`https://www.cheapshark.com/api/1.0/games?ids=${chunk.join(',')}`, CHEAPSHARK);
    for (const gid of chunk) lows[gid] = parseFloat(json[gid]?.cheapestPriceEver?.price);
  }
  return new Set(appIds.filter((id) => {
    const cents = usCents.get(id);
    const low = lows[csmap[id]];
    return cents != null && !isNaN(low) && cents / 100 <= low + 0.01;
  }));
}

/** Steam New & Trending: recent games players like, most reviewed first. */
async function loadFresh() {
  const s = CONFIG.steam;
  const j = await http(
    `https://store.steampowered.com/api/getappsincategory/?category=cat_newreleases&cc=${s.country}&l=english`,
  );
  const ids = [...new Set(['topsellers', 'viewall'].flatMap((k) => (j.tabs?.[k]?.items ?? []).map((i) => i.id)))]
    .filter((id) => id > 0);
  if (!ids.length) return [];
  const items = await steamItems(ids, { language: 'russian', country_code: s.country }, FULL_REQUEST);
  const now = Date.now();
  return items
    .flatMap((item) => {
      if (item.type !== 0 || !item.release || item.release.is_coming_soon) return []; // games only, out
      const released = (item.release.steam_release_date ?? 0) * 1000;
      if (released <= 0 || now - released > s.freshDays * 86_400_000) return [];
      const reviews = item.reviews?.summary_filtered;
      if (!reviews || reviews.review_count < s.freshMinReviews || reviews.percent_positive < s.freshMinPercent) return [];
      const offer = item.best_purchase_option;
      return [{
        appId: item.appid,
        name: item.name,
        image: steamImage(item),
        price: steamPrice(offer?.formatted_final_price) || 'Бесплатно',
        discount: offer?.discount_pct ?? 0,
        reviews: reviews.percent_positive,
        reviewCount: reviews.review_count,
        released,
      }];
    })
    .sort((a, b) => b.reviewCount - a.reviewCount)
    .slice(0, s.freshMax);
}

/* ---------- Network: exit country (is the VPN on) and ping ---------- */

async function loadNet() {
  const { country } = await http('https://api.country.is/', { timeout: 8_000 });
  // Best of 3: the first one also pays for DNS + TLS, the next reuse the connection (about one RTT).
  let ping = null;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    try {
      await fetch('https://www.google.com/generate_204', { cache: 'no-store', signal: AbortSignal.timeout(3_000) });
      ping = Math.min(ping ?? Infinity, Math.round(performance.now() - start));
    } catch {
      // no answer this time
    }
  }
  return { country, ping };
}

/* ---------- Backgrounds: Bing photo of the day + ESA space images ---------- */

async function loadWallpapers(prev) {
  const [bing, space] = await Promise.allSettled([bingImages(), spaceImages()]);
  const lists = {
    bing: bing.status === 'fulfilled' ? bing.value : (prev?.filter((w) => w.kind === 'bing') ?? []),
    space: space.status === 'fulfilled' ? space.value : (prev?.filter((w) => w.kind === 'space') ?? []),
  };
  const mixed = [];
  while (Object.values(lists).some((l) => l.length)) {
    for (const kind of CONFIG.wallpapers.pattern) {
      const next = lists[kind]?.shift();
      if (next) mixed.push(next);
    }
  }
  if (!mixed.length) throw new Error('No wallpapers');
  return mixed;
}

async function bingImages() {
  const pages = await Promise.all(
    [0, 7].map((idx) =>
      http(`https://www.bing.com/HPImageArchive.aspx?format=js&mkt=${CONFIG.wallpapers.bingMarket}&idx=${idx}&n=8`),
    ),
  );
  const seen = new Set();
  return pages.flatMap((p) => p.images ?? []).flatMap((img) => {
    if (seen.has(img.urlbase)) return [];
    seen.add(img.urlbase);
    // "Place, Country (© Author/Agency)"
    const [, place = img.copyright, credit = ''] = img.copyright.match(/^(.*?)\s*\((©.*)\)\s*$/) ?? [];
    return [{
      kind: 'bing',
      url: `https://www.bing.com${img.urlbase}_UHD.jpg`,
      fallback: `https://www.bing.com${img.urlbase}_1920x1080.jpg`,
      title: img.title && img.title !== 'Info' ? `${img.title} · ${place}` : place,
      credit,
      link: img.copyrightlink?.startsWith('http') ? img.copyrightlink : null,
    }];
  });
}

async function spaceImages() {
  const feeds = [
    ['https://esawebb.org/images/feed/', 'ESA/Webb'],
    ['https://esahubble.org/images/potw/feed/', 'ESA/Hubble'],
  ];
  const results = await Promise.allSettled(feeds.map(([url]) => http(url, { type: 'text' })));
  return results.flatMap((r, i) => {
    if (r.status !== 'fulfilled') return [];
    const xml = new DOMParser().parseFromString(r.value, 'text/xml');
    return [...xml.querySelectorAll('item')].flatMap((item) => {
      const screen = item.querySelector('enclosure')?.getAttribute('url');
      if (!screen) return [];
      return [{
        kind: 'space',
        // 1920 px "wallpaper" exists for most images; the 1280 px "screen" one always does.
        url: screen.replace('/screen/', '/wallpaper5/'),
        fallback: screen,
        title: item.querySelector('title')?.textContent.trim() ?? '',
        credit: feeds[i][1],
        link: item.querySelector('link')?.textContent.trim() || null,
      }];
    });
  });
}

/* ---------- Free games: GamerPower, Steam giveaways only ---------- */

async function loadGiveaways() {
  const list = await http('https://www.gamerpower.com/api/giveaways?platform=steam&type=game');
  if (!Array.isArray(list)) return []; // {status: 0} when there is nothing
  return list.map((g) => ({
    id: g.id,
    // "Sker Ritual (Epic Games) Giveaway" -> "Sker Ritual"
    name: g.title.replace(/\s*\([^)]*\)\s*(Key\s+)?Giveaway\s*$/i, '').replace(/\s*Giveaway\s*$/i, ''),
    image: g.thumbnail,
    worth: g.worth !== 'N/A' ? g.worth : '',
    // GamerPower dates have no zone; read as local, so the day shown is the one they state.
    ends: g.end_date && g.end_date !== 'N/A' ? Date.parse(g.end_date.replace(' ', 'T')) : null,
    link: g.open_giveaway_url || g.gamerpower_url,
  }));
}

/* ---------- Geomagnetic storms: NOAA planetary Kp forecast ---------- */

async function loadKp() {
  const rows = await http('https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json');
  // Times are UTC, 3-hour slots; keep the ones from 3 hours ago on.
  const from = Date.now() - 3 * 3600_000;
  return rows
    .map((r) => ({ time: Date.parse(r.time_tag + 'Z'), kp: r.kp }))
    .filter((r) => r.time >= from && typeof r.kp === 'number');
}

/* ---------- Steam online: current players of the deals and fresh releases ---------- */

async function loadPlayers() {
  const { steam } = await ext.storage.local.get('steam');
  const ids = new Set([
    ...(steam?.v?.deals ?? []).map((d) => d.appId),
    ...(steam?.v?.fresh ?? []).map((f) => f.appId),
  ]);
  const counts = {};
  await Promise.all([...ids].map(async (id) => {
    try {
      const j = await http(`https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${id}`, { retry: false });
      if (j.response?.player_count > 0) counts[id] = j.response.player_count;
    } catch {
      // not released or no stats
    }
  }));
  return { counts };
}

/* ---------- On this day: video games released on today's date (Wikidata) ---------- */

const dayKey = (d = new Date()) => `${d.getMonth() + 1}-${d.getDate()}`;

async function loadToday() {
  const d = new Date();
  // Day precision only (11), so games dated just "2004" do not land on January 1.
  const query = `
    SELECT ?game ?gameLabel (MIN(?year) AS ?y) (COUNT(DISTINCT ?sl) AS ?links) WHERE {
      ?game wdt:P31 wd:Q7889; p:P577/psv:P577 [ wikibase:timeValue ?date; wikibase:timePrecision 11 ].
      FILTER(MONTH(?date) = ${d.getMonth() + 1} && DAY(?date) = ${d.getDate()})
      BIND(YEAR(?date) AS ?year)
      ?sl schema:about ?game.
      SERVICE wikibase:label { bd:serviceParam wikibase:language "ru,en". }
    } GROUP BY ?game ?gameLabel ORDER BY DESC(?links) LIMIT 20`;
  const j = await http(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`, {
    timeout: 60_000,
    // Wikimedia's policy: clients name themselves (Api-User-Agent is the header meant for browsers).
    headers: {
      'User-Agent': 'HomeNewTab/0.3 (personal Firefox new tab extension)',
      'Api-User-Agent': 'HomeNewTab/0.3 (personal Firefox new tab extension)',
    },
  });
  const games = j.results.bindings
    .map((b) => ({ name: b.gameLabel.value, year: Number(b.y.value), link: b.game.value }))
    .filter((g) => !/^Q\d+$/.test(g.name) && g.year < d.getFullYear())
    .slice(0, CONFIG.today.max);
  return { day: dayKey(d), games };
}
loadToday.isCurrent = (v) => v?.day === dayKey();

const SOURCES = {
  weather: loadWeather,
  rates: loadRates,
  dtf: loadDtf,
  steam: loadSteam,
  net: loadNet,
  wallpapers: loadWallpapers,
  giveaways: loadGiveaways,
  kp: loadKp,
  players: loadPlayers,
  today: loadToday,
};
