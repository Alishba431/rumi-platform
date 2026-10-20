/**
 * An invite the teacher never opened: once the untapped sweep gives up
 * (gave_up_at set, status still awaiting_teacher_tap), the coach is told to
 * "send it again from /observe" (send_gave_up_fo) and the portal lists it
 * under "Send the report". So /observe lists it again, and the send flow starts
 * a new preview instead of answering "no tap yet". An invite still within its
 * life keeps waiting for the tap.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createFakeSupabase } = require('./_helpers/fake-supabase');
const { mockBotDependency } = require('../_helpers/mock-bot-dependency');

const mockTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-gaveup-'));
const mockDb = createFakeSupabase({
  users: [
    { id: 'coach-1', role: 'coach', name: 'Robin Coach', phone_number: '15550100001', preferred_language: 'en' },
    { id: 't-1', role: 'teacher', name: 'Sam Taylor', phone_number: '15554000002' },
  ],
  user_channels: [],
  coaching_sessions: [],
});
jest.mock('../../bot/shared/config/supabase', () => mockDb.client);
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/constants', () => ({ TEMP_DIR: mockTmp }));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn(async () => true),
  sendInteractiveButtons: jest.fn(async () => true),
  sendInteractiveMessage: jest.fn(async () => true),
}));
const mockQueued = [];
jest.mock('../../bot/shared/services/coaching/coaching-job-queue.service', () => ({
  queueObserveTeacherReport: jest.fn(async (id, p) => { mockQueued.push([id, p]); return 'm'; }),
}));
jest.mock('../../bot/shared/services/observe/observe-state.service', () => ({
  getState: jest.fn(async () => null), setState: jest.fn(async () => true), clearState: jest.fn(async () => true),
}));

// bot-only package (the debrief service reaches gpt5-mini): the root CI job runs before bot/node_modules installs
mockBotDependency('jsonrepair', () => ({ jsonrepair: (s) => s }));

const WA = require('../../bot/shared/services/whatsapp.service');
const Send = require('../../bot/shared/services/observe/observe-send.service');
const Debrief = require('../../bot/shared/services/observe/observe-debrief.service');
const { classifyUntappedDelivery } = require('../../bot/shared/services/observe/observe-untapped.service');

const INVITE = {
  status: 'awaiting_teacher_tap', teacher_name: 'Sam Taylor', teacher_phone: '15554000002', teacher_user_id: 't-1',
  template_sent_at: '2026-09-20T10:00:00Z', report_kind: 'text', report_text: 'Warm explanations', preview_id: 'aaaaaa111111',
};
function seed(delivery) {
  mockDb.tables.coaching_sessions.length = 0;
  mockDb.tables.coaching_sessions.push({
    id: 'obs-1', user_id: 't-1', observer_user_id: 'coach-1', observation_type: 'leader_observation',
    status: 'observer_review_complete', debrief_status: 'done', created_at: '2026-09-19T10:00:00Z',
    analysis_data: { teacher_delivery: delivery },
  });
}
const said = () => WA.sendMessage.mock.calls.map((c) => c[1]).join(' | ');
beforeEach(() => { jest.clearAllMocks(); mockQueued.length = 0; });

test('a given-up invite: "Send report" starts a new preview for the bound teacher', async () => {
  seed({ ...INVITE, nudged_at: '2026-09-22T10:00:00Z', gave_up_at: '2026-09-25T10:00:00Z' });
  await Send.startSendFlow('obs-1', '15550100001', { id: 'coach-1', preferred_language: 'en' });
  expect(said()).not.toMatch(/No tap yet/);
  expect(mockQueued).toHaveLength(1);
  expect(mockQueued[0][1]).toMatchObject({ phase: 'preview' });
  expect(mockDb.tables.coaching_sessions[0].analysis_data.teacher_delivery.status).toBe('previewing');
});

test('a given-up invite is listed again under the reports to send, with its own line', async () => {
  seed({ ...INVITE, gave_up_at: '2026-09-25T10:00:00Z' });
  const rows = await Debrief.listUnsentReports('coach-1');
  expect(rows.map((r) => r.id)).toEqual(['obs-1']);
  expect(Debrief.sendReportRowMeta(rows[0])).toMatch(/not opened/i);
});

test('an invite still waiting for the teacher is neither listed nor re-sent', async () => {
  seed({ ...INVITE });
  expect(await Debrief.listUnsentReports('coach-1')).toEqual([]);
  await Send.startSendFlow('obs-1', '15550100001', { id: 'coach-1', preferred_language: 'en' });
  expect(said()).toMatch(/No tap yet/);
  expect(mockQueued).toHaveLength(0);
});

test('the re-sent invite is a fresh invite: chased by the sweeps, not born given-up', async () => {
  seed({ ...INVITE, nudged_at: '2026-09-22T10:00:00Z', nudge_count: 1, gave_up_at: '2026-09-25T10:00:00Z',
    gave_up_reason: 'nudged_no_tap', reminded_at: '2026-09-21T10:00:00Z', reminder_count: 2 });
  await Send.startSendFlow('obs-1', '15550100001', { id: 'coach-1', preferred_language: 'en' });
  const fresh = mockDb.tables.coaching_sessions[0].analysis_data.teacher_delivery;
  expect(fresh).toMatchObject({ nudged_at: null, nudge_count: 0, gave_up_at: null, gave_up_reason: null, reminded_at: null, reminder_count: 0 });

  // the new invite goes out (what the deliver step writes when the window is closed)
  const now = Date.now();
  await Send.mergeTeacherDelivery('obs-1', { status: 'awaiting_teacher_tap', template_sent_at: new Date(now).toISOString() });
  const d = mockDb.tables.coaching_sessions[0].analysis_data.teacher_delivery;
  expect(classifyUntappedDelivery(d, now + 30 * 3600 * 1000).reason).not.toBe('already_gave_up');
  expect(await Debrief.listUnsentReports('coach-1')).toEqual([]);
  WA.sendMessage.mockClear();
  await Send.startSendFlow('obs-1', '15550100001', { id: 'coach-1', preferred_language: 'en' });
  expect(said()).toMatch(/No tap yet/);
});
