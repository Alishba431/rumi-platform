'use strict';
/**
 * The /testpaper conversation: from "make a test" to a queued paper, plus
 * "my papers" and edits.
 *
 *   /testpaper [subject]
 *     → what should it cover?   a loaded textbook · my lesson plans · send a chapter · my papers
 *     → which chapter(s)?       one, several ("1,3"), a range ("1-4") or all (a unit test)
 *     → how big?                quick 10 · standard 20 · full 30 · or a typed mix
 *     → which language?
 *     → queued: the worker writes, stores and sends the paper + answer key
 *
 * Every pick is an interactive list or reply buttons through the messaging
 * facade — native on WhatsApp, a numbered menu on every other channel, whose
 * numeric replies come back as the same ids (see messaging/pending-options.js).
 * Multi-picks and typed mixes are plain text, read here while a pick is
 * pending. Nothing depends on a WhatsApp Flow, so the conversation is the same
 * on Meta, Baileys, Matrix, Slack and Discord.
 *
 * The source text is read HERE, before anything is queued, so a source with
 * nothing in it is told to the teacher straight away — never queued, never
 * turned into an invented paper.
 */

const WhatsAppService = require('../whatsapp.service');
const { logToFile } = require('../../utils/logger');
const { FEATURES, isFeatureAvailable } = require('../../config/feature-availability');
const { LANGUAGES, SUPPORTED_LANGUAGES, getLabel } = require('../../config/supported-languages');
const Sources = require('./testpaper-sources.service');
const Store = require('./testpaper-store.service');
const Session = require('./testpaper-session.service');
const QuestionTypes = require('./question-types');
const { subjectName } = require('./paper-renderer');
const { t } = require('./testpaper-strings');

const ID_PREFIX = 'tp_';
/** Meta list limits: 10 rows, 24-character titles, 72-character descriptions. */
const MAX_ROWS = 10;
const TITLE_MAX = 24;
const DESC_MAX = 72;
/**
 * The most books the first menu shows one row each. Past that, one
 * "Textbooks (N)" row opens a numbered list of every book, so no book is ever
 * out of reach; a subject and grade in the command narrow it.
 */
const MAX_BOOK_ROWS = 6;
/**
 * The longest numbered book list sent as one message. Meta's text body limit
 * is 4096 characters; past this, the list is narrowed by subject, then grade.
 */
const MAX_LIST_CHARS = 3500;
/** Pasted text shorter than this is a message, not a chapter. */
const MIN_PASTE_CHARS = 300;
/** Languages offered after the teacher's own, in this order. */
const LANGUAGE_CHOICES = ['en', 'ur', 'ar', 'hi', 'bn', 'es', 'fr', 'ta-IN'];

const FEATURE = FEATURES.find((f) => f.id === 'test_paper');

/**
 * The operator's switch, checked at every way in — a command, an old button,
 * a pending pick, a document — not only at /testpaper, so "off" means off.
 */
function _enabled() {
  return Boolean(FEATURE) && isFeatureAvailable(FEATURE);
}

function isTestPaperId(id) {
  return typeof id === 'string' && id.startsWith(ID_PREFIX);
}

function fit(text, max = TITLE_MAX) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

function _lang(language) {
  return language || 'en';
}

async function _list(from, { header, body, button, rows }) {
  return WhatsAppService.sendInteractiveMessage(from, {
    header: fit(header, 60),
    body,
    action: { button: fit(button || 'Choose', 20), sections: [{ title: fit(header, 24), rows: rows.slice(0, MAX_ROWS) }] },
  });
}

/** Parse "2", "1,3", "1-4", "1, 3 and 5", "all" against N offered items → 1-based indexes. */
function parsePicks(text, count) {
  const s = String(text || '').trim().toLowerCase();
  if (!s) return null;
  if (/^(all|everything|all of them|whole( unit| book)?|سب)$/.test(s)) {
    return Array.from({ length: count }, (_, i) => i + 1);
  }
  if (!/^[\d\s,\-–and&]+$/.test(s)) return null;
  const out = new Set();
  for (const part of s.split(/\s*(?:,|and|&|\s)\s*/).filter(Boolean)) {
    const range = part.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])].sort((x, y) => x - y);
      for (let n = a; n <= b; n += 1) out.add(n);
    } else if (/^\d+$/.test(part)) {
      out.add(Number(part));
    } else {
      return null;
    }
  }
  const picks = [...out].sort((a, b) => a - b);
  if (!picks.length || picks.some((n) => n < 1 || n > count)) return null;
  return picks;
}

