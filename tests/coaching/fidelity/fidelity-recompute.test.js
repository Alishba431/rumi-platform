'use strict';
/**
 * Late-plan recovery: a plan that reaches a session after its analysis already ran (an uploaded document that
 * finished reading late, a pick from the list after the report started) re-grades ONLY the fidelity section, while
 * the session can still use it — before the report is generated.
 *
 * The gate: a scored blob graded from the plan linked NOW is final. An ok blob with no percentage (the no-timings
 * refusal, an unreadable recording) is NOT final — treating it as done once stranded a whole cohort of sessions with
 * no way back. Nor is a blob graded from a different plan.
 *
 * Real: the recompute service, fidelity-session, orchestrator, scorer. Faked: the database and the two LLM calls.
 */
const { makeFakeDb } = require('./_fake-db');

let mockDb;
jest.mock('../../../bot/shared/config/supabase', () => new Proxy({}, { get: (_t, k) => mockDb[k] }));
jest.mock('../../../bot/shared/utils/logger', () => ({ logToFile: jest.fn(), logWarn: jest.fn() }));

const { recomputeFidelityForSession, RECOMPUTABLE_STATUSES } = require('../../../bot/shared/services/coaching/fidelity/fidelity-recompute.service');
const { planTextHash } = require('../../../bot/shared/services/coaching/fidelity/fidelity-orchestrator');

const STAMPED = '[00:10] Teacher (EN): fold the strip into five\n\n[03:00] Teacher (EN): one question each before you go';
const PLAN = 'Explain adding fractions with paper fraction strips folded into fifths, then an exit ticket with one question each.';
const MOVES = [{ move_id: 'm1', phase: 'explain', text: 'Explain with strips', bucket: 'must_happen' }, { move_id: 'm2', phase: 'exit', text: 'Exit ticket', bucket: 'must_happen' }];

let calls;
const deps = () => ({
  extractPlanMoves: async () => { calls.extract += 1; return { goal: 'g', moves: MOVES }; },
  analyzeFidelity: async () => { calls.grade += 1; return { verdicts: [{ move_id: 'm1', verdict: 'executed', evidence: '[00:10] fold' }, { move_id: 'm2', verdict: 'executed', evidence: '[03:00] one' }], model: 'm' }; },
});

function seed(sessionOver = {}) {
  calls = { extract: 0, grade: 0 };
  mockDb = makeFakeDb({
    coaching_sessions: [{
      id: 's1', status: 'conducting_conversation', transcript_text: STAMPED, audio_duration_seconds: 240,
      lesson_plan_text: PLAN, lesson_plan_link_method: 'uploaded', linked_lesson_plan_id: null,
      analysis_data: { framework: 'oecd', scores: {}, lp_fidelity: { status: 'lp_absent' } },
      ...sessionOver,
    }],
  });
}
const row = () => mockDb.tables.coaching_sessions[0];
const saved = process.env.LP_FIDELITY_ENABLED;
beforeEach(() => { process.env.LP_FIDELITY_ENABLED = 'true'; });
afterAll(() => { if (saved === undefined) delete process.env.LP_FIDELITY_ENABLED; else process.env.LP_FIDELITY_ENABLED = saved; });

describe('recomputeFidelityForSession', () => {
  test('a plan that arrived after the analysis: graded and persisted, the rest of analysis_data untouched', async () => {
    seed();
    const r = await recomputeFidelityForSession('s1', deps());
    expect(r).toMatchObject({ recomputed: true, fidelity_pct: 100 });
    expect(row().analysis_data).toMatchObject({ framework: 'oecd', scores: {}, lp_fidelity: { status: 'ok', source: 'uploaded', fidelity_pct: 100 } });
  });

  test('THE GATE: ok with no percentage (the no-timings refusal) stays recomputable', async () => {
    seed({ analysis_data: { framework: 'oecd', lp_fidelity: { status: 'ok', fidelity_pct: null, unusable_guard: 'no_timestamps', plan_hash: planTextHash(PLAN) } } });
    const r = await recomputeFidelityForSession('s1', deps());
    expect(r.recomputed).toBe(true);
    expect(calls.grade).toBe(1);
  });

  test('a scored blob graded from the plan linked now is final — no model call', async () => {
    seed({ analysis_data: { framework: 'oecd', lp_fidelity: { status: 'ok', fidelity_pct: 50, source: 'uploaded', plan_hash: planTextHash(PLAN) } } });
    expect(await recomputeFidelityForSession('s1', deps())).toMatchObject({ recomputed: false, reason: 'already_ok' });
    expect(calls).toEqual({ extract: 0, grade: 0 });
  });

  test('a scored blob graded from a DIFFERENT plan is re-graded', async () => {
    seed({ analysis_data: { framework: 'oecd', lp_fidelity: { status: 'ok', fidelity_pct: 50, source: 'uploaded', plan_hash: planTextHash('an older, different plan text that was graded before') } } });
    expect((await recomputeFidelityForSession('s1', deps())).recomputed).toBe(true);
  });

  test('a linked plan picked late is graded from its stored text', async () => {
    seed({ lesson_plan_text: null, linked_lesson_plan_id: 'lp-1' });
    mockDb.tables.lesson_plans = [{ id: 'lp-1', topic: 'Adding fractions', content: { plan_text: PLAN }, pdf_url: null }];
    const r = await recomputeFidelityForSession('s1', deps());
    expect(r.recomputed).toBe(true);
    expect(row().analysis_data.lp_fidelity).toMatchObject({ source: 'linked', lesson_plan_id: 'lp-1' });
  });

  test.each(['analyzing', 'generating_report', 'completed', 'awaiting_lesson_plan'])('status %s → not recomputed (the analysis or the report owns analysis_data then)', async (status) => {
    seed({ status });
    expect((await recomputeFidelityForSession('s1', deps())).recomputed).toBe(false);
    expect(calls.grade).toBe(0);
  });

  test('the recomputable statuses are the ones between the analysis and the report', () => {
    expect(RECOMPUTABLE_STATUSES).toEqual(['analysis_complete', 'conducting_conversation']);
  });

  test('feature off → nothing happens', async () => {
    seed();
    delete process.env.LP_FIDELITY_ENABLED;
    expect(await recomputeFidelityForSession('s1', deps())).toMatchObject({ recomputed: false, reason: 'disabled' });
  });

  test('never throws', async () => {
    seed();
    const r = await recomputeFidelityForSession('s1', { extractPlanMoves: async () => { throw new Error('x'); }, analyzeFidelity: async () => { throw new Error('y'); } });
    expect(r.recomputed).toBe(false);
  });
});
