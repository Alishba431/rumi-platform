/**
 * /observe — the coach's entry point, and the coach's typed replies.
 *
 * handleObserveCommand: gates (feature, account, role) → one-time onboarding →
 * the menu (pending work oldest first, New observation, My schedule, Plan a
 * visit — observe-menu.service). A coach with no pending work and no roster
 * gets the bare capture prompt with awaiting_audio armed, exactly as before.
 * handleObserveText: the text-handler hook. /observe itself, plus any reply a
 * pending observe step is waiting for (the stepwise rating form, the teacher's
 * details for the report, a typed visit date). Returns false for everything
 * else so normal chat is untouched.
 *
 * Both return true when the message was handled (caller stops processing).
 */

const WhatsAppService = require('../services/whatsapp.service');
const ObserveState = require('../services/observe/observe-state.service');
const { evaluateObserveTrigger, OBSERVE_TRIGGER_RX, isObserveEnabled, isSchoolLeader } = require('../services/observe/observe-gate');
const { t, observeLang } = require('../services/observe/observe-strings');
const supabase = require('../config/supabase');
const { logToFile } = require('../utils/logger');

async function markOnboarded(user) {
  const mergedPrefs = {
    ...(user.preferences || {}),
    observe_onboarded: true,
    observe_onboarded_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('users').update({ preferences: mergedPrefs }).eq('id', user.id);
  if (error) {
    // Non-fatal: they'd see onboarding again next time. Log and continue.
    logToFile('⚠️ observe: failed to persist observe_onboarded flag', { userId: user.id, error: error.message });
  }
}

/** Ask for the recording and arm the slot the audio router reads. */
async function sendCapturePrompt(user, from) {
  return require('../services/observe/observe-visit.service').sendBareCapture(user, from);
}

/** After the gates: the menu, or the bare capture prompt when there is nothing to list. */
async function openObserve(user, from) {
  try {
    return await require('../services/observe/observe-menu.service').openMenu(user, from);
  } catch (err) {
    // The menu is a convenience; the recording is the product. Never dead-end.
    logToFile('⚠️ observe: menu failed, falling back to capture', { userId: user.id, error: err.message });
    return sendCapturePrompt(user, from);
  }
}

/**
 * @param {object|null} user  users row
 * @param {string} from       sender channel identity
 * @param {string} messageBody the (trimmed) inbound text
 * @returns {Promise<boolean>} handled?
 */
async function handleObserveCommand(user, from, messageBody) {
  const result = evaluateObserveTrigger({ messageBody, user });
  if (!result.match) return false;

  const lang = observeLang(user);
  logToFile('🔭 /observe command', { userId: user && user.id, from, action: result.action });

  switch (result.action) {
    case 'deny_no_user':
      await WhatsAppService.sendMessage(from, t(lang, 'no_account'));
      return true;

    case 'deny_role':
      await WhatsAppService.sendMessage(from, t(lang, 'role_denied'));
      return true;

    case 'onboard':
      // Persist the flag FIRST so a mid-flight crash can't replay the
      // one-time onboarding.
      await markOnboarded(user);
      await WhatsAppService.sendMessage(from, t(lang, 'onboard'));
      return openObserve(user, from);

    case 'capture':
    default:
      return openObserve(user, from);
  }
}

/**
 * The text-handler hook for coaches.
 * @returns {Promise<boolean>} handled?
 */
async function handleObserveText(user, from, text) {
  const trimmed = String(text || '').trim();
  if (OBSERVE_TRIGGER_RX.test(trimmed)) return handleObserveCommand(user, from, trimmed);
  if (!isObserveEnabled() || !isSchoolLeader(user)) return false;

  // The stepwise rating form (S1).
  const ObserveForm = require('../services/observe/observe-form.service');
  if (await ObserveForm.handleText(user, from, trimmed)) return true;

  const observeState = await ObserveState.getState(user.id).catch(() => null);
  if (!observeState) return false;

  // The report's recipient, typed as "Name, +1 555 010 0123". The original-case
  // text goes through so the teacher's name keeps its capitals.
  const ObserveSend = require('../services/observe/observe-send.service');
  if (ObserveSend.DETAILS_TEXT_STATES.includes(observeState.state)) {
    return ObserveSend.handleTeacherDetailsText(user, from, trimmed, observeState);
  }
  if (observeState.state === 'awaiting_visit_date') {
    return require('../services/observe/observe-visit.service').handleTypedDate(user, from, trimmed, observeState);
  }
  return false;
}

module.exports = { handleObserveCommand, handleObserveText, sendCapturePrompt };
