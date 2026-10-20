'use strict';
/**
 * A blind solver (or a plan key check) that answers NOTHING usable is a failed
 * check, not a clean one: `{"answers": []}`, or answers whose indices or option
 * numbers are all out of range, leave every item without a verdict. The quiz
 * still ships as authored (fail-open), but the record says `status: 'error'`
 * and the failure is logged at ERROR — the same as a solver that threw. A
 * solver that answers every item "unsure" is still a real (unclear) answer.
 *
 * Mocked at the boundary only: the LLM client (completeJson), supabase, WhatsApp,
 * the queue, R2, the PDF renderer and the share-code minter. The author, the
 * validator, the key verify and key check services, generate and the hand-off
 * all run for real.
 */

jest.mock('../../bot/shared/services/quiz/transcript-quiz-llm', () => ({ completeJson: jest.fn() }));
jest.mock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn().mockResolvedValue(true),
  sendDocument: jest.fn().mockResolvedValue(true),
  sendInteractiveButtons: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../bot/shared/services/queue/sqs-queue.service', () => ({ queueJob: jest.fn().mockResolvedValue('mid') }));
jest.mock('../../bot/shared/services/quiz/video-quiz-share.service', () => ({
  mintCode: jest.fn().mockResolvedValue({ id: 'sc-1', code: 'ABC234', teacherName: 'Sam Rivera' }),
  botNumber: jest.fn().mockReturnValue('15550000000'),
  joinInvite: jest.fn(({ code }) => ({ kind: 'wa', link: `https://wa.me/15550000000?text=QUIZ-${code}`, bot: 'Rumi', code })),
}));
jest.mock('../../bot/shared/utils/html-to-pdf', () => ({
  htmlToPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
  htmlToImage: jest.fn().mockResolvedValue(Buffer.from('png-bytes')),
}));
jest.mock('../../bot/shared/storage/r2', () => ({
  isR2Configured: jest.fn(() => true), uploadBuffer: jest.fn().mockResolvedValue('https://r2/x'), downloadFromR2: jest.fn(),
}));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const { completeJson } = require('../../bot/shared/services/quiz/transcript-quiz-llm');
const supabase = require('../../bot/shared/config/supabase');
const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const { logToFile } = require('../../bot/shared/utils/logger');
const { logEvent } = require('../../bot/shared/utils/structured-logger');
const { UX_STRINGS } = require('../../bot/shared/config/ux-strings');
const { failureCopyKey } = require('../../bot/shared/services/quiz/quiz-sources');
const { installFrom } = require('./helpers/supabase-chain');
const F = require('./helpers/key-verify-fixture');
const LP = require('./helpers/plan-key-check-fixture');
const Handoff = require('../../bot/shared/services/quiz/transcript-quiz-handoff.service');
const Gen = require('../../bot/shared/services/quiz/transcript-quiz-generate.service');

const QID = '33c92e31-0000-4000-8000-000000000001';
const TEACHER = { id: 'u-1', name: 'Sam Rivera', phone_number: '15550001234', preferred_language: 'ur' };
const TRANSCRIPT_QUIZ = {
  id: QID, teacher_id: 'u-1', coaching_session_id: 's-1', quiz_source: 'transcript', topic: 'حروف کا جوڑ توڑ',
  subject: 'urdu', language: 'ur', status: 'generating', grade: '3',
  meta: { digest: F.DIGEST, grade: '3', step: 'author' },
};
const LP_QUIZ = {
  id: QID, teacher_id: 'u-1', coaching_session_id: null, quiz_source: 'lp_generated', lesson_plan_id: LP.LESSON_PLAN_ID, topic: 'واحد اور جمع',
  subject: 'urdu', language: 'ur', status: 'generating', grade: '3',
  meta: {
    step: 'digest', source: 'menu', lesson_date: '2026-09-23',
    lessons: [{ lesson_plan_id: LP.LESSON_PLAN_ID }],
  },
};

const clean = (s) => String(s || '').replace(/\u200f/g, '').trim();

/**
 * The items a solver prompt asks about, read off its own item blocks:
 * `q<i> (…): <stem>` then `options: [0] … | [1] … | [2] …`.
 */
function itemsIn(prompt) {
  const out = new Map();
  for (const m of String(prompt).matchAll(/^q(\d+) \([^)\n]*\): (.*)\n\s+options: (.*)$/gm)) {
    const options = m[3].split(' | ').map((s) => clean(s.replace(/^\[\d+\]\s*/, '')));
    out.set(Number(m[1]), { stem: clean(m[2]), options });
  }
  return out;
}

