'use strict';
/**
 * The 24-hour window is a WhatsApp rule, and only WhatsApp children are held
 * to it.
 *
 * A child's class card goes out as free-form media, which WhatsApp (Meta)
 * allows only within 24 hours of the child's last message, so a WhatsApp
 * child whose last answer is older than that is skipped (no template is used
 * for children). Matrix, Slack and Discord have no such window: a child there
 * gets the card however long ago they finished.
 *
 * Driven through the real sendClassCards and the real card template; the
 * picture renderer, the stores and the WhatsApp facade are the stand-ins.
 */

const mockUpdates = [];
jest.mock('../../bot/shared/config/supabase', () => ({
  from: jest.fn((table) => ({
    update: (patch) => ({ eq: async () => { mockUpdates.push({ table, patch }); return { error: null }; } }),
  })),
}));
const mockSentTo = [];
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendImage: jest.fn(async (to) => { mockSentTo.push(to); return true; }),
  sendMessage: jest.fn(async () => true),
}));
jest.mock('../../bot/shared/utils/html-to-pdf', () => ({
  htmlToImage: jest.fn(async () => Buffer.from('89504e470d0a1a0a', 'hex')),
}));
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  get: jest.fn(async () => null), set: jest.fn(async () => true),
}));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const report = require('../../bot/shared/services/quiz/video-quiz-report.service');

const DAY = 24 * 3600 * 1000;
const longAgo = () => new Date(Date.now() - 2 * DAY).toISOString();
const justNow = () => new Date(Date.now() - 60 * 1000).toISOString();

function session(id, phone, completedAt) {
  return {
    id, student_id: `st-${id}`, student_name: `Child ${id}`, status: 'completed',
    correct_answers: 6, total_questions_answered: 8, mastery_percentage: 75,
    completed_at: completedAt, parent_phone: phone,
  };
}

let saved;
beforeEach(() => {
  saved = process.env.CLASS_CARD_ENABLED;
  process.env.CLASS_CARD_ENABLED = 'true';
  mockSentTo.length = 0;
  mockUpdates.length = 0;
});
afterEach(() => {
  if (saved === undefined) delete process.env.CLASS_CARD_ENABLED; else process.env.CLASS_CARD_ENABLED = saved;
});

test('a WhatsApp child outside the window is skipped; a Matrix child the same age gets the card', async () => {
  const out = await report.sendClassCards({
    shareCode: { id: 'sc-1', quiz_id: 'quiz-1', topic: 'Fractions' },
    quizRow: { meta: {}, quiz_source: 'transcript' },
    done: [
      session('1', '15550100001', longAgo()),
      session('2', 'matrix:@child2:example.org', longAgo()),
      session('3', '15550100003', justNow()),
    ],
    reason: 'scheduled', language: 'en', className: '',
  });

  expect(mockSentTo.sort()).toEqual(['15550100003', 'matrix:@child2:example.org'].sort());
  expect(out).toEqual(expect.objectContaining({ sent: 2, skipped: 1 }));
});
