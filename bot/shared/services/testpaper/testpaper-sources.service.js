'use strict';
/**
 * What a test paper can be built from, flattened to the text the generator
 * reads.
 *
 * A paper is only as fair as the material under it, and this deployment's
 * material is whatever it actually holds — not a government textbook
 * catalogue. Three sources, all available to a fresh clone:
 *
 *   1. The teacher's OWN lesson plans (`lesson_plans`): the content saved with
 *      the plan, or failing that the text of its PDF.
 *   2. Textbooks loaded into `textbooks` / `textbook_toc` / `textbook_pages` —
 *      for example by bot/scripts/testpaper/import-curriculum-corpus.js from
 *      the curriculum/ pipeline's page-truth output. TESTPAPER_CURRICULUM
 *      narrows the list to one curriculum when a deployment holds several.
 *   3. A chapter the teacher uploads (PDF, Word, plain text) or pastes.
 *
 * Text comes back with `=== Page N ===` (books) or `=== Lesson: … ===` (lesson
 * plans) markers, so seen questions can be traced to where they came from.
 * Anything that yields no real text is INSUFFICIENT_SOURCE: the teacher is told
 * honestly, and the generator is never asked to fill an empty chapter with
 * questions about things it does not teach.
 */

const supabase = require('../../config/supabase');
const { logToFile } = require('../../utils/logger');
const { familyOf } = require('./question-types');
const { subjectName } = require('./paper-renderer');
const { planTextFromRow } = require('../coaching/fidelity/lesson-plan-text');

/** How many of a teacher's recent lesson plans are offered. */
const LESSON_PLAN_LIMIT = 20;
/** A lesson plan's text has to be at least this long to count as material. */
const MIN_LESSON_CHARS = 200;
/** How long a lesson plan's PDF may take to fetch before it is skipped. */
const PDF_FETCH_TIMEOUT_MS = 20000;

