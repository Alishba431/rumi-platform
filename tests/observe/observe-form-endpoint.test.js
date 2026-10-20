/**
 * S1-metaflow — the data_exchange endpoint behind the editable Meta Flow.
 *
 * On Meta the coach reviews the AI's ratings in a WhatsApp Flow: one screen
 * per framework domain (DOMAIN_1..N), every screen pre-filled from the draft.
 * The endpoint only READS the pre-computed draft and buffers each screen's
 * edits in Redis; the last screen merges them into v2 and closes the Flow
 * with { observe_action: 'submitted' } for the webhook to pick up. It never
 * returns a `version` field, refuses anyone but the observation's coach, and
 * refuses a cancelled observation — telling the coach once, in the chat,
 * because Meta does not render an endpoint error.
 */

const { createFakeSupabase } = require('./_helpers/fake-supabase');
const { getObservePack } = require('../../bot/shared/services/observe/observe-framework');

function packAnalysis(score) {
  const pack = getObservePack();
  const analysis = { domains: {} };
  for (const d of pack.domainOrder) {
    analysis.domains[d] = {
      indicators: pack.domains[d].indicators.map((i) => ({
        id: i.id, score, evidence: `Evidence for ${i.id}`, improvement: `Next step for ${i.id}`,
      })),
    };
  }
  return pack.computeScores(analysis);
}

