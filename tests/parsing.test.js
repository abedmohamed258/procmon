import system from 'system';
import {
    parseStatLine, computeCpuShares, parseCpuTicks, parseCoreTicks, computeCoreShares,
    coreGridRows, parseLoadAvg, parseMemInfo, averageFrequencyGhz, pickFanRpm,
    parseBattery, parseUptime, formatDuration, formatBytes, formatRate,
    parseTemperatureCelsius, collectTemperatures, collectFans, collectVoltages,
    parseBatteryDetails, parseNetDev, computeNetRates, parseDiskStats, computeDiskRates,
    parsePsi, parseGpuPercent, parseGpuCard, isFiniteRect, groupProcesses,
    assessKillProcess, ownedProcessEntries, isPointInsideRect,
} from '../lib/proc.js';

let passed = 0;
const failures = [];
function check(name, cond) { if (cond) passed++; else failures.push(name); }

// parseStatLine
check('stat: basic', parseStatLine('123 (bash) S 1 2 3 4 5 6 7 8 9 10 11 20 30 40 50 60 70 80 90 100 110').name === 'bash');
check('stat: null on empty', parseStatLine('') === null);
check('stat: ticks sum', parseStatLine('1 (a) R 1 2 3 4 5 6 7 8 9 10 11 20 30 40 50 60 70 80 90 100 110').ticks === 31);
check('stat: non-string', parseStatLine(42) === null);

// computeCpuShares
const prevProcesses = new Map();
prevProcesses.set(1, {ticks: 5});
prevProcesses.set(2, {ticks: 3});
const prev = {ticks: {busy: 10, total: 100}, processes: prevProcesses};
const currProcesses = new Map();
currProcesses.set(1, {ticks: 15});
currProcesses.set(2, {ticks: 4});
const curr = {ticks: {busy: 20, total: 150}, processes: currProcesses};
const shares = computeCpuShares(prev, curr);
check('shares: pid1 20%', Math.abs(shares.get(1) - 20) < 1e-9);
check('shares: pid2 2%', Math.abs(shares.get(2) - 2) < 1e-9);
check('shares: null prev => empty', computeCpuShares(null, curr).size === 0);

// parseCpuTicks / parseCoreTicks
check('cpuTicks: basic', parseCpuTicks('cpu  1 2 3 4 5 6 7 8 9 10\n').total > 0);
check('cpuTicks: non-string null', parseCpuTicks(5) === null);
const cores = parseCoreTicks('cpu0 1 2 3 4 5\ncpu1 6 7 8 9 10\n');
check('coreTicks: two cores', cores.size === 2 && cores.has(0) && cores.has(1));
check('coreShares: basic', computeCoreShares(new Map([[0,{busy:1,total:10}]]), new Map([[0,{busy:3,total:20}]])) instanceof Map);

// coreGridRows
const grid = coreGridRows(new Map([[0,{}],[1,{}],[2,{}],[3,{}],[4,{}],[5,{}]]), 4, 2);
check('coreGrid: rows', Array.isArray(grid.rows) && grid.rows.length > 0);
check('coreGrid: hidden count', typeof grid.hidden === 'number');

// parseLoadAvg
check('loadavg: basic', parseLoadAvg('0.5 1.2 0.3 2/100 1234').one === 0.5);
check('loadavg: null', parseLoadAvg('x y z') === null);

// parseMemInfo
const mem = parseMemInfo('MemTotal:       8000000 kB\nMemFree:        2000000 kB\nMemAvailable:   4000000 kB\nBuffers:         500000 kB\nCached:         1000000 kB\nSwapTotal:      2000000 kB\nSwapFree:       1500000 kB\n');
check('meminfo: total', Math.abs(mem.totalMb - 7812.5) < 0.01);
check('meminfo: swapUsed', Math.abs(mem.swapUsedMb - 488.28125) < 0.01);
check('meminfo: null', parseMemInfo('foo') === null);

