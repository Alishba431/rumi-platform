'use strict';
/**
 * The exam paper itself — the one artefact a teacher actually sees.
 *
 * Laid out the way the papers teachers already print are laid out: school name,
 * a marking header with Roll No and Obtained Marks, the standing instructions,
 * then the questions. Deliberately NOT the coloured web preview the previous
 * generator emitted — a gradient banner and emoji section headings are fine on a
 * screen and wrong on a photocopier, where they cost ink and say nothing.
 *
 * Everything is inline-styled and self-contained because this HTML is fed
 * straight to a headless browser for printing; there is no stylesheet to load.
 *
 * On escaping: every string here came from a language model. It is rendered as
 * text, never as markup — a question containing a stray angle bracket must
 * appear on the page, not disappear into the DOM.
 */

const fs = require('fs');
const path = require('path');

/**
 * Fonts are base64-embedded into the HTML, not named and hoped for.
 *
 * The Chromium that prints this runs headless on a container with NO system
 * fonts. A stylesheet that merely NAMES 'Noto Nastaliq Urdu' gets no glyphs and
 * every Urdu character renders as an empty box. Naming a font that happens to be
 * installed on the author's laptop is the exact shape of that bug: it passes on
 * one machine and prints boxes everywhere else.
 */
const LATIN_FONTS = { regular: 'Lexend-Regular.ttf', bold: 'Lexend-Bold.ttf' };

// The face a right-to-left paper is set in, by language. Urdu is written in
// Nastaliq; the other Arabic-script languages read naturally in Naskh. A
// language with no entry here (Hebrew, say) falls back to the system serif the
// browser has — which still lays out right to left, just without a bundled face.
const NASTALIQ = { regular: 'NotoNastaliqUrdu-Regular.ttf', bold: 'NotoNastaliqUrdu-Bold.ttf' };
const NASKH = { regular: 'NotoNaskhArabic-Regular.ttf', bold: 'NotoNaskhArabic-Bold.ttf' };
const SCRIPT_FONTS = {
  ur: NASTALIQ,
  // The platform's region-tagged codes for languages written in Perso-Arabic
  // script (see config/supported-languages.js): pa-PK (Shahmukhi) and bal-PK
  // are usually set in Nastaliq, sd-PK and ps-PK in Naskh.
  'pa-pk': NASTALIQ,
  'bal-pk': NASTALIQ,
  'sd-pk': NASKH,
  'ps-pk': NASKH,
  ar: NASKH,
  fa: NASKH,
  ps: NASKH,
  sd: NASKH,
  ckb: NASKH,
  ug: NASKH,
};

// Languages whose papers are set right to left — by base code, plus the
// region-tagged platform codes whose base alone is ambiguous ("pa" is right to
// left in Shahmukhi script, pa-PK, and left to right in Gurmukhi).
const RTL_LANGUAGES = new Set(['ur', 'ar', 'fa', 'ps', 'sd', 'ckb', 'ug', 'he', 'yi', 'dv', 'bal']);
const RTL_TAGGED = new Set(['pa-pk', 'bal-pk', 'sd-pk', 'ps-pk']);

/** "ur-PK" → "ur"; anything unreadable → "en". */
function baseLanguage(language) {
  const code = String(language || '').trim().toLowerCase().split(/[-_]/)[0];
  return code || 'en';
}

function _tag(language) {
  return String(language || '').trim().toLowerCase().replace('_', '-');
}

/** The face entry for a language: its exact tag first, then its base code. */
function _scriptEntry(language) {
  return SCRIPT_FONTS[_tag(language)] || SCRIPT_FONTS[baseLanguage(language)] || null;
}

const _fontCache = new Map();
function fontData(file) {
  if (_fontCache.has(file)) return _fontCache.get(file);
  const abs = path.join(__dirname, '..', '..', 'fonts', file);
  let data = '';
  try {
    data = fs.existsSync(abs) ? fs.readFileSync(abs).toString('base64') : '';
  } catch {
    data = '';
  }
  _fontCache.set(file, data);
  return data;
}

/** The bundled script face (file name) for a language, or null. */
function scriptFontFor(language) {
  const entry = _scriptEntry(language);
  return entry ? entry.regular : null;
}

