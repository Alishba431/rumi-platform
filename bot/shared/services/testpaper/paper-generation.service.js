'use strict';
/**
 * Source material in, a test paper's question tree out.
 *
 * The source is whatever the teacher's paper is built from — a textbook
 * chapter loaded into this deployment, one of the teacher's own lesson plans,
 * or a chapter they uploaded — already flattened to text by
 * testpaper-sources.service. Almost all of the paper's quality lives in the
 * prompt pack (testpaper-prompts.json); this file assembles it, makes the one
 * model call, and makes the answer true where the model was careless: the seen
 * cap, the marks budget, MCQ answers, stray image keys.
 *
 * The ordering of the prompt is load-bearing — role, subject guidance, output
 * format, answer-key rule, final checklist, and safety LAST so nothing after it
 * can soften it — hence the tests on ordering rather than only on output.
 *
 * The one rule that is not about formatting: a paper is never invented. Text
 * too short to hold a chapter is refused before the model is asked, and the
 * prompt tells the model to answer `insufficient_source` rather than fill a
 * thin source with questions about things it does not teach. Both surface as
 * INSUFFICIENT_SOURCE, which the teacher sees as an honest message.
 */

const { getClient } = require('../llm-client');
const { resolveModelForJob } = require('../../config/model-registry');
const { getEnglishName } = require('../../config/supported-languages');
const { logToFile } = require('../../utils/logger');
const { extractJsonFromResponse } = require('./paper-json.util');
const { familyOf } = require('./question-types');

const PROMPTS = require('./testpaper-prompts.json');

/**
 * Below this many characters of source text there is no chapter to test — a
 * lesson plan saved with only its topic, an empty upload, a scanned page the
 * text extractor could not read. A paper from that would be the model's
 * general knowledge wearing the teacher's chapter title.
 */
const MIN_SOURCE_CHARS = 200;

/**
 * The most source text one paper is built from. Far above any chapter or unit
 * (a 30-page chapter is ~60k characters), so in practice nothing is cut; it
 * exists so an uploaded whole book cannot become a single enormous request.
 */
const MAX_SOURCE_CHARS = 120000;

