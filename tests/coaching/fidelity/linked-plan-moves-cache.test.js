'use strict';
/**
 * A plan Rumi made is taught again and again; every lesson taught from it must be graded against the SAME move list.
 * Re-extracting the moves at each grading let the denominator drift (13 moves one time, 14 the next, an optional
 * extension counted once and not the other), so the same lesson scored 80.8 and then 61.5 in end-to-end runs. The
 * first extraction is now kept on the plan's own row (content.fidelity_moves, keyed by the hash of the plan text the
 * moves came from) and reused; an edited plan (new hash) is extracted afresh.
 */
const { makeFakeDb } = require('./_fake-db');

let mockDb;
jest.mock('../../../bot/shared/config/supabase', () => new Proxy({}, { get: (_t, k) => mockDb[k] }));
jest.mock('../../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));

const { computeFidelityForSession } = require('../../../bot/shared/services/coaching/fidelity/fidelity-session');

const PLAN = 'Hook: pizza with eight slices. Fold paper strips into eighths. Model 3/8 + 2/8. Word problem in pairs. Exit ticket of five questions.';
const MOVES = [{ move_id: 'm1', phase: 'hook', text: 'Pizza hook', bucket: 'must_happen' }, { move_id: 'm2', phase: 'exit', text: 'Exit ticket', bucket: 'must_happen' }];
const T = '[00:10] Teacher (EN): pizza\n\n[02:00] Teacher (EN): exit ticket';

function seed(content) {
  mockDb = makeFakeDb({ lesson_plans: [{ id: 'lp-1', topic: 'Fractions', content, pdf_url: null }] });
}
const session = { id: 's1', transcript_text: T, linked_lesson_plan_id: 'lp-1', lesson_plan_text: null };
const grader = async () => ({ verdicts: [{ move_id: 'm1', verdict: 'executed', evidence: '[00:10] pizza' }, { move_id: 'm2', verdict: 'executed', evidence: '[02:00] exit' }], model: 'm' });

describe('linked plan: one move list per plan', () => {
  test('the first grading extracts and keeps the moves on the plan row; the next reuses them', async () => {
    seed({ plan_text: PLAN });
    let extracts = 0;
    const deps = { extractPlanMoves: async () => { extracts += 1; return { goal: 'g', moves: MOVES }; }, analyzeFidelity: grader };
    const first = await computeFidelityForSession(session, { deps });
    expect(first.status).toBe('ok');
    const kept = mockDb.tables.lesson_plans[0].content.fidelity_moves;
    expect(kept).toMatchObject({ plan_hash: first.plan_hash, goal: 'g', moves: MOVES });
    expect(mockDb.tables.lesson_plans[0].content.plan_text).toBe(PLAN);

    const second = await computeFidelityForSession(session, { deps });
    expect(extracts).toBe(1);
    expect(second.moves.map((m) => m.move_id)).toEqual(['m1', 'm2']);
  });

  test('an edited plan (different text) is extracted afresh', async () => {
    seed({ plan_text: PLAN, fidelity_moves: { plan_hash: 'stale', goal: 'old', moves: [{ move_id: 'x', text: 'old', bucket: 'must_happen' }] } });
    let extracts = 0;
    const deps = { extractPlanMoves: async () => { extracts += 1; return { goal: 'g', moves: MOVES }; }, analyzeFidelity: grader };
    await computeFidelityForSession(session, { deps });
    expect(extracts).toBe(1);
    expect(mockDb.tables.lesson_plans[0].content.fidelity_moves.goal).toBe('g');
  });

  test('uploaded and pasted plans are not cached on any plan row', async () => {
    seed({ plan_text: PLAN });
    let extracts = 0;
    const deps = { extractPlanMoves: async () => { extracts += 1; return { goal: 'g', moves: MOVES }; }, analyzeFidelity: grader };
    await computeFidelityForSession({ id: 's2', transcript_text: T, lesson_plan_text: PLAN, lesson_plan_link_method: 'pasted' }, { deps });
    expect(mockDb.tables.lesson_plans[0].content.fidelity_moves).toBeUndefined();
    expect(extracts).toBe(1);
  });
});
