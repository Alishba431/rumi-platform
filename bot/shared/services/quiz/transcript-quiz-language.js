'use strict';
/**
 * Transcript quiz — language and subject rules, in CODE, not in a prompt.
 *
 * Quiz language (what the children read) — always one of QUIZ_LANGUAGES
 * (config/quiz-languages.js, default `en`):
 *   a subject fixed by QUIZ_SUBJECT_LANGUAGE (`islamiat:ur`)  → that language
 *   a language lesson (urdu, english)                         → that language
 *   anything else (maths, science, other)                     → the lesson's language,
 *                                                               else the first configured one
 * A subject rule that names a language the deployment does not quiz in is
 * ignored: the quiz is never written in a language nobody configured.
 *
 * Teacher-facing language (offer, PDF caption, report):
 *   users.preferred_language, clamped to the catalogue. Nothing else — not the
 *   transcript, not the quiz. See teacherLanguageFor().
 */

const { getLanguage, quizLanguages, asksLanguage } = require('../../config/quiz-languages');
const { resolveUx, clampLanguage, subjectLabelFor } = require('../../config/ux-strings');
const SchoolClock = require('../../config/school-clock');

/**
 * A lesson ABOUT a language is quizzed in that language — an Urdu-grammar lesson
 * quizzed in French is not a quiz about that lesson. Keyed by the canonical
 * subject below; applies only when the language is one of QUIZ_LANGUAGES.
 */
const LANGUAGE_SUBJECTS = Object.freeze({ urdu: 'ur', english: 'en' });

/**
 * QUIZ_SUBJECT_LANGUAGE — `subject:code` pairs, comma separated, for a
 * deployment whose curriculum teaches a subject in one language whatever the
 * lesson was recorded in (e.g. `islamiat:ur,sst:ur`). Subjects go through
 * canonicalSubject, so any spelling it knows works. Empty by default. Read per
 * call, so a settings change needs no restart.
 */
function subjectLanguageRules() {
  const out = {};
  for (const part of String(process.env.QUIZ_SUBJECT_LANGUAGE || '').split(',')) {
    const i = part.lastIndexOf(':');
    if (i <= 0) continue;
    const subject = canonicalSubject(part.slice(0, i));
    const code = part.slice(i + 1).trim();
    if (subject !== 'other' && code) out[subject] = code;
  }
  return out;
}

/**
 * The language a subject FIXES in this deployment, or null when the subject
 * leaves it open. Only a configured quiz language counts.
 */
function fixedLanguageFor(subject) {
  const canon = canonicalSubject(subject);
  const configured = quizLanguages();
  const own = subjectLanguageRules()[canon] || LANGUAGE_SUBJECTS[canon] || null;
  return own && configured.includes(own) ? own : null;
}

/**
 * The language's English name, for the prompts ("QUIZ LANGUAGE: Urdu"). From
 * the platform's language registry, so a new deployment language needs no edit
 * here; an unknown code reads as "the lesson's own language".
 */
function languageName(code) {
  const row = code ? getLanguage(code) : null;
  return (row && row.languageDescription) || 'the lesson\'s own language';
}

/**
 * LANG_NAME[code] — the same names as languageName, kept as a lookup so a
 * caller can write `LANG_NAME[language] || 'fallback'`. Undefined for an
 * unknown code, as an object lookup would be.
 */
const LANG_NAME = new Proxy({}, {
  get: (_t, code) => (typeof code === 'string' && getLanguage(code) ? getLanguage(code).languageDescription : undefined),
});

// Whatever a teacher, a transcript or an earlier pass calls a subject, one
// name internally. Keys are lowercased; matching is exact first, then by
// substring so "General Science (Grade 5)" still lands on science.
const CANON = [
  ['islamiat', ['islamiat', 'islamiyat', 'islamic studies', 'islamic study', 'islamiyaat', 'deeniyat', 'اسلامیات', 'دینیات']],
  ['urdu', ['urdu', 'اردو']],
  ['english', ['english', 'english language', 'eng', 'انگریزی', 'انگلش']],
  ['maths', ['maths', 'math', 'mathematics', 'riyazi', 'ریاضی', 'حساب']],
  ['science', ['science', 'general science', 'gen science', 'sci', 'سائنس']],
  ['sst', ['sst', 'social studies', 'social study', 'social science', 'معاشرتی علوم']],
  // 'عمومی معلومات' is the subject's own display label (SUBJECT_LABELS), so a
  // label handed back in is recognised as the subject it names.
  ['genk', ['genk', 'gk', 'general knowledge', 'معلومات عامہ', 'عمومی معلومات']],
];

