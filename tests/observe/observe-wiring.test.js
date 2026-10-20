/**
 * The observe hooks on the LIVE handler paths (not the observe modules in
 * isolation): /observe through handleTextMessage, and a coach's recording
 * through handleVoiceMessage becoming a leader observation instead of a
 * teacher's own coaching session. The database, Redis, the queue and the
 * channel are faked; the handlers and observe code run for real.
 */

const { createFakeSupabase } = require('./_helpers/fake-supabase');

const mockDb = createFakeSupabase({
  users: [
    { id: 'coach-1', role: 'coach', name: 'Robin Coach', phone_number: '15550100001', preferred_language: 'en', preferences: { observe_onboarded: true }, registration_completed: true },
    { id: 'teacher-1', role: null, name: 'Sam Taylor', phone_number: '15550100002', preferred_language: 'en', preferences: {}, registration_completed: true },
  ],
  chat_sessions: [],
});
jest.mock('../../bot/shared/config/supabase', () => mockDb.client);
const mockRedis = new Map();
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  get: jest.fn(async (k) => (mockRedis.has(k) ? JSON.parse(mockRedis.get(k)) : null)),
  set: jest.fn(async (k, v) => { mockRedis.set(k, typeof v === 'string' ? v : JSON.stringify(v)); return true; }),
  setex: jest.fn(async (k, ttl, v) => { mockRedis.set(k, typeof v === 'string' ? v : JSON.stringify(v)); return true; }),
  setexWithCeiling: jest.fn(async (k, ttl, v) => { mockRedis.set(k, v); return true; }),
  delete: jest.fn(async (k) => mockRedis.delete(k)),
  exists: jest.fn(async () => false),
  isAvailable: () => true,
  redis: { get: async () => null, set: async () => 'OK', del: async () => 1 },
}));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  startContinuousTypingIndicator: () => ({ stop: () => {} }),
  sendMessage: jest.fn(async () => true),
  sendInteractiveButtons: jest.fn(async () => true),
  sendInteractiveMessage: jest.fn(async () => true),
  getMediaInfo: jest.fn(async () => ({ file_size: 50_000 })),
  downloadMedia: jest.fn(async () => Buffer.from('')),
  sendReaction: jest.fn(async () => true),
}));
jest.mock('../../bot/shared/database/bot-helpers', () => ({
  ...jest.requireActual('../../bot/shared/database/bot-helpers'),
  getOrCreateSession: jest.fn(async () => 'chat-1'),
  storeConversation: jest.fn(async () => true),
}));
const mockQueue = { queueCoachingJob: jest.fn(async () => 'm1') };
jest.mock('../../bot/shared/services/queue', () => mockQueue);
const mockCoaching = { initiateCoachingSession: jest.fn(async () => true) };
jest.mock('../../bot/shared/services/coaching-orchestrator.service', () => mockCoaching);

const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const ObserveState = require('../../bot/shared/services/observe/observe-state.service');
const handlers = () => ({
  ...require('../../bot/shared/handlers/text-message.handler'),
  ...require('../../bot/shared/handlers/voice-message.handler'),
});

const coach = () => mockDb.tables.users[0];

// The real text/voice handlers pull the whole bot graph (uuid, ffmpeg, …), which
// only exists once bot deps are installed — the root CI job runs before that.
// Same pattern as tests/setup/bin-rumi.test.js. The Matrix E2E proves this path live.
const botDepsInstalled = require('fs').existsSync(require('path').resolve(__dirname, '../../bot/node_modules'));
const describeWithBotDeps = botDepsInstalled ? describe : describe.skip;

describeWithBotDeps('observe wiring on the live handlers', () => {
  beforeEach(() => { jest.clearAllMocks(); mockRedis.clear(); process.env.OBSERVE_ENABLED = 'true'; });

  test('/observe through handleTextMessage arms the capture', async () => {
    await handlers().handleTextMessage({ id: 'w1' }, '15550100001', '/observe', coach());
    expect(WhatsAppService.sendMessage.mock.calls.map((c) => c[1]).join('\n')).toMatch(/record the lesson on your phone/);
    expect((await ObserveState.getState('coach-1')).state).toBe('awaiting_audio');
  });

  test('an armed coach\'s voice note becomes a leader observation, not self-coaching', async () => {
    await ObserveState.setState('coach-1', 'awaiting_audio');
    await handlers().handleVoiceMessage({ id: 'w2', type: 'audio', audio: { id: 'media-1', mime_type: 'audio/ogg' } }, '15550100001', coach());
    const row = (mockDb.tables.coaching_sessions || [])[0];
    expect(row).toMatchObject({ observation_type: 'leader_observation', observer_user_id: 'coach-1', audio_id: 'media-1' });
    expect(mockQueue.queueCoachingJob).toHaveBeenCalledWith(row.id, 'transcription', expect.objectContaining({ audioId: 'media-1' }));
    expect(mockCoaching.initiateCoachingSession).not.toHaveBeenCalled();
  });

  test('with observe off, a coach\'s classroom file still goes nowhere new (feature dark = unchanged)', async () => {
    delete process.env.OBSERVE_ENABLED;
    const { routeLeaderAudio } = require('../../bot/shared/services/observe/observe-audio-router');
    expect(await routeLeaderAudio({ user: coach(), from: '15550100001', audioId: 'm', durationSeconds: 2000 })).toBe(false);
  });
});
