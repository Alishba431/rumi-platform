'use strict';
/**
 * Rows stuck in `generating` (review F-S3).
 *
 *   - startGenerating flipped the row to `generating`, then queued the job with
 *     no try/catch: a queue that refused left the row `generating` with no job,
 *     and /quiz answered "still making" for ever.
 *   - A quiz_offer job that died after its own INSERT was redelivered into a
 *     23505 and returned `already_claimed`: the lesson was never offered.
 *   - /quiz answered "still making" for a `generating` row nothing had touched
 *     for hours.
 *
 * The real offer service and the real /quiz lesson provider run against a
 * stateful, schema-checked database; the queue, the sends and the digest are
 * mocked at their boundaries.
 */
jest.mock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn().mockResolvedValue(true),
  sendInteractiveButtons: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../bot/shared/services/queue', () => ({ queueJob: jest.fn().mockResolvedValue('mid') }));
jest.mock('../../bot/shared/services/quiz/transcript-quiz-digest.service', () => ({ run: jest.fn() }));
jest.mock('../../bot/shared/services/feature-intro.service', () => ({
  hasSeenIntroVideo: jest.fn().mockResolvedValue(false),
  markVideoShown: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../bot/shared/services/quiz/transcript-quiz-language', () => require('./helpers/language-mock').factory());
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const supabase = require('../../bot/shared/config/supabase');
const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const Queue = require('../../bot/shared/services/queue');
const Digest = require('../../bot/shared/services/quiz/transcript-quiz-digest.service');
const { resolveUx } = require('../../bot/shared/config/ux-strings');
const { makeSchemaDb } = require('./helpers/schema-db');
const Offer = require('../../bot/shared/services/quiz/transcript-quiz-offer.service');
const Provider = require('../../bot/shared/services/quiz/transcript-lesson-provider');

const SID = '11111111-1111-4111-8111-111111111111';
const QID = '22222222-2222-4222-8222-222222222222';
const UID = '33333333-3333-4333-8333-333333333333';
const PHONE = '15550100001';
const USER = { id: UID, phone_number: PHONE, preferred_language: 'en', name: 'Sample Teacher', grades_taught: ['4'], subjects_taught: ['maths'] };
const SESSION = {
  id: SID, user_id: UID, status: 'completed', transcript_text: 'x'.repeat(3000), transcript_language: 'en',
  created_at: '2026-09-05T05:00:00Z', analysis_data: { topic: 'Fractions', subject: 'Maths' }, lesson_plan_excerpt: null,
  users: USER,
};
const DIGEST = {
  topic: 'Fractions', topic_as_taught: 'Fractions', subject: 'maths', grade_band: '3-5', language_of_instruction: 'en', confidence: 0.9,
  slos: [{ id: 'S1', statement: 'a', taught_level: 'recall' }, { id: 'S2', statement: 'b', taught_level: 'understand' }],
};
const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000).toISOString();

function seed(quizzes = []) {
  const db = makeSchemaDb({ coaching_sessions: [SESSION], users: [USER], quizzes });
  supabase.from.mockImplementation(db.from);
  return db;
}
const quizRow = (over = {}) => ({
  id: QID, teacher_id: UID, coaching_session_id: SID, quiz_source: 'transcript', topic: 'Fractions', subject: 'maths',
  language: 'en', status: 'generating', ...over,
});

const ENV = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ENV, TRANSCRIPT_QUIZ_ENABLED: 'true', QUIZ_LANGUAGES: 'en' };
  delete process.env.TRANSCRIPT_QUIZ_OFFER_MODE;
  delete process.env.TRANSCRIPT_QUIZ_STALE_MINUTES;
  Digest.run.mockResolvedValue({ digest: DIGEST, grade: '4', gradeSource: 'profile', lpHint: null, model: 'm', costUsd: 0 });
});
afterAll(() => { process.env = ENV; });

