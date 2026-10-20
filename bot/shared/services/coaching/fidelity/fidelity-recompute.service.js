'use strict';
/**
 * Late-plan recovery for lesson-plan fidelity.
 *
 * A plan can reach a session after its analysis already ran: an uploaded document that finished reading late, or a
 * pick from the plan list (it stays in the chat) after the analysis started. Left alone, the report would say "no
 * plan linked" for a plan the teacher did link. This re-grades ONLY the fidelity section and persists it while the
 * session sits between the analysis and the report (RECOMPUTABLE_STATUSES); the write is guarded on those statuses so
 * it can never land on top of a report being generated.
 *
 * The gate: a scored blob graded from the plan linked NOW is final. An ok blob with no percentage — the no-timings
 * refusal, an unreadable recording — is NOT: treating "ok" as final whatever its percentage once left a whole cohort
 * of refused sessions with no recovery path. A blob graded from a different plan (plan_hash) is not final either.
 *
 * Never throws; callers treat it as fire-and-forget.
 */
const { logToFile } = require('../../../utils/logger');

/** Statuses between the analysis persist and the report: the only window in which fidelity may be rewritten. */
const RECOMPUTABLE_STATUSES = ['analysis_complete', 'conducting_conversation'];

async function defaultLoadSession(sessionId) {
  const supabase = require('../../../config/supabase');
  const { data } = await supabase
    .from('coaching_sessions')
    .select('id, status, transcript_text, audio_duration_seconds, lesson_plan_text, lesson_plan_link_method, linked_lesson_plan_id, analysis_data')
    .eq('id', sessionId)
    .maybeSingle();
  return data || null;
}

function persistOutcome(data, error) {
  return error ? { ok: false, error: error.message } : { ok: !!(data && data.length) };
}

async function defaultPersist(sessionId, patch) {
  const supabase = require('../../../config/supabase');
  const { data, error } = await supabase
    .from('coaching_sessions')
    .update(patch)
    .eq('id', sessionId)
    .in('status', RECOMPUTABLE_STATUSES)
    .select('id');
  return persistOutcome(data, error);
}

function frameworkFor(analysis) {
  try {
    const { getFramework, listFrameworks } = require('../frameworks/framework-registry');
    const key = analysis && analysis.framework;
    return key && listFrameworks().includes(key) ? getFramework(key) : null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {string} sessionId
 * @param {object} [deps] the orchestrator's injectable collaborators (extractPlanMoves, analyzeFidelity), plus
 *                        loadSession / persist for tests
 * @returns {Promise<{recomputed:boolean, reason?:string, fidelity_pct?:number|null}>}
 */
async function recomputeFidelityForSession(sessionId, deps = {}) {
  const loadSession = deps.loadSession || defaultLoadSession;
  const persist = deps.persist || defaultPersist;
  try {
    const { isFidelityEnabled, resolveFidelitySources, planTextHash } = require('./fidelity-orchestrator');
    if (!isFidelityEnabled()) return { recomputed: false, reason: 'disabled' };

    const session = await loadSession(sessionId);
    if (!session) return { recomputed: false, reason: 'not_found' };
    if (!RECOMPUTABLE_STATUSES.includes(session.status)) return { recomputed: false, reason: 'not_recomputable_status' };
    const analysis = session.analysis_data || null;
    if (!analysis) return { recomputed: false, reason: 'no_analysis' };
    if (!session.transcript_text) return { recomputed: false, reason: 'no_transcript' };

    const current = analysis.lp_fidelity;
    if (current && current.status === 'ok' && current.fidelity_pct != null && current.plan_hash) {
      // Cheap identity check first: an uploaded or pasted plan is its own text. A linked plan's text needs a read,
      // so compare on the plan id instead.
      const sources = resolveFidelitySources(session, { linkedPlanText: session.linked_lesson_plan_id ? 'linked' : null });
      const samePlan = sources.source === 'linked'
        ? current.source === 'linked' && current.lesson_plan_id === session.linked_lesson_plan_id
        : current.plan_hash === planTextHash(sources.planText);
      if (samePlan) return { recomputed: false, reason: 'already_ok' };
    }

    const { computeFidelityForSession, applyFrameworkFidelity } = require('./fidelity-session');
    const result = await computeFidelityForSession(session, { runs: 1, deps });
    if (!result) return { recomputed: false, reason: 'no_sources' };

    const next = applyFrameworkFidelity(frameworkFor(analysis), { ...analysis, lp_fidelity: result }, result);
    const saved = await persist(sessionId, { analysis_data: next });
    logToFile('[lp-fidelity] recomputed after a late plan', {
      sessionId, status: result.status, fidelity_pct: result.fidelity_pct ?? null, persisted: saved && saved.ok,
    });
    if (result.status !== 'ok') return { recomputed: false, reason: result.status };
    return { recomputed: !!(saved && saved.ok), fidelity_pct: result.fidelity_pct };
  } catch (e) {
    logToFile('[lp-fidelity] recompute failed (non-blocking)', { sessionId, error: e.message });
    return { recomputed: false, reason: 'error', error: e.message };
  }
}

module.exports = { recomputeFidelityForSession, RECOMPUTABLE_STATUSES };
