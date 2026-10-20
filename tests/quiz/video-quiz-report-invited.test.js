'use strict';
/**
 * A friend a child invited counts in the teacher's report.
 *
 * The invite service files a friend's session under the TEACHER's share code
 * (video-quiz-invite.service.js header: "the teacher queries one share code
 * and sees every child who took their quiz, however they reached it"), and
 * that is what the report did before lesson quizzes. The invite only decides
 * who ALSO hears the result.
 *
 * Driven through the real report.generate on an in-memory database; the PDF
 * printer and the send are the stand-ins (the printer's HTML is what we read).
 */

jest.mock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn().mockResolvedValue(true),
  sendDocument: jest.fn().mockResolvedValue(true),
  sendInteractiveButtons: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../bot/shared/services/queue/sqs-queue.service', () => ({
  queueJob: jest.fn().mockResolvedValue({ MessageId: 'm1' }),
}));
const mockKv = new Map();
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  get: jest.fn(async (k) => (mockKv.has(k) ? mockKv.get(k) : null)),
  set: jest.fn(async (k, v) => { mockKv.set(k, v); return true; }),
  setNX: jest.fn(async (k, v) => { if (mockKv.has(k)) return false; mockKv.set(k, v); return true; }),
  delete: jest.fn(async (k) => { mockKv.delete(k); return true; }),
  isAvailable: () => true,
}));
jest.mock('../../bot/shared/utils/html-to-pdf', () => ({
  htmlToPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
  htmlToImage: jest.fn().mockResolvedValue(Buffer.from('png')),
  closeBrowser: jest.fn(),
}));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const supabase = require('../../bot/shared/config/supabase');
const { htmlToPdf } = require('../../bot/shared/utils/html-to-pdf');
const report = require('../../bot/shared/services/quiz/video-quiz-report.service');
const { createMemorySupabase } = require('./helpers/memory-supabase');

const now = () => new Date().toISOString();
const session = (id, name, invitedBy) => ({
  id, share_code_id: 'sc1', student_id: `st-${id}`, student_name: name, status: 'completed',
  total_questions_answered: 8, correct_answers: 6, mastery_percentage: 75,
  invited_by_student_id: invitedBy, user_id: null, created_at: now(), completed_at: now(),
});

beforeEach(() => { jest.clearAllMocks(); mockKv.clear(); });

test('the teacher\'s report names the child who came through a friend\'s invite', async () => {
  const mem = createMemorySupabase({
    users: [{ id: 't1', name: 'Teacher Example', phone_number: '15550100001' }],
    quizzes: [{ id: 'q1', topic: 'Magnets', video_id: 'v1', quiz_source: 'video', teacher_id: null, meta: {} }],
    quiz_share_codes: [{
      id: 'sc1', code: 'K7RM2Q', quiz_id: 'q1', teacher_user_id: 't1', teacher_name: 'Teacher Example',
      topic: 'Magnets', language: 'en', active: true, report_sent_at: null, created_at: now(),
    }],
    quiz_sessions: [
      session('s1', 'Pupil Direct', null),
      session('s2', 'Pupil Invited', 'st-s1'),
    ],
    quiz_answers: [],
  });
  supabase.from.mockImplementation(mem.from);

  await report.generate('sc1', { reason: 'all_finished' });
  expect(htmlToPdf).toHaveBeenCalled();
  const html = htmlToPdf.mock.calls[0][0];
  expect(html).toContain('Pupil Direct');
  expect(html).toContain('Pupil Invited');
});
