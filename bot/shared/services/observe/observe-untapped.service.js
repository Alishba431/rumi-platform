/**
 * Reports waiting on the teacher's tap (Meta only).
 *
 * A teacher outside the 24-hour messaging window cannot be sent a report
 * directly; they get the approved invite template, and the report follows only
 * when they TAP it (observe-send.service, phase 'teacher_tap'). Until then the
 * coach has been told "invitation sent" and would hear nothing more.
 *
 * So the chase is bounded and event-closed:
 *   - the tap is recorded (tapped_at) and the coach is told when it lands;
 *   - at most ONE nudge, after a full day of silence;
 *   - then we stop and tell the coach plainly.
 * A teacher is never nudged twice, and a coach is never left guessing.
 *
 * Pure — no I/O, no clock of its own: the planner decides, the worker executes.
 */

const HOUR = 60 * 60 * 1000;

/** A full day of silence before we say anything again. */
const NUDGE_AFTER_MS = 24 * HOUR;
/** …and a further two days before we stop and tell the coach. */
const GIVE_UP_AFTER_MS = 48 * HOUR;
/**
 * Past this, a delivery nobody has chased is CLOSED SILENTLY. A sweep that
 * starts (or restarts) on a backlog must not message about week-old
 * observations: rows too old to act on are closed, not messaged. A report that
 * HAS been nudged still ends in give_up and the coach is told, exactly once.
 * Overridable (in days, minimum 4) so the ramp can change without a deploy.
 */
const EXPIRE_AFTER_MS = (() => {
  const days = Number(process.env.OBSERVE_UNTAPPED_EXPIRE_DAYS);
  if (Number.isFinite(days) && days > 3) return days * 24 * HOUR;
  return 7 * 24 * HOUR;
})();

const parsed = (iso) => {
  const t = Date.parse(iso || '');
  return Number.isNaN(t) ? null : t;
};

/**
 * @param {object} delivery analysis_data.teacher_delivery
 * @param {number} nowMs
 * @returns {{action:'skip'|'nudge'|'give_up'|'expire', reason:string}}
 */
function classifyUntappedDelivery(delivery, nowMs = Date.now()) {
  const d = delivery || {};
  if (d.status !== 'awaiting_teacher_tap') return { action: 'skip', reason: 'not_awaiting_tap' };
  // The event that closes the loop: once tapped, never chased again.
  if (d.tapped_at) return { action: 'skip', reason: 'already_tapped' };
  if (d.gave_up_at) return { action: 'skip', reason: 'already_gave_up' };

  const sentAt = parsed(d.template_sent_at);
  if (sentAt == null) return { action: 'skip', reason: 'no_send_timestamp' };

  const nudgedAt = parsed(d.nudged_at);
  const alreadyNudged = nudgedAt != null || Number(d.nudge_count || 0) > 0;

  if (!alreadyNudged) {
    if (nowMs - sentAt < NUDGE_AFTER_MS) return { action: 'skip', reason: 'within_grace_window' };
    if (nowMs - sentAt >= EXPIRE_AFTER_MS) return { action: 'expire', reason: 'too_old_to_chase' };
    return { action: 'nudge', reason: 'no_tap_after_grace' };
  }

  // Nudged once already — the only remaining move is to stop and say so.
  const since = nudgedAt != null ? nudgedAt : sentAt;
  if (nowMs - since < GIVE_UP_AFTER_MS) return { action: 'skip', reason: 'awaiting_nudge_response' };
  return { action: 'give_up', reason: 'no_tap_after_nudge' };
}

module.exports = { classifyUntappedDelivery, NUDGE_AFTER_MS, GIVE_UP_AFTER_MS, EXPIRE_AFTER_MS };
