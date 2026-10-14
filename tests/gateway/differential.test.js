/**
 * tests/gateway/differential.test.js
 *
 * Webhook Ingestion Gateway Differential Verification Runner (Milestone 3).
 *
 * Proves ZERO BEHAVIORAL DIVERGENCE across all supported event types between:
 * 1. Legacy Ingress Pipeline (unmodified reference handlers matching pre-migration monolith)
 * 2. New Strangler Fig Modular Gateway Pipeline (bot/gateway/index.js & adapters)
 *
 * Dual Ephemeral Server Architecture:
 * - Runs both pipelines on independent ephemeral loopback HTTP servers (port 0 on 127.0.0.1)
 * - Guarantees full wire-level fidelity (raw body buffering, chunk encoding, header handling)
 * - Eliminates subpath routing side-effects by keeping identical URL paths on both servers
 *
 * Hermetic Isolation & Normalization:
 * - resetMockState() executed before every fixture run to prevent state leakage
 * - slack-events.adapter._resetSeenEventsForTests() invoked to prevent cache crosstalk
 * - Deep normalization engine captures [status, headers, body, dispatchCalls, serviceCalls, broadcastCalls]
 * - Verifies: expect(normalizedGateway).toEqual(normalizedLegacy)
 */

'use strict';

const crypto = require('crypto');
const http = require('http');
const express = require('express');

// =========================================================================
// 1. Environment Variables Configuration (before requiring bot modules)
// =========================================================================
const VERIFY_TOKEN = 'test_verify_token_differential_2026';
const PHONE_NUMBER_ID = '100000000000001';
const SENDER_PHONE = '923001234567';
const SLACK_SIGNING_SECRET = 'test_slack_signing_secret_differential_xyz';

process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.WEBHOOK_VERIFY_TOKEN = VERIFY_TOKEN;
process.env.PHONE_NUMBER_ID = PHONE_NUMBER_ID;
process.env.SLACK_SIGNING_SECRET = SLACK_SIGNING_SECRET;
process.env.SUPABASE_URL = 'https://test-project.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
process.env.OPENROUTER_API_KEY = 'sk-or-test-key';
delete process.env.REDIS_URL;

// =========================================================================
// 2. Offline Mocks for Hermetic Execution
// =========================================================================
jest.mock('../../bot/shared/utils/logger', () => ({
  logToFile: jest.fn(),
  LOGS_DIR: '/tmp/test-logs',
}));

const mockTypingController = { stop: jest.fn() };
const mockWhatsAppService = {
  sendReaction: jest.fn().mockResolvedValue({ success: true }),
  showTypingIndicator: jest.fn().mockResolvedValue({ success: true }),
  startContinuousTypingIndicator: jest.fn().mockReturnValue(mockTypingController),
  stopTypingIndicator: jest.fn().mockResolvedValue(undefined),
  sendMessage: jest.fn().mockResolvedValue({ success: true, messageId: 'mock_msg_id' }),
  sendVoiceMessage: jest.fn().mockResolvedValue({ success: true }),
  sendImage: jest.fn().mockResolvedValue({ success: true }),
  sendDocument: jest.fn().mockResolvedValue({ success: true }),
  sendInteractiveMessage: jest.fn().mockResolvedValue({ success: true }),
  sendButtonMessage: jest.fn().mockResolvedValue({ success: true }),
  sendListMessage: jest.fn().mockResolvedValue({ success: true }),
  sendImageWithButtons: jest.fn().mockResolvedValue({ success: true }),
  sendFlow: jest.fn().mockResolvedValue(true),
  downloadMedia: jest.fn().mockResolvedValue(Buffer.from('fake-media')),
  uploadMedia: jest.fn().mockResolvedValue({ id: 'mock_media_id' }),
  markAsRead: jest.fn().mockResolvedValue({ success: true }),
};
jest.mock('../../bot/shared/services/whatsapp.service', () => mockWhatsAppService);

const baseDuplicateIds = ['wamid.duplicate.001', 'wamid.DUPLICATE_SEEN_MSG_888'];
let duplicateSeenIds = new Set(baseDuplicateIds);

const mockSessionService = {
  isProcessed: jest.fn().mockImplementation((id) => Promise.resolve(duplicateSeenIds.has(id))),
  markAsProcessed: jest.fn().mockImplementation((id) => {
    duplicateSeenIds.add(id);
    return Promise.resolve();
  }),
  isFirstMessage: jest.fn().mockReturnValue(true),
  markFirstMessageReceived: jest.fn(),
  getReactionEmoji: jest.fn().mockReturnValue('❤️'),
  getStats: jest.fn().mockReturnValue({ processedMessagesCount: 0, usersWithFirstMessageCount: 0 }),
};
jest.mock('../../bot/shared/services/session.service', () => mockSessionService);

jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  setex: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  exists: jest.fn().mockResolvedValue(0),
  redis: null,
}));

const mockSupabaseQuery = {
  select: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  delete: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  neq: jest.fn().mockReturnThis(),
  in: jest.fn().mockReturnThis(),
  is: jest.fn().mockReturnThis(),
  gte: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  single: jest.fn().mockResolvedValue({ data: null, error: null }),
};
mockSupabaseQuery.then = (resolve) => resolve({ data: [], error: null });

jest.mock('../../bot/shared/config/supabase', () => ({
  from: jest.fn(() => mockSupabaseQuery),
  rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
}));

jest.mock('../../bot/shared/database/bot-helpers', () => ({
  getOrCreateUser: jest.fn().mockResolvedValue({
    id: 'test-user-uuid-1',
    phone_number: '923001234567',
    role: 'teacher',
    language: 'en',
    registration_completed: true,
  }),
  getOrCreateUserByChannel: jest.fn().mockResolvedValue({
    id: 'test-channel-user-uuid-2',
    phone_number: 'slack:U0123ABC',
    role: 'teacher',
    channel: 'slack',
    channel_user_id: 'U0123ABC',
    language: 'en',
    registration_completed: true,
  }),
  trackChatStart: jest.fn().mockResolvedValue(true),
  getOrCreateSession: jest.fn().mockResolvedValue('test-session-id-1'),
}));

