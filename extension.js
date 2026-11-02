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
import {assessKillProcess, alertDecision, averageFrequencyGhz, collectFans, collectTemperatures,
    collectVoltages, computeCoreShares, computeCpuShares, computeDiskRates,
    computeNetRates, formatBytes, formatDuration, formatRate, groupProcesses,
    isFiniteRect, isPointInsideRect, ownedProcessEntries, parseBatteryDetails,
    parseCoreTicks, parseCpuTicks, parseDiskStats, parseGpuCard, parseLoadAvg,
    parseMemInfo, parseNetDev, parsePsi, parseStatLine, parseUptime} from './lib/proc.js';
import * as sparkline from './ui/sparkline.js';
import * as cards from './ui/cards.js';
import * as sections from './ui/sections.js';
import * as rows from './ui/rows.js';
import * as startup from './ui/startup.js';
import * as renderers from './ui/renderers.js';

import {_, _n, iso, FIRST_SAMPLE_MS, IO_WARMUP_MS, EXIT_CHECK_MS,
    TEMPERATURE_CACHE_MS, ALERT_COOLDOWN_MS, SPARK_SAMPLES, SPARKLINE_WIDTH,
    SPARKLINE_HEIGHT,
    MAX_TEMPERATURES, MAX_FILESYSTEMS, MAX_GPU_CARDS, MIN_PID, ENUMERATE_BATCH,
    FALLBACK_PROCESS_ICON, PSI_RESOURCES, BATTERY_STATUS_TEXT, percentOf} from './ui/constants.js';

const SHELL_MAJOR = Number.parseInt(String(Config.PACKAGE_VERSION ?? ''), 10) || 0;
// wrap arrived on StBoxLayout with newer shells; sliced rows stay for older ones.
const BOX_WRAP_SUPPORTED = SHELL_MAJOR >= 48;

const REAL_FILESYSTEMS = new Set(['ext2', 'ext3', 'ext4', 'btrfs', 'xfs', 'f2fs', 'vfat',
    'exfat', 'ntfs', 'ntfs3', 'fuseblk', 'zfs']);

const decodeMountPath = path => path.replace(/\\([0-7]{3})/g, (_match, octal) =>
    String.fromCharCode(parseInt(octal, 8)));

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
        this._sparkValue = null;
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

            if (this._sparkValue)
                this._sparkValue.text = `${iso(Math.round(this._cpuPercent))}% CPU · ${iso(this._memory ? Math.round(percentOf(this._memory.usedMb, this._memory.totalMb)) : 0)}% RAM`;

            void this._refreshThermalSensors();
            this._updatePanelLabel();
            this._recordSparkSample();
            this._maybeMemoryAlert();
            void this._refreshDiskUsage();
            if (this.menu.isOpen)
                this._renderSummaryCards();
        } catch (error) {
            console.warn(`procmon: panel sample failed: ${error}`);
        } finally {
            this._panelBusy = false;
        }
    }

    _panelTemperature() {
        return this._temperatures.length ? this._temperatures[0].celsius : null;
    }

    _updatePanelLabel() {
        return renderers.updatePanelLabel(this);
    }

    _recordSparkSample() {
        return sparkline.recordSparkSample(this);
    }
    _paintSparkline(area) {
        return sparkline.paintSparkline(this, area);
    }

    _drawSparkSeries(cr, width, height, inset, history, red, green, blue, lineAlpha) {
        return sparkline.drawSparkSeries(this, cr, width, height, inset, history, red, green, blue, lineAlpha);
    }
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
        const {escalated, cooled, shouldNotify} = alertDecision(state, level, now, ALERT_COOLDOWN_MS);
        if (!shouldNotify)
            return;
        const notif = new MessageTray.Notification(this._alertSource(),
            _('ProcMon'), message);
        notif.addAction(_('Details'), () => {
            const entry = this._alertState.get(kind);
            if (entry)
                entry.acked = true;
            this.menu.open();
        });
        this._alertState.set(kind, {level, at: now, acked: false});
        const source = this._alertSource();
        // the Source API changed across GNOME versions; pick what exists
        if (typeof source.showNotification === 'function')
            source.showNotification(notif);
        else if (typeof source.notify === 'function')
            source.notify(notif);
        else
            Main.notify('ProcMon', message);
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
            console.warn(`procmon: sampleMenuData failed: ${error}`);
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
                this._sparkValue = null;

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
        return sections.addOptionalSections(this, content);
    }
    _mountContent(content) {
        return sections.mountContent(this, content);
    }

    _addHeader(content) {
        return sections.addHeader(this, content);
    }

    _addSparkline(content) {
        return sparkline.addSparkline(this, content);
    }

    _addCard(cardsRow, titleText, valueClass) {
        return cards.addCard(this, cardsRow, titleText, valueClass);
    }

    _addSummaryCards(content) {
        return cards.addSummaryCards(this, content);
    }

    _ensureThirdCard(cardsRow) {
        return cards.ensureThirdCard(this, cardsRow);
    }

    _addSection(content, titleText, hint, options = {}) {
        return sections.addSection(this, content, titleText, hint, options = {});
    }

    _setSectionSummary(section, text) {
        if (section?.summary)
            section.summary.text = text;
    }

    _toggleSection(section) {
        return sections.toggleSection(this, section);
    }

    _addGroup(content, title, options = {}) {
        return sections.addGroup(this, content, title, options = {});
    }

    _toggleGroup(group) {
        return sections.toggleGroup(this, group);
    }

    _autostartDirs() {
        return startup.autostartDirs(this);
    }

    _readAutostartEntries() {
        return startup.readAutostartEntries(this);
    }

    _makeToggleButton(active) {
        return startup.makeToggleButton(this, active);
    }

    _syncToggleButton(btn, active) {
        return startup.syncToggleButton(this, btn, active);
    }

    _makeStartupRow(entry) {
        return startup.makeStartupRow(this, entry);
    }

    _toggleAutostart(entry) {
        return startup.toggleAutostart(this, entry);
    }

    _runSystemctl(args) {
        return startup.runSystemctl(this, args);
    }

    _addStartupSection(box) {
        return startup.addStartupSection(this, box);
    }

    async _fillServices(section) {
        return startup.fillServices(this, section);
    }

    _makeLineRow(box) {
        return rows.makeLineRow(this, box);
    }
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
        return rows.makeProcessRows(this, box);
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
        return renderers.renderValues(this);
    }

    _renderMeta() {
        return renderers.renderMeta(this);
    }

    _renderSummaryCards() {
        return renderers.renderSummaryCards(this);
    }

    _renderSectionSummaries() {
        return renderers.renderSectionSummaries(this);
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
        return renderers.renderIo(this);
    }

    _renderProcessRows() {
        return rows.renderProcessRows(this);
    }

    _paintProcessRows(rows, entries, valueFor, highlightFor) {
        return rows.paintProcessRows(this, rows, entries, valueFor, highlightFor);
    }

    _syncRowsVisibility(rows, expected) {
        return rows.syncRowsVisibility(this, rows, expected);
    }

    _setRowIcon(row, group) {
        return rows.setRowIcon(this, row, group);
    }

    _iconForGroup(group) {
        return rows.iconForGroup(this, group);
    }

    _renderGraphics() {
        return renderers.renderGraphics(this);
    }

    _renderPsi() {
        return renderers.renderPsi(this);
    }

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

    _renderMemorySection() {
        return renderers.renderMemorySection(this);
    }
    _renderLineSection(section, entries, rowFor) {
        return renderers.renderLineSection(this, section, entries, rowFor);
    }
    _renderBatterySection() {
        return renderers.renderBatterySection(this);
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