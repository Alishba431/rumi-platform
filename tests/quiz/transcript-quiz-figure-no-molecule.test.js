'use strict';
/**
 * `molecule` is not a quiz figure type.
 *
 * The engine draws a structure only through the optional `openchemlib`
 * package, which the bot does not install, so every molecule fell back to a
 * formula card ("CH4" in a box) the child could not read a structure off.
 * Until the dependency is declared and tested, the validator refuses the type
 * and the author prompt never offers it.
 */

jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const { validate } = require('../../bot/shared/services/quiz/transcript-quiz-validator');
const Figure = require('../../bot/shared/services/quiz/transcript-quiz-figure');

const DIGEST = { subject: 'science', slos: [{ id: 'S1', statement: 'Name simple molecules from their formula', taught_level: 'understand' }] };
const W = ['one', 'two', 'three', 'four', 'five', 'six'];
function q(i, over = {}) {
  return {
    slo_id: 'S1', level: 'understand',
    question: `Question ${W[i]}: which gas is made of one carbon atom and four hydrogen atoms?`,
    options: [`methane ${W[i]}`, `oxygen ${W[i]}`, `nitrogen ${W[i]}`], correct_index: 0,
    explanation: 'CH4 is methane.',
    distractor_misconceptions: { 1: 'mixed up the elements', 2: 'guessed a common gas' },
    option_feedback: { correct: 'Yes, that is methane.', wrong: { 1: 'Oxygen is O2.', 2: 'Nitrogen is N2.' } },
    ...over,
  };
}

test('the validator rejects a molecule figure', () => {
  const qs = [0, 1, 2, 3, 4, 5].map((i) => q(i, i === 0 ? { figure: { type: 'molecule', formula: 'CH4', name: 'methane' } } : {}));
  const r = validate(qs, { language: 'en', subject: 'science', digest: DIGEST, nExpected: 6 });
  expect(r.errors.join('\n')).toMatch(/q0: FIGURE_TYPE[^\n]*molecule/);
});

test('molecule is on neither the allowlist nor the 6-12 roster', () => {
  expect(Figure.ALLOWED_TYPES).not.toContain('molecule');
  expect(Figure.CORE_TYPES).not.toContain('molecule');
});
