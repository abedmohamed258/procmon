// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Abed Mohamed

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import {SPARK_SAMPLES, percentOf, iso} from './constants.js';

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
    // one row, two coloured labels: the colour IS the legend (blue = CPU,
    // green = RAM) — no separate legend chips, no extra row
    const row = new St.BoxLayout({style_class: 'procmon-sparkline-row'});
    ind._sparkCpu = new St.Label({
        text: '',
        style_class: 'procmon-spark-value-cpu',
    });
    ind._sparkRam = new St.Label({
        text: '',
        style_class: 'procmon-spark-value-ram',
    });
    row.add_child(ind._sparkCpu);
    row.add_child(new St.Label({
        text: '·',
        style_class: 'procmon-spark-sep',
    }));
    row.add_child(ind._sparkRam);
    content.add_child(row);

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

// The value line is the legend: blue says CPU, green says RAM.
export function setSparkValue(ind, cpuPercent, ramPercent) {
    if (ind._sparkCpu)
        ind._sparkCpu.text = `${iso(Math.round(cpuPercent))}% CPU`;
    if (ind._sparkRam)
        ind._sparkRam.text = `${iso(Math.round(ramPercent))}% RAM`;
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
