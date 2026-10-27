'use strict';

/* Paints from storage.local at once, then asks the background to refresh what is stale. */

const $ = (id) => document.getElementById(id);

/** Tiny DOM builder: el('div.a.b', {href}, child, 'text', ...). Text is never parsed as HTML. */
function el(spec, attrs, ...children) {
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    children.unshift(attrs);
    attrs = {};
  }
  const [tag, ...classes] = spec.split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : String(c));
  }
  return node;
}

const SVG = 'http://www.w3.org/2000/svg';
const ru = 'ru-RU';
const compact = new Intl.NumberFormat(ru, { notation: 'compact', maximumFractionDigits: 1 });
const fmt = (n, digits = 2) => n.toLocaleString(ru, { minimumFractionDigits: digits, maximumFractionDigits: digits });
const plural = (n, one, few, many) =>
  n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many;

function ago(ms) {
  const min = Math.floor((Date.now() - ms) / 60_000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'вчера' : `${d} ${plural(d, 'день', 'дня', 'дней')} назад`;
}

let data = {};

/* ---------- Clock ---------- */

function renderClock() {
  const now = new Date();
  $('clock').textContent = now.toLocaleTimeString(ru, { hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString(ru, { weekday: 'long', day: 'numeric', month: 'long' });
  $('date').textContent = date[0].toUpperCase() + date.slice(1);
  setTimeout(renderClock, 60_000 - (Date.now() % 60_000) + 20);
}

/* ---------- Network ---------- */

function renderNet() {
  const net = data.net?.v;
  if (!net) return $('net').replaceChildren();
  const flag = net.country.toUpperCase().replace(/[A-Z]/g, (c) => String.fromCodePoint(0x1f1a5 + c.charCodeAt(0)));
  let name = net.country;
  try {
    name = new Intl.DisplayNames([ru], { type: 'region' }).of(net.country);
  } catch {}
  $('net').replaceChildren(
    el('span.flag', flag), ` ${name}`,
    net.ping != null ? el('span.dim', ` · ${net.ping} мс`) : '',
  );
  $('net').title = 'Через какую страну сейчас выходит интернет';
}

/* ---------- Currency ---------- */

function sparkline(values, up) {
  const w = 120, h = 30, pad = 3;
  const min = Math.min(...values), max = Math.max(...values);
  const x = (i) => pad + (i / (values.length - 1 || 1)) * (w - pad * 2);
  const y = (v) => pad + (max === min ? 0.5 : 1 - (v - min) / (max - min)) * (h - pad * 2);
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('class', `spark ${up ? 'up' : 'down'}`);
  const line = document.createElementNS(SVG, 'polyline');
  line.setAttribute('points', values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '));
  const dot = document.createElementNS(SVG, 'circle');
  dot.setAttribute('cx', x(values.length - 1));
  dot.setAttribute('cy', y(values.at(-1)));
  dot.setAttribute('r', 2.6);
  svg.append(line, dot);
  return svg;
}

function renderRates() {
  const rates = data.rates?.v;
  if (!rates) return;
  $('rates').replaceChildren(
    ...rates.map(({ code, history: raw, date }) => {
      // Cheap currencies (tenge) read better per 100 units, like the CBR quotes them.
      const scale = raw.at(-1) < 1 ? 100 : 1;
      const history = raw.map((v) => v * scale);
      const now = history.at(-1);
      const change = history.length > 1 ? now - history.at(-2) : 0;
      const up = now >= history[0];
      const per = scale > 1 ? ` за ${scale} ${code}` : '';
      return el('div.rate', { title: `ЦБ РФ на ${date}${per}, график за ${CONFIG.rates.days} дн` },
        el('span.code', code, scale > 1 && el('small', `×${scale}`)),
        el('span.value', fmt(now)),
        el(`span.change.${change >= 0 ? 'up' : 'down'}`, `${change >= 0 ? '▲' : '▼'}${fmt(Math.abs(change))}`),
        sparkline(history, up),
      );
    }),
  );
}

/* ---------- Weather ---------- */

const WEATHER = {
  describe(code) {
    const names = {
      0: 'Ясно', 1: 'Преимущественно ясно', 2: 'Переменная облачность', 3: 'Пасмурно', 45: 'Туман', 48: 'Туман',
      51: 'Морось', 53: 'Морось', 55: 'Морось', 56: 'Ледяная морось', 57: 'Ледяная морось',
      61: 'Небольшой дождь', 63: 'Дождь', 65: 'Сильный дождь', 66: 'Ледяной дождь', 67: 'Ледяной дождь',
      71: 'Небольшой снег', 73: 'Снег', 75: 'Сильный снег', 77: 'Снежная крупа',
      80: 'Ливень', 81: 'Ливень', 82: 'Ливень', 85: 'Снегопад', 86: 'Снегопад',
      95: 'Гроза', 96: 'Гроза с градом', 99: 'Гроза с градом',
    };
    return names[code] ?? '';
  },
  icon(code, isDay = true) {
    if (code === 0) return isDay ? '☀️' : '🌙';
    if (code === 1) return isDay ? '🌤️' : '🌙';
    if (code === 2) return isDay ? '⛅' : '☁️';
    if (code === 3) return '☁️';
    if (code === 45 || code === 48) return '🌫️';
    if (code >= 51 && code <= 55) return '🌦️';
    if ((code >= 56 && code <= 67) || (code >= 80 && code <= 82)) return '🌧️';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return '🌨️';
    if (code >= 95) return '⛈️';
    return '🌡️';
  },
  isPrecipitation: (code) => code >= 51 && code <= 99,
  kind: (code) => ((code >= 71 && code <= 77) || code === 85 || code === 86 ? 'снег' : code >= 95 ? 'гроза' : 'дождь'),
};
const temp = (t) => `${t > 0 ? '+' : ''}${t}°`;

function renderWeather() {
  const w = data.weather?.v;
  if (!w) return;
  const now = Date.now();
  const hours = w.hours.filter((h) => h.time > now - 3_600_000).slice(0, 13);
  // The current hour from the hourly forecast, when the stored "current" is getting old.
  const cur = now - data.weather.t > 45 * 60_000 && hours[0] ? hours[0] : w;
  const curTemp = cur.temp, curCode = cur.code;

  const rain = hours.slice(0, 5).find((h) => h.prec >= 50 && WEATHER.isPrecipitation(h.code));
  let rainText = null;
  if (rain) {
    const inHours = Math.floor((rain.time - now + 30 * 60_000) / 3_600_000);
    rainText = inHours <= 0 ? `☔ сейчас ${WEATHER.kind(rain.code)}` : `☔ ${WEATHER.kind(rain.code)} через ${inHours} ч`;
  }

  const day = (iso) => new Date(`${iso}T12:00`).toLocaleDateString(ru, { weekday: 'short' });
  const clock = (iso) => iso?.slice(11, 16);
  const today = w.days[0];
  $('weather').replaceChildren(
    el('div.now',
      el('span.icon', WEATHER.icon(curCode, cur.isDay)),
      el('div',
        el('div.temp', temp(curTemp)),
        el('div.dim', `${CONFIG.weather.city} · ${WEATHER.describe(curCode)}`),
        today?.sunrise && el('div.sun.dim', `🌅 ${clock(today.sunrise)}  🌇 ${clock(today.sunset)}`),
        rainText && el('div.rain', rainText),
        stormText(),
      ),
    ),
    el('div.days',
      w.days.slice(1, 4).map((d) =>
        el('div.day',
          el('div.dim', day(d.date)),
          el('div.icon', WEATHER.icon(d.code)),
          el('div', `${temp(d.max)} `, el('span.dim', temp(d.min))),
        ),
      ),
    ),
    el('div.hours',
      hours.slice(1).map((h) =>
        el('div.hour',
          el('div.dim', new Date(h.time).toLocaleTimeString(ru, { hour: '2-digit', minute: '2-digit' })),
          el('div.icon', WEATHER.icon(h.code, h.isDay)),
          el('div', temp(h.temp)),
          el(`div.prec${h.prec >= 50 ? '.wet' : ''}`, h.prec ? `${h.prec}%` : ''),
        ),
      ),
    ),
  );
}

/** "🧲 магнитная буря, Kp 5 · завтра с 15:00" when the next 24 hours reach CONFIG.stormKp. */
function stormText() {
  const now = Date.now();
  const slots = (data.kp?.v ?? []).filter((s) => s.time + 3 * 3600_000 > now && s.time < now + 24 * 3600_000);
  const storm = slots.filter((s) => s.kp >= CONFIG.stormKp);
  if (!storm.length) return null;
  const max = Math.max(...storm.map((s) => s.kp));
  const first = storm[0].time;
  let when = 'сейчас';
  if (first > now) {
    const d = new Date(first);
    const isToday = d.toDateString() === new Date(now).toDateString();
    when = `${isToday ? 'сегодня' : 'завтра'} с ${d.toLocaleTimeString(ru, { hour: '2-digit', minute: '2-digit' })}`;
  }
  return el('div.storm', { title: 'Прогноз NOAA, индекс Kp (5 = слабая буря, 9 = экстремальная)' },
    `🧲 магнитная буря, Kp ${Math.round(max)} · ${when}`);
}

/* ---------- Bookmarks ---------- */

async function bookmarkFolder() {
  const { folder } = CONFIG.bookmarks;
  if (folder) {
    const found = (await ext.bookmarks.search({ title: folder })).find((b) => !b.url);
    if (found) return found.id;
  }
  return 'toolbar_____';
}

async function renderBookmarks() {
  let items = [];
  try {
    items = (await ext.bookmarks.getChildren(await bookmarkFolder()))
      .filter((b) => b.url && /^https?:/.test(b.url))
      .slice(0, CONFIG.bookmarks.max);
  } catch (e) {
    console.warn('bookmarks', e);
  }
  $('bookmarks').replaceChildren(
    ...items.map((b) => {
      const host = new URL(b.url).hostname;
      const name = b.title || host.replace(/^www\./, '');
      const letter = el('span.letter', name[0]?.toUpperCase() ?? '?');
      const icon = el('img', {
        src: `https://www.google.com/s2/favicons?domain=${host}&sz=64`,
        alt: '',
        onload() {
          // Google answers with a 16 px globe when it knows no icon.
          if (this.naturalWidth > 16) letter.replaceWith(this);
        },
      });
      return el('a.bookmark', { href: b.url, title: b.url }, el('span.favicon', letter), el('span.label', name));
    }),
  );
}

/* ---------- Rotating panels with a timer bar ---------- */

/** A panel that shows pages in turn; the timer bar's animation end flips the page, hover pauses it. */
class Rotator {
  constructor(root, ms) {
    this.root = root;
    this.ms = ms;
    this.page = 0;
    this.pages = [];
  }

  set(pages) {
    this.pages = pages;
    this.page = Math.min(this.page, Math.max(0, pages.length - 1));
    this.draw();
  }

  go(page) {
    this.page = (page + this.pages.length) % this.pages.length;
    this.draw();
  }

  draw() {
    const page = this.pages[this.page];
    if (!page) return this.root.replaceChildren();
    const bar = el('i', { style: `animation-duration:${this.ms}ms` });
    if (this.pages.length > 1) bar.addEventListener('animationend', () => this.go(this.page + 1));
    this.root.replaceChildren(
      el('div.panel-head', page.head(this)),
      el(`div.timer${this.pages.length > 1 ? '' : '.idle'}`, bar),
      page.body(),
    );
  }
}

/* ---------- News: DTF ---------- */

const news = new Rotator($('news'), CONFIG.dtf.rotateMs);

function renderNews() {
  const cats = data.dtf?.v;
  if (!cats) return;
  news.set(cats.map((cat, i) => ({
    head: (r) => [
      el('a.brand', { href: 'https://dtf.ru/' }, 'DTF'),
      cats.map((c, j) => el(`button.tab${j === i ? '.on' : ''}`, { onclick: () => r.go(j) }, c.label)),
    ],
    body: () => el('div.list.grid.news-grid', cat.items.map(newsItem)),
  })));
}

function newsItem(n) {
  return el('a.item.news-item', { href: n.link },
    el('div.thumb',
      n.image && el('img', { src: n.image, alt: '', loading: 'lazy' }),
      n.summary && el('div.summary', n.summary),
    ),
    el('div.text',
      el('div.title', n.title),
      el('div.meta', ago(n.date), n.comments > 0 && ` · 💬 ${n.comments}`),
    ),
  );
}

/* ---------- Steam ---------- */

const steam = new Rotator($('steam'), CONFIG.steam.rotateMs);
const storeUrl = (id) => `https://store.steampowered.com/app/${id}/`;

function releaseDate(u) {
  const d = new Date(u.release);
  const days = Math.ceil((u.release - Date.now()) / 86_400_000);
  switch (u.display) {
    case 'date_full':
      return [
        d.toLocaleDateString(ru, { day: 'numeric', month: 'short' }).replace('.', ''),
        days <= 0 ? 'сегодня' : days === 1 ? 'завтра' : `через ${days} ${plural(days, 'день', 'дня', 'дней')}`,
      ];
    case 'date_month':
      return [d.toLocaleDateString(ru, { month: 'long', year: 'numeric' }).replace(' г.', ''), ''];
    case 'date_quarter':
      return [`Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`, ''];
    case 'date_year':
      return [String(d.getFullYear()), ''];
    default:
      return ['Скоро', ''];
  }
}

/** "👥 30,5 тыс." current players, when Steam reports any. */
function online(appId) {
  const n = data.players?.v?.counts?.[appId];
  return n > 0 && el('span.online', { title: 'Играют сейчас' }, `👥 ${compact.format(n)}`);
}

/** "3 380₸" -> "3 380₸ (≈590 ₽)" by today's CBR rate; other currencies as they are. */
function withRub(price) {
  const kzt = data.rates?.v?.find((r) => r.code === 'KZT')?.history.at(-1);
  const amount = Number(price.replace(/[^\d]/g, ''));
  if (!kzt || !/₸/.test(price) || !amount) return price;
  const rub = amount * kzt;
  const rounded = rub >= 1000 ? Math.round(rub / 10) * 10 : Math.round(rub);
  return [price, el('span.rub', ` (≈${rounded.toLocaleString(ru)} ₽)`)];
}

const reviews = (p) => p > 0 && el(`span.reviews${p >= 80 ? '.good' : ''}`, { title: 'Положительных отзывов' }, `👍 ${p}%`);

function steamCard(item, ...lines) {
  return el('a.item.game', { href: storeUrl(item.appId) },
    el('div.capsule', item.image && el('img', { src: item.image, alt: '', loading: 'lazy' })),
    el('div.text', el('div.title.one', item.name), ...lines),
  );
}

function dealCard(d) {
  const isNew = d.firstSeen > 0 && Date.now() - d.firstSeen < CONFIG.steam.newDealMs;
  return steamCard(d,
    el('div.badges',
      el('span.pct', `−${d.discount}%`),
      el('span.price', withRub(d.price)),
      el('s.dim', d.oldPrice),
    ),
    el('div.badges',
      d.historicalLow && el('span.low', { title: 'Самая низкая цена за всю историю (CheapShark)' }, '🔥 мин.'),
      isNew && el('span.new', 'NEW'),
      reviews(d.reviews),
      online(d.appId),
    ),
  );
}

function upcomingCard(u) {
  const [date, countdown] = releaseDate(u);
  return steamCard(u, el('div.badges', el('span.date', date), countdown && el('span.dim', countdown)));
}

function freshCard(f) {
  const days = Math.floor((Date.now() - f.released) / 86_400_000);
  return steamCard(f,
    el('div.badges',
      f.discount > 0 && el('span.pct', `−${f.discount}%`),
      el('span.price', withRub(f.price)),
      el('span.dim', days === 0 ? 'сегодня' : days === 1 ? 'вчера' : `${days} дн назад`),
    ),
    el('div.badges', reviews(f.reviews), el('span.dim', `${compact.format(f.reviewCount)} отзывов`), online(f.appId)),
  );
}

function giveawayCard(g) {
  let ends = null;
  if (g.ends) {
    const days = Math.floor((g.ends - Date.now()) / 86_400_000);
    const date = new Date(g.ends).toLocaleDateString(ru, { day: 'numeric', month: 'short' }).replace('.', '');
    ends = days < 1 ? el('span.low', 'последний день') : el('span.dim', `до ${date} · ещё ${days} ${plural(days, 'день', 'дня', 'дней')}`);
  }
  return el('a.item.game', { href: g.link },
    el('div.capsule', g.image && el('img', { src: g.image, alt: '', loading: 'lazy' })),
    el('div.text',
      el('div.title.one', g.name),
      el('div.badges', el('span.price', 'Бесплатно'), g.worth && el('s.dim', g.worth)),
      ends && el('div.badges', ends),
    ),
  );
}

/**
 * "Зимняя распродажа через 51 день" / "Steam Scream V идёт · ещё 6 дней". While a small event is on,
 * the next big sale is shown too.
 */
function steamEvent() {
  const now = Date.now();
  const events = CONFIG.steam.events
    .map((e) => ({ ...e, from: Date.parse(e.start), to: Date.parse(e.end) }))
    .filter((e) => e.to > now)
    .sort((a, b) => a.from - b.from);
  const days = (ms) => {
    const d = Math.ceil(ms / 86_400_000);
    return d <= 1 ? (ms < 86_400_000 / 2 ? 'сегодня' : 'завтра') : `через ${d} ${plural(d, 'день', 'дня', 'дней')}`;
  };
  const left = (ms) => {
    const d = Math.ceil(ms / 86_400_000);
    return d <= 1 ? 'последний день' : `ещё ${d} ${plural(d, 'день', 'дня', 'дней')}`;
  };
  const parts = [];
  const live = events.find((e) => e.from <= now);
  if (live) parts.push(el(`span.event.live${live.demo ? '.demo' : ''}`, `${live.demo ? '🎮' : '🔥'} ${live.name} идёт · ${left(live.to - now)}`));
  const nextBig = events.find((e) => e.big && e.from > now);
  const next = live ? nextBig : events.find((e) => e.from > now && !e.demo) ?? nextBig;
  if (next) parts.push(el('span.event', `${next.name} ${days(next.from - now)}`));
  return parts.length ? el('span.events', { title: 'Даты Valve; список — config.js, steam.events' }, parts) : null;
}

function myGameCard(g, i) {
  const playing = i === 0 && data.mysteam?.v?.playing === g.name;
  return steamCard(g,
    el('div.badges', playing ? el('span.new', 'ИГРАЮ СЕЙЧАС') : '', el('span', g.details[0] ?? '')),
    g.details[1] ? el('div.badges', el('span.dim', g.details[1])) : '',
  );
}

function renderSteam() {
  const s = data.steam?.v ?? { deals: [], fresh: [], upcoming: [] };
  const free = (data.giveaways?.v ?? []).filter((g) => !g.ends || g.ends > Date.now());
  const newThisWeek = s.deals.filter((d) => d.firstSeen > 0 && Date.now() - d.firstSeen < 7 * 86_400_000).length;
  // One page per section, the whole list in it (scrolls when it does not fit).
  const sections = [
    ['Скидки', s.deals, dealCard],
    ['Новинки', s.fresh, freshCard],
    ['Скоро выйдет', s.upcoming, upcomingCard],
    ['Мои игры', data.mysteam?.v?.games ?? [], myGameCard],
    ['Бесплатно', free, giveawayCard],
  ].filter(([, items]) => items.length);
  steam.set(sections.map(([, items, card], i) => ({
    head: (r) => [
      el('a.brand', { href: 'https://store.steampowered.com/wishlist/' }, 'Игры'),
      sections.map(([title, list], j) =>
        el(`button.tab${j === i ? '.on' : ''}`, { onclick: () => r.go(j) }, title,
          el('span.count', list.length),
          title === 'Скидки' && newThisWeek > 0 && el('span.count.fresh', { title: 'Новых скидок за неделю' }, `+${newThisWeek}`)),
      ),
      steamEvent(),
    ],
    body: () => el('div.list.grid', items.map((item, n) => card(item, n))),
  })));
}

/* ---------- On this day: games released on this date ---------- */

function renderFact() {
  const t = data.today?.v;
  const games = t?.day === dayKey() ? t.games : [];
  const button = $('fact');
  if (!games.length) return button.replaceChildren();
  // A different game on every new tab, the click shows the next one.
  let index = 0;
  try {
    index = Number(localStorage.getItem('factIndex')) || 0;
  } catch {}
  const show = () => {
    const g = games[index % games.length];
    const years = new Date().getFullYear() - g.year;
    button.replaceChildren(`🎮 ${years} ${plural(years, 'год', 'года', 'лет')} назад вышла `, el('b', g.name), el('span.dim', ` · ${g.year}`));
    try {
      localStorage.setItem('factIndex', String(index + 1));
    } catch {}
  };
  button.onclick = () => {
    index++;
    show();
  };
  show();
}

/* ---------- To-do: a chip with the next item, the list opens on click; kept in storage.sync ---------- */

let todos = [];
const todoChip = el('button.todo-chip', { title: 'Дела', onclick: () => toggleTodo() });
const todoList = el('ul.todo-list');
const todoInput = el('input', {
  placeholder: 'Добавить дело и Enter',
  maxlength: 200,
  onkeydown(e) {
    const text = this.value.trim();
    if (e.key === 'Escape') return toggleTodo(false);
    if (e.key !== 'Enter' || !text) return;
    todos.push({ id: Date.now().toString(36), text, done: false });
    this.value = '';
    saveTodos();
  },
});

function toggleTodo(open = !$('todo').classList.contains('open')) {
  $('todo').classList.toggle('open', open);
  if (open) todoInput.focus();
}

function saveTodos() {
  renderTodo();
  ext.storage.sync.set({ todos }).catch((e) => console.warn('todos', e));
}

function renderTodo() {
  const left = todos.filter((t) => !t.done);
  const done = todos.length - left.length;
  todoChip.replaceChildren(
    ...(left.length
      ? [el('span.box'), el('span.todo-text', left[0].text), left.length > 1 ? el('span.more', `+${left.length - 1}`) : '']
      : [el('span.dim', '＋ Дела')]),
  );
  todoList.replaceChildren(
    ...[...left, ...todos.filter((t) => t.done)].map((t) =>
      el(`li${t.done ? '.done' : ''}`,
        el('button.check', {
          title: t.done ? 'Вернуть' : 'Готово',
          onclick() {
            t.done = !t.done;
            saveTodos();
          },
        }, t.done ? '✓' : ''),
        el('span.todo-text', t.text),
        el('button.remove', {
          title: 'Удалить',
          onclick() {
            todos = todos.filter((x) => x !== t);
            saveTodos();
          },
        }, '×'),
      ),
    ),
    ...(done > 1 ? [el('li.clear', el('button', {
      onclick() {
        todos = todos.filter((t) => !t.done);
        saveTodos();
      },
    }, `Убрать выполненные (${done})`))] : []),
  );
}

$('todo').append(todoChip, el('div.todo-pop', todoInput, todoList));
document.addEventListener('pointerdown', (e) => {
  if (!$('todo').contains(e.target)) toggleTodo(false);
});
ext.storage.sync.get('todos').then((r) => {
  todos = r.todos ?? [];
  renderTodo();
});

/* ---------- Background photo ---------- */

let shownWallpaper = null;
let bgLayer = 'a';

const stored = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
};
const store = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
};

/** A random photo, never the one on screen and not one of the last few shown. */
function randomWallpaper() {
  const list = data.wallpapers?.v ?? [];
  const recent = stored('recentWallpapers') ?? [];
  const pool = list.filter((w) => w.url !== shownWallpaper?.url && !recent.includes(w.url));
  const from = pool.length ? pool : list.filter((w) => w.url !== shownWallpaper?.url);
  return from.length ? from[Math.floor(Math.random() * from.length)] : list[0] ?? null;
}

/** Tries the main URL, then the fallback; resolves with the one that loaded. */
function loadImage(w) {
  return [w.url, w.fallback].filter(Boolean).reduce(
    (prev, url) => prev.catch(() => new Promise((ok, fail) => {
      const img = new Image();
      img.onload = () => (img.naturalWidth >= img.naturalHeight * 1.2 ? ok(url) : fail(new Error('portrait')));
      img.onerror = fail;
      img.src = url;
    })),
    Promise.reject(new Error('start')),
  );
}

/**
 * Every new tab gets a random photo. The next one is picked and downloaded ahead
 * (localStorage.nextWallpaper), so the following tab opens with its photo already in the cache.
 */
async function renderWallpaper(w) {
  if (!w) {
    if (shownWallpaper || !data.wallpapers?.v?.length) return; // new data while a photo is shown: keep it
    const next = stored('nextWallpaper');
    w = (next && data.wallpapers.v.find((x) => x.url === next.w?.url)) || randomWallpaper();
  }
  if (!w) return;
  shownWallpaper = w;
  try {
    const url = await loadImage(w);
    if (shownWallpaper !== w) return;
    const layer = $(`bg-${bgLayer === 'a' ? 'b' : 'a'}`);
    layer.style.backgroundImage = `url("${url}")`;
    layer.classList.add('on');
    $(`bg-${bgLayer}`).classList.remove('on');
    bgLayer = bgLayer === 'a' ? 'b' : 'a';
  } catch (e) {
    console.warn('wallpaper', w.url, e);
  }
  renderCaption(w);
  store('recentWallpapers', [w.url, ...(stored('recentWallpapers') ?? [])].slice(0, 8));
  const upcoming = randomWallpaper();
  if (upcoming) {
    loadImage(upcoming)
      .then((url) => store('nextWallpaper', { w: upcoming, url }))
      .catch(() => {});
  }
}

const nextWallpaper = () => {
  const next = stored('nextWallpaper');
  renderWallpaper((next && data.wallpapers?.v?.find((x) => x.url === next.w?.url)) || randomWallpaper());
};

function renderCaption(w) {
  $('caption').replaceChildren(
    el(w.link ? 'a.title' : 'span.title', { href: w.link }, w.kind === 'space' ? '🌌 ' : '📷 ', w.title),
    w.credit ? el('span.dim', w.credit) : '',
    el('button.next', { title: 'Другой фон', onclick: nextWallpaper }, '⟳'),
  );
}

/** A tab left open also changes its photo every CONFIG.wallpapers.rotateMin minutes. */
function scheduleWallpaper() {
  setInterval(nextWallpaper, CONFIG.wallpapers.rotateMin * 60_000);
}

/* ---------- Wiring ---------- */

const RENDER = {
  net: renderNet,
  rates: () => {
    renderRates();
    renderSteam(); // ≈ rubles next to tenge prices
  },
  weather: renderWeather,
  dtf: renderNews,
  steam: renderSteam,
  wallpapers: renderWallpaper,
  giveaways: renderSteam,
  kp: renderWeather,
  players: renderSteam,
  mysteam: renderSteam,
  today: renderFact,
};

function render(key) {
  try {
    RENDER[key]?.();
  } catch (e) {
    console.error('render', key, e);
  }
}

(function paintPrefetchedBackground() {
  // The photo prefetched by the previous tab is in the cache: show it at once, no fade.
  const url = stored('nextWallpaper')?.url;
  if (url) {
    $('bg-a').style.backgroundImage = `url("${url}")`;
    $('bg-a').classList.add('on', 'instant');
  }
})();

/* ---------- Site access: Firefox lets the user switch MV3 host permissions off ---------- */

async function checkAccess() {
  const origins = ext.runtime.getManifest().host_permissions;
  if (await ext.permissions.contains({ origins })) return;
  const banner = el('div.access',
    'Нет доступа к сайтам — Steam и курсы не загрузятся. ',
    el('button', {
      async onclick() {
        if (!(await ext.permissions.request({ origins }))) return;
        banner.remove();
        ext.runtime.sendMessage({ type: 'refresh', force: true }).catch(() => {});
      },
    }, 'Разрешить'),
  );
  document.body.append(banner);
}

checkAccess().catch((e) => console.warn('permissions', e));
renderClock();
renderBookmarks();
for (const e of ['onCreated', 'onRemoved', 'onChanged', 'onMoved']) ext.bookmarks[e]?.addListener(renderBookmarks);

ext.storage.local.get(null).then((all) => {
  data = all;
  Object.keys(RENDER).forEach(render);
  ext.runtime.sendMessage({ type: 'refresh' }).catch(() => {});
});

ext.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.todos) {
    todos = changes.todos.newValue ?? [];
    renderTodo();
  }
  if (area !== 'local') return;
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (!(key in RENDER) || !newValue || newValue.t === data[key]?.t) continue;
    data[key] = newValue;
    render(key);
  }
});

scheduleWallpaper();
// Relative times and the hourly weather go stale while the tab stays open.
setInterval(() => {
  render('weather');
  render('dtf');
}, 5 * 60_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') ext.runtime.sendMessage({ type: 'refresh' }).catch(() => {});
});
