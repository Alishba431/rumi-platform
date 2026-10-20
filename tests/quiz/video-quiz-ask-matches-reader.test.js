'use strict';
/**
 * How a question is ASKED on a channel where the child types (Baileys, Matrix).
 *
 * The typed letter is read only for a lesson quiz with the lesson quiz on
 * (video-quiz.service answerTypedLetter; review F-B2). The question must be
 * asked the same way it can be answered: a lesson quiz as lettered text
 * ("Reply with A, B or C"), a v1.2.0 video quiz with its buttons — drawn as
 * numbered text by the channel and answered by number, as on main. Asking a
 * video quiz in letters left the child's "A" unread: it fell through to the
 * classic quiz's "Reply Start Quiz" prompt (seen end to end on the Matrix rig).
 *
 * Driven through the real video-quiz service, render and sender. Only the
 * network boundary (WhatsApp facade), the stores (supabase, Redis) and the
 * loggers are stand-ins.
 */

const { createMemorySupabase } = require('./helpers/memory-supabase');

let mockMem;
jest.mock('../../bot/shared/config/supabase', () => ({
  from: (t) => mockMem.from(t),
  rpc: (...a) => mockMem.rpc(...a),
}));

const mockKv = new Map();
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  get: jest.fn(async (k) => (mockKv.has(k) ? JSON.parse(mockKv.get(k)) : null)),
  set: jest.fn(async (k, v) => { mockKv.set(k, JSON.stringify(v)); return true; }),
  setNX: jest.fn(async (k, v) => { if (mockKv.has(k)) return false; mockKv.set(k, JSON.stringify(v)); return true; }),
  delete: jest.fn(async (k) => { mockKv.delete(k); return true; }),
}));

const mockSent = [];
jest.mock('../../bot/shared/services/whatsapp.service', () => {
  const ok = (kind) => jest.fn(async (to, payload, ...rest) => { mockSent.push({ kind, to, payload, rest }); return true; });
  return {
    sendMessage: ok('text'),
    sendTextReturningId: jest.fn(async (to, payload) => { mockSent.push({ kind: 'text', to, payload }); return 'wamid.t'; }),
    sendInteractiveButtons: ok('buttons'),
    sendImageWithButtons: ok('buttons'),
    sendInteractiveMessage: ok('list'),
    sendImageFromUrl: ok('image'),
    sendImage: ok('image'),
    sendAudioFromUrlReturningId: jest.fn(async () => 'wamid.a'),
    sendFlow: ok('flow'),
  };
});
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const PHONE = '15550101234';
const SESSION = 'sess-1';

const question = {
  id: 'q-1', quiz_id: 'quiz-1', external_id: 'tq:quiz-1:S1:0', sort_order: 0,
  question_text: 'Which shape has three sides?', option_a: 'Square', option_b: 'Triangle', option_c: 'Circle',
  option_d: null, correct_option: 'B', explanation: 'A triangle has three sides.', option_feedback: null,
  media: { display_order: [0, 1, 2] }, render_pattern: 'P1',
};
const next = { ...question, id: 'q-2', external_id: 'tq:quiz-1:S1:1', sort_order: 1, question_text: 'Next question?' };

/**
 * A quiz waiting on q-1. `mainShaped` is the state v1.2.0 writes for a video
 * quiz (no quizSource field, source video_solo) on a `video` quiz row.
 */
function reset({ quizSource = 'transcript', mainShaped = false } = {}) {
  mockMem = createMemorySupabase({
    quiz_questions: [question, next],
    quiz_answers: [],
    quiz_sessions: [{ id: SESSION, quiz_id: 'quiz-1', status: 'in_progress', total_questions_answered: 0, correct_answers: 0 }],
    quizzes: [{ id: 'quiz-1', topic: 'Shapes', quiz_source: mainShaped ? 'video' : quizSource }],
  });
  mockKv.clear();
  mockSent.length = 0;
  const state = mainShaped
    ? {
      sessionId: SESSION, quizId: 'quiz-1', videoId: 'v-1', userId: 'u-1', language: 'en', deliveryId: null,
      source: 'video_solo', shareCodeId: null, studentId: null, takerName: null,
      questionIds: ['q-1', 'q-2'], index: 0, correct: 0, answered: 0, currentQuestionId: 'q-1', sentAt: Date.now(),
    }
    : {
      sessionId: SESSION, quizId: 'quiz-1', videoId: null, userId: null, language: 'en', source: 'share_link',
      quizSource, shareCodeId: 'sc-1', studentId: 'st-1', takerName: 'Child Example',
      questionIds: ['q-1', 'q-2'], index: 0, correct: 0, answered: 0, currentQuestionId: 'q-1', sentAt: Date.now(),
    };
  mockKv.set(`videoquiz:${PHONE}:active`, JSON.stringify(state));
}

let vq;
const saved = {};
beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers();
  for (const k of ['CHANNEL_DRIVER', 'TRANSCRIPT_QUIZ_ENABLED']) saved[k] = process.env[k];
  process.env.CHANNEL_DRIVER = 'baileys';
  process.env.TRANSCRIPT_QUIZ_ENABLED = 'true';
  vq = require('../../bot/shared/services/quiz/video-quiz.service');
});
afterEach(() => {
  jest.useRealTimers();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

async function settle(promise) {
  let done = false;
  let value;
  const p = promise.then((v) => { value = v; done = true; });
  for (let i = 0; i < 200 && !done; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await jest.runAllTimersAsync();
  }
  await p;
  return value;
}
const texts = () => mockSent.filter((s) => s.kind === 'text').map((s) => String(s.payload));


const asked = () => mockSent.filter((s) => s.kind === 'buttons' || s.kind === 'list' || s.kind === 'text');
const lettered = () => texts().filter((t) => /Reply with A, B or C/.test(t));
const state = () => JSON.parse(mockKv.get(`videoquiz:${PHONE}:active`));

describe('a question on a typing channel (Baileys)', () => {
  test('a v1.2.0 video quiz is asked with its buttons, not as lettered text', async () => {
    reset({ mainShaped: true });
    await settle(vq.sendNextQuestion(PHONE, state()));
    expect(lettered()).toEqual([]);
    expect(mockSent.filter((s) => s.kind === 'buttons')).toHaveLength(1);
  });

  test('a video quiz whose state names the video stream: buttons too', async () => {
    reset({ quizSource: 'video' });
    await settle(vq.sendNextQuestion(PHONE, state()));
    expect(lettered()).toEqual([]);
    expect(mockSent.filter((s) => s.kind === 'buttons')).toHaveLength(1);
  });

  test.each(['transcript', 'lp_generated', 'topic'])('a %s quiz is asked as lettered text', async (src) => {
    reset({ quizSource: src });
    await settle(vq.sendNextQuestion(PHONE, state()));
    expect(lettered()).toHaveLength(1);
    expect(mockSent.filter((s) => s.kind === 'buttons')).toEqual([]);
  });

  test('with the lesson quiz off even a lesson-quiz state keeps its buttons (nothing would read a letter)', async () => {
    delete process.env.TRANSCRIPT_QUIZ_ENABLED;
    reset({ quizSource: 'transcript' });
    await settle(vq.sendNextQuestion(PHONE, state()));
    expect(lettered()).toEqual([]);
    expect(asked().length).toBeGreaterThan(0);
  });
});
