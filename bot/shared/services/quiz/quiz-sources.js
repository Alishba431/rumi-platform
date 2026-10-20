'use strict';
/**
 * `quizzes.quiz_source` — the one place the values are named.
 *
 * The `quizzes` table is shared by several lanes: the classic parent quiz
 * (`lesson_plan`, the column's historical default), the video quiz (`video`),
 * and the LESSON quiz a teacher makes for their own class, written from one of
 * three sources:
 *
 *   transcript    a coaching recording of the lesson they taught;
 *   lp_generated  a lesson plan the bot generated for them (`lesson_plans`);
 *   topic         a topic they typed (`/quiz fractions`), with no source text.
 *
 * The three are THE SAME THING to a teacher: a quiz for a lesson. One list in
 * /quiz for every kind; the teacher never has to care where a quiz came from.
 * Everything downstream of authoring — the /quiz list, the class report's
 * objectives, the report_sent stamp — must therefore ask "is this a LESSON
 * quiz", not "is this a transcript quiz". Before this module that question was
 * a set of `'transcript'` string literals in several files, and a second lesson
 * source meant finding all of them by hand.
 */

const { noonOn } = require('../../config/school-clock');

/** A quiz written from a coaching recording's transcript. */
const TRANSCRIPT = 'transcript';

/**
 * A quiz written from a lesson plan the bot generated (`quizzes.lesson_plan_id`
 * → `lesson_plans`). Downstream it is a lesson-PLAN quiz: no recording, "What
 * you planned", the lesson-plan failure copy, "Make it again".
 */
const LP_GENERATED = 'lp_generated';

/**
 * A quiz on a topic the teacher typed. There is no source text at all: the
 * digest writes the objectives a lesson on that topic would have, so nothing
 * may say it was taught or planned.
 */
const TOPIC = 'topic';

/**
 * Frozen: every consumer reads it, several hand it straight to PostgREST's
 * `.in()`, and one `.sort()` in a caller would reorder it for everyone in the
 * same process.
 */
const LESSON_SOURCES = Object.freeze([TRANSCRIPT, LP_GENERATED, TOPIC]);

/**
 * The lesson quizzes written from a lesson PLAN rather than a recording. The
 * question every surface that asks "is this a plan quiz?" is really asking:
 * nobody heard this lesson, so nothing may say it was taught, and the quiz is
 * made from a written source that can be read again.
 */
const PLAN_SOURCES = Object.freeze([LP_GENERATED]);

/** @param {string|null|undefined} source `quizzes.quiz_source` */
function isPlanQuiz(source) {
  return PLAN_SOURCES.includes(source);
}

/**
 * Was this lesson HEARD? Only a transcript quiz was: it is the one source with a
 * coaching session, and the only one whose copy may say "what you taught".
 * @param {string|null|undefined} source `quizzes.quiz_source`
 */
function isRecordedQuiz(source) {
  return source === TRANSCRIPT;
}

/**
 * Is this quiz one of a teacher's own lessons (as opposed to a video quiz or a
 * classic parent quiz)?
 * @param {string|null|undefined} source `quizzes.quiz_source`
 * @returns {boolean}
 */
function isLessonQuiz(source) {
  return LESSON_SOURCES.includes(source);
}

/**
 * The only thing any consumer reads from a quiz's "session" is the lesson's
 * date. A plan or topic quiz has no coaching session: its date is
 * `meta.lesson_date`, the school day the lesson was planned (or asked) for,
 * printed where a transcript quiz prints the recording's date and sorted on in
 * /quiz.
 *
 * A bare `YYYY-MM-DD` is pinned to noon in the school's timezone
 * (SCHOOL_TIMEZONE, school-clock), so no reading of the offset can move it
 * across midnight onto the neighbouring day. Pure, and here rather than in the
 * hand-off, because several suites mock the hand-off service wholesale.
 *
 * @returns {{created_at?: string}}
 */
function lessonSessionFor(quiz) {
  const d = quiz && quiz.meta && quiz.meta.lesson_date;
  if (!d) return {};
  return { created_at: /^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? noonOn(String(d)) : d };
}

