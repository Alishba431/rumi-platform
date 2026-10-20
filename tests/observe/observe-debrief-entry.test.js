/**
 * The guided debrief — the coach-facing entry side.
 *
 *  - After the form: "Debrief now / Later" (ids observe_debrief_now_<id>,
 *    observe_debrief_later_<id>), routed through observe-interactive.handler.
 *  - "Debrief now" builds the six-step guide from the coach-EDITED analysis via
 *    one JSON completion, validates it in code, falls back to the scaffold on
 *    any failure, sends it with the recording instruction, and arms
 *    awaiting_debrief_audio with a snapshot of the guide.
 *  - Refusals: someone else's observation, a cancelled one, one already done.
 *  - The coach's next recording is routed (observe-audio-router) to
 *    startDebriefFromAudio, which resets the debrief artefacts, queues the
 *    dedicated observe_debrief job — never the lesson transcription job, which
 *    would overwrite the lesson transcript — acks and clears the state.
 *  - The pending lists S4 builds the /observe worklist from.
 */

jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
const { createFakeSupabase } = require('./_helpers/fake-supabase');
const mockDb = createFakeSupabase({ coaching_sessions: [], users: [], observation_schedules: [], chat_sessions: [] });
jest.mock('../../bot/shared/config/supabase', () => mockDb.client);

const mockRedis = new Map();
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  setexWithCeiling: jest.fn(async (k, _ttl, v) => { mockRedis.set(k, v); return true; }),
  get: jest.fn(async (k) => { const v = mockRedis.get(k); if (v === undefined) return null; try { return JSON.parse(v); } catch (_) { return v; } }),
  delete: jest.fn(async (k) => { mockRedis.delete(k); return true; }),
  setNX: jest.fn(async () => true),
}));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn(async () => true),
  sendInteractiveButtons: jest.fn(async () => true),
  sendInteractiveMessage: jest.fn(async () => true),
  getMediaInfo: jest.fn(async () => ({ file_size: 100 })),
  downloadMedia: jest.fn(async () => Buffer.from('x')),
}));
const mockComplete = jest.fn();
jest.mock('../../bot/shared/services/gpt5-mini.service', () => ({ completeJson: (...a) => mockComplete(...a) }));
const mockQueue = { queueObserveDebrief: jest.fn(async () => 'job-1'), queueTranscription: jest.fn() };
jest.mock('../../bot/shared/services/coaching/coaching-job-queue.service', () => mockQueue);

const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const ObserveDebrief = require('../../bot/shared/services/observe/observe-debrief.service');
const ObserveState = require('../../bot/shared/services/observe/observe-state.service');
const { handleObserveInteractive } = require('../../bot/shared/handlers/observe-interactive.handler');
const { routeLeaderAudio } = require('../../bot/shared/services/observe/observe-audio-router');
const { observeStrings } = require('../../bot/shared/services/observe/observe-strings');

const S = observeStrings('en');
const COACH = { id: 'coach-1', role: 'coach', preferred_language: 'en', phone_number: '15550100001' };
const OTHER = { id: 'coach-2', role: 'coach', preferred_language: 'en', phone_number: '15550100002' };
const FROM = '15550100001';

const LLM_GUIDE = {
  intro: 'Your guide — about fifteen minutes.',
  steps: [
    { n: 1, title: 'Open with intent', body: 'Thank them.', say_this: 'Thank you for having me — I am here so we can grow together.' },
    { n: 2, title: 'Praise with evidence', body: 'One real moment.', say_this: 'I loved how the groups formed when the bell rang.' },
    { n: 3, title: 'One question, then wait', body: 'Then stay silent.', say_this: 'In your own view, how did it go?' },
    { n: 4, title: 'One thing to improve', body: 'As an invitation.', say_this: 'How about asking three children to explain tomorrow?' },
    { n: 5, title: 'Their own if-then', body: 'Their words.', say_this: 'When exactly will you try it?' },
    { n: 6, title: 'Agree the return', body: 'Pick a day.', say_this: 'When shall we look again together?' },
  ],
  outro: 'No number to hand over.',
};

function seedSession(over = {}) {
  const row = {
    id: 'obs-1', user_id: 'teacher-1', observer_user_id: COACH.id, observation_type: 'leader_observation',
    status: 'observer_review_complete', debrief_status: 'pending', created_at: '2026-09-01T09:00:00Z',
    analysis_data: {
      scores: { overall: 40 },
      strengths: [{ title: 'Routines', evidence: 'The groups formed in under a minute.' }],
      focus_area: { title: 'Checking understanding', try: 'Ask three children to explain.' },
      observer_edit_summary: { changed: 2 },
    },
    ...over,
  };
  mockDb.tables.coaching_sessions.push(row);
  return row;
}