function canonicalSubject(subject) {
  const s = String(subject || '').trim().toLowerCase();
  if (!s) return 'other';
  for (const [canon, names] of CANON) {
    if (names.includes(s)) return canon;
  }
  for (const [canon, names] of CANON) {
    if (names.some((n) => n.length > 2 && s.includes(n))) return canon;
  }
  return 'other';
}

function isEnglishCode(lang) {
  const l = String(lang || '').trim().toLowerCase();
  return l === 'en' || l.startsWith('en-') || l.startsWith('en_') || l === 'english';
}

/**
 * A transcript's language label → a quiz language code, or null. Speech-to-text
 * labels vary ('en-GB', 'urdu', 'mixed'); a configured code is matched exactly,
 * then by its base ('ur-PK' → 'ur'), then by the registry's English name.
 */
function lessonLanguageCode(transcriptLanguage, configured) {
  const raw = String(transcriptLanguage || '').trim();
  if (!raw) return null;
  const l = raw.toLowerCase();
  if (isEnglishCode(l) && configured.includes('en')) return 'en';
  for (const code of configured) {
    const c = code.toLowerCase();
    if (l === c || l.split(/[-_]/)[0] === c.split('-')[0]) return code;
    const row = getLanguage(code);
    if (row && row.languageDescription.toLowerCase() === l) return code;
  }
  return null;
}

function quizLanguageFor(subject, transcriptLanguage) {
  const fixed = fixedLanguageFor(subject);
  if (fixed) return fixed;
  const configured = quizLanguages();
  return lessonLanguageCode(transcriptLanguage, configured) || configured[0];
}

/**
 * What the TEACHER reads. The language they stored, clamped to the offer, and
 * nothing else.
 *
 * A recording never changes the teacher's language; neither does a
 * transcript. The earlier version fell back to the detected transcript
 * language when they had stored nothing, which meant the same teacher could
 * be addressed in Urdu on one surface and English on the next depending on
 * which lesson they had just recorded. clampLanguage's floor is the one
 * answer for "nothing is known", shared with the rest of the deployment.
 *
 * `transcriptLanguage` is still accepted and ignored so a stale caller cannot
 * quietly change the answer.
 */
function teacherLanguageFor({ preferredLanguage } = {}) {
  return clampLanguage(preferredLanguage);
}

/**
 * Is the teacher asked which language the quiz is in? Only when the deployment
 * quizzes in more than one language (QUIZ_LANGUAGES) AND the subject leaves the
 * choice open: a language lesson, or a subject QUIZ_SUBJECT_LANGUAGE fixes, is
 * written in its own language without a question.
 */
function needsLanguageAsk(subject) {
  return asksLanguage() && !fixedLanguageFor(subject);
}

const LANGUAGE_BUTTON_PREFIX = 'tq_lang_';

/**
 * One option per configured quiz language, the subject-rule language first —
 * the one the teacher would have been given silently, still the easy tap. The
 * offer's sendLanguageAsk sends up to three as reply buttons and more as one
 * list (no channel driver turns extra buttons into a list: Meta refuses a
 * fourth button).
 *
 * Each title is the language's own name from the registry, so it cannot drift
 * from what /language and /settings show, and none is translated: a language
 * names itself the same way whichever language you are reading in.
 */
function languageAskButtons(quizId, ruleLanguage) {
  const offer = quizLanguages();
  const first = offer.includes(ruleLanguage) ? ruleLanguage : offer[0];
  const order = [first, ...offer.filter((c) => c !== first)];
  return order.map((code) => ({
    id: `${LANGUAGE_BUTTON_PREFIX}${code}_${quizId}`,
    title: getLanguage(code).languageTitle,
  }));
}

