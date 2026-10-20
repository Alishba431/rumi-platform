/**
 * Keeping the coach organised — entirely in chat.
 *
 * /observe opens ONE numbered list: pending work (oldest first, every row
 * resumes exactly its own step) then New observation / My schedule / Plan a
 * visit. The visit picker goes school → teacher → brief → armed recording with
 * the teacher bound; Plan a visit goes school → teacher → day; My schedule
 * lists upcoming visits (overdue first) and each one can be started, moved or
 * cancelled. The same ids come back from a native list tap (Meta) or a typed
 * number (pending-options), so nothing here is channel-specific.
 *
 * Faked: the database, Redis, the channel facade, the job queue, and the
 * not-yet-merged sibling slices (debrief + send) as virtual modules.
 */

const { createFakeSupabase } = require('./_helpers/fake-supabase');

const teachersAtHill = Array.from({ length: 11 }, (_, i) => ({
  id: `t-${String(i + 1).padStart(2, '0')}`,
  name: `Teacher ${String(i + 1).padStart(2, '0')}`,
  phone_number: `155501001${String(i + 1).padStart(2, '0')}`,
  school_id: 'school-1',
  role: 'teacher',
}));

const mockDb = createFakeSupabase({
  users: [
    { id: 'coach-1', role: 'coach', preferred_language: 'en', preferences: { observe_onboarded: true }, phone_number: '15550100001' },
    { id: 'coach-2', role: 'coach', preferred_language: 'en', preferences: { observe_onboarded: true }, phone_number: '15550100002' },
    ...teachersAtHill,
    { id: 't-river', name: 'Rio Lane', phone_number: 'mtx:15550100300', school_id: 'school-2', role: 'teacher' },
  ],
  schools: [{ id: 'school-1', ext_id: 'SCH-1', name: 'Hill School' }, { id: 'school-2', ext_id: null, name: 'River School' }],
  leader_schools: [
    { id: 'ls-1', leader_user_id: 'coach-1', school_id: 'school-1', school_ext_id: 'SCH-1', school_name: 'Hill School' },
    { id: 'ls-2', leader_user_id: 'coach-1', school_id: 'school-2', school_ext_id: null, school_name: 'River School' },
  ],
  observation_schedules: [],
  coaching_sessions: [{
    id: 'prev-1', user_id: 't-01', observer_user_id: 'coach-1', observation_type: 'leader_observation', status: 'observer_review_complete',
    created_at: '2026-09-01T09:00:00Z',
    analysis_data: { overall_percentage: 62.5, focus_area: { title: 'Wait time after questions', try: 'Count to five before taking an answer' }, strengths: [{ title: 'Warm greetings at the door' }] },
  }],
});
jest.mock('../../bot/shared/config/supabase', () => mockDb.client);
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
const mockRedis = new Map();
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  setexWithCeiling: jest.fn(async (k, ttl, v) => { mockRedis.set(k, v); return true; }),
  get: jest.fn(async (k) => { if (!mockRedis.has(k)) return null; try { return JSON.parse(mockRedis.get(k)); } catch (_) { return mockRedis.get(k); } }),
  setNX: jest.fn(async (k, v) => { if (mockRedis.has(k)) return false; mockRedis.set(k, v); return true; }),
  delete: jest.fn(async (k) => mockRedis.delete(k)),
}));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn(async () => true),
  sendInteractiveButtons: jest.fn(async () => true),
  sendInteractiveMessage: jest.fn(async () => true),
  getMediaInfo: jest.fn(async () => ({ file_size: 100 })),
  downloadMedia: jest.fn(async () => Buffer.from('x')),
}));
jest.mock('../../bot/shared/services/coaching/coaching-job-queue.service', () => ({
  queueTranscription: jest.fn(async () => true),
  queueAnalysis: jest.fn(async () => true),
}));
const mockPending = { debriefs: [], unsent: [], unfinished: [] };
// The neighbouring steps (debrief, send, ratings form) have their own suites;
// here only their hand-off contract is faked.
const mockDebrief = {
  listPendingDebriefs: jest.fn(async () => mockPending.debriefs),
  listUnsentReports: jest.fn(async () => mockPending.unsent),
  listUnfinished: jest.fn(async () => mockPending.unfinished),
  offerDebriefChoice: jest.fn(async () => true),
  startDebriefFromAudio: jest.fn(async () => true),
};
const mockSend = { offerSendReport: jest.fn(async () => true), DETAILS_TEXT_STATES: ['awaiting_teacher_details', 'awaiting_teacher_pick'] };
const mockForm = { resume: jest.fn(async () => true), handleText: jest.fn(async () => false) };
jest.mock('../../bot/shared/services/observe/observe-debrief.service', () => mockDebrief);
jest.mock('../../bot/shared/services/observe/observe-send.service', () => mockSend);
jest.mock('../../bot/shared/services/observe/observe-form.service', () => mockForm);