const sent = () => WhatsAppService.sendMessage.mock.calls.map((c) => c[1]);

beforeEach(() => {
  jest.clearAllMocks();
  mockRedis.clear();
  mockDb.tables.coaching_sessions.length = 0;
  mockDb.tables.users.length = 0;
  mockDb.tables.observation_schedules.length = 0;
  process.env.OBSERVE_ENABLED = 'true';
  mockComplete.mockResolvedValue({ result: JSON.parse(JSON.stringify(LLM_GUIDE)), usage: {} });
});

describe('offerDebriefChoice', () => {
  test('sends "Debrief now / Later" with session-scoped ids that fit the 20-char cap', async () => {
    await ObserveDebrief.offerDebriefChoice(COACH, FROM, 'obs-1');
    const [to, payload] = WhatsAppService.sendInteractiveButtons.mock.calls[0];
    expect(to).toBe(FROM);
    expect(payload.body).toBe(S.debrief_choice_body);
    expect(payload.buttons.map((b) => b.id)).toEqual(['observe_debrief_now_obs-1', 'observe_debrief_later_obs-1']);
    for (const b of payload.buttons) expect(b.title.length).toBeLessThanOrEqual(20);
  });

  test('id parsing: buttons and list rows never collide', () => {
    expect(ObserveDebrief.parseDebriefButtonId('observe_debrief_now_abc')).toEqual({ action: 'now', sessionId: 'abc' });
    expect(ObserveDebrief.parseDebriefButtonId('observe_debrief_later_abc')).toEqual({ action: 'later', sessionId: 'abc' });
    expect(ObserveDebrief.parseDebriefListReplyId('observe_debrief_abc')).toEqual({ action: 'debrief', sessionId: 'abc' });
    expect(ObserveDebrief.parseDebriefListReplyId('observe_debrief_now_abc')).toBeNull();
    expect(ObserveDebrief.parseDebriefButtonId(null)).toBeNull();
  });
});

describe('the taps, through observe-interactive.handler', () => {
  test('"Later" acknowledges and leaves the debrief pending', async () => {
    seedSession();
    expect(await handleObserveInteractive(COACH, FROM, 'observe_debrief_later_obs-1')).toBe(true);
    expect(sent()).toEqual([S.debrief_later_ack]);
    expect(mockDb.tables.coaching_sessions[0].debrief_status).toBe('pending');
  });

  test('"Later" on a debrief already done says so', async () => {
    seedSession({ debrief_status: 'done' });
    await handleObserveInteractive(COACH, FROM, 'observe_debrief_later_obs-1');
    expect(sent()).toEqual([S.debrief_already_done]);
  });

  test('"Debrief now" builds the guide from the EDITED analysis, without scores, and arms the recording', async () => {
    seedSession();
    expect(await handleObserveInteractive(COACH, FROM, 'observe_debrief_now_obs-1')).toBe(true);
    const [prompt, opts] = mockComplete.mock.calls[0];
    expect(prompt).toContain('The groups formed in under a minute.');
    expect(prompt).not.toContain('"overall"');
    expect(prompt).not.toContain('observer_edit_summary');
    expect(opts.label).toBe('observeDebriefGuide');
    const msgs = sent();
    expect(msgs[0]).toContain('I loved how the groups formed when the bell rang.');
    expect(msgs[1]).toBe(S.debrief_record_instruction);
    const st = await ObserveState.getState(COACH.id);
    expect(st.state).toBe('awaiting_debrief_audio');
    expect(st.sessionId).toBe('obs-1');
    expect(st.guide_snapshot.steps).toHaveLength(6);
  });

  test('a pending-list row (observe_debrief_<id>) starts the same debrief', async () => {
    seedSession();
    await handleObserveInteractive(COACH, FROM, 'observe_debrief_obs-1');
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect((await ObserveState.getState(COACH.id)).state).toBe('awaiting_debrief_audio');
  });
});

