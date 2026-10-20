'use strict';
/**
 * Plan quiz — the KEY CHECK, between authoring and the hand-off.
 *
 * WHY THIS EXISTS. A singular/plural quiz written from a lesson plan once went
 * out with one item keyed to the lesson's own planted misconception: "what do
 * you do to make the plural of this word?" → "its form will not change". The
 * plan said the opposite three times — a vocabulary definition, the check that
 * plants exactly this mistake for the class to correct ("A friend says the
 * plural stays the same — are they right?"), and the homework answer. The author
 * is handed the misconception so it can build WRONG options from it, and once in
 * a couple of dozen items it made it the RIGHT one. The validator checks shape,
 * language, level and pictures; nothing compared a key with the lesson. A quiz
 * that teaches children the misconception is the worst thing this feature can
 * send.
 *
 * WHAT IT DOES. A plan quiz (lp_generated) is written from a written source, so
 * its keys can be checked against that source: ONE LLM call through the
 * pipeline's JSON client is shown the plan as written and asked, per item,
 * whether the KEYED option agrees with it, and returns
 * `{index, verdict: consistent|contradicts|unclear, quote}`. The prompt tells
 * the checker which statements in a plan are WRONG on purpose — the mistakes it
 * warns about and the claims it puts to the class to test.
 *
 * What the generate step does with a contradiction (re-author once through the
 * existing targeted rewrite, re-check, drop, or fail as `key_conflict`) lives
 * in `transcript-quiz-generate.service.js`, beside every other recovery step.
 *
 * TWO CONTRACTS ASSERTED IN CODE, not left to the prompt:
 *   - a reply with no `verdicts` array is a FAILED check (the caller fails open
 *     and says so at error), never "every key is fine";
 *   - a verdict outside the three values, or an item the reply skipped, is
 *     `unclear` — it neither blocks the quiz nor counts as a pass.
 *
 * A transcript quiz has no written source, and a topic quiz has no source at
 * all: neither is checked here (the blind solve still checks both).
 * Pure except for the one LLM call: no DB, no WhatsApp, no R2.
 */

const { completeJson } = require('./transcript-quiz-llm');
const { LANG_NAME } = require('./transcript-quiz-language');
const Multi = require('./transcript-quiz-multi');
const { planText, PLAN_TEXT_MAX } = require('./plan-quiz-digest.service');

/** One line of the lesson, at most this many code points (the long ones are teacher prose). */
const LINE_MAX = 280;
const VERDICTS = new Set(['consistent', 'contradicts', 'unclear']);
const LABEL = 'plan_quiz.key_check';

const cp = (s) => [...String(s)].length;
const arr = (v) => (Array.isArray(v) ? v : []);

/** A field as one trimmed line, cut to LINE_MAX code points. */
function line(v) {
  if (v == null || typeof v === 'object') return '';
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return cp(s) > LINE_MAX ? `${[...s].slice(0, LINE_MAX - 1).join('')}…` : s;
}

/**
 * The lesson as the checker reads it: the plan text, capped, under a heading
 * that says which of its statements are true and which are put up to be
 * corrected. '' when the source states nothing checkable (a topic, or a plan
 * with no text).
 *
 * @param {{kind:string, text?:string}} source  what the generate step resolved
 * @returns {string}
 */
function renderSourceBlock(source) {
  const text = planText(source).slice(0, PLAN_TEXT_MAX);
  if (!text) return '';
  return `THE LESSON PLAN, as the teacher has it. Its facts, definitions and worked answers are TRUE for this quiz. Two kinds of statement in it are WRONG on purpose: a mistake it says children make, and a claim it puts to the class to TEST and then corrects ("A friend says … — are they right?"). Where the plan's facts disagree with such a claim, the claim is the mistake.

${text}`;
}

/** The positions an item keys as correct: one for an ordinary question, a set for "select all". */
function keyedIndices(q) {
  if (Multi.isMultiQuestion(q)) return Multi.authoredCorrectIndices(q);
  const n = Number(q && q.correct_index);
  return Number.isInteger(n) ? [n] : [];
}

/** The keyed option(s) as text — what the checker judges and what the record shows. */
function keyedText(q) {
  const opts = arr(q && q.options);
  return keyedIndices(q).map((i) => String(opts[i] ?? '').trim()).filter(Boolean).join(' + ');
}

/**
 * THE CHECKER PROMPT. The lesson first, then the items, then the verdict rule.
 * Written in English; the lesson and the quiz stay in their own language and
 * the quote is asked for verbatim.
 */
