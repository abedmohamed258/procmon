# Changelog — ProcMon

All notable changes to this extension, newest first. Versions follow the
git history; the `version` in `metadata.json` (extensions.gnome.org) tracks
them one-to-one.

## v3.1.0 — Menu redesign

- Level-2 subsections are flat titles with a hairline divider (first in a
  group exempt) — no more boxes inside boxes. One frame per group.
- Sparkline colour legend (blue dot = CPU, green dot = RAM).
- Summary-card titles show a trend glyph (▲/▼/●) vs the previous sample.
- Menu width 352 → 360px, scroll viewport 440 → 460px.
- Design tokens: 18 checks (legend, flatten rule, width).

## v3.0.0 — Identity

- Brand mark (`assets/procmon.svg`): blue→green tile with a white pulse —
  panel icon, menu header, alert notifications (themed fallback preserved).
- `DESIGN.md`: the full visual identity — mark, closed colour palette,
  type scale, 4px rhythm, radii, motion, control styles, do/don't.
- Controls per the spec: ghost soft-square kill button (red tint + red × on
  hover/focus), bordered On/Off pills, footer button active/focus states.
- New header gear button opens extension preferences.
- GitHub repo description refreshed (was listing the removed heatmap).

## v2.9.1 — Alert hotfix

- Smart alerts never worked on GNOME 45+: `MessageTray.Source` /
  `Notification` positional constructors throw — now the 45+ params-object
  forms (verified against libshell-14.so).
- Delivery prefers `source.addNotification()` (45+ API); old
  `notify()`/`showNotification()` kept as fallbacks.
- `_alertSource()` renamed `_getAlertSource()` — a method and an instance
  property with the same name shadowed each other.
- Alert-source cleanup on disable passes an explicit destroy reason with a
  typeof guard + emit fallback.

## v2.9.0 — Panel colours, diagnostics, hygiene

- Per-item panel labels, each coloured by its own attention level
  (warn ≥75%, crit ≥90%, tested `panelLevel` helper).
- Prefs: About group + one-click copy-diagnostics (clipboard + toast).
- Import hygiene: trimmed copy-pasted mega-imports in every `ui/` module.
- 105 gjs checks.

## v2.8.0 — Light theme + i18n coverage

- Text colour was hardcoded white and invisible on light themes — foreground
  is now theme-inherited; the design-tokens test asserts the absence.
- Dead CSS removed; duplicate sparkline-value rules merged.
- Full Arabic coverage: `_()`/`_n()` extractor, POT merge, 36 translations
  incl. 11 fuzzy leftovers that were wrong (GPU → CPU text, etc.).
- `metadata.json` gained `url` (extensions.gnome.org requirement).

## v2.7.0 — First polish round

- Startup services: generation-guarded async fill (killed the journal
  "already disposed" storm), honest systemctl exit status.
- `npm test` runs all four suites (94 checks); added `npm run check`.
- `pack.sh` ships `ui/` (silently omitted since the v2.2 split) and now
  asserts the manifest.
- Version alignment (metadata 3 / package 2.7.0), prefs copy fixed
  (6h cooldown), alert-source cleanup on disable, 30s disk cadence,
  persistent icon cache, CPU+RAM spark rows, README screenshots, CI.
