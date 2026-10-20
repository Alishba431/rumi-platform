'use strict';
/**
 * Lesson-plan fidelity for one coaching session: gather its inputs, grade, and let the session's framework map the
 * measurement. Shared by the analysis job and the late-plan recompute so both grade exactly the same inputs.
 */
const { computeLpFidelity, resolveFidelitySources } = require('./fidelity-orchestrator');
const { renderLinkedPlanText } = require('./lesson-plan-text');

function log(message, detail) {
  try { require('../../../utils/logger').logToFile(message, detail); } catch (_) { /* never fails a grading */ }
}

const DEFAULT_PLAN_WAIT_SECONDS = 90;

function planWaitMs() {
  const n = Number(process.env.LP_FIDELITY_PLAN_WAIT_SECONDS);
  return (Number.isFinite(n) && n >= 0 ? n : DEFAULT_PLAN_WAIT_SECONDS) * 1000;
}

/**
 * An uploaded plan is read by a job queued at the same moment as the analysis, so the analysis can start before the
 * plan's text exists. While the upload is still being read, wait for it (polling the session) rather than grade
 * "no plan" and recover later. Returns the session with the plan's fields refreshed.
 */
async function waitForPlanText(session, pollMs) {
  const deadline = Date.now() + planWaitMs();
  let current = session;
  const supabase = require('../../../config/supabase');
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const { data } = await supabase
      .from('coaching_sessions')
      .select('lesson_plan_text, lesson_plan_link_method, lesson_plan_extraction_status, linked_lesson_plan_id')
      .eq('id', session.id)
      .maybeSingle();
    if (data) current = { ...current, ...data };
    if (!data || current.lesson_plan_extraction_status !== 'pending') break;
  }
  log('[lp-fidelity] waited for the uploaded plan', { sessionId: session.id, found: !!current.lesson_plan_text });
  return current;
}

/**
 * A plan Rumi made is taught again and again, and every lesson taught from it must be graded against the SAME move
 * list: re-extracting at each grading lets the denominator drift. The first extraction is kept on the plan's own row
 * (lesson_plans.content.fidelity_moves, keyed by the hash of the plan text it came from) and reused; edited plan text
 * (a new hash) is extracted afresh. A failed read or write only costs a fresh extraction.
 */
function cachedLinkedExtractor(lessonPlanId, extract) {
  return async (text, extractOpts) => {
    const { planTextHash } = require('./fidelity-orchestrator');
    const supabase = require('../../../config/supabase');
    const hash = planTextHash(text);
    let content = null;
    try {
      const { data } = await supabase.from('lesson_plans').select('content').eq('id', lessonPlanId).maybeSingle();
      content = data && data.content && typeof data.content === 'object' ? data.content : null;
    } catch (_) { /* extract afresh */ }
    const kept = content && content.fidelity_moves;
    if (kept && kept.plan_hash === hash && Array.isArray(kept.moves) && kept.moves.length) {
      return { goal: kept.goal || null, moves: kept.moves, model: kept.model || null, cached: true };
    }
    const fresh = await extract(text, extractOpts);
    if (fresh && Array.isArray(fresh.moves) && fresh.moves.length) {
      try {
        await supabase.from('lesson_plans').update({
          content: {
            ...(content || {}),
            fidelity_moves: { plan_hash: hash, goal: fresh.goal || null, moves: fresh.moves, model: fresh.model || null, extracted_at: new Date().toISOString() },
          },
        }).eq('id', lessonPlanId);
      } catch (e) {
        log('[lp-fidelity] could not keep the plan\'s moves (next grading re-extracts)', { lessonPlanId, error: e.message });
      }
    }
    return fresh;
  };
}

/**
 * @param {object} session coaching_sessions row (transcript_text, audio_duration_seconds, lesson_plan_text,
 *                         lesson_plan_link_method, linked_lesson_plan_id)
 * @param {{runs?:number, deps?:object, waitForPlan?:boolean, pollMs?:number, renderLinkedPlanText?:Function,
 *          computeLpFidelity?:Function}} [opts]
 *        waitForPlan: the analysis job waits for an upload still being read (LP_FIDELITY_PLAN_WAIT_SECONDS)
 *        deps: the orchestrator's injectable collaborators (extractPlanMoves, analyzeFidelity) for tests
 * @returns {Promise<object|null>} the lp_fidelity blob (graded_at stamped), or null when there is no transcript
 */
async function computeFidelityForSession(session, opts = {}) {
  const render = opts.renderLinkedPlanText || renderLinkedPlanText;
  const compute = opts.computeLpFidelity || computeLpFidelity;
  let s = session || {};
  if (opts.waitForPlan && s.id && !s.lesson_plan_text && s.lesson_plan_extraction_status === 'pending') {
    s = await waitForPlanText(s, opts.pollMs || 3000);
  }

  let linkedPlanText = null;
  if (!s.lesson_plan_text && s.linked_lesson_plan_id) {
    const rendered = await render(s.linked_lesson_plan_id);
    linkedPlanText = rendered ? rendered.text : null;
  }
  const { planText, source, lessonPlanId } = resolveFidelitySources(s, { linkedPlanText });
  let deps = opts.deps || {};
  if (source === 'linked' && lessonPlanId) {
    const extract = deps.extractPlanMoves || require('./lp-upload-extractor').extractUploadedLp;
    deps = { ...deps, extractPlanMoves: cachedLinkedExtractor(lessonPlanId, extract) };
  }
  const result = await compute({
    planText,
    source,
    lessonPlanId,
    transcript: s.transcript_text,
    audioDurationSeconds: s.audio_duration_seconds,
    ...(opts.runs != null ? { runs: opts.runs } : {}),
  }, deps);
  if (!result) return null;
  return { ...result, graded_at: new Date().toISOString() };
}

/**
 * The optional framework hook: a framework that has an indicator for plan fidelity can map the measurement onto it
 * (`applyLpFidelity(analysis, lpFidelity) → analysis`). A framework without the hook is left as it is; the
 * measurement still travels on analysis_data.lp_fidelity and the report reads it there.
 */
function applyFrameworkFidelity(framework, analysis, lpFidelity) {
  if (!framework || typeof framework.applyLpFidelity !== 'function' || !analysis || !lpFidelity) return analysis;
  try {
    return framework.applyLpFidelity(analysis, lpFidelity) || analysis;
  } catch (e) {
    log('[lp-fidelity] framework applyLpFidelity failed — keeping the analysis as scored', { framework: framework.name, error: e.message });
    return analysis;
  }
}

module.exports = { computeFidelityForSession, applyFrameworkFidelity };
