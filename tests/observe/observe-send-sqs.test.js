/**
 * The send flow on the default queue driver (SQS), through the real chain:
 * observe-send → coaching-job-queue → queue/index → sqs-queue, with a
 * stateful Redis (the driver's 1-hour idempotency keys) and a mocked aws-sdk.
 *
 * Every distinct coach action must reach the queue — a second preview after
 * "Someone else", a retry after a failed send — while a double tap of the
 * same button in the same state is still deduplicated.
 */

const { mockBotDependency } = require('../_helpers/mock-bot-dependency');
const { createFakeSupabase } = require('./_helpers/fake-supabase');

// The first test pays for a cold resetModules() load of the queue driver.
jest.setTimeout(30000);

const COACH = { id: 'coach-1', role: 'coach', name: 'Robin Coach', preferred_language: 'en' };
const COACH_TO = 'mtx:15550100001';

let sqsSend;
let mockDb;
let ObserveSend;
let state;

function load() {
  jest.resetModules();
  mockDb = createFakeSupabase({
    users: [
      { id: 'coach-1', role: 'coach', name: 'Robin Coach', phone_number: COACH_TO, preferred_language: 'en' },
      { id: 't-1', role: 'teacher', name: 'Sam Taylor', phone_number: 'mtx:15554000002' },
      { id: 't-2', role: 'teacher', name: 'Pat Other', phone_number: 'mtx:15554000099' },
    ],
    coaching_sessions: [{
      id: 'obs-1', user_id: 't-1', observer_user_id: 'coach-1', observation_type: 'leader_observation',
      status: 'observer_review_complete', debrief_status: 'done', analysis_data: {},
    }],
  });
  const store = new Map();
  state = new Map();
  sqsSend = jest.fn(() => ({ promise: () => Promise.resolve({ MessageId: `m${sqsSend.mock.calls.length}` }) }));
  mockBotDependency('aws-sdk', () => ({ config: { update: jest.fn() }, SQS: jest.fn(() => ({ sendMessage: sqsSend })) }));
  jest.doMock('../../bot/shared/config/supabase', () => mockDb.client);
  jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
  jest.doMock('../../bot/shared/utils/structured-logger', () => ({ getCurrentCorrelationId: () => 'c1', logEvent: jest.fn() }));
  jest.doMock('../../bot/shared/services/cache/railway-redis.service', () => ({
    get: jest.fn(async (k) => (store.has(k) ? store.get(k) : null)),
    set: jest.fn(async (k, v) => { store.set(k, v); return true; }),
  }));
  jest.doMock('../../bot/shared/services/whatsapp.service', () => ({
    sendMessage: jest.fn(async () => true),
    sendInteractiveButtons: jest.fn(async () => true),
    sendInteractiveMessage: jest.fn(async () => true),
  }));
  jest.doMock('../../bot/shared/services/observe/observe-state.service', () => ({
    getState: jest.fn(async (u) => state.get(u) || null),
    setState: jest.fn(async (u, s, data) => { state.set(u, { state: s, ...data }); return true; }),
    clearState: jest.fn(async (u) => { state.delete(u); return true; }),
  }));
  jest.doMock('../../bot/shared/services/observe/observe-roster.service', () => ({ listTeachers: async () => [] }));
  process.env.SQS_QUEUE_URL = 'https://sqs/main.fifo';
  delete process.env.QUEUE_DRIVER;
  ObserveSend = require('../../bot/shared/services/observe/observe-send.service');
}

const delivery = () => mockDb.tables.coaching_sessions[0].analysis_data.teacher_delivery || {};
/** The preview the worker would have shown: armed and bound to the current preview id. */
function previewShown() {
  const row = mockDb.tables.coaching_sessions[0];
  row.analysis_data.teacher_delivery = { ...delivery(), status: 'awaiting_confirm', report_kind: 'text', report_text: 'Warm' };
  return ObserveSend.buildSendConfirmButtons('obs-1', 'en', delivery().preview_id).buttons.map((b) => b.id);
}

beforeEach(load);
afterEach(() => { delete process.env.SQS_QUEUE_URL; });

test('teacher A, then "Someone else" → teacher B: the second preview reaches SQS', async () => {
  await ObserveSend.handleSendButton(COACH, COACH_TO, 'observe_send_start_obs-1');
  const [, other] = previewShown();
  await ObserveSend.handleSendButton(COACH, COACH_TO, other);
  await ObserveSend.handleTeacherDetailsText(COACH, COACH_TO, 'Pat Other +1 555 400 0099', state.get('coach-1'));
  expect(sqsSend).toHaveBeenCalledTimes(2);
  expect(sqsSend.mock.calls[0][0].MessageDeduplicationId).not.toBe(sqsSend.mock.calls[1][0].MessageDeduplicationId);
});

test('a send_failed, then Send now: the deliver reaches SQS twice; a double tap in one state is enqueued once', async () => {
  await ObserveSend.handleSendButton(COACH, COACH_TO, 'observe_send_start_obs-1');
  const [confirm] = previewShown();
  expect(sqsSend).toHaveBeenCalledTimes(1);                    // the preview

  await ObserveSend.handleSendButton(COACH, COACH_TO, confirm);
  await ObserveSend.handleSendButton(COACH, COACH_TO, confirm); // double tap
  expect(sqsSend).toHaveBeenCalledTimes(2);

  // the worker's send failed
  await ObserveSend.mergeTeacherDelivery('obs-1', { status: 'send_failed', last_error: 'x', failed_at: '2026-10-02T10:00:00.000Z' });
  await ObserveSend.handleSendButton(COACH, COACH_TO, confirm);
  await ObserveSend.handleSendButton(COACH, COACH_TO, confirm); // double tap of the retry
  expect(sqsSend).toHaveBeenCalledTimes(3);
  expect(sqsSend.mock.calls.slice(1).map((c) => c[0].MessageDeduplicationId)).toEqual([
    expect.stringMatching(/^obs-1-observe_teacher_report-deliver-/),
    expect.stringMatching(/^obs-1-observe_teacher_report-deliver-/),
  ]);
  expect(sqsSend.mock.calls[1][0].MessageDeduplicationId).not.toBe(sqsSend.mock.calls[2][0].MessageDeduplicationId);
});
