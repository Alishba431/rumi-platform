'use strict';
/**
 * Which kinds of question each subject supports, and how many of each to ask for.
 *
 * The lists are what the prompts were written against — a Science prompt knows
 * what a "Label the Diagram" question is and a language prompt does not.
 * Offering a teacher a type their subject's prompt has never heard of produces a
 * question the model invents the format for.
 *
 * Subjects are grouped into five neutral FAMILIES rather than one deployment's
 * subject list: every language a school teaches (the language of instruction,
 * a second language, a mother tongue) behaves the same way on a paper, and so do
 * history and geography. A subject nobody planned for lands in `general`, which
 * still makes a fair paper.
 *
 * Two things are subject-dependent and easy to get wrong:
 *   * whether a type is objective or subjective. "Brief Answers" is OBJECTIVE
 *     for a language paper and SUBJECTIVE for Science, and the distinction
 *     decides which half of the output tree it lands in.
 *   * language subjects split their subjective types by grade band, because a
 *     Grade 1 child is not writing an essay.
 */

const LANGUAGE = {
  objective: ['MCQs', 'MSQs', 'Fill in the Blanks', 'Missing Letters', 'True/False',
    'Match the Column', 'Circle the Correct Answer', 'Rewrite Sentences',
    'Brief Answers', 'Listening', 'Speaking', 'Reading'],
  subjectiveByGrade: {
    '1-2': ['Word Meanings', 'Word Sentences', 'Comprehension Passage',
      'Rewriting', 'Story Completion', 'Simple Writing'],
    '3+': ['Word Meanings', 'Word Sentences', 'Comprehension Passage',
      'Letter Writing', 'Application Writing', 'Story Writing',
      'Essay Writing', 'Paragraph Writing', 'Picture Description'],
  },
};

const CATALOGUE = {
  language: LANGUAGE,
  maths: {
    objective: ['MCQs', 'Fill in the Blanks', 'True/False', 'Match the Column',
      'Mental Math (Viva)', 'Sequences'],
    subjective: ['Short Questions', 'Restricted Response Question',
      'Word Problems', 'Graphs & Geometric Problems'],
  },
  science: {
    objective: ['MCQs', 'MSQs', 'True/False', 'Fill in the Blanks'],
    subjective: ['Short Questions', 'Brief Answers', 'Mind Map', 'Flow Chart',
      'Label the Diagram', 'Logical Reasoning'],
  },
  social_studies: {
    objective: ['MCQs', 'Fill in the Blanks', 'True/False', 'Match the Column'],
    subjective: ['Short Questions', 'Long Question', 'Mind Map', 'Flow Chart'],
  },
  general: {
    objective: ['MCQs', 'MSQs', 'Fill in the Blanks', 'True/False', 'Match the Column'],
    subjective: ['Short Questions', 'Long Question', 'Mind Map'],
  },
};

// Words that put a subject in a family. Matched as whole words anywhere in the
// subject name, so "General Science" and "Science (Grade 4)" both read as
// science. Order matters only for a name that hits two families; the first wins.
const FAMILY_WORDS = [
  ['maths', ['math', 'maths', 'mathematics', 'numeracy', 'arithmetic', 'algebra', 'geometry']],
  ['science', ['science', 'sciences', 'biology', 'physics', 'chemistry', 'evs', 'environmental']],
  ['social_studies', ['social', 'history', 'geography', 'civics', 'sst', 'citizenship']],
  ['language', ['language', 'languages', 'english', 'urdu', 'arabic', 'french', 'spanish',
    'portuguese', 'swahili', 'kiswahili', 'hindi', 'bengali', 'bangla', 'tamil', 'sinhala',
    'pashto', 'sindhi', 'punjabi', 'persian', 'farsi', 'amharic', 'hausa', 'yoruba', 'igbo',
    'zulu', 'xhosa', 'indonesian', 'malay', 'tagalog', 'filipino', 'nepali', 'reading',
    'literacy', 'literature', 'grammar', 'phonics', 'writing', 'vocabulary', 'spelling']],
];

/** The neutral family a subject name belongs to; `general` when none fits. */
function familyOf(subject) {
  const words = String(subject || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const [family, keys] of FAMILY_WORDS) {
    if (words.some((w) => keys.includes(w))) return family;
  }
  return 'general';
}

