# ProcMon — Design Identity

ProcMon is a system monitor. Its identity is one idea: **the pulse of the
machine**. Every visual decision serves that idea — a heartbeat line for the
mark, blue/green for the two shapes of load (compute / memory), restrained
amber/red reserved for things a human should act on.

## 1. The mark

`assets/procmon.svg` — a rounded-square tile (64×64, radius 14) with a
blue→green diagonal gradient (`#3584e4` → `#33d17a`) carrying a white
heartbeat polyline (5px stroke, round joins/caps):

    M10,34 H24 L30,18 L38,46 L44,34 H54

- Where it appears: panel icon (16px), menu header, alert notifications,
  footer "Open System Monitor" fallback pairing.
- Fallback: the generic `utilities-system-monitor` icon if the file is
  missing (it never replaces the mark when present).
- Don't: outline versions, drop shadows, stretched tiles, other hues.

## 2. Colour tokens

| Token  | Value                 | Meaning                          |
| ------ | --------------------- | -------------------------------- |
| CPU    | `#3584e4` (rgba 53,132,228)  | processor load, primary accent   |
| RAM    | `#33d17a` (rgba 51,209,122)  | memory load                      |
| Warn   | `#ffbe6f` bars / #c27800 text | watch it (panel: ≥75%, bars: ≥60%) |
| Crit   | `#e66100` bars / `#e01b24` text | it needs you (≥90% / ≥85%)    |
| Text   | **inherited from shell theme** (never hardcoded) | primary; opacity 0.6/0.45 dims |

Rules: only the accents above may be literal colours. Foreground always
inherits; secondary text dims via `opacity`. Backgrounds are alpha washes —
subtle on both themes. Warn/crit text colours are chosen to read on light
*and* dark themes.

## 3. Type scale

- Card values: 16px bold, tabular numerals (`tnum`) — the loudest numbers.
- Row/line values: 11px bold tnum · names 11px · kill pill 11px bold.
- Titles: section/group titles 11px bold untracked (tool-like);
  card titles stay 9px tracked kickers (instrument readouts).
- Group titles: 11.5px bold. Meta line: 10px, opacity 0.6, tnum.
- Every visible number passes through `iso()` (RTL-safe), never raw.

## 4. Space, shape, motion

- 4px rhythm everywhere; content width 352px, 10px padding.
- Radii: cards 10 · groups 10 · sections 9 · rows 6 · pills 10–11.
- Bars: 3px tall, 250ms colour transition. Section open/close: 100ms
  `EASE_OUT_CUBIC` opacity fade, no layout jump.
- Fixed columns in process rows (value 52px, right-aligned) so numbers
  never jitter between samples.

## 5. Controls

| Control       | Style                                                              |
| ------------- | ------------------------------------------------------------------ |
| Kill (×)      | Ghost circle, fixed 20–22px slot; transparent → red tint on hover  |
| On/Off toggle | Pill, min 34px; green tint when On, neutral wash when Off          |
| Footer buttons| one bottom toolbar: Open System Monitor + Refresh (labelled,
  x_expand pair) + Preferences gear (icon-only, aria name). Controls live
  in the footer, never scattered in the header. Header is brand-only. |
| Group headers | Full-row buttons (consume the press so the menu stays open)        |
| Chevrons      | ▾ open / ▸ closed, 11px, opacity 0.65                              |

All interactive rows are `can_focus` and carry accessible names. The kill
pill is the only red control — red means destructive, always.

## 5b. Menu structure (v4.0.0)

- **No stacked buttons.** Groups are ruled rows, not rounded card buttons;
  one hairline per group boundary. Subsections are flat titles with a
  hairline between them (first in a group exempt). This is the de-AI pass.
- Every group header carries a live summary (count, GB, °C, %, some) — an
  empty right side reads as broken.
- Menu content width 360px; scroll viewport 460px max.
- The sparkline value line IS the legend: CPU value in CPU blue, RAM value
  in readable green (`#1f9d55`) — blue row above, green row below.
- Card titles gain a trend glyph vs the previous sample (▲ up ≥2pts,
  ▼ down ≥2pts, ● steady) — title text only, layout never shifts.

## 6. Motion/Behaviour principles

- No flicker: first paint shows placeholders, real data ≤700ms.
- Rows never rebuild under the cursor (pointer gate) so clicks land.
- Async fills never touch disposed actors (menu generation guard).
- Alerts escalate (94/97/99%), then repeat at most once per 6h per kind.

## 7. What not to do

- No per-core heatmap (removed by product decision).
- No second orange/red accent; the palette is closed.
- No hardcoded text colours; no Cairo inside popups (libmutter crash).
- No new hue without updating this document and the tokens test.
