'use strict';
/**
 * The two lesson sources /quiz makes a quiz from besides a recording:
 *
 *   lp_generated  the teacher's own lesson plans (`lesson_plans`) — listed while
 *                 they have no quiz, claimed by INSERT on a tap (the unique
 *                 index on lesson_plan_id is the claim);
 *   topic         `/quiz <topic>` or the menu's topic row — a new quiz row with
 *                 the grade and subject the profile names when it names one.
 *
 * Runs against schema-db, so every column read or written exists in
 * 00_complete-schema.sql and the unique indexes answer 23505 as Postgres does.
 */
jest.mock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn().mockResolvedValue(true),
  sendInteractiveButtons: jest.fn().mockResolvedValue(true),
  sendInteractiveMessage: jest.fn().mockResolvedValue(true),
  sendFlow: jest.fn().mockResolvedValue(false),
}));
jest.mock('../../bot/shared/services/queue', () => ({ queueJob: jest.fn().mockResolvedValue('mid') }));
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  set: jest.fn().mockResolvedValue(false),
  get: jest.fn().mockResolvedValue(null),
  delete: jest.fn().mockResolvedValue(false),
}));
jest.mock('../../bot/shared/services/quiz/transcript-quiz-digest.service', () => ({ run: jest.fn() }));
jest.mock('../../bot/shared/services/feature-intro.service', () => ({
  hasSeenIntroVideo: jest.fn().mockResolvedValue(true),
  markVideoShown: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../bot/shared/services/quiz/transcript-quiz-language', () => require('./helpers/language-mock').factory());
jest.mock('../../bot/shared/services/quiz/teacher-self-test', () => require('./helpers/language-mock').selfTestFactory());
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const supabase = require('../../bot/shared/config/supabase');
const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const Queue = require('../../bot/shared/services/queue');
const { resolveUx } = require('../../bot/shared/config/ux-strings');
const { makeSchemaDb } = require('./helpers/schema-db');
const LpProvider = require('../../bot/shared/services/quiz/providers/lp-generated.provider');
const Topic = require('../../bot/shared/services/quiz/providers/topic.provider');
const Providers = require('../../bot/shared/services/quiz/quiz-lesson-providers');
const List = require('../../bot/shared/services/quiz/transcript-quiz-list.service');

const UID = '33333333-3333-4333-8333-333333333333';
const OTHER = '99999999-9999-4999-8999-999999999999';
const PHONE = '15550100001';
const USER = { id: UID, phone_number: PHONE, preferred_language: 'en', grades_taught: '4', subjects_taught: ['science'] };
const P = (n) => `5555555${n}-5555-4555-8555-555555555555`;
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
// lesson_plans.created_at is a TIMESTAMP without a zone: PostgREST returns no offset.
const naive = (iso) => iso.replace('Z', '').replace(/\.\d+$/, '');

function plan(n, over = {}) {
  return {
    id: P(n), user_id: UID, topic: `Plan ${n}`, grade: '4', subject: 'Science', type: 'standard',
    content: { plan_text: 'Objectives: name the parts of a plant.' }, created_at: naive(daysAgo(n)), ...over,
  };
}

let db;
function install(seed) {
  db = makeSchemaDb({ users: [USER], quizzes: [], lesson_plans: [], ...seed });
  supabase.from.mockImplementation(db.from);
}

const ENV = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ENV, TRANSCRIPT_QUIZ_ENABLED: 'true', QUIZ_LANGUAGES: 'en' };
});
afterAll(() => { process.env = ENV; });

