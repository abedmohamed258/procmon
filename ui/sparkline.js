import St from 'gi://St';
import Gettext from 'gettext';
import {assessKillProcess, averageFrequencyGhz, collectFans, collectTemperatures, collectVoltages, computeCoreShares, computeCpuShares, computeDiskRates, computeNetRates, formatBytes, formatDuration, formatRate, groupProcesses, isFiniteRect, isPointInsideRect, ownedProcessEntries, parseBatteryDetails, parseCoreTicks, parseCpuTicks, parseDiskStats, parseGpuCard, parseLoadAvg, parseMemInfo, parseNetDev, parsePsi, parseStatLine, parseUptime} from '../lib/proc.js';
import { FIRST_SAMPLE_MS, IO_WARMUP_MS, EXIT_CHECK_MS, TEMPERATURE_CACHE_MS, ALERT_COOLDOWN_MS, SPARK_SAMPLES, SPARKLINE_WIDTH, SPARKLINE_HEIGHT, iso, _, _n, MAX_TEMPERATURES, MAX_FILESYSTEMS, PSI_RESOURCES, FALLBACK_PROCESS_ICON } from './constants.js';


export function addSparkline(ind, content) {
        ind._sparkValue = new St.Label({
            text: '',
            style_class: 'procmon-sparkline-value',
        });
        content.add_child(ind._sparkValue);
        const area = new St.DrawingArea({
            style_class: 'procmon-sparkline',
            width: SPARKLINE_WIDTH,
            height: SPARKLINE_HEIGHT,
        });
        area.connect('repaint', area => ind._paintSparkline(area));
        ind._sparkArea = area;
        content.add_child(area);
    }

export function paintSparkline(ind, area) {
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
        const usableHeight = height - 2 * inset;
        const bottom = height - inset;
        // gridlines
        cr.setSourceRGBA(0.5, 0.5, 0.5, 0.35);
        cr.setLineWidth(0.5);
        for (const pct of [0, 25, 50, 75, 100]) {
            const y = bottom - pct / 100 * usableHeight;
            cr.moveTo(inset, y);
            cr.lineTo(width - inset, y);
            cr.stroke();
        }
        ind._drawSparkSeries(cr, width, height, inset, ind._cpuHistory,
            94 / 255, 160 / 255, 255 / 255, 0.9);
        ind._drawSparkSeries(cr, width, height, inset, ind._ramHistory,
            46 / 255, 194 / 255, 126 / 255, 0.8);
        cr.$dispose();
    }

function sparkGeometry(width, height, inset, count) {
        const usableWidth = width - 2 * inset;
        const usableHeight = height - 2 * inset;
        const bottom = height - inset;
        const span = usableWidth / (SPARK_SAMPLES - 1);
        const start = inset + (SPARK_SAMPLES - count) * span;
        const toY = value => bottom - Math.min(100, Math.max(0, value)) / 100 * usableHeight;
        return {bottom, span, start, toY};
    }

function drawSparkFill(cr, start, bottom, span, count, points, toY, red, green, blue, height, inset) {
        const gradient = cr.createLinearGradient(0, inset, 0, height - inset);
        gradient.addColorStopRGBA(0, red, green, blue, 0.25);
        gradient.addColorStopRGBA(1, red, green, blue, 0.02);
        cr.setSource(gradient);
        cr.moveTo(start, bottom);
        points.forEach((value, index) =>
            cr.lineTo(start + index * span, toY(value)));
        cr.lineTo(start + (count - 1) * span, bottom);
        cr.closePath();
        cr.fill();
    }

function drawSparkStroke(cr, start, span, count, points, toY, red, green, blue, lineAlpha) {
        cr.setSourceRGBA(red, green, blue, lineAlpha);
        cr.setLineWidth(1.5);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.moveTo(start, toY(points[0]));
        for (let index = 1; index < count; index++) {
            const prevX = start + (index - 1) * span;
            const prevY = toY(points[index - 1]);
            const currX = start + index * span;
            const currY = toY(points[index]);
            const cpx = (prevX + currX) / 2;
            const cpy = (prevY + currY) / 2;
            cr.quadraticCurveTo(cpx, cpy, currX, currY);
        }
        cr.stroke();
    }

export function drawSparkSeries(ind, cr, width, height, inset, history, red, green, blue, lineAlpha) {
        const points = history.slice(-SPARK_SAMPLES);
        const count = points.length;
        if (count < 2)
            return;
        const {bottom, span, start, toY} = sparkGeometry(width, height, inset, count);
        drawSparkFill(cr, start, bottom, span, count, points, toY, red, green, blue, height, inset);
        drawSparkStroke(cr, start, span, count, points, toY, red, green, blue, lineAlpha);
    }

    // Smart notifications. Rules:
    //  - notify only on the rising edge of a level (94 → 97 → 99);
    //  - a reminder at most once per ALERT_COOLDOWN_MS while ignored;
    //  - "Details" or simply opening the menu = the user knows: silence
    //    until the condition clears, which re-arms the alert;
    //  - escalation always breaks the silence (it is new information).

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

        // repaint only pays off while the menu is visible
        if (ind.menu.isOpen && ind._sparkArea)
            ind._sparkArea.queue_repaint();
    }

    // St.DrawingArea in GNOME 46 passes NO cairo context through the repaint
    // signal; the handler fetches its own context and must dispose it after.
