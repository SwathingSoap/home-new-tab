'use strict';

/**
 * Everything you are likely to tweak lives here. After a change: about:debugging -> "Перезагрузить"
 * (or `npm run dev` picks it up by itself).
 */
const CONFIG = {
  // Weather location. Coordinates are used for the forecast, the name is just a label.
  weather: { city: 'Москва', lat: 55.7558, lon: 37.6173 },

  // Central Bank of Russia currency codes (see https://www.cbr.ru/scripts/XML_val.asp).
  rates: { currencies: { USD: 'R01235', EUR: 'R01239', KZT: 'R01335' }, days: 30 },

  // DTF "popular now" of these sections, rotating in the news block.
  // Section id: open any post via https://api.dtf.ru/v2.1/content?id=<post id>, see result.subsite.id.
  dtf: {
    categories: [
      { label: '🎮 Игры', subsite: 64953 },
      { label: '🎬 Фильмы и сериалы', subsite: 64957 },
    ],
    limit: 15,
    rotateMs: 30_000,
  },

  // Steam: public wishlist (profile privacy "Public" for the game details), store region for prices.
  steam: {
    id: '76561198056775026',
    country: 'KZ',
    rotateMs: 30_000, // sections: deals -> fresh releases -> upcoming
    upcomingMax: 15,
    newDealMs: 48 * 3600_000, // a discount is "NEW" for 2 days after it appeared
    // "Новинки Steam": released in the last N days, with enough reviews and mostly positive.
    freshDays: 21,
    freshMinReviews: 300,
    freshMinPercent: 70,
    freshMax: 15,
    // Steam events for the countdown in the games panel header. Valve announces them ahead
    // (steamdb.info/sales/history); they start and end at 10:00 Pacific time. Add new ones here.
    events: [
      { name: 'Steam Scream V', start: '2026-10-26T10:00-07:00', end: '2026-11-02T10:00-08:00' },
      { name: 'Зимняя распродажа', start: '2026-12-17T10:00-08:00', end: '2027-01-04T10:00-08:00', big: true },
      { name: 'Next Fest', start: '2027-02-22T10:00-08:00', end: '2027-03-01T10:00-08:00', demo: true },
      { name: 'Весенняя распродажа', start: '2027-03-18T10:00-07:00', end: '2027-03-25T10:00-07:00', big: true },
      { name: 'Next Fest', start: '2027-06-14T10:00-07:00', end: '2027-06-21T10:00-07:00', demo: true },
      { name: 'Летняя распродажа', start: '2027-06-24T10:00-07:00', end: '2027-07-08T10:00-07:00', big: true },
    ],
  },

  // "On this day" line under the clock: best known games released on today's date (click = next).
  today: { max: 8 },

  // Spotify mini player: Client ID of your app at developer.spotify.com (empty = no player).
  // Redirect URI to add there: see README (it is identity.getRedirectURL() of this extension).
  spotify: { clientId: 'f5307088d52a45598228009ec719cba6' },

  // Geomagnetic storm warning under the weather when the forecast Kp reaches this (5 = G1 storm).
  stormKp: 5,

  // Bookmarks shown under the clock: this folder (anywhere in the tree), else the bookmarks toolbar.
  bookmarks: { folder: 'Новая вкладка', max: 12 },

  // Backgrounds: Bing photo of the day (last ~15 days) mixed with ESA/Webb and ESA/Hubble images.
  wallpapers: {
    bingMarket: 'ru-RU',
    pattern: ['bing', 'bing', 'space'],
    rotateMin: 30, // every new tab gets a random photo; a tab left open changes it every N minutes
  },

  // Minutes between refreshes of each source (done in the background, tabs open from cache).
  refreshMin: { weather: 30, rates: 180, dtf: 15, steam: 180, net: 5, wallpapers: 720, giveaways: 180, kp: 180, players: 30, today: 720 },
};