// What a paper looks like when the teacher does not want to choose. Objective
// types first and in quantity, because they are quick to mark for a class of
// thirty and quick to answer for a child who is six.
const DEFAULT_MIX = {
  objective: ['MCQs', 'Fill in the Blanks', 'True/False'],
  subjective: ['Short Questions', 'Brief Answers'],
};

// Types that ask for a written, extended answer. A "full" paper carries one.
const EXTENDED_TYPES = ['Long Question', 'Word Problems', 'Essay Writing', 'Story Writing',
  'Comprehension Passage', 'Logical Reasoning', 'Restricted Response Question', 'Simple Writing'];

function _sets(subject, grade) {
  const entry = CATALOGUE[familyOf(subject)];
  const objective = entry.objective || [];
  const subjective = entry.subjective
    || (Number(grade) <= 2 ? entry.subjectiveByGrade['1-2'] : entry.subjectiveByGrade['3+']);
  return { objective, subjective };
}

/** Everything this subject and grade supports, each tagged with its category. */
function forSubject(subject, grade) {
  const { objective, subjective } = _sets(subject, grade);
  return [
    ...objective.map((id) => ({ id, category: 'objective' })),
    ...subjective.map((id) => ({ id, category: 'subjective' })),
  ];
}

function categoryOf(typeId, subject, grade) {
  const { objective } = _sets(subject, grade);
  return objective.includes(typeId) ? 'objective' : 'subjective';
}

/**
 * Spread a total across the picked types. The remainder goes to the earlier
 * types rather than the last one, so a request for 10 across 3 types reads
 * 4/3/3 and not 3/3/4 — the paper opens with its fullest section.
 */
function withCounts(pickedIds, total, subject, grade) {
  const ids = (pickedIds || []).filter(Boolean);
  if (ids.length === 0) return defaultMix(subject, grade, total);

  const wanted = Math.max(1, Number(total) || ids.length);
  const base = Math.floor(wanted / ids.length);
  let spare = wanted - (base * ids.length);

  return ids.map((id) => {
    const count = base + (spare > 0 ? 1 : 0);
    if (spare > 0) spare -= 1;
    return { id, count: Math.max(1, count), category: categoryOf(id, subject, grade) };
  });
}

/** The mix a teacher gets when they did not want to choose types. */
function defaultMix(subject, grade, total) {
  const { objective, subjective } = _sets(subject, grade);
  const firstSubjective = DEFAULT_MIX.subjective.find((t) => subjective.includes(t));
  const pick = [
    ...DEFAULT_MIX.objective.filter((t) => objective.includes(t)),
    ...(firstSubjective ? [firstSubjective] : []),
  ];
  // A subject whose catalogue shares none of the defaults still needs a paper.
  const ids = pick.length ? pick : [objective[0], subjective[0]].filter(Boolean);
  return withCounts(ids, total, subject, grade);
}

/**
 * The three ready-made papers a chat offers, so a teacher can answer one
 * question ("which size?") instead of eight. Sizes are product choices, not
 * limits: anything else is one typed mix away (parseMixText).
 *
 *   quick    — 10 questions, objective only: a class check, marked in minutes
 *   standard — 20 questions, the default mix
 *   full     — 30 questions, the default mix plus one extended-answer type
 */
const PRESETS = { quick: 10, standard: 20, full: 30 };

function presetMix(preset, subject, grade) {
  const total = PRESETS[preset];
  if (!total) return null;
  const { objective, subjective } = _sets(subject, grade);

  if (preset === 'quick') {
    const ids = DEFAULT_MIX.objective.filter((t) => objective.includes(t));
    return withCounts(ids.length ? ids : objective.slice(0, 3), total, subject, grade);
  }
  if (preset === 'standard') return defaultMix(subject, grade, total);

  const extended = EXTENDED_TYPES.find((t) => subjective.includes(t));
  const base = defaultMix(subject, grade, 1).map((t) => t.id);
  const ids = extended && !base.includes(extended) ? [...base, extended] : base;
  return withCounts(ids, total, subject, grade);
}