// averageFrequencyGhz
check('avgFreq: basic', Math.abs(averageFrequencyGhz([1000000, 2000000]) - 1.5) < 1e-9);
check('avgFreq: null', averageFrequencyGhz([]) === null);

// pickFanRpm
check('fan: first positive', pickFanRpm([0, 1200, 800]) === 1200);
check('fan: null', pickFanRpm([0, -1]) === null);

// parseBattery
check('battery: basic', parseBattery('80', 'Charging').percent === 80);
check('battery: null', parseBattery('', 'Full') === null);

// parseUptime
check('uptime: basic', parseUptime('12345.67 999') === 12345.67);
check('uptime: null', parseUptime('x') === null);

// formatDuration
check('duration: days', formatDuration(90000) === '1d 1h 0m');
check('duration: seconds', formatDuration(42) === '42s');
check('duration: null', formatDuration(-1) === null);

// formatBytes / formatRate
check('bytes: KB', formatBytes(2048) === '2.0 KB');
check('bytes: negative', formatBytes(-1) === '—');
check('rate: basic', formatRate(1024) === '1.0 KB/s');

// parseTemperatureCelsius
check('temp: basic', parseTemperatureCelsius('45000') === 45);
check('temp: out of range', parseTemperatureCelsius('200000') === null);

// collectTemperatures
const temps = collectTemperatures([{name:'z0', type:'x86_pkg_temp', temp:'50000'}], [{device:'coretemp', temps:[{label:'Package', temp:'60000'}]}]);
check('temps: sorted desc', temps.length === 2 && temps[0].celsius === 60);

// collectFans
const fans = collectFans([{device:'it87', fans:[{label:'fan1', rpm:1200}, {label:'fan2', rpm:0}]}]);
check('fans: drops zero', fans.length === 1 && fans[0].rpm === 1200);

// collectVoltages
const volts = collectVoltages([{device:'it87', voltages:[{label:'in0', millivolts:12000}]}], 3700000);
check('volts: hwmon + battery', volts.length === 2);

// parseBatteryDetails
const bd = parseBatteryDetails({capacity:'80', status:'Discharging', voltageNow:'12000000', currentNow:'1000000', energyNow:'10000000'});
check('batteryDetails: basic', bd.percent === 80 && bd.watts !== null);

// parseNetDev
const net = parseNetDev('Inter-|   Receive |  Transmit\n face |bytes    packets ...\n    lo: 1 2 3 4 5 6 7 8 9\n  eth0: 100 2 3 4 5 6 7 8 200\n');
check('netdev: eth0', net.has('eth0') && net.get('eth0').rxBytes === 100);
check('netdev: no lo', !net.has('lo'));

// computeNetRates
const n0 = new Map();
n0.set('eth0', {rxBytes: 100, txBytes: 50});
const n1 = new Map();
n1.set('eth0', {rxBytes: 300, txBytes: 150});
const nr = computeNetRates(n0, n1, 2);
check('netRates: rx', nr.length === 1 && nr[0].rxPerSecond === 100);

// parseDiskStats
const ds = parseDiskStats('   8       0 sda 1 2 3 4 5 30478671 6 7 8 9 17534762 10\n   8       1 sda1 1 2 3 4 5 6 7 8 9 10\n');
check('diskStats: sda only', ds.size === 1 && ds.has('sda'));

// computeDiskRates
const d0 = new Map();
d0.set('sda', {readBytes: 100, writeBytes: 50});
const d1 = new Map();
d1.set('sda', {readBytes: 300, writeBytes: 150});
const dr = computeDiskRates(d0, d1, 2);
check('diskRates: read', dr.readPerSecond === 100);

// parsePsi
const psi = parsePsi('some avg10=1.23 avg60=0.50 avg300=0.10 total=100\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n');
check('psi: some', psi.some.avg10 === 1.23 && psi.full.total === 0);
check('psi: null', parsePsi('garbage') === null);

// parseGpuPercent
check('gpuPct: basic', parseGpuPercent('42') === 42);
check('gpuPct: reject 101', parseGpuPercent('101') === null);

