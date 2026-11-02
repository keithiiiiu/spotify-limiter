/* =============================================================================
 *  SPOTIFY TIME LIMITER - CONFIGURATION
 *
 *  Everything the extension does is controlled from this file. Students have no
 *  settings. To change anything: edit this file, bump "version" in
 *  manifest.json, run pack.sh / pack.ps1, publish the new package.
 * ========================================================================== */
self.SL_CONFIG = {

  /* ---- Sites that are tracked ---------------------------------------------
   * Time on ALL enabled sites below counts together towards the same limits.
   * (Music sites only - video streaming sites are intentionally not tracked.)
   *
   * name    : shown to the student
   * hosts   : domains; sub-domains match too (soundcloud.com also covers
   *           on.soundcloud.com)
   * enabled : false = the extension does nothing on this site
   *
   * To add a site that is NOT in this list you must ALSO add it to
   * "host_permissions" and both "content_scripts" blocks in manifest.json
   * (browsers fix those at install time).
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
  sync: { enabled: true },

  /* ---- Test controls -----------------------------------------------------
   * When enabled, the toolbar popup shows a "Test controls" panel: fake the
   * date/time, speed up counting, add / clear usage.
   *
   * pack.sh / pack.ps1 flip this to false automatically for production builds
   * (they look for the @DEBUG_FLAG marker - keep it on this line).
   */
  debug: { enabled: false }, // @DEBUG_FLAG
};