function fontFaces(language) {
  const face = (family, weight, data) => (data
    ? `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;`
      + `src:url(data:font/ttf;base64,${data}) format('truetype');}`
    : '');
  const script = _scriptEntry(language);
  return [
    face('PaperLatin', 400, fontData(LATIN_FONTS.regular)),
    face('PaperLatin', 700, fontData(LATIN_FONTS.bold)),
    // Only a right-to-left paper carries a script face: a 1 MB Nastaliq font in
    // every English paper is weight the printer pays for and nobody reads.
    script ? face('PaperScript', 400, fontData(script.regular)) : '',
    script ? face('PaperScript', 700, fontData(script.bold)) : '',
  ].filter(Boolean).join('\n');
}

/**
 * The paper's own words — header, instructions, section headings — per paper
 * language. A paper whose questions are in Urdu and whose header is in English
 * reads as two documents stapled together, so a language with a label set gets
 * its labels laid out in its own direction. A language without one keeps the
 * English labels, isolated left to right inside the page.
 *
 * Urdu wording is the plain register of a school exam paper, with no gendered
 * forms.
 */
const LABELS = {
  en: {
    rtl: false,
    grade: 'Grade', pages: 'Pages', version: 'Version',
    studentName: 'Student Name', rollNo: 'Roll No', date: 'Date',
    totalMarks: 'Total Marks', obtainedMarks: 'Obtained Marks',
    instructions: 'Instructions',
    instructionLines: [
      'Read all questions carefully before answering.',
      'Answer all questions in the space provided.',
      'Write clearly and legibly.',
      'Time allowed: as specified by your teacher.',
    ],
    mark: 'mark', marks: 'marks',
    answerKey: 'Answer Key',
    teacherNote: (dash) => `For the teacher. Numbers match the question paper. ${dash} marks a question the generator gave no model answer for.`,
    types: {},
  },
  ur: {
    rtl: true,
    grade: 'جماعت', pages: 'صفحات', version: 'ورژن',
    studentName: 'نام', rollNo: 'رول نمبر', date: 'تاریخ',
    totalMarks: 'کل نمبر', obtainedMarks: 'حاصل کردہ نمبر',
    instructions: 'ہدایات',
    instructionLines: [
      'جواب دینے سے پہلے تمام سوالات غور سے پڑھیں۔',
      'تمام سوالات کے جوابات دی گئی جگہ پر لکھیں۔',
      'صاف اور خوش خط لکھیں۔',
      'وقت: جیسا استاد بتائیں۔',
    ],
    mark: 'نمبر', marks: 'نمبر',
    answerKey: 'جوابی کلید',
    teacherNote: (dash) => `استاد کے لیے۔ نمبر سوالیہ پرچے کے مطابق ہیں۔ ${dash} اس سوال کی نشان دہی کرتا ہے جس کا نمونہ جواب نہیں دیا گیا۔`,
    types: {
      'MCQs': 'کثیر انتخابی سوالات',
      'MSQs': 'ایک سے زیادہ درست جوابات',
      'Fill in the Blanks': 'خالی جگہ پُر کریں',
      'True/False': 'درست / غلط',
      'Match the Column': 'کالم ملائیں',
      'Circle the Correct Answer': 'درست جواب پر دائرہ لگائیں',
      'Rewrite Sentences': 'جملے دوبارہ لکھیں',
      'Short Questions': 'مختصر سوالات',
      'Brief Answers': 'مختصر جوابات',
      'Long Question': 'تفصیلی سوال',
      'Word Problems': 'عبارتی سوالات',
      'Comprehension Passage': 'تفہیمِ عبارت',
      'Word Meanings': 'الفاظ کے معنی',
      'Word Sentences': 'الفاظ کو جملوں میں استعمال کریں',
    },
  },
};

function labelsFor(language) {
  return LABELS[_tag(language)] || LABELS[baseLanguage(language)] || LABELS.en;
}

/** A section heading in the paper's language, when it has one for this type. */
function typeLabel(type, L) {
  const key = Object.keys(L.types).find((k) => k.toLowerCase() === String(type || '').trim().toLowerCase());
  return key ? L.types[key] : type;
}

// How much room a written answer needs. Multiple choice and matching get none —
// the child marks the option or draws the line, and blank ruled lines under an MCQ
// just waste the page.
const ANSWER_LINES = {
  'brief answers': 2, 'short questions': 4, 'short answer': 4,
  'restricted response question': 4, 'long question': 8, 'long answer': 8,
  'essay writing': 10, 'story writing': 10, 'letter writing': 10,
  'application writing': 10, 'paragraph writing': 6, 'picture description': 6,
  'word problems': 4, 'mind map': 6, 'flow chart': 6, 'label the diagram': 4,
  'logical reasoning': 4, 'word sentences': 3, 'word meanings': 3,
  'simple writing': 6, 'story completion': 6, 'rewriting': 3,
};

