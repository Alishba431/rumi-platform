/**
 * sqs-worker routes the two test-paper job types to testpaper.worker, with a
 * longer visibility timeout (a 30-question paper in a right-to-left script can
 * take a few minutes to write and print).
 */

function load() {
  jest.resetModules();
  jest.doMock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
  jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
  jest.doMock('../../bot/shared/utils/structured-logger', () => ({ runWithCorrelation: (id, fn) => fn(), generateCorrelationId: () => 'c', logEvent: jest.fn() }));
  jest.doMock('../../bot/shared/services/whatsapp.service', () => ({ sendMessage: jest.fn() }));
  const queue = { extendJobTimeout: jest.fn().mockResolvedValue(), queueJob: jest.fn() };
  jest.doMock('../../bot/shared/services/queue', () => queue);
  jest.doMock('../../bot/shared/services/coaching-orchestrator.service', () => ({}));
  jest.doMock('../../bot/workers/lesson-plan-extraction.worker', () => ({}));
  jest.doMock('../../bot/workers/lesson-plan-generation.worker', () => ({}));
  jest.doMock('../../bot/workers/video-generation.worker', () => ({}));
  jest.doMock('../../bot/workers/exam-grading.worker', () => ({}));
  const testpaper = { process: jest.fn().mockResolvedValue({ ready: true }) };
  jest.doMock('../../bot/workers/testpaper.worker', () => testpaper);
  const { SQSCoachingWorker } = require('../../bot/workers/sqs-worker');
  return { worker: new SQSCoachingWorker('w-test'), queue, testpaper };
}

afterEach(() => jest.resetModules());

it.each([['testpaper_generate', 'generate'], ['testpaper_revise', 'revise']])('%s → testpaper.worker (%s)', async (jobType, action) => {
  const { worker, queue, testpaper } = load();
  const payload = { paperId: 'p1', userId: 'u1', to: '15550100001' };
  await worker.executeJob('req-1', jobType, payload, 'rh-1', 'main');
  expect(queue.extendJobTimeout).toHaveBeenCalledWith('rh-1', 600);
  expect(testpaper.process).toHaveBeenCalledWith({ ...payload, action });
});

it('reads the operator\'s RUMI_FEATURE_* switches at startup, as the bot does', () => {
  process.env.RUMI_FEATURE_TEST_PAPER = 'off';
  try {
    load();
    expect(require('../../bot/shared/config/feature-availability').overrides.isEnabled('test_paper')).toBe(false);
  } finally {
    delete process.env.RUMI_FEATURE_TEST_PAPER;
  }
});
