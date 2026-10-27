'use strict';

/**
 * Spotify mini player. Web API with PKCE (no client secret), so it sees playback on any device,
 * the desktop app included; play/pause/skip need Premium. The token lives in storage.local.
 * Setup: CONFIG.spotify.clientId from developer.spotify.com, redirect URI = identity.getRedirectURL().
 */

const SPOTIFY_SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing';
const SPOTIFY_POLL_MS = 5_000;

const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function spotifyTokenRequest(params) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CONFIG.spotify.clientId, ...params }),
  });
  if (!res.ok) throw Object.assign(new Error(`Spotify token HTTP ${res.status}`), { status: res.status });
  const j = await res.json();
  const auth = {
    access: j.access_token,
    refresh: j.refresh_token ?? params.refresh_token,
    expires: Date.now() + j.expires_in * 1000,
  };
  await ext.storage.local.set({ spotifyAuth: auth });
  return auth;
}

async function spotifyLogin() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const redirect = ext.identity.getRedirectURL();
  const back = await ext.identity.launchWebAuthFlow({
    interactive: true,
    url: 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
      client_id: CONFIG.spotify.clientId,
      response_type: 'code',
      redirect_uri: redirect,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      scope: SPOTIFY_SCOPES,
    }),
  });
  const code = new URL(back).searchParams.get('code');
  if (!code) throw new Error('Spotify: no code in ' + back);
  await spotifyTokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier });
}

/** A valid access token, refreshed when it is about to expire; null when not logged in. */
async function spotifyToken() {
  const { spotifyAuth: auth } = await ext.storage.local.get('spotifyAuth');
  if (!auth) return null;
  if (Date.now() < auth.expires - 60_000) return auth.access;
  try {
    return (await spotifyTokenRequest({ grant_type: 'refresh_token', refresh_token: auth.refresh })).access;
  } catch (e) {
    if (e.status === 400) await ext.storage.local.remove('spotifyAuth'); // revoked: log in again
    throw e;
  }
}

async function spotifyApi(method, path) {
  const token = await spotifyToken();
  if (!token) return { loggedOut: true };
  const res = await fetch(`https://api.spotify.com/v1${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    await ext.storage.local.set({ spotifyAuth: { ...(await ext.storage.local.get('spotifyAuth')).spotifyAuth, expires: 0 } });
    return { retry: true };
  }
  if (res.status === 204 || res.status === 202) return { empty: true };
  if (!res.ok) throw new Error(`Spotify ${method} ${path}: HTTP ${res.status}`);
  return res.headers.get('content-type')?.includes('json') ? res.json() : { empty: true };
}

/* ---------- UI ---------- */

const player = {
  state: null, // last /me/player answer
  at: 0, // when it was fetched (progress runs on from there)
  timer: null,
  tick: null,
};

function mmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function playerPoll() {
  clearTimeout(player.timer);
  try {
    let r = await spotifyApi('GET', '/me/player');
    if (r.retry) r = await spotifyApi('GET', '/me/player');
    if (r.loggedOut) return renderPlayer('login');
    player.state = r.empty || !r.item ? null : r;
    player.at = Date.now();
    renderPlayer();
  } catch (e) {
    console.warn('spotify', e);
  }
  if (document.visibilityState === 'visible') player.timer = setTimeout(playerPoll, SPOTIFY_POLL_MS);
}

async function playerCommand(method, path) {
  try {
    await spotifyApi(method, path);
  } catch (e) {
    console.warn('spotify command', e);
  }
  setTimeout(playerPoll, 400); // Spotify needs a moment before the state reflects the command
}

function renderPlayer(mode) {
  const root = $('player');
  clearInterval(player.tick);
  if (mode === 'login') {
    return root.replaceChildren(el('button.player-chip', {
      async onclick() {
        try {
          await spotifyLogin();
          playerPoll();
        } catch (e) {
          console.warn('spotify login', e);
          this.textContent = '🎵 Не вышло войти — ещё раз';
        }
      },
    }, '🎵 Подключить Spotify'));
  }
  const s = player.state;
  if (!s) return root.replaceChildren(el('div.player-chip.idle', '🎵 Spotify: ничего не играет'));

  const item = s.item;
  const cover = item.album?.images?.findLast((i) => i.width >= 64)?.url ?? item.album?.images?.[0]?.url;
  const bar = el('i');
  const time = el('span.time');
  const progress = () => {
    const ms = Math.min(item.duration_ms, s.progress_ms + (s.is_playing ? Date.now() - player.at : 0));
    bar.style.width = `${(ms / item.duration_ms) * 100}%`;
    time.textContent = `${mmss(ms)} / ${mmss(item.duration_ms)}`;
  };
  progress();
  if (s.is_playing) player.tick = setInterval(progress, 1000);

  root.replaceChildren(
    el('a.cover', { href: item.external_urls?.spotify, title: 'Открыть в Spotify' }, cover && el('img', { src: cover, alt: '' })),
    el('div.track',
      el('div.name', item.name),
      el('div.artist', (item.artists ?? []).map((a) => a.name).join(', ')),
      el('div.progress', bar),
      el('div.controls',
        el('button', { title: 'Предыдущий', onclick: () => playerCommand('POST', '/me/player/previous') }, '⏮'),
        el('button.play', {
          title: s.is_playing ? 'Пауза' : 'Играть',
          onclick: () => playerCommand('PUT', s.is_playing ? '/me/player/pause' : '/me/player/play'),
        }, s.is_playing ? '⏸' : '▶'),
        el('button', { title: 'Следующий', onclick: () => playerCommand('POST', '/me/player/next') }, '⏭'),
        time,
        s.device?.name && el('span.device', { title: 'Где играет' }, s.device.name),
      ),
    ),
  );
}

if (CONFIG.spotify?.clientId) {
  playerPoll();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') playerPoll();
  });
}
