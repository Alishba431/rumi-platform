'use strict';
/**
 * Lesson quiz — /quiz, the teacher's menu.
 *
 * ONE interactive list (sendInteractiveMessage). Meta shows it as a list;
 * Baileys and the other text drivers show it as numbered text, and the number
 * the teacher replies with comes back as the same row id — so this file never
 * needs to know the channel.
 *
 * Section one lists the teacher's lessons newest-first — recorded coaching
 * lessons, lesson plans the bot made for them that have no quiz yet, and the
 * quizzes already made (plan and topic quizzes included) — each with the state
 * of its quiz (none yet / being made / sent · N started / report sent). A tap
 * makes it, resends the forwardable link, or fetches the class report now.
 *
 * Section two is the other ways to a quiz: a quiz on any topic (the topic is
 * asked, then the topic provider makes it), the video quizzes (the same picker
 * /video opens), and the classic quiz sent to each student's parent's phone
 * (QuizOrchestrator — it needs a class list with parents' numbers, which is why
 * it is a row here and not the whole of /quiz).
 */

const supabase = require('../../config/supabase');
const WhatsAppService = require('../whatsapp.service');
const { logToFile } = require('../../utils/logger');
const { logEvent } = require('../../utils/structured-logger');
const { resolveUx } = require('../../config/ux-strings');
const { composeTitle, composeLabelledDescription, normaliseTopic } = require('./transcript-quiz-rows');
const { teacherLanguageFor, formatLessonDate, subjectLabel, quizLanguageFor } = require('./transcript-quiz-language');
const { MIN_TRANSCRIPT_CHARS, sendLanguageAsk } = require('./transcript-quiz-offer.service');
const { isQuizMenuRequest } = require('./quiz-menu-request');
const QuizMenuFlags = require('./quiz-menu-flags');
const Providers = require('./quiz-lesson-providers');
const Topic = require('./providers/topic.provider');
// The recorded lessons' own reads and tap (the transcript lesson provider),
// re-exported below under the names every caller already uses.
const {
  countsFor, loadEligibleSessions, enqueueGenerate, claimForGeneration, startTranscriptLesson,
  LINK_PREFIX, REPORT_PREFIX, BACK_PREFIX,
} = require('./transcript-lesson-provider');
const {
  TRANSCRIPT, LP_GENERATED, TOPIC, PLAN_SOURCES, isPlanQuiz, lessonSessionFor, failureCopyKey, failureReasonOf,
  lpRemakeable, lpRemakeableQuiz,
} = require('./quiz-sources');

const PICK_PREFIX = 'tq_pick_';
// A plan or topic quiz has no coaching session to pick, so its row carries the
// quiz. It rides under PICK_PREFIX on purpose: the router already dispatches
// every `tq_pick_` list reply here, so no new route is needed.
const LP_PICK_PREFIX = `${PICK_PREFIX}lp_`;
// The rows that are not a lesson, under PICK_PREFIX for the same reason.
const MENU_PREFIX = `${PICK_PREFIX}menu_`;
const MENU_TOPIC = `${MENU_PREFIX}topic`;
const MENU_VIDEOS = `${MENU_PREFIX}videos`;
const MENU_CLASSIC = `${MENU_PREFIX}classic`;
const PAGE_PREFIX = 'tq_page_';
const MAX_ROWS = 10;            // WhatsApp's hard cap on total rows in one list
const MENU_ROWS = 3;            // topic, video quizzes, classic
const PER_PAGE = MAX_ROWS - MENU_ROWS - 1; // the lessons, one "Older lessons…" row, the menu rows
const TITLE_MAX = 24;
const DESC_MAX = 72;
/** The quizzes that are rows of their own: no coaching session behind them. */
const OWN_ROW_SOURCES = Object.freeze([...PLAN_SOURCES, TOPIC]);
const LP_QUIZ_SELECT = 'id, teacher_id, coaching_session_id, quiz_source, status, topic, subject, language, meta, created_at';

/**
 * Is this text a request for /quiz? `/quiz…` as always, and now every bare
 * spelling a teacher types ("quiz/", "quize", "mera quiz", «کویز») — one
 * matcher, shared with the child's door (quiz-menu-request.js).
 */
