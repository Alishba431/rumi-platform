'use strict';
/**
 * The orchestrator a coaching analysis calls: plan text → moves (extractor) → verdicts (grader) → score (the REAL
 * scorer and pre-flight here; deps inject only the two LLM calls, the network boundary).
 *
 * It MUST be non-blocking — any failure comes back as a status, never a throw, so fidelity can never fail the
 * coaching job — and each way it can fail is a DIFFERENT status, because each one tells the teacher something
 * different: no plan linked, the recording had no timings, the plan could not be read, the grader failed.
 */
const orchestrator = require('../../../bot/shared/services/coaching/fidelity/fidelity-orchestrator');

const { computeLpFidelity, planTextHash, PLAN_TEXT_CAP } = orchestrator;

const PLAN = 'Warm-up on halves and quarters; explain with fraction strips; model 1/5 + 2/5; pair practice; exit ticket.';
const MOVES = [
  { move_id: 'm1', phase: 'explain', text: 'Explain with fraction strips', bucket: 'must_happen' },
  { move_id: 'm2', phase: 'exit', text: 'Exit ticket', bucket: 'must_happen' },
];
const T = '[00:10] Teacher (EN): fold the strip into five\n\n[03:00] Teacher (EN): one question each before you go';
const V = (m2) => ({
  verdicts: [
    { move_id: 'm1', verdict: 'executed', evidence: '[00:10] fold the strip into five' },
    { move_id: 'm2', verdict: m2, evidence: m2 === 'not_done' ? '' : '[03:00] one question each' },
  ],
  narrative: 'n', language_note: 'English', model: 'google/gemini-3.8-flash', moderators: null,
});

function spyDeps(over = {}) {
  const calls = { extract: [], grade: [] };
  const deps = {
    extractPlanMoves: async (text, opts) => { calls.extract.push({ text, opts }); return { goal: 'add fractions', moves: MOVES }; },
    analyzeFidelity: async (moves, transcript, meta) => { calls.grade.push({ moves, transcript, meta }); return V('not_done'); },
    ...over,
  };
  return { deps, calls };
}

const FLAGS = ['LP_FIDELITY_RUNS'];

