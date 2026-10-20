'use strict';
/**
 * The language ask with more than three quiz languages (review F-S12).
 *
 * The ask was one reply button per QUIZ_LANGUAGES entry. Meta takes at most
 * three buttons: with four the driver returns false without sending, the
 * result was ignored, and the teacher who said yes heard nothing. Now: three
 * or fewer are buttons; more are one list; and when the channel refuses
 * either, a numbered text whose typed number (or name) answers it the way a
 * tap would (messaging/pending-options).
 *
 * The real Meta driver runs behind the real messaging facade (axios mocked at
 * the network), with the real pending-options store (Redis mocked) and the real
 * offer service on a schema-checked in-memory database.
 */

const QID = '22222222-2222-4222-8222-222222222222';
const UID = '33333333-3333-4333-8333-333333333333';
const PHONE = '15550100001';

let axios;
let fetchMock;
let redisStore;
let db;
const realFetch = global.fetch;

function load() {
  jest.resetModules();
  process.env.CHANNEL_DRIVER = 'meta';
  process.env.WHATSAPP_TOKEN = 'test-token';
  process.env.PHONE_NUMBER_ID = '1555000';
  axios = { post: jest.fn().mockResolvedValue({ data: { messages: [{ id: 'wamid.1' }] } }), get: jest.fn() };
  jest.doMock('axios', () => axios);
  // The driver's sendMessage uses fetch: never the network from a test.
  fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ messages: [{ id: 'wamid.2' }] }) }));
  global.fetch = fetchMock;
  redisStore = new Map();
  jest.doMock('../../bot/shared/services/cache/railway-redis.service', () => ({
    get: jest.fn(async (k) => (redisStore.has(k) ? redisStore.get(k) : null)),
    set: jest.fn(async (k, v) => { redisStore.set(k, v); return true; }),
    delete: jest.fn(async (k) => { redisStore.delete(k); return true; }),
  }));
  jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn(), logError: jest.fn() }));
  jest.doMock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));
  jest.doMock('../../bot/shared/services/queue', () => ({ queueJob: jest.fn().mockResolvedValue('mid') }));
  jest.doMock('../../bot/shared/services/quiz/transcript-quiz-digest.service', () => ({ run: jest.fn() }));
  jest.doMock('../../bot/shared/services/feature-intro.service', () => ({
    hasSeenIntroVideo: jest.fn().mockResolvedValue(false), markVideoShown: jest.fn(),
  }));
  const { makeSchemaDb } = require('./helpers/schema-db');
  db = makeSchemaDb({
    users: [{ id: UID, phone_number: PHONE, preferred_language: 'en', name: 'Sample Teacher' }],
    quizzes: [{
      id: QID, teacher_id: UID, quiz_source: 'transcript', coaching_session_id: '11111111-1111-4111-8111-111111111111',
      topic: 'Fractions', subject: 'maths', language: 'en', status: 'offered',
      meta: { step: 'awaiting_language', awaiting_language: true, digest: { topic: 'Fractions', subject: 'maths', slos: [] } },
    }],
  });
  jest.doMock('../../bot/shared/config/supabase', () => ({ from: db.from }));
  return require('../../bot/shared/services/quiz/transcript-quiz-offer.service');
}

const posted = () => [
  ...axios.post.mock.calls.map((c) => c[1]),
  ...fetchMock.mock.calls.map((c) => JSON.parse(c[1].body)),
].filter((b) => b && b.messaging_product === 'whatsapp');

const ENV = { ...process.env };
beforeEach(() => {
  process.env = { ...ENV, TRANSCRIPT_QUIZ_ENABLED: 'true', QUIZ_LANGUAGES: 'en,ur,ar,fr' };
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
});
afterEach(() => { jest.resetModules(); process.env = { ...ENV }; global.fetch = realFetch; });

describe('four quiz languages on Meta', () => {
  test('the ask goes out as ONE list with a row per language, and says it was sent', async () => {
    const Offer = load();
    const ok = await Offer.sendLanguageAsk(QID, PHONE, 'en', 'en', {});
    expect(ok).toBe(true);
    const sent = posted();
    expect(sent).toHaveLength(1);
    expect(sent[0].interactive.type).toBe('list');
    const rows = sent[0].interactive.action.sections.flatMap((s) => s.rows);
    expect(rows.map((r) => r.id)).toEqual(['en', 'ur', 'ar', 'fr'].map((c) => `tq_lang_${c}_${QID}`));
  });

  test('a list Meta refuses falls back to numbered text, and a typed "3" answers it as the tap would', async () => {
    const Offer = load();
    axios.post.mockRejectedValueOnce(Object.assign(new Error('400'), { response: { data: { error: 'bad list' } } }));
    const ok = await Offer.sendLanguageAsk(QID, PHONE, 'en', 'en', {});
    expect(ok).toBe(true);
    const text = posted().find((b) => b.type === 'text');
    expect(text).toBeDefined();
    expect(text.text.body).toMatch(/1\. English/);
    expect(text.text.body).toMatch(/3\. العربية/);

    const handled = await Offer.handleTypedLanguageChoice(PHONE, '3', { id: UID, preferred_language: 'en' });
    expect(handled).toBe(true);
    expect(db.tables.quizzes[0].status).toBe('generating');
    expect(db.tables.quizzes[0].language).toBe('ar');
    // Answered: the same "3" later is ordinary chat again.
    expect(await Offer.handleTypedLanguageChoice(PHONE, '3', { id: UID })).toBe(false);
  });

  test('every send refused: the ask reports false (the caller can tell)', async () => {
    const Offer = load();
    axios.post.mockRejectedValue(new Error('network down'));
    fetchMock.mockRejectedValue(new Error('network down'));
    expect(await Offer.sendLanguageAsk(QID, PHONE, 'en', 'en', {})).toBe(false);
  });
});

describe('three or fewer stay buttons', () => {
  test('two languages: reply buttons, as before', async () => {
    process.env.QUIZ_LANGUAGES = 'en,ur';
    const Offer = load();
    expect(await Offer.sendLanguageAsk(QID, PHONE, 'en', 'ur', {})).toBe(true);
    const sent = posted();
    expect(sent).toHaveLength(1);
    expect(sent[0].interactive.type).toBe('button');
    expect(sent[0].interactive.action.buttons.map((b) => b.reply.id)).toEqual([`tq_lang_ur_${QID}`, `tq_lang_en_${QID}`]);
  });
});

describe('a typed reply that is not an answer to the ask', () => {
  test('no pending ask, or another menu pending: not taken', async () => {
    const Offer = load();
    expect(await Offer.handleTypedLanguageChoice(PHONE, '2', { id: UID })).toBe(false);
    const PendingOptions = require('../../bot/shared/services/messaging/pending-options');
    await PendingOptions.remember(PHONE, { replyType: 'list_reply', options: [{ id: 'lang_en', title: 'English' }, { id: 'lang_ur', title: 'Urdu' }] });
    expect(await Offer.handleTypedLanguageChoice(PHONE, '2', { id: UID })).toBe(false);
  });

  test('with the lesson quiz off nothing is read', async () => {
    const Offer = load();
    process.env.TRANSCRIPT_QUIZ_ENABLED = 'false';
    const Redis = require('../../bot/shared/services/cache/railway-redis.service');
    expect(await Offer.handleTypedLanguageChoice(PHONE, '2', { id: UID })).toBe(false);
    expect(Redis.get).not.toHaveBeenCalled();
  });
});