function isQuizCommand(text) {
  if (QuizMenuFlags.bareTextToMenu()) return isQuizMenuRequest(text);
  // QUIZ_BARE_TEXT_TO_MENU off: the door as it was — `/quiz…` and three exact words.
  const t = String(text || '').trim();
  if (!t) return false;
  if (/^\/quiz(\s|$)/i.test(t)) return true;
  const low = t.toLowerCase();
  return low === 'quiz' || t === 'کوئز' || t === 'کوئز؟';
}

/**
 * The SIX states a lesson can be in, as far as the menu is concerned. One
 * function so every row, and the tap on it, reads the same taxonomy.
 *
 * @returns {'none'|'offered'|'making'|'sent'|'report_sent'|'failed'}
 */
function quizState(quiz) {
  if (!quiz) return 'none';
  switch (quiz.status) {
    case 'offered': return 'offered';
    case 'generating':
    case 'ready': return 'making';
    case 'sent': return 'sent';
    case 'report_sent': return 'report_sent';
    case 'failed': return 'failed';
    default: return 'none';           // declined, skipped, cancelled
  }
}

/**
 * Is this quiz waiting for the teacher to choose its language?
 *
 * The one `offered` state that is NOT "being made": the teacher said yes, was
 * asked which language, and has not answered. Nothing is queued until they do
 * (the tq_lang_ buttons → startGenerating), so a menu that finds a quiz here
 * must ask again — never say it is on its way.
 */
function isAwaitingLanguage(quiz) {
  return Boolean(quiz && quiz.status === 'offered' && quiz.meta && quiz.meta.awaiting_language === true);
}

function statusLine(quiz, language) {
  const started = quiz?.meta?.started ?? quiz?._started ?? 0;
  const finished = quiz?.meta?.finished ?? quiz?._finished ?? 0;
  switch (quizState(quiz)) {
    // An offer nobody answered, or a yes still waiting for its language: no quiz
    // has been made, and the tap makes it (or asks the language) — the same
    // words as a lesson with no quiz row at all.
    case 'offered': return resolveUx('tqRowNoQuiz', { language });
    case 'making': return resolveUx('tqRowMaking', { language });
    case 'sent': return resolveUx('tqRowSent', { language, params: { started, finished } });
    case 'report_sent': return resolveUx('tqRowReportSent', { language, params: { finished } });
    // "tap to retry" only where the tap DOES retry: every failed transcript row
    // (the tap re-makes it), and a plan row a remake can still help
    // (lpRemakeable — handleLpPick makes it again). A plan row that cannot be
    // made again, and a topic row (asked for again with /quiz <topic>), just say
    // it did not work.
    case 'failed': return resolveUx(
      quiz?.quiz_source === TOPIC || (isPlanQuiz(quiz?.quiz_source) && !lpRemakeable(quiz.meta))
        ? 'tqRowFailedLp' : 'tqRowFailed',
      { language },
    );
    default: return resolveUx('tqRowNoQuiz', { language });
  }
}

/**
 * ONE list: the teacher's lessons, whichever way their quiz was born. A
 * coaching session is an item (joined to its transcript quiz, if any); a plan
 * or topic quiz is an item of its own, dated by the lesson day it carries. One
 * sort, newest first.
 *
 * A lesson whose recording is thinner than the offer gate is left out even if
 * a quiz row already points at it: the author cannot write eight questions
 * from it, so the row could only ever end at "I couldn't make a good quiz".
 *
 * @returns {Array<{kind:'session'|'lp'|'lesson', key:string, session:object, quiz:object|null, date:string}>}
 */
function lessonItems(sessions, quizzes, lessons = []) {
  const all = quizzes || [];
  const bySession = new Map(all.filter((q) => q.quiz_source === TRANSCRIPT).map((q) => [q.coaching_session_id, q]));
  const items = (sessions || [])
    .filter((s) => String(s.transcript_text || '').length >= MIN_TRANSCRIPT_CHARS)
    .map((s) => ({ kind: 'session', key: s.id, session: s, quiz: bySession.get(s.id) || null, date: s.created_at }));
  all.filter((q) => OWN_ROW_SOURCES.includes(q.quiz_source)).forEach((q) => {
    const session = lessonSessionFor(q);
    items.push({
      kind: 'lp', key: `lp_${q.id}`, session, quiz: q, date: session.created_at || q.created_at,
    });
  });
  // A lesson with NO quiz yet from a plan provider (quiz-lesson-providers):
  // listed, made only when tapped. Its pseudo-session carries the fields every
  // row reads (the date, the topic, the subject), so the layout is shared.
  (lessons || []).forEach((l) => {
    items.push({
      kind: 'lesson',
      key: Providers.lessonKey(l),
      session: { created_at: l.date, analysis_data: { topic: l.topic, subject: l.subject } },
      quiz: null,
      date: l.date,
      lesson: l,
    });
  });
  return items.sort((a, b) => new Date(b.date) - new Date(a.date));
}