/**
 * `tq_lang_<code>_<quizId>` → `{ language, quizId }`, or null when the id is not
 * a language button or names a language this deployment does not quiz in. The
 * code is matched against the configured list rather than split on `_`, because
 * a code may itself carry a hyphen (`ta-IN`) and a quiz id is free-form.
 */
function parseLanguageButton(buttonId) {
  const id = String(buttonId || '');
  if (!id.startsWith(LANGUAGE_BUTTON_PREFIX)) return null;
  const rest = id.slice(LANGUAGE_BUTTON_PREFIX.length);
  const code = quizLanguages()
    .slice()
    .sort((a, b) => b.length - a.length)
    .find((c) => rest.startsWith(`${c}_`) && rest.length > c.length + 1);
  return code ? { language: code, quizId: rest.slice(code.length + 1) } : null;
}

/**
 * THE EXAMPLES THE ASK NAMES. The ask tells the teacher what an Urdu quiz does
 * with English terms, with an example or two — which must come from THIS lesson
 * (a science lesson was told "fraction, numerator"). In order of preference:
 *
 *   1. up to two of the digest's own key_terms written in English letters and
 *      short enough to read at a glance (a term, not a sentence), repeats
 *      dropped;
 *   2. when the lesson has none — no digest yet (a quiz born from a lesson
 *      plan), or only Urdu terms — a pair that fits the SUBJECT;
 *   3. and when neither fits, no examples at all: an example from another
 *      subject is worse than none.
 */
const ASK_TERM_MAX_CODE_POINTS = 24;
const ASK_TERM_MAX_WORDS = 3;
const ASK_TERM_SHAPE = /^[A-Za-z][A-Za-z0-9' -]*$/;
const ASK_TERM_FALLBACK = {
  maths: ['fraction', 'numerator'],
  science: ['photosynthesis', 'cell'],
  english: ['noun', 'verb'],
};

function askTermExamples({ digest, subject } = {}) {
  const terms = [];
  const seen = new Set();
  const keyTerms = digest && Array.isArray(digest.key_terms) ? digest.key_terms : [];
  for (const k of keyTerms) {
    const term = String((k && typeof k === 'object' ? k.term : k) || '').replace(/\s+/g, ' ').trim();
    const usable = ASK_TERM_SHAPE.test(term)
      && [...term].length <= ASK_TERM_MAX_CODE_POINTS
      && term.split(' ').length <= ASK_TERM_MAX_WORDS
      && !seen.has(term.toLowerCase());
    if (!usable) continue;
    seen.add(term.toLowerCase());
    terms.push(term);
    if (terms.length === 2) return terms;
  }
  if (terms.length) return terms;
  return [...(ASK_TERM_FALLBACK[canonicalSubject(subject || (digest && digest.subject))] || [])];
}

/**
 * The body of the quiz language ask, in the teacher's language, naming this
 * lesson's English terms (above). Each term is a first-strong isolate so a term
 * with a digit or a hyphen keeps its shape inside an Urdu line, and the terms
 * are joined by the language's own list comma (`،` in Urdu).
 *
 * @param {{digest?: object, subject?: string}} lesson
 * @param {string} teacherLang
 */
function languageAskBody(lesson, teacherLang) {
  const terms = askTermExamples(lesson || {});
  if (!terms.length) return resolveUx('tqAskLanguagePlain', { language: teacherLang });
  const examples = terms.map(isolate).join(resolveUx('vqLetterSep', { language: teacherLang }));
  return resolveUx('tqAskLanguage', { language: teacherLang, params: { examples } });
}

const UR_MONTHS = ['جنوری', 'فروری', 'مارچ', 'اپریل', 'مئی', 'جون', 'جولائی', 'اگست', 'ستمبر', 'اکتوبر', 'نومبر', 'دسمبر'];
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "5 ستمبر" / "5 Sep" (with the year when asked), on the school's calendar
 * (SCHOOL_TIMEZONE): a lesson recorded late in the evening belongs to that
 * school day, not the server's. Digits stay ASCII in both languages — that is
 * how dates are written in a chat.
 */
function formatLessonDate(iso, language, { year = false } = {}) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const [y, m, day] = SchoolClock.localDate(d).split('-').map(Number);
  const month = language === 'ur' ? UR_MONTHS[m - 1] : EN_MONTHS[m - 1];
  return year ? `${day} ${month} ${y}` : `${day} ${month}`;
}

