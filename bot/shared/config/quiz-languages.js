'use strict';
/**
 * The languages a lesson quiz can be written in — this deployment's, in order.
 *
 * QUIZ_LANGUAGES is a comma list of codes from config/supported-languages.js
 * (default `en`). With more than one, a teacher who says yes to a quiz is asked
 * which language its questions should be in, and the ask lists exactly these.
 * The FIRST is the default where no ask happens.
 *
 * The questions can be written in any of them; the fixed copy around the quiz
 * (buttons, the score card, the class report's labels) comes from
 * config/ux-strings.js, which carries English and Urdu and falls back to
 * English for the rest.
 *
 * Read per call, so a settings change needs no restart.
 */

const { LANGUAGES, isSupported, isRTL } = require('./supported-languages');

const DEFAULT_QUIZ_LANGUAGES = Object.freeze(['en']);

/** @returns {string[]} the configured quiz languages, never empty */
function quizLanguages() {
  const raw = String(process.env.QUIZ_LANGUAGES || '').trim();
  if (!raw) return [...DEFAULT_QUIZ_LANGUAGES];
  const out = [];
  for (const part of raw.split(',')) {
    const code = part.trim();
    if (code && isSupported(code) && !out.includes(code)) out.push(code);
  }
  return out.length ? out : [...DEFAULT_QUIZ_LANGUAGES];
}

/** Does a teacher get asked which language the quiz is in? */
function asksLanguage() {
  return quizLanguages().length > 1;
}

function isQuizLanguage(code) {
  return quizLanguages().includes(code);
}

/**
 * Everything a quiz surface needs to know about a language.
 * @returns {{code:string, direction:'rtl'|'ltr', languageTitle:string, languageDescription:string}|undefined}
 */
function getLanguage(code) {
  const row = LANGUAGES[code];
  if (!row) return undefined;
  return {
    code, direction: isRTL(code) ? 'rtl' : 'ltr', languageTitle: row.native, languageDescription: row.english,
  };
}

module.exports = {
  DEFAULT_QUIZ_LANGUAGES, quizLanguages, asksLanguage, isQuizLanguage, getLanguage,
};