describe('lp_generated: which plans are listed', () => {
  test('recent plans with something to write from and no quiz yet — newest first', async () => {
    install({
      lesson_plans: [
        plan(1),
        plan(2, { content: null, pdf_url: 'https://files.example.org/plan-2.pdf' }), // the PDF is enough
        plan(3, { content: null, pdf_url: null }),                                 // nothing to write from
        plan(4, { created_at: naive(daysAgo(40)) }),                               // older than a month
        plan(5),                                                                   // already has its quiz
        plan(6, { user_id: OTHER }),                                               // someone else's
        plan(7, { status: 'failed' }),                                             // never finished
      ],
      quizzes: [{ id: 'q5', teacher_id: UID, quiz_source: 'lp_generated', lesson_plan_id: P(5), topic: 'Plan 5', status: 'sent', meta: {} }],
    });
    const items = await LpProvider.list(UID, { limit: 20 });
    expect(items.map((i) => i.lessonRef)).toEqual([P(1), P(2)]);
    expect(items[0]).toEqual(expect.objectContaining({ source: 'lp_generated', topic: 'Plan 1', subject: 'Science', grade: '4' }));
    // The zone-less timestamp is read as UTC, never as the process's local time.
    expect(items[0].date).toMatch(/Z$/);
    expect(db.refused).toEqual([]);
  });

  test('the row id carries the plan and parses back to this provider', () => {
    const key = Providers.lessonKey({ source: 'lp_generated', lessonRef: P(1) });
    expect(key).toBe(`lsn_lp_generated_${P(1)}`);
    const parsed = Providers.parseLessonKey(key);
    expect(parsed.provider.source).toBe('lp_generated');
    expect(parsed.lessonRef).toBe(P(1));
  });
});

describe('lp_generated: the tap', () => {
  test('claims the plan by insert, with what the author reads, and queues the quiz', async () => {
    install({ lesson_plans: [plan(1)] });
    const out = await LpProvider.start(USER, P(1), { phone: PHONE, via: 'list' });
    expect(out.outcome).toBe('queued');
    const q = db.table('quizzes')[0];
    expect(q).toEqual(expect.objectContaining({
      teacher_id: UID, quiz_source: 'lp_generated', lesson_plan_id: P(1), topic: 'Plan 1', status: 'generating', language: 'en',
    }));
    expect(q.meta.lessons).toEqual([{ lesson_plan_id: P(1) }]);
    expect(q.meta.lesson_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Queue.queueJob).toHaveBeenCalledWith(q.id, 'quiz_generate', expect.objectContaining({ quizId: q.id }), expect.any(Object));
    expect(WhatsAppService.sendMessage).toHaveBeenCalledWith(PHONE, resolveUx('lpQuizMaking', { language: 'en' }));
    expect(db.refused).toEqual([]);
  });

  test('a second tap meets the unique index: one quiz, one job, and the teacher hears where it stands', async () => {
    install({ lesson_plans: [plan(1)] });
    await List.handleListPick(`tq_pick_lsn_lp_generated_${P(1)}`, PHONE, USER);
    WhatsAppService.sendMessage.mockClear();
    await List.handleListPick(`tq_pick_lsn_lp_generated_${P(1)}`, PHONE, USER);
    expect(db.table('quizzes')).toHaveLength(1);
    expect(Queue.queueJob).toHaveBeenCalledTimes(1);
    expect(db.refused.map((r) => r.error.code)).toEqual(['23505']);
    expect(WhatsAppService.sendMessage).toHaveBeenCalledWith(PHONE, resolveUx('tqStillMaking', { language: 'en' }));
  });

  test('with more than one quiz language the plan is claimed as offered and the language is asked', async () => {
    process.env.QUIZ_LANGUAGES = 'en,ur';
    install({ lesson_plans: [plan(1)] });
    const out = await LpProvider.start(USER, P(1), { phone: PHONE });
    expect(out.outcome).toBe('asked');
    const q = db.table('quizzes')[0];
    expect(q.status).toBe('offered');
    expect(q.meta.awaiting_language).toBe(true);
    expect(Queue.queueJob).not.toHaveBeenCalled();
    const [, payload] = WhatsAppService.sendInteractiveButtons.mock.calls[0];
    expect(payload.buttons.map((b) => b.id)).toEqual([`tq_lang_en_${q.id}`, `tq_lang_ur_${q.id}`]);
  });

  test('another teacher\'s plan is not theirs to quiz', async () => {
    install({ lesson_plans: [plan(1, { user_id: OTHER })] });
    const out = await LpProvider.start(USER, P(1), { phone: PHONE });
    expect(out.outcome).toBe('not_found');
    expect(db.table('quizzes')).toHaveLength(0);
    expect(WhatsAppService.sendMessage).toHaveBeenCalledWith(PHONE, resolveUx('tqNotYours', { language: 'en' }));
  });

  test('a plan that lost its content says so and makes nothing', async () => {
    install({ lesson_plans: [plan(1, { content: null, pdf_url: null })] });
    const out = await LpProvider.start(USER, P(1), { phone: PHONE });
    expect(out.outcome).toBe('unavailable');
    expect(db.table('quizzes')).toHaveLength(0);
  });
});

