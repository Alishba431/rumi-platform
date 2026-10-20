/**
 * The two delivery sweeps run by the stale-session worker.
 *
 *  untapped    — an invite went to a teacher outside the Meta window and was
 *                never tapped: ONE nudge after a day, then stop and tell the
 *                coach. Never chased past the age ceiling: closed silently.
 *  undelivered — a finished observation whose report was never sent
 *                (preview ignored, or the send flow never opened): ONE
 *                reminder to the coach, then stop and say so. Same ceiling.
 *
 * The planners are pure (no clock, no I/O); the executors act; the sweep is
 * single-flight (Redis lock), capped per tick, and has a kill switch.
 */

const { createFakeSupabase } = require('./_helpers/fake-supabase');

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-10-10T12:00:00Z');
const ago = (h) => new Date(NOW - h * HOUR).toISOString();

const mockDb = createFakeSupabase({ users: [], coaching_sessions: [] });
jest.mock('dotenv', () => ({ config: () => ({}) }));
jest.mock('../../bot/shared/config/supabase', () => mockDb.client);
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn(async () => true),
  sendTemplate: jest.fn(async () => true),
}));
jest.mock('../../bot/shared/services/coaching/coaching-job-queue.service', () => ({}));
const mockLock = { granted: true, ready: true };
// Like the real service: no lock until the connection is ready.
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  isAvailable: () => mockLock.ready,
  acquireLock: jest.fn(async () => mockLock.ready && mockLock.granted),
  releaseLock: jest.fn(async () => true),
}));

const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const { classifyUntappedDelivery } = require('../../bot/shared/services/observe/observe-untapped.service');
const { classifyUndelivered, candidateFromSession } = require('../../bot/shared/services/observe/observe-undelivered.service');
const ObserveSend = require('../../bot/shared/services/observe/observe-send.service');
const Worker = require('../../bot/workers/stale-session.worker');

describe('untapped planner', () => {
  const tap = (d) => classifyUntappedDelivery({ status: 'awaiting_teacher_tap', ...d }, NOW).action;
  test('waits a day, nudges once, gives up two days after the nudge', () => {
    expect(tap({ template_sent_at: ago(5) })).toBe('skip');
    expect(tap({ template_sent_at: ago(30) })).toBe('nudge');
    expect(tap({ template_sent_at: ago(80), nudged_at: ago(30) })).toBe('skip');
    expect(tap({ template_sent_at: ago(100), nudged_at: ago(50) })).toBe('give_up');
  });
  test('closed by the tap; never chased past the ceiling; not ours without the status', () => {
    expect(tap({ template_sent_at: ago(30), tapped_at: ago(1) })).toBe('skip');
    expect(tap({ template_sent_at: ago(24 * 8) })).toBe('expire');
    expect(classifyUntappedDelivery({ status: 'sent', template_sent_at: ago(30) }, NOW).action).toBe('skip');
  });
});

describe('undelivered planner', () => {
  const plan = (c) => classifyUndelivered({ sessionStatus: 'observer_review_complete', finishedAt: ago(30), ...c }, NOW).action;
  test('a finished observation with no send, or an ignored preview, is reminded once after a day', () => {
    expect(plan({ deliveryStatus: undefined })).toBe('remind');
    expect(plan({ deliveryStatus: 'awaiting_confirm' })).toBe('remind');
    expect(plan({ deliveryStatus: 'previewing', finishedAt: ago(3) })).toBe('skip');
    expect(plan({ deliveryStatus: 'awaiting_confirm', reminded_at: ago(10) })).toBe('skip');
    expect(plan({ deliveryStatus: 'awaiting_confirm', reminded_at: ago(60) })).toBe('give_up');
  });
  test('not ours: unfinished sessions, sent / tapped / cancelled reports; stale ones close silently', () => {
    expect(plan({ sessionStatus: 'analyzing' })).toBe('skip');
    expect(plan({ deliveryStatus: 'awaiting_teacher_tap' })).toBe('skip');
    expect(plan({ deliveryStatus: 'sent' })).toBe('skip');
    expect(plan({ deliveryStatus: 'cancelled' })).toBe('skip');
    expect(plan({ deliveryStatus: undefined, finishedAt: ago(24 * 9) })).toBe('expire');
    expect(plan({ deliveryStatus: undefined, gave_up_at: ago(1) })).toBe('skip');
  });
  test('candidateFromSession reads the row the sweep reads', () => {
    expect(candidateFromSession({ status: 'completed', updated_at: ago(2), analysis_data: { teacher_delivery: { status: 'previewing', reminder_count: 1 } } }))
      .toMatchObject({ sessionStatus: 'completed', deliveryStatus: 'previewing', finishedAt: ago(2), reminder_count: 1 });
  });
});

