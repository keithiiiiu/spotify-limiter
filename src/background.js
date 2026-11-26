/* Service worker. The ONLY place usage is written. */
importScripts('config.js', 'core.js');

const C = self.SL_CONFIG; // built-in defaults (debug / sync / remote url live only here)
const SL = self.SL;       // SL.getConfig() = EFFECTIVE settings (defaults + central JSON)
const KEY = 'sl_state';
const SYNC_FLUSH_MS = 60 * 1000; // normal upload interval while counting
const SYNC_FLOOR_MS = 15 * 1000; // never write to sync more often than this (quota)

const ICONS = {
  idle:   { 16: 'icons/idle-16.png',   32: 'icons/idle-32.png',   48: 'icons/idle-48.png' },
  active: { 16: 'icons/active-16.png', 32: 'icons/active-32.png', 48: 'icons/active-48.png' },
};

function siteUrlPatterns() {
  return SL.enabledHosts().map((h) => 'https://*.' + h + '/*');
}

/* ---------- helpers ---------- */
const SYNC_TIMEOUT_MS = 3000;
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}
let lastError = null; // shown in the popup to help diagnose problems

/* ---------- storage (serialised so tabs can't race each other) ---------- */
let queue = Promise.resolve();
function withLock(fn) {
  const run = queue.then(() => fn());
  queue = run.catch(() => {});
  return run;
}

async function load() {
  const o = await chrome.storage.local.get(KEY);
  const s = o[KEY] || {};
  s.debug = Object.assign({ offsetMs: 0, speed: 1, ignoreSchoolHours: false }, s.debug);
  s.lastTickReal = s.lastTickReal || 0; // last tick from a TRACKED site (drives "counting")
  s.timerHidden = !!s.timerHidden;
  s.dismissed = s.dismissed || {};
  s.dirtyDays = s.dirtyDays || {};      // day -> revision, waiting to be uploaded to browser sync
  s.usageRev = s.usageRev || 0;
  s.lastSyncWrite = s.lastSyncWrite || 0;
  if (!s.deviceId) {
    s.deviceId = crypto.randomUUID();
    await save(s);
  }
  return s;
}
function save(s) {
  const { usageAll, remote, ...persist } = s; // derived fields are never stored
  return chrome.storage.local.set({ [KEY]: persist });
}
function nowOf(s) { return Date.now() + (C.debug.enabled ? s.debug.offsetMs || 0 : 0); }

/* ---------- activity history: seconds per website per day (host names only) ----------
 * One small storage key per day ("sl_day:2026-11-20" -> { "open.spotify.com": ms, ... }) so a
 * tick only rewrites today's key. Everything older than retention.days is deleted. */
const DAY_PREFIX = 'sl_day:';
const EARLIER = '(earlier)'; // time carried over from versions that only kept a daily total
let dayCache = null;         // Map<day, { host: ms }>
const lastUntracked = new Map(); // host -> last tick time (de-duplicates tabs of the same site)

async function days() {
  if (!dayCache) {
    const all = await chrome.storage.local.get(null);
    const m = new Map();
    Object.keys(all).forEach((k) => { if (k.indexOf(DAY_PREFIX) === 0) m.set(k.slice(DAY_PREFIX.length), all[k]); });
    dayCache = m;
  }
  return dayCache;
}
async function persistDay(day) {
  const m = await days();
  if (m.has(day)) await chrome.storage.local.set({ [DAY_PREFIX + day]: m.get(day) });
  else await chrome.storage.local.remove(DAY_PREFIX + day);
}
function hostOf(sender) {
  try {
    return new URL(sender.url || (sender.tab && sender.tab.url) || '').hostname.toLowerCase().replace(/^www\./, '');
  } catch (e) { return ''; }
}
function retentionDays() {
  const r = (SL.getConfig() || {}).retention;
  return r && Number.isInteger(r.days) && r.days > 0 ? r.days : 30;
}

// Does a host count towards the limits RIGHT NOW? (re-evaluated whenever the list changes,
// which is what makes earlier time on a newly added site count immediately)
let trackedMemo = new Map();
function isTracked(host) {
  if (host === EARLIER) return true;
  let v = trackedMemo.get(host);
  if (v === undefined) { v = !!SL.siteForHost(host); trackedMemo.set(host, v); }
  return v;
}

/* ---------- browser sync: small items per device and day, merged on read ----------
 * Key  u:<device id>:<YYYY-MM-DD>  ->  { v: 2, h: { host: seconds } }
 * (older versions wrote one item u:<device id> -> { d: { day: seconds } }; still read.)
 * Reading other devices' totals NEVER blocks counting or the popup: we serve the last
 * known copy (kept in storage.local) immediately and refresh it in the background. */