/**
 * WHERE a row came from, in the teacher's language: "From transcript" for a
 * recorded lesson, "From lesson plan" for a planned one (quiz or not yet),
 * "Quiz on a topic" for a topic — the provider's own label, so a new source
 * brings its own.
 */
function rowLabel(item, language) {
  let source = TRANSCRIPT;
  if (item.kind === 'lp') source = (item.quiz && item.quiz.quiz_source) || LP_GENERATED;
  else if (item.kind === 'lesson') source = item.lesson.source;
  return resolveUx(Providers.labelKeyFor(source), { language });
}

/**
 * Pure: sessions + quizzes + lessons → one page of lesson rows, newest first.
 *
 * ONE FORMAT, EVERY ROW: the title is always `date · subject` (or the date
 * alone), the description is always `label · topic · status` — see
 * transcript-quiz-rows.js. A real topic does not fit the 24-code-point title,
 * so it lives in the 72-code-point description always.
 *
 * Returns `{ rows, page, from, to, total, hasMore }`. `total`/`from`/`to` are
 * 1-based positions within the items this call was handed — `showList` is
 * responsible for handing it enough of them.
 */
function buildRows(sessions, quizzes, language, { page = 1, lessons = [] } = {}) {
  const eligible = lessonItems(sessions, quizzes, lessons);
  const total = eligible.length;
  const p = Number.isFinite(page) && page > 0 ? page : 1;
  const start = (p - 1) * PER_PAGE;
  const slice = eligible.slice(start, start + PER_PAGE);
  const hasMore = total > start + PER_PAGE;

  const rows = slice.map((item) => {
    const { key, session: s, quiz, date: when } = item;
    const topic = quiz?.topic || s.analysis_data?.topic || resolveUx('tqLessonWord', { language });
    const subject = subjectLabel(quiz?.subject || s.analysis_data?.subject, language);
    const status = statusLine(quiz, language);
    const date = formatLessonDate(when, language);
    return {
      id: `${PICK_PREFIX}${key}`,
      title: composeTitle({ date, subject }, TITLE_MAX),
      // QUIZ_MENU_SOURCE_LABELS off: no label — `topic · status`, exactly as before.
      description: composeLabelledDescription({
        label: QuizMenuFlags.sourceLabels() ? rowLabel(item, language) : '', topic, status,
      }, DESC_MAX, { language }),
    };
  });

  if (hasMore) {
    rows.push({
      id: `${PAGE_PREFIX}${p + 1}`,
      title: resolveUx('tqRowOlder', { language }),
      description: resolveUx('tqRowOlderDesc', { language, params: { n: PER_PAGE } }),
    });
  }

  return {
    rows,
    page: p,
    from: total ? start + 1 : 0,
    to: Math.min(start + PER_PAGE, total),
    total,
    hasMore,
  };
}

/**
 * The rows that are not a lesson, in the teacher's language: a quiz on any
 * topic, the video quizzes, and the classic quiz to parents' phones.
 */
function menuRows(language) {
  return [
    { id: MENU_TOPIC, title: resolveUx('tqMenuTopicTitle', { language }), description: resolveUx('tqMenuTopicDesc', { language }) },
    { id: MENU_VIDEOS, title: resolveUx('tqMenuVideoTitle', { language }), description: resolveUx('tqMenuVideoDesc', { language }) },
    { id: MENU_CLASSIC, title: resolveUx('tqMenuClassicTitle', { language }), description: resolveUx('tqMenuClassicDesc', { language }) },
  ];
}

/** Does this teacher have any lesson /quiz could list? */
async function hasEligibleLessons(userId) {
  if (!userId) return false;
  const { sessions } = await loadEligibleSessions(userId, 1);
  if (sessions.length > 0) return true;
  if ((await loadLpQuizzes(userId, 1)).length > 0) return true;
  return (await Providers.listPlanLessons(userId, { limit: 1 })).length > 0;
}

