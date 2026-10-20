-- =============================================================================
-- V2.6.0 - Observe: the coach's assistant
--
-- Adds what /observe needs on an existing deployment. A fresh install gets the
-- same shape from 00_complete-schema.sql + 01_rls-policies.sql. Additive only:
-- every statement is IF NOT EXISTS, nothing is dropped or rewritten.
--
--   coaching_sessions  + observation_type / observer_user_id /
--                        autofill_analysis_data / debrief_status
--   users              + role (the coach role family reads it) + school_id
--   schools            one row per school a coach can be assigned
--   leader_schools     which schools a coach holds; the coach's teachers are
--                      DERIVED from it (leader_schools x users.school_id), never
--                      stored a second time
--   observation_schedules  one upcoming visit per (coach, school, teacher)
--   coach_directory    coach -> work email, only for the optional calendar
-- =============================================================================

-- A leader observation is a coaching_sessions row like any other, so the whole
-- transcription + analysis pipeline is reused. user_id is the observed teacher
-- (or the coach on a bare capture, until the teacher is named); the coach is
-- observer_user_id. NULL observation_type = the teacher's own recording.
ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS observation_type       VARCHAR(30);
ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS observer_user_id       UUID;
-- Frozen v1 of the AI analysis, written exactly once; analysis_data then holds
-- the coach-edited v2. The v1 -> v2 diff is the record of what the coach changed.
ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS autofill_analysis_data JSONB;
-- pending | done: whether the coach's debrief step has run.
ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS debrief_status         VARCHAR(20);

CREATE INDEX IF NOT EXISTS idx_coaching_sessions_observer_pending
  ON coaching_sessions (observer_user_id, created_at DESC)
  WHERE observation_type = 'leader_observation';

-- The role family that may use /observe is config (OBSERVE_LEADER_ROLES), so
-- the column is free text: no CHECK list to migrate when a deployment names
-- its coaches differently. NULL = a teacher.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(30);

CREATE TABLE IF NOT EXISTS schools (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The school's id in the deployment's own register (a census code, a
  -- district number...). Free text on purpose; OBSERVE_SCHOOL_ID_PREFIX can
  -- namespace it when one database serves several registers.
  ext_id      TEXT,
  name        TEXT NOT NULL,
  district    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_schools_ext_id ON schools (ext_id) WHERE ext_id IS NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS school_id UUID REFERENCES schools(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_school_id ON users (school_id);

CREATE TABLE IF NOT EXISTS leader_schools (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  leader_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  school_id       UUID REFERENCES schools(id) ON DELETE CASCADE,
  school_ext_id   TEXT,
  school_name     TEXT NOT NULL,
  -- Where the assignment came from ('manual', 'import', ...). Free text, set by
  -- OBSERVE_ROSTER_SOURCE; no deployment-specific enum.
  source          TEXT NOT NULL DEFAULT 'manual',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (leader_user_id, school_id)
);
CREATE INDEX IF NOT EXISTS idx_leader_schools_leader ON leader_schools (leader_user_id);
CREATE INDEX IF NOT EXISTS idx_leader_schools_school_id ON leader_schools (school_id);

CREATE TABLE IF NOT EXISTS observation_schedules (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  leader_user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  school_id          UUID REFERENCES schools(id) ON DELETE SET NULL,
  school_ext_id      TEXT NOT NULL,
  teacher_ext_id     TEXT NOT NULL,
  teacher_name       TEXT,
  school_name        TEXT,
  scheduled_for      DATE NOT NULL,
  scheduled_slot     TEXT,
  status             TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'done', 'cancelled')),
  session_id         UUID,
  calendar_event_id  TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_obs_sched_leader_status
  ON observation_schedules (leader_user_id, status, scheduled_for);
-- One upcoming visit per (coach, school, teacher): scheduling again moves it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_obs_sched_active
  ON observation_schedules (leader_user_id, school_ext_id, teacher_ext_id)
  WHERE status = 'upcoming';

CREATE TABLE IF NOT EXISTS coach_directory (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  leader_user_id  UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  full_name       TEXT NOT NULL,
  work_email      TEXT NOT NULL,
  -- exact: matched automatically; confirmed: a person checked it; manual: typed in.
  match_method    TEXT NOT NULL DEFAULT 'exact' CHECK (match_method IN ('exact', 'confirmed', 'manual')),
  confirmed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT coach_directory_confirmed_requires_timestamp
    CHECK (match_method <> 'confirmed' OR confirmed_at IS NOT NULL)
);

ALTER TABLE schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE leader_schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE observation_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE coach_directory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_schools" ON schools;
CREATE POLICY "service_role_schools" ON schools FOR ALL USING (auth.role() = 'service_role');
DROP POLICY IF EXISTS "service_role_leader_schools" ON leader_schools;
CREATE POLICY "service_role_leader_schools" ON leader_schools FOR ALL USING (auth.role() = 'service_role');
DROP POLICY IF EXISTS "service_role_observation_schedules" ON observation_schedules;
CREATE POLICY "service_role_observation_schedules" ON observation_schedules FOR ALL USING (auth.role() = 'service_role');
DROP POLICY IF EXISTS "service_role_coach_directory" ON coach_directory;
CREATE POLICY "service_role_coach_directory" ON coach_directory FOR ALL USING (auth.role() = 'service_role');

NOTIFY pgrst, 'reload schema';
