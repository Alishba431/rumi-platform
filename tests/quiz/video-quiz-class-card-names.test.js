'use strict';
/**
 * What one child's class card shows about the OTHER children.
 *
 * The invite service draws the line for everything that crosses between
 * children (video-quiz-invite.service.js header): a first name and a score,
 * never a family name. The class card follows the same rule: every other
 * child appears by first name only, the top rows named and the rest as a
 * count ('top' mode); the child the card is for always sees their own row.
 *
 * Driven through the real sendClassCards and the real card template; the
 * picture renderer and the send are the stand-ins.
 */

jest.mock('../../bot/shared/config/supabase', () => ({
  from: jest.fn(() => ({ update: () => ({ eq: async () => ({ error: null }) }) })),
}));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendImage: jest.fn(async () => true),
  sendMessage: jest.fn(async () => true),
}));
const mockHtml = [];
jest.mock('../../bot/shared/utils/html-to-pdf', () => ({
  htmlToImage: jest.fn(async (html) => { mockHtml.push(html); return Buffer.from('89504e470d0a1a0a', 'hex'); }),
}));
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  get: jest.fn(async () => null), set: jest.fn(async () => true),
}));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const report = require('../../bot/shared/services/quiz/video-quiz-report.service');

const justNow = () => new Date(Date.now() - 60 * 1000).toISOString();
// Eight children, best first: Pupil1 scored highest, Pupil8 lowest.
const done = Array.from({ length: 8 }, (_, i) => ({
  id: `s${i + 1}`, student_id: `st${i + 1}`, student_name: `Pupil${i + 1} Family${i + 1}`, status: 'completed',
  correct_answers: 8 - i, total_questions_answered: 8, mastery_percentage: Math.round(((8 - i) / 8) * 100),
  completed_at: justNow(), parent_phone: `1555010010${i + 1}`,
}));

let saved;
beforeEach(() => {
  saved = process.env.CLASS_CARD_ENABLED;
  process.env.CLASS_CARD_ENABLED = 'true';
  mockHtml.length = 0;
});
afterEach(() => {
  if (saved === undefined) delete process.env.CLASS_CARD_ENABLED; else process.env.CLASS_CARD_ENABLED = saved;
});

test('no card carries another child\'s family name, and the lower ranks are a count, not names', async () => {
  const out = await report.sendClassCards({
    shareCode: { id: 'sc-1', quiz_id: 'quiz-1', topic: 'Fractions' },
    quizRow: { meta: {}, quiz_source: 'transcript' },
    done, reason: 'scheduled', language: 'en', className: '',
  });
  expect(out.sent).toBe(8);
  expect(mockHtml).toHaveLength(8);

  // The top child's card: the top rows by first name, nobody's family name but
  // their own, and the bottom of the class not named at all.
  const top = mockHtml[0];
  expect(top).toContain('Pupil2');
  for (let n = 2; n <= 8; n += 1) expect(top).not.toContain(`Family${n}`);
  expect(top).not.toContain('Pupil8');

  // The last child's card still shows their own row.
  const last = mockHtml[7];
  expect(last).toContain('Pupil8');
  for (let n = 1; n <= 7; n += 1) expect(last).not.toContain(`Family${n}`);
});