/**
 * The teacher's plan and topic quizzes, newest first — at most `needed`, which
 * is all one page of the union can ever show (the union's top N lies within the
 * top N of each half). Filtered on the owner in the query, never afterwards.
 */
async function loadLpQuizzes(userId, needed) {
  if (!userId) return [];
  const { data, error } = await supabase.from('quizzes')
    .select(LP_QUIZ_SELECT)
    .eq('teacher_id', userId).in('quiz_source', OWN_ROW_SOURCES)
    .order('created_at', { ascending: false })
    .limit(Math.max(1, needed));
  if (error) logToFile('❌ lesson quiz: plan and topic quizzes lookup failed', { userId, error: error.message }, 'error');
  return data || [];
}

/**
 * Everything one page of /quiz needs: the eligible sessions, their transcript
 * quizzes, the plan and topic quizzes, and the started/finished counts stamped
 * on every sent quiz as `_started`/`_finished`.
 */
async function loadLessonPage(userId, needed) {
  // The recorded lessons come through their provider like every other source.
  const recorded = await Providers.providerFor(TRANSCRIPT).list(userId, { limit: needed });
  const sessions = recorded.map((r) => r.session);
  const ids = sessions.map((s) => s.id);
  let quizzes = [];
  if (ids.length) {
    const { data } = await supabase.from('quizzes')
      .select('id, coaching_session_id, quiz_source, status, topic, subject, meta')
      .eq('teacher_id', userId).eq('quiz_source', TRANSCRIPT).in('coaching_session_id', ids);
    quizzes = data || [];
  }
  quizzes = quizzes.concat(await loadLpQuizzes(userId, needed));
  const counts = await countsFor(
    quizzes.filter((q) => ['sent', 'report_sent'].includes(q.status)).map((q) => q.id),
    userId,
  );
  quizzes.forEach((q) => { const c = counts.get(q.id); if (c) { q._started = c.started; q._finished = c.finished; } });
  // Lessons of the plan sources with NO quiz yet — listed, never generated here.
  const lessons = await Providers.listPlanLessons(userId, { limit: needed });
  return { sessions, quizzes, counts, lessons };
}

async function showList(user, phone, language, page = 1) {
  const lang = teacherLanguageFor({ preferredLanguage: language || user?.preferred_language });
  const p = Number.isFinite(page) && page > 0 ? page : 1;
  const { sessions, quizzes, lessons } = await loadLessonPage(user.id, p * PER_PAGE + 1);

  let { rows, from, to } = buildRows(sessions, quizzes, lang, { page: p, lessons });
  // A stale list tapped a week later can ask for a page that no longer exists.
  // The tap means "show me more lessons", so the list is what comes back —
  // not "no lessons yet".
  if (!rows.length && p > 1) {
    ({ rows, from, to } = buildRows(sessions, quizzes, lang, { page: 1, lessons }));
  }
  const more = { title: resolveUx('tqMenuSection', { language: lang }), rows: menuRows(lang) };
  if (!rows.length) {
    // Nothing to list yet: say what makes a lesson appear here, and keep the
    // ways to a quiz that need no lesson one tap away.
    await WhatsAppService.sendInteractiveMessage(phone, {
      header: { type: 'text', text: resolveUx('tqMenuHeader', { language: lang }) },
      body: { text: resolveUx(QuizMenuFlags.lessonRows() ? 'tqListEmptyMenu' : 'tqListEmpty', { language: lang }) },
      action: { button: resolveUx('tqMenuButton', { language: lang }), sections: [more] },
    });
    logEvent('transcript_quiz.list_empty', { userId: user.id });
    return true;
  }
  await WhatsAppService.sendInteractiveMessage(phone, {
    header: { type: 'text', text: resolveUx('tqListHeader', { language: lang, params: { from, to } }) },
    body: { text: resolveUx('tqListBody', { language: lang }) },
    action: {
      button: resolveUx('tqMenuButton', { language: lang }),
      sections: [{ title: resolveUx('tqListSection', { language: lang }), rows }, more],
    },
  });
  logEvent('transcript_quiz.list_shown', {
    userId: user.id, rows: rows.length, page: p, lessonRows: rows.filter((r) => r.id.startsWith(`${PICK_PREFIX}${Providers.LESSON_KEY_PREFIX}`)).length,
  });
  return true;
}

