// Preferences dialog. GTK/Adw only — never St or Clutter, so it works inside
// the standalone prefs process of every supported shell version.
import Adw from 'gi://Adw';
import Gettext from 'gettext';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const _ = Gettext.domain('procmon@abed.dev').gettext;

const SECTION_KEYS = [
    {key: 'show-processes', title: _('Top processes')},
    {key: 'show-cpu', title: _('CPU cores and frequencies')},
    {key: 'show-memory', title: _('Memory details')},
    {key: 'show-temperatures', title: _('Temperatures')},
    {key: 'show-fans', title: _('Fans')},
    {key: 'show-voltages', title: _('Voltages')},
    {key: 'show-battery', title: _('Battery')},
    {key: 'show-network', title: _('Network rates')},
    {key: 'show-disk', title: _('Disk usage')},
    {key: 'show-gpu', title: _('Graphics')},
    {key: 'show-psi', title: _('Pressure (PSI)')},
];

const PANEL_ITEMS = [
    {key: 'cpu', title: _('CPU usage')},
    {key: 'temp', title: _('Temperature')},
    {key: 'ram', title: _('Memory usage')},
];

export default class ProcmonPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.set_search_enabled(true);
        window.add(page);

        this._addGeneralGroup(page, settings);
        this._addPanelGroup(page, settings);
        this._addAlertsGroup(page, settings);
        this._addSectionsGroup(page, settings);
        this._addSafetyGroup(page, settings);
    }

    _addGeneralGroup(page, settings) {
        const group = new Adw.PreferencesGroup({title: _('General')});
        page.add(group);
        this._addSpinRow(group, settings, {
            title: _('Panel refresh (ms)'),
            subtitle: _('How often /proc samples update the panel label. 500–10000.'),
            key: 'refresh-interval-ms', min: 500, max: 10000, step: 100,
        });
        this._addSpinRow(group, settings, {
            title: _('Menu refresh (ms)'),
            subtitle: _('How often sensor sweeps and process scans run while the menu is open. 1000–30000.'),
            key: 'menu-refresh-ms', min: 1000, max: 30000, step: 500,
        });
        this._addSpinRow(group, settings, {
            title: _('Rows in each process list'),
            subtitle: _('How many highest-usage processes each of the two lists shows. 3–20.'),
            key: 'top-count', min: 3, max: 20, step: 1,
        });
    }

    _addPanelGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Panel'),
            description: _('Which values the panel indicator shows, picked in this fixed order.'),
        });
        page.add(group);

        const current = settings.get_string('panel-items')
            .split(',').map(item => item.trim());
        const rows = PANEL_ITEMS.map(item => {
            const check = new Gtk.CheckButton({
                label: item.title,
                active: current.includes(item.key),
            });
            const panelRow = new Adw.ActionRow({title: item.title});
            panelRow.add_prefix(check);
            panelRow.activatableWidget = check;
            group.add(panelRow);
            return {key: item.key, check};
        });
        for (const entry of rows)
            entry.check.connect('toggled', () =>
                this._writePanelItems(settings, rows));

        const sparkline = new Adw.SwitchRow({title: _('Show sparkline')});
        settings.bind('show-sparkline', sparkline, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        group.add(sparkline);
    }

    // panel-items is a csv string, so the checkboxes cannot bind directly
    _writePanelItems(settings, entries) {
        const selected = entries.filter(entry => entry.check.active)
            .map(entry => entry.key);
        settings.set_string('panel-items', selected.join(','));
    }

    _addAlertsGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Alerts'),
            description: _('Threshold notifications shown at most once every 5 minutes per kind.'),
        });
        page.add(group);
        this._addSpinRow(group, settings, {
            title: _('Temperature alert (°C)'),
            subtitle: _('Notify when the hottest sensor goes above this value. 0 disables it. 0–120.'),
            key: 'temp-alert-c', min: 0, max: 120, step: 5,
        });
        this._addSpinRow(group, settings, {
            title: _('Memory alert (%)'),
            subtitle: _('Notify when RAM usage goes above this percent. 0 disables it. 0–100.'),
            key: 'mem-alert-pct', min: 0, max: 100, step: 5,
        });
        this._addSpinRow(group, settings, {
            title: _('Disk alert (%)'),
            subtitle: _('Notify when the fullest mounted filesystem goes above this percent. 0 disables it. 0–100.'),
            key: 'disk-alert-pct', min: 0, max: 100, step: 5,
        });
    }

    _addSectionsGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Sections'),
            description: _('Each toggle adds or removes a section of the open menu.'),
        });
        page.add(group);
        for (const section of SECTION_KEYS) {
            const row = new Adw.SwitchRow({title: section.title});
            settings.bind(section.key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        }
    }

    _addSafetyGroup(page, settings) {
        const group = new Adw.PreferencesGroup({title: _('Safety')});
        page.add(group);
        const row = new Adw.SwitchRow({
            title: _('Confirm before terminating processes'),
            subtitle: _('When enabled, a click on the × stops first and asks. SIGTERM requests an exit; SIGKILL cannot be caught by the process and may lose its data.'),
        });
        settings.bind('kill-confirmation', row, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(row);
    }

    _addSpinRow(group, settings, {title, subtitle, key, min, max, step}) {
        const row = new Adw.SpinRow({
            title,
            subtitle,
            adjustment: new Gtk.Adjustment({
                lower: step * Math.round(min / step),
                upper: step * Math.round(max / step),
                step_increment: step,
                page_increment: 10 * step,
            }),
            numeric: true,
        });
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(row);
    }
}