describe('fidelity-orchestrator · computeLpFidelity', () => {
  const saved = {};
  beforeEach(() => { for (const k of FLAGS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of FLAGS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  test.each(['linked', 'uploaded', 'pasted'])('%s plan: extract → grade → score → ok, source recorded', async (source) => {
    const { deps, calls } = spyDeps();
    const r = await computeLpFidelity({ planText: PLAN, source, lessonPlanId: source === 'linked' ? 'lp-1' : null, transcript: T, audioDurationSeconds: 240 }, deps);
    expect(r.status).toBe('ok');
    expect(r.source).toBe(source);
    expect(r.lesson_plan_id).toBe(source === 'linked' ? 'lp-1' : null);
    expect(r.fidelity_pct).toBe(50);
    expect(r.band).toBe('partial');
    expect(r.narrative).toBe('n');
    expect(r.model).toBe('google/gemini-3.8-flash');
    expect(r.recording).toMatchObject({ stamps: 2, no_timestamps: false, audio_s: 240 });
    expect(r.runs).toEqual([{ pct: 50, model: 'google/gemini-3.8-flash' }]);
    expect(r.runs_requested).toBe(1);
    expect(r.unusable_guard).toBeNull();
    expect(calls.extract[0].opts.source).toBe(source);
    expect(calls.grade[0].meta).toMatchObject({ goal: 'add fractions' });
  });

  test('no plan text → lp_absent and no model call at all', async () => {
    const { deps, calls } = spyDeps();
    for (const planText of [null, undefined, '', '   ']) {
      expect(await computeLpFidelity({ planText, source: 'pasted', transcript: T }, deps)).toEqual({ status: 'lp_absent' });
    }
    expect(calls.extract).toHaveLength(0);
    expect(calls.grade).toHaveLength(0);
  });

  test('no transcript → null (nothing to grade against)', async () => {
    const { deps } = spyDeps();
    expect(await computeLpFidelity({ planText: PLAN, source: 'pasted' }, deps)).toBeNull();
  });

  test('INPUT CONTRACT: a transcript with no [MM:SS] stamps is not assessed — and no model is called, not even the extractor', async () => {
    const { deps, calls } = spyDeps();
    const raw = 'Good morning class today we add fractions fold the strip into five one question each before you go';
    const r = await computeLpFidelity({ planText: PLAN, source: 'linked', lessonPlanId: 'lp-1', transcript: raw, audioDurationSeconds: 240 }, deps);
    expect(calls.extract).toHaveLength(0);
    expect(calls.grade).toHaveLength(0);
    expect(r).toMatchObject({
      status: 'ok', source: 'linked', lesson_plan_id: 'lp-1',
      fidelity_pct: null, band: null, unusable_guard: 'no_timestamps', recording_unusable: true, model: null, moves: [],
    });
    expect(r.recording.no_timestamps).toBe(true);
    expect(r.plan_hash).toBe(planTextHash(PLAN));
  });

  test('the plan could not be read → lp_unparseable (its own status), grader never called', async () => {
    const { deps, calls } = spyDeps({
      extractPlanMoves: async () => { const e = new Error('lp_unparseable: no text'); e.code = 'lp_unparseable'; throw e; },
    });
    const r = await computeLpFidelity({ planText: PLAN, source: 'uploaded', transcript: T }, deps);
    expect(r).toMatchObject({ status: 'lp_unparseable', source: 'uploaded', error: 'lp_unparseable' });
    expect(calls.grade).toHaveLength(0);
  });

  test('an extractor that answered badly (extractor_failed) is "the check could not run"', async () => {
    const { deps } = spyDeps({ extractPlanMoves: async () => { const e = new Error('extractor_failed: unparseable'); e.code = 'extractor_failed'; throw e; } });
    const r = await computeLpFidelity({ planText: PLAN, source: 'pasted', transcript: T }, deps);
    expect(r).toMatchObject({ status: 'fidelity_unavailable', cause: 'extractor_failed' });
  });

  test('the extractor call itself failing (provider error, bad model slug) is NOT "the plan could not be read"', async () => {
    const { deps, calls } = spyDeps({
      extractPlanMoves: async () => { const e = new Error('400 invalid model'); e.status = 400; throw e; },
    });
    const r = await computeLpFidelity({ planText: PLAN, source: 'pasted', transcript: T }, deps);
    expect(r).toMatchObject({ status: 'fidelity_unavailable', cause: 'extractor_failed' });
    expect(calls.grade).toHaveLength(0);
  });

  test('the grader failed → fidelity_unavailable with the grader\'s reason as cause, after one retry; never thrown', async () => {
    let n = 0;
    const { deps } = spyDeps({
      analyzeFidelity: async () => { n += 1; const e = new Error('fidelity_unavailable: truncated'); e.code = 'fidelity_unavailable'; e.reason = 'truncated'; throw e; },
    });
    const r = await computeLpFidelity({ planText: PLAN, source: 'pasted', transcript: T }, deps);
    expect(r).toMatchObject({ status: 'fidelity_unavailable', source: 'pasted', error: 'fidelity_unavailable', cause: 'truncated' });
    expect(n).toBe(2);
  });

  test('a transient grader failure is retried once and the second answer kept', async () => {
    let n = 0;
    const { deps } = spyDeps({ analyzeFidelity: async () => { n += 1; if (n === 1) throw new Error('flake'); return V('executed'); } });
    const r = await computeLpFidelity({ planText: PLAN, source: 'pasted', transcript: T }, deps);
    expect(r.status).toBe('ok');
    expect(r.fidelity_pct).toBe(100);
  });

  test('plan_hash identifies the plan text graded (capped like the extractor input) and stays out of the grader meta', async () => {
    const { deps, calls } = spyDeps();
    const r = await computeLpFidelity({ planText: PLAN, source: 'uploaded', transcript: T }, deps);
    expect(r.plan_hash).toBe(planTextHash(PLAN));
    expect(r.plan_hash).toMatch(/^[0-9a-f]{40}$/);
    expect(calls.grade[0].meta).not.toHaveProperty('plan_hash');
    const big = 'x'.repeat(PLAN_TEXT_CAP + 500);
    expect(planTextHash(big)).toBe(planTextHash(big.slice(0, PLAN_TEXT_CAP)));
    expect(planTextHash(null)).toBeNull();
  });

  test('a very long plan is capped before extraction', async () => {
    const { deps, calls } = spyDeps();
    await computeLpFidelity({ planText: 'p'.repeat(PLAN_TEXT_CAP * 3), source: 'uploaded', transcript: T }, deps);
    expect(calls.extract[0].text).toHaveLength(PLAN_TEXT_CAP);
  });

  test('LP_FIDELITY_RUNS=3 → three gradings; the median scored run is kept whole, with every run and the spread', async () => {
    process.env.LP_FIDELITY_RUNS = '3';
    const seq = ['not_done', 'executed', 'partial']; // 50, 100, 75
    let n = 0;
    const { deps } = spyDeps({ analyzeFidelity: async () => V(seq[n++]) });
    const r = await computeLpFidelity({ planText: PLAN, source: 'pasted', transcript: T }, deps);
    expect(n).toBe(3);
    expect(r.fidelity_pct).toBe(75);
    expect(r.runs.map((x) => x.pct)).toEqual([50, 75, 100]);
    expect(r.runs_requested).toBe(3);
    expect(r.spread).toBe(50);
    expect(r.moves.find((m) => m.move_id === 'm2').verdict).toBe('partial');
  });

  test('an even LP_FIDELITY_RUNS rounds up to odd; junk is one run; more than 5 is 5; input.runs overrides', async () => {
    for (const [val, want] of [['2', 3], ['4', 5], ['0', 1], ['abc', 1], ['9', 5]]) {
      process.env.LP_FIDELITY_RUNS = val;
      let n = 0;
      const { deps } = spyDeps({ analyzeFidelity: async () => { n += 1; return V('executed'); } });
      await computeLpFidelity({ planText: PLAN, source: 'pasted', transcript: T }, deps);
      expect(n).toBe(want);
    }
    process.env.LP_FIDELITY_RUNS = '5';
    let n = 0;
    const { deps } = spyDeps({ analyzeFidelity: async () => { n += 1; return V('executed'); } });
    await computeLpFidelity({ planText: PLAN, source: 'pasted', transcript: T, runs: 1 }, deps);
    expect(n).toBe(1);
  });

  test('isFidelityEnabled is off unless LP_FIDELITY_ENABLED is exactly "true"', () => {
    const before = process.env.LP_FIDELITY_ENABLED;
    try {
      for (const [v, want] of [['true', true], ['TRUE', false], ['1', false], ['', false], [undefined, false]]) {
        if (v === undefined) delete process.env.LP_FIDELITY_ENABLED; else process.env.LP_FIDELITY_ENABLED = v;
        expect(orchestrator.isFidelityEnabled()).toBe(want);
      }
    } finally {
      if (before === undefined) delete process.env.LP_FIDELITY_ENABLED; else process.env.LP_FIDELITY_ENABLED = before;
    }
  });
});
