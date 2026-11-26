(function () {
  'use strict';
  const SL = self.SL;
  const $ = (id) => document.getElementById(id);
  const send = (m) => chrome.runtime.sendMessage(m);
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let populated = false;
  if (!self.SL_CONFIG.debug.enabled) {
    const panel = document.getElementById('debug');
    if (panel) panel.remove(); // production build: test controls don't exist at all
  }
  let current = null;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function ago(ms) {
    const m = Math.round((Date.now() - ms) / 60000);
    return m < 1 ? 'just now' : m < 90 ? m + ' min ago' : Math.round(m / 60) + ' h ago';
  }
  function settingsText(s) {
    if (!s || !s.enabled) return 'Settings: built-in.';
    if (s.source === 'central') {
      return 'Settings: central' + (s.version ? ' v' + s.version : '') + ', checked ' + (s.checkedAt ? ago(s.checkedAt) : 'never') +
        (s.error ? ' (last check failed - using saved copy)' : '') +
        (s.checkedAt && Date.now() - s.checkedAt > 75 * 60000 ? ' (overdue - not refreshing)' : '') + '.';
    }
    return 'Settings: built-in defaults' + (s.error ? ' (central file unavailable)' : ' (not downloaded yet)') + '.';
  }

  function statusLine(st) {
    if (st.locked) {
      return { pill: 'Locked', cls: 'lock',
        msg: 'Limit reached. ' + (st.availableAt ? 'Free again ' + (st.availableKind === 'break' ? 'during the break ' : 'after school ') + SL.fmtWhen(st.availableAt, st.nowMs) + '. ' : '') +
          (st.resumeAt ? 'Allowance returns ' + SL.fmtWhen(st.resumeAt, st.nowMs) + '.' : '') };
    }
    if (st.counting) {
      return { pill: 'Counting', cls: st.inWarning ? 'warn' : 'on', msg: 'A streaming site is on screen (or in picture-in-picture), so your time is being counted.' };
    }
    if (st.reached.length && !st.inSchool) {
      return { pill: 'Not counting', cls: '', msg: 'Limit reached \u2013 streaming is blocked during school hours until ' +
        (st.resumeAt ? SL.fmtWhen(st.resumeAt, st.nowMs) : 'later') + '.' };
    }
    const resumes = st.nextStartMs ? ' Counting resumes ' + SL.fmtWhen(st.nextStartMs, st.nowMs) + '.' : '';
    if (!st.schoolDay) {
      return { pill: 'Not counting', cls: '', msg: (st.holiday ? 'No school today (' + st.holiday + ').' : 'No school today.') + resumes };
    }
    if (!st.inSchool) return { pill: 'Not counting', cls: '', msg: 'Outside school periods (lunch / before / after school).' + resumes };
    if (st.lastTickAgoMs === null || st.lastTickAgoMs > 10000) {
      return { pill: 'Not counting', cls: '', msg: 'No tracked site is on screen. (If one is, reload that tab.)' };
    }
    return { pill: 'Not counting', cls: '', msg: 'Time is counted only while a tracked site is on screen or in picture-in-picture.' };
  }

  function render(st) {
    current = st;
    const s = statusLine(st);
    const pill = $('pill');
    pill.textContent = s.pill;
    pill.className = 'pill ' + s.cls;
    $('msg').textContent = s.msg + (st.lastError ? '  [Error: ' + st.lastError + ']' : '');

    const box = $('limits');
    while (box.firstChild) box.removeChild(box.firstChild);
    const active = st.limits.filter((l) => l.enabled);
    if (!active.length) box.appendChild(el('p', 'msg', 'No time limits are active.'));
    active.forEach((l) => {
      const wrap = el('div', 'lim');
      const top = el('div', 'top');
      top.append(el('b', null, l.label), el('span', null, l.reached ? 'Limit reached' : SL.fmtDur(l.remainingMs, true) + ' left'));
      const bar = el('div', 'bar');
      const fill = el('div', 'fill' + (l.reached ? ' full' : l.level >= 0 ? ' warn' : ''));
      fill.style.width = Math.min(100, l.pct * 100).toFixed(1) + '%';
      bar.appendChild(fill);
      wrap.append(top, bar, el('div', 'sub', SL.fmtDur(l.usedMs) + ' used of ' + SL.fmtDur(l.limitMs)));
      box.appendChild(wrap);
    });

    $('info').textContent = 'Counted ' + st.daysText + ' ' + st.periodsText + ', excluding holidays.';
    $('settingsInfo').textContent = settingsText(st.settings);
    $('toggleTimer').textContent = st.timerHidden ? 'Show on-page timer' : 'Hide on-page timer';

    if (st.debugEnabled && self.SL_CONFIG.debug.enabled) renderDebug(st);
  }

  function renderDebug(st) {
    $('debug').hidden = false;
    if (!populated) {
      populated = true;
      $('dbgTime').value = SL.toLocalInput(st.nowMs);
      $('dbgDate').value = SL.dateKey(st.nowMs);
      $('dbgSpeed').value = st.debug.speed || 1;
      $('dbgIgnore').checked = !!st.debug.ignoreSchoolHours;
    }
    const rows = Object.keys(st.usage).sort().map((k) => k + '  ' + SL.fmtDur(st.usage[k]) + ' counted');
    const sites = (st.siteTotals || []).map((t) => (t.tracked ? '* ' : '  ') + t.host + '  ' + SL.fmtDur(t.ms));
    $('dbgRaw').textContent = (rows.length ? rows.join('\n') : '(no counted time)') +
      '\n\nToday by site (* = counts towards limits):\n' + (sites.length ? sites.join('\n') : '(nothing recorded)');
    $('dbgDevices').textContent = 'Devices contributing to this total: ' + st.deviceCount + ' (this one + ' + (st.deviceCount - 1) + ' synced)';
  }

  let rendered = false;
  async function refresh() {
    try {
      const st = await send({ type: 'status' });
      if (st && !st.error) {
        render(st);
        rendered = true;
        try { localStorage.setItem('slLast', JSON.stringify(st)); } catch (e) { /* ignore */ }
        return;
      }
    } catch (e) { /* worker waking up */ }
    if (!rendered) $('msg').textContent = 'Loading\u2026';
  }

  // Paint the last known numbers instantly so the popup is never blank while the
  // background worker wakes up; they are replaced as soon as fresh data arrives.
  try {
    const cached = JSON.parse(localStorage.getItem('slLast') || 'null');
    if (cached && cached.limits) {
      render(Object.assign({}, cached, { counting: false }));
      $('msg').textContent = 'Updating\u2026';
    } else {
      $('msg').textContent = 'Loading\u2026';
    }
  } catch (e) { $('msg').textContent = 'Loading\u2026'; }

  $('toggleTimer').addEventListener('click', async () => {
    await send({ type: 'setTimerHidden', value: !(current && current.timerHidden) });
    refresh();
  });

  // Test controls exist only in debug builds; in production the panel is gone from the DOM.
  if (self.SL_CONFIG.debug.enabled) {
    function dbg(payload) { return send(Object.assign({ type: 'debug' }, payload)).then(refresh); }
    $('dbgSetTime').addEventListener('click', () => dbg({ op: 'setTime', value: $('dbgTime').value }));
    $('dbgResetTime').addEventListener('click', async () => { await dbg({ op: 'resetTime' }); populated = false; });
    $('dbgSetSpeed').addEventListener('click', () => dbg({ op: 'setSpeed', value: $('dbgSpeed').value }));
    $('dbgIgnore').addEventListener('change', (e) => dbg({ op: 'ignoreHours', value: e.target.checked }));
    $('dbgAdd').addEventListener('click', () => dbg({ op: 'addUsage', date: $('dbgDate').value, minutes: $('dbgMin').value, host: $('dbgHost').value }));
    $('dbgSync').addEventListener('click', () => dbg({ op: 'syncNow' }));
    $('dbgFetch').addEventListener('click', async () => {
      $('dbgFetchMsg').textContent = 'Downloading\u2026';
      let r = null;
      try { r = await send({ type: 'debug', op: 'fetchSettings' }); } catch (e) { /* worker unavailable */ }
      const f = r && r.fetchResult;
      $('dbgFetchMsg').textContent = !f ? 'No answer from the extension - reload it.'
        : f.skipped ? 'Central settings are switched off in config.js.'
        : f.busy ? 'Another refresh is still running - try again in a few seconds.'
        : f.ok === false ? 'Failed: ' + f.error + ' (still using the saved copy).'
        : (f.changed ? 'Downloaded - settings changed.' : 'Downloaded - no change.') + (f.problems && f.problems.length ? ' Ignored: ' + f.problems.join('; ') : '');
      refresh();
    });
    $('dbgSimInstall').addEventListener('click', () => dbg({ op: 'simNotice', kind: 'newInstall' }));
    $('dbgSimUpdate').addEventListener('click', () => dbg({ op: 'simNotice', kind: 'update' }));
    $('dbgResetNotices').addEventListener('click', () => dbg({ op: 'resetNotices' }));
    $('dbgClear').addEventListener('click', () => {
      if (confirm('Delete ALL recorded Spotify usage?')) dbg({ op: 'clearUsage' });
    });
  }

  refresh();
  setInterval(refresh, 1000);
})();
