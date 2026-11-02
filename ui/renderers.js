import St from 'gi://St';
import Gettext from 'gettext';
import {assessKillProcess, averageFrequencyGhz, collectFans, collectTemperatures, collectVoltages, computeCoreShares, computeCpuShares, computeDiskRates, computeNetRates, formatBytes, formatDuration, formatRate, groupProcesses, isFiniteRect, isPointInsideRect, ownedProcessEntries, parseBatteryDetails, parseCoreTicks, parseCpuTicks, parseDiskStats, parseGpuCard, parseLoadAvg, parseMemInfo, parseNetDev, parsePsi, parseStatLine, parseUptime} from '../lib/proc.js';
import { FIRST_SAMPLE_MS, IO_WARMUP_MS, EXIT_CHECK_MS, TEMPERATURE_CACHE_MS, ALERT_COOLDOWN_MS, SPARK_SAMPLES, SPARKLINE_WIDTH, iso, _, _n, MAX_TEMPERATURES, MAX_FILESYSTEMS, PSI_RESOURCES, FALLBACK_PROCESS_ICON, percentOf, parsePanelItems } from './constants.js';


export function renderValues(ind) {
        if (!ind.menu.isOpen)
            return;
        ind._ensureThirdCard(ind._ui.cardsRow);
        ind._renderMeta();
        ind._renderSummaryCards();
        ind._renderProcessRows();
        ind._renderMemorySection();
        ind._renderLineSection(ind._ui.temperature, (ind._temperatures ?? [])
            .slice(0, MAX_TEMPERATURES), reading => [
            reading.label,
            `${iso(Math.round(reading.celsius))}°C`,
        ]);
        ind._renderLineSection(ind._ui.fans, ind._fans ?? [], reading => [
            reading.label,
            `${iso(reading.rpm)} rpm`,
        ]);
        ind._renderLineSection(ind._ui.voltages, ind._voltages ?? [], reading => [
            reading.label === 'battery' ? _('Battery') : reading.label,
            `${iso(reading.volts.toFixed(2))} V`,
        ]);
        ind._renderBatterySection();
        ind._renderIo();
        ind._renderLineSection(ind._ui.filesystems,
            (ind._fsData ?? []).slice(0, MAX_FILESYSTEMS), filesystem => [
                filesystem.mountPoint,
                `(${iso(filesystem.percent)}%) ${iso(formatBytes(filesystem.usedBytes))} / ${
                    iso(formatBytes(filesystem.totalBytes))}`,
            ]);
        ind._renderGraphics();
        ind._renderPsi();
        ind._renderSectionSummaries();
    }

export function renderMeta(ind) {
        const sensors = ind._sensors ?? {};
        const parts = [];
        if (Number.isFinite(sensors.uptime))
            parts.push(_('Up %s').format(iso(formatDuration(sensors.uptime) ?? '—')));
        if (sensors.load)
            parts.push(_('Load %s').format(iso(sensors.load.one.toFixed(2))));
        const count = ind._processes.size;
        parts.push(_n('%s process', '%s processes', count).format(iso(count)));
        const coreCount = ind._lastSample?.cores?.size ?? 0;
        if (coreCount > 0)
            parts.push(_('Cores %s').format(iso(coreCount)));
        ind._ui.meta.text = parts.join(' · ');
    }

export function renderSummaryCards(ind) {
        const cards = ind._ui.cards;
        cards.cpu.value.text = `${iso(Math.round(ind._cpuPercent))}%`;
        ind._setBar(cards.cpu, ind._cpuPercent);

        const memory = ind._memory;
        if (memory && memory.totalMb > 0) {
            const percent = percentOf(memory.usedMb, memory.totalMb);
            cards.mem.value.text = `${iso(Math.round(percent))}%`;
            ind._setBar(cards.mem, percent);
        } else {
            cards.mem.value.text = _('No data');
            ind._setBar(cards.mem, 0);
        }

        if (ind._sparkValue)
            ind._sparkValue.text = `${iso(Math.round(ind._cpuPercent))}% CPU · ${iso(ind._memory ? Math.round(percentOf(ind._memory.usedMb, ind._memory.totalMb)) : 0)}% RAM`;

        const third = cards.third;
        if (cards.thirdKind === 'gpu') {
            const gpu = (ind._sensors?.gpus ?? [])[0];
            if (gpu && gpu.usagePercent !== null) {
                third.value.text = `${iso(gpu.usagePercent)}%`;
                ind._setBar(third, gpu.usagePercent);
            } else {
                third.value.text = '—';
                ind._setBar(third, 0);
            }
        } else {
            const rates = ind._ioRates?.disk;
            third.value.text = rates
                ? `${_('↓ %s · ↑ %s').format(iso(formatRate(rates.readPerSecond)),
                    iso(formatRate(rates.writePerSecond)))}`
                : _('No data');
        }
    }

