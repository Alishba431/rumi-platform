/**
 * The "you have an unfinished coaching session" prompt on the live text
 * handler. It looks for the teacher's own session stuck in conversation or
 * analysis, and the teacher's reply (1 retry / 2 start fresh / 3 archive) then
 * acts on that row. A coach's observation of the teacher is a row with
 * user_id = teacher that sits in 'analyzing' too, so it must never be picked:
 * the teacher would be told about a session they never started, and their
 * reply would fail, archive or re-run the coach's observation.
 */
const { createFakeSupabase } = require('../observe/_helpers/fake-supabase');

const mockDb = createFakeSupabase({});
jest.mock('../../bot/shared/config/supabase', () => mockDb.client);
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
// the LLM is the other network boundary: offline, so the general reply falls back
const mockOffline = () => ({ chat: { completions: { create: async () => { throw new Error('offline'); } } } });
jest.mock('../../bot/shared/services/llm-client', () => ({
  createLLMClient: mockOffline, getClient: mockOffline, getDefaultModel: () => 'test-model', getProviderInfo: () => ({}),
}));
const mockRedis = new Map();
const mockRaw = {
  get: jest.fn(async (k) => (mockRedis.has(k) ? mockRedis.get(k) : null)),
  set: jest.fn(async (k, v) => { mockRedis.set(k, v); return 'OK'; }),
  setex: jest.fn(async (k, ttl, v) => { mockRedis.set(k, v); return 'OK'; }),
  del: jest.fn(async (k) => (mockRedis.delete(k) ? 1 : 0)),
};
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  get: jest.fn(async () => null),
  set: jest.fn(async () => true),
  setex: jest.fn(async () => true),
  setexWithCeiling: jest.fn(async () => true),
  delete: jest.fn(async () => true),
  exists: jest.fn(async () => false),
  isAvailable: () => true,
  redis: mockRaw,
}));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  startContinuousTypingIndicator: () => ({ stop: () => {} }),
  sendMessage: jest.fn(async () => true),
  sendInteractiveButtons: jest.fn(async () => true),
  sendInteractiveMessage: jest.fn(async () => true),
  sendReaction: jest.fn(async () => true),
}));
jest.mock('../../bot/shared/database/bot-helpers', () => ({
  ...jest.requireActual('../../bot/shared/database/bot-helpers'),
  getOrCreateSession: jest.fn(async () => 'chat-1'),
  storeConversation: jest.fn(async () => true),
}));
const mockCoaching = { retryAnalysis: jest.fn(async () => true), handleReflectiveResponse: jest.fn(async () => true) };
jest.mock('../../bot/shared/services/coaching-orchestrator.service', () => mockCoaching);

const WhatsAppService = require('../../bot/shared/services/whatsapp.service');

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const TEACHER = { id: 't-1', name: 'Sam Taylor', phone_number: '15550100002', preferred_language: 'en', preferences: {}, registration_completed: true };
const observation = () => ({ id: 'obs-1', user_id: 't-1', observer_user_id: 'coach-1', observation_type: 'leader_observation',
  status: 'analyzing', created_at: hoursAgo(3), updated_at: hoursAgo(2), conversation_state: {} });
const ownSession = () => ({ id: 'self-1', user_id: 't-1', status: 'analyzing', created_at: hoursAgo(3), updated_at: hoursAgo(2), conversation_state: {} });

// The real text handler pulls the whole bot graph, which only exists once bot deps are installed
// (same gate as tests/observe/observe-wiring.test.js).
const botDepsInstalled = require('fs').existsSync(require('path').resolve(__dirname, '../../bot/node_modules'));
const describeWithBotDeps = botDepsInstalled ? describe : describe.skip;

function seed(rows) {
  for (const k of Object.keys(mockDb.tables)) delete mockDb.tables[k];
  mockDb.tables.users = [{ ...TEACHER }];
  mockDb.tables.chat_sessions = [];
  mockDb.tables.coaching_sessions = rows;
}

describeWithBotDeps('unfinished-session prompt on the live text handler', () => {
  const handle = (body) => require('../../bot/shared/handlers/text-message.handler')
    .handleTextMessage({ id: `w-${Math.random()}` }, TEACHER.phone_number, body, { ...TEACHER });

  beforeEach(() => { jest.clearAllMocks(); mockRedis.clear(); });

  const toldAboutUnfinished = () => WhatsAppService.sendMessage.mock.calls.some(([, text]) => /unfinished coaching session/.test(text));

  test("the teacher is never told a coach's observation is their unfinished session", async () => {
    seed([observation()]);
    await handle('hello');
    expect(toldAboutUnfinished()).toBe(false);
    expect(mockRedis.has('user:t-1:expecting:recovery')).toBe(false);
  });

  test("a recovery reply can never fail the coach's observation", async () => {
    // e.g. a prompt stored before this fix, still within its 5-minute window
    seed([observation()]);
    mockRedis.set('user:t-1:expecting:recovery', 'obs-1');
    await handle('2');
    expect(mockDb.tables.coaching_sessions[0].status).toBe('analyzing');
  });

  test('a teacher with no observations: their own stuck session is still offered, and reply 2 still archives it', async () => {
    seed([ownSession()]);
    await handle('hello');
    expect(toldAboutUnfinished()).toBe(true);
    expect(mockRedis.get('user:t-1:expecting:recovery')).toBe('self-1');
    await handle('2');
    expect(mockDb.tables.coaching_sessions[0].status).toBe('failed');
  });
});
