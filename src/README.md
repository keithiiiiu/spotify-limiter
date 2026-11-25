# Spotify Time Limiter

Manifest V3 extension for Chrome and Edge. Limits time on Spotify and other music sites during school hours. Students have no settings. Settings come from a JSON file on GitHub, with built-in defaults as a fallback.

## How it behaves

| Rule | Behaviour |
|---|---|
| Activity history | While a page is **visible** (active tab of an on-screen window, popup / app window, or **picture-in-picture**) during school hours, the time is recorded **per website host name, on every website**. Background tabs, minimised or covered windows don't count. Only the host name is stored (never the page address, path, query or content). |
| Tracked sites | The list in the settings JSON (or `config.js`). Only time on these sites counts towards the limits and triggers banners / the lock; they share one allowance. |
| Adding a site later | Its time that was already recorded (up to the retention period) counts immediately, on this device and, with sync, the user's other devices. Removing a site stops it counting; nothing is deleted, so adding it back restores the time. |
| Retention | History older than `retention.days` (default 30) is deleted from the device and from browser sync. |
| When | Mon-Fri during `schoolHours.periods` (default 08:45-11:45 and 12:45-15:30), minus holidays. |
| Limits | Default 1 h/day and 3 h/7 days; 30-day limit defined but off. Rolling windows including today. |
| Warning | Closable banner at each threshold (default 75 / 90 / 95 %); returns when the next threshold is passed. |
| Lock | At 100 % a lock screen shows the reason, when it unblocks and remaining time. Playback paused, tab muted, PiP closed. |
| Auto-PiP | Blocked (`pip-guard.js`); manual PiP works and counts. |
| Usage sync | Per-day, per-site totals are uploaded to the browser's sync storage and added up across the user's devices (needs browser sync with extension data). See "Activity history and privacy". |

## Central settings (JSON on GitHub)

`config.js` -> `remote.url` points at the file (default
`https://raw.githubusercontent.com/keithiiiiu/spotify-limiter/refs/heads/main/extension/settings.json`).
Copy `settings.example.json` to that path in the repo and edit it.

