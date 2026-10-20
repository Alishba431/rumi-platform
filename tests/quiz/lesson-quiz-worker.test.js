'use strict';
/**
 * sqs-worker.js#executeJob — the lesson-quiz job types. The real worker class
 * runs each job; the quiz services and the queue are mocked at the require
 * boundary (they have their own suites). What is asserted is the wiring: which
 * service gets which id out of the v2 envelope (`body.payload`), the timeout
 * extension per source queue, and that the teacher nudge requeues itself
 * until its target time instead of firing early.
 */

const QID = '33333333-3333-4333-8333-333333333333';
const CSID = '44444444-4444-4444-8444-444444444444';

let mocks;

function load() {
  jest.resetModules();
  jest.doMock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
  jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn(), logError: jest.fn() }));
  jest.doMock('../../bot/shared/utils/structured-logger', () => ({
    runWithCorrelation: (id, fn) => fn(),
    generateCorrelationId: () => 'corr-1',
  }));
  jest.doMock('../../bot/shared/services/whatsapp.service', () => ({ sendMessage: jest.fn() }));
  jest.doMock('../../bot/shared/services/coaching-orchestrator.service', () => ({}));
  jest.doMock('../../bot/workers/lesson-plan-extraction.worker', () => ({}));
  jest.doMock('../../bot/workers/lesson-plan-generation.worker', () => ({}));
  jest.doMock('../../bot/workers/video-generation.worker', () => ({}));
  jest.doMock('../../bot/workers/exam-grading.worker', () => ({}));

  mocks = {
    queue: {
      queueJob: jest.fn().mockResolvedValue('msg-id'),
      extendJobTimeout: jest.fn().mockResolvedValue(undefined),
      extendQuizJobTimeout: jest.fn().mockResolvedValue(undefined),
    },
    offer: { processOffer: jest.fn().mockResolvedValue(undefined) },
    generate: { process: jest.fn().mockResolvedValue(undefined) },
    invite: { offerVideosIfUnanswered: jest.fn().mockResolvedValue(undefined) },
    nudge: {
      nudgeDispatch: jest.fn(() => ({ action: 'process' })),
      process: jest.fn().mockResolvedValue(undefined),
    },
  };
  jest.doMock('../../bot/shared/services/queue', () => mocks.queue);
  jest.doMock('../../bot/shared/services/quiz/transcript-quiz-offer.service', () => mocks.offer);
  jest.doMock('../../bot/shared/services/quiz/transcript-quiz-generate.service', () => mocks.generate);
  jest.doMock('../../bot/shared/services/quiz/video-quiz-invite.service', () => mocks.invite);
  jest.doMock('../../bot/shared/services/quiz/transcript-quiz-nudge.service', () => mocks.nudge);

  const { SQSCoachingWorker } = require('../../bot/workers/sqs-worker');
  return new SQSCoachingWorker('test-worker');
}

const v2 = (groupId, payload) => ({ version: '2.0', groupId, payload });

afterEach(() => jest.resetModules());

describe('quiz_offer', () => {
  test('runs processOffer with the coaching session id from the payload, extending the quiz queue lease', async () => {
    const w = load();
    const body = v2(CSID, { coachingSessionId: CSID, userId: 'u-1', phone: '15550001111' });
    await w.executeJob(CSID, 'quiz_offer', body.payload, 'rh-1', 'quiz', body);
    expect(mocks.offer.processOffer).toHaveBeenCalledWith(CSID, expect.objectContaining({ userId: 'u-1' }));
    // Never shorter than the quiz queue's receive lease (600 s): shortening it
    // is what let a slow digest be handed to a second worker.
    expect(mocks.queue.extendQuizJobTimeout).toHaveBeenCalledWith('rh-1', 600);
    expect(mocks.queue.extendJobTimeout).not.toHaveBeenCalled();
  });

  test('falls back to the envelope groupId, and extends the main queue lease off the quiz queue', async () => {
    const w = load();
    const body = v2(CSID, {});
    await w.executeJob(CSID, 'quiz_offer', {}, 'rh-2', 'main', body);
    expect(mocks.offer.processOffer).toHaveBeenCalledWith(CSID, {});
    expect(mocks.queue.extendJobTimeout).toHaveBeenCalledWith('rh-2', 900);
  });
});

describe('quiz_generate', () => {
  test('runs the generate pipeline for the quiz id with a 30-minute lease', async () => {
    const w = load();
    const body = v2(QID, { quizId: QID, language: 'en' });
    await w.executeJob(QID, 'quiz_generate', body.payload, 'rh-3', 'quiz', body);
    expect(mocks.generate.process).toHaveBeenCalledWith(QID, expect.objectContaining({ language: 'en' }));
    // Up to three authoring rounds, a blind solve, figures and a PDF: a lease
    // shorter than the run hands the job to a second worker (review F-S2).
    expect(mocks.queue.extendQuizJobTimeout).toHaveBeenCalledWith('rh-3', 1800);
  });
});

describe('quiz_child_videos_offer', () => {
  test('offers the videos to the child phone in the payload', async () => {
    const w = load();
    const body = v2('15550002222', { phone: '15550002222' });
    await w.executeJob('15550002222', 'quiz_child_videos_offer', body.payload, 'rh-4', 'quiz', body);
    expect(mocks.invite.offerVideosIfUnanswered).toHaveBeenCalledWith('15550002222');
  });

  test('is a no-op without a phone (never throws Unknown job type)', async () => {
    const w = load();
    await expect(w.executeJob('x', 'quiz_child_videos_offer', {}, 'rh-5', 'quiz', v2('x', {}))).resolves.toBeUndefined();
    expect(mocks.invite.offerVideosIfUnanswered).not.toHaveBeenCalled();
  });
});

describe('quiz_nudge_teacher', () => {
  test('before its target time: requeues itself with the dispatch decision, does NOT nudge', async () => {
    const w = load();
    const later = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
    mocks.nudge.nudgeDispatch.mockReturnValueOnce({ action: 'requeue', targetAt: later, delaySeconds: 900 });
    const body = v2(QID, { quizId: QID, targetAt: later });
    await w.executeJob(QID, 'quiz_nudge_teacher', body.payload, 'rh-6', 'quiz', body);
    expect(mocks.nudge.nudgeDispatch).toHaveBeenCalledWith({ targetAt: later });
    expect(mocks.nudge.process).not.toHaveBeenCalled();
    expect(mocks.queue.queueJob).toHaveBeenCalledWith(QID, 'quiz_nudge_teacher',
      { quizId: QID, targetAt: later },
      expect.objectContaining({ delaySeconds: 900, deduplicationId: expect.stringContaining(`${QID}-quiz_nudge_teacher-`) }));
  });

  test('when due: runs the nudge and does not requeue', async () => {
    const w = load();
    const body = v2(QID, { quizId: QID, targetAt: new Date(Date.now() - 1000).toISOString() });
    await w.executeJob(QID, 'quiz_nudge_teacher', body.payload, 'rh-7', 'quiz', body);
    expect(mocks.nudge.process).toHaveBeenCalledWith(QID);
    expect(mocks.queue.queueJob).not.toHaveBeenCalled();
  });
});

describe('existing job types are untouched', () => {
  test('an unknown job type still throws', async () => {
    const w = load();
    await expect(w.executeJob('x', 'not_a_job', {}, 'rh', 'main', {})).rejects.toThrow('Unknown job type: not_a_job');
  });
});