/** What is actually true, by stem: the texts of every correct option. */
function truthFrom(questions, overrides = {}) {
  const t = new Map(questions.map((q) => [clean(q.question), [clean(q.options[q.correct_index])]]));
  Object.entries(overrides).forEach(([stem, texts]) => t.set(clean(stem), texts.map(clean)));
  return t;
}

/** A solver that answers every asked item from `truth` (texts), by the positions it was SHOWN. */
function solverFor(truth) {
  return (prompt) => ({
    answers: [...itemsIn(prompt)].map(([index, item]) => {
      const right = truth.get(item.stem) || [];
      return { index, correct: item.options.map((o, k) => (right.includes(o) ? k : -1)).filter((k) => k >= 0), unsure: false, note: '' };
    }),
  });
}

const TRUTH = truthFrom(F.AUTHORED, {
  [F.HAAL_STEM]: [F.HAAL_RIGHT],
  [F.SALAAM_STEM]: [F.SALAAM_KEY, F.SALAAM_TWIN],
});

/** The second solve, without the lesson, when a test is not about it: unsure of everything, so it changes no verdict. */
const unsureOfEverything = (prompt) => ({
  answers: [...itemsIn(prompt).keys()].map((index) => ({ index, correct: [], unsure: true, note: '' })),
});

/**
 * The LLM, routed by the label each pass names itself with. `verify` answers
 * every blind-solve call with (prompt, n); `bare` the solve without the lesson
 * (transcript-quiz-key-truth.test.js drives that one); `rewrite` the targeted rewrite.
 */
function llm({ verify, rewrite, check, bare = unsureOfEverything } = {}) {
  let verifies = 0;
  let bares = 0;
  let checks = 0;
  completeJson.mockImplementation(async ({ label, prompt }) => {
    if (label === 'plan_quiz.digest') return { json: LP.MODEL_DIGEST, model: 'dm', costUsd: 0.001, latencyMs: 5 };
    if (label === 'transcript_quiz.author') {
      const lp = /واحد|جمع/.test(prompt) && !/جوڑ توڑ/.test(prompt);
      return lp
        ? { json: { lesson_summary: LP.LESSON_SUMMARY, questions: LP.AUTHORED }, model: 'am', costUsd: 0.01, latencyMs: 50 }
        : { json: { lesson_summary: F.LESSON_SUMMARY, questions: F.AUTHORED }, model: 'am', costUsd: 0.01, latencyMs: 50 };
    }
    if (label === 'plan_quiz.key_check') {
      checks += 1;
      const json = check ? await check(prompt, checks)
        : { verdicts: [...String(prompt).matchAll(/^q(\d+): /gm)].map((m) => ({ index: Number(m[1]), verdict: 'consistent', quote: '' })) };
      return { json, model: 'cm', costUsd: 0.002, latencyMs: 20 };
    }
    if (label === 'transcript_quiz.key_verify') {
      verifies += 1;
      const json = await verify(prompt, verifies);
      return { json, model: 'vm', costUsd: 0.004, latencyMs: 40 };
    }
    if (label === 'transcript_quiz.key_verify_bare') {
      bares += 1;
      return { json: await bare(prompt, bares), model: 'vm', costUsd: 0.004, latencyMs: 40 };
    }
    if (label === 'transcript_quiz.rewrite') {
      if (!rewrite) throw new Error('no rewrite expected');
      return { json: await rewrite(prompt), model: 'rm', costUsd: 0.003, latencyMs: 30 };
    }
    throw new Error(`unexpected LLM call: ${label}`);
  });
}

function wireTranscript(quiz = TRANSCRIPT_QUIZ) {
  installFrom(supabase.from, ({
    quizzes: (calls) => (calls.some((c) => c[0] === 'update') ? { data: [{ id: QID }] } : { data: [quiz] }),
    coaching_sessions: {
      data: [{
        id: 's-1', user_id: 'u-1', transcript_text: 'آج ہم نے حروف کا جوڑ توڑ کیا۔ '.repeat(120), transcript_language: 'ur',
        created_at: '2026-09-23T05:00:00Z', analysis_data: {}, users: TEACHER,
      }],
    },
    quiz_questions: (calls) => (calls.some((c) => c[0] === 'insert') ? { data: null, error: null } : { data: [] }),
    users: { data: [TEACHER] },
  }));
}

