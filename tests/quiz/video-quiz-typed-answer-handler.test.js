'use strict';
/**
 * The typed-letter step, EXECUTED through the real handleTextMessage and the
 * real video-quiz service, with a quiz waiting in the shape v1.2.0 writes.
 *
 * On main the text handler has no typed-letter step: free text during an
 * unfinished video quiz goes on to intent detection and chat. The lesson quiz
 * added answerTypedLetter ahead of everything else, so with the flag OFF it
 * must hand every message straight back (false) and the handler must carry on
 * exactly as on main. With the flag on, a sibling's "2" while a join step is
 * pending belongs to the join, not to the quiz.
 *
 * Only the stores (supabase, Redis), the messaging facade, the LLM and the
 * services this handler wires against that are not under test are stand-ins.
 */

jest.mock('jsonrepair', () => ({ jsonrepair: (s) => s }), { virtual: true });
const { mockBotDependency } = require('../_helpers/mock-bot-dependency');
mockBotDependency('aws-sdk', () => ({ config: { update: () => {} }, SQS: function SQS() {} }));
jest.mock('pdfkit', () => ({}), { virtual: true });
jest.mock('uuid', () => ({ v4: () => 'stub-uuid' }), { virtual: true });

const { createMemorySupabase } = require('./helpers/memory-supabase');

// The quiz's tables live in memory; every other table the handler touches on
// its way to chat reads as empty.
const mockQuizTables = new Set(['quiz_questions', 'quiz_answers', 'quiz_sessions', 'quizzes']);
let mockMem;
jest.mock('../../bot/shared/config/supabase', () => {
  const empty = () => {
    const b = {
      select: () => b, eq: () => b, neq: () => b, in: () => b, is: () => b, not: () => b, gte: () => b,
      lte: () => b, order: () => b, limit: () => b, update: () => b, insert: () => b, upsert: () => b,
      single: () => Promise.resolve({ data: null, error: null }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (resolve) => resolve({ data: [], error: null }),
    };
    return b;
  };
  return {
    from: (t) => (mockQuizTables.has(t) ? mockMem.from(t) : empty()),
    rpc: (...a) => (mockMem.rpc ? mockMem.rpc(...a) : Promise.resolve({ data: null, error: null })),
  };
});

const mockKv = new Map();
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => {
  const get = async (k) => (mockKv.has(k) ? JSON.parse(mockKv.get(k)) : null);
  return {
    redis: { get: async () => null, set: async () => true, del: async () => 1 },
    isAvailable: () => true,
    get,
    set: async (k, v) => { mockKv.set(k, JSON.stringify(v)); return true; },
    setNX: async (k, v) => { if (mockKv.has(k)) return false; mockKv.set(k, JSON.stringify(v)); return true; },
    delete: async (k) => { mockKv.delete(k); return true; },
    del: async (k) => { mockKv.delete(k); return true; },
  };
});

const mockSent = [];
jest.mock('../../bot/shared/services/whatsapp.service', () => {
  const ok = (kind) => async (to, payload) => { mockSent.push({ kind, to, payload }); return true; };
  return {
    sendMessage: ok('text'),
    sendTextReturningId: async (to, payload) => { mockSent.push({ kind: 'text', to, payload }); return 'wamid.t'; },
    sendInteractiveButtons: ok('buttons'),
    sendImageWithButtons: ok('buttons'),
    sendInteractiveMessage: ok('list'),
    sendImageFromUrl: ok('image'),
    sendImage: ok('image'),
    sendFlow: async () => false,
    sendTypingIndicator: () => {},
    markAsRead: () => {},
    startContinuousTypingIndicator: () => ({ stop: () => {} }),
  };
});

const mockDetectIntent = jest.fn().mockResolvedValue({ type: 'general' });
jest.mock('../../bot/shared/services/openai.service', () => ({
  detectIntent: (...a) => mockDetectIntent(...a),
  getResponseWithFormat: jest.fn().mockResolvedValue('a warm answer'),
  generateResponse: jest.fn().mockResolvedValue('ok'),
  createChatCompletion: jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] }),
}));

jest.mock('../../bot/shared/database/bot-helpers', () => ({
  getOrCreateUser: jest.fn(async () => global.__TEST_USER__),
  getOrCreateUserByChannel: jest.fn(async () => global.__TEST_USER__),
  getOrCreateSession: jest.fn().mockResolvedValue('sess-chat'),
  updateSessionType: jest.fn(),
  storeConversation: jest.fn(),
  storeLessonPlan: jest.fn(),
  getConversationHistory: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../bot/shared/utils/language-cache', () => ({
  getUserLanguage: jest.fn().mockResolvedValue('en'),
  setUserLanguage: jest.fn(),
}));
jest.mock('../../bot/shared/services/feature-registration.service', () => ({
  isPendingName: jest.fn().mockResolvedValue(false),
  checkAndTriggerRegistration: jest.fn(),
}));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn(), logError: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