/**
 * WHICH failure sentence the teacher gets.
 *
 * `tqCouldNotMake` names "this lesson's recording" and "the transcript" — true
 * of a quiz written from a coaching recording, and a state that never existed
 * for a quiz written from a lesson plan or a topic. One shared fallback across
 * distinct failures also misdirects whoever tries to fix it, so the plan path
 * names the step that stopped. Pure and here, so the generate step (which sends
 * it) and /quiz (which repeats it on a failed row) read one table.
 *
 * @param {string} reason      the `transcript_quiz.failed` reason
 * @param {string} quizSource  `quizzes.quiz_source`
 * @param {{meta?: object}} [opts]  the FAILED row's meta: a start failure's line
 *   then says what can happen next (startFailureCopyKey)
 * @returns {string} a ux-strings key
 */
const LP_FAILURE_COPY = {
  source_missing: 'tqFailedLpSource',
  // The plan was found and carries no lesson to write from.
  source_unusable: 'tqFailedLpSourceUnusable',
  // The model gave nothing usable — empty, cut off or unparseable after its
  // retry, or the provider refused the call. Ours, not the lesson plan's.
  model_failed: 'tqFailedLpModel',
  validator_failed: 'tqFailedLpAuthor',
  // The key check found answers the lesson contradicts and could neither fix
  // nor drop enough of them: the questions were clear, their KEYS were wrong.
  key_conflict: 'tqFailedLpKeyConflict',
  // The blind solve disagreed with too many keys (a wrong answer, or two right
  // ones) to fix or drop and still send a quiz.
  key_disagreement: 'tqFailedLpKeyDisagreement',
  // The START failure — the quiz was never written. With the row's meta the
  // line is chosen by what can happen next (startFailureCopyKey); this is the
  // line when a caller has no meta to give.
  queue_failed: 'lpQuizCouldNotStartMenu',
  // The teacher reached today's quiz limit (quiz-daily-cap) — nothing was written.
  daily_cap: 'tqDailyCap',
};
/**
 * The transcript counterpart. `tqCouldNotMake` blames the recording ("the
 * transcript didn't carry enough"), so it is sent ONLY where that is the state:
 * a transcript too short to carry a quiz (source_unusable), checked in code
 * before any model call. Every other reason is ours and says so — the MODEL
 * gave nothing usable (model_failed); the questions we wrote never passed our
 * checks (validator_failed), or their keys contradicted the lesson
 * (key_conflict); the blind solve held the quiz back (key_disagreement). A
 * session that is gone says so (session_missing). A reason nobody has written
 * copy for is no evidence about the recording either, so it falls back to the
 * general "on my side" sentence.
 */
const TRANSCRIPT_FAILURE_COPY = {
  source_unusable: 'tqCouldNotMake',
  model_failed: 'tqCouldNotMakeModel',
  validator_failed: 'tqCouldNotMakeAuthor',
  key_conflict: 'tqCouldNotMakeAuthor',
  key_disagreement: 'tqFailedKeyDisagreement',
  // the coaching session it was to be written from is gone
  session_missing: 'tqCouldNotMakeSessionGone',
  // today's quiz limit (quiz-daily-cap) — nothing was written
  daily_cap: 'tqDailyCap',
};
/**
 * A topic quiz has neither a recording nor a plan to blame: every failure is
 * ours, and the way to try again is the same `/quiz <topic>` that asked for it.
 */
const TOPIC_FAILURE_COPY = {
  daily_cap: 'tqDailyCapTopic',
};
function failureCopyKey(reason, quizSource, { meta = null } = {}) {
  if (quizSource === TOPIC) return TOPIC_FAILURE_COPY[reason] || 'tqFailedTopic';
  if (!isPlanQuiz(quizSource)) return TRANSCRIPT_FAILURE_COPY[reason] || 'tqCouldNotMakeModel';
  if (meta && START_FAILURES.has(reason)) return startFailureCopyKey(reason, meta);
  // A plan quiz never falls back to the transcript copy: a reason nobody has
  // written copy for is still a plan failure, and "the questions did not come
  // out" is the honest general case of one.
  return LP_FAILURE_COPY[reason] || 'tqFailedLpAuthor';
}

/** The lesson-plan failures where the quiz was never STARTED: nothing was written. */
const START_FAILURES = new Set(['queue_failed']);

/**
 * WHICH line a start failure gets — by what can happen next, not the reason
 * alone. A plan quiz is only ever made from /quiz, so the teacher is always
 * sent back there:
 *
 *   - it can be made again (lpRemakeable on the failed row) → "pick this lesson
 *     to try again";
 *   - otherwise → "pick another lesson".
 *
 * @param {string} reason   'queue_failed'
 * @param {object} meta     the FAILED row's `quizzes.meta` (its error set)
 */
