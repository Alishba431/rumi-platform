/**
 * A coaching job's dedup identity must include its phase / nonce.
 *
 * Both drivers deduplicated on `${sessionId}-${jobType}` alone. That is right
 * for the one-shot pipeline (transcription, analysis, report), but the observe
 * jobs run more than once per session on purpose: a teacher report is first
 * rendered as a PREVIEW for the coach and then DELIVERED, and a coach may
 * re-record a debrief. With the old key the second job was dropped as a
 * "duplicate" and the report never reached the teacher.
 */

const { mockBotDependency } = require('../_helpers/mock-bot-dependency');

// The first test pays for a cold resetModules() load of the queue driver; under a
// full parallel run that alone can take several seconds.
jest.setTimeout(30000);

let sendMessage;
let redisGet;

function loadSqs() {
  jest.resetModules();
  sendMessage = jest.fn(() => ({ promise: () => Promise.resolve({ MessageId: 'm1' }) }));
  redisGet = jest.fn().mockResolvedValue(null);
  mockBotDependency('aws-sdk', () => ({ config: { update: jest.fn() }, SQS: jest.fn(() => ({ sendMessage })) }));
  jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
  jest.doMock('../../bot/shared/services/cache/railway-redis.service', () => ({ get: redisGet, set: jest.fn() }));
  jest.doMock('../../bot/shared/utils/structured-logger', () => ({ getCurrentCorrelationId: () => 'c1', logEvent: jest.fn() }));
  process.env.SQS_QUEUE_URL = 'https://sqs/main.fifo';
  return require('../../bot/shared/services/queue/sqs-queue.service');
}

afterEach(() => { jest.resetModules(); delete process.env.SQS_QUEUE_URL; });

describe('SQS coaching-job dedup identity', () => {
  test('unchanged for a job with no phase or nonce', async () => {
    const q = loadSqs();
    await q.queueCoachingJob('s1', 'transcription', { from: '15550100001' });
    expect(sendMessage.mock.calls[0][0].MessageDeduplicationId).toBe('s1-transcription');
    expect(redisGet).toHaveBeenCalledWith(expect.stringMatching(/s1:transcription$/));
  });

  test('a preview and a deliver job for the same session get different identities', async () => {
    const q = loadSqs();
    await q.queueCoachingJob('s1', 'observe_teacher_report', { phase: 'preview' });
    await q.queueCoachingJob('s1', 'observe_teacher_report', { phase: 'deliver' });
    const ids = sendMessage.mock.calls.map((c) => c[0].MessageDeduplicationId);
    expect(ids).toEqual(['s1-observe_teacher_report-preview', 's1-observe_teacher_report-deliver']);
    expect(redisGet).toHaveBeenLastCalledWith(expect.stringMatching(/s1:observe_teacher_report:deliver$/));
  });

  test('a dedupNonce (one per debrief recording) is part of the identity', async () => {
    const q = loadSqs();
    await q.queueCoachingJob('s1', 'observe_debrief', { dedupNonce: 'abc123' });
    expect(sendMessage.mock.calls[0][0].MessageDeduplicationId).toBe('s1-observe_debrief-abc123');
  });
});
