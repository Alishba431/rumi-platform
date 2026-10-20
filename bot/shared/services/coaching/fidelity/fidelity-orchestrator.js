'use strict';
/**
 * The lesson-plan fidelity orchestrator a coaching analysis calls.
 *
 * Plan text (a plan Rumi made for the teacher, an uploaded document, or pasted text — resolveFidelitySources decides
 * which) → the prescribed move list (lp-upload-extractor) → per-move verdicts on the timestamped transcript
 * (fidelity-analyzer) → a deterministic score (fidelity-scorer). Returns the blob persisted as
 * analysis_data.lp_fidelity, or a status.
 *
 * NON-BLOCKING BY CONTRACT: this never throws. Each way it can fall short is its own status, because each tells the
 * teacher something different (fidelity-messages.js):
 *   lp_absent            no plan was linked to the session
 *   ok + unusable_guard  the transcript has no [MM:SS] timings, so the recording cannot be judged move by move —
 *                        decided HERE, in code, before any model call (no extraction, no grading, no spend)
 *   lp_unparseable       the plan has no readable text, or the extractor found no moves in it
 *   fidelity_unavailable the grader failed (its reason is kept as `cause`)
 * The caller gates on isFidelityEnabled() before calling, so the feature ships OFF.
 *
 * The no-timestamps guard exists because a transcription fallback that silently drops speaker turns also drops their
 * stamps. Left to the grader, a stampless transcript can come back as 0% and "lesson mismatch" — a teacher with a
 * bad recording blamed for a lesson they taught. The guard takes the model out of that decision.
 *
 * LP_FIDELITY_RUNS=N (odd, at most 5) grades N times concurrently and keeps the median scored run whole; every run's
 * percentage and the spread are persisted as telemetry; no person-facing prompt sees them (the voice note gets only
 * the band, fidelity-report.js#projectForVoice). Unset = one call plus one retry.
 *
 * All collaborators are injectable (deps) for unit testing.
 */
const { describeRecording } = require('./fidelity-preflight');

const MAX_RUNS = 5;
// Plan text cap (chars) before extraction: a pasted or extracted document can be enormous (a whole textbook
// chapter), and an uncapped one makes the extractor return nothing.
const PLAN_TEXT_CAP = 24000;
const warned = new Set();

function log(message, detail) {
  try { require('../../../utils/logger').logToFile(message, detail); } catch (_) { /* logging never fails a grading */ }
}

function warnOnce(key, detail) {
  if (warned.has(key)) return;
  warned.add(key);
  log(`[lp-fidelity] ${key}`, detail);
}

/** An odd number of runs between 1 and MAX_RUNS: an even count has no single middle run to keep. */
function normaliseRuns(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n % 2 === 0 ? n + 1 : n, MAX_RUNS);
}

function fidelityRuns() {
  const raw = process.env.LP_FIDELITY_RUNS;
  if (raw == null || String(raw).trim() === '') return 1;
  const runs = normaliseRuns(raw);
  if (String(runs) !== String(raw).trim()) warnOnce('LP_FIDELITY_RUNS adjusted', { value: raw, runs });
  return runs;
}

/** LP_FIDELITY_ENABLED=true, and not paused from the console (RUMI_FEATURE_LP_FIDELITY=off). */
function isFidelityEnabled() {
  if (process.env.LP_FIDELITY_ENABLED !== 'true') return false;
  try {
    return require('../../../config/feature-overrides').isEnabled('lp_fidelity');
  } catch (_) {
    return true;
  }
}

function capPlanText(text) {
  const s = String(text);
  return s.length > PLAN_TEXT_CAP ? s.slice(0, PLAN_TEXT_CAP) : s;
}

/**
 * sha1 of a plan's text exactly as the extractor sees it (capped), so the same document hashes the same whether or
 * not it was over the cap. The recompute gate compares it to tell a different plan from the same one. null for no text.
 */
function planTextHash(text) {
  if (text == null || text === '') return null;
  return require('crypto').createHash('sha1').update(capPlanText(text), 'utf8').digest('hex');
}

/**
 * Decide the fidelity inputs for a coaching session. Text the teacher gave for THIS lesson (an upload or a paste,
 * stored in lesson_plan_text) wins over a linked plan: it is the more specific statement of what they meant to teach.
 * A linked Rumi-made plan is rendered to text by the caller (lesson-plan-text.js) and passed as linkedPlanText.
 *
 * @param {object} session coaching_sessions row
 * @param {{linkedPlanText?: string|null}} [extra]
 * @returns {{planText: string|null, source: 'uploaded'|'pasted'|'linked'|null, lessonPlanId: string|null}}
 */
