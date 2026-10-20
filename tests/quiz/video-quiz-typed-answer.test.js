'use strict';
/**
 * Typed answers — the child's side of the quiz on a channel without buttons.
 *
 * On Baileys and Matrix a reply button is drawn as numbered text and the menu
 * matcher (messaging/pending-options.js) refuses one-letter replies by design, so
 * a child there types "B", "b.", "2" — or, on a select-all-that-apply question,
 * "A C", "a, c", "a and c". The quiz reads those itself:
 *   - a single letter (any case, an optional trailing "." or ")") answers the
 *     question waiting on this phone, as the option the child saw under it;
 *   - a SET answers a select-all question, scored by exact set equality — a
 *     partial set is wrong and the reply says what was missed;
 *   - a letter / set that cannot be graded (a letter the question does not
 *     offer, a set on a single-answer question) re-asks and counts nothing;
 *   - anything that is not a letter / number / set ("banana") is not an answer:
 *     false, and the message goes on to chat;
 *   - on a typing channel each question is sent as lettered text, never as
 *     buttons, and a select-all question is "reply with every right letter"
 *     on every channel (no Meta Flow).
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

const single = {
  id: 'q-single', quiz_id: 'quiz-1', external_id: 'tq:quiz-1:S1:0', sort_order: 0,
  question_text: 'Which shape has three sides?', option_a: 'Square', option_b: 'Triangle', option_c: 'Circle',
  option_d: null, correct_option: 'B', explanation: 'A triangle has three sides.', option_feedback: null,
  media: { display_order: [0, 1, 2] }, render_pattern: 'P1',
};
const multi = {
  id: 'q-multi', quiz_id: 'quiz-1', external_id: 'tq:quiz-1:S1:1', sort_order: 1,
  question_text: 'Which of these are even numbers?', option_a: '2', option_b: '3', option_c: '4', option_d: '5',
  correct_option: 'A,C', explanation: '', option_feedback: null,
  media: { answer_mode: 'multi', display_order: [0, 1, 2, 3] }, render_pattern: 'P1',
};
const spare = {
  ...single, id: 'q-spare', external_id: 'tq:quiz-1:S1:2', sort_order: 2, question_text: 'Spare question?',
};

function reset({ current, questionIds = ['q-single', 'q-multi', 'q-spare'], phone = PHONE } = {}) {
  mockMem = createMemorySupabase({
    quiz_questions: [single, multi, spare],
    quiz_answers: [],
    quiz_sessions: [{ id: SESSION, quiz_id: 'quiz-1', status: 'in_progress', total_questions_answered: 0, correct_answers: 0 }],
    quizzes: [{ id: 'quiz-1', topic: 'Shapes', quiz_source: 'transcript' }],
  });
  mockKv.clear();
  mockSent.length = 0;
  mockKv.set(`videoquiz:${phone}:active`, JSON.stringify({
    sessionId: SESSION, quizId: 'quiz-1', videoId: null, userId: null, language: 'en', source: 'share_link',
    shareCodeId: null, studentId: 'st-1', takerName: 'Child Example', questionIds,
    index: questionIds.indexOf(current), correct: 0, answered: 0, currentQuestionId: current, sentAt: Date.now(),
  }));
}

let vq;
let savedDriver;
let savedFlag;
beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers();
  savedDriver = process.env.CHANNEL_DRIVER;
  savedFlag = process.env.TRANSCRIPT_QUIZ_ENABLED;
  process.env.CHANNEL_DRIVER = 'baileys';
  // Typed answers are a lesson-quiz feature: they are read only with it on.
  process.env.TRANSCRIPT_QUIZ_ENABLED = 'true';
  vq = require('../../bot/shared/services/quiz/video-quiz.service');
});
afterEach(() => {
  jest.useRealTimers();
  if (savedDriver === undefined) delete process.env.CHANNEL_DRIVER; else process.env.CHANNEL_DRIVER = savedDriver;
  if (savedFlag === undefined) delete process.env.TRANSCRIPT_QUIZ_ENABLED; else process.env.TRANSCRIPT_QUIZ_ENABLED = savedFlag;
});

/** Run a service call to completion through its sleeps (answer pause, send gaps). */
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