function _key(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Short names people type for a type. Each maps onto the catalogue id.
const TYPE_ALIASES = {
  mcq: 'MCQs', mcqs: 'MCQs', 'multiple choice': 'MCQs',
  msq: 'MSQs', msqs: 'MSQs', 'multiple select': 'MSQs',
  'fill in the blank': 'Fill in the Blanks', 'fill in the blanks': 'Fill in the Blanks',
  blanks: 'Fill in the Blanks', 'fill blanks': 'Fill in the Blanks', fill: 'Fill in the Blanks',
  'true false': 'True/False', 'true or false': 'True/False', tf: 'True/False',
  match: 'Match the Column', matching: 'Match the Column',
  short: 'Short Questions', 'short question': 'Short Questions', 'short answer': 'Short Questions',
  long: 'Long Question', 'long question': 'Long Question', 'long answer': 'Long Question',
  essay: 'Essay Writing', comprehension: 'Comprehension Passage',
  'word problem': 'Word Problems', brief: 'Brief Answers', 'brief answer': 'Brief Answers',
};

/** The catalogue id a typed name means for this subject, or null. */
function _resolveType(name, subject, grade) {
  const offered = forSubject(subject, grade).map((t) => t.id);
  const want = _key(name);
  if (!want) return null;
  const exact = offered.find((id) => _key(id) === want);
  if (exact) return exact;
  const alias = TYPE_ALIASES[want] || TYPE_ALIASES[want.replace(/s$/, '')];
  if (alias && offered.includes(alias)) return alias;
  const prefixed = offered.filter((id) => _key(id).startsWith(want) || _key(id).replace(/s$/, '') === want);
  return prefixed.length === 1 ? prefixed[0] : null;
}

/**
 * Read a question mix typed into chat: "5 MCQs, 3 true/false, 2 short", or one
 * "type: n" per line. The chat counterpart of parsePerTypeCounts, with the same
 * rules — every type named must be one this subject offers (named back to the
 * teacher when it is not), and the ceiling is checked on the sum, refused rather
 * than clamped.
 */
function parseMixText(text, subject, grade) {
  const parts = String(text || '').split(/[,;\n]+|\band\b/i).map((p) => p.trim()).filter(Boolean);
  const out = [];
  for (const part of parts) {
    const m = part.match(/^(\d+)\s*x?\s+(.+)$/i) || part.match(/^(.+?)\s*[:=\-]\s*(\d+)$/);
    if (!m) continue;
    const [count, name] = /^\d+$/.test(m[1]) ? [Number(m[1]), m[2]] : [Number(m[2]), m[1]];
    const id = _resolveType(name, subject, grade);
    if (!id) {
      return { ok: false, message: `"${name.trim()}" is not a question type I can set for this subject.` };
    }
    if (!Number.isInteger(count) || count < 1) {
      return { ok: false, message: `How many ${id}? Type a number between 1 and ${MAX_QUESTIONS}.` };
    }
    const existing = out.find((t) => t.id === id);
    if (existing) existing.count += count;
    else out.push({ id, count, category: categoryOf(id, subject, grade) });
  }
  if (!out.length) {
    return { ok: false, message: 'Type the mix as numbers and kinds, e.g. "5 MCQs, 3 true/false, 2 short".' };
  }
  const total = out.reduce((s, t) => s + t.count, 0);
  if (total > MAX_QUESTIONS) {
    return {
      ok: false,
      message: `That is ${total} questions. A paper can hold up to ${MAX_QUESTIONS} — please lower one of the numbers.`,
    };
  }
  return { ok: true, types: out, total };
}

/**
 * How many questions a paper may hold.
 *
 * A product ceiling, not a technical one: teachers set papers longer than 25,
 * and the model call sets no output cap. Count adherence at the very top of the
 * range is the thing to watch if it is ever raised again.
 */
const MAX_QUESTIONS = 50;
const DEFAULT_QUESTIONS = 15;

/** How many different types one paper may mix. */
const MAX_TYPE_SLOTS = 8;

/**
 * Read the number a teacher typed.
 *
 * Every bound is enforced here, on a value that can be anything a keyboard
 * produces: empty, "0", "-5", "999", "7.5", "abc".
 *
 * Out of range is REFUSED rather than clamped. Quietly turning 40 into 25 hands
 * the teacher a paper they did not ask for and never mentions it; refusing puts
 * the number back in front of them while they can still change it.
 */
function parseQuestionCount(raw) {
  const text = String(raw ?? '').trim();
  const range = `Type a number between 1 and ${MAX_QUESTIONS}.`;

  if (!text) return { ok: false, message: range };
  if (!/^\d+$/.test(text)) return { ok: false, message: range };

  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) return { ok: false, message: range };
  if (n > MAX_QUESTIONS) {
    return { ok: false, message: `A paper can hold up to ${MAX_QUESTIONS} questions. ${range}` };
  }
  return { ok: true, count: n };
}

