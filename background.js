'use strict';

/**
 * Keeps every source fresh in storage.local, so a new tab paints instantly from cache.
 * Runs on a timer and whenever a tab opens (only stale sources are fetched).
 * storage.local[key] = { t: time of the last good load, v: value, error?: last failure }.
 */

const inflight = {};

async function refresh(key, force = false) {
  if (inflight[key]) return inflight[key];
  const stored = (await ext.storage.local.get(key))[key];
  const age = Date.now() - (stored?.t ?? 0);
  // A failed source is retried after a minute, not on every new tab.
  const failedRecently = stored?.failedAt && Date.now() - stored.failedAt < 60_000;
  // isCurrent: a source tied to the date (e.g. "on this day") goes stale at midnight too.
  const current = !stored?.v || (SOURCES[key].isCurrent?.(stored.v) ?? true);
  if (!force && ((age < CONFIG.refreshMin[key] * 60_000 && current) || failedRecently)) return;

  inflight[key] = (async () => {
    const start = Date.now();
    try {
      const v = await SOURCES[key](stored?.v);
      await ext.storage.local.set({ [key]: { t: Date.now(), v } });
      console.info('refreshed', key, `${Date.now() - start} ms`);
    } catch (e) {
      console.warn('refresh failed', key, e);
      await ext.storage.local.set({ [key]: { ...stored, failedAt: Date.now(), error: String(e) } });
    } finally {
      delete inflight[key];
    }
  })();
  return inflight[key];
}

const refreshAll = (force) => Promise.all(Object.keys(SOURCES).map((key) => refresh(key, force)));

async function ensureAlarm() {
  if (!(await ext.alarms.get('tick'))) ext.alarms.create('tick', { periodInMinutes: 5 });
}

ext.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  refreshAll(true);
});
ext.runtime.onStartup.addListener(() => {
  ensureAlarm();
  refreshAll();
});
ext.alarms.onAlarm.addListener(() => refreshAll());
ext.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'refresh') return refreshAll(msg.force);
});
// Site access switched on in about:addons: fetch everything that failed without it.
ext.permissions.onAdded.addListener(() => refreshAll(true));
