import Clutter from 'gi://Clutter';
import St from 'gi://St';
import {_} from './constants.js';


export function addCard(ind, cardsRow, titleText, valueClass) {
        const card = new St.BoxLayout({
            vertical: true,
            style_class: 'procmon-card',
            x_expand: true,
        });
        const title = new St.Label({text: titleText, style_class: 'procmon-card-title'});
        card.add_child(title);
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
        return {card, value, fill, barBox, title, baseTitle: titleText};
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
