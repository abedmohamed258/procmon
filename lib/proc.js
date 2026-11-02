// Pure parsing and formatting helpers. No gi imports and no gettext here, so
// the file runs under plain `gjs -m tests/parsing.test.js`. All user-visible
// wording is produced in extension.js; labels returned by these functions are
// stable identifiers, never UI copy.

// /proc/<pid>/stat fields after the closing bracket: [0]=state (field 3),
// [11]=utime (14), [12]=stime (15), [19]=starttime (22).
const STATE_INDEX = 0;
const UTIME_INDEX = 11;
const STIME_INDEX = 12;
const START_TIME_INDEX = 19;

export function parseStatLine(text) {
    if (typeof text !== 'string' || text.length === 0)
        return null;

    const openIndex = text.indexOf('(');
    const closeIndex = text.lastIndexOf(')');
    if (openIndex < 0 || closeIndex <= openIndex)
        return null;

    const fields = text.slice(closeIndex + 2).trim().split(/\s+/);
    if (fields.length <= START_TIME_INDEX)
        return null;

    const utime = Number(fields[UTIME_INDEX]);
    const stime = Number(fields[STIME_INDEX]);
    const startTime = Number(fields[START_TIME_INDEX]);
    const state = fields[STATE_INDEX];
    if (!Number.isFinite(utime) || !Number.isFinite(stime) || !Number.isFinite(startTime))
        return null;

    return {
        name: text.slice(openIndex + 1, closeIndex),
        state,
        startTime,
        ticks: utime + stime,
    };
}

function hasValidTicks(ticks) {
    return Boolean(ticks) && Number.isFinite(ticks.busy) && Number.isFinite(ticks.total) &&
        ticks.total > 0;
}

export function computeCpuShares(previous, current) {
    const shares = new Map();
    const previousTicks = previous ? previous.ticks : null;
    const currentTicks = current ? current.ticks : null;
    if (!hasValidTicks(previousTicks) || !hasValidTicks(currentTicks))
        return shares;

    const totalDelta = currentTicks.total - previousTicks.total;
    if (!(totalDelta > 0))
        return shares;

    for (const [pid, entry] of current.processes) {
        const before = previous.processes.get(pid);
        if (!before)
            continue;

        const processDelta = entry.ticks - before.ticks;
        if (!(processDelta > 0))
            continue;

        shares.set(pid, 100 * processDelta / totalDelta);
    }
    return shares;
}

function parseTicksFields(line) {
    const fields = line.trim().split(/\s+/).slice(1).map(Number);
    if (fields.length < 5 || fields.some(value => !Number.isFinite(value)))
        return null;

    const idle = fields[3] + fields[4];
    const total = fields.reduce((sum, value) => sum + value, 0);
    return {busy: total - idle, total};
}

export function parseCpuTicks(text) {
    if (typeof text !== 'string')
        return null;

    const firstLine = text.split('\n', 1)[0];
    if (!/^cpu\s/.test(firstLine))
        return null;

    return parseTicksFields(firstLine);
}

// cpuN lines of /proc/stat: core index => {busy, total}.
export function parseCoreTicks(text) {
    const cores = new Map();
    if (typeof text !== 'string')
        return cores;

    for (const line of text.split('\n')) {
        const match = /^cpu(\d+)\s/.exec(line);
        if (!match)
            continue;

        const ticks = parseTicksFields(line);
        if (ticks)
            cores.set(Number(match[1]), ticks);
    }
    return cores;
}

// Per-core version of the two-sample difference, normalized on the core itself.
export function computeCoreShares(previous, current) {
    const shares = new Map();
    if (!(previous instanceof Map) || !(current instanceof Map))
        return shares;

    for (const [index, currentTicks] of current) {
        const previousTicks = previous.get(index);
        if (!previousTicks)
            continue;

        const core = computeCpuShares(
            {ticks: previousTicks, processes: new Map([[index, {ticks: previousTicks.busy}]])},
            {ticks: currentTicks, processes: new Map([[index, {ticks: currentTicks.busy}]])});
        // An idle core yields no share; pin it to 0% so the cell stays in the grid.
        shares.set(index, core.get(index) ?? 0);
    }
    return shares;
}

