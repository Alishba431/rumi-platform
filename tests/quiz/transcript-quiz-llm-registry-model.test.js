'use strict';
/**
 * The lesson quiz's own passes (digest, author, rewrites, plan key check) name
 * no model: the model comes from the registry job `quiz.transcript`, so a
 * deployment on LLM_PROVIDER=openai gets the job's OpenAI default, and a typo in
 * TRANSCRIPT_QUIZ_MODEL never reaches the provider as a model name.
 *
 * Drives the real completeJson → real llm-client → real model-registry; only the
 * OpenAI SDK (the network boundary) is mocked.
 */

const mockCreate = jest.fn();
jest.mock('openai', () => jest.fn((config) => ({
  _config: config,
  chat: { completions: { create: (...a) => mockCreate(...a) } },
})));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));

const VARS = ['LLM_PROVIDER', 'TRANSCRIPT_QUIZ_MODEL', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'];
const saved = {};
beforeEach(() => {
  jest.resetModules();
  mockCreate.mockReset();
  mockCreate.mockResolvedValue({ choices: [{ message: { content: '{"ok":1}' }, finish_reason: 'stop' }], usage: {} });
  for (const k of VARS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => { for (const k of VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const load = () => require('../../bot/shared/services/quiz/transcript-quiz-llm');

test('under LLM_PROVIDER=openai a quiz pass sends the registry OpenAI default', async () => {
  Object.assign(process.env, { LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'k-test' });
  const out = await load().completeJson({ prompt: 'p' });
  expect(mockCreate.mock.calls[0][0].model).toBe('gpt-4.1-mini');
  expect(mockCreate.mock.calls[0][0].usage).toBeUndefined();
  expect(out.model).toBe('gpt-4.1-mini');
});

test('a typo in TRANSCRIPT_QUIZ_MODEL falls back to the registry default', async () => {
  Object.assign(process.env, { OPENROUTER_API_KEY: 'k-test', TRANSCRIPT_QUIZ_MODEL: 'bad model;rm' });
  await load().completeJson({ prompt: 'p' });
  expect(mockCreate.mock.calls[0][0].model).toBe('google/gemini-2.5-flash');
});

test('a valid TRANSCRIPT_QUIZ_MODEL still wins, and an explicit per-call model wins over it', async () => {
  Object.assign(process.env, { OPENROUTER_API_KEY: 'k-test', TRANSCRIPT_QUIZ_MODEL: 'openai/gpt-5.4-mini' });
  const Llm = load();
  await Llm.completeJson({ prompt: 'p' });
  expect(mockCreate.mock.calls[0][0].model).toBe('openai/gpt-5.4-mini');
  await Llm.completeJson({ prompt: 'p', model: 'anthropic/claude-sonnet-5', job: 'quiz.keyVerify' });
  expect(mockCreate.mock.calls[1][0].model).toBe('anthropic/claude-sonnet-5');
});

test('there is no second hard-coded default beside the registry', () => {
  expect(load().DEFAULT_MODEL).toBeUndefined();
});