// Type keys that name a bucket rather than a kind of question. Never used as a
// heading; the questions under them still render normally.
const GENERIC_TYPES = new Set(['other', 'others', 'misc', 'miscellaneous', 'general']);

const NO_LINES = new Set([
  'mcqs', 'msqs', 'true/false', 'match the column', 'circle the correct answer',
  'fill in the blanks', 'missing letters', 'listening', 'speaking', 'reading',
]);

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Escaped, but line breaks in a passage survive as line breaks. */
function escMultiline(value) {
  return esc(value).replace(/\n/g, '<br>');
}

/** The subject as the teacher's source named it; a snake_case code reads as words. */
function subjectName(subject) {
  const raw = String(subject || '').trim();
  if (!/^[a-z0-9_]+$/.test(raw)) return raw;
  return raw.split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function isRtl(language) {
  if (!language) return false;
  return RTL_TAGGED.has(_tag(language)) || RTL_LANGUAGES.has(baseLanguage(language));
}

/** "Grade 2 · Math", or just "Math" when the source named no grade. */
function headingOf(grade, subject, L = LABELS.en) {
  const hasGrade = grade !== null && grade !== undefined && String(grade).trim() !== '';
  return [hasGrade ? `${L.grade} ${esc(grade)}` : '', esc(subjectName(subject))].filter(Boolean).join(' · ');
}

/** The line under the heading: chapter, pages, and (from v2 on) the version. */
function subLineOf(chapterTitle, pageReference, version, L = LABELS.en) {
  const parts = [];
  if (chapterTitle) parts.push(esc(chapterTitle));
  if (pageReference) parts.push(`${L.pages} ${esc(pageReference)}`);
  if (Number(version) > 1) parts.push(`${L.version} ${Number(version)}`);
  return parts.join(' · ');
}

function marksLabel(marks, L = LABELS.en) {
  const n = Number(marks);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `<span class="marks">[${n} ${n === 1 ? L.mark : L.marks}]</span>`;
}

/**
 * The bounds within which the model's own `lines`
 * number is believed. Prod values run 0..15 (an essay asks for 15); anything
 * outside, fractional or non-numeric is a malformed field, not a request for a
 * page of lines, and falls back to the type's default.
 */
const MAX_STORED_LINES = 15;

/** The stored `lines` as a whole number in bounds, or null. */
function storedLines(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  if (typeof value === 'string' && !/^\s*\d+\s*$/.test(value)) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_STORED_LINES) return null;
  return n;
}

/**
 * How many ruled lines a question gets. Every question the model writes
 * carries a `lines` number sized to the answer it expects (15 for an essay, 2
 * for a brief answer); an earlier version ignored it in favour of a
 * per-type table. Now:
 *
 *   * nowhere to write — a no-line type, options to mark, columns to match — 0,
 *     whatever `lines` says;
 *   * otherwise the stored number, when it is sane (see storedLines);
 *   * otherwise the type's default, as before.
 *
 * This is the one rule for every paper: the first version and every revision
 * are made from renderPaper's HTML.
 */
function answerLinesFor(questionType, question) {
  const key = String(questionType || '').trim().toLowerCase();
  if (NO_LINES.has(key)) return 0;
  if (question && Array.isArray(question.options) && question.options.length) return 0;
  if (question && (question.column_a || question.column_b)) return 0;
  const stored = storedLines(question && question.lines);
  if (stored !== null) return stored;
  return ANSWER_LINES[key] ?? 3;
}

// A comprehension sub-question's lines: its own number when sane, else 2.
const SUB_QUESTION_LINES = 2;

function ruledLines(count) {
  if (!count) return '';
  return `<div class="answer-space">${'<div class="answer-line"></div>'.repeat(count)}</div>`;
}

/**
 * How tall a ruled line has to be for the child holding the pencil.
 *
 * A Grade 1 hand writes letters roughly twice the height a Grade 5 hand does,
 * and a line it cannot fit its writing between is worse than no line at all —
 * it makes neat work look untidy. Sized from printed handwriting guides:
 * ~9mm for the youngest, tapering to ~6.5mm by Grade 5.
 */
