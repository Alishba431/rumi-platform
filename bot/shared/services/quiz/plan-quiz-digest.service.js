'use strict';
/**
 * Plan and topic quiz — pass 1, the DIGEST, read from a LESSON PLAN or written
 * from a TOPIC.
 *
 * The transcript digest (`transcript-quiz-digest.service.js`) reads what a
 * teacher actually said in class. This one serves the two lesson-quiz sources
 * that have no recording:
 *
 *   lp_generated  the text of a lesson plan the bot made for the teacher
 *                 (`lesson_plans`, resolved by the generate step);
 *   topic         nothing but the topic the teacher typed (`/quiz fractions`)
 *                 — the digest writes the objectives a lesson on that topic,
 *                 at that grade, in that subject, would have.
 *
 * It returns the SAME SHAPE as the transcript digest, through the same
 * `normaliseDigest()`. That is not tidiness: the author prompt, the validator,
 * the teacher PDF, the hand-off and the class report's objectives all read that
 * shape and nothing else, so a second shape would mean a second copy of every
 * one of them.
 *
 * WHAT A PLAN DIGEST MUST NOT FORWARD. A plan's own check questions and their
 * answers are the questions this class has already been asked and answered: a
 * quiz that reuses them measures who remembers the last five minutes. The
 * prompt says so (PRACTICE IS SHAPE), and the author is told the same.
 *
 * WHAT A TOPIC DIGEST MUST NEVER CLAIM. Nobody taught or planned a topic quiz's
 * lesson as far as the bot knows, so nothing it writes may say "the lesson
 * used", "the class saw" or quote evidence that does not exist: its evidence
 * quotes stay empty, its examples are ordinary examples for the grade, and its
 * confidence says how sure it is of the topic, nothing more.
 */

const { completeJson } = require('./transcript-quiz-llm');
const { normaliseDigest, fenceUntrusted, dataOnlyLine } = require('./transcript-quiz-digest.service');
const { peopleDigestRule } = require('./transcript-quiz-people');
const { canonicalSubject, LANG_NAME, statementFieldsRule } = require('./transcript-quiz-language');
const { logEvent } = require('../../utils/structured-logger');
const { LP_GENERATED, TOPIC, SOURCE_UNUSABLE_CODE } = require('./quiz-sources');

/** The digest reads at most this much of a plan; a runaway one is cut, not refused. */
const PLAN_TEXT_MAX = 20000;
/** The author reads at most this much of it, beside the digest. */
const EXCERPT_MAX = 12000;
/** Below this a "plan" is a title and a heading — nothing to write eight questions from. */
const MIN_PLAN_CHARS = 200;
/** A typed topic longer than this is a message, not a topic. */
const TOPIC_MAX = 200;

const clean = (s) => String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/**
 * A source is what the generate step resolved (resolveLessonSource):
 *   { kind: 'plan',  text, title, from }  a lesson plan; `text` is null when the
 *                                         plan's text could not be had (`from: 'topic'`)
 *   { kind: 'topic', text: null, title }  a typed topic
 */

/** The plan text a source carries, or ''. */
function planText(source) {
  return source && source.kind === 'plan' ? clean(source.text) : '';
}

/** The topic a source names: the typed topic, or a plan's own title. */
function topicOf(source) {
  if (!source) return '';
  return clean(source.title || source.topic).replace(/\s+/g, ' ').slice(0, TOPIC_MAX);
}

/**
 * How this source is digested: 'plan' when there is a plan's worth of text to
 * read, 'topic' when there is only a name to write from (a typed topic, or a
 * plan whose text could not be had), null when there is nothing at all.
 */
function digestMode(source) {
  if (!source) return null;
  if (planText(source).length >= MIN_PLAN_CHARS) return 'plan';
  return topicOf(source) ? 'topic' : null;
}

/** Is there enough here to write anything from? */
function isUsable(source) {
  return digestMode(source) !== null;
}

/**
 * The block the AUTHOR pass reads where a transcript quiz reads the passages
 * around each SLO's evidence: the plan itself, capped, or one line naming the
 * topic. '' when there is nothing.
 * @returns {string}
 */