function fail(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/**
 * The system prompt: role, the subject family's guidance, output format, the
 * answer-key rule, the final checklist, then safety. Answers are always asked
 * for — the paper never prints them, and the separate key needs every one.
 */
function buildSystemPrompt({ subject }) {
  const family = familyOf(subject);
  return [
    PROMPTS['tp.system'],
    PROMPTS[`tp.subject.${family}`] || PROMPTS['tp.subject.general'],
    PROMPTS['tp.format.exam'],
    PROMPTS['tp.answer_key'],
    PROMPTS['tp.task.final'],
    PROMPTS['tp.safety'],
  ].join('');
}

/** "Urdu", "Swahili", … — the name a model reads best, from a language code. */
function languageName(language) {
  const code = String(language || 'en').trim();
  const name = getEnglishName(code);
  return name && name !== code ? name : (code === 'en' || !code ? 'English' : code);
}

/**
 * The language line. English papers get none (the pack is written in English);
 * every other paper is told to be written in its language entirely, because a
 * model given English instructions otherwise drifts back to English headings.
 */
function languageRule(language) {
  const name = languageName(language);
  if (name === 'English') return '';
  return `• Write the WHOLE paper in ${name} — the title, every instruction, question, option and answer. `
    + `Keep the JSON keys and the question-type keys (e.g. "MCQs") exactly as specified in English. `
    + `Label options the way ${name} papers usually do.\n`;
}

function _count(t) {
  return Math.max(1, parseInt(t.count, 10) || 1);
}

/** `target` questions spread over the same types, the remainder to the earlier
 * ones, so a paper opens with its fullest section (mirrors QuestionTypes.withCounts). */
function _rescale(types, target) {
  if (!types.length || target <= 0) return [];
  const base = Math.floor(target / types.length);
  let spare = target - base * types.length;
  return types.map((t) => {
    const count = base + (spare > 0 ? 1 : 0);
    if (spare > 0) spare -= 1;
    return { ...t, count: Math.max(1, count) };
  });
}

/**
 * The number a teacher asks for is the size of the paper — all of it. (Sizing
 * only the unseen half, and then adding every exercise in the chapter on top for
 * "a mix of both", is how a request for 20 comes back as 64.)
 *
 *   unseen  → all `total` are new questions, types as given.
 *   both    → at most half are lifted from the book (seenTarget = floor(total/2)),
 *             the rest are new, and the types are re-spread over that rest.
 *   seen    → exactly `total` lifted from the book, no new ones.
 *
 * With no explicit count, the total is the sum of the per-type counts.
 */
function planCounts({ contentSource = 'unseen', questionCount, questionTypes = [], seenCount = null }) {
  const typed = questionTypes.reduce((s, t) => s + _count(t), 0);
  const total = Number(questionCount) > 0 ? Number(questionCount) : typed;
  if (contentSource === 'seen') {
    return { total, seenTarget: total, unseenTarget: 0, questionTypes: [] };
  }
  // Both, with an explicit Seen number. The Unseen counts are the teacher's —
  // used as given, never re-spread — and the paper is the two added together.
  // The Seen number travels explicitly rather than being inferred from
  // total − types, because that inference cannot tell a deliberate mix from
  // one whose types happen to sum short of its total.
  const seen = Number(seenCount);
  if (contentSource === 'both' && Number.isInteger(seen) && seen > 0) {
    return { total: seen + typed, seenTarget: seen, unseenTarget: typed, questionTypes };
  }
  // Both, with no Seen count: half and half.
  if (contentSource === 'both') {
    const seenTarget = Math.floor(total / 2);
    const unseenTarget = total - seenTarget;
    return { total, seenTarget, unseenTarget, questionTypes: _rescale(questionTypes, unseenTarget) };
  }
  return { total, seenTarget: 0, unseenTarget: total, questionTypes };
}

/**
 * What to make, in the words the prompts expect. Objective and subjective are
 * listed separately because that is the shape of the tree the model returns.
 */
/**
 * What to make, in the words the prompt pack expects. Objective and subjective
 * are listed separately because that is the shape of the tree the model returns.
 */
function buildUserPrompt({ grade, subject, language = 'en', sourceText, sourceLabel,
                           contentSource = 'unseen', questionCount, questionTypes = [], totalMarks = null,
                           seenCount = null }) {
  const plan = planCounts({ contentSource, questionCount, questionTypes, seenCount });
  const objective = plan.questionTypes.filter((q) => q.category === 'objective');
  const subjective = plan.questionTypes.filter((q) => q.category !== 'objective');
  const describe = (list) => list.map((q) => `${_count(q)} ${q.id}`).join(', ');

  const items = [];
  if (contentSource === 'unseen' || contentSource === 'both') {
    if (objective.length) items.push(`Unseen Objective questions — ${describe(objective)}`);
    if (subjective.length) items.push(`Unseen Subjective questions — ${describe(subjective)}`);
  }
  if (contentSource === 'both') {
    items.push(`Seen questions — at most ${plan.seenTarget}, taken directly from the source's own `
      + 'exercises (if it holds fewer usable exercise questions, add unseen questions instead so the '
      + 'total below is still met)');
  } else if (contentSource === 'seen') {
    items.push(`Seen questions — exactly ${plan.seenTarget}, taken directly from the source's own `
      + 'exercises (objective and subjective)');
  }

  // Only when one was set. An always-present line about marks would change
  // every paper, including the ones nobody budgeted.
  const budget = Number(totalMarks) > 0 ? Number(totalMarks) : null;
  const hasGrade = grade !== null && grade !== undefined && String(grade).trim() !== '';
  const text = String(sourceText || '').slice(0, MAX_SOURCE_CHARS);

  return `**Grade:** ${hasGrade ? grade : 'not stated — judge the level from the source material'}
**Subject:** ${subject || 'not stated — infer it from the source material'}
**Source:** ${sourceLabel || 'teacher-provided material'}
**Paper language:** ${languageName(language)}

**Source Material:**
\`\`\`
${text}
\`\`\`

**GENERATE THE FOLLOWING:**
${items.map((i) => `• ${i}`).join('\n')}
• In total the paper must have exactly ${plan.total} questions — no more${budget ? `
• The whole paper must be worth ${budget} marks in total — allocate the marks across the questions so they add up to ${budget} and NEVER exceed it` : ''}
${languageRule(language)}${subject ? '' : '• The subject was not stated: add a top-level "subject" key naming it in English (e.g. "Science", "Mathematics")\n'}
**IMPORTANT NOTES:**
• Every question must test something this source material actually teaches
• For SEEN questions: take questions exactly as they appear in the source
• For UNSEEN questions: create new questions on the concepts in the source
• The paper carries no pictures. Do NOT include any question that needs a picture, illustration or diagram to answer; rewrite it so it can be answered from text alone, or leave it out
• Include proper marks for each question
• Keep the language and difficulty right for the grade
• Where a question type has an exact count (e.g. "5 MCQs"), generate EXACTLY that many — no more, no less
• Return output in the JSON format specified in the system prompt

---
`;
}

/**
 * Keep the first `seenTarget` seen questions in tree order and drop the rest.
 * The prompt asks for the cap; this makes it true when the model ignores it.
 * Returns how many were removed.
 */
function trimSeen(examJson, seenTarget) {
  const branch = examJson?.seen;
  if (!branch || typeof branch !== 'object') return 0;
  let kept = 0;
  let removed = 0;
  const take = (list) => {
    const out = [];
    for (const q of list) {
      if (kept < seenTarget) { out.push(q); kept += 1; } else removed += 1;
    }
    return out;
  };
  for (const category of Object.values(branch)) {
    if (!category || typeof category !== 'object') continue;
    for (const [type, entry] of Object.entries(category)) {
      if (Array.isArray(entry)) category[type] = take(entry);
      else if (entry && typeof entry === 'object') {
        for (const [sub, list] of Object.entries(entry)) {
          if (Array.isArray(list)) entry[sub] = take(list);
        }
      }
    }
  }
  return removed;
}

/**
 * Walk every question in the tree. The shape has two shrugs in it: a subjective
 * entry is either a list of questions or a map of sub-type to list (Long
 * Question), and either section may be absent. Both are handled here so no
 * caller has to know.
 */
function _walkQuestions(examJson, visit) {
  for (const section of ['seen', 'unseen']) {
    const branch = examJson?.[section];
    if (!branch || typeof branch !== 'object') continue;
    for (const category of Object.values(branch)) {
      if (!category || typeof category !== 'object') continue;
      for (const entry of Object.values(category)) {
        if (Array.isArray(entry)) {
          entry.forEach((q) => q && typeof q === 'object' && visit(q));
        } else if (entry && typeof entry === 'object') {
          for (const sub of Object.values(entry)) {
            if (Array.isArray(sub)) sub.forEach((q) => q && typeof q === 'object' && visit(q));
          }
        }
      }
    }
  }
}

function countQuestions(examJson) {
  let n = 0;
  _walkQuestions(examJson, () => { n += 1; });
  return n;
}

/**
 * What one question is worth, measured the way the paper prints it.
 *
 * A composite question (a Long Question with parts) carries marks on its
 * sub-questions, and the renderer's totalMarks() prefers their sum over the
 * parent's own number. Enforcement has to agree with the renderer, or we trim
 * against one total and print another.
 */
function _marksOf(q) {
  if (Array.isArray(q?.questions)) {
    const subs = q.questions.reduce((s, sub) => s + (Number(sub?.marks) || 0), 0);
    if (subs > 0) return subs;
  }
  return Number(q?.marks) || 0;
}

/** What the whole tree is worth. Same rule, every question. */
function totalMarksOf(examJson) {
  let sum = 0;
  _walkQuestions(examJson, (q) => { sum += _marksOf(q); });
  return sum;
}

/**
 * Keep the paper inside the marks budget the teacher asked for.
 *
 * The prompt states the budget; this makes it true when the model ignores it —
 * the same job trimSeen does for the seen cap, and done the same way: walk in
 * tree order, keep while there is room, drop the rest. Returns how many were
 * removed.
 *
 * Two decisions worth stating, because both are load-bearing:
 *
 *   * We DROP whole questions rather than rescale marks. Marks are pedagogical:
 *     a 5-mark essay rewritten to 2 marks misrepresents the work it demands and
 *     silently edits a mark scheme the teacher will grade against. Every question that
 *     survives is exactly as the model wrote it.
 *
 *   * Dropping can leave fewer questions than were asked for, and that is the
 *     intended trade. The marks total is the constraint imposed from outside —
 *     the exam type, the school — while the question count is the teacher's own
 *     preference, and is already soft downstream (trimSeen drops, and an edit can
 *     add questions back). Overshooting marks is the failure that cannot be fixed
 *     after the fact; a question short, the teacher can see and ask for more.
 *
 * A budget of null/0 means none was set: nothing is touched.
 */
function enforceMarksBudget(examJson, budget) {
  const cap = Number(budget);
  if (!Number.isFinite(cap) || cap <= 0) return 0;
  if (totalMarksOf(examJson) <= cap) return 0;

  let spent = 0;
  let kept = 0;
  let removed = 0;

  const fits = (q) => {
    const cost = _marksOf(q);
    // The first question always survives. A single question worth more than the
    // whole budget would otherwise empty the paper, and a paper slightly over
    // budget beats a blank one.
    if (kept === 0 || spent + cost <= cap) {
      spent += cost;
      kept += 1;
      return true;
    }
    removed += 1;
    return false;
  };

  const take = (list) => list.filter((q) => (q && typeof q === 'object' ? fits(q) : true));

  for (const section of ['seen', 'unseen']) {
    const branch = examJson?.[section];
    if (!branch || typeof branch !== 'object') continue;
    for (const category of Object.values(branch)) {
      if (!category || typeof category !== 'object') continue;
      for (const [type, entry] of Object.entries(category)) {
        if (Array.isArray(entry)) category[type] = take(entry);
        else if (entry && typeof entry === 'object') {
          for (const [sub, list] of Object.entries(entry)) {
            if (Array.isArray(list)) entry[sub] = take(list);
          }
        }
      }
    }
  }
  return removed;
}

/**
 * The model is told not to emit "image" keys, and sometimes emits them anyway.
 * Their value is a prompt for an image generator we did not port, so left in
 * place they render as a stray line of instructions on a child's exam paper.
 */
function stripImageKeys(examJson) {
  _walkQuestions(examJson, (q) => {
    delete q.image;
    delete q.image_description;
  });
  return examJson;
}

// An option's label and the text after it: "b) 4", "(b) 4", "B. 4", "ج) اسلام آباد".
const OPTION_LABEL = /^\s*\(?\s*([A-Za-z]|[؀-ۿ]{1,3})\s*[).:\-]\s*(.*)$/s;

function _norm(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function _splitOption(option) {
  const m = String(option ?? '').match(OPTION_LABEL);
  return m ? { label: _norm(m[1]), text: _norm(m[2]) } : { label: null, text: _norm(option) };
}

/**
 * The option an MCQ answer names, or null when it names none unambiguously.
 * Tried in order: the option itself, its label alone ("b", "(b)", "ج"), and the
 * text after the label ("4" for "b) 4"). Only a single match counts — a guess
 * would print a wrong answer on a teacher's key, which is worse than a gap.
 */
function _resolveOption(options, answer) {
  const want = _norm(answer);
  if (!want) return null;
  const exact = options.filter((o) => _norm(o) === want);
  if (exact.length === 1) return exact[0];
  const bareLabel = want.replace(/^\(\s*/, '').replace(/\s*[).:\-]?\s*\)?$/, '');
  const byLabel = options.filter((o) => _splitOption(o).label === bareLabel);
  if (byLabel.length === 1) return byLabel[0];
  const asOption = _splitOption(answer);
  const byText = options.filter((o) => {
    const t = _splitOption(o).text;
    return t && (t === want || (asOption.label && t === asOption.text));
  });
  return byText.length === 1 ? byText[0] : null;
}

/** "1) a 2) b 3) c" → ['a','b','c'], or null when it is not numbered 1..n. */
function _splitNumbered(answer, n) {
  const text = String(answer ?? '');
  const marks = [...text.matchAll(/(?:^|\s)\(?(\d{1,2})\s*[).:\-]\s*/g)];
  const seq = [];
  for (const m of marks) {
    if (Number(m[1]) === seq.length + 1) seq.push(m);
  }
  if (seq.length !== n || n === 0) return null;
  return seq.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < seq.length ? seq[i + 1].index : text.length;
    return text.slice(start, end).trim();
  });
}