describe('startDebrief', () => {
  test('an invalid LLM guide (a leaked score) falls back to the scaffold — never guideless', async () => {
    seedSession();
    const bad = JSON.parse(JSON.stringify(LLM_GUIDE));
    bad.steps[1].body = 'You scored 40/60.';
    mockComplete.mockResolvedValueOnce({ result: bad, usage: {} });
    await ObserveDebrief.startDebrief('obs-1', FROM, COACH);
    const guideMsg = sent()[0];
    expect(guideMsg).not.toMatch(/40\/60/);
    expect(guideMsg).toContain('The groups formed in under a minute.');
    expect(guideMsg).toContain(S.guide_fb_intro);
  });

  test('an LLM error falls back too', async () => {
    seedSession();
    mockComplete.mockRejectedValueOnce(new Error('provider down'));
    await ObserveDebrief.startDebrief('obs-1', FROM, COACH);
    expect(sent()[0]).toContain(S.guide_fb_intro);
    expect((await ObserveState.getState(COACH.id)).state).toBe('awaiting_debrief_audio');
  });

  test('ownership: another coach cannot open it', async () => {
    seedSession();
    await ObserveDebrief.startDebrief('obs-1', OTHER.phone_number, OTHER);
    expect(sent()).toEqual([S.debrief_not_yours]);
    expect(mockComplete).not.toHaveBeenCalled();
    expect(await ObserveState.getState(OTHER.id)).toBeNull();
  });

  test('a cancelled observation is refused', async () => {
    seedSession({ status: 'cancelled' });
    await ObserveDebrief.startDebrief('obs-1', FROM, COACH);
    expect(sent()).toEqual([S.debrief_cancelled]);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  test('a debrief already done is not rebuilt', async () => {
    seedSession({ debrief_status: 'done' });
    await ObserveDebrief.startDebrief('obs-1', FROM, COACH);
    expect(sent()).toEqual([S.debrief_already_done]);
  });

  test('an unknown session gets the load error', async () => {
    await ObserveDebrief.startDebrief('nope', FROM, COACH);
    expect(sent()).toEqual([S.debrief_load_error]);
  });

  test('a double tap re-sends the stored guide without a second LLM call', async () => {
    seedSession();
    await ObserveDebrief.startDebrief('obs-1', FROM, COACH);
    WhatsAppService.sendMessage.mockClear();
    await ObserveDebrief.startDebrief('obs-1', FROM, COACH);
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(sent()[0]).toContain('I loved how the groups formed');
    expect(sent()[1]).toBe(S.debrief_record_instruction);
  });
});

describe('the debrief recording', () => {
  test('the router hands an armed coach\'s audio (any length) to startDebriefFromAudio', async () => {
    seedSession();
    await ObserveState.setState(COACH.id, 'awaiting_debrief_audio', { sessionId: 'obs-1', guide_snapshot: LLM_GUIDE });
    const handled = await routeLeaderAudio({
      user: COACH, from: FROM, audioId: 'media-9', sessionId: 'chat-1', durationSeconds: 240, mimeType: 'audio/aac',
    });
    expect(handled).toBe(true);
    expect(mockQueue.queueObserveDebrief).toHaveBeenCalledWith('obs-1', { from: FROM, audioId: 'media-9', mimeType: 'audio/aac' });
    expect(mockQueue.queueTranscription).not.toHaveBeenCalled();
  });

  test('startDebriefFromAudio resets the artefacts, keeps the rest of analysis_data, acks and clears state', async () => {
    seedSession({
      analysis_data: {
        strengths: [{ evidence: 'kept' }],
        observer_debrief: { transcript: 'stale', feedback: { old: true }, opening_sent_at: '2026-09-01T09:00:00Z', attempts: 4, error_class: 'media_gone', keep_me: 1 },
      },
    });
    await ObserveState.setState(COACH.id, 'awaiting_debrief_audio', { sessionId: 'obs-1', guide_snapshot: LLM_GUIDE });
    const st = await ObserveState.getState(COACH.id);
    await ObserveDebrief.startDebriefFromAudio(COACH, FROM, 'media-9', st, { mimeType: 'audio/ogg' });
    const ad = mockDb.tables.coaching_sessions[0].analysis_data;
    expect(ad.strengths).toEqual([{ evidence: 'kept' }]);
    expect(ad.observer_debrief).toMatchObject({
      audio_id: 'media-9', audio_mime: 'audio/ogg', transcript: null, feedback: null, opening_sent_at: null, attempts: 0, error_class: null, keep_me: 1,
    });
    expect(ad.observer_debrief.guide_snapshot.steps).toHaveLength(6);
    expect(sent()).toEqual([S.debrief_audio_received]);
    expect(await ObserveState.getState(COACH.id)).toBeNull();
  });

  test('a state with no session id gets the load error and nothing is queued', async () => {
    await ObserveDebrief.startDebriefFromAudio(COACH, FROM, 'media-9', { state: 'awaiting_debrief_audio' }, {});
    expect(sent()).toEqual([S.debrief_load_error]);
    expect(mockQueue.queueObserveDebrief).not.toHaveBeenCalled();
  });

  test('a queue failure tells the coach and keeps the state armed', async () => {
    seedSession();
    await ObserveState.setState(COACH.id, 'awaiting_debrief_audio', { sessionId: 'obs-1' });
    mockQueue.queueObserveDebrief.mockRejectedValueOnce(new Error('queue down'));
    await ObserveDebrief.startDebriefFromAudio(COACH, FROM, 'media-9', await ObserveState.getState(COACH.id), {});
    expect(sent()).toEqual([S.debrief_feedback_failed]);
    expect((await ObserveState.getState(COACH.id)).state).toBe('awaiting_debrief_audio');
  });

  test('armDebriefAudio never overwrites a live debrief for ANOTHER session', async () => {
    await ObserveState.setState(COACH.id, 'awaiting_debrief_audio', { sessionId: 'obs-A' });
    expect(await ObserveDebrief.armDebriefAudio(COACH.id, 'obs-B', null)).toBe(false);
    expect((await ObserveState.getState(COACH.id)).sessionId).toBe('obs-A');
    expect(await ObserveDebrief.armDebriefAudio(COACH.id, 'obs-A', null)).toBe(true);
    expect(await ObserveDebrief.clearStateAfterSubmit(COACH.id, 'obs-B')).toBe(false);
    expect(await ObserveDebrief.clearStateAfterSubmit(COACH.id, 'obs-A')).toBe(true);
  });
});

describe('the pending lists (for the /observe worklist)', () => {
  beforeEach(() => {
    const base = { observer_user_id: COACH.id, observation_type: 'leader_observation', analysis_data: {} };
    mockDb.tables.coaching_sessions.push(
      { ...base, id: 'p1', user_id: 'teacher-1', status: 'observer_review_complete', debrief_status: 'pending', created_at: '2026-09-02T10:00:00Z' },
      { ...base, id: 'p2', user_id: COACH.id, status: 'observer_review_complete', debrief_status: 'pending', created_at: '2026-09-03T10:00:00Z' },
      { ...base, id: 'u1', user_id: 'teacher-1', status: 'observer_review_complete', debrief_status: 'done', created_at: '2026-09-01T10:00:00Z', analysis_data: { teacher_delivery: { status: 'send_failed', teacher_name: 'Alex Doe' } } },
      { ...base, id: 'u2', user_id: 'teacher-1', status: 'observer_review_complete', debrief_status: 'done', created_at: '2026-09-01T11:00:00Z', analysis_data: { teacher_delivery: { status: 'sent' } } },
      { ...base, id: 'a1', user_id: COACH.id, status: 'awaiting_observer_review', debrief_status: 'pending', created_at: '2026-09-04T10:00:00Z', updated_at: '2026-09-04T10:00:00Z' },
      { ...base, id: 'a2', user_id: COACH.id, status: 'failed', debrief_status: 'pending', created_at: '2026-09-04T11:00:00Z' },
      { ...base, id: 'c1', user_id: COACH.id, status: 'cancelled', debrief_status: 'pending', created_at: '2026-09-05T10:00:00Z' },
      { ...base, id: 'x1', observer_user_id: OTHER.id, user_id: OTHER.id, status: 'observer_review_complete', debrief_status: 'pending', created_at: '2026-09-05T10:00:00Z' },
    );
    mockDb.tables.users.push({ id: 'teacher-1', name: 'Jordan Lee', phone_number: '15550100009' });
    mockDb.tables.observation_schedules.push({ session_id: 'p1', teacher_name: 'Robin Park', school_name: 'Hill School' });
  });

  test('listPendingDebriefs: this coach\'s form-complete, debrief-pending rows, newest first, named', async () => {
    const rows = await ObserveDebrief.listPendingDebriefs(COACH.id);
    expect(rows.map((r) => r.id)).toEqual(['p2', 'p1']);
    expect(rows[1].teacher_name).toBe('Robin Park');
    expect(rows[0].teacher_name).toBeUndefined();   // unbound: never labelled with the coach's own name
  });

  test('listUnsentReports: debrief done, report not delivered', async () => {
    const rows = await ObserveDebrief.listUnsentReports(COACH.id);
    expect(rows.map((r) => r.id)).toEqual(['u1']);
    expect(rows[0].delivery_status).toBe('send_failed');
    expect(ObserveDebrief.sendReportRowMeta(rows[0])).toMatch(/send failed/);
  });

  test('listUnfinished: before the form, each with how a tap resumes it; terminal rows never appear', async () => {
    const rows = await ObserveDebrief.listUnfinished(COACH.id);
    expect(rows.map((r) => [r.id, r.resume])).toEqual([['a2', 'retry'], ['a1', 'form']]);
  });

  test('a users-row name is used for a bound row with no schedule — never a phone number', async () => {
    mockDb.tables.observation_schedules.length = 0;
    const rows = await ObserveDebrief.listPendingDebriefs(COACH.id);
    expect(rows.find((r) => r.id === 'p1').teacher_name).toBe('Jordan Lee');
  });

  test('countPending counts debriefs + unsent reports', async () => {
    expect(await ObserveDebrief.countPending(COACH.id)).toBe(3);
  });
});