const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const Queue = require('../../bot/shared/services/coaching/coaching-job-queue.service');
const Debrief = mockDebrief;
const Send = mockSend;
const Form = mockForm;
const ObserveState = require('../../bot/shared/services/observe/observe-state.service');
const { handleObserveCommand, handleObserveText } = require('../../bot/shared/handlers/observe-command.handler');
const { handleObserveInteractive } = require('../../bot/shared/handlers/observe-interactive.handler');
const { routeLeaderAudio } = require('../../bot/shared/services/observe/observe-audio-router');

const FROM = '15550100001';
const coach = () => mockDb.tables.users.find((u) => u.id === 'coach-1');
const lastList = () => {
  const calls = WhatsAppService.sendInteractiveMessage.mock.calls;
  return calls.length ? calls[calls.length - 1][1] : null;
};
const rowsOf = (payload) => payload.action.sections.flatMap((s) => s.rows);
const lastText = () => {
  const calls = WhatsAppService.sendMessage.mock.calls;
  return calls.length ? calls[calls.length - 1][1] : '';
};
const allText = () => WhatsAppService.sendMessage.mock.calls.map((c) => c[1]).join('\n');
const tap = (id, user = coach()) => handleObserveInteractive(user, FROM, id);

function checkListLimits(payload) {
  const rows = rowsOf(payload);
  expect(rows.length).toBeLessThanOrEqual(10);
  for (const r of rows) {
    expect(r.id).toMatch(/^observe_/);
    expect(r.title.length).toBeLessThanOrEqual(24);
    expect((r.description || '').length).toBeLessThanOrEqual(72);
  }
  expect(payload.action.button.length).toBeLessThanOrEqual(20);
}

