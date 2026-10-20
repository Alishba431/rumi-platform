'use strict';
/**
 * The lesson quiz's button and list routes in whatsapp-bot.js, EXECUTED — not
 * grepped. A source-level assertion cannot see a ReferenceError in the branch
 * it matches, so the real webhook route is loaded, a real button / list payload
 * is POSTed through it, and the assertion is which handler was reached with
 * what. The quiz services themselves are mocked at the module boundary (they
 * have their own suites).
 */

const { mockBotDependency } = require('../_helpers/mock-bot-dependency');
const http = require('http');

const QID = '22222222-2222-4222-8222-222222222222';
const PHONE = '15550001111';

function interactiveBody(interactive) {
  return {
    entry: [{
      id: 'waba',
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: 'pnid' },
          messages: [{
            id: `wamid.${Math.random().toString(36).slice(2)}`,
            from: PHONE,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'interactive',
            interactive,
          }],
        },
      }],
    }],
  };
}
function textBody(text) {
  const body = interactiveBody(null);
  const m = body.entry[0].changes[0].value.messages[0];
  delete m.interactive;
  m.type = 'text';
  m.text = { body: text };
  return body;
}
const buttonBody = (id) => interactiveBody({ type: 'button_reply', button_reply: { id, title: 'x' } });
const listBody = (id) => interactiveBody({ type: 'list_reply', list_reply: { id, title: 'x' } });

async function postWebhook(app, body) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/** Wait (briefly) for a mock to be called: the webhook may ack before the dispatch finishes. */
async function until(fn) {
  for (let i = 0; i < 40 && !fn(); i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 25));
  }
}

let mocks;