const mockHandleTextMessage = jest.fn().mockResolvedValue(undefined);
jest.mock('../../bot/shared/handlers/text-message.handler', () => ({
  handleTextMessage: mockHandleTextMessage,
  parseStyleFromButtonId: jest.fn().mockReturnValue('fun'),
}));

jest.mock('../../bot/shared/handlers/voice-message.handler', () => ({
  handleVoiceMessage: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../bot/shared/handlers/image-message.handler', () => ({
  handleImageMessage: jest.fn().mockResolvedValue(undefined),
}));

const mockCoachingService = {
  handleConfirmation: jest.fn().mockResolvedValue(undefined),
  handleLessonPlanResponse: jest.fn().mockResolvedValue(undefined),
};
jest.mock('../../bot/shared/services/coaching-orchestrator.service', () => mockCoachingService);

const mockVideoQuizService = {
  handleAnswer: jest.fn().mockResolvedValue(true),
};
jest.mock('../../bot/shared/services/quiz/video-quiz.service', () => mockVideoQuizService);

jest.mock('../../bot/shared/services/messaging/slack-web-client', () => ({
  openView: jest.fn().mockResolvedValue({ ok: true }),
  pushView: jest.fn().mockResolvedValue({ ok: true }),
  updateView: jest.fn().mockResolvedValue({ ok: true }),
}));

// =========================================================================
// 3. Module Imports Under Test
// =========================================================================
const { setupGateway, createWhatsAppRouter } = require('../../bot/gateway');
const mountLegacySlackRoutes = require('../../bot/shared/routes/slack-interactions.routes');
const { _resetSeenEventsForTests } = require('../../bot/shared/services/messaging/inbound/slack-events.adapter');
const validators = require('../../bot/shared/utils/validators');
const constants = require('../../bot/shared/utils/constants');

// =========================================================================
// 4. Instrumented Pipeline Factories & Server Setup
// =========================================================================
const legacyDispatchCalls = [];
const gatewayDispatchCalls = [];
const legacyBroadcastCalls = [];
const gatewayBroadcastCalls = [];

function createRecordingDispatcher(callsArray) {
  return async function recordingDispatcher(req, res) {
    callsArray.push({
      method: req.method,
      baseUrl: req.baseUrl,
      path: req.path,
      headers: { ...(req.headers || {}) },
      body: JSON.parse(JSON.stringify(req.body || {})),
      rawBody: req.rawBody
        ? (Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : String(req.rawBody))
        : undefined,
      _gatewayHandled: req._gatewayHandled,
    });

    if (!res.headersSent) {
      if (req.method === 'POST' && (req.baseUrl || '').includes('slack')) {
        res.status(200).send('');
      } else {
        res.status(200).send('EVENT_RECEIVED');
      }
    }
  };
}

const legacyDispatcher = createRecordingDispatcher(legacyDispatchCalls);
const gatewayDispatcher = createRecordingDispatcher(gatewayDispatchCalls);

const legacyBroadcastHandler = async (statuses) => {
  legacyBroadcastCalls.push(statuses);
};

const gatewayBroadcastHandler = async (statuses) => {
  gatewayBroadcastCalls.push(statuses);
};

/**
 * Creates the Legacy Application Pipeline (Pre-Strangler Fig Monolith Ingress)
 */
function createLegacyApp() {
  const app = express();

  // 1. Legacy Slack Ingress: raw-body buffering mounted directly at /api/slack
  app.use('/api/slack', express.raw({ type: '*/*' }), (req, res, next) => {
    req.rawBody = req.body;
    next();
  });
  app.use('/api/slack', mountLegacySlackRoutes(legacyDispatcher));

  // 2. Global JSON parsing
  app.use(express.json());

  // 3. Legacy WhatsApp Verification (GET /webhook)
  app.get('/webhook', (req, res) => {
    const mode = req.query?.['hub.mode'];
    const token = req.query?.['hub.verify_token'];
    const challenge = req.query?.['hub.challenge'];
    if (mode === 'subscribe' && token === (process.env.WEBHOOK_VERIFY_TOKEN || constants.WEBHOOK_VERIFY_TOKEN)) {
      res.status(200).send(challenge);
    } else {
      res.status(403).send('Forbidden');
    }
  });

  // 4. Legacy WhatsApp Ingestion (POST /webhook)
  app.post('/webhook', async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || !Array.isArray(req.body.entry) || req.body.entry.length === 0) {
      return res.status(200).send('EVENT_RECEIVED');
    }

    const statusValidation = validators.validateWebhookStatus(req);
    if (statusValidation) {
      await legacyBroadcastHandler(statusValidation.statuses);
      return res.status(200).send('EVENT_RECEIVED');
    }

    const validation = validators.validateWebhookMessage(req);
    if (!validation) {
      return res.status(200).send('EVENT_RECEIVED');
    }

    const { entry, message, from, messageType, messageTimestamp, phoneNumberId } = validation;
    if (!validators.isOurPhoneNumber(phoneNumberId)) {
      return res.status(200).send('EVENT_RECEIVED');
    }

    if (validators.isTestWebhook(entry)) {
      return res.status(200).send('EVENT_RECEIVED');
    }

    if (validators.isTestPhoneNumber(from)) {
      return res.status(200).send('EVENT_RECEIVED');
    }

    if (!validators.isWithin24Hours(messageTimestamp, from)) {
      return res.status(200).send('EVENT_RECEIVED');
    }

    const alreadyProcessed = await mockSessionService.isProcessed(message.id);
    if (alreadyProcessed) {
      return res.status(200).send('EVENT_RECEIVED');
    }

    await mockSessionService.markAsProcessed(message.id);
    const emoji = mockSessionService.getReactionEmoji(from);
    await mockWhatsAppService.sendReaction(from, message.id, emoji);
    await mockWhatsAppService.showTypingIndicator(from, message.id);

    await legacyDispatcher(req, res);
    if (!res.headersSent) {
      res.status(200).send('EVENT_RECEIVED');
    }
  });

  return app;
}

