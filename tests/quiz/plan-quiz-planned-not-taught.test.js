'use strict';
/**
 * A plan quiz says PLANNED, never TAUGHT — and a topic quiz says neither.
 *
 * A plan quiz (lp_generated) is written from a lesson plan the bot made for the
 * teacher. Nobody heard the lesson, so nothing the bot writes about it may
 * claim it happened. The lesson summary printed at the top of the teacher's PDF
 * once read «آپ نے … سکھایا» ("you taught …"): the plan rule asked for "you
 * planned", but the gender rule beside it offers «آپ نے … پڑھایا» as THE neutral
 * Urdu form, and the targeted rewrite of a rejected summary asked for "what you
 * taught" outright, whatever the quiz's source.
 *
 * A topic quiz has neither a recording nor a plan: its summary says what the
 * quiz covers, with the topic as its subject (TOPIC_SUMMARY_VOICE).
 *
 * The transcript path keeps "taught" everywhere — that lesson WAS taught. (The
 * hand-off caption is the hand-off's own suite.)
 *
 * Mocked at the boundary: supabase, WhatsApp, the queue, the LLM client, R2,
 * the PDF renderer and the share-code minter. Author, rewrite and generate run
 * for real.
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
  botNumber: jest.fn().mockReturnValue('15550009999'),
  joinInvite: jest.fn(({ code }) => ({ kind: 'wa', link: `https://wa.me/15550009999?text=QUIZ-${code}`, bot: 'Rumi', code })),
}));
jest.mock('../../bot/shared/utils/html-to-pdf', () => ({ htmlToPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')) }));
jest.mock('../../bot/shared/storage/r2', () => ({
  isR2Configured: jest.fn(() => true), uploadBuffer: jest.fn().mockResolvedValue('https://r2/x'), downloadFromR2: jest.fn(),
}));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const { completeJson } = require('../../bot/shared/services/quiz/transcript-quiz-llm');
const supabase = require('../../bot/shared/config/supabase');
const r2 = require('../../bot/shared/storage/r2');
const { installFrom } = require('./helpers/supabase-chain');
const Author = require('../../bot/shared/services/quiz/transcript-quiz-author.service');
const Rewrite = require('../../bot/shared/services/quiz/transcript-quiz-rewrite');
const Gen = require('../../bot/shared/services/quiz/transcript-quiz-generate.service');
// The blind solve is not this suite's subject: an agreeing solver on its seam (see the helper).
const { installAgreeingSolver } = require('./helpers/key-verify-agree');
// Nor is the grade 1-5 maths picture repair (see the helper).
const { installNoPictureRepair } = require('./helpers/no-picture-repair');

const QID = '66666666-6666-4666-8666-666666666666';
const DIGEST = {
  topic: 'Adding with carrying', topic_as_taught: 'Adding with carrying', subject: 'maths', grade_band: '1-2', confidence: 0.9,
  taught_level: 'apply',
  slos: [{ id: 'S1', statement: 'a', statement_en: 'a', statement_ur: 'ا', taught_level: 'apply' },
    { id: 'S2', statement: 'b', statement_en: 'b', statement_ur: 'ب', taught_level: 'understand' }],
  key_terms: [], examples_used: ['146 + 27'], misconceptions_surfaced: ['carries out of every column'],
};
const ROW = {
  external_id: `tq:${QID}:S1:1`, question_text: 'q', option_a: 'a', option_b: 'b', option_c: 'c',
  correct_option: 'A', explanation: null, distractor_misconceptions: null, option_feedback: { correct: 'ok', wrong: {} },
  media: null, render_pattern: 'P1', sort_order: 0,
};
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Gen, 'sleep').mockResolvedValue(undefined);
  installAgreeingSolver(Gen);
  installNoPictureRepair(Gen);
  r2.downloadFromR2.mockResolvedValue(Buffer.from('%PDF-1.4 stored'));
  installFrom(supabase.from, { quizzes: { data: [{ id: QID }] } });
});

// ── 1. the lesson summary the author writes ──────────────────────────────────

/** The prompt of the n-th LLM call. */
const promptOf = (n = 0) => completeJson.mock.calls[n][0].prompt;
/** The summary instruction of an author prompt: from its heading to the checks line. */
const summaryRule = (prompt) => prompt.slice(prompt.indexOf('LESSON SUMMARY.'), prompt.indexOf('"checks_summary"'));

