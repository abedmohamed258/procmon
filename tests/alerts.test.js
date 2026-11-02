// alerts.test.js — pure escalation logic (gjs -m)
import { alertDecision } from '../lib/proc.js';

const checks = [];
function ok(name, cond) {
    if (!cond) throw new Error(`FAIL: ${name}`);
    checks.push(name);
}

// 1. first rise notifies
ok('first-rise', alertDecision(null, 1, 1000, 1000).shouldNotify === true);
// 2. same level, not cooled → silent
ok('same-level-cooldown', alertDecision({level: 1, at: 900, acked: false}, 1, 1000, 1000).shouldNotify === false);
// 3. escalation breaks silence
ok('escalation', alertDecision({level: 1, at: 999, acked: true}, 2, 1000, 1000).shouldNotify === true);
// 4. acknowledged + cooled → still silent (user knows)
ok('acked-silent', alertDecision({level: 1, at: 0, acked: true}, 1, 1000, 1000).shouldNotify === false);
// 5. cooled and not acked → reminder
ok('cooled-reminder', alertDecision({level: 1, at: 0, acked: false}, 1, 1000, 1000).shouldNotify === true);
// 6. escalated returns escalated=true
ok('escalated-flag', alertDecision({level: 1, at: 0, acked: false}, 2, 1000, 1000).escalated === true);
// 7. cooled flag
ok('cooled-flag', alertDecision({level: 1, at: 0, acked: false}, 1, 1000, 1000).cooled === true);

console.log(`OK ${checks.length} checks`);
