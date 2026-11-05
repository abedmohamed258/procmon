// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Abed Mohamed

import * as sparkline from './sparkline.js';
import {formatBytes, formatDuration, formatRate} from '../lib/proc.js';
import {iso, _, _n, MAX_TEMPERATURES, MAX_FILESYSTEMS, PSI_RESOURCES,
    percentOf, parsePanelItems, panelLevel} from './constants.js';


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

        // trend arrows: delta vs the previous menu render, >= 2 points
        const trend = (now, prev) => prev === null ? '' :
            (now - prev >= 2 ? ' ▲' : now - prev <= -2 ? ' ▼' : ' ●');
        cards.cpu.title.text = cards.cpu.baseTitle +
            trend(ind._cpuPercent, ind._cardPrev.cpu);
        const ramNow = memory && memory.totalMb > 0
            ? percentOf(memory.usedMb, memory.totalMb) : null;
        cards.mem.title.text = cards.mem.baseTitle +
            (ramNow === null ? '' : trend(ramNow, ind._cardPrev.mem));
        ind._cardPrev.cpu = ind._cpuPercent;
        if (ramNow !== null)
            ind._cardPrev.mem = ramNow;

        sparkline.setSparkValue(ind, ind._cpuPercent,
            ind._memory && ind._memory.totalMb > 0
                ? percentOf(ind._memory.usedMb, ind._memory.totalMb)
                : 0);

        const third = cards.third;
        third.barBox.visible = cards.thirdKind === 'gpu';
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
                : _('Sampling…');
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
        // group headers carry a live summary too — an empty right side
        // reads as broken, a filled one reads as a glanceable instrument
        const groups = ind._groups ?? {};
        if (groups.procs) {
            const first = (ind._processes ?? new Map()).size;
            ind._setSectionSummary(groups.procs,
                _n('%s process', '%s processes', first).format(iso(first)));
        }
        if (groups.memory) {
            const memory = ind._memory;
            if (memory && memory.totalMb > 0)
                ind._setSectionSummary(groups.memory,
                    `${iso((memory.usedMb / 1024).toFixed(1))}/${iso((memory.totalMb / 1024).toFixed(1))} GB`);
        }
        renderSensorsGroupSummary(ind, groups.sensors);
        renderStorageGroupSummary(ind, groups.storage);
        if (groups.graphics) {
            const gpu = (ind._sensors?.gpus ?? [])[0];
            if (gpu && gpu.usagePercent !== null)
                ind._setSectionSummary(groups.graphics, `${iso(gpu.usagePercent)}%`);
        }
        renderPressureGroupSummary(ind, groups.psi);
    }

function renderSensorsGroupSummary(ind, group) {
        if (!group)
            return;
        const temps = ind._temperatures ?? [];
        if (temps.length > 0) {
            const hottest = Math.max(...temps.map(t => t.celsius));
            ind._setSectionSummary(group, `${iso(Math.round(hottest))}°C`);
        } else if (ind._battery) {
            ind._setSectionSummary(group, `${iso(ind._battery.percent)}%`);
        }
    }

function renderStorageGroupSummary(ind, group) {
        if (!group)
            return;
        const net = ind._ioRates?.net ?? [];
        if (net.length > 0) {
            const rx = net.reduce((sum, rate) => sum + (rate.rxPerSecond ?? 0), 0);
            ind._setSectionSummary(group,
                `${_('↓ %s').format(iso(formatRate(rx)))}`);
        } else if ((ind._fsData ?? []).length > 0) {
            const fullest = (ind._fsData ?? [])
                .reduce((max, fs) => Math.max(max, fs.percent ?? 0), 0);
            ind._setSectionSummary(group, `${iso(Math.round(fullest))}%`);
        }
    }

function renderPressureGroupSummary(ind, group) {
        if (!group)
            return;
        const psi = ind._sensors?.psi ?? {};
        const peak = Math.max(0, ...Object.values(psi).map(v => v?.some?.avg10 ?? 0));
        if (peak > 0)
            ind._setSectionSummary(group, _('some %s').format(iso(peak.toFixed(2))));
    }

export function renderIo(ind) {
        const cards = ind._ui.cards;
        if (cards.thirdKind === 'disk') {
            const rates = ind._ioRates?.disk;
            cards.third.value.text = rates
                ? `${_('↓ %s · ↑ %s').format(iso(formatRate(rates.readPerSecond)),
                    iso(formatRate(rates.writePerSecond)))}`
                : _('Sampling…');
            // a speed has no 0–100 fill; the bar belongs to the GPU card only
            cards.third.barBox.visible = false;
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
                : _('Sampling…');
        });
    }

export function updatePanelLabel(ind) {
        const ramPercent = ind._memory
            ? percentOf(ind._memory.usedMb, ind._memory.totalMb) : 0;
        const wanted = new Set(parsePanelItems(ind._settings.get_string('panel-items')));
        const values = {
            cpu: {text: `${_('CPU')} ${iso(Math.round(ind._cpuPercent))}%`,
                value: ind._cpuPercent},
            ram: {text: `${_('RAM')} ${iso(Math.round(ramPercent))}%`,
                value: ramPercent},
            temp: null,
        };
        const celsius = ind._panelTemperature();
        if (celsius !== null)
            values.temp = {text: `${iso(Math.round(celsius))}°C`, value: celsius};
        // one label per item, coloured by its own attention level, so a hot
        // RAM readout never paints a calm CPU readout amber
        for (const item of ['cpu', 'temp', 'ram']) {
            const label = ind._panelItems?.[item];
            if (!label)
                continue;
            const entry = wanted.has(item) ? values[item] : null;
            label.visible = Boolean(entry);
            if (!entry)
                continue;
            label.text = entry.text;
            const level = panelLevel(item, entry.value);
            label.style_class = level === 'ok'
                ? 'procmon-label'
                : `procmon-label procmon-label-${level}`;
        }
    }

    // ----- sparkline + threshold alerts ------------------------------------

export function renderMemorySection(ind) {
    const ui = ind._ui?.memory;
    if (!ui)
        return;
    const memory = ind._memory;
        if (!memory) {
            ui.section.hintLabel.text = _('Waiting for memory sample…');
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
