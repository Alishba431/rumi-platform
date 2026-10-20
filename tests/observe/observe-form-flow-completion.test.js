/**
 * S1-metaflow — closing the loop on Meta.
 *
 * The form endpoint is mounted at /api/flows/observe-form (decrypted like every
 * other Flow endpoint). When the coach submits the last screen, Meta delivers
 * an nfm_reply carrying { observe_action: 'submitted', session_id, flow_token }.
 * The webhook routes that on observe_action (before the shape-guessing flow
 * detector, which would read the "<id>:<id>" token as attendance) to
 * observe-draft completeFromFlow: clear the coach's form state, acknowledge
 * with the change count, offer the debrief — exactly what the chat form does
 * at its end.
 */

const fs = require('fs');
const path = require('path');
const { createFakeSupabase } = require('./_helpers/fake-supabase');
const { mockBotDependency } = require('../_helpers/mock-bot-dependency');

// The Flow router reaches the SQS driver, whose aws-sdk is a bot-only package.
mockBotDependency('aws-sdk', () => ({ config: { update: jest.fn() }, SQS: jest.fn(() => ({})) }));

const mockDb = createFakeSupabase({
  users: [
    { id: 'coach-1', role: 'coach', name: 'Robin Coach', phone_number: '15550100001', preferred_language: 'en' },
    { id: 't-1', name: 'Sam Taylor', phone_number: '15550100002', preferred_language: 'en' },
  ],
  coaching_sessions: [],
});
jest.mock('../../bot/shared/config/supabase', () => mockDb.client);
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
const mockRedis = new Map();
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  setexWithCeiling: jest.fn(async (k, ttl, v) => { mockRedis.set(k, v); return true; }),
  get: jest.fn(async (k) => (mockRedis.has(k) ? JSON.parse(mockRedis.get(k)) : null)),
  delete: jest.fn(async (k) => mockRedis.delete(k)),
  setNX: jest.fn(async (k, v) => { if (mockRedis.has(k)) return false; mockRedis.set(k, JSON.stringify(v)); return true; }),
}));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn(async () => true),
  sendFlow: jest.fn(async () => true),
  sendInteractiveButtons: jest.fn(async () => true),
}));
const mockDebrief = { offerDebriefChoice: jest.fn(async () => true) };
jest.mock('../../bot/shared/services/observe/observe-debrief.service', () => mockDebrief);

const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const ObserveState = require('../../bot/shared/services/observe/observe-state.service');
const ObserveDraft = require('../../bot/shared/services/observe/observe-draft.service');
const ObserveForm = require('../../bot/shared/services/observe/observe-form.service');

