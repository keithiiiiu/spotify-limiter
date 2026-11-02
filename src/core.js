/* Shared logic (background, content script, popup). No side effects. */
(function () {
  'use strict';
  const C = self.SL_CONFIG;
  if (!C) { console.error('[limiter] config.js did not load before core.js'); return; }
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
    };
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
    computeStatus, limitDefs,
    fmtClock, fmtDur, badgeText, fmtWhen,
  };
})();
