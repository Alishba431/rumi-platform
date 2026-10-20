'use strict';
/**
 * /quiz on a TOPIC — `/quiz fractions`, or the menu's "Quiz on any topic" row
 * followed by the topic typed in reply.
 *
 * There is no lesson behind a topic quiz: no recording, no plan. The digest
 * writes the objectives a lesson on the topic would have for the teacher's
 * grade and subject, and every surface says "a quiz on this topic", never "what
 * you taught" or "what you planned" (quiz-sources TOPIC).
 *
 * The row is the quiz from the start: `quiz_source='topic'`, the topic as
 * typed, and the grade and subject the teacher's profile names when it names
 * exactly one of each (a teacher of grades 4 and 5 is not guessed for). With
 * more than one QUIZ_LANGUAGES the language is asked first, through the same
 * ask the coaching offer uses; otherwise it is queued straight away.
 *
 * The "type the topic" step is one pending answer per handset, kept in Redis
 * (an in-memory fallback when Redis is down) for AWAIT_TTL_SECONDS. The text
 * door asks consumeTopicReply first; a slash command or a fresh /quiz request
 * cancels it rather than becoming the topic.
 */

const supabase = require('../../../config/supabase');
const WhatsAppService = require('../../whatsapp.service');
const { logToFile } = require('../../../utils/logger');
const { logEvent } = require('../../../utils/structured-logger');
const { resolveUx } = require('../../../config/ux-strings');
const { localDate } = require('../../../config/school-clock');
const { teacherLanguageFor, quizLanguageFor, needsLanguageAsk } = require('../transcript-quiz-language');
const { sendLanguageAsk } = require('../transcript-quiz-offer.service');
const { enqueueGenerate } = require('../transcript-lesson-provider');
const { isQuizMenuRequest } = require('../quiz-menu-request');
const { TOPIC, failureCopyKey } = require('../quiz-sources');
const Funnel = require('../quiz-funnel');

const AWAIT_PREFIX = 'quiz:awaiting_topic:';
/** Long enough to think of a topic; short enough that a stray message hours later is chat. */
const AWAIT_TTL_SECONDS = 15 * 60;
/** A topic, not a paragraph: the row's title and the forwardable message both carry it. */
const MAX_TOPIC_CHARS = 120;
/**
 * The same topic sent twice in quick succession (a double send, a retry while
 * the network was slow) is one quiz. A teacher who asks for the same topic again
 * later gets a new one — that is a real request.
 */
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
const IN_FLIGHT = ['offered', 'generating', 'ready'];

/** In-memory fallback for the pending ask. Map<phone, {expiresAt, value}>. */
const memory = new Map();

function redis() {
  // Lazy: requiring the Redis service opens its connection.
  return require('../../cache/railway-redis.service');
}

async function writePending(phone, value) {
  memory.set(String(phone), { expiresAt: Date.now() + AWAIT_TTL_SECONDS * 1000, value });
  try {
    await redis().set(`${AWAIT_PREFIX}${phone}`, value, AWAIT_TTL_SECONDS);
  } catch (err) {
    logToFile('⚠️ topic quiz: pending ask not stored in Redis (memory only)', { error: err.message });
  }
}

async function readPending(phone) {
  try {
    const v = await redis().get(`${AWAIT_PREFIX}${phone}`);
    if (v) return typeof v === 'string' ? JSON.parse(v) : v;
  } catch (err) {
    logToFile('⚠️ topic quiz: pending ask read failed (checking memory)', { error: err.message });
  }
  const m = memory.get(String(phone));
  if (m && m.expiresAt > Date.now()) return m.value;
  memory.delete(String(phone));
  return null;
}

async function clearPending(phone) {
  memory.delete(String(phone));
  try {
    await redis().delete(`${AWAIT_PREFIX}${phone}`);
  } catch { /* the TTL clears it anyway */ }
}

/** The topic as a row can carry it, or null when nothing is left. */
function cleanTopic(text) {
  const t = String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '')
    .trim();
  if (!t) return null;
  const cps = [...t];
  return cps.length > MAX_TOPIC_CHARS ? cps.slice(0, MAX_TOPIC_CHARS).join('').trim() : t;
}

/**
 * The one value a profile field names, or null. `grades_taught` is free text
 * ("4", "4, 5"); `subjects_taught` is a JSON array (or, on older rows, text).
 */
function singleValue(field) {
  let values;
  if (Array.isArray(field)) values = field;
  else if (field == null) values = [];
  else values = String(field).split(/[,;/|&]|\band\b/i);
  const clean = values.map((v) => String(v == null ? '' : v).trim()).filter(Boolean);
  return clean.length === 1 ? clean[0] : null;
}

/** "What topic?" — and remember that the next message answers it. */
async function askTopic(user, phone, language) {
  const lang = teacherLanguageFor({ preferredLanguage: language || (user && user.preferred_language) });
  await writePending(phone, { userId: (user && user.id) || null, language: lang });
  await WhatsAppService.sendMessage(phone, resolveUx('tqTopicAsk', { language: lang }));
  logEvent('topic_quiz.topic_asked', { userId: (user && user.id) || null });
  return true;
}