function _hasText(v) {
  return typeof v === 'string' ? v.trim() !== '' : v != null && v !== false;
}

/**
 * Make the model's answers usable by the key without asking it again — only
 * where the right answer is recoverable from what it wrote:
 *
 *   * An MCQ answer given as a letter, a label or the option's bare text is
 *     rewritten to the exact option, so the key reads "b) 4", not "b".
 *   * A comprehension answer written once on the passage as "1) … 2) …" is
 *     split onto the sub-questions that carry none. A sub-question's own
 *     answer is never overwritten.
 *
 * Nothing is invented: an answer that cannot be placed is left as written.
 */
function normaliseAnswers(examJson) {
  _walkQuestions(examJson, (q) => {
    if (Array.isArray(q.options) && q.options.length && _hasText(q.answer)
        && typeof q.answer !== 'object') {
      const hit = _resolveOption(q.options, q.answer);
      if (hit != null) q.answer = hit;
    }
    if (Array.isArray(q.questions) && q.questions.length && _hasText(q.answer)) {
      const parts = _splitNumbered(q.answer, q.questions.length);
      if (parts) {
        q.questions.forEach((sub, i) => {
          if (sub && typeof sub === 'object' && !_hasText(sub.answer) && parts[i]) sub.answer = parts[i];
        });
      }
    }
  });
  return examJson;
}