function resolveFidelitySources(session, extra = {}) {
  const s = session || {};
  if (s.lesson_plan_text && String(s.lesson_plan_text).trim()) {
    return {
      planText: s.lesson_plan_text,
      source: s.lesson_plan_link_method === 'pasted' ? 'pasted' : 'uploaded',
      lessonPlanId: null,
    };
  }
  if (s.linked_lesson_plan_id && extra.linkedPlanText && String(extra.linkedPlanText).trim()) {
    return { planText: extra.linkedPlanText, source: 'linked', lessonPlanId: s.linked_lesson_plan_id };
  }
  return { planText: null, source: null, lessonPlanId: null };
}

/**
 * @param {object} input  { planText:string, source:'linked'|'uploaded'|'pasted', lessonPlanId?:string,
 *                          transcript:string, meta?:object, audioDurationSeconds?:number, runs?:number }
 *                        `runs` overrides LP_FIDELITY_RUNS (a recompute grades once).
 * @param {object} deps    { extractPlanMoves, analyzeFidelity, scoreFidelity } (optional)
 * @returns {Promise<null | {status:'ok'|'lp_absent'|'lp_unparseable'|'fidelity_unavailable', ...}>}
 */
async function computeLpFidelity(input = {}, deps = {}) {
  const extractPlanMoves = deps.extractPlanMoves || require('./lp-upload-extractor').extractUploadedLp;
  const analyzeFidelity = deps.analyzeFidelity || require('./fidelity-analyzer').analyzeFidelity;
  const scoreFidelity = deps.scoreFidelity || require('./fidelity-scorer').scoreFidelity;

  if (!input || !input.transcript) return null; // nothing to grade against
  if (!input.planText || !String(input.planText).trim()) return { status: 'lp_absent' };

  const source = input.source || 'uploaded';
  const lessonPlanId = input.lessonPlanId || null;
  const planText = capPlanText(input.planText);
  const planHash = planTextHash(planText);
  const recording = describeRecording(input.transcript, input.audioDurationSeconds);
  const runsRequested = input.runs != null ? normaliseRuns(input.runs) : fidelityRuns();

  // 1) The input contract, before any model call: every verdict above not_done must quote a stamped span, so a
  // transcript with no [MM:SS] stamps cannot be judged move by move. "Not assessed", never 0%. Same blob shape as a
  // scored run, so every reader sees the not-assessed state it already handles.
  if (recording.no_timestamps) {
    log('[lp-fidelity] no timestamps in the transcript — not assessed, no model called', { source, lessonPlanId });
    return {
      status: 'ok',
      source,
      lesson_plan_id: lessonPlanId,
      plan_hash: planHash,
      meta: { ...(input.meta || {}) },
      fidelity_pct: null,
      band: null,
      executed_credit: 0,
      prescribed_count: 0,
      intended_scorable: 0,
      coverage: 0,
      low_confidence: true,
      recording_unusable: true,
      truncation_inconsistent: false,
      not_assessed: [],
      enrichment_uptake: [],
      strengths: [],
      time_on_task: null,
      moves: [],
      moderators: { plan_navigability: null, note: 'recording_unusable' },
      narrative: null,
      language_note: 'The transcript carries no [MM:SS] timestamps; the recording was not graded.',
      model: null,
      reasoning_effort: null,
      empty_retry: false,
      recording,
      runs: [],
      runs_requested: runsRequested,
      spread: null,
      missing_verdicts: 0,
      unusable_guard: 'no_timestamps',
      graded_at: null,
    };
  }

  // 2) The plan → its move list. A plan with no text layer, or one the extractor finds no moves in, is its own state.
  let extracted;
  try {
    extracted = await extractPlanMoves(planText, { source, lessonId: lessonPlanId || undefined });
  } catch (e) {
    // Only a plan the extractor could not READ is "the plan could not be read". A provider error on the call itself
    // (a bad model slug, an outage) is our failure, and the teacher must not be told their plan was the problem.
    if (e.code !== 'lp_unparseable') {
      log('[lp-fidelity] the plan extractor call failed', { source, error: e.message });
      return { status: 'fidelity_unavailable', source, lesson_plan_id: lessonPlanId, plan_hash: planHash, error: e.message || 'extractor_failed', cause: 'extractor_failed' };
    }
    log('[lp-fidelity] the plan could not be read', { source, error: e.message });
    return { status: 'lp_unparseable', source, lesson_plan_id: lessonPlanId, plan_hash: planHash, error: e.code, cause: e.message || null };
  }
  const moves = extracted && Array.isArray(extracted.moves) ? extracted.moves : [];
  if (!moves.length) {
    return { status: 'lp_unparseable', source, lesson_plan_id: lessonPlanId, plan_hash: planHash, error: 'lp_unparseable', cause: 'no moves extracted' };
  }
  const meta = { ...(input.meta || {}), template: 'UPLOADED', goal: extracted.goal || null };

  // 3) Grade + score — N runs, the median scored run kept. N=1 is one call plus one retry.
  try {
    const { graded, analysis, runs, spread } = await gradeWithRuns(
      { analyzeFidelity, scoreFidelity }, { moves, transcript: input.transcript, meta }, runsRequested,
    );
    return {
      status: 'ok',
      source,
      lesson_plan_id: lessonPlanId,
      // Identity of the plan text this blob was graded from, so the recompute gate can tell a different plan from
      // the same one. Top-level, not in meta — meta is the grader's prompt input.
      plan_hash: planHash,
      meta,
      ...analysis,
      narrative: graded.narrative || null,
      language_note: graded.language_note || null,
      // NOT `graded.moderators` — the scorer returns that block with its own truncation_inconsistent finding folded
      // in, and re-reading the grader's copy here would silently drop it. One writer.
      model: graded.model || null,
      reasoning_effort: graded.reasoning_effort || null,
      empty_retry: Boolean(graded.empty_retry),
      recording,
      runs,
      runs_requested: runsRequested,
      spread,
      missing_verdicts: graded.missing_verdicts || 0,
      unusable_guard: null,
      graded_at: null, // stamped by the caller
    };
  } catch (e) {
    // never fail the coaching job — surface as a status the report can fall back on
    return { status: 'fidelity_unavailable', source, lesson_plan_id: lessonPlanId, plan_hash: planHash, error: e.code || e.message, cause: e.reason || null };
  }
}