describe('the author asks a plan summary to describe the plan, with the lesson as its subject', () => {
  beforeEach(() => {
    completeJson.mockResolvedValue({ json: { questions: [], lesson_summary: '' }, model: 'm', costUsd: 0, latencyMs: 1 });
  });

  test('the plan rule opens the summary on the lesson in both languages and bans "you taught" in both', async () => {
    await Author.author({ digest: DIGEST, language: 'ur', lessonPlan: 'WHAT THE CLASS WAS TO LEARN: carrying' });
    const rule = summaryRule(promptOf());
    expect(rule.length).toBeGreaterThan(50);
    expect(rule).toContain('Today\'s lesson plans');
    expect(rule).toContain('آج کے سبق میں');
    expect(rule).toMatch(/never[^.]*"you taught"/i);
    expect(rule).toMatch(/آپ نے … پڑھایا/);   // named as banned, not offered
    expect(rule).not.toMatch(/say what you taught/);
    expect(rule).not.toMatch(/say what you planned/);
  });

  test('a topic quiz: the topic is the subject, and neither "taught" nor "planned" is asked for', async () => {
    await Author.author({ digest: DIGEST, language: 'en', lessonPlan: 'THE TOPIC THE TEACHER NAMED: Fractions', topicOnly: true });
    const prompt = promptOf();
    const rule = summaryRule(prompt);
    expect(rule).toContain('This quiz is on');
    expect(rule).not.toContain('Today\'s lesson plans');
    expect(rule).not.toMatch(/say what you taught/);
    expect(prompt).toMatch(/there is NO plan and NO recording/);
  });

  test('a transcript quiz\'s summary rule is untouched — "you taught" is true there', async () => {
    await Author.author({ digest: DIGEST, language: 'ur', transcript: 'x'.repeat(2000) });
    const rule = summaryRule(promptOf());
    expect(rule).toMatch(/say what you taught and in the order you taught it/);
    expect(rule).not.toContain('آج کے سبق میں');
  });
});

// ── 2. the targeted rewrite of a rejected summary ────────────────────────────

const GOOD = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({
  slo_id: i % 2 ? 'S1' : 'S2', level: i % 2 ? 'apply' : 'understand', question: `Question ${i}: what is ${100 + i} + ${20 + i}?`,
  options: [`${120 + 2 * i}`, `${130 + 2 * i}`, `${110 + 2 * i}`], correct_index: 0,
  explanation: `Add the ones, then the tens: ${120 + 2 * i}.`,
  selected_because: `Question ${i} checks adding two numbers in columns.`,
  distractor_misconceptions: { 1: 'carried when no column reached ten', 2: 'dropped a ten' },
  option_feedback: { correct: 'Yes — ones first, then tens.', wrong: { 1: 'No column reached ten, so nothing carries.', 2: 'A ten was lost from the tens column.' } },
}));
const GENDERED = 'PEDAGOGY_GENDERED_TEACHER — "lesson_summary" refers to the teacher with a gendered word ("She").';

