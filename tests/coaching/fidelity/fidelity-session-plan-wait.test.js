'use strict';
/**
 * An uploaded plan is read by a background job that is queued at the same moment as the analysis, so the analysis
 * can start before the plan's text exists. Rather than grade "no plan" and recover later, the analysis's fidelity
 * task waits (LP_FIDELITY_PLAN_WAIT_SECONDS, default 90) while the plan is still being read, then grades with it.
 */
const { makeFakeDb } = require('./_fake-db');

let mockDb;
jest.mock('../../../bot/shared/config/supabase', () => new Proxy({}, { get: (_t, k) => mockDb[k] }));
jest.mock('../../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));

const { computeFidelityForSession } = require('../../../bot/shared/services/coaching/fidelity/fidelity-session');

const PLAN = 'Explain adding fractions with paper fraction strips folded into fifths, then an exit ticket with one question each.';
const T = '[00:10] Teacher (EN): fold the strip';

describe('computeFidelityForSession · waiting for a plan still being read', () => {
  test('waits for the extraction to finish, then grades with the plan', async () => {
    const session = { id: 's1', transcript_text: T, lesson_plan_text: null, lesson_plan_extraction_status: 'pending' };
    mockDb = makeFakeDb({ coaching_sessions: [{ ...session }] });
    const row = mockDb.tables.coaching_sessions[0];
    setTimeout(() => Object.assign(row, { lesson_plan_text: PLAN, lesson_plan_extraction_status: 'completed' }), 30);
    let seenPlan = null;
    const r = await computeFidelityForSession(session, { waitForPlan: true, pollMs: 10, computeLpFidelity: async (input) => { seenPlan = input.planText; return { status: 'ok' }; } });
    expect(seenPlan).toBe(PLAN);
    expect(r.status).toBe('ok');
  });

  test('gives up after the wait and grades with what there is', async () => {
    process.env.LP_FIDELITY_PLAN_WAIT_SECONDS = '0.05';
    try {
      const session = { id: 's1', transcript_text: T, lesson_plan_text: null, lesson_plan_extraction_status: 'pending' };
      mockDb = makeFakeDb({ coaching_sessions: [{ ...session }] });
      let seenPlan = 'x';
      await computeFidelityForSession(session, { waitForPlan: true, pollMs: 10, computeLpFidelity: async (input) => { seenPlan = input.planText; return { status: 'lp_absent' }; } });
      expect(seenPlan).toBeNull();
    } finally { delete process.env.LP_FIDELITY_PLAN_WAIT_SECONDS; }
  });

  test('no upload in flight → no wait at all', async () => {
    mockDb = makeFakeDb({ coaching_sessions: [] });
    const t0 = Date.now();
    await computeFidelityForSession({ id: 's1', transcript_text: T, lesson_plan_text: PLAN, lesson_plan_link_method: 'pasted' }, { waitForPlan: true, computeLpFidelity: async () => ({ status: 'ok' }) });
    expect(Date.now() - t0).toBeLessThan(50);
  });
});
