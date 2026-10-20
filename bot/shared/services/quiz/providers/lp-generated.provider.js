'use strict';
/**
 * /quiz lesson provider — the teacher's own LESSON PLANS (`lesson_plans`, the
 * plans the bot generated for them), and the tap that makes a quiz from one.
 *
 * LISTED: plans from the last LOOKBACK_DAYS that carry something to write a quiz
 * from — the plan text the lesson-plan worker stores in `content`, or the PDF
 * at `pdf_url` the author can read it back from — and have no `lp_generated`
 * quiz yet. A plan with neither is never listed: its tap could only end at "I
 * couldn't make a quiz from that plan".
 *
 * THE TAP claims the plan by INSERT. The unique index
 * `(lesson_plan_id) WHERE quiz_source='lp_generated'` lets exactly one quiz
 * exist per plan, so a double tap, two replicas or an old list tapped again all
 * meet the same 23505, and the caller answers with the quiz that exists
 * (`outcome: 'already'`). Then, as every lesson quiz does: the language ask when
 * there is more than one QUIZ_LANGUAGES, else the one plan-quiz queue step
 * (offer service queueLpQuiz), which tells the teacher it is on its way.
 *
 * Row ids: `tq_pick_lsn_lp_generated_<lesson_plans.id>` (quiz-lesson-providers).
 */

const supabase = require('../../../config/supabase');
const WhatsAppService = require('../../whatsapp.service');
const { logToFile } = require('../../../utils/logger');
const { logEvent } = require('../../../utils/structured-logger');
const { resolveUx } = require('../../../config/ux-strings');
const { localDate } = require('../../../config/school-clock');
const { teacherLanguageFor, quizLanguageFor, needsLanguageAsk } = require('../transcript-quiz-language');
const Offer = require('../transcript-quiz-offer.service');
const { LP_GENERATED } = require('../quiz-sources');
const Funnel = require('../quiz-funnel');

const LOOKBACK_DAYS = 30;
/** Plans read per /quiz: a month of plans is rarely more; a runaway history is capped. */
const MAX_PLANS_READ = 50;
const PLAN_SELECT = 'id, user_id, topic, grade, subject, status, content, pdf_url, created_at';
const QUIZ_SELECT = 'id, teacher_id, lesson_plan_id, quiz_source, status, topic, subject, language, meta, created_at';

/**
 * `lesson_plans.created_at` is a TIMESTAMP without a zone, which PostgREST
 * returns with no offset. It was written in UTC; say so before anything parses
 * it, or the parse would read it in whatever zone the process runs in.
 */
function asUtcIso(ts) {
  if (!ts) return null;
  const s = String(ts);
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : `${s.replace(' ', 'T')}Z`;
  const d = new Date(zoned);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Does the plan carry anything a quiz can be written from? */
function hasSource(plan) {
  if (!plan) return false;
  if (plan.pdf_url && String(plan.pdf_url).trim()) return true;
  const c = plan.content;
  if (c == null) return false;
  if (typeof c === 'string') return c.trim().length > 0;
  if (typeof c === 'object') return Object.keys(c).length > 0;
  return false;
}

/** A plan that finished: the worker marks the ones it gave up on, and those carry nothing. */
function isFinished(plan) {
  return !plan.status || plan.status === 'completed';
}

async function list(teacherId, { limit = 20 } = {}) {
  if (!teacherId) return [];
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: plans, error } = await supabase.from('lesson_plans')
    .select(PLAN_SELECT)
    .eq('user_id', teacherId).gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(MAX_PLANS_READ);
  if (error) {
    logToFile('❌ plan quiz: lesson plans lookup failed — no plan rows in /quiz', { error: error.message }, 'error');
    return [];
  }
  const usable = (plans || []).filter((p) => isFinished(p) && hasSource(p));
  if (!usable.length) return [];

  const { data: quizzes, error: qErr } = await supabase.from('quizzes')
    .select('lesson_plan_id')
    .eq('teacher_id', teacherId).eq('quiz_source', LP_GENERATED)
    .in('lesson_plan_id', usable.map((p) => p.id));
  if (qErr) {
    // Listing a plan that has a quiz would only cost an "already made" on the
    // tap (the claim is the unique index), so the rows are still shown.
    logToFile('⚠️ plan quiz: could not read which plans have a quiz', { error: qErr.message });
  }
  const taken = new Set((quizzes || []).map((q) => q.lesson_plan_id));
  return usable
    .filter((p) => !taken.has(p.id))
    .slice(0, Math.max(0, limit))
    .map((p) => ({
      source: LP_GENERATED,
      lessonRef: p.id,
      date: asUtcIso(p.created_at),
      grade: p.grade || null,
      subject: p.subject || null,
      topic: p.topic || null,
    }));
}

