/* Service worker. The ONLY place usage is written. */
importScripts('config.js', 'core.js');

const C = self.SL_CONFIG; // built-in defaults (debug / sync / remote url live only here)
const SL = self.SL;       // SL.getConfig() = EFFECTIVE settings (defaults + central JSON)
const KEY = 'sl_state';
const KEEP_DAYS = 400;          // local history kept (tiny)
const SYNC_DAYS = 40;           // days uploaded to browser sync (windows are max 30)
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
  s.usage = s.usage || {};
  s.debug = Object.assign({ offsetMs: 0, speed: 1, ignoreSchoolHours: false }, s.debug);
  s.lastTickReal = s.lastTickReal || 0;
  s.timerHidden = !!s.timerHidden;
  s.dismissed = s.dismissed || {};
  s.syncDirty = !!s.syncDirty;
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

function prune(s, nowMs) {
  const keys = Object.keys(s.usage);
  if (keys.length <= KEEP_DAYS + 20) return;
  const cutoff = SL.dateKey(SL.addDays(nowMs, -KEEP_DAYS));
  keys.forEach((k) => { if (k < cutoff) delete s.usage[k]; });
}

/* ---------- browser sync: one small item per device, merged on read ----------
 * Reading other devices' totals NEVER blocks counting or the popup: we serve the
 * last known copy (kept in storage.local) immediately and refresh it from
 * chrome.storage.sync in the background. */
const REMOTE_KEY = 'sl_remote';
const REMOTE_TTL_MS = 60 * 1000;
let remoteMem = null;         // { items: { 'u:<id>': {d:{day:seconds}} }, at: ms }
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
        if (k.indexOf('u:') === 0 && v && typeof v.d === 'object') items[k] = v;
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
async function getRemote(ownId) {
  const all = await readRemoteAll();
  const out = {};
  Object.keys(all).forEach((k) => { if (k !== 'u:' + ownId) out[k] = all[k]; });
  return out;
}
function mergeUsage(local, remote) {
  const all = Object.assign({}, local);
  Object.keys(remote).forEach((k) => {
    const d = remote[k].d;
    Object.keys(d).forEach((day) => { all[day] = (all[day] || 0) + (Number(d[day]) || 0) * 1000; });
  });
  return all;
}
async function loadMerged() {
  const s = await load();
  s.remote = await getRemote(s.deviceId);
  s.usageAll = mergeUsage(s.usage, s.remote);
  return s;
}

// Upload this device's totals (seconds per day). The network call happens
// OUTSIDE the storage lock so a slow sync can never delay counting.
let flushing = false;
async function flushSync(force) {
  if (!C.sync || !C.sync.enabled || flushing) return;
  const plan = await withLock(async () => {
    const s = await load();
    if (!s.syncDirty) return null;
    const since = Date.now() - s.lastSyncWrite;
    if (since < SYNC_FLOOR_MS || (!force && since < SYNC_FLUSH_MS)) return null;
    const cutoff = SL.dateKey(SL.addDays(nowOf(s), -SYNC_DAYS));
    const d = {};
    Object.keys(s.usage).forEach((k) => { if (k >= cutoff) d[k] = Math.round(s.usage[k] / 1000); });
    return { id: s.deviceId, d, rev: s.usageRev || 0 };
  });
  if (!plan) return;
  flushing = true;
  let ok = false;
  try {
    await withTimeout(chrome.storage.sync.set({ ['u:' + plan.id]: { v: 1, upd: Date.now(), d: plan.d } }), SYNC_TIMEOUT_MS);
    ok = true;
  } catch (e) {
    console.warn('[limiter] sync write failed', e); // stays dirty, retried later
  }
  flushing = false;
  await withLock(async () => {
    const s = await load();
    s.lastSyncWrite = Date.now();
    if (ok && (s.usageRev || 0) <= plan.rev) s.syncDirty = false; // nothing new since the snapshot
    await save(s);
  });
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
      }
      ours.add(tabId);
    } else if (ours.has(tabId)) {
      await chrome.tabs.update(tabId, { muted: false });
      ours.delete(tabId);
    }
  } catch (e) {
    ours.delete(tabId);
  }
  await chrome.storage.session.set({ sl_muted: [...ours] });
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

function siteOf(sender) {
  try {
    return SL.siteForHost(new URL(sender.url || (sender.tab && sender.tab.url) || '').hostname);
  } catch (e) { return null; }
}

