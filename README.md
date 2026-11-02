# ProcMon

ProcMon is a GNOME Shell extension that puts processor, temperature and memory
usage in the top panel and opens a polished dashboard menu with uptime, load,
memory breakdown, CPU cores and frequencies, temperatures, fans, voltages,
battery, network and disk rates, graphics (GPU), pressure (PSI) and the
heaviest processes — all sampled asynchronously from `/proc` and `/sys`.

## Features

- **Panel indicator** with configurable items (CPU, temperature, RAM) and a
  live sparkline inside the menu.
- **Dashboard menu** with summary cards (CPU / memory / disk or GPU) and
  collapsible sections (accordion) so you see only what you need.
- **Top processes** grouped by CPU and by RAM, with safe termination:
  left click sends SIGTERM, right click sends SIGKILL, after a confirmation
  dialog. Every kill is re-verified against `/proc/<pid>/stat` starttime to
  prevent PID-reuse races, and only your own processes can be signaled.
- **Sensors**: CPU cores (up to 16) and frequencies, memory breakdown
  (used / available / cached / buffers / swap), temperatures, fans, voltages,
  battery level and power, network and disk rates, GPU usage, PSI pressure.
- **Preferences** built with Adw (no St/Clutter in the prefs process).
- **Internationalised**: English source with Arabic provided; all visible
  numbers go through isolates so RTL layouts stay clean.
- **GNOME Shell 45–49** (X11 and Wayland).

## Installation

From extensions.gnome.org, or manually:

```bash
cd ~/.local/share/gnome-shell/extensions
unzip procmon@abed.dev.zip -d procmon@abed.dev
gnome-extensions enable procmon@abed.dev
```

Log out and back in (or restart GNOME Shell on X11) the first time.

## Build

```bash
bash scripts/pack.sh
```

Produces `procmon@abed.dev.zip` with the runtime files only (tests, po and
scripts are excluded).

## Tests

```bash
npm test   # gjs -m tests/parsing.test.js  (71 tests)
```

## License

GPL-2.0-or-later. See `LICENSE`.