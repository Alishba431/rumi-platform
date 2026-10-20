'use strict';
/**
 * /quiz — the teacher's menu, on every channel.
 *
 * The menu is ONE interactive list (sendInteractiveMessage): Meta renders it
 * natively, Baileys and the other text drivers as numbered text. There is no
 * Meta Flow for it in the open-source release, so a deployment that still has
 * TRANSCRIPT_QUIZ_FLOW_ID set — or a channel where sendFlow returns false — must
 * still get the list. The rows: recorded lessons, the teacher's own lesson plans
 * with no quiz yet ("From lesson plan"), quizzes already made with their state,
 * then the three ways to a quiz that are not a lesson: a topic, the video
 * quizzes, and the classic quiz to parents' phones.
 *
 * Runs against schema-db: every column the menu reads must exist in
 * 00_complete-schema.sql, exactly as PostgREST would insist on a fresh clone.
 */
jest.mock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn().mockResolvedValue(true),
  sendInteractiveButtons: jest.fn().mockResolvedValue(true),
  sendInteractiveMessage: jest.fn().mockResolvedValue(true),
  sendFlow: jest.fn().mockResolvedValue(false),
}));
jest.mock('../../bot/shared/services/queue', () => ({ queueJob: jest.fn().mockResolvedValue('mid') }));
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => {
  const store = new Map();
  return {
    _store: store,
    set: jest.fn(async (k, v) => { store.set(k, v); return true; }),
    get: jest.fn(async (k) => (store.has(k) ? store.get(k) : null)),
    delete: jest.fn(async (k) => { store.delete(k); return true; }),
  };
});
jest.mock('../../bot/shared/services/quiz/video-quiz.service', () => ({ getActiveState: jest.fn().mockResolvedValue(null) }));
jest.mock('../../bot/shared/services/quiz/video-quiz-report.service', () => ({ generate: jest.fn().mockResolvedValue(true) }));
jest.mock('../../bot/shared/services/quiz/quiz-orchestrator.service', () => ({ initiateQuizRequest: jest.fn().mockResolvedValue(undefined) }));
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
const VideoQuizService = require('../../bot/shared/services/quiz/video-quiz.service');
const QuizOrchestrator = require('../../bot/shared/services/quiz/quiz-orchestrator.service');
const { resolveUx } = require('../../bot/shared/config/ux-strings');
const { makeSchemaDb } = require('./helpers/schema-db');
const { openQuizMenu } = require('../../bot/shared/services/quiz/quiz-menu-entry.service');
const List = require('../../bot/shared/services/quiz/transcript-quiz-list.service');

const UID = '33333333-3333-4333-8333-333333333333';
const PHONE = '15550100001';
const SESS = '44444444-4444-4444-8444-444444444444';
const PLAN = '55555555-5555-4555-8555-555555555555';
const USER = {
  id: UID, name: 'Teacher Example', phone_number: PHONE, preferred_language: 'en',
  grades_taught: '4', subjects_taught: ['science'],
};
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

function seed(over = {}) {
  return {
    users: [USER],
    coaching_sessions: [{
      id: SESS, user_id: UID, status: 'completed', created_at: daysAgo(1),
      transcript_text: 'The water cycle. '.repeat(120), transcript_language: 'en',
      analysis_data: { topic: 'The water cycle', subject: 'Science' },
    }],
    lesson_plans: [{
      id: PLAN, user_id: UID, topic: 'Fractions', grade: '4', subject: 'Maths', type: 'standard',
      content: { plan_text: 'Objectives: compare fractions with like denominators.' }, created_at: daysAgo(2),
    }],
    quizzes: [],
    quiz_sessions: [],
    ...over,
  };
}

let db;
function install(s) {
  db = makeSchemaDb(s);
  supabase.from.mockImplementation(db.from);
}