function lineHeightMm(grade) {
  const g = Number(grade);
  if (!Number.isFinite(g)) return 7;
  if (g <= 2) return 9;
  if (g <= 4) return 7.5;
  return 6.5;
}

/**
 * One question, rendered for whichever of the six shapes it is. Order matters —
 * a comprehension question also has a `passage`, so it must be tested before the
 * passage-only case.
 */
function renderQuestion(question, number, questionType, opts) {
  const { includeAnswerKey, answerLines } = opts;
  const out = [];

  if (typeof question === 'string') {
    return `<div class="q"><p><b class="qn">${number}.</b> ${esc(question)}</p></div>`;
  }

  const marks = marksLabel(question.marks, opts.labels);
  const answer = includeAnswerKey && question.answer
    ? `<div class="answer"><b>Answer:</b> ${esc(question.answer)}</div>` : '';

  out.push('<div class="q">');

  if (Array.isArray(question.options) && question.options.length) {
    out.push(`<p><b class="qn">${number}.</b> ${esc(question.question)} ${marks}</p>`);
    out.push('<div class="options">');
    question.options.forEach((o) => out.push(`<div class="opt">${esc(o)}</div>`));
    out.push('</div>');
  } else if (question.column_a || question.column_b) {
    const a = question.column_a || [];
    const b = question.column_b || [];
    out.push(`<p><b class="qn">${number}.</b> ${esc(question.question)} ${marks}</p>`);
    out.push('<table class="match"><tr><th>Column A</th><th>Column B</th></tr>');
    // Pad to the longer column — dropping a row loses a question.
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      out.push(`<tr><td>${esc(a[i] || '')}</td><td>${esc(b[i] || '')}</td></tr>`);
    }
    out.push('</table>');
  } else if (Array.isArray(question.words) && question.words.length) {
    out.push(`<p><b class="qn">${number}.</b> ${esc(question.question || '')} ${marks}</p>`);
    out.push('<div class="words">');
    question.words.forEach((w) => out.push(
      `<div class="word">${esc(w)}${answerLines ? '<span class="rule"></span>' : ''}</div>`));
    out.push('</div>');
  } else if (question.passage && Array.isArray(question.questions)) {
    out.push(`<p><b class="qn">${number}.</b> ${esc(question.question || 'Read the passage and answer the questions.')} ${marks}</p>`);
    out.push(`<div class="passage">${escMultiline(question.passage)}</div>`);
    out.push('<div class="subs">');
    question.questions.forEach((sub, i) => {
      const letter = String.fromCharCode(97 + i);
      const subText = typeof sub === 'string' ? sub : sub.question;
      const subMarks = typeof sub === 'string' ? '' : marksLabel(sub.marks, opts.labels);
      out.push(`<p class="sub"><b>${letter})</b> ${esc(subText)} ${subMarks}</p>`);
      if (typeof sub === 'object' && Array.isArray(sub.options) && sub.options.length) {
        out.push('<div class="options">');
        sub.options.forEach((o) => out.push(`<div class="opt">${esc(o)}</div>`));
        out.push('</div>');
      } else if (answerLines) {
        const own = typeof sub === 'object' ? storedLines(sub && sub.lines) : null;
        out.push(ruledLines(own !== null ? own : SUB_QUESTION_LINES));
      }
      if (includeAnswerKey && typeof sub === 'object' && sub.answer) {
        out.push(`<div class="answer"><b>Answer:</b> ${esc(sub.answer)}</div>`);
      }
    });
    out.push('</div>');
  } else if (question.passage) {
    const label = question.section ? `[${esc(question.section)}] ` : '';
    out.push(`<p><b class="qn">${number}.</b> ${label}${esc(question.question || '')} ${marks}</p>`);
    out.push(`<div class="passage">${escMultiline(question.passage)}</div>`);
  } else {
    out.push(`<p><b class="qn">${number}.</b> ${esc(question.question)} ${marks}</p>`);
    if (answerLines) out.push(ruledLines(answerLinesFor(questionType, question)));
  }

  if (answer) out.push(answer);
  out.push('</div>');
  return out.join('\n');
}

/**
 * Every question the paper PRINTS, in printing order, with its type.
 *
 * A question the teacher took off the paper stays in the tree flagged `removed: true`
 * (so it can be brought back without moving any other question's id). Skipping
 * it HERE, in the one walk the paper, the answer key and the total all go
 * through, is what keeps a caller from forgetting it.
 */