describe('topic', () => {
  test('/quiz <topic> makes a topic quiz with the one grade and subject the profile names', async () => {
    install({});
    expect(await Topic.startTopicQuiz(USER, PHONE, '  "Plant parts"  ', 'en')).toBe(true);
    const q = db.table('quizzes')[0];
    expect(q).toEqual(expect.objectContaining({
      teacher_id: UID, quiz_source: 'topic', topic: 'Plant parts', grade: '4', subject: 'science', status: 'generating',
    }));
    expect(q.meta.lesson_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Queue.queueJob).toHaveBeenCalledWith(q.id, 'quiz_generate', expect.any(Object), expect.any(Object));
    expect(db.refused).toEqual([]);
  });

  test('a teacher of several grades or subjects is not guessed for', async () => {
    install({});
    await Topic.startTopicQuiz({ ...USER, grades_taught: '4, 5', subjects_taught: ['science', 'maths'] }, PHONE, 'Magnets');
    const q = db.table('quizzes')[0];
    expect(q.grade).toBeNull();
    expect(q.subject).toBeNull();
  });

  test('the same topic sent twice in a row is one quiz', async () => {
    install({});
    await Topic.startTopicQuiz(USER, PHONE, 'Magnets');
    await Topic.startTopicQuiz(USER, PHONE, 'Magnets');
    expect(db.table('quizzes')).toHaveLength(1);
    expect(WhatsAppService.sendMessage).toHaveBeenLastCalledWith(PHONE, resolveUx('tqAlreadyMaking', { language: 'en' }));
  });

  test('no topic: the topic is asked, and the reply (held in memory when Redis is down) makes the quiz', async () => {
    install({});
    await Topic.startTopicQuiz(USER, PHONE, '   ');
    expect(WhatsAppService.sendMessage).toHaveBeenCalledWith(PHONE, resolveUx('tqTopicAsk', { language: 'en' }));
    expect(await Topic.consumeTopicReply(PHONE, 'Food chains', USER)).toBe(true);
    expect(db.table('quizzes')[0].topic).toBe('Food chains');
  });

  test('with more than one quiz language the topic quiz waits for the ask', async () => {
    process.env.QUIZ_LANGUAGES = 'en,ur';
    install({});
    await Topic.startTopicQuiz(USER, PHONE, 'Magnets');
    const q = db.table('quizzes')[0];
    expect(q.status).toBe('offered');
    expect(q.language).toBeNull();
    expect(Queue.queueJob).not.toHaveBeenCalled();
    expect(WhatsAppService.sendInteractiveButtons).toHaveBeenCalledTimes(1);
  });

  test('a topic quiz row is labelled as one', () => {
    expect(Providers.labelKeyFor('topic')).toBe('tqRowFromTopic');
    expect(Providers.labelKeyFor('lp_generated')).toBe('tqRowFromLessonPlan');
    expect(Providers.labelKeyFor('transcript')).toBe('tqRowFromTranscript');
  });
});