/**
 * How much of the key has an answer, counted the way renderAnswerKey prints
 * it: a comprehension question counts once per sub-question, and falls back to
 * the passage's own answer only when none of its subs has one.
 */
function answerCoverage(examJson) {
  let questions = 0;
  let answered = 0;
  _walkQuestions(examJson, (q) => {
    if (Array.isArray(q.questions) && q.questions.length && q.passage) {
      const subs = q.questions;
      const anySub = subs.some((s) => s && typeof s === 'object' && _hasText(s.answer));
      if (!anySub && _hasText(q.answer)) { questions += 1; answered += 1; return; }
      subs.forEach((s) => {
        questions += 1;
        if (s && typeof s === 'object' && _hasText(s.answer)) answered += 1;
      });
      return;
    }
    questions += 1;
    if (_hasText(q.answer)) answered += 1;
  });
  return { questions, answered };
}

/** One model call, with the failure codes the caller turns into teacher messages. */
async function _callModel({ job, model, messages }) {
  let response;
  try {
    response = await getClient().chat.completions.create({
      model,
      messages,
      temperature: 0.7,
      response_format: { type: 'json_object' },
    });
  } catch (err) {
    // An outage is not bad output, and telling them apart is what decides
    // whether a retry is worth anything.
    logToFile('[testpaper] model call failed', { job, model, error: err.message });
    throw fail('MODEL_UNAVAILABLE', 'The question writer is unavailable right now.', { cause: err.message });
  }

  const choice = response?.choices?.[0] || {};
  const raw = choice.message?.content || '';

  // A model that reasons before it answers spends the same budget on both.
  // Hitting the ceiling returns empty content with finish_reason 'length' —
  // a truncation, which wants fewer questions rather than simply trying again.
  if (!raw && choice.finish_reason === 'length') {
    logToFile('[testpaper] model ran out of room', { job, model, usage: response.usage });
    throw fail('TRUNCATED', 'That was too much to write in one go — try fewer questions.', { usage: response.usage });
  }

  let json;
  try {
    json = extractJsonFromResponse(raw);
  } catch (err) {
    logToFile('[testpaper] model returned unusable JSON', { job, model, error: err.message, preview: raw.slice(0, 300) });
    throw fail('BAD_JSON', 'The question writer returned something we could not read.', { cause: err.message });
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw fail('BAD_JSON', 'The question writer returned something we could not read.');
  }

  const usage = response.usage || {};
  const tokenData = {
    inputTokens: usage.prompt_tokens ?? null,
    outputTokens: usage.completion_tokens ?? null,
    totalTokens: usage.total_tokens ?? null,
    model,
  };
  return { json, tokenData };
}

