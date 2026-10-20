'use strict';
/**
 * How text reaches the /testpaper conversation. Kept separate from
 * text-message.handler so it is unit-testable without the handler's full
 * dependency graph (the homework-trigger convention).
 *
 *   /testpaper [subject], /paper [subject]   start (optionally narrowed to a subject)
 *   /mypapers, /my papers                    the teacher's papers
 *   any other text                           read by the conversation only when a
 *                                            pick is pending (numbers, a mix, a pasted
 *                                            chapter, an edit request)
 *
 * "Assessment" is deliberately not a trigger: in this repo it means the
 * reading assessment.
 */

const { logToFile } = require('../utils/logger');

const START_RX = /^\/(?:test\s?paper|paper)(?:\s+(.*))?$/i;
const MINE_RX = /^\/my\s?papers$/i;

/** @returns {{command: 'start'|'mine', args: string} | null} */
function parseTestPaperCommand(text) {
  const s = String(text || '').trim();
  if (MINE_RX.test(s)) return { command: 'mine', args: '' };
  const m = s.match(START_RX);
  if (!m) return null;
  return { command: 'start', args: (m[1] || '').trim().replace(/\s+/g, ' ') };
}

function orchestrator() {
  // eslint-disable-next-line global-require -- loaded on use; most messages are not about test papers
  return require('../services/testpaper/testpaper-orchestrator.service');
}

/**
 * @returns {Promise<boolean>} true when the message was a test-paper command
 *   or an answer the pending conversation consumed — the handler stops there.
 */
async function routeTestPaperText({ user, from, messageBody, language }) {
  const parsed = parseTestPaperCommand(messageBody);
  try {
    if (parsed && parsed.command === 'start') {
      await orchestrator().start({ user, from, args: parsed.args, language });
      return true;
    }
    if (parsed && parsed.command === 'mine') {
      if (!user?.id) return false;
      await orchestrator().showMyPapers({ user, from, language });
      return true;
    }
    if (!user?.id) return false;
    return await orchestrator().handleText({ user, from, text: messageBody, language });
  } catch (error) {
    logToFile('⚠️ test paper routing error (message passed on)', { error: error.message });
    return Boolean(parsed);
  }
}

async function _language(user) {
  try {
    // eslint-disable-next-line global-require -- loaded on use, like the orchestrator
    const { getUserLanguage } = require('../utils/language-cache');
    return (await getUserLanguage(user.id)) || user.preferred_language || 'en';
  } catch {
    return user.preferred_language || 'en';
  }
}

/**
 * A list row or reply button from whatsapp-bot.js's interactive branches.
 * Only `tp_` ids are ours; everything else is left to the existing routing.
 * @returns {Promise<boolean>} true when handled
 */
async function routeTestPaperSelection({ user, from, id }) {
  if (typeof id !== 'string' || !id.startsWith('tp_') || !user?.id) return false;
  try {
    return await orchestrator().handleSelection({ user, from, id, language: await _language(user) });
  } catch (error) {
    logToFile('❌ test paper selection failed', { id, error: error.message });
    return false;
  }
}

/**
 * A document, offered to the conversation before the other document handlers:
 * it is taken only while the teacher has been asked to send a chapter.
 * @returns {Promise<boolean>} true when taken as a paper's source
 */
async function routeTestPaperDocument({ user, from, message }) {
  if (!user?.id) return false;
  try {
    return await orchestrator().handleDocument({ user, from, message, language: await _language(user) });
  } catch (error) {
    logToFile('⚠️ test paper document routing error (passed on)', { error: error.message });
    return false;
  }
}

module.exports = { parseTestPaperCommand, routeTestPaperText, routeTestPaperSelection, routeTestPaperDocument };
