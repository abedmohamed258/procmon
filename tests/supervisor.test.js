// supervisor.test.js — cgroup supervisor parsing (gjs -m)
import { parseCgroupUnit } from '../lib/proc.js';

const checks = [];
function ok(name, cond) {
    if (!cond) throw new Error(`FAIL: ${name}`);
    checks.push(name);
}

const service = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/gvfs-daemon.service';
ok('service', parseCgroupUnit(service)?.kind === 'service');
ok('service-unit', parseCgroupUnit(service)?.unit === 'gvfs-daemon.service');

const appScope = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-org.gnome.Software-96276.scope';
ok('app-scope', parseCgroupUnit(appScope)?.kind === 'app');

const session = '0::/user.slice/user-1000.slice/user@1000.service/session.slice/org.gnome.Shell@x11.service';
ok('session-service', parseCgroupUnit(session)?.unit === 'org.gnome.Shell@x11.service');

ok('user-manager-ignored', parseCgroupUnit('0::/user.slice/user-1000.slice/user@1000.service') === null);
ok('garbage', parseCgroupUnit('not a cgroup line') === null);
ok('null', parseCgroupUnit(null) === null);

console.log(`OK ${checks.length} checks`);
