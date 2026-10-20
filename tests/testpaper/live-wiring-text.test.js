/**
 * /testpaper live wiring — text-message.handler.js.
 *
 * The trigger and orchestrator suites test the routers and the conversation
 * on their own; this suite drives a message through the REAL handleTextMessage
 * so the one line that connects them to the bot —
 *
 *   if (messageBody && await routeTestPaperText({ ... })) { ...; return; }
 *
 * — is on the path under test. Deleting or reordering it (or renaming the
 * router) fails here instead of silently disconnecting the feature.
 *
 * Real: the handler, testpaper-trigger, the orchestrator, sources, store and
 * session (memory fallback). Mocked at the boundary: the database (in-memory
 * query builder), the messaging facade, the queue, Redis, the LLM services and
 * the logger; plus the handler's other services, stubbed to "not handled" so
 * control reaches the test-paper line.
 */

const { createFakeDb } = require('./helpers/fake-db');

const TEACHER = { id: '00000000-0000-4000-8000-0000000000a1', preferred_language: 'en', phone_number: '15550100001' };
const FROM = '15550100001';
const TEXT = (s) => `${s} `.repeat(12);

let handleTextMessage;
let O;
let db;
let WA;
let OpenAI;

function seed() {
  return {
    users: [{ id: TEACHER.id }],
    textbooks: [{ id: 'tb-1', grade: 2, subject: 'math', curriculum: 'corpus' }],
    textbook_toc: [
      { id: 't1', textbook_id: 'tb-1', chapter_number: 1, chapter_title: 'Numbers up to 999', page_start: 1, page_end: 1 },
      { id: 't2', textbook_id: 'tb-1', chapter_number: 2, chapter_title: 'Adding', page_start: 2, page_end: 2 },
    ],
    textbook_pages: [
      { id: 'p1', textbook_id: 'tb-1', textbook_page_number: 1, page_content: TEXT('A 3-digit number has hundreds, tens and ones.') },
      { id: 'p2', textbook_id: 'tb-1', textbook_page_number: 2, page_content: TEXT('Add the ones first, then the tens, then the hundreds.') },
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
    startContinuousTypingIndicator: jest.fn(() => ({ stop: jest.fn() })),
  });
  jest.doMock('../../bot/shared/services/whatsapp.service', () => WA);
  jest.doMock('../../bot/shared/services/queue', () => ({ queueJob: jest.fn().mockResolvedValue('job-1') }));
  // General AI chat: what the text would reach if the test-paper line let it through.
  OpenAI = inert({
    detectIntent: jest.fn().mockResolvedValue({ type: 'general' }),
    getResponseWithFormat: jest.fn().mockResolvedValue('A friendly AI reply.'),
  });
  jest.doMock('../../bot/shared/services/openai.service', () => OpenAI);
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
  jest.doMock('../../bot/shared/services/feature-registration.service', () => inert({ isPendingName: jest.fn().mockResolvedValue(false) }));
  jest.doMock('../../bot/shared/services/quiz/quiz-session.service', () => inert());
  jest.doMock('../../bot/shared/services/quiz/video-quiz-share.service', () => inert({
    parseShareCode: jest.fn(() => null), consumeJoinReply: jest.fn().mockResolvedValue(false),
  }));
  jest.doMock('../../bot/shared/services/student-video-feedback.service', () => inert({ consumeReasonIfPending: jest.fn().mockResolvedValue(false) }));
  require('../../bot/shared/config/feature-availability').overrides.load(process.env);
  ({ handleTextMessage } = require('../../bot/shared/handlers/text-message.handler'));
  O = require('../../bot/shared/services/testpaper/testpaper-orchestrator.service');
}

afterEach(() => {
  jest.resetModules();
});

const rowsOf = (list) => list.action.sections.flatMap((s) => s.rows);
const lastList = () => WA.sendInteractiveMessage.mock.calls[WA.sendInteractiveMessage.mock.calls.length - 1][1];
const expectNoAiChat = () => {
  expect(OpenAI.detectIntent).not.toHaveBeenCalled();
  expect(OpenAI.getResponseWithFormat).not.toHaveBeenCalled();
};
const send = (body, id = 'wamid.t1') => handleTextMessage({ id, from: FROM, type: 'text', text: { body } }, FROM, body, TEACHER);

describe('handleTextMessage → /testpaper', () => {
  it('"/testpaper" opens the source list through the messaging facade', async () => {
    load();
    await send('/testpaper');
    expect(WA.sendInteractiveMessage).toHaveBeenCalledTimes(1);
    expect(WA.sendInteractiveMessage.mock.calls[0][0]).toBe(FROM);
    const ids = rowsOf(lastList()).map((r) => r.id);
    expect(ids[0]).toBe('tp_src_tb_0');
    expect(ids.every((id) => id.startsWith('tp_'))).toBe(true);
    expectNoAiChat();
  });

  it('a chapter number typed while a pick is pending goes to the conversation, not to AI chat', async () => {
    load();
    // Started on the orchestrator directly, so this case isolates the reply path.
    await O.start({ user: TEACHER, from: FROM, args: '', language: 'en' });
    expect(await O.handleSelection({ user: TEACHER, from: FROM, id: 'tp_src_tb_0', language: 'en' })).toBe(true);
    expect(rowsOf(lastList()).map((r) => r.id)).toEqual(['tp_ch_1', 'tp_ch_2', 'tp_ch_all']);

    await send('1', 'wamid.t2');
    expect(rowsOf(lastList()).map((r) => r.id)).toEqual(['tp_mix_quick', 'tp_mix_standard', 'tp_mix_full']);
    expectNoAiChat();
  });
});
