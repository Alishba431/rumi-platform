'use strict';
/**
 * The DIGEST of a quiz with no recording — written from a lesson PLAN's text
 * (lp_generated) or from nothing but a TOPIC (`/quiz <topic>`).
 *
 * Both hand the author pass the SAME shape the transcript digest produces
 * (normaliseDigest), because everything downstream reads that shape. A topic
 * digest may never claim a lesson happened: its evidence quotes are empty,
 * asserted in code.
 *
 * Only the LLM client (the network boundary) is doubled.
 */
jest.mock('../../bot/shared/services/quiz/transcript-quiz-llm', () => ({ completeJson: jest.fn() }));
jest.mock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const { completeJson } = require('../../bot/shared/services/quiz/transcript-quiz-llm');
const { logEvent } = require('../../bot/shared/utils/structured-logger');
const PlanDigest = require('../../bot/shared/services/quiz/plan-quiz-digest.service');
const { normaliseDigest } = require('../../bot/shared/services/quiz/transcript-quiz-digest.service');

const PLAN_TEXT = [
  'Lesson: Comparing fractions with the same denominator',
  'Objective: children compare two fractions with the same denominator.',
  'Worked example: fold a strip into 5 equal parts; shade 2 and then 4; 4/5 is more than 2/5.',
  'Common mistake: some children think a bigger denominator always means a bigger fraction.',
  'Practice: Which is bigger, 3/8 or 5/8? Exit ticket: Which is smaller, 1/4 or 3/4?',
].join('\n').repeat(2);
const PLAN = { kind: 'plan', from: 'plan_text', text: PLAN_TEXT, title: 'Comparing fractions' };
const TOPIC = { kind: 'topic', from: 'topic', text: null, title: 'The water cycle' };

const REPLY = {
  topic: 'Comparing fractions', topic_as_taught: 'Comparing fractions', subject: 'maths', grade_band: '3-5',
  language_of_instruction: 'en', confidence: 0.9,
  slos: [{ id: 'S1', statement: 'Compare fractions', statement_en: 'Compare fractions', evidence_quote: 'compare two fractions', taught_level: 'understand' }],
  key_terms: [{ term: 'denominator', as_spoken: 'denominator' }],
  examples_used: ['a strip in 5 parts'], misconceptions_surfaced: ['a bigger denominator is a bigger fraction'], people: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.QUIZ_LANGUAGES;
  completeJson.mockResolvedValue({ json: REPLY, model: 'm', costUsd: 0.001, latencyMs: 5 });
});