// Grid layout: rows of perRow cores, remember cores beyond maxCores as hidden.
export function coreGridRows(cores, maxCores = 16, perRow = 4) {
    const indexes = [...(cores instanceof Map ? cores.keys() : [])].sort((a, b) => a - b);
    const visible = indexes.slice(0, Math.max(0, maxCores));
    const size = Math.max(1, perRow);
    const rows = [];

    for (let start = 0; start < visible.length; start += size)
        rows.push(visible.slice(start, start + size));

    return {rows, hidden: indexes.length - visible.length};
}

export function parseLoadAvg(text) {
    if (typeof text !== 'string')
        return null;

    const fields = text.trim().split(/\s+/).slice(0, 3).map(Number);
    if (fields.length < 3 || fields.some(value => !Number.isFinite(value)))
        return null;

    return {one: fields[0], five: fields[1], fifteen: fields[2]};
}

export function parseMemInfo(text) {
    if (typeof text !== 'string')
        return null;

    const readKb = key => {
        const match = text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
        return match ? Number(match[1]) : 0;
    };

    const totalKb = readKb('MemTotal');
    if (!(totalKb > 0))
        return null;

    const swapTotalKb = readKb('SwapTotal');
    const swapFreeKb = readKb('SwapFree');

    return {
        totalMb: totalKb / 1024,
        usedMb: (totalKb - readKb('MemAvailable')) / 1024,
        availableMb: readKb('MemAvailable') / 1024,
        freeMb: readKb('MemFree') / 1024,
        buffersMb: readKb('Buffers') / 1024,
        cachedMb: readKb('Cached') / 1024,
        swapTotalMb: swapTotalKb / 1024,
        swapUsedMb: (swapTotalKb - swapFreeKb) / 1024,
    };
}

// Frequencies in kHz => average in GHz, or null when no valid value exists.
export function averageFrequencyGhz(frequenciesKhz) {
    if (!Array.isArray(frequenciesKhz))
        return null;

    const valid = frequenciesKhz.filter(value => Number.isFinite(value) && value > 0);
    if (valid.length === 0)
        return null;

    const average = valid.reduce((sum, value) => sum + value, 0) / valid.length / 1e6;
    return average > 0 ? average : null;
}

export function pickFanRpm(values) {
    if (!Array.isArray(values))
        return null;

    for (const value of values) {
        const rpm = Number(value);
        if (Number.isFinite(rpm) && rpm > 0)
            return Math.round(rpm);
    }
    return null;
}

// Unknown or missing status keys stay null; extension.js maps them to gettext.
const BATTERY_STATUS_KEYS = new Set(['Charging', 'Discharging', 'Full']);

function batteryStatusKey(statusText) {
    const status = typeof statusText === 'string' ? statusText.trim() : '';
    return BATTERY_STATUS_KEYS.has(status) ? status : null;
}

export function parseBattery(capacityText, statusText) {
    const raw = typeof capacityText === 'string' ? capacityText.trim() : '';
    if (raw === '')
        return null;

    const percent = Number(raw);
    if (!Number.isFinite(percent) || percent < 0)
        return null;

    return {percent: Math.round(percent), status: batteryStatusKey(statusText)};
}

function readRawNumber(text) {
    if (typeof text === 'number')
        return Number.isFinite(text) ? text : null;

    const raw = typeof text === 'string' ? text.trim() : '';
    if (raw === '')
        return null;

    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
}

// A battery may expose energy_* or charge_* only; charge turns into energy via voltage.
function energyMicroWattHours(energyNow, chargeNow, microvolts) {
    const energy = readRawNumber(energyNow);
    if (energy !== null && energy >= 0)
        return energy;

    const charge = readRawNumber(chargeNow);
    if (charge === null || charge <= 0 || microvolts === null || microvolts <= 0)
        return null;

    return charge * microvolts / 1e6;
}

