/**
 * The observe framework pack: one observation pipeline, several rubrics,
 * chosen by OBSERVE_FRAMEWORK. TEACH (the public classroom observation tool
 * already shipped in frameworks/) is the default, so a fresh clone needs no
 * rubric decision to try /observe.
 */

const { getObservePack, OBSERVE_FRAMEWORK_KEYS } = require('../../bot/shared/services/observe/observe-framework');
const { buildTeachGroups } = require('../../bot/shared/services/coaching/report-v2/score-adapters/teach-adapter');

describe('observe framework pack', () => {
  const saved = process.env.OBSERVE_FRAMEWORK;
  afterEach(() => {
    if (saved === undefined) delete process.env.OBSERVE_FRAMEWORK;
    else process.env.OBSERVE_FRAMEWORK = saved;
  });

  test('defaults to TEACH when OBSERVE_FRAMEWORK is unset or unknown', () => {
    delete process.env.OBSERVE_FRAMEWORK;
    expect(getObservePack().key).toBe('teach');
    process.env.OBSERVE_FRAMEWORK = 'not-a-rubric';
    expect(getObservePack().key).toBe('teach');
  });

  test('offers teach, hots and mewaka', () => {
    expect(OBSERVE_FRAMEWORK_KEYS).toEqual(['teach', 'hots', 'mewaka']);
    for (const key of OBSERVE_FRAMEWORK_KEYS) {
      process.env.OBSERVE_FRAMEWORK = key;
      const pack = getObservePack();
      expect(pack.key).toBe(key);
      expect(pack.domainOrder.length).toBeGreaterThan(0);
      for (const d of pack.domainOrder) {
        expect(pack.domains[d].title).toEqual(expect.any(String));
        expect(pack.domains[d].indicators.length).toBeGreaterThan(0);
        pack.domains[d].indicators.forEach((i) => expect(i.name).toEqual(expect.any(String)));
      }
      expect(pack.scaleOptions.length).toBeGreaterThan(1);
      expect(typeof pack.module.buildAnalysisPrompt).toBe('function');
    }
  });

  test('TEACH pack scores 1-5 per indicator and clamps out-of-range ratings', () => {
    delete process.env.OBSERVE_FRAMEWORK;
    const pack = getObservePack();
    expect(pack.scaleOptions.map((o) => o.id)).toEqual(['1', '2', '3', '4', '5']);
    const analysis = { domains: {} };
    for (const d of pack.domainOrder) {
      analysis.domains[d] = { indicators: pack.domains[d].indicators.map((i) => ({ id: i.id, score: 4 })) };
    }
    analysis.domains.instruction.indicators[0].score = 9;   // clamps to 5
    analysis.domains.instruction.indicators[1].score = 0;   // clamps to 1
    pack.computeScores(analysis);
    // 10 indicators (time on task + 9 elements), max 50 — the TEACH tool's own total.
    expect(analysis.scores.overall_max_marks).toBe(50);
    expect(analysis.scores.overall_marks).toBe(4 * 8 + 5 + 1);
    expect(analysis.framework).toBe('teach');
  });

  test('TEACH pack mirrors scores into the areas shape the TEACH hero-report adapter reads', () => {
    delete process.env.OBSERVE_FRAMEWORK;
    const pack = getObservePack();
    const analysis = { domains: {} };
    for (const d of pack.domainOrder) {
      analysis.domains[d] = { indicators: pack.domains[d].indicators.map((i) => ({ id: i.id, score: 3 })) };
    }
    pack.computeScores(analysis);
    const groups = buildTeachGroups(analysis);
    expect(groups[0]).toMatchObject({ key: 'T1', score: 3, max: 5 });
    expect(groups.find((g) => g.name === 'Instruction')).toMatchObject({ score: 12, max: 20 });
  });

  test('the TEACH observe prompt asks for the domains shape, never invents evidence', () => {
    delete process.env.OBSERVE_FRAMEWORK;
    const prompt = getObservePack().module.buildAnalysisPrompt('T: Good morning class.', { teacherName: 'Alex' });
    expect(prompt).toContain('"domains"');
    expect(prompt).toContain('T: Good morning class.');
    expect(prompt).toMatch(/never invent/i);
  });
});