How it works:
- On install, on browser start, and every `remote.refreshMinutes` (30) each device downloads the file.
- The **last good copy is stored on the device** and used until the file changes. If GitHub is unreachable, or the file is broken, the device keeps using it. On a device that has never downloaded it, the built-in defaults in `config.js` are used.
- Only sections present in the file override the defaults. Remove a section and the built-in value applies again. Unknown keys are ignored (the file can't touch debug, sync or the URL).
- A section that fails validation is ignored while the stored value is kept; the other sections still apply. (Popup test panel, Settings line, shows the status.)
- GitHub's CDN caches raw files for about 5 minutes, so changes show up on devices within roughly 5 minutes plus the refresh interval.

Sections the JSON can set:

| Section | Format |
|---|---|
| `version` | optional text/number shown in the popup, e.g. `3` |
| `sites` | `[{ "name": "Spotify", "hosts": ["open.spotify.com"], "enabled": true }]`. The whole list is replaced. Hosts have no `https://`; sub-domains match. |
| `limits` | `{ "daily": { "enabled": true, "hours": 1, "days": 1 }, "weekly": {...}, "monthly": {...} }` (any of them) |
| `warning` | `{ "enabled": true, "thresholds": [75, 90, 95] }` |
| `schoolHours` | `{ "days": [1,2,3,4,5], "periods": [{ "start": "08:45", "end": "11:45" }, ...] }` |
| `retention` | `{ "days": 30 }` - how long per-site history is kept (1-365). Keep it at least as long as the longest limit window you use (30 if the monthly limit is on). |
| `holidays` | list of `"2027-01-22"`, `{ "date": "...", "name": "..." }` or `{ "from": "...", "to": "...", "name": "..." }` (replaces the whole list) |
| `notices` | see below |

**Sites and history.** History is kept per website, so the tracked list decides what counts *now*, not what was recorded. Add a site and the time already recorded on it counts straight away; remove it and that time stops counting; add it back and it counts again. Only the window of days kept by `retention.days` is available.

## Activity history and privacy

- What is stored: for each day, a list of `host name -> seconds on screen during school hours`. Example: `docs.google.com: 1500 s`. No page addresses, titles, search terms or content; the extension reads only the host name of the page that is on screen.
- Where: in the extension's storage on each device (`sl_day:<date>` keys) and, with `sync.allSites: true` (default), in browser sync storage so other devices of the same user can count it too. Sites with under 30 s a day are not uploaded, and at most 60 sites per device and day (sync storage allows 100 KB in total). Set `sync.allSites: false` to upload only sites currently on the tracked list; then time on a site added later is only known on the device where it happened.
- Deleted after `retention.days` (default 30) from both places.
- Nothing is shown to students except the tracked-site totals; the per-site list appears only in the test build's popup.
- Decide whether your school's acceptable-use / privacy notice covers this before enabling it for students.

## Notification banners (optional)

A dismissible blue banner at the top of a tracked page. Plain text, max 500 characters. Each distinct message is shown **once per device**, then never again. Nothing is shown when the message is empty.

| Message | When it appears | Where to set it |
|---|---|---|
| `newInstall` | only on a brand-new install | `config.js` `notices.newInstall.message` or JSON `notices.newInstall.message` |
| `update` | once, right after the extension updates to a new version (never on a new install). Leave empty for versions you don't want to announce. | `config.js` `notices.update.message` (ships inside that release) |
| `update` via JSON | once whenever the JSON supplies a new message or a new `id` (no version change needed), e.g. to announce changed limits. Not shown on a brand-new install. | JSON `notices.update` `{ "id": "2027-01-limits", "message": "..." }` |

JSON values override `config.js`. An install/update notice must be seen within 24 hours of the install/update.

## Try it (test build)

1. `chrome://extensions` / `edge://extensions` -> Developer mode -> **Load unpacked**.
2. Open a tracked site and click the toolbar icon. With `debug.enabled: true` the popup has **Test controls**: fake date/time, counting speed, ignore school hours, add/subtract usage, upload to sync, refresh central settings, preview the new-install / update notices, clear usage.

## Production build

```
./pack.sh        # macOS / Linux
.\pack.ps1       # Windows PowerShell
```

Copies the extension to `dist/`, switches `debug.enabled` to false, verifies, and writes `spotify-limiter-<version>.zip`.

## Permissions (changed in 1.4.0)

Because every website is recorded (and sites can be added from the JSON), the extension needs **access to all http/https sites** (`host_permissions`) plus `scripting`. A small script runs on every page; it only reports "this host is on screen" and builds no UI unless the host is on the tracked list. Auto-picture-in-picture blocking (`pip-guard.js`) is limited to the tracked sites so other apps (Meet, Teams, ...) are unaffected.

## Deployment notes (Intune / Edge)

- Force-install with `ExtensionSettings` (`installation_mode: force_installed`, `update_url`, `override_update_url: true`, `toolbar_state: force_shown`).
- Keep the same signing key (.pem) forever: it determines the extension ID, and stored data is tied to it.
- `update.xml` / `edge.xml` needs the app ID, a `codebase` link to the `.crx` and a `version` equal to `manifest.json`.
- Hardening: `InPrivateModeAvailability = 1`, `DeveloperToolsAvailability = 2`, block other browsers and the native Spotify app, block changing the system clock.

## Files

`config.js` built-in defaults + central settings URL + notices | `settings.example.json` template for the GitHub file | `core.js` shared logic, validation | `background.js` accounting, sync, settings download, notices, content-script registration | `content.js` on-page UI | `pip-guard.js` blocks auto-PiP on tracked sites | `popup.*` toolbar popup | `pack.sh` / `pack.ps1` production build

## Known limits

- Tested with a mock browser and unit tests, not against live sites or two real devices.
- Browser-internal pages (`edge://`, `chrome://`, the new-tab page, the built-in PDF viewer, the extension store) can't be recorded. Time with a page on screen counts even if the student is idle.
- The warning/notice banners overlay the top of the page (closable) instead of pushing it down.
- Usage is bucketed by device date, so clock tampering matters.
- Auto-PiP blocking needs Chrome/Edge 111+.
