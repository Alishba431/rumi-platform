'use strict';
/**
 * Which kind of chat is this quiz recipient on?
 *
 * The quiz speaks to teachers and children through the messaging facade
 * (whatsapp.service → messaging/index.js), which routes every send by the shape
 * of the recipient id. Three quiz decisions depend on that shape, and this leaf
 * module is the one place that reads it:
 *
 *   - the CLASS LINK a teacher forwards (a wa.me link only opens WhatsApp);
 *   - whether a question is sent as BUTTONS or as LETTERED TEXT the child
 *     answers by typing (Baileys and Matrix render buttons as numbered text,
 *     and a typed letter never matches a pending menu);
 *   - whether the 24-hour window and per-recipient pacing apply at all — they
 *     are WhatsApp rules (isWhatsAppRecipient), and Matrix, Slack and Discord
 *     have neither.
 *
 * A bare phone number is WhatsApp: the one resolved WhatsApp-family driver
 * (CHANNEL_DRIVER — Meta or Baileys). Anything with a `<prefix>:` is another
 * channel. An unknown prefix is NOT WhatsApp: a channel this build does not
 * register (Matrix ids look like `matrix:@user:server` or `mtx:<digits>`) must
 * never be treated as a phone number.
 *
 * Pure apart from reading the environment at call time; requires nothing that
 * requires back, so any quiz module can use it without joining a cycle.
 */

const MATRIX_PREFIXES = ['matrix', 'mtx'];

function prefixOf(id) {
  const s = String(id == null ? '' : id);
  const i = s.indexOf(':');
  return i === -1 ? null : s.slice(0, i).toLowerCase();
}

/** True for a bare phone number — the WhatsApp-family driver's recipients. */
function isWhatsAppRecipient(id) {
  return Boolean(id) && prefixOf(id) === null;
}

/** True for a Matrix recipient (`matrix:@user:server`, `mtx:<digits>`). */
function isMatrixRecipient(id) {
  return MATRIX_PREFIXES.includes(prefixOf(id));
}

/** The WhatsApp-family driver this deployment runs: 'meta' or 'baileys'. */
function whatsAppDriver() {
  try {
    const { resolveChannelDriver } = require('../../config/feature-availability');
    return resolveChannelDriver(process.env);
  } catch (_) {
    return 'meta';
  }
}

/**
 * Does this recipient answer a question by TYPING rather than tapping?
 *
 * Baileys and Matrix draw reply buttons and lists as numbered text, so a child
 * there reads "1. …  2. …" and types. Meta draws real buttons; Slack and
 * Discord have native components. On a typing channel the quiz sends each
 * question as lettered text and reads the letter itself (video-quiz.service
 * answerTypedLetter) — it never relies on the menu matcher, which refuses
 * one-letter replies by design.
 */
function answersByTyping(id) {
  if (isMatrixRecipient(id)) return true;
  if (isWhatsAppRecipient(id)) return whatsAppDriver() === 'baileys';
  return false;
}

module.exports = {
  isWhatsAppRecipient, isMatrixRecipient, answersByTyping, whatsAppDriver,
};
