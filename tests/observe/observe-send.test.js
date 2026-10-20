/**
 * Sending the teacher their report — the coach's side of it.
 *
 * After the coach-the-coach feedback the coach is offered "Send report /
 * Later". The recipient is resolved, in order: the teacher the session is
 * bound to (their users row — phone_number IS the channel identity), else a
 * pick from the coach's derived roster, else the name and number typed in one
 * message. A typed number resolves to an existing user in ANY channel shape
 * before falling back to the bare number. Nothing is ever sent before the coach
 * has seen a preview: every path ends in a queued 'preview' job.
 */

const { createFakeSupabase } = require('./_helpers/fake-supabase');

const mockDb = createFakeSupabase({
  users: [
    { id: 'coach-1', role: 'coach', name: 'Robin Coach', phone_number: 'mtx:15550100001', preferred_language: 'en' },
    { id: 't-1', role: 'teacher', name: 'Sam Taylor', phone_number: 'mtx:15550100002', school_id: 'sch-1' },
    { id: 't-2', role: 'teacher', name: 'Alex Kim', phone_number: '15550100003', school_id: 'sch-1' },
    { id: 't-3', role: 'teacher', name: 'No Phone', phone_number: null, school_id: 'sch-1' },
    { id: 't-4', role: 'teacher', name: 'Jordan Lee', phone_number: 'mtx:15550100004' },
  ],
  leader_schools: [{ id: 'ls-1', leader_user_id: 'coach-1', school_id: 'sch-1', school_ext_id: 'S-001', school_name: 'Hillside Primary' }],
  coaching_sessions: [
    { id: 'bound-1', user_id: 't-1', observer_user_id: 'coach-1', observation_type: 'leader_observation', status: 'observer_review_complete', analysis_data: {} },
    { id: 'bare-1', user_id: 'coach-1', observer_user_id: 'coach-1', observation_type: 'leader_observation', status: 'observer_review_complete', analysis_data: {} },
    { id: 'sent-1', user_id: 't-1', observer_user_id: 'coach-1', observation_type: 'leader_observation', status: 'observer_review_complete', analysis_data: { teacher_delivery: { status: 'sent' } } },
    { id: 'other-coach', user_id: 't-1', observer_user_id: 'coach-9', observation_type: 'leader_observation', status: 'observer_review_complete', analysis_data: {} },
  ],
});
jest.mock('../../bot/shared/config/supabase', () => mockDb.client);
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
const mockRedis = new Map();
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  setexWithCeiling: jest.fn(async (k, ttl, v) => { mockRedis.set(k, v); return true; }),
  get: jest.fn(async (k) => (mockRedis.has(k) ? JSON.parse(mockRedis.get(k)) : null)),
  delete: jest.fn(async (k) => mockRedis.delete(k)),
}));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn(async () => true),
  sendInteractiveButtons: jest.fn(async () => true),
  sendInteractiveMessage: jest.fn(async () => true),
}));
jest.mock('../../bot/shared/services/coaching/coaching-job-queue.service', () => ({
  queueObserveTeacherReport: jest.fn(async () => 'msg-1'),
}));

const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const Queue = require('../../bot/shared/services/coaching/coaching-job-queue.service');
const ObserveState = require('../../bot/shared/services/observe/observe-state.service');
const ObserveSend = require('../../bot/shared/services/observe/observe-send.service');
const { handleObserveInteractive } = require('../../bot/shared/handlers/observe-interactive.handler');
const { handleObserveText } = require('../../bot/shared/handlers/observe-command.handler');

const FROM = 'mtx:15550100001';
const coach = () => mockDb.tables.users[0];
const session = (id) => mockDb.tables.coaching_sessions.find((s) => s.id === id);
const delivery = (id) => (session(id).analysis_data || {}).teacher_delivery || {};
const sent = () => WhatsAppService.sendMessage.mock.calls.map((c) => c[1]);
// Every preview has its own id: on the row, on the job, and as the job's dedup nonce.
const expectPreviewQueued = (id) => {
  const previewId = delivery(id).preview_id;
  expect(previewId).toMatch(/^[0-9a-f]{12}$/);
  expect(Queue.queueObserveTeacherReport).toHaveBeenCalledWith(id, { phase: 'preview', from: FROM, previewId, dedupNonce: previewId });
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRedis.clear();
  process.env.OBSERVE_ENABLED = 'true';
  for (const id of ['bound-1', 'bare-1']) session(id).analysis_data = {};
});