/**
 * THE URDU PACK. Speech-to-text writes English technical terms in Urdu letters
 * ("فیکشن") and a model mirrors the transcript. The rule for an Urdu quiz is
 * the other way round — Urdu written well, English terms in English letters —
 * so the known ones are
 * rewritten deterministically before validation. Longest first so a plural or
 * a compound wins over its stem. Case is the English convention (lower-case
 * common nouns).
 */
const TRANSLITERATIONS = [
  ['پروپر فیکشنز', 'proper fractions'], ['پروپر فیکشن', 'proper fraction'], ['پراپر فیکشن', 'proper fraction'],
  ['امپروپر فیکشن', 'improper fraction'], ['مکسڈ فیکشن', 'mixed fraction'],
  ['فیکشنز', 'fractions'], ['فیکشن', 'fraction'], ['فریکشنز', 'fractions'], ['فریکشن', 'fraction'],
  ['نیومریٹر', 'numerator'], ['نمبریٹر', 'numerator'], ['نیومیریٹر', 'numerator'],
  ['ڈینومینیٹر', 'denominator'], ['ڈینامینیٹر', 'denominator'], ['ڈی نومینیٹر', 'denominator'],
  ['ہول', 'whole'], ['پارٹس', 'parts'], ['پارٹ', 'part'], ['ٹیسٹ', 'test'], ['سرکل', 'circle'], ['ہاف', 'half'], ['کوارٹر', 'quarter'], ['ایریا', 'area'], ['پیریمیٹر', 'perimeter'], ['شیپ', 'shape'], ['ٹرائی اینگل', 'triangle'], ['سکوائر', 'square'], ['ریکٹینگل', 'rectangle'],
  ['سبٹریکشن', 'subtraction'], ['ایڈیشن', 'addition'], ['ملٹی پلیکیشن', 'multiplication'], ['ملٹیپلیکیشن', 'multiplication'], ['ڈویژن', 'division'],
  ['پلیس ویلیو', 'place value'], ['ڈیجٹس', 'digits'], ['ڈیجٹ', 'digit'],
  ['ٹرائی اینگل', 'triangle'], ['ریکٹینگل', 'rectangle'], ['پیری میٹر', 'perimeter'],
  ['فوٹو سنتھیسز', 'photosynthesis'], ['فوٹوسنتھیسز', 'photosynthesis'], ['ایکو سسٹم', 'ecosystem'], ['ایکوسسٹم', 'ecosystem'],
  ['کلوگرام', 'kilogram'], ['ٹمپریچر', 'temperature'], ['میٹیریل', 'material'], ['لیکوئڈ', 'liquid'],
  ['پروناؤن', 'pronoun'], ['ایڈجیکٹو', 'adjective'], ['سینٹینس', 'sentence'], ['نائون', 'noun'],
  // Science and geometry: the first table was written from a maths-only corpus,
  // so a circuit, an atom and a radius all reached the teacher in Urdu letters.
  ['الیکٹرک سرکٹس', 'electric circuits'], ['الیکٹرک سرکٹ', 'electric circuit'], ['سرکٹس', 'circuits'], ['سرکٹ', 'circuit'],
  ['اسٹرکچر', 'structure'], ['سٹرکچر', 'structure'],
  ['ایٹمز', 'atoms'], ['ایٹم', 'atom'],
  ['الیکٹرانز', 'electrons'], ['الیکٹران', 'electron'],
  ['پروٹونز', 'protons'], ['پروٹون', 'proton'],
  ['نیوٹرانز', 'neutrons'], ['نیوٹران', 'neutron'],
  ['نیوکلیئس', 'nucleus'], ['نیوکلئس', 'nucleus'], ['نیوکلیس', 'nucleus'],
  ['ڈائی میٹر', 'diameter'], ['ڈایا میٹر', 'diameter'], ['ڈایامیٹر', 'diameter'], ['ڈائیامیٹر', 'diameter'],
  ['ریڈیئس', 'radius'], ['ریڈیس', 'radius'], ['ریڈئس', 'radius'],
  ['سرکمفرنس', 'circumference'],
  ['امپراپر', 'improper'], ['پراپر', 'proper'], ['مکسچر', 'mixture'], ['مکس', 'mixed'],
];

