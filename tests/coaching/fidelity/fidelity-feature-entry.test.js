'use strict';
/**
 * Lesson-plan fidelity is a FEATURES entry, so `rumi doctor` and the console show whether it is on. It is the first
 * entry gated on a flag as well as a key: it needs SONIOX_API_KEY (only the diarized transcript carries the [MM:SS]
 * timings the grader quotes) AND LP_FIDELITY_ENABLED=true (it ships off). The operator's console switch can pause it.
 */
const fa = require('../../../bot/shared/config/feature-availability');
const overrides = require('../../../bot/shared/config/feature-overrides');
const { isFidelityEnabled } = require('../../../bot/shared/services/coaching/fidelity/fidelity-orchestrator');

const entry = () => fa.FEATURES.find((f) => f.id === 'lp_fidelity');

describe('lp_fidelity feature entry', () => {
  test('is listed, gated on the Soniox key and the LP_FIDELITY_ENABLED flag', () => {
    expect(entry()).toMatchObject({ keys: ['SONIOX_API_KEY'], flag: 'LP_FIDELITY_ENABLED' });
    expect(entry().name).toMatch(/lesson-plan fidelity/i);
  });

  test.each([
    [{ SONIOX_API_KEY: 'k' }, false],
    [{ SONIOX_API_KEY: 'k', LP_FIDELITY_ENABLED: 'false' }, false],
    [{ SONIOX_API_KEY: 'k', LP_FIDELITY_ENABLED: 'true' }, true],
    [{ LP_FIDELITY_ENABLED: 'true' }, false],
  ])('%j → %s', (env, want) => {
    expect(fa.isFeatureAvailable(entry(), env)).toBe(want);
  });

  test('a flag entry is never "configured" while its flag is off', () => {
    expect(fa.configuredFeatures({ SONIOX_API_KEY: 'k' })).not.toContain(entry().name);
    expect(fa.configuredFeatures({ SONIOX_API_KEY: 'k', LP_FIDELITY_ENABLED: 'true' })).toContain(entry().name);
  });
});

describe('isFidelityEnabled', () => {
  const saved = process.env.LP_FIDELITY_ENABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.LP_FIDELITY_ENABLED; else process.env.LP_FIDELITY_ENABLED = saved;
    overrides.load({});
  });

  test('the console switch (RUMI_FEATURE_LP_FIDELITY=off) pauses it without touching the flag', () => {
    process.env.LP_FIDELITY_ENABLED = 'true';
    overrides.load({});
    expect(isFidelityEnabled()).toBe(true);
    overrides.load({ RUMI_FEATURE_LP_FIDELITY: 'off' });
    expect(isFidelityEnabled()).toBe(false);
  });
});
