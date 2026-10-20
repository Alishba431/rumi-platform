'use strict';
/**
 * Who the class report goes to.
 *
 * A VIDEO quiz is one `quizzes` row per video, shared by every teacher who is
 * sent that video; each teacher mints their own share code against it. So the
 * chat a class link went to belongs to the SHARE CODE, never to the quiz row:
 * a second teacher sharing the same video must not redirect the first
 * teacher's report (every child's name and score) to themselves.
 *
 * Driven end to end on one in-memory database: the real deliverClassLink mints
 * each teacher's code, the real report.generate reads it back.
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
// The real PDF path launches a headless browser; the recipient is decided
// before it, so a canned buffer is enough here.
jest.mock('../../bot/shared/utils/html-to-pdf', () => ({
  htmlToPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
  htmlToImage: jest.fn().mockResolvedValue(Buffer.from('png')),
  closeBrowser: jest.fn(),
}));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const supabase = require('../../bot/shared/config/supabase');
const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const share = require('../../bot/shared/services/quiz/video-quiz-share.service');
const report = require('../../bot/shared/services/quiz/video-quiz-report.service');
const { createMemorySupabase } = require('./helpers/memory-supabase');

const A_PHONE = '15550100001';
const A_MATRIX = 'mtx:15550100001';
const B_PHONE = '15550100002';
const C_PHONE = '15550100003';

function seed(quiz) {
  return createMemorySupabase({
    users: [
      { id: 'tA', name: 'Teacher A', phone_number: A_PHONE },
      { id: 'tB', name: 'Teacher B', phone_number: B_PHONE },
      { id: 'tC', name: 'Teacher C', phone_number: C_PHONE },
    ],
    quizzes: [quiz],
    quiz_share_codes: [],
    quiz_sessions: [],
    quiz_answers: [],
  }, { defaults: { quiz_share_codes: { active: true, report_sent_at: null, uses_count: 0 } } });
}

function finishedChild(mem, shareCodeId, n) {
  mem.table('quiz_sessions').push({
    id: `s-${shareCodeId}`, share_code_id: shareCodeId, student_name: `Child ${n}`, status: 'completed',
    total_questions_answered: 8, correct_answers: 6, mastery_percentage: 75,
    invited_by_student_id: null, created_at: new Date().toISOString(),
  });
}

const codeOf = (mem, teacher) => mem.table('quiz_share_codes').find((r) => r.teacher_user_id === teacher);

async function recipientsOf(shareCodeId) {
  jest.clearAllMocks();
  await report.generate(shareCodeId, { reason: 'all_finished' });
  return new Set([...WhatsAppService.sendMessage.mock.calls, ...WhatsAppService.sendDocument.mock.calls]
    .map((c) => c[0]));
}

beforeEach(() => { jest.clearAllMocks(); mockKv.clear(); });

describe('the class report goes to the teacher who shared THIS code', () => {
  test('teacher B sharing the same video does not redirect teacher A\'s report', async () => {
    const mem = seed({ id: 'vq1', topic: 'Magnets', video_id: 'v1', quiz_source: 'video', teacher_id: null, meta: {} });
    supabase.from.mockImplementation(mem.from);

    // A shares from Matrix on Monday, B from WhatsApp on Tuesday — same video row.
    await share.deliverClassLink({ quizId: 'vq1', userId: 'tA', videoId: 'v1', language: 'en' }, A_MATRIX);
    await share.deliverClassLink({ quizId: 'vq1', userId: 'tB', videoId: 'v1', language: 'en' }, B_PHONE);
    const scA = codeOf(mem, 'tA');
    const scB = codeOf(mem, 'tB');
    finishedChild(mem, scA.id, 1);
    finishedChild(mem, scB.id, 2);

    // The chat is recorded on each teacher's own code, and the shared row is untouched.
    expect(scA.teacher_to).toBe(A_MATRIX);
    expect(scB.teacher_to).toBe(B_PHONE);
    expect(mem.table('quizzes')[0].meta).toEqual({});

    expect(await recipientsOf(scA.id)).toEqual(new Set([A_MATRIX]));
    expect(await recipientsOf(scB.id)).toEqual(new Set([B_PHONE]));
  });

  test('a code minted before the chat was recorded goes to its own teacher\'s number, whatever the quiz row says', async () => {
    // A stale `meta.teacher_to` on the shared video row (written by the
    // previous build) must not be honoured for anyone's code.
    const mem = seed({ id: 'vq1', topic: 'Magnets', video_id: 'v1', quiz_source: 'video', teacher_id: null, meta: { teacher_to: B_PHONE } });
    supabase.from.mockImplementation(mem.from);
    mem.table('quiz_share_codes').push({
      id: 'scC', code: 'K7RM2Q', quiz_id: 'vq1', teacher_user_id: 'tC', teacher_name: 'Teacher C', topic: 'Magnets',
      language: 'en', active: true, report_sent_at: null, created_at: new Date().toISOString(),
    });
    finishedChild(mem, 'scC', 1);
    expect(await recipientsOf('scC')).toEqual(new Set([C_PHONE]));
  });

  test('a lesson quiz (one row per teacher) still honours the hand-off chat on its own teacher\'s code only', async () => {
    const mem = seed({ id: 'lq1', topic: 'Fractions', video_id: null, quiz_source: 'transcript', teacher_id: 'tA', meta: { teacher_to: A_MATRIX } });
    supabase.from.mockImplementation(mem.from);
    const push = (id, teacher) => mem.table('quiz_share_codes').push({
      id, code: `CODE${id}`, quiz_id: 'lq1', teacher_user_id: teacher, teacher_name: 'T', topic: 'Fractions',
      language: 'en', active: true, report_sent_at: null, created_at: new Date().toISOString(),
    });
    push('scA', 'tA');
    push('scX', 'tC');   // not the quiz's teacher: the quiz row's chat is not theirs
    finishedChild(mem, 'scA', 1);
    finishedChild(mem, 'scX', 2);
    expect(await recipientsOf('scA')).toEqual(new Set([A_MATRIX]));
    expect(await recipientsOf('scX')).toEqual(new Set([C_PHONE]));
  });

  test('the lesson-quiz hand-off mint records the chat on the code', async () => {
    const mem = seed({ id: 'lq1', topic: 'Fractions', quiz_source: 'transcript', teacher_id: 'tA', meta: {} });
    supabase.from.mockImplementation(mem.from);
    const minted = await share.mintCode({ quizId: 'lq1', userId: 'tA', videoId: null, language: 'en', teacherTo: A_MATRIX });
    expect(codeOf(mem, 'tA').id).toBe(minted.id);
    expect(codeOf(mem, 'tA').teacher_to).toBe(A_MATRIX);
  });
});
