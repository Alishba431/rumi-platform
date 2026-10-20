'use strict';
/**
 * Which of the inviter's runs their friend is compared with.
 *
 * An inviter may have finished the same quiz more than once. The comparison
 * uses their FIRST completed run, the attempt that counts, every time; a bare
 * `.limit(1)` returned whichever row the database happened to give first.
 *
 * Driven through the real notifyInviter on an in-memory database, with the
 * later run stored first so an unordered read picks the wrong one.
 */

jest.mock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  get: jest.fn(), set: jest.fn().mockResolvedValue(true), delete: jest.fn(),
}));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn().mockResolvedValue(true),
  sendInteractiveButtons: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const supabase = require('../../bot/shared/config/supabase');
const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const invite = require('../../bot/shared/services/quiz/video-quiz-invite.service');
const { createMemorySupabase } = require('./helpers/memory-supabase');

const INVITER_PHONE = '15550100061';
const run = (id, correct, completedAt) => ({
  id, student_id: 'st-inv', quiz_id: 'q1', status: 'completed',
  correct_answers: correct, total_questions_answered: 8, mastery_percentage: Math.round((correct / 8) * 100),
  completed_at: completedAt,
});

test('the friend is compared with the inviter\'s first completed run', async () => {
  const mem = createMemorySupabase({
    students: [{ id: 'st-inv', student_name: 'Pupil Inviter', phone: INVITER_PHONE }],
    quiz_sessions: [
      run('later', 8, '2026-09-02T10:00:00.000Z'),   // a retake, stored first
      run('first', 2, '2026-09-01T10:00:00.000Z'),
    ],
  });
  supabase.from.mockImplementation(mem.from);
  const friend = {
    invited_by_student_id: 'st-inv', quiz_id: 'q1', topic: 'Magnets', student_name: 'Pupil Friend',
    correct_answers: 5, total_questions_answered: 8, mastery_percentage: 63,
  };

  expect(await invite.notifyInviter(friend, 'en')).toBe(true);
  const expected = invite.buildComparison({
    inviter: { correct_answers: 2, total_questions_answered: 8, mastery_percentage: 25 },
    friend, topic: 'Magnets', language: 'en',
  });
  expect(WhatsAppService.sendMessage).toHaveBeenCalledWith(INVITER_PHONE, expected);
});
