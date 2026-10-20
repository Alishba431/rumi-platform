-- =============================================================================
-- V2.5.1 - Teacher nudges
-- One table for scheduled, proactive messages to teachers ("nudges"): one row
-- per (teacher, local day, kind). The bot's sweeper books rows, claims the due
-- ones (pending -> sending, single-flight) and records the outcome.
-- See docs/features/teacher-nudges.md.
--
-- Additive and idempotent: safe to re-run, touches no existing data. The same
-- definitions are mirrored in 00_complete-schema.sql (fresh installs) and the
-- RLS policy in 01_rls-policies.sql.
-- =============================================================================

CREATE TABLE IF NOT EXISTS teacher_nudges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- A code registry, not a CHECK: a new kind needs no migration.
    kind TEXT NOT NULL,
    -- The local calendar day (TEACHER_NUDGES_TZ) the nudge belongs to.
    nudge_date DATE NOT NULL,
    scheduled_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'failed')),
    -- Why a nudge was deliberately not sent (window_closed, quiet_hours, ...).
    skip_reason TEXT,
    -- What the nudge was about, plus an error message on failure. Merged, never replaced.
    context JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- How many times the row has been claimed.
    attempts INTEGER NOT NULL DEFAULT 0,
    claimed_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One nudge per teacher per local day per kind. Booking relies on this.
    CONSTRAINT teacher_nudges_one_per_day UNIQUE (user_id, nudge_date, kind)
);

-- The sweeper's claim: due, pending rows, oldest first.
CREATE INDEX IF NOT EXISTS idx_teacher_nudges_due
    ON teacher_nudges (scheduled_at) WHERE status = 'pending';
-- A teacher's recent nudges (the "same quiet spell" check).
CREATE INDEX IF NOT EXISTS idx_teacher_nudges_user_recent
    ON teacher_nudges (user_id, nudge_date DESC);
-- The re-engage cohort reads users by how long ago they last wrote in.
CREATE INDEX IF NOT EXISTS idx_users_last_message_at
    ON users (last_message_at);

-- Bot-only table: the service role reads and writes it; nobody else.
ALTER TABLE teacher_nudges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_teacher_nudges" ON teacher_nudges;
CREATE POLICY "service_role_teacher_nudges" ON teacher_nudges FOR ALL USING (auth.role() = 'service_role');

-- Where a proactive send goes: the exact identifier the teacher last wrote from
-- on each channel, stamped on every inbound (bot-helpers.getOrCreateUserByChannel).
ALTER TABLE user_channels ADD COLUMN IF NOT EXISTS reply_identifier VARCHAR(255);

NOTIFY pgrst, 'reload schema';