function lastList() {
  const calls = WhatsAppService.sendInteractiveMessage.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const [to, payload] = calls[calls.length - 1];
  const rows = payload.action.sections.flatMap((s) => s.rows);
  return { to, payload, rows, ids: rows.map((r) => r.id) };
}

const ENV = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  require('../../bot/shared/services/cache/railway-redis.service')._store.clear();
  process.env = { ...ENV, TRANSCRIPT_QUIZ_ENABLED: 'true', QUIZ_LANGUAGES: 'en' };
  delete process.env.TRANSCRIPT_QUIZ_FLOW_ID;
});
afterAll(() => { process.env = ENV; });

describe('the menu is a list, whatever the channel', () => {
  test('TRANSCRIPT_QUIZ_FLOW_ID set and sendFlow refused: the teacher still gets the numbered list', async () => {
    process.env.TRANSCRIPT_QUIZ_FLOW_ID = '1234567890';
    WhatsAppService.sendFlow.mockResolvedValue(false);
    install(seed());

    await openQuizMenu({ user: USER, from: PHONE, language: 'en', sessionId: 's-1', trigger: 'text' });

    const { to, ids, rows } = lastList();
    expect(to).toBe(PHONE);
    expect(ids).toContain(`tq_pick_${SESS}`);                           // the recorded lesson
    expect(ids).toContain(`tq_pick_lsn_lp_generated_${PLAN}`);          // the lesson plan, no quiz yet
    const planRow = rows.find((r) => r.id === `tq_pick_lsn_lp_generated_${PLAN}`);
    expect(planRow.description).toContain(resolveUx('tqRowFromLessonPlan', { language: 'en' }));
    expect(ids).toEqual(expect.arrayContaining(['tq_pick_menu_topic', 'tq_pick_menu_videos', 'tq_pick_menu_classic']));
    expect(rows.length).toBeLessThanOrEqual(10);                        // WhatsApp's cap on one list
    rows.forEach((r) => {
      expect([...r.title].length).toBeLessThanOrEqual(24);
      expect([...(r.description || '')].length).toBeLessThanOrEqual(72);
    });
    // Nothing the menu read was refused by the schema.
    expect(db.refused).toEqual([]);
  });

  test('a teacher with nothing yet is told to record a lesson or make a plan — and still has the other ways in', async () => {
    install(seed({ coaching_sessions: [], lesson_plans: [] }));
    await openQuizMenu({ user: USER, from: PHONE, language: 'en' });
    const { payload, ids } = lastList();
    expect(payload.body.text).toBe(resolveUx('tqListEmptyMenu', { language: 'en' }));
    expect(ids).toEqual(['tq_pick_menu_topic', 'tq_pick_menu_videos', 'tq_pick_menu_classic']);
  });

  test('a quiz question waiting on this handset keeps the child in the quiz', async () => {
    install(seed());
    VideoQuizService.getActiveState.mockResolvedValueOnce({ currentQuestionId: 'q1', language: 'en', sessionId: 'qs' });
    const route = await openQuizMenu({ user: USER, from: PHONE, language: 'en' });
    expect(route).toBe('still_in_quiz');
    expect(WhatsAppService.sendInteractiveMessage).not.toHaveBeenCalled();
    expect(WhatsAppService.sendMessage).toHaveBeenCalledWith(PHONE, resolveUx('vqStillInQuiz', { language: 'en' }));
  });
});