describe('the targeted rewrite keeps the plan voice, or the topic voice', () => {
  beforeEach(() => {
    completeJson.mockResolvedValue({ json: { lesson_summary: 'Today\'s lesson plans column addition.' }, model: 'm', costUsd: 0, latencyMs: 1 });
  });

  test('planned: the rewrite asks for the lesson-as-subject summary, never "what you taught"', async () => {
    await Rewrite.rewriteRejected({
      questions: GOOD, errors: [GENDERED], digest: DIGEST, language: 'ur', lessonSummary: 'She planned carrying.', planned: true,
    });
    const prompt = promptOf();
    expect(prompt).not.toMatch(/say what you taught/);
    expect(prompt).toContain('آج کے سبق میں');
    expect(prompt).toContain('Today\'s lesson plans');
  });

  test('topic: the rewrite asks for the topic voice', async () => {
    await Rewrite.rewriteRejected({
      questions: GOOD, errors: [GENDERED], digest: DIGEST, language: 'en', lessonSummary: 'She chose fractions.', planned: true, topicOnly: true,
    });
    const prompt = promptOf();
    expect(prompt).toContain('This quiz is on');
    expect(prompt).not.toContain('Today\'s lesson plans');
    expect(prompt).not.toMatch(/say what you taught/);
  });

  test('a transcript summary rewrite still asks for what was taught', async () => {
    await Rewrite.rewriteRejected({
      questions: GOOD, errors: [GENDERED], digest: DIGEST, language: 'ur', lessonSummary: 'She taught carrying.',
    });
    expect(promptOf()).toMatch(/say what you taught and in the order you taught it/);
  });

  const PLAN_ROW = {
    id: 'lp-1', topic: 'Adding with carrying', grade: '2', subject: 'maths', pdf_url: null,
    content: { plan_text: 'Objective: add a 3-digit and a 2-digit number, carrying into the tens. Worked example: 146 + 27 = 173. '.repeat(3) },
  };
  async function runGenerate(quiz) {
    installFrom(supabase.from, ({
      quizzes: (calls) => (calls.some((c) => c[0] === 'update') ? { data: [{ id: QID }] } : { data: [quiz] }),
      lesson_plans: { data: [PLAN_ROW] },
      quiz_questions: { data: [] },
      users: { data: [{ id: 'u-1', name: 'Sam Rivera', phone_number: '15550001234', preferred_language: 'en' }] },
    }));
    // The author's summary calls the teacher "She": the validator rejects the
    // summary, and the targeted rewrite is asked to repair it.
    completeJson.mockResolvedValue({
      json: { lesson_summary: 'She planned column addition with carrying for the class.', questions: GOOD },
      model: 'm', costUsd: 0, latencyMs: 1,
    });
    const spy = jest.spyOn(Gen, 'rewriteRejected').mockResolvedValue({ attempted: false });
    process.env.TRANSCRIPT_QUIZ_MAX_ATTEMPTS = '2';
    try {
      await Gen.process(QID, {});
    } finally {
      delete process.env.TRANSCRIPT_QUIZ_MAX_ATTEMPTS;
    }
    expect(spy).toHaveBeenCalled();
    const args = spy.mock.calls[0][0];
    spy.mockRestore();
    return args;
  }

  test('generate tells the rewrite a plan quiz was planned', async () => {
    const args = await runGenerate({
      id: QID, teacher_id: 'u-1', coaching_session_id: null, quiz_source: 'lp_generated', lesson_plan_id: 'lp-1', topic: 'Carrying',
      subject: 'maths', language: 'en', status: 'generating', grade: '2',
      meta: { step: 'author', digest: DIGEST, lesson_date: '2026-09-22', lessons: [{ lesson_plan_id: 'lp-1' }] },
    });
    expect(args).toEqual(expect.objectContaining({ planned: true, topicOnly: false }));
  });

  test('generate tells the rewrite a topic quiz is a topic', async () => {
    const args = await runGenerate({
      id: QID, teacher_id: 'u-1', coaching_session_id: null, quiz_source: 'topic', topic: 'Adding with carrying',
      subject: 'maths', language: 'en', status: 'generating', grade: '2',
      meta: { step: 'author', digest: DIGEST, lesson_date: '2026-09-22' },
    });
    expect(args).toEqual(expect.objectContaining({ planned: true, topicOnly: true }));
  });
});
