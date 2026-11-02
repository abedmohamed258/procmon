import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Gettext from 'gettext';
import {assessKillProcess, averageFrequencyGhz, collectFans, collectTemperatures, collectVoltages, computeCoreShares, computeCpuShares, computeDiskRates, computeNetRates, formatBytes, formatDuration, formatRate, groupProcesses, isFiniteRect, isPointInsideRect, ownedProcessEntries, parseBatteryDetails, parseCoreTicks, parseCpuTicks, parseDiskStats, parseGpuCard, parseLoadAvg, parseMemInfo, parseNetDev, parsePsi, parseStatLine, parseUptime} from '../lib/proc.js';
import { FIRST_SAMPLE_MS, IO_WARMUP_MS, EXIT_CHECK_MS, TEMPERATURE_CACHE_MS, ALERT_COOLDOWN_MS, SPARK_SAMPLES, SPARKLINE_WIDTH, iso, _, _n, MAX_TEMPERATURES, MAX_FILESYSTEMS, PSI_RESOURCES, FALLBACK_PROCESS_ICON } from './constants.js';


export function addCard(ind, cardsRow, titleText, valueClass) {
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

export function ensureThirdCard(ind, cardsRow) {
        const kind = (ind._sensors?.gpus?.length ?? 0) > 0 ? 'gpu' : 'disk';
        if (ind._ui.cards.third && ind._ui.cards.thirdKind === kind)
            return;
        if (ind._ui.cards.third)
            ind._ui.cards.third.card.destroy();
        ind._ui.cards.third = kind === 'gpu'
            ? ind._addCard(cardsRow, _('Graphics'), 'procmon-card-value procmon-value-compact')
            : ind._addCard(cardsRow, _('Disk'), 'procmon-card-value procmon-value-compact');
        ind._ui.cards.thirdKind = kind;
    }

export function addSummaryCards(ind, content) {
        const cardsRow = new St.BoxLayout({style_class: 'procmon-cards', x_expand: true});
        ind._ui.cards = {
            cpu: ind._addCard(cardsRow, _('Processor'), 'procmon-card-value'),
            mem: ind._addCard(cardsRow, _('Memory'), 'procmon-card-value'),
            third: null,
            thirdKind: 'disk',
        };
        ind._ensureThirdCard(cardsRow);
        content.add_child(cardsRow);
        ind._ui.cardsRow = cardsRow;
    }