describe('a single-answer question answered by a typed letter', () => {
  test.each(['B', 'b', 'b.', 'B)', ' b '])('"%s" is the option shown under B', async (reply) => {
    reset({ current: 'q-single' });
    const took = await settle(vq.answerTypedLetter(PHONE, reply));
    expect(took).toBe(true);
    expect(answers()).toEqual([expect.objectContaining({ question_id: 'q-single', selected_option: 'B', is_correct: true })]);
  });

  test('a number names the same option on a typing channel ("2" = B)', async () => {
    reset({ current: 'q-single' });
    await settle(vq.answerTypedLetter(PHONE, '2'));
    expect(answers()).toEqual([expect.objectContaining({ selected_option: 'B', is_correct: true })]);
  });

  test('a letter the question does not offer re-asks and counts nothing', async () => {
    reset({ current: 'q-single' });
    const took = await settle(vq.answerTypedLetter(PHONE, 'D'));
    expect(took).toBe(true);
    expect(answers()).toEqual([]);
    expect(texts().join('\n')).toMatch(/A, B or C/);
  });

  test('"banana" is not an answer: false (on to chat), nothing sent, nothing counted', async () => {
    reset({ current: 'q-single' });
    const took = await settle(vq.answerTypedLetter(PHONE, 'banana'));
    expect(took).toBe(false);
    expect(answers()).toEqual([]);
    expect(texts()).toEqual([]);
  });

  test('a set on a single-answer question re-asks', async () => {
    reset({ current: 'q-single' });
    await settle(vq.answerTypedLetter(PHONE, 'A C'));
    expect(answers()).toEqual([]);
  });

  test('STOP, a slash command and a share code are not answers: false, the message goes on', async () => {
    reset({ current: 'q-single' });
    for (const text of ['stop', 'STOP.', '/quiz', 'QUIZ-ABC234']) {
      // eslint-disable-next-line no-await-in-loop
      expect(await settle(vq.answerTypedLetter(PHONE, text))).toBe(false);
    }
    expect(answers()).toEqual([]);
    expect(mockSent).toEqual([]);
  });

  test('no question waiting: not ours', async () => {
    reset({ current: 'q-single' });
    mockKv.clear();
    expect(await settle(vq.answerTypedLetter(PHONE, 'B'))).toBe(false);
  });
});

describe('a select-all question answered by typed letters', () => {
  test.each(['A C', 'a,c', 'A, C', 'a and c', 'c a', 'A C.'])('"%s" is the full set and scores', async (reply) => {
    reset({ current: 'q-multi' });
    const took = await settle(vq.answerTypedLetter(PHONE, reply));
    expect(took).toBe(true);
    expect(answers()).toEqual([expect.objectContaining({ question_id: 'q-multi', selected_option: 'A,C', is_correct: true })]);
  });

  test('a partial set is wrong, and the reply says what was missed', async () => {
    reset({ current: 'q-multi' });
    await settle(vq.answerTypedLetter(PHONE, 'A'));
    expect(answers()).toEqual([expect.objectContaining({ selected_option: 'A', is_correct: false })]);
    expect(texts().join('\n')).toMatch(/You missed 4/);
  });

  test('a letter outside the question re-asks and counts nothing', async () => {
    reset({ current: 'q-multi' });
    const took = await settle(vq.answerTypedLetter(PHONE, 'A E'));
    expect(took).toBe(true);
    expect(answers()).toEqual([]);
    expect(texts().join('\n')).toMatch(/every right letter/i);
  });
});

