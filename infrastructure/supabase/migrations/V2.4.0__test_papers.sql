-- =============================================================================
-- V2.4.0 - Test papers (/testpaper)
-- For existing deployments; fresh installs get the same tables from
-- 00_complete-schema.sql. Additive only: two new tables, their indexes and RLS.
-- Safe to re-run.
-- =============================================================================

-- ============================================================================
-- TEST PAPERS (/testpaper)
-- ============================================================================
-- A teacher picks material the deployment already has — a textbook chapter,
-- their own lesson plans, or a chapter they upload — and gets a printable test
-- paper with a separate answer key. Every edit makes a NEW version; a ready
-- paper is never rewritten, so "my papers" can always re-send exactly what was
-- printed. ("Assessment" already means reading assessment in this repo, hence
-- the name.)

-- 1. test_paper_requests — the ask: what the paper covers and how it is built.
-- source_text is the material exactly as the generator read it, so every later
-- version is built from the same text even if a lesson plan is edited or a
-- textbook re-imported in the meantime.
CREATE TABLE IF NOT EXISTS test_paper_requests (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_kind      TEXT NOT NULL
                     CHECK (source_kind IN ('lesson_plan', 'textbook', 'upload')),
    -- What was picked: {"lessonPlanIds":[...]} | {"textbookId":"…","chapterNumbers":[…]} | {"filename":"…"}
    source_ref       JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_label     TEXT,
    source_text      TEXT NOT NULL,
    subject          TEXT,
    grade            TEXT,
    language         TEXT NOT NULL DEFAULT 'en',
    content_source   TEXT NOT NULL DEFAULT 'unseen'
                     CHECK (content_source IN ('seen', 'unseen', 'both')),
    question_types   JSONB NOT NULL DEFAULT '[]'::jsonb,
    question_count   INTEGER CHECK (question_count IS NULL OR question_count BETWEEN 1 AND 60),
    total_marks      INTEGER CHECK (total_marks IS NULL OR total_marks BETWEEN 1 AND 1000),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_test_paper_requests_user_time
    ON test_paper_requests (user_id, created_at DESC);

-- 2. test_papers — one row per version of a paper. Version 1 is the first
-- paper; each edit inserts the next version pointing at the one it came from.
CREATE TABLE IF NOT EXISTS test_papers (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id       UUID NOT NULL REFERENCES test_paper_requests(id) ON DELETE CASCADE,
    version          SMALLINT NOT NULL DEFAULT 1,
    edited_from      UUID REFERENCES test_papers(id) ON DELETE SET NULL,
    edit_instruction TEXT,
    status           TEXT NOT NULL DEFAULT 'generating'
                     CHECK (status IN ('generating', 'ready', 'failed')),
    title            TEXT,
    exam_json        JSONB,
    question_count   INTEGER,
    total_marks      INTEGER,
    model            TEXT,
    input_tokens     INTEGER,
    output_tokens    INTEGER,
    -- A machine code (INSUFFICIENT_SOURCE, MODEL_UNAVAILABLE, …) and a short
    -- technical detail. Never a teacher's or child's name or phone number.
    error_code       TEXT,
    error_detail     TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    ready_at         TIMESTAMPTZ,
    UNIQUE (request_id, version)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'test_papers_edited_from_not_self') THEN
    ALTER TABLE test_papers ADD CONSTRAINT test_papers_edited_from_not_self
      CHECK (edited_from IS NULL OR edited_from <> id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_test_papers_request ON test_papers (request_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_test_papers_inflight ON test_papers (created_at) WHERE status = 'generating';

-- RLS, as in 01_rls-policies.sql
ALTER TABLE test_paper_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_papers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_test_paper_requests" ON test_paper_requests;
CREATE POLICY "service_role_test_paper_requests" ON test_paper_requests FOR ALL USING (auth.role() = 'service_role');
DROP POLICY IF EXISTS "service_role_test_papers" ON test_papers;
CREATE POLICY "service_role_test_papers" ON test_papers FOR ALL USING (auth.role() = 'service_role');

INSERT INTO schema_versions (version, description)
VALUES ('2.4.0', 'Test papers: test_paper_requests + test_papers (versions)')
ON CONFLICT (version) DO NOTHING;

NOTIFY pgrst, 'reload schema';
