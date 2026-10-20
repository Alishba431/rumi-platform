'use strict';
/**
 * Every rendered quiz picture carries the DEPLOYMENT's brand, never a fixed one.
 *
 * The class report, the child's score card and the class card take the bot's
 * name from config/branding.js (BOT_NAME, ORG_NAME) and the mark from the
 * deployment's own brand files (bot/shared/assets/rumi-mark-*.png, read by
 * quiz-brand brandMark). A clone that sets BOT_NAME sees its own name on every
 * artefact; nothing in the HTML names another organisation.
 */

// The lesson-quiz language helpers (transcript-quiz-language, adapted by the
// authoring slice) still read the retired config/languages registry in this
// tree. Until they move to config/quiz-languages, stand that registry in with
// the same shape; once they have moved this virtual module is simply unused.
jest.mock('../../bot/shared/config/languages', () => ({
  LANGUAGE_OFFER: ['en', 'ur'],
  getLanguage: (c) => jest.requireActual('../../bot/shared/config/quiz-languages').getLanguage(c),
}), { virtual: true });

const ENV = ['BOT_NAME', 'ORG_NAME'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.BOT_NAME = 'Example Bot';
  process.env.ORG_NAME = 'Example Schools';
  jest.resetModules();
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

// Every brand name the HTML carries (image alt text, the footer lockup) must be
// the configured one: an alt naming anything else is another organisation's mark.
const altNames = (html) => [...html.matchAll(/alt=["']([^"']*)["']/g)].map((m) => m[1]);
const FOREIGN = { test: (html) => altNames(html).some((n) => n !== 'Example Bot') };

test('the class report names the configured bot and organisation', () => {
  const render = require('../../bot/shared/templates/video-quiz-report.template');
  const html = render({
    topic: 'Fractions', teacherName: 'Teacher Example', started: 3, finished: 2, average: 70,
    students: [{ student_name: 'Child One', status: 'completed', correct_answers: 6, total_questions_answered: 8, mastery_percentage: 75 }],
    hardest: [], guidance: null, unfinished: [], language: 'en',
  });
  expect(html).toContain('Example Bot');
  expect(html).toContain('Example Schools');
  expect(FOREIGN.test(html)).toBe(false);
});

test('the score card and the class card carry no other organisation', () => {
  const scorecard = require('../../bot/shared/templates/video-quiz-scorecard.template');
  const leaderboard = require('../../bot/shared/templates/video-quiz-leaderboard.template');
  const card = scorecard({ topic: 'Fractions', correct: 7, total: 8, pct: 88, takerName: 'Child One', language: 'en' });
  const board = leaderboard({
    topic: 'Fractions', language: 'en', mode: 'full', targetSessionId: 's1',
    rows: [{ sessionId: 's1', name: 'Child One', correct: 7, total: 8, pct: 88 }],
  });
  expect(FOREIGN.test(card)).toBe(false);
  expect(FOREIGN.test(board)).toBe(false);
  expect(board).toContain('Example Bot');
});
