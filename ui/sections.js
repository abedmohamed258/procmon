import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import {_} from './constants.js';


function buildGroupHeader(ind, title, options, open) {
        const headerRow = new St.BoxLayout({style_class: 'procmon-group-header'});
        if (options.icon)
            headerRow.add_child(new St.Icon({
                icon_name: options.icon,
                style_class: 'procmon-group-icon',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        headerRow.add_child(new St.Label({
            text: title,
            style_class: 'procmon-group-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const summary = new St.Label({
            text: '',
            style_class: 'procmon-group-summary',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerRow.add_child(summary);
        const chevron = new St.Label({
            text: open ? '▾' : '▸',
            style_class: 'procmon-group-chevron',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerRow.add_child(chevron);
        const header = new St.Button({
            style_class: 'procmon-group-header-btn',
            can_focus: true,
            child: headerRow,
        });
        return {headerRow, summary, chevron, header};
    }

function buildGroupBody(open) {
        const box = new St.BoxLayout({vertical: true, style_class: 'procmon-group-body'});
        box.visible = open;
        return box;
    }

export function addGroup(ind, content, title, options = {}) {
        const id = options.id ?? title;
        const open = ind._openSections.has(id);

        const card = new St.BoxLayout({vertical: true, style_class: 'procmon-group'});
        const {summary, chevron, header} = buildGroupHeader(ind, title, options, open);
        const box = buildGroupBody(open);
        card.add_child(header);
        card.add_child(box);

        const group = {id, box, header, summary, chevron, open};
        header.connect('button-press-event', () => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (!ind._destroyed)
                    ind._toggleGroup(group);
                return GLib.SOURCE_REMOVE;
            });
            return Clutter.EVENT_STOP;
        });
        content.add_child(card);
        return group;
    }

export function toggleGroup(ind, group) {
        group.open = !group.open;
        group.chevron.text = group.open ? '▾' : '▸';
        group.box.visible = group.open;
        if (group.open) {
            group.box.opacity = 0;
            group.box.ease({
                duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                opacity: 255,
            });
        }
        if (group.open) {
            ind._openSections.add(group.id);
            ind._renderValues();
        } else {
            ind._openSections.delete(group.id);
        }
    }

    // ----- startup apps & user services ---------------------------------

function buildSectionHeader(ind, titleText, sub, open) {
        const headerRow = new St.BoxLayout({
            style_class: sub ? 'procmon-sub-header' : 'procmon-acc-header',
        });
        const title = new St.Label({
            text: titleText,
            style_class: sub ? 'procmon-sub-title' : 'procmon-acc-title',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const summary = new St.Label({
            text: '',
            style_class: sub ? 'procmon-sub-summary' : 'procmon-acc-summary',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const chevron = new St.Label({
            text: open ? '▾' : '▸',
            style_class: sub ? 'procmon-sub-chevron' : 'procmon-acc-chevron',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerRow.add_child(title);
        headerRow.add_child(new St.Widget({x_expand: true}));
        headerRow.add_child(summary);
        headerRow.add_child(chevron);
        const header = new St.Button({
            style_class: sub ? 'procmon-sub-header-btn' : 'procmon-acc-header-btn',
            can_focus: true,
            child: headerRow,
        });
        return {title, summary, chevron, header, headerRow};
    }

function buildSectionBody(sub, hint, open) {
        const box = new St.BoxLayout({
            vertical: true,
            style_class: sub ? 'procmon-sub-body' : 'procmon-acc-body',
        });
        const hintLabel = new St.Label({text: hint, style_class: 'procmon-hint'});
        box.add_child(hintLabel);
        if (!open)
            box.visible = false;
        return {box, hintLabel};
    }

export function addSection(ind, content, titleText, hint, options = {}) {
        const id = options.id ?? titleText;
        const level = options.level ?? 1;
        const open = ind._openSections.has(id);
        const sub = level === 2;

        const card = new St.BoxLayout({
            vertical: true,
            style_class: sub ? 'procmon-sub-card' : 'procmon-acc-card',
        });
        const {summary, chevron, header} = buildSectionHeader(ind, titleText, sub, open);
        const {box, hintLabel} = buildSectionBody(sub, hint, open);
        card.add_child(header);
        card.add_child(box);

        const section = {id, box, lines: [], hintLabel, summary, open, header, chevron};
        header.connect('button-press-event', () => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (!ind._destroyed)
                    ind._toggleSection(section);
                return GLib.SOURCE_REMOVE;
            });
            return Clutter.EVENT_STOP;
        });
        content.add_child(card);
        return section;
    }

export function toggleSection(ind, section) {
        const open = !section.open;
        section.open = open;
        section.chevron.text = open ? '▾' : '▸';
        if (open) {
            section.box.visible = true;
            section.box.opacity = 0;
            section.box.ease({
                duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                opacity: 255,
            });
            ind._openSections.add(section.id);
            // fill the newly revealed body at once instead of showing a
            // half-painted section that only catches up on the next tick
            ind._renderValues();
        } else {
            section.box.visible = false;
            ind._openSections.delete(section.id);
        }
    }

    // ----- grouped navigation (level 1) -----------------------------------
    // A group is a collapsible container; the sections inside keep their own
    // headers and behaviour, so the renderers stay untouched.

function buildScrollItem(content) {
        const scroll = new St.ScrollView({
            style_class: 'procmon-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
        });
        scroll.set_child(content);
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'procmon-scroll-item',
        });
        item.add_child(scroll);
        return item;
    }

function buildOpenButton(ind) {
        const openBtn = new St.Button({
            style_class: 'procmon-footer-btn',
            can_focus: true,
            x_expand: true,
        });
        const openRow = new St.BoxLayout({vertical: false});
        openRow.add_child(new St.Icon({
            icon_name: 'utilities-system-monitor-symbolic',
            style_class: 'procmon-footer-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        openRow.add_child(new St.Label({
            text: _('Open System Monitor'),
            style_class: 'procmon-footer-label',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        openBtn.set_child(openRow);
        openBtn.connect('clicked', () => {
            ind.menu.close();
            ind._openSystemMonitor();
        });
        return openBtn;
    }

function buildRefreshButton(ind) {
        const refreshBtn = new St.Button({
            style_class: 'procmon-footer-btn',
            can_focus: true,
            x_expand: true,
        });
        const refreshRow = new St.BoxLayout({vertical: false});
        refreshRow.add_child(new St.Icon({
            icon_name: 'view-refresh-symbolic',
            style_class: 'procmon-footer-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        refreshRow.add_child(new St.Label({
            text: _('Refresh'),
            style_class: 'procmon-footer-label',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        refreshBtn.set_child(refreshRow);
        refreshBtn.connect('button-press-event', () => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (!ind._destroyed)
                    void ind._sampleMenuData();
                return GLib.SOURCE_REMOVE;
            });
            return Clutter.EVENT_STOP;
        });
        return refreshBtn;
    }

function buildFooter(ind) {
        const footerItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'procmon-scroll-item',
        });
        const footer = new St.BoxLayout({style_class: 'procmon-footer'});
        footer.add_child(buildOpenButton(ind));
        footer.add_child(buildRefreshButton(ind));
        footerItem.add_child(footer);
        return footerItem;
    }

export function mountContent(ind, content) {
        const item = buildScrollItem(content);
        ind.menu.addMenuItem(item);
        const footerItem = buildFooter(ind);
        ind.menu.addMenuItem(footerItem);
    }

function createOptionalGroups(ind, content) {
        const wants = id => ind._wantsSection(id);
        const wantsProc = wants('processes');
        const groups = {};

        if (wantsProc)
            groups.procs = ind._addGroup(content, _('Top processes'),
                {id: 'processes', icon: 'view-list-symbolic'});
        if (wants('memory'))
            groups.memory = ind._addGroup(content, _('Memory'),
                {id: 'memory', icon: 'media-flash-symbolic'});

        const wantsSensors = wants('temperatures') || wants('fans') ||
            wants('voltages') || wants('battery');
        if (wantsSensors)
            groups.sensors = ind._addGroup(content, _('Sensors'),
                {id: 'sensors', icon: 'temperature-symbolic'});

        if (wants('disk') || wants('network'))
            groups.storage = ind._addGroup(content, _('Storage & network'),
                {id: 'storage', icon: 'drive-harddisk-symbolic'});

        if (wants('gpu'))
            groups.graphics = ind._addGroup(content, _('Graphics'),
                {id: 'graphics', icon: 'video-display-symbolic'});

        groups.startup = ind._addGroup(content, _('Startup'),
            {id: 'startup', icon: 'emblem-system-symbolic'});

        if (wants('psi'))
            groups.psi = ind._addGroup(content, _('Pressure'),
                {id: 'psi', icon: 'speedometer-symbolic'});

        return {groups, wants, wantsProc, wantsSensors};
    }

function addOptionalSectionBodies(ind, groups, wants) {
        if (groups.procs)
            ind._addTopCpuSection(groups.procs.box);
        if (groups.procs)
            ind._addTopMemSection(groups.procs.box);
        if (groups.memory)
            ind._addMemorySection(groups.memory.box);

        if (groups.sensors) {
            ind._ui.temperature = ind._addSection(groups.sensors.box, _('Temperature'),
                _('No temperature sensors'), {id: 'temperatures', level: 2});
            ind._ui.fans = ind._addSection(groups.sensors.box, _('Fans'),
                _('No fan sensors'), {id: 'fans', level: 2});
            ind._ui.voltages = ind._addSection(groups.sensors.box, _('Voltage'),
                _('No voltage sensors'), {id: 'voltages', level: 2});
            if (wants('battery'))
                ind._ui.battery = ind._addBatterySection(groups.sensors.box);
        }

        if (groups.storage && wants('network'))
            ind._ui.network = ind._addSection(groups.storage.box, _('Network'),
                _('No network interfaces'), {id: 'network', level: 2});
        if (groups.storage && wants('disk'))
            ind._ui.filesystems = ind._addSection(groups.storage.box, _('Disk usage'),
                _('No filesystems'), {id: 'disk', level: 2});

        if (groups.graphics)
            ind._ui.graphics = ind._addSection(groups.graphics.box, _('GPU'),
                _('No GPU sensors'), {id: 'graphics', level: 2});
        ind._addStartupSection(groups.startup.box);
        if (groups.psi)
            ind._ui.psi = ind._addPsiSection(groups.psi.box);
    }

export function addOptionalSections(ind, content) {
        const {groups, wants} = createOptionalGroups(ind, content);
        addOptionalSectionBodies(ind, groups, wants);
    }

    // wraps the assembled content in the scroll item plus the static actions

export function addHeader(ind, content) {
        const header = new St.BoxLayout({style_class: 'procmon-header'});
        const mark = ind._procmonGIcon();
        header.add_child(mark
            ? new St.Icon({gicon: mark, style_class: 'procmon-header-icon',
                y_align: Clutter.ActorAlign.CENTER})
            : new St.Icon({icon_name: 'utilities-system-monitor-symbolic',
                style_class: 'procmon-header-icon',
                y_align: Clutter.ActorAlign.CENTER}));
        header.add_child(new St.Label({
            text: _('ProcMon'),
            style_class: 'procmon-title',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const prefsBtn = new St.Button({
            style_class: 'procmon-header-btn',
            can_focus: true,
            child: new St.Icon({
                icon_name: 'emblem-system-symbolic',
                style_class: 'procmon-header-icon',
                y_align: Clutter.ActorAlign.CENTER,
            }),
        });
        prefsBtn.accessible_name = _('Preferences');
        prefsBtn.connect('clicked', () => ind._openPrefs());
        header.add_child(prefsBtn);
        header.add_child(new St.Widget({x_expand: true}));
        content.add_child(header);

        ind._ui.meta = new St.Label({
            text: '',
            style_class: 'procmon-meta',
        });
        content.add_child(ind._ui.meta);
    }
