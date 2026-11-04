# ProcMon

A system monitor for the GNOME top panel — CPU, RAM and temperature at a
glance, with a dashboard menu for everything else. Fully async sampling from
`/proc` and `/sys`, no external dependencies, GNOME Shell 45–49 (X11 and
Wayland), English + Arabic.

![Menu](screenshots/menu.png)

## Features

- **Panel indicator** with configurable items (CPU, temperature, RAM) and
  warn/crit colouring on the summary bars.
- **Dashboard menu**: summary cards (CPU / memory / disk-or-GPU), a CPU+RAM
  history sparkline (blue CPU bars, green RAM bars), and collapsible groups
  so you see only what you need.
- **Top processes** grouped by CPU and by RAM, with safe termination: left
  click sends SIGTERM, right click sends SIGKILL, after a confirmation
  dialog. Every kill is re-verified against `/proc/<pid>/stat` starttime to
  prevent PID-reuse races, only your own processes can be signaled, and
  supervised processes (systemd services, session apps) say so before you
  kill them — with a one-click "Stop the unit" follow-up if they restart.
- **Sensors**: CPU cores and frequencies, memory breakdown (used / available
  / cached / buffers / swap), temperatures, fans, voltages, battery level,
  power and time left, network and disk rates, GPU usage + VRAM, PSI
  pressure.
- **Smart alerts**: threshold notifications with escalation (94/97/99%) that
  notify again immediately; repeats are capped at once per 6 hours per kind,
  and opening the menu acknowledges what you have seen.
- **Startup**: autostart apps (user/system) and `systemctl --user` services
  with On/Off toggles that only flip after the underlying call succeeds.
- **Preferences** built with Adw (no St/Clutter in the prefs process):
  refresh rates, panel items, alert thresholds, per-section visibility,
  kill confirmation.
- **Internationalised**: English source with Arabic provided; every visible
  number goes through isolates so RTL layouts stay clean.

## Screenshots

| Menu | Kill confirmation |
| --- | --- |
| ![Menu](screenshots/menu.png) | ![Kill confirmation](screenshots/confirm-dialog.png) |

## Installation

From extensions.gnome.org, or manually:

```bash
cd ~/.local/share/gnome-shell/extensions
unzip procmon@abed.dev.zip -d procmon@abed.dev
gnome-extensions enable procmon@abed.dev
```

Log out and back in (or restart GNOME Shell on X11) the first time.

## Development

```bash
npm test        # 94 gjs checks: parsing + design tokens + alerts + supervisor
npm run check   # node --check on every JS file
bash scripts/pack.sh      # produces procmon@abed.dev.zip (runtime files only)
bash scripts/compile-schemas.sh
bash scripts/compile-locale.sh
```

Code layout: `extension.js` (indicator + sampling orchestration),
`lib/proc.js` (pure parsers — gettext-free, unit-tested), `ui/` (menu
components: cards, sections, rows, renderers, sparkline, startup),
`prefs.js` (Adw preferences), `stylesheet.css` (alpha-only design tokens so
light and dark themes both work).

## License

GPL-2.0-or-later. See `LICENSE`.
