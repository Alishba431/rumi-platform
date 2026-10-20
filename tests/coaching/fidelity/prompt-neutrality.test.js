'use strict';
/**
 * The grader and extractor prompts are calibrated artefacts that ship to every deployment. They must not assume a
 * language pair, a gender, or one organisation's template: the teacher may teach in any language(s), and the
 * cross-language rule ("match on what the move achieves, not on words") is the part that carries over.
 */
const { GRADER_BRIEF } = require('../../../bot/shared/services/coaching/fidelity/grader-prompt');
const { UPLOAD_EXTRACTION_BRIEF } = require('../../../bot/shared/services/coaching/fidelity/upload-extractor-prompt');

const GENDERED = /\b(she|her|hers|herself|he|him|his|himself)\b/i;
const NAMED_LANGUAGES = /\b(urdu|english|hindi|swahili|arabic|devanagari)\b/i;

describe.each([
  ['GRADER_BRIEF', () => GRADER_BRIEF],
  ['UPLOAD_EXTRACTION_BRIEF', () => UPLOAD_EXTRACTION_BRIEF],
])('%s', (_name, get) => {
  test('uses no gendered pronoun for the teacher', () => {
    const hit = get().match(GENDERED);
    expect(hit && hit[0]).toBeNull();
  });

  test('names no particular language', () => {
    const hit = get().match(NAMED_LANGUAGES);
    expect(hit && hit[0]).toBeNull();
  });

  test('names no organisation template', () => {
    expect(get()).not.toMatch(/govt|government|college teaching-practice/i);
  });
});

describe('GRADER_BRIEF keeps the calibrated rules', () => {
  test.each([
    ["the teacher's language(s)"],
    ['GLOBAL-UNUSABILITY GUARD'],
    ['LESSON-MISMATCH RULE'],
    ['DIFFERENT CONTENT IS NOT A DIFFERENT MOVE'],
    ['DO NOT CONTRADICT YOURSELF'],
    ['One activity satisfies at most ONE prescribed move'],
    ['substituted_equivalent'],
    ['"lesson_mismatch"'],
    ['"recording_unusable"'],
  ])('contains %s', (phrase) => {
    expect(GRADER_BRIEF).toContain(phrase);
  });

  test('the evidence gloss is asked for in the reader\'s language, defaulting to English', () => {
    expect(GRADER_BRIEF).toMatch(/evidence_translation/);
  });
});
