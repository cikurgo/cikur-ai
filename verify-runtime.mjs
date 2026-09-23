import * as physics from './cgo-satellite-virtual.js';
import * as tle from './cgo-satellite-live-tle.js';
import * as multi from './cgo-multi-constellation.js';
import * as rf from './cgo-satellite.real-connection.js';

const report = physics.runSelfTest();
for (const test of report) console.log(`${test.pass ? 'PASS' : 'FAIL'} ${test.name}${test.info ? ` — ${test.info}` : ''}`);
console.log(`physics: ${report.filter(t => t.pass).length}/${report.length}`);

const tleRows = tle.parseTLEText(`TEST SAT\n1 00005U 58002B   24100.00000000  .00000023  00000-0  28098-4 0  9999\n2 00005  34.2500 331.5174 1849677 331.7664  19.3264 10.82419157456123\n`);
if (tleRows.length !== 1) throw new Error('TLE parser smoke test failed');
console.log(`tle parser: ${tleRows.length}/1`);
const mc = multi.runSelfTest();
console.log(`constellation: ${mc.pass}/${mc.total}`);
console.log(`rf exports: ${Object.keys(rf).length}`);
if (report.some(t => !t.pass) || !mc.verified) process.exitCode = 1;