const SYNC_ITEM = /^u:([0-9a-f-]{36}):(\d{4}-\d{2}-\d{2})$/;
const REMOTE_KEY = 'sl_remote';
const REMOTE_TTL_MS = 60 * 1000;
let remoteMem = null;         // { items: { key: value }, at: ms }
let remoteRefreshing = false;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && remoteMem) remoteMem.at = 0; // stale -> refresh on next read
});

function refreshRemote() {
  if (remoteRefreshing) return;
  remoteRefreshing = true;
  (async () => {
    try {
      const all = await withTimeout(chrome.storage.sync.get(null), 10000);
      const items = {};
      Object.keys(all).forEach((k) => {
        const v = all[k];
        if (k.indexOf('u:') === 0 && v && (typeof v.h === 'object' || typeof v.d === 'object')) items[k] = v;
      });
      remoteMem = { items, at: Date.now() };
      await chrome.storage.local.set({ [REMOTE_KEY]: remoteMem });
    } catch (e) {
      console.warn('[limiter] sync read failed', e); // counting carries on locally
      if (remoteMem) remoteMem.at = Date.now() - REMOTE_TTL_MS + 10000; // retry in ~10 s
    } finally {
      remoteRefreshing = false;
    }
  })();
}
async function readRemoteAll() {
  if (!C.sync || !C.sync.enabled) return {};
  if (!remoteMem) {
    const o = await chrome.storage.local.get(REMOTE_KEY);
    remoteMem = o[REMOTE_KEY] || { items: {}, at: 0 };
  }
  if (Date.now() - remoteMem.at > REMOTE_TTL_MS) refreshRemote(); // not awaited
  return remoteMem.items;
}

// day -> ms that count towards the limits (tracked sites only), this device + the others.
function poolByDay(local, remoteItems, ownId) {
  const out = {};
  const add = (day, host, ms) => { if (isTracked(host)) out[day] = (out[day] || 0) + ms; };
  local.forEach((hosts, day) => Object.keys(hosts).forEach((h) => add(day, h, hosts[h])));
  Object.keys(remoteItems || {}).forEach((k) => {
    const v = remoteItems[k];
    const m = SYNC_ITEM.exec(k);
    if (m) {
      if (m[1] === ownId || !v.h) return; // our own copy is the local data
      Object.keys(v.h).forEach((h) => add(m[2], h, (Number(v.h[h]) || 0) * 1000));
    } else if (k !== 'u:' + ownId && v.d) { // legacy single-item format: daily totals
      Object.keys(v.d).forEach((day) => add(day, EARLIER, (Number(v.d[day]) || 0) * 1000));
    }
  });
  return out;
}
async function loadMerged() {
  const s = await load();
  s.remote = await readRemoteAll();
  s.usageAll = poolByDay(await days(), s.remote, s.deviceId);
  return s;
}

async function recordTime(s, nowMs, host, addMs) {
  const m = await days();
  const key = SL.dateKey(nowMs);
  const hosts = m.get(key) || {};
  hosts[host] = (hosts[host] || 0) + addMs;
  m.set(key, hosts);
  s.usageRev += 1;
  s.dirtyDays[key] = s.usageRev;
  await persistDay(key);
}

// One-off: older versions kept only { day: ms } for the tracked sites.
async function migrate() {
  await withLock(async () => {
    const s = await load();
    if (!s.usage) return;
    const m = await days();
    for (const day of Object.keys(s.usage)) {
      const hosts = m.get(day) || {};
      hosts[EARLIER] = (hosts[EARLIER] || 0) + s.usage[day];
      m.set(day, hosts);
      s.usageRev += 1;
      s.dirtyDays[day] = s.usageRev;
      await persistDay(day);
    }
    delete s.usage;
    delete s.syncDirty;
    await save(s);
  });
}

