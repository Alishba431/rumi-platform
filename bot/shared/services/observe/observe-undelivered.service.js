/**
 * Observations that finished and never reached the teacher.
 *
 * Teacher delivery is a deliberate act by the coach: tap Send, check the
 * preview, tap Send again. Three states can be left behind and nothing else
 * reads them:
 *
 *   awaiting_confirm   the preview was shown and the coach tapped neither Send
 *                      nor Cancel — pulled into the next lesson, lost signal
 *   previewing         the render was queued and the coach left before it came
 *   (no record)        the coach never opened the send flow on that observation
 *
 * The planner reminds the coach ONCE after a day, then — two days after the
 * reminder — stops and says so. A delivery nobody ever chased that is already
 * past the age ceiling is closed SILENTLY: a sweep switched on over a backlog
 * must not fire a wave of messages about week-old observations. A row that HAS
 * been chased still ends in give_up and the coach is told, exactly once.
 *
 * Deliberately NOT in scope: `awaiting_teacher_tap` (the untapped planner owns
 * it) and any session that has not finished. Two sweeps on one row is how a
 * coach is told two contradictory things about one observation in one tick.
 *
 * Pure — no I/O, no clock of its own: the planner decides, the worker executes.
 */

const HOUR = 60 * 60 * 1000;

/** The delivery states this planner owns (plus "no record at all"). */
const OWNED_DELIVERY_STATES = new Set(['awaiting_confirm', 'previewing']);

/** Session statuses at which the report EXISTS. */
const FINISHED_SESSION_STATUSES = new Set(['completed', 'observer_review_complete']);

const _hoursFromEnv = (name, defaultMs) => {
  const hours = Number(process.env[name]);
  if (Number.isFinite(hours) && hours > 0) return hours * HOUR;
  return defaultMs;
};

/** A full day before we say anything: the coach may simply be teaching. */
const REMIND_AFTER_MS = _hoursFromEnv('OBSERVE_UNDELIVERED_REMIND_HOURS', 24 * HOUR);
/** …and two more days after the reminder before we stop and say so. */
const GIVE_UP_AFTER_MS = _hoursFromEnv('OBSERVE_UNDELIVERED_GIVE_UP_HOURS', 72 * HOUR);
/** Past this, a delivery nobody has chased is closed silently. */
const EXPIRE_AFTER_MS = _hoursFromEnv('OBSERVE_UNDELIVERED_EXPIRE_HOURS', 7 * 24 * HOUR);

const parsed = (iso) => {
  if (iso instanceof Date) return Number.isNaN(iso.getTime()) ? null : iso.getTime();
  const t = Date.parse(iso || '');
  return Number.isNaN(t) ? null : t;
};

/**
 * @param {object} c
 * @param {string|null} c.deliveryStatus teacher_delivery.status (absent = never opened)
 * @param {string} c.sessionStatus coaching_sessions.status
 * @param {string} c.finishedAt when the report became available
 * @param {string|null} c.reminded_at / c.gave_up_at / c.reminder_count
 * @param {number} nowMs
 * @returns {{action:'skip'|'remind'|'give_up'|'expire', reason:string}}
 */
function classifyUndelivered(candidate, nowMs = Date.now()) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  if (!FINISHED_SESSION_STATUSES.has(c.sessionStatus)) return { action: 'skip', reason: 'session_not_finished' };

  const status = c.deliveryStatus;
  const noRecord = status === null || status === undefined || status === '';
  if (!noRecord && !OWNED_DELIVERY_STATES.has(status)) return { action: 'skip', reason: 'not_undelivered' };

  // Notify-once: a closed row is never reopened by a later tick.
  if (c.gave_up_at) return { action: 'skip', reason: 'already_closed' };

  const finishedAt = parsed(c.finishedAt);
  if (finishedAt == null) return { action: 'skip', reason: 'no_finished_timestamp' };

  const remindedAt = parsed(c.reminded_at);
  const alreadyReminded = remindedAt != null || Number(c.reminder_count || 0) > 0;

  if (!alreadyReminded) {
    if (nowMs - finishedAt < REMIND_AFTER_MS) return { action: 'skip', reason: 'within_grace_window' };
    if (nowMs - finishedAt >= EXPIRE_AFTER_MS) return { action: 'expire', reason: 'too_old_to_chase' };
    return { action: 'remind', reason: 'no_send_after_grace' };
  }

  // Measured from the REMINDER: give_up answers a question the coach was asked.
  const since = remindedAt != null ? remindedAt : finishedAt;
  if (nowMs - since < GIVE_UP_AFTER_MS - REMIND_AFTER_MS) return { action: 'skip', reason: 'awaiting_reminder_response' };
  return { action: 'give_up', reason: 'no_send_after_reminder' };
}

/**
 * A coaching_sessions row → the planner's candidate. `updated_at` is when the
 * row last moved, which on a finished-and-idle observation IS the moment the
 * report became available (delivery merges do not touch it).
 */
function candidateFromSession(session) {
  const s = session || {};
  const d = (s.analysis_data && s.analysis_data.teacher_delivery) || {};
  return {
    deliveryStatus: d.status,
    sessionStatus: s.status,
    finishedAt: s.updated_at || s.created_at,
    reminded_at: d.reminded_at,
    reminder_count: d.reminder_count,
    gave_up_at: d.gave_up_at,
  };
}

module.exports = {
  classifyUndelivered,
  candidateFromSession,
  OWNED_DELIVERY_STATES,
  FINISHED_SESSION_STATUSES,
  REMIND_AFTER_MS,
  GIVE_UP_AFTER_MS,
  EXPIRE_AFTER_MS,
};