describe('how a question is SENT on a typing channel', () => {
  test('a single-answer question arrives as lettered text, never buttons', async () => {
    reset({ current: 'q-single' });
    await settle(vq.answerTypedLetter(PHONE, 'B'));   // answering q-single sends q-multi next
    mockSent.length = 0;
    reset({ current: 'q-multi', questionIds: ['q-multi', 'q-single', 'q-spare'] });
    await settle(vq.answerTypedLetter(PHONE, 'A C'));  // → q-single is sent next
    const kinds = mockSent.map((s) => s.kind);
    expect(kinds).not.toContain('buttons');
    expect(kinds).not.toContain('list');
    const ask = texts().find((t) => t.includes('Which shape has three sides?'));
    expect(ask).toMatch(/A\. Square/);
    expect(ask).toMatch(/B\. Triangle/);
    expect(ask).toMatch(/C\. Circle/);
  });

  test('a select-all question is "reply with every right letter" — also on Meta, never a Flow', async () => {
    process.env.CHANNEL_DRIVER = 'meta';
    jest.resetModules();
    vq = require('../../bot/shared/services/quiz/video-quiz.service');
    reset({ current: 'q-single' });
    // Tapping B on Meta answers q-single; q-multi is sent next.
    await settle(vq.handleAnswer(PHONE, 'vq_q-single_1'));
    const kinds = mockSent.map((s) => s.kind);
    expect(kinds).not.toContain('flow');
    const ask = texts().find((t) => t.includes('Which of these are even numbers?'));
    expect(ask).toMatch(/A\. 2/);
    expect(ask).toMatch(/D\. 5/);
    expect(ask).toMatch(/every right letter/i);
  });

  test('on Meta a single-answer question keeps its native buttons', async () => {
    process.env.CHANNEL_DRIVER = 'meta';
    jest.resetModules();
    vq = require('../../bot/shared/services/quiz/video-quiz.service');
    reset({ current: 'q-multi', questionIds: ['q-multi', 'q-single', 'q-spare'] });
    await settle(vq.answerTypedLetter(PHONE, 'A C'));
    expect(mockSent.map((s) => s.kind)).toContain('buttons');
  });
});

describe('a Matrix child answers by typing whatever the WhatsApp driver is', () => {
  test('on a Meta deployment a Matrix recipient still gets lettered text, and its letter scores', async () => {
    process.env.CHANNEL_DRIVER = 'meta';
    jest.resetModules();
    vq = require('../../bot/shared/services/quiz/video-quiz.service');
    const MX = 'matrix:@child:example.org';
    reset({ current: 'q-multi', questionIds: ['q-multi', 'q-single', 'q-spare'], phone: MX });
    expect(await settle(vq.answerTypedLetter(MX, 'a, c'))).toBe(true);
    expect(answers()).toEqual([expect.objectContaining({ question_id: 'q-multi', selected_option: 'A,C', is_correct: true })]);
    const kinds = mockSent.map((s) => s.kind);
    expect(kinds).not.toContain('buttons');
    expect(texts().find((t) => t.includes('Which shape has three sides?'))).toMatch(/B\. Triangle/);
  });
});

describe('STOP typed during a quiz', () => {
  test('ends the run unfinished with the stopped copy; the answers so far stay counted', async () => {
    reset({ current: 'q-single' });
    expect(await settle(vq.stopTyped(PHONE, 'Stop.'))).toBe(true);
    expect(mockMem.tables.quiz_sessions[0]).toEqual(expect.objectContaining({ status: 'incomplete' }));
    expect(mockKv.has(`videoquiz:${PHONE}:active`)).toBe(false);
    expect(texts().join('\n')).toMatch(/stopped this quiz/);
  });

  test('anything else, or no quiz running, is not ours', async () => {
    reset({ current: 'q-single' });
    expect(await settle(vq.stopTyped(PHONE, 'B'))).toBe(false);
    mockKv.clear();
    expect(await settle(vq.stopTyped(PHONE, 'stop'))).toBe(false);
    expect(mockSent).toEqual([]);
  });
});
