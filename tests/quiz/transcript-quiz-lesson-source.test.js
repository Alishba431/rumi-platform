'use strict';
/**
 * WHAT A PLAN OR TOPIC QUIZ IS WRITTEN FROM — resolveLessonSource.
 *
 * lp_generated: the platform's own `lesson_plans` row (quiz.lesson_plan_id, or
 * meta.lessons[0].lesson_plan_id). The plan text comes from content.plan_text,
 * else from the content JSON itself, else from the plan's PDF; a plan with none
 * of those is written from its topic. A plan row that is gone is nothing to
 * write from (null → source_missing); a database ERROR throws so the job is
 * redelivered rather than the teacher being told the plan is gone.
 *
 * topic: no source text at all — the quiz's own topic, grade and subject.
 *
 * Only the database client and the PDF fetch (axios + pdf-parse, the network
 * boundary) are doubled. A plan's PDF is read through main's shared
 * lesson-plan text helper — there is no second PDF reader in the quiz.
 */
jest.mock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
jest.mock('pdf-parse', () => jest.fn(), { virtual: true });
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const supabase = require('../../bot/shared/config/supabase');
const { installFrom } = require('./helpers/supabase-chain');
const Gen = require('../../bot/shared/services/quiz/transcript-quiz-generate.service');
const PlanDigest = require('../../bot/shared/services/quiz/plan-quiz-digest.service');
const LessonPlanText = require('../../bot/shared/services/coaching/fidelity/lesson-plan-text');
const axios = require('axios');
const pdfParse = require('pdf-parse');

const PLAN_ID = '66666666-6666-4666-8666-666666666666';
const PLAN_TEXT = 'Lesson objective: compare two fractions with the same denominator. '.repeat(10);
const quizFor = (over = {}) => ({
  id: 'q-1', teacher_id: 'u-1', quiz_source: 'lp_generated', lesson_plan_id: PLAN_ID,
  topic: 'Comparing fractions', grade: '4', subject: 'maths', meta: {}, ...over,
});

function wirePlan(row, error = null) {
  installFrom(supabase.from, { lesson_plans: error ? { data: null, error } : { data: row ? [row] : [] } });
}

beforeEach(() => {
  jest.restoreAllMocks();
  supabase.from.mockReset();
  axios.get.mockClear();
  pdfParse.mockReset();
});