function mockBoundary() {
  // gpt5-mini.service (reached through the real route) needs jsonrepair, a bot-only
  // dependency the root suite runs without.
  jest.doMock('jsonrepair', () => ({ jsonrepair: (s) => s }), { virtual: true });
  mockBotDependency('aws-sdk', () => ({ config: { update: () => {} }, SQS: function SQS() {} }));
  jest.doMock('pdfkit', () => ({}), { virtual: true });
  jest.doMock('uuid', () => ({ v4: () => 'stub-uuid' }), { virtual: true });
  jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn(), logError: jest.fn(), LOGS_DIR: '/tmp' }));
  jest.doMock('../../bot/shared/utils/validators', () => ({
    validateWebhookStatus: () => null,
    validateWebhookMessage: (req) => {
      const value = req.body.entry[0].changes[0].value;
      const message = value.messages[0];
      return {
        entry: req.body.entry[0], message, from: message.from, messageBody: (message.text && message.text.body) || '',
        messageType: message.type, messageTimestamp: message.timestamp,
        phoneNumberId: value.metadata.phone_number_id,
      };
    },
    isOurPhoneNumber: () => true,
    isTestWebhook: () => false,
    isTestPhoneNumber: () => false,
    isWithin24Hours: () => true,
    isAlreadyProcessed: () => false,
    markAsProcessed: () => {},
  }));
  jest.doMock('../../bot/shared/services/cache/railway-redis.service', () => ({
    redis: { get: jest.fn().mockResolvedValue(null), set: jest.fn(), del: jest.fn() },
    isAvailable: () => true,
    checkRateLimit: jest.fn().mockResolvedValue({ allowed: true }),
    get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(true),
    delete: jest.fn(), del: jest.fn(), setNX: jest.fn().mockResolvedValue(true),
  }));
  jest.doMock('../../bot/shared/services/session.service', () => ({
    isProcessed: jest.fn().mockResolvedValue(false),
    markAsProcessed: jest.fn().mockResolvedValue(undefined),
    getReactionEmoji: jest.fn().mockReturnValue('👍'),
  }));
  jest.doMock('../../bot/shared/services/whatsapp.service', () => ({
    sendReaction: jest.fn().mockResolvedValue(true),
    showTypingIndicator: jest.fn().mockResolvedValue(true),
    sendMessage: jest.fn().mockResolvedValue(true),
    sendInteractiveButtons: jest.fn().mockResolvedValue(true),
    sendInteractiveMessage: jest.fn().mockResolvedValue(true),
    startContinuousTypingIndicator: () => ({ stop: jest.fn() }),
  }));
  jest.doMock('../../bot/shared/database/bot-helpers', () => ({
    getOrCreateUser: jest.fn().mockResolvedValue({ id: 'u-1', phone_number: PHONE, preferred_language: 'en' }),
    getOrCreateUserByChannel: jest.fn(),
    getOrCreateSession: jest.fn().mockResolvedValue('sess-1'),
    trackChatStart: jest.fn().mockResolvedValue(undefined),
  }));
  jest.doMock('../../bot/shared/config/supabase', () => {
    const chain = () => {
      const b = {
        select: () => b, eq: () => b, neq: () => b, in: () => b, is: () => b, not: () => b, gte: () => b,
        order: () => b, limit: () => b, update: () => b, insert: () => b, upsert: () => b,
        single: () => Promise.resolve({ data: null, error: null }),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (resolve) => resolve({ data: [], error: null }),
      };
      return b;
    };
    return { from: jest.fn(() => chain()), rpc: jest.fn().mockResolvedValue({ error: null }) };
  });

  mocks = {
    offer: {
      enabled: jest.fn(() => true),
      handleOfferButton: jest.fn().mockResolvedValue(false),
      handleLanguageButton: jest.fn().mockResolvedValue(true),
      handleTypedLanguageChoice: jest.fn().mockResolvedValue(false),
    },
    text: { handleTextMessage: jest.fn().mockResolvedValue(undefined) },
    orchestrator: { continueWithClass: jest.fn().mockResolvedValue(undefined) },
    list: {
      MENU_CLASSIC: 'tq_pick_menu_classic',
      isQuizCommand: jest.fn(() => false),
      handleActionButton: jest.fn().mockResolvedValue(false),
      handleListPick: jest.fn().mockResolvedValue(true),
    },
    vq: {
      handleOfferButton: jest.fn().mockResolvedValue(false),
      handleAnswer: jest.fn().mockResolvedValue(false),
      answerTypedLetter: jest.fn().mockResolvedValue(false),
      stopTyped: jest.fn().mockResolvedValue(false),
    },
    share: { handleShareButton: jest.fn().mockResolvedValue(false), parseShareCode: () => null },
    invite: { handleInviteButton: jest.fn().mockResolvedValue(false) },
    binge: { handleMoreButton: jest.fn().mockResolvedValue(true) },
  };
  jest.doMock('../../bot/shared/services/quiz/transcript-quiz-offer.service', () => mocks.offer);
  jest.doMock('../../bot/shared/services/quiz/transcript-quiz-list.service', () => mocks.list);
  jest.doMock('../../bot/shared/services/quiz/video-quiz.service', () => mocks.vq);
  jest.doMock('../../bot/shared/services/quiz/video-quiz-share.service', () => mocks.share);
  jest.doMock('../../bot/shared/services/quiz/video-quiz-invite.service', () => mocks.invite);
  jest.doMock('../../bot/shared/services/quiz/video-quiz-binge.service', () => mocks.binge);
  jest.doMock('../../bot/shared/handlers/text-message.handler', () => mocks.text);
  jest.doMock('../../bot/shared/services/quiz/quiz-orchestrator.service', () => mocks.orchestrator);
}

let app;
beforeAll(() => {
  jest.resetModules();
  mockBoundary();
  ({ app } = require('../../bot/whatsapp-bot'));
});

beforeEach(() => {
  Object.values(mocks).forEach((m) => Object.values(m).forEach((fn) => fn.mockClear && fn.mockClear()));
});

