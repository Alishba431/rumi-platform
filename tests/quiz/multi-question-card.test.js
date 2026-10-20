'use strict';
/**
 * The question card for a "select all that apply" question:
 * two or three options are correct and the child replies with every right
 * letter, not by tapping one. `renderQuestionCardHtml` takes a
 * new optional `answerMode` ('single' default | 'multi'). On 'multi' the card
 * gains a cue line under the stem and its foot line stops claiming "Tap A, B
 * or C" (false on a multi question) in favour of a "reply with every right letter" instruction.
 * Both strings come from the ux-strings catalog, never hardcoded here.
 */
const crypto = require('crypto');
const Card = require('../../bot/shared/services/quiz/transcript-quiz-card');
const { resolveUx } = require('../../bot/shared/config/ux-strings');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Captured from the UNMODIFIED transcript-quiz-card.js (before the
// multi-answer change) for these exact inputs with answerMode omitted — the
// guarantee that every existing single-answer card is byte-for-byte untouched.
// Re-captured once, when an equation written in prose ("2 + 2") began to be
// typeset as one maths expression (quiz-math spanEquations): the only
// differences from the original capture are that expression and the maths
// stylesheet it brings with it. Still the single-answer output, unchanged by
// answerMode.
// The Urdu single-answer card carries the Urdu line-spacing block when
// QUIZ_URDU_SPACING_V2 is on (the default): the capture below is that output,
// and the switched-off output must still be the pre-spacing capture exactly.
// Re-captured for this repo: the card wears the deployment's mark
// (bot/shared/assets, quiz-brand brandMark), and the root suite runs with the
// KaTeX stub, so the English card's "2 + 2" carries no KaTeX stylesheet. With
// the mark swapped back, the two Urdu captures are the earlier ones exactly.
// Two captures: with the bot's katex installed the card inlines its stylesheet;
// the root CI job runs before the bot's dependencies are installed.
const KATEX_INSTALLED = (() => {
  try { require.resolve('katex/package.json', { paths: [require('path').join(__dirname, '..', '..', 'bot')] }); return true; } catch { return false; }
})();
const BASELINE_SINGLE_EN_SHA256 = KATEX_INSTALLED
  ? '4b6d6a52f4ab3fed3c4475a77931567bfce86ce50fe5405906bed9f5c77b906e'
  : '0498816fd1940fcbae4c0c2b3833d4b517857805666949078d7029bc3d6f854c';
const BASELINE_SINGLE_UR_SHA256 = '8b43f3f0207e2e1f6aa51aa4e3bdabeb93d2b961bc84c12aa824b1b59a768e01';
const BASELINE_SINGLE_UR_SPACING_OFF_SHA256 = '84990195fa26e14aedf4f93e9de4fff2758eaad5c11d2caed548310e85c1d98e';

const SINGLE_EN_DATA = { stem: 'What is 2 + 2?', options: ['3', '4', '5'], displayOrder: [0, 1, 2], language: 'en', questionNumber: 1, total: 5 };
const SINGLE_UR_DATA = { stem: 'کیا؟', options: ['ا', 'ب', 'ج'], displayOrder: [0, 1, 2], language: 'ur', questionNumber: 1, total: 5 };

describe('renderQuestionCardHtml — answerMode "single" is untouched', () => {
  test('omitted answerMode, en: byte-identical to the pre-existing output', () => {
    const html = Card.renderQuestionCardHtml(SINGLE_EN_DATA);
    expect(sha256(html)).toBe(BASELINE_SINGLE_EN_SHA256);
  });
  test('explicit answerMode:"single", ur: byte-identical to the pre-existing output', () => {
    const html = Card.renderQuestionCardHtml({ ...SINGLE_UR_DATA, answerMode: 'single' });
    expect(sha256(html)).toBe(BASELINE_SINGLE_UR_SHA256);
  });
  test('explicit answerMode:"single", ur, Urdu spacing switched off: byte-identical to the pre-spacing output', () => {
    const saved = process.env.QUIZ_URDU_SPACING_V2;
    process.env.QUIZ_URDU_SPACING_V2 = 'false';
    try {
      const html = Card.renderQuestionCardHtml({ ...SINGLE_UR_DATA, answerMode: 'single' });
      expect(sha256(html)).toBe(BASELINE_SINGLE_UR_SPACING_OFF_SHA256);
    } finally {
      if (saved === undefined) delete process.env.QUIZ_URDU_SPACING_V2; else process.env.QUIZ_URDU_SPACING_V2 = saved;
    }
  });
});

describe('renderQuestionCardHtml — answerMode "multi"', () => {
  test('en, 4 options: cue + multi foot present, four lettered rows, old foot gone', () => {
    const html = Card.renderQuestionCardHtml({
      stem: 'Which of these are prime numbers?',
      options: ['2', '4', '7', '9'],
      displayOrder: [0, 1, 2, 3],
      language: 'en',
      questionNumber: 2,
      total: 5,
      answerMode: 'multi',
    });
    expect(html).toContain(resolveUx('vqMultiSelectAll', { language: 'en' }));
    expect(html).toContain(resolveUx('vqMultiCardFoot', { language: 'en' }));
    expect(html).not.toContain('Tap A, B or C below');
    const letters = [...html.matchAll(/data-letter="([ABCD])"/g)].map((m) => m[1]);
    expect(letters).toEqual(['A', 'B', 'C', 'D']);
  });

  test('ur: Urdu cue + Urdu foot present, dir="rtl", no Latin instruction leaks in', () => {
    const html = Card.renderQuestionCardHtml({
      stem: 'کون سے اشکال مثلث ہیں؟',
      options: ['مربع', 'مثلث', 'دائرہ'],
      displayOrder: [0, 1, 2],
      language: 'ur',
      questionNumber: 2,
      total: 5,
      answerMode: 'multi',
    });
    expect(html).toMatch(/dir="rtl"/);
    expect(html).toContain(resolveUx('vqMultiSelectAll', { language: 'ur' }));
    expect(html).toContain(resolveUx('vqMultiCardFoot', { language: 'ur' }));
    expect(html).not.toContain('Tap A, B or C below');
    expect(html).not.toContain('نیچے A، B یا C دبائیں'); // the single-answer ur foot
  });

  test('three options + multi: three rows, still the multi cue and foot', () => {
    const html = Card.renderQuestionCardHtml({
      stem: 'Which are even?',
      options: ['2', '3', '4'],
      displayOrder: [0, 1, 2],
      language: 'en',
      questionNumber: 1,
      total: 3,
      answerMode: 'multi',
    });
    const letters = [...html.matchAll(/data-letter="([ABCD])"/g)].map((m) => m[1]);
    expect(letters).toEqual(['A', 'B', 'C']);
    expect(html).toContain(resolveUx('vqMultiSelectAll', { language: 'en' }));
    expect(html).toContain(resolveUx('vqMultiCardFoot', { language: 'en' }));
  });
});