describe('offerSendReport', () => {
  test('two buttons, ids under observe_send_, titles inside the 20-character cap', async () => {
    await ObserveSend.offerSendReport(coach(), FROM, 'bound-1');
    const [to, payload] = WhatsAppService.sendInteractiveButtons.mock.calls[0];
    expect(to).toBe(FROM);
    expect(payload.buttons.map((b) => b.id)).toEqual(['observe_send_start_bound-1', 'observe_send_later_bound-1']);
    payload.buttons.forEach((b) => expect(b.title.length).toBeLessThanOrEqual(20));
    expect(payload.body).toMatch(/see it first/);
  });
});

describe('who receives it', () => {
  test('a bound session goes straight to the bound teacher — no question asked', async () => {
    expect(await handleObserveInteractive(coach(), FROM, 'observe_send_start_bound-1')).toBe(true);
    expect(delivery('bound-1')).toMatchObject({
      teacher_name: 'Sam Taylor', teacher_phone: 'mtx:15550100002', status: 'previewing', target: 'session_binding',
    });
    expectPreviewQueued('bound-1');
    expect(WhatsAppService.sendInteractiveMessage).not.toHaveBeenCalled();
    expect(sent()[0]).toMatch(/Sam Taylor \(\+15550100002\)/);
    expect((await ObserveState.getState('coach-1')).state).toBe('awaiting_send_confirm');
  });

  test('an unbound session offers the derived roster (teachers with a number) plus "New teacher"', async () => {
    await handleObserveInteractive(coach(), FROM, 'observe_send_start_bare-1');
    const payload = WhatsAppService.sendInteractiveMessage.mock.calls[0][1];
    const rows = payload.action.sections[0].rows;
    expect(rows.map((r) => r.id)).toEqual(['observe_pickt_0', 'observe_pickt_1', 'observe_pickt_new']);
    expect(rows.map((r) => r.title)).toEqual(['Alex Kim', 'Sam Taylor', '➕ New teacher']);
    rows.forEach((r) => { expect(r.title.length).toBeLessThanOrEqual(24); expect(r.description.length).toBeLessThanOrEqual(72); });
    expect((await ObserveState.getState('coach-1')).state).toBe('awaiting_teacher_pick');

    // the tap resolves against the snapshot the coach saw
    expect(await handleObserveInteractive(coach(), FROM, 'observe_pickt_1')).toBe(true);
    expect(delivery('bare-1')).toMatchObject({ teacher_name: 'Sam Taylor', teacher_phone: 'mtx:15550100002', target: 'roster_pick' });
    expectPreviewQueued('bare-1');
  });

  test('"New teacher" arms awaiting_teacher_details; typed details keep their capitals and resolve the channel identity', async () => {
    await handleObserveInteractive(coach(), FROM, 'observe_send_start_bare-1');
    await handleObserveInteractive(coach(), FROM, 'observe_pickt_new');
    expect((await ObserveState.getState('coach-1')).state).toBe('awaiting_teacher_details');
    expect(sent().pop()).toMatch(/name and phone number/);

    // +1 555 010 0004 is Jordan's Matrix identity — resolved, not sent to the bare number
    expect(await handleObserveText(coach(), FROM, 'Jordan Lee, +1 555 010 0004')).toBe(true);
    expect(delivery('bare-1')).toMatchObject({ teacher_name: 'Jordan Lee', teacher_phone: 'mtx:15550100004', target: 'typed' });
    expectPreviewQueued('bare-1');
  });

  test('a typed number nobody uses falls back to the bare digits', async () => {
    await ObserveState.setState('coach-1', 'awaiting_teacher_details', { sessionId: 'bare-1' });
    await handleObserveText(coach(), FROM, 'Pat Morgan 555-010-0199');
    expect(delivery('bare-1')).toMatchObject({ teacher_name: 'Pat Morgan', teacher_phone: '5550100199' });
  });

  test('a reply that is not a name + number is re-asked and stays consumed', async () => {
    await ObserveState.setState('coach-1', 'awaiting_teacher_details', { sessionId: 'bare-1' });
    expect(await handleObserveText(coach(), FROM, 'just a name')).toBe(true);
    expect(sent().pop()).toMatch(/didn't catch that/);
    expect((await ObserveState.getState('coach-1')).state).toBe('awaiting_teacher_details');
    expect(Queue.queueObserveTeacherReport).not.toHaveBeenCalled();
  });

  test('a coach with no roster is asked for the details directly', async () => {
    const lonely = { id: 'coach-2', role: 'coach', name: 'Lone Coach' };
    mockDb.tables.coaching_sessions.push({ id: 'bare-2', user_id: 'coach-2', observer_user_id: 'coach-2', observation_type: 'leader_observation', status: 'observer_review_complete', analysis_data: {} });
    await handleObserveInteractive(lonely, FROM, 'observe_send_start_bare-2');
    expect(WhatsAppService.sendInteractiveMessage).not.toHaveBeenCalled();
    expect((await ObserveState.getState('coach-2')).state).toBe('awaiting_teacher_details');
  });

  test('someone else\'s observation is refused; an already-sent report says so', async () => {
    await handleObserveInteractive(coach(), FROM, 'observe_send_start_other-coach');
    expect(sent().pop()).toMatch(/isn't yours/);
    await handleObserveInteractive(coach(), FROM, 'observe_send_start_sent-1');
    expect(sent().pop()).toMatch(/already been sent/);
    expect(Queue.queueObserveTeacherReport).not.toHaveBeenCalled();
  });
});

describe('the preview buttons', () => {
  test('Send now queues delivery of THAT preview and clears the state', async () => {
    session('bound-1').analysis_data = { teacher_delivery: { status: 'awaiting_confirm', preview_id: 'a1b2c3d4e5f6', teacher_phone: 'mtx:15550100002', report_kind: 'text' } };
    await ObserveState.setState('coach-1', 'awaiting_send_confirm', { sessionId: 'bound-1' });
    await handleObserveInteractive(coach(), FROM, 'observe_send_confirm_bound-1.a1b2c3d4e5f6');
    expect(Queue.queueObserveTeacherReport).toHaveBeenCalledWith('bound-1',
      { phase: 'deliver', from: FROM, previewId: 'a1b2c3d4e5f6', dedupNonce: 'a1b2c3d4e5f6-0' });
    expect(sent().pop()).toMatch(/Sending the report/);
    expect(await ObserveState.getState('coach-1')).toBeNull();
  });

  test('Cancel records it and sends nothing', async () => {
    await handleObserveInteractive(coach(), FROM, 'observe_send_cancel_bound-1');
    expect(delivery('bound-1').status).toBe('cancelled');
    expect(Queue.queueObserveTeacherReport).not.toHaveBeenCalled();
    expect(sent().pop()).toMatch(/nothing was sent/);
  });

  test('Someone else re-opens the pick for the same session; Later just acknowledges', async () => {
    await handleObserveInteractive(coach(), FROM, 'observe_send_other_bound-1');
    expect((await ObserveState.getState('coach-1'))).toMatchObject({ state: 'awaiting_teacher_pick', sessionId: 'bound-1' });
    await handleObserveInteractive(coach(), FROM, 'observe_send_later_bound-1');
    expect(sent().pop()).toMatch(/No problem/);
  });
});

describe('parseTeacherDetails — no country rules, 7 to 15 digits', () => {
  test.each([
    ['Sam Taylor, +1 555 010 0123', { name: 'Sam Taylor', phone: '15550100123' }],
    ['(555) 010-0123 Alex Kim', { name: 'Alex Kim', phone: '5550100123' }],
    ['Kim Ng\n+44 20 7946 0958', { name: 'Kim Ng', phone: '442079460958' }],
  ])('%j', (text, expected) => {
    expect(ObserveSend.parseTeacherDetails(text)).toEqual(expected);
  });

  test.each([['Sam 12345'], ['+1 555 010 0123'], ['Sam 1234567890123456'], ['']])('rejects %j', (text) => {
    expect(ObserveSend.parseTeacherDetails(text)).toBeNull();
  });
});
