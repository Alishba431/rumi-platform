'use strict';
/**
 * A share code on a deployment whose region has video quizzes switched off,
 * EXECUTED through the real handleTextMessage, share service and invite
 * service (review F-S13).
 *
 * On main the region gate made beginFromCode return false and the message went
 * on to ordinary chat. The lesson quiz made the join ack-first (it runs after
 * the handler returns), so that false reached nobody: the text was swallowed.
 * Now, with the region gate off, the code is resolved before the ack: a VIDEO
 * code (and an unknown one) goes on to chat exactly as on main, and a lesson
 * quiz's code still joins — it has nothing to do with the video library.
 *
 * Only the stores, the messaging facade, the LLM and the region switch are
 * stand-ins.
 */

jest.mock('jsonrepair', () => ({ jsonrepair: (s) => s }), { virtual: true });
const { mockBotDependency } = require('../_helpers/mock-bot-dependency');
mockBotDependency('aws-sdk', () => ({ config: { update: () => {} }, SQS: function SQS() {} }));
jest.mock('pdfkit', () => ({}), { virtual: true });
jest.mock('uuid', () => ({ v4: () => 'stub-uuid' }), { virtual: true });

const { createMemorySupabase } = require('./helpers/memory-supabase');

// The share codes live in memory; every other table the handler touches on its
// way to chat reads as empty.
const mockQuizTables = new Set(['quiz_share_codes']);
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
    incr: async (k) => { const n = (mockKv.has(k) ? JSON.parse(mockKv.get(k)) : 0) + 1; mockKv.set(k, JSON.stringify(n)); return n; },
    expire: async () => true,
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


let mockRegionOn = true;
jest.mock('../../bot/shared/services/region-features.service', () => ({
  isVideoQuizzesEnabled: jest.fn(async () => mockRegionOn),
  getRegionFeatures: jest.fn(async () => ({ video_quizzes_enabled: mockRegionOn })),
  isCurriculumLpEnabled: jest.fn(async () => false),
  isPicLpEnabled: jest.fn(async () => false),
}));

const PHONE = '15550104444';
const CHILD = { id: 'u-child', phone_number: PHONE, name: null, preferred_language: 'en', registration_completed: true };
const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
const codes = () => [
  { id: 'sc-v', code: 'VIDABC', quiz_id: 'quiz-v', video_id: 'v-1', teacher_user_id: 'u-t', teacher_name: 'Teacher Example',
    topic: 'Shapes', language: 'en', active: true, expires_at: future, invited_by_student_id: null, parent_share_code_id: null },
  { id: 'sc-l', code: 'LESABC', quiz_id: 'quiz-l', video_id: null, teacher_user_id: 'u-t', teacher_name: 'Teacher Example',
    topic: 'Fractions', language: 'en', active: true, expires_at: future, invited_by_student_id: null, parent_share_code_id: null },
];

let handler;
let share;
beforeAll(() => {
  handler = require('../../bot/shared/handlers/text-message.handler');
  share = require('../../bot/shared/services/quiz/video-quiz-share.service');
});
beforeEach(() => {
  mockMem = createMemorySupabase({ quiz_share_codes: codes() });
  mockKv.clear();
  mockSent.length = 0;
  mockDetectIntent.mockClear();
  require('../../bot/shared/database/bot-helpers').storeConversation.mockClear();
  mockRegionOn = true;
});

// The ordinary pipeline stores the user's message before routing it (main's
// natural-language quiz detector then answers "QUIZ-…" like any other text).
const reachedChat = (text) => require('../../bot/shared/database/bot-helpers').storeConversation.mock.calls
  .some((c) => c.includes(text));

async function say(body) {
  global.__TEST_USER__ = CHILD;
  const spy = jest.spyOn(share, 'beginFromCodeLocked').mockResolvedValue(true);
  try {
    await handler.handleTextMessage({ id: 'wamid.test' }, PHONE, body, CHILD);
    await new Promise((r) => setImmediate(r));
    return spy.mock.calls.map((c) => c[1]);
  } finally {
    spy.mockRestore();
  }
}

describe('region with video quizzes OFF', () => {
  beforeEach(() => { mockRegionOn = false; });

  test('a video quiz code goes on to ordinary chat, as on main', async () => {
    const joined = await say('QUIZ-VIDABC');
    expect(joined).toEqual([]);
    expect(reachedChat('QUIZ-VIDABC')).toBe(true);
  });

  test('an unknown code goes on to ordinary chat, as on main', async () => {
    const joined = await say('QUIZ-NOPE23');
    expect(joined).toEqual([]);
    expect(reachedChat('QUIZ-NOPE23')).toBe(true);
  });

  // The lookup made before the ack counts wrong codes like the join does
  // (review F-S5): after the limit a sender's codes are not looked up.
  test('wrong codes count here too: the sixth is not looked up, and goes on to chat', async () => {
    for (let i = 0; i < share.JOIN_GUESS_LIMIT; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await say(`QUIZ-NOPE2${i}`);
    }
    const reads = jest.spyOn(mockMem, 'from');
    const joined = await say('QUIZ-LESABC');
    expect(reads).not.toHaveBeenCalledWith('quiz_share_codes');
    expect(joined).toEqual([]);
    expect(reachedChat('QUIZ-LESABC')).toBe(true);
  });

  test('a lesson quiz code still joins (the region gate is about the video library only)', async () => {
    const joined = await say('QUIZ-LESABC');
    expect(joined).toEqual(['LESABC']);
    expect(reachedChat('QUIZ-LESABC')).toBe(false);
  });
});

describe('region with video quizzes ON: ack-first, unchanged', () => {
  test('a video code joins without a lookup in the handler', async () => {
    const reads = jest.spyOn(mockMem, 'from');
    const joined = await say('QUIZ-VIDABC');
    expect(joined).toEqual(['VIDABC']);
    expect(reachedChat('QUIZ-VIDABC')).toBe(false);
    expect(reads).not.toHaveBeenCalledWith('quiz_share_codes');
  });
});