function collectQuestions(examJson) {
  const found = [];
  const push = (entry) => {
    if (entry.question && entry.question.removed === true) return;
    found.push(entry);
  };
  for (const section of ['seen', 'unseen']) {
    const branch = examJson?.[section];
    if (!branch || typeof branch !== 'object') continue;
    for (const [category, types] of Object.entries(branch)) {
      if (!types || typeof types !== 'object') continue;
      for (const [type, entry] of Object.entries(types)) {
        if (Array.isArray(entry)) {
          entry.forEach((q) => q && push({ section, category, type, question: q }));
        } else if (entry && typeof entry === 'object') {
          for (const [subType, list] of Object.entries(entry)) {
            if (Array.isArray(list)) {
              list.forEach((q) => q && push({ section, category, type: subType, question: q }));
            }
          }
        }
      }
    }
  }
  return found;
}

function totalMarks(questions) {
  return questions.reduce((sum, { question }) => {
    if (Array.isArray(question?.questions)) {
      const subs = question.questions.reduce((s, q) => s + (Number(q?.marks) || 0), 0);
      if (subs > 0) return sum + subs;
    }
    return sum + (Number(question?.marks) || 0);
  }, 0);
}

// The paper a child writes on never carries the answers. The key is its own
// document — see renderAnswerKey.
function renderPaper({ examJson, grade, subject, language = 'en', schoolName, pageReference,
                       chapterTitle, version = 1, answerLines = true }) {
  const lineMm = lineHeightMm(grade);
  const questions = collectQuestions(examJson);
  const rtl = isRtl(language);
  const lang = esc(baseLanguage(language));
  const L = labelsFor(language);
  const chromeDir = L.rtl ? 'rtl' : 'ltr';
  const chromeAlign = L.rtl ? 'right' : 'left';
  const opts = { includeAnswerKey: false, answerLines, labels: L };

  const body = [];
  let number = 1;
  let lastType = null;
  let lastMain = null;

  for (const { type, question } of questions) {
    if (type !== lastType) {
      // The model's schema has a catch-all bucket, and questions land in it
      // legitimately. "OTHER" printed as a section heading on a child's paper
      // says nothing — the shared instruction under it already does the work.
      if (type && !GENERIC_TYPES.has(String(type).trim().toLowerCase())) {
        body.push(`<h3 class="type">${esc(typeLabel(type, L))}</h3>`);
      }
      lastType = type;
      lastMain = null;
    }
    // A shared instruction ("Write True or False") belongs above its group once,
    // not restated over every question under it.
    const main = question && question.main_question;
    if (main && main !== lastMain) {
      body.push(`<p class="lead">${esc(main)}</p>`);
      lastMain = main;
    }
    body.push(renderQuestion(question, number, type, opts));
    number += 1;
  }

  const heading = headingOf(grade, subject, L);
  const sub = subLineOf(chapterTitle, pageReference, version, L);

  return `<!DOCTYPE html>
<html lang="${lang}"${rtl ? ' dir="rtl"' : ''}>
<head><meta charset="utf-8"><title>${heading}</title>
<style>
  @page { size: A4; margin: 14mm 12mm; }
  ${fontFaces(language)}
  body { font-family: ${rtl
    ? "'PaperScript','PaperLatin',serif"
    : "'PaperLatin',Arial,sans-serif"}; font-size: ${rtl ? '13.5pt' : '12pt'};
    color: #000; line-height: ${rtl ? 2.0 : 1.5}; margin: 0; padding: 0 2px; }
  /* The 2px body gutter: Chrome's PDF printer crops a border that sits exactly
     on the right edge of the printable area (the marks table, the instructions). */
  /* Latin runs inside an RTL paper need BOTH halves: isolation stops the run
     reordering its Urdu neighbours, and an explicit ltr direction stops the run
     itself laying out right-to-left. Isolation alone was an earlier defect:
     "[1 mark]" printed as "[mark 1]" and every instruction lost its full stop
     to the front of the line, while the Urdu around them was perfectly correct. */
  .marks, .num { direction: ltr; unicode-bidi: isolate; }
  /* The question number is its own run: in a right-to-left paper "2." next to a
     question that starts with "56" otherwise prints as "56.2". */
  .qn { direction: ltr; unicode-bidi: isolate; }
  .school { text-align: center; font-weight: 700; font-size: 13pt; letter-spacing: .01em; }
  .class-line { text-align: center; font-size: 11.5pt; margin: 2px 0 10px; }
  .chapter { text-align: center; font-size: 10.5pt; color: #333; margin-bottom: 10px; }
  table.marks-header { width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: 11pt;
    direction: ${chromeDir}; unicode-bidi: isolate; text-align: ${chromeAlign}; }
  table.marks-header td { border: 1px solid #333; padding: 5px 7px; height: 22px; text-align: ${chromeAlign}; }
  table.marks-header td.k { background: #f2f2f2; font-weight: 600; white-space: nowrap; width: 22%; }
  .instructions { border: 1px solid #999; padding: 7px 10px; font-size: 10.5pt; margin-bottom: 14px;
    direction: ${chromeDir}; unicode-bidi: isolate; text-align: ${chromeAlign}; }
  .instructions ol { margin: 4px 0 0; padding-${L.rtl ? 'right' : 'left'}: 18px; }
  h3.type { font-size: 11.5pt; text-transform: uppercase; letter-spacing: .04em;
            border-bottom: 1.5px solid #000; padding-bottom: 3px; margin: 16px 0 9px;
            direction: ${chromeDir}; unicode-bidi: isolate; text-align: ${chromeAlign}; }
  .lead { font-weight: 600; margin: 8px 0 6px; }
  .q { margin-bottom: 11px; page-break-inside: avoid; }
  .q p { margin: 0 0 4px; }
  .marks { font-size: 10pt; color: #444; float: ${rtl ? 'left' : 'right'}; }
  .options { margin-${rtl ? 'right' : 'left'}: 18px; }
  .opt { margin: 2px 0; }
  .words { margin-${rtl ? 'right' : 'left'}: 18px; }
  .word { margin: 5px 0; }
  .word .rule { display: inline-block; border-bottom: 1px solid #999; width: 190px; margin-${rtl ? 'right' : 'left'}: 10px; }
  .passage { border: 1px solid #bbb; background: #fafafa; padding: 8px 10px; margin: 6px 0 8px; }
  .subs { margin-${rtl ? 'right' : 'left'}: 18px; }
  .sub { margin: 6px 0 3px; }
  table.match { border-collapse: collapse; margin: 6px 0 0 ${rtl ? '0' : '18px'}; width: 70%; }
  table.match th, table.match td { border: 1px solid #666; padding: 5px 8px; text-align: ${rtl ? 'right' : 'left'}; }
  table.match th { background: #f2f2f2; }
  .answer-space { margin: 5px 0 0 ${rtl ? '0' : '18px'}; }
  .answer-line { border-bottom: 1px solid #aaa; height: ${lineMm}mm; }
  .answer { background: #eef7ee; border-${rtl ? 'right' : 'left'}: 3px solid #4a4; padding: 3px 7px; margin-top: 4px; font-size: 10.5pt; }
</style></head>
<body>
${schoolName ? `<div class="school">${esc(schoolName)}</div>` : ''}
<div class="class-line">${heading}</div>
${sub ? `<div class="chapter">${sub}</div>` : ''}
<table class="marks-header">
  <tr><td class="k">${esc(L.studentName)}</td><td colspan="3"></td></tr>
  <tr><td class="k">${esc(L.rollNo)}</td><td></td><td class="k">${esc(L.date)}</td><td></td></tr>
  <tr><td class="k">${esc(L.totalMarks)}</td><td>${totalMarks(questions)}</td><td class="k">${esc(L.obtainedMarks)}</td><td></td></tr>
</table>
<div class="instructions"><b>${esc(L.instructions)}</b>
  <ol>${L.instructionLines.map((i) => `<li>${esc(i)}</li>`).join('')}</ol>
</div>
${body.join('\n')}
</body></html>`;
}

