'use strict';
/**
 * analysis_data.lp_fidelity → what the teacher reads: the report's fidelity block (band, "N of M planned moves",
 * one row per planned move with the [MM:SS] moment) and one chat line. Every way fidelity can fall short has its OWN
 * words, because each one tells the teacher something different — a single shared "no usable plan" line once sent
 * readers chasing the wrong cause for days.
 */
jest.mock('../../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));

const { fidelityState, buildFidelityReportSection, fidelityChatLine } = require('../../../bot/shared/services/coaching/fidelity/fidelity-report');
const { extractFidelity } = require('../../../bot/shared/services/coaching/report-transformers/_shared');

const row = (id, phase, verdict, over = {}) => ({
  move_id: id, phase, text: `move ${id}`, verdict, counted: verdict !== 'not_adjudicable',
  credit: { executed: 1, substituted_equivalent: 1, partial: 0.5, not_done: 0 }[verdict] ?? null,
  evidence: verdict === 'not_done' ? '' : `[0${id.slice(1)}:00] said it`, evidence_translation: '', ...over,
});

const MEASURED = {
  status: 'ok', source: 'linked', fidelity_pct: 66.7, band: 'partial', narrative: 'Most of the plan happened.',
  moves: [row('m1', 'warm_up', 'executed'), row('m2', 'explain', 'substituted_equivalent'), row('m3', 'guided', 'partial'), row('m4', 'exit', 'not_done'), row('m5', 'homework', 'not_adjudicable')],
  strengths: [], not_assessed: ['m5'], moderators: { note: '' },
};

describe('fidelityState — one state per outcome', () => {
  test.each([
    [MEASURED, 'measured'],
    [{ ...MEASURED, fidelity_pct: 4, band: 'low', moderators: { note: 'lesson_mismatch' } }, 'lesson_mismatch'],
    [{ status: 'ok', fidelity_pct: null, unusable_guard: 'no_timestamps', recording_unusable: true, moves: [] }, 'no_timings'],
    [{ status: 'ok', fidelity_pct: null, recording_unusable: true, moves: [row('m1', 'explain', 'not_adjudicable')] }, 'recording_unusable'],
    [{ status: 'lp_absent' }, 'no_plan'],
    [{ status: 'lp_unparseable', error: 'lp_unparseable' }, 'plan_unreadable'],
    [{ status: 'fidelity_unavailable', error: 'fidelity_unavailable', cause: 'truncated' }, 'grader_failed'],
    [null, null],
    [undefined, null],
  ])('%#', (lp, want) => {
    expect(fidelityState(lp)).toBe(want);
  });
});

describe('fidelityChatLine — distinct words for each state', () => {
  test('every state has its own non-empty line, and no two are the same', () => {
    const lines = ['measured', 'lesson_mismatch', 'no_timings', 'recording_unusable', 'no_plan', 'plan_unreadable', 'grader_failed']
      .map((state) => fidelityChatLine({ state, delivered: 2, total: 4, band: 'partial' }, 'en'));
    for (const l of lines) expect(l.length).toBeGreaterThan(20);
    expect(new Set(lines).size).toBe(lines.length);
  });

  test('the measured line speaks moves and the band in words, never a percentage', () => {
    const line = fidelityChatLine({ state: 'measured', delivered: 2, total: 4, band: 'partial' }, 'en');
    expect(line).toContain('2 of 4');
    expect(line).not.toMatch(/%/);
  });

  test('the timings line blames the recording, not the teacher', () => {
    expect(fidelityChatLine({ state: 'no_timings' }, 'en')).toMatch(/timing/i);
  });
});

describe('buildFidelityReportSection', () => {
  test('measured: band, "N of M planned moves", and one table row per counted planned move', () => {
    const s = buildFidelityReportSection(MEASURED);
    expect(s).toMatchObject({ measured: true, state: 'measured', score: 66.7, maxScore: 100, band: 'partial' });
    expect(s.note).toBe('2 of 4 planned moves delivered');
    expect(s.perAction.map((r) => [r.phaseLabel, r.verdictLabel])).toEqual([
      ['Warm-up', 'Done'], ['Explain', 'Done another way'], ['Guided practice', 'Partly'], ['Exit check', 'Not seen'],
    ]);
    expect(s.perAction[0].evidence).toBe('[01:00] said it');
    expect(s.notAssessedCount).toBe(1);
    expect(s.gaps).toEqual(['move m4']);
    expect(s.commentary).toBe('Most of the plan happened.');
    expect(s.statusLine).toBe(fidelityChatLine({ state: 'measured', delivered: 2, total: 4, band: 'partial' }, 'en'));
  });

  test('a different lesson keeps its (near-zero) score but says the plan did not match', () => {
    const s = buildFidelityReportSection({ ...MEASURED, fidelity_pct: 0, band: 'low', moderators: { note: 'lesson_mismatch' } });
    expect(s.measured).toBe(true);
    expect(s.state).toBe('lesson_mismatch');
    expect(s.statusLine).toMatch(/match/i);
  });

  test.each([
    [{ status: 'ok', fidelity_pct: null, unusable_guard: 'no_timestamps', recording_unusable: true, moves: [] }, 'no_timings'],
    [{ status: 'lp_absent' }, 'no_plan'],
    [{ status: 'lp_unparseable' }, 'plan_unreadable'],
    [{ status: 'fidelity_unavailable' }, 'grader_failed'],
  ])('not measured (%#): no score, no table, its own status line — never 0%%', (lp, state) => {
    const s = buildFidelityReportSection(lp);
    expect(s).toMatchObject({ measured: false, state, score: null, perAction: [] });
    expect(s.statusLine).toBe(fidelityChatLine({ state }, 'en'));
  });
});

describe('a credit without a quoted moment', () => {
  test('the table says so instead of showing a blank or "not found"', () => {
    const s = buildFidelityReportSection({ ...MEASURED, moves: [row('m1', 'explain', 'executed', { evidence: '', unquoted: true })] });
    expect(s.perAction[0].unquoted).toBe(true);
  });
});

describe('the evidence gloss', () => {
  const withGloss = (evidence, gloss) => buildFidelityReportSection({ ...MEASURED, moves: [row('m1', 'explain', 'executed', { evidence, evidence_translation: gloss })] }).perAction[0];

  test('a gloss that only repeats the quote (same language) is not printed twice', () => {
    expect(withGloss('[00:50] Everyone take 1 paper strip.', 'Everyone take one paper strip').evidenceTranslation).toBe('');
    expect(withGloss('[00:50] Fold it into 5 parts', '(Fold it into 5 parts.)').evidenceTranslation).toBe('');
  });

  test('a real translation is kept', () => {
    expect(withGloss('[00:50] Har bacha ek patti le', 'Every child takes one strip').evidenceTranslation).toBe('Every child takes one strip');
  });
});

describe('extractFidelity (every report transformer)', () => {
  test('prefers the measured lp_fidelity blob', () => {
    expect(extractFidelity({ lp_fidelity: MEASURED, fidelity_analysis: { score: 85 } })).toMatchObject({ measured: true, score: 66.7 });
  });

  test('without lp_fidelity (flag off) the legacy block is exactly as before', () => {
    expect(extractFidelity({ fidelity_analysis: { score: 85, max_score: 100, note: 'n', overall_commentary: 'c', evidence: [], strengths: ['s'], gaps: [] } }))
      .toEqual({ score: 85, maxScore: 100, note: 'n', commentary: 'c', evidence: [], strengths: ['s'], gaps: [] });
    expect(extractFidelity({})).toBeNull();
  });
});

describe('OECD transformer (the default framework)', () => {
  const { transformOECDToReportData } = require('../../../bot/shared/services/coaching/report-transformers/oecd-report-transformer');
  const session = { id: 's1', created_at: '2026-10-01T09:00:00Z', lesson_plan_structured: null };

  test('carries the measured section instead of the model\'s estimate', () => {
    const data = transformOECDToReportData(session, 'Sam Teacher', { scores: {}, has_lesson_plan: true, lp_fidelity: MEASURED }, false);
    expect(data.fidelitySection).toMatchObject({ measured: true, note: '2 of 4 planned moves delivered' });
  });

  test('flag off: unchanged — no lp_fidelity, no section unless the legacy estimate exists', () => {
    const data = transformOECDToReportData(session, 'Sam Teacher', { scores: {} }, false);
    expect(data.fidelitySection).toBeNull();
  });
});

describe('TEACH transformer', () => {
  test('carries the section too (framework-neutral)', () => {
    const { transformTeachToReportData } = require('../../../bot/shared/services/coaching/report-transformers/teach-report-transformer');
    const data = transformTeachToReportData({ id: 's1', created_at: '2026-10-01T09:00:00Z' }, 'Sam Teacher', { lp_fidelity: MEASURED }, false);
    expect(data.fidelitySection).toMatchObject({ measured: true });
  });
});
