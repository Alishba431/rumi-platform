'use strict';
/**
 * Who the typed-letter step may take a message from.
 *
 * answerTypedLetter runs in the text handler before user lookup, the slash
 * menus and chat. v1.2.0's video quiz is answered by taps only: on main, free
 * text during a video quiz went on to normal handling. So the typed step must
 * take a message only when ALL of these hold, and otherwise return false (the
 * message goes on, exactly as on main):
 *   - the lesson quiz is switched on (TRANSCRIPT_QUIZ_ENABLED=true and not
 *     RUMI_FEATURE_LESSON_QUIZ=off);
 *   - the waiting question belongs to a LESSON quiz (transcript, lesson plan or
 *     topic), never a v1.2.0 video quiz;
 *   - the reply is a strict letter, number or letter set — not a sentence;
 *   - no join step (name / class / "who is taking it?") is pending on the phone.
 * A re-ask names STOP, so a stuck reader always has a way out.
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
const answers = () => mockMem.tables.quiz_answers;
const texts = () => mockSent.filter((s) => s.kind === 'text').map((s) => String(s.payload));

describe('flag OFF: a v1.2.0 video quiz behaves exactly as on main', () => {
  beforeEach(() => { delete process.env.TRANSCRIPT_QUIZ_ENABLED; });

  test.each([
    'Please make me a lesson plan on fractions for grade 5', 'yes', 'hello', 'I need help', '1', 'B',
  ])('"%s" during an unfinished video quiz is not taken: false, nothing sent, nothing graded', async (text) => {
    reset({ mainShaped: true });
    expect(await settle(vq.answerTypedLetter(PHONE, text))).toBe(false);
    expect(answers()).toEqual([]);
    expect(mockSent).toEqual([]);
  });

  test('even a lesson-quiz state is not read while the flag is off', async () => {
    reset({ quizSource: 'transcript' });
    expect(await settle(vq.answerTypedLetter(PHONE, 'B'))).toBe(false);
    expect(answers()).toEqual([]);
  });

  // On main the video engine never read a typed STOP: it went on to the
  // adaptive quiz / chat, and the video quiz stayed open for its taps.
  test('"stop" during an unfinished video quiz is not taken: false, quiz left running', async () => {
    reset({ mainShaped: true });
    expect(await settle(vq.stopTyped(PHONE, 'stop'))).toBe(false);
    expect(mockSent).toEqual([]);
    expect(mockKv.has(`videoquiz:${PHONE}:active`)).toBe(true);
  });
});

describe('flag ON', () => {
  test('a v1.2.0 video quiz (main-shaped state) is still not taken: "1" is not graded', async () => {
    reset({ mainShaped: true });
    expect(await settle(vq.answerTypedLetter(PHONE, '1'))).toBe(false);
    expect(answers()).toEqual([]);
    expect(mockSent).toEqual([]);
  });

  test('a state that names the video stream is not taken either', async () => {
    reset({ quizSource: 'video' });
    expect(await settle(vq.answerTypedLetter(PHONE, 'B'))).toBe(false);
    expect(answers()).toEqual([]);
  });

  test('RUMI_FEATURE_LESSON_QUIZ=off pauses it like the flag', async () => {
    require('../../bot/shared/config/feature-overrides').setEnabled('lesson_quiz', false);
    reset({ quizSource: 'transcript' });
    expect(await settle(vq.answerTypedLetter(PHONE, 'B'))).toBe(false);
    expect(answers()).toEqual([]);
  });

  test.each(['lp_generated', 'topic', 'transcript'])('a %s quiz takes a typed letter', async (src) => {
    reset({ quizSource: src });
    expect(await settle(vq.answerTypedLetter(PHONE, 'b'))).toBe(true);
    expect(answers()).toEqual([expect.objectContaining({ question_id: 'q-1', selected_option: 'B', is_correct: true })]);
  });

  test.each([
    'Please make me a lesson plan on fractions for grade 5', 'yes', 'hello', 'banana', 'I need help', 'a lot',
  ])('"%s" is not a letter: false (on to chat), nothing sent, nothing graded', async (text) => {
    reset({ quizSource: 'transcript' });
    expect(await settle(vq.answerTypedLetter(PHONE, text))).toBe(false);
    expect(answers()).toEqual([]);
    expect(mockSent).toEqual([]);
  });

  test('a join step pending on the phone: a sibling\'s "2" goes to the join, not the quiz', async () => {
    reset({ quizSource: 'transcript' });
    mockKv.set(`videoquiz:${PHONE}:join`, JSON.stringify({ step: 'whoami', shareCodeId: 'sc-2', candidates: [{ id: 's1' }] }));
    expect(await settle(vq.answerTypedLetter(PHONE, '2'))).toBe(false);
    expect(answers()).toEqual([]);
    expect(mockSent).toEqual([]);
  });

  test('a letter the question does not offer re-asks, and the re-ask names STOP', async () => {
    reset({ quizSource: 'transcript' });
    expect(await settle(vq.answerTypedLetter(PHONE, 'D'))).toBe(true);
    expect(answers()).toEqual([]);
    expect(texts().join('\n')).toMatch(/A, B or C/);
    expect(texts().join('\n')).toMatch(/STOP/);
  });

  test('the Urdu re-ask names STOP too', async () => {
    reset({ quizSource: 'transcript' });
    const st = JSON.parse(mockKv.get(`videoquiz:${PHONE}:active`));
    mockKv.set(`videoquiz:${PHONE}:active`, JSON.stringify({ ...st, language: 'ur' }));
    expect(await settle(vq.answerTypedLetter(PHONE, 'D'))).toBe(true);
    expect(texts().join('\n')).toMatch(/STOP/);
  });

  test('a state from before quizSource was carried is classified by its quiz row', async () => {
    reset({ quizSource: 'transcript' });
    const st = JSON.parse(mockKv.get(`videoquiz:${PHONE}:active`));
    delete st.quizSource;
    mockKv.set(`videoquiz:${PHONE}:active`, JSON.stringify(st));
    expect(await settle(vq.answerTypedLetter(PHONE, 'B'))).toBe(true);
    expect(answers()).toEqual([expect.objectContaining({ selected_option: 'B' })]);
  });
});

describe('two fast typed replies (review F-S8)', () => {
  test('"B" then "C" before the first is graded: one answer, the next question sent once', async () => {
    reset({ quizSource: 'transcript' });
    // Both replies read the waiting question before either takes the answer
    // lock; the second must find the question moved on and be dropped.
    const both = Promise.all([vq.answerTypedLetter(PHONE, 'B'), vq.answerTypedLetter(PHONE, 'C')]);
    const [first, second] = await settle(both);
    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(answers()).toEqual([expect.objectContaining({ question_id: 'q-1', selected_option: 'B' })]);
    const asked = mockSent.filter((s) => JSON.stringify(s.payload).includes('Next question?'));
    expect(asked).toHaveLength(1);
  });
});

describe('digits from an Urdu or Arabic keyboard (review F-N5)', () => {
  test.each([['۲', 'Urdu'], ['٢', 'Arabic-Indic']])('"%s" (%s two) names B, like "2"', async (reply) => {
    reset({ quizSource: 'transcript' });
    expect(await settle(vq.answerTypedLetter(PHONE, reply))).toBe(true);
    expect(answers()).toEqual([expect.objectContaining({ question_id: 'q-1', selected_option: 'B', is_correct: true })]);
  });
});
