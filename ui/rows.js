// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Abed Mohamed

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {groupProcesses} from '../lib/proc.js';
import {iso, _n, FALLBACK_PROCESS_ICON} from './constants.js';


export function makeLineRow(ind, box) {
        const row = new St.BoxLayout({style_class: 'procmon-line', x_expand: true});
        const name = new St.Label({
            text: '',
            style_class: 'procmon-line-name',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const value = new St.Label({
            text: '',
            style_class: 'procmon-line-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(name);
        row.add_child(value);
        box.add_child(row);
        return {row, name, value};
    }

    // grows or shrinks a line list to `wanted` entries without rebuilding rows

function createProcessRowFields(row) {
        const icon = new St.Icon({
            icon_name: FALLBACK_PROCESS_ICON,
            style_class: 'procmon-row-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(icon);
        const name = new St.Label({
            text: '',
            style_class: 'procmon-row-name',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(name);
        const count = new St.Label({
            text: '',
            style_class: 'procmon-group-count',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(count);
        const value = new St.Label({
            text: '',
            style_class: 'procmon-row-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        value.x_align = Clutter.ActorAlign.END;
        row.add_child(value);
        return {icon, name, count, value};
    }

function addProcessRowSlots(ind, box, i, rows) {
        const row = new St.BoxLayout({
            style_class: 'procmon-row',
            x_expand: true,
            can_focus: true,
        });
        box.add_child(row);

        const {icon, name, count, value} = createProcessRowFields(row);
        const kill = new St.Button({
            style_class: 'procmon-kill',
            can_focus: true,
            child: new St.Label({
                text: '×',
                style_class: 'procmon-kill-label',
                y_align: Clutter.ActorAlign.CENTER,
            }),
        });
        connectProcessRowKill(ind, kill, i, rows);
        row.add_child(kill);

        rows[i] = {row, icon, name, count, value, kill, entry: null};
    }

function connectProcessRowKill(ind, kill, i, rows) {
        kill.connect('button-press-event', (actor, event) => {
            const group = rows[i].entry;
            const button = event.get_button();
            if (group) {
                const idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    ind._timeouts.delete(idleId);
                    if (ind.menu && !ind._destroyed)
                        ind._onKillRequest(group, button === 3 ? 'KILL' : 'TERM');
                    return GLib.SOURCE_REMOVE;
                });
                ind._timeouts.add(idleId);
            }
            return Clutter.EVENT_STOP;
        });
    }

export function makeProcessRows(ind, box) {
        const rows = [];
        for (let i = 0; i < ind._topRows; i++)
            addProcessRowSlots(ind, box, i, rows);
        return rows;
    }

export function setRowIcon(ind, row, group) {
        if (row.icon.forProcessName === group.name)
            return;
        row.icon.forProcessName = group.name;
        // every row keeps an icon slot; an unresolved app icon must not leave
        // a hole that makes the name look indented differently
        row.icon.gicon = ind._iconForGroup(group) ??
            Gio.ThemedIcon.new(FALLBACK_PROCESS_ICON);
    }

export function iconForGroup(ind, group) {
        const key = group.name;
        if (!ind._iconCache.has(key)) {
            const appSystem = Shell.AppSystem.get_default();
            let gicon = null;
            for (const app of appSystem.get_running()) {
                if (group.pids.some(pid => app.get_pids().includes(pid))) {
                    gicon = app.get_app_info()?.get_icon() ?? null;
                    break;
                }
            }
            if (!gicon) {
                const app = appSystem.lookup_app(`${key}.desktop`) ??
                    appSystem.lookup_startup_wmclass(key);
                gicon = app?.get_app_info()?.get_icon() ?? null;
            }
            ind._iconCache.set(key, gicon);
        }
        return ind._iconCache.get(key) ?? null;
    }

export function renderProcessRows(ind) {
        const rows = ind._ui.processRows;
        if (!rows)
            return;
        // while the pointer rests on the menu, rows stay put so clicks land
        if (ind._rowsPopulated && ind._pointerInsideMenu())
            return;

        const shares = ind._menuShares;
        const processes = ind._processes ?? new Map();
        const entries = [...processes.values()]
            .map(entry => ({...entry, cpu: shares?.cpu.get(entry.pid) ?? 0}));
        // both lists are cut independently from the full sample; clipping the
        // cpu list first would drop RAM-heavy groups out of the RAM view
        const {groups: cpuList} = groupProcesses(entries, ind._topRows);
        const {groups: ramList} = groupProcesses(entries, ind._topRows, 'rss');

        ind._paintProcessRows(rows.byCpu, cpuList,
            group => `${iso(group.cpuSum.toFixed(1))}%`, group => group.cpuSum > 50);
        ind._paintProcessRows(rows.byRam, ramList,
            group => `${iso(Math.round(group.rssKbSum / 1024))} MB`, () => false);
        if (ind._ui.processSection)
            ind._ui.processSection.hintLabel.visible = entries.length === 0;
        ind._rowsPopulated = true;
    }

export function paintProcessRows(ind, rows, entries, valueFor, highlightFor) {
        if (entries.length !== rows.length)
            ind._syncRowsVisibility(rows, entries.length);
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const group = entries[i];
            if (!group) {
                row.row.visible = false;
                row.entry = null;
                continue;
            }
            row.row.visible = true;
            // keyed by name+count so a rebuilt pid array never churns the row;
            // text/icon/value/count repaint in place, no rebuild needed
            if (row.entry?.name !== group.name || row.entry?.count !== group.count) {
                row.name.text = group.name;
                row.kill.accessible_name = _n('Terminate %s (%d process)',
                    'Terminate %s (%d processes)',
                    group.count).format(group.name, iso(group.count));
                ind._setRowIcon(row, group);
            }
            row.value.text = valueFor(group);
            row.count.text = group.count > 1 ? `×${iso(group.count)}` : '';
            // an empty pill is chrome noise: hide the badge entirely for
            // single-process rows instead of leaving a blank capsule
            row.count.visible = group.count > 1;
            row.value.style_class = highlightFor(group)
                ? 'procmon-row-value procmon-row-value-high'
                : 'procmon-row-value';
            row.entry = group;
        }
    }

export function syncRowsVisibility(ind, rows, expected) {
        for (let i = 0; i < rows.length; i++) {
            if (i < expected)
                continue;
            rows[i].row.visible = false;
            rows[i].entry = null;
        }
    }
