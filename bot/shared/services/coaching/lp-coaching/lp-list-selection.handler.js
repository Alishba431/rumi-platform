/**
 * A tap (or numbered reply) on the lesson-plan picker → link it and continue the coaching flow.
 *
 *   lp_select_{lessonPlanId}_{sessionId}  link a plan Rumi made for the teacher
 *   lp_upload_{sessionId}                 the teacher will send a document or paste the text
 *   lp_none_{sessionId}                   continue without a plan
 *
 * The linker does the database write; this owns what happens next, which the picker never had: tell the teacher,
 * then queue the analysis. A pick that arrives after the analysis already ran (the list stays in the chat)
 * recomputes only the fidelity section rather than re-running the whole analysis.
 */
const supabase = require('../../../config/supabase');
const { logToFile } = require('../../../utils/logger');
const { getCoachingMessage } = require('../../../config/coaching-messages');
const { TERMINAL_STATUSES } = require('./lp-step.service');

const LP_ID_RE = /^lp_(select|upload|none)_/;
// The session id is always the trailing UUID; a plan id could contain underscores.
const SESSION_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

async function loadSession(sessionId) {
  const { data } = await supabase
    .from('coaching_sessions')
    .select('id, status, user_id, users(preferred_language)')
    .eq('id', sessionId)
    .maybeSingle();
  return data || null;
}

/**
 * @returns {Promise<boolean>} true when the id was a picker row and has been handled
 */
async function handleLpListSelection(listId, from) {
  if (!LP_ID_RE.test(listId || '')) return false;
  const m = listId.match(SESSION_RE);
  if (!m) {
    logToFile('[lp-list] picker reply without a session id — ignoring', { listId });
    return false;
  }
  const sessionId = m[1];

  const WhatsAppService = require('../../whatsapp.service');
  const CoachingJobQueueService = require('../coaching-job-queue.service');
  const CoachingSessionService = require('../coaching-session.service');
  const linker = require('./lp-coaching-linker.service');

  const session = await loadSession(sessionId);
  if (!session || TERMINAL_STATUSES.includes(session.status)) {
    logToFile('[lp-list] picker reply for a session that is over — not linking', { sessionId, status: session && session.status });
    return true;
  }
  const lang = (session.users && session.users.preferred_language) || 'en';
  const result = await linker.handleLPSelection(sessionId, listId, { ownerUserId: session.user_id });
  const { isFidelityEnabled } = require('../fidelity/fidelity-orchestrator');

  if (result.awaiting_upload) {
    await WhatsAppService.sendMessage(from, getCoachingMessage(isFidelityEnabled() ? 'lessonPlan_request_or_paste' : 'lessonPlan_request', lang));
    return true;
  }

  if (result.lesson_plan_link_method === 'selected_recent') {
    await WhatsAppService.sendMessage(from, getCoachingMessage('lessonPlan_linked', lang));
  } else {
    await WhatsAppService.sendMessage(from, getCoachingMessage('lessonPlan_skip', lang));
  }

  if (session.status === 'awaiting_lesson_plan') {
    await CoachingSessionService.updateStatus(sessionId, 'analysis_started');
    await CoachingJobQueueService.queueAnalysis(sessionId, { from });
  } else if (result.lesson_plan_link_method === 'selected_recent' && isFidelityEnabled()) {
    // The analysis already ran: grade fidelity against the plan just picked, nothing else.
    const { recomputeFidelityForSession } = require('../fidelity/fidelity-recompute.service');
    await recomputeFidelityForSession(sessionId);
  }
  return true;
}

module.exports = { handleLpListSelection };