/**
 * "Video quizzes": the student-video picker /video opens — a Meta Flow where
 * one is published (STUDENT_VIDEOS_FLOW_ID), its text conversation on Baileys.
 * Where neither can be shown, the teacher is told the command that reaches it.
 */
async function openVideoQuizzes(user, phone, lang) {
  let sent = false;
  try {
    sent = await WhatsAppService.sendFlow(phone, {
      flowId: process.env.STUDENT_VIDEOS_FLOW_ID || '',
      flowKind: 'student-videos',
      header: resolveUx('tqVideoPickerHeader', { language: lang }),
      body: resolveUx('tqVideoPickerBody', { language: lang }),
      buttonText: resolveUx('tqVideoPickerCta', { language: lang }),
      // The chat rides on the token so the video reaches a teacher on any channel.
      flowToken: `${user?.id || 'anon'}:student-videos:${Date.now()}:${phone}`,
    });
  } catch (err) {
    logToFile('⚠️ quiz menu: the video picker could not be sent', { error: err.message });
  }
  if (!sent) await WhatsAppService.sendMessage(phone, resolveUx('tqVideoQuizzesHint', { language: lang }));
  logEvent('quiz_menu.videos_opened', { userId: user?.id || null, picker: Boolean(sent) });
  return true;
}

/** A tap on one of the rows that are not a lesson. */
async function handleMenuRow(listId, phone, user, { sessionId = null } = {}) {
  const lang = teacherLanguageFor({ preferredLanguage: user?.preferred_language });
  if (listId === MENU_TOPIC) return Topic.askTopic(user, phone, lang);
  if (listId === MENU_VIDEOS) return openVideoQuizzes(user, phone, lang);
  if (listId === MENU_CLASSIC) {
    // The classic quiz, exactly as /quiz started it before the lesson quiz:
    // pick a class, then a topic, sent to each student's parent.
    const QuizOrchestrator = require('./quiz-orchestrator.service');
    await QuizOrchestrator.initiateQuizRequest(user, phone, sessionId, lang, null);
    logEvent('quiz_menu.classic_opened', { userId: user?.id || null });
    return true;
  }
  // A menu row this version does not have (an old list): the menu again.
  await showList(user, phone, lang, 1);
  return true;
}

async function handleListPick(listId, phone, user, { sessionId = null } = {}) {
  if (listId && listId.startsWith(PAGE_PREFIX)) {
    const lang = teacherLanguageFor({ preferredLanguage: user?.preferred_language });
    const parsed = parseInt(listId.slice(PAGE_PREFIX.length), 10);
    const page = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    await showList(user, phone, lang, page);
    return true;
  }
  if (!listId || !listId.startsWith(PICK_PREFIX)) return false;
  if (listId.startsWith(MENU_PREFIX)) return handleMenuRow(listId, phone, user, { sessionId });
  if (listId.startsWith(LP_PICK_PREFIX)) return handleLpPick(listId.slice(LP_PICK_PREFIX.length), phone, user);
  // A lesson with no quiz yet, from any provider (`tq_pick_lsn_<source>_<ref>`):
  // the tap is the request — the provider claims the lesson and makes its quiz.
  const lesson = Providers.parseLessonKey(listId.slice(PICK_PREFIX.length));
  if (lesson) {
    if (!QuizMenuFlags.lessonRows()) {
      // QUIZ_MENU_LESSON_ROWS off: a lesson row from an older list makes nothing.
      const lang = teacherLanguageFor({ preferredLanguage: user?.preferred_language });
      await WhatsAppService.sendMessage(phone, resolveUx('tqLpLessonUnavailable', { language: lang }));
      logEvent('quiz_menu.lesson_picked', { userId: user?.id || null, source: lesson.provider.source, outcome: 'switched_off', via: 'list' });
      return true;
    }
    const out = await lesson.provider.start(user, lesson.lessonRef, { phone, via: 'list' });
    await answerTakenLesson(out, phone, user);
    return true;
  }
  return startTranscriptLesson(user, listId.slice(PICK_PREFIX.length), { phone, via: 'list' });
}

/**
 * A provider's tap came back `already`: the lesson has its quiz (made by the
 * other tap or the other replica). Answer with THAT quiz —
 * its buttons when sent, the language ask again while it waits for one, "still
 * being made" otherwise — exactly as a tap on its quiz row would. With no quiz
 * to show (the other tap holds the claim and is still writing it), "already on
 * it". Any other outcome has already answered the teacher itself.
 */
