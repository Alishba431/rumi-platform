'use strict';
/**
 * ONE name for "a quiz born of a lesson this teacher gave (or asked for)".
 *
 * Before this module, `'transcript'` was written as a literal in the list
 * service and the report — places that each had to be found and changed by
 * hand for a second lesson source. `isLessonQuiz` is the single predicate they
 * all ask.
 *
 * The open-source sources: a coaching recording (`transcript`), a lesson plan
 * the bot generated (`lp_generated`), and a topic the teacher typed (`topic`).
 */

const {
  TRANSCRIPT, LP_GENERATED, TOPIC, LESSON_SOURCES, PLAN_SOURCES,
  isLessonQuiz, isPlanQuiz, isRecordedQuiz, failureCopyKey, handoffIntroKey, lessonSessionFor,
  lpRemakeable, digestFailureReason, failureReasonOf, SOURCE_UNUSABLE_CODE,
} = require('../../bot/shared/services/quiz/quiz-sources');
const { resolveUx } = require('../../bot/shared/config/ux-strings');

describe('quiz-sources', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });

  test('the constants are the values written into quizzes.quiz_source', () => {
    expect(TRANSCRIPT).toBe('transcript');
    expect(LP_GENERATED).toBe('lp_generated');
    expect(TOPIC).toBe('topic');
  });

  test('LESSON_SOURCES is exactly the three sources a teacher can make a quiz from', () => {
    expect(LESSON_SOURCES).toEqual(['transcript', 'lp_generated', 'topic']);
  });

  test('a PLAN quiz is one written from a lesson plan, never from a recording or a bare topic', () => {
    expect(PLAN_SOURCES).toEqual(['lp_generated']);
    expect(isPlanQuiz('lp_generated')).toBe(true);
    expect(isPlanQuiz('transcript')).toBe(false);
    expect(isPlanQuiz('topic')).toBe(false);
    expect(isPlanQuiz('video')).toBe(false);
    expect(isPlanQuiz(undefined)).toBe(false);
    expect(() => PLAN_SOURCES.push('video')).toThrow();
  });

  test('only a transcript quiz was heard: isRecordedQuiz', () => {
    expect(isRecordedQuiz('transcript')).toBe(true);
    expect(isRecordedQuiz('lp_generated')).toBe(false);
    expect(isRecordedQuiz('topic')).toBe(false);
  });

  test('the fork-only plan sources are gone', () => {
    const mod = require('../../bot/shared/services/quiz/quiz-sources');
    expect(mod.LP_V8).toBeUndefined();
    expect(mod.LP612).toBeUndefined();
    expect(mod.lp612SourceOn).toBeUndefined();
    expect(isLessonQuiz('lp_v8')).toBe(false);
    expect(isLessonQuiz('lp612')).toBe(false);
  });

  test('a plan quiz gets the lesson-plan copy, never the recording\'s', () => {
    expect(handoffIntroKey('lp_generated')).toBe('tqHandoffIntroLp');
    expect(failureCopyKey('source_missing', 'lp_generated')).toBe('tqFailedLpSource');
    expect(failureCopyKey('model_failed', 'lp_generated')).toBe('tqFailedLpModel');
    expect(failureCopyKey('something_new', 'lp_generated')).toBe('tqFailedLpAuthor');
  });

  test('a topic quiz has its own intro and failure copy — never "what you taught", never "your recording"', () => {
    expect(handoffIntroKey('topic')).toBe('tqHandoffIntroTopic');
    const intro = resolveUx('tqHandoffIntroTopic', { language: 'en', params: { lesson: 'Fractions', n: 8 } });
    expect(intro).not.toMatch(/you taught|you planned/i);
    for (const reason of ['model_failed', 'validator_failed', 'key_conflict', 'key_disagreement', 'source_unusable', 'odd']) {
      const key = failureCopyKey(reason, 'topic');
      expect(resolveUx(key, { language: 'en' })).not.toMatch(/recording|lesson plan/i);
    }
    expect(failureCopyKey('daily_cap', 'topic')).toBe('tqDailyCapTopic');
  });

  test('transcript copy is unchanged', () => {
    expect(handoffIntroKey('transcript')).toBe('tqHandoffIntro');
    expect(failureCopyKey('source_unusable', 'transcript')).toBe('tqCouldNotMake');
    expect(failureCopyKey('model_failed', 'transcript')).toBe('tqCouldNotMakeModel');
    expect(failureCopyKey('unheard_of', 'transcript')).toBe('tqCouldNotMakeModel');
  });

  test('a plan quiz that could not START says what can happen next from /quiz — never an afternoon-offer line', () => {
    const meta = { lessons: [{ lesson_plan_id: 'p1' }], remakes: 0 };
    expect(failureCopyKey('queue_failed', 'lp_generated', { meta })).toBe('lpQuizCouldNotStartRetry');
    expect(failureCopyKey('queue_failed', 'lp_generated', { meta: { remakes: 2, lessons: meta.lessons } }))
      .toBe('lpQuizCouldNotStartMenu');
    expect(failureCopyKey('queue_failed', 'lp_generated')).toBe('lpQuizCouldNotStartMenu');
  });

  test('lpRemakeable: only failures a second try can change, with the plan still named, capped', () => {
    const lessons = [{ lesson_plan_id: 'p1' }];
    expect(lpRemakeable({ error: 'model_failed', lessons })).toBe(true);
    expect(lpRemakeable({ error: 'queue_failed', lessons })).toBe(true);
    expect(lpRemakeable({ error: 'source_unusable', lessons })).toBe(false);
    expect(lpRemakeable({ error: 'source_missing', lessons })).toBe(false);
    expect(lpRemakeable({ error: 'model_failed' })).toBe(false);
    expect(lpRemakeable({ error: 'model_failed', lessons, remakes: 2 })).toBe(false);
  });

  test('digest failures: only the source-unusable throw is the plan\'s', () => {
    expect(digestFailureReason(Object.assign(new Error('x'), { code: SOURCE_UNUSABLE_CODE }))).toBe('source_unusable');
    expect(digestFailureReason(new Error('timeout'))).toBe('model_failed');
    expect(failureReasonOf({})).toBe('validator_failed');
    expect(failureReasonOf({ error: 'digest: carries no lesson to digest' })).toBe('source_unusable');
    expect(failureReasonOf({ error: 'key_conflict' })).toBe('key_conflict');
  });

  test('lessonSessionFor pins a bare lesson date to noon in SCHOOL_TIMEZONE', () => {
    process.env.SCHOOL_TIMEZONE = 'Africa/Nairobi';
    expect(lessonSessionFor({ meta: { lesson_date: '2026-03-04' } })).toEqual({ created_at: '2026-03-04T09:00:00.000Z' });
    process.env.SCHOOL_TIMEZONE = 'America/Lima';
    expect(lessonSessionFor({ meta: { lesson_date: '2026-03-04' } })).toEqual({ created_at: '2026-03-04T17:00:00.000Z' });
    expect(lessonSessionFor({ meta: {} })).toEqual({});
    expect(lessonSessionFor({ meta: { lesson_date: '2026-03-04T08:00:00Z' } })).toEqual({ created_at: '2026-03-04T08:00:00Z' });
  });

  test('isLessonQuiz answers for every source the column actually holds', () => {
    expect(isLessonQuiz('lp_generated')).toBe(true);
    expect(isLessonQuiz('topic')).toBe(true);
    expect(isLessonQuiz('transcript')).toBe(true);
    // The video lane and the classic parent quiz share this table and must not
    // be swept into /quiz or given a transcript digest.
    expect(isLessonQuiz('video')).toBe(false);
    expect(isLessonQuiz('lesson_plan')).toBe(false);
    expect(isLessonQuiz(null)).toBe(false);
    expect(isLessonQuiz('')).toBe(false);
  });

  test('LESSON_SOURCES cannot be mutated by a consumer that sorts or pushes it', () => {
    expect(() => LESSON_SOURCES.push('video')).toThrow();
  });
});
