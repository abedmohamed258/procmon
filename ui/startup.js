import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {_} from './constants.js';

// A section belongs to one menu build. Any async fill that returns after the
// menu was rebuilt (or the indicator destroyed) must not touch its actors —
// St raises "already disposed" storms in the journal otherwise.
function sectionAlive(ind, section, generation) {
    if (ind._destroyed || generation !== (ind._menuGeneration ?? 0))
        return false;
    try {
        return Boolean(section?.box?.get_parent());
    } catch {
        return false;
    }
}


export function addStartupSection(ind, box) {
        const generation = ind._menuGeneration ?? 0;
        const apps = ind._addSection(box, _('Autostart apps'), _('No entries'),
            {id: 'startup-apps', level: 2});
        const entries = ind._readAutostartEntries();
        for (const entry of entries)
            apps.box.add_child(ind._makeStartupRow(entry));
        apps.hintLabel.visible = entries.length === 0;

        const services = ind._addSection(box, _('User services'), _('Loading…'),
            {id: 'startup-services', level: 2});
        void ind._fillServices(services, generation);
    }

export function makeStartupRow(ind, entry) {
        const row = new St.BoxLayout({style_class: 'procmon-line', x_expand: true});
        const name = new St.Label({
            text: entry.name,
            style_class: 'procmon-line-name',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(name);
        const source = new St.Label({
            text: entry.origin === 'user' ? _('user') : _('system'),
            style_class: 'procmon-startup-src',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(source);
        const btn = ind._makeToggleButton(!entry.hidden);
        btn.connect('button-press-event', () => {
            const active = ind._toggleAutostart(entry);
            ind._syncToggleButton(btn, active);
            return Clutter.EVENT_STOP;
        });
        row.add_child(btn);
        return row;
    }

export function makeToggleButton(ind, active) {
        const btn = new St.Button({
            style_class: 'procmon-toggle',
            can_focus: true,
            child: new St.Label({
                text: active ? _('On') : _('Off'),
                style_class: 'procmon-toggle-label',
                y_align: Clutter.ActorAlign.CENTER,
            }),
        });
        ind._syncToggleButton(btn, active);
        return btn;
    }

export function syncToggleButton(ind, btn, active) {
        btn.child.text = active ? _('On') : _('Off');
        btn.remove_style_class_name('procmon-toggle-on');
        btn.remove_style_class_name('procmon-toggle-off');
        btn.add_style_class_name(active ? 'procmon-toggle-on' : 'procmon-toggle-off');
    }

export function toggleAutostart(ind, entry) {
        const [userDir] = ind._autostartDirs()[0];
        const userPath = `${userDir}/${entry.file}`;
        try {
            if (entry.hidden) {
                // enable: either clear the user override or unhide the user file
                if (entry.origin === 'user') {
                    const [ok, text] = GLib.file_get_contents(userPath);
                    if (ok) {
                        let str = new TextDecoder().decode(text);
                        if (/^Hidden=/m.test(str))
                            str = str.replace(/^Hidden=.*$/m, 'Hidden=false');
                        else
                            str += (str.endsWith('\n') ? '' : '\n') + 'Hidden=false\n';
                        GLib.file_set_contents(userPath, str);
                    }
                } else {
                    const override = Gio.File.new_for_path(userPath);
                    if (override.query_exists(null))
                        GLib.file_delete(userPath);
                }
            } else {
                // disable: shadow with Hidden=true without destroying the
                // original entry's Name/Exec (write a full override only when
                // there is no user file yet)
                GLib.mkdir_with_parents(userDir, 0o755);
                const override = Gio.File.new_for_path(userPath);
                if (override.query_exists(null)) {
                    const [ok, text] = GLib.file_get_contents(userPath);
                    if (ok) {
                        let str = new TextDecoder().decode(text);
                        if (/^Hidden=/m.test(str))
                            str = str.replace(/^Hidden=.*$/m, 'Hidden=true');
                        else
                            str += (str.endsWith('\n') ? '' : '\n') + 'Hidden=true\n';
                        GLib.file_set_contents(userPath, str);
                    }
                } else {
                    GLib.file_set_contents(userPath,
                        '[Desktop Entry]\nHidden=true\n');
                }
            }
            entry.hidden = !entry.hidden;
        } catch (error) {
            console.warn(`procmon: autostart toggle: ${error}`);
        }
        return !entry.hidden;
    }

function parseServiceUnits(lines) {
        const units = [];
        for (const line of lines) {
            const parts = line.split(/\s+/);
            if (parts.length < 2 || !parts[0].endsWith('.service'))
                continue;
            const state = parts[1];
            if (state === 'static' || state === 'generated')
                continue;
            units.push({unit: parts[0], enabled: state === 'enabled'});
        }
        units.sort((a, b) => Number(b.enabled) - Number(a.enabled));
        return units;
    }

function buildServiceRow(ind, unit) {
        const row = new St.BoxLayout({style_class: 'procmon-line', x_expand: true});
        const name = new St.Label({
            text: unit.unit,
            style_class: 'procmon-line-name',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(name);
        const btn = ind._makeToggleButton(unit.enabled);
        btn.connect('button-press-event', () => {
            const target = !unit.enabled;
            // never flip the switch on a failed systemctl call: the user
            // would believe the unit changed state when it did not
            void ind._runSystemctlChecked([target ? 'enable' : 'disable', unit.unit])
                .then(ok => {
                    if (ok) {
                        unit.enabled = target;
                        ind._syncToggleButton(btn, target);
                    } else {
                        Main.notify('ProcMon',
                            _('Could not %s %s').format(
                                target ? _('enable') : _('disable'), unit.unit));
                    }
                });
            return Clutter.EVENT_STOP;
        });
        row.add_child(btn);
        return row;
    }

export async function fillServices(ind, section, generation = ind._menuGeneration ?? 0) {
        try {
            const lines = await ind._runSystemctl(['list-unit-files', '--type=service']);
            if (!sectionAlive(ind, section, generation))
                return;
            const units = parseServiceUnits(lines);
            if (units.length === 0) {
                section.hintLabel.text = _('No user services');
                section.hintLabel.visible = true;
                return;
            }
            section.hintLabel.visible = false;
            for (const unit of units) {
                if (!sectionAlive(ind, section, generation))
                    return;
                section.box.add_child(buildServiceRow(ind, unit));
            }
        } catch (error) {
            console.warn(`procmon: services fill failed: ${error}`);
        }
    }

export function readAutostartEntries(ind) {
        const entries = [];
        const seen = new Set();
        for (const [dir, origin] of ind._autostartDirs()) {
            const file = Gio.File.new_for_path(dir);
            if (!file.query_exists(null))
                continue;
            let en;
            try {
                en = file.enumerate_children('standard::name',
                    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            } catch (error) {
                continue;
            }
            let info;
            while ((info = en.next_file(null))) {
                const name = info.get_name();
                if (!name.endsWith('.desktop') || seen.has(name))
                    continue;
                seen.add(name); // a user override shadows the system entry
                const path = `${dir}/${name}`;
                const [ok, text] = GLib.file_get_contents(path);
                if (!ok)
                    continue;
                const str = new TextDecoder().decode(text);
                const m = /^Name=(.*)$/m.exec(str);
                const hidden = /^Hidden=true$/m.test(str);
                entries.push({file: name, name: m ? m[1].trim() : name,
                    origin, hidden});
            }
            en.close(null);
        }
        return entries.sort((a, b) => a.name.localeCompare(b.name));
    }

export function autostartDirs(ind) {
        return [
            [`${GLib.get_home_dir()}/.config/autostart`, 'user'],
            ['/etc/xdg/autostart', 'system'],
        ];
    }

export function runSystemctl(ind, args) {
        return new Promise(resolve => {
            try {
                const proc = Gio.Subprocess.new(
                    ['systemctl', '--user', ...args, '--no-pager'],
                    Gio.SubprocessFlags.STDOUT_PIPE |
                        Gio.SubprocessFlags.STDERR_SILENCE);
                proc.communicate_utf8_async(null, null, (source, result) => {
                    try {
                        const [, stdout] = source.communicate_utf8_finish(result);
                        // a non-zero exit means the listing failed; treat it
                        // as empty instead of parsing error output as units
                        if (source.get_exit_status() !== 0) {
                            resolve([]);
                            return;
                        }
                        resolve(stdout.split('\n').map(l => l.trim()).filter(Boolean));
                    } catch (error) {
                        resolve([]);
                    }
                });
            } catch (error) {
                resolve([]);
            }
        });
    }

// Honest success signal for state-changing calls (enable/disable/stop).
// wait_check throws on a non-zero exit, so the promise resolves false
// instead of pretending the unit changed state.
export function runSystemctlChecked(ind, args) {
        return new Promise(resolve => {
            try {
                const proc = Gio.Subprocess.new(
                    ['systemctl', '--user', ...args, '--no-pager'],
                    Gio.SubprocessFlags.STDOUT_SILENCE |
                        Gio.SubprocessFlags.STDERR_SILENCE);
                proc.wait_check_async(null, (source, result) => {
                    try {
                        source.wait_check_finish(result);
                        resolve(true);
                    } catch (error) {
                        console.warn(`procmon: systemctl ${args.join(' ')} failed: ${error}`);
                        resolve(false);
                    }
                });
            } catch (error) {
                console.warn(`procmon: systemctl spawn failed: ${error}`);
                resolve(false);
            }
        });
    }
