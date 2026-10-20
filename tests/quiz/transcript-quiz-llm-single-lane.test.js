'use strict';
/**
 * Every quiz LLM call goes through llm-client.getClientForModel with the model
 * id it asked for — there is one lane. An `anthropic/` model (the blind solve's
 * default) is an OpenRouter id like any other: it is never rewritten to a
 * provider-direct id, whatever keys the deployment happens to hold, and the
 * request is the OpenRouter chat-completions shape.
 *
 * Only the model client (the network boundary) is mocked.
 */

const mockCreate = jest.fn();
const mockGetClientForModel = jest.fn((model, opts) => ({
  client: { chat: { completions: { create: (...a) => mockCreate(...a) } } },
  model,
  job: opts && opts.job,
}));
jest.mock('../../bot/shared/services/llm-client', () => ({
  getClientForModel: (...a) => mockGetClientForModel(...a),
}));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));

const ENV = ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'LLM_PROVIDER', 'TRANSCRIPT_QUIZ_MODEL'];
const saved = {};
beforeEach(() => {
  mockCreate.mockReset();
  mockGetClientForModel.mockClear();
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const Llm = require('../../bot/shared/services/quiz/transcript-quiz-llm');

const ok = (content) => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { cost: 0.002 } });

test('an anthropic/ model stays an OpenRouter id even with an Anthropic key present', async () => {
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'k-a', OPENROUTER_API_KEY: 'k-or', LLM_PROVIDER: 'openrouter' });
  mockCreate.mockResolvedValue(ok('{"answers":[]}'));
  const out = await Llm.completeJson({
    prompt: 'Solve.', maxTokens: 8000, label: 'key_verify', model: 'anthropic/claude-sonnet-5', job: 'quiz.keyVerify',
  });
  expect(mockGetClientForModel).toHaveBeenCalledWith('anthropic/claude-sonnet-5', { job: 'quiz.keyVerify' });
  const params = mockCreate.mock.calls[0][0];
  expect(params.model).toBe('anthropic/claude-sonnet-5');
  expect(params.response_format).toEqual({ type: 'json_object' });
  expect(params.reasoning).toEqual({ effort: 'low' });
  expect(params.output_config).toBeUndefined();
  expect(out.model).toBe('anthropic/claude-sonnet-5');
  expect(out.costUsd).toBe(0.002);
});

test('there is no provider-direct lane to configure', () => {
  expect(Llm.directModelFor).toBeUndefined();
});

test('a pass that names no job is billed as quiz.transcript on TRANSCRIPT_QUIZ_MODEL', async () => {
  process.env.TRANSCRIPT_QUIZ_MODEL = 'openai/gpt-5.4-mini';
  mockCreate.mockResolvedValue(ok('{"ok":1}'));
  await Llm.completeJson({ prompt: 'p' });
  expect(mockGetClientForModel).toHaveBeenCalledWith('openai/gpt-5.4-mini', { job: 'quiz.transcript' });
});
