/**
 * getClientForModel — the per-job entry the lesson quiz calls (one OpenRouter key
 * runs every quiz pass). The shim sits over the same OSS client; no second
 * provider lane.
 */

const mockCreate = jest.fn(async (params) => ({ choices: [{ message: { content: '{}' } }], params }));
// Like the SDK, `parse` and `stream` live on the Completions prototype, not on the instance.
const mockParse = jest.fn(async () => ({ parsed: true }));
jest.mock('openai', () => jest.fn((config) => ({
  _config: config,
  chat: { completions: Object.assign(Object.create({ parse: mockParse, stream() {} }), { create: mockCreate }) },
})));

describe('llm-client getClientForModel', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    jest.resetModules();
    mockCreate.mockClear();
    process.env = { ...originalEnv };
    delete process.env.LLM_PROVIDER;
    delete process.env.TRANSCRIPT_QUIZ_MODEL;
    delete process.env.TRANSCRIPT_QUIZ_VERIFY_MODEL;
    delete process.env.QUIZ_REPORT_MODEL;
  });
  afterAll(() => { process.env = originalEnv; });

  it('returns the shared OpenRouter client and the requested model, untouched', () => {
    const { getClientForModel, getClient } = require('../../bot/shared/services/llm-client');
    const out = getClientForModel('google/gemini-2.5-flash', { job: 'quiz.transcript' });
    expect(out.model).toBe('google/gemini-2.5-flash');
    expect(out.client).toBe(getClient());
  });

  it('falls back to the job default when no model is named', () => {
    const { getClientForModel } = require('../../bot/shared/services/llm-client');
    expect(getClientForModel(null, { job: 'quiz.keyVerify' }).model).toBe('anthropic/claude-sonnet-5');
    expect(getClientForModel('', { job: 'quiz.videoReport' }).model).toBe('openai/gpt-5.4-mini');
  });

  it('on LLM_PROVIDER=openai, strips the openai/ prefix and the OpenRouter-only params', async () => {
    process.env.LLM_PROVIDER = 'openai';
    const { getClientForModel } = require('../../bot/shared/services/llm-client');
    const { client, model } = getClientForModel('openai/gpt-5.4-mini', { job: 'quiz.videoReport' });
    expect(model).toBe('gpt-5.4-mini');
    await client.chat.completions.create({
      model, messages: [], usage: { include: true }, reasoning: { effort: 'low' },
    });
    const sent = mockCreate.mock.calls[0][0];
    expect(sent.usage).toBeUndefined();
    expect(sent.reasoning).toBeUndefined();
    expect(sent.model).toBe('gpt-5.4-mini');
  });
});

describe('getClientForModel follows the client getClient() built (review A-N5)', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    jest.resetModules();
    mockCreate.mockClear();
    process.env = { ...originalEnv };
    delete process.env.LLM_PROVIDER;
    delete process.env.TRANSCRIPT_QUIZ_VERIFY_MODEL;
  });
  afterAll(() => { process.env = originalEnv; });

  it('an env flip after start does not turn the OpenRouter client into the OpenAI wrapper', () => {
    const { getClientForModel, getClient } = require('../../bot/shared/services/llm-client');
    process.env.LLM_PROVIDER = 'openai';
    const out = getClientForModel('openai/gpt-5.4-mini', { job: 'quiz.videoReport' });
    expect(out.client).toBe(getClient());
    expect(out.model).toBe('openai/gpt-5.4-mini');
    // and a job default is the OpenRouter one the client can run
    expect(getClientForModel(null, { job: 'quiz.keyVerify' }).model).toBe('anthropic/claude-sonnet-5');
  });

  it('started on openai, it stays on openai when the env is changed later', () => {
    process.env.LLM_PROVIDER = 'openai';
    const { getClientForModel } = require('../../bot/shared/services/llm-client');
    delete process.env.LLM_PROVIDER;
    expect(getClientForModel('openai/gpt-5.4-mini', { job: 'quiz.videoReport' }).model).toBe('gpt-5.4-mini');
    expect(getClientForModel(null, { job: 'quiz.transcript' }).model).toBe('gpt-4.1-mini');
  });

  it('the OpenAI wrapper keeps the SDK prototype methods (parse, stream)', async () => {
    process.env.LLM_PROVIDER = 'openai';
    const { getClientForModel } = require('../../bot/shared/services/llm-client');
    const { client } = getClientForModel('gpt-4.1-mini', { job: 'quiz.transcript' });
    expect(typeof client.chat.completions.parse).toBe('function');
    expect(typeof client.chat.completions.stream).toBe('function');
    await expect(client.chat.completions.parse({})).resolves.toEqual({ parsed: true });
  });

  it('on openai, an OpenRouter id of another vendor falls back to the job\'s OpenAI default', () => {
    process.env.LLM_PROVIDER = 'openai';
    const { getClientForModel } = require('../../bot/shared/services/llm-client');
    const { JOBS } = require('../../bot/shared/config/model-registry');
    const out = getClientForModel('anthropic/claude-sonnet-5', { job: 'quiz.keyVerify' });
    expect(out.model).toBe(JOBS['quiz.keyVerify'].openaiDefault);
    expect(out.model).not.toMatch(/\//);
    // with no job, still never a foreign id sent to api.openai.com
    expect(getClientForModel('google/gemini-2.5-flash').model).not.toMatch(/\//);
  });
});

describe('model-registry (quiz jobs)', () => {
  it('each quiz job keeps its own env var and a default that runs on one OpenRouter key, read per call', () => {
    const { resolveModelForJob, JOBS } = require('../../bot/shared/config/model-registry');
    expect(Object.keys(JOBS)).toEqual(expect.arrayContaining(['quiz.keyVerify', 'quiz.transcript', 'quiz.videoReport']));
    expect(resolveModelForJob('quiz.transcript', {}, {}).model).toBe('google/gemini-2.5-flash');
    expect(resolveModelForJob('quiz.transcript', {}, { TRANSCRIPT_QUIZ_MODEL: 'openai/gpt-4.1-mini' }).model).toBe('openai/gpt-4.1-mini');
    expect(resolveModelForJob('quiz.keyVerify', {}, { TRANSCRIPT_QUIZ_VERIFY_MODEL: '  ' }).model).toBe('anthropic/claude-sonnet-5');
    expect(resolveModelForJob('quiz.videoReport', {}, {}).model).toBe('openai/gpt-5.4-mini');
  });

  it('under LLM_PROVIDER=openai a quiz job gets an OpenAI model', () => {
    const { resolveModelForJob } = require('../../bot/shared/config/model-registry');
    for (const job of ['quiz.transcript', 'quiz.keyVerify', 'quiz.videoReport']) {
      expect(resolveModelForJob(job, {}, { LLM_PROVIDER: 'openai' }).model).not.toMatch(/\//);
    }
  });
});
