'use strict';
/**
 * Where a request for the quiz menu goes — ONE decision, whoever holds the phone.
 *
 * The text door (`text-message.handler.js`) hands every bare quiz request
 * (`quiz-menu-request.js`) here. Two answers, checked in this order:
 *
 *  1. A quiz QUESTION IS WAITING on this handset → stay in the quiz. One line in
 *     the quiz's own language, nothing else. Checked first because children
 *     take class quizzes on their teachers' phones, so "who is typing" is
 *     unknowable here and the quiz in progress is the thing to keep.
 *  2. EVERYONE ELSE → the teacher's /quiz menu: one interactive list. Meta shows
 *     it as a list; Baileys and the other text drivers show it as numbered text
 *     the teacher answers with a number. There is no Flow for this menu — a
 *     surface that only works where Meta Flows are published would leave every
 *     other channel without /quiz.
 *
 * Every answer logs `quiz_menu.requested {userId, route}` — ids only.
 */

const WhatsAppService = require('../whatsapp.service');
const { logToFile } = require('../../utils/logger');
const { logEvent } = require('../../utils/structured-logger');
const { resolveUx, clampLanguage } = require('../../config/ux-strings');
const QuizMenuFlags = require('./quiz-menu-flags');

const ROUTES = Object.freeze({
  STILL_IN_QUIZ: 'still_in_quiz',
  TEACHER_MENU: 'teacher_menu',
});

/** The question a quiz on this handset is waiting on, or null. Never throws. */
async function waitingQuestion(from) {
  try {
    const VideoQuizService = require('./video-quiz.service');
    const state = await VideoQuizService.getActiveState(from);
    return state && state.currentQuestionId ? state : null;
  } catch (err) {
    // A state read that failed is not "no quiz": the menu below is the safe
    // default only because a reminder we cannot ground would be a guess.
    logToFile('❌ quiz menu: quiz-state read failed — answering with the menu', { error: err.message }, 'error');
    return null;
  }
}

/**
 * @param {object} args
 * @param {object} args.user       the users row
 * @param {string} args.from       the handset
 * @param {string|null} args.language the teacher's resolved language
 * @param {string|null} [args.sessionId] the chat session — accepted for the caller's signature; the
 *   classic row receives it on the tap (transcript-quiz-list handleListPick)
 * @param {string} [args.trigger]  what asked: 'text' | 'button' (log only)
 * @returns {Promise<string>} the route taken (ROUTES)
 */
async function openQuizMenu({ user, from, language = null, trigger = 'text' }) {
  const userId = (user && user.id) || null;
  const log = (route, extra = {}) => logEvent('quiz_menu.requested', { userId, route, trigger, ...extra });

  // QUIZ_MENU_HANDSET_ROUTING off: every handset gets the teacher menu.
  const live = QuizMenuFlags.handsetRouting() ? await waitingQuestion(from) : null;
  if (live) {
    const lang = clampLanguage(live.language || language);
    await WhatsAppService.sendMessage(from, resolveUx('vqStillInQuiz', { language: lang }));
    log(ROUTES.STILL_IN_QUIZ, { quizSessionId: live.sessionId || null });
    return ROUTES.STILL_IN_QUIZ;
  }

  const List = require('./transcript-quiz-list.service');
  const teacher = { ...user, preferred_language: language || (user && user.preferred_language) };
  await List.showList(teacher, from, language, 1);
  log(ROUTES.TEACHER_MENU, { how: 'list' });
  return ROUTES.TEACHER_MENU;
}

module.exports = { openQuizMenu, ROUTES };