/**
 * Read the count typed against EACH picked type (`count_1`…`count_N`,
 * positional, in the order the types were picked) and return the
 * `{ id, count, category }` list the generator speaks.
 *
 * Every box is REQUIRED: a type picked and then left blank is a contradiction,
 * and the two ways out of it are both worse than asking. Filling it with a
 * default hands the teacher a number they never chose; dropping the type quietly
 * deletes a section they asked for. So a blank bounces, naming the type rather
 * than the slot — "MCQs" is theirs, "count_1" is ours.
 *
 * The paper ceiling is checked on the SUM, because that is the paper. Refused,
 * never clamped — the same rule the single count follows.
 */
function parsePerTypeCounts(pickedIds, data, subject, grade, seenCount = 0) {
  const ids = (pickedIds || []).filter(Boolean);
  if (ids.length === 0) {
    return { ok: false, message: 'Please choose at least one kind of question.' };
  }

  const out = [];
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    const raw = data?.[`count_${i + 1}`];
    const text = String(raw ?? '').trim();
    const range = `Type a number between 1 and ${MAX_QUESTIONS}.`;

    // `slot` names the box, so a form can mark THAT box rather than leaving the
    // teacher to work out which of eight numbers was wrong.
    const slot = i + 1;
    if (!text || !/^\d+$/.test(text)) {
      return { ok: false, slot, message: `How many ${id}? ${range}` };
    }
    const n = Number(text);
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, slot, message: `How many ${id}? ${range}` };
    }
    if (n > MAX_QUESTIONS) {
      return {
        ok: false,
        slot,
        message: `A paper can hold up to ${MAX_QUESTIONS} questions, so ${id} cannot be ${n}. ${range}`,
      };
    }
    out.push({ id, count: n, category: categoryOf(id, subject, grade) });
  }

  const total = out.reduce((s, t) => s + t.count, 0);
  // On Both, the Seen questions already asked for are part of the same paper,
  // so the ceiling is checked on Seen + Unseen together.
  const seen = Math.max(0, Number(seenCount) || 0);
  if (total + seen > MAX_QUESTIONS) {
    const which = seen ? ` (${seen} Seen + ${total} Unseen)` : '';
    return {
      ok: false,
      message: `That is ${total + seen} questions in total${which}. A paper can hold up to `
        + `${MAX_QUESTIONS} — please lower one of the numbers.`,
    };
  }

  return { ok: true, types: out, total };
}

/**
 * The most marks a paper may be asked to carry.
 *
 * A typo guard, not a product opinion: 50 questions (the ceiling) at a generous
 * 20 marks each is 1000, so it never blocks a genuine request and still catches
 * the keypad slip that turns 40 into 40000. It moves with the question ceiling.
 */
const MAX_TOTAL_MARKS = 1000;

/**
 * Read an optional marks budget.
 *
 * BLANK IS VALID: the budget is optional and an empty answer means "no
 * budget". Only a value actually typed is held to the range, and out of range
 * is refused rather than clamped, for the same reason as the count.
 */
function parseTotalMarks(raw) {
  const text = String(raw ?? '').trim();
  const range = `Type a number between 1 and ${MAX_TOTAL_MARKS}, or leave it blank.`;

  if (!text) return { ok: true, marks: null };

  if (!/^\d+$/.test(text)) return { ok: false, message: range };

  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) return { ok: false, message: range };
  if (n > MAX_TOTAL_MARKS) {
    return { ok: false, message: `A paper can carry up to ${MAX_TOTAL_MARKS} marks. ${range}` };
  }
  return { ok: true, marks: n };
}

module.exports = {
  familyOf, forSubject, categoryOf, withCounts, defaultMix, presetMix, parseMixText,
  parseQuestionCount, parsePerTypeCounts, parseTotalMarks,
  CATALOGUE, PRESETS, EXTENDED_TYPES, MAX_QUESTIONS, DEFAULT_QUESTIONS, MAX_TOTAL_MARKS, MAX_TYPE_SLOTS,
};