// Upload changed days. The network call happens OUTSIDE the storage lock so a slow
// sync can never delay counting. Only the day(s) that changed are written.
let flushing = false;
let lastFlushCheck = 0;
const SYNC_MIN_SECONDS = 30;   // hosts with less time than this on a day are not uploaded
const SYNC_MAX_HOSTS = 60;     // per device and day (keeps every item far below the 8 KB limit)
function dayItem(hosts, strict) {
  const minSec = strict ? 120 : SYNC_MIN_SECONDS;
  const max = strict ? 20 : SYNC_MAX_HOSTS;
  const all = !C.sync || C.sync.allSites !== false;
  const h = {};
  Object.keys(hosts)
    .filter((k) => hosts[k] >= minSec * 1000 && (all || isTracked(k)))
    .sort((a, b) => hosts[b] - hosts[a])
    .slice(0, max)
    .forEach((k) => { h[k] = Math.round(hosts[k] / 1000); });
  return { v: 2, h };
}
async function flushSync(force) {
  if (!C.sync || !C.sync.enabled || flushing) return;
  if (!force && Date.now() - lastFlushCheck < 5000) return;
  lastFlushCheck = Date.now();
  const plan = await withLock(async () => {
    const s = await load();
    const dirty = Object.keys(s.dirtyDays);
    if (!dirty.length) return null;
    const since = Date.now() - s.lastSyncWrite;
    if (since < SYNC_FLOOR_MS || (!force && since < SYNC_FLUSH_MS)) return null;
    const m = await days();
    const hostsByDay = {};
    dirty.forEach((day) => { if (m.has(day)) hostsByDay[day] = Object.assign({}, m.get(day)); });
    return { id: s.deviceId, hostsByDay, rev: s.usageRev, days: dirty };
  });
  if (!plan) return;
  flushing = true;
  let ok = false;
  const build = (strict) => {
    const items = {};
    Object.keys(plan.hostsByDay).forEach((day) => { items['u:' + plan.id + ':' + day] = dayItem(plan.hostsByDay[day], strict); });
    return items;
  };
  const nonEmpty = (items) => { // days with nothing worth uploading (all hosts under the minimum) are skipped
    Object.keys(items).forEach((k) => { if (!Object.keys(items[k].h).length) delete items[k]; });
    return items;
  };
  try {
    try {
      const items = nonEmpty(build(false));
      if (Object.keys(items).length) await withTimeout(chrome.storage.sync.set(items), SYNC_TIMEOUT_MS);
    } catch (e) {
      if (!/QUOTA/i.test(String(e && e.message))) throw e;
      const items = nonEmpty(build(true));
      if (Object.keys(items).length) await withTimeout(chrome.storage.sync.set(items), SYNC_TIMEOUT_MS); // smaller payload
    }
    ok = true;
    // the old single-item format of this device is now redundant
    chrome.storage.sync.remove('u:' + plan.id).catch(() => {});
  } catch (e) {
    console.warn('[limiter] sync write failed', e); // stays dirty, retried later
  }
  flushing = false;
  await withLock(async () => {
    const s = await load();
    s.lastSyncWrite = Date.now();
    if (ok) plan.days.forEach((day) => { if ((s.dirtyDays[day] || 0) <= plan.rev) delete s.dirtyDays[day]; });
    await save(s);
  });
}

// Delete history older than retention.days from this device and from browser sync.
let lastSyncPurge = 0;
async function purgeOld(force) {
  const cutoffOf = (s) => SL.dateKey(SL.addDays(nowOf(s), -retentionDays()));
  let cutoff;
  await withLock(async () => {
    const s = await load();
    cutoff = cutoffOf(s);
    const m = await days();
    let changed = false;
    for (const day of Array.from(m.keys())) {
      if (day < cutoff) {
        m.delete(day);
        await chrome.storage.local.remove(DAY_PREFIX + day);
        delete s.dirtyDays[day];
        changed = true;
      }
    }
    if (changed) await save(s);
  });
  if (!C.sync || !C.sync.enabled) return;
  if (!force && Date.now() - lastSyncPurge < 60 * 60 * 1000) return;
  lastSyncPurge = Date.now();
  try {
    const all = await withTimeout(chrome.storage.sync.get(null), 10000);
    const old = Object.keys(all).filter((k) => { const m = SYNC_ITEM.exec(k); return m && m[2] < cutoff; });
    if (old.length) await withTimeout(chrome.storage.sync.remove(old), 10000);
  } catch (e) { /* retried next hour */ }
}

/* ---------- toolbar button ---------- */
let badgeTimer = null;
let iconState = null;
function setIcon(kind) {
  if (iconState === kind) return;
  iconState = kind;
  chrome.action.setIcon({ path: ICONS[kind] }).catch(() => {});
}
function clearBadge() {
  chrome.action.setBadgeText({ text: '' }).catch(() => {});
  chrome.action.setTitle({ title: 'Streaming time limit' }).catch(() => {});
  setIcon('idle');
}
function showBadge(st) {
  clearTimeout(badgeTimer);
  if (st.counting) {
    const t = st.tightest;
    const color = st.inWarning ? '#d97706' : '#16a34a';
    chrome.action.setBadgeText({ text: t ? SL.badgeText(t.remainingMs) : '\u25CF' });
    chrome.action.setBadgeBackgroundColor({ color });
    if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#ffffff' });
    chrome.action.setTitle({ title: 'Streaming time is being counted' + (t ? ' - ' + SL.fmtDur(t.remainingMs, true) + ' left' : '') });
    setIcon('active');
  } else if (st.locked) {
    chrome.action.setBadgeText({ text: 'LOCK' });
    chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#ffffff' });
    chrome.action.setTitle({ title: 'Streaming is locked - limit reached' });
    setIcon('idle');
  } else {
    clearBadge();
    return;
  }
  badgeTimer = setTimeout(clearBadge, SL.MAX_GAP + 100);
}