const COACH = { id: 'coach-1', role: 'coach', preferred_language: 'en' };
const FROM = '15550100001';
const reply = (over = {}) => ({ observe_action: 'submitted', session_id: 'obs-1', flow_token: 'coach-1:obs-1', ...over });
function seed(over = {}) {
  mockDb.tables.coaching_sessions.push({
    id: 'obs-1', user_id: 't-1', observer_user_id: 'coach-1', observation_type: 'leader_observation',
    status: 'observer_review_complete', debrief_status: 'pending',
    analysis_data: { domains: {}, observer_edit_summary: { indicators_rescored: 2, text_fields_changed: 1 } },
    ...over,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRedis.clear();
  mockDb.tables.coaching_sessions.length = 0;
});

describe('completeFromFlow (the nfm_reply for a submitted form)', () => {
  test('clears the form state, acknowledges with the change count, offers the debrief', async () => {
    seed();
    await ObserveState.setState('coach-1', 'awaiting_form', { sessionId: 'obs-1', via: 'flow' });
    expect(await ObserveDraft.completeFromFlow(COACH, FROM, reply())).toBe(true);
    expect(await ObserveState.getState('coach-1')).toBeNull();
    const [to, text] = WhatsAppService.sendMessage.mock.calls[0];
    expect(to).toBe(FROM);
    expect(text).toMatch(/saved, with your edits/);
    expect(text).toMatch(/You changed 2 rating/);
    expect(mockDebrief.offerDebriefChoice).toHaveBeenCalledWith(COACH, FROM, 'obs-1');
  });

  test('no edits: the ack carries no change line', async () => {
    seed({ analysis_data: { observer_edit_summary: { indicators_rescored: 0 } } });
    await ObserveDraft.completeFromFlow(COACH, FROM, reply());
    expect(WhatsAppService.sendMessage.mock.calls[0][1]).not.toMatch(/You changed/);
  });

  test('a redelivered webhook acknowledges once', async () => {
    seed();
    await ObserveDraft.completeFromFlow(COACH, FROM, reply());
    await ObserveDraft.completeFromFlow(COACH, FROM, reply());
    expect(WhatsAppService.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockDebrief.offerDebriefChoice).toHaveBeenCalledTimes(1);
  });

  test('a form state armed for ANOTHER observation is left alone', async () => {
    seed();
    await ObserveState.setState('coach-1', 'awaiting_debrief_audio', { sessionId: 'obs-9' });
    await ObserveDraft.completeFromFlow(COACH, FROM, reply());
    expect((await ObserveState.getState('coach-1')).state).toBe('awaiting_debrief_audio');
  });

  test('someone else\'s observation, or one whose edits never landed, gets no ack and no debrief', async () => {
    seed({ observer_user_id: 'coach-2' });
    await ObserveDraft.completeFromFlow(COACH, FROM, reply());
    mockDb.tables.coaching_sessions.length = 0;
    seed({ status: 'cancelled' });
    await ObserveDraft.completeFromFlow(COACH, FROM, reply());
    mockDb.tables.coaching_sessions.length = 0;
    seed({ status: 'awaiting_observer_review' });
    await ObserveDraft.completeFromFlow(COACH, FROM, reply());
    expect(WhatsAppService.sendMessage).not.toHaveBeenCalled();
    expect(mockDebrief.offerDebriefChoice).not.toHaveBeenCalled();
  });

  test('a reply for a form whose debrief already happened is not re-acknowledged or re-offered', async () => {
    // The 24 h redelivery guard has expired; the row is still in
    // observer_review_complete because the report has not gone yet.
    seed({ debrief_status: 'done' });
    expect(await ObserveDraft.completeFromFlow(COACH, FROM, reply())).toBe(true);
    mockDb.tables.coaching_sessions.length = 0;
    seed({ analysis_data: { domains: {}, teacher_delivery: { status: 'sent' } } });
    expect(await ObserveDraft.completeFromFlow(COACH, FROM, reply())).toBe(true);
    expect(WhatsAppService.sendMessage).not.toHaveBeenCalled();
    expect(mockDebrief.offerDebriefChoice).not.toHaveBeenCalled();
  });

  test('a token for another user is refused even when session_id matches', async () => {
    seed();
    await ObserveDraft.completeFromFlow(COACH, FROM, reply({ flow_token: 'coach-2:obs-1' }));
    expect(mockDebrief.offerDebriefChoice).not.toHaveBeenCalled();
  });

  test('the chat-form text hook ignores a coach whose form is the Flow', async () => {
    await ObserveState.setState('coach-1', 'awaiting_form', { sessionId: 'obs-1', via: 'flow' });
    expect(await ObserveForm.handleText(COACH, FROM, 'ok')).toBe(false);
  });
});

describe('wiring', () => {
  test('the form endpoint is mounted on the Flow router and decrypted like the others', async () => {
    jest.resetModules();
    jest.doMock('../../bot/shared/config/supabase', () => mockDb.client);
    jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
    jest.doMock('../../bot/shared/services/flow-encryption.service', () => ({
      isConfigured: () => true,
      processEncryptedRequest: jest.fn(async (body, handler) => JSON.stringify(await handler(body))),
      handlePing: () => ({ data: { status: 'active' } }),
      createErrorResponse: (m) => ({ data: { error: true, error_message: m } }),
    }));
    const handle = jest.fn(async () => ({ screen: 'DOMAIN_1', data: {} }));
    jest.doMock('../../bot/shared/routes/observe-form-endpoint', () => ({ handleObserveFormRequest: handle }));
    const router = require('../../bot/shared/routes/flow-endpoint.routes');
    const layer = router.stack.find((l) => l.route && l.route.path === '/observe-form');
    expect(layer).toBeDefined();
    expect(layer.route.methods.post).toBe(true);

    const res = { set: jest.fn(), send: jest.fn(), status: jest.fn(() => res), json: jest.fn() };
    await layer.route.stack[0].handle({ body: { action: 'INIT', flow_token: 'coach-1:obs-1' } }, res);
    expect(handle).toHaveBeenCalledWith({ action: 'INIT', flow_token: 'coach-1:obs-1' });
    expect(JSON.parse(res.send.mock.calls[0][0])).toEqual({ screen: 'DOMAIN_1', data: {} });
  });

  test('whatsapp-bot.js routes an observe_action nfm_reply before the flow-type detector', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../bot/whatsapp-bot.js'), 'utf8');
    const start = src.indexOf("message.interactive?.type === 'nfm_reply'");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('detectFlowType(responseJson)', start));
    expect(block).toMatch(/responseJson\.observe_action[\s\S]*completeFromFlow\(user, from, responseJson\)/);
  });
});