async function recentDuplicate(teacherId, topic) {
  const since = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
  const { data, error } = await supabase.from('quizzes')
    .select('id, status')
    .eq('teacher_id', teacherId).eq('quiz_source', TOPIC).eq('topic', topic)
    .in('status', IN_FLIGHT).gte('created_at', since)
    .limit(1);
  if (error) {
    logToFile('⚠️ topic quiz: duplicate check failed (making the quiz anyway)', { error: error.message });
    return null;
  }
  return (data && data[0]) || null;
}

async function markQueueFailed(quizId, meta, err) {
  const failedMeta = {
    ...meta, step: 'failed', error: 'queue_failed', error_detail: `queue: ${err.message}`, failed_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('quizzes').update({ status: 'failed', meta: failedMeta }).eq('id', quizId);
  if (error) logToFile('❌ topic quiz: could not mark the quiz failed', { quizId, error: error.message }, 'error');
  Funnel.emit('generation_failed', { quiz_id: quizId, source: TOPIC, channel: Funnel.channelOf('topic'), reason: 'queue_failed' });
}

/**
 * Make a quiz on `topic` for this teacher. With no topic, ask for one.
 *
 * @param {object} user      the users row (id, preferred_language, grades_taught, subjects_taught)
 * @param {string} from      the teacher's handset
 * @param {string|null} topic what they typed
 * @param {string|null} [language] the teacher's resolved language
 * @returns {Promise<boolean>} true when the teacher was answered
 */
async function startTopicQuiz(user, from, topic, language = null) {
  const lang = teacherLanguageFor({ preferredLanguage: language || (user && user.preferred_language) });
  if (!user || !user.id) return false;
  const t = cleanTopic(topic);
  if (!t) return askTopic(user, from, lang);

  const dup = await recentDuplicate(user.id, t);
  if (dup) {
    await WhatsAppService.sendMessage(from, resolveUx('tqAlreadyMaking', { language: lang }));
    logEvent('topic_quiz.duplicate', { userId: user.id, quizId: dup.id });
    return true;
  }

  const subject = singleValue(user.subjects_taught);
  const grade = singleValue(user.grades_taught);
  // The language the teacher wrote to us in is the nearest thing a topic has to
  // a language of instruction.
  const quizLanguage = quizLanguageFor(subject, lang);
  const ask = needsLanguageAsk(subject);
  const now = new Date().toISOString();
  const meta = {
    step: ask ? 'awaiting_language' : 'digest',
    awaiting_language: ask,
    source: 'topic',
    // The day it was asked for is the day it is listed and dated under in /quiz.
    lesson_date: localDate(new Date()),
    claimed_at: now,
    ...(ask ? {} : { accepted_at: now }),
  };
  const { data: created, error } = await supabase.from('quizzes').insert({
    teacher_id: user.id, quiz_source: TOPIC, topic: t, subject, grade,
    language: ask ? null : quizLanguage,
    status: ask ? 'offered' : 'generating',
    meta,
  }).select('id').single();
  if (error || !created) {
    logToFile('❌ topic quiz: the quiz row could not be written', { userId: user.id, error: error && error.message }, 'error');
    await WhatsAppService.sendMessage(from, resolveUx(failureCopyKey('queue_failed', TOPIC), { language: lang }));
    return true;
  }

  if (ask) {
    await sendLanguageAsk(created.id, from, lang, quizLanguage, { subject });
    logEvent('transcript_quiz.language_asked', { userId: user.id, quizId: created.id, ruleLanguage: quizLanguage, from: 'topic', quiz_source: TOPIC });
    return true;
  }
  try {
    await enqueueGenerate(created.id, from, lang, 'topic', TOPIC);
  } catch (err) {
    logToFile('❌ topic quiz: quiz_generate could not be queued', { quizId: created.id, error: err.message }, 'error');
    await markQueueFailed(created.id, meta, err);
    await WhatsAppService.sendMessage(from, resolveUx(failureCopyKey('queue_failed', TOPIC), { language: lang }));
    return true;
  }
  logEvent('topic_quiz.queued', { userId: user.id, quizId: created.id, hasGrade: Boolean(grade), hasSubject: Boolean(subject) });
  return true;
}

/**
 * The text door's hook: is this message the topic we asked for? A command
 * (`/menu`) or a fresh quiz request is never taken as the topic — it cancels the
 * ask and goes where it was going.
 *
 * @returns {Promise<boolean>} true when the message was consumed as the topic
 */
async function consumeTopicReply(from, text, user) {
  const pending = await readPending(from);
  if (!pending) return false;
  const raw = String(text == null ? '' : text).trim();
  if (pending.userId && user && user.id && pending.userId !== user.id) return false;
  await clearPending(from);
  if (!raw || raw.startsWith('/') || isQuizMenuRequest(raw)) return false;
  return startTopicQuiz(user, from, raw, pending.language);
}

module.exports = {
  startTopicQuiz, askTopic, consumeTopicReply, cleanTopic, singleValue,
  AWAIT_TTL_SECONDS, MAX_TOPIC_CHARS, DUPLICATE_WINDOW_MS,
};