// A word character in ANY script: letter, combining mark or digit. Everything
// else — a space, a Latin comma, an Urdu comma (،), an Urdu full stop (۔), a
// bracket, the string edge — is a word boundary. Written with Unicode property
// escapes rather than a hand-listed Arabic range, because the Arabic block puts
// ، ۔ ؟ ؛ in among its letters, and a hand-listed range therefore treats
// "circle، ریڈیس، اور ڈائی میٹر" as ONE word and rewrites none of it.
const WORD_CHAR = '\\p{L}\\p{M}\\p{N}';

/**
 * Compiled once, and matched at URDU WORD BOUNDARIES rather than as a raw
 * substring. The substring form was safe only while every entry was long: the
 * moment a three-letter one is needed (`مکس` → mixed, from a real lesson) it
 * eats the middle of an unrelated word — `مکسچر` (mixture) came back as
 * "mixedچر" on the first pass over the seeded corpus. A boundary is any
 * non-Urdu character or the edge of the string, so `مکس fraction` is rewritten
 * and `مکسچر` is not, and `سٹرکچر` no longer fires inside `اسٹرکچر`.
 */
const TRANSLITERATION_RULES = TRANSLITERATIONS.map(([ur, en]) => [
  new RegExp(`(^|[^${WORD_CHAR}])(${ur.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![${WORD_CHAR}])`, 'gu'),
  en,
]);

function fixTransliterations(text) {
  let out = String(text || '');
  for (const [rx, en] of TRANSLITERATION_RULES) out = out.replace(rx, (_m, pre) => pre + en);
  return out;
}

/**
 * A whole English phrase spelled out in Urdu letters, e.g. "اسٹرکچر آف این
 * ایٹم". No table can hold these — the giveaway is the GRAMMAR, not the terms:
 * `آف` and `اینڈ` standing alone are never Urdu words, they are how a
 * speech-to-text writes "of" and "and" inside an English phrase. When one
 * appears, the label is a transliteration rather than the Urdu the prompt asked
 * for, and the digest has already produced the clean English label alongside it.
 */
const ENGLISH_CONNECTOR_IN_URDU = new RegExp(`(^|[^${WORD_CHAR}])(آف|اینڈ)(?![${WORD_CHAR}])`, 'u');

/** The SLO statement in the DOCUMENT's language (D1); falls back to the lesson-language one. */
function sloStatement(slo, language) {
  if (!slo) return '';
  // statement_<code> for the document's language; statement (the lesson's own
  // language) when the digest wrote none for it.
  const pick = language === 'en' || !language ? slo.statement_en : slo[`statement_${language}`];
  return String(pick || slo.statement || '').trim();
}

/**
 * The languages an SLO statement is written in: English (the record every
 * report can read) plus every configured quiz language, so a teacher who picks
 * any of them gets a one-language document. Read per call (QUIZ_LANGUAGES).
 * @returns {string[]}
 */
function statementLanguages() {
  return [...new Set(['en', ...quizLanguages()])];
}

/**
 * The digest prompt's line about the per-language statements — the same
 * `statement_<code>` fields statementLanguages() names, and nothing a
 * deployment does not quiz in.
 */
function statementFieldsRule() {
  const codes = statementLanguages();
  const fields = codes.map((c) => (c === 'en'
    ? '"statement_en" (the objective in English)'
    : `"statement_${c}" (the same objective in ${languageName(c)})`));
  return `Every SLO carries ${fields.join(', ')} — the teacher may ask for the quiz in ${codes.length > 1 ? 'any of these languages' : 'this language'} and the document must read in one language only.`;
}

function isTransliteratedEnglishPhrase(label) {
  return ENGLISH_CONNECTOR_IN_URDU.test(String(label || ''));
}

