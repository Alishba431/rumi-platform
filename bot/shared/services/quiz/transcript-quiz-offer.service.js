'use strict';
/**
 * Transcript quiz — THE OFFER.
 *
 * After a coaching report lands, the teacher is asked once whether they want
 * a quiz written from what they just taught. Once per TEACHER, not per report:
 * the offer introduces the feature; after that the path is /quiz. Asking after
 * every report trains teachers to ignore the question.
 * TRANSCRIPT_QUIZ_OFFER_MODE=every keeps the alternative one env flip away.
 *
 * TIMING. The survey buttons go out ~90 s after the report. The offer is
 * queued for +240 s so it never competes with them, and the survey answer
 * itself brings it forward (triggerEarly) — whichever job runs first wins the
 * per-session claim, the other is a no-op.
 *
 * STATE lives in `quizzes` (quiz_source='transcript', one row per coaching
 * session, enforced by a unique partial index). The offer job claims the row
 * with status 'generating', digests, flips it to 'offered' and sends the
 * buttons; the buttons flip it to 'generating' (yes) or 'declined' (no)
 * exactly once, however many times they are tapped.
 *
 * The offer is plain buttons: every channel driver renders them (natively on
 * Meta, Slack and Discord; as a numbered menu on Baileys), so nothing here
 * depends on the channel.
 *
 * FLAG-GATED, read at call time: TRANSCRIPT_QUIZ_ENABLED. With it unset a
 * deployment that pulls this code changes nothing for teachers.
 */

const supabase = require('../../config/supabase');
const WhatsAppService = require('../whatsapp.service');
const { logToFile } = require('../../utils/logger');
const { logEvent } = require('../../utils/structured-logger');
const { resolveUx } = require('../../config/ux-strings');
const FeatureIntro = require('../feature-intro.service');
const Digest = require('./transcript-quiz-digest.service');
const Funnel = require('./quiz-funnel');
const { quizLanguageFor, teacherLanguageFor, canonicalSubject, formatLessonDate, topicFor, lessonLabel,
  needsLanguageAsk, languageAskButtons, languageAskBody } = require('./transcript-quiz-language');
const { isQuizLanguage } = require('../../config/quiz-languages');
const PendingOptions = require('../messaging/pending-options');
const {
  TRANSCRIPT, LP_GENERATED, isPlanQuiz, lpRemakeableQuiz, failureReasonOf, digestFailureReason, failureCopyKey,
} = require('./quiz-sources');