/* ---------- mute tracked tabs while locked ---------- */
async function enforceTab(tabId, locked) {
  if (tabId == null) return;
  const o = await chrome.storage.session.get('sl_muted');
  const ours = new Set(o.sl_muted || []);
  try {
    if (locked) {
      const t = await chrome.tabs.get(tabId);
      if (!t.mutedInfo || !t.mutedInfo.muted) {
        await chrome.tabs.update(tabId, { muted: true });
        ours.add(tabId);
      }
    } else if (ours.has(tabId)) {
      await chrome.tabs.update(tabId, { muted: false });
      ours.delete(tabId);
    }
  } catch (e) {
    ours.delete(tabId);
  }
  await chrome.storage.session.set({ sl_muted: [...ours] });
}

// Tabs we muted must not stay muted once the lock is gone - including when the site was
// removed from the tracked list (those tabs no longer match the tracked-site patterns).
async function releaseMutedTabs() {
  const o = await chrome.storage.session.get('sl_muted');
  const ids = o.sl_muted || [];
  if (!ids.length) return;
  const s = await loadMerged();
  const locked = SL.computeStatus(s, nowOf(s), Date.now()).locked;
  const keep = [];
  for (const id of ids) {
    try {
      const t = await chrome.tabs.get(id);
      const host = new URL(t.url || '').hostname.toLowerCase().replace(/^www\./, '');
      if (locked && SL.siteForHost(host)) { keep.push(id); continue; }
      await chrome.tabs.update(id, { muted: false });
    } catch (e) { /* tab closed or not readable: forget it */ }
  }
  await chrome.storage.session.set({ sl_muted: keep });
}

/* ---------- message handlers ---------- */
function publicStatus(s, extra) {
  const st = SL.computeStatus(s, nowOf(s), Date.now());
  st.lastError = lastError;
  st.settings = settingsInfo();
  return extra ? Object.assign(st, extra) : st;
}

function handleTick(kind, sender) {
  return withLock(async () => {
    try { return await tickInner(kind, sender); }
    catch (e) { lastError = 'tick: ' + (e && e.message || e); console.error('[limiter]', e); throw e; }
  });
}

function speedOf(s) { return C.debug.enabled ? Math.max(1, s.debug.speed || 1) : 1; }

async function tickInner(kind, sender) {
  const host = hostOf(sender);
  if (!host) return { tracked: false };
  const site = SL.siteForHost(host); // non-null = this page counts towards the limits
  const real = Date.now();

  /* ----- any other website: just record how long it is on screen during school hours ----- */
  if (!site) {
    if (kind !== 'tick') return { tracked: false };
    const s = await load();
    const n = nowOf(s);
    const inSchool = (C.debug.enabled && s.debug.ignoreSchoolHours) || SL.isSchoolTime(n);
    const gap = real - (lastUntracked.get(host) || 0); // per host: two tabs of one site don't double-count
    lastUntracked.set(host, real);
    if (lastUntracked.size > 300) lastUntracked.clear();
    if (inSchool && gap > 0 && gap <= SL.MAX_GAP) {
      await recordTime(s, n, host, gap * speedOf(s));
      await save(s);
      flushSync(false).catch(() => {}); // fire and forget
    }
    return { tracked: false };
  }

  /* ----- a tracked site: record, count towards the limits, lock, warn ----- */
  const s = await loadMerged();
  const n = nowOf(s);
  let st = SL.computeStatus(s, n, real);

  // Usage fell back below a threshold the student had closed (new day, window
  // slid, usage cleared): forget the dismissal so the banner can return.
  let reset = false;
  st.limits.forEach((l) => {
    if (s.dismissed[l.id] !== undefined && l.level < s.dismissed[l.id]) { delete s.dismissed[l.id]; reset = true; }
  });
  if (reset) { await save(s); st = SL.computeStatus(s, n, real); }

  if (kind === 'tick') {
    const gap = real - s.lastTickReal; // across ALL tracked tabs: two visible windows can't double-count
    s.lastTickReal = real;
    if (st.canCount && gap > 0 && gap <= SL.MAX_GAP) {
      await recordTime(s, n, host, gap * speedOf(s));
      s.usageAll = poolByDay(await days(), s.remote, s.deviceId);
    }
    await save(s);
    flushSync(false).catch(() => {}); // fire and forget
    st = SL.computeStatus(s, n, real);
    showBadge(st);
  }
  enforceTab(sender.tab && sender.tab.id, st.locked).catch(() => {});
  lastError = null;
  st.tracked = true;
  st.siteName = site.name;
  st.notice = pickNotice(s);
  return st;
}