function _insufficient(json) {
  if (json && json.insufficient_source === true) {
    return fail('INSUFFICIENT_SOURCE', 'The source material is too thin for a fair paper.',
      { reason: typeof json.reason === 'string' ? json.reason.slice(0, 300) : null });
  }
  return null;
}

/** The tree's own parts only — top-level metadata stays out of the question walk. */
function _treeOf(json) {
  const tree = {};
  if (json.seen && typeof json.seen === 'object') tree.seen = json.seen;
  if (json.unseen && typeof json.unseen === 'object') tree.unseen = json.unseen;
  return tree;
}

function _cleanTitle(title) {
  return typeof title === 'string' && title.trim() ? title.trim().slice(0, 160) : null;
}

/**
 * Make a paper.
 *
 * @returns {Promise<{examJson, title, questionCount, tokenData, plan, trimmed, marksRemoved,
 *   answerCoverage, elapsedMs}>}
 * @throws {Error} with `.code` INSUFFICIENT_SOURCE | MODEL_UNAVAILABLE | TRUNCATED | BAD_JSON | NO_QUESTIONS
 */
async function generateExam(args) {
  const { grade, subject, language = 'en', sourceText, sourceLabel,
          contentSource = 'unseen', questionCount, questionTypes = [],
          totalMarks = null, seenCount = null } = args;

  const chars = String(sourceText || '').trim().length;
  if (chars < MIN_SOURCE_CHARS) {
    logToFile('[testpaper] refused: source too short', { sourceLabel, chars });
    throw fail('INSUFFICIENT_SOURCE', 'There is not enough source material to build a paper from.', { chars });
  }

  const { model } = resolveModelForJob('testpaper.generate');
  const plan = planCounts({ contentSource, questionCount, questionTypes, seenCount });
  const messages = [
    { role: 'system', content: buildSystemPrompt({ subject }) },
    { role: 'user', content: buildUserPrompt({ grade, subject, language, sourceText, sourceLabel, contentSource, questionCount, questionTypes, totalMarks, seenCount }) },
  ];

  logToFile('[testpaper] generating', {
    grade, subject, family: familyOf(subject), language, model, sourceLabel, contentSource,
    total: plan.total, seenTarget: plan.seenTarget,
    types: plan.questionTypes.map((q) => `${q.count} ${q.id}`), sourceChars: chars,
  });

  const startedAt = Date.now();
  const { json, tokenData } = await _callModel({ job: 'testpaper.generate', model, messages });

  const refusal = _insufficient(json);
  if (refusal) {
    logToFile('[testpaper] model judged the source insufficient', { sourceLabel, reason: refusal.reason });
    throw refusal;
  }

  const examJson = _treeOf(json);
  stripImageKeys(examJson);
  normaliseAnswers(examJson);
  const removedSeen = trimSeen(examJson, plan.seenTarget);
  const trimmed = removedSeen > 0 ? { seen: removedSeen } : {};

  // Last, because it measures the paper that actually survived the seen cap.
  const marksRemoved = enforceMarksBudget(examJson, totalMarks);

  const produced = countQuestions(examJson);
  if (produced === 0) {
    // Valid JSON with an empty tree. Rare, and worth its own code: retrying is
    // reasonable here, where retrying a refusal is not.
    throw fail('NO_QUESTIONS', 'The question writer returned no questions.');
  }

  // Measured on every paper, so a model that stops writing answers shows up in
  // the logs the day it happens rather than in a teacher's blank key.
  const coverage = answerCoverage(examJson);
  const elapsedMs = Date.now() - startedAt;
  logToFile('[testpaper] generated', {
    grade, subject, questionCount: produced, elapsedMs, ...tokenData,
    answersGiven: coverage.answered, answersExpected: coverage.questions, marksRemoved, trimmed,
  });

  return { examJson, title: _cleanTitle(json.title), subject: _cleanTitle(json.subject), questionCount: produced,
    tokenData, plan, trimmed, marksRemoved, answerCoverage: coverage, elapsedMs };
}

