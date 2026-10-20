/**
 * A lesson plan pasted into the chat as one message, while a coaching session waits for its plan.
 *
 * On a chat messenger pasting is often easier than attaching a file. With lesson-plan fidelity on, a long enough
 * text message sent while the teacher's session is at awaiting_lesson_plan is taken as the plan: stored whole in
 * lesson_plan_text (the fidelity extractor reads it), marked 'pasted', and the analysis is queued. Anything short
 * ("no", "2", a question) is not a plan and falls through to normal chat; numbered replies to the picker are
 * resolved before text handling ever sees them.
 */
const supabase = require('../../../config/supabase');
const { logToFile } = require('../../../utils/logger');
const { getCoachingMessage } = require('../../../config/coaching-messages');

// Below this a message is a reply, not a plan: the shortest real plans run to several sentences.
const MIN_PASTED_PLAN_CHARS = 120;
const EXCERPT_CHARS = 500;

function excerpt(text) {
  return text.length <= EXCERPT_CHARS ? text : `${text.slice(0, EXCERPT_CHARS)}...`;
}

/**
 * @param {{id: string}} user
 * @param {string} from
 * @param {string} text
 * @returns {Promise<boolean>} true when the text was taken as the session's plan
 */
async function handlePastedLessonPlan(user, from, text) {
  const { isFidelityEnabled } = require('../fidelity/fidelity-orchestrator');
  if (!isFidelityEnabled() || !user || !user.id) return false;
  const plan = String(text || '').trim();
  if (plan.length < MIN_PASTED_PLAN_CHARS) return false;

  const { data: rows } = await supabase
    .from('coaching_sessions')
    .select('id, status, users(preferred_language)')
    .eq('user_id', user.id)
    .eq('status', 'awaiting_lesson_plan')
    .order('created_at', { ascending: false })
    .limit(1);
  const session = rows && rows[0];
  if (!session) return false;

  await supabase
    .from('coaching_sessions')
    .update({
      lesson_plan_text: plan,
      lesson_plan_excerpt: excerpt(plan),
      lesson_plan_word_count: plan.split(/\s+/).filter(Boolean).length,
      lesson_plan_link_method: 'pasted',
      lesson_plan_extraction_status: 'completed',
      has_lesson_plan: true,
      linked_lesson_plan_id: null,
      status: 'analysis_started',
    })
    .eq('id', session.id);

  const lang = (session.users && session.users.preferred_language) || 'en';
  const WhatsAppService = require('../../whatsapp.service');
  await WhatsAppService.sendMessage(from, getCoachingMessage('lessonPlan_pasted', lang));
  const CoachingJobQueueService = require('../coaching-job-queue.service');
  await CoachingJobQueueService.queueAnalysis(session.id, { from, lpPasted: true });
  logToFile('📄 Pasted lesson plan taken for the coaching session', { sessionId: session.id, chars: plan.length });
  return true;
}

module.exports = { handlePastedLessonPlan, MIN_PASTED_PLAN_CHARS };