function lessonExcerpts(source) {
  const mode = digestMode(source);
  if (!mode) return '';
  if (mode === 'topic') {
    return `THE TOPIC THE TEACHER NAMED: ${topicOf(source)}\n(There is no lesson text and no recording behind this quiz.)`;
  }
  const text = planText(source);
  const title = topicOf(source);
  const body = text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX)}\n[… the rest of the plan is not shown]` : text;
  return `${title ? `LESSON: ${title}\n` : ''}${body}`;
}

const JSON_SHAPE = `Return ONLY this JSON object:
{
  "topic": "", "topic_as_taught": "", "subject": "urdu|english|maths|science|sst|genk|islamiat|other", "subject_conflict": false,
  "grade_band": "", "language_of_instruction": "", "confidence": 0.0,
  "slos": [ { "id": "S1", "statement": "", "statement_en": "", "evidence_quote": "", "taught_level": "recall|understand|apply" } ],
  "key_terms": [ { "term": "", "as_spoken": "" } ],
  "examples_used": [ "" ],
  "misconceptions_surfaced": [ "" ],
  "people": [ { "latin": "", "ur": "" } ]
}`;

const SHARED_RULES = (language) => `- "subject" must be one of: urdu | english | maths | science | sst | genk | islamiat | other.
- "grade_band": "1-2" | "3-5" | "6-8" | "9-10".
- ${statementFieldsRule(language)}
- ENGLISH TECHNICAL TERMS ARE WRITTEN IN ENGLISH LETTERS in a statement in another language, never transliterated into its script: write "column method", "numerator", "photosynthesis".
- "topic" = a clean short label in English.
- THE TEACHER HAS NO GENDER. Never write "she", "he", "her", "his" or "him" about the teacher in any field — say "the teacher". In a gendered language use no gendered word for the teacher and no gendered verb form about the teacher. Never guess a child's gender either.
- Religious content: write sacred names and honorifics exactly, in the script the subject is taught in — never transliterated, never dropped.`;

function buildPlanDigestPrompt({ source, language, grade, subject }) {
  const text = planText(source).slice(0, PLAN_TEXT_MAX);
  return `You are reading the LESSON PLAN a teacher prepared for their class. Your job is to write a faithful DIGEST of what that lesson sets out to teach — nothing more, nothing less. This digest will be used to write a short quiz for the children of that class, so anything you invent will be tested on children who never met it.

${dataOnlyLine('lesson_plan')} ${dataOnlyLine('teacher_topic')}