async function answerTakenLesson(out, phone, user) {
  if (!out || out.outcome !== 'already') return false;
  if (out.existing && out.existing.id) return handleLpPick(out.existing.id, phone, user);
  const lang = teacherLanguageFor({ preferredLanguage: user?.preferred_language });
  await WhatsAppService.sendMessage(phone, resolveUx('tqAlreadyMaking', { language: lang }));
  return true;
}

/**
 * A tap on a plan or topic quiz row. There is no session to make a quiz FROM
 * here — the quiz row already exists — so the choices are the ones a sent quiz
 * has (resend the link, the report, back), a "still making it", a failed plan
 * quiz made AGAIN when a remake can help (lpRemakeable, the list's "tap to
 * retry"), or the failure copy that names the step that stopped when it cannot.
 * Never "make it" from a session: that path claims a coaching session.
 *
 * The one decision still open on such a quiz is its LANGUAGE: with more than
 * one QUIZ_LANGUAGES the row stays `offered` until the teacher picks one. If
 * they ignored that ask, the row says "No quiz yet", and the tap re-sends the
 * ask — "still being made" would be false, because nothing is queued until the
 * ask is answered.
 */
async function handleLpPick(quizId, phone, user) {
  const lang = teacherLanguageFor({ preferredLanguage: user?.preferred_language });
  const { data: quiz } = user?.id ? await supabase.from('quizzes')
    .select(LP_QUIZ_SELECT)
    .eq('id', quizId).eq('teacher_id', user.id).in('quiz_source', OWN_ROW_SOURCES)
    .maybeSingle() : { data: null };
  if (!quiz) {
    await WhatsAppService.sendMessage(phone, resolveUx('tqNotYours', { language: lang }));
    return true;
  }
  const state = quizState(quiz);
  if (state === 'sent' || state === 'report_sent') {
    const counts = await countsFor([quiz.id], user.id);
    const c = counts.get(quiz.id) || { started: 0, finished: 0 };
    await WhatsAppService.sendInteractiveButtons(phone, {
      body: resolveUx('tqQuizStatus', {
        language: lang,
        params: {
          topic: normaliseTopic(quiz.topic || ''),
          date: formatLessonDate(lessonSessionFor(quiz).created_at || quiz.created_at, lang),
          started: c.started, finished: c.finished,
        },
      }),
      buttons: [
        { id: `${LINK_PREFIX}${quiz.id}`, title: resolveUx('tqLinkButton', { language: lang }) },
        { id: `${REPORT_PREFIX}${quiz.id}`, title: resolveUx('tqReportButton', { language: lang }) },
        { id: `${BACK_PREFIX}${quiz.id}`, title: resolveUx('tqBackButton', { language: lang }) },
      ],
    });
    logEvent('transcript_quiz.list_pick', { userId: user.id, quizId: quiz.id, state, quiz_source: quiz.quiz_source });
    return true;
  }
  if (isAwaitingLanguage(quiz)) {
    // The same ask and buttons the offer sent; its answer runs startGenerating,
    // which flips offered → generating atomically and queues the quiz.
    const ruleLanguage = quiz.language || quizLanguageFor(quiz.subject, null);
    await sendLanguageAsk(quiz.id, phone, lang, ruleLanguage, { digest: quiz.meta?.digest, subject: quiz.subject });
    logEvent('transcript_quiz.language_asked', {
      userId: user.id, quizId: quiz.id, ruleLanguage, from: 'list', quiz_source: quiz.quiz_source,
    });
    return true;
  }
  if (state === 'failed' && lpRemakeableQuiz(quiz)) {
    // The list's own promise ("tap to retry"), kept the way a failed transcript
    // row keeps it: the tap makes the quiz again — the atomic failed →
    // generating flip, then the one plan-quiz queue step, which tells the
    // teacher it is on its way.
    const Offer = require('./transcript-quiz-offer.service');
    const remade = await Offer.remakeLpQuiz({ quiz, phone, teacherLang: lang, source: 'list' });
    logEvent('transcript_quiz.list_pick', {
      userId: user.id, quizId: quiz.id, state, remade: Boolean(remade), quiz_source: quiz.quiz_source,
    });
    return true;
  }
  if (state === 'failed') {
    // The reason the generate step persisted, so the sentence repeated here is
    // the one the teacher was sent when it failed (model vs plan, never mixed).
    // The teacher is in /quiz: a start failure's line says what can happen next
    // from here.
    await WhatsAppService.sendMessage(phone, resolveUx(failureCopyKey(failureReasonOf(quiz.meta), quiz.quiz_source, {
      meta: quiz.meta, channel: 'quiz_menu',
    }), { language: lang }));
  } else {
    await WhatsAppService.sendMessage(phone, resolveUx('tqStillMaking', { language: lang }));
  }
  logEvent('transcript_quiz.list_pick', { userId: user.id, quizId: quiz.id, state, quiz_source: quiz.quiz_source });
  return true;
}