/** Apply the fixer to every child-facing field of an authored question. */
/** Walk a diagram spec and fix every string field (labels, titles, captions, notes). */
function fixSpecStrings(node) {
  if (typeof node === 'string') return fixTransliterations(node);
  if (Array.isArray(node)) return node.map(fixSpecStrings);
  if (node && typeof node === 'object') {
    const out = {};
    Object.entries(node).forEach(([k, v]) => { out[k] = k === 'type' || k === 'kind' ? v : fixSpecStrings(v); });
    return out;
  }
  return node;
}

function fixQuestionTransliterations(q) {
  if (!q || typeof q !== 'object') return q;
  const fb = q.option_feedback || {};
  const wrong = {};
  Object.entries(fb.wrong || {}).forEach(([k, v]) => { wrong[k] = fixTransliterations(v); });
  const misc = {};
  Object.entries(q.distractor_misconceptions || {}).forEach(([k, v]) => { misc[k] = fixTransliterations(v); });
  return {
    ...q,
    question: fixTransliterations(q.question),
    options: Array.isArray(q.options) ? q.options.map(fixTransliterations) : q.options,
    explanation: fixTransliterations(q.explanation),
    distractor_misconceptions: Object.keys(misc).length ? misc : q.distractor_misconceptions,
    option_feedback: { ...fb, correct: fixTransliterations(fb.correct), wrong },
    // A figure's labels/titles/captions are read by the child too.
    figure: q.figure && typeof q.figure === 'object' ? fixSpecStrings(q.figure) : q.figure,
  };
}

/**
 * The digest's canonical subject → the display code in the class reference
 * table, whose labels SUBJECT_LABELS mirrors. `sst` and `genk` are the
 * digest's own short names for the two the table spells out.
 */
const SUBJECT_LABEL_CODES = {
  urdu: 'urdu',
  english: 'english',
  maths: 'maths',
  science: 'science',
  sst: 'social_studies',
  genk: 'general_knowledge',
};

/**
 * Islamiyat is taught in these classrooms and the digest emits it, but it is
 * NOT one of the six codes seeded in the `subjects` reference table — and
 * SUBJECT_LABELS is that table's display mirror: the class-manager Flow builds
 * its subject picker from those keys and validates a teacher's selection
 * against them (class-manager-endpoint.js normalizeSubjectSelection). A
 * seventh key there would offer teachers a subject the table has never heard
 * of, so the quiz carries its own label and the mirror stays exact.
 */
const EXTRA_SUBJECT_LABELS = {
  islamiat: { en: 'Islamiyat', ur: 'اسلامیات' },
};

/** The subject's name in the reader's language, or null when we cannot name it. */
function subjectLabel(subject, language) {
  const canon = canonicalSubject(subject);
  const lang = clampLanguage(language);
  const extra = EXTRA_SUBJECT_LABELS[canon];
  if (extra) return extra[lang] || extra.en;
  const code = SUBJECT_LABEL_CODES[canon];
  return code ? subjectLabelFor(code, lang) : null;
}

// FIRST STRONG ISOLATE / POP DIRECTIONAL ISOLATE. The topic's script is not
// knowable when the catalog string is written — an Urdu topic sits inside an
// English sentence and vice versa — and an un-isolated atom drags the
// punctuation and the brackets around it (language-protocol §9.2).
const FSI = '\u2068';
const PDI = '\u2069';

function isolate(text) {
  return `${FSI}${text}${PDI}`;
}

// Common irregular English plurals, mapped to their singular. A short list on
// purpose: the rule only has to stop a topic being glossed with its own plural,
// and anything missing here simply keeps its bracket, as before.
const IRREGULAR_PLURALS = Object.freeze({
  children: 'child', men: 'man', women: 'woman', people: 'person', feet: 'foot', teeth: 'tooth',
  mice: 'mouse', geese: 'goose', halves: 'half', leaves: 'leaf', lives: 'life', knives: 'knife',
  wives: 'wife', shelves: 'shelf', wolves: 'wolf', calves: 'calf', loaves: 'loaf', thieves: 'thief',
  vertices: 'vertex', indices: 'index', matrices: 'matrix', radii: 'radius',
});

