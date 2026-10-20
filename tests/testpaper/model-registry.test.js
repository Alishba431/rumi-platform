/**
 * model-registry — which model a job runs on, resolved per request.
 *
 * A slim shim of the per-job registry the test-paper generator was written
 * against: the same `resolveModelForJob(job, ctx)` call shape, with only the
 * jobs this repo has, an env override per job and a default that works with
 * the one OpenRouter key a fresh clone is configured with.
 */

let Registry;

beforeEach(() => {
  jest.resetModules();
  delete process.env.TESTPAPER_MODEL;
  delete process.env.LLM_PROVIDER;
  Registry = require('../../bot/shared/config/model-registry');
});

afterAll(() => {
  delete process.env.TESTPAPER_MODEL;
  delete process.env.LLM_PROVIDER;
});

describe('resolveModelForJob', () => {
  it('defaults the test-paper jobs to an OpenRouter model id', () => {
    const { model, source } = Registry.resolveModelForJob('testpaper.generate');
    expect(model).toBe(Registry.JOBS['testpaper.generate'].default);
    expect(model).toMatch(/^[a-z0-9-]+\/[a-z0-9.-]+$/);
    expect(source).toBe('default');
  });

  it('honours the job\'s env override, read at call time', () => {
    const before = Registry.resolveModelForJob('testpaper.generate').model;
    process.env.TESTPAPER_MODEL = 'openai/gpt-4.1';
    expect(Registry.resolveModelForJob('testpaper.generate')).toEqual({ model: 'openai/gpt-4.1', source: 'env' });
    expect(Registry.resolveModelForJob('testpaper.revise').model).toBe('openai/gpt-4.1');
    delete process.env.TESTPAPER_MODEL;
    expect(Registry.resolveModelForJob('testpaper.generate').model).toBe(before);
  });

  it('ignores an override that is not a model id', () => {
    process.env.TESTPAPER_MODEL = 'please use the good one';
    expect(Registry.resolveModelForJob('testpaper.generate').source).toBe('default');
  });

  it('an explicit model in the context wins', () => {
    expect(Registry.resolveModelForJob('testpaper.generate', { model: 'anthropic/claude-sonnet-5' }))
      .toEqual({ model: 'anthropic/claude-sonnet-5', source: 'context' });
  });

  it('direct OpenAI deployments get an OpenAI model, not an OpenRouter id', () => {
    process.env.LLM_PROVIDER = 'openai';
    const { model } = Registry.resolveModelForJob('testpaper.generate');
    expect(model).not.toContain('/');
  });

  it('an unknown job falls back to the platform default model', () => {
    expect(Registry.resolveModelForJob('nothing.here').source).toBe('platform');
  });
});