describe('lp_generated', () => {
  test('content.plan_text is the plan', async () => {
    wirePlan({ id: PLAN_ID, topic: 'Comparing fractions', grade: '4', subject: 'Mathematics', content: { plan_text: PLAN_TEXT, source: 'gamma_pdf' }, pdf_url: 'https://cdn.test/p.pdf' });
    const src = await Gen.resolveLessonSource(quizFor());
    expect(src).toEqual(expect.objectContaining({
      kind: 'plan', from: 'plan_text', title: 'Comparing fractions', grade: '4', lessonPlanId: PLAN_ID,
    }));
    expect(src.text).toContain(PLAN_TEXT.trim());
    expect(axios.get).not.toHaveBeenCalled();
    const sel = supabase.from.callsFor('lesson_plans')[0];
    expect(sel).toEqual(expect.arrayContaining([['eq', 'id', PLAN_ID]]));
  });

  test('the stored plan is read through the shared lesson-plan text helper (one reader for every feature)', async () => {
    const row = { id: PLAN_ID, topic: 'Comparing fractions', grade: '4', subject: 'Mathematics', content: { plan_text: PLAN_TEXT }, pdf_url: null };
    wirePlan(row);
    const shared = jest.spyOn(LessonPlanText, 'planTextFromRow');
    const src = await Gen.resolveLessonSource(quizFor());
    expect(shared).toHaveBeenCalledWith(expect.objectContaining({ id: PLAN_ID, content: row.content }));
    expect(src.text).toBe(shared.mock.results[0].value);
  });

  test('the plan id may come from meta.lessons[0]', async () => {
    wirePlan({ id: PLAN_ID, topic: 'T', content: { plan_text: PLAN_TEXT } });
    const src = await Gen.resolveLessonSource(quizFor({ lesson_plan_id: null, meta: { lessons: [{ lesson_plan_id: PLAN_ID }] } }));
    expect(src.lessonPlanId).toBe(PLAN_ID);
    expect(src.from).toBe('plan_text');
  });

  test('content without plan_text is read as the plan itself, flattened to its text', async () => {
    const content = { objective: 'Compare fractions with like denominators', activities: ['Fold paper strips into quarters', 'Shade 3/4 and 1/4 and compare'], assessment: { exit: 'Which is bigger, 2/5 or 4/5?' } };
    wirePlan({ id: PLAN_ID, topic: 'Comparing fractions', content, pdf_url: null });
    const src = await Gen.resolveLessonSource(quizFor());
    expect(src.from).toBe('content');
    expect(src.text).toMatch(/Fold paper strips into quarters/);
    expect(src.text).toMatch(/Which is bigger, 2\/5 or 4\/5\?/);
    expect(src.text).not.toMatch(/[{}"]/);
  });

  test('no content: the PDF is read through the shared helper, with a size cap on the download', async () => {
    wirePlan({ id: PLAN_ID, topic: 'Comparing fractions', content: null, pdf_url: 'https://cdn.test/plan.pdf' });
    const shared = jest.spyOn(LessonPlanText, 'renderLinkedPlanText');
    axios.get.mockResolvedValueOnce({ data: Buffer.from('%PDF-1.4'), status: 200 });
    pdfParse.mockResolvedValueOnce({ text: PLAN_TEXT });
    const src = await Gen.resolveLessonSource(quizFor());
    expect(shared).toHaveBeenCalledWith(PLAN_ID, expect.anything());
    expect(axios.get).toHaveBeenCalledWith('https://cdn.test/plan.pdf', expect.objectContaining({
      maxContentLength: expect.any(Number),
    }));
    expect(axios.get.mock.calls[0][1].maxContentLength).toBeGreaterThan(0);
    expect(src).toEqual(expect.objectContaining({ kind: 'plan', from: 'pdf' }));
    expect(src.text).toContain(PLAN_TEXT.trim());
  });

  test('the quiz has no PDF reader of its own', () => {
    expect(PlanDigest.planTextFromPdf).toBeUndefined();
  });

  test('a PDF that cannot be read falls back to the plan\'s topic', async () => {
    wirePlan({ id: PLAN_ID, topic: 'Comparing fractions', grade: '4', subject: 'maths', content: null, pdf_url: 'https://cdn.test/plan.pdf' });
    axios.get.mockRejectedValueOnce(new Error('404'));
    const src = await Gen.resolveLessonSource(quizFor());
    expect(src).toEqual(expect.objectContaining({ kind: 'plan', from: 'topic', text: null, title: 'Comparing fractions' }));
  });

  test('a plan row that is gone is nothing to write from', async () => {
    wirePlan(null);
    expect(await Gen.resolveLessonSource(quizFor())).toBeNull();
  });

  test('a quiz that names no plan is nothing to write from', async () => {
    wirePlan(null);
    expect(await Gen.resolveLessonSource(quizFor({ lesson_plan_id: null }))).toBeNull();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('a database error throws (the job is redelivered)', async () => {
    wirePlan(null, { message: 'timeout' });
    await expect(Gen.resolveLessonSource(quizFor())).rejects.toThrow(/timeout/);
  });
});

describe('topic', () => {
  test('the quiz\'s own topic, grade and subject — no source text, no database read', async () => {
    const src = await Gen.resolveLessonSource(quizFor({ quiz_source: 'topic', lesson_plan_id: null, topic: 'The water cycle', subject: 'science', grade: '5' }));
    expect(src).toEqual(expect.objectContaining({
      kind: 'topic', from: 'topic', text: null, title: 'The water cycle', subject: 'science', grade: '5',
    }));
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('a topic quiz with no topic is nothing to write from', async () => {
    expect(await Gen.resolveLessonSource(quizFor({ quiz_source: 'topic', topic: '  ' }))).toBeNull();
  });
});