async function handleActionButton(buttonId, phone) {
  const isLink = buttonId && buttonId.startsWith(LINK_PREFIX);
  const isReport = buttonId && buttonId.startsWith(REPORT_PREFIX);
  const isBack = buttonId && buttonId.startsWith(BACK_PREFIX);
  if (!isLink && !isReport && !isBack) return false;
  const prefix = isLink ? LINK_PREFIX : isReport ? REPORT_PREFIX : BACK_PREFIX;
  const quizId = buttonId.slice(prefix.length);
  const { data: quiz } = await supabase.from('quizzes')
    .select('id, teacher_id, status, language, topic, meta').eq('id', quizId).maybeSingle();
  if (!quiz) return true;
  const { data: teacher } = await supabase.from('users')
    .select('phone_number, preferred_language').eq('id', quiz.teacher_id).maybeSingle();
  const lang = teacherLanguageFor({ preferredLanguage: teacher?.preferred_language });

  if (isBack) {
    await showList({ id: quiz.teacher_id, preferred_language: teacher?.preferred_language }, phone, lang, 1);
    logEvent('transcript_quiz.list_reopened', { quizId });
    return true;
  }

  if (isLink) {
    // The SAME hand-off the teacher got when the quiz was made: the PDF and
    // then the forwardable message — the same share code, the same link, never
    // a new one (a class that already has a link must not be handed a second).
    // A quiz that has not been handed off yet has no code to reuse, and must
    // not mint one here.
    if (!quiz.meta?.student_message || !quiz.meta?.share_code_id) {
      await WhatsAppService.sendMessage(phone, resolveUx('tqStillMaking', { language: lang }));
      return true;
    }
    const Handoff = require('./transcript-quiz-handoff.service');
    const out = await Handoff.sendHandoff(quizId, phone, { firstSend: false });
    if (!out || !out.ok) {
      await WhatsAppService.sendMessage(phone, resolveUx('tqCouldNotSend', { language: lang }));
    }
    logEvent('transcript_quiz.link_resent', { quizId, reused: Boolean(out && out.reused), pdfSent: Boolean(out && out.pdfSent) });
    return true;
  }

  const shareCodeId = quiz.meta?.share_code_id;
  if (!shareCodeId) {
    await WhatsAppService.sendMessage(phone, resolveUx('tqNoReportYet', { language: lang }));
    return true;
  }
  await WhatsAppService.sendMessage(phone, resolveUx('tqReportComing', { language: lang }));
  const Report = require('./video-quiz-report.service');
  const sent = await Report.generate(shareCodeId, { reason: 'requested', force: true });
  if (!sent) await WhatsAppService.sendMessage(phone, resolveUx('tqNoReportYet', { language: lang }));
  logEvent('transcript_quiz.report_requested', { quizId, sent: Boolean(sent) });
  return true;
}

const { consumeTopicReply, startTopicQuiz } = Topic;

module.exports = {
  isQuizCommand, buildRows, menuRows, showList, handleListPick, handleActionButton, statusLine, countsFor,
  loadEligibleSessions, hasEligibleLessons, quizState, isAwaitingLanguage, claimForGeneration, enqueueGenerate,
  lessonItems, loadLessonPage, loadLpQuizzes, rowLabel, startTranscriptLesson, answerTakenLesson,
  consumeTopicReply, startTopicQuiz,
  PICK_PREFIX, LP_PICK_PREFIX, MENU_PREFIX, MENU_TOPIC, MENU_VIDEOS, MENU_CLASSIC,
  LINK_PREFIX, REPORT_PREFIX, PAGE_PREFIX, BACK_PREFIX, MAX_ROWS, PER_PAGE,
};