describe('startGenerating when the queue refuses the job', () => {
  test('the row is failed (queue_failed, remakeable from /quiz) and the teacher is told — never left generating', async () => {
    const db = seed([quizRow({ status: 'offered', meta: { step: 'offered', digest: DIGEST } })]);
    Queue.queueJob.mockRejectedValueOnce(new Error('queue down'));
    const quiz = db.tables.quizzes[0];
    const r = await Offer.startGenerating({ quizId: QID, quiz, phone: PHONE, teacherLang: 'en', language: 'en', source: 'offer' });
    expect(r).toBe(true);   // handled: the tap is answered, nothing else routes it
    const row = db.tables.quizzes[0];
    expect(row.status).toBe('failed');
    expect(row.meta.error).toBe('queue_failed');
    expect(row.meta.digest).toEqual(DIGEST);
    const said = WhatsAppService.sendMessage.mock.calls.map((c) => c[1]);
    expect(said).not.toContain(resolveUx('tqMaking', { language: 'en' }));
    expect(said).toContain(resolveUx('tqCouldNotMakeModel', { language: 'en' }));
  });
});

describe('a quiz_offer job redelivered after its own claim', () => {
  test('a claim older than the offer lease is taken over: the lesson is offered', async () => {
    const db = seed([quizRow({ meta: { step: 'digest', source: 'self', claimed_at: minutesAgo(11) } })]);
    const r = await Offer.processOffer(SID, { phone: PHONE });
    expect(r).toEqual(expect.objectContaining({ ok: true, quizId: QID }));
    expect(db.tables.quizzes[0].status).toBe('offered');
    expect(WhatsAppService.sendInteractiveButtons).toHaveBeenCalledTimes(1);
  });

  test('a claim inside the lease is a live job: no second offer', async () => {
    seed([quizRow({ meta: { step: 'digest', source: 'self', claimed_at: minutesAgo(2) } })]);
    const r = await Offer.processOffer(SID, { phone: PHONE });
    expect(r).toEqual(expect.objectContaining({ skipped: 'already_claimed' }));
    expect(WhatsAppService.sendInteractiveButtons).not.toHaveBeenCalled();
  });

  test('a row /quiz claimed (accepted, being made) is never taken by the offer', async () => {
    seed([quizRow({ meta: { step: 'digest', source: 'list', claimed_at: minutesAgo(40), accepted_at: minutesAgo(40) } })]);
    const r = await Offer.processOffer(SID, { phone: PHONE });
    expect(r).toEqual(expect.objectContaining({ skipped: 'already_claimed' }));
    expect(WhatsAppService.sendInteractiveButtons).not.toHaveBeenCalled();
  });
});

describe('/quiz on a generating row', () => {
  test('nothing has touched it for longer than the stale window: the quiz is made again', async () => {
    const db = seed([quizRow({ meta: { step: 'author', digest: DIGEST, accepted_at: minutesAgo(45) } })]);
    await Provider.startTranscriptLesson(USER, SID, { phone: PHONE });
    expect(Queue.queueJob).toHaveBeenCalledWith(QID, 'quiz_generate', expect.objectContaining({ quizId: QID }), expect.any(Object));
    expect(WhatsAppService.sendMessage).toHaveBeenCalledWith(PHONE, resolveUx('tqMaking', { language: 'en' }));
    expect(db.tables.quizzes[0].status).toBe('generating');
  });

  test('a run that is live (fresh claim) still answers "still making"', async () => {
    seed([quizRow({ meta: { step: 'author', digest: DIGEST, accepted_at: minutesAgo(45), run_ms: String(Date.now() - 60 * 1000) } })]);
    await Provider.startTranscriptLesson(USER, SID, { phone: PHONE });
    expect(Queue.queueJob).not.toHaveBeenCalled();
    expect(WhatsAppService.sendMessage).toHaveBeenCalledWith(PHONE, resolveUx('tqStillMaking', { language: 'en' }));
  });

  test('a row accepted a few minutes ago still answers "still making"', async () => {
    seed([quizRow({ meta: { step: 'author', digest: DIGEST, accepted_at: minutesAgo(3) } })]);
    await Provider.startTranscriptLesson(USER, SID, { phone: PHONE });
    expect(Queue.queueJob).not.toHaveBeenCalled();
  });
});
