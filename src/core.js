/* Shared logic (background, content script, popup). No side effects. */
(function () {
  'use strict';
  // C = the EFFECTIVE settings (built-in defaults + central JSON). The background
  // worker replaces it with setConfig(); other pages only use the pure helpers.
  let C = self.SL_CONFIG || null;
  function setConfig(cfg) { C = cfg; }
  function getConfig() { return C; }
  const MIN = 60000;
  const HOUR = 3600000;
  const MAX_GAP = 3500; // ms without a tick before we stop saying "counting"

  const pad = (n) => String(n).padStart(2, '0');

  /* ---------- dates (all device-local) ---------- */
  function dateKey(ms) {
    const d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function startOfDay(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  function addDays(ms, n) {
    const d = new Date(ms);
    d.setDate(d.getDate() + n); // DST-safe
    return d.getTime();
  }
  function atTime(ms, hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date(ms);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  }
  function toLocalInput(ms) {
    const d = new Date(ms);
    return dateKey(ms) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* ---------- school calendar ---------- */
  function holidayFor(key) {
    for (const h of C.holidays) {
      if (typeof h === 'string') { if (h === key) return { name: 'Holiday' }; }
      else if (h.date) { if (h.date === key) return h; }
      else if (h.from && h.to && key >= h.from && key <= h.to) return h;
    }
    return null;
  }
  function isSchoolDay(ms) {
    return C.schoolHours.days.includes(new Date(ms).getDay()) && !holidayFor(dateKey(ms));
  }
  // School periods sorted by start. Also accepts the old { start, end } form.
  function periods() {
    const h = C.schoolHours;
    const list = h.periods && h.periods.length ? h.periods : [{ start: h.start, end: h.end }];
    return list.slice().sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  }
  function currentPeriod(ms) {
    if (!isSchoolDay(ms)) return null;
    return periods().find((p) => ms >= atTime(ms, p.start) && ms < atTime(ms, p.end)) || null;
  }
  function isSchoolTime(ms) { return !!currentPeriod(ms); }
  function nextSchoolStart(ms) {
    const base = startOfDay(ms);
    for (let i = 0; i < 800; i++) {
      const day = addDays(base, i);
      if (!isSchoolDay(day)) continue;
      for (const p of periods()) {
        const t = atTime(day, p.start);
        if (t >= ms) return t;
      }
    }
    return null;
  }
  function fmtPeriods() {
    return periods().map((p) => p.start + '\u2013' + p.end).join(', ');
  }

  /* ---------- tracked sites ---------- */
  function enabledSites() { return (C.sites || []).filter((s) => s.enabled); }
  function enabledHosts() {
    return enabledSites().reduce((all, s) => all.concat(s.hosts), []);
  }
  function siteForHost(host) {
    host = String(host || '').toLowerCase();
    return enabledSites().find((s) => s.hosts.some((h) => host === h || host.endsWith('.' + h))) || null;
  }

  /* ---------- limits ---------- */
  function limitDefs() {
    return Object.keys(C.limits).map((id) => {
      const l = C.limits[id];
      return {
        id,
        enabled: !!l.enabled,
        days: l.days,
        limitMs: l.hours * HOUR,
        label: l.days === 1 ? 'Today' : 'Last ' + l.days + ' days',
        noun: l.days === 1 ? 'daily' : l.days + '-day',
      };
    });
  }
  function sumUsage(usage, endMs, days) {
    let total = 0;
    for (let i = 0; i < days; i++) total += usage[dateKey(addDays(endMs, -i))] || 0;
    return total;
  }
  // First midnight at which this limit's window has dropped back under the limit.
  function clearAtFor(l, usage, nowMs) {
    const today = startOfDay(nowMs);
    for (let d = 1; d <= l.days; d++) {
      const dayStart = addDays(today, d);
      if (sumUsage(usage, dayStart, l.days) < l.limitMs) return dayStart;
    }
    return addDays(today, l.days);
  }

  /* ---------- the one big status object ---------- */
  function computeStatus(s, nowMs, realNow) {
    const dbg = C.debug.enabled ? s.debug || {} : {};
    const usage = s.usageAll || s.usage; // usageAll = this device + the user's other devices
    const onlySchool = C.enforcement.onlyDuringSchoolHours;
    const hol = holidayFor(dateKey(nowMs));
    const schoolDay = isSchoolDay(nowMs);
    const inSchool = dbg.ignoreSchoolHours ? true : isSchoolTime(nowMs);

    const warnOn = !!C.warning.enabled;
    const thresholds = (C.warning.thresholds || []).slice().sort((a, b) => a - b);
    const dismissed = s.dismissed || {};
    const limits = limitDefs().map((l) => {
      const usedMs = sumUsage(usage, nowMs, l.days);
      const pct = l.limitMs > 0 ? usedMs / l.limitMs : 1;
      return Object.assign({}, l, {
        usedMs,
        remainingMs: Math.max(0, l.limitMs - usedMs),
        pct,
        reached: l.enabled && usedMs >= l.limitMs,
        // index of the highest warning threshold passed (-1 = none)
        level: warnOn ? thresholds.filter((t) => pct * 100 >= t - 1e-9).length - 1 : -1,
      });
    });
    const active = limits.filter((l) => l.enabled);
    const reached = active.filter((l) => l.reached);

    const enforced = inSchool || !onlySchool;
    const locked = enforced && reached.length > 0;
    const canCount = inSchool && !locked;

    const inWarning = warnOn && active.some((l) => !l.reached && l.level >= 0);
    // Banner: a limit qualifies if it passed a threshold higher than the one the student closed.
    const warnLimit = (warnOn && enforced)
      ? active
          .filter((l) => !l.reached && l.level >= 0 && l.level > (dismissed[l.id] === undefined ? -1 : dismissed[l.id]))
          .sort((a, b) => b.pct - a.pct)[0] || null
      : null;
    const tightest = active.slice().sort((a, b) => a.remainingMs - b.remainingMs)[0] || null;

    let clearAt = null, resumeAt = null, availableAt = null, availableKind = null;
    if (reached.length) {
      clearAt = Math.max.apply(null, reached.map((l) => clearAtFor(l, usage, nowMs)));
      resumeAt = onlySchool ? nextSchoolStart(clearAt) : clearAt;
      if (onlySchool && inSchool) {
        const p = currentPeriod(nowMs);
        if (p) {
          availableAt = atTime(nowMs, p.end);
          availableKind = periods().some((q) => atTime(nowMs, q.start) >= availableAt) ? 'break' : 'afterSchool';
        }
      }
    }

    const todayMs = sumUsage(usage, nowMs, 1);
    return {
      nowMs,
      inSchool,
      schoolDay,
      holiday: hol ? hol.name || 'Holiday' : null,
      limits,
      reached,
      locked,
      canCount,
      counting: canCount && realNow - (s.lastTickReal || 0) < MAX_GAP,
      lastTickAgoMs: s.lastTickReal ? realNow - s.lastTickReal : null,
      nextStartMs: nextSchoolStart(nowMs),
      warn: !locked && !!warnLimit,
      warnLimit,
      inWarning,
      tightest,
      todayMs,
      clearAt,
      resumeAt,
      availableAt,
      availableKind,
      timerHidden: !!s.timerHidden,
      onlyDuringSchoolHours: onlySchool,
      periodsText: fmtPeriods(),
      daysText: C.schoolHours.days.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', '),
    };
  }

  /* ---------- central settings (JSON on GitHub): validate + merge ---------- */
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  const YMD = /^\d{4}-\d{2}-\d{2}$/;
  const HOSTRE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
  const isNum = (x) => typeof x === 'number' && isFinite(x);
  const isStr = (x, max) => typeof x === 'string' && x.length <= (max || 200);
  function validDate(s) {
    if (typeof s !== 'string' || !YMD.test(s)) return false;
    const p = s.split('-').map(Number);
    const t = new Date(p[0], p[1] - 1, p[2]);
    return t.getFullYear() === p[0] && t.getMonth() === p[1] - 1 && t.getDate() === p[2];
  }
  function hashString(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  // Returns { data, problems }. A section that fails validation is ignored and the
  // previously accepted value (if any) is kept; other sections still apply.
  // Throws if the file is not a JSON object at all.
  function sanitizeRemote(raw, previous) {
    previous = previous || {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('settings file must be a JSON object');
    const data = {};
    const problems = [];
    function section(name, fn) {
      if (!(name in raw)) return;
      try { data[name] = fn(raw[name]); }
      catch (e) {
        problems.push(name + ': ' + e.message);
        if (previous[name] !== undefined) data[name] = previous[name];
      }
    }
    const obj = (v) => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('must be an object'); return v; };

    section('version', (v) => {
      if (!(isStr(v, 40) || isNum(v))) throw new Error('must be text or a number');
      return String(v);
    });

    section('sites', (v) => {
      if (!Array.isArray(v) || v.length > 200) throw new Error('must be an array (max 200)');
      return v.map((s, i) => {
        if (!s || !isStr(s.name, 60) || !s.name.trim() || !Array.isArray(s.hosts) || !s.hosts.length || s.hosts.length > 20) {
          throw new Error('entry ' + i + ' needs "name" and a non-empty "hosts" list');
        }
        const hosts = s.hosts.map((h) => {
          const x = String(h).trim().toLowerCase().replace(/^\*\./, '');
          if (!HOSTRE.test(x)) throw new Error('bad host "' + h + '" (use e.g. open.spotify.com, no https://)');
          return x;
        });
        return { name: s.name.trim(), hosts, enabled: s.enabled !== false };
      });
    });

    section('limits', (v) => {
      obj(v);
      const out = {};
      Object.keys(v).forEach((id) => {
        if (!/^[a-z][a-z0-9_]{0,19}$/i.test(id)) throw new Error('bad limit name "' + id + '"');
        const l = obj(v[id]);
        const o = {};
        if ('enabled' in l) { if (typeof l.enabled !== 'boolean') throw new Error(id + '.enabled must be true/false'); o.enabled = l.enabled; }
        if ('hours' in l) { if (!isNum(l.hours) || l.hours < 0 || l.hours > 1000) throw new Error(id + '.hours must be 0-1000'); o.hours = l.hours; }
        if ('days' in l) { if (!Number.isInteger(l.days) || l.days < 1 || l.days > 366) throw new Error(id + '.days must be 1-366'); o.days = l.days; }
        out[id] = o;
      });
      return out;
    });

    section('warning', (v) => {
      obj(v);
      const o = {};
      if ('enabled' in v) { if (typeof v.enabled !== 'boolean') throw new Error('enabled must be true/false'); o.enabled = v.enabled; }
      if ('thresholds' in v) {
        if (!Array.isArray(v.thresholds) || v.thresholds.length > 12 || v.thresholds.some((t) => !isNum(t) || t < 1 || t > 100)) {
          throw new Error('thresholds must be up to 12 numbers between 1 and 100');
        }
        o.thresholds = v.thresholds.slice();
      }
      return o;
    });

    section('schoolHours', (v) => {
      obj(v);
      const o = {};
      if ('days' in v) {
        if (!Array.isArray(v.days) || !v.days.length || v.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
          throw new Error('days must be numbers 0-6 (0 = Sunday)');
        }
        o.days = Array.from(new Set(v.days));
      }
      if ('periods' in v) {
        if (!Array.isArray(v.periods) || !v.periods.length || v.periods.length > 8) throw new Error('periods must be 1-8 entries');
        const list = v.periods.map((p) => {
          if (!p || !HHMM.test(p.start) || !HHMM.test(p.end) || p.start >= p.end) throw new Error('each period needs start < end as "HH:MM"');
          return { start: p.start, end: p.end };
        }).sort((a, b) => (a.start < b.start ? -1 : 1));
        for (let i = 1; i < list.length; i++) if (list[i].start < list[i - 1].end) throw new Error('periods overlap');
        o.periods = list;
      }
      return o;
    });

    section('holidays', (v) => {
      if (!Array.isArray(v) || v.length > 400) throw new Error('must be an array (max 400)');
      return v.map((h, i) => {
        if (typeof h === 'string') { if (!validDate(h)) throw new Error('entry ' + i + ': bad date'); return h; }
        const o = obj(h);
        const name = o.name === undefined ? undefined : String(o.name).slice(0, 80);
        if (o.date !== undefined) { if (!validDate(o.date)) throw new Error('entry ' + i + ': bad date'); return { date: o.date, name }; }
        if (!validDate(o.from) || !validDate(o.to) || o.from > o.to) throw new Error('entry ' + i + ': needs valid from <= to');
        return { from: o.from, to: o.to, name };
      });
    });

    section('retention', (v) => {
      obj(v);
      if (!Number.isInteger(v.days) || v.days < 1 || v.days > 365) throw new Error('days must be a whole number 1-365');
      return { days: v.days };
    });

    section('notices', (v) => {
      obj(v);
      const o = {};
      ['update', 'newInstall'].forEach((k) => {
        if (!(k in v)) return;
        const n = obj(v[k]);
        if (!isStr(n.message || '', 500)) throw new Error(k + '.message must be text up to 500 characters');
        o[k] = { message: String(n.message || '').trim() };
        if (k === 'update' && n.id !== undefined) {
          if (!isStr(String(n.id), 60)) throw new Error('update.id too long');
          o[k].id = String(n.id);
        }
      });
      return o;
    });

    return { data, problems };
  }

  // defaults (config.js) + accepted remote sections -> effective settings.
  function buildConfig(defaults, remote) {
    const cfg = JSON.parse(JSON.stringify(defaults));
    remote = remote || {};
    if (remote.sites) cfg.sites = remote.sites.map((s) => Object.assign({}, s));
    if (remote.limits) {
      Object.keys(remote.limits).forEach((id) => {
        const m = Object.assign({}, cfg.limits[id] || {}, remote.limits[id]);
        if (isNum(m.hours) && Number.isInteger(m.days)) { if (m.enabled === undefined) m.enabled = true; cfg.limits[id] = m; }
      });
    }
    if (remote.warning) cfg.warning = Object.assign({}, cfg.warning, remote.warning);
    if (remote.schoolHours) cfg.schoolHours = Object.assign({}, cfg.schoolHours, remote.schoolHours);
    if (remote.retention) cfg.retention = Object.assign({}, cfg.retention, remote.retention);
    if (remote.holidays) cfg.holidays = JSON.parse(JSON.stringify(remote.holidays));
    cfg.notices = cfg.notices || {};
    cfg.notices.update = cfg.notices.update || { message: '' };
    cfg.notices.newInstall = cfg.notices.newInstall || { message: '' };
    if (remote.notices) {
      if (remote.notices.update && remote.notices.update.message) {
        cfg.notices.update = { message: remote.notices.update.message, id: remote.notices.update.id, remote: true };
      }
      if (remote.notices.newInstall && remote.notices.newInstall.message) {
        cfg.notices.newInstall = { message: remote.notices.newInstall.message, remote: true };
      }
    }
    return cfg;
  }

  /* ---------- formatting ---------- */
  function fmtClock(ms) {
    const t = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(t / 3600) + ':' + pad(Math.floor((t % 3600) / 60)) + ':' + pad(t % 60);
  }
  function fmtDur(ms, roundUp) {
    const mins = Math.max(0, roundUp ? Math.ceil(ms / MIN) : Math.floor(ms / MIN));
    const h = Math.floor(mins / 60), m = mins % 60;
    if (h === 0) return m + 'm';
    return m ? h + 'h ' + pad(m) + 'm' : h + 'h';
  }
  function badgeText(ms) {
    const mins = Math.ceil(ms / MIN);
    if (ms <= 0) return '0m';
    if (mins < 60) return mins + 'm';
    return Math.floor(mins / 60) + 'h' + pad(mins % 60);
  }
  function fmtWhen(ms, nowMs) {
    const time = new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const diff = Math.round((startOfDay(ms) - startOfDay(nowMs)) / 86400000);
    if (diff === 0) return 'today at ' + time;
    if (diff === 1) return 'tomorrow at ' + time;
    const day = new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    return day + ' at ' + time;
  }

  self.SL = {
    MAX_GAP, HOUR, MIN,
    dateKey, startOfDay, addDays, atTime, toLocalInput,
    isSchoolDay, isSchoolTime, nextSchoolStart, holidayFor, periods, fmtPeriods,
    enabledSites, enabledHosts, siteForHost,
    computeStatus, limitDefs, setConfig, getConfig,
    sanitizeRemote, buildConfig, hashString,
    fmtClock, fmtDur, badgeText, fmtWhen,
  };
})();
