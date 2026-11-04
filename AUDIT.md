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

## Round 4 (v3.0.0 — visual identity + prefs gear)

- **Brand mark**: `assets/procmon.svg` (blue→green tile, white pulse) as the
  panel icon (FileIcon + themed fallback), alert-source icon, and menu header
  mark. Verified live in a panel crop — tile + pulse readable at 16px.
- **DESIGN.md**: full identity spec (mark, colour tokens, type scale, space,
  controls, motion, do/don't) — the closed palette the tokens test enforces.
  Repo description on GitHub refreshed (was listing the removed heatmap).
- **Control system** per DESIGN §5: kill button is now a ghost soft-square
  (red tint + red × on hover/focus, the only destructive red), toggles got a
  border, footer buttons got active/focus states, gear button in the header.
- **Feature**: header gear → opens extension prefs (`gnome-extensions prefs`).
- Design-tokens test: +6 identity checks (mark + gradient + pulse + rules).
  Total 111 gjs checks. Version alignment: metadata 4 / package 3.0.0 / tag v3.0.0.

## Round 3 (v2.9.0 — panel colours, diagnostics, import hygiene)

Hotfix v2.9.1 — **smart alerts were never working on GNOME 45+**:
- `new MessageTray.Source(title, iconName)` (positional) throws on 45+
  ("should be an object with properties to set"). The throw was swallowed by
  _refreshDiskUsage's try/catch, so alerts silently fell back to Main.notify
  (banner, but no Details action, no tray source) and disable() tried to
  call `.destroy()` on the unwrapped prototype METHOD (property/method name
  collision `_alertSource`) — "source.destroy is not a function".
- Same for `new MessageTray.Notification(source, title, body)` — now the
  45+ params-object form `{source, title, body}` in both alert sites.
- Delivery: `source.notify()`/`showNotification()` were removed in 45+ —
  the chain now prefers `source.addNotification()` with the old names as
  fallbacks (verified against libshell-14.so messageTray.js source).
- `_alertSource()` renamed `_getAlertSource()` to end the property/method
  name collision; destroy() passes an explicit reason with a typeof guard
  and an emit('destroy') fallback.
- **Deploy lesson**: `disable/enable` does NOT reload changed JS modules in
  the running shell (ESM cache) — only CSS. JS changes need a shell restart
  (`killall gnome-shell` on X11) before journal verification means
  anything. Earlier "clean journal" checks in this repo's history were
  measuring the cached old code.

- **Panel per-item labels with attention colours**: each of CPU/temp/RAM is
  its own label, coloured by a pure tested helper (`panelLevel` in
  ui/constants.js, warn/crit thresholds, + tests/panel-level.test.js, 11 =
  total 105 checks). CSS `.procmon-label-warn/-crit` are literal accents,
  readable on both themes. Replaces the single joined label.
- **Prefs About + Copy diagnostics**: version row + diagnostics button
  (clipboard verified empirically; toast feedback), Arabic strings added
  (140 = 140 parity, zero fuzzy).
- **Import hygiene** (skill rule): trimmed the copy-pasted mega-imports in
  ui/rows.js, ui/renderers.js, ui/sections.js, ui/cards.js to the symbols
  each module actually uses (verified per-symbol by usage count).
- Evidence-based rejections stand: stat-only process reads (UID needs
  /status), programmatic menu-open (Eval off by default).

## Round 2 (v2.8.0 — light theme + i18n coverage + shipping)

Findings:
- **Light theme broken**: all text colors were hardcoded `rgba(255,255,255,*)`
  → invisible on a light GNOME theme. Fix: foreground inherited from the shell
  theme; opacity dims secondary text. The old design-tokens test asserted the
  white token (encoded the bug) — replaced with a negative check.
- **Dead CSS**: `.procmon-sparkline` block unused since the Cairo removal; the
  tokens test passed only because `min-height: 40px` lived in dead code;
  duplicate `.procmon-sparkline-value` rules. Cleaned.
- **Arabic coverage gap**: extractor (`scripts/extract-strings.py`, since GNU
  xgettext can't parse JS) found 133 msgids vs 113 in ar.po — Startup section
  + sensors were English-only in Arabic, and 11 fuzzy entries carried wrong
  leftovers (e.g. "Stop %s" → "مدة التشغيل %s" = uptime; "GPU" → "المعالج" = CPU).
  Merged POT, translated all 36 (32 + 4 wrapped), zero fuzzy, zero empty.
- **metadata missing "url"** → extensions.gnome.org uploads need it. Added.
- Rejected with evidence: halving `_readProcess` file reads (stat-only) —
  UID still needs /status, memfs reads are negligible next to the risks.

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
