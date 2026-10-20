/**
 * Shared plumbing the observe debrief and report steps run on:
 *  - GPT5MiniService.completeJson — one JSON completion (guide, coach feedback,
 *    teacher notes all use it);
 *  - the two observe job types on the coaching job queue, with the identity
 *    each needs (a debrief job per recording; preview vs deliver per report).
 */

const { mockBotDependency } = require('../_helpers/mock-bot-dependency');

// jsonrepair is a bot-only package (the root CI job runs before bot deps
// install): a minimal stand-in that repairs the one malformation tested here.
mockBotDependency('jsonrepair', () => ({ jsonrepair: (s) => String(s).replace(/,\s*([}\]])/g, '$1') }));
const mockCreate = jest.fn();
jest.mock('../../bot/shared/services/llm-client', () => ({ getClient: () => ({ chat: { completions: { create: mockCreate } } }) }));
jest.mock('../../bot/shared/config/supabase', () => ({}));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
const mockQueue = { queueCoachingJob: jest.fn(async (s, t) => `${s}-${t}`) };
jest.mock('../../bot/shared/services/queue', () => mockQueue);

const GPT5MiniService = require('../../bot/shared/services/gpt5-mini.service');
const CoachingJobQueueService = require('../../bot/shared/services/coaching/coaching-job-queue.service');

describe('GPT5MiniService.completeJson', () => {
  beforeEach(() => mockCreate.mockReset());

  test('sends one user message in JSON mode and returns the parsed result with usage', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '{"wins":["a"],"try":"b"}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const { result, usage } = await GPT5MiniService.completeJson('Return JSON please', { maxTokens: 900, label: 't' });
    expect(result).toEqual({ wins: ['a'], try: 'b' });
    expect(usage).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
    const req = mockCreate.mock.calls[0][0];
    expect(req.messages).toEqual([{ role: 'user', content: 'Return JSON please' }]);
    expect(req.response_format).toEqual({ type: 'json_object' });
    expect(req.max_completion_tokens).toBe(900);
  });

  test('repairs slightly malformed JSON and rethrows a provider error', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: '{"a": 1,}' }, finish_reason: 'stop' }] });
    expect((await GPT5MiniService.completeJson('JSON')).result).toEqual({ a: 1 });
    mockCreate.mockRejectedValueOnce(new Error('provider down'));
    await expect(GPT5MiniService.completeJson('JSON')).rejects.toThrow('provider down');
  });
});

describe('observe job types on the coaching job queue', () => {
  beforeEach(() => mockQueue.queueCoachingJob.mockClear());

  test('queueObserveDebrief derives a per-recording dedupNonce from the audio id', async () => {
    await CoachingJobQueueService.queueObserveDebrief('s1', { from: '15550100001', audioId: 'media-1' });
    await CoachingJobQueueService.queueObserveDebrief('s1', { from: '15550100001', audioId: 'media-2' });
    const [a, b] = mockQueue.queueCoachingJob.mock.calls;
    expect(a[1]).toBe('observe_debrief');
    expect(a[2].dedupNonce).toMatch(/^[0-9a-f]{16}$/);
    expect(a[2].dedupNonce).not.toBe(b[2].dedupNonce);
  });

  test('queueObserveTeacherReport passes the phase through', async () => {
    await CoachingJobQueueService.queueObserveTeacherReport('s1', { phase: 'deliver' });
    expect(mockQueue.queueCoachingJob).toHaveBeenCalledWith('s1', 'observe_teacher_report', { phase: 'deliver' });
  });
});

describe('analyzePedagogy with an observe pack', () => {
  test('an observe framework asks the model for JSON mode (a malformed reply fails the whole observation)', async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({ choices: [{ message: { content: '{"domains":{}}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const { getObservePack } = require('../../bot/shared/services/observe/observe-framework');
    await GPT5MiniService.analyzePedagogy('T: Hello.', {}, null, getObservePack().module);
    expect(mockCreate.mock.calls[0][0].response_format).toEqual({ type: 'json_object' });
  });

  test('a framework that does not opt in is sent exactly as before', async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({ choices: [{ message: { content: '{"areas":{}}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const teach = require('../../bot/shared/services/coaching/frameworks/teach-framework');
    await GPT5MiniService.analyzePedagogy('T: Hello.', {}, null, teach);
    expect(mockCreate.mock.calls[0][0].response_format).toBeUndefined();
  });
});
