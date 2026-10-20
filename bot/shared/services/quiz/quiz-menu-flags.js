'use strict';
/**
 * Kill switches for the /quiz menu changes — one per behaviour, read at CALL
 * time, DEFAULT ON. Unset (or anything else) keeps the behaviour; 'false',
 * '0', 'off' or 'no' puts back the old behaviour exactly, with no deploy.
 *
 *   QUIZ_BARE_TEXT_TO_MENU     every bare spelling of "quiz" opens the menu (the
 *                              teacher's text door and a child's join)
 *   QUIZ_MENU_HANDSET_ROUTING  a quiz question waiting on the handset → stay in the quiz
 *   QUIZ_MENU_LESSON_ROWS      lesson plans with no quiz yet are listed in /quiz and made
 *                              on a tap
 *   QUIZ_MENU_SOURCE_LABELS    every row says "From lesson plan" / "From transcript"
 */

const OFF = new Set(['false', '0', 'off', 'no']);

function on(name) {
  return !OFF.has(String(process.env[name] == null ? '' : process.env[name]).trim().toLowerCase());
}

module.exports = {
  bareTextToMenu: () => on('QUIZ_BARE_TEXT_TO_MENU'),
  handsetRouting: () => on('QUIZ_MENU_HANDSET_ROUTING'),
  lessonRows: () => on('QUIZ_MENU_LESSON_ROWS'),
  sourceLabels: () => on('QUIZ_MENU_SOURCE_LABELS'),
};
