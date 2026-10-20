'use strict';
/**
 * Delayed lesson-quiz jobs on a deployment with no quiz queue (review F-S1).
 *
 * quiz_* jobs fall back to SQS_QUEUE_URL when SQS_QUIZ_QUEUE_URL is unset. The
 * main queue is FIFO, and FIFO drops DelaySeconds: a nudge that re-queued
 * itself "in 15 minutes" until its target came back at once, every time — a
 * tight loop for the six hours to the target (longer through quiet hours).
 *
 * The real worker, the real queue service (aws-sdk mocked at the network) and
 * the real nudge dispatch run here; only the nudge's database work is stubbed.
 */

const { mockBotDependency } = require('../_helpers/mock-bot-dependency');

const QID = '33333333-3333-4333-8333-333333333333';
const CSID = '44444444-4444-4444-8444-444444444444';

let sendMessageMock;
let logToFile;

function load({ main = 'https://sqs.example/123/main.fifo', quiz = null } = {}) {
  jest.resetModules();
  process.env.SQS_QUEUE_URL = main;
  if (quiz) process.env.SQS_QUIZ_QUEUE_URL = quiz; else delete process.env.SQS_QUIZ_QUEUE_URL;
  delete process.env.QUEUE_DRIVER;
  sendMessageMock = jest.fn(() => ({ promise: () => Promise.resolve({ MessageId: 'm1' }) }));
  mockBotDependency('aws-sdk', () => ({
    config: { update: jest.fn() },
    SQS: jest.fn(() => ({
      sendMessage: sendMessageMock,
      changeMessageVisibility: jest.fn(() => ({ promise: () => Promise.resolve({}) })),
    })),
  }));
  logToFile = jest.fn();
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
  const Nudge = require('../../bot/shared/services/quiz/transcript-quiz-nudge.service');
  jest.spyOn(Nudge, 'process').mockResolvedValue({ ok: true });
  const Queue = require('../../bot/shared/services/queue');
  const { SQSCoachingWorker } = require('../../bot/workers/sqs-worker');
  return { worker: new SQSCoachingWorker('test-worker'), Nudge, Queue };
}

const v2 = (groupId, payload) => ({ version: '2.0', groupId, payload });
const ENV = { ...process.env };
afterEach(() => { jest.resetModules(); process.env = { ...ENV }; });

describe('quiz_nudge_teacher on a FIFO main queue, no quiz queue', () => {
  test('a nudge whose target has not arrived is NOT re-queued (no hop on FIFO): dropped with a warning', async () => {
    const { worker, Nudge } = load();
    const later = new Date(Date.now() + 6 * 3600 * 1000).toISOString();
    const body = v2(QID, { quizId: QID, targetAt: later });
    await worker.executeJob(QID, 'quiz_nudge_teacher', body.payload, 'rh-1', 'main', body);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(Nudge.process).not.toHaveBeenCalled();
    expect(logToFile).toHaveBeenCalledWith(expect.stringMatching(/nudge dropped/i),
      expect.objectContaining({ quizId: QID }), 'warn');
  });

  test('a nudge that is due still runs at once', async () => {
    const { worker, Nudge } = load();
    const body = v2(QID, { quizId: QID, targetAt: new Date(Date.now() - 1000).toISOString() });
    // Midday in the school clock's default zone: never inside quiet hours.
    jest.spyOn(Nudge, 'nudgeDispatch').mockReturnValue({ action: 'process' });
    await worker.executeJob(QID, 'quiz_nudge_teacher', body.payload, 'rh-2', 'main', body);
    expect(Nudge.process).toHaveBeenCalledWith(QID);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test('with a Standard quiz queue the nudge still hops, with its delay', async () => {
    const { worker, Nudge } = load({ quiz: 'https://sqs.example/123/quiz' });
    const later = new Date(Date.now() + 6 * 3600 * 1000).toISOString();
    const body = v2(QID, { quizId: QID, targetAt: later });
    await worker.executeJob(QID, 'quiz_nudge_teacher', body.payload, 'rh-3', 'quiz', body);
    expect(Nudge.process).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const params = sendMessageMock.mock.calls[0][0];
    expect(params.QueueUrl).toBe('https://sqs.example/123/quiz');
    expect(params.DelaySeconds).toBe(900);
  });
});

describe('the queue says whether a job type can be delayed', () => {
  test('quiz jobs on a FIFO fallback cannot; on a Standard quiz queue they can; non-quiz jobs read the main queue', () => {
    expect(load().Queue.honoursDelay('quiz_nudge_teacher')).toBe(false);
    expect(load({ quiz: 'https://sqs.example/123/quiz' }).Queue.honoursDelay('quiz_offer')).toBe(true);
    expect(load({ main: 'https://sqs.example/123/main' }).Queue.honoursDelay('quiz_offer')).toBe(true);
  });

  test('a delayed quiz job sent to a FIFO queue is logged as sent at once (never silently)', async () => {
    const { Queue } = load();
    await Queue.queueJob(CSID, 'quiz_offer', { coachingSessionId: CSID }, { delaySeconds: 240 });
    expect(sendMessageMock.mock.calls[0][0].DelaySeconds).toBeUndefined();
    expect(logToFile).toHaveBeenCalledWith(expect.stringMatching(/delay.*not honoured/i),
      expect.objectContaining({ jobType: 'quiz_offer', delaySeconds: 240 }), 'warn');
  });

  test('a non-quiz job on the FIFO queue logs nothing new (main behaviour)', async () => {
    const { Queue } = load();
    await Queue.queueJob('lp1', 'some_other_job', {}, { delaySeconds: 30 });
    expect(logToFile).not.toHaveBeenCalledWith(expect.stringMatching(/not honoured/i), expect.anything(), 'warn');
  });
});
