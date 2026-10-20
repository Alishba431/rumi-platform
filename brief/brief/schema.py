"""Read the LIVE schema once and let the panels switch themselves on.

The baseline open-source schema has no leader observations and no lesson-plan ratings; a fork
that adds those columns gets those panels without touching the brief. Nothing here assumes a
table exists — `Features` is the single answer to "can this panel be drawn on this database?"."""
from __future__ import annotations

# the event tables that make a teacher "active", with the columns the union needs
ACTIVE_SOURCES = [
    ("conversations", "user_id", "created_at", "role = 'user'"),
    ("lesson_plans", "user_id", "created_at", None),
    ("coaching_sessions", "user_id", "created_at", None),
    ("reading_assessments", "user_id", "created_at", None),
    ("quiz_sessions", "user_id", "created_at", None),
    ("attendance_sessions", "user_id", "created_at", None),
]

# optional feature tables for the usage strip, in display order
FEATURE_TABLES = [
    ("quiz_sessions", "quizzes", "quizzes sent"),
    ("attendance_sessions", "attendance", "attendance sessions"),
    ("exam_check_sessions", "exam_checks", "exams checked"),
    ("video_requests", "videos", "videos made"),
]

GROUP_BY_COLUMNS = ["school_name", "region", "organization"]


class Features:
    def __init__(self, cols: dict):
        self.cols = cols

    def has(self, table: str) -> bool:
        return table in self.cols

    def col(self, table: str, column: str) -> bool:
        return column in self.cols.get(table, set())

    @property
    def observations(self) -> bool:
        return self.col("coaching_sessions", "observation_type") and self.col("coaching_sessions", "observer_user_id")

    @property
    def debriefs(self) -> bool:
        return self.col("coaching_sessions", "debrief_status")

    @property
    def ratings(self) -> bool:
        return self.has("lp_feedback")

    @property
    def group_by_candidates(self) -> list:
        return [c for c in GROUP_BY_COLUMNS if self.col("users", c)]

    def resolve_group_by(self, preferred: str):
        """The preferred organising column if the users table has it, else the first one it
        does have, else None (every panel then reports the whole cohort as one unit)."""
        cands = self.group_by_candidates
        if preferred in cands:
            return preferred
        return cands[0] if cands else None

    def self_coaching(self, alias: str) -> str:
        """The WHERE clause tail that keeps a coaching_sessions read to a teacher's OWN coaching. A coach's
        observation is filed under the observed teacher (user_id) and its score is the coach's rating, so it
        never counts as the teacher's session; a database without the column has no observations to skip."""
        return f" AND {alias}.observation_type IS NULL" if self.col("coaching_sessions", "observation_type") else ""

    def active_sources(self) -> list:
        out = []
        for table, ucol, tcol, extra in ACTIVE_SOURCES:
            if not (self.has(table) and self.col(table, ucol) and self.col(table, tcol)):
                continue
            if table == "coaching_sessions" and self.self_coaching(table):
                # being observed by a coach is not an event the teacher originated
                extra = self.self_coaching(table)[len(" AND "):]
            out.append((table, ucol, tcol, extra))
        return out

    def feature_tables(self) -> list:
        return [t for t, _, _ in FEATURE_TABLES if self.has(t) and self.col(t, "created_at")]


def detect(conn) -> Features:
    cur = conn.cursor()
    cur.execute("/* schema.columns */ SELECT table_name, column_name FROM information_schema.columns "
                "WHERE table_schema = 'public'")
    cols: dict = {}
    for table, column in cur.fetchall():
        cols.setdefault(table, set()).add(column)
    return Features(cols)
