/**
 * /testpaper live wiring — whatsapp-bot.js's Meta webhook.
 *
 * The trigger and orchestrator suites test the routers and the conversation
 * on their own; this suite POSTs Meta-shaped webhooks into the REAL
 * handleWebhookPost (the handler express mounts at POST /webhook) so the three
 * lines that connect them to the bot are on the path under test:
 *
 *   button_reply  if (await routeTestPaperSelection({ user, from, id: buttonId })) return;
 *   list_reply    if (await routeTestPaperSelection({ user, from, id: listId })) return;
 *   document      if (await routeTestPaperDocument({ user, from, message })) return;
 *
 * Deleting or reordering any of them (or renaming a router) fails here instead
 * of silently disconnecting the feature.
 *
 * Real: whatsapp-bot.js, the validators, testpaper-trigger, the orchestrator,
 * sources, store and session (memory fallback). Mocked at the boundary: the
 * database (in-memory query builder), the messaging facade, the queue, Redis,
 * the LLM services and the logger; plus the message dedupe (SessionService),
 * the user lookup (bot-helpers), and the audio/voice path an audio document
 * falls through to.
 */

const { createFakeDb } = require('./helpers/fake-db');

const FROM = '15550100002';
const TEACHER = { id: '00000000-0000-4000-8000-0000000000b2', preferred_language: 'en', phone_number: FROM };
const TEXT = (s) => `${s} `.repeat(12);

let handleWebhookPost;
let O;
let db;
let WA;
let Voice;
let msgSeq = 0;

function seed() {
  return {
    users: [{ id: TEACHER.id }],
    lesson_plans: [
      { id: 'lp-1', user_id: TEACHER.id, topic: 'How plants make food', subject: 'Science', grade: '4', content: { text: TEXT('Plants make food in their leaves using sunlight, water and air.') }, created_at: '2026-09-20T10:00:00Z' },
      { id: 'lp-2', user_id: TEACHER.id, topic: 'Parts of a plant', subject: 'Science', grade: '4', content: { text: TEXT('Roots hold the plant and take in water; the stem carries it up.') }, created_at: '2026-09-21T10:00:00Z' },
    ],
  };
}

/** Any method on these stubs resolves to "nothing to do". */
function inert(explicit = {}) {
  return new Proxy(explicit, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol' || prop === 'then' || prop === '__esModule') return undefined;
      target[prop] = jest.fn().mockResolvedValue(null);
      return target[prop];
    },
  });
}

function load() {
  jest.resetModules();
  process.env.OPENROUTER_API_KEY = 'test-key';
  delete process.env.RUMI_FEATURE_TEST_PAPER;
  delete process.env.PHONE_NUMBER_ID;
  db = createFakeDb(seed());
  jest.doMock('../../bot/shared/config/supabase', () => db);
  jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn(), LOGS_DIR: '/tmp' }));
  jest.doMock('../../bot/shared/services/cache/railway-redis.service', () => inert({
    set: jest.fn().mockResolvedValue(false), get: jest.fn().mockResolvedValue(null), delete: jest.fn().mockResolvedValue(true), redis: inert(),
  }));
  WA = inert({
    sendMessage: jest.fn().mockResolvedValue(true),
    sendInteractiveMessage: jest.fn().mockResolvedValue(true),
    sendInteractiveButtons: jest.fn().mockResolvedValue(true),
    sendDocument: jest.fn().mockResolvedValue(true),
    downloadMedia: jest.fn(),
    sendReaction: jest.fn().mockResolvedValue(true),
    showTypingIndicator: jest.fn().mockResolvedValue(true),
    startContinuousTypingIndicator: jest.fn(() => ({ stop: jest.fn() })),
  });
  jest.doMock('../../bot/shared/services/whatsapp.service', () => WA);
  jest.doMock('../../bot/shared/services/queue', () => ({ queueJob: jest.fn().mockResolvedValue('job-1') }));
  jest.doMock('../../bot/shared/services/openai.service', () => inert());
  // An LLM service whose JSON repair package is installed only with the bot's own dependencies (absent in CI's root job).
  jest.doMock('../../bot/shared/services/gpt5-mini.service', () => inert());
  jest.doMock('../../bot/shared/services/exam-checker/annotation.service', () => inert());
  jest.doMock('../../bot/shared/services/feature-registration.service', () => inert());
  jest.doMock('../../bot/shared/services/portal-invite.service', () => inert());
  jest.doMock('../../bot/shared/services/pdf-report.service', () => inert());
  jest.doMock('../../bot/shared/services/llm-client', () => ({ getClient: () => inert() }));
  jest.doMock('../../bot/shared/utils/language-cache', () => inert({
    getUserLanguage: jest.fn().mockResolvedValue('en'), setUserLanguage: jest.fn(), setLanguageLock: jest.fn(),
  }));
  jest.doMock('../../bot/shared/database/bot-helpers', () => inert({
    getOrCreateUser: jest.fn().mockResolvedValue(TEACHER),
    getOrCreateSession: jest.fn().mockResolvedValue('session-1'),
  }));
  // Redis-backed message dedupe: every message is new.
  jest.doMock('../../bot/shared/services/session.service', () => inert({
    isProcessed: jest.fn().mockResolvedValue(false),
    markAsProcessed: jest.fn().mockResolvedValue(true),
    getReactionEmoji: jest.fn(() => '👀'),
  }));
  // Where a short audio document goes when test papers pass it on.
  jest.doMock('../../bot/shared/services/audio.service', () => inert({ getAudioDuration: jest.fn().mockResolvedValue(60) }));
  Voice = { handleVoiceMessage: jest.fn().mockResolvedValue(undefined) };
  jest.doMock('../../bot/shared/handlers/voice-message.handler', () => Voice);

  const { app } = require('../../bot/whatsapp-bot');
  handleWebhookPost = routeHandler(app, 'post', '/webhook');
  O = require('../../bot/shared/services/testpaper/testpaper-orchestrator.service');
}