async function existingQuizFor(planId) {
  const { data } = await supabase.from('quizzes')
    .select(QUIZ_SELECT)
    .eq('lesson_plan_id', planId).eq('quiz_source', LP_GENERATED)
    .maybeSingle();
  return data || null;
}

/**
 * The tap on a plan row.
 * @returns {Promise<{outcome:'queued'|'asked'|'already'|'not_found'|'unavailable'|'claim_failed'|'queue_failed', quizId?:string, existing?:object|null}>}
 */
async function start(teacher, lessonRef, { phone, via = 'list' } = {}) {
  const lang = teacherLanguageFor({ preferredLanguage: teacher && teacher.preferred_language });
  if (!teacher || !teacher.id) {
    await WhatsAppService.sendMessage(phone, resolveUx('tqNotYours', { language: lang }));
    return { outcome: 'not_found' };
  }
  const { data: plan } = await supabase.from('lesson_plans')
    .select(PLAN_SELECT)
    .eq('id', lessonRef).eq('user_id', teacher.id)
    .maybeSingle();
  if (!plan) {
    await WhatsAppService.sendMessage(phone, resolveUx('tqNotYours', { language: lang }));
    return { outcome: 'not_found' };
  }
  if (!hasSource(plan)) {
    await WhatsAppService.sendMessage(phone, resolveUx('tqLpLessonUnavailable', { language: lang }));
    logEvent('quiz_menu.lesson_picked', { userId: teacher.id, source: LP_GENERATED, outcome: 'unavailable', via });
    return { outcome: 'unavailable' };
  }

  const subject = plan.subject || null;
  const quizLanguage = quizLanguageFor(subject, lang);
  const ask = needsLanguageAsk(subject);
  const now = new Date().toISOString();
  const planDate = asUtcIso(plan.created_at);
  const { data: created, error } = await supabase.from('quizzes').insert({
    teacher_id: teacher.id, quiz_source: LP_GENERATED, lesson_plan_id: plan.id,
    topic: plan.topic || 'Lesson', subject, grade: plan.grade || null,
    language: ask ? null : quizLanguage,
    status: ask ? 'offered' : 'generating',
    meta: {
      step: ask ? 'awaiting_language' : 'digest',
      awaiting_language: ask,
      source: via,
      // What the quiz is written from (the generate step reads it), and what
      // a remake needs to still be able to name.
      lessons: [{ lesson_plan_id: plan.id }],
      // The school day the plan was made, which /quiz lists and dates it under.
      lesson_date: planDate ? localDate(new Date(planDate)) : localDate(new Date()),
      claimed_at: now,
      ...(ask ? {} : { accepted_at: now }),
    },
  }).select('id').single();

  if (error) {
    if (error.code === '23505') {
      const existing = await existingQuizFor(plan.id);
      logEvent('quiz_menu.lesson_picked', { userId: teacher.id, source: LP_GENERATED, outcome: 'already', via });
      return { outcome: 'already', existing };
    }
    logToFile('❌ plan quiz: the plan could not be claimed', { lessonPlanId: plan.id, error: error.message }, 'error');
    await WhatsAppService.sendMessage(phone, resolveUx('lpQuizCouldNotStartMenu', { language: lang }));
    return { outcome: 'claim_failed' };
  }

  if (ask) {
    await Offer.sendLanguageAsk(created.id, phone, lang, quizLanguage, { subject });
    logEvent('transcript_quiz.language_asked', {
      userId: teacher.id, quizId: created.id, ruleLanguage: quizLanguage, from: via, quiz_source: LP_GENERATED,
    });
    return { outcome: 'asked', quizId: created.id };
  }

  Funnel.emit('accepted', { quiz_id: created.id, teacher_id: teacher.id, source: LP_GENERATED, channel: Funnel.channelOf(via) });
  const queued = await Offer.queueLpQuiz({ quizId: created.id, phone, language: lang });
  logEvent('quiz_menu.lesson_picked', {
    userId: teacher.id, source: LP_GENERATED, outcome: queued ? 'queued' : 'queue_failed', via, quizId: created.id,
  });
  return { outcome: queued ? 'queued' : 'queue_failed', quizId: created.id };
}

module.exports = {
  source: LP_GENERATED,
  labelKey: 'tqRowFromLessonPlan',
  list,
  start,
  hasSource,
  asUtcIso,
  LOOKBACK_DAYS,
};
