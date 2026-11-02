// ProcMon — GNOME Shell system monitor. /proc and /sys are sampled through
// Gio async calls only; the menu structure is built once per open and updated
// in place, like the old _updateIoLabels approach. Every visible number goes
// through iso() so RTL layouts keep digits clean; every visible word is
// translated through gettext.
import Clutter from 'gi://Clutter';
import Atk from 'gi://Atk';
import Cairo from 'gi://cairo';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import Gettext from 'gettext';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {assessKillProcess, averageFrequencyGhz, collectFans, collectTemperatures,
    collectVoltages, computeCoreShares, computeCpuShares, computeDiskRates,
    computeNetRates, formatBytes, formatDuration, formatRate, groupProcesses,
    isFiniteRect, isPointInsideRect, ownedProcessEntries, parseBatteryDetails,
    parseCoreTicks, parseCpuTicks, parseDiskStats, parseGpuCard, parseLoadAvg,
    parseMemInfo, parseNetDev, parsePsi, parseStatLine, parseUptime} from './lib/proc.js';

const _ = Gettext.domain('procmon@abed.dev').gettext;
const _n = Gettext.domain('procmon@abed.dev').ngettext;

const iso = value => '\u2066' + String(value) + '\u2069';

const FIRST_SAMPLE_MS = 700;
const IO_WARMUP_MS = 1000;
const EXIT_CHECK_MS = 2000;
const TEMPERATURE_CACHE_MS = 5000;
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // at most one reminder per 6h
const SPARK_SAMPLES = 60;
const SPARKLINE_WIDTH = 120;
const SPARKLINE_HEIGHT = 30;
const MAX_DISPLAYED_CORES = 16;
const CORES_PER_ROW = 4;
const MAX_FREQUENCY_CORES = 8;
const MAX_TEMPERATURES = 8;
const MAX_FILESYSTEMS = 3;
const MAX_GPU_CARDS = 4;
const MIN_PID = 3;
const ENUMERATE_BATCH = 64;
const FALLBACK_PROCESS_ICON = 'application-x-executable-symbolic';
const PSI_RESOURCES = [
    {resource: 'cpu', title: () => _('CPU')},
    {resource: 'memory', title: () => _('Memory')},
    {resource: 'io', title: () => _('I/O')},
];
// lib/proc.js stays gettext-free: battery statuses come back as raw keys.
const BATTERY_STATUS_TEXT = new Map([
    ['Charging', () => _('Charging')],
    ['Discharging', () => _('Discharging')],
    ['Full', () => _('Fully charged')],
]);

const SHELL_MAJOR = Number.parseInt(String(Config.PACKAGE_VERSION ?? ''), 10) || 0;
// wrap arrived on StBoxLayout with newer shells; sliced rows stay for older ones.
const BOX_WRAP_SUPPORTED = SHELL_MAJOR >= 48;

const REAL_FILESYSTEMS = new Set(['ext2', 'ext3', 'ext4', 'btrfs', 'xfs', 'f2fs', 'vfat',
    'exfat', 'ntfs', 'ntfs3', 'fuseblk', 'zfs']);

const decodeMountPath = path => path.replace(/\\([0-7]{3})/g, (_match, octal) =>
    String.fromCharCode(parseInt(octal, 8)));

const percentOf = (used, total) => total > 0
    ? Math.max(0, Math.min(100, 100 * used / total)) : 0;

function parsePanelItems(raw) {
    const allowed = new Set(['cpu', 'temp', 'ram']);
    const items = [];
    for (const item of String(raw ?? '').split(',')) {
        const key = item.trim();
        if (allowed.has(key) && !items.includes(key))
            items.push(key);
    }
    return items;
}

const uidFromStatus = statusText => {
    const match = statusText?.match(/^Uid:\s+(\d+)/m);
    return match ? Number(match[1]) : -1;
};

const rssKbFromStatus = statusText => {
    const match = statusText?.match(/^VmRSS:\s+(\d+) kB/m);
    return match ? Number(match[1]) : 0;
};

// assessKillProcess reasons → gettext copy; the same words serve the single
// identity notice and the aggregated skip report.
const KILL_PROBLEM_TEXT = reason => {
    switch (reason) {
        case 'foreign-uid': return _('Not your process');
        case 'pid-reused': return _('Process identity changed');
        case 'zombie-or-exited': return _('Process exited');
        case 'unknown-identity':
            return _('Unknown user identity — termination disabled');
        default: return _('Process exited');
    }
};

const getPointer = () => (typeof global.backend?.get_cursor === 'function')
    ? global.backend.get_cursor()
    : global.get_pointer();

function readFileAsync(path, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.File.new_for_path(path).load_contents_async(cancellable, (stream, result) => {
            let contents;
            try {
                [, contents] = stream.load_contents_finish(result);
            } catch (error) {
                reject(error);
                return;
            }
            resolve(new TextDecoder().decode(contents));
        });
    });
}

const tryRead = (path, cancellable) =>
    readFileAsync(path, cancellable).catch(() => null);

// Last-resort synchronous read for /proc: the async path can fail on a live
// pid, and a false "exited" verdict blocks a legitimate kill. /proc files are
// in-memory, so this never blocks on I/O.
function readProcSync(pid, name) {
    try {
        const [ok, contents] = GLib.file_get_contents(`/proc/${pid}/${name}`);
        return ok ? new TextDecoder().decode(contents) : null;
    } catch {
        return null;
    }
}

// Async directory listing for /proc and /sys; nothing synchronous here.
function listNamesAsync(path, pattern, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.File.new_for_path(path).enumerate_children_async('standard::name',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, cancellable,
            (source, result) => {
                let enumerator;
                try {
                    enumerator = source.enumerate_children_finish(result);
                } catch (error) {
                    reject(error);
                    return;
                }

                const names = [];
                const drain = () => {
                    enumerator.next_files_async(ENUMERATE_BATCH, GLib.PRIORITY_DEFAULT,
                        cancellable, (list, nextResult) => {
                            let infos;
                            try {
                                infos = list.next_files_finish(nextResult);
                            } catch (error) {
                                reject(error);
                                return;
                            }
                            if (infos.length === 0) {
                                enumerator.close_async(GLib.PRIORITY_LOW, null,
                                    (closing, closeResult) => {
                                        try {
                                            closing.close_finish(closeResult);
                                        } catch (error) {
                                            console.warn(`procmon: closing enumerator: ${error}`);
                                        }
                                    });
                                resolve(names);
                                return;
                            }
                            for (const info of infos) {
                                const name = info.get_name();
                                if (pattern.test(name))
                                    names.push(name);
                            }
                            drain();
                        });
                };
                drain();
            });
    });
}

const tryList = (path, pattern, cancellable) =>
    listNamesAsync(path, pattern, cancellable).catch(() => []);

function queryFilesystemUsageAsync(mountPoint, cancellable) {
    return new Promise(resolve => {
        const attributes = 'filesystem::used,filesystem::size';
        Gio.File.new_for_path(mountPoint).query_filesystem_info_async(attributes,
            GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
                let info;
                try {
                    info = source.query_filesystem_info_finish(result);
                } catch {
                    resolve(null);
                    return;
                }
                const totalBytes = info.get_attribute_uint64('filesystem::size');
                const usedBytes = info.get_attribute_uint64('filesystem::used');
                if (!(totalBytes > 0)) {
                    resolve(null);
                    return;
                }
                resolve({
                    mountPoint,
                    usedBytes,
                    totalBytes,
                    percent: Math.round(100 * usedBytes / totalBytes),
                });
            });
    });
}