function fail(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function _norm(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Does a source's subject answer to the subject the teacher named? Exact or
 * contained names match ("Science" ~ "General Science"); otherwise two names in
 * the same non-general family do ("Math" ~ "Mathematics").
 */
function sameSubject(have, want) {
  const a = _norm(have);
  const b = _norm(want);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const fa = familyOf(have);
  return fa !== 'general' && fa === familyOf(want);
}

/** A lesson plan with no subject of its own matches on its topic. */
function lessonMatches(lp, want) {
  if (lp.subject) return sameSubject(lp.subject, want);
  const topic = _norm(lp.topic);
  const w = _norm(want);
  if (w && topic.split(' ').some((word) => word === w)) return true;
  const family = familyOf(want);
  return family !== 'general' && familyOf(lp.topic) === family;
}

function _curricula() {
  return String(process.env.TESTPAPER_CURRICULUM || '')
    .split(',').map((c) => c.trim()).filter(Boolean);
}

/**
 * Everything this teacher could build a paper from, optionally narrowed to a
 * subject and/or a grade they named. A plan saved without a grade is kept
 * under any grade. Fails soft: a lookup error lists nothing for that source
 * rather than stopping the conversation.
 *
 * @returns {Promise<{lessonPlans: Array, textbooks: Array}>}
 */
async function listSources(userId, { subject = null, grade = null } = {}) {
  let lessonPlans = [];
  let textbooks = [];

  try {
    const { data } = await supabase
      .from('lesson_plans')
      .select('id, topic, grade, subject, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(LESSON_PLAN_LIMIT);
    lessonPlans = (data || []).filter((lp) => lp.topic);
  } catch (err) {
    logToFile('⚠️ test paper: lesson plan lookup failed', { error: err.message });
  }

  try {
    let query = supabase.from('textbooks').select('id, grade, subject, curriculum');
    const curricula = _curricula();
    if (curricula.length) query = query.in('curriculum', curricula);
    const { data: books } = await query;
    if (books && books.length) {
      const { data: toc } = await supabase
        .from('textbook_toc')
        .select('textbook_id, chapter_number')
        .in('textbook_id', books.map((b) => b.id));
      const counts = new Map();
      for (const row of toc || []) counts.set(row.textbook_id, (counts.get(row.textbook_id) || 0) + 1);
      // A book with no chapters has nothing to pick.
      textbooks = books
        .filter((b) => counts.get(b.id))
        .map((b) => ({ ...b, chapterCount: counts.get(b.id) }))
        .sort((x, y) => (Number(x.grade) - Number(y.grade)) || String(x.subject).localeCompare(String(y.subject)));
    }
  } catch (err) {
    logToFile('⚠️ test paper: textbook lookup failed', { error: err.message });
  }

  if (subject) {
    lessonPlans = lessonPlans.filter((lp) => lessonMatches(lp, subject));
    textbooks = textbooks.filter((tb) => sameSubject(tb.subject, subject));
  }
  if (grade != null) {
    const g = String(grade);
    lessonPlans = lessonPlans.filter((lp) => !lp.grade || String(lp.grade) === g);
    textbooks = textbooks.filter((tb) => String(tb.grade) === g);
  }
  return { lessonPlans, textbooks };
}

function isEmpty(sources) {
  return !sources || (!sources.lessonPlans?.length && !sources.textbooks?.length);
}

async function getTextbook(textbookId) {
  const { data } = await supabase
    .from('textbooks')
    .select('id, grade, subject, curriculum')
    .eq('id', textbookId)
    .maybeSingle();
  return data || null;
}

/** A book's chapters, in order. */
async function listChapters(textbookId) {
  const { data } = await supabase
    .from('textbook_toc')
    .select('chapter_number, chapter_title, page_start, page_end')
    .eq('textbook_id', textbookId)
    .order('chapter_number', { ascending: true });
  return (data || []).map((c) => ({
    number: c.chapter_number, title: c.chapter_title, pageStart: c.page_start, pageEnd: c.page_end,
  }));
}

function _compressPages(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const runs = [];
  for (const n of sorted) {
    const last = runs[runs.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
}

/**
 * One or more chapters of a loaded textbook as page-marked text. Several
 * chapters (a whole unit) come back in chapter order whatever order they were
 * picked in.
 */
async function loadTextbookContent(textbookId, chapterNumbers) {
  const book = await getTextbook(textbookId);
  if (!book) throw fail('INSUFFICIENT_SOURCE', 'That book is no longer loaded.');

  const wanted = new Set((chapterNumbers || []).map(Number));
  const chapters = (await listChapters(textbookId)).filter((c) => wanted.has(Number(c.number)));
  if (!chapters.length) throw fail('INSUFFICIENT_SOURCE', 'Those chapters are not in the book.');

  const pages = [];
  for (const ch of chapters) {
    const { data } = await supabase
      .from('textbook_pages')
      .select('textbook_page_number, page_content')
      .eq('textbook_id', textbookId)
      .gte('textbook_page_number', ch.pageStart)
      .lte('textbook_page_number', ch.pageEnd)
      .order('textbook_page_number', { ascending: true });
    for (const p of data || []) {
      if (p.page_content && p.page_content.trim()) pages.push(p);
    }
  }
  if (!pages.length) {
    throw fail('INSUFFICIENT_SOURCE', 'Those chapters have no text loaded.', { chapters: chapters.map((c) => c.number) });
  }

  const seen = new Set();
  const unique = pages.filter((p) => (seen.has(p.textbook_page_number) ? false : seen.add(p.textbook_page_number)));
  const text = unique.map((p) => `=== Page ${p.textbook_page_number} ===\n${p.page_content.trim()}`).join('\n\n');
  const numbers = chapters.map((c) => c.number);
  const chapterTitle = chapters.length === 1
    ? chapters[0].title
    : `Chapters ${_compressPages(numbers).replace(/-/g, '–')}`;
  const pageReference = _compressPages(unique.map((p) => p.textbook_page_number));

  return {
    text,
    subject: book.subject,
    grade: book.grade,
    chapterTitle,
    pageReference,
    // A subject stored as a code ("math", "social_studies") reads as words.
    label: chapters.length === 1
      ? `${subjectName(book.subject)} · Chapter ${chapters[0].number}: ${chapters[0].title}`
      : `${subjectName(book.subject)} · ${chapterTitle}: ${chapters.map((c) => c.title).join('; ')}`,
  };
}

/**
 * Keys on a lesson_plans row's content that are derived from the plan, not
 * part of it: lesson-plan fidelity caches the plan's extracted moves there.
 */
const NOT_PLAN_TEXT = new Set(['fidelity_moves']);

/**
 * A structured lesson plan as readable text. Keys become headings and every
 * string value is kept, so whatever shape a plan was saved in (a `text` field,
 * a sectioned object, a list of activities) the generator reads all of it.
 */
function flattenContent(content, depth = 0) {
  if (content == null) return '';
  if (typeof content === 'string') return content.trim();
  if (typeof content === 'number' || typeof content === 'boolean') return String(content);
  if (Array.isArray(content)) {
    return content.map((v) => flattenContent(v, depth + 1)).filter(Boolean).join('\n');
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string' && Object.keys(content).length === 1) return content.text.trim();
    return Object.entries(content)
      .filter(([k]) => !(depth === 0 && NOT_PLAN_TEXT.has(k)))
      .map(([k, v]) => {
        const body = flattenContent(v, depth + 1);
        if (!body) return '';
        const heading = k.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
        return `${heading}:\n${body}`;
      })
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

async function _pdfText(buffer) {
  // eslint-disable-next-line global-require -- bot-only dependency, loaded on use
  const pdfParse = require('pdf-parse');
  const out = await pdfParse(buffer);
  return String(out?.text || '').trim();
}

/** A lesson plan's text: its saved content, else its PDF's text, else ''. */
async function _lessonText(lp) {
  // A plan Rumi made stores its PDF's text as content.plan_text, read through
  // the one shared reader; any other saved shape is flattened. Only the
  // content is passed, since the paper already heads each plan with its topic.
  const saved = lp.content && typeof lp.content.plan_text === 'string'
    ? (planTextFromRow({ content: lp.content }) || '')
    : flattenContent(lp.content);
  if (saved.length >= MIN_LESSON_CHARS) return saved;
  if (lp.pdf_url) {
    try {
      // eslint-disable-next-line global-require -- loaded on use, like the PDF parser
      const axios = require('axios');
      const res = await axios.get(lp.pdf_url, { responseType: 'arraybuffer', timeout: PDF_FETCH_TIMEOUT_MS });
      const text = await _pdfText(Buffer.from(res.data));
      if (text.length >= MIN_LESSON_CHARS) return text;
    } catch (err) {
      // Lesson-plan PDF links can be signed and expire; a plan whose PDF is
      // gone is skipped rather than failing the whole paper.
      logToFile('⚠️ test paper: lesson plan PDF unreadable', { lessonPlanId: lp.id, error: err.message });
    }
  }
  return saved;
}

/**
 * One or more of the teacher's own lesson plans as one source, each under its
 * own heading. Plans with no usable text are skipped (and named in `skipped`);
 * if none has any, INSUFFICIENT_SOURCE.
 */
async function loadLessonPlanContent(lessonPlanIds, userId) {
  const { data } = await supabase
    .from('lesson_plans')
    .select('id, topic, grade, subject, content, pdf_url, created_at')
    .eq('user_id', userId)
    .in('id', lessonPlanIds || []);
  const plans = (data || []).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

  const parts = [];
  const used = [];
  const skipped = [];
  for (const lp of plans) {
    const text = await _lessonText(lp);
    if (text.length >= MIN_LESSON_CHARS) {
      parts.push(`=== Lesson: ${lp.topic} ===\n${text}`);
      used.push(lp);
    } else {
      skipped.push(lp.topic);
    }
  }
  if (!used.length) {
    throw fail('INSUFFICIENT_SOURCE', 'Those lesson plans have no saved content to build a paper from.', { skipped });
  }

  const subject = used.find((lp) => lp.subject)?.subject || null;
  const grade = used.find((lp) => lp.grade)?.grade || null;
  const chapterTitle = used.length === 1 ? used[0].topic : `${used.length} lessons`;
  return {
    text: parts.join('\n\n'),
    subject,
    grade,
    chapterTitle,
    pageReference: null,
    label: used.length === 1 ? `Lesson plan: ${used[0].topic}` : `Lesson plans: ${used.map((lp) => lp.topic).join('; ')}`,
    skipped,
  };
}

const DOCX_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
];

function _fileKind(mimeType, filename) {
  const type = String(mimeType || '').toLowerCase();
  const name = String(filename || '').toLowerCase();
  // A recording or a photo is never a chapter, whatever it is named.
  if (/^(audio|video|image)\//.test(type)) return null;
  if (type.includes('pdf') || name.endsWith('.pdf')) return 'pdf';
  if (DOCX_TYPES.includes(type) || name.endsWith('.docx') || name.endsWith('.doc')) return 'word';
  if (type.startsWith('text/') || name.endsWith('.txt') || name.endsWith('.md')) return 'text';
  return null;
}

/**
 * Could this document be a chapter (PDF, Word, plain text)? Decided from its
 * type and name alone, before anything is downloaded, so a classroom recording
 * or a photo sent while a chapter is awaited goes on to its own handler.
 */
function isChapterFile(mimeType, filename) {
  return _fileKind(mimeType, filename) !== null;
}

/**
 * The text of an uploaded chapter. PDF via pdf-parse, Word via mammoth, plain
 * text as is. A scanned PDF with no text layer comes back short and is caught
 * as INSUFFICIENT_SOURCE by the caller, with a hint to send the text instead.
 */
async function extractUploadText(buffer, mimeType = '', filename = '') {
  const kind = _fileKind(mimeType, filename);
  if (kind === 'pdf') return _pdfText(buffer);
  if (kind === 'word') {
    // eslint-disable-next-line global-require -- bot-only dependency, loaded on use
    const mammoth = require('mammoth');
    const out = await mammoth.extractRawText({ buffer });
    return String(out?.value || '').trim();
  }
  if (kind === 'text') return buffer.toString('utf8').trim();
  throw fail('UNSUPPORTED_FILE', 'Send the chapter as a PDF, a Word document or plain text.', { mimeType: String(mimeType || '').toLowerCase() });
}

module.exports = {
  listSources, isEmpty, listChapters, getTextbook, loadTextbookContent, loadLessonPlanContent,
  extractUploadText, isChapterFile, flattenContent, sameSubject, MIN_LESSON_CHARS,
};
