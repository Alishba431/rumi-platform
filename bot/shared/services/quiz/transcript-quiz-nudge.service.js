'use strict';
/**
 * Lesson quiz — the one nudge. Some hours after the link went out, if fewer
 * than a handful of children have started, the teacher is told how many have
 * and asked whether the link is worth forwarding again. Once per TEACHER per
 * school day, never during quiet hours, never twice.
 *
 * The three rules, and why:
 *
 *   THE WAIT   six hours by default (TRANSCRIPT_QUIZ_NUDGE_AFTER_MINUTES). A
 *              shorter wait catches a class that simply has not got home yet,
 *              and reminders that nobody has started read as nagging.
 *   QUIET      the school's quiet hours (QUIET_HOURS in SCHOOL_TIMEZONE,
 *              school-clock) defer a nudge to the window's end, never drop it:
 *              "nobody has opened your quiz" is not a message for late evening.
 *   ONE A DAY  a teacher who records several lessons should not collect several
 *              separate "nobody has started" messages. One message names the
 *              quiet lessons together; every one of them is stamped, so none
 *              can nudge on its own later.
 */

const supabase = require('../../config/supabase');
const WhatsAppService = require('../whatsapp.service');
const { logToFile } = require('../../utils/logger');
const { logEvent } = require('../../utils/structured-logger');
const { resolveUx } = require('../../config/ux-strings');
const { deferOutOfQuiet, localDate, atLocalTime } = require('../../config/school-clock');
const { teacherLanguageFor, isolate } = require('./transcript-quiz-language');
const { excludeSelfTests } = require('./teacher-self-test');
const { oneAttemptPerChild } = require('./one-attempt-per-child');
const { paused } = require('./transcript-quiz-offer.service');

/** The defaults behind TRANSCRIPT_QUIZ_NUDGE_BELOW and TRANSCRIPT_QUIZ_NUDGE_AFTER_MINUTES. */
const NUDGE_BELOW = 5;
const NUDGE_AFTER_MINUTES = 360;

/**
 * Read per call. `globalThis.process`: this module defines its own `process`
 * (the job handler below). Anything unreadable keeps the default.
 */