function deviceCount(s) {
  const ids = new Set([s.deviceId]);
  Object.keys(s.remote || {}).forEach((k) => { const m = /^u:([0-9a-f-]{36})/.exec(k); if (m) ids.add(m[1]); });
  return ids.size;
}
function siteTotalsToday(s, nowMs) { // debug view: who used what today (all devices)
  const key = SL.dateKey(nowMs);
  const tot = {};
  const local = (dayCache && dayCache.get(key)) || {};
  Object.keys(local).forEach((h) => { tot[h] = (tot[h] || 0) + local[h]; });
  Object.keys(s.remote || {}).forEach((k) => {
    const m = SYNC_ITEM.exec(k);
    const v = s.remote[k];
    if (m && m[1] !== s.deviceId && m[2] === key && v.h) Object.keys(v.h).forEach((h) => { tot[h] = (tot[h] || 0) + (Number(v.h[h]) || 0) * 1000; });
  });
  return Object.keys(tot).map((h) => ({ host: h, ms: tot[h], tracked: isTracked(h) })).sort((a, b) => b.ms - a.ms).slice(0, 40);
}
function debugStatus(s) {
  return publicStatus(s, {
    debugEnabled: true,
    debug: s.debug,
    usage: s.usageAll,
    siteTotals: siteTotalsToday(s, nowOf(s)),
    deviceCount: deviceCount(s),
  });
}