/**
 * Creates the Gateway Application Pipeline (Strangler Fig Modular Ingress)
 */
function createGatewayApp() {
  const app = express();

  setupGateway(app, {
    dispatch: gatewayDispatcher,
    verifyToken: VERIFY_TOKEN,
    signingSecret: SLACK_SIGNING_SECRET,
    whatsappConfig: {
      handleBroadcastStatus: gatewayBroadcastHandler,
      sessionService: mockSessionService,
      whatsAppService: mockWhatsAppService,
      validatorsUtil: validators,
      encapsulateIngress: true,
    },
  });

  app.use(express.json());
  return app;
}

// =========================================================================
// 5. Normalization Engine & Deep Equality Assertions
// =========================================================================
function resetMockState() {
  jest.clearAllMocks();
  duplicateSeenIds = new Set(baseDuplicateIds);
  legacyDispatchCalls.length = 0;
  gatewayDispatchCalls.length = 0;
  legacyBroadcastCalls.length = 0;
  gatewayBroadcastCalls.length = 0;

  if (typeof _resetSeenEventsForTests === 'function') {
    _resetSeenEventsForTests();
  }

  mockSessionService.isProcessed.mockImplementation((id) => Promise.resolve(duplicateSeenIds.has(id)));
  mockSessionService.markAsProcessed.mockImplementation((id) => {
    duplicateSeenIds.add(id);
    return Promise.resolve();
  });
  mockSessionService.getReactionEmoji.mockReturnValue('❤️');
  mockWhatsAppService.sendReaction.mockResolvedValue({ success: true });
  mockWhatsAppService.showTypingIndicator.mockResolvedValue({ success: true });
  mockHandleTextMessage.mockResolvedValue(undefined);
  mockCoachingService.handleConfirmation.mockResolvedValue(undefined);
  mockVideoQuizService.handleAnswer.mockResolvedValue(true);
}

function collectServiceCalls() {
  return {
    isProcessed: mockSessionService.isProcessed.mock.calls,
    markAsProcessed: mockSessionService.markAsProcessed.mock.calls,
    sendReaction: mockWhatsAppService.sendReaction.mock.calls,
    showTypingIndicator: mockWhatsAppService.showTypingIndicator.mock.calls,
  };
}

function normalizeResult(raw) {
  if (!raw) return raw;

  // Clean headers: keep only semantic headers (lowercase)
  const cleanHeaders = {};
  if (raw.headers && typeof raw.headers === 'object') {
    if (raw.headers['content-type']) {
      cleanHeaders['content-type'] = raw.headers['content-type'].toLowerCase().replace(/\s*;\s*/g, '; ');
    }
  }

  const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const correlationRegex = /c-[0-9a-zA-Z_-]+/g;
  const slashIdRegex = /^slash-\d+-(.+)$/;

  function deepNormalize(val, key = '') {
    if (typeof val === 'string') {
      let str = val.replace(uuidRegex, '<UUID>').replace(correlationRegex, '<CORRELATION_ID>');
      const slashMatch = str.match(slashIdRegex);
      if (slashMatch) {
        return `slash-<TIMESTAMP>-${slashMatch[1]}`;
      }
      return str;
    }
    if (typeof val === 'number') {
      if (key === 'timestamp' && val > 1700000000) {
        return '<TIMESTAMP>';
      }
      return val;
    }
    if (Array.isArray(val)) {
      return val.map((item) => deepNormalize(item, key));
    }
    if (val && typeof val === 'object') {
      const result = {};
      for (const [k, v] of Object.entries(val)) {
        if (k === '_gatewayHandled' || k === '_deduplicated' || k === '_reacted' || k === 'host' || k === 'date') {
          continue;
        }
        result[k] = deepNormalize(v, k);
      }
      return result;
    }
    return val;
  }

  const normalizedDispatchCalls = (raw.dispatchCalls || []).map((call) => ({
    body: deepNormalize(call.body),
  }));

  let normalizedBody = raw.body;
  if (typeof raw.body === 'string') {
    if (raw.body.includes('Cannot POST /api/slack')) {
      normalizedBody = 'Cannot POST /api/slack';
    } else {
      try {
        normalizedBody = JSON.parse(raw.body);
      } catch {
        normalizedBody = raw.body;
      }
    }
  }
  normalizedBody = deepNormalize(normalizedBody);

  return {
    status: raw.status,
    headers: cleanHeaders,
    body: normalizedBody,
    dispatchCalls: normalizedDispatchCalls,
    serviceCalls: deepNormalize(raw.serviceCalls),
    broadcastCalls: deepNormalize(raw.broadcastCalls),
  };
}