async function tickInner(kind, sender) {
  {
    // A page that is not (or no longer) on the tracked list is never counted.
    const site = siteOf(sender);
    if (!site) return { tracked: false };
    const s = await loadMerged();
    const real = Date.now();
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
      const gap = real - s.lastTickReal;
      s.lastTickReal = real;
      // Wall-clock based: two visible windows can't double-count,
      // and a long gap (sleep, hidden tab) is never counted.
      if (st.canCount && gap > 0 && gap <= SL.MAX_GAP) {
        const speed = C.debug.enabled ? Math.max(1, s.debug.speed || 1) : 1;
        const key = SL.dateKey(n);
        const add = gap * speed;
        s.usage[key] = (s.usage[key] || 0) + add;
        s.usageAll[key] = (s.usageAll[key] || 0) + add;
        s.syncDirty = true;
        s.usageRev += 1;
        prune(s, n);
      }
      await save(s);
      if (s.syncDirty) flushSync(false).catch(() => {}); // fire and forget
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
}

function debugStatus(s) {
  return publicStatus(s, {
    debugEnabled: true,
    debug: s.debug,
    usage: s.usageAll,
    deviceCount: 1 + Object.keys(s.remote || {}).length,
  });
}

async function handleDebug(msg) {
  return withLock(async () => {
    const s = await loadMerged();
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
        if (!/^\d{4}-\d{2}-\d{2}$/.test(msg.date)) return { error: 'Invalid date' };
        const add = (Number(msg.minutes) || 0) * SL.MIN;
        s.usage[msg.date] = Math.max(0, (s.usage[msg.date] || 0) + add);
        s.syncDirty = true;
        s.usageRev += 1;
        break;
      }
      case 'clearUsage': {
        s.usage = {};
        s.dismissed = {};
        s.syncDirty = false;
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
    s.remote = await getRemote(s.deviceId);
    s.usageAll = mergeUsage(s.usage, s.remote);
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
          if (s.syncDirty) flushSync(true).catch(() => {});
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
          await withLock(async () => { const s = await load(); s.syncDirty = true; s.usageRev += 1; s.lastSyncWrite = 0; await save(s); });
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

function applyEffective(rec) {
  settings = rec || {};
  SL.setConfig(SL.buildConfig(C, settings.data));
}
const ready = chrome.storage.local.get(SETTINGS_KEY)
  .then((o) => applyEffective(o[SETTINGS_KEY]))
  .catch((e) => { applyEffective(null); lastError = 'settings load: ' + (e && e.message || e); });

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
  if (fetching) return { busy: true };
  fetching = true;
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

    const { data, problems } = SL.sanitizeRemote(raw, settings.data);
    const hash = SL.hashString(JSON.stringify(data));
    const changed = settings.hash !== hash;
    const rec = {
      data, hash, problems,
      version: data.version || null,
      fetchedAt: changed ? Date.now() : settings.fetchedAt || Date.now(),
      checkedAt: Date.now(),
      error: null,
    };
    await chrome.storage.local.set({ [SETTINGS_KEY]: rec }); // remembered until the JSON changes again
    applyEffective(rec);
    await afterSettingsApplied(changed);
    return { ok: true, changed, problems };
  } catch (e) {
    // Unavailable / invalid: keep using the last good copy (or the built-in defaults).
    const rec = Object.assign({}, settings, { checkedAt: Date.now(), error: String((e && e.message) || e) });
    settings = rec;
    chrome.storage.local.set({ [SETTINGS_KEY]: rec }).catch(() => {});
    return { ok: false, error: rec.error };
  } finally {
    fetching = false;
  }
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
}

/* ---------- content scripts follow the tracked-site list ---------- */
let csChain = Promise.resolve();
function syncContentScripts(forceInject) {
  const run = csChain.then(() => doSyncContentScripts(forceInject));
  csChain = run.catch(() => {});
  return run;
}
async function doSyncContentScripts(forceInject) {
  const matches = SL.enabledHosts().map((h) => 'https://*.' + h + '/*').sort();
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const main = existing.find((x) => x.id === 'sl-main');
  const content = existing.find((x) => x.id === 'sl-content');
  const same = !!(main && content) && JSON.stringify((content.matches || []).slice().sort()) === JSON.stringify(matches);
  if (same && !forceInject) return;
  if (!same) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((x) => x.id) });
    if (matches.length) {
      await chrome.scripting.registerContentScripts([
        { id: 'sl-main', matches, js: ['pip-guard.js'], runAt: 'document_start', world: 'MAIN', persistAcrossSessions: true },
        { id: 'sl-content', matches, js: ['core.js', 'content.js'], runAt: 'document_start', persistAcrossSessions: true },
      ]);
    }
  }
  // Pages that were already open don't get registered scripts until reload: inject now.
  if (matches.length) {
    const tabs = await chrome.tabs.query({ url: matches });
    for (const t of tabs) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['pip-guard.js'], world: 'MAIN' });
        await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['core.js', 'content.js'] });
      } catch (e) { /* tab not injectable (discarded, error page, ...) */ }
    }
  }
}

/* ---------- housekeeping: sync upload, stale badge, mute hidden tabs ---------- */
async function housekeeping() {
  await ready;
  await flushSync(true).catch(() => {});
  await syncContentScripts(false).catch((e) => { lastError = 'content scripts: ' + (e && e.message || e); });
  const s = await loadMerged();
  const st = SL.computeStatus(s, nowOf(s), Date.now());
  if (!st.counting && !st.locked) clearBadge();
  const patterns = siteUrlPatterns();
  if (!patterns.length) return;
  const tabs = await chrome.tabs.query({ url: patterns });
  for (const t of tabs) await enforceTab(t.id, st.locked);
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