/**
 * The handler express runs for METHOD PATH — the live mount, not a re-export.
 * A path can be served by a route on the app itself or by a mounted router
 * (POST /webhook is the WhatsApp gateway router, bot/gateway/).
 */
function routeHandler(app, method, path) {
  const router = app.router || app._router;
  const matches = (l) => l.route && [].concat(l.route.path).includes(path) && l.route.methods[method];
  const layer = router.stack.find(matches)
    || router.stack.flatMap((l) => (l.handle && Array.isArray(l.handle.stack) ? l.handle.stack : [])).find(matches);
  if (!layer) throw new Error(`no ${method.toUpperCase()} ${path} route on the app`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function metaWebhook(message) {
  msgSeq += 1;
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: '1555010000000',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550100000', phone_number_id: '1555010009999' },
          contacts: [{ profile: { name: 'Sam' }, wa_id: FROM }],
          messages: [{ from: FROM, id: `wamid.live-wiring-${msgSeq}`, timestamp: String(Math.floor(Date.now() / 1000)), ...message }],
        },
      }],
    }],
  };
}

async function post(message) {
  const res = { statusCode: null, body: null };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.send = jest.fn((body) => { res.body = body; return res; });
  res.sendStatus = jest.fn((code) => { res.statusCode = code; return res; });
  await handleWebhookPost({ method: 'POST', url: '/webhook', headers: {}, body: metaWebhook(message) }, res);
  return res;
}

const listReply = (id, title = 'Pick') => ({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id, title } } });
const buttonReply = (id, title = 'Tap') => ({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } } });
const documentMsg = (document) => ({ type: 'document', document });

const rowsOf = (list) => list.action.sections.flatMap((s) => s.rows);
const lastList = () => WA.sendInteractiveMessage.mock.calls[WA.sendInteractiveMessage.mock.calls.length - 1][1];
const textsSent = () => WA.sendMessage.mock.calls.map((c) => c[1]);

afterEach(() => {
  jest.resetModules();
});

describe('webhook list_reply → test paper', () => {
  it('"My lesson plans" (tp_src_lp) opens the lesson-plan list', async () => {
    load();
    await O.start({ user: TEACHER, from: FROM, args: '', language: 'en' });
    WA.sendInteractiveMessage.mockClear();

    const res = await post(listReply('tp_src_lp', 'My lesson plans (2)'));
    // Meta retries a webhook it gets no 200 for.
    expect(res.statusCode).toBe(200);

    expect(WA.sendInteractiveMessage).toHaveBeenCalledTimes(1);
    expect(WA.sendInteractiveMessage.mock.calls[0][0]).toBe(FROM);
    expect(rowsOf(lastList()).map((r) => r.id)).toEqual(['tp_lp_0', 'tp_lp_1', 'tp_lp_all']);
  });
});

describe('webhook button_reply → test paper', () => {
  it('"My papers" (tp_mine) with none yet says so', async () => {
    load();
    const res = await post(buttonReply('tp_mine', 'My papers'));
    expect(res.statusCode).toBe(200);
    expect(textsSent()).toEqual([expect.stringMatching(/no test papers yet/)]);
  });
});

describe('webhook document → test paper', () => {
  const awaitChapter = async () => {
    await O.start({ user: TEACHER, from: FROM, args: '', language: 'en' });
    expect(await O.handleSelection({ user: TEACHER, from: FROM, id: 'tp_src_up', language: 'en' })).toBe(true);
    WA.sendMessage.mockClear();
    WA.sendInteractiveMessage.mockClear();
  };

  it('a text chapter sent while one is awaited is taken: downloaded, read, and the size list follows', async () => {
    load();
    await awaitChapter();
    WA.downloadMedia.mockResolvedValue(Buffer.from(TEXT('The water cycle: evaporation, condensation, precipitation.')));

    await post(documentMsg({ id: 'media-chapter-1', mime_type: 'text/plain', filename: 'water-cycle.txt' }));

    expect(WA.downloadMedia).toHaveBeenCalledWith('media-chapter-1');
    expect(textsSent()).toEqual([expect.stringMatching(/^Got it — about [\d,]+ characters/)]);
    expect(rowsOf(lastList()).map((r) => r.id)).toEqual(['tp_mix_quick', 'tp_mix_standard', 'tp_mix_full']);
    expect(Voice.handleVoiceMessage).not.toHaveBeenCalled();
  });

  it('an audio file in that same state is not taken: it goes on to the voice path', async () => {
    load();
    await awaitChapter();
    WA.downloadMedia.mockResolvedValue(Buffer.from('ID3 fake audio'));

    await post(documentMsg({ id: 'media-audio-1', mime_type: 'audio/mpeg', filename: 'class-recording.mp3' }));

    expect(Voice.handleVoiceMessage).toHaveBeenCalledWith(expect.objectContaining({ audio: { id: 'media-audio-1' } }), FROM, TEACHER);
    expect(WA.sendInteractiveMessage).not.toHaveBeenCalled();
    expect(textsSent().some((t) => /^Got it/.test(t))).toBe(false);
  });
});