const mockDb = createFakeSupabase({
  users: [
    { id: 'coach-1', role: 'coach', name: 'Robin Coach', phone_number: '15550100001', preferred_language: 'en' },
    { id: 'coach-2', role: 'coach', name: 'Avery Coach', phone_number: '15550100003', preferred_language: 'en' },
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

const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const { handleObserveFormRequest } = require('../../bot/shared/routes/observe-form-endpoint');

const row = (id) => mockDb.tables.coaching_sessions.find((s) => s.id === id);
function seed(id, over = {}) {
  const analysis = packAnalysis(3);
  mockDb.tables.coaching_sessions.push({
    id, user_id: 't-1', observer_user_id: 'coach-1', observation_type: 'leader_observation',
    status: 'awaiting_observer_review', debrief_status: 'pending',
    analysis_data: analysis, autofill_analysis_data: JSON.parse(JSON.stringify(analysis)), ...over,
  });
}
const req = (action, extra = {}) => ({ action, flow_token: 'coach-1:obs-1', ...extra });
function expectNoVersion(res) {
  expect(res).not.toHaveProperty('version');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRedis.clear();
  mockDb.tables.coaching_sessions.length = 0;
  delete process.env.OBSERVE_FRAMEWORK;
});

describe('observe form endpoint', () => {
  test('ping answers active', async () => {
    const res = await handleObserveFormRequest({ action: 'ping' });
    expect(res).toEqual({ data: { status: 'active' } });
  });

  test('INIT serves the first domain screen, pre-filled from the draft and the pack scale', async () => {
    seed('obs-1');
    const res = await handleObserveFormRequest(req('INIT'));
    expectNoVersion(res);
    expect(res.screen).toBe('DOMAIN_1');
    // TEACH: the first domain is Time on Task, one indicator "T", 1-5 scale.
    expect(res.data.scale.map((o) => o.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(res.data).toMatchObject({ s_T: '3', e_T: 'Evidence for T', i_T: 'Next step for T' });
  });

  test('INIT follows the configured pack (hots: 0-3 scale, its own first domain)', async () => {
    process.env.OBSERVE_FRAMEWORK = 'hots';
    seed('obs-1', { analysis_data: packAnalysis(2) });
    const res = await handleObserveFormRequest(req('INIT'));
    expect(res.screen).toBe('DOMAIN_1');
    expect(res.data.scale.map((o) => o.id)).toEqual(['0', '1', '2', '3']);
    expect(res.data).toMatchObject({ s_1: '2', s_2: '2', s_3: '2' });
  });

  test('data_exchange buffers each screen; the last screen merges v2 and closes the Flow', async () => {
    seed('obs-1');
    let res = await handleObserveFormRequest(req('data_exchange', {
      screen: 'DOMAIN_1', data: { _screen: 'DOMAIN_1', r_T: '5', ev_T: 'Evidence for T', imp_T: 'Next step for T' },
    }));
    expectNoVersion(res);
    expect(res.screen).toBe('DOMAIN_2');
    expect(res.data).toMatchObject({ s_1: '3', s_2: '3' });
    expect(row('obs-1').status).toBe('awaiting_observer_review');   // nothing written yet
    expect(JSON.parse(mockRedis.get('observe:edits:obs-1'))).toMatchObject({ r_T: '5' });

    res = await handleObserveFormRequest(req('data_exchange', { data: { _screen: 'DOMAIN_2', r_1: '1' } }));
    expect(res.screen).toBe('DOMAIN_3');
    res = await handleObserveFormRequest(req('data_exchange', { data: { _screen: 'DOMAIN_3', imp_3: 'Pause for answers' } }));
    expect(res.screen).toBe('DOMAIN_4');
    res = await handleObserveFormRequest(req('data_exchange', { data: { _screen: 'DOMAIN_4', r_9: '3' } }));
    expectNoVersion(res);
    expect(res.screen).toBe('SUCCESS');
    expect(res.data.extension_message_response.params).toMatchObject({ observe_action: 'submitted', session_id: 'obs-1' });

    const s = row('obs-1');
    expect(s.status).toBe('observer_review_complete');
    expect(s.analysis_data.observer_edit_summary).toMatchObject({ indicators_rescored: 2, text_fields_changed: 1 });
    expect(s.analysis_data.scores.overall_marks).toBe(30 + 2 - 2);
    expect(s.autofill_analysis_data.scores.overall_marks).toBe(30);   // v1 untouched
    expect(mockRedis.has('observe:edits:obs-1')).toBe(false);         // buffer cleared
  });

  test('BACK re-serves the requested screen; an unknown screen falls back to the first', async () => {
    seed('obs-1');
    let res = await handleObserveFormRequest(req('BACK', { screen: 'DOMAIN_3' }));
    expectNoVersion(res);
    expect(res.screen).toBe('DOMAIN_3');
    expect(res.data).toHaveProperty('s_3', '3');
    res = await handleObserveFormRequest(req('BACK', { screen: 'NOPE' }));
    expect(res.screen).toBe('DOMAIN_1');
  });

  test('an unknown screen in data_exchange is an error, not a write', async () => {
    seed('obs-1');
    const res = await handleObserveFormRequest(req('data_exchange', { data: { _screen: 'DOMAIN_99', r_T: '1' } }));
    expect(res.data.error).toBeTruthy();
    expect(mockRedis.has('observe:edits:obs-1')).toBe(false);
  });

  test('someone else\'s token is refused and nothing is read out', async () => {
    seed('obs-1');
    const res = await handleObserveFormRequest({ action: 'INIT', flow_token: 'coach-2:obs-1' });
    expectNoVersion(res);
    expect(res.screen).toBeUndefined();
    expect(res.data.error).toBeTruthy();
    expect(JSON.stringify(res)).not.toMatch(/Evidence for/);
  });

  test('a malformed token and a teacher-path session are refused', async () => {
    seed('obs-1', { observation_type: 'classroom' });
    expect((await handleObserveFormRequest({ action: 'INIT', flow_token: 'garbage' })).data.error).toBeTruthy();
    expect((await handleObserveFormRequest(req('INIT'))).data.error).toBeTruthy();
  });

  test('a cancelled observation is refused, and the coach is told once in the chat', async () => {
    seed('obs-1', { status: 'cancelled' });
    const submit = req('data_exchange', { data: { _screen: 'DOMAIN_4', r_9: '1' } });
    const res = await handleObserveFormRequest(submit);
    expectNoVersion(res);
    expect(res.screen).toBeUndefined();
    expect(res.data.error).toBeTruthy();
    expect(row('obs-1').status).toBe('cancelled');
    expect(WhatsAppService.sendMessage).toHaveBeenCalledTimes(1);
    const [to, text] = WhatsAppService.sendMessage.mock.calls[0];
    expect(to).toBe('15550100001');                      // the owner from the row, never a `from`
    expect(text).toMatch(/cancelled/);
    expect(WhatsAppService.sendMessage.mock.calls[0]).toHaveLength(2);   // no pacer/budget argument

    await handleObserveFormRequest(submit);
    await handleObserveFormRequest(req('INIT'));
    expect(WhatsAppService.sendMessage).toHaveBeenCalledTimes(1);        // once, not per tap
  });

  test('a completed observation refuses a stale form: nothing re-scored, status kept, the coach told once', async () => {
    // The report is already with the teacher; the old Flow is still tappable.
    const analysis = packAnalysis(3);
    analysis.teacher_delivery = { status: 'sent', sent_at: '2026-10-01T10:00:00Z' };
    seed('obs-1', { status: 'completed', debrief_status: 'done', analysis_data: analysis });
    const before = JSON.stringify(row('obs-1').analysis_data);
    const res = await handleObserveFormRequest(req('data_exchange', { data: { _screen: 'DOMAIN_4', r_9: '1' } }));
    expectNoVersion(res);
    expect(res.screen).toBeUndefined();
    expect(res.data.error_message).toMatch(/already saved/);
    expect(row('obs-1').status).toBe('completed');
    expect(JSON.stringify(row('obs-1').analysis_data)).toBe(before);
    expect(WhatsAppService.sendMessage).toHaveBeenCalledTimes(1);
    expect(WhatsAppService.sendMessage.mock.calls[0]).toEqual(['15550100001', res.data.error_message]);
  });

  test('a form already submitted (observer_review_complete) does not reopen or resubmit', async () => {
    seed('obs-1', { status: 'observer_review_complete' });
    const init = await handleObserveFormRequest(req('INIT'));
    expect(init.screen).toBeUndefined();
    expect(init.data.error_message).toMatch(/already saved/);
    const res = await handleObserveFormRequest(req('data_exchange', { data: { _screen: 'DOMAIN_4', r_9: '1' } }));
    expect(res.screen).toBeUndefined();
    expect(row('obs-1').analysis_data.observer_edit_summary).toBeUndefined();
  });

  test('finished between load and write: the last screen does not reach SUCCESS, and says why', async () => {
    seed('obs-1');
    const ObserveEdits = require('../../bot/shared/services/observe/observe-edits.service');
    const spy = jest.spyOn(ObserveEdits, 'applyObserverEdits').mockResolvedValueOnce({ refused: 'not_in_review' });
    const res = await handleObserveFormRequest(req('data_exchange', { data: { _screen: 'DOMAIN_4', r_9: '1' } }));
    expect(res.screen).toBeUndefined();
    expect(res.data.error_message).toMatch(/already saved/);
    spy.mockRestore();
  });

  test('cancelled between load and write: the last screen does not reach SUCCESS', async () => {
    seed('obs-1');
    const ObserveEdits = require('../../bot/shared/services/observe/observe-edits.service');
    const spy = jest.spyOn(ObserveEdits, 'applyObserverEdits').mockResolvedValueOnce({ refused: 'terminal' });
    const res = await handleObserveFormRequest(req('data_exchange', { data: { _screen: 'DOMAIN_4', r_9: '1' } }));
    expect(res.screen).toBeUndefined();
    expect(res.data.error_message).toMatch(/cancelled/);
    spy.mockRestore();
  });

  test('a lost edit buffer degrades to the v1 values, never a crash', async () => {
    seed('obs-1');
    const res = await handleObserveFormRequest(req('data_exchange', { data: { _screen: 'DOMAIN_4' } }));
    expect(res.screen).toBe('SUCCESS');
    expect(row('obs-1').analysis_data.observer_edit_summary).toMatchObject({ indicators_rescored: 0 });
  });
});
