'use strict';
/**
 * Re-enter an unfinished observation AT ITS OWN STEP.
 *
 * The /observe menu lists observations that have not reached the debrief yet
 * (stage A). A tap re-reads the row — never the list — and decides:
 *   form  → awaiting_observer_review: re-open the coach's ratings form
 *   retry → failed, or silent mid-pipeline for 30+ min: offer "run it again"
 *   wait  → the pipeline is genuinely still working: say so, nothing else
 *
 * "Run it again" re-enters the phase it died in (no transcript → transcribe
 * again; a transcript → analyse again), with a compare-and-set on the status it
 * read so a double tap queues once, and a bound (MAX_RETRIES) so a recording
 * that cannot go through is told so honestly instead of looping.
 */

const supabase = require('../../config/supabase');
const WhatsAppService = require('../whatsapp.service');
const { t, observeLang } = require('./observe-strings');
const { isTerminalStatus } = require('./observe-terminal');
const { logToFile } = require('../../utils/logger');

const MAX_RETRIES = 2;
const STALE_MINUTES = 30;
const IN_PIPELINE = ['confirmed', 'transcribing', 'transcription_complete', 'analyzing', 'analysis_complete'];

/** Which step a tap re-enters, from the row's own status. Pure. */
function resumeKindFor(status, updatedAt, nowMs = Date.now()) {
  if (status === 'awaiting_observer_review') return 'form';
  if (status === 'failed') return 'retry';
  if (IN_PIPELINE.includes(status)) {
    const ageMin = (nowMs - Date.parse(updatedAt || 0)) / 60000;
    return ageMin > STALE_MINUTES ? 'retry' : 'wait';   // a 30-min-silent pipeline is stuck, not working
  }
  return null;
}

async function _loadOwn(sessionId, user) {
  const { data } = await supabase
    .from('coaching_sessions')
    .select('id, status, created_at, updated_at, observer_user_id, analysis_data, transcript_text, audio_id')
    .eq('id', sessionId)
    .maybeSingle();
  if (!data || data.observer_user_id !== user.id) return null;
  return data;
}

async function _guard(sessionId, from, user) {
  const lang = observeLang(user);
  const s = await _loadOwn(sessionId, user);
  if (!s) { await WhatsAppService.sendMessage(from, t(lang, 'debrief_not_yours')); return null; }
  if (isTerminalStatus(s.status)) { await WhatsAppService.sendMessage(from, t(lang, 'resume_cancelled')); return null; }
  return s;
}

function _retryPlan(s) {
  const count = (s.analysis_data && s.analysis_data.observe_retry_count) || 0;
  if (count >= MAX_RETRIES) return { ok: false, reason: 'retry_bound_reached', count };
  if (s.transcript_text) return { ok: true, queue: 'analysis', count };
  if (s.audio_id) return { ok: true, queue: 'transcription', count };
  return { ok: false, reason: 'nothing_to_retry_from', count };
}

async function _refuseRetry(s, from, user, plan) {
  await WhatsAppService.sendMessage(from, t(observeLang(user), 'resume_retry_exhausted'));
  logToFile('⛔ observe-resume: retry refused', { sessionId: s.id, reason: plan.reason, count: plan.count });
  await supabase.from('coaching_sessions')
    .update({ error_message: `observe resume refused: ${plan.reason} after ${plan.count} attempt(s)`, updated_at: new Date().toISOString() })
    .eq('id', s.id);
}

/**
 * Reopen the coach's ratings form. A failing form step degrades to "still
 * working", never a crash.
 */
async function _resumeForm(s, from, user) {
  try {
    // eslint-disable-next-line global-require -- lazy: the form reaches back into this graph
    const Form = require('./observe-form.service');
    await Form.resume(user, from, s.id);
    return true;
  } catch (err) {
    logToFile('⚠️ observe-resume: form step unavailable', { sessionId: s.id, error: err.message });
  }
  await WhatsAppService.sendMessage(from, t(observeLang(user), 'resume_wait_ack'));
  return true;
}

/** A pending-row tap: `observe_pend_resume_<id>`. */
async function resume(sessionId, from, user) {
  const s = await _guard(sessionId, from, user);
  if (!s) return true;
  const lang = observeLang(user);
  const kind = resumeKindFor(s.status, s.updated_at);
  logToFile('🔁 observe-resume: row tapped', { sessionId, kind, status: s.status });
  if (kind === 'form') return _resumeForm(s, from, user);
  if (kind === 'retry') {
    const plan = _retryPlan(s);
    if (!plan.ok) { await _refuseRetry(s, from, user, plan); return true; }
    await WhatsAppService.sendInteractiveButtons(from, {
      body: t(lang, 'resume_desc_retry'),
      buttons: [
        { id: `observe_retry_${s.id}`, title: t(lang, 'btn_retry_now').slice(0, 20) },
        { id: `observe_cancel_${s.id}`, title: t(lang, 'btn_cancel_obs').slice(0, 20) },
      ],
    });
    return true;
  }
  // 'wait', or a stage this list does not own any more (moved on since the list was sent)
  await WhatsAppService.sendMessage(from, t(lang, 'resume_wait_ack'));
  return true;
}

/** The [Run it again] tap — CAS off the status read, so a double tap queues once. */
async function runRetry(sessionId, from, user) {
  const s = await _guard(sessionId, from, user);
  if (!s) return true;
  const lang = observeLang(user);
  if (resumeKindFor(s.status, s.updated_at) !== 'retry') {
    await WhatsAppService.sendMessage(from, t(lang, 'resume_wait_ack'));
    return true;
  }
  const plan = _retryPlan(s);
  if (!plan.ok) { await _refuseRetry(s, from, user, plan); return true; }

  const { data: claimed } = await supabase
    .from('coaching_sessions')
    .update({
      status: plan.queue === 'transcription' ? 'confirmed' : 'transcription_complete',
      analysis_data: { ...(s.analysis_data || {}), observe_retry_count: plan.count + 1 },
      updated_at: new Date().toISOString(),
    })
    .eq('id', sessionId)
    .eq('status', s.status)
    .select('id');
  if (!claimed || !claimed.length) {
    await WhatsAppService.sendMessage(from, t(lang, 'resume_wait_ack'));
    return true;
  }
  const Q = require('../coaching/coaching-job-queue.service');
  if (plan.queue === 'transcription') await Q.queueTranscription(sessionId, { from, audioId: s.audio_id });
  else await Q.queueAnalysis(sessionId, { from, trigger: 'observe_manual_retry' });
  await WhatsAppService.sendMessage(from, t(lang, 'resume_retry_ack'));
  logToFile('🔄 observe-resume: pipeline re-entered', { sessionId, queue: plan.queue, retry: plan.count + 1 });
  return true;
}

module.exports = { resume, runRetry, resumeKindFor, MAX_RETRIES };
