/**
 * tests/gateway/characterization.test.js
 *
 * Webhook Ingestion Gateway Characterization Tests (Behavior Freeze).
 * Establishes the ground-truth baseline against the unmodified legacy
 * webhook implementation in bot/whatsapp-bot.js prior to Strangler Fig extraction.
 *
 * Requirements:
 * - WhatsApp GET /webhook (Meta verification handshake: 200 challenge on valid subscribe mode & verify token, 403 on invalid/missing params)
 * - WhatsApp POST /webhook (Inbound text message, button reply, list reply, status notifications, duplicate suppression, malformed payloads — all returning 200 'EVENT_RECEIVED')
 * - Slack POST /api/slack/events (url_verification challenge with valid HMAC returning 200 challenge, message events returning 200 '', invalid HMAC returning 401, expired timestamp returning 401)
 * - Boundary Characterization:
 *   - Symmetric clock skew boundaries (past now-299s -> 200, future now+299s -> 200, past now-301s -> 401, future now+301s -> 401)
 *   - Missing Slack security headers (missing x-slack-signature -> 401, missing x-slack-request-timestamp -> 401)
 * - Slack POST /api/slack/interactions (Block Kit button click returning 200 '', invalid HMAC returning 401, malformed JSON payload=%7Bbadjson returning 400 'Bad payload')
 * - Slack POST /api/slack/commands (Slash command returning 200 '')
 * - Bare POST /api/slack (Legacy 404 fall-through)
 *
 * Runs 100% offline via ephemeral loopback server with all side-effects mocked.
 */

const crypto = require('crypto');
const http = require('http');

// 1. Configure test environment variables before requiring bot modules
const VERIFY_TOKEN = 'test_verify_token_characterization';
const PHONE_NUMBER_ID = '100000000000001';
const SLACK_SIGNING_SECRET = 'test_slack_signing_secret_characterization_xyz';

process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.WEBHOOK_VERIFY_TOKEN = VERIFY_TOKEN;
process.env.PHONE_NUMBER_ID = PHONE_NUMBER_ID;
process.env.SLACK_SIGNING_SECRET = SLACK_SIGNING_SECRET;
process.env.SUPABASE_URL = 'https://test-project.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
process.env.OPENROUTER_API_KEY = 'sk-or-test-key';
delete process.env.REDIS_URL;

// 2. Mocks for offline test execution
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

const duplicateSeenIds = new Set(['wamid.duplicate.001', 'wamid.DUPLICATE_SEEN_MSG_888']);
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

// Bot-only deps reached by requiring whatsapp-bot.js: CI runs root tests
// before bot/ npm ci, so they are mocked virtually.
jest.mock('jsonrepair', () => ({ jsonrepair: (s) => s }), { virtual: true });
jest.mock('pdfkit', () => ({}), { virtual: true });
jest.mock('uuid', () => ({ v4: () => 'stub-uuid' }), { virtual: true });
jest.mock('../../bot/shared/storage/r2', () => ({}));
jest.mock('../../bot/shared/services/queue', () => ({ queueJob: jest.fn().mockResolvedValue('job-1') }));

// 3. Import legacy app after mocks and env vars are configured
const { app } = require('../../bot/whatsapp-bot');

// 4. Helper utilities
function getFreshTimestamp() {
  return Math.floor(Date.now() / 1000).toString();
}

