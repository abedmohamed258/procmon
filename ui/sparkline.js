// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Abed Mohamed

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import {SPARK_SAMPLES, percentOf, _} from './constants.js';

// The chart is drawn with plain St widgets on purpose: a Cairo surface inside
// a popup was the one code path that consistently crashed gnome-shell
// (libmutter segfault) on this box, and a bar strip conveys the same trend.
// Two rows: tall blue CPU bars, short green RAM bars beneath — both series
// come from the same sample instants, so the rows stay comparable.
const BAR_COUNT = 48;
const BAR_MAX_HEIGHT = 26;
const RAM_BAR_MAX_HEIGHT = 10;

function buildBarRow(styleClass, barClass, maxHeight) {
    const bars = new St.BoxLayout({
        style_class: styleClass,
        x_expand: true,
    });
    const widgets = [];
    for (let i = 0; i < BAR_COUNT; i++) {
        const bar = new St.Widget({
            style_class: barClass,
            y_align: Clutter.ActorAlign.END,
        });
        bar.style = 'height: 1px;';
        bars.add_child(bar);
        widgets.push(bar);
    }
    return {bars, widgets, maxHeight};
}

export function addSparkline(ind, content) {
    ind._sparkValue = new St.Label({
        text: '',
        style_class: 'procmon-sparkline-value',
    });
    content.add_child(ind._sparkValue);

    // legend: colour chips so the two bar rows are never ambiguous
    const legend = new St.BoxLayout({style_class: 'procmon-legend'});
    for (const [cls, word] of [['procmon-legend-dot-cpu', _('CPU')],
        ['procmon-legend-dot-ram', _('RAM')]]) {
        const chip = new St.BoxLayout({style_class: 'procmon-legend-chip'});
        chip.add_child(new St.Widget({style_class: `procmon-legend-dot ${cls}`}));
        chip.add_child(new St.Label({text: word, style_class: 'procmon-legend-label'}));
        legend.add_child(chip);
    }
    content.add_child(legend);

    const cpu = buildBarRow('procmon-sparkbars', 'procmon-sparkbar', BAR_MAX_HEIGHT);
    const ram = buildBarRow('procmon-sparkbars procmon-sparkbars-ram',
        'procmon-sparkbar procmon-sparkbar-ram', RAM_BAR_MAX_HEIGHT);
    ind._sparkBars = cpu.widgets;
    ind._sparkRamBars = ram.widgets;
    ind._sparkCpuRow = cpu;
    ind._sparkRamRow = ram;
    ind._sparkArea = cpu.bars;
    content.add_child(cpu.bars);
    content.add_child(ram.bars);
}

function paintRow(row, history) {
    const bars = row.widgets;
    const samples = history.slice(-bars.length);
    const offset = bars.length - samples.length;
    bars.forEach((bar, index) => {
        const value = samples[index - offset];
        const height = Number.isFinite(value)
            ? Math.max(1, Math.round(value / 100 * row.maxHeight))
            : 1;
        bar.style = `height: ${height}px;`;
    });
}

export function paintSparkline(ind) {
    if (ind._sparkCpuRow)
        paintRow(ind._sparkCpuRow, ind._cpuHistory);
    if (ind._sparkRamRow)
        paintRow(ind._sparkRamRow, ind._ramHistory);
}

export function recordSparkSample(ind) {
    if (!ind._settings.get_boolean('show-sparkline'))
        return;
    if (Number.isFinite(ind._cpuPercent)) {
        ind._cpuHistory.push(Math.min(100, Math.max(0, ind._cpuPercent)));
        if (ind._cpuHistory.length > SPARK_SAMPLES)
            ind._cpuHistory.shift();
    }

    const memory = ind._memory;
    const ramPercent = memory && memory.totalMb > 0
        ? percentOf(memory.usedMb, memory.totalMb) : null;
    if (ramPercent !== null) {
        ind._ramHistory.push(Math.min(100, Math.max(0, ramPercent)));
        if (ind._ramHistory.length > SPARK_SAMPLES)
            ind._ramHistory.shift();
    }

    if (ind.menu.isOpen)
        paintSparkline(ind);
}