WHAT YOU KNOW ABOUT THIS LESSON:
- grade (from the teacher's request, trust it over your own reading): ${grade || 'unknown'}
- subject (from the teacher's request): ${subject || 'unknown'}
- the topic the teacher asked the plan for: ${topicOf(source) ? fenceUntrusted('teacher_topic', topicOf(source), { inline: true }) : 'unknown'}
- the quiz will be written in: ${LANG_NAME[language] || 'the lesson’s own language'}

RULES
- Use ONLY the lesson plan below. If there is too little of it to say what the lesson teaches, say so via confidence < 0.5.
- "slos" = the specific learning objectives THIS lesson sets out to teach, 2-6 of them, each with a short verbatim quote from the plan as its evidence and the level the plan pitches it at: "recall" (name/repeat/identify), "understand" (explain/compare/give own example), "apply" (solve/use in a new case). No objective may be tagged above the level the plan's own activities reach.
- "topic_as_taught" = the topic label as the plan names it.
- "key_terms": up to 8 terms the lesson teaches; "term" is the canonical form, "as_spoken" is how the plan words it for the class.
- "examples_used": the concrete examples, numbers, objects and stories THIS plan uses — the worked example and the practice work. These are the material of the quiz: a child should recognise their own lesson in it.
- "misconceptions_surfaced": the mistakes this plan expects children to make, and why. This is what the quiz's wrong options are built from, so write each as the mistaken THINKING, not as an instruction to the teacher.
${peopleDigestRule('the plan')}
- PRACTICE IS SHAPE, NOT QUESTIONS. The plan's own practice, check and exit questions have already been put to this class. Never copy one of them, or its numbers, into anything you write — a child who did that exact sum in the period is being asked to remember an answer, not to use the idea. Write about the same skill with different material.
${SHARED_RULES(language)}

${JSON_SHAPE}

THE LESSON PLAN:
${fenceUntrusted('lesson_plan', text)}`;
}

function buildTopicDigestPrompt({ source, language, grade, subject }) {
  return `A teacher asked for a short quiz for their class on ONE topic. There is NO lesson plan and NO recording of the lesson — only the topic below. Your job is to write the DIGEST a well-made lesson on this topic, for this grade and subject, would have: what such a lesson sets out to teach, its key terms, ordinary examples for that grade, and the mistakes children usually make with it. A quiz for the children is written from this digest.

${dataOnlyLine('teacher_topic')}

WHAT YOU KNOW:
- the topic, as the teacher typed it: ${fenceUntrusted('teacher_topic', topicOf(source), { inline: true })}
- grade (from the teacher's profile; may be unknown): ${grade || 'unknown — pitch it at the grade the topic is usually taught in'}
- subject (from the teacher's profile; may be unknown): ${subject || 'unknown — infer it from the topic'}
- the quiz will be written in: ${LANG_NAME[language] || 'English'}

RULES
- "slos" = 2-5 learning objectives a lesson on this topic would set out to teach, at this grade. "evidence_quote" is ALWAYS "" — there is no lesson to quote, and nothing you write may claim one happened. "taught_level": "recall", "understand" or "apply", the level a lesson for this grade would reach.
- "topic_as_taught" = the topic as the teacher typed it, tidied (spelling and case only).
- "key_terms": up to 8 terms the topic rests on, "as_spoken" the same as "term".
- "examples_used": ordinary examples a teacher of this grade would use for it — everyday objects, small numbers, familiar situations. Never a named textbook, curriculum or exam.
- "misconceptions_surfaced": the mistakes children of this age usually make with this topic, written as the mistaken THINKING. These seed the quiz's wrong options.
- "confidence": how sure you are what the topic means. Below 0.5 when it is not a school topic, or too vague to write objectives for.
- "subject_conflict": true when the topic does not belong to the subject above.
- "people": [] unless the topic is ABOUT a person (a historical figure, an author), then that person once, as { "latin": "", "ur": "" }.
${SHARED_RULES(language)}

${JSON_SHAPE}`;
}

/**
 * Run the digest for ONE plan or topic.
 *
 * @param {object}  args
 * @param {{kind:'plan'|'topic', text:string|null, title:string, from?:string}} args.source
 *   what the generate step resolved (resolveLessonSource)
 * @param {string}  args.language     the quiz language already settled on the row
 * @param {string|number} [args.grade]   the grade on the quiz row (authoritative)
 * @param {string}  [args.subject]    the subject on the quiz row
 * @param {string}  [args.quizSource] `quizzes.quiz_source`, for the telemetry
 * @returns {Promise<{digest:object, grade:string|null, gradeSource:string, lpHint:null,
 *                    model:string, costUsd:number|null, latencyMs:number}>}
 *   The same envelope `transcript-quiz-digest.service.run()` returns, so the
 *   generate step spreads one or the other without a second branch.
 */
async function run({
  source, language = null, grade = null, subject = null, quizSource = null,
}) {
  if (!isUsable(source)) {
    // Loudly, and before the LLM call: an empty digest authored into a quiz is
    // eight questions about nothing, and the teacher would be the one to find out.
    // The code is what tells this — the one failure that IS the source's — apart
    // from every failure of the model after it (quiz-sources
    // `digestFailureReason`), so the teacher is told which one happened.
    const err = new Error('plan digest: the source carries no lesson to digest');
    err.code = SOURCE_UNUSABLE_CODE;
    throw err;
  }
  const isTopic = digestMode(source) === 'topic';
  const prompt = isTopic
    ? buildTopicDigestPrompt({ source, language, grade, subject })
    : buildPlanDigestPrompt({ source, language, grade, subject });
  const {
    json, model, costUsd, latencyMs,
  } = await completeJson({ prompt, label: isTopic ? 'topic_quiz.digest' : 'plan_quiz.digest' });

  const digest = normaliseDigest(json, { storedSubject: subject });
  if (isTopic) {
    // Asserted in code, not left to the prompt: a topic digest quotes nothing,
    // because there is nothing it could have quoted.
    digest.slos = digest.slos.map((s) => ({ ...s, evidence_quote: '' }));
    digest.source_kind = 'topic';
  } else {
    digest.source_kind = 'plan';
  }

  // The row's subject, when it has one. The model's reading is kept for the
  // record (`subject_read`, `subject_conflict`) and never used over it.
  const given = canonicalSubject(subject);
  if (given !== 'other') {
    if (digest.subject && digest.subject !== 'other' && digest.subject !== given) {
      digest.subject_read = digest.subject;
      digest.subject_conflict = true;
    }
    digest.subject = given;
  } else if (!digest.subject) {
    digest.subject = 'other';
  }
  // A topic quiz is called what the teacher typed; the model only tidies it.
  if (isTopic && !digest.topic_as_taught) digest.topic_as_taught = topicOf(source);

  const rowGrade = grade != null && String(grade).trim() ? String(grade).trim() : null;
  const resolvedGrade = rowGrade || digest.grade_band || null;
  const gradeSource = rowGrade ? 'quiz' : (digest.grade_band ? 'digest' : 'none');

  logEvent('transcript_quiz.digest_done', {
    quiz_source: quizSource || (isTopic ? TOPIC : LP_GENERATED),
    sourceKind: digest.source_kind,
    sourceFrom: source.from || null,
    model,
    costUsd,
    latencyMs,
    subject: digest.subject,
    // what the model read the content as, when it disagreed with the row (kept, never used)
    subjectRead: digest.subject_read || null,
    slos: digest.slos.length,
    confidence: digest.confidence,
    grade: resolvedGrade,
    gradeSource,
  });

  return {
    digest,
    grade: resolvedGrade,
    gradeSource,
    lpHint: null,
    model,
    costUsd,
    latencyMs,
  };
}

module.exports = {
  run, lessonExcerpts, buildPlanDigestPrompt, buildTopicDigestPrompt, isUsable, digestMode, planText, topicOf,
  PLAN_TEXT_MAX, EXCERPT_MAX, MIN_PLAN_CHARS,
};