function signSlackRequest(timestamp, rawBody, secret = SLACK_SIGNING_SECRET) {
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  const base = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac('sha256', secret).update(base, 'utf8').digest('hex');
  return `v0=${hmac}`;
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
    value.contacts = [{ profile: { name: 'Amina Khan' }, wa_id: messageObj.from || '923001234567' }];
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

describe('Gateway Ingress Characterization Tests (Behavior Freeze)', () => {
  let server;
  let baseUrl;

  beforeAll((done) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      done();
    });
  });

  afterAll((done) => {
    if (server) {
      server.close(done);
    } else {
      done();
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
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
  });

  // =========================================================================
  // WhatsApp Ingress Characterization
  // =========================================================================
  describe('WhatsApp GET /webhook (Meta Verification Handshake)', () => {
    it('returns 200 and challenge string when mode is subscribe and token matches', async () => {
      const challenge = 'challenge_test_code_991';
      const url = `${baseUrl}/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=${challenge}`;

      const res = await fetch(url);
      const text = await res.text();

      expect(res.status).toBe(200);
      expect(text).toBe(challenge);
    });

    it('returns 403 Forbidden when verify token does not match', async () => {
      const challenge = 'challenge_test_code_991';
      const url = `${baseUrl}/webhook?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=${challenge}`;

      const res = await fetch(url);
      const text = await res.text();

      expect(res.status).toBe(403);
      expect(text).toBe('Forbidden');
    });

    it('returns 403 Forbidden when hub.mode is missing', async () => {
      const url = `${baseUrl}/webhook?hub.verify_token=${VERIFY_TOKEN}&hub.challenge=test_challenge`;

      const res = await fetch(url);
      const text = await res.text();

      expect(res.status).toBe(403);
      expect(text).toBe('Forbidden');
    });

    it('returns 403 Forbidden when hub.verify_token is missing', async () => {
      const url = `${baseUrl}/webhook?hub.mode=subscribe&hub.challenge=test_challenge`;

      const res = await fetch(url);
      const text = await res.text();

      expect(res.status).toBe(403);
      expect(text).toBe('Forbidden');
    });

    it('returns 403 Forbidden when query string is empty', async () => {
      const res = await fetch(`${baseUrl}/webhook`);
      const text = await res.text();

      expect(res.status).toBe(403);
      expect(text).toBe('Forbidden');
    });

    it('returns 403 Forbidden when hub.mode is not subscribe', async () => {
      const url = `${baseUrl}/webhook?hub.mode=publish&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=test_challenge`;

      const res = await fetch(url);
      const text = await res.text();

      expect(res.status).toBe(403);
      expect(text).toBe('Forbidden');
    });
  });

  describe('WhatsApp POST /webhook (Inbound Payloads)', () => {
    it('processes a valid text message payload and returns 200 EVENT_RECEIVED', async () => {
      const messageId = 'wamid.HBgMOTIzMDAxMjM0NTY3FQIAERgSMUUyM0Q0RjVBQTU0Mjg2OTEA';
      const textBody = 'Hello Rumi, help me plan a lesson on Fractions for Grade 5';
      const payload = buildWhatsAppEnvelope({
        from: '923001234567',
        id: messageId,
        timestamp: getFreshTimestamp(),
        type: 'text',
        text: { body: textBody },
      });

      const res = await fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const text = await res.text();

      expect(res.status).toBe(200);
      expect(text).toBe('EVENT_RECEIVED');

      // Verify ingress side-effects
      expect(mockSessionService.isProcessed).toHaveBeenCalledWith(messageId);
      expect(mockSessionService.markAsProcessed).toHaveBeenCalledWith(messageId);
      expect(mockWhatsAppService.sendReaction).toHaveBeenCalledWith('923001234567', messageId, '❤️');
      expect(mockWhatsAppService.showTypingIndicator).toHaveBeenCalledWith('923001234567', messageId);
      expect(mockHandleTextMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: messageId, type: 'text' }),
        '923001234567',
        textBody,
        expect.objectContaining({ id: 'test-user-uuid-1' })
      );
    });

    it('processes an interactive button reply payload and returns 200 EVENT_RECEIVED', async () => {
      const messageId = 'wamid.BUTTON_REPLY_MSG_123';
      const buttonId = 'coaching_confirm_session_999';
      const payload = buildWhatsAppEnvelope({
        from: '923001234567',
        id: messageId,
        timestamp: getFreshTimestamp(),
        type: 'interactive',
        interactive: {
          type: 'button_reply',
          button_reply: { id: buttonId, title: 'Yes, continue' },
        },
      });

      const res = await fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const text = await res.text();

      expect(res.status).toBe(200);
      expect(text).toBe('EVENT_RECEIVED');

      // Verify side-effects
      expect(mockSessionService.isProcessed).toHaveBeenCalledWith(messageId);
      expect(mockSessionService.markAsProcessed).toHaveBeenCalledWith(messageId);
      expect(mockWhatsAppService.sendReaction).toHaveBeenCalledWith('923001234567', messageId, '❤️');
      expect(mockCoachingService.handleConfirmation).toHaveBeenCalledWith('session_999', '923001234567', true);
    });

    it('processes an interactive list reply payload and returns 200 EVENT_RECEIVED', async () => {
      const messageId = 'wamid.LIST_REPLY_MSG_456';
      const listId = 'lang_ur';
      const payload = buildWhatsAppEnvelope({
        from: '923001234567',
        id: messageId,
        timestamp: getFreshTimestamp(),
        type: 'interactive',
        interactive: {
          type: 'list_reply',
          list_reply: { id: listId, title: 'Urdu', description: 'اردو' },
        },
      });

      const res = await fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const text = await res.text();

      expect(res.status).toBe(200);
      expect(text).toBe('EVENT_RECEIVED');

      // Verify side-effects
      expect(mockSessionService.isProcessed).toHaveBeenCalledWith(messageId);
      expect(mockSessionService.markAsProcessed).toHaveBeenCalledWith(messageId);
      expect(mockWhatsAppService.sendReaction).toHaveBeenCalledWith('923001234567', messageId, '❤️');
    });

    it('processes delivery/read status notifications and returns 200 EVENT_RECEIVED without message dispatch', async () => {
      const statusId = 'wamid.ORIGINAL_OUTBOUND_MSG_777';
      const payload = buildWhatsAppEnvelope(null, [
        {
          id: statusId,
          status: 'delivered',
          timestamp: getFreshTimestamp(),
          recipient_id: '923001234567',
        },
      ]);

      const res = await fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const text = await res.text();

      expect(res.status).toBe(200);
      expect(text).toBe('EVENT_RECEIVED');

      // Status updates do not invoke user-message handlers
      expect(mockSessionService.isProcessed).not.toHaveBeenCalled();
      expect(mockWhatsAppService.sendReaction).not.toHaveBeenCalled();
      expect(mockHandleTextMessage).not.toHaveBeenCalled();
    });

    it('skips processing for duplicate messages and returns 200 EVENT_RECEIVED', async () => {
      const duplicateId = 'wamid.duplicate.001';
      const payload = buildWhatsAppEnvelope({
        from: '923001234567',
        id: duplicateId,
        timestamp: getFreshTimestamp(),
        type: 'text',
        text: { body: 'Duplicate message delivery attempt' },
      });

      const res = await fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const text = await res.text();

      expect(res.status).toBe(200);
      expect(text).toBe('EVENT_RECEIVED');

      expect(mockSessionService.isProcessed).toHaveBeenCalledWith(duplicateId);
      expect(mockSessionService.markAsProcessed).not.toHaveBeenCalled();
      expect(mockWhatsAppService.sendReaction).not.toHaveBeenCalled();
      expect(mockWhatsAppService.showTypingIndicator).not.toHaveBeenCalled();
      expect(mockHandleTextMessage).not.toHaveBeenCalled();
    });

    it('handles malformed / unexpected envelopes gracefully and returns 200 EVENT_RECEIVED', async () => {
      const emptyPayload = {};
      const res1 = await fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(emptyPayload),
      });
      expect(res1.status).toBe(200);
      expect(await res1.text()).toBe('EVENT_RECEIVED');

      const emptyEntryPayload = {
        object: 'whatsapp_business_account',
        entry: [],
      };
      const res2 = await fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(emptyEntryPayload),
      });
      expect(res2.status).toBe(200);
      expect(await res2.text()).toBe('EVENT_RECEIVED');

      expect(mockSessionService.isProcessed).not.toHaveBeenCalled();
      expect(mockHandleTextMessage).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Slack Ingress Characterization
  // =========================================================================
  describe('Slack POST /api/slack/events', () => {
    it('url_verification challenge with valid HMAC -> status 200, challenge echo', async () => {
      const challengeToken = 'test-challenge-token-' + Date.now();
      const rawBody = JSON.stringify({
        type: 'url_verification',
        token: 'slack-verify-token',
        challenge: challengeToken,
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = signSlackRequest(timestamp, rawBody);

      const res = await fetch(`${baseUrl}/api/slack/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
        body: rawBody,
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ challenge: challengeToken });
    });

    it('event_callback message event with valid HMAC -> status 200, empty body ack', async () => {
      const rawBody = JSON.stringify({
        type: 'event_callback',
        event_id: `Ev-${Date.now()}`,
        event_time: Math.floor(Date.now() / 1000),
        event: {
          type: 'message',
          user: 'U0123ABC',
          text: 'Hello Rumi',
          ts: `${Math.floor(Date.now() / 1000)}.000100`,
          channel: 'C0123ABC',
        },
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = signSlackRequest(timestamp, rawBody);

      const res = await fetch(`${baseUrl}/api/slack/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
        body: rawBody,
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe('');
    });

    it('Invalid HMAC signature -> status 401, Invalid signature', async () => {
      const rawBody = JSON.stringify({
        type: 'url_verification',
        challenge: 'forged-challenge',
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const invalidSignature = 'v0=' + '0'.repeat(64);

      const res = await fetch(`${baseUrl}/api/slack/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': invalidSignature,
        },
        body: rawBody,
      });

      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).toBe('Invalid signature');
    });

    it('Expired timestamp (> 300s skew) -> status 401, Invalid signature', async () => {
      const rawBody = JSON.stringify({
        type: 'url_verification',
        challenge: 'expired-challenge',
      });
      const expiredTimestamp = String(Math.floor(Date.now() / 1000) - 350);
      const signature = signSlackRequest(expiredTimestamp, rawBody);

      const res = await fetch(`${baseUrl}/api/slack/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': expiredTimestamp,
          'x-slack-signature': signature,
        },
        body: rawBody,
      });

      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).toBe('Invalid signature');
    });

    // --- Boundary Condition Characterization: Clock Skew Limits ---
    it('Past within-window (now - 299s) returns HTTP 200', async () => {
      const challengeToken = 'skew_past_within_' + Date.now();
      const rawBody = JSON.stringify({
        type: 'url_verification',
        challenge: challengeToken,
      });
      const timestamp = String(Math.floor(Date.now() / 1000) - 299);
      const signature = signSlackRequest(timestamp, rawBody);

      const res = await fetch(`${baseUrl}/api/slack/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
        body: rawBody,
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ challenge: challengeToken });
    });

    it('Future within-window (now + 299s) returns HTTP 200', async () => {
      const challengeToken = 'skew_future_within_' + Date.now();
      const rawBody = JSON.stringify({
        type: 'url_verification',
        challenge: challengeToken,
      });
      const timestamp = String(Math.floor(Date.now() / 1000) + 299);
      const signature = signSlackRequest(timestamp, rawBody);

      const res = await fetch(`${baseUrl}/api/slack/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
        body: rawBody,
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ challenge: challengeToken });
    });

    it('Past outside-window (now - 301s) returns HTTP 401 Invalid signature', async () => {
      const rawBody = JSON.stringify({
        type: 'url_verification',
        challenge: 'skew_past_outside',
      });
      const timestamp = String(Math.floor(Date.now() / 1000) - 301);
      const signature = signSlackRequest(timestamp, rawBody);

      const res = await fetch(`${baseUrl}/api/slack/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
        body: rawBody,
      });

      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).toBe('Invalid signature');
    });

    it('Future outside-window (now + 301s) returns HTTP 401 Invalid signature', async () => {
      const rawBody = JSON.stringify({
        type: 'url_verification',
        challenge: 'skew_future_outside',
      });
      const timestamp = String(Math.floor(Date.now() / 1000) + 301);
      const signature = signSlackRequest(timestamp, rawBody);

      const res = await fetch(`${baseUrl}/api/slack/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
        body: rawBody,
      });

      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).toBe('Invalid signature');
    });

    // --- Boundary Condition Characterization: Missing Slack Security Headers ---
    it('Request missing x-slack-signature returns HTTP 401 Invalid signature', async () => {
      const rawBody = JSON.stringify({
        type: 'url_verification',
        challenge: 'missing_sig_challenge',
      });
      const timestamp = String(Math.floor(Date.now() / 1000));

      const res = await fetch(`${baseUrl}/api/slack/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': timestamp,
        },
        body: rawBody,
      });

      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).toBe('Invalid signature');
    });

    it('Request missing x-slack-request-timestamp returns HTTP 401 Invalid signature', async () => {
      const rawBody = JSON.stringify({
        type: 'url_verification',
        challenge: 'missing_ts_challenge',
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = signSlackRequest(timestamp, rawBody);

      const res = await fetch(`${baseUrl}/api/slack/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-signature': signature,
        },
        body: rawBody,
      });

      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).toBe('Invalid signature');
    });
  });

  describe('Slack POST /api/slack/interactions', () => {
    it('Block Kit button click interaction with valid HMAC -> status 200, empty body ack', async () => {
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

      const res = await fetch(`${baseUrl}/api/slack/interactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
        body: rawBody,
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe('');
    });

    it('Invalid HMAC signature -> status 401, Invalid signature', async () => {
      const rawBody = `payload=${encodeURIComponent(JSON.stringify({ type: 'block_actions' }))}`;
      const timestamp = String(Math.floor(Date.now() / 1000));
      const invalidSignature = 'v0=' + 'f'.repeat(64);

      const res = await fetch(`${baseUrl}/api/slack/interactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': invalidSignature,
        },
        body: rawBody,
      });

      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).toBe('Invalid signature');
    });

    it('Valid HMAC with malformed JSON (payload=%7Bbadjson) returns HTTP 400 Bad payload', async () => {
      const rawBody = 'payload=%7Bbadjson';
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = signSlackRequest(timestamp, rawBody);

      const res = await fetch(`${baseUrl}/api/slack/interactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
        body: rawBody,
      });

      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toBe('Bad payload');
    });
  });

  describe('Slack POST /api/slack/commands', () => {
    it('Slash command (/readingtest) with valid HMAC -> status 200, empty body ack', async () => {
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

      const res = await fetch(`${baseUrl}/api/slack/commands`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
        body: rawBody,
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe('');
    });
  });

  describe('Slack Bare POST /api/slack', () => {
    it('returns legacy 404 Cannot POST /api/slack on bare path', async () => {
      const rawBody = JSON.stringify({ test: 'bare_endpoint' });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = signSlackRequest(timestamp, rawBody);

      const res = await fetch(`${baseUrl}/api/slack`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
        body: rawBody,
      });

      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).toContain('Cannot POST /api/slack');
    });
  });
});