const OFFER_YES = 'tq_yes_';
const OFFER_NO = 'tq_no_';
const BUTTON_RX = /^tq_(yes|no)_([0-9a-fA-F-]{36})$/;
// Any language code the deployment can configure in QUIZ_LANGUAGES (`en`,
// `sw`, `pa-PK` …); whether it is one of THIS deployment's quiz languages is
// checked on the tap, not by the pattern.
const LANGUAGE_RX = /^tq_lang_([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)_([0-9a-fA-F-]{36})$/;
const MIN_TRANSCRIPT_CHARS = 1500;
const OFFER_DELAY_SECONDS = 240;
const MIN_CONFIDENCE = 0.6;
const MIN_SLOS = 2;
/** The user_feature_first_use row that marks "this teacher has had the offer" (feature-intro). */
const FEATURE_KEY = 'transcript_quiz';

// Only columns coaching_sessions and users actually have (00_complete-schema.sql).
// A column PostgREST does not know makes it refuse the WHOLE read, and every
// offer then fails as "session not found" while the job itself "succeeds" — so
// tests/quiz/transcript-quiz-offer.test.js runs this string against the schema.
// There is no observation-type column: every completed coaching session here is
// the teacher's own lesson. The digest reads grades_taught / subjects_taught.
const SESSION_SELECT = 'id, user_id, status, transcript_text, transcript_language, '
  + 'analysis_data, lesson_plan_excerpt, created_at, '
  + 'users!inner(name, id, phone_number, preferred_language, grades_taught, subjects_taught)';

function enabled() {
  if (process.env.TRANSCRIPT_QUIZ_ENABLED !== 'true') return false;
  // The operator's console switch (RUMI_FEATURE_LESSON_QUIZ=off) pauses it
  // without unsetting the flag. Required here, not at the top: the config
  // module is pure and cheap, but this keeps the offer's import list as it was.
  return require('../../config/feature-overrides').isEnabled('lesson_quiz');
}

/**
 * How long a `generating` row may go without progress before it counts as
 * dead (TRANSCRIPT_QUIZ_STALE_MINUTES, default 30 — the generate job's lease,
 * see sqs-worker quiz_generate). A run that died, or a job that was never
 * queued, leaves its row `generating`; after this window the generate step
 * may take its claim over and /quiz offers to make the quiz again.
 */
const STALE_MINUTES = 30;
function staleMs() {
  const n = Number.parseInt(String(process.env.TRANSCRIPT_QUIZ_STALE_MINUTES || '').trim(), 10);
  return (Number.isFinite(n) && n >= 1 ? n : STALE_MINUTES) * 60 * 1000;
}

/**
 * The last sign of life on a `generating` row: the live run's claim
 * (`meta.run_ms`), else the moment it was accepted or claimed.
 */
function lastProgressMs(quiz) {
  const meta = (quiz && quiz.meta) || {};
  const stamps = [Number(meta.run_ms) || 0];
  for (const k of ['accepted_at', 'retried_at', 'claimed_at', 'remade_at']) {
    const t = Date.parse(meta[k] || '');
    if (Number.isFinite(t)) stamps.push(t);
  }
  return Math.max(...stamps);
}

/** A `generating` row nothing has touched for the stale window. */
function isStaleGenerating(quiz, now = Date.now()) {
  if (!quiz || quiz.status !== 'generating') return false;
  const last = lastProgressMs(quiz);
  return last > 0 && now - last >= staleMs();
}

/**
 * The operator's console switch alone (RUMI_FEATURE_LESSON_QUIZ=off). A job
 * queued before the switch — a quiz being made, a nudge — exits quietly when
 * it is paused (the generate step, the nudge).
 */
function paused() {
  return !require('../../config/feature-overrides').isEnabled('lesson_quiz');
}

function offerMode() {
  return (process.env.TRANSCRIPT_QUIZ_OFFER_MODE || 'once').trim().toLowerCase() === 'every' ? 'every' : 'once';
}

function subjectAllowed(subject) {
  const raw = (process.env.TRANSCRIPT_QUIZ_SUBJECTS || '').trim();
  if (!raw) return true;
  const allow = new Set(raw.split(',').map((s) => canonicalSubject(s.trim())));
  return allow.has(canonicalSubject(subject));
}

async function alreadyOffered(userId) {
  if (!userId) return false;
  return FeatureIntro.hasSeenIntroVideo(userId, FEATURE_KEY);
}

// ─── 1. Schedule (called from the report generator, on the worker) ──────────

async function scheduleOffer({ coachingSessionId, userId, phone, language, transcriptChars = 0,
                               delaySeconds = OFFER_DELAY_SECONDS, source = 'self', reportTopic = null }) {
  if (!enabled()) return false;
  if (!coachingSessionId || !userId || !phone) {
    logToFile('transcript quiz: schedule skipped, missing field', { coachingSessionId, userId, hasPhone: Boolean(phone) });
    return false;
  }
  if (transcriptChars < MIN_TRANSCRIPT_CHARS) {
    logEvent('transcript_quiz.skipped', { coachingSessionId, userId, reason: 'transcript_too_short', transcriptChars });
    return false;
  }
  if (offerMode() === 'once' && await alreadyOffered(userId)) {
    logEvent('transcript_quiz.skipped', { coachingSessionId, userId, reason: 'already_offered_once' });
    return false;
  }
  // TRUE only when the offer job is actually queued: the report generator holds
  // back its own follow-ups on this answer, so a queue that refused must read as
  // "no offer is coming", never as one.
  try {
    const SQSQueueService = require('../queue');
    // `followUps`: what the report held back for this offer (Trigger 3 and
    // the next-feature suggestion). The job runs them if it ends up not
    // offering — see runReportFollowUps.
    await SQSQueueService.queueJob(coachingSessionId, 'quiz_offer', {
      coachingSessionId, userId, phone, language, source, followUps: { topic: reportTopic || null },
    }, { delaySeconds });
  } catch (err) {
    logToFile('⚠️ transcript quiz: offer could not be queued (non-fatal)', { coachingSessionId, error: err.message });
    return false;
  }
  logEvent('transcript_quiz.offer_scheduled', { coachingSessionId, userId, delaySeconds, source });
  return true;
}

/** The survey answer brings the offer forward. Idempotent with the delayed job. */
async function triggerEarly(coachingSessionId) {
  if (!enabled() || !coachingSessionId) return false;
  try {
    const SQSQueueService = require('../queue');
    await SQSQueueService.queueJob(coachingSessionId, 'quiz_offer', { coachingSessionId, early: true }, { delaySeconds: 0 });
    logEvent('transcript_quiz.offer_triggered_early', { coachingSessionId });
    return true;
  } catch (err) {
    logToFile('⚠️ transcript quiz: early trigger failed (non-fatal)', { coachingSessionId, error: err.message });
    return false;
  }
}

// ─── 2. Process (the worker) ─────────────────────────────────────────────────

/** INSERT is the claim. 23505 means another job got here first. */
async function claimRow({ session, source }) {
  const { data, error } = await supabase
    .from('quizzes')
    .insert({
      teacher_id: session.user_id,
      quiz_source: TRANSCRIPT,
      coaching_session_id: session.id,
      topic: session.analysis_data?.topic || 'Lesson',
      subject: session.analysis_data?.subject || null,
      status: 'generating',
      meta: { step: 'digest', source: source || 'offer', claimed_at: new Date().toISOString() },
    })
    .select('id')
    .single();
  if (error) {
    if (error.code === '23505') return { claimed: false };
    throw new Error(`transcript quiz: claim failed: ${error.message}`);
  }
  return { claimed: true, quizId: data.id };
}

/**
 * How long an offer job's claim is its own: the quiz queue's receive lease
 * (600 s, see sqs-worker quiz_offer). Past it the queue has handed the message
 * on, so a claim that old with its digest unfinished is a job that died.
 */
const OFFER_LEASE_MS = 600 * 1000;

/**
 * Take over this session's offer row when it is a dead offer job's claim:
 * still `generating` at the digest step, never accepted (a /quiz row carries
 * `accepted_at`), claimed longer ago than the lease. Compare-and-set on the
 * claim time, so two redeliveries cannot both take it.
 *
 * @returns {Promise<string|null>} the quiz id when taken over
 */
async function reclaimStaleOffer(coachingSessionId) {
  const { data: row } = await supabase.from('quizzes')
    .select('id, status, meta')
    .eq('coaching_session_id', coachingSessionId).eq('quiz_source', TRANSCRIPT).maybeSingle();
  const meta = (row && row.meta) || {};
  if (!row || row.status !== 'generating' || meta.step !== 'digest' || meta.accepted_at || !meta.claimed_at) return null;
  const claimedMs = Date.parse(meta.claimed_at);
  if (!Number.isFinite(claimedMs) || Date.now() - claimedMs < OFFER_LEASE_MS) return null;
  const now = new Date().toISOString();
  const { data: taken } = await supabase.from('quizzes')
    .update({ meta: { ...meta, claimed_at: now, reclaimed_at: now } })
    .eq('id', row.id).eq('status', 'generating').eq('meta->>claimed_at', meta.claimed_at)
    .select('id');
  return taken && taken.length ? row.id : null;
}

async function markSkipped(quizId, reason, extra = {}) {
  await supabase.from('quizzes')
    .update({ status: 'skipped', meta: { step: 'skipped', skip_reason: reason, ...extra } })
    .eq('id', quizId);
}

/**
 * Trigger 3 and the next-feature suggestion, held back by the report because
 * this offer was coming (report-generator afterReportOffers), for an offer job
 * that skipped. The worker passes the report generator in
 * (`ReportGenerator.reportFollowUps`): it already requires this module, so
 * requiring it back from here would be a cycle. Only the job the
 * report scheduled carries them (`payload.followUps`); the survey's early job
 * does not. Once per session: when the session has an offer row, it must be a
 * SKIPPED one (an offer that went out, or a quiz being made, means the teacher
 * has their ask) and the run is stamped on it (`meta.follow_ups_at`,
 * compare-and-set), so a redelivery or the second of the two jobs sends
 * nothing more. Never throws.
 */
async function runReportFollowUps(coachingSessionId, payload = {}, ReportGenerator = null) {
  if (!payload.followUps || !payload.userId || !payload.phone) return false;
  if (!ReportGenerator || typeof ReportGenerator.reportFollowUps !== 'function') return false;
  try {
    const { data: row } = await supabase.from('quizzes')
      .select('id, status, meta')
      .eq('coaching_session_id', coachingSessionId).eq('quiz_source', TRANSCRIPT).maybeSingle();
    if (row) {
      const meta = row.meta || {};
      if (row.status !== 'skipped' || meta.follow_ups_at) return false;
      const { data: stamped } = await supabase.from('quizzes')
        .update({ meta: { ...meta, follow_ups_at: new Date().toISOString() } })
        .eq('id', row.id).eq('status', 'skipped').is('meta->>follow_ups_at', null)
        .select('id');
      if (!stamped || !stamped.length) return false;
    }
    // The report's own language rule (preferred, else 'en') was applied when it
    // scheduled the offer: `payload.language` is its answer.
    await ReportGenerator.reportFollowUps(
      { user_id: payload.userId, users: { preferred_language: payload.language || null } },
      coachingSessionId, payload.phone, payload.followUps.topic || null,
    );
    logEvent('transcript_quiz.report_follow_ups_run', { coachingSessionId, userId: payload.userId });
    return true;
  } catch (err) {
    logToFile('⚠️ transcript quiz: report follow-ups failed (non-fatal)', { coachingSessionId, error: err.message });
    return false;
  }
}

/**
 * The offer job. When it ends without offering (`{ skipped }`), the worker
 * runs runReportFollowUps for it (sqs-worker quiz_offer).
 */
async function processOffer(coachingSessionId, payload = {}) {
  if (!enabled()) return { skipped: 'disabled' };

  const { data: session, error } = await supabase
    .from('coaching_sessions')
    .select(SESSION_SELECT)
    .eq('id', coachingSessionId)
    .maybeSingle();
  if (error || !session) {
    logToFile('⚠️ transcript quiz: session not found for offer', { coachingSessionId, error: error?.message });
    return { skipped: 'session_not_found' };
  }
  if (session.status && session.status !== 'completed') return { skipped: `status_${session.status}` };
  const transcript = String(session.transcript_text || '');
  if (transcript.length < MIN_TRANSCRIPT_CHARS) {
    logEvent('transcript_quiz.skipped', { coachingSessionId, reason: 'transcript_too_short' });
    return { skipped: 'transcript_too_short' };
  }
  const user = session.users || {};
  if (!payload.force && offerMode() === 'once' && await alreadyOffered(session.user_id)) {
    return { skipped: 'already_offered_once' };
  }

  const claim = await claimRow({ session, source: payload.source || 'offer' });
  let quizId = claim.quizId;
  if (!claim.claimed) {
    // 23505: a row exists. When it is THIS step's own claim from a job that
    // died mid-digest (the queue redelivered it), take it over; anything else
    // — a live job, an offer already made, a /quiz quiz — is left alone.
    quizId = await module.exports.reclaimStaleOffer(session.id);
    if (!quizId) {
      logEvent('transcript_quiz.offer_skipped', { coachingSessionId, reason: 'already_claimed' });
      return { skipped: 'already_claimed' };
    }
    logEvent('transcript_quiz.offer_reclaimed', { coachingSessionId, quizId });
  }

  let result;
  try {
    result = await Digest.run({ session, user });
  } catch (err) {
    // Named for what happened, like the generate step's digest failure: a
    // transcript digest has no source-side throw (the length was checked above),
    // so this is the model or the provider — `digest_failed` said neither. The
    // teacher was never offered this quiz, so nothing is sent to them; /quiz can
    // still make it from the same session.
    const reason = digestFailureReason(err);
    logToFile('❌ transcript quiz: digest failed', { coachingSessionId, quizId, reason, code: err.code || null, error: err.message }, 'error');
    await markSkipped(quizId, reason, { error: err.message });
    logEvent('transcript_quiz.skipped', { coachingSessionId, quizId, reason, step: 'digest' });
    return { skipped: reason, quizId };
  }
  const { digest, grade, gradeSource, lpHint, model, costUsd } = result;

  if (digest.confidence < MIN_CONFIDENCE || digest.slos.length < MIN_SLOS || digest.language_of_instruction === 'unknown') {
    const reason = digest.confidence < MIN_CONFIDENCE ? 'low_confidence'
      : digest.slos.length < MIN_SLOS ? 'too_few_slos' : 'language_unknown';
    await markSkipped(quizId, reason, { digest, model, cost_usd: costUsd });
    logEvent('transcript_quiz.skipped', { coachingSessionId, quizId, reason, confidence: digest.confidence, slos: digest.slos.length });
    return { skipped: reason, quizId };
  }
  if (!subjectAllowed(digest.subject)) {
    await markSkipped(quizId, 'subject_not_allowed', { digest, subject: digest.subject });
    logEvent('transcript_quiz.skipped', { coachingSessionId, quizId, reason: 'subject_not_allowed', subject: digest.subject });
    return { skipped: 'subject_not_allowed', quizId };
  }

  const language = quizLanguageFor(digest.subject, session.transcript_language);
  const teacherLang = teacherLanguageFor({ preferredLanguage: user.preferred_language });
  const topic = topicFor(digest, language);

  await supabase.from('quizzes').update({
    status: 'offered',
    topic: topic || 'Lesson',
    subject: digest.subject,
    language,
    grade: grade || null,
    meta: {
      step: 'offered', source: payload.source || 'offer',
      digest, grade, grade_source: gradeSource, lp_hint: lpHint,
      digest_model: model, cost_usd: costUsd || 0,
      teacher_language: teacherLang, offered_at: new Date().toISOString(),
    },
  }).eq('id', quizId);

  // The offer itself: plain buttons, on every channel.
  const phone = payload.phone || user.phone_number;
  const params = {
    lesson: lessonLabel({ digest, quizLanguage: language, teacherLanguage: teacherLang }),
    date: formatLessonDate(session.created_at, teacherLang),
  };
  const body = resolveUx('tqOffer', { language: teacherLang, params });
  const buttons = [
    { id: `${OFFER_YES}${quizId}`, title: resolveUx('tqOfferYes', { language: teacherLang }) },
    { id: `${OFFER_NO}${quizId}`, title: resolveUx('tqOfferNo', { language: teacherLang }) },
  ];
  const sent = await WhatsAppService.sendInteractiveButtons(phone, { body, buttons });
  // Marks "this teacher has had the offer" — what `once` mode reads next time.
  // Only when it went out: an offer that never arrived must not use up the
  // teacher's one offer.
  if (sent) await FeatureIntro.markVideoShown(session.user_id, FEATURE_KEY);
  else logToFile('⚠️ transcript quiz: offer not delivered', { coachingSessionId, quizId });

  logEvent('transcript_quiz.offered', {
    coachingSessionId, quizId, userId: session.user_id, subject: digest.subject, language, teacherLang,
    sent: Boolean(sent), early: Boolean(payload.early),
  });
  // Counted whether or not WhatsApp took it: an offer that never arrived is a
  // failure to see, not an offer that never happened.
  Funnel.emit('offer_made', {
    quiz_id: quizId, teacher_id: session.user_id, source: TRANSCRIPT,
    channel: Funnel.channelOf(payload.source || 'offer'), delivered: Boolean(sent),
  });
  return { ok: true, quizId };
}

// ─── 3. The buttons (on the web service) ─────────────────────────────────────

/**
 * The teacher's language when the quiz row is gone: there is nothing to join
 * on, so the teacher is looked up by the number they just tapped from.
 * Without this the one surface a teacher meets when an offer has expired
 * answers in the floor language rather than theirs.
 */
async function languageByPhone(phone) {
  const { data } = await supabase.from('users')
    .select('preferred_language').eq('phone_number', phone).maybeSingle();
  return teacherLanguageFor({ preferredLanguage: data?.preferred_language });
}

async function teacherFor(quiz) {
  const { data } = await supabase.from('users')
    .select('id, phone_number, preferred_language')
    .eq('id', quiz.teacher_id).maybeSingle();
  return data || {};
}

async function handleOfferButton(buttonId, phone) {
  const api = module.exports;
  const m = BUTTON_RX.exec(buttonId || '');
  if (!m) return false;
  const yes = m[1] === 'yes';
  const quizId = m[2];

  const { data: quiz } = await supabase.from('quizzes')
    .select('id, teacher_id, status, language, subject, topic, meta, coaching_session_id')
    .eq('id', quizId).maybeSingle();
  if (!quiz) {
    await WhatsAppService.sendMessage(phone, resolveUx('tqOfferExpired', { language: await api.languageByPhone(phone) }));
    return true;
  }
  const teacher = await teacherFor(quiz);
  const lang = teacherLanguageFor({ preferredLanguage: teacher.preferred_language });
  // These buttons only ever ride the coaching offer, so the stream is transcript.
  Funnel.emit('offer_answered', {
    quiz_id: quizId, teacher_id: quiz.teacher_id, source: TRANSCRIPT,
    channel: Funnel.channelOf(quiz.meta && quiz.meta.source), choice: yes ? 'yes' : 'no',
  });

  if (!yes) {
    const { data: flipped } = await supabase.from('quizzes')
      .update({ status: 'declined', meta: { ...(quiz.meta || {}), step: 'declined', declined_at: new Date().toISOString() } })
      .eq('id', quizId).eq('status', 'offered').select('id');
    const declined = Boolean(flipped && flipped.length);
    logEvent('transcript_quiz.declined', { quizId, userId: quiz.teacher_id, flipped: declined });
    // "No" after "Yes": the quiz is being made (or sent) and still coming, so
    // say that — never "declined". A second "No" on a declined offer repeats it.
    if (!declined && quiz.status !== 'declined') return api.tellAlready(phone, quiz, lang);
    await WhatsAppService.sendMessage(phone, resolveUx('tqDeclined', { language: lang }));
    return true;
  }

  // The rule language is what the teacher would be handed without an ask. It is
  // the first button, not the decision.
  const ruleLanguage = quiz.language || quizLanguageFor(quiz.subject, null);

  if (needsLanguageAsk(quiz.subject)) {
    // The row stays 'offered' until they answer, so an unanswered ask expires
    // exactly as an unanswered offer does.
    const { data: marked } = await supabase.from('quizzes')
      .update({
        meta: {
          ...(quiz.meta || {}), step: 'awaiting_language', awaiting_language: true,
          accepted_at: new Date().toISOString(), asked_language_at: new Date().toISOString(),
        },
      })
      .eq('id', quizId).eq('status', 'offered').select('id');
    if (!marked || !marked.length) return api.tellAlready(phone, quiz, lang);
    const asked = await api.sendLanguageAsk(quizId, phone, lang, ruleLanguage, {
      digest: quiz.meta && quiz.meta.digest, subject: quiz.subject,
    });
    logEvent('transcript_quiz.language_asked', { quizId, userId: quiz.teacher_id, ruleLanguage, from: 'offer', sent: asked });
    return true;
  }

  return api.startGenerating({ quizId, quiz, phone, teacherLang: lang, language: ruleLanguage, source: 'offer' });
}

/** Tapped twice, or already sent. Never a second generation. */
async function tellAlready(phone, quiz, lang) {
  const done = ['sent', 'report_sent', 'ready'].includes(quiz.status);
  await WhatsAppService.sendMessage(phone, resolveUx(done ? 'tqAlreadySent' : 'tqAlreadyMaking', { language: lang }));
  return true;
}

/** Meta's limits: three reply buttons, ten list rows of 24 characters. */
const MAX_ASK_BUTTONS = 3;
const MAX_ASK_ROWS = 10;
const ASK_ROW_TITLE_MAX = 24;

/**
 * The ask itself — shared with /quiz and the plan and topic providers, which
 * reach the same decision. `lesson` ({digest, subject}) is what its examples of
 * terms are taken from; a caller that knows neither gets an ask naming none,
 * never another subject's. One option per QUIZ_LANGUAGES entry
 * (`tq_lang_<code>_<quizId>`):
 *
 *   - up to three: reply buttons;
 *   - more: one list (Meta refuses a fourth button, and its driver returns
 *     false without sending — the ask used to vanish there);
 *   - a channel that refuses either: numbered text, its number (or name)
 *     answering it as the tap would (pending-options; handleTypedLanguageChoice
 *     on Meta, the inbound adapter on Baileys).
 *
 * @returns {Promise<boolean>} true when one of the three went out
 */
async function sendLanguageAsk(quizId, phone, teacherLang, ruleLanguage, lesson = {}) {
  const body = languageAskBody(lesson, teacherLang);
  const options = languageAskButtons(quizId, ruleLanguage);
  let sent = false;
  if (options.length <= MAX_ASK_BUTTONS) {
    sent = await WhatsAppService.sendInteractiveButtons(phone, { body, buttons: options });
  } else if (options.length <= MAX_ASK_ROWS) {
    sent = await WhatsAppService.sendInteractiveMessage(phone, {
      body: { text: body },
      action: {
        button: resolveUx('tqMenuButton', { language: teacherLang }),
        sections: [{ rows: options.map((o) => ({ id: o.id, title: String(o.title).slice(0, ASK_ROW_TITLE_MAX) })) }],
      },
    });
  }
  if (!sent) sent = await sendNumberedLanguageAsk(phone, body, options);
  if (!sent) logToFile('❌ transcript quiz: the language ask could not be delivered', { quizId, options: options.length }, 'error');
  return Boolean(sent);
}

async function sendNumberedLanguageAsk(phone, body, options) {
  const lines = options.map((o, i) => `${i + 1}. ${o.title}`);
  const ok = await WhatsAppService.sendMessage(phone, `${body}\n\n${lines.join('\n')}`);
  if (ok) {
    await PendingOptions.remember(phone, {
      replyType: 'list_reply', options: options.map((o) => ({ id: o.id, title: o.title })),
    });
  }
  return Boolean(ok);
}

/** ۲ / ٢ → 2: a teacher typing the number on an Urdu or Arabic keyboard. */
function asciiDigits(text) {
  return String(text || '')
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

/**
 * A typed answer to the numbered language ask (Meta: the inbound text is not
 * resolved against pending menus there; whatsapp-bot.js asks here first).
 * Only a pending menu made of language-ask options is ever answered; anything
 * else — no menu, another feature's menu, text that picks nothing — is left
 * to ordinary handling. With the lesson quiz off nothing is read.
 *
 * @returns {Promise<boolean>} true when the text answered the ask
 */
async function handleTypedLanguageChoice(phone, text, user) {
  if (!enabled() || !phone) return false;
  const menu = await PendingOptions.get(phone);
  const options = (menu && menu.options) || [];
  if (!options.length || !options.every((o) => String(o.id || '').startsWith('tq_lang_'))) return false;
  const picked = PendingOptions.resolveSelection(menu, asciiDigits(text));
  if (!picked) return false;
  await PendingOptions.clear(phone);
  return module.exports.handleLanguageButton(picked.id, phone, user);
}

/**
 * offered → generating, once, with the language that will be written. The
 * atomic status filter is what makes a double tap a no-op.
 */
async function startGenerating({ quizId, quiz, phone, teacherLang, language, source }) {
  const api = module.exports;
  // The label follows the language the teacher CHOSE, not the rule language the
  // offer was written under: a lesson taught in one language and quizzed in
  // another is labelled in the quiz's language on the row, in the student
  // message and in every later /quiz listing. A row without a digest (a plan or
  // topic quiz before its digest) keeps the label it has.
  const topic = topicFor(quiz.meta && quiz.meta.digest, language) || quiz.topic || 'Lesson';
  // A plan or topic quiz reaches here with no digest yet (the author digests
  // the plan or the topic first), so its next step is the digest, not the author.
  const next = quiz.meta && quiz.meta.digest ? 'author' : 'digest';
  const acceptedMeta = {
    ...(quiz.meta || {}), step: next, awaiting_language: false, language_choice: language, accepted_at: new Date().toISOString(),
  };
  const { data: flipped } = await supabase.from('quizzes')
    .update({ status: 'generating', language, topic, meta: acceptedMeta })
    .eq('id', quizId).eq('status', 'offered').select('id');
  if (!flipped || !flipped.length) return api.tellAlready(phone, quiz, teacherLang);

  // Committed: the ONE accepted for a quiz whose yes had to wait for its
  // language (the coaching offer, /quiz, a plan or a topic all land here).
  Funnel.emit('accepted', {
    quiz_id: quizId, teacher_id: quiz.teacher_id,
    source: quiz.quiz_source || TRANSCRIPT, channel: Funnel.channelOf(quiz.meta && quiz.meta.source),
  });

  if (isPlanQuiz(quiz.quiz_source)) {
    // A plan quiz whose language was asked: queued and announced by the same
    // step a plan quiz with no ask goes through.
    await api.queueLpQuiz({ quizId, phone, language: teacherLang });
    logEvent('transcript_quiz.accepted', { quizId, userId: quiz.teacher_id, language, source, quiz_source: quiz.quiz_source });
    return true;
  }

  // Queued the way queueLpQuiz queues: a refusal fails the row (remakeable
  // from /quiz, the digest kept) and says so. Left `generating` with no job,
  // the row read "still making" for ever.
  try {
    const SQSQueueService = require('../queue');
    await SQSQueueService.queueJob(quizId, 'quiz_generate', { quizId, phone, language: teacherLang }, { delaySeconds: 0 });
  } catch (err) {
    logToFile('❌ transcript quiz: quiz_generate could not be queued', { quizId, error: err.message }, 'error');
    const quizSource = quiz.quiz_source || TRANSCRIPT;
    const failedMeta = {
      ...acceptedMeta, step: 'failed', error: 'queue_failed', error_detail: `queue: ${err.message}`, failed_at: new Date().toISOString(),
    };
    const { error: writeErr } = await supabase.from('quizzes')
      .update({ status: 'failed', meta: failedMeta })
      .eq('id', quizId).eq('status', 'generating');
    if (writeErr) logToFile('❌ transcript quiz: could not mark the quiz failed', { quizId, error: writeErr.message }, 'error');
    Funnel.emit('generation_failed', {
      quiz_id: quizId, source: quizSource, channel: Funnel.channelOf(acceptedMeta.source), reason: 'queue_failed',
    });
    await WhatsAppService.sendMessage(phone, resolveUx(failureCopyKey('queue_failed', quizSource, { meta: failedMeta }), { language: teacherLang }));
    // Handled: the tap was answered, nothing else should route it.
    return true;
  }
  await WhatsAppService.sendMessage(phone, resolveUx('tqMaking', { language: teacherLang }));
  logEvent('transcript_quiz.accepted', { quizId, userId: quiz.teacher_id, language, source });
  return true;
}

/**
 * Queue the author for a lesson-plan quiz and tell the teacher it is coming —
 * or, when the queue refuses, fail the quiz and say so. The ONE place a plan
 * quiz is queued: the plan provider calls it when no language needs asking,
 * and so does startGenerating when the teacher answers the ask, so the two can
 * never queue a different job.
 *
 * @returns {Promise<boolean>} true when the job was queued
 */
async function queueLpQuiz({ quizId, phone, language }) {
  const say = async (key) => {
    const ok = await WhatsAppService.sendMessage(phone, resolveUx(key, { language }));
    if (!ok) logToFile('❌ plan quiz: reply not delivered', { quizId, key }, 'error');
  };
  try {
    const SQSQueueService = require('../queue');
    await SQSQueueService.queueJob(quizId, 'quiz_generate', { quizId, phone, language, source: 'list' }, { delaySeconds: 0 });
  } catch (err) {
    logToFile('❌ plan quiz: quiz_generate could not be queued', { quizId, error: err.message }, 'error');
    // MERGED into the row's meta, never a fresh object: the lessons, the class
    // and the lesson date are what the quiz is written from and dated by. A
    // failure that replaced them would leave a row /quiz could not date and
    // nobody could ever make again.
    const { data: current, error: readErr } = await supabase.from('quizzes')
      .select('meta, quiz_source').eq('id', quizId).maybeSingle();
    if (readErr) {
      logToFile('❌ plan quiz: could not read the quiz before marking it failed', { quizId, error: readErr.message }, 'error');
    }
    const meta = (current && current.meta) || {};
    const failedMeta = {
      ...meta,
      step: 'failed',
      error: 'queue_failed',
      error_detail: `queue: ${err.message}`,
      source: meta.source || 'list',
      failed_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('quizzes')
      .update({ status: 'failed', meta: failedMeta })
      .eq('id', quizId);
    if (error) logToFile('❌ plan quiz: could not mark the quiz failed', { quizId, error: error.message }, 'error');
    const source = (current && current.quiz_source) || LP_GENERATED;
    Funnel.emit('generation_failed', {
      quiz_id: quizId, source, channel: Funnel.channelOf(meta.source || 'list'), reason: 'queue_failed',
    });
    // What can happen next from /quiz: this lesson again when a remake can
    // help, another lesson when it cannot (quiz-sources startFailureCopyKey).
    await say(failureCopyKey('queue_failed', source, { meta: failedMeta }));
    return false;
  }
  await say('lpQuizMaking');
  return true;
}

/**
 * "Make it again" on a FAILED plan quiz (a tap on its /quiz row). failed →
 * generating, once, then the same queue step every plan quiz goes through.
 *
 * Safe to re-queue: the generate step only runs a row in generating / ready /
 * offered, and every failure write it makes keeps `meta` (the lessons, the
 * class, the lesson date), so the remake reads what the first attempt read.
 * The atomic `status = failed` filter is what makes a double submit a no-op —
 * nothing below de-duplicates a quiz_generate job (its FIFO id is per call).
 * A digest the first attempt already wrote is kept, so a quiz that failed at
 * authoring goes straight back to authoring. The failure it replaces is kept as
 * `previous_error`; `error` is cleared so no surface reads a stale reason off a
 * row that is being made.
 *
 * @returns {Promise<boolean>} true when the remake was queued
 */
async function remakeLpQuiz({ quiz, phone, teacherLang, source = 'list' }) {
  const api = module.exports;
  const meta = quiz.meta || {};
  if (!isPlanQuiz(quiz.quiz_source) || !lpRemakeableQuiz(quiz)) {
    logEvent('transcript_quiz.remake_refused', { quizId: quiz.id, reason: failureReasonOf(meta), remakes: meta.remakes || 0 });
    return false;
  }
  const { error: _error, error_detail: _detail, ...kept } = meta;
  const { data: flipped, error } = await supabase.from('quizzes')
    .update({
      status: 'generating',
      meta: {
        ...kept,
        step: kept.digest ? 'author' : 'digest',
        remakes: (Number(meta.remakes) || 0) + 1,
        previous_error: meta.error || null,
        remade_at: new Date().toISOString(),
        accepted_at: new Date().toISOString(),
        remake_source: source,
      },
    })
    .eq('id', quiz.id).eq('status', 'failed').select('id');
  if (error) {
    logToFile('❌ plan quiz remake: the failed row could not be claimed', { quizId: quiz.id, error: error.message }, 'error');
    return false;
  }
  if (!flipped || !flipped.length) {
    await api.tellAlready(phone, quiz, teacherLang);
    return false;
  }
  logEvent('transcript_quiz.remade', {
    quizId: quiz.id, userId: quiz.teacher_id, previousError: meta.error || null,
    remakes: (Number(meta.remakes) || 0) + 1, source, quiz_source: quiz.quiz_source,
  });
  Funnel.emit('accepted', {
    quiz_id: quiz.id, teacher_id: quiz.teacher_id, source: quiz.quiz_source || LP_GENERATED, channel: 'remake',
  });
  return api.queueLpQuiz({ quizId: quiz.id, phone, language: teacherLang });
}

/**
 * The teacher's answer to the ask. The language they chose is written to
 * `quizzes.language` — the generate step reads that ahead of the subject
 * rule — and the same atomic flip guards a double tap.
 */
async function handleLanguageButton(buttonId, phone, user) {
  const api = module.exports;
  const m = LANGUAGE_RX.exec(buttonId || '');
  if (!m) return false;
  const language = m[1];
  const quizId = m[2];

  // quiz_source: the same ask answers a plan or topic quiz, which
  // startGenerating queues the way its source is queued.
  const { data: quiz } = await supabase.from('quizzes')
    .select('id, teacher_id, status, language, subject, topic, meta, coaching_session_id, quiz_source')
    .eq('id', quizId).maybeSingle();
  if (!quiz) {
    await WhatsAppService.sendMessage(phone, resolveUx('tqOfferExpired', {
      language: user?.preferred_language ? teacherLanguageFor({ preferredLanguage: user.preferred_language }) : await api.languageByPhone(phone),
    }));
    return true;
  }
  const teacher = await teacherFor(quiz);
  const lang = teacherLanguageFor({ preferredLanguage: teacher.preferred_language || user?.preferred_language });
  if (!isQuizLanguage(language)) {
    // A button from an older ask, for a language this deployment no longer
    // offers (QUIZ_LANGUAGES changed): ask again with today's languages rather
    // than write a quiz in a language nobody configured.
    if (quiz.status === 'offered') {
      await api.sendLanguageAsk(quizId, phone, lang, quiz.language || quizLanguageFor(quiz.subject, null), {
        digest: quiz.meta && quiz.meta.digest, subject: quiz.subject,
      });
    } else {
      await api.tellAlready(phone, quiz, lang);
    }
    logEvent('transcript_quiz.language_refused', { quizId, language });
    return true;
  }
  logEvent('transcript_quiz.language_chosen', { quizId, userId: quiz.teacher_id, language });
  return api.startGenerating({ quizId, quiz, phone, teacherLang: lang, language, source: 'ask' });
}

module.exports = {
  enabled, paused, offerMode, subjectAllowed, alreadyOffered, staleMs, isStaleGenerating, STALE_MINUTES,
  scheduleOffer, triggerEarly, processOffer, runReportFollowUps, handleOfferButton, handleLanguageButton, claimRow, reclaimStaleOffer, languageByPhone,
  sendLanguageAsk, handleTypedLanguageChoice, startGenerating, tellAlready, queueLpQuiz, remakeLpQuiz,
  OFFER_YES, OFFER_NO, MIN_TRANSCRIPT_CHARS, OFFER_DELAY_SECONDS, OFFER_LEASE_MS, MIN_CONFIDENCE, MIN_SLOS, FEATURE_KEY, SESSION_SELECT,
};
