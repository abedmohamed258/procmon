# Changelog — ProcMon

All notable changes to this extension, newest first, one section per git
tag. The `version` field in `metadata.json` is an extensions.gnome.org
upload counter: a plain integer that must strictly increase on every
upload, so it does **not** equal the human version (v3.3.0 shipped as
integer 4; the human version lives in the tags, this file and
`package.json`).

## v3.3.0 — Controls consolidation (footer toolbar)

- The preferences gear moved out of the header into the footer as an
  icon-only third button (`buildPrefsButton`, aria name "Preferences"),
  so all controls live in one bottom toolbar: Open System Monitor +
  Refresh (labelled, `x_expand` pair) + gear. The header is brand-only
  now (mark + title). (`ui/sections.js`)
- Measurements: process value column widened 46 → 52px (less digit
  jitter between samples), group-body bottom padding 6 → 8px.
- Motion: section and group open/close fade 120 → 100ms
  (`EASE_OUT_CUBIC`, unchanged) — snappier collapse.
- CSS: dead `.procmon-header-btn` rule replaced by
  `.procmon-footer-icon-btn` (min-width 36px); duplicated
  `.procmon-footer` block removed. (`stylesheet.css`)
- `DESIGN.md` control table rewritten for the footer-toolbar rule
  ("controls live in the footer, never scattered in the header").
- CI hardening since v3.2.0: the release step is idempotent
  (`gh release upload --clobber` when the release already exists) and
  the workflow gained `workflow_dispatch` with a tag input for manual
  re-runs.

## v3.2.0 — Release engineering

- `.github/workflows/release.yml`: pushing a `v*` tag runs the full
  gate (114 gjs checks, `node --check` on every file, metadata/package
  JSON validation, `glib-compile-schemas --strict`), builds the zip via
  `scripts/pack.sh` (whose manifest assertions guard against shipping a
  broken artifact) and publishes it attached to a GitHub release.
- `CHANGELOG.md` created from the git history (v2.7.0 → v3.1.0 at the
  time) and linked from the README.
- README: CI status badge, and a concise Arabic section (feature
  summary + install snippet) alongside the English docs.
- `tests.yml`: job step labels synced to the real count (94 → 114).

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

## Backfill: v2.0.0 – v2.6.0

Short entries reconstructed from the tagged release commits when this
file was created (v3.2.0); details intentionally terse.

### v2.6.0 — Supervised-process awareness
- Detect whether a process is supervised (cgroup/systemd service or
  session app) and say so before killing, with a "Stop the unit"
  follow-up action; supervisor-parser tests; section fade animation and
  spacing/button polish.

### v2.5.0 — Runtime-breakage fixes
- Shadowed `rows` parameter and stale detail sections fixed; the Cairo
  sparkline removed (segfault via libmutter in the shell) and replaced
  by St-based bars; disk rates added.

### v2.4.0 — Post-refactor regressions
- `percentOf`/`parsePanelItems` single-sourced in `ui/constants.js`;
  PopupMenu/Cairo imports restored; MessageTray Source API fallback;
  `Cairo.LinearGradient` constructor instead of `cr.createLinearGradient`;
  sparkline `x_expand` fix.

### v2.3.0 — Sparkline + pure helpers
- Sparkline fills card width; `alertDecision` extracted as a pure
  helper with tests; `toggleAutostart` preserves unrelated entries;
  repo cleanup.

### v2.2.0 — Spec-driven polish + module split
- Hierarchical menu, smart alerts and startup toggles per the design
  spec; single-file indicator refactored into `ui/*` modules; design
  tokens introduced.

### v2.1.0 — Startup group + acknowledgments
- Panel default is CPU + RAM; Startup group (autostart apps and user
  services with toggles); smart notifications acknowledge-on-open;
  per-core block removed.

### v2.0.0 — The v2 rewrite
- Hierarchical dashboard menu, per-core CPU heatmap, smart alerts and
  safe kill (confirmation + PID-reuse re-verification); initial
  full release (19 files).
