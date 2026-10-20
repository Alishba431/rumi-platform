/**
 * Re-running 00_complete-schema.sql over an existing database must leave the current quizzes status CHECK.
 *
 * `CREATE TABLE IF NOT EXISTS` skips the inline CHECK on a database that already has `quizzes`, and bootstrap
 * advertises a re-run as safe. So the full CHECK is dropped and re-added after the table, as V2.9.0 does; otherwise a
 * database built before 2.9.0 rejects the 'offered' / 'declined' / 'skipped' statuses the lesson quiz writes.
 * (Proved against Postgres 17: main 00+01+02, then this 00, then pg_get_constraintdef.)
 */

const fs = require('fs');
const path = require('path');

const schema = fs.readFileSync(path.resolve(__dirname, '../../infrastructure/supabase/00_complete-schema.sql'), 'utf8');

describe('00_complete-schema re-run over an older database', () => {
  it('re-adds quizzes_status_check with every lesson-quiz status, outside CREATE TABLE', () => {
    const tableEnd = schema.indexOf(');', schema.indexOf('CREATE TABLE IF NOT EXISTS quizzes ('));
    const after = schema.slice(tableEnd);
    const drop = after.indexOf('ALTER TABLE quizzes DROP CONSTRAINT IF EXISTS quizzes_status_check;');
    const add = after.indexOf('ALTER TABLE quizzes ADD CONSTRAINT quizzes_status_check CHECK');
    expect(drop).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(drop);
    const check = after.slice(add, after.indexOf(';', add));
    for (const status of ['generating', 'ready', 'sent', 'report_sent', 'failed', 'cancelled', 'offered', 'declined', 'skipped']) {
      expect(check).toContain(`'${status}'`);
    }
  });
});
