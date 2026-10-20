/**
 * Coaches and teachers who reach Rumi on Matrix (or Slack/Discord) have NO
 * users.phone_number — only user_channels rows. Found running the Matrix
 * end-to-end rig: the roster, the coach's form and the teacher's report all
 * looked for a phone number and found nobody. This suite seeds users exactly
 * as the bot stores them for a non-WhatsApp channel.
 */

const { createFakeSupabase } = require('./_helpers/fake-supabase');
const { getObservePack } = require('../../bot/shared/services/observe/observe-framework');

function analysis() {
  const pack = getObservePack();
  const a = { domains: {} };
  for (const d of pack.domainOrder) a.domains[d] = { indicators: pack.domains[d].indicators.map((i) => ({ id: i.id, score: 3, evidence: 'seen' })) };
  return pack.computeScores(a);
}

const mockDb = createFakeSupabase({
  users: [
    { id: 'coach-1', role: 'coach', name: 'Robin Coach', phone_number: null, preferred_language: 'en' },
    { id: 't-1', role: null, name: 'Sam Taylor', phone_number: null, school_id: 'sch-1' },
    { id: 't-2', role: null, name: 'Alex Kim', phone_number: null, school_id: null },
  ],
  user_channels: [
    { user_id: 'coach-1', channel: 'matrix', channel_user_id: '1555400011', last_message_at: '2026-10-02T10:00:00Z' },
    { user_id: 't-1', channel: 'matrix', channel_user_id: '1555400001', last_message_at: '2026-10-02T10:00:00Z' },
    { user_id: 't-2', channel: 'matrix', channel_user_id: '15554000002', last_message_at: '2026-10-02T10:00:00Z' },
  ],
  leader_schools: [{ id: 'ls-1', leader_user_id: 'coach-1', school_id: 'sch-1', school_ext_id: 'S-001', school_name: 'Hillside Primary' }],
  coaching_sessions: [],
});
jest.mock('../../bot/shared/config/supabase', () => mockDb.client);
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
const mockRedis = new Map();
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  setexWithCeiling: jest.fn(async (k, ttl, v) => { mockRedis.set(k, v); return true; }),
  get: jest.fn(async (k) => (mockRedis.has(k) ? JSON.parse(mockRedis.get(k)) : null)),
  delete: jest.fn(async (k) => mockRedis.delete(k)),
  setNX: jest.fn(async () => true),
}));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn(async () => true),
  sendInteractiveButtons: jest.fn(async () => true),
  sendInteractiveMessage: jest.fn(async () => true),
  sendFlow: jest.fn(async () => true),
}));
jest.mock('../../bot/shared/services/coaching/coaching-job-queue.service', () => ({
  queueObserveTeacherReport: jest.fn(async () => 'msg-1'),
}));

const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const Roster = require('../../bot/shared/services/observe/observe-roster.service');
const ObserveDraft = require('../../bot/shared/services/observe/observe-draft.service');
const ObserveSend = require('../../bot/shared/services/observe/observe-send.service');
const { handleObserveInteractive } = require('../../bot/shared/handlers/observe-interactive.handler');
const { handleObserveText } = require('../../bot/shared/handlers/observe-command.handler');

const FROM = 'mtx:1555400011';
const coach = () => mockDb.tables.users[0];
const delivery = (id) => (mockDb.tables.coaching_sessions.find((s) => s.id === id).analysis_data || {}).teacher_delivery || {};

beforeEach(() => { jest.clearAllMocks(); mockRedis.clear(); process.env.OBSERVE_ENABLED = 'true'; });

test('the roster carries each teacher\'s channel identity', async () => {
  const [t] = await Roster.listTeachers('coach-1');
  expect(t).toMatchObject({ user_id: 't-1', name: 'Sam Taylor', phone: 'mtx:1555400001' });
});

test('the pre-filled form reaches a Matrix coach from the worker (no `from` to fall back on)', async () => {
  mockDb.tables.coaching_sessions.push({ id: 'obs-1', user_id: 't-1', observer_user_id: 'coach-1', observation_type: 'leader_observation', status: 'analysis_complete', analysis_data: analysis() });
  await ObserveDraft.onAnalysisReady('obs-1', undefined);
  expect(WhatsAppService.sendMessage.mock.calls[0][0]).toBe(FROM);
});

test('a bound Matrix teacher gets the report without the coach being asked', async () => {
  mockDb.tables.coaching_sessions.push({ id: 'obs-2', user_id: 't-1', observer_user_id: 'coach-1', observation_type: 'leader_observation', status: 'observer_review_complete', analysis_data: {} });
  await handleObserveInteractive(coach(), FROM, 'observe_send_start_obs-2');
  expect(delivery('obs-2')).toMatchObject({ teacher_name: 'Sam Taylor', teacher_phone: 'mtx:1555400001', target: 'session_binding' });
  expect(WhatsAppService.sendInteractiveMessage).not.toHaveBeenCalled();
});

test('a number the coach types finds the teacher\'s Matrix account', async () => {
  mockDb.tables.coaching_sessions.push({ id: 'obs-3', user_id: 'coach-1', observer_user_id: 'coach-1', observation_type: 'leader_observation', status: 'observer_review_complete', analysis_data: {} });
  await handleObserveInteractive(coach(), FROM, 'observe_send_start_obs-3');
  await handleObserveInteractive(coach(), FROM, 'observe_pickt_new');
  expect(await handleObserveText(coach(), FROM, 'Alex Kim, +1 555 400 0002')).toBe(true);
  expect(delivery('obs-3')).toMatchObject({ teacher_name: 'Alex Kim', teacher_phone: 'mtx:15554000002' });
});

test('a sweep reminder reaches a Matrix coach', async () => {
  const finished = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
  mockDb.tables.coaching_sessions.push({ id: 'obs-4', user_id: 't-1', observer_user_id: 'coach-1', observation_type: 'leader_observation', status: 'observer_review_complete', debrief_status: 'done', updated_at: finished, analysis_data: {} });
  const decision = await ObserveSend.processUndeliveredDelivery('obs-4');
  expect(decision.action).toBe('remind');
  expect(WhatsAppService.sendMessage).toHaveBeenCalledWith(FROM, expect.stringMatching(/not been sent yet/));
});
