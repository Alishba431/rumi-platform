/**
 * exec_sql runs any SQL as postgres, so only service_role may call it.
 *
 * Postgres grants EXECUTE on every new function to PUBLIC, and Supabase also
 * default-grants it to anon and authenticated. PostgREST then serves the
 * function at /rest/v1/rpc/exec_sql, so a helper created without a REVOKE lets
 * anyone holding the project URL and the (public) anon key run SQL as the
 * database owner. Every snippet in this repo that creates the helper must
 * revoke it, and a migration revokes it on databases created from the old
 * snippet.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CREATES = /create\s+or\s+replace\s+function\s+(public\.)?exec_sql\s*\(/i;
const REVOKES = /revoke\s+execute\s+on\s+function\s+public\.exec_sql\(text\)\s+from\s+public,\s*anon,\s*authenticated\s*;/i;

// Tracked files outside tests/ (tests quote fragments of the helper on purpose).
function filesThatCreateExecSql() {
  return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && !f.startsWith('tests/') && /\.(md|sql|js|sh)$/.test(f))
    .filter((f) => fs.existsSync(path.join(ROOT, f)) && CREATES.test(read(f)));
}

describe('exec_sql is callable by service_role only', () => {
  it('finds the places that create the helper', () => {
    expect(filesThatCreateExecSql()).toEqual(
      expect.arrayContaining(['SETUP.md', 'infrastructure/scripts/exec-sql-helper.js']),
    );
  });

  it.each(filesThatCreateExecSql())('%s revokes EXECUTE from PUBLIC, anon and authenticated', (rel) => {
    expect(read(rel)).toMatch(REVOKES);
  });

  it('the helper setup prints revokes before it grants to service_role', () => {
    const { EXEC_SQL_SQL } = require('../../infrastructure/scripts/exec-sql-helper');
    const revoke = EXEC_SQL_SQL.search(REVOKES);
    expect(revoke).toBeGreaterThan(-1);
    expect(EXEC_SQL_SQL.indexOf('grant execute on function public.exec_sql(text) to service_role')).toBeGreaterThan(revoke);
  });

  it('a versioned migration revokes it on existing databases', () => {
    const dir = 'infrastructure/supabase/migrations';
    const migrations = fs.readdirSync(path.join(ROOT, dir)).filter((f) => /^V\d+\.\d+\.\d+__.*\.sql$/.test(f));
    const revoking = migrations.filter((f) => REVOKES.test(read(`${dir}/${f}`)));
    expect(revoking).toHaveLength(1);
    const sql = read(`${dir}/${revoking[0]}`);
    // Fails loudly, rather than passing, when the REVOKE could not take effect.
    expect(sql).toMatch(/has_function_privilege\('anon',\s*'public\.exec_sql\(text\)',\s*'execute'\)/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
  });
});
