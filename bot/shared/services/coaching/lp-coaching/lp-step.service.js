/**
 * The lesson-plan step of the teacher coaching flow: after the classroom-photo question, ask which plan the lesson
 * followed. One owner for landing on this step, whichever button got the teacher here ("No photo", "Done", or the
 * photo limit).
 *
 * With lesson-plan fidelity on, the prompt lists the plans Rumi made for this teacher (newest first,
 * LP_FIDELITY_LIST_LIMIT, at most 8 — a WhatsApp list holds 10 rows and two are the "upload or paste" and "no plan"
 * options). With it off, or with no plans yet, it is the original Yes/No question. On channels without native lists
 * the facade renders either as numbered text.
 */
const supabase = require('../../../config/supabase');
const { logToFile } = require('../../../utils/logger');

const TERMINAL_STATUSES = ['completed', 'cancelled', 'failed'];
const DEFAULT_LIST_LIMIT = 8;
const MAX_LIST_LIMIT = 8;

function listLimit() {
  const n = Math.floor(Number(process.env.LP_FIDELITY_LIST_LIMIT));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIST_LIMIT;
  return Math.min(n, MAX_LIST_LIMIT);
}

/** The plans Rumi made for this teacher, newest first (lesson plans only, not slide decks). */
async function recentLessonPlansFor(userId) {
  const { isFidelityEnabled } = require('../fidelity/fidelity-orchestrator');
  if (!isFidelityEnabled() || !userId) return [];
  try {
    const { data } = await supabase
      .from('lesson_plans')
      .select('id, topic, grade, created_at')
      .eq('user_id', userId)
      .eq('type', 'lesson_plan')
      .order('created_at', { ascending: false })
      .limit(listLimit());
    return Array.isArray(data) ? data.slice(0, listLimit()) : [];
  } catch (e) {
    logToFile('[lp-fidelity] recent plans fetch failed — Yes/No prompt instead', { error: e.message });
    return [];
  }
}

/**
 * Move the session to the lesson-plan step and send the prompt. Idempotent.
 * @param {{ sessionId: string, from: string, tapperUserId?: string }} args
 * @returns {Promise<boolean>} true when the prompt went out AND the session moved; false when the session is over or
 *   no prompt could be delivered (the session is then left where it was).
 */
async function advanceToLessonPlanStep({ sessionId, from }) {
  const WhatsAppService = require('../../whatsapp.service');
  const { buildLPSelectionList } = require('./lp-selection-list.service');
  const { sendLpPrompt } = require('./send-lp-prompt');

  const { data: session } = await supabase
    .from('coaching_sessions')
    .select('status, conversation_state, user_id, users(preferred_language)')
    .eq('id', sessionId)
    .maybeSingle();
  if (!session || TERMINAL_STATUSES.includes(session.status)) {
    logToFile('🚫 LP step refused — no such session or it is over', { sessionId, status: session && session.status });
    return false;
  }

  const lang = (session.users && session.users.preferred_language) || 'en';
  const recents = await recentLessonPlansFor(session.user_id);
  const prompt = buildLPSelectionList(sessionId, recents, lang);
  const fallback = buildLPSelectionList(sessionId, [], lang);
  const sent = await sendLpPrompt(WhatsAppService, from, prompt, fallback);
  if (!sent) {
    logToFile('⚠️ LP prompt could not be delivered — session left in place', { sessionId });
    return false;
  }

  await supabase
    .from('coaching_sessions')
    .update({
      status: 'awaiting_lesson_plan',
      conversation_state: { ...(session.conversation_state || {}), current_state: 'AWAITING_LESSON_PLAN' },
    })
    .eq('id', sessionId);

  logToFile('📄 LP step prompted', { sessionId, plansListed: recents.length });
  return true;
}

module.exports = { advanceToLessonPlanStep, recentLessonPlansFor, TERMINAL_STATUSES };
