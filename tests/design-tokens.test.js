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
check('primary text present', css.includes('rgba(255, 255, 255, 0.96)'));
check('sparkline class present', css.includes('.procmon-sparkline'));
check('sparkline min-height 40px', css.includes('min-height: 40px'));
check('card-value class present', css.includes('.procmon-card-value'));
check('card-value font-size 16px', css.includes('font-size: 16px'));
check('warn accent present', css.includes('rgba(255, 190, 111'));
check('crit accent present', css.includes('rgba(230, 97, 0'));

if (failures.length > 0) {
    printerr(`FAILED ${failures.length} / ${passed + failures.length}`);
    system.exit(1);
}
print(`OK ${passed} checks`);