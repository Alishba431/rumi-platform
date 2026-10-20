'use strict';
/**
 * The generate step claims its row before the first send (review F-S2, F-S3).
 *
 * A quiz_generate job can be delivered twice (a Standard queue is
 * at-least-once, and a run longer than its lease is handed to a second
 * worker). Both runs used to accept `generating` and go all the way: two share
 * codes, two PDFs, two links for one lesson. The run now claims the row
 * (`meta.run_ms`, compare-and-set) and a second run exits; a claim older than
 * TRANSCRIPT_QUIZ_STALE_MINUTES is a run that died and can be taken over.
 *
 * The real generate step and hand-off run against a stateful, schema-checked
 * database (helpers/schema-db); the model, the PDF and the sends are mocked.
 */
jest.mock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn().mockResolvedValue(true),
  sendDocument: jest.fn().mockResolvedValue(true),
  sendInteractiveButtons: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../bot/shared/services/queue/sqs-queue.service', () => ({ queueJob: jest.fn().mockResolvedValue('mid') }));
jest.mock('../../bot/shared/services/quiz/transcript-quiz-digest.service', () => ({ run: jest.fn() }));
jest.mock('../../bot/shared/services/quiz/transcript-quiz-author.service', () => ({
  author: jest.fn(), excerptsFor: jest.fn().mockReturnValue('…'),
}));
jest.mock('../../bot/shared/services/quiz/video-quiz-share.service', () => ({
  mintCode: jest.fn().mockResolvedValue({ id: 'sc-1', code: 'ABC234', teacherName: 'Sample Teacher', topic: 'Fractions' }),
  botNumber: jest.fn().mockReturnValue('15550000000'),
  joinInvite: jest.fn(({ code }) => ({ kind: 'wa', link: `https://wa.me/15550000000?text=QUIZ-${code}`, bot: 'Rumi', code })),
}));
jest.mock('../../bot/shared/utils/html-to-pdf', () => ({ htmlToPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')) }));
jest.mock('../../bot/shared/storage/r2', () => ({
  isR2Configured: jest.fn(() => true), uploadBuffer: jest.fn().mockResolvedValue('https://r2/x'), downloadFromR2: jest.fn(),
}));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));
jest.mock('../../bot/shared/services/quiz/quiz-daily-cap', () => ({
  claim: jest.fn().mockResolvedValue({ allowed: true, count: 1, limit: 10 }),
}));

const supabase = require('../../bot/shared/config/supabase');
const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const Author = require('../../bot/shared/services/quiz/transcript-quiz-author.service');
const Share = require('../../bot/shared/services/quiz/video-quiz-share.service');
const { logEvent } = require('../../bot/shared/utils/structured-logger');
const { makeSchemaDb } = require('./helpers/schema-db');
const Gen = require('../../bot/shared/services/quiz/transcript-quiz-generate.service');
const { installAgreeingSolver } = require('./helpers/key-verify-agree');
const { installNoPictureRepair } = require('./helpers/no-picture-repair');

const QID = '22222222-2222-4222-8222-222222222222';
const SID = '11111111-1111-4111-8111-111111111111';
const UID = '33333333-3333-4333-8333-333333333333';
const DIGEST = {
  topic: 'Fractions', topic_as_taught: 'Fractions', subject: 'maths', grade_band: '3-5', language_of_instruction: 'en', confidence: 0.9,
  slos: [{ id: 'S1', statement: 'a', taught_level: 'recall' }, { id: 'S2', statement: 'b', taught_level: 'understand' }],
  key_terms: [], examples_used: ['half a roti'], misconceptions_surfaced: [],
};
const USER = { id: UID, name: 'Sample Teacher', phone_number: '15550001234', preferred_language: 'en', grades_taught: ['4'], subjects_taught: ['maths'] };
const SESSION = {
  id: SID, user_id: UID, status: 'completed', transcript_text: 'x'.repeat(3000), transcript_language: 'en',
  created_at: '2026-09-05T05:00:00Z', analysis_data: { topic: 'Fractions', subject: 'Maths' }, lesson_plan_excerpt: null,
  users: USER,
};

function goodQuestion(i, slo = 'S1', level = 'recall') {
  return {
    slo_id: slo, level, question: `Question ${i}: what fraction is half a roti?`, options: [`1/2 (${i})`, `1/3 (${i})`, `1/4 (${i})`], correct_index: 0,
    explanation: 'Half a roti is one of two equal parts.',
    selected_because: `Question ${i} comes from the roti example`,
    distractor_misconceptions: { 1: 'three parts', 2: 'four parts' },
    option_feedback: { correct: 'Yes — half is one of two equal parts.', wrong: { 1: 'Not three parts: the roti was cut in two.', 2: 'Not four parts: the roti was cut in two.' } },
  };
}
const EIGHT = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => goodQuestion(i, i % 2 ? 'S1' : 'S2', i % 2 ? 'recall' : 'understand'));

