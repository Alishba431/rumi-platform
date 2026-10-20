/**
 * The register's day columns must not depend on the server's timezone.
 *
 * A date like '2026-08-03' read through `new Date()` is midnight UTC, which is
 * still the 2nd west of UTC — the register shifted a column there, and the month
 * query dropped the last day east of it. CI runs in UTC, where neither shows, so
 * the register suites are run again here in a child process under a zone on each
 * side of UTC.
 */
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const JEST = path.join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js');
const SUITES = [
  'tests/attendance/monthly-register.test.js',
  'tests/attendance/class-register-generator.test.js',
  'tests/attendance/attendance-dates.test.js',
];

describe.each(['America/Lima', 'Pacific/Kiritimati'])('the register suites under TZ=%s', (tz) => {
  it('pass', () => {
    const run = spawnSync(process.execPath, [JEST, '--config', 'tests/jest.config.js', '--runTestsByPath', ...SUITES], {
      cwd: ROOT,
      env: { ...process.env, TZ: tz },
      encoding: 'utf8',
      timeout: 120000,
    });
    const tail = `${run.stderr || ''}`.split('\n').filter((l) => /✕|Tests:|●/.test(l)).slice(0, 20).join('\n');
    expect({ status: run.status, failures: run.status === 0 ? '' : tail }).toEqual({ status: 0, failures: '' });
  }, 130000);
});
