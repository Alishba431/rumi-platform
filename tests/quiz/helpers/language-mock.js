'use strict';
/**
 * Contract fakes for the two modules the teacher's side leans on but does not
 * own, so these suites test the offer, /quiz, the hand-off, the nudge and the
 * providers against the CONTRACT rather than against whichever revision of
 * those modules is in the tree.
 *
 * transcript-quiz-language (`factory()`):
 *   needsLanguageAsk(subject)           a real choice exists: more than one
 *                                       QUIZ_LANGUAGES (a suite can force it)
 *   languageAskButtons(quizId, rule)    one `tq_lang_<code>_<quizId>` button per
 *                                       configured quiz language, the rule's first
 *   languageAskBody(lesson, lang)       the ask's text
 *   quizLanguageFor(subject, heard)     the heard language when it is a quiz
 *                                       language, else the deployment's first
 *   teacherLanguageFor, formatLessonDate, lessonLabel, topicFor, subjectLabel,
 *   canonicalSubject, isolate           plain, predictable renderings
 *
 * teacher-self-test (`selfTestFactory()`): the teacher's own run of their class
 * link is the session whose user_id is the teacher's.
 *
 * Use inside a jest.mock factory:
 *   jest.mock('<path>/transcript-quiz-language', () => require('./helpers/language-mock').factory());
 */

function factory() {
  const QL = jest.requireActual('../../../bot/shared/config/quiz-languages');
  const { clampLanguage } = jest.requireActual('../../../bot/shared/config/ux-strings');
  const clock = jest.requireActual('../../../bot/shared/config/school-clock');
  const topicFor = (digest, language) => {
    if (!digest) return null;
    if (digest.topic_as_taught && language && language === digest.language_of_instruction) return digest.topic_as_taught;
    return digest.topic || null;
  };
  return {
    needsLanguageAsk: jest.fn(() => QL.asksLanguage()),
    languageAskButtons: jest.fn((quizId, rule) => {
      const codes = QL.quizLanguages();
      const ordered = codes.includes(rule) ? [rule, ...codes.filter((c) => c !== rule)] : codes;
      return ordered.map((c) => ({ id: `tq_lang_${c}_${quizId}`, title: QL.getLanguage(c).languageTitle }));
    }),
    languageAskBody: jest.fn(() => 'Which language should the quiz be in?'),
    quizLanguageFor: jest.fn((_subject, heard) => (QL.isQuizLanguage(heard) ? heard : QL.quizLanguages()[0])),
    teacherLanguageFor: jest.fn(({ preferredLanguage } = {}) => clampLanguage(preferredLanguage)),
    formatLessonDate: jest.fn((iso) => (iso ? clock.localDate(new Date(iso)) : '')),
    lessonLabel: jest.fn(({ digest, quizLanguage } = {}) => {
      const topic = topicFor(digest, quizLanguage);
      return topic ? `${(digest && digest.subject) || 'lesson'} lesson on ${topic}` : 'lesson';
    }),
    topicFor: jest.fn(topicFor),
    subjectLabel: jest.fn((s) => (s ? String(s) : '')),
    canonicalSubject: jest.fn((s) => String(s || '').trim().toLowerCase()),
    isolate: jest.fn((t) => `⁨${t}⁩`),
  };
}

function selfTestFactory() {
  const isSelfTest = (s, teacherId) => Boolean(s && teacherId && s.user_id && s.user_id === teacherId);
  return {
    isSelfTest,
    excludeSelfTests: (sessions, teacherId) => (sessions || []).filter((s) => !isSelfTest(s, teacherId)),
    resolveSelfTest: jest.fn().mockResolvedValue(null),
  };
}

module.exports = { factory, selfTestFactory };
