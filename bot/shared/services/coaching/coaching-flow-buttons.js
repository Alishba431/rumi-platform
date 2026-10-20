/**
 * The classroom-photo question's buttons. transcription-processor asks "share a classroom photo?" (photo_yes_ /
 * photo_no_) and the image handler asks "add another?" (photo_more_ / photo_done_) after each photo — but none of
 * the four ids had a handler, so a session stalled at awaiting_photo unless the teacher sent the maximum number of
 * photos. "No" and "Done" move to the lesson-plan step; "Yes" and "Add another" ask for the photo.
 */
const supabase = require('../../config/supabase');
const { logToFile } = require('../../utils/logger');
const { getCoachingMessage } = require('../../config/coaching-messages');

const PHOTO_ID_RE = /^photo_(yes|no|more|done)_(.+)$/;

/**
 * @returns {Promise<boolean>} true when the id was a photo-question button and has been handled
 */
async function handleCoachingFlowButton(buttonId, from, user) {
  const m = PHOTO_ID_RE.exec(buttonId || '');
  if (!m) return false;
  const [, action, sessionId] = m;

  if (action === 'no' || action === 'done') {
    logToFile('📸 Photo step finished — moving to the lesson-plan step', { sessionId, action });
    const { advanceToLessonPlanStep } = require('./lp-coaching/lp-step.service');
    await advanceToLessonPlanStep({ sessionId, from, tapperUserId: user && user.id });
    return true;
  }

  const { data: session } = await supabase
    .from('coaching_sessions')
    .select('status, conversation_state, users(preferred_language)')
    .eq('id', sessionId)
    .maybeSingle();
  if (!session || session.status !== 'awaiting_photo') return true;
  await supabase
    .from('coaching_sessions')
    .update({ conversation_state: { ...(session.conversation_state || {}), current_state: 'COLLECTING_PHOTOS' } })
    .eq('id', sessionId);
  const lang = (session.users && session.users.preferred_language) || 'en';
  const WhatsAppService = require('../whatsapp.service');
  await WhatsAppService.sendMessage(from, getCoachingMessage('photo_sendNow', lang));
  return true;
}

module.exports = { handleCoachingFlowButton };