/**
 * The picture a question is answered from, as one line of text.
 *
 * The checker was shown the stem, the options and the key — never the picture.
 * On a grade 1 counting lesson it then read
 * "how many butterflies?" over a picture of THREE butterflies, keyed 3, as
 * contradicting the lesson's own example of two, in 6 of 8 quizzes; the
 * rewrite that followed dropped the picture and two quizzes shipped short. A
 * count is spelled out ("3 × butterfly"; "0 × counter (an empty tray)"); any
 * other picture is its spec, shortened.
 */
const PICTURE_MAX = 240;
function pictureLine(figure) {
  if (!figure || typeof figure !== 'object') return '';
  const type = String(figure.type || 'figure');
  if (type === 'count_objects') {
    const rows = arr(figure.rows).length ? arr(figure.rows) : [{ picto: figure.picto, count: figure.count, label: figure.label }];
    const one = (r) => {
      const n = Number(r && r.count);
      const what = String((r && r.picto) || figure.picto || 'thing');
      const name = r && r.label ? ` «${String(r.label).trim()}»` : '';
      return `${Number.isFinite(n) ? n : '?'} × ${what}${n === 0 ? ' (an empty tray)' : ''}${name}${figure.group > 1 ? `, ringed in groups of ${Math.floor(Number(figure.group))}` : ''}`;
    };
    return `count_objects — ${rows.map(one).join('; ')}`;
  }
  const { type: _t, lang: _l, ...rest } = figure; // eslint-disable-line no-unused-vars
  const spec = JSON.stringify(rest);
  return `${type} — ${[...spec].length > PICTURE_MAX ? `${[...spec].slice(0, PICTURE_MAX).join('')}…` : spec}`;
}

function buildKeyCheckPrompt({ sourceBlock, questions, indices, language }) {
  const qs = arr(questions);
  const items = indices.map((i) => {
    const q = qs[i] || {};
    const opts = arr(q.options).map((o, k) => `[${k}] ${String(o ?? '').trim()}`).join(' | ');
    const keyed = keyedIndices(q).map((k) => `[${k}] ${String(arr(q.options)[k] ?? '').trim()}`).join('; ');
    const multi = Multi.isMultiQuestion(q) ? ' (all that apply)' : '';
    const picture = pictureLine(q.figure);
    return `q${i}: ${String(q.question || '').trim()}\n  options: ${opts}\n  marked correct${multi}: ${keyed || '(none)'}${picture ? `\n  picture the child answers from: ${picture}` : ''}`;
  }).join('\n\n');
  const anyPicture = indices.some((i) => pictureLine((qs[i] || {}).figure));

  return [
    `You are CHECKING THE ANSWER KEY of a short quiz for children, written from ONE lesson plan. For each question, decide whether the answer MARKED CORRECT agrees with what the lesson itself says. The lesson and the quiz are in ${LANG_NAME[language] || 'the lesson\'s own language'}.`,
    `THE LESSON\n\n${sourceBlock}`,
    `THE QUIZ — each question, its options, and the one marked correct\n\n${items}`,
    `For EACH question give one verdict:
- "contradicts": the marked answer disagrees with a fact or worked answer in the lesson, OR it says one of the lesson's mistakes — including a claim the lesson puts to the class to test and then corrects. Quote, word for word and in the lesson's own language, the ONE line of the lesson that shows it.
- "consistent": the lesson supports the marked answer.
- "unclear": the lesson says nothing that decides this question either way.
Judge ONLY the marked answer against the LESSON. Do not re-solve the question from your own knowledge, and do not judge wording, level, style, or whether another option could also be defended. Say "contradicts" only when you can quote the line.${anyPicture ? `
A question with a PICTURE is answered by reading that picture: the quiz draws its own example. When the marked answer is what the picture shows — the number of things drawn, the shaded part, the time on the clock — it is "consistent", even if the lesson's own example used a different number. Say "contradicts" for a picture question only when the marked answer states one of the lesson's mistakes.` : ''}`,
    `Return ONLY this JSON object, one entry per question above, "index" being the number after its q:
{ "verdicts": [ { "index": ${indices[0] ?? 0}, "verdict": "consistent|contradicts|unclear", "quote": "" } ] }`,
  ].join('\n\n');
}

