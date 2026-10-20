-- =============================================================================
-- V2.5.0 - Attendance register: staff attendance and Leave
--
-- For existing deployments; fresh installs get the same from 00_complete-schema.sql.
-- Additive and idempotent. The one in-place change is a CHECK WIDENING on
-- attendance_records.status, and only where the legacy CHECK exists: every row
-- valid before stays valid after.
-- =============================================================================

-- A school, so a head teacher's staff can be found. `ext_id` is an optional
-- external identifier for deployments that have one. Same definition as the
-- coach-observation migration; whichever runs first creates it.
CREATE TABLE IF NOT EXISTS schools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ext_id TEXT,
    name TEXT NOT NULL,
    district TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE schools ADD COLUMN IF NOT EXISTS ext_id TEXT;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS district TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_schools_ext_id ON schools (ext_id) WHERE ext_id IS NOT NULL;

-- Who works where, and in which job. NULL or 'teacher' is a teacher;
-- 'head_teacher' marks staff attendance ('principal' and 'school_leader' are
-- read as the same role, never written).
ALTER TABLE users ADD COLUMN IF NOT EXISTS school_id UUID REFERENCES schools(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(30);
CREATE INDEX IF NOT EXISTS idx_users_school_id ON users (school_id);

-- Staff attendance: one row per (teacher, day).
CREATE TABLE IF NOT EXISTS teacher_attendance_records (
    id UUID NOT NULL DEFAULT uuid_generate_v4(),
    teacher_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    status VARCHAR(16) NOT NULL,
    leave_type VARCHAR(16),
    marked_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    marked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    UNIQUE (teacher_id, date),
    CONSTRAINT teacher_attendance_status_valid
        CHECK (status IN ('present', 'absent', 'leave')),
    CONSTRAINT teacher_attendance_leave_type_valid
        CHECK (leave_type IS NULL OR (status = 'leave' AND leave_type IN ('casual', 'sick', 'official')))
);
CREATE INDEX IF NOT EXISTS idx_teacher_attendance_school_date
    ON teacher_attendance_records (school_id, date);
CREATE INDEX IF NOT EXISTS idx_teacher_attendance_teacher_date
    ON teacher_attendance_records (teacher_id, date DESC);

ALTER TABLE schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_attendance_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_schools" ON schools;
CREATE POLICY "service_role_schools" ON schools FOR ALL USING (auth.role() = 'service_role');
DROP POLICY IF EXISTS "service_role_teacher_attendance_records" ON teacher_attendance_records;
CREATE POLICY "service_role_teacher_attendance_records" ON teacher_attendance_records FOR ALL USING (auth.role() = 'service_role');

-- Student Leave: a tally on the session, and the status on the record.
ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS leave_count INTEGER DEFAULT 0;

-- Existing rows: a session's leave tally from any records already on leave
-- (written as the legacy 'excused'), so old months total correctly.
UPDATE attendance_sessions s
SET leave_count = sub.n
FROM (
    SELECT session_id, COUNT(*)::int AS n
    FROM attendance_records
    WHERE status IN ('leave', 'excused')
    GROUP BY session_id
) sub
WHERE s.id = sub.session_id AND COALESCE(s.leave_count, 0) = 0;
UPDATE attendance_sessions SET leave_count = 0 WHERE leave_count IS NULL;

-- Widen the legacy CHECK (present, absent, late, excused) to accept 'leave'.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'attendance_records_status_check'
          AND conrelid = 'attendance_records'::regclass
          AND pg_get_constraintdef(oid) NOT LIKE '%leave%'
    ) THEN
        ALTER TABLE attendance_records DROP CONSTRAINT attendance_records_status_check;
        ALTER TABLE attendance_records ADD CONSTRAINT attendance_records_status_check
            CHECK (status IN ('present', 'absent', 'leave', 'late', 'excused'));
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';
