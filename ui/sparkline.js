import Clutter from 'gi://Clutter';
import St from 'gi://St';
import {SPARK_SAMPLES, percentOf} from './constants.js';

// The chart is drawn with plain St widgets on purpose: a Cairo surface inside
// a popup was the one code path that consistently crashed gnome-shell
// (libmutter segfault) on this box, and a bar strip conveys the same trend.
const BAR_COUNT = 48;
const BAR_MAX_HEIGHT = 26;

export function addSparkline(ind, content) {
    ind._sparkValue = new St.Label({
        text: '',
        style_class: 'procmon-sparkline-value',
    });
    content.add_child(ind._sparkValue);

    const bars = new St.BoxLayout({
        style_class: 'procmon-sparkbars',
        x_expand: true,
    });
    ind._sparkBars = [];
    for (let i = 0; i < BAR_COUNT; i++) {
        const bar = new St.Widget({
            style_class: 'procmon-sparkbar',
            y_align: Clutter.ActorAlign.END,
        });
        bar.style = 'height: 1px;';
        bars.add_child(bar);
        ind._sparkBars.push(bar);
    }
    ind._sparkArea = bars;
    content.add_child(bars);
}

export function paintSparkline(ind) {
    const bars = ind._sparkBars;
    if (!bars)
        return;
    const history = ind._cpuHistory.slice(-bars.length);
    const offset = bars.length - history.length;
    bars.forEach((bar, index) => {
        const value = history[index - offset];
        const height = Number.isFinite(value)
            ? Math.max(1, Math.round(value / 100 * BAR_MAX_HEIGHT))
            : 1;
        bar.style = `height: ${height}px;`;
    });
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