export function renderGraphics(ind) {
        const section = ind._ui.graphics;
        if (!section)
            return;
        const cards = ind._sensors?.gpus ?? [];
        ind._ensureLines(section, cards.length);
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

export function renderPsi(ind) {
        const ui = ind._ui.psi;
        if (!ui)
            return;
        const psi = ind._sensors?.psi ?? {};
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

function renderProcessorSummary(ind, ui) {
        if (ui.cpu)
            ind._setSectionSummary(ui.cpu, `${iso(Math.round(ind._cpuPercent))}%`);
    }

function renderMemorySummary(ind, ui) {
        const memory = ind._memory;
        if (ui.memory?.section && memory && memory.totalMb > 0) {
            const usedGb = memory.usedMb / 1024;
            const totalGb = memory.totalMb / 1024;
            ind._setSectionSummary(ui.memory.section,
                `${iso(usedGb.toFixed(1))}/${iso(totalGb.toFixed(0))} GB`);
        }
    }

function renderTemperatureSummary(ind, ui) {
        const temps = ind._temperatures ?? [];
        if (ui.temperature && temps.length > 0) {
            const hottest = Math.max(...temps.map(t => t.celsius));
            ind._setSectionSummary(ui.temperature, `${iso(Math.round(hottest))}°C`);
        }
    }

function renderNetworkSummary(ind, ui) {
        const netRates = ind._ioRates?.net ?? [];
        if (ui.network && netRates.length > 0) {
            const rx = netRates.reduce((sum, rate) => sum + (rate.rxPerSecond ?? 0), 0);
            const tx = netRates.reduce((sum, rate) => sum + (rate.txPerSecond ?? 0), 0);
            ind._setSectionSummary(ui.network,
                `${_('↓ %s · ↑ %s').format(iso(formatRate(rx)), iso(formatRate(tx)))}`);
        } else if (ui.network) {
            ind._setSectionSummary(ui.network, '');
        }
    }

function renderDiskSummary(ind, ui) {
        const fs = (ind._fsData ?? [])[0];
        if (ui.filesystems && fs)
            ind._setSectionSummary(ui.filesystems, `${iso(Math.round(fs.percent))}%`);
    }

function renderGraphicsSummary(ind, ui) {
        const gpu = (ind._sensors?.gpus ?? [])[0];
        if (ui.graphics && gpu && gpu.usagePercent !== null)
            ind._setSectionSummary(ui.graphics, `${iso(gpu.usagePercent)}%`);
    }

export function renderSectionSummaries(ind) {
        const ui = ind._ui;
        renderProcessorSummary(ind, ui);
        renderMemorySummary(ind, ui);
        renderTemperatureSummary(ind, ui);
        renderNetworkSummary(ind, ui);
        renderDiskSummary(ind, ui);
        renderGraphicsSummary(ind, ui);
    }

export function renderIo(ind) {
        const cards = ind._ui.cards;
        if (cards.thirdKind === 'disk') {
            const rates = ind._ioRates?.disk;
            cards.third.value.text = rates
                ? `${_('↓ %s · ↑ %s').format(iso(formatRate(rates.readPerSecond)),
                    iso(formatRate(rates.writePerSecond)))}`
                : _('No data');
        }
        const section = ind._ui.network;
        if (!section)
            return;
        const interfaces = [...(ind._ioCurrent?.net.keys() ?? [])];
        ind._ensureLines(section, interfaces.length);
        const ratesByName = new Map((ind._ioRates?.net ?? [])
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

export function updatePanelLabel(ind) {
        const parts = [];
        const ramPercent = ind._memory
            ? percentOf(ind._memory.usedMb, ind._memory.totalMb) : 0;
        for (const item of parsePanelItems(ind._settings.get_string('panel-items'))) {
            if (item === 'cpu')
                parts.push(`${_('CPU')} ${iso(Math.round(ind._cpuPercent))}%`);
            if (item === 'ram')
                parts.push(`${_('RAM')} ${iso(Math.round(ramPercent))}%`);
            if (item === 'temp') {
                const celsius = ind._panelTemperature();
                if (celsius !== null)
                    parts.push(`${iso(Math.round(celsius))}°C`);
            }
        }
        ind._label.text = parts.join(' · ');
    }

    // ----- sparkline + threshold alerts ------------------------------------

export function renderMemorySection(ind) {
    const ui = ind._ui?.memory;
    if (!ui)
        return;
    const memory = ind._memory;
    if (!memory) {
        ui.section.hintLabel.visible = true;
        return;
    }
    ui.section.hintLabel.visible = false;
    const rows = ui.rows;
    rows.used.name.text = _('Used');
    rows.used.value.text = `${iso(Math.round(memory.usedMb))} MB`;
    rows.available.name.text = _('Available');
    rows.available.value.text = `${iso(Math.round(memory.availableMb))} MB`;
    rows.cached.name.text = _('Cached');
    rows.cached.value.text = `${iso(Math.round(memory.cachedMb))} MB`;
    rows.buffers.name.text = _('Buffers');
    rows.buffers.value.text = `${iso(Math.round(memory.buffersMb))} MB`;
    rows.swap.name.text = _('Swap');
    rows.swap.value.text = `${iso(Math.round(memory.swapUsedMb))} / ${iso(Math.round(memory.swapTotalMb))} MB`;
}

export function renderLineSection(ind, section, entries, rowFor) {
    if (!section)
        return;
    ind._ensureLines(section, entries.length);
    entries.forEach((entry, index) => {
        const row = section.lines[index];
        const pair = rowFor(entry);
        row.name.text = pair[0];
        row.value.text = pair[1];
        row.row.visible = true;
    });
}

export function renderBatterySection(ind) {
    const section = ind._ui?.battery;
    if (!section)
        return;
    const battery = ind._battery;
    if (!battery) {
        section.hintLabel.visible = true;
        return;
    }
    section.hintLabel.visible = false;
    const rows = section.rows;
    rows.level.name.text = _('Level');
    rows.level.value.text = `${iso(battery.percent)}%`;
    rows.power.name.text = _('Power');
    rows.power.value.text = battery.watts !== null ? `${iso(battery.watts)} W` : '—';
    rows.left.name.text = _('Time left');
    rows.left.value.text = battery.minutesLeft !== null ? `${iso(battery.minutesLeft)} min` : '—';
}
