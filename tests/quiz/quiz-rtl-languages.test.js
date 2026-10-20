'use strict';
/**
 * The direction of a quiz document comes from the language registry
 * (config/supported-languages isRTL), not from a hand-kept list holding only
 * 'ur'. A quiz in Arabic or Pashto is laid out right to left like an Urdu one;
 * an English one stays left to right.
 */

jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const teacherSheet = require('../../bot/shared/templates/transcript-quiz-teacher.template');
const classReport = require('../../bot/shared/templates/video-quiz-report.template');

const sheet = (language) => teacherSheet({
  topic: 'دورة حياة النبات', teacherName: 'Teacher Example', date: '2 Oct 2026',
  digest: { slos: [] },
  questions: [{ question_text: 'ما الذي يأتي بعد البذرة؟', option_a: 'البرعم', option_b: 'الثمرة', correct_option: 'A' }],
  language, contentLanguage: language,
});

const report = (language) => classReport({
  topic: 'دورة حياة النبات', teacherName: 'Teacher Example', classes: ['Blue'],
  started: 1, finished: 1, average: 50,
  students: [{ name: 'Child One', correct: 1, total: 2, pct: 50 }],
  hardest: [{ text: 'ما الذي يأتي بعد البذرة؟', correct: 0, total: 1, pct: 0 }],
  unfinished: [], language, contentLanguage: language,
});

describe.each(['ar', 'ps-PK'])('a %s quiz is right to left', (language) => {
  test('the teacher sheet', () => {
    const html = sheet(language);
    expect(html).toContain(`<html dir="rtl" lang="${language}">`);
    expect(html).toMatch(/class="stem content" dir="rtl"/);
  });

  test('the class report', () => {
    const html = report(language);
    expect(html).toMatch(/^<!doctype html><html dir="rtl"/);
  });
});

describe('an English quiz stays left to right', () => {
  test('the teacher sheet', () => {
    expect(sheet('en')).toContain('<html dir="ltr" lang="en">');
  });
  test('the class report', () => {
    expect(report('en')).toMatch(/^<!doctype html><html dir="ltr"/);
  });
});

// The picture the child answers from: the question card and the figure frame.
// They follow the same registry, and set right-to-left text in the Nastaliq-
// first stack the teacher sheet uses, not in Inter.
const { renderQuestionCardHtml } = require('../../bot/shared/services/quiz/transcript-quiz-card');
const { figureHtml } = require('../../bot/shared/services/quiz/transcript-quiz-figure');

const card = (language) => renderQuestionCardHtml({
  stem: 'ما الذي يأتي بعد البذرة؟', options: ['البرعم', 'الثمرة', 'الجذر'], language,
  questionNumber: 1, total: 5,
});
const frame = (language) => figureHtml('<svg viewBox="0 0 10 10"></svg>', language, { questionNumber: 1, total: 5 });

describe.each(['ar', 'ps-PK', 'ur'])('a %s child card is right to left', (language) => {
  test('the question card', () => {
    const html = card(language);
    expect(html).toContain(`<html lang="${language}" dir="rtl">`);
    expect(html).toMatch(/\.card\{[^}]*font-family:'Noto Nastaliq Urdu'[^}]*direction:rtl\}/);
    expect(html).toMatch(/\.counter\{[^}]*direction:rtl/);
  });

  test('the figure frame', () => {
    const html = frame(language);
    expect(html).toContain(`<html lang="${language}"`);
    expect(html).toMatch(/font-family:'Noto Nastaliq Urdu'[^;]*;font-size:30px/);
  });
});

describe('an English child card stays left to right', () => {
  test('the question card', () => {
    const html = card('en');
    expect(html).toContain('<html lang="en" dir="ltr">');
    expect(html).toMatch(/\.card\{[^}]*font-family:'Inter'[^}]*direction:ltr\}/);
  });
  test('the figure frame', () => {
    expect(frame('en')).toContain('<html lang="en"');
  });
});
