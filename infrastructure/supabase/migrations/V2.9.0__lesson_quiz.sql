-- =============================================================================
-- V2.9.0 - Lesson quiz
-- A quiz written from the lesson the teacher taught (coaching transcript) or
-- planned (a Rumi lesson plan), shared with the class by one link.
--
-- ADDITIVE ONLY. Three nullable/defaulted columns on quizzes, three more
-- statuses on its CHECK, three indexes, one nullable column on
-- quiz_share_codes. Nothing here changes existing rows or existing code paths;
-- the feature stays off until TRANSCRIPT_QUIZ_ENABLED=true.
-- Fresh installs get the same shape from 00_complete-schema.sql.
--
-- ALL OR NOTHING. The whole change is one DO block, so it is one statement: if
-- any part fails, nothing is left applied, whether this file is run by psql,
-- the SQL editor or infrastructure/scripts/migrate.js. (A BEGIN/COMMIT pair
-- would not do: migrate.js runs the file inside a database function, where
-- transaction commands are refused.) Safe to run again.
-- =============================================================================

DO $$
BEGIN
  -- The coaching session a transcript quiz was written from. NULL for every
  -- other quiz_source.
  ALTER TABLE quizzes
    ADD COLUMN IF NOT EXISTS coaching_session_id UUID
      REFERENCES coaching_sessions(id) ON DELETE SET NULL;

  -- The language the QUESTIONS are written in.
  ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS language TEXT;

  -- Everything else the pipeline carries: the lesson digest (objectives, level
  -- taught, key terms), model + cost, the PDF's storage key, the share code and
  -- student message, the offer/decline timestamps, the error on a failed quiz.
  ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb;

  -- Three states for the offer lifecycle. 'offered' = the yes/no was sent;
  -- 'declined' = the teacher said no; 'skipped' = the lesson could not carry a
  -- quiz (reason in meta.skip_reason).
  ALTER TABLE quizzes DROP CONSTRAINT IF EXISTS quizzes_status_check;
  ALTER TABLE quizzes ADD CONSTRAINT quizzes_status_check CHECK (
    status = ANY (ARRAY[
      'generating', 'ready', 'sent', 'report_sent', 'failed', 'cancelled',
      'offered', 'declined', 'skipped'
    ])
  );

  -- /quiz lists a teacher's recent quizzes newest-first.
  CREATE INDEX IF NOT EXISTS quizzes_teacher_recent ON quizzes(teacher_id, created_at DESC);

  -- The idempotency anchors: one transcript quiz per coaching session, one
  -- lesson-plan quiz per plan. The offer job, an early trigger and a /quiz tap
  -- all INSERT, and exactly one wins.
  CREATE UNIQUE INDEX IF NOT EXISTS quizzes_one_transcript_quiz_per_session
    ON quizzes(coaching_session_id) WHERE quiz_source = 'transcript';
  -- The lesson-plan one is built only when no plan already has two
  -- 'lp_generated' quizzes. Nothing on earlier releases writes that source, but
  -- a database that did would otherwise refuse the whole migration. When it is
  -- skipped a NOTICE says so: keep one quiz per plan and run this file again.
  IF EXISTS (
    SELECT 1 FROM quizzes
    WHERE quiz_source = 'lp_generated' AND lesson_plan_id IS NOT NULL
    GROUP BY lesson_plan_id HAVING count(*) > 1
  ) THEN
    RAISE NOTICE 'quizzes_one_lesson_plan_quiz not created: some lesson plans have more than one lp_generated quiz. Keep one per plan, then run V2.9.0 again.';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS quizzes_one_lesson_plan_quiz
      ON quizzes(lesson_plan_id) WHERE quiz_source = 'lp_generated';
  END IF;

  -- The chat each class link was sent to, where that code's class report goes.
  -- On the share CODE, not the quiz: a video quiz is one row shared by every
  -- teacher who is sent that video. NULL (every existing code) = the teacher's
  -- users.phone_number, as before.
  ALTER TABLE quiz_share_codes ADD COLUMN IF NOT EXISTS teacher_to TEXT;

  -- Recorded inside the block, so the version is never marked applied unless
  -- everything above was.
  INSERT INTO schema_versions (version, description)
  VALUES ('2.9.0', 'Lesson quiz: quizzes coaching_session_id/language/meta + offer statuses, quiz_share_codes.teacher_to')
  ON CONFLICT (version) DO NOTHING;
END $$;

NOTIFY pgrst, 'reload schema';
