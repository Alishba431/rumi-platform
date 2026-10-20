'use strict';
/**
 * FICO's applyLpFidelity hook replaces indicator 1.2 with the measurement. A recompute applies it again on an
 * analysis it already changed (review S2): the model's original score must be kept once, never overwritten by the
 * previous measured score, and a new result that is NOT measured must restore it.
 */
jest.mock('../../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
const fico = require('../../../bot/shared/services/coaching/frameworks/fico-framework');

const analysis = () => ({
  domains: { lesson_structure: { indicators: [
    { id: '1.1', score: 3 }, { id: '1.2', score: 2, evidence: 'model guess' }, { id: '1.3', score: 3 }, { id: '1.4', score: 3 },
  ] } },
});
const measured = (pct, band) => ({ status: 'ok', fidelity_pct: pct, band, moves: [{ counted: true, credit: 1 }] });
const ind = (a) => a.domains.lesson_structure.indicators.find((i) => i.id === '1.2');

describe('fico.applyLpFidelity across a recompute', () => {
  test('a second measurement keeps the model\'s original score, not the first measurement', () => {
    let a = fico.applyLpFidelity(analysis(), measured(90, 'high'));
    expect(ind(a)).toMatchObject({ score: 4, score_before_fidelity: 2, fidelity_derived: true });
    a = fico.applyLpFidelity(a, measured(55, 'partial'));
    expect(ind(a)).toMatchObject({ score: 3, score_before_fidelity: 2, fidelity_derived: true });
  });

  test('a new result that is not measured restores the model\'s score and evidence', () => {
    let a = fico.applyLpFidelity(analysis(), measured(90, 'high'));
    a = fico.applyLpFidelity(a, { status: 'ok', fidelity_pct: null, unusable_guard: 'no_timestamps' });
    expect(ind(a)).toMatchObject({ score: 2, evidence: 'model guess' });
    expect(ind(a)).not.toHaveProperty('fidelity_derived');
    expect(a.scores.overall_marks).toBe(11);
    a = fico.applyLpFidelity(a, { status: 'fidelity_unavailable' });
    expect(ind(a).score).toBe(2);
  });
});