function _bookLabel(book) {
  return `${book.grade ? `Grade ${book.grade} · ` : ''}${subjectName(book.subject)}`;
}

/**
 * "science 8", "science grade 8", "grade 8 science", "class 8" or "8" →
 * { subject, grade }. A grade is a bare number of one or two digits.
 */
function parseArgs(arg) {
  const s = String(arg || '').trim();
  const m = s.match(/(?:^|\s)(?:grade|class)?\s*(\d{1,2})(?=\s|$)/i);
  if (!m) return { subject: s || null, grade: null };
  const subject = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`.replace(/\s+/g, ' ').trim();
  return { subject: subject || null, grade: Number(m[1]) };
}

// ── Entry ───────────────────────────────────────────────────────────────────

/**
 * `/testpaper`, `/paper` — optionally with a subject ("/testpaper science") or
 * "my papers".
 */
async function start({ user, from, args = '', language }) {
  const lang = _lang(language);
  if (!_enabled()) {
    await WhatsAppService.sendMessage(from, t('notReady', lang));
    return;
  }
  if (!user?.id) {
    await WhatsAppService.sendMessage(from, t('noAccount', lang));
    return;
  }

  const arg = String(args || '').trim();
  if (/^(my\s*)?papers?$|^mine$/i.test(arg)) {
    await showMyPapers({ user, from, language: lang });
    return;
  }

  const { subject, grade } = parseArgs(arg);
  const sources = await Sources.listSources(user.id, { subject, grade });

  if (Sources.isEmpty(sources)) {
    // Nothing to build from. Say so, and accept a chapter sent next.
    const named = [subject, grade != null ? `grade ${grade}` : null].filter(Boolean).join(', ') || null;
    await Session.save(user.id, { step: 'await_upload', subject, from });
    await WhatsAppService.sendMessage(from, t('noSource', lang, { subject: named }));
    logToFile('📝 test paper: no source material', { userId: user.id, subject, grade });
    return;
  }

  const books = sources.textbooks.map((b) => ({
    id: b.id, grade: b.grade, subject: b.subject, curriculum: b.curriculum, chapterCount: b.chapterCount,
  }));
  const lessonPlans = sources.lessonPlans.map((lp) => ({ id: lp.id, topic: lp.topic, subject: lp.subject, grade: lp.grade }));
  await Session.save(user.id, { step: 'pick_source', subject, from, books, lessonPlans });

  const rows = books.length <= MAX_BOOK_ROWS
    ? books.map((b, i) => ({
      id: `${ID_PREFIX}src_tb_${i}`,
      title: fit(t('sourceTextbook', lang, { grade: b.grade, subject: subjectName(b.subject) })),
      description: fit(t('sourceTextbookHint', lang, { chapters: b.chapterCount, curriculum: b.curriculum }), DESC_MAX),
    }))
    : [{
      id: `${ID_PREFIX}src_books`,
      title: fit(t('sourceAllBooks', lang, { count: books.length })),
      description: fit(t('sourceAllBooksHint', lang), DESC_MAX),
    }];
  if (lessonPlans.length) {
    rows.push({ id: `${ID_PREFIX}src_lp`, title: fit(t('sourceLessonPlans', lang, { count: lessonPlans.length })) });
  }
  rows.push({ id: `${ID_PREFIX}src_up`, title: fit(t('sourceUpload', lang)), description: fit(t('sourceUploadHint', lang), DESC_MAX) });
  rows.push({ id: `${ID_PREFIX}mine`, title: fit(t('myPapers', lang)) });

  await _list(from, {
    header: t('chooseSourceHeader', lang), body: t('chooseSourceBody', lang), button: t('chooseSourceButton', lang), rows,
  });
}

// ── Steps ───────────────────────────────────────────────────────────────────

async function _offerChapters(user, from, lang, state, bookIndex) {
  const book = state.books?.[bookIndex];
  if (!book) return false;
  const chapters = (await Sources.listChapters(book.id)).map((c) => ({ number: c.number, title: c.title }));
  const label = _bookLabel(book);
  await Session.save(user.id, { ...state, step: 'pick_chapters', book, chapters });

  if (chapters.length <= MAX_ROWS - 1) {
    await _list(from, {
      header: t('pickChaptersHeader', lang, { book: label }),
      body: t('pickChaptersBody', lang),
      rows: [
        ...chapters.map((c) => ({ id: `${ID_PREFIX}ch_${c.number}`, title: fit(`${c.number}. ${c.title}`), description: fit(c.title, DESC_MAX) })),
        { id: `${ID_PREFIX}ch_all`, title: fit(t('allChapters', lang)) },
      ],
    });
  } else {
    // More chapters than a list can hold: a numbered message, answered in text.
    const list = chapters.map((c, i) => `${i + 1}. ${c.title}`).join('\n');
    await WhatsAppService.sendMessage(from, t('pickChaptersText', lang, { book: label, list }));
  }
  return true;
}

function _bookExample(books) {
  const last = books[books.length - 1];
  return [String(last?.subject || 'science').replace(/_/g, ' '), last?.grade].filter((x) => x != null).join(' ');
}

/**
 * Every book as a numbered message, answered in text (see handleText). A list
 * too long for one message is narrowed first: by subject, or by grade when
 * every book is the same subject. Each pick re-enters here with fewer books.
 */
async function _offerBooks(user, from, lang, state) {
  const books = state.books || [];
  const example = _bookExample(books);
  const lines = books
    .map((b, i) => `${i + 1}. ${_bookLabel(b)} — ${t('sourceTextbookHint', lang, { chapters: b.chapterCount, curriculum: b.curriculum })}`);
  const by = ['subject', 'grade'].find((k) => new Set(books.map((b) => String(b[k]))).size > 1);

  if (lines.join('\n').length <= MAX_LIST_CHARS || !by) {
    // Every book of one subject and grade (many editions) and still too long:
    // send what fits rather than a message the channel would refuse.
    while (lines.length > 1 && lines.join('\n').length > MAX_LIST_CHARS) lines.pop();
    await Session.save(user.id, { ...state, books: books.slice(0, lines.length), step: 'pick_book' });
    await WhatsAppService.sendMessage(from, t('pickBookText', lang, { list: lines.join('\n'), example }));
    return true;
  }

  const groups = [];
  for (const b of books) {
    const key = String(b[by]);
    let g = groups.find((x) => x.key === key);
    if (!g) {
      g = { key, label: by === 'grade' ? `Grade ${b.grade}` : subjectName(b.subject), count: 0 };
      groups.push(g);
    }
    g.count += 1;
  }
  if (by === 'subject') groups.sort((x, y) => x.label.localeCompare(y.label));
  await Session.save(user.id, { ...state, step: 'pick_book_group', bookGroupBy: by, bookGroups: groups });
  const list = groups.map((g, i) => `${i + 1}. ${t('bookGroupRow', lang, g)}`).join('\n');
  await WhatsAppService.sendMessage(from, t('pickBookGroupText', lang, { list, by, example }));
  return true;
}

async function _offerLessonPlans(user, from, lang, state) {
  const plans = state.lessonPlans || [];
  await Session.save(user.id, { ...state, step: 'pick_lessons' });
  if (plans.length <= MAX_ROWS - 1) {
    await _list(from, {
      header: t('pickLessonsHeader', lang),
      body: t('pickLessonsBody', lang),
      rows: [
        ...plans.map((lp, i) => ({ id: `${ID_PREFIX}lp_${i}`, title: fit(lp.topic), description: fit(lp.topic, DESC_MAX) })),
        { id: `${ID_PREFIX}lp_all`, title: fit(t('allLessons', lang)) },
      ],
    });
  } else {
    const list = plans.map((lp, i) => `${i + 1}. ${lp.topic}`).join('\n');
    await WhatsAppService.sendMessage(from, t('pickLessonsText', lang, { list }));
  }
  return true;
}

async function _askMix(user, from, lang, state) {
  await Session.save(user.id, { ...state, step: 'pick_mix' });
  await _list(from, {
    header: t('pickMixHeader', lang),
    body: t('pickMixBody', lang),
    rows: [
      { id: `${ID_PREFIX}mix_quick`, title: fit(t('mixQuick', lang)), description: fit(t('mixQuickHint', lang), DESC_MAX) },
      { id: `${ID_PREFIX}mix_standard`, title: fit(t('mixStandard', lang)), description: fit(t('mixStandardHint', lang), DESC_MAX) },
      { id: `${ID_PREFIX}mix_full`, title: fit(t('mixFull', lang)), description: fit(t('mixFullHint', lang), DESC_MAX) },
    ],
  });
  return true;
}

async function _askLanguage(user, from, lang, state) {
  await Session.save(user.id, { ...state, step: 'pick_language' });
  const own = SUPPORTED_LANGUAGES.includes(lang) ? lang : 'en';
  const codes = [own, ...LANGUAGE_CHOICES.filter((c) => c !== own && SUPPORTED_LANGUAGES.includes(c))].slice(0, MAX_ROWS);
  await _list(from, {
    header: t('pickLanguageHeader', lang),
    body: t('pickLanguageBody', lang),
    rows: codes.map((c) => ({
      id: `${ID_PREFIX}lang_${c}`,
      title: fit(LANGUAGES[c]?.native || c),
      description: LANGUAGES[c] && LANGUAGES[c].native !== LANGUAGES[c].english ? fit(LANGUAGES[c].english, DESC_MAX) : undefined,
    })),
  });
  return true;
}

/** The subject the paper's question types are chosen for. */
function _subjectOf(state) {
  if (state.source?.kind === 'textbook') return state.book?.subject || null;
  if (state.source?.kind === 'lesson_plan') {
    const picked = (state.lessonPlans || []).filter((lp) => state.source.lessonPlanIds.includes(lp.id));
    return picked.find((lp) => lp.subject)?.subject || null;
  }
  // An upload's subject is read from the chapter by the model. The subject the
  // teacher searched for may be exactly the one that had no material.
  return null;
}

function _gradeOf(state) {
  if (state.source?.kind === 'textbook') return state.book?.grade ?? null;
  if (state.source?.kind === 'lesson_plan') {
    const picked = (state.lessonPlans || []).filter((lp) => state.source.lessonPlanIds.includes(lp.id));
    return picked.find((lp) => lp.grade)?.grade || null;
  }
  return null;
}

async function _withMix(user, from, lang, state, types) {
  const next = { ...state, questionTypes: types, questionCount: types.reduce((s, q) => s + q.count, 0) };
  return _askLanguage(user, from, lang, next);
}

/** Read the material now; refuse here, honestly, when there is none. */
async function _loadSource(state, userId) {
  const src = state.source;
  if (src.kind === 'textbook') {
    const c = await Sources.loadTextbookContent(src.textbookId, src.chapterNumbers);
    return { ...c, sourceRef: { textbookId: src.textbookId, chapterNumbers: src.chapterNumbers } };
  }
  if (src.kind === 'lesson_plan') {
    const c = await Sources.loadLessonPlanContent(src.lessonPlanIds, userId);
    return { ...c, sourceRef: { lessonPlanIds: src.lessonPlanIds } };
  }
  return {
    text: src.text,
    subject: null,
    grade: null,
    chapterTitle: src.filename || null,
    label: src.filename ? `Uploaded: ${src.filename}` : 'Pasted chapter',
    sourceRef: src.filename ? { filename: src.filename } : {},
  };
}

async function _queue(user, from, lang, state, paperLanguage) {
  let content;
  try {
    content = await _loadSource(state, user.id);
  } catch (error) {
    if (error.code !== 'INSUFFICIENT_SOURCE') throw error;
    await Session.clear(user.id);
    const message = state.source.kind === 'lesson_plan'
      ? t('insufficientLessons', lang, { skipped: error.skipped })
      : t('insufficient', lang, { what: state.book ? _bookLabel(state.book) : 'that material', reason: error.message.replace(/\.$/, '').toLowerCase() });
    await WhatsAppService.sendMessage(from, message);
    logToFile('📝 test paper: source refused before queueing', { userId: user.id, kind: state.source.kind, error: error.message });
    return;
  }

  const request = await Store.createRequest({
    userId: user.id,
    sourceKind: state.source.kind,
    sourceRef: content.sourceRef,
    sourceLabel: content.label,
    sourceText: content.text,
    subject: content.subject || _subjectOf(state),
    grade: content.grade ?? _gradeOf(state),
    language: paperLanguage,
    contentSource: 'unseen',
    questionTypes: state.questionTypes,
    questionCount: state.questionCount,
  });
  const paper = await Store.createPaper({ requestId: request.id });
  await Session.clear(user.id);

  try {
    // eslint-disable-next-line global-require -- the queue driver dials its backend on require
    const Queue = require('../queue');
    await Queue.queueJob(user.id, 'testpaper_generate', { paperId: paper.id, userId: user.id, to: from, chatLanguage: lang });
  } catch (error) {
    await Store.markFailed(paper.id, 'QUEUE_UNAVAILABLE', error.message);
    logToFile('❌ test paper: could not queue', { userId: user.id, error: error.message });
    await WhatsAppService.sendMessage(from, t('failedQueue', lang));
    return;
  }

  await WhatsAppService.sendMessage(from, t('making', lang, {
    label: content.label, count: state.questionCount, language: getLabel(paperLanguage),
  }));
  logToFile('📝 test paper queued', { userId: user.id, paperId: paper.id, kind: state.source.kind, language: paperLanguage });
}

// ── My papers / edits ───────────────────────────────────────────────────────

async function showMyPapers({ user, from, language }) {
  const lang = _lang(language);
  if (!_enabled()) {
    await WhatsAppService.sendMessage(from, t('notReady', lang));
    return;
  }
  const papers = await Store.listPapers(user.id, MAX_ROWS);
  if (!papers.length) {
    await WhatsAppService.sendMessage(from, t('noPapers', lang));
    return;
  }
  await _list(from, {
    header: t('myPapersHeader', lang),
    body: t('myPapersBody', lang),
    rows: papers.map((p) => ({
      id: `${ID_PREFIX}open_${p.paperId}`,
      title: fit(t('paperRow', lang, { title: p.title || p.sourceLabel || 'Test paper', version: p.version })),
      description: fit([p.sourceLabel, p.questionCount ? `${p.questionCount} Qs` : null].filter(Boolean).join(' · '), DESC_MAX),
    })),
  });
}

async function _resend(user, from, lang, paperId) {
  const found = await Store.getPaper(paperId, user.id);
  if (!found || found.paper.status !== 'ready') {
    await WhatsAppService.sendMessage(from, t('paperGone', lang));
    return;
  }
  // eslint-disable-next-line global-require -- prints through Chromium; loaded only on a re-send
  const Delivery = require('./testpaper-delivery.service');
  await Delivery.deliverPaper({ to: from, paper: found.paper, request: found.request, chatLanguage: lang });
}

async function _askEdit(user, from, lang, paperId) {
  const found = await Store.getPaper(paperId, user.id);
  if (!found || found.paper.status !== 'ready') {
    await WhatsAppService.sendMessage(from, t('paperGone', lang));
    return;
  }
  await Session.save(user.id, { step: 'await_edit', paperId, from });
  await WhatsAppService.sendMessage(from, t('askEdit', lang));
}

async function _queueEdit(user, from, lang, state, instruction) {
  const found = await Store.getPaper(state.paperId, user.id);
  await Session.clear(user.id);
  if (!found) {
    await WhatsAppService.sendMessage(from, t('paperGone', lang));
    return;
  }
  const next = await Store.createPaper({ requestId: found.request.id, editedFrom: found.paper.id, editInstruction: instruction });
  try {
    // eslint-disable-next-line global-require -- see _queue
    const Queue = require('../queue');
    await Queue.queueJob(user.id, 'testpaper_revise', { paperId: next.id, userId: user.id, to: from, chatLanguage: lang });
  } catch (error) {
    await Store.markFailed(next.id, 'QUEUE_UNAVAILABLE', error.message);
    await WhatsAppService.sendMessage(from, t('failedQueue', lang));
    return;
  }
  await WhatsAppService.sendMessage(from, t('revising', lang, { version: next.version }));
}

// ── Dispatch ────────────────────────────────────────────────────────────────

/**
 * A list row or button the teacher picked (any `tp_` id).
 * @returns {Promise<boolean>} true when the id was ours and handled
 */
async function handleSelection({ user, from, id, language }) {
  if (!isTestPaperId(id) || !user?.id) return false;
  const lang = _lang(language);
  if (!_enabled()) {
    // Our button, so it is answered — but nothing is opened, sent or queued.
    await Session.clear(user.id);
    await WhatsAppService.sendMessage(from, t('notReady', lang));
    return true;
  }
  const rest = id.slice(ID_PREFIX.length);

  if (rest === 'new') { await start({ user, from, language: lang }); return true; }
  if (rest === 'mine') { await Session.clear(user.id); await showMyPapers({ user, from, language: lang }); return true; }
  if (rest.startsWith('open_')) { await _resend(user, from, lang, rest.slice(5)); return true; }
  if (rest.startsWith('edit_')) { await _askEdit(user, from, lang, rest.slice(5)); return true; }

  const state = await Session.get(user.id);
  if (!state) {
    // A menu from an expired conversation: start again rather than guess.
    await start({ user, from, language: lang });
    return true;
  }

  if (rest.startsWith('src_tb_')) return _offerChapters(user, from, lang, state, Number(rest.slice(7)));
  if (rest === 'src_books') return _offerBooks(user, from, lang, state);
  if (rest === 'src_lp') return _offerLessonPlans(user, from, lang, state);
  if (rest === 'src_up') {
    await Session.save(user.id, { ...state, step: 'await_upload' });
    await WhatsAppService.sendMessage(from, t('sendChapter', lang));
    return true;
  }
  if (rest.startsWith('ch_') && state.chapters) {
    const which = rest.slice(3);
    const numbers = which === 'all' ? state.chapters.map((c) => c.number) : [Number(which)];
    return _askMix(user, from, lang, { ...state, source: { kind: 'textbook', textbookId: state.book.id, chapterNumbers: numbers } });
  }
  if (rest.startsWith('lp_') && state.lessonPlans) {
    const which = rest.slice(3);
    const ids = which === 'all' ? state.lessonPlans.map((lp) => lp.id) : [state.lessonPlans[Number(which)]?.id].filter(Boolean);
    if (!ids.length) return false;
    return _askMix(user, from, lang, { ...state, source: { kind: 'lesson_plan', lessonPlanIds: ids } });
  }
  if (rest.startsWith('mix_') && state.source) {
    const mix = QuestionTypes.presetMix(rest.slice(4), _subjectOf(state), _gradeOf(state));
    if (!mix) return false;
    return _withMix(user, from, lang, state, mix);
  }
  if (rest.startsWith('lang_') && state.questionTypes) {
    const code = rest.slice(5);
    await _queue(user, from, lang, state, SUPPORTED_LANGUAGES.includes(code) ? code : 'en');
    return true;
  }
  logToFile('⚠️ test paper: selection out of step', { id, step: state.step });
  return false;
}

function _languageFromText(text) {
  const want = String(text || '').trim().toLowerCase();
  return SUPPORTED_LANGUAGES.find((c) => c.toLowerCase() === want
    || LANGUAGES[c].english.toLowerCase() === want
    || LANGUAGES[c].native.toLowerCase() === want) || null;
}

/**
 * Plain text while a pick is pending: chapter/lesson numbers, a typed mix, a
 * language name, a pasted chapter, or an edit request.
 * @returns {Promise<boolean>} true when the text was an answer and was handled
 */
async function handleText({ user, from, text, language }) {
  if (!user?.id || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('/') || !_enabled()) return false;
  const state = await Session.get(user.id);
  if (!state) return false;
  const lang = _lang(language);

  if (/^(cancel|stop|منسوخ)$/i.test(trimmed)) {
    await Session.clear(user.id);
    await WhatsAppService.sendMessage(from, t('cancelled', lang));
    return true;
  }

  switch (state.step) {
    case 'pick_book_group': {
      const picks = parsePicks(trimmed, state.bookGroups.length);
      if (!picks || picks.length !== 1) {
        if (trimmed.length > 40) return false; // talking, not answering
        await WhatsAppService.sendMessage(from, t('pickAgain', lang));
        return true;
      }
      const group = state.bookGroups[picks[0] - 1];
      const books = state.books.filter((b) => String(b[state.bookGroupBy]) === group.key);
      return _offerBooks(user, from, lang, { ...state, books, bookGroups: undefined, bookGroupBy: undefined });
    }
    case 'pick_book': {
      const picks = parsePicks(trimmed, state.books.length);
      if (!picks || picks.length !== 1) {
        if (trimmed.length > 40) return false; // talking, not answering
        await WhatsAppService.sendMessage(from, t('pickAgain', lang));
        return true;
      }
      return _offerChapters(user, from, lang, state, picks[0] - 1);
    }
    case 'pick_chapters': {
      const picks = parsePicks(trimmed, state.chapters.length);
      if (!picks) {
        if (trimmed.length > 40) return false; // talking, not answering
        await WhatsAppService.sendMessage(from, t('pickAgain', lang));
        return true;
      }
      const numbers = picks.map((i) => state.chapters[i - 1].number);
      return _askMix(user, from, lang, { ...state, source: { kind: 'textbook', textbookId: state.book.id, chapterNumbers: numbers } });
    }
    case 'pick_lessons': {
      const picks = parsePicks(trimmed, state.lessonPlans.length);
      if (!picks) {
        if (trimmed.length > 40) return false;
        await WhatsAppService.sendMessage(from, t('pickAgain', lang));
        return true;
      }
      const ids = picks.map((i) => state.lessonPlans[i - 1].id);
      return _askMix(user, from, lang, { ...state, source: { kind: 'lesson_plan', lessonPlanIds: ids } });
    }
    case 'pick_mix': {
      const preset = trimmed.toLowerCase().match(/^(quick|standard|full)$/);
      const parsed = preset
        ? { ok: true, types: QuestionTypes.presetMix(preset[1], _subjectOf(state), _gradeOf(state)) }
        : QuestionTypes.parseMixText(trimmed, _subjectOf(state), _gradeOf(state));
      if (!parsed.ok) {
        if (!/\d/.test(trimmed)) return false;
        await WhatsAppService.sendMessage(from, parsed.message);
        return true;
      }
      return _withMix(user, from, lang, state, parsed.types);
    }
    case 'pick_language': {
      const code = _languageFromText(trimmed);
      if (!code) return false;
      await _queue(user, from, lang, state, code);
      return true;
    }
    case 'await_upload': {
      if (trimmed.length < MIN_PASTE_CHARS) return false;
      return _askMix(user, from, lang, { ...state, source: { kind: 'upload', text: trimmed, filename: null } });
    }
    case 'await_edit':
      // A bare number or a two-letter reply is a stray (a menu answer typed
      // twice, an "ok"), not a change request — asking again costs a message;
      // treating it as one costs a whole new version built from nothing.
      // A real one-word request ("easier") still goes through.
      if (/^\d+$/.test(trimmed) || trimmed.length < 4) {
        await WhatsAppService.sendMessage(from, t('editTooShort', lang));
        return true;
      }
      await _queueEdit(user, from, lang, state, trimmed);
      return true;
    default:
      return false;
  }
}

/**
 * A document while the conversation is waiting for a chapter. Only a PDF, Word
 * or text file is taken, judged before downloading: anything else (a classroom
 * recording for coaching, a photo) goes on to the bot's other document routes.
 * @returns {Promise<boolean>} true when it was taken as the paper's source
 */
async function handleDocument({ user, from, message, language }) {
  if (!user?.id || !message?.document || !_enabled()) return false;
  const state = await Session.get(user.id);
  if (!state || state.step !== 'await_upload') return false;
  const { id, mime_type: mimeType, filename } = message.document;
  if (!Sources.isChapterFile(mimeType, filename)) return false;
  const lang = _lang(language);

  let text;
  try {
    const buffer = await WhatsAppService.downloadMedia(id);
    text = await Sources.extractUploadText(Buffer.from(buffer), mimeType, filename);
  } catch (error) {
    await WhatsAppService.sendMessage(from, t(error.code === 'UNSUPPORTED_FILE' ? 'uploadUnsupported' : 'uploadFailed', lang));
    logToFile('⚠️ test paper: upload unreadable', { userId: user.id, mimeType, error: error.message });
    return true;
  }
  if (!text || text.length < MIN_PASTE_CHARS) {
    await WhatsAppService.sendMessage(from, t('uploadTooShort', lang));
    return true;
  }
  await WhatsAppService.sendMessage(from, t('uploadRead', lang, { chars: text.length }));
  return _askMix(user, from, lang, { ...state, source: { kind: 'upload', text, filename: filename || 'chapter' } });
}

module.exports = {
  start, handleSelection, handleText, handleDocument, showMyPapers, isTestPaperId, parsePicks, parseArgs,
};
