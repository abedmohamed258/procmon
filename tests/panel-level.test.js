// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Abed Mohamed

// panel-level.test.js — panel attention thresholds (gjs -m)
import {panelLevel} from '../ui/constants.js';

const checks = [];
function ok(name, cond) {
    if (!cond) throw new Error(`FAIL: ${name}`);
    checks.push(name);
}

// cpu/ram: warn >= 75, crit >= 90
ok('cpu-calm', panelLevel('cpu', 12) === 'ok');
ok('cpu-warn', panelLevel('cpu', 75) === 'warn');
ok('cpu-crit', panelLevel('cpu', 90) === 'crit');
ok('ram-warn', panelLevel('ram', 80) === 'warn');
ok('ram-crit', panelLevel('ram', 99) === 'crit');
// temp: warn >= 70, crit >= 85
ok('temp-calm', panelLevel('temp', 55) === 'ok');
ok('temp-warn', panelLevel('temp', 70) === 'warn');
ok('temp-crit', panelLevel('temp', 85) === 'crit');
// unknown values stay calm (no sensors -> no colour)
ok('nan-calm', panelLevel('cpu', NaN) === 'ok');
ok('null-calm', panelLevel('ram', null) === 'ok');
ok('unknown-item-defaults', panelLevel('bogus', 999) === 'crit'); // default 90

console.log(`OK ${checks.length} checks`);