beforeAll(() => {
  jest.useFakeTimers({ now: new Date('2026-10-02T08:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] });
});
afterAll(() => jest.useRealTimers());

beforeEach(() => {
  jest.clearAllMocks();
  mockRedis.clear();
  mockPending.debriefs = []; mockPending.unsent = []; mockPending.unfinished = [];
  mockDb.tables.observation_schedules.length = 0;
  mockDb.tables.coaching_sessions = mockDb.tables.coaching_sessions.filter((s) => s.id === 'prev-1' || s.id.startsWith('obs-'));
  process.env.OBSERVE_ENABLED = 'true';
  delete process.env.OBSERVE_SCHOOL_DAYS;
});

describe('/observe menu', () => {
  test('no pending work + a roster: New observation, My schedule, Plan a visit — nothing armed', async () => {
    expect(await handleObserveCommand(coach(), FROM, '/observe')).toBe(true);
    const payload = lastList();
    checkListLimits(payload);
    expect(rowsOf(payload).map((r) => r.id)).toEqual(['observe_menu_new', 'observe_menu_sched', 'observe_menu_plan']);
    expect(await ObserveState.getState('coach-1')).toBeNull();
  });

  test('no roster and no pending work: the bare capture prompt, unchanged', async () => {
    const other = mockDb.tables.users.find((u) => u.id === 'coach-2');
    expect(await handleObserveCommand(other, '15550100002', '/observe')).toBe(true);
    expect(WhatsAppService.sendInteractiveMessage).not.toHaveBeenCalled();
    expect(lastText()).toMatch(/record the lesson on your phone/);
    expect((await ObserveState.getState('coach-2')).state).toBe('awaiting_audio');
  });

  test('pending work comes first, OLDEST at the top, then the three actions', async () => {
    mockPending.unfinished = [{ id: 'obs-u', status: 'failed', created_at: '2026-09-20T10:00:00Z', updated_at: '2026-09-20T10:00:00Z', teacher_name: 'Ana Fox', resume: 'retry' }];
    mockPending.debriefs = [{ id: 'obs-d', created_at: '2026-09-25T10:00:00Z', teacher_name: 'Ben Ode' }];
    mockPending.unsent = [{ id: 'obs-s', created_at: '2026-09-10T10:00:00Z', analysis_data: { teacher_delivery: { teacher_name: 'Cy Moe' } } }];
    await handleObserveCommand(coach(), FROM, '/observe');
    const payload = lastList();
    checkListLimits(payload);
    expect(payload.body).toMatch(/oldest is at the top/);
    expect(rowsOf(payload).map((r) => r.id)).toEqual([
      'observe_pend_send_obs-s', 'observe_pend_resume_obs-u', 'observe_pend_debrief_obs-d',
      'observe_menu_new', 'observe_menu_sched', 'observe_menu_plan',
    ]);
    expect(rowsOf(payload)[0].title).toMatch(/Cy Moe/);
  });

  test('every row in the menu has a dispatch branch that resumes exactly its step', async () => {
    mockDb.tables.coaching_sessions.push({ id: 'obs-u', observer_user_id: 'coach-1', user_id: 'coach-1', observation_type: 'leader_observation', status: 'failed', audio_id: 'm-u', created_at: '2026-09-20T10:00:00Z', updated_at: '2026-09-20T10:00:00Z', analysis_data: {} });
    mockPending.unfinished = [{ id: 'obs-u', status: 'failed', created_at: '2026-09-20T10:00:00Z', resume: 'retry' }];
    mockPending.debriefs = [{ id: 'obs-d', created_at: '2026-09-25T10:00:00Z' }];
    mockPending.unsent = [{ id: 'obs-s', created_at: '2026-09-10T10:00:00Z' }];
    await handleObserveCommand(coach(), FROM, '/observe');
    for (const row of rowsOf(lastList())) {
      jest.clearAllMocks();
      expect(await tap(row.id)).toBe(true);
      const said = WhatsAppService.sendMessage.mock.calls.length + WhatsAppService.sendInteractiveMessage.mock.calls.length
        + WhatsAppService.sendInteractiveButtons.mock.calls.length + Debrief.offerDebriefChoice.mock.calls.length
        + Send.offerSendReport.mock.calls.length;
      expect(said).toBeGreaterThan(0);
    }
    jest.clearAllMocks();
    await tap('observe_pend_debrief_obs-d');
    expect(Debrief.offerDebriefChoice).toHaveBeenCalledWith(coach(), FROM, 'obs-d');
    await tap('observe_pend_send_obs-s');
    expect(Send.offerSendReport).toHaveBeenCalledWith(coach(), FROM, 'obs-s');
  });

  test('a stopped observation resumes with "run it again"; the retry re-queues once and is bounded', async () => {
    mockDb.tables.coaching_sessions.push({ id: 'obs-r', observer_user_id: 'coach-1', user_id: 'coach-1', observation_type: 'leader_observation', status: 'failed', audio_id: 'm-r', transcript_text: null, created_at: '2026-09-20T10:00:00Z', updated_at: '2026-09-20T10:00:00Z', analysis_data: {} });
    await tap('observe_pend_resume_obs-r');
    const btns = WhatsAppService.sendInteractiveButtons.mock.calls[0][1].buttons.map((b) => b.id);
    expect(btns).toEqual(['observe_retry_obs-r', 'observe_cancel_obs-r']);
    await tap('observe_retry_obs-r');
    expect(Queue.queueTranscription).toHaveBeenCalledWith('obs-r', { from: FROM, audioId: 'm-r' });
    const row = mockDb.tables.coaching_sessions.find((s) => s.id === 'obs-r');
    expect(row.status).toBe('confirmed');
    expect(row.analysis_data.observe_retry_count).toBe(1);
    // A second tap on the same button finds the row already moved on — nothing queued twice.
    await tap('observe_retry_obs-r');
    expect(Queue.queueTranscription).toHaveBeenCalledTimes(1);
    row.status = 'failed'; row.analysis_data.observe_retry_count = 2;
    await tap('observe_retry_obs-r');
    expect(Queue.queueTranscription).toHaveBeenCalledTimes(1);
    expect(lastText()).toMatch(/as many times as I can/);
  });

  test('a session with a transcript retries from analysis; a form-stage one re-opens the form; a fresh one says wait', async () => {
    mockDb.tables.coaching_sessions.push(
      { id: 'obs-a', observer_user_id: 'coach-1', user_id: 'coach-1', observation_type: 'leader_observation', status: 'failed', transcript_text: 'hello class', created_at: '2026-09-20T10:00:00Z', updated_at: '2026-09-20T10:00:00Z', analysis_data: {} },
      { id: 'obs-f', observer_user_id: 'coach-1', user_id: 'coach-1', observation_type: 'leader_observation', status: 'awaiting_observer_review', created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z', analysis_data: {} },
      { id: 'obs-w', observer_user_id: 'coach-1', user_id: 'coach-1', observation_type: 'leader_observation', status: 'analyzing', created_at: '2026-10-02T07:50:00Z', updated_at: '2026-10-02T07:55:00Z', analysis_data: {} },
      { id: 'obs-x', observer_user_id: 'coach-2', user_id: 'coach-2', observation_type: 'leader_observation', status: 'failed', created_at: '2026-10-02T07:50:00Z', analysis_data: {} },
    );
    await tap('observe_retry_obs-a');
    expect(Queue.queueAnalysis).toHaveBeenCalledWith('obs-a', expect.objectContaining({ from: FROM }));
    await tap('observe_pend_resume_obs-f');
    expect(Form.resume).toHaveBeenCalledWith(coach(), FROM, 'obs-f');
    await tap('observe_pend_resume_obs-w');
    expect(lastText()).toMatch(/Still working/);
    await tap('observe_pend_resume_obs-x');
    expect(lastText()).toMatch(/isn't yours/);
  });

  test('more than seven pending items: a More… row pages through, the actions stay', async () => {
    mockPending.debriefs = Array.from({ length: 9 }, (_, i) => ({ id: `obs-p${i}`, created_at: `2026-09-${String(10 + i).padStart(2, '0')}T10:00:00Z`, teacher_name: `T${i}` }));
    await handleObserveCommand(coach(), FROM, '/observe');
    const first = rowsOf(lastList()).map((r) => r.id);
    checkListLimits(lastList());
    expect(first.slice(0, 6)).toEqual(['observe_pend_debrief_obs-p0', 'observe_pend_debrief_obs-p1', 'observe_pend_debrief_obs-p2', 'observe_pend_debrief_obs-p3', 'observe_pend_debrief_obs-p4', 'observe_pend_debrief_obs-p5']);
    expect(first).toContain('observe_menu_more_1');
    expect(first.slice(-3)).toEqual(['observe_menu_new', 'observe_menu_sched', 'observe_menu_plan']);
    await tap('observe_menu_more_1');
    const second = rowsOf(lastList()).map((r) => r.id);
    expect(second.slice(0, 3)).toEqual(['observe_pend_debrief_obs-p6', 'observe_pend_debrief_obs-p7', 'observe_pend_debrief_obs-p8']);
    expect(second).not.toContain('observe_menu_more_2');
  });

  test('/observe clears a stale armed recording slot so an old pick never binds a new lesson', async () => {
    await ObserveState.setState('coach-1', 'awaiting_audio', { boundTeacher: { user_id: 't-01' } });
    await handleObserveCommand(coach(), FROM, '/observe');
    expect(await ObserveState.getState('coach-1')).toBeNull();
  });
});

describe('visit picker: school → teacher → brief → armed', () => {
  test('New observation lists schools, then that school\'s teachers, with a More… row past nine', async () => {
    await tap('observe_menu_new');
    let payload = lastList();
    checkListLimits(payload);
    expect(rowsOf(payload).map((r) => r.id)).toEqual(['observe_vs_o_school-1', 'observe_vs_o_school-2']);
    await tap('observe_vs_o_school-1');
    payload = lastList();
    checkListLimits(payload);
    const ids = rowsOf(payload).map((r) => r.id);
    expect(ids.slice(0, 8)).toEqual(['observe_vt_o_t-01', 'observe_vt_o_t-02', 'observe_vt_o_t-03', 'observe_vt_o_t-04', 'observe_vt_o_t-05', 'observe_vt_o_t-06', 'observe_vt_o_t-07', 'observe_vt_o_t-08']);
    expect(ids).toContain('observe_vtmore_o_school-1_1');
    expect(ids).toContain('observe_vskip');
    await tap('observe_vtmore_o_school-1_1');
    expect(rowsOf(lastList()).map((r) => r.id).slice(0, 3)).toEqual(['observe_vt_o_t-09', 'observe_vt_o_t-10', 'observe_vt_o_t-11']);
  });

  test('picking a teacher sends the brief (last focus, what to look for, never a score) and binds the recording', async () => {
    await tap('observe_vt_o_t-01');
    const brief = allText();
    expect(brief).toMatch(/Teacher 01/);
    expect(brief).toMatch(/Wait time after questions/);
    expect(brief).toMatch(/Count to five/);
    expect(brief).toMatch(/not a grade/);
    expect(brief).not.toMatch(/62|%/);
    const st = await ObserveState.getState('coach-1');
    expect(st.state).toBe('awaiting_audio');
    expect(st.boundTeacher).toEqual({
      user_id: 't-01', teacher_ext_id: 't-01', school_ext_id: 'SCH-1', school_id: 'school-1', name: 'Teacher 01', phone: '15550100101',
    });
  });

  test('a first visit gets the warm first-visit brief; a school with no ext id is keyed on its own id', async () => {
    await tap('observe_vt_o_t-river');
    expect(allText()).toMatch(/first recorded observation of Rio Lane/);
    const st = await ObserveState.getState('coach-1');
    expect(st.boundTeacher).toMatchObject({ school_ext_id: 'school-2', phone: 'mtx:15550100300' });
  });

  test('a teacher outside the coach\'s roster is refused as stale — ids are never trusted', async () => {
    const other = mockDb.tables.users.find((u) => u.id === 'coach-2');
    await tap('observe_vt_o_t-01', other);
    expect(lastText()).toMatch(/out of date/);
    expect(await ObserveState.getState('coach-2')).toBeNull();
  });

  test('"Not listed — record" arms a bare capture', async () => {
    await tap('observe_vskip');
    expect(lastText()).toMatch(/record the lesson on your phone/);
    expect((await ObserveState.getState('coach-1')).boundTeacher).toBeUndefined();
  });

  test('the picked recording is captured for that teacher', async () => {
    await tap('observe_vt_o_t-02');
    expect(await routeLeaderAudio({ user: coach(), from: FROM, audioId: 'media-77', sessionId: 'chat-1', durationSeconds: 1500 })).toBe(true);
    const row = mockDb.tables.coaching_sessions.find((s) => s.audio_id === 'media-77');
    expect(row).toMatchObject({ user_id: 't-02', observer_user_id: 'coach-1', observation_type: 'leader_observation' });
  });
});

describe('scheduling', () => {
  test('Plan a visit → school → teacher → numbered school days → saved', async () => {
    await tap('observe_menu_plan');
    expect(rowsOf(lastList())[0].id).toBe('observe_vs_p_school-1');
    await tap('observe_vs_p_school-1');
    expect(rowsOf(lastList()).map((r) => r.id)).not.toContain('observe_vskip');
    await tap('observe_vt_p_t-03');
    const payload = lastList();
    checkListLimits(payload);
    const ids = rowsOf(payload).map((r) => r.id);
    // 2026-10-02 is a Friday: Fri, then Mon–Fri of next week.
    expect(ids).toEqual([
      'observe_vd_tt-03_2026-10-02', 'observe_vd_tt-03_2026-10-05', 'observe_vd_tt-03_2026-10-06',
      'observe_vd_tt-03_2026-10-07', 'observe_vd_tt-03_2026-10-08', 'observe_vd_tt-03_2026-10-09',
      'observe_vdtype_tt-03',
    ]);
    await tap('observe_vd_tt-03_2026-10-06');
    expect(lastText()).toMatch(/Saved — you will visit Teacher 03/);
    expect(mockDb.tables.observation_schedules).toEqual([expect.objectContaining({
      leader_user_id: 'coach-1', teacher_ext_id: 't-03', school_ext_id: 'SCH-1', school_id: 'school-1', scheduled_for: '2026-10-06', status: 'upcoming',
    })]);
  });

  test('school days follow OBSERVE_SCHOOL_DAYS (a deployment with a different weekend)', async () => {
    process.env.OBSERVE_SCHOOL_DAYS = '7,1,2,3,4';   // Sunday–Thursday
    await tap('observe_vt_p_t-03');
    const dates = rowsOf(lastList()).map((r) => r.id).filter((id) => id.startsWith('observe_vd_')).map((id) => id.slice(-10));
    expect(dates).toEqual(['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-11']);
  });

  test('"type a date" waits for YYYY-MM-DD; a bad or past date is re-asked; plain chat is let go', async () => {
    await tap('observe_vdtype_tt-04');
    expect(lastText()).toMatch(/YYYY-MM-DD/);
    expect(await handleObserveText(coach(), FROM, '2026-09-01')).toBe(true);
    expect(lastText()).toMatch(/doesn't look like a date/);
    expect(await handleObserveText(coach(), FROM, '2026-02-30')).toBe(true);
    expect(mockDb.tables.observation_schedules).toHaveLength(0);
    expect(await handleObserveText(coach(), FROM, ' 2026-10-20 ')).toBe(true);
    expect(lastText()).toMatch(/Saved — you will visit Teacher 04/);
    expect(mockDb.tables.observation_schedules[0].scheduled_for).toBe('2026-10-20');
    expect(await ObserveState.getState('coach-1')).toBeNull();

    await tap('observe_vdtype_tt-04');
    expect(await handleObserveText(coach(), FROM, 'what time is it')).toBe(false);
    expect(await ObserveState.getState('coach-1')).toBeNull();
  });

  test('My schedule: ascending, overdue flagged; start binds the teacher, move and cancel work', async () => {
    mockDb.tables.observation_schedules.push(
      { id: 'v-late', leader_user_id: 'coach-1', school_id: 'school-1', school_ext_id: 'SCH-1', teacher_ext_id: 't-05', teacher_name: 'Teacher 05', school_name: 'Hill School', scheduled_for: '2026-09-29', status: 'upcoming' },
      { id: 'v-next', leader_user_id: 'coach-1', school_id: 'school-1', school_ext_id: 'SCH-1', teacher_ext_id: 't-06', teacher_name: 'Teacher 06', school_name: 'Hill School', scheduled_for: '2026-10-07', status: 'upcoming' },
      { id: 'v-other', leader_user_id: 'coach-2', school_ext_id: 'SCH-1', teacher_ext_id: 't-07', teacher_name: 'Teacher 07', scheduled_for: '2026-10-03', status: 'upcoming' },
    );
    await handleObserveCommand(coach(), FROM, '/observe');
    expect(rowsOf(lastList()).find((r) => r.id === 'observe_menu_sched').description).toMatch(/2 planned · 1 overdue/);
    await tap('observe_menu_sched');
    const payload = lastList();
    checkListLimits(payload);
    const rows = rowsOf(payload);
    expect(rows.map((r) => r.id)).toEqual(['observe_sched_v-late', 'observe_sched_v-next']);
    expect(`${rows[0].title} ${rows[0].description}`).toMatch(/overdue/);
    expect(`${rows[1].title} ${rows[1].description}`).not.toMatch(/overdue/);

    await tap('observe_sched_v-next');
    expect(WhatsAppService.sendInteractiveButtons.mock.calls[0][1].buttons.map((b) => b.id))
      .toEqual(['observe_sstart_v-next', 'observe_smove_v-next', 'observe_scancel_v-next']);

    await tap('observe_smove_v-next');
    expect(rowsOf(lastList())[0].id).toBe('observe_vd_sv-next_2026-10-02');
    await tap('observe_vd_sv-next_2026-10-08');
    expect(lastText()).toMatch(/Moved/);
    expect(mockDb.tables.observation_schedules.find((r) => r.id === 'v-next').scheduled_for).toBe('2026-10-08');

    await tap('observe_scancel_v-late');
    expect(lastText()).toMatch(/cancelled/);
    expect(mockDb.tables.observation_schedules.find((r) => r.id === 'v-late').status).toBe('cancelled');

    await tap('observe_sstart_v-other');   // someone else's visit
    expect(lastText()).toMatch(/no longer on your schedule/);

    await tap('observe_sstart_v-next');
    expect((await ObserveState.getState('coach-1')).boundTeacher).toMatchObject({ user_id: 't-06', school_ext_id: 'SCH-1' });
  });

  test('integration: a scheduled visit leaves "My schedule" once its recording is captured', async () => {
    await tap('observe_vt_p_t-08');
    await tap('observe_vd_tt-08_2026-10-05');
    await tap('observe_menu_sched');
    const visitRow = rowsOf(lastList())[0];
    expect(visitRow.title).toMatch(/Teacher 08/);
    await tap(visitRow.id.replace('observe_sched_', 'observe_sstart_'));
    expect(await routeLeaderAudio({ user: coach(), from: FROM, audioId: 'media-88', sessionId: 'chat-1', durationSeconds: 1800 })).toBe(true);
    const session = mockDb.tables.coaching_sessions.find((s) => s.audio_id === 'media-88');
    expect(session.user_id).toBe('t-08');
    jest.clearAllMocks();
    await tap('observe_menu_sched');
    expect(WhatsAppService.sendInteractiveMessage).not.toHaveBeenCalled();
    expect(lastText()).toMatch(/no visits planned/);
    expect(mockDb.tables.observation_schedules[0]).toMatchObject({ status: 'done', session_id: session.id });
  });

  test('My schedule pages past ten visits', async () => {
    for (let i = 0; i < 12; i += 1) {
      mockDb.tables.observation_schedules.push({ id: `v-${i}`, leader_user_id: 'coach-1', school_ext_id: 'SCH-1', teacher_ext_id: `t-x${i}`, teacher_name: `T${i}`, scheduled_for: `2026-10-${String(10 + i).padStart(2, '0')}`, status: 'upcoming' });
    }
    await tap('observe_menu_sched');
    const ids = rowsOf(lastList()).map((r) => r.id);
    expect(ids).toHaveLength(10);
    expect(ids[9]).toBe('observe_schedmore_1');
    await tap('observe_schedmore_1');
    expect(rowsOf(lastList()).map((r) => r.id)).toEqual(['observe_sched_v-9', 'observe_sched_v-10', 'observe_sched_v-11']);
  });
});
