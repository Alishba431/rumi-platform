/**
 * When is an observation COMPLETE?
 *
 * Without this, a coach-led observation never reached status='completed': the
 * flow's last status was observer_review_complete, so every surface counting
 * completed observations showed a coach who did every step at zero.
 *
 * An observation is done when all three hold:
 *   status = observer_review_complete   (the form was submitted)
 *   debrief_status = done               (the debrief was coached)
 *   teacher_delivery.status = sent      (the report reached the teacher)
 * Either order can finish it, so both the debrief's done-flip and the send
 * step's sent-merge call maybeCompleteObservation afterwards.
 *
 * The write is guarded on status = observer_review_complete so a concurrent
 * transition (a cancel, another worker) is never overwritten.
 */

const { logToFile } = require('../../utils/logger');

/**
 * @param {{ status?: string, debrief_status?: string,
 *           teacher_delivery?: { status?: string } | null }} session
 * @returns {boolean}
 */
function shouldComplete(session) {
  if (!session) return false;
  if (session.status !== 'observer_review_complete') return false;
  if (session.debrief_status !== 'done') return false;
  const d = session.teacher_delivery;
  return !!(d && d.status === 'sent');
}

/**
 * Flip the session to 'completed' when the three conditions hold. Never
 * throws — completion is bookkeeping and must not fail the calling flow.
 * @param {string} sessionId
 * @returns {Promise<boolean>} true when the flip happened
 */
async function maybeCompleteObservation(sessionId) {
  try {
    const supabase = require('../../config/supabase');
    const { data: row } = await supabase
      .from('coaching_sessions')
      .select('id, status, debrief_status, analysis_data')
      .eq('id', sessionId)
      .maybeSingle();
    if (!row) return false;
    const session = {
      status: row.status,
      debrief_status: row.debrief_status,
      teacher_delivery: (row.analysis_data && row.analysis_data.teacher_delivery) || null,
    };
    if (!shouldComplete(session)) return false;
    await supabase
      .from('coaching_sessions')
      .update({ status: 'completed' })
      .eq('id', sessionId)
      .eq('status', 'observer_review_complete');
    logToFile('🏁 observation completed (debrief done + report sent)', { sessionId });
    return true;
  } catch (err) {
    logToFile('⚠️ observe completion check failed (non-fatal)', { sessionId, error: err && err.message });
    return false;
  }
}

module.exports = { shouldComplete, maybeCompleteObservation };