function wireLp(quiz = LP_QUIZ) {
  installFrom(supabase.from, ({
    quizzes: (calls) => (calls.some((c) => c[0] === 'update') ? { data: [{ id: QID }] } : { data: [quiz] }),
    coaching_sessions: () => { throw new Error('a plan quiz must never query coaching_sessions'); },
    lesson_plans: { data: [{ id: LP.LESSON_PLAN_ID, topic: 'واحد اور جمع', grade: '3', subject: 'urdu', content: { plan_text: LP.PLAN_TEXT, source: 'gamma_pdf' }, pdf_url: null }] },
    quiz_questions: (calls) => (calls.some((c) => c[0] === 'insert') ? { data: null, error: null } : { data: [] }),
    users: { data: [TEACHER] },
  }));
}

const quizUpdates = () => supabase.from.callsFor('quizzes').flat().filter((c) => c[0] === 'update').map((u) => u[1]);
const readyUpdate = () => quizUpdates().find((u) => u.status === 'ready');
const insertedRows = () => {
  const ins = supabase.from.callsFor('quiz_questions').flat().filter((c) => c[0] === 'insert');
  return ins.length ? ins[ins.length - 1][1] : null;
};
/** The option texts a stored row marks correct. */
const keyedTexts = (row) => row.correct_option.split(',').map((l) => clean(row[`option_${l.trim().toLowerCase()}`]));
const optionTexts = (row) => ['a', 'b', 'c', 'd'].map((l) => row[`option_${l}`]).filter((o) => o != null).map(clean);
const rowFor = (rows, stem) => rows.find((r) => clean(r.question_text) === clean(stem));
const callsLabelled = (label) => completeJson.mock.calls.filter((c) => c[0].label === label);
const verifyEvent = () => {
  const ev = logEvent.mock.calls.filter((c) => c[0] === 'transcript_quiz.key_verify');
  return ev.length ? ev[ev.length - 1][1] : null;
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Gen, 'sleep').mockResolvedValue(undefined);
  jest.spyOn(Handoff, 'sleep').mockResolvedValue(undefined);
});


const kvErrorLogs = () => logToFile.mock.calls.filter((c) => c[2] === 'error' && /key verify/i.test(c[0]));

test('{"answers": []} from the solve with the lesson is recorded as error, logged at ERROR', async () => {
  llm({ verify: () => ({ answers: [] }), bare: () => ({ answers: [] }) });
  wireTranscript();
  const r = await Gen.process(QID, {});
  expect(r.ok).toBe(true);
  const kv = readyUpdate().meta.key_verify;
  expect(kv.status).toBe('error');
  expect(kv.error).toMatch(/no usable answer/i);
  expect(kvErrorLogs().length).toBeGreaterThan(0);
  expect(verifyEvent().status).toBe('error');
});

test('answers whose indices and option numbers are all out of range are an error too', async () => {
  llm({
    verify: (prompt) => ({
      answers: [...itemsIn(prompt).keys()].map((index, k) => (k % 2
        ? { index: index + 100, correct: [0], unsure: false }
        : { index, correct: [9], unsure: false })),
    }),
  });
  wireTranscript();
  await Gen.process(QID, {});
  expect(readyUpdate().meta.key_verify.status).toBe('error');
  expect(kvErrorLogs().length).toBeGreaterThan(0);
});

test('the solve without the lesson answering nothing marks the bare pass error, logged at ERROR', async () => {
  llm({ verify: solverFor(TRUTH), bare: () => ({ answers: [] }), rewrite: () => { throw new Error('skip'); } });
  wireTranscript();
  await Gen.process(QID, {});
  const kv = readyUpdate().meta.key_verify;
  expect(kv.bare.status).toBe('error');
  expect(logToFile.mock.calls.some((c) => c[2] === 'error' && /without the lesson failed/.test(c[0]))).toBe(true);
});

test('a solver unsure of every item is an answer (unclear), not an error', async () => {
  llm({ verify: unsureOfEverything });
  wireTranscript();
  await Gen.process(QID, {});
  const kv = readyUpdate().meta.key_verify;
  expect(kv.status).toBe('clean');
  expect(kv.unclear).toBe(kv.checked);
});

test('a plan key check that returns {"verdicts": []} is recorded as error, logged at ERROR', async () => {
  llm({ verify: unsureOfEverything, check: () => ({ verdicts: [] }) });
  wireLp();
  await Gen.process(QID, {});
  const kc = readyUpdate().meta.key_check;
  expect(kc.status).toBe('error');
  expect(kc.error).toMatch(/no usable verdict/i);
  expect(logToFile.mock.calls.some((c) => c[2] === 'error' && /key check/i.test(c[0]))).toBe(true);
});
