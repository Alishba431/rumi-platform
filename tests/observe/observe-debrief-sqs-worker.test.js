/**
 * The worker's three debrief hooks (bot/workers/sqs-worker.js):
 *  1. executeJob routes `observe_debrief` to processDebriefRecording;
 *  2. handleJobFailure returns early for the observe job types — a failed
 *     debrief must NEVER mark the lesson's session status='failed' (the
 *     observation itself is fine; only the coach's debrief recording failed);
 *  3. runDebriefRetrySweep re-queues stuck debrief recordings on the worker's
 *     timer, one replica per row (Redis lock), with a per-attempt phase so
 *     each retry is its own job; OBSERVE_DEBRIEF_RETRY_OFF=1 turns it off.
 */

jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({
  runWithCorrelation: (id, fn) => fn(),
  generateCorrelationId: () => 'corr-1',
}));
const { createFakeSupabase } = require('./_helpers/fake-supabase');
const mockDb = createFakeSupabase({ coaching_sessions: [] });
jest.mock('../../bot/shared/config/supabase', () => mockDb.client);
jest.mock('../../bot/shared/services/whatsapp.service', () => ({ sendMessage: jest.fn(async () => true) }));
jest.mock('../../bot/shared/services/queue', () => ({ queueJob: jest.fn(), extendJobTimeout: jest.fn() }));
jest.mock('../../bot/shared/services/coaching-orchestrator.service', () => ({}));
jest.mock('../../bot/workers/lesson-plan-extraction.worker', () => ({}));
jest.mock('../../bot/workers/lesson-plan-generation.worker', () => ({}));
jest.mock('../../bot/workers/video-generation.worker', () => ({}));
jest.mock('../../bot/workers/exam-grading.worker', () => ({}));
const mockProcess = jest.fn(async () => undefined);
jest.mock('../../bot/shared/services/observe/observe-debrief.service', () => ({
  processDebriefRecording: (...a) => mockProcess(...a),
}));
const mockLocks = new Set();
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  setNX: jest.fn(async (k) => { if (mockLocks.has(k)) return false; mockLocks.add(k); return true; }),
}));
const mockQueueDebrief = jest.fn(async () => 'job');
jest.mock('../../bot/shared/services/coaching/coaching-job-queue.service', () => ({
  queueObserveDebrief: (...a) => mockQueueDebrief(...a),
}));

const { SQSCoachingWorker, runDebriefRetrySweep } = require('../../bot/workers/sqs-worker');

const NOW = Date.parse('2026-09-10T12:00:00Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();

beforeEach(() => {
  jest.clearAllMocks();
  mockLocks.clear();
  mockDb.tables.coaching_sessions.length = 0;
  delete process.env.OBSERVE_DEBRIEF_RETRY_OFF;
});

describe('executeJob', () => {
  test('observe_debrief → processDebriefRecording(sessionId, payload)', async () => {
    const w = new SQSCoachingWorker('w-test');
    await w.executeJob('obs-1', 'observe_debrief', { from: '15550100001', audioId: 'm' }, 'rh');
    expect(mockProcess).toHaveBeenCalledWith('obs-1', { from: '15550100001', audioId: 'm' });
  });
});

describe('handleJobFailure', () => {
  test('a failed debrief never marks the observation failed', async () => {
    mockDb.tables.coaching_sessions.push({ id: 'obs-1', status: 'observer_review_complete' });
    const w = new SQSCoachingWorker('w-test');
    await w.handleJobFailure({ receiptHandle: 'rh', messageId: 'm1', body: { sessionId: 'obs-1', jobType: 'observe_debrief' } }, new Error('boom'));
    expect(mockDb.tables.coaching_sessions[0].status).toBe('observer_review_complete');
  });

  test('other job types still mark the session failed (unchanged)', async () => {
    mockDb.tables.coaching_sessions.push({ id: 's-2', status: 'analyzing' });
    const w = new SQSCoachingWorker('w-test');
    await w.handleJobFailure({ receiptHandle: 'rh', messageId: 'm2', body: { sessionId: 's-2', jobType: 'analysis' } }, new Error('boom'));
    expect(mockDb.tables.coaching_sessions[0].status).toBe('failed');
  });
});

describe('runDebriefRetrySweep', () => {
  const stuck = (id, od = {}, over = {}) => ({
    id, status: 'observer_review_complete', debrief_status: 'pending', observer_user_id: 'coach-1',
    created_at: ago(120), analysis_data: { observer_debrief: { audio_id: `m-${id}`, recorded_at: ago(90), attempts: 1, ...od } }, ...over,
  });

  test('re-queues eligible rows with a per-attempt phase, and skips the rest', async () => {
    mockDb.tables.coaching_sessions.push(
      stuck('a'),
      stuck('b', { transcript: 'done already' }),
      stuck('c', { error_class: 'media_gone' }),
      stuck('d', {}, { status: 'cancelled' }),
      stuck('e', {}, { observer_user_id: null }),
    );
    const summary = await runDebriefRetrySweep({ now: NOW });
    expect(mockQueueDebrief).toHaveBeenCalledTimes(1);
    expect(mockQueueDebrief).toHaveBeenCalledWith('a', expect.objectContaining({
      audioId: 'm-a', trigger: 'debrief_retry_sweep', attempt: 2, phase: 'retry-2',
    }));
    expect(summary).toMatchObject({ queued: 1, mediaGone: 1 });
  });

  test('one replica per row: a held lock skips it', async () => {
    mockDb.tables.coaching_sessions.push(stuck('a'));
    await runDebriefRetrySweep({ now: NOW });
    const second = await runDebriefRetrySweep({ now: NOW });
    expect(mockQueueDebrief).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ queued: 0, skipped: 1 });
  });

  test('OBSERVE_DEBRIEF_RETRY_OFF=1 turns it off', async () => {
    mockDb.tables.coaching_sessions.push(stuck('a'));
    process.env.OBSERVE_DEBRIEF_RETRY_OFF = '1';
    expect(await runDebriefRetrySweep({ now: NOW })).toMatchObject({ off: true, queued: 0 });
    expect(mockQueueDebrief).not.toHaveBeenCalled();
  });
});

describe('startWorker wiring', () => {
  test('the sweep runs on the worker timer, gated by OBSERVE_DEBRIEF_RETRY_OFF', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../bot/workers/sqs-worker.js'), 'utf8');
    const start = src.slice(src.indexOf('function startWorker('));
    expect(start).toMatch(/runDebriefRetrySweep\(\)/);
    expect(start).toMatch(/setInterval\(runDebriefRetry/);
  });
});