async function handleDebug(msg) {
  return withLock(async () => {
    const s = await loadMerged();
    const m = await days();
    switch (msg.op) {
      case 'setTime': {
        const t = new Date(msg.value).getTime();
        if (Number.isNaN(t)) return { error: 'Invalid date' };
        s.debug.offsetMs = t - Date.now();
        break;
      }
      case 'resetTime': s.debug.offsetMs = 0; break;
      case 'setSpeed': s.debug.speed = Math.min(3600, Math.max(1, Number(msg.value) || 1)); break;
      case 'ignoreHours': s.debug.ignoreSchoolHours = !!msg.value; break;
      case 'addUsage': {
        const host = String(msg.host || 'open.spotify.com').trim().toLowerCase().replace(/^www\./, '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(msg.date) || !/^[a-z0-9.()-]{1,100}$/.test(host)) return { error: 'Invalid date or site' };
        const hosts = m.get(msg.date) || {};
        hosts[host] = Math.max(0, (hosts[host] || 0) + (Number(msg.minutes) || 0) * SL.MIN);
        m.set(msg.date, hosts);
        s.usageRev += 1;
        s.dirtyDays[msg.date] = s.usageRev;
        await persistDay(msg.date);
        break;
      }
      case 'clearUsage': {
        for (const day of Array.from(m.keys())) await chrome.storage.local.remove(DAY_PREFIX + day);
        m.clear();
        s.dirtyDays = {};
        s.dismissed = {};
        try { // remove every device's synced totals so the cleared state sticks
          const all = await withTimeout(chrome.storage.sync.get(null), SYNC_TIMEOUT_MS);
          const keys = Object.keys(all).filter((k) => k.indexOf('u:') === 0);
          if (keys.length) await withTimeout(chrome.storage.sync.remove(keys), SYNC_TIMEOUT_MS);
        } catch (e) { /* ignore */ }
        remoteMem = { items: {}, at: Date.now() };
        await chrome.storage.local.set({ [REMOTE_KEY]: remoteMem });
        break;
      }
      default: return { error: 'Unknown op' };
    }
    s.remote = await readRemoteAll();
    s.usageAll = poolByDay(m, s.remote, s.deviceId);
    await save(s);
    return debugStatus(s);
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fromPage = !sender.tab; // extension popup (not a content script)
  (async () => {
    await ready; // effective settings are loaded before any message is answered
    switch (msg && msg.type) {
      case 'tick':
      case 'poll':
        if (fromPage) return { error: 'not allowed' };
        return handleTick(msg.type, sender);
      case 'idle':
        if (fromPage) return { error: 'not allowed' };
        return withLock(async () => {
          const s = await load();
          s.lastTickReal = 0;
          await save(s);
          clearBadge();
          if (Object.keys(s.dirtyDays).length) flushSync(true).catch(() => {});
          return { ok: true };
        });
      case 'status': {
        const s = await loadMerged();
        return C.debug.enabled && fromPage ? debugStatus(s) : publicStatus(s, { debugEnabled: false });
      }
      case 'dismissWarning':
        if (fromPage) return { error: 'not allowed' };
        return withLock(async () => {
          const s = await loadMerged();
          const lvl = Number(msg.level);
          if (typeof msg.limitId === 'string' && Number.isInteger(lvl)) {
            s.dismissed[msg.limitId] = Math.max(lvl, s.dismissed[msg.limitId] === undefined ? -1 : s.dismissed[msg.limitId]);
            await save(s);
          }
          return publicStatus(s);
        });
      case 'dismissNotice':
        if (fromPage) return { error: 'not allowed' };
        return withLock(async () => {
          const s = await load();
          const id = String(msg.id || '').slice(0, 100);
          if (id) markSeen(s, id);
          const pk = s.pendingNotice && s.pendingNotice.kind;
          if ((id.indexOf('install:') === 0 && pk === 'newInstall') || (id.indexOf('update:') === 0 && pk === 'update')) delete s.pendingNotice;
          await save(s);
          return { ok: true };
        });
      case 'setTimerHidden':
        return withLock(async () => {
          const s = await load();
          s.timerHidden = !!msg.value;
          await save(s);
          return { timerHidden: s.timerHidden };
        });
      case 'debug':
        if (!C.debug.enabled || !fromPage) return { error: 'disabled' };
        if (msg.op === 'syncNow') { // network call must happen outside the lock
          await withLock(async () => {
            const s = await load();
            (await days()).forEach((_, day) => { s.usageRev += 1; s.dirtyDays[day] = s.usageRev; }); // re-upload every day
            s.lastSyncWrite = 0;
            await save(s);
          });
          await flushSync(true);
          if (remoteMem) remoteMem.at = 0;
          return debugStatus(await loadMerged());
        }
        if (msg.op === 'fetchSettings') { // network call outside the lock
          const r = await fetchSettings();
          return Object.assign(debugStatus(await loadMerged()), { fetchResult: r });
        }
        if (msg.op === 'simNotice' || msg.op === 'resetNotices') {
          await withLock(async () => {
            const s = await load();
            s.noticesSeen = {};
            delete s.pendingNotice;
            if (msg.op === 'simNotice') s.pendingNotice = { kind: msg.kind === 'update' ? 'update' : 'newInstall', at: Date.now() };
            await save(s);
          });
          return debugStatus(await loadMerged());
        }
        return handleDebug(msg);
      default:
        return { error: 'unknown' };
    }
  })().then(sendResponse).catch((e) => sendResponse({ error: String(e) }));
  return true; // async response
});

/* ---------- notices (optional banners) ---------- */
const NOTICE_WINDOW_MS = 24 * 3600 * 1000; // an install/update notice must be shown within a day
function cleanMsg(m) { return typeof m === 'string' ? m.trim().slice(0, 500) : ''; }
function noticeId(kind, n) { return kind + ':' + (n.id ? String(n.id).slice(0, 60) : SL.hashString(n.message)); }
function markSeen(s, id) {
  s.noticesSeen = s.noticesSeen || {};
  s.noticesSeen[id] = Date.now();
  const ids = Object.keys(s.noticesSeen);
  if (ids.length > 50) ids.sort((a, b) => s.noticesSeen[a] - s.noticesSeen[b]).slice(0, ids.length - 50).forEach((k) => delete s.noticesSeen[k]);
}
function pickNotice(s) {
  const N = (SL.getConfig() || {}).notices || {};
  const seen = s.noticesSeen || {};
  const p = s.pendingNotice;
  const fresh = !!p && Date.now() - p.at < NOTICE_WINDOW_MS;
  const found = [];
  if (fresh && p.kind === 'newInstall') {
    const m = cleanMsg(N.newInstall && N.newInstall.message);
    if (m) found.push({ id: noticeId('install', { message: m }), kind: 'newInstall', message: m });
  }
  const u = N.update;
  const um = cleanMsg(u && u.message);
  // update notice: right after an extension update, or when the central JSON supplies a new one
  if (um && ((fresh && p.kind === 'update') || (u && u.remote))) {
    found.push({ id: noticeId('update', { message: um, id: u.id }), kind: 'update', message: um });
  }
  return found.find((n) => !seen[n.id]) || null;
}

/* ---------- central settings (JSON on GitHub) ---------- */
const SETTINGS_KEY = 'sl_settings';
const REMOTE = C.remote || {};
const REFRESH_MS = Math.max(1, Number(REMOTE.refreshMinutes) || 30) * 60 * 1000;
let settings = {};           // last accepted record: { data, hash, version, fetchedAt, checkedAt, error, problems }
let fetching = false;
let fetchStartedAt = 0;
const FETCH_STALE_MS = 30 * 1000; // a refresh that has not finished after this long is considered dead

function applyEffective(rec) {
  settings = rec || {};
  SL.setConfig(SL.buildConfig(C, settings.data));
  trackedMemo = new Map(); // the tracked list may have changed: earlier time on added/removed sites now (not) counts
}
const ready = Promise.all([
  chrome.storage.local.get(SETTINGS_KEY)
    .then((o) => applyEffective(o[SETTINGS_KEY]))
    .catch((e) => { applyEffective(null); lastError = 'settings load: ' + (e && e.message || e); }),
  migrate().catch((e) => { lastError = 'migrate: ' + (e && e.message || e); }),
]);

function settingsInfo() {
  return {
    enabled: !!(REMOTE.enabled && REMOTE.url),
    source: settings.hash ? 'central' : 'built-in',
    version: settings.version || null,
    changedAt: settings.fetchedAt || null,
    checkedAt: settings.checkedAt || null,
    error: settings.error || null,
    problems: settings.problems || [],
  };
}

async function fetchSettings() {
  if (!REMOTE.enabled || !REMOTE.url) return { skipped: true };
  if (fetching && Date.now() - fetchStartedAt < FETCH_STALE_MS) return { busy: true };
  fetching = true;
  fetchStartedAt = Date.now();
  let changed = false;
  let problems = [];
  try {
    await ready;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let raw;
    try {
      const res = await fetch(REMOTE.url, { cache: 'no-cache', signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      if (text.length > 300000) throw new Error('settings file too large');
      raw = JSON.parse(text);
    } finally { clearTimeout(timer); }

    const sanitized = SL.sanitizeRemote(raw, settings.data);
    const data = sanitized.data;
    problems = sanitized.problems;
    const hash = SL.hashString(JSON.stringify(data));
    changed = settings.hash !== hash;
    const rec = {
      data, hash, problems,
      version: data.version || null,
      fetchedAt: changed ? Date.now() : settings.fetchedAt || Date.now(),
      checkedAt: Date.now(),
      error: null,
    };
    await chrome.storage.local.set({ [SETTINGS_KEY]: rec }); // remembered until the JSON changes again
    applyEffective(rec);
  } catch (e) {
    // Unavailable / invalid: keep using the last good copy (or the built-in defaults).
    const rec = Object.assign({}, settings, { checkedAt: Date.now(), error: String((e && e.message) || e) });
    settings = rec;
    chrome.storage.local.set({ [SETTINGS_KEY]: rec }).catch(() => {});
    return { ok: false, error: rec.error };
  } finally {
    fetching = false; // always released, whatever happens below
  }
  // Follow-up work (re-register scripts, unmute tabs, purge) runs on its own, with a time limit,
  // so it can never keep the NEXT refresh from running.
  withTimeout(afterSettingsApplied(changed), 60000)
    .catch((e) => { lastError = 'after settings: ' + (e && e.message || e); });
  return { ok: true, changed, problems };
}

async function afterSettingsApplied(changed) {
  await withLock(async () => {
    const s = await load();
    let dirty = false;
    if (changed) { s.dismissed = {}; dirty = true; } // thresholds may have changed
    if (s.suppressRemoteNotice) { // brand-new install: don't announce what already exists
      const u = (SL.getConfig().notices || {}).update;
      if (u && u.remote && cleanMsg(u.message)) markSeen(s, noticeId('update', { message: cleanMsg(u.message), id: u.id }));
      s.suppressRemoteNotice = false;
      dirty = true;
    }
    if (dirty) await save(s);
  });
  await syncContentScripts(false).catch((e) => { lastError = 'content scripts: ' + (e && e.message || e); });
  if (changed) purgeOld(true).catch(() => {});
  await releaseMutedTabs().catch(() => {}); // sites removed from the list / limits raised: give the sound back now
}

/* ---------- content scripts follow the tracked-site list ---------- */
let csChain = Promise.resolve();
function syncContentScripts(forceInject) {
  const run = csChain.then(() => doSyncContentScripts(forceInject));
  csChain = run.catch(() => {});
  return run;
}
const ALL_PAGES = ['https://*/*', 'http://*/*'];
const INJECT_TIMEOUT_MS = 4000;   // a frozen/discarded tab must not stall everything
const INJECT_BUDGET_MS = 20000;   // and the whole sweep has a ceiling
async function injectInto(tabIds, files, world) {
  const t0 = Date.now();
  let n = 0;
  for (const id of tabIds) {
    if (Date.now() - t0 > INJECT_BUDGET_MS || n++ > 400) break;
    try {
      const target = { tabId: id };
      await withTimeout(chrome.scripting.executeScript(world ? { target, files, world } : { target, files }), INJECT_TIMEOUT_MS);
    } catch (e) { /* tab not injectable (discarded, browser page, slow, ...) */ }
  }
}
async function doSyncContentScripts(forceInject) {
  const tracked = SL.enabledHosts().map((h) => 'https://*.' + h + '/*').sort();
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const main = existing.find((x) => x.id === 'sl-main');
  const content = existing.find((x) => x.id === 'sl-content');
  const sameSet = (a, b) => JSON.stringify((a || []).slice().sort()) === JSON.stringify((b || []).slice().sort());
  const contentOk = !!content && sameSet(content.matches, ALL_PAGES);
  const same = contentOk && (tracked.length ? !!main && sameSet(main.matches, tracked) : !main);
  if (same && !forceInject) return;
  const hadMatches = main && main.matches ? main.matches.slice() : [];
  if (!same) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((x) => x.id) });
    const list = [{ id: 'sl-content', matches: ALL_PAGES, js: ['core.js', 'content.js'], runAt: 'document_start', persistAcrossSessions: true }];
    // auto-picture-in-picture is only blocked on the tracked music sites
    if (tracked.length) list.push({ id: 'sl-main', matches: tracked, js: ['pip-guard.js'], runAt: 'document_start', world: 'MAIN', persistAcrossSessions: true });
    await chrome.scripting.registerContentScripts(list);
  }
  // Pages that were already open don't get registered scripts until reload: inject now,
  // but only what is actually new (the page script exists everywhere already when it was registered before).
  if (!contentOk || forceInject) {
    const tabs = await chrome.tabs.query({ url: ALL_PAGES });
    await injectInto(tabs.map((t) => t.id), ['core.js', 'content.js']);
  }
  const fresh = forceInject || !main ? tracked : tracked.filter((m) => !hadMatches.includes(m));
  if (fresh.length) {
    const tabs = await chrome.tabs.query({ url: fresh });
    await injectInto(tabs.map((t) => t.id), ['pip-guard.js'], 'MAIN');
  }
}

/* ---------- housekeeping: sync upload, stale badge, mute hidden tabs ---------- */
async function housekeeping() {
  await ready;
  await flushSync(true).catch(() => {});
  await purgeOld(false).catch((e) => { lastError = 'purge: ' + (e && e.message || e); });
  await syncContentScripts(false).catch((e) => { lastError = 'content scripts: ' + (e && e.message || e); });
  const s = await loadMerged();
  const st = SL.computeStatus(s, nowOf(s), Date.now());
  if (!st.counting && !st.locked) clearBadge();
  const patterns = siteUrlPatterns();
  if (patterns.length) {
    const tabs = await chrome.tabs.query({ url: patterns });
    for (const t of tabs) await enforceTab(t.id, st.locked);
  }
  await releaseMutedTabs();
}

function ensureAlarms() {
  chrome.alarms.get('sl-housekeeping', (a) => {
    if (!a) chrome.alarms.create('sl-housekeeping', { periodInMinutes: 0.5 });
  });
  chrome.alarms.get('sl-settings', (a) => {
    const period = REFRESH_MS / 60000;
    if (!a || Math.abs((a.periodInMinutes || 0) - period) > 0.001) chrome.alarms.create('sl-settings', { periodInMinutes: period });
  });
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'sl-housekeeping') housekeeping();
  if (a.name === 'sl-settings') fetchSettings();
});

chrome.runtime.onInstalled.addListener((details) => {
  ensureAlarms();
  (async () => {
    await ready;
    await withLock(async () => {
      const s = await load();
      if (details.reason === 'install') {
        s.pendingNotice = { kind: 'newInstall', at: Date.now() };
        s.suppressRemoteNotice = true;
      } else if (details.reason === 'update') {
        s.pendingNotice = { kind: 'update', at: Date.now(), version: chrome.runtime.getManifest().version };
      }
      await save(s);
    });
    await syncContentScripts(true).catch((e) => { lastError = 'content scripts: ' + (e && e.message || e); });
    await fetchSettings();
  })().catch((e) => { lastError = 'install: ' + (e && e.message || e); });
});
chrome.runtime.onStartup.addListener(ensureAlarms);
ensureAlarms();

// Every time the worker wakes: make sure the scripts match the settings, and refresh if stale.
ready.then(() => {
  syncContentScripts(false).catch((e) => { lastError = 'content scripts: ' + (e && e.message || e); });
  if (Date.now() - (settings.checkedAt || 0) > REFRESH_MS) fetchSettings();
});
