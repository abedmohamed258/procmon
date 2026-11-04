import Gettext from 'gettext';
const __ = Gettext.domain('procmon@abed.dev');
export const _ = __.gettext;
export const _n = __.ngettext;
export const iso = value => '\u2066' + String(value) + '\u2069';

export const FIRST_SAMPLE_MS = 700;
export const IO_WARMUP_MS = 1000;
export const EXIT_CHECK_MS = 2000;
export const TEMPERATURE_CACHE_MS = 5000;
export const DISK_CACHE_MS = 30000; // statfs is syscall-heavy; 30s is plenty
export const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const SPARK_SAMPLES = 60;
export const SPARKLINE_WIDTH = 120;
export const SPARKLINE_HEIGHT = 30;
export const MAX_TEMPERATURES = 8;
export const MAX_FILESYSTEMS = 3;
export const FALLBACK_PROCESS_ICON = 'application-x-executable-symbolic';
export const PSI_RESOURCES = [
    {resource: 'cpu', title: () => _('CPU')},
    {resource: 'memory', title: () => _('Memory')},
    {resource: 'io', title: () => _('I/O')},
];

export const MAX_GPU_CARDS = 4;
export const ENUMERATE_BATCH = 64;
export const MIN_PID = 3;
// lib/proc.js stays gettext-free: battery statuses come back as raw keys.
export const BATTERY_STATUS_TEXT = new Map([
    ['Charging', () => _('Charging')],
    ['Discharging', () => _('Discharging')],
    ['Full', () => _('Fully charged')],
]);

export const percentOf = (used, total) => total > 0 ? Math.max(0, Math.min(100, 100 * used / total)) : 0;

export function parsePanelItems(raw) {
    const allowed = new Set(['cpu', 'temp', 'ram']);
    const items = [];
    for (const item of String(raw ?? '').split(',')) {
        const key = item.trim();
        if (allowed.has(key) && !items.includes(key))
            items.push(key);
    }
    return items;
}

// Panel attention levels (display only — never alert logic): amber means
// "watch it", red means "it needs you". Thresholds are deliberately stricter
// than the card bars (warn >=60) so a calm system shows no amber at all.
export const PANEL_WARN = {cpu: 75, ram: 75, temp: 70};
export const PANEL_CRIT = {cpu: 90, ram: 90, temp: 85};

export function panelLevel(item, value) {
    if (!Number.isFinite(value))
        return 'ok';
    if (value >= (PANEL_CRIT[item] ?? 90))
        return 'crit';
    if (value >= (PANEL_WARN[item] ?? 75))
        return 'warn';
    return 'ok';
}