export function parseUptime(text) {
    if (typeof text !== 'string')
        return null;

    const seconds = Number(text.trim().split(/\s+/)[0]);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

// 3d 4h 12m · 1h 20m · 42s — latin unit letters, matching the rest of the indicator.
export function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0)
        return null;

    const total = Math.floor(seconds);
    const days = Math.floor(total / 86400);
    const hours = Math.floor(total % 86400 / 3600);
    const minutes = Math.floor(total % 3600 / 60);

    if (days > 0)
        return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0)
        return `${hours}h ${minutes}m`;
    if (minutes > 0)
        return `${minutes}m`;
    return `${total}s`;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0)
        return '—';

    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < UNITS.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(unit === 0 ? 0 : 1)} ${UNITS[unit]}`;
}

export function formatRate(bytesPerSecond) {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0)
        return '—';
    return `${formatBytes(bytesPerSecond)}/s`;
}

// milli°C (thermal/hwmon) => °C; values outside the plausible range are dropped.
export function parseTemperatureCelsius(text) {
    const millidegrees = readRawNumber(text);
    if (millidegrees === null)
        return null;

    const celsius = millidegrees / 1000;
    if (celsius <= 0 || celsius >= 150)
        return null;
    return celsius;
}

// zones: [{name, type, temp}] · hwmons: [{device, temps: [{label, temp}]}]
// Result is sorted descending, deduplicated by label; the first entry is the hottest.
export function collectTemperatures(zones = [], hwmons = []) {
    const readings = [];

    for (const zone of Array.isArray(zones) ? zones : []) {
        const celsius = parseTemperatureCelsius(zone?.temp);
        if (celsius === null)
            continue;
        const label = String(zone?.type ?? '').trim() || String(zone?.name ?? '').trim();
        if (label)
            readings.push({label, celsius});
    }

    for (const hwmon of Array.isArray(hwmons) ? hwmons : []) {
        const device = String(hwmon?.device ?? '').trim();
        for (const sensor of Array.isArray(hwmon?.temps) ? hwmon.temps : []) {
            const celsius = parseTemperatureCelsius(sensor?.temp);
            if (celsius === null)
                continue;
            const own = String(sensor?.label ?? '').trim();
            const label = own && device ? `${device}: ${own}` : own || device;
            if (label)
                readings.push({label, celsius});
        }
    }

    readings.sort((a, b) => b.celsius - a.celsius);
    const seen = new Set();
    return readings.filter(reading => {
        if (seen.has(reading.label))
            return false;
        seen.add(reading.label);
        return true;
    });
}

// hwmons: [{device, fans: [{label, rpm}]}] — stopped fans (0) are dropped.
export function collectFans(hwmons = []) {
    const fans = [];

    for (const hwmon of Array.isArray(hwmons) ? hwmons : []) {
        const device = String(hwmon?.device ?? '').trim();
        for (const fan of Array.isArray(hwmon?.fans) ? hwmon.fans : []) {
            const rpm = readRawNumber(fan?.rpm);
            if (rpm === null || rpm <= 0)
                continue;
            const own = String(fan?.label ?? '').trim();
            fans.push({label: own && device ? `${device}: ${own}` : own || device, rpm: Math.round(rpm)});
        }
    }

    return fans.sort((a, b) => b.rpm - a.rpm);
}

// hwmons: [{device, voltages: [{label, millivolts}]}] plus battery voltage in µV.
export function collectVoltages(hwmons = [], batteryMicrovolts = null) {
    const voltages = [];

    for (const hwmon of Array.isArray(hwmons) ? hwmons : []) {
        const device = String(hwmon?.device ?? '').trim();
        for (const entry of Array.isArray(hwmon?.voltages) ? hwmon.voltages : []) {
            const millivolts = readRawNumber(entry?.millivolts);
            if (millivolts === null || millivolts <= 0 || millivolts > 30000)
                continue;
            const own = String(entry?.label ?? '').trim();
            voltages.push({
                label: own && device ? `${device}: ${own}` : own || device,
                volts: Math.round(millivolts / 10) / 100,
            });
        }
    }

    const battery = readRawNumber(batteryMicrovolts);
    if (battery !== null && battery > 0) {
        const volts = Math.round(battery / 1e4) / 100;
        // hwmon often exposes the battery voltage itself; do not duplicate the line.
        if (!voltages.some(entry => Math.abs(entry.volts - volts) < 0.01))
            voltages.push({label: 'battery', volts});
    }

    return voltages;
}

// Raw /sys/class/power_supply/BAT* fields; missing fields are skipped silently.
export function parseBatteryDetails(fields = {}) {
    const battery = parseBattery(fields.capacity, fields.status);
    if (!battery)
        return null;

    const microvolts = readRawNumber(fields.voltageNow);
    const microamps = readRawNumber(fields.currentNow);
    const microwatts = readRawNumber(fields.powerNow);

    let watts = null;
    if (microwatts !== null && microwatts >= 0) {
        watts = microwatts / 1e6;
    } else if (microvolts !== null && microamps !== null) {
        // µV × µA = pW
        watts = microvolts * microamps / 1e12;
    }
    if (watts !== null)
        watts = Math.round(watts * 100) / 100;

    const status = batteryStatusKey(fields.status);
    const energy = energyMicroWattHours(fields.energyNow, fields.chargeNow, microvolts);
    let minutesLeft = null;
    if (status === 'Discharging' && energy !== null && watts !== null && watts > 0.01)
        minutesLeft = Math.round(energy / 1e6 / watts * 60);

    return {
        percent: battery.percent,
        status,
        watts,
        minutesLeft,
        voltageMicrovolts: microvolts,
    };
}

// /proc/net/dev => Map(interface => {rxBytes, txBytes}) without lo.
export function parseNetDev(text) {
    const interfaces = new Map();
    if (typeof text !== 'string')
        return interfaces;

    for (const line of text.split('\n')) {
        const separator = line.indexOf(':');
        if (separator < 0)
            continue;

        const name = line.slice(0, separator).trim();
        if (!name || name === 'lo')
            continue;

        const fields = line.slice(separator + 1).trim().split(/\s+/).map(Number);
        if (fields.length < 9 || !Number.isFinite(fields[0]) || !Number.isFinite(fields[8]))
            continue;

        interfaces.set(name, {rxBytes: fields[0], txBytes: fields[8]});
    }

    return interfaces;
}

export function computeNetRates(previous, current, seconds) {
    if (!(previous instanceof Map) || !(current instanceof Map) || !(seconds > 0))
        return [];

    const rates = [];
    for (const [name, now] of current) {
        const before = previous.get(name);
        if (!before)
            continue;
        rates.push({
            name,
            rxPerSecond: Math.max(0, now.rxBytes - before.rxBytes) / seconds,
            txPerSecond: Math.max(0, now.txBytes - before.txBytes) / seconds,
            rxTotal: now.rxBytes,
            txTotal: now.txBytes,
        });
    }

    return rates.sort((a, b) =>
        (b.rxPerSecond + b.txPerSecond) - (a.rxPerSecond + a.txPerSecond));
}

const VIRTUAL_DISK = /^(loop|ram|zram|dm-|sr|fd)/;
const SECTOR_BYTES = 512;

// /proc/diskstats => Map(device => {readBytes, writeBytes}), partitions and virtual devices skipped.
export function parseDiskStats(text) {
    const devices = new Map();
    if (typeof text !== 'string')
        return devices;

    const rows = [];
    for (const line of text.split('\n')) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 10)
            continue;
        const name = fields[2];
        const readSectors = Number(fields[5]);
        const writeSectors = Number(fields[9]);
        if (!name || !Number.isFinite(readSectors) || !Number.isFinite(writeSectors))
            continue;
        rows.push({name, readSectors, writeSectors});
    }

    const names = new Set(rows.map(row => row.name));
    const isPartition = name => {
        const parent = name.replace(/p?\d+$/, '');
        return parent !== name && names.has(parent);
    };

    for (const row of rows) {
        if (VIRTUAL_DISK.test(row.name) || isPartition(row.name))
            continue;
        devices.set(row.name, {
            readBytes: row.readSectors * SECTOR_BYTES,
            writeBytes: row.writeSectors * SECTOR_BYTES,
        });
    }

    return devices;
}

export function computeDiskRates(previous, current, seconds) {
    if (!(previous instanceof Map) || !(current instanceof Map) || !(seconds > 0))
        return null;

    let readPerSecond = 0;
    let writePerSecond = 0;
    let sampled = false;
    for (const [name, now] of current) {
        const before = previous.get(name);
        if (!before)
            continue;
        sampled = true;
        readPerSecond += Math.max(0, now.readBytes - before.readBytes) / seconds;
        writePerSecond += Math.max(0, now.writeBytes - before.writeBytes) / seconds;
    }

    return sampled ? {readPerSecond, writePerSecond} : null;
}

// /proc/pressure/<resource> lines: `some avg10=a avg60=b avg300=c total=t` and optional `full …`.
export function parsePsi(text) {
    if (typeof text !== 'string')
        return null;

    const result = {};
    let found = false;
    for (const line of text.split('\n')) {
        const match = /^(some|full)\s+avg10=([\d.]+)\s+avg60=([\d.]+)\s+avg300=([\d.]+)\s+total=(\d+)\s*$/
            .exec(line.trim());
        if (!match)
            continue;
        result[match[1]] = {
            avg10: Number(match[2]),
            avg60: Number(match[3]),
            avg300: Number(match[4]),
            total: Number(match[5]),
        };
        found = true;
    }

    return found ? result : null;
}

// `gpu_busy_percent` content: integer 0..100, anything else rejected.
export function parseGpuPercent(text) {
    const raw = typeof text === 'string' ? text.trim() : '';
    if (raw === '')
        return null;

    const percent = Number(raw);
    if (!Number.isInteger(percent) || percent < 0 || percent > 100)
        return null;
    return percent;
}

// PCI vendor ids observed on sysfs DRM cards (lowercase expected upstream).
const GPU_VENDORS = new Map([
    ['0x1002', 'AMD'],
    ['0x10de', 'NVIDIA'],
    ['0x13b5', 'ARM'],
    ['0x5143', 'Qualcomm'],
    ['0x8086', 'Intel'],
    ['0x1234', 'QEMU'],
]);

// DRm vendors expose gpu_busy_percent only for AMD; NVIDIA/intel cards remain
// visible for their VRAM counters when present.
export function parseGpuCard({vendorId, busy, vramUsed, vramTotal} = {}) {
    const vendor = GPU_VENDORS.get(String(vendorId ?? '').toLowerCase()) ?? null;
    if (!vendor)
        return null;

    const usagePercent = parseGpuPercent(busy);
    const usedBytes = readRawNumber(vramUsed);
    const totalBytes = readRawNumber(vramTotal);

    const card = {
        vendor,
        usagePercent,
        vramUsedBytes: usedBytes !== null && usedBytes >= 0 ? usedBytes : null,
        vramTotalBytes: totalBytes !== null && totalBytes >= 0 ? totalBytes : null,
    };

    const hasData = usagePercent !== null ||
        (card.vramUsedBytes !== null && card.vramUsedBytes > 0) ||
        (card.vramTotalBytes !== null && card.vramTotalBytes > 0);
    return hasData ? card : null;
}

export function isFiniteRect(rect) {
    if (!rect)
        return false;
    return ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key]));
}

// entries: [{pid, name, rssKb, cpu, uid}] — same-comm workers merge into one
// group so the UI can terminate a whole app family with one click. The input
// array is never mutated; groups carry first-seen casing for display.
// sortKey picks the ranking metric: 'cpu' (default) or 'rss'; ties fall back
// to the other metric so both views stay deterministic.
export function groupProcesses(entries, topCount, sortKey = 'cpu') {
    const groups = new Map();
    const list = Array.isArray(entries) ? entries : [];

    for (const entry of list) {
        if (!entry || !Number.isFinite(entry.pid))
            continue;

        const baseName = String(entry.name ?? '').trim().replace(/.*\//, '').toLowerCase();
        if (!baseName)
            continue;

        let group = groups.get(baseName);
        if (!group) {
            group = {
                name: String(entry.name).trim(),
                pids: [],
                cpuSum: 0,
                rssKbSum: 0,
                count: 0,
                uidSet: new Set(),
            };
            groups.set(baseName, group);
        }

        group.pids.push(entry.pid);
        group.count++;
        if (Number.isFinite(entry.cpu) && entry.cpu > 0)
            group.cpuSum += entry.cpu;
        if (Number.isFinite(entry.rssKb) && entry.rssKb > 0)
            group.rssKbSum += entry.rssKb;
        group.uidSet.add(entry.uid);
    }

    const byRank = sortKey === 'rss'
        ? (a, b) => b.rssKbSum - a.rssKbSum || b.cpuSum - a.cpuSum
        : (a, b) => b.cpuSum - a.cpuSum || b.rssKbSum - a.rssKbSum;
    const sorted = [...groups.values()].sort(byRank);

    const limit = Number.isFinite(topCount) ? Math.max(0, Math.floor(topCount))
        : Infinity;
    return {groups: sorted.slice(0, limit), totalGroups: sorted.length};
}

// Kill policy as pure functions: every fail path is closed, so an unknown
// identity, a zombie or an unverifiable startTime can only answer "cannot
// kill". Reasons are stable keys; extension.js translates them. `pid` is
// accepted for call-site completeness only — kernel/own-pid guards stay with
// the caller, which owns those liveness notions.
export function assessKillProcess({uid, ownUid, startTime,
    expectedStartTimeTicks, state}) {
    if (ownUid === null || ownUid === undefined || ownUid < 0)
        return {canKill: false, reason: 'unknown-identity'};
    if (uid !== ownUid)
        return {canKill: false, reason: 'foreign-uid'};
    if (typeof state !== 'string' || state === 'Z' || state === 'X')
        return {canKill: false, reason: 'zombie-or-exited'};
    if (!Number.isFinite(startTime) || !Number.isFinite(expectedStartTimeTicks) ||
        startTime !== expectedStartTimeTicks)
        return {canKill: false, reason: 'pid-reused'};
    return {canKill: true, reason: 'owned'};
}

// entries are kept by reference — filtering must never mutate or copy process
// objects. An unknown ownUid has only one safe answer: [].
export function ownedProcessEntries(entries, ownUid) {
    if (ownUid === null || ownUid === undefined || ownUid < 0)
        return [];
    return (Array.isArray(entries) ? entries : [])
        .filter(entry => entry?.uid === ownUid);
}

export function isPointInsideRect(pointX, pointY, rect) {
    if (!Number.isFinite(pointX) || !Number.isFinite(pointY) || !isFiniteRect(rect))
        return false;
    if (rect.width <= 0 || rect.height <= 0)
        return false;

    return pointX >= rect.x && pointX <= rect.x + rect.width &&
        pointY >= rect.y && pointY <= rect.y + rect.height;
}


// Pure decision for smart alerts. Returns whether a notification should be
// shown given the previous state, the new level, the current time and the
// cooldown. Separated from the shell so it can be unit-tested without GJS.
export function alertDecision(state, level, now, cooldownMs) {
    const s = state ?? {level: 0, at: 0, acked: false};
    const escalated = level > s.level;
    const cooled = (now - (s.at ?? 0)) >= cooldownMs;
    const shouldNotify = escalated || (cooled && !s.acked);
    return {escalated, cooled, shouldNotify};
}


// Which supervisor owns a pid, from /proc/<pid>/cgroup:
//   systemd user service -> {kind:'service', unit}
//   session app scope    -> {kind:'app', unit:null}
// user@1000.service is the session manager itself, not an app supervisor.
export function parseCgroupUnit(text) {
    if (typeof text !== 'string')
        return null;
    const line = text.split('\n')[0];
    const segment = line.split('/').reverse()
        .find(part => /\.(service|scope)$/.test(part));
    if (!segment)
        return null;
    if (segment.endsWith('.service') && !segment.startsWith('user@'))
        return {kind: 'service', unit: segment};
    if (segment.endsWith('.scope'))
        return {kind: 'app', unit: null};
    return null;
}
