/**
 * infrastructure/local/{up,down}.sh — the state dir guard.
 *
 * `down.sh --wipe` trusts the marker file up.sh drops in the state dir. If
 * up.sh drops it in any directory RUMI_LOCAL_STATE_DIR names, a slip such as
 * RUMI_LOCAL_STATE_DIR=~/Documents turns the next --wipe into an rm -rf of
 * that directory. So up.sh must refuse a non-empty directory that has no
 * marker, and --wipe must delete only what up.sh creates.
 *
 * The scripts run for real against temp dirs. Postgres, PostgREST and Redis
 * are stub executables that start nothing: the stub initdb fails, so up.sh
 * stops right after the point where it would adopt the directory.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const UP = path.join(ROOT, 'infrastructure', 'local', 'up.sh');
const DOWN = path.join(ROOT, 'infrastructure', 'local', 'down.sh');
const MARKER = '.rumi-local-stack';

let tmp;
let stubs;

function stub(name, body) {
  const file = path.join(stubs, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

function run(script, stateDir, args = []) {
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      RUMI_LOCAL_STATE_DIR: stateDir,
      PG_BIN: stubs,
      POSTGREST_BIN: path.join(stubs, 'postgrest'),
      REDIS_SERVER_BIN: path.join(stubs, 'redis-server'),
    },
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rumi-ls-'));
  stubs = path.join(tmp, 'stubs');
  fs.mkdirSync(stubs);
  stub('pg_ctl', 'case "$1" in --version) echo "pg_ctl (PostgreSQL) 17.0" ;; *) exit 1 ;; esac');
  stub('postgres', 'exit 1');
  stub('initdb', 'exit 1');
  stub('psql', 'exit 1');
  stub('postgrest', 'echo "PostgREST 12.0 (stub)"');
  stub('redis-server', 'exit 1');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('up.sh adopts only an empty or already-marked state dir', () => {
  it('refuses a non-empty unmarked dir, touches nothing, and a later --wipe cannot delete it', () => {
    const dir = path.join(tmp, 'precious');
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'thesis.txt'), 'important');

    const up = run(UP, dir);
    expect(up.status).not.toBe(0);
    expect(up.stderr).toMatch(/is not empty and is not a Rumi local stack state dir/);
    expect(fs.existsSync(path.join(dir, MARKER))).toBe(false);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o755);

    const down = run(DOWN, dir, ['--wipe']);
    expect(down.status).not.toBe(0);
    expect(fs.readFileSync(path.join(dir, 'thesis.txt'), 'utf8')).toBe('important');
  });

  it('adopts a dir that holds only bin/postgrest (the documented pre-copy)', () => {
    const dir = path.join(tmp, 'stack');
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.copyFileSync(path.join(stubs, 'postgrest'), path.join(dir, 'bin', 'postgrest'));

    const up = run(UP, dir);
    // It gets past the guard and stops at the stub initdb.
    expect(up.stderr).not.toMatch(/is not a Rumi local stack state dir/);
    expect(up.stderr).toMatch(/initdb failed/);
    expect(fs.existsSync(path.join(dir, MARKER))).toBe(true);
  });
});

describe('down.sh --wipe deletes only what up.sh creates', () => {
  function makeStack(dir) {
    for (const d of ['pgdata', 'logs', 'run', 'redis', 'pgsock', 'bin']) {
      fs.mkdirSync(path.join(dir, d), { recursive: true });
    }
    fs.writeFileSync(path.join(dir, 'pgdata', 'base'), '');
    fs.writeFileSync(path.join(dir, 'logs', 'postgres.log'), '');
    fs.writeFileSync(path.join(dir, 'bin', 'postgrest'), '');
    for (const f of [MARKER, 'jwt-secret', 'postgrest.conf', 'redis.conf', 'local.env', '00_complete-schema.local.sql']) {
      fs.writeFileSync(path.join(dir, f), '');
    }
  }

  it('removes the stack and then the empty dir', () => {
    const dir = path.join(tmp, 'stack');
    makeStack(dir);
    const down = run(DOWN, dir, ['--wipe']);
    expect(down.status).toBe(0);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('leaves a file it did not create, and the dir holding it', () => {
    const dir = path.join(tmp, 'stack');
    makeStack(dir);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine');
    fs.writeFileSync(path.join(dir, 'bin', 'my-tool'), 'mine too');

    const down = run(DOWN, dir, ['--wipe']);
    expect(down.status).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8')).toBe('mine');
    expect(fs.readFileSync(path.join(dir, 'bin', 'my-tool'), 'utf8')).toBe('mine too');
    expect(fs.existsSync(path.join(dir, 'pgdata'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'bin', 'postgrest'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'jwt-secret'))).toBe(false);
    expect(fs.existsSync(path.join(dir, MARKER))).toBe(false);
    expect(down.stdout).toMatch(/left .* in place/);
  });
});
