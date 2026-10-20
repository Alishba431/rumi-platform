/**
 * While Rumi waits for a teacher's name, every plain message is read as the
 * answer (text-message.handler.js). A teacher whose name is a greeting word
 * ("Salam") used to be told "I didn't quite catch that" on every message, so
 * they could neither register nor use Rumi in plain text. Now the first
 * "Salam" gets a question that makes clear it can be their name, and sending
 * it again registers it. Only the database, Redis and the outbound send are
 * mocked; the handler and the registration service run for real.
 */

const FROM = '+15550100001';
const USER = { id: 'user-1', preferred_language: 'en' };

function load() {
  jest.resetModules();
  const sent = [];
  const updates = [];
  const redisStore = new Map();
  jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
  jest.doMock('../../bot/shared/services/whatsapp.service', () => ({
    startContinuousTypingIndicator: jest.fn(() => ({ stop: jest.fn() })),
    sendMessage: jest.fn(async (to, text) => { sent.push(text); return true; }),
    sendAudio: jest.fn(),
  }));
  jest.doMock('../../bot/shared/services/cache/railway-redis.service', () => ({
    redis: null,
    get: jest.fn(async (k) => (redisStore.has(k) ? JSON.parse(redisStore.get(k)) : null)),
    set: jest.fn(async (k, v) => { redisStore.set(k, typeof v === 'string' ? v : JSON.stringify(v)); return true; }),
    delete: jest.fn(async (k) => { redisStore.delete(k); return true; }),
  }));
  jest.doMock('../../bot/shared/services/quiz/quiz-session.service', () => ({
    getPostQuizState: jest.fn(async () => null), getActiveState: jest.fn(async () => null),
  }));
  jest.doMock('../../bot/shared/database/bot-helpers', () => ({
    getOrCreateUser: jest.fn(), getOrCreateUserByChannel: jest.fn(),
    getOrCreateSession: jest.fn(async () => 'session-1'),
    updateSessionType: jest.fn(), storeConversation: jest.fn(), storeLessonPlan: jest.fn(),
  }));
  // users row: the teacher is waiting for their name until an update clears it.
  const row = { registration_pending_name: true };
  jest.doMock('../../bot/shared/config/supabase', () => ({
    from: jest.fn(() => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: { ...row }, error: null }) }) }),
      update: (patch) => ({ eq: async () => { updates.push(patch); Object.assign(row, patch); return { error: null }; } }),
    })),
  }));
  const { handleTextMessage } = require('../../bot/shared/handlers/text-message.handler');
  return { handleTextMessage, sent, updates };
}

// The real handler loads the bot's own packages, which the root CI pass runs
// before bot/ installs (same guard as tests/observe/observe-wiring.test.js).
const botDepsInstalled = require('fs').existsSync(require('path').resolve(__dirname, '../../bot/node_modules'));
const describeWithBotDeps = botDepsInstalled ? describe : describe.skip;

describeWithBotDeps('the pending-name loop through the real text handler', () => {
  it('"Salam" sent twice registers the teacher as Salam', async () => {
    const { handleTextMessage, sent, updates } = load();

    await handleTextMessage({ id: 'm1' }, FROM, 'Salam', USER);
    expect(updates).toEqual([]);
    expect(sent[0]).toMatch(/"Salam"/);
    expect(sent[0]).toMatch(/your name/i);

    await handleTextMessage({ id: 'm2' }, FROM, 'Salam', USER);
    expect(updates[0]).toEqual(expect.objectContaining({ first_name: 'Salam', registration_pending_name: false }));
    expect(sent[1]).toMatch(/Nice to meet you, Salam/);
  });

  it('"null" is asked again and never stored', async () => {
    const { handleTextMessage, sent, updates } = load();
    await handleTextMessage({ id: 'm1' }, FROM, 'null', USER);
    await handleTextMessage({ id: 'm2' }, FROM, 'null', USER);
    expect(updates).toEqual([]);
    expect(sent).toEqual([expect.stringMatching(/didn't quite catch/), expect.stringMatching(/didn't quite catch/)]);
  });

  it('a different reply to the re-ask is read on its own', async () => {
    const { handleTextMessage, updates } = load();
    await handleTextMessage({ id: 'm1' }, FROM, 'Hi', USER);
    await handleTextMessage({ id: 'm2' }, FROM, 'My name is Noor', USER);
    expect(updates[0]).toEqual(expect.objectContaining({ first_name: 'Noor' }));
  });
});