// parseGpuCard
const card = parseGpuCard({vendorId: '0x1002', busy: '50', vramUsed: '100', vramTotal: '200'});
check('gpuCard: AMD', card.vendor === 'AMD' && card.usagePercent === 50);
check('gpuCard: unknown vendor', parseGpuCard({vendorId: '0xdead'}) === null);

// isFiniteRect / isPointInsideRect
check('rect: finite', isFiniteRect({x:1,y:2,width:3,height:4}) === true);
check('point: inside', isPointInsideRect(2, 3, {x:1,y:2,width:3,height:4}) === true);
check('point: outside', isPointInsideRect(10, 10, {x:1,y:2,width:3,height:4}) === false);

// groupProcesses
const entries = [
    {pid: 1, name: 'chrome', cpu: 10, rssKb: 100, uid: 5},
    {pid: 2, name: 'chrome', cpu: 5, rssKb: 50, uid: 5},
    {pid: 3, name: 'firefox', cpu: 20, rssKb: 200, uid: 5},
];
const g = groupProcesses(entries, 10, 'cpu');
check('group: chrome merged', g.groups.find(x => x.name.toLowerCase() === 'chrome').count === 2);
check('group: chrome cpuSum 15', g.groups.find(x => x.name.toLowerCase() === 'chrome').cpuSum === 15);
check('group: totalGroups 2', g.totalGroups === 2);
check('group: entries not mutated', entries.length === 3);
const g2 = groupProcesses(entries, 1, 'rss');
check('group: topCount 1', g2.groups.length === 1);
check('group: null input', groupProcesses(null, 5).groups.length === 0);

// assessKillProcess
check('kill: owned', assessKillProcess({uid:5, ownUid:5, startTime:10, expectedStartTimeTicks:10, state:'S'}).canKill === true);
check('kill: foreign uid', assessKillProcess({uid:6, ownUid:5, startTime:10, expectedStartTimeTicks:10, state:'S'}).reason === 'foreign-uid');
check('kill: zombie', assessKillProcess({uid:5, ownUid:5, startTime:10, expectedStartTimeTicks:10, state:'Z'}).reason === 'zombie-or-exited');
check('kill: pid reused', assessKillProcess({uid:5, ownUid:5, startTime:11, expectedStartTimeTicks:10, state:'S'}).reason === 'pid-reused');
check('kill: missing ref', assessKillProcess({uid:5, ownUid:5, startTime:10, expectedStartTimeTicks:null, state:'S'}).reason === 'pid-reused');
check('kill: unknown identity null', assessKillProcess({uid:5, ownUid:null, startTime:10, expectedStartTimeTicks:10, state:'S'}).reason === 'unknown-identity');
check('kill: unknown identity -1', assessKillProcess({uid:5, ownUid:-1, startTime:10, expectedStartTimeTicks:10, state:'S'}).reason === 'unknown-identity');
check('kill: missing state', assessKillProcess({uid:5, ownUid:5, startTime:10, expectedStartTimeTicks:10, state:undefined}).reason === 'zombie-or-exited');

// ownedProcessEntries
check('owned: filters', ownedProcessEntries([{uid:5},{uid:6}], 5).length === 1);
check('owned: unknown => []', ownedProcessEntries([{uid:5}], null).length === 0);
check('owned: unknown -1 => []', ownedProcessEntries([{uid:5}], -1).length === 0);
check('owned: non-array => []', ownedProcessEntries('x', 5).length === 0);
const orig = [{uid:5, pid:1}];
const filtered = ownedProcessEntries(orig, 5);
check('owned: no mutation', orig.length === 1 && filtered[0] === orig[0]);

// parseBattery (already) + parseLoadAvg already

if (failures.length > 0) {
    for (const name of failures)
        printerr(`FAIL: ${name}`);
    printerr(`FAILED ${failures.length} / ${passed + failures.length}`);
    system.exit(1);
}
print(`OK ${passed} tests`);