describe('a plan', () => {
  test('the prompt carries the plan text and tells the model practice is shape, not questions', async () => {
    await PlanDigest.run({ source: PLAN, language: 'en', grade: '4', subject: 'maths' });
    const { prompt } = completeJson.mock.calls[0][0];
    expect(prompt).toContain('LESSON PLAN');
    expect(prompt).toContain('fold a strip into 5 equal parts');
    expect(prompt).toMatch(/PRACTICE IS SHAPE/);
    expect(prompt).not.toMatch(/Pakistan|government school/i);
  });

  test('returns the transcript digest\'s shape, key for key', async () => {
    const out = await PlanDigest.run({ source: PLAN, language: 'en', grade: '4', subject: 'maths' });
    const shape = Object.keys(normaliseDigest(REPLY)).sort();
    expect(Object.keys(out.digest).filter((k) => !['source_kind'].includes(k)).sort()).toEqual(shape);
    expect(out).toEqual(expect.objectContaining({ grade: '4', gradeSource: 'quiz', lpHint: null, model: 'm' }));
    expect(out.digest.source_kind).toBe('plan');
  });

  test('the row\'s subject wins over the model\'s reading, which is kept for the record', async () => {
    completeJson.mockResolvedValue({ json: { ...REPLY, subject: 'science' }, model: 'm', costUsd: 0, latencyMs: 1 });
    const out = await PlanDigest.run({ source: PLAN, language: 'en', grade: '4', subject: 'Mathematics' });
    expect(out.digest.subject).toBe('maths');
    expect(out.digest.subject_read).toBe('science');
    expect(out.digest.subject_conflict).toBe(true);
  });

  test('asks for one statement per configured quiz language, and only those', async () => {
    process.env.QUIZ_LANGUAGES = 'en,ur';
    await PlanDigest.run({ source: PLAN, language: 'en' });
    expect(completeJson.mock.calls[0][0].prompt).toMatch(/"statement_ur"/);
    delete process.env.QUIZ_LANGUAGES;
    completeJson.mockClear();
    await PlanDigest.run({ source: PLAN, language: 'en' });
    expect(completeJson.mock.calls[0][0].prompt).not.toMatch(/statement_ur/);
  });

  test('the author reads the plan itself, capped', () => {
    const block = PlanDigest.lessonExcerpts(PLAN);
    expect(block).toMatch(/^LESSON: Comparing fractions/);
    expect(block).toContain('Common mistake');
    const long = PlanDigest.lessonExcerpts({ ...PLAN, text: 'x '.repeat(20000) });
    expect(long.length).toBeLessThan(PlanDigest.EXCERPT_MAX + 200);
  });

  test('a plan whose text could not be had is written from its title, as a topic', async () => {
    const out = await PlanDigest.run({ source: { kind: 'plan', from: 'topic', text: null, title: 'Comparing fractions' }, language: 'en' });
    expect(completeJson.mock.calls[0][0].prompt).toMatch(/NO lesson plan and NO recording/);
    expect(out.digest.source_kind).toBe('topic');
  });
});

describe('a topic', () => {
  test('the prompt says there is no lesson, and asks for no evidence', async () => {
    await PlanDigest.run({ source: TOPIC, language: 'en', grade: '5', subject: 'science' });
    const { prompt, label } = completeJson.mock.calls[0][0];
    expect(label).toBe('topic_quiz.digest');
    expect(prompt).toContain('The water cycle');
    expect(prompt).toMatch(/NO lesson plan and NO recording/);
    expect(prompt).toMatch(/"evidence_quote" is ALWAYS ""/);
  });

  test('evidence quotes are emptied in code, whatever the model wrote', async () => {
    const out = await PlanDigest.run({ source: TOPIC, language: 'en', grade: '5', subject: 'science' });
    expect(out.digest.slos.every((s) => s.evidence_quote === '')).toBe(true);
    expect(out.digest.source_kind).toBe('topic');
  });

  test('no grade on the row: the digest\'s band, and it says so', async () => {
    const out = await PlanDigest.run({ source: TOPIC, language: 'en' });
    expect(out.grade).toBe('3-5');
    expect(out.gradeSource).toBe('digest');
  });

  test('the author is told it is a topic, with no lesson text behind it', () => {
    expect(PlanDigest.lessonExcerpts(TOPIC)).toMatch(/THE TOPIC THE TEACHER NAMED: The water cycle/);
  });
});

describe('nothing to write from', () => {
  test.each([
    ['no source', null],
    ['a topic with no name', { kind: 'topic', text: null, title: '  ' }],
    ['a plan with neither text nor title', { kind: 'plan', text: '', title: '' }],
  ])('%s fails loudly as SOURCE_UNUSABLE, before any model call', async (_n, source) => {
    await expect(PlanDigest.run({ source, language: 'en' })).rejects.toMatchObject({ code: 'SOURCE_UNUSABLE' });
    expect(completeJson).not.toHaveBeenCalled();
  });

  test('the event records the source kind and where its text came from', async () => {
    await PlanDigest.run({ source: PLAN, language: 'en', quizSource: 'lp_generated' });
    const [, payload] = logEvent.mock.calls.find((c) => /digest_done/.test(c[0]));
    expect(payload).toEqual(expect.objectContaining({ quiz_source: 'lp_generated', sourceKind: 'plan', sourceFrom: 'plan_text' }));
  });
});
