import system from 'system';
import GLib from 'gi://GLib';

const path = GLib.build_filenamev([GLib.get_current_dir(), 'stylesheet.css']);
// resolve relative to this test file's location instead
const testDir = GLib.path_get_dirname(import.meta.url.replace('file://', ''));
const cssPath = GLib.build_filenamev([testDir, '..', 'stylesheet.css']);
const [ok, bytes] = GLib.file_get_contents(cssPath);
if (!ok) {
    printerr('FAIL: could not read stylesheet.css');
    system.exit(1);
}
const css = new TextDecoder().decode(bytes);

let passed = 0;
const failures = [];
function check(name, cond) {
    if (cond) {
        passed++;
        print(`ok ${name}`);
    } else {
        failures.push(name);
        printerr(`FAIL: ${name}`);
    }
}

check('cpu accent present', css.includes('rgba(53, 132, 228'));
check('ram accent present', css.includes('rgba(51, 209, 122'));
// foreground must be theme-inherited: hardcoded white text is invisible on
// a light GNOME theme, so assert its absence instead of its presence
// (anchored to line start so background-color: washes don't count)
check('no hardcoded white text', !/^\s+color:\s*rgba\(255,\s*255,\s*255/m.test(css));
check('sparkbars class present', css.includes('.procmon-sparkbars'));
check('ram spark row present', css.includes('.procmon-sparkbar-ram'));
check('card-value class present', css.includes('.procmon-card-value'));
check('card-value font-size 16px', css.includes('font-size: 16px'));
check('warn accent present', css.includes('rgba(255, 190, 111'));
check('crit accent present', css.includes('rgba(230, 97, 0'));

if (failures.length > 0) {
    printerr(`FAILED ${failures.length} / ${passed + failures.length}`);
    system.exit(1);
}
print(`OK ${passed} checks`);