function sendSignalAsync(pid, signal) {
    const killBin = GLib.find_program_in_path('kill');
    if (!killBin)
        return Promise.resolve(_('kill command not found'));

    return new Promise(resolve => {
        let process;
        try {
            process = Gio.Subprocess.new([killBin, `-${signal}`, String(pid)],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (error) {
            resolve(String(error.message ?? error));
            return;
        }
        process.wait_check_async(null, (source, result) => {
            const succeeded = source.wait_check_finish(result);
            resolve(succeeded ? null : _('Signal failed'));
        });
    });
}

const ProcMonIndicator = GObject.registerClass(
class ProcMonIndicator extends PanelMenu.Button {
    _init(settings) {
        super._init(0.0, 'ProcMon');
        this.accessible_name = _('System monitor');

        this._settings = settings;
        this._cancellable = new Gio.Cancellable();
        this._timeouts = new Set();
        this._settingsSignalId = 0;
        this._menuSignalId = 0;

        this._panelTickId = 0;
        this._menuTickId = 0;
        this._ioWarmupId = 0;
        this._exitCheckId = 0;
        this._panelBusy = false;
        this._menuBusy = false;
        this._thermalBusy = false;
        this._ioBusy = false;
        this._diskBusy = false;

        this._cpuPercent = 0;
        this._memory = null;
        this._lastCpuTicks = null;
        this._lastSample = null;
        this._processes = new Map();
        this._menuShares = null;
        this._rowsPopulated = false;

        this._thermalAt = 0;
        this._temperatures = [];
        this._fans = [];
        this._voltages = [];
        this._battery = null;
        this._frequencies = [];
        this._sensors = {};
        this._fsData = [];
        this._ioCurrent = null;
        this._ioRates = null;
        this._iconCache = new Map();
                this._cpuHistory = [];
        this._ramHistory = [];
        this._sparkArea = null;
        this._lastAlertAt = new Map();
        this._alertState = new Map();
        this._openSections = new Set(['processes', 'memory', 'memory-usage', 'top-cpu']);

        this._currentUid = -1;
        this._ownPid = -1;
        void this._bootstrapIdentity();

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box procmon-box'});
        box.add_child(new St.Icon({
            icon_name: 'utilities-system-monitor-symbolic',
            // many themes (Zorin, Papirus) ship only the full-colour icon, so
            // without a fallback the panel button renders as an empty gap
            fallback_icon_name: 'utilities-system-monitor',
            style_class: 'system-status-icon procmon-icon',
        }));
        this._label = new St.Label({
            text: '',
            style_class: 'procmon-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._label);
        this.add_child(box);

        this._settingsSignalId = this._settings.connect('changed', (_client, key) =>
            this._onSettingsChanged(key));
        this._menuSignalId = this.menu.connect('open-state-changed', (_menu, isOpen) =>
            this._onMenuOpenChanged(isOpen));

        this._startPanelTimer();
        void this._samplePanelData();
        // PopupMenu.open() silently refuses (never emits open-state-changed)
        // when the menu box is empty, and the content was only ever built
        // inside the open-state-changed handler — a boot-time deadlock.
        // Build the structure here so the first open() has content;
        // the open handler still rebuilds fresh content on every open.
        this._buildMenu();
    }

    // ----- timers --------------------------------------------------------

    _periodic(ms, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            callback();
            return GLib.SOURCE_CONTINUE;
        });
        this._timeouts.add(id);
        return id;
    }

    _later(ms, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
        return id;
    }

    _clearTimer(field) {
        const id = this[field];
        if (!id)
            return;
        // one-shot sources delete themselves; removing them twice logs
        // "Source ID … was not found" and is a real warning in the journal
        if (this._timeouts.has(id))
            GLib.source_remove(id);
        this._timeouts.delete(id);
        this[field] = 0;
    }

    _stopAllTimers() {
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();
        this._panelTickId = 0;
        this._menuTickId = 0;
        this._ioWarmupId = 0;
        this._exitCheckId = 0;
    }

    _startPanelTimer() {
        this._clearTimer('_panelTickId');
        const interval = Math.max(200, this._settings.get_int('refresh-interval-ms'));
        this._panelTickId = this._periodic(interval, () => void this._samplePanelData());
    }

    _restartMenuTimer() {
        this._clearTimer('_menuTickId');
        if (!this.menu.isOpen)
            return;
        const interval = Math.max(500, this._settings.get_int('menu-refresh-ms'));
        this._menuTickId = this._periodic(interval, () => void this._sampleMenuData());
    }

    // ----- identity ------------------------------------------------------

    async _bootstrapIdentity() {
        const cancellable = this._cancellable;
        const [statusText, statText] = await Promise.all([
            tryRead('/proc/self/status', cancellable),
            tryRead('/proc/self/stat', cancellable),
        ]);
        this._currentUid = uidFromStatus(statusText);
        const ownPid = statText?.match(/^(\d+)\s/)?.[1];
        this._ownPid = ownPid ? Number(ownPid) : -1;
    }

    // ----- settings ------------------------------------------------------

    _onSettingsChanged(key) {
        switch (key) {
            case 'refresh-interval-ms':
                this._startPanelTimer();
                break;
            case 'panel-items':
                this._updatePanelLabel();
                break;
            case 'menu-refresh-ms':
                this._restartMenuTimer();
                break;
            default:
                // kill-confirmation is read at kill time, not a menu layout
                // input; only layout keys may rebuild the menu
                if (key.startsWith('show-') || key === 'top-count') {
                    if (this.menu.isOpen) {
                        this._buildMenu();
                        void this._sampleMenuData();
                    }
                }
        }
    }

    _wantsSection(key) {
        return this._settings.get_boolean(`show-${key}`);
    }

    // ----- panel ---------------------------------------------------------

    async _samplePanelData() {
        if (this._panelBusy)
            return;
        this._panelBusy = true;
        try {
            const cancellable = this._cancellable;
            const [statText, memText] = await Promise.all([
                tryRead('/proc/stat', cancellable),
                tryRead('/proc/meminfo', cancellable),
            ]);

            const ticks = parseCpuTicks(statText);
            if (ticks && this._lastCpuTicks) {
                const totalDelta = ticks.total - this._lastCpuTicks.total;
                const busyDelta = ticks.busy - this._lastCpuTicks.busy;
                this._cpuPercent = totalDelta > 0
                    ? Math.max(0, 100 * busyDelta / totalDelta) : 0;
            }
            if (ticks)
                this._lastCpuTicks = ticks;
            this._memory = parseMemInfo(memText) ?? this._memory;

            void this._refreshThermalSensors();
            this._updatePanelLabel();
            this._recordSparkSample();
            this._maybeMemoryAlert();
            void this._refreshDiskUsage();
            if (this.menu.isOpen)
                this._renderSummaryCards();
        } catch (error) {
            // swallow cancellation / transient read failures
        } finally {
            this._panelBusy = false;
        }
    }

    _panelTemperature() {
        return this._temperatures.length ? this._temperatures[0].celsius : null;
    }

    _updatePanelLabel() {
        const parts = [];
        const ramPercent = this._memory
            ? percentOf(this._memory.usedMb, this._memory.totalMb) : 0;
        for (const item of parsePanelItems(this._settings.get_string('panel-items'))) {
            if (item === 'cpu')
                parts.push(`${_('CPU')} ${iso(Math.round(this._cpuPercent))}%`);
            if (item === 'ram')
                parts.push(`${_('RAM')} ${iso(Math.round(ramPercent))}%`);
            if (item === 'temp') {
                const celsius = this._panelTemperature();
                if (celsius !== null)
                    parts.push(`${iso(Math.round(celsius))}°C`);
            }
        }
        this._label.text = parts.join(' · ');
    }

    // ----- sparkline + threshold alerts ------------------------------------

    _recordSparkSample() {
        if (!this._settings.get_boolean('show-sparkline'))
            return;
        if (Number.isFinite(this._cpuPercent)) {
            this._cpuHistory.push(Math.min(100, Math.max(0, this._cpuPercent)));
            if (this._cpuHistory.length > SPARK_SAMPLES)
                this._cpuHistory.shift();
        }

        const memory = this._memory;
        const ramPercent = memory && memory.totalMb > 0
            ? percentOf(memory.usedMb, memory.totalMb) : null;
        if (ramPercent !== null) {
            this._ramHistory.push(Math.min(100, Math.max(0, ramPercent)));
            if (this._ramHistory.length > SPARK_SAMPLES)
                this._ramHistory.shift();
        }

        // repaint only pays off while the menu is visible
        if (this.menu.isOpen && this._sparkArea)
            this._sparkArea.queue_repaint();
    }

    // St.DrawingArea in GNOME 46 passes NO cairo context through the repaint
    // signal; the handler fetches its own context and must dispose it after.
    _paintSparkline(area) {
        const allocation = area?.allocation;
        if (!allocation)
            return;
        const width = allocation.x2 - allocation.x1;
        const height = allocation.y2 - allocation.y1;
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
            return;
        const cr = area.get_context();
        // inset inside the styled padding so the curve stays off the rounded rim
        const inset = 6;
        this._drawSparkSeries(cr, width, height, inset, this._cpuHistory,
            94 / 255, 160 / 255, 255 / 255, 0.9);
        this._drawSparkSeries(cr, width, height, inset, this._ramHistory,
            46 / 255, 194 / 255, 126 / 255, 0.8);
        cr.$dispose();
    }

    _drawSparkSeries(cr, width, height, inset, history, red, green, blue, lineAlpha) {
        const points = history.slice(-SPARK_SAMPLES);
        const count = points.length;
        if (count < 2)
            return;

        const usableWidth = width - 2 * inset;
        const usableHeight = height - 2 * inset;
        const bottom = height - inset;
        // newest sample sits at the right edge even before the buffer fills
        const span = usableWidth / (SPARK_SAMPLES - 1);
        const start = inset + (SPARK_SAMPLES - count) * span;
        const toY = value => bottom - Math.min(100, Math.max(0, value)) / 100 * usableHeight;

        cr.setSourceRGBA(red, green, blue, 0.15);
        cr.moveTo(start, bottom);
        points.forEach((value, index) =>
            cr.lineTo(start + index * span, toY(value)));
        cr.lineTo(start + (count - 1) * span, bottom);
        cr.closePath();
        cr.fill();

        cr.setSourceRGBA(red, green, blue, lineAlpha);
        cr.setLineWidth(1.5);
        cr.moveTo(start, toY(points[0]));
        for (let index = 1; index < count; index++)
            cr.lineTo(start + index * span, toY(points[index]));
        cr.stroke();
    }

    // Smart notifications. Rules:
    //  - notify only on the rising edge of a level (94 → 97 → 99);
    //  - a reminder at most once per ALERT_COOLDOWN_MS while ignored;
    //  - "Details" or simply opening the menu = the user knows: silence
    //    until the condition clears, which re-arms the alert;
    //  - escalation always breaks the silence (it is new information).
    _alertSource() {
        if (!this._alertSource) {
            this._alertSource = new MessageTray.Source(_('ProcMon'),
                'utilities-system-monitor-symbolic');
            this._alertSource.connect('destroy', () => {
                this._alertSource = null;
            });
            Main.messageTray.add(this._alertSource);
        }
        return this._alertSource;
    }

    _maybeAlert(kind, message, level = 1) {
        const now = GLib.get_monotonic_time() / 1000;
        const state = this._alertState.get(kind) ?? {level: 0, at: 0, acked: false};
        const escalated = level > state.level;
        const cooled = now - state.at >= ALERT_COOLDOWN_MS;
        if (!escalated && (state.acked || !cooled))
            return;
        const notif = new MessageTray.Notification(this._alertSource(),
            _('ProcMon'), message);
        notif.setResident(true);
        notif.setTransient(false);
        notif.addAction(_('Details'), () => {
            const entry = this._alertState.get(kind);
            if (entry)
                entry.acked = true;
            this.menu.open();
        });
        this._alertState.set(kind, {level, at: now, acked: false});
        this._alertSource().showNotification(notif);
    }

    // opening the menu counts as engagement: stop repeating what was seen
    _acknowledgeAlerts() {
        for (const state of this._alertState.values())
            state.acked = true;
    }

    // the condition cleared: the next rise is news again
    _clearAlert(kind) {
        const state = this._alertState.get(kind);
        if (state && (state.level > 0 || state.acked))
            this._alertState.set(kind, {level: 0, at: 0, acked: false});
    }

    _maybeMemoryAlert() {
        const limit = this._settings.get_uint('mem-alert-pct');
        if (!(limit > 0) || !this._memory)
            return;
        const percent = Math.round(percentOf(this._memory.usedMb, this._memory.totalMb));
        if (percent > limit) {
            const level = percent >= 97 ? 3 : percent >= 94 ? 2 : 1;
            this._maybeAlert('mem',
                _('Memory %.0f%% — almost full').replace('%.0f', iso(percent))
                    .replace('%%', '%'), level);
        } else if (limit > 0) {
            this._clearAlert('mem');
        }
    }

    // disk usage sampling lives on the permanent panel path (not menu-only),
    // so the threshold alert works even when the menu has never been opened
    async _refreshDiskUsage() {
        if (this._diskBusy)
            return;
        this._diskBusy = true;
        try {
            this._fsData = await this._readFilesystems();
            const diskLimit = this._settings.get_uint('disk-alert-pct');
            const fullest = this._fsData.reduce(
                (max, filesystem) => Math.max(max, filesystem.percent ?? 0), 0);
            if (diskLimit > 0 && fullest > diskLimit) {
                // 94% · 97% · 99% are three different urgencies, not a loop
                const level = fullest >= 99 ? 3 : fullest >= 97 ? 2 : 1;
                this._maybeAlert('disk',
                    _('Disk %.0f%% full').replace('%.0f', iso(fullest)).replace('%%', '%'),
                    level);
            } else if (diskLimit > 0) {
                this._clearAlert('disk');
            }
        } catch (error) {
            console.warn(`procmon: disk usage refresh failed: ${error}`);
        } finally {
            this._diskBusy = false;
        }
    }

    // ----- sensor sweeps -------------------------------------------------

    async _refreshThermalSensors(force = false) {
        if (this._thermalBusy)
            return;
        const now = GLib.get_monotonic_time() / 1000;
        if (!force && now - this._thermalAt < TEMPERATURE_CACHE_MS)
            return;
        this._thermalBusy = true;
        try {
            const cancellable = this._cancellable;
            const [zoneNames, hwmonNames, powerNames] = await Promise.all([
                tryList('/sys/class/thermal', /^thermal_zone\d+$/, cancellable),
                tryList('/sys/class/hwmon', /^hwmon\d+$/, cancellable),
                tryList('/sys/class/power_supply', /^BAT\d*$/, cancellable),
            ]);

            const zones = await Promise.all(zoneNames.map(async name => {
                const [type, temp] = await Promise.all([
                    tryRead(`/sys/class/thermal/${name}/type`, cancellable),
                    tryRead(`/sys/class/thermal/${name}/temp`, cancellable),
                ]);
                return {name, type: (type ?? '').trim(), temp};
            }));
            const hwmons = await Promise.all(hwmonNames.map(name =>
                this._readHwmon(`/sys/class/hwmon/${name}`, cancellable)));
            const battery = await this._readBattery(powerNames.sort(), cancellable);

            this._temperatures = collectTemperatures(zones, hwmons);
            this._fans = collectFans(hwmons);
            this._voltages = collectVoltages(hwmons, battery?.voltageMicrovolts ?? null);
            this._battery = battery;
            this._thermalAt = GLib.get_monotonic_time() / 1000;

            const tempLimit = this._settings.get_uint('temp-alert-c');
            const hottest = this._temperatures[0]?.celsius;
            if (tempLimit > 0 && Number.isFinite(hottest) && hottest > tempLimit)
                this._maybeAlert('temp',
                    _('Temperature %.0f°C — throttle risk').replace('%.0f', iso(Math.round(hottest))));
        } catch (error) {
            console.warn(`procmon: thermal sensor refresh failed: ${error}`);
        } finally {
            this._thermalBusy = false;
        }
    }

    async _readHwmon(basePath, cancellable) {
        const [deviceText, tempNames, fanNames, voltNames] = await Promise.all([
            tryRead(`${basePath}/name`, cancellable),
            tryList(basePath, /^temp\d+_input$/, cancellable),
            tryList(basePath, /^fan\d+_input$/, cancellable),
            tryList(basePath, /^in\d+_input$/, cancellable),
        ]);
        const labelOf = async file => {
            const label = await tryRead(
                `${basePath}/${file.replace('_input', '_label')}`, cancellable);
            return (label ?? '').trim();
        };

        const [temps, fans, voltages] = await Promise.all([
            Promise.all(tempNames.map(async file => ({
                label: await labelOf(file),
                temp: await tryRead(`${basePath}/${file}`, cancellable),
            }))),
            Promise.all(fanNames.map(async file => ({
                label: await labelOf(file),
                rpm: await tryRead(`${basePath}/${file}`, cancellable),
            }))),
            Promise.all(voltNames.map(async file => ({
                label: await labelOf(file),
                millivolts: await tryRead(`${basePath}/${file}`, cancellable),
            }))),
        ]);

        return {
            device: (deviceText ?? '').trim() || basePath.split('/').pop(),
            temps,
            fans,
            voltages,
        };
    }

    async _readBattery(powerNames, cancellable) {
        for (const name of powerNames) {
            const basePath = `/sys/class/power_supply/${name}`;
            const [capacity, status, powerNow, energyNow, energyFull, chargeNow,
                chargeFull, voltageNow, currentNow] = await Promise.all([
                tryRead(`${basePath}/capacity`, cancellable),
                tryRead(`${basePath}/status`, cancellable),
                tryRead(`${basePath}/power_now`, cancellable),
                tryRead(`${basePath}/energy_now`, cancellable),
                tryRead(`${basePath}/energy_full`, cancellable),
                tryRead(`${basePath}/charge_now`, cancellable),
                tryRead(`${basePath}/charge_full`, cancellable),
                tryRead(`${basePath}/voltage_now`, cancellable),
                tryRead(`${basePath}/current_now`, cancellable),
            ]);
            const battery = parseBatteryDetails({
                capacity, status, powerNow, energyNow, energyFull,
                chargeNow, chargeFull, voltageNow, currentNow,
            });
            if (battery)
                return battery;
        }
        return null;
    }

    async _readCoreFrequencies() {
        const cpuNames = await tryList('/sys/devices/system/cpu', /^cpu\d+$/,
            this._cancellable);
        const reads = await Promise.all(cpuNames.map(name =>
            tryRead(`/sys/devices/system/cpu/${name}/cpufreq/scaling_cur_freq`,
                this._cancellable)));
        return reads
            .map(text => Number((text ?? '').trim()))
            .filter(khz => Number.isFinite(khz) && khz > 0);
    }

    async _readFilesystems() {
        const mounts = await tryRead('/proc/mounts', this._cancellable);
        if (!mounts)
            return [];

        const seen = new Set();
        const wanted = [];
        for (const line of mounts.split('\n')) {
            const [device, rawMountPoint, type] = line.split(/\s+/);
            if (!device || !rawMountPoint || !REAL_FILESYSTEMS.has(type))
                continue;
            const mountPoint = decodeMountPath(rawMountPoint);
            if (seen.has(mountPoint))
                continue;
            seen.add(mountPoint);
            wanted.push(mountPoint);
            if (wanted.length >= MAX_FILESYSTEMS)
                break;
        }
        const usages = await Promise.all(wanted.map(path =>
            queryFilesystemUsageAsync(path, this._cancellable)));
        return usages.filter(Boolean);
    }

    async _readGpus() {
        const cardNames = (await tryList('/sys/class/drm', /^card\d+$/, this._cancellable))
            .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))
            .slice(0, MAX_GPU_CARDS);

        const cards = await Promise.all(cardNames.map(async name => {
            const basePath = `/sys/class/drm/${name}/device`;
            const [vendorId, busy, used, total] = await Promise.all([
                tryRead(`${basePath}/vendor`, this._cancellable),
                tryRead(`${basePath}/gpu_busy_percent`, this._cancellable),
                tryRead(`${basePath}/mem_info_vram_used`, this._cancellable),
                tryRead(`${basePath}/mem_info_vram_total`, this._cancellable),
            ]);
            return parseGpuCard({vendorId, busy, vramUsed: used, vramTotal: total});
        }));
        return cards.filter(Boolean);
    }

    async _readPsi() {
        const texts = await Promise.all(PSI_RESOURCES.map(({resource}) =>
            tryRead(`/proc/pressure/${resource}`, this._cancellable)));
        const psi = {};
        for (let i = 0; i < PSI_RESOURCES.length; i++)
            psi[PSI_RESOURCES[i].resource] = parsePsi(texts[i]);
        return psi;
    }

    async _refreshMenuSensors() {
        const [uptimeText, loadText, frequencies, gpus, psi] =
            await Promise.all([
                tryRead('/proc/uptime', this._cancellable),
                tryRead('/proc/loadavg', this._cancellable),
                this._readCoreFrequencies(),
                this._readGpus(),
                this._readPsi(),
            ]);
        await this._refreshThermalSensors(true);

        this._sensors = {
            uptime: parseUptime(uptimeText),
            load: parseLoadAvg(loadText),
            frequencies,
            gpus,
            psi,
        };
    }

    // ----- process sampling ----------------------------------------------

    async _sampleProcesses(cancellable) {
        const pidNames = await tryList('/proc', /^\d+$/, cancellable);
        const pids = pidNames
            .map(Number)
            .filter(pid => Number.isInteger(pid) && pid >= MIN_PID);
        const entries = await Promise.all(pids.map(pid =>
            this._readProcess(pid, cancellable)));

        const processes = new Map();
        for (const entry of entries) {
            if (entry)
                processes.set(entry.pid, entry);
        }
        return processes;
    }

    async _readProcess(pid, cancellable) {
        const [statText, statusText] = await Promise.all([
            tryRead(`/proc/${pid}/stat`, cancellable),
            tryRead(`/proc/${pid}/status`, cancellable),
        ]);
        const stats = statText ? parseStatLine(statText) : null;
        if (!stats || !statusText)
            return null;
        return {
            ...stats,
            pid,
            rssKb: rssKbFromStatus(statusText),
            uid: uidFromStatus(statusText),
        };
    }

    // ----- menu lifecycle ------------------------------------------------

    _onMenuOpenChanged(isOpen) {
        if (!this.menu)
            return;
        if (isOpen) {
            this._ioCurrent = null;
            this._ioRates = null;
            this._rowsPopulated = false;
            this._quickSampled = false;
            this._acknowledgeAlerts();
            this._buildMenu();
            void this._sampleMenuData();
            this._scheduleIoWarmup();
            this._restartMenuTimer();
        } else {
            this._clearTimer('_menuTickId');
            this._clearTimer('_ioWarmupId');
        }
    }

    _scheduleIoWarmup() {
        this._clearTimer('_ioWarmupId');
        this._ioWarmupId = this._later(IO_WARMUP_MS, () => {
            if (this.menu.isOpen)
                void this._sampleIo();
        });
    }

    async _sampleMenuData() {
        if (this._destroyed || this._menuBusy || !this.menu.isOpen)
            return;
        this._menuBusy = true;
        try {
            const [processes, statText, memText] = await Promise.all([
                this._sampleProcesses(this._cancellable),
                tryRead('/proc/stat', this._cancellable),
                tryRead('/proc/meminfo', this._cancellable),
            ]);

            const ticks = parseCpuTicks(statText);
            if (ticks) {
                const current = {ticks, cores: parseCoreTicks(statText), processes};
                const previous = this._lastSample;
                this._lastSample = current;
                this._processes = processes;
                this._menuShares = {
                    cpu: previous ? computeCpuShares(previous, current) : new Map(),
                    cores: previous
                        ? computeCoreShares(previous.cores, current.cores) : new Map(),
                };
            }

            this._memory = parseMemInfo(memText) ?? this._memory;
            await this._refreshMenuSensors();
            await this._sampleIo();
            if (this.menu.isOpen)
                this._renderValues();

            // a second quick sample turns the first baseline into real rates
            if (!this._quickSampled && ticks) {
                this._quickSampled = true;
                this._later(FIRST_SAMPLE_MS, () => {
                    if (this.menu.isOpen)
                        void this._sampleMenuData();
                });
            }
        } catch (error) {
            // swallow cancellation / transient read failures
        } finally {
            this._menuBusy = false;
        }
    }

    async _sampleIo() {
        if (this._ioBusy)
            return;
        this._ioBusy = true;
        try {
            const [netText, diskText] = await Promise.all([
                tryRead('/proc/net/dev', this._cancellable),
                tryRead('/proc/diskstats', this._cancellable),
            ]);
            const current = {
                at: GLib.get_monotonic_time() / 1e6,
                net: netText ? parseNetDev(netText) : new Map(),
                disk: diskText ? parseDiskStats(diskText) : new Map(),
            };
            const previous = this._ioCurrent;
            this._ioCurrent = current;
            if (!previous)
                return;

            const seconds = current.at - previous.at;
            if (seconds > 0) {
                this._ioRates = {
                    net: computeNetRates(previous.net, current.net, seconds),
                    disk: computeDiskRates(previous.disk, current.disk, seconds),
                };
            }
            if (this.menu.isOpen && !this._destroyed)
                this._renderIo();
        } catch (error) {
            // the IO card is cosmetic; a transient read failure or a destroyed
            // actor must never surface as an unhandled rejection
            console.debug(`procmon: io sample failed: ${error}`);
        } finally {
            this._ioBusy = false;
        }
    }

    // ----- menu construction (once per open/settings change) --------------

    _buildMenu() {
        this.menu.removeAll();
        this._iconCache.clear();
        this._topRows = Math.max(1, this._settings.get_int('top-count'));

        const content = new St.BoxLayout({
            vertical: true,
            style_class: 'procmon-content',
        });
        this._ui = {};
                this._sparkArea = null;

        this._addHeader(content);
        if (this._settings.get_boolean('show-sparkline'))
            this._addSparkline(content);
        this._addSummaryCards(content);
        this._addOptionalSections(content);

        this._mountContent(content);
        this._renderValues();
    }

    // setting-driven tree: permanent heatmap, then collapsible groups
    _addOptionalSections(content) {
        const wants = id => this._wantsSection(id);
        const wantsProc = wants('processes');
        const groups = {};

        // signature view first: always visible, no collapse

        if (wantsProc)
            groups.procs = this._addGroup(content, _('Top processes'),
                {id: 'processes', icon: 'view-list-symbolic'});
        if (wants('memory'))
            groups.memory = this._addGroup(content, _('Memory'),
                {id: 'memory', icon: 'media-flash-symbolic'});

        const wantsSensors = wants('temperatures') || wants('fans') ||
            wants('voltages') || wants('battery');
        if (wantsSensors)
            groups.sensors = this._addGroup(content, _('Sensors'),
                {id: 'sensors', icon: 'temperature-symbolic'});

        if (wants('disk') || wants('network'))
            groups.storage = this._addGroup(content, _('Storage & network'),
                {id: 'storage', icon: 'drive-harddisk-symbolic'});

        if (wants('gpu'))
            groups.graphics = this._addGroup(content, _('Graphics'),
                {id: 'graphics', icon: 'video-display-symbolic'});

        // startup control is a first-class citizen, not a settings section
        groups.startup = this._addGroup(content, _('Startup'),
            {id: 'startup', icon: 'emblem-system-symbolic'});

        if (wants('psi'))
            groups.psi = this._addGroup(content, _('Pressure'),
                {id: 'psi', icon: 'speedometer-symbolic'});

        if (groups.procs)
            this._addTopCpuSection(groups.procs.box);
        if (groups.procs)
            this._addTopMemSection(groups.procs.box);
        if (groups.memory)
            this._addMemorySection(groups.memory.box);

        if (groups.sensors) {
            this._ui.temperature = this._addSection(groups.sensors.box, _('Temperature'),
                _('No temperature sensors'), {id: 'temperatures', level: 2});
            this._ui.fans = this._addSection(groups.sensors.box, _('Fans'),
                _('No fan sensors'), {id: 'fans', level: 2});
            this._ui.voltages = this._addSection(groups.sensors.box, _('Voltage'),
                _('No voltage sensors'), {id: 'voltages', level: 2});
            if (wants('battery'))
                this._ui.battery = this._addBatterySection(groups.sensors.box);
        }

        if (groups.storage && wants('network'))
            this._ui.network = this._addSection(groups.storage.box, _('Network'),
                _('No network interfaces'), {id: 'network', level: 2});
        if (groups.storage && wants('disk'))
            this._ui.filesystems = this._addSection(groups.storage.box, _('Disk usage'),
                _('No filesystems'), {id: 'disk', level: 2});

        if (groups.graphics)
            this._ui.graphics = this._addSection(groups.graphics.box, _('GPU'),
                _('No GPU sensors'), {id: 'graphics', level: 2});
        this._addStartupSection(groups.startup.box);
        if (groups.psi)
            this._ui.psi = this._addPsiSection(groups.psi.box);
    }

    // wraps the assembled content in the scroll item plus the static actions
    _mountContent(content) {
        const scroll = new St.ScrollView({
            style_class: 'procmon-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
        });
        scroll.set_child(content);
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'procmon-scroll-item',
        });
        item.add_child(scroll);
        this.menu.addMenuItem(item);

        const footerItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'procmon-scroll-item',
        });
        const footer = new St.BoxLayout({style_class: 'procmon-footer'});
        const openBtn = new St.Button({
            style_class: 'procmon-footer-btn',
            can_focus: true,
            x_expand: true,
        });
        const openRow = new St.BoxLayout({vertical: false});
        openRow.add_child(new St.Icon({
            icon_name: 'utilities-system-monitor-symbolic',
            style_class: 'procmon-footer-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        openRow.add_child(new St.Label({
            text: _('Open System Monitor'),
            style_class: 'procmon-footer-label',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        openBtn.set_child(openRow);
        openBtn.connect('clicked', () => {
            this.menu.close();
            this._openSystemMonitor();
        });
        footer.add_child(openBtn);

        const refreshBtn = new St.Button({
            style_class: 'procmon-footer-btn',
            can_focus: true,
            x_expand: true,
        });
        const refreshRow = new St.BoxLayout({vertical: false});
        refreshRow.add_child(new St.Icon({
            icon_name: 'view-refresh-symbolic',
            style_class: 'procmon-footer-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        refreshRow.add_child(new St.Label({
            text: _('Refresh'),
            style_class: 'procmon-footer-label',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        refreshBtn.set_child(refreshRow);
        // same rule as the section headers: consume the press so the popup
        // does not close, then refresh on idle
        refreshBtn.connect('button-press-event', () => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (!this._destroyed)
                    void this._sampleMenuData();
                return GLib.SOURCE_REMOVE;
            });
            return Clutter.EVENT_STOP;
        });
        footer.add_child(refreshBtn);

        footerItem.add_child(footer);
        this.menu.addMenuItem(footerItem);
    }

    _addHeader(content) {
        const header = new St.BoxLayout({style_class: 'procmon-header'});
        header.add_child(new St.Label({
            text: _('ProcMon'),
            style_class: 'procmon-title',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        header.add_child(new St.Widget({x_expand: true}));
        content.add_child(header);

        this._ui.meta = new St.Label({
            text: '',
            style_class: 'procmon-meta',
        });
        content.add_child(this._ui.meta);
    }

    _addSparkline(content) {
        const area = new St.DrawingArea({
            style_class: 'procmon-sparkline',
            width: SPARKLINE_WIDTH,
            height: SPARKLINE_HEIGHT,
        });
        area.connect('repaint', area => this._paintSparkline(area));
        this._sparkArea = area;
        content.add_child(area);
    }

    _addCard(cardsRow, titleText, valueClass) {
        const card = new St.BoxLayout({
            vertical: true,
            style_class: 'procmon-card',
            x_expand: true,
        });
        card.add_child(new St.Label({text: titleText, style_class: 'procmon-card-title'}));
        const value = new St.Label({
            text: '—',
            style_class: valueClass,
            y_align: Clutter.ActorAlign.CENTER,
        });
        card.add_child(value);
        const barBox = new St.BoxLayout({style_class: 'procmon-bar'});
        const fill = new St.Widget({style_class: 'procmon-bar-fill procmon-bar-fill-ok'});
        fill.style = 'width: 0px;';
        barBox.add_child(fill);
        card.add_child(barBox);
        cardsRow.add_child(card);
        return {card, value, fill, barBox};
    }

    _addSummaryCards(content) {
        const cardsRow = new St.BoxLayout({style_class: 'procmon-cards', x_expand: true});
        this._ui.cards = {
            cpu: this._addCard(cardsRow, _('Processor'), 'procmon-card-value'),
            mem: this._addCard(cardsRow, _('Memory'), 'procmon-card-value'),
            third: null,
            thirdKind: 'disk',
        };
        this._ensureThirdCard(cardsRow);
        content.add_child(cardsRow);
        this._ui.cardsRow = cardsRow;
    }

    _ensureThirdCard(cardsRow) {
        const kind = (this._sensors?.gpus?.length ?? 0) > 0 ? 'gpu' : 'disk';
        if (this._ui.cards.third && this._ui.cards.thirdKind === kind)
            return;
        if (this._ui.cards.third)
            this._ui.cards.third.card.destroy();
        this._ui.cards.third = kind === 'gpu'
            ? this._addCard(cardsRow, _('Graphics'), 'procmon-card-value procmon-value-compact')
            : this._addCard(cardsRow, _('Disk'), 'procmon-card-value procmon-value-compact');
        this._ui.cards.thirdKind = kind;
    }

    _addSection(content, titleText, hint, options = {}) {
        const id = options.id ?? titleText;
        const level = options.level ?? 1;
        const open = this._openSections.has(id);
        const sub = level === 2;

        const card = new St.BoxLayout({
            vertical: true,
            style_class: sub ? 'procmon-sub-card' : 'procmon-acc-card',
        });

        const headerRow = new St.BoxLayout({
            style_class: sub ? 'procmon-sub-header' : 'procmon-acc-header',
        });
        const title = new St.Label({
            text: titleText,
            style_class: sub ? 'procmon-sub-title' : 'procmon-acc-title',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const summary = new St.Label({
            text: '',
            style_class: sub ? 'procmon-sub-summary' : 'procmon-acc-summary',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const chevron = new St.Label({
            text: open ? '▾' : '▸',
            style_class: sub ? 'procmon-sub-chevron' : 'procmon-acc-chevron',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerRow.add_child(title);
        headerRow.add_child(new St.Widget({x_expand: true}));
        headerRow.add_child(summary);
        headerRow.add_child(chevron);

        const header = new St.Button({
            style_class: sub ? 'procmon-sub-header-btn' : 'procmon-acc-header-btn',
            can_focus: true,
            child: headerRow,
        });
        card.add_child(header);

        const box = new St.BoxLayout({
            vertical: true,
            style_class: sub ? 'procmon-sub-body' : 'procmon-acc-body',
        });
        const hintLabel = new St.Label({text: hint, style_class: 'procmon-hint'});
        box.add_child(hintLabel);
        if (!open)
            box.visible = false;
        card.add_child(box);

        const section = {
            id, box, lines: [], hintLabel, summary, open,
            header, chevron,
        };
        // A plain 'clicked' inside a non-reactive menu item bubbles to the
        // popup and closes it, which looked like the section vanishing.
        // Consume the press like the kill button does, then toggle on idle.
        header.connect('button-press-event', () => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (!this._destroyed)
                    this._toggleSection(section);
                return GLib.SOURCE_REMOVE;
            });
            return Clutter.EVENT_STOP;
        });
        content.add_child(card);
        return section;
    }

    _setSectionSummary(section, text) {
        if (section?.summary)
            section.summary.text = text;
    }

    _toggleSection(section) {
        const open = !section.open;
        section.open = open;
        section.chevron.text = open ? '▾' : '▸';
        if (open) {
            section.box.visible = true;
            section.box.opacity = 255;
            this._openSections.add(section.id);
            // fill the newly revealed body at once instead of showing a
            // half-painted section that only catches up on the next tick
            this._renderValues();
        } else {
            section.box.visible = false;
            this._openSections.delete(section.id);
        }
    }

    // ----- grouped navigation (level 1) -----------------------------------
    // A group is a collapsible container; the sections inside keep their own
    // headers and behaviour, so the renderers stay untouched.

    _addGroup(content, title, options = {}) {
        const id = options.id ?? title;
        const open = this._openSections.has(id);

        const card = new St.BoxLayout({vertical: true, style_class: 'procmon-group'});
        const headerRow = new St.BoxLayout({style_class: 'procmon-group-header'});
        if (options.icon)
            headerRow.add_child(new St.Icon({
                icon_name: options.icon,
                style_class: 'procmon-group-icon',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        headerRow.add_child(new St.Label({
            text: title,
            style_class: 'procmon-group-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const summary = new St.Label({
            text: '',
            style_class: 'procmon-group-summary',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerRow.add_child(summary);
        const chevron = new St.Label({
            text: open ? '▾' : '▸',
            style_class: 'procmon-group-chevron',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerRow.add_child(chevron);

        const header = new St.Button({
            style_class: 'procmon-group-header-btn',
            can_focus: true,
            child: headerRow,
        });
        card.add_child(header);

        const box = new St.BoxLayout({vertical: true, style_class: 'procmon-group-body'});
        box.visible = open;
        card.add_child(box);

        const group = {id, box, header, summary, chevron, open};
        header.connect('button-press-event', () => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (!this._destroyed)
                    this._toggleGroup(group);
                return GLib.SOURCE_REMOVE;
            });
            return Clutter.EVENT_STOP;
        });
        content.add_child(card);
        return group;
    }

    _toggleGroup(group) {
        group.open = !group.open;
        group.chevron.text = group.open ? '▾' : '▸';
        group.box.visible = group.open;
        if (group.open) {
            this._openSections.add(group.id);
            this._renderValues();
        } else {
            this._openSections.delete(group.id);
        }
    }

    // ----- startup apps & user services ---------------------------------

    _autostartDirs() {
        return [
            [`${GLib.get_home_dir()}/.config/autostart`, 'user'],
            ['/etc/xdg/autostart', 'system'],
        ];
    }

    _readAutostartEntries() {
        const entries = [];
        const seen = new Set();
        for (const [dir, origin] of this._autostartDirs()) {
            const file = Gio.File.new_for_path(dir);
            if (!file.query_exists(null))
                continue;
            let en;
            try {
                en = file.enumerate_children('standard::name',
                    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            } catch (error) {
                continue;
            }
            let info;
            while ((info = en.next_file(null))) {
                const name = info.get_name();
                if (!name.endsWith('.desktop') || seen.has(name))
                    continue;
                seen.add(name); // a user override shadows the system entry
                const path = `${dir}/${name}`;
                const [ok, text] = GLib.file_get_contents(path);
                if (!ok)
                    continue;
                const str = new TextDecoder().decode(text);
                const m = /^Name=(.*)$/m.exec(str);
                const hidden = /^Hidden=true$/m.test(str);
                entries.push({file: name, name: m ? m[1].trim() : name,
                    origin, hidden});
            }
            en.close(null);
        }
        return entries.sort((a, b) => a.name.localeCompare(b.name));
    }

    _makeToggleButton(active) {
        const btn = new St.Button({
            style_class: 'procmon-toggle',
            can_focus: true,
            child: new St.Label({
                text: active ? _('On') : _('Off'),
                style_class: 'procmon-toggle-label',
                y_align: Clutter.ActorAlign.CENTER,
            }),
        });
        this._syncToggleButton(btn, active);
        return btn;
    }

    _syncToggleButton(btn, active) {
        btn.child.text = active ? _('On') : _('Off');
        btn.remove_style_class_name('procmon-toggle-on');
        btn.remove_style_class_name('procmon-toggle-off');
        btn.add_style_class_name(active ? 'procmon-toggle-on' : 'procmon-toggle-off');
    }

    _makeStartupRow(entry) {
        const row = new St.BoxLayout({style_class: 'procmon-line', x_expand: true});
        const name = new St.Label({
            text: entry.name,
            style_class: 'procmon-line-name',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(name);
        const source = new St.Label({
            text: entry.origin === 'user' ? _('user') : _('system'),
            style_class: 'procmon-startup-src',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(source);
        const btn = this._makeToggleButton(!entry.hidden);
        btn.connect('button-press-event', () => {
            const active = this._toggleAutostart(entry);
            this._syncToggleButton(btn, active);
            return Clutter.EVENT_STOP;
        });
        row.add_child(btn);
        return row;
    }

    _toggleAutostart(entry) {
        const [userDir] = this._autostartDirs()[0];
        const userPath = `${userDir}/${entry.file}`;
        try {
            if (entry.hidden) {
                // enable: either clear the user override or unhide the user file
                if (entry.origin === 'user') {
                    const [ok, text] = GLib.file_get_contents(userPath);
                    if (ok)
                        GLib.file_set_contents(userPath,
                            new TextDecoder().decode(text)
                                .replace(/^Hidden=.*$/m, 'Hidden=false'));
                } else {
                    const override = Gio.File.new_for_path(userPath);
                    if (override.query_exists(null))
                        GLib.file_delete(userPath);
                }
            } else {
                // disable: a same-name user entry with Hidden=true shadows it
                GLib.mkdir_with_parents(userDir, 0o755);
                GLib.file_set_contents(userPath, '[Desktop Entry]\nHidden=true\n');
            }
            entry.hidden = !entry.hidden;
        } catch (error) {
            console.warn(`procmon: autostart toggle: ${error}`);
        }
        return !entry.hidden;
    }

    _runSystemctl(args) {
        return new Promise(resolve => {
            try {
                const proc = Gio.Subprocess.new(
                    ['systemctl', '--user', ...args, '--no-pager'],
                    Gio.SubprocessFlags.STDOUT_PIPE |
                        Gio.SubprocessFlags.STDERR_SILENCE);
                proc.communicate_utf8_async(null, null, (source, result) => {
                    try {
                        const [, stdout] = source.communicate_utf8_finish(result);
                        resolve(stdout.split('\n').map(l => l.trim()).filter(Boolean));
                    } catch (error) {
                        resolve([]);
                    }
                });
            } catch (error) {
                resolve([]);
            }
        });
    }

    _addStartupSection(box) {
        const apps = this._addSection(box, _('Autostart apps'), _('No entries'),
            {id: 'startup-apps', level: 2});
        const entries = this._readAutostartEntries();
        for (const entry of entries)
            apps.box.add_child(this._makeStartupRow(entry));
        apps.hintLabel.visible = entries.length === 0;

        const services = this._addSection(box, _('User services'), _('Loading…'),
            {id: 'startup-services', level: 2});
        void this._fillServices(services);
    }

    async _fillServices(section) {
        const lines = await this._runSystemctl(['list-unit-files', '--type=service']);
        const units = [];
        for (const line of lines) {
            const parts = line.split(/\s+/);
            if (parts.length < 2 || !parts[0].endsWith('.service'))
                continue;
            const state = parts[1];
            if (state === 'static' || state === 'generated')
                continue;
            units.push({unit: parts[0], enabled: state === 'enabled'});
        }
        units.sort((a, b) => Number(b.enabled) - Number(a.enabled));
        if (units.length === 0) {
            section.hintLabel.text = _('No user services');
            section.hintLabel.visible = true;
            return;
        }
        section.hintLabel.visible = false;
        for (const unit of units) {
            const row = new St.BoxLayout({style_class: 'procmon-line', x_expand: true});
            const name = new St.Label({
                text: unit.unit,
                style_class: 'procmon-line-name',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            row.add_child(name);
            const btn = this._makeToggleButton(unit.enabled);
            btn.connect('button-press-event', () => {
                const target = !unit.enabled;
                void this._runSystemctl([target ? 'enable' : 'disable', unit.unit])
                    .then(() => {
                        unit.enabled = target;
                        this._syncToggleButton(btn, target);
                    });
                return Clutter.EVENT_STOP;
            });
            row.add_child(btn);
            section.box.add_child(row);
        }
    }

    _makeLineRow(box) {
        const row = new St.BoxLayout({style_class: 'procmon-line', x_expand: true});
        const name = new St.Label({
            text: '',
            style_class: 'procmon-line-name',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const value = new St.Label({
            text: '',
            style_class: 'procmon-line-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(name);
        row.add_child(value);
        box.add_child(row);
        return {row, name, value};
    }

    // grows or shrinks a line list to `wanted` entries without rebuilding rows
    _ensureLines(section, wanted) {
        while (section.lines.length < wanted)
            section.lines.push(this._makeLineRow(section.box));
        for (const entry of section.lines.slice(wanted))
            entry.row.destroy();
        section.lines.length = wanted;
        section.hintLabel.visible = wanted === 0;
    }

    _addTopCpuSection(box) {
        const section = this._addSection(box, _('Top CPU'),
            _('No process data yet'), {id: 'top-cpu', level: 2});
        this._ui.processSection = section;
        this._ui.processRows = this._ui.processRows ?? {};
        this._ui.processRows.byCpu = this._makeProcessRows(section.box);
    }

    _addTopMemSection(box) {
        const section = this._addSection(box, _('Top memory'),
            _('No process data yet'), {id: 'top-mem', level: 2});
        this._ui.processRows = this._ui.processRows ?? {};
        this._ui.processRows.byRam = this._makeProcessRows(section.box);
    }

    _makeProcessRows(box) {
        const rows = [];
        for (let i = 0; i < this._topRows; i++) {
            const row = new St.BoxLayout({
                style_class: 'procmon-row',
                x_expand: true,
                can_focus: true,
            });
            box.add_child(row);

            const icon = new St.Icon({
                icon_name: FALLBACK_PROCESS_ICON,
                style_class: 'procmon-row-icon',
                y_align: Clutter.ActorAlign.CENTER,
            });
            row.add_child(icon);
            const name = new St.Label({
                text: '',
                style_class: 'procmon-row-name',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            row.add_child(name);
            const count = new St.Label({
                text: '',
                style_class: 'procmon-group-count',
                y_align: Clutter.ActorAlign.CENTER,
            });
            row.add_child(count);
            const value = new St.Label({
                text: '',
                style_class: 'procmon-row-value',
                y_align: Clutter.ActorAlign.CENTER,
            });
            value.x_align = Clutter.ActorAlign.END;
            row.add_child(value);
            const kill = new St.Button({
                style_class: 'procmon-kill',
                can_focus: true,
                child: new St.Label({
                    text: '×',
                    style_class: 'procmon-kill-label',
                    y_align: Clutter.ActorAlign.CENTER,
                }),
            });
            kill.connect('button-press-event', (actor, event) => {
                const group = rows[i].entry;
                const button = event.get_button();
                if (group) {
                    const idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        this._timeouts.delete(idleId);
                        if (this.menu && !this._destroyed)
                            this._onKillRequest(group, button === 3 ? 'KILL' : 'TERM');
                        return GLib.SOURCE_REMOVE;
                    });
                    this._timeouts.add(idleId);
                }
                return Clutter.EVENT_STOP;
            });
            row.add_child(kill);

            rows[i] = {row, icon, name, count, value, kill, entry: null};
        }
        return rows;
    }

    _addMemorySection(content) {
        const section = this._addSection(content, _('Usage'), _('No data'),
            {id: 'memory-usage', level: 2});
        const rows = {
            used: this._makeLineRow(section.box),
            available: this._makeLineRow(section.box),
            cached: this._makeLineRow(section.box),
            buffers: this._makeLineRow(section.box),
            swap: this._makeLineRow(section.box),
        };
        this._ui.memory = {section, rows};
    }

    _addBatterySection(content) {
        const section = this._addSection(content, _('Battery'), _('No battery'),
            {id: 'battery', level: 2});
        const rows = {
            level: this._makeLineRow(section.box),
            power: this._makeLineRow(section.box),
            left: this._makeLineRow(section.box),
        };
        return {box: section.box, hintLabel: section.hintLabel, rows,
            summary: section.summary, id: section.id, open: section.open};
    }

    _addPsiSection(content) {
        const section = this._addSection(content, _('Pressure'),
            _('Pressure data unavailable'), {id: 'psi', level: 2});
        const rows = PSI_RESOURCES.map(() => this._makeLineRow(section.box));
        return {box: section.box, hintLabel: section.hintLabel, rows,
            summary: section.summary, id: section.id, open: section.open};
    }

    // ----- in-place painting ----------------------------------------------

    _renderValues() {
        if (!this.menu.isOpen)
            return;
        this._ensureThirdCard(this._ui.cardsRow);
        this._renderMeta();
        this._renderSummaryCards();
        this._renderProcessRows();
        this._renderMemorySection();
        this._renderLineSection(this._ui.temperature, (this._temperatures ?? [])
            .slice(0, MAX_TEMPERATURES), reading => [
            reading.label,
            `${iso(Math.round(reading.celsius))}°C`,
        ]);
        this._renderLineSection(this._ui.fans, this._fans ?? [], reading => [
            reading.label,
            `${iso(reading.rpm)} rpm`,
        ]);
        this._renderLineSection(this._ui.voltages, this._voltages ?? [], reading => [
            reading.label === 'battery' ? _('Battery') : reading.label,
            `${iso(reading.volts.toFixed(2))} V`,
        ]);
        this._renderBatterySection();
        this._renderIo();
        this._renderLineSection(this._ui.filesystems,
            (this._fsData ?? []).slice(0, MAX_FILESYSTEMS), filesystem => [
                filesystem.mountPoint,
                `(${iso(filesystem.percent)}%) ${iso(formatBytes(filesystem.usedBytes))} / ${
                    iso(formatBytes(filesystem.totalBytes))}`,
            ]);
        this._renderGraphics();
        this._renderPsi();
        this._renderSectionSummaries();
    }

    _renderMeta() {
        const sensors = this._sensors ?? {};
        const parts = [];
        if (Number.isFinite(sensors.uptime))
            parts.push(_('Up %s').format(iso(formatDuration(sensors.uptime) ?? '—')));
        if (sensors.load)
            parts.push(_('Load %s').format(iso(sensors.load.one.toFixed(2))));
        const count = this._processes.size;
        parts.push(_n('%s process', '%s processes', count).format(iso(count)));
        const coreCount = this._lastSample?.cores?.size ?? 0;
        if (coreCount > 0)
            parts.push(_('Cores %s').format(iso(coreCount)));
        this._ui.meta.text = parts.join(' · ');
    }

    _renderSummaryCards() {
        const cards = this._ui.cards;
        cards.cpu.value.text = `${iso(Math.round(this._cpuPercent))}%`;
        this._setBar(cards.cpu, this._cpuPercent);

        const memory = this._memory;
        if (memory && memory.totalMb > 0) {
            const percent = percentOf(memory.usedMb, memory.totalMb);
            cards.mem.value.text = `${iso(Math.round(percent))}%`;
            this._setBar(cards.mem, percent);
        } else {
            cards.mem.value.text = _('No data');
            this._setBar(cards.mem, 0);
        }

        const third = cards.third;
        if (cards.thirdKind === 'gpu') {
            const gpu = (this._sensors?.gpus ?? [])[0];
            if (gpu && gpu.usagePercent !== null) {
                third.value.text = `${iso(gpu.usagePercent)}%`;
                this._setBar(third, gpu.usagePercent);
            } else {
                third.value.text = '—';
                this._setBar(third, 0);
            }
        } else {
            const rates = this._ioRates?.disk;
            third.value.text = rates
                ? `${_('↓ %s · ↑ %s').format(iso(formatRate(rates.readPerSecond)),
                    iso(formatRate(rates.writePerSecond)))}`
                : _('No data');
        }
    }

    _renderSectionSummaries() {
        const ui = this._ui;
        // Processor
        if (ui.cpu)
            this._setSectionSummary(ui.cpu, `${iso(Math.round(this._cpuPercent))}%`);

        // Memory
        const memory = this._memory;
        if (ui.memory?.section && memory && memory.totalMb > 0) {
            const usedGb = memory.usedMb / 1024;
            const totalGb = memory.totalMb / 1024;
            this._setSectionSummary(ui.memory.section,
                `${iso(usedGb.toFixed(1))}/${iso(totalGb.toFixed(0))} GB`);
        }

        // Temperature: hottest sensor
        const temps = this._temperatures ?? [];
        if (ui.temperature && temps.length > 0) {
            const hottest = Math.max(...temps.map(t => t.celsius));
            this._setSectionSummary(ui.temperature, `${iso(Math.round(hottest))}°C`);
        }

        // Network: total down/up, computeNetRates() returns [
        // {name, rxPerSecond, txPerSecond}] sorted by activity
        const netRates = this._ioRates?.net ?? [];
        if (ui.network && netRates.length > 0) {
            const rx = netRates.reduce((sum, rate) => sum + (rate.rxPerSecond ?? 0), 0);
            const tx = netRates.reduce((sum, rate) => sum + (rate.txPerSecond ?? 0), 0);
            this._setSectionSummary(ui.network,
                `${_('↓ %s · ↑ %s').format(iso(formatRate(rx)), iso(formatRate(tx)))}`);
        } else if (ui.network) {
            this._setSectionSummary(ui.network, '');
        }

        // Disk: first fs percent
        const fs = (this._fsData ?? [])[0];
        if (ui.filesystems && fs)
            this._setSectionSummary(ui.filesystems, `${iso(Math.round(fs.percent))}%`);

        const gpu = (this._sensors?.gpus ?? [])[0];
        if (ui.graphics && gpu && gpu.usagePercent !== null)
            this._setSectionSummary(ui.graphics, `${iso(gpu.usagePercent)}%`);
    }

    _setBar(card, percent) {
        const allocation = card.barBox.allocation;
        const width = allocation ? allocation.x2 - allocation.x1 : 0;
        const pixels = width > 4 ? Math.max(2, Math.round(width * percent / 100)) : 0;
        card.fill.style = `width: ${pixels}px;`;
        const state = percent >= 85 ? 'crit' : percent >= 60 ? 'warn' : 'ok';
        card.fill.remove_style_class_name('procmon-bar-fill-ok');
        card.fill.remove_style_class_name('procmon-bar-fill-warn');
        card.fill.remove_style_class_name('procmon-bar-fill-crit');
        card.fill.add_style_class_name(`procmon-bar-fill-${state}`);
    }

    _renderIo() {
        const cards = this._ui.cards;
        if (cards.thirdKind === 'disk') {
            const rates = this._ioRates?.disk;
            cards.third.value.text = rates
                ? `${_('↓ %s · ↑ %s').format(iso(formatRate(rates.readPerSecond)),
                    iso(formatRate(rates.writePerSecond)))}`
                : _('No data');
        }
        const section = this._ui.network;
        if (!section)
            return;
        const interfaces = [...(this._ioCurrent?.net.keys() ?? [])];
        this._ensureLines(section, interfaces.length);
        const ratesByName = new Map((this._ioRates?.net ?? [])
            .map(rate => [rate.name, rate]));
        interfaces.forEach((name, index) => {
            const entry = section.lines[index];
            const rate = ratesByName.get(name);
            entry.name.text = name;
            entry.value.text = rate
                ? `${_('↓ %s · ↑ %s').format(iso(formatRate(rate.rxPerSecond)),
                    iso(formatRate(rate.txPerSecond)))}`
                : _('No sample');
        });
    }

    _renderProcessRows() {
        const rows = this._ui.processRows;
        if (!rows)
            return;
        // while the pointer rests on the menu, rows stay put so clicks land
        if (this._rowsPopulated && this._pointerInsideMenu())
            return;

        const shares = this._menuShares;
        const processes = this._processes ?? new Map();
        const entries = [...processes.values()]
            .map(entry => ({...entry, cpu: shares?.cpu.get(entry.pid) ?? 0}));
        // both lists are cut independently from the full sample; clipping the
        // cpu list first would drop RAM-heavy groups out of the RAM view
        const {groups: cpuList} = groupProcesses(entries, this._topRows);
        const {groups: ramList} = groupProcesses(entries, this._topRows, 'rss');

        this._paintProcessRows(rows.byCpu, cpuList,
            group => `${iso(group.cpuSum.toFixed(1))}%`, group => group.cpuSum > 50);
        this._paintProcessRows(rows.byRam, ramList,
            group => `${iso(Math.round(group.rssKbSum / 1024))} MB`, () => false);
        if (this._ui.processSection)
            this._ui.processSection.hintLabel.visible = entries.length === 0;
        this._rowsPopulated = true;
    }

    _paintProcessRows(rows, entries, valueFor, highlightFor) {
        if (entries.length !== rows.length)
            this._syncRowsVisibility(rows, entries.length);
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const group = entries[i];
            if (!group) {
                row.row.visible = false;
                row.entry = null;
                continue;
            }
            row.row.visible = true;
            // keyed by name+count so a rebuilt pid array never churns the row;
            // text/icon/value/count repaint in place, no rebuild needed
            if (row.entry?.name !== group.name || row.entry?.count !== group.count) {
                row.name.text = group.name;
                row.kill.accessible_name = _n('Terminate %s (%d process)',
                    'Terminate %s (%d processes)',
                    group.count).format(group.name, iso(group.count));
                this._setRowIcon(row, group);
            }
            row.value.text = valueFor(group);
            row.count.text = group.count > 1 ? `×${iso(group.count)}` : '';
            // an empty pill is chrome noise: hide the badge entirely for
            // single-process rows instead of leaving a blank capsule
            row.count.visible = group.count > 1;
            row.value.style_class = highlightFor(group)
                ? 'procmon-row-value procmon-row-value-high'
                : 'procmon-row-value';
            row.entry = group;
        }
    }

    _syncRowsVisibility(rows, expected) {
        for (let i = 0; i < rows.length; i++) {
            if (i < expected)
                continue;
            rows[i].row.visible = false;
            rows[i].entry = null;
        }
    }

    _setRowIcon(row, group) {
        if (row.icon.forProcessName === group.name)
            return;
        row.icon.forProcessName = group.name;
        // every row keeps an icon slot; an unresolved app icon must not leave
        // a hole that makes the name look indented differently
        row.icon.gicon = this._iconForGroup(group) ??
            Gio.ThemedIcon.new(FALLBACK_PROCESS_ICON);
    }

    _iconForGroup(group) {
        const key = group.name;
        if (!this._iconCache.has(key)) {
            const appSystem = Shell.AppSystem.get_default();
            let gicon = null;
            for (const app of appSystem.get_running()) {
                if (group.pids.some(pid => app.get_pids().includes(pid))) {
                    gicon = app.get_app_info()?.get_icon() ?? null;
                    break;
                }
            }
            if (!gicon) {
                const app = appSystem.lookup_app(`${key}.desktop`) ??
                    appSystem.lookup_startup_wmclass(key);
                gicon = app?.get_app_info()?.get_icon() ?? null;
            }
            this._iconCache.set(key, gicon);
        }
        return this._iconCache.get(key) ?? null;
    }

    _renderGraphics() {
        const section = this._ui.graphics;
        if (!section)
            return;
        const cards = this._sensors?.gpus ?? [];
        this._ensureLines(section, cards.length);
        cards.forEach((card, index) => {
            const entry = section.lines[index];
            const pieces = [];
            if (card.usagePercent !== null)
                pieces.push(`${iso(card.usagePercent)}%`);
            if (card.vramTotalBytes > 0 && card.vramUsedBytes !== null) {
                pieces.push(_('VRAM %s / %s').format(iso(formatBytes(card.vramUsedBytes)),
                    iso(formatBytes(card.vramTotalBytes))));
            }
            entry.name.text = card.vendor;
            entry.value.text = pieces.join(' · ') || '—';
        });
    }

    _renderPsi() {
        const ui = this._ui.psi;
        if (!ui)
            return;
        const psi = this._sensors?.psi ?? {};
        ui.hintLabel.visible = PSI_RESOURCES.every(({resource}) => !psi[resource]);
        PSI_RESOURCES.forEach((info, index) => {
            const row = ui.rows[index];
            const value = psi[info.resource];
            row.row.visible = Boolean(value);
            if (!value)
                return;
            const pieces = [_('some %s').format(iso(value.some.avg10.toFixed(2)))];
            if (value.full)
                pieces.push(_('full %s').format(iso(value.full.avg10.toFixed(2))));
            row.name.text = info.title();
            row.value.text = pieces.join(' · ');
        });
    }

    // ----- pointer gate ---------------------------------------------------

    _menuRect() {
        const widget = this.menu.widget;
        if (!widget)
            return null;
        const extents = widget.get_transformed_extents();
        const rect = {
            x: extents.get_x(),
            y: extents.get_y(),
            width: extents.get_width(),
            height: extents.get_height(),
        };
        return isFiniteRect(rect) ? rect : null;
    }

    _pointerInsideMenu() {
        const rect = this._menuRect();
        if (!rect)
            return false;
        const cursor = getPointer();
        const [pointerX, pointerY] = Array.isArray(cursor)
            ? cursor
            : (typeof cursor?.get_position === 'function'
                ? [cursor.get_position()?.x, cursor.get_position()?.y]
                : [null, null]);
        if (pointerX === null || pointerY === null)
            return false;
        return isPointInsideRect(pointerX, pointerY, rect);
    }

    // ----- killing --------------------------------------------------------

    // identities must be known before any kill is even discussed; the single
    // message covers all attempts until bootstrap succeeds
    _onKillRequest(group, signal) {
        if (!group)
            return;
        if (!(this._currentUid >= 0)) {
            Main.notify('ProcMon', _('Unknown user identity — termination disabled'));
            return;
        }
        if (this._settings.get_boolean('kill-confirmation'))
            this._confirmKill(group, signal);
        else
            void this._executeGroupKill(group, signal);
    }

    _confirmKill(group, signal) {
        const dialog = new ModalDialog.ModalDialog();

        // the dialog quotes only the pids we are actually allowed to signal
        const count = iso(this._ownedCount(group));
        const body = new St.BoxLayout({
            vertical: true,
            style_class: 'procmon-dialog',
        });
        body.add_child(new St.Label({
            text: signal === 'KILL'
                ? _('Send SIGKILL to “%s” (%s processes)?').format(group.name, count)
                : _('Send SIGTERM to “%s” (%s processes)?').format(group.name, count),
            style_class: 'procmon-dialog-text',
        }));
        dialog.contentLayout.add_child(body);
        dialog.addButton({label: _('Cancel'), action: () => dialog.close(),
            key: Clutter.KEY_Escape});
        dialog.addButton({
            label: signal === 'KILL' ? _('Force kill') : _('Terminate'),
            action: () => {
                // ModalDialog does not close itself when a button fires, and
                // its grab would keep the whole shell pointer-inert
                dialog.close();
                void this._executeGroupKill(group, signal);
            },
        });
        dialog.open();
    }

    // owned pids only, via the unified lib filter; a one-uid group shortcut
    _ownedCount(group) {
        if (group.uidSet.size === 1 && group.uidSet.has(this._currentUid))
            return group.count;
        return ownedProcessEntries(
            group.pids.map(pid => this._processes.get(pid)).filter(Boolean),
            this._currentUid).length;
    }

    // each candidate gets one fresh read pair; the pure lib verdict decides
    // and `null` covers protected pids (kernel/own) owned by the caller side
    async _assessTargetProcess(pid, expectedStartTime) {
        if (!Number.isInteger(pid) || pid <= 2 || pid === this._ownPid)
            return null;
        let [statusText, statText] = await Promise.all([
            tryRead(`/proc/${pid}/status`, this._cancellable),
            tryRead(`/proc/${pid}/stat`, this._cancellable),
        ]);
        if (statText === null)
            statText = readProcSync(pid, 'stat');
        if (statusText === null)
            statusText = readProcSync(pid, 'status');
        const stats = statText ? parseStatLine(statText) : null;
        if (!stats || !statusText)
            return {verdict: {canKill: false, reason: 'zombie-or-exited'},
                startTime: null};
        const uid = uidFromStatus(statusText);
        // without a prior sample the fresh start time is the only identity we
        // have; the recheck passes the first read's value so pid reuse stays
        // caught between assessment and signaling
        const expected = expectedStartTime !== undefined
            ? expectedStartTime
            : (this._processes.get(pid)?.startTime ?? stats.startTime);
        return {
            pid,
            verdict: assessKillProcess({
                pid,
                uid,
                ownUid: this._currentUid,
                startTime: stats.startTime,
                expectedStartTimeTicks: expected,
                state: stats.state,
            }),
            startTime: stats.startTime,
        };
    }

    async _executeGroupKill(group, signal) {
        const problems = new Set();
        const candidates = [];
        for (const pid of group.pids) {
            const check = await this._assessTargetProcess(pid);
            if (!check) {
                problems.add(_('Protected process'));
                continue;
            }
            if (check.verdict.canKill)
                candidates.push(check);
            else
                problems.add(KILL_PROBLEM_TEXT(check.verdict.reason));
        }

        if (candidates.length === 0) {
            Main.notify(_('Could not terminate %s').format(group.name),
                problems.values().next().value ?? _('Process exited'));
            return;
        }

        // TOCTOU guard: every pid is re-read and re-assessed immediately
        // before signaling, so a reused pid never receives our signal
        const targets = [];
        const failures = [];
        for (const candidate of candidates) {
            const recheck = await this._assessTargetProcess(candidate.pid,
                candidate.startTime);
            if (!recheck || !recheck.verdict.canKill) {
                if (recheck)
                    problems.add(KILL_PROBLEM_TEXT(recheck.verdict.reason));
                continue;
            }
            targets.push({pid: candidate.pid, startTime: recheck.startTime});
            const failure = await sendSignalAsync(candidate.pid, signal);
            if (failure)
                failures.push(failure);
        }

        if (targets.length === 0) {
            Main.notify(_('Could not terminate %s').format(group.name),
                problems.values().next().value ?? _('Process exited'));
            return;
        }

        // one signal per process, sequential; one aggregated failure notice
        if (failures.length > 0) {
            Main.notify(_('Could not terminate %s').format(group.name),
                _n('%s process not signaled', '%s processes not signaled',
                    failures.length).format(iso(failures.length)));
        }

        this._scheduleExitCheck(group, targets);
    }

    _scheduleExitCheck(group, targets) {
        this._clearTimer('_exitCheckId');
        this._exitCheckId = this._later(EXIT_CHECK_MS, () =>
            void this._verifyGroupKill(group, targets));
    }

    async _verifyGroupKill(group, targets) {
        const stillRunning = [];
        for (const target of targets) {
            const statText = await tryRead(`/proc/${target.pid}/stat`, this._cancellable);
            const current = statText ? parseStatLine(statText) : null;
            if (current && current.startTime === target.startTime && current.state !== 'Z')
                stillRunning.push(target.pid);
        }
        if (stillRunning.length > 0) {
            Main.notify(_('Did not terminate'),
                _n('%s process is still running', '%s processes are still running',
                    stillRunning.length).format(iso(stillRunning.length)));
        }
        if (this.menu.isOpen)
            void this._sampleMenuData();
    }

    // ----- actions --------------------------------------------------------

    // the AppSystem launch is the single path; no second spawn fallback
    _openSystemMonitor() {
        const appSystem = Shell.AppSystem.get_default();
        let app = appSystem.lookup_app('org.gnome.SystemMonitor.desktop')
            || appSystem.lookup_app('gnome-system-monitor.desktop');
        if (app) {
            app.launch(0, -1, Shell.AppLaunchGpu.APP_PREF);
            return;
        }
        // last resort: spawn gnome-system-monitor binary directly
        try {
            GLib.spawn_command_line_async('gnome-system-monitor');
            return;
        } catch (e) {
            // fall through to notification
        }
        Main.notify('ProcMon', _('Could not open System Monitor'));
    }

    destroy() {
        this._destroyed = true;
        this._stopAllTimers();
        this._cancellable.cancel();
        if (this._settingsSignalId) {
            this._settings.disconnect(this._settingsSignalId);
            this._settingsSignalId = 0;
        }
        if (this._menuSignalId) {
            this.menu?.disconnect(this._menuSignalId);
            this._menuSignalId = 0;
        }
        super.destroy();
    }
});

export default class ProcmonExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new ProcMonIndicator(this._settings);
        Main.panel.addToStatusArea('procmon', this._indicator, 0, 'right');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
