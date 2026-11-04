# ProcMon — Full Audit (2026-11-04)

Repo: `abedmohamed258/procmon` @ `5916b8e` (v2.6) · Installed: `~/.local/share/gnome-shell/extensions/procmon@abed.dev` (ACTIVE, GNOME 46)
Method: code read (all 4,476 lines), `gjs` test run, `journalctl /usr/bin/gnome-shell` since 2026-11-02.

## Verified healthy
- 94 `gjs` checks exist (71 parsing + 9 design-tokens + 7 alerts + 7 supervisor) and all pass individually.
- `node --check` clean on all 11 JS files.
- Kill flow: UID check + starttime re-verify (PID-reuse safe), confirmation dialog, supervisor warning. Sound.
- Async-only `/proc` reads, `tryRead`/`tryList` swallow per-file errors, RTL via `iso()`, gettext via `_()`/`_n()`.
- `this.actor is null` / schema errors in the journal belong to **zorin-tiling-shell**, not ProcMon.

## P0 — journal-proven bugs
1. **Disposed-actor spam in Startup services** (`ui/startup.js:164,166`, 51× since Nov 2, burst Nov 3 14:18)
   `fillServices` awaits `systemctl`, then touches `section.hintLabel`/`section.box`. A menu close/rebuild in between disposes them → "already disposed" storms.
2. **`npm test` regression**: repo `package.json` runs only 71/94 checks. alerts, supervisor, design-tokens tests exist but are silently skipped on GitHub (the local copy still had all four).
3. **Service toggles lie on failure**: `runSystemctl` resolves `[]` on *any* error and never checks exit status; the toggle flips the UI regardless. User believes a service was disabled when `systemctl` failed.

## P1 — correctness
4. Version chaos: `metadata.json` = 2, `package.json` = 1.0.0, git history = v2.6. Nobody can tell what they run.
5. `disable()` never destroys `_alertSource` (MessageTray source) → orphaned source; re-enable creates a second one. `enable()` not idempotent.
6. Prefs copy vs code: prefs says alerts "at most once every 5 minutes"; `ALERT_COOLDOWN_MS` is 6 **hours** (72× off).
7. `void this._executeGroupKill(...)` / `void this._verifyGroupKill(...)` — neither has an internal try/catch; any throw becomes an unhandled rejection in the shell.

## P2 — performance / waste
8. `_refreshDiskUsage` runs on every panel tick (2s) — `/proc/mounts` + per-fs statfs, even with the menu closed and alerts at default 90%. Needs a ~30s cadence.
9. `_iconCache.clear()` on every `_buildMenu` → full `Shell.AppSystem` icon lookup on every menu open.
10. `_ramHistory` is recorded every sample and **never painted** (bars are CPU-only). Dead data or missing chart.

## P2 — repo / world-class gaps
11. README has **zero** screenshot embeds although `screenshots/` ships `menu.png` + `confirm-dialog.png`; README still claims "71 tests".
12. No CI. No `check` script (`node --check` all files).
13. `metadata.json` description lists the v1 feature set (no Startup, no alerts, no PSI/sensors detail).
14. Arabic po: 109 msgids, 4 untranslated — good, but new strings must keep it that way.

## Fix plan (v2.7.0 — all shipped + verified 2026-11-04)

Extra find during the round: **P0 shipping bug** — `scripts/pack.sh` never included `ui/` in the zip (broken since the v2.2 split: 16 files, 0 ui/*). Fixed + pack now asserts required/forbidden entries.
- [x] F1 startup generation guard + try/catch (P0-1)
- [x] F2 honest systemctl exit status + toggle only on success + failure notice (P0-3)
- [x] F3 `npm test` = all 4 files (94), add `npm run check` (P0-2)
- [x] F4 prefs copy → 6 hours (P1-6)
- [x] F5 version align (metadata 3 / package 2.7.0) + description (P1-4, P2-13)
- [x] F6 alert-source cleanup on disable + idempotent enable (P1-5)
- [x] F7 wrap kill/verify bodies in try/catch (P1-7)
- [x] F8 disk cadence 30s (P2-8)
- [x] F9 persistent icon cache (P2-9)
- [x] F10 RAM spark row (green) so both histories are real (P2-10)
- [x] F11 README screenshots + features + test count; CI workflow (P2-11/12)