jest.mock('../../bot/shared/services/quiz/quiz-session.service', () => ({
  getPostQuizState: jest.fn().mockResolvedValue(null),
  getActiveState: jest.fn().mockResolvedValue(null),
  handlePostQuizChat: jest.fn(),
  endPostQuizChat: jest.fn(),
  startQuizFromInvite: jest.fn(),
  endSession: jest.fn(),
  handleAnswer: jest.fn(),
}));

// The share service is its own suite; here only "who gets the reply" matters.
const mockShare = {
  parseShareCode: jest.fn(() => null),
  beginFromCode: jest.fn().mockResolvedValue(false),
  beginFromCodeLocked: jest.fn().mockResolvedValue(false),
  consumeJoinReply: jest.fn().mockResolvedValue(false),
};
jest.mock('../../bot/shared/services/quiz/video-quiz-share.service', () => mockShare);

jest.mock('../../bot/shared/services/quiz/quiz-follow-up.service', () => ({
  getAwaitingState: jest.fn().mockResolvedValue(null),
}));

const PHONE = '15550103333';
const PARENT = { id: 'u-parent', phone_number: PHONE, name: 'P', preferred_language: 'en', registration_completed: true };
const SESSION = 'vq-sess-1';

const question = {
  id: 'q-1', quiz_id: 'quiz-1', external_id: 'vq:1', sort_order: 0,
  question_text: 'Which shape has three sides?', option_a: 'Square', option_b: 'Triangle', option_c: 'Circle',
  option_d: null, correct_option: 'B', explanation: 'A triangle has three sides.', option_feedback: null,
  media: { display_order: [0, 1, 2] }, render_pattern: 'P1',
};

/** The state v1.2.0 writes for a video quiz started from /video (no quizSource). */
function seedMainShapedVideoQuiz() {
  mockMem = createMemorySupabase({
    quiz_questions: [question],
    quiz_answers: [],
    quiz_sessions: [{ id: SESSION, quiz_id: 'quiz-1', status: 'in_progress', total_questions_answered: 0, correct_answers: 0 }],
    quizzes: [{ id: 'quiz-1', topic: 'Shapes', quiz_source: 'video' }],
  });
  mockKv.clear();
  mockKv.set(`videoquiz:${PHONE}:active`, JSON.stringify({
    sessionId: SESSION, quizId: 'quiz-1', videoId: 'v-1', userId: 'u-parent', language: 'en', deliveryId: null,
    source: 'video_solo', shareCodeId: null, studentId: null, takerName: null,
    questionIds: ['q-1'], index: 0, correct: 0, answered: 0, currentQuestionId: 'q-1', sentAt: Date.now(),
  }));
}

let handler;
const saved = {};
beforeAll(() => {
  for (const k of ['CHANNEL_DRIVER', 'TRANSCRIPT_QUIZ_ENABLED']) saved[k] = process.env[k];
  process.env.CHANNEL_DRIVER = 'baileys';
  handler = require('../../bot/shared/handlers/text-message.handler');
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
beforeEach(() => {
  mockSent.length = 0;
  mockDetectIntent.mockClear();
  mockShare.consumeJoinReply.mockReset().mockResolvedValue(false);
  delete process.env.TRANSCRIPT_QUIZ_ENABLED;
});

async function say(body) {
  global.__TEST_USER__ = PARENT;
  await handler.handleTextMessage({ id: 'wamid.test' }, PHONE, body, PARENT);
  await new Promise((r) => setImmediate(r));
}
const quizTexts = () => mockSent.filter((s) => /one letter|right letter/i.test(String(s.payload)));

describe('flag OFF, a v1.2.0 video quiz unfinished on the phone', () => {
  test.each([
    'Please make me a lesson plan on fractions for grade 5', 'yes', 'hello', 'I need help', '1',
  ])('"%s" goes on to intent detection, as on main; nothing graded, no re-ask', async (text) => {
    seedMainShapedVideoQuiz();
    await say(text);
    expect(mockDetectIntent).toHaveBeenCalledWith(text);
    expect(mockMem.tables.quiz_answers).toEqual([]);
    expect(quizTexts()).toEqual([]);
  });
});

describe('flag ON, a lesson quiz waiting', () => {
  test('a sibling\'s "2" while the join asks "who is taking it?" goes to the join, not the quiz', async () => {
    process.env.TRANSCRIPT_QUIZ_ENABLED = 'true';
    seedMainShapedVideoQuiz();
    const st = JSON.parse(mockKv.get(`videoquiz:${PHONE}:active`));
    mockKv.set(`videoquiz:${PHONE}:active`, JSON.stringify({ ...st, quizSource: 'transcript', source: 'share_link' }));
    mockKv.set(`videoquiz:${PHONE}:join`, JSON.stringify({ step: 'whoami', shareCodeId: 'sc-2' }));
    mockShare.consumeJoinReply.mockResolvedValueOnce(true);
    await say('2');
    expect(mockShare.consumeJoinReply).toHaveBeenCalledWith(PHONE, '2');
    expect(mockMem.tables.quiz_answers).toEqual([]);
  });
});
