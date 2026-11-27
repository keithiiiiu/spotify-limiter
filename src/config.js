/* =============================================================================
 *  SPOTIFY TIME LIMITER - BUILT-IN SETTINGS
 *
 *  These are the DEFAULTS shipped inside the extension. They are used:
 *    - on a fresh install, until the central settings file has been downloaded
 *    - whenever the central settings file is unavailable and nothing has been
 *      downloaded yet
 *
 *  Normal operation: the extension downloads a settings JSON (see "remote"
 *  below) and remembers the last good copy. The JSON can override: sites,
 *  limits, warning, schoolHours, holidays and notices. Anything the JSON does
 *  not mention keeps the value from this file. See README.md for the format.
 *
 *  Students have no settings of their own.
 * ========================================================================== */
self.SL_CONFIG = {

  /* ---- Sites that are tracked ---------------------------------------------
   * Time on ALL enabled sites below counts together towards the same limits.
   * (Time on every other site is recorded too but doesn't count until the site is added here.)
   * (Music sites only - video streaming sites are intentionally not tracked.)
   *
   * name    : shown to the student
   * hosts   : domains; sub-domains match too (soundcloud.com also covers
   *           on.soundcloud.com)
   * enabled : false = the extension does nothing on this site
   *
   * YouTube (www.youtube.com) is intentionally not listed because it is used
   * for schoolwork. YouTube MUSIC is.
   */
  sites: [
    // ---- music ----
    { name: 'Spotify',       hosts: ['open.spotify.com'],                        enabled: true },
    { name: 'YouTube Music', hosts: ['music.youtube.com'],                       enabled: true },
    { name: 'Apple Music',   hosts: ['music.apple.com'],                         enabled: true },
    { name: 'Amazon Music',  hosts: ['music.amazon.com', 'music.amazon.ca'],     enabled: true },
    { name: 'Pandora',       hosts: ['pandora.com'],                             enabled: true },
    { name: 'SoundCloud',    hosts: ['soundcloud.com'],                          enabled: true },
    { name: 'Deezer',        hosts: ['deezer.com'],                              enabled: true },
    { name: 'TIDAL',         hosts: ['listen.tidal.com', 'tidal.com'],           enabled: true },
    { name: 'iHeartRadio',   hosts: ['iheart.com'],                              enabled: true },
    { name: 'TuneIn',        hosts: ['tunein.com'],                              enabled: true },
  ],

  /* ---- Usage limits ------------------------------------------------------
   * enabled : false = this limit is never enforced (usage is still tracked)
   * hours   : maximum time allowed (decimals ok, e.g. 0.5 = 30 minutes)
   * days    : length of the rolling window, including today
   *           (daily = today only, weekly = today + previous 6 days, ...)
   */
  limits: {
    daily:   { enabled: true,  hours: 1,  days: 1  },
    weekly:  { enabled: true,  hours: 3,  days: 7  },
    monthly: { enabled: false, hours: 15, days: 30 },
  },

  /* ---- Warning banner ----------------------------------------------------
   * When ANY enabled limit passes the first threshold, a banner is shown at the
   * top of the page. The student can close it, but it comes back each time
   * usage passes the NEXT threshold in the list.
   * thresholds: percentages of a limit, any order
   */
  warning: { enabled: true, thresholds: [75, 90, 95] },

  /* ---- School hours ------------------------------------------------------
   * Time is only counted (and limits only enforced) inside these periods, so
   * list lunch as a gap between two periods.
   * days    : 0 = Sunday, 1 = Monday ... 6 = Saturday
   * periods : "HH:MM" 24h, device local time; start inclusive, end exclusive
   */
  schoolHours: {
    days: [1, 2, 3, 4, 5],
    periods: [
      { start: '08:45', end: '11:45' },
      { start: '12:45', end: '15:30' },
    ],
  },

  /* ---- Holidays (no counting, no locking) --------------------------------
   * Three formats, all dates are "YYYY-MM-DD":
   *   '2026-11-11'
   *   { date: '2026-11-11', name: 'Remembrance Day' }
   *   { from: '2026-12-18', to: '2027-01-01', name: 'Winter break' }   (inclusive)
   */
  holidays: [
    { date: '2026-10-12', name: 'Thanksgiving' },
    { date: '2026-11-06', name: 'PA Day' },
    { date: '2026-11-11', name: 'Remembrance Day' },
    { from: '2026-12-18', to: '2027-01-01', name: 'Winter break' },
    { date: '2027-01-22', name: 'PA Day' },
    { date: '2027-02-12', name: 'PA Day' },
    { date: '2027-02-15', name: 'Family Day' },
    { from: '2027-03-15', to: '2027-03-29', name: 'March break' },
    { date: '2027-04-02', name: 'Good Friday' },
    { date: '2027-04-05', name: 'Easter Monday' },
    { date: '2027-05-14', name: 'PA Day' },
    { date: '2027-05-24', name: 'Victoria Day' },
    { from: '2027-06-21', to: '2027-06-25', name: 'Last week of school' },
  ],

  /* ---- Activity history -------------------------------------------------
   * The extension records how long each website (host name only - never the
   * page address or content) is on screen during school hours, on EVERY site.
   * Only the sites on the tracked list count towards the limits, but because
   * the history is kept, a site added to the list later immediately counts
   * its earlier time too (within the limit windows).
   *
   * days : history older than this many days is deleted from the device and
   *        from browser sync. Keep it >= the longest limit window (30 if the
   *        monthly limit is ever switched on) or old time will be forgotten.
   */
  retention: { days: 30 },

  /* ---- Enforcement -------------------------------------------------------
   * onlyDuringSchoolHours: true  -> the lock screen / banner only appear during
   *                                 school periods; sites are free at lunch and
   *                                 after school.
   *                        false -> once a limit is hit, sites stay locked
   *                                 until the limit actually clears (even at
   *                                 night / weekends).
   */
  enforcement: { onlyDuringSchoolHours: true },

  /* ---- Sync across devices -----------------------------------------------
   * true: each device uploads its own daily totals to the browser's sync
   * storage and adds up the totals of the user's other devices, so the limit
   * follows the student. Needs browser sync turned on for extension data.
   */
  sync: {
    enabled: true,
    // true  : upload per-site totals for ALL sites, so a site added to the list later
    //         also counts its time recorded on this user's other devices.
    // false : upload only sites currently on the tracked list.
    allSites: true,
  },

  /* ---- Central settings (JSON hosted on GitHub) ----------------------------
   * url             : raw link to the settings JSON
   * refreshMinutes  : how often each device checks for changes (minimum 1)
   * The last good copy is stored on the device and used whenever the file
   * can't be reached. enabled: false = ignore the central file completely.
   */
  remote: {
    enabled: true,
    url: 'https://raw.githubusercontent.com/keithiiiiu/spotify-limiter/refs/heads/main/extension/settings.json',
    refreshMinutes: 30,
  },

  /* ---- Notification banners (all optional) --------------------------------
   * Empty message = nothing is shown. Each distinct message is shown once per
   * device, then never again. Plain text only (max 500 characters).
   *
   * newInstall.message : shown once, ONLY on a brand-new install
   * update.message     : shown once, right after the extension is updated to a
   *                      new version (never on a new install). Leave it empty
   *                      for versions you don't want to announce.
   * The settings JSON can supply both too (it takes priority) - an update
   * message that arrives through the JSON is also shown once when it changes.
   */
  notices: {
    newInstall: { message: '' },
    update:     { message: '' },
  },

  /* ---- Test controls -----------------------------------------------------
   * When enabled, the toolbar popup shows a "Test controls" panel: fake the
   * date/time, speed up counting, add / clear usage.
   *
   * pack.sh / pack.ps1 flip this to false automatically for production builds
   * (they look for the @DEBUG_FLAG marker - keep it on this line).
   */
  debug: { enabled: false }, // @DEBUG_FLAG
};