/** The text a question asks, short enough to sit beside its answer. */
function questionLabel(question) {
  if (typeof question === 'string') return question;
  return question.question || question.main_question || '';
}

/**
 * The answer key, as a document of its own: every question in the order and
 * under the number the paper printed it, with its answer beside it. A question
 * the model gave no answer for still appears, so the numbering matches the
 * paper and the teacher sees the gap rather than a renumbered list.
 */
function renderAnswerKey({ examJson, grade, subject, language = 'en', schoolName, pageReference,
                           chapterTitle, version = 1 }) {
  const questions = collectQuestions(examJson);
  const rtl = isRtl(language);
  const lang = esc(baseLanguage(language));
  const L = labelsFor(language);
  const dash = '—';

  const rows = [];
  let number = 1;
  let lastType = null;
  for (const { type, question } of questions) {
    if (type !== lastType) {
      if (type && !GENERIC_TYPES.has(String(type).trim().toLowerCase())) {
        rows.push(`<tr class="type"><td colspan="3">${esc(typeLabel(type, L))}</td></tr>`);
      }
      lastType = type;
    }
    let answer;
    const subsAnswered = question && Array.isArray(question.questions)
      && question.questions.some((q) => q && typeof q === 'object' && q.answer);
    if (question && Array.isArray(question.questions) && question.passage
        && !subsAnswered && question.answer) {
      // The model wrote the comprehension answer once, on the passage, and it
      // could not be split per sub-question: print it whole rather than a dash
      // beside every part.
      answer = escMultiline(question.answer);
    } else if (question && Array.isArray(question.questions) && question.passage) {
      answer = question.questions.map((sub, i) => {
        const letter = String.fromCharCode(97 + i);
        const a = typeof sub === 'object' && sub.answer ? esc(sub.answer) : dash;
        return `<div><b>${letter})</b> ${a}</div>`;
      }).join('');
    } else if (question && Array.isArray(question.words) && question.words.length && !question.answer) {
      answer = dash;
    } else {
      answer = question && question.answer ? escMultiline(question.answer) : dash;
    }
    rows.push(`<tr><td class="num">${number}.</td><td class="qt">${esc(questionLabel(question))}</td><td class="ans">${answer}</td></tr>`);
    number += 1;
  }

  const heading = headingOf(grade, subject, L);
  const sub = subLineOf(chapterTitle, pageReference, version, L);

  return `<!DOCTYPE html>
<html lang="${lang}"${rtl ? ' dir="rtl"' : ''}>
<head><meta charset="utf-8"><title>${heading} · ${esc(L.answerKey)}</title>
<style>
  @page { size: A4; margin: 14mm 12mm; }
  ${fontFaces(language)}
  body { font-family: ${rtl
    ? "'PaperScript','PaperLatin',serif"
    : "'PaperLatin',Arial,sans-serif"}; font-size: ${rtl ? '13pt' : '11.5pt'};
    color: #000; line-height: ${rtl ? 1.9 : 1.45}; margin: 0; padding: 0 2px; }
  .num, .marks { direction: ltr; unicode-bidi: isolate; }
  .title, .teacher { direction: ${L.rtl ? 'rtl' : 'ltr'}; unicode-bidi: isolate; }
  .school { text-align: center; font-weight: 700; font-size: 13pt; }
  .class-line { text-align: center; font-size: 11.5pt; margin: 2px 0 2px; }
  .title { text-align: center; font-size: 15pt; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; margin: 6px 0 2px; }
  .chapter { text-align: center; font-size: 10.5pt; color: #333; margin-bottom: 12px; }
  .teacher { border: 1px solid #999; padding: 6px 10px; font-size: 10.5pt; margin-bottom: 12px; color: #222; }
  table.key { width: 100%; border-collapse: collapse; }
  table.key td { border-bottom: 1px solid #ccc; padding: 6px 7px; vertical-align: top; }
  table.key td.num { width: 8%; font-weight: 700; white-space: nowrap; }
  table.key td.qt { width: 46%; color: #333; }
  table.key td.ans { width: 46%; font-weight: 600; }
  table.key tr.type td { border-bottom: 1.5px solid #000; font-size: 10.5pt; font-weight: 700;
    text-transform: uppercase; letter-spacing: .04em; padding-top: 14px; }
  tr { page-break-inside: avoid; }
</style></head>
<body>
${schoolName ? `<div class="school">${esc(schoolName)}</div>` : ''}
<div class="class-line">${heading}</div>
<div class="title">${esc(L.answerKey)}</div>
${sub ? `<div class="chapter">${sub}</div>` : ''}
<div class="teacher">${esc(L.teacherNote(dash))}</div>
<table class="key">
${rows.join('\n')}
</table>
</body></html>`;
}

module.exports = {
  renderPaper, renderAnswerKey, collectQuestions, totalMarks, renderQuestion,
  answerLinesFor, storedLines, MAX_STORED_LINES,
  NO_LINES, isRtl, baseLanguage, scriptFontFor, subjectName,
};