function seed(meta = {}) {
  const db = makeSchemaDb({
    quizzes: [{
      id: QID, teacher_id: UID, coaching_session_id: SID, quiz_source: 'transcript', topic: 'Fractions', subject: 'maths',
      language: 'en', status: 'generating', grade: '4', meta: { digest: DIGEST, grade: '4', step: 'author', ...meta },
    }],
    coaching_sessions: [SESSION],
    users: [USER],
    quiz_questions: [],
  });
  supabase.from.mockImplementation(db.from);
  return db;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.TRANSCRIPT_QUIZ_ENABLED = 'true';
  delete process.env.TRANSCRIPT_QUIZ_STALE_MINUTES;
  jest.spyOn(Gen, 'sleep').mockResolvedValue(undefined);
  installAgreeingSolver(Gen);
  installNoPictureRepair(Gen);
  Author.author.mockResolvedValue({ questions: EIGHT, model: 'm', costUsd: 0.01, latencyMs: 100, lessonSummary: 'The teacher used half a roti.' });
});

describe('two deliveries of one quiz_generate job', () => {
  test('run at the same time: ONE share code, ONE PDF, ONE link', async () => {
    const db = seed();
    const [a, b] = await Promise.all([Gen.process(QID, {}), Gen.process(QID, {})]);
    expect(Share.mintCode).toHaveBeenCalledTimes(1);
    expect(WhatsAppService.sendDocument).toHaveBeenCalledTimes(1);
    expect([a, b].filter((r) => r && r.skipped === 'already_running')).toHaveLength(1);
    expect(db.tables.quizzes[0].status).toBe('sent');
  });

  test('a redelivery while the first run is live exits without a model call or a send', async () => {
    seed({ run_ms: String(Date.now() - 60 * 1000) });
    const r = await Gen.process(QID, {});
    expect(r).toEqual(expect.objectContaining({ skipped: 'already_running' }));
    expect(Author.author).not.toHaveBeenCalled();
    expect(WhatsAppService.sendMessage).not.toHaveBeenCalled();
    expect(WhatsAppService.sendDocument).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith('transcript_quiz.generate_skipped', expect.objectContaining({ quizId: QID, reason: 'already_running' }));
  });
});

describe('a run that died (F-S3)', () => {
  test('a claim older than the stale window is taken over and the quiz is made', async () => {
    const db = seed({ run_ms: String(Date.now() - 31 * 60 * 1000) });
    const r = await Gen.process(QID, {});
    expect(r.ok).toBe(true);
    expect(WhatsAppService.sendDocument).toHaveBeenCalledTimes(1);
    expect(db.tables.quizzes[0].status).toBe('sent');
  });

  test('TRANSCRIPT_QUIZ_STALE_MINUTES sets the window', async () => {
    process.env.TRANSCRIPT_QUIZ_STALE_MINUTES = '5';
    seed({ run_ms: String(Date.now() - 6 * 60 * 1000) });
    const r = await Gen.process(QID, {});
    expect(r.ok).toBe(true);
  });

  test('a run that THROWS hands its claim back, so the queue\'s redelivery makes the quiz', async () => {
    const db = seed();
    const { chain } = require('./helpers/supabase-chain');
    let failed = false;
    supabase.from.mockImplementation((t) => {
      if (t === 'coaching_sessions' && !failed) {
        failed = true;
        return chain({ data: null, error: { message: 'connection reset' } });
      }
      return db.from(t);
    });
    await expect(Gen.process(QID, {})).rejects.toThrow(/coaching session read failed/);
    expect(db.tables.quizzes[0].status).toBe('generating');
    expect(db.tables.quizzes[0].meta.run_ms).toBeUndefined();
    const again = await Gen.process(QID, {});
    expect(again.ok).toBe(true);
    expect(WhatsAppService.sendDocument).toHaveBeenCalledTimes(1);
  });
});

describe('RUMI_FEATURE_LESSON_QUIZ=off (review F-N8)', () => {
  const { overrides } = require('../../bot/shared/config/feature-availability');
  afterEach(() => { delete process.env.RUMI_FEATURE_LESSON_QUIZ; overrides.load(process.env); });

  test('a quiz_generate job already queued exits quietly: no claim, no model call, no send', async () => {
    const db = seed();
    process.env.RUMI_FEATURE_LESSON_QUIZ = 'off';
    overrides.load(process.env);
    const r = await Gen.process(QID, {});
    expect(r).toEqual({ skipped: 'paused' });
    expect(Author.author).not.toHaveBeenCalled();
    expect(WhatsAppService.sendMessage).not.toHaveBeenCalled();
    expect(db.tables.quizzes[0].meta.run_ms).toBeUndefined();
  });
});