async function executePipeline(baseUrl, fixture, dispatchCallsArray, broadcastCallsArray) {
  const url = `${baseUrl}${fixture.path}`;
  const headers = {
    Connection: 'close',
    ...(fixture.headers || {}),
  };

  let body = fixture.body;
  if (body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body)) {
    body = JSON.stringify(body);
    if (!headers['content-type'] && !headers['Content-Type']) {
      headers['content-type'] = 'application/json';
    }
  }

  const options = {
    method: fixture.method || 'GET',
    headers,
  };
  if (body !== undefined) {
    options.body = body;
  }

  const res = await fetch(url, options);
  const text = await res.text();
  let parsedBody;
  try {
    parsedBody = JSON.parse(text);
  } catch {
    parsedBody = text;
  }

  const responseHeaders = {};
  res.headers.forEach((val, key) => {
    responseHeaders[key.toLowerCase()] = val;
  });

  return {
    status: res.status,
    headers: responseHeaders,
    body: parsedBody,
    dispatchCalls: [...dispatchCallsArray],
    serviceCalls: collectServiceCalls(),
    broadcastCalls: [...broadcastCallsArray],
  };
}

// =========================================================================
// 6. Signature & Payload Helper Functions
// =========================================================================
function signSlackRequest(timestamp, rawBody, secret = SLACK_SIGNING_SECRET) {
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '');
  const base = `v0:${timestamp}:${body}`;
  return 'v0=' + crypto.createHmac('sha256', secret).update(base, 'utf8').digest('hex');
}

function buildWhatsAppEnvelope(messageObj, statusesObj = null) {
  const value = {
    messaging_product: 'whatsapp',
    metadata: {
      display_phone_number: '15550001111',
      phone_number_id: PHONE_NUMBER_ID,
    },
  };
  if (messageObj) {
    value.contacts = [{ profile: { name: 'Amina Khan' }, wa_id: messageObj.from || SENDER_PHONE }];
    value.messages = [messageObj];
  }
  if (statusesObj) {
    value.statuses = statusesObj;
  }
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '109876543210987',
        changes: [
          {
            field: 'messages',
            value,
          },
        ],
      },
    ],
  };
}