/**
 * An English word without its trailing plural: -ies → -y, -es after s/x/z/ch/sh,
 * otherwise a final -s that is not part of -ss, -us or -is ("class", "bus",
 * "axis" stay whole). Non-Latin words are returned as they are.
 */
function singular(word) {
  if (!/^[a-z]+$/.test(word)) return word;
  if (IRREGULAR_PLURALS[word]) return IRREGULAR_PLURALS[word];
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && /(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

/**
 * Do two topic labels name the same thing? True when they differ only in
 * "&" versus "and" (or "اور"), punctuation, spacing, case, or an English
 * word's plural ("Proper Fraction" / "Proper Fractions"). The digest's
 * `topic` and `topic_as_taught` are written separately and often agree in all
 * but that — "Comparing & ordering unlike fractions" / "Comparing and ordering
 * unlike fractions" — and a bracket repeating the topic tells the teacher
 * nothing. Two labels in different scripts are never the same by this test,
 * so a translation always survives.
 */
function sameTopic(a, b) {
  const norm = (s) => String(s || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/(^|\s)اور(?=\s|$)/g, ' and ')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map(singular)
    .join(' ');
  return norm(a) === norm(b);
}

/**
 * "Urdu lesson on *واحد اور جمع* (singular and plural)" — the one phrase the
 * offer, the hand-off and the /quiz rows all name the lesson by.
 *
 * The subject is in the TEACHER's language; the topic is the one the class
 * actually heard (the quiz language); the gloss in brackets is the teacher's
 * language and appears only when it adds information — a translation, or a
 * genuinely different name, never the same topic with "&" for "and" (sameTopic). The teacher taps "yes" on a
 * lesson they recognise, and then reads a quiz in the language their children
 * were taught in — the first version named neither, and an English offer arriving before
 * an Urdu quiz read as two different lessons.
 */
function lessonLabel({ digest, quizLanguage, teacherLanguage } = {}) {
  const quizLang = clampLanguage(quizLanguage);
  const teacherLang = clampLanguage(teacherLanguage);
  const taught = topicFor(digest, quizLang);
  const inTeacherLanguage = topicFor(digest, teacherLang);
  // The gloss is there to add information: a translation, or a genuinely
  // different name. A near-duplicate of the topic is not shown.
  const gloss = quizLang !== teacherLang && inTeacherLanguage && !sameTopic(inTeacherLanguage, taught)
    ? inTeacherLanguage : '';
  const subject = subjectLabel(digest && digest.subject, teacherLang);

  if (!taught) {
    return subject
      ? resolveUx('tqLessonNoTopic', { language: teacherLang, params: { subject } })
      : resolveUx('tqLessonPlain', { language: teacherLang });
  }
  const topic = gloss ? `${isolate(`*${taught}*`)} (${isolate(gloss)})` : isolate(`*${taught}*`);
  return subject
    ? resolveUx('tqLessonOnSubject', { language: teacherLang, params: { subject, topic } })
    : resolveUx('tqLessonOnTopic', { language: teacherLang, params: { topic } });
}

/** The topic label in a given language: the lesson's own name for Urdu, the clean English label otherwise. */
function topicFor(digest, language) {
  const d = digest || {};
  return language === 'ur' ? (d.topic_as_taught || d.topic || '') : (d.topic || d.topic_as_taught || '');
}

module.exports = {
  isolate,
  topicFor,
  needsLanguageAsk,
  fixedLanguageFor,
  languageAskButtons,
  parseLanguageButton,
  languageAskBody,
  LANGUAGE_BUTTON_PREFIX,
  LANGUAGE_SUBJECTS,
  lessonLabel,
  subjectLabel,
  SUBJECT_LABEL_CODES,
  EXTRA_SUBJECT_LABELS,
  fixTransliterations,
  fixQuestionTransliterations,
  isTransliteratedEnglishPhrase,
  sloStatement,
  statementLanguages,
  statementFieldsRule,
  TRANSLITERATIONS,
  LANG_NAME,
  languageName,
  canonicalSubject,
  quizLanguageFor,
  teacherLanguageFor,
  formatLessonDate,
  isEnglishCode,
};
