'use strict';
/**
 * The shape of V2.9.0 that keeps it all-or-nothing on every path.
 *
 * Proved against a throwaway Postgres (fresh 00+01 == main 00+01 + V2.9.0;
 * a re-run is a no-op; dirty data leaves nothing half-applied; the same file
 * through migrate.js, inside its SQL function). This test pins the shape that proof relied
 * on, so an edit that breaks it is caught without a database:
 *   - the change is one DO block: one statement, atomic under psql too;
 *   - no BEGIN/COMMIT: migrate.js runs the file inside a SQL function, where
 *     transaction commands are refused;
 *   - the lesson-plan unique index is built only when no plan has two
 *     lp_generated quizzes (else a NOTICE);
 *   - the schema_versions row is written inside the block, then the PostgREST
 *     schema reload.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../../infrastructure/supabase/migrations/V2.9.0__lesson_quiz.sql');
const sql = fs.readFileSync(FILE, 'utf8');
const code = sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

describe('V2.9.0 lesson quiz migration', () => {
  test('the whole change is one DO block, with no transaction commands', () => {
    const blocks = code.match(/^DO \$\$/gm) || [];
    expect(blocks).toHaveLength(1);
    expect(code).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    const body = code.slice(code.indexOf('DO $$'), code.indexOf('END $$;'));
    for (const stmt of ['ADD COLUMN IF NOT EXISTS coaching_session_id', 'ADD COLUMN IF NOT EXISTS meta',
      'quizzes_status_check', 'quizzes_teacher_recent', 'quizzes_one_transcript_quiz_per_session',
      'quizzes_one_lesson_plan_quiz', 'quiz_share_codes ADD COLUMN IF NOT EXISTS teacher_to']) {
      expect(body).toContain(stmt);
    }
  });

  test('the lesson-plan unique index is guarded by a duplicate check', () => {
    const guard = code.indexOf('HAVING count(*) > 1');
    const idx = code.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS quizzes_one_lesson_plan_quiz');
    expect(guard).toBeGreaterThan(-1);
    expect(idx).toBeGreaterThan(guard);
    expect(code).toMatch(/RAISE NOTICE 'quizzes_one_lesson_plan_quiz not created/);
  });

  test('records 2.9.0 in schema_versions inside the block, then reloads the API schema', () => {
    const insert = code.indexOf("INSERT INTO schema_versions (version, description)");
    expect(insert).toBeGreaterThan(code.indexOf('DO $$'));
    expect(insert).toBeLessThan(code.indexOf('END $$;'));
    expect(code).toMatch(/VALUES \('2\.9\.0', 'Lesson quiz: [^']+'\)\s*ON CONFLICT \(version\) DO NOTHING;/);
    expect(code.trimEnd().endsWith("NOTIFY pgrst, 'reload schema';")).toBe(true);
  });
});