function seed() {
  mockDb.tables.users.length = 0;
  mockDb.tables.users.push({ id: 'coach-1', role: 'coach', name: 'Robin Coach', phone_number: 'mtx:15550100001' });
  mockDb.tables.coaching_sessions.length = 0;
  const base = { observer_user_id: 'coach-1', user_id: 't-1', observation_type: 'leader_observation', created_at: ago(40) };
  mockDb.tables.coaching_sessions.push(
    { ...base, id: 'tap-1', status: 'observer_review_complete', updated_at: ago(40),
      analysis_data: { teacher_delivery: { status: 'awaiting_teacher_tap', teacher_name: 'Sam Taylor', teacher_phone: '15554000002', template_sent_at: ago(30) } } },
    { ...base, id: 'und-1', status: 'observer_review_complete', updated_at: ago(30), analysis_data: {} },
    { ...base, id: 'und-old', status: 'observer_review_complete', updated_at: ago(24 * 10), analysis_data: {} },
    { ...base, id: 'cancelled', status: 'cancelled', updated_at: ago(30), analysis_data: {} },
  );
}
const td = (id) => (mockDb.tables.coaching_sessions.find((s) => s.id === id).analysis_data || {}).teacher_delivery || {};

describe('executors', () => {
  beforeEach(() => { jest.clearAllMocks(); seed(); process.env.OBSERVE_REPORT_TEMPLATE = 'observation_report'; });
  afterAll(() => { delete process.env.OBSERVE_REPORT_TEMPLATE; });

  test('untapped nudge: the same invite again, stamped, and the coach told on their own identity', async () => {
    expect((await ObserveSend.processUntappedDelivery('tap-1', NOW)).action).toBe('nudge');
    expect(WhatsAppService.sendTemplate.mock.calls[0][0]).toBe('15554000002');
    expect(td('tap-1').nudge_count).toBe(1);
    expect(WhatsAppService.sendMessage).toHaveBeenCalledWith('mtx:15550100001', expect.stringMatching(/Sam Taylor has not opened/));
  });

  test('undelivered remind messages the coach; expire messages nobody', async () => {
    expect((await ObserveSend.processUndeliveredDelivery('und-1', NOW)).action).toBe('remind');
    expect(WhatsAppService.sendMessage).toHaveBeenCalledWith('mtx:15550100001', expect.stringMatching(/report is ready but has not been sent/));
    expect(td('und-1').reminder_count).toBe(1);
    jest.clearAllMocks();
    expect((await ObserveSend.processUndeliveredDelivery('und-old', NOW)).action).toBe('expire');
    expect(WhatsAppService.sendMessage).not.toHaveBeenCalled();
    expect(td('und-old').gave_up_at).toBeTruthy();
  });
});

describe('the sweeps in the stale-session worker', () => {
  beforeEach(() => {
    jest.clearAllMocks(); seed(); mockLock.granted = true; mockLock.ready = true;
    delete process.env.OBSERVE_UNTAPPED_SWEEP_OFF; delete process.env.OBSERVE_UNDELIVERED_SWEEP_OFF;
  });

  test('the kill switches stop each sweep before it reads anything', async () => {
    process.env.OBSERVE_UNTAPPED_SWEEP_OFF = 'true';
    process.env.OBSERVE_UNDELIVERED_SWEEP_OFF = 'true';
    mockDb.calls.length = 0;
    expect((await Worker.runUntappedSweep(NOW)).disabled).toBe(true);
    expect((await Worker.runUndeliveredSweep(NOW)).disabled).toBe(true);
    expect(mockDb.calls.filter((c) => c.table === 'coaching_sessions')).toHaveLength(0);
  });

  test('a cron run that starts before Redis has connected still sweeps (found on the E2E rig: every run skipped)', async () => {
    mockLock.ready = false;
    setTimeout(() => { mockLock.ready = true; }, 300);
    const untapped = await Worker.runUntappedSweep(NOW);
    expect(untapped.skippedLocked).toBeUndefined();
    expect(untapped).toMatchObject({ nudged: 1 });
  });

  test('no lock, no sweep (another replica has it)', async () => {
    mockLock.granted = false;
    expect((await Worker.runUntappedSweep(NOW)).skippedLocked).toBe(true);
    expect(WhatsAppService.sendMessage).not.toHaveBeenCalled();
  });

  test('a tick acts on what the planners pick and tallies it; cancelled observations are never touched', async () => {
    const untapped = await Worker.runUntappedSweep(NOW);
    expect(untapped).toMatchObject({ nudged: 1, failed: 0 });
    const undelivered = await Worker.runUndeliveredSweep(NOW);
    expect(undelivered).toMatchObject({ reminded: 1, expired: 1, failed: 0 });
    expect(td('cancelled')).toEqual({});
    // a second tick is quiet: notify-once
    jest.clearAllMocks();
    await Worker.runUntappedSweep(NOW);
    await Worker.runUndeliveredSweep(NOW);
    expect(WhatsAppService.sendMessage).not.toHaveBeenCalled();
  });
});
