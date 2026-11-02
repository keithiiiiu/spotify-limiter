# Spotify Time Limiter

Manifest V3 extension for Chrome and Edge. Limits time on Spotify and other music sites (YouTube Music, Apple Music, ...) during school hours. Students have no settings; everything is in `config.js`.

## How it behaves

| Rule | Behaviour |
|---|---|
| Sites | `sites` in `config.js`. Music sites only (video streaming is not tracked). All enabled sites share one allowance. YouTube itself is deliberately not listed. |
| What counts | Time while a tracked site is **visible** (active tab of an on-screen window, a popup / app window, or **picture-in-picture**). Background tabs, minimised or fully covered windows do not count. |
| When it counts | Mon-Fri, during the periods in `schoolHours.periods` (default 08:45-11:45 and 12:45-15:30, so lunch is free), minus holidays. |
| Limits | 1 h/day and 3 h/7 days are on. The 30-day limit (15 h) is defined but disabled. Rolling windows including today. |
| Warning | Closable banner at 75 %, again at 90 % and 95 % (`warning.thresholds`). It comes back each time the next threshold is passed. |
| Lock | At 100 % a full-page lock screen shows the reason, when the site is free again (break / after school), when the allowance returns, and remaining time per limit. Playback is paused, the tab muted and any PiP window closed. |
| Auto-PiP | Browser-opened picture-in-picture is blocked (`pip-guard.js`); students can still open it by hand and it counts. |
| Timer / button | Timer pill on the page (hideable, re-show from popup). Toolbar icon turns green with time-left badge while counting, orange in warning, red `LOCK` when locked. |

## Syncing usage across a user's devices

Each device stores its own per-day totals in `chrome.storage.local` and uploads them (about once a minute while counting) to `chrome.storage.sync` as one small item (`u:<device id>`). Every device adds up its own total plus the other devices' items, so the limit follows the student. Reinstalling the extension keeps the old totals because the old device's item is still in sync storage.

Requirements and behaviour:
- The student must be **signed into the browser with their school account** and browser sync must include extensions/extension data. Check your Intune/Edge/Chrome sync policies. Without sync the extension still works, per device.
- Sync is not instant (seconds to a few minutes). Using two computers at the same moment can overshoot a limit slightly before totals meet.
- **Verify on two real devices before rollout**: whether `chrome.storage.sync` syncs for a policy-installed, self-hosted extension can depend on browser and sync policy. The popup's test panel shows "Devices contributing to this total" and has an "Upload to sync now" button for this.
- `sync.enabled: false` in `config.js` turns it off.

## Adding or changing tracked sites

Flip `enabled` in `config.js` for any listed site. To track a site that is **not** listed, add it to `sites` **and** to `host_permissions` and both `content_scripts` blocks in `manifest.json` (browsers fix those at install time). The background worker logs a console warning if config enables a host the manifest doesn't cover.

## Try it (test build)

1. `chrome://extensions` (or `edge://extensions`) -> Developer mode -> **Load unpacked** -> pick this folder.
2. Open a tracked site and click the toolbar icon. With `debug.enabled: true` you get **Test controls**: simulated date/time, counting speed, ignore school hours, add/subtract usage on any date, upload to sync now, clear all usage (also removes the synced copies; clear on every device to fully reset a test user).

Quick lock test: speed 600, open Spotify during (simulated) school hours, wait ~12 seconds.

## Production build

```
./pack.sh        # macOS / Linux
.\pack.ps1       # Windows PowerShell
```

Copies the extension to `dist/`, **switches `debug.enabled` to false** (line tagged `@DEBUG_FLAG`), verifies it, and writes `spotify-limiter-<version>.zip`. With debug off the test controls are hidden and the worker rejects debug messages.

## Changing config later

Edit `config.js`, bump `version` in `manifest.json`, run the pack script, publish. Stored usage is kept.

## Deployment notes (Intune)

- Force-install with `ExtensionInstallForcelist` (Chrome) / Edge equivalent: `<extension-id>;<update-xml-url>`. Package a signed `.crx` and host `update.xml` on GitHub. Replace `update_url` in `manifest.json` with yours.
- **Keep the same signing key (.pem) forever.** The extension ID derives from it; storage is tied to the ID.
- Hardening policies: `IncognitoModeAvailability = 1`, `DeveloperToolsAvailability = 2`, block other browsers and the native Spotify/streaming apps, block changing the system clock, `BrowserGuestModeEnabled = false`.

## Files

`config.js` settings | `pip-guard.js` blocks auto-PiP (page world, self-contained, runs on every site in the manifest) | `core.js` shared logic | `background.js` accounting, storage, sync, badge, mute | `content.js` on-page UI | `popup.*` toolbar popup | `tools/make_icons.py` regenerates icons | `pack.sh` / `pack.ps1` production build

## Known limits

- Written and unit-tested with a mock browser, but not run against live streaming sites. If a site keeps resuming playback under the lock screen, adjust the pause loop in `content.js`.
- The warning banner overlays the top of the page (it is closable) rather than pushing it down.
- Auto-PiP blocking needs Chrome/Edge 111+; a future browser auto-PiP path would need `pip-guard.js` extended.
- Usage is bucketed by device date, so clock tampering matters.