/**
 * Grade N times and keep the median. The same audio and plan re-graded moves the percentage by several points; one
 * call is one draw. N=1 is call-then-retry. N>1: the calls run concurrently and each answer is scored on its own, so an
 * answer the scorer cannot read is skipped rather than fatal. The median of the runs that produced a percentage is kept
 * whole — its verdicts, evidence and narrative stay one coherent grading, never a per-move blend — unless most runs
 * produced none, in which case a run without one is kept. If every call fails, the first failure propagates.
 * @returns {Promise<{graded:object, analysis:object, runs:Array<{pct:number|null, model:string|null}>, spread:number|null}>}
 */
async function gradeWithRuns({ analyzeFidelity, scoreFidelity }, { moves, transcript, meta }, n) {
  let answered;
  if (n <= 1) {
    let graded;
    try {
      graded = await analyzeFidelity(moves, transcript, meta);
    } catch (firstErr) {
      log('[lp-fidelity] grading failed, retrying once', { reason: firstErr.reason || firstErr.code || null, error: firstErr.message });
      graded = await analyzeFidelity(moves, transcript, meta);
    }
    answered = [graded];
  } else {
    const settled = await Promise.allSettled(Array.from({ length: n }, () => analyzeFidelity(moves, transcript, meta)));
    answered = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const failed = settled.filter((r) => r.status === 'rejected').map((r) => r.reason);
    if (failed.length) {
      log('[lp-fidelity] grading runs failed', { failed: failed.length, of: n, reasons: failed.map((e) => (e && (e.reason || e.code)) || null) });
    }
    if (!answered.length) throw failed[0];
  }

  const scored = [];
  let scoreErr = null;
  for (const graded of answered) {
    try {
      scored.push({ graded, analysis: scoreFidelity(moves, graded.verdicts, { moderators: graded.moderators }) });
    } catch (e) {
      scoreErr = scoreErr || e;
      log('[lp-fidelity] a grading could not be scored, skipped', { error: e.message });
    }
  }
  if (!scored.length) throw scoreErr;

  const rank = (p) => (p == null ? -1 : p);
  scored.sort((a, b) => rank(a.analysis.fidelity_pct) - rank(b.analysis.fidelity_pct));
  const withPct = scored.filter((x) => x.analysis.fidelity_pct != null);
  const pool = withPct.length * 2 >= scored.length ? withPct : scored.filter((x) => x.analysis.fidelity_pct == null);
  const pick = pool[Math.floor((pool.length - 1) / 2)];
  const pcts = withPct.map((x) => x.analysis.fidelity_pct);
  return {
    graded: pick.graded,
    analysis: pick.analysis,
    runs: scored.map((x) => ({ pct: x.analysis.fidelity_pct, model: x.graded.model || null })),
    spread: pcts.length >= 2 ? Math.round((Math.max(...pcts) - Math.min(...pcts)) * 10) / 10 : null,
  };
}

/**
 * The persist patch for a computeLpFidelity result. Non-ok statuses persist too: lp_absent vs lp_unparseable vs
 * fidelity_unavailable vs never-ran must stay distinguishable. Every reader guards on status === 'ok'.
 */
function fidelityPatch(lpFidelity) {
  return lpFidelity ? { lp_fidelity: lpFidelity } : {};
}

module.exports = {
  computeLpFidelity, isFidelityEnabled, resolveFidelitySources, fidelityPatch, planTextHash, PLAN_TEXT_CAP,
};