describe('quizzes already made show where they stand', () => {
  test('a sent quiz says how many have started; a quiz being made says so', async () => {
    const SENT = '66666666-6666-4666-8666-666666666666';
    const MAKING = '77777777-7777-4777-8777-777777777777';
    install(seed({
      quizzes: [
        {
          id: SENT, teacher_id: UID, quiz_source: 'transcript', coaching_session_id: SESS, status: 'sent',
          topic: 'The water cycle', subject: 'science', meta: { share_code_id: 'sc-1' }, created_at: daysAgo(1),
        },
        {
          id: MAKING, teacher_id: UID, quiz_source: 'topic', status: 'generating', topic: 'Magnets',
          subject: 'science', meta: { lesson_date: daysAgo(0).slice(0, 10) }, created_at: daysAgo(0),
        },
      ],
      quiz_sessions: [
        { id: 'a', quiz_id: SENT, user_id: null, student_name: 'A', status: 'completed', created_at: daysAgo(0) },
        { id: 'b', quiz_id: SENT, user_id: null, student_name: 'B', status: 'in_progress', created_at: daysAgo(0) },
      ],
    }));
    await openQuizMenu({ user: USER, from: PHONE, language: 'en' });
    const { rows } = lastList();
    const sent = rows.find((r) => r.id === `tq_pick_${SESS}`);
    expect(sent.description).toContain(resolveUx('tqRowSent', { language: 'en', params: { started: 2, finished: 1 } }));
    const making = rows.find((r) => r.id === `tq_pick_lp_${MAKING}`);
    expect(making.description).toContain(resolveUx('tqRowMaking', { language: 'en' }));
    expect(making.description).toContain(resolveUx('tqRowFromTopic', { language: 'en' }));
    expect(db.refused).toEqual([]);
  });
});

describe('the rows that are not a lesson', () => {
  test('"Quiz to parents\' phones" opens the classic quiz', async () => {
    install(seed());
    expect(await List.handleListPick('tq_pick_menu_classic', PHONE, USER, { sessionId: 's-9' })).toBe(true);
    expect(QuizOrchestrator.initiateQuizRequest).toHaveBeenCalledWith(USER, PHONE, 's-9', 'en', null);
  });

  test('"Video quizzes" opens the student-video picker — the same one /video opens', async () => {
    install(seed());
    WhatsAppService.sendFlow.mockResolvedValueOnce(true);
    await List.handleListPick('tq_pick_menu_videos', PHONE, USER);
    const [to, flow] = WhatsAppService.sendFlow.mock.calls[0];
    expect(to).toBe(PHONE);
    expect(flow.flowKind).toBe('student-videos');
    expect(flow.flowToken).toMatch(new RegExp(`^${UID}:student-videos:`));
  });

  test('where no picker can be shown, the teacher is told how to reach the video quizzes', async () => {
    install(seed());
    WhatsAppService.sendFlow.mockResolvedValueOnce(false);
    await List.handleListPick('tq_pick_menu_videos', PHONE, USER);
    expect(WhatsAppService.sendMessage).toHaveBeenCalledWith(PHONE, resolveUx('tqVideoQuizzesHint', { language: 'en' }));
  });

  test('"Quiz on any topic" asks the topic; the reply makes a topic quiz', async () => {
    install(seed());
    await List.handleListPick('tq_pick_menu_topic', PHONE, USER);
    expect(WhatsAppService.sendMessage).toHaveBeenCalledWith(PHONE, resolveUx('tqTopicAsk', { language: 'en' }));

    expect(await List.consumeTopicReply(PHONE, 'Magnets and poles', USER)).toBe(true);
    const made = db.table('quizzes').find((q) => q.quiz_source === 'topic');
    expect(made).toEqual(expect.objectContaining({ teacher_id: UID, topic: 'Magnets and poles', status: 'generating' }));
    expect(Queue.queueJob).toHaveBeenCalledWith(made.id, 'quiz_generate', expect.any(Object), expect.any(Object));

    // The ask is answered once: the next message is ordinary chat again.
    expect(await List.consumeTopicReply(PHONE, 'thank you', USER)).toBe(false);
    expect(db.refused).toEqual([]);
  });

  test('a slash command while the topic is asked is not taken as the topic', async () => {
    install(seed());
    await List.handleListPick('tq_pick_menu_topic', PHONE, USER);
    expect(await List.consumeTopicReply(PHONE, '/menu', USER)).toBe(false);
    expect(db.table('quizzes')).toHaveLength(0);
  });
});