function startFailureCopyKey(reason, meta) {
  if (lpRemakeable({ ...meta, error: reason })) return 'lpQuizCouldNotStartRetry';
  return 'lpQuizCouldNotStartMenu';
}

/**
 * The `err.code` the plan digest throws with when the source it was handed
 * carries no lesson. It is the ONE digest failure that is the lesson plan's;
 * every other throw out of that step is the model's or the provider's.
 */
const SOURCE_UNUSABLE_CODE = 'SOURCE_UNUSABLE';

/**
 * WHY the digest step stopped, from what it threw.
 *
 * Without this, every throw would read as "the lesson plan could not be read" —
 * true only when the plan was empty. An empty, cut-off or unparseable reply
 * (after the one retry) or a refused call is ours, and says so.
 *
 * @param {Error} err what the digest threw
 * @returns {'source_unusable'|'model_failed'}
 */
function digestFailureReason(err) {
  return err && err.code === SOURCE_UNUSABLE_CODE ? 'source_unusable' : 'model_failed';
}

/**
 * The failure reason a failed quiz row carries, for a surface that repeats the
 * failure later (/quiz). `meta.error` is the reason itself; a row that carries
 * `digest: <message>` is read by that message — the unusable-plan throw has one
 * fixed text, anything else was the model. A failed row with no marker failed
 * validation (the one path that stores none).
 *
 * @param {object} meta `quizzes.meta`
 * @returns {string} a reason `failureCopyKey` understands
 */
function failureReasonOf(meta) {
  const error = String((meta && meta.error) || '');
  if (!error) return 'validator_failed';
  if (error.startsWith('digest')) {
    return /carries no lesson to digest/.test(error) ? 'source_unusable' : 'model_failed';
  }
  return error;
}

/**
 * Can a failed plan quiz be made again from /quiz?
 *
 * Only when trying again can come out differently. The model-side failures
 * can: authoring is not deterministic, and a provider fault is usually gone on
 * the next call. A plan that was missing or carried no lesson cannot — a remake
 * would fail the same way and tell the teacher the same thing a second time.
 * The row must still name the plan it is written from (`meta.lessons`), and
 * remakes are capped so a quiz that keeps failing cannot be retried without end.
 *
 * queue_failed: the job never reached the queue — a transient refusal, and the
 * row keeps its lessons (queueLpQuiz merges), so a remake can succeed.
 * daily_cap: today's quiz limit (quiz-daily-cap) — made again on another day.
 *
 * @param {object} meta `quizzes.meta` of a failed plan row
 * @returns {boolean}
 */
const LP_REMAKE_REASONS = new Set([
  'model_failed', 'validator_failed', 'key_conflict', 'key_disagreement', 'queue_failed', 'daily_cap',
]);
const MAX_LP_REMAKES = 2;
function lpRemakeable(meta) {
  const m = meta || {};
  const reason = failureReasonOf(m);
  if (!LP_REMAKE_REASONS.has(reason)) return false;
  if (!Array.isArray(m.lessons) || !m.lessons.length) return false;
  return (Number(m.remakes) || 0) < MAX_LP_REMAKES;
}

/** lpRemakeable for a loaded quiz row. */
function lpRemakeableQuiz(quiz) {
  return Boolean(quiz) && isPlanQuiz(quiz.quiz_source) && lpRemakeable(quiz.meta);
}

/**
 * WHICH caption rides the teacher's PDF.
 *
 * `tqHandoffIntro` says "what you taught" — true of a quiz written from a
 * recording of the class. A quiz written from a lesson PLAN knows only that a
 * plan was made, so its caption says what was planned, matching the sheet's own
 * "What you planned" heading; a topic quiz names neither.
 *
 * @param {string} quizSource `quizzes.quiz_source`
 * @returns {string} a ux-strings key
 */
function handoffIntroKey(quizSource) {
  if (quizSource === TOPIC) return 'tqHandoffIntroTopic';
  return isPlanQuiz(quizSource) ? 'tqHandoffIntroLp' : 'tqHandoffIntro';
}

module.exports = {
  TRANSCRIPT, LP_GENERATED, TOPIC, LESSON_SOURCES, PLAN_SOURCES,
  isLessonQuiz, isPlanQuiz, isRecordedQuiz, lessonSessionFor, failureCopyKey, handoffIntroKey,
  SOURCE_UNUSABLE_CODE, digestFailureReason, failureReasonOf, lpRemakeable, lpRemakeableQuiz,
};