// =========================================================================
// 7. Differential Verification Test Suite
// =========================================================================
describe('Webhook Ingestion Gateway Differential Verification Runner', () => {
  let legacyServer;
  let gatewayServer;
  let legacyBaseUrl;
  let gatewayBaseUrl;

  beforeAll((done) => {
    const legacyApp = createLegacyApp();
    const gatewayApp = createGatewayApp();

    let serversStarted = 0;
    const checkDone = () => {
      serversStarted++;
      if (serversStarted === 2) done();
    };

    legacyServer = http.createServer(legacyApp);
    legacyServer.listen(0, '127.0.0.1', () => {
      const port = legacyServer.address().port;
      legacyBaseUrl = `http://127.0.0.1:${port}`;
      checkDone();
    });

    gatewayServer = http.createServer(gatewayApp);
    gatewayServer.listen(0, '127.0.0.1', () => {
      const port = gatewayServer.address().port;
      gatewayBaseUrl = `http://127.0.0.1:${port}`;
      checkDone();
    });
  });

  afterAll((done) => {
    let serversClosed = 0;
    const checkClosed = () => {
      serversClosed++;
      if (serversClosed === 2) done();
    };

    if (legacyServer) legacyServer.close(checkClosed);
    else checkClosed();

    if (gatewayServer) gatewayServer.close(checkClosed);
    else checkClosed();
  });

  /**
   * Helper that executes the fixture sequentially against Legacy then Gateway,
   * normalizes both outputs, and asserts 0 divergence.
   */
  async function runDifferentialTest(fixture) {
    // 1. Run Legacy
    resetMockState();
    if (fixture.setupMocks) fixture.setupMocks();
    const legacyRaw = await executePipeline(legacyBaseUrl, fixture, legacyDispatchCalls, legacyBroadcastCalls);

    // 2. Run Gateway
    resetMockState();
    if (fixture.setupMocks) fixture.setupMocks();
    const gatewayRaw = await executePipeline(gatewayBaseUrl, fixture, gatewayDispatchCalls, gatewayBroadcastCalls);

    // 3. Normalize
    const normalizedLegacy = normalizeResult(legacyRaw);
    const normalizedGateway = normalizeResult(gatewayRaw);

    // 4. Assert zero divergence between gateway and legacy
    expect(normalizedGateway).toEqual(normalizedLegacy);

    // 5. Semantic validity assertions
    if (fixture.expectedStatus !== undefined) {
      expect(normalizedLegacy.status).toBe(fixture.expectedStatus);
    }
    if (fixture.expectedBody !== undefined) {
      if (typeof fixture.expectedBody === 'object' && !(fixture.expectedBody instanceof RegExp)) {
        expect(normalizedLegacy.body).toEqual(fixture.expectedBody);
      } else if (fixture.expectedBody instanceof RegExp) {
        expect(String(normalizedLegacy.body)).toMatch(fixture.expectedBody);
      } else {
        expect(normalizedLegacy.body).toBe(fixture.expectedBody);
      }
    }

    return { legacy: normalizedLegacy, gateway: normalizedGateway };
  }

  // =======================================================================
  // Category 1: WhatsApp GET /webhook (Meta Verification Handshake)
  // =======================================================================
  describe('WhatsApp GET /webhook (Meta Verification Handshake)', () => {
    it('WA-GET-01: Valid challenge handshake returns 200 and challenge string', async () => {
      const challenge = 'challenge_token_valid_991';
      await runDifferentialTest({
        path: `/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=${challenge}`,
        method: 'GET',
        expectedStatus: 200,
        expectedBody: challenge,
      });
    });

    it('WA-GET-02: Invalid verify token returns 403 Forbidden', async () => {
      await runDifferentialTest({
        path: `/webhook?hub.mode=subscribe&hub.verify_token=wrong_token_mismatch&hub.challenge=challenge_123`,
        method: 'GET',
        expectedStatus: 403,
        expectedBody: 'Forbidden',
      });
    });

    it('WA-GET-03: Missing hub.mode returns 403 Forbidden', async () => {
      await runDifferentialTest({
        path: `/webhook?hub.verify_token=${VERIFY_TOKEN}&hub.challenge=challenge_123`,
        method: 'GET',
        expectedStatus: 403,
        expectedBody: 'Forbidden',
      });
    });

    it('WA-GET-04: Missing hub.verify_token returns 403 Forbidden', async () => {
      await runDifferentialTest({
        path: `/webhook?hub.mode=subscribe&hub.challenge=challenge_123`,
        method: 'GET',
        expectedStatus: 403,
        expectedBody: 'Forbidden',
      });
    });

    it('WA-GET-05: Empty query string returns 403 Forbidden', async () => {
      await runDifferentialTest({
        path: '/webhook',
        method: 'GET',
        expectedStatus: 403,
        expectedBody: 'Forbidden',
      });
    });

    it('WA-GET-06: hub.mode not subscribe (e.g. publish) returns 403 Forbidden', async () => {
      await runDifferentialTest({
        path: `/webhook?hub.mode=publish&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=challenge_123`,
        method: 'GET',
        expectedStatus: 403,
        expectedBody: 'Forbidden',
      });
    });
  });

  // =======================================================================
  // Category 2: WhatsApp POST /webhook (Inbound Messages, Statuses & Envelope Edge Cases)
  // =======================================================================
  describe('WhatsApp POST /webhook (Inbound Messages, Statuses & Envelope Edge Cases)', () => {
    it('WA-POST-01: Inbound plain text message returns 200 and dispatches message with side-effects', async () => {
      const payload = buildWhatsAppEnvelope({
        from: SENDER_PHONE,
        id: 'wamid.TXT_001',
        timestamp: Math.floor(Date.now() / 1000).toString(),
        type: 'text',
        text: { body: 'Hello Rumi, plan Grade 5 math lesson' },
      });

      const { legacy } = await runDifferentialTest({
        path: '/webhook',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        expectedStatus: 200,
        expectedBody: 'EVENT_RECEIVED',
      });

      // Verify side-effects occurred identically
      expect(legacy.serviceCalls.isProcessed).toEqual([['wamid.TXT_001']]);
      expect(legacy.serviceCalls.markAsProcessed).toEqual([['wamid.TXT_001']]);
      expect(legacy.serviceCalls.sendReaction).toEqual([[SENDER_PHONE, 'wamid.TXT_001', '❤️']]);
      expect(legacy.serviceCalls.showTypingIndicator).toEqual([[SENDER_PHONE, 'wamid.TXT_001']]);
      expect(legacy.dispatchCalls.length).toBe(1);
    });

    it('WA-POST-02: Interactive button reply returns 200 and dispatches button action', async () => {
      const payload = buildWhatsAppEnvelope({
        from: SENDER_PHONE,
        id: 'wamid.BTN_002',
        timestamp: Math.floor(Date.now() / 1000).toString(),
        type: 'interactive',
        interactive: {
          type: 'button_reply',
          button_reply: { id: 'coaching_confirm_session_999', title: 'Yes, continue' },
        },
      });

      const { legacy } = await runDifferentialTest({
        path: '/webhook',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        expectedStatus: 200,
        expectedBody: 'EVENT_RECEIVED',
      });

      expect(legacy.serviceCalls.isProcessed).toEqual([['wamid.BTN_002']]);
      expect(legacy.serviceCalls.markAsProcessed).toEqual([['wamid.BTN_002']]);
      expect(legacy.dispatchCalls.length).toBe(1);
    });

    it('WA-POST-03: Interactive list reply returns 200 and dispatches list selection', async () => {
      const payload = buildWhatsAppEnvelope({
        from: SENDER_PHONE,
        id: 'wamid.LIST_003',
        timestamp: Math.floor(Date.now() / 1000).toString(),
        type: 'interactive',
        interactive: {
          type: 'list_reply',
          list_reply: { id: 'lang_ur', title: 'Urdu', description: 'اردو' },
        },
      });

      const { legacy } = await runDifferentialTest({
        path: '/webhook',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        expectedStatus: 200,
        expectedBody: 'EVENT_RECEIVED',
      });

      expect(legacy.serviceCalls.isProcessed).toEqual([['wamid.LIST_003']]);
      expect(legacy.dispatchCalls.length).toBe(1);
    });

    it('WA-POST-04: Broadcast status receipt (delivered) calls broadcast handler without message dispatch', async () => {
      const statusPayload = [{
        id: 'wamid.OUT_777',
        status: 'delivered',
        timestamp: Math.floor(Date.now() / 1000).toString(),
        recipient_id: SENDER_PHONE,
      }];
      const payload = buildWhatsAppEnvelope(null, statusPayload);

      const { legacy } = await runDifferentialTest({
        path: '/webhook',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        expectedStatus: 200,
        expectedBody: 'EVENT_RECEIVED',
      });

      expect(legacy.broadcastCalls.length).toBe(1);
      expect(legacy.broadcastCalls[0]).toEqual(statusPayload);
      expect(legacy.dispatchCalls.length).toBe(0);
      expect(legacy.serviceCalls.sendReaction.length).toBe(0);
    });

    it('WA-POST-05: Duplicate message suppression skips mark, reactions, and dispatch', async () => {
      const duplicateMsgId = 'wamid.DUP_SEEN_888';
      const payload = buildWhatsAppEnvelope({
        from: SENDER_PHONE,
        id: duplicateMsgId,
        timestamp: Math.floor(Date.now() / 1000).toString(),
        type: 'text',
        text: { body: 'Duplicate delivery' },
      });

      const { legacy } = await runDifferentialTest({
        path: '/webhook',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        setupMocks: () => {
          duplicateSeenIds.add(duplicateMsgId);
        },
        expectedStatus: 200,
        expectedBody: 'EVENT_RECEIVED',
      });

      expect(legacy.serviceCalls.isProcessed).toEqual([[duplicateMsgId]]);
      expect(legacy.serviceCalls.markAsProcessed.length).toBe(0);
      expect(legacy.serviceCalls.sendReaction.length).toBe(0);
      expect(legacy.serviceCalls.showTypingIndicator.length).toBe(0);
      expect(legacy.dispatchCalls.length).toBe(0);
    });

    it('WA-POST-06: Unhandled message type (sticker) returns 200 and passes through gracefully', async () => {
      const payload = buildWhatsAppEnvelope({
        from: SENDER_PHONE,
        id: 'wamid.STK_999',
        timestamp: Math.floor(Date.now() / 1000).toString(),
        type: 'sticker',
        sticker: { id: 'sticker_id_123', mime_type: 'image/webp' },
      });

      const { legacy } = await runDifferentialTest({
        path: '/webhook',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        expectedStatus: 200,
        expectedBody: 'EVENT_RECEIVED',
      });

      expect(legacy.serviceCalls.isProcessed).toEqual([['wamid.STK_999']]);
      expect(legacy.dispatchCalls.length).toBe(1);
    });

    it('WA-POST-07: Empty request body {} returns 200 without dispatch or side-effects', async () => {
      const { legacy } = await runDifferentialTest({
        path: '/webhook',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {},
        expectedStatus: 200,
        expectedBody: 'EVENT_RECEIVED',
      });

      expect(legacy.dispatchCalls.length).toBe(0);
      expect(legacy.serviceCalls.isProcessed.length).toBe(0);
    });

    it('WA-POST-08: Malformed envelope (empty entry array) returns 200 without dispatch', async () => {
      const { legacy } = await runDifferentialTest({
        path: '/webhook',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { object: 'whatsapp_business_account', entry: [] },
        expectedStatus: 200,
        expectedBody: 'EVENT_RECEIVED',
      });

      expect(legacy.dispatchCalls.length).toBe(0);
      expect(legacy.serviceCalls.isProcessed.length).toBe(0);
    });

    it('WA-POST-09: Cross-WABA phone number filtering drops message without dispatch', async () => {
      const envelope = buildWhatsAppEnvelope({
        from: SENDER_PHONE,
        id: 'wamid.CROSS_WABA_001',
        timestamp: Math.floor(Date.now() / 1000).toString(),
        type: 'text',
        text: { body: 'Different WABA message' },
      });
      envelope.entry[0].changes[0].value.metadata.phone_number_id = '999999999999999';

      const { legacy } = await runDifferentialTest({
        path: '/webhook',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: envelope,
        expectedStatus: 200,
        expectedBody: 'EVENT_RECEIVED',
      });

      expect(legacy.dispatchCalls.length).toBe(0);
      expect(legacy.serviceCalls.isProcessed.length).toBe(0);
    });

    it('WA-POST-10: Test webhook filtering (entry id 0) drops message without dispatch', async () => {
      const envelope = buildWhatsAppEnvelope({
        from: SENDER_PHONE,
        id: 'wamid.TEST_ENTRY_001',
        timestamp: Math.floor(Date.now() / 1000).toString(),
        type: 'text',
        text: { body: 'Test webhook payload' },
      });
      envelope.entry[0].id = '0';

      const { legacy } = await runDifferentialTest({
        path: '/webhook',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: envelope,
        expectedStatus: 200,
        expectedBody: 'EVENT_RECEIVED',
      });

      expect(legacy.dispatchCalls.length).toBe(0);
      expect(legacy.serviceCalls.isProcessed.length).toBe(0);
    });

    it('WA-POST-11: Test phone number filtering drops message without dispatch', async () => {
      const envelope = buildWhatsAppEnvelope({
        from: '16315551181',
        id: 'wamid.TEST_PHONE_001',
        timestamp: Math.floor(Date.now() / 1000).toString(),
        type: 'text',
        text: { body: 'From test phone number' },
      });

      const { legacy } = await runDifferentialTest({
        path: '/webhook',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: envelope,
        expectedStatus: 200,
        expectedBody: 'EVENT_RECEIVED',
      });

      expect(legacy.dispatchCalls.length).toBe(0);
      expect(legacy.serviceCalls.isProcessed.length).toBe(0);
    });

    it('WA-POST-12: Stale message window filtering (> 24 hours) drops message without dispatch', async () => {
      const staleTimestamp = (Math.floor(Date.now() / 1000) - (25 * 3600)).toString();
      const envelope = buildWhatsAppEnvelope({
        from: SENDER_PHONE,
        id: 'wamid.STALE_001',
        timestamp: staleTimestamp,
        type: 'text',
        text: { body: 'Old message' },
      });

      const { legacy } = await runDifferentialTest({
        path: '/webhook',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: envelope,
        expectedStatus: 200,
        expectedBody: 'EVENT_RECEIVED',
      });

      expect(legacy.dispatchCalls.length).toBe(0);
      expect(legacy.serviceCalls.isProcessed.length).toBe(0);
    });
  });

  // =======================================================================
  // Category 3: Slack POST /api/slack/events (URL Verification, Events API & Clock Skew)
  // =======================================================================
  describe('Slack POST /api/slack/events (URL Verification, Events API & Clock Skew)', () => {
    it('SLACK-EVT-01: url_verification challenge handshake with valid HMAC returns 200 and challenge echo', async () => {
      const challengeToken = 'challenge_evt_token_001';
      const rawBody = JSON.stringify({
        type: 'url_verification',
        token: 'slack-token',
        challenge: challengeToken,
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = signSlackRequest(timestamp, rawBody);

      await runDifferentialTest({
        path: '/api/slack/events',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
        body: rawBody,
        expectedStatus: 200,
        expectedBody: { challenge: challengeToken },
      });
    });

    it('SLACK-EVT-02: event_callback message event with valid HMAC returns 200 empty body and dispatches synthetic Meta request', async () => {
      const rawBody = JSON.stringify({
        type: 'event_callback',
        event_id: 'Ev-diff-002',
        event_time: Math.floor(Date.now() / 1000),
        event: {
          type: 'message',
          user: 'U0123ABC',
          text: 'Hello Rumi from Slack',
          ts: '1710000000.000100',
          channel: 'C0123ABC',
        },
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = signSlackRequest(timestamp, rawBody);

      const { legacy } = await runDifferentialTest({
        path: '/api/slack/events',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
        body: rawBody,
        expectedStatus: 200,
        expectedBody: '',
      });

      expect(legacy.dispatchCalls.length).toBe(1);
      const dispatchedMsg = legacy.dispatchCalls[0].body.entry[0].changes[0].value.messages[0];
      expect(dispatchedMsg.from).toBe('slack:U0123ABC');
      expect(dispatchedMsg.text.body).toBe('Hello Rumi from Slack');
    });

    it('SLACK-EVT-03: Invalid HMAC signature returns 401 Invalid signature', async () => {
      const rawBody = JSON.stringify({
        type: 'url_verification',
        challenge: 'forged_challenge',
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const invalidSignature = 'v0=' + '0'.repeat(64);

      await runDifferentialTest({
        path: '/api/slack/events',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': invalidSignature,
        },
        body: rawBody,
        expectedStatus: 401,
        expectedBody: 'Invalid signature',
      });
    });

    it('SLACK-EVT-04: Expired timestamp (> 300s skew) returns 401 Invalid signature', async () => {
      const rawBody = JSON.stringify({
        type: 'url_verification',
        challenge: 'expired_challenge',
      });
      const expiredTimestamp = String(Math.floor(Date.now() / 1000) - 350);
      const signature = signSlackRequest(expiredTimestamp, rawBody);

      await runDifferentialTest({
        path: '/api/slack/events',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': expiredTimestamp,
          'x-slack-signature': signature,
        },
        body: rawBody,
        expectedStatus: 401,
        expectedBody: 'Invalid signature',
      });
    });

    it('SLACK-EVT-05: Symmetric skew boundary: Past within-window (now - 299s) returns 200', async () => {
      const challenge = 'skew_past_within_299';
      const rawBody = JSON.stringify({
        type: 'url_verification',
        challenge,
      });
      const timestamp = String(Math.floor(Date.now() / 1000) - 299);
      const signature = signSlackRequest(timestamp, rawBody);

      await runDifferentialTest({
        path: '/api/slack/events',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
        body: rawBody,
        expectedStatus: 200,
        expectedBody: { challenge },
      });
    });

    it('SLACK-EVT-06: Symmetric skew boundary: Future within-window (now + 299s) returns 200', async () => {
      const challenge = 'skew_future_within_299';
      const rawBody = JSON.stringify({
        type: 'url_verification',
        challenge,
      });
      const timestamp = String(Math.floor(Date.now() / 1000) + 299);
      const signature = signSlackRequest(timestamp, rawBody);

      await runDifferentialTest({
        path: '/api/slack/events',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
        body: rawBody,
        expectedStatus: 200,
        expectedBody: { challenge },
      });
    });

    it('SLACK-EVT-07: Symmetric skew boundary: Past outside-window (now - 301s) returns 401 Invalid signature', async () => {
      const rawBody = JSON.stringify({
        type: 'url_verification',
        challenge: 'skew_past_outside_301',
      });
      const timestamp = String(Math.floor(Date.now() / 1000) - 301);
      const signature = signSlackRequest(timestamp, rawBody);

      await runDifferentialTest({
        path: '/api/slack/events',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
        body: rawBody,
        expectedStatus: 401,
        expectedBody: 'Invalid signature',
      });
    });

    it('SLACK-EVT-08: Symmetric skew boundary: Future outside-window (now + 301s) returns 401 Invalid signature', async () => {
      const rawBody = JSON.stringify({
        type: 'url_verification',
        challenge: 'skew_future_outside_301',
      });
      const timestamp = String(Math.floor(Date.now() / 1000) + 301);
      const signature = signSlackRequest(timestamp, rawBody);

      await runDifferentialTest({
        path: '/api/slack/events',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
        body: rawBody,
        expectedStatus: 401,
        expectedBody: 'Invalid signature',
      });
    });

    it('SLACK-EVT-09: Request missing x-slack-signature header returns 401 Invalid signature', async () => {
      const rawBody = JSON.stringify({
        type: 'url_verification',
        challenge: 'missing_sig',
      });
      const timestamp = String(Math.floor(Date.now() / 1000));

      await runDifferentialTest({
        path: '/api/slack/events',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': timestamp,
        },
        body: rawBody,
        expectedStatus: 401,
        expectedBody: 'Invalid signature',
      });
    });

    it('SLACK-EVT-10: Request missing x-slack-request-timestamp header returns 401 Invalid signature', async () => {
      const rawBody = JSON.stringify({
        type: 'url_verification',
        challenge: 'missing_ts',
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = signSlackRequest(timestamp, rawBody);

      await runDifferentialTest({
        path: '/api/slack/events',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-signature': signature,
        },
        body: rawBody,
        expectedStatus: 401,
        expectedBody: 'Invalid signature',
      });
    });

    it('SLACK-EVT-11: Malformed JSON body with valid HMAC returns 400 Bad request body', async () => {
      const rawBody = '{invalid_json_stream';
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = signSlackRequest(timestamp, rawBody);

      await runDifferentialTest({
        path: '/api/slack/events',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
        body: rawBody,
        expectedStatus: 400,
        expectedBody: 'Bad request body',
      });
    });
  });

  // =======================================================================
  // Category 4: Slack POST /api/slack/interactions (Block Kit & Malformed Envelopes)
  // =======================================================================
  describe('Slack POST /api/slack/interactions (Block Kit & Malformed Envelopes)', () => {
    it('SLACK-INT-01: Block Kit button click interaction with valid HMAC returns 200 and dispatches interactive button reply', async () => {
      const payloadObj = {
        type: 'block_actions',
        user: { id: 'U0123ABC' },
        container: { message_ts: '1710000000.000100' },
        actions: [
          {
            type: 'button',
            action_id: 'menu_video_btn',
            value: 'menu_video',
            text: { type: 'plain_text', text: 'Watch Video' },
          },
        ],
      };
      const rawBody = `payload=${encodeURIComponent(JSON.stringify(payloadObj))}`;
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = signSlackRequest(timestamp, rawBody);

      const { legacy } = await runDifferentialTest({
        path: '/api/slack/interactions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
        body: rawBody,
        expectedStatus: 200,
        expectedBody: '',
      });

      expect(legacy.dispatchCalls.length).toBe(1);
      const dispatchedMsg = legacy.dispatchCalls[0].body.entry[0].changes[0].value.messages[0];
      expect(dispatchedMsg.from).toBe('slack:U0123ABC');
      expect(dispatchedMsg.type).toBe('interactive');
      expect(dispatchedMsg.interactive.type).toBe('button_reply');
      expect(dispatchedMsg.interactive.button_reply.id).toBe('menu_video');
    });

    it('SLACK-INT-02: Malformed JSON payload (payload=%7Bbadjson) returns 400 Bad payload', async () => {
      const rawBody = 'payload=%7Bbadjson';
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = signSlackRequest(timestamp, rawBody);

      await runDifferentialTest({
        path: '/api/slack/interactions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
        body: rawBody,
        expectedStatus: 400,
        expectedBody: 'Bad payload',
      });
    });

    it('SLACK-INT-03: Invalid HMAC signature on interactions returns 401 Invalid signature', async () => {
      const rawBody = `payload=${encodeURIComponent(JSON.stringify({ type: 'block_actions' }))}`;
      const timestamp = String(Math.floor(Date.now() / 1000));
      const invalidSignature = 'v0=' + 'f'.repeat(64);

      await runDifferentialTest({
        path: '/api/slack/interactions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': invalidSignature,
        },
        body: rawBody,
        expectedStatus: 401,
        expectedBody: 'Invalid signature',
      });
    });
  });

  // =======================================================================
  // Category 5: Slack POST /api/slack/commands (Slash Commands)
  // =======================================================================
  describe('Slack POST /api/slack/commands (Slash Commands)', () => {
    it('SLACK-CMD-01: Slash command (/readingtest) with valid HMAC returns 200 and dispatches synthetic text message', async () => {
      const params = new URLSearchParams({
        command: '/readingtest',
        text: '',
        user_id: 'U0123COMMANDER',
        channel_id: 'C0123CHANNEL',
        team_id: 'T0123TEAM',
      });
      const rawBody = params.toString();
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = signSlackRequest(timestamp, rawBody);

      const { legacy } = await runDifferentialTest({
        path: '/api/slack/commands',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
        body: rawBody,
        expectedStatus: 200,
        expectedBody: '',
      });

      expect(legacy.dispatchCalls.length).toBe(1);
      const dispatchedMsg = legacy.dispatchCalls[0].body.entry[0].changes[0].value.messages[0];
      expect(dispatchedMsg.from).toBe('slack:U0123COMMANDER');
      expect(dispatchedMsg.text.body).toBe('/readingtest');
      expect(dispatchedMsg.id).toMatch(/^slash-/);
    });

    it('SLACK-CMD-02: Slash command (/quiz fractions grade 5) with valid HMAC returns 200 and dispatches command with args', async () => {
      const params = new URLSearchParams({
        command: '/quiz',
        text: 'fractions grade 5',
        user_id: 'U0123COMMANDER',
        channel_id: 'C0123CHANNEL',
        team_id: 'T0123TEAM',
      });
      const rawBody = params.toString();
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = signSlackRequest(timestamp, rawBody);

      const { legacy } = await runDifferentialTest({
        path: '/api/slack/commands',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
        body: rawBody,
        expectedStatus: 200,
        expectedBody: '',
      });

      expect(legacy.dispatchCalls.length).toBe(1);
      const dispatchedMsg = legacy.dispatchCalls[0].body.entry[0].changes[0].value.messages[0];
      expect(dispatchedMsg.from).toBe('slack:U0123COMMANDER');
      expect(dispatchedMsg.text.body).toBe('/quiz fractions grade 5');
    });

    it('SLACK-CMD-03: Invalid HMAC signature on slash command returns 401 Invalid signature', async () => {
      const params = new URLSearchParams({
        command: '/readingtest',
        user_id: 'U0123COMMANDER',
      });
      const rawBody = params.toString();
      const timestamp = String(Math.floor(Date.now() / 1000));
      const invalidSignature = 'v0=' + '0'.repeat(64);

      await runDifferentialTest({
        path: '/api/slack/commands',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': invalidSignature,
        },
        body: rawBody,
        expectedStatus: 401,
        expectedBody: 'Invalid signature',
      });
    });
  });

  // =======================================================================
  // Category 6: Bare / Unrouted Endpoints
  // =======================================================================
  describe('Slack Bare POST /api/slack', () => {
    it('SLACK-BARE-01: Bare POST /api/slack returns 404 fall-through on both pipelines', async () => {
      const rawBody = JSON.stringify({ test: 'bare_endpoint' });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = signSlackRequest(timestamp, rawBody);

      await runDifferentialTest({
        path: '/api/slack',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
        body: rawBody,
        expectedStatus: 404,
        expectedBody: /Cannot POST \/api\/slack/,
      });
    });
  });
});