describe('webhook → lesson-quiz buttons', () => {
  test('tq_lang_ reaches handleLanguageButton, never the generic tq_ handlers', async () => {
    await postWebhook(app, buttonBody(`tq_lang_en_${QID}`));
    await until(() => mocks.offer.handleLanguageButton.mock.calls.length);
    expect(mocks.offer.handleLanguageButton).toHaveBeenCalledWith(`tq_lang_en_${QID}`, PHONE, expect.objectContaining({ id: 'u-1' }));
    expect(mocks.offer.handleOfferButton).not.toHaveBeenCalled();
    expect(mocks.list.handleActionButton).not.toHaveBeenCalled();
  });

  test('a tq_lang_ code that is not en/ur (any configured quiz language) still routes there', async () => {
    await postWebhook(app, buttonBody(`tq_lang_fr_${QID}`));
    await until(() => mocks.offer.handleLanguageButton.mock.calls.length);
    expect(mocks.offer.handleLanguageButton).toHaveBeenCalledWith(`tq_lang_fr_${QID}`, PHONE, expect.anything());
  });

  test('tq_yes_ reaches the offer handler', async () => {
    mocks.offer.handleOfferButton.mockResolvedValueOnce(true);
    await postWebhook(app, buttonBody(`tq_yes_${QID}`));
    await until(() => mocks.offer.handleOfferButton.mock.calls.length);
    expect(mocks.offer.handleOfferButton).toHaveBeenCalledWith(`tq_yes_${QID}`, PHONE);
    expect(mocks.offer.handleLanguageButton).not.toHaveBeenCalled();
    expect(mocks.list.handleActionButton).not.toHaveBeenCalled();
  });

  test('a tq_ action the offer does not own falls through to the list (tq_link_)', async () => {
    mocks.list.handleActionButton.mockResolvedValueOnce(true);
    await postWebhook(app, buttonBody(`tq_link_${QID}`));
    await until(() => mocks.list.handleActionButton.mock.calls.length);
    expect(mocks.offer.handleOfferButton).toHaveBeenCalledWith(`tq_link_${QID}`, PHONE);
    expect(mocks.list.handleActionButton).toHaveBeenCalledWith(`tq_link_${QID}`, PHONE);
  });

  test('vq_more_ reaches the binge offer, before handleAnswer could take it as a wrong answer', async () => {
    await postWebhook(app, buttonBody('vq_more_yes_abc'));
    await until(() => mocks.binge.handleMoreButton.mock.calls.length);
    expect(mocks.binge.handleMoreButton).toHaveBeenCalledWith('vq_more_yes_abc', PHONE);
    expect(mocks.vq.handleAnswer).not.toHaveBeenCalled();
  });

  test('a vq_ answer still reaches handleAnswer when no offer handler claims it', async () => {
    mocks.binge.handleMoreButton.mockResolvedValueOnce(false);
    mocks.vq.handleAnswer.mockResolvedValueOnce(true);
    await postWebhook(app, buttonBody('vq_a_q1_B'));
    await until(() => mocks.vq.handleAnswer.mock.calls.length);
    expect(mocks.vq.handleAnswer).toHaveBeenCalledWith(PHONE, 'vq_a_q1_B');
  });
});

describe('webhook → lesson-quiz list rows', () => {
  test('a tq_pick_ row reaches TranscriptQuizList.handleListPick', async () => {
    await postWebhook(app, listBody(`tq_pick_${QID}`));
    await until(() => mocks.list.handleListPick.mock.calls.length);
    expect(mocks.list.handleListPick).toHaveBeenCalledWith(`tq_pick_${QID}`, PHONE, expect.objectContaining({ id: 'u-1' }));
  });

  test('the "older lessons" tq_page_ row reaches handleListPick too', async () => {
    await postWebhook(app, listBody('tq_page_2'));
    await until(() => mocks.list.handleListPick.mock.calls.length);
    expect(mocks.list.handleListPick).toHaveBeenCalledWith('tq_page_2', PHONE, expect.anything());
  });

  test('a vq_ answer picked from a list is answered AND the webhook is acknowledged (no hung request)', async () => {
    mocks.vq.handleAnswer.mockResolvedValueOnce(true);
    await postWebhook(app, listBody('vq_a_q1_D'));
    expect(mocks.vq.handleAnswer).toHaveBeenCalledWith(PHONE, 'vq_a_q1_D');
  }, 5000);
});

