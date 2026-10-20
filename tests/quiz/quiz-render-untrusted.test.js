'use strict';
/**
 * Every lesson-quiz render runs in html-to-pdf's untrusted mode.
 *
 * The figure PNG, the question card, the teacher PDF, the class report PDF,
 * the child's scorecard and the class card are all built from text a model or
 * a child wrote. Escaping is the first gate; the second is the browser itself:
 * these pages run no JavaScript and may fetch nothing but data: / about:.
 * Driven through each real render function and the real html-to-pdf; only
 * playwright-core (the browser) and the stores are stand-ins.
 */

const path = require('path');

jest.mock('../../bot/shared/config/languages', () => ({
  LANGUAGE_OFFER: ['en', 'ur'],
  getLanguage: (c) => jest.requireActual('../../bot/shared/config/quiz-languages').getLanguage(c),
}), { virtual: true });
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));
jest.mock('../../bot/shared/config/supabase', () => ({
  from: jest.fn(() => ({ update: () => ({ eq: async () => ({ error: null }) }) })),
}));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendImage: jest.fn(async () => true),
  sendMessage: jest.fn(async () => true),
}));
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  get: jest.fn(async () => null), set: jest.fn(async () => true),
}));

const PLAYWRIGHT = (() => {
  try {
    return require.resolve('playwright-core', { paths: [path.join(__dirname, '../../bot/shared/utils')] });
  } catch {
    return null;
  }
})();

let contexts;
function mockBrowser() {
  contexts = [];
  const newContext = jest.fn(async (opts) => {
    const page = {
      setContent: jest.fn().mockResolvedValue(),
      evaluate: jest.fn().mockResolvedValue(),
      pdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
      $: jest.fn().mockResolvedValue(null),
      screenshot: jest.fn().mockResolvedValue(Buffer.from('89504e470d0a1a0a', 'hex')),
    };
    const ctx = { opts, route: jest.fn().mockResolvedValue(), newPage: jest.fn().mockResolvedValue(page), close: jest.fn().mockResolvedValue() };
    contexts.push(ctx);
    return ctx;
  });
  const browser = { isConnected: () => true, newContext, on: jest.fn(), close: jest.fn().mockResolvedValue() };
  const playwright = () => ({ chromium: { launch: jest.fn().mockResolvedValue(browser) } });
  if (PLAYWRIGHT) jest.doMock(PLAYWRIGHT, playwright);
  else jest.doMock('playwright-core', playwright, { virtual: true });
}

beforeEach(() => {
  jest.resetModules();
  mockBrowser();
});

function expectUntrusted() {
  expect(contexts.length).toBeGreaterThan(0);
  for (const ctx of contexts) {
    expect(ctx.opts).toEqual(expect.objectContaining({ javaScriptEnabled: false }));
    expect(ctx.route).toHaveBeenCalledWith('**/*', expect.any(Function));
  }
}

const DIGEST = { subject: 'maths', slos: [{ id: 'S1', statement_en: 'Add with carrying', taught_level: 'apply' }] };
const Q = [{ slo_id: 'S1', level: 'apply', question: 'What is 146 + 27?', options: ['173', '163', '1613'], correct_index: 0, explanation: 'Ones first.' }];

test('the figure PNG', async () => {
  const Figure = require('../../bot/shared/services/quiz/transcript-quiz-figure');
  await Figure.renderFigurePng('<svg></svg>', 'ur');
  expectUntrusted();
});

test('the question card PNG', async () => {
  const Card = require('../../bot/shared/services/quiz/transcript-quiz-card');
  await Card.renderQuestionCardPng({ question: 'What is 3/4 + 1/4?', options: ['1', '2', '3'], language: 'en', index: 0, total: 6 });
  expectUntrusted();
});

test('the teacher PDF', async () => {
  const Render = require('../../bot/shared/services/quiz/transcript-quiz-render');
  await Render.renderPdf({
    quiz: { topic: 'Adding', language: 'en', quiz_source: 'transcript' },
    questions: Q, digest: DIGEST, teacherName: 'Teacher Example', grade: '2', lessonSummary: '', language: 'en', date: '2 Oct', link: 'x',
  });
  expectUntrusted();
});

test('the class report PDF', async () => {
  const Report = require('../../bot/shared/services/quiz/video-quiz-report.service');
  await Report.renderReportPdf({ topic: 'Adding', teacherName: 'Teacher Example', classes: ['Blue'], students: [], hardest: [], unfinished: [], language: 'en' });
  expectUntrusted();
});

test('the child scorecard', async () => {
  const Score = require('../../bot/shared/services/quiz/video-quiz-scorecard.service');
  const png = await Score.renderScorecardImage({ topic: 'Adding', correct: 3, total: 4, pct: 75, subject: 'maths', takerName: 'Child One', language: 'en' });
  expect(png).toBeTruthy();
  expectUntrusted();
});

test('the class card', async () => {
  const saved = process.env.CLASS_CARD_ENABLED;
  process.env.CLASS_CARD_ENABLED = 'true';
  try {
    const Report = require('../../bot/shared/services/quiz/video-quiz-report.service');
    const out = await Report.sendClassCards({
      shareCode: { id: 'sc-1', quiz_id: 'quiz-1', topic: 'Fractions' },
      quizRow: { meta: {}, quiz_source: 'transcript' },
      done: [{
        id: '1', student_id: 'st-1', student_name: 'Child One', status: 'completed',
        correct_answers: 6, total_questions_answered: 8, mastery_percentage: 75,
        completed_at: new Date(Date.now() - 60 * 1000).toISOString(), parent_phone: 'matrix:@child1:example.org',
      }],
      reason: 'scheduled', language: 'en', className: '',
    });
    expect(out.sent + out.skipped).toBeGreaterThan(0);
    expectUntrusted();
  } finally {
    if (saved === undefined) delete process.env.CLASS_CARD_ENABLED; else process.env.CLASS_CARD_ENABLED = saved;
  }
});