/** Letters, digits and marks only — so a quote matches the lesson through punctuation, spacing and diacritics. */
function squash(s) {
  return String(s || '').normalize('NFC').toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * The reply, held to its contract. Throws when there is no `verdicts` array, or
 * when it answers none of the requested indices (`err.code = 'NO_ANSWERS'`) —
 * the caller treats that as a failed check, never as "all consistent". One
 * verdict per REQUESTED index, in order: a verdict outside the three values is
 * `unclear`, and so is an index the reply skipped (`missing: true`). A
 * `contradicts` carries whether its quote is actually in the lesson
 * (`grounded`), so a model that invents its evidence shows up in the telemetry.
 *
 * @returns {{index:number, verdict:string, quote:string, grounded?:boolean, missing?:boolean}[]}
 */
function parseVerdicts(json, indices, sourceBlock) {
  if (!json || !Array.isArray(json.verdicts)) throw new Error(`${LABEL}: the reply carries no "verdicts" array`);
  const byIndex = new Map();
  json.verdicts.forEach((v) => {
    const i = Number(v && v.index);
    if (!Number.isInteger(i) || !indices.includes(i) || byIndex.has(i)) return;
    byIndex.set(i, v);
  });
  // Not one requested item answered (`{"verdicts": []}`, or every index out of
  // range): a failed check, never "all unclear".
  if (indices.length && !indices.some((i) => byIndex.has(i))) {
    const err = new Error(`${LABEL}: the reply has no usable verdict for any of the ${indices.length} questions`);
    err.code = 'NO_ANSWERS';
    throw err;
  }
  const haystack = squash(sourceBlock);
  return indices.map((index) => {
    const v = byIndex.get(index);
    if (!v) return { index, verdict: 'unclear', quote: '', missing: true };
    const said = String(v.verdict || '').trim().toLowerCase();
    const verdict = VERDICTS.has(said) ? said : 'unclear';
    const quote = typeof v.quote === 'string' ? v.quote.trim() : '';
    const out = { index, verdict, quote };
    if (verdict === 'contradicts') out.grounded = Boolean(quote) && haystack.includes(squash(quote));
    return out;
  });
}

/**
 * The complaint a contradicting item carries into the targeted rewrite — the
 * same `q<i>: CODE — …` shape every validator complaint has, so the existing
 * rewrite takes it as one question's text to rewrite.
 */
function conflictComplaint(verdict, q) {
  const keyed = keyedText(q) || '(none)';
  const quote = line(verdict && verdict.quote) || '(no line quoted)';
  return `q${verdict.index}: KEY_CONFLICT — the answer marked correct ("${keyed}") contradicts the lesson, which says: "${quote}". Mark as correct the answer the lesson teaches; the lesson's mistake may only ever be a WRONG option.`;
}

/**
 * ONE call. Checks every item, or only `indices` (the re-check after a rewrite).
 * Throws on an LLM failure or an unusable reply — the caller decides what a
 * failed check means (it fails open). Returns `skipped: 'no_source'` with no
 * call at all when the lesson states nothing to check against.
 *
 * @returns {Promise<{verdicts:object[], model:string|null, costUsd:number,
 *   latencyMs:number, skipped?:string, sourceLines?:object}>}
 */
async function checkKeys({
  questions, source, language, indices = null, quizId = null,   // eslint-disable-line no-unused-vars
}) {
  const qs = arr(questions);
  const idx = Array.isArray(indices) ? indices.filter((i) => Number.isInteger(i) && qs[i]) : qs.map((_, i) => i);
  const sourceBlock = renderSourceBlock(source);
  const sourceChars = planText(source).length;
  if (!sourceBlock || !idx.length) {
    return { verdicts: [], model: null, costUsd: 0, latencyMs: 0, skipped: 'no_source', sourceChars };
  }
  const prompt = buildKeyCheckPrompt({ sourceBlock, questions: qs, indices: idx, language });
  // 8000 like the targeted rewrite: a reasoning model spends its budget
  // thinking, and a truncated reply here is a failed check, not a verdict.
  const {
    json, model, costUsd, latencyMs,
  } = await completeJson({ prompt, maxTokens: 8000, label: LABEL });
  return {
    verdicts: parseVerdicts(json, idx, sourceBlock),
    model,
    costUsd: Number(costUsd) || 0,
    latencyMs,
    sourceChars,
    promptChars: cp(prompt),
  };
}

module.exports = {
  renderSourceBlock, buildKeyCheckPrompt, parseVerdicts, conflictComplaint, checkKeys,
  keyedIndices, keyedText, LABEL, LINE_MAX,
};