describe('webhook → the language ask as a list, or as numbered text (review F-S12)', () => {
  test('a tq_lang_ row picked from the list reaches handleLanguageButton', async () => {
    await postWebhook(app, listBody(`tq_lang_ar_${QID}`));
    await until(() => mocks.offer.handleLanguageButton.mock.calls.length);
    expect(mocks.offer.handleLanguageButton).toHaveBeenCalledWith(`tq_lang_ar_${QID}`, PHONE, expect.objectContaining({ id: 'u-1' }));
  });

  test('a typed number answering the numbered ask is taken by the offer, never by chat', async () => {
    mocks.offer.handleTypedLanguageChoice.mockResolvedValueOnce(true);
    await postWebhook(app, textBody('3'));
    await until(() => mocks.offer.handleTypedLanguageChoice.mock.calls.length);
    expect(mocks.offer.handleTypedLanguageChoice).toHaveBeenCalledWith(PHONE, '3', expect.objectContaining({ id: 'u-1' }));
    expect(mocks.text.handleTextMessage).not.toHaveBeenCalled();
  });

  test('any other text goes to the text handler as before', async () => {
    await postWebhook(app, textBody('hello'));
    await until(() => mocks.text.handleTextMessage.mock.calls.length);
    expect(mocks.text.handleTextMessage).toHaveBeenCalledWith(expect.anything(), PHONE, 'hello', expect.objectContaining({ id: 'u-1' }));
  });

  test('the check failing never costs the message: the text handler still runs', async () => {
    mocks.offer.handleTypedLanguageChoice.mockRejectedValueOnce(new Error('redis down'));
    await postWebhook(app, textBody('hello again'));
    await until(() => mocks.text.handleTextMessage.mock.calls.length);
    expect(mocks.text.handleTextMessage).toHaveBeenCalledWith(expect.anything(), PHONE, 'hello again', expect.anything());
  });
});

describe('webhook → small teacher-side routes (review F-N8)', () => {
  test('the classic-quiz row carries the chat session, never a null session key', async () => {
    await postWebhook(app, listBody('tq_pick_menu_classic'));
    await until(() => mocks.list.handleListPick.mock.calls.length);
    expect(mocks.list.handleListPick).toHaveBeenCalledWith('tq_pick_menu_classic', PHONE, expect.objectContaining({ id: 'u-1' }), { sessionId: 'sess-1' });
  });

  test('switched off (RUMI_FEATURE_LESSON_QUIZ=off): tq_ buttons and rows reach no lesson-quiz handler', async () => {
    mocks.offer.enabled.mockReturnValue(false);
    try {
      await postWebhook(app, buttonBody(`tq_yes_${QID}`));
      await postWebhook(app, buttonBody(`tq_lang_en_${QID}`));
      await postWebhook(app, buttonBody(`tq_link_${QID}`));
      await postWebhook(app, listBody(`tq_pick_${QID}`));
      await postWebhook(app, listBody(`tq_lang_ar_${QID}`));
      await new Promise((r) => setTimeout(r, 100));
      expect(mocks.offer.handleOfferButton).not.toHaveBeenCalled();
      expect(mocks.offer.handleLanguageButton).not.toHaveBeenCalled();
      expect(mocks.list.handleActionButton).not.toHaveBeenCalled();
      expect(mocks.list.handleListPick).not.toHaveBeenCalled();
    } finally {
      mocks.offer.enabled.mockReturnValue(true);
    }
  });
});

describe('webhook → the classic quiz class picker (review F-N12)', () => {
  /** POST and return the HTTP status, or 'hung' when nothing answers in time. */
  async function statusOf(body, ms = 1500) {
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(ms),
      });
      return res.status;
    } catch (err) {
      return 'hung';
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  }

  test('a quiz_class_ row continues the classic quiz AND acknowledges the webhook (no hung request, no redelivery)', async () => {
    const status = await statusOf(listBody('quiz_class_list-1'));
    expect(mocks.orchestrator.continueWithClass).toHaveBeenCalledWith(expect.objectContaining({ id: 'u-1' }), PHONE, 'list-1', expect.any(String));
    expect(status).toBe(200);
  });

  test('…and when continuing fails, still acknowledged', async () => {
    mocks.orchestrator.continueWithClass.mockRejectedValueOnce(new Error('redis down'));
    expect(await statusOf(listBody('quiz_class_list-2'))).toBe(200);
  });
});
