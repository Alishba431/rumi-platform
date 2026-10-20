'use strict';
/**
 * The worker polls the quiz queue on the BullMQ driver.
 *
 * BullMQ always routes quiz_* jobs to its own quiz queue (bullmq-queue.service
 * queueJob), and the docs promise that QUEUE_DRIVER=bullmq needs no extra queue.
 * The worker polled that queue only when SQS_QUIZ_QUEUE_URL was set, so on an
 * AWS-free deployment the lesson quiz's offer, generate, nudge and class report
 * jobs were queued and never run (seen end to end on the Matrix rig).
 *
 * The real worker loop and the real BullMQ driver run here; only the driver's
 * pulls (the Redis boundary) are stubbed.
 */

const { mockBotDependency } = require('../_helpers/mock-bot-dependency');

let logToFile;

function load({ driver = 'bullmq', quizUrl = null } = {}) {
  jest.resetModules();
  process.env.QUEUE_DRIVER = driver;
  process.env.REDIS_URL = 'redis://127.0.0.1:6379/0';
  if (quizUrl) process.env.SQS_QUIZ_QUEUE_URL = quizUrl; else delete process.env.SQS_QUIZ_QUEUE_URL;
  delete process.env.SQS_VIDEO_QUEUE_URL;
  logToFile = jest.fn();
  mockBotDependency('aws-sdk', () => ({ config: { update: jest.fn() }, SQS: jest.fn(() => ({})) }));
  jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile, logError: jest.fn() }));
  jest.doMock('../../bot/shared/services/cache/railway-redis.service', () => ({}));
  jest.doMock('../../bot/shared/utils/structured-logger', () => ({
    runWithCorrelation: (id, fn) => fn(),
    generateCorrelationId: () => 'corr-1',
    getCurrentCorrelationId: () => 'corr-1',
    logEvent: jest.fn(),
  }));
  jest.doMock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
  jest.doMock('../../bot/shared/services/whatsapp.service', () => ({ sendMessage: jest.fn() }));
  jest.doMock('../../bot/shared/services/coaching-orchestrator.service', () => ({}));
  jest.doMock('../../bot/workers/lesson-plan-extraction.worker', () => ({}));
  jest.doMock('../../bot/workers/lesson-plan-generation.worker', () => ({}));
  jest.doMock('../../bot/workers/video-generation.worker', () => ({}));
  jest.doMock('../../bot/workers/exam-grading.worker', () => ({}));
  const Queue = require('../../bot/shared/services/queue');
  jest.spyOn(Queue, 'receiveJobs').mockResolvedValue([]);
  jest.spyOn(Queue, 'receiveVideoJobs').mockResolvedValue([]);
  jest.spyOn(Queue, 'receiveQuizJobs').mockResolvedValue([]);
  const { SQSCoachingWorker } = require('../../bot/workers/sqs-worker');
  return { worker: new SQSCoachingWorker('test-worker'), Queue };
}

const ENV = { ...process.env };
afterEach(() => { jest.resetModules(); process.env = { ...ENV }; });

describe('the worker polls the quiz queue', () => {
  test('QUEUE_DRIVER=bullmq without SQS_QUIZ_QUEUE_URL: the quiz queue is polled', async () => {
    const { worker, Queue } = load();
    expect(Queue.constructor.name).toBe('BullMQQueueService');
    await worker.processNextBatch(5);
    expect(Queue.receiveJobs).toHaveBeenCalled();
    expect(Queue.receiveQuizJobs).toHaveBeenCalledTimes(1);
  });

  test('a quiz job pulled from the BullMQ quiz queue is processed as a quiz-queue job', async () => {
    const { worker, Queue } = load();
    const job = { receiptHandle: 'quiz:1:tok', messageId: '1', body: { version: '2.0', groupId: 'q1', jobType: 'quiz_offer', payload: {} } };
    Queue.receiveQuizJobs.mockResolvedValueOnce([job]);
    const seen = [];
    jest.spyOn(worker, 'processJob').mockImplementation((j) => seen.push(j));
    await worker.processNextBatch(5);
    expect(seen).toHaveLength(1);
    expect(seen[0].sourceQueue).toBe('quiz');
  });

  test('SQS driver without SQS_QUIZ_QUEUE_URL: unchanged, quiz jobs ride the main queue', async () => {
    const { worker, Queue } = load({ driver: 'sqs' });
    process.env.SQS_QUEUE_URL = 'https://sqs.example/123/main.fifo';
    await worker.processNextBatch(5);
    expect(Queue.receiveQuizJobs).not.toHaveBeenCalled();
  });

  test('SQS driver with SQS_QUIZ_QUEUE_URL: the quiz queue is polled', async () => {
    const { worker, Queue } = load({ driver: 'sqs', quizUrl: 'https://sqs.example/123/quiz' });
    await worker.processNextBatch(5);
    expect(Queue.receiveQuizJobs).toHaveBeenCalledTimes(1);
  });
});