/**
 * A new version of a paper, from the teacher's change request ("make it
 * easier", "add 5 MCQs on rounding", "remove question 4"). The current tree
 * and the same source material go back to the model with the revision rules;
 * the result goes through the same clean-up as a first paper.
 *
 * `changed` is false when the model returned the paper as it was — usually
 * with a `note` saying why the request could not be done from the source —
 * so the caller can say that instead of sending an identical "new" version.
 */
async function revisePaper({ examJson, instruction, sourceText, sourceLabel, grade, subject, language = 'en' }) {
  const { model } = resolveModelForJob('testpaper.revise');
  const hasGrade = grade !== null && grade !== undefined && String(grade).trim() !== '';
  const user = `**Grade:** ${hasGrade ? grade : 'not stated'}
**Subject:** ${subject || 'not stated'}
**Source:** ${sourceLabel || 'teacher-provided material'}
**Paper language:** ${languageName(language)}

**The teacher's change request:**
${String(instruction || '').trim().slice(0, 2000)}

**Current paper (JSON):**
\`\`\`json
${JSON.stringify(examJson)}
\`\`\`

**Source Material:**
\`\`\`
${String(sourceText || '').slice(0, MAX_SOURCE_CHARS)}
\`\`\`
${languageRule(language)}
Return the whole revised paper as JSON.
`;
  const messages = [
    {
      role: 'system',
      content: [PROMPTS['tp.revise.system'], PROMPTS['tp.format.exam'], PROMPTS['tp.answer_key'], PROMPTS['tp.safety']].join(''),
    },
    { role: 'user', content: user },
  ];

  const startedAt = Date.now();
  const { json, tokenData } = await _callModel({ job: 'testpaper.revise', model, messages });
  const revised = _treeOf(json);
  stripImageKeys(revised);
  normaliseAnswers(revised);

  const produced = countQuestions(revised);
  if (produced === 0) throw fail('NO_QUESTIONS', 'The question writer returned no questions.');

  // Compared after the same clean-up, so normalising an answer the original
  // stored loosely ("b" → "b) 4") does not count as the teacher's change.
  const before = normaliseAnswers(stripImageKeys(JSON.parse(JSON.stringify(_treeOf(examJson)))));
  const changed = JSON.stringify(revised) !== JSON.stringify(before);
  const note = typeof json.note === 'string' && json.note.trim() ? json.note.trim().slice(0, 300) : null;
  logToFile('[testpaper] revised', { subject, questionCount: produced, changed, elapsedMs: Date.now() - startedAt, ...tokenData });

  return { examJson: revised, title: _cleanTitle(json.title), questionCount: produced, changed, note,
    tokenData, answerCoverage: answerCoverage(revised), elapsedMs: Date.now() - startedAt };
}

module.exports = {
  generateExam,
  revisePaper,
  buildSystemPrompt,
  buildUserPrompt,
  languageName,
  planCounts,
  trimSeen,
  enforceMarksBudget,
  totalMarksOf,
  countQuestions,
  stripImageKeys,
  normaliseAnswers,
  answerCoverage,
  MIN_SOURCE_CHARS,
  MAX_SOURCE_CHARS,
};