function envInt(name, fallback, { min = 1 } = {}) {
  const n = Number.parseInt(String(globalThis.process.env[name] || '').trim(), 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/** "Fewer than N have started" — the threshold below which the teacher hears. */
function nudgeBelow() {
  return envInt('TRANSCRIPT_QUIZ_NUDGE_BELOW', NUDGE_BELOW);
}

/**
 * How long after the link goes out the nudge falls due (before the quiet window
 * moves it). Owned HERE, the nudge's own module: the hand-off schedules the job
 * with it and this module decides which nudges are due with it, so the two read
 * one number. It lives here rather than in the hand-off because the hand-off
 * already requires this module — the other direction would be a require cycle.
 */
function nudgeAfterMs() {
  return envInt('TRANSCRIPT_QUIZ_NUDGE_AFTER_MINUTES', NUDGE_AFTER_MINUTES) * 60 * 1000;
}

/**
 * When a nudge due at `when` may actually be sent: `when` itself during the
 * school day, or the end of the quiet window if it falls inside it. DEFERRED,
 * never dropped — the worker re-queues until this instant.
 */
function nudgeTargetUtc(when = new Date()) {
  return deferOutOfQuiet(when);
}

/**
 * What the worker should do with a nudge job it has just picked up.
 *
 * The quiet-hours rule is applied where the job is SCHEDULED, and again here on
 * arrival: a job queued under an older window (or before QUIET_HOURS changed)
 * must not speak in tonight's quiet hours just because its old target said so.
 *
 * @returns {{action:'process'}|{action:'requeue', targetAt:string, delaySeconds:number}}
 */
function nudgeDispatch({ targetAt = null, now = new Date() } = {}) {
  const at = now instanceof Date ? now : new Date(now);
  const due = targetAt ? new Date(targetAt) : null;
  const when = due && due > at ? due : at;
  const allowed = nudgeTargetUtc(when);
  if (allowed <= at) return { action: 'process' };
  // SQS caps DelaySeconds at 900, so a long hold is a chain of short hops.
  const wait = Math.min(900, Math.max(1, Math.ceil((allowed - at) / 1000)));
  return { action: 'requeue', targetAt: allowed.toISOString(), delaySeconds: wait };
}

/** Midnight, school time, of the day `now` falls in, as a UTC ISO string. */
function schoolDayStartIso(now = new Date()) {
  return atLocalTime(localDate(now), 0, 0).toISOString();
}

/** How many REAL children have started this quiz — once each, however many
 *  times they opened it (one attempt per child, as the class report counts);
 *  the teacher's own run never counts. */
async function startedFor(quizId, teacherId) {
  const { data: sessions } = await supabase.from('quiz_sessions')
    .select('id, user_id, student_id, status, completed_at, created_at')
    .eq('quiz_id', quizId).is('invited_by_student_id', null);
  return oneAttemptPerChild(excludeSelfTests(sessions || [], teacherId)).length;
}

/**
 * A quiz title as it sits in a nudge: bold, and isolated so it keeps its own
 * direction whatever the sentence's (an Urdu title in an English nudge, or the
 * reverse). Titles can contain the list comma themselves, so the bold is also
 * what shows where one title ends and the next begins.
 */
function titled(topic, language) {
  const text = String(topic || '').trim() || resolveUx('tqLessonWord', { language });
  return `*${isolate(text)}*`;
}

/** How far back a sent quiz is looked for when gathering nudges due today. A due
 *  nudge was sent at least the wait ago and at most the wait plus one night; two
 *  days is slack, and the rule below does the deciding. */
const DUE_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Has this quiz's OWN nudge fallen due within the last day? Its job was queued at
 * first send for the wait later, pushed out of the quiet window — the same target
 * the hand-off computes. A quiz already stamped (`nudged_at`) never is.
 */
function ownNudgeDueToday(q, now = new Date()) {
  const meta = q && q.meta ? q.meta : {};
  if (!q || q.status !== 'sent' || meta.nudged_at || !meta.sent_at) return false;
  const sentMs = Date.parse(meta.sent_at);
  if (!Number.isFinite(sentMs)) return false;
  const due = nudgeTargetUtc(new Date(sentMs + nudgeAfterMs())).getTime();
  return due <= now.getTime() && due > now.getTime() - 24 * 60 * 60 * 1000;
}

/** None, one, several — "0 student(s)" is not a sentence. */
function nudgeKeyFor(started) {
  if (started <= 0) return 'tqNudgeNone';
  if (started === 1) return 'tqNudgeOne';
  return 'tqNudge';
}

async function process(quizId) {
  // Switched off in the console after the nudge was queued: no nudge.
  if (paused()) return { skipped: 'paused' };
  const { data: quiz } = await supabase.from('quizzes')
    .select('id, teacher_id, topic, status, language, meta').eq('id', quizId).maybeSingle();
  if (!quiz) return { skipped: 'quiz_not_found' };
  if (quiz.status !== 'sent') return { skipped: `status_${quiz.status}` };
  if (quiz.meta?.nudged_at) return { skipped: 'already_nudged' };

  const now = new Date();
  const dayStart = schoolDayStartIso(now);

  // ONE a day, counted on the day the teacher was NUDGED. The day a quiz was MADE
  // is the wrong key: a quiz row is made when the quiz is offered and can be sent
  // days later from /quiz, so several older quizzes sent in one evening all have
  // their nudges held to the same morning — and not one of them was "made
  // today", so none could see that another had already spoken.
  const { data: nudgedToday, error: nudgedErr } = await supabase.from('quizzes')
    .select('id, meta').eq('teacher_id', quiz.teacher_id)
    .gte('meta->>nudged_at', dayStart);
  if (nudgedErr) {
    logToFile('❌ transcript quiz nudge: could not read today\'s nudges', { quizId, error: nudgedErr.message }, 'error');
  }
  if ((nudgedToday || []).some((q) => q.id !== quiz.id && (q.meta || {}).nudged_at >= dayStart)) {
    return { skipped: 'teacher_nudged_today' };
  }

  // The OTHER quiet lessons that ride in this message: the ones made today (as
  // before), and the ones whose own nudge falls due today by now — those are the
  // jobs that would otherwise each speak a few minutes after this one.
  const since = new Date(now.getTime() - DUE_LOOKBACK_MS).toISOString();
  const [{ data: sameDay }, { data: recentlySent }] = await Promise.all([
    supabase.from('quizzes')
      .select('id, topic, status, meta').eq('teacher_id', quiz.teacher_id)
      .gte('created_at', dayStart),
    supabase.from('quizzes')
      .select('id, topic, status, meta').eq('teacher_id', quiz.teacher_id)
      .eq('status', 'sent').gte('meta->>sent_at', since),
  ]);
  const byId = new Map();
  for (const q of sameDay || []) byId.set(q.id, q);
  for (const q of recentlySent || []) if (ownNudgeDueToday(q, now)) byId.set(q.id, q);
  byId.delete(quiz.id);
  const others = [...byId.values()];

  // This count decides whether a teacher is told "only N children have
  // started"; their own test run of the class link must not read as "started".
  const below = nudgeBelow();
  const started = await startedFor(quiz.id, quiz.teacher_id);
  if (started >= below) return { skipped: 'enough_started', started };

  // Gather the teacher's OTHER quiet lessons from today so they ride in the
  // same message rather than arriving as separate nags.
  const quiet = [{ id: quiz.id, topic: quiz.topic || '', started }];
  for (const q of others) {
    if (q.status !== 'sent' || (q.meta || {}).nudged_at) continue;
    const n = await startedFor(q.id, quiz.teacher_id);
    if (n < below) quiet.push({ id: q.id, topic: q.topic || '', started: n, meta: q.meta });
  }

  const { data: teacher } = await supabase.from('users')
    .select('phone_number, preferred_language').eq('id', quiz.teacher_id).maybeSingle();
  // The chat the hand-off went to (see transcript-quiz-handoff `teacher_to`);
  // users.phone_number only for a quiz sent before that was recorded.
  const to = (quiz.meta || {}).teacher_to || (teacher && teacher.phone_number);
  if (!to) return { skipped: 'no_phone' };
  const lang = teacherLanguageFor({ preferredLanguage: teacher && teacher.preferred_language });

  const body = quiet.length === 1
    ? resolveUx(nudgeKeyFor(started), { language: lang, params: { started, topic: titled(quiz.topic, lang) } })
    : resolveUx('tqNudgeMany', {
      language: lang,
      params: {
        count: quiet.length,
        // The teacher's language's own list comma (", " / "، "), never one
        // language's for every teacher.
        topics: quiet.map((q) => q.topic).filter(Boolean).map((t) => titled(t, lang))
          .join(resolveUx('vqLetterSep', { language: lang })),
      },
    });
  // THE CLAIM, before the send: stamp this quiz nudged only if nobody else has
  // (compare-and-set on `nudged_at`). A Standard queue can deliver the job
  // twice; the run that loses the stamp sends nothing.
  const at = new Date().toISOString();
  const { data: claimed } = await supabase.from('quizzes')
    .update({ meta: { ...(quiz.meta || {}), nudged_at: at, nudge_started: started } })
    .eq('id', quiz.id).is('meta->>nudged_at', null)
    .select('id');
  if (!claimed || !claimed.length) return { skipped: 'already_nudged' };

  const ok = await WhatsAppService.sendMessage(to, body);
  for (const q of quiet.slice(1)) {
    await supabase.from('quizzes')
      .update({ meta: { ...(q.meta || {}), nudged_at: at, nudge_started: q.started, nudged_with: quiz.id } })
      .eq('id', q.id);
  }

  logEvent('transcript_quiz.nudged', {
    quizId, started, sent: Boolean(ok), lessons: quiet.length, quizIds: quiet.map((q) => q.id),
  });
  if (!ok) logToFile('⚠️ transcript quiz: nudge not delivered', { quizId });
  return { ok: true, started, quizIds: quiet.map((q) => q.id) };
}

module.exports = {
  process, nudgeDispatch, nudgeTargetUtc, nudgeAfterMs, nudgeBelow, schoolDayStartIso, ownNudgeDueToday,
  NUDGE_BELOW, NUDGE_AFTER_MINUTES,
};
