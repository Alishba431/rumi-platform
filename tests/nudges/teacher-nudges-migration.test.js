'use strict';
/**
 * The `teacher_nudges` schema — shape checks on the SQL itself.
 *
 * The store's two guards lean on the database: idempotent booking needs the
 * UNIQUE (user_id, nudge_date, kind), and the claim needs `status` to be a
 * closed set. Kinds are deliberately NOT a CHECK (they are a code registry, so a
 * new kind needs no migration). The same table must appear in three places:
 * the versioned migration (upgrades), the consolidated schema (fresh installs)
 * and the RLS file.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const MIGRATION = path.join(ROOT, 'infrastructure/supabase/migrations/V2.5.1__teacher_nudges.sql');
const SCHEMA = path.join(ROOT, 'infrastructure/supabase/00_complete-schema.sql');
const RLS = path.join(ROOT, 'infrastructure/supabase/01_rls-policies.sql');

/** SQL with `--` comments removed, so a commented-out line can never satisfy a check. */
const stripComments = (sql) => sql.replace(/--[^\n]*/g, '');

/** The body of `CREATE TABLE IF NOT EXISTS teacher_nudges ( ... );`. */
function tableBody(sql) {
  const m = stripComments(sql).match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+teacher_nudges\s*\(([\s\S]*?)\n\);/i);
  return m ? m[1] : null;
}

function checkShape(sql) {
  const body = tableBody(sql);
  expect(body).not.toBeNull();

  expect(body).toMatch(/\bid\s+uuid\s+PRIMARY\s+KEY/i);
  expect(body).toMatch(/\buser_id\s+uuid\s+NOT\s+NULL\s+REFERENCES\s+users\s*\(\s*id\s*\)\s+ON\s+DELETE\s+CASCADE/i);
  expect(body).toMatch(/\bkind\s+text\s+NOT\s+NULL/i);
  expect(body).toMatch(/\bnudge_date\s+date\s+NOT\s+NULL/i);
  expect(body).toMatch(/\bscheduled_at\s+timestamptz\s+NOT\s+NULL/i);
  expect(body).toMatch(/\bstatus\s+text\s+NOT\s+NULL\s+DEFAULT\s+'pending'/i);
  for (const col of ['skip_reason', 'context', 'attempts', 'claimed_at', 'sent_at', 'created_at', 'updated_at']) {
    expect(body).toMatch(new RegExp(`\\n\\s*${col}\\s`, 'i'));
  }
  expect(body).toMatch(/\bcontext\s+jsonb\b[^,]*DEFAULT\s+'\{\}'/i);
  expect(body).toMatch(/\battempts\s+int(eger)?\b[^,]*DEFAULT\s+0/i);

  // status is closed — exactly the five states the store uses.
  const statusCheck = body.match(/CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/i);
  expect(statusCheck).not.toBeNull();
  const states = statusCheck[1].split(',').map((s) => s.trim().replace(/'/g, '')).sort();
  expect(states).toEqual(['failed', 'pending', 'sending', 'sent', 'skipped']);

  // kind is NOT a CHECK — kinds are a code registry.
  expect(body).not.toMatch(/CHECK\s*\(\s*kind\b/i);

  expect(body).toMatch(/UNIQUE\s*\(\s*user_id\s*,\s*nudge_date\s*,\s*kind\s*\)/i);

  const flat = stripComments(sql);
  expect(flat).toMatch(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+\w+\s+ON\s+teacher_nudges\s*(USING\s+btree\s*)?\(\s*scheduled_at\s*\)\s*WHERE\s+status\s*=\s*'pending'/i);
  expect(flat).toMatch(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+\w+\s+ON\s+teacher_nudges\s*(USING\s+btree\s*)?\(\s*user_id\s*,\s*nudge_date\s+DESC\s*\)/i);
  expect(flat).toMatch(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+\w+\s+ON\s+users\s*(USING\s+btree\s*)?\(\s*last_message_at\s*\)/i);
}

describe('teacher_nudges migration (V2.5.1)', () => {
  it('exists with a name the migration runner accepts', () => {
    expect(fs.existsSync(MIGRATION)).toBe(true);
    expect(path.basename(MIGRATION)).toMatch(/^V\d+\.\d+\.\d+__.*\.sql$/);
  });

  it('has the table shape the store relies on', () => {
    checkShape(fs.readFileSync(MIGRATION, 'utf8'));
  });

  it('is additive and idempotent: every CREATE is IF NOT EXISTS, nothing is dropped or altered', () => {
    const sql = stripComments(fs.readFileSync(MIGRATION, 'utf8'));
    expect(sql).not.toMatch(/CREATE\s+(TABLE|INDEX)\s+(?!IF\s+NOT\s+EXISTS)/i);
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX)\b/i);
    expect(sql).not.toMatch(/\bALTER\s+TABLE\s+\w+\s+(DROP|ALTER)\b/i);
  });

  it('enables row level security on the table', () => {
    expect(stripComments(fs.readFileSync(MIGRATION, 'utf8')))
      .toMatch(/ALTER\s+TABLE\s+teacher_nudges\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
  });
});

describe('teacher_nudges in the consolidated schema and RLS file', () => {
  it('00_complete-schema.sql carries the same table shape', () => {
    checkShape(fs.readFileSync(SCHEMA, 'utf8'));
  });

  it('01_rls-policies.sql enables RLS with a service-role policy, like the other bot-only tables', () => {
    const sql = stripComments(fs.readFileSync(RLS, 'utf8'));
    expect(sql).toMatch(/ALTER\s+TABLE\s+teacher_nudges\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
    expect(sql).toMatch(/CREATE\s+POLICY\s+"service_role_teacher_nudges"\s+ON\s+teacher_nudges\s+FOR\s+ALL\s+USING\s*\(\s*auth\.role\(\)\s*=\s*'service_role'\s*\)/i);
  });
});
