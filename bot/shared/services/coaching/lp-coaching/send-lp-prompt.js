/**
 * Send a lesson-plan prompt through the right facade method.
 *
 * buildLPSelectionList returns EITHER { type: 'list', listData } (the teacher has plans Rumi made) or
 * { type: 'buttons', body, buttons } (Yes/No). A list payload must go to sendInteractiveMessage — handing it to
 * sendInteractiveButtons throws on `buttons.length` — and a refused list (a channel or payload limit returns false
 * rather than throwing) falls back to the Yes/No buttons, which always fit.
 *
 * @returns {Promise<boolean>} true only when a prompt actually went out. Callers must gate the move to
 *   awaiting_lesson_plan on it, or a session waits at a step the teacher was never shown.
 */
async function sendLpPrompt(WhatsAppService, to, lpPrompt, fallbackButtons = null) {
  if (lpPrompt && lpPrompt.type === 'list' && lpPrompt.listData) {
    const sent = await WhatsAppService.sendInteractiveMessage(to, lpPrompt.listData);
    if (sent !== false) return true;
    if (!fallbackButtons) return false;
    return (await WhatsAppService.sendInteractiveButtons(to, fallbackButtons)) !== false;
  }
  return (await WhatsAppService.sendInteractiveButtons(to, lpPrompt)) !== false;
}

module.exports = { sendLpPrompt };
