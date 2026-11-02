/* Runs on open.spotify.com. Reports "I'm visible" once a second and draws the UI.
 * All decisions (counting, locking) are made by the background worker. */
(function () {
  'use strict';
  if (window.__slLoaded) return;
  window.__slLoaded = true;

  const SL = self.SL;
  if (!SL) { console.error('[limiter] core.js / config.js not available - content script stopped'); return; }
  // Only act on sites enabled in config.js (the manifest may list more than are enabled).
  const site = SL.siteForHost(location.hostname);
  if (!site) return;
  let locked = false;
  let dead = false; // extension was reloaded/updated: this copy of the script is orphaned

  // chrome.runtime.sendMessage THROWS synchronously once the extension context is
  // invalidated, so .catch() alone is not enough.
  function send(msg) {
    if (dead) return Promise.resolve(undefined);
    try {
      if (!chrome.runtime || !chrome.runtime.id) throw new Error('context lost');
      return chrome.runtime.sendMessage(msg).catch((e) => { checkDead(e); });
    } catch (e) {
      checkDead(e);
      return Promise.resolve(undefined);
    }
  }
  function checkDead(e) {
    if (dead) return;
    if (!chrome.runtime || !chrome.runtime.id || /context invalidated|context lost/i.test(String(e && e.message))) {
      dead = true;
      onContextLost();
    }
  }

  /* ---------- UI (closed shadow DOM so Spotify's CSS can't touch it) ---------- */
  const host = document.createElement('div');
  host.id = 'spotify-limiter-host';
  host.style.cssText = 'all:initial;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: "Segoe UI", system-ui, -apple-system, Roboto, sans-serif; }
  .banner { position: fixed; top: 0; left: 0; right: 0; z-index: 2147483646; display: none; align-items: center;
    justify-content: center; gap: 12px; background: #f5b942; color: #1c1500; padding: 7px 12px 7px 16px;
    font-size: 14px; font-weight: 600; text-align: center; box-shadow: 0 2px 10px rgba(0,0,0,.4); }
  .banner button { all: unset; cursor: pointer; flex: none; width: 24px; height: 24px; line-height: 24px;
    text-align: center; border-radius: 50%; font-size: 18px; color: #1c1500; }
  .banner button:hover, .banner button:focus-visible { background: rgba(0,0,0,.15); }
  .timer { position: fixed; right: 16px; bottom: 104px; z-index: 2147483645; display: none; align-items: center;
    gap: 8px; background: rgba(20,22,26,.94); color: #f2f2f2; border: 1px solid #343840; border-radius: 999px;
    padding: 6px 6px 6px 12px; font-size: 13px; font-variant-numeric: tabular-nums; box-shadow: 0 4px 14px rgba(0,0,0,.45); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #7b818c; flex: none; }
  .dot.on { background: #3ddc84; animation: pulse 1.6s ease-in-out infinite; }
  .timer.warn .dot.on { background: #f5b942; }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
  @media (prefers-reduced-motion: reduce) { .dot.on { animation: none; } }
  .timer button { all: unset; cursor: pointer; width: 20px; height: 20px; line-height: 20px; text-align: center;
    border-radius: 50%; color: #aeb4bf; font-size: 16px; }
  .timer button:hover, .timer button:focus-visible { background: #343840; color: #fff; }
  .lock { position: fixed; inset: 0; z-index: 2147483647; display: none; align-items: center; justify-content: center;
    background: rgba(12,13,16,.96); backdrop-filter: blur(10px); padding: 16px; overflow: auto; }
  .card { width: min(540px, 100%); background: #1a1d22; border: 1px solid #2f343c; border-radius: 14px;
    padding: 32px; color: #f2f2f2; }
  .card svg { width: 40px; height: 40px; color: #ff6b5e; }
  h1 { font-size: 26px; font-weight: 700; margin: 14px 0 8px; letter-spacing: -.01em; }
  .why { font-size: 15px; line-height: 1.5; color: #d5d8de; margin: 0 0 20px; }
  .when { border-left: 3px solid #3ddc84; padding: 2px 0 2px 14px; margin: 0 0 24px; }
  .when div { font-size: 15px; line-height: 1.6; }
  .when b { font-weight: 600; color: #fff; }
  .when span { color: #aeb4bf; }
  .usage { display: grid; gap: 14px; }
  .u-top { display: flex; justify-content: space-between; font-size: 14px; margin-bottom: 6px; }
  .u-top span:last-child { color: #aeb4bf; font-variant-numeric: tabular-nums; }
  .bar { height: 6px; border-radius: 3px; background: #2a2e35; overflow: hidden; }
  .fill { height: 100%; background: #3ddc84; }
  .fill.warn { background: #f5b942; }
  .fill.full { background: #ff6b5e; }
  .foot { font-size: 12.5px; color: #8b919c; margin: 22px 0 0; line-height: 1.5; }
</style>

<div class="banner" id="banner" role="alert">
  <span id="btext"></span>
  <button id="bclose" title="Close" aria-label="Close warning">\u00d7</button>
</div>

<div class="timer" id="timer">
  <span class="dot" id="dot"></span>
  <span id="ttext"></span>
  <button id="thide" title="Hide timer" aria-label="Hide timer">\u00d7</button>
</div>

<div class="lock" id="lock" role="alertdialog" aria-modal="true" aria-labelledby="ltitle">
  <div class="card">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="4" y="10.5" width="16" height="10.5" rx="2.5"></rect><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"></path>
    </svg>
    <h1 id="ltitle">Locked</h1>
    <p class="why" id="why"></p>
    <div class="when" id="when"></div>
    <div class="usage" id="usage"></div>
    <p class="foot" id="foot"></p>
  </div>
</div>`;

  const $ = (id) => root.getElementById(id);
  const banner = $('banner'), btext = $('btext'), timer = $('timer'), dot = $('dot'), ttext = $('ttext'),
        lock = $('lock'), why = $('why'), when = $('when'), usage = $('usage'), foot = $('foot');

  function attach() {
    if (!host.isConnected) (document.documentElement || document).appendChild(host);
  }
  attach();
  // Re-attach if the page (or a curious student) removes the UI.
  new MutationObserver(attach).observe(document, { childList: true, subtree: true });

  let bannerFor = null; // { id, level } of the warning currently shown
  $('bclose').addEventListener('click', () => {
    banner.style.display = 'none';
    if (bannerFor) {
      send({ type: 'dismissWarning', limitId: bannerFor.id, level: bannerFor.level });
    }
  });

  $('thide').addEventListener('click', () => {
    timer.style.display = 'none';
    send({ type: 'setTimerHidden', value: true });
  });

  /* ---------- helpers ---------- */
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  /* ---------- picture-in-picture ---------- */
  function pipWindow() {
    try {
      const w = window.documentPictureInPicture && window.documentPictureInPicture.window;
      return w && !w.closed ? w : null;
    } catch (e) { return null; }
  }
  function inPip() {
    return !!pipWindow() || !!document.pictureInPictureElement;
  }
  function closePip() {
    try { const w = pipWindow(); if (w) w.close(); } catch (e) { /* ignore */ }
    try { if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {}); } catch (e) { /* ignore */ }
  }

  function pauseMedia() {
    document.querySelectorAll('audio, video').forEach((m) => {
      try { if (!m.paused) m.pause(); } catch (e) { /* ignore */ }
    });
  }
  // Stop playback the instant Spotify tries to resume while locked.
  document.addEventListener('play', (e) => {
    if (locked && e.target && e.target.pause) e.target.pause();
  }, true);
  window.addEventListener('keydown', (e) => {
    if (locked) { e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);

  /* ---------- render ---------- */
  function renderLock(st) {
    $('ltitle').textContent = site.name + ' is locked';
    why.textContent = st.reached.length === 1
      ? 'You have used your ' + st.reached[0].noun + ' streaming allowance of ' + SL.fmtDur(st.reached[0].limitMs) + '.'
      : 'You have used your streaming allowance for: ' + st.reached.map((l) => l.noun + ' (' + SL.fmtDur(l.limitMs) + ')').join(', ') + '.';

    clear(when);
    if (st.availableAt) {
      const r = el('div');
      r.append(el('span', null, st.availableKind === 'break' ? 'Free again during the break: ' : 'Free again after school: '),
        el('b', null, SL.fmtWhen(st.availableAt, st.nowMs)));
      when.appendChild(r);
    }
    const r2 = el('div');
    r2.append(
      el('span', null, st.availableAt ? 'School-time allowance returns: ' : 'Unblocks: '),
      el('b', null, st.resumeAt ? SL.fmtWhen(st.resumeAt, st.nowMs) : 'later')
    );
    when.appendChild(r2);

    clear(usage);
    st.limits.filter((l) => l.enabled).forEach((l) => {
      const row = el('div');
      const top = el('div', 'u-top');
      top.append(el('span', null, l.label),
        el('span', null, l.reached ? 'limit reached' : SL.fmtDur(l.remainingMs, true) + ' left'));
      const bar = el('div', 'bar');
      const fill = el('div', 'fill' + (l.reached ? ' full' : l.pct >= 0.75 ? ' warn' : ''));
      fill.style.width = Math.min(100, l.pct * 100).toFixed(1) + '%';
      bar.appendChild(fill);
      const sub = el('div', 'u-top');
      sub.style.marginTop = '4px'; sub.style.marginBottom = '0';
      sub.append(el('span', null, SL.fmtDur(l.usedMs) + ' used of ' + SL.fmtDur(l.limitMs)), el('span', null, ''));
      row.append(top, bar, sub);
      usage.appendChild(row);
    });

    foot.textContent = 'Time counts while a streaming site is on screen during school hours (' + st.periodsText +
      '). All tracked streaming sites share the same allowance.';
  }

  function render(st) {
    locked = st.locked;

    if (st.warn && st.warnLimit) {
      const l = st.warnLimit;
      bannerFor = { id: l.id, level: l.level };
      btext.textContent = 'Streaming time warning: ' + Math.floor(l.pct * 100) + '% of your ' + l.noun +
        ' limit is used. ' + SL.fmtDur(l.remainingMs, true) + ' left before ' + site.name + ' locks.';
      banner.style.display = 'flex';
    } else {
      bannerFor = null;
      banner.style.display = 'none';
    }

    if (st.locked) {
      renderLock(st);
      lock.style.display = 'flex';
      pauseMedia();
      closePip();
    } else {
      lock.style.display = 'none';
    }

    if (st.timerHidden || st.locked) {
      timer.style.display = 'none';
    } else {
      timer.style.display = 'flex';
      timer.classList.toggle('warn', st.inWarning);
      dot.classList.toggle('on', st.counting);
      if (st.counting) {
        ttext.textContent = st.tightest
          ? SL.fmtClock(st.tightest.remainingMs) + ' left'
          : SL.fmtClock(st.todayMs) + ' today';
      } else {
        ttext.textContent = !st.schoolDay ? 'Not counting \u2013 no school' : 'Not counting \u2013 outside school hours';
      }
      timer.title = 'Streaming time is counted only while this site is on screen during school hours.';
    }
  }

  /* ---------- loop ---------- */
  // "On screen" = tab visible OR Spotify is in picture-in-picture.
  function isOnScreen() {
    return document.visibilityState === 'visible' || inPip();
  }

  let token = 0;   // makes sure only one scheduled timer fires
  let loopGen = 0; // makes sure only the newest step() schedules the next one
  function schedule(delay) {
    const t = ++token;
    const fire = () => { if (t !== token) return; token++; step(); };
    setTimeout(fire, delay);
    // A hidden tab's timers get throttled; the PiP window is visible, so its timers are not.
    const pw = pipWindow();
    if (pw) { try { pw.setTimeout(fire, delay); } catch (e) { /* ignore */ } }
  }

  function onContextLost() {
    // Extension was updated underneath this page: reload once to get the new script.
    try {
      if (sessionStorage.getItem('sl_reloaded')) return;
      sessionStorage.setItem('sl_reloaded', '1');
      location.reload();
    } catch (e) { /* ignore */ }
  }

  async function step() {
    if (dead) return;
    const gen = ++loopGen;
    const onScreen = isOnScreen();
    try {
      // Never wait forever on the background worker: give up after 5 s and try again.
      const st = await Promise.race([
        send({ type: onScreen ? 'tick' : 'poll' }),
        new Promise((resolve) => setTimeout(() => resolve(undefined), 5000)),
      ]);
      if (dead) return;
      if (st && !st.error) {
        render(st);
        try { sessionStorage.removeItem('sl_reloaded'); } catch (e) { /* ignore */ }
      }
    } catch (e) {
      console.error('[limiter] render failed', e); // keep the loop alive no matter what
    }
    if (gen === loopGen) schedule(onScreen ? 1000 : 5000);
  }

  document.addEventListener('visibilitychange', () => {
    if (dead) return;
    token++; // cancel pending timers
    if (document.visibilityState === 'hidden' && !inPip()) {
      send({ type: 'idle' });
    }
    step();
  });

  step();
})();
