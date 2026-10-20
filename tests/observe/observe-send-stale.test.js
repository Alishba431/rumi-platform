/**
 * The trust firewall on the send buttons: a teacher must never receive
 * another teacher's report, and nothing goes out that the coach did not
 * confirm for exactly that recipient.
 *
 *  - every preview carries its own id; the "Send now" button is bound to it;
 *  - "Someone else" invalidates the old preview and the re-point clears the
 *    old package, so an old button can never send teacher A's report to B;
 *  - Cancel makes the old "Send now" dead, at the tap AND in the worker;
 *  - only the observer may press any of the buttons;
 *  - a superseded, cancelled or redelivered preview job sends nothing.
 *
 * Real send service end to end; the boundary is the fake database, the
 * channel facade, the queue (recorded) and the image renderer.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { createFakeSupabase } = require('./_helpers/fake-supabase');

const mockTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-stale-'));
const mockDb = createFakeSupabase({
  users: [
    { id: 'coach-1', role: 'coach', name: 'Robin Coach', phone_number: 'mtx:15550100001', preferred_language: 'en' },
    { id: 't-1', role: 'teacher', name: 'Sam Taylor', phone_number: 'mtx:15554000002' },
    { id: 't-2', role: 'teacher', name: 'Pat Other', phone_number: 'mtx:15554000099' },
  ],
  coaching_sessions: [],
});
jest.mock('../../bot/shared/config/supabase', () => mockDb.client);
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/constants', () => ({ TEMP_DIR: mockTmp }));
jest.mock('../../bot/shared/storage/r2', () => ({
  isR2Configured: () => false, uploadImageBuffer: jest.fn(), downloadFromR2: jest.fn(),
}));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn(async () => true),
  sendImage: jest.fn(async () => true),
  sendTemplate: jest.fn(async () => true),
  sendInteractiveButtons: jest.fn(async () => true),
  sendInteractiveMessage: jest.fn(async () => true),
}));
jest.mock('../../bot/shared/services/quiz/quiz-delivery.service', () => ({ _hasOpenMessageWindow: async () => true }));
const mockQueued = [];
jest.mock('../../bot/shared/services/coaching/coaching-job-queue.service', () => ({
  queueObserveTeacherReport: jest.fn(async (id, p) => { mockQueued.push({ id, payload: p }); return `m${mockQueued.length}`; }),
}));
const mockState = new Map();
jest.mock('../../bot/shared/services/observe/observe-state.service', () => ({
  getState: jest.fn(async (u) => mockState.get(u) || null),
  setState: jest.fn(async (u, s, data) => { mockState.set(u, { state: s, ...data }); return true; }),
  clearState: jest.fn(async (u) => { mockState.delete(u); return true; }),
}));
jest.mock('../../bot/shared/services/observe/observe-roster.service', () => ({ listTeachers: async () => [] }));
jest.mock('../../bot/shared/services/gpt5-mini.service', () => ({ completeJson: jest.fn(async () => { throw new Error('no model'); }) }));
// The image boundary. `during` lets a test act while a preview is rendering.
const mockHero = { during: null };
jest.mock('../../bot/shared/services/coaching/report-v2/hero-report.service', () => ({
  generateHeroReport: async (session, analysis, opts) => {
    if (mockHero.during) { const fn = mockHero.during; mockHero.during = null; await fn(); }
    const vm = { teacherName: opts.teacherName, tryNext: '', narrative: { affirmation: `Well done, ${opts.teacherName}.` }, groups: [] };
    if (opts.beforeRender) await opts.beforeRender(vm);
    return { png: Buffer.from(`PNG for ${opts.teacherName}`), caption: 'x' };
  },
}));

const WA = require('../../bot/shared/services/whatsapp.service');
const ObserveSend = require('../../bot/shared/services/observe/observe-send.service');
const { handleObserveInteractive } = require('../../bot/shared/handlers/observe-interactive.handler');

const COACH = { id: 'coach-1', role: 'coach', name: 'Robin Coach', preferred_language: 'en' };
const COACH_TO = 'mtx:15550100001';
const SAM = 'mtx:15554000002';
const PAT = 'mtx:15554000099';
const PACKAGE_FIELDS = ['report_kind', 'report_key', 'report_path', 'report_text', 'caption', 'companion_text',
  'notes', 'previewed_at', 'last_error', 'failed_at'];

function seed() {
  mockDb.tables.coaching_sessions.length = 0;
  mockDb.tables.coaching_sessions.push({
    id: 'obs-1', user_id: 't-1', observer_user_id: 'coach-1', observation_type: 'leader_observation',
    status: 'observer_review_complete', debrief_status: 'done',
    analysis_data: { framework: 'teach', strengths: [{ title: 'Warm, clear explanations' }] },
  });
}
const delivery = () => mockDb.tables.coaching_sessions[0].analysis_data.teacher_delivery || {};
const textsTo = (to) => WA.sendMessage.mock.calls.filter((c) => c[0] === to).map((c) => c[1]);
const imagesTo = (to) => WA.sendImage.mock.calls.filter((c) => c[0] === to);
const toTeachers = () => [SAM, PAT].reduce((n, p) => n + textsTo(p).length + imagesTo(p).length, 0);
const queuedPhase = (phase) => mockQueued.filter((q) => q.payload.phase === phase);
const lastButtons = () => {
  const calls = WA.sendInteractiveButtons.mock.calls;
  const ids = calls[calls.length - 1][1].buttons.map((b) => b.id);
  return { confirm: ids[0], other: ids[1], cancel: ids[2] };
};
const tap = (id, user = COACH, from = COACH_TO) => handleObserveInteractive(user, from, id);
const runLast = (phase) => ObserveSend.processTeacherReport('obs-1', queuedPhase(phase).pop().payload);

/** "Send report" on the bound session → the preview job runs → its buttons. */
async function previewForSam() {
  await tap('observe_send_start_obs-1');
  expect(await runLast('preview')).toMatchObject({ status: 'previewed' });
  return lastButtons();
}

/** "Someone else" → typed details for Pat → the new preview is queued (not run). */
async function repointToPat(oldButtons) {
  await tap(oldButtons.other);
  const st = mockState.get('coach-1');
  expect(st).toMatchObject({ state: 'awaiting_teacher_details', sessionId: 'obs-1' });
  await ObserveSend.handleTeacherDetailsText(COACH, COACH_TO, 'Pat Other +1 555 400 0099', st);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQueued.length = 0;
  mockState.clear();
  mockHero.during = null;
  delete process.env.OBSERVE_REVIEW_MODE;
  seed();
});
afterAll(() => fs.rmSync(mockTmp, { recursive: true, force: true }));

describe('happy path, end to end', () => {
  test('recipient → preview → the preview\'s own Send now → deliver → the teacher receives it once', async () => {
    const buttons = await previewForSam();
    const previewId = delivery().preview_id;
    expect(previewId).toMatch(/^[0-9a-f]{12}$/);
    expect(buttons.confirm).toBe(`observe_send_confirm_obs-1.${previewId}`);
    Object.values(buttons).forEach((id) => expect(id.length).toBeLessThanOrEqual(256));

    await tap(buttons.confirm);
    expect(queuedPhase('deliver')).toHaveLength(1);
    expect(queuedPhase('deliver')[0].payload).toMatchObject({ phase: 'deliver', from: COACH_TO, previewId });
    expect(await runLast('deliver')).toMatchObject({ status: 'sent' });
    expect(imagesTo(SAM)).toHaveLength(1);
    expect(imagesTo(PAT)).toHaveLength(0);
    expect(textsTo(COACH_TO).pop()).toMatch(/reached the teacher/);
  });

  test('a double tap of Send now carries the same job identity (the queue dedupes it); a redelivered job sends nothing more', async () => {
    const buttons = await previewForSam();
    await tap(buttons.confirm);
    await tap(buttons.confirm);
    const [a, b] = queuedPhase('deliver');
    expect(b.payload).toEqual(a.payload);
    await ObserveSend.processTeacherReport('obs-1', a.payload);
    expect(await ObserveSend.processTeacherReport('obs-1', b.payload)).toMatchObject({ status: 'noop' });
    expect(imagesTo(SAM)).toHaveLength(1);
  });

  test('after a send_failed, Send now retries with a NEW job identity and gets through', async () => {
    const buttons = await previewForSam();
    await tap(buttons.confirm);
    WA.sendImage.mockResolvedValueOnce(false);
    expect(await runLast('deliver')).toMatchObject({ status: 'failed' });
    expect(delivery().status).toBe('send_failed');
    const first = mockQueued.find((q) => q.payload.phase === 'deliver').payload;

    await tap(buttons.confirm);
    const retry = queuedPhase('deliver').pop().payload;
    expect(retry.dedupNonce).not.toBe(first.dedupNonce);
    expect(await ObserveSend.processTeacherReport('obs-1', retry)).toMatchObject({ status: 'sent' });
    expect(delivery().status).toBe('sent');
  });
});

describe('Cancel', () => {
  test('after Cancel, the old Send now queues nothing — and a deliver job that arrives anyway sends nothing', async () => {
    const buttons = await previewForSam();
    const previewId = delivery().preview_id;
    await tap(buttons.cancel);
    expect(delivery()).toMatchObject({ status: 'cancelled', preview_id: null });

    WA.sendMessage.mockClear();
    await tap(buttons.confirm);
    expect(queuedPhase('deliver')).toHaveLength(0);
    expect(textsTo(COACH_TO).pop()).toMatch(/out of date/);

    const out = await ObserveSend.processTeacherReport('obs-1', { phase: 'deliver', from: COACH_TO, previewId });
    expect(out.status).toBe('noop');
    expect(toTeachers()).toBe(0);
    // a legacy job with no preview id at all is refused the same way
    expect((await ObserveSend.processTeacherReport('obs-1', { phase: 'deliver', from: COACH_TO })).status).toBe('noop');
    expect(toTeachers()).toBe(0);
  });
});

describe('only the observer may press the buttons', () => {
  test.each(['confirm', 'other', 'cancel', 'later'])('a non-observer\'s %s queues nothing and writes nothing', async (action) => {
    const buttons = { ...(await previewForSam()), later: 'observe_send_later_obs-1' };
    const before = JSON.stringify(mockDb.tables.coaching_sessions[0]);
    mockQueued.length = 0;
    WA.sendMessage.mockClear();
    await tap(buttons[action], { id: 't-2', role: 'teacher', name: 'Pat Other' }, PAT);
    expect(mockQueued).toHaveLength(0);
    expect(JSON.stringify(mockDb.tables.coaching_sessions[0])).toBe(before);
    expect(mockState.has('t-2')).toBe(false);
    expect(textsTo(PAT)).toEqual([expect.stringMatching(/isn't yours/)]);
  });
});

describe('"Someone else"', () => {
  test('the re-point clears the old package and starts a new preview id', async () => {
    const buttons = await previewForSam();
    const oldId = delivery().preview_id;
    expect(delivery().report_kind).toBe('image');
    await tap(buttons.other);
    expect(delivery().preview_id).toBeNull();          // the old Send now is dead already
    await ObserveSend.handleTeacherDetailsText(COACH, COACH_TO, 'Pat Other +1 555 400 0099', mockState.get('coach-1'));
    const d = delivery();
    expect(d).toMatchObject({ teacher_name: 'Pat Other', teacher_phone: PAT, status: 'previewing' });
    expect(d.preview_id).toMatch(/^[0-9a-f]{12}$/);
    expect(d.preview_id).not.toBe(oldId);
    PACKAGE_FIELDS.forEach((f) => expect(d[f] == null).toBe(true));
    expect(queuedPhase('preview').pop().payload).toMatchObject({ phase: 'preview', previewId: d.preview_id, dedupNonce: d.preview_id });
  });

  test('the OLD preview\'s Send now is refused, and a deliver job with the old id sends nothing to the new person', async () => {
    const old = await previewForSam();
    const oldId = delivery().preview_id;
    await repointToPat(old);
    await tap(old.confirm);
    expect(queuedPhase('deliver')).toHaveLength(0);
    expect(textsTo(COACH_TO).pop()).toMatch(/out of date/);

    const out = await ObserveSend.processTeacherReport('obs-1', { phase: 'deliver', from: COACH_TO, previewId: oldId });
    expect(out.status).toBe('noop');
    expect(toTeachers()).toBe(0);
  });

  test('...and the new preview, confirmed, reaches the new person with THEIR report', async () => {
    const old = await previewForSam();
    await repointToPat(old);
    expect(await runLast('preview')).toMatchObject({ status: 'previewed' });
    const fresh = lastButtons();
    expect(fresh.confirm).not.toBe(old.confirm);
    await tap(fresh.confirm);
    await runLast('deliver');
    expect(imagesTo(SAM)).toHaveLength(0);
    const [img] = imagesTo(PAT);
    expect(fs.readFileSync(img[1], 'utf8')).toBe('PNG for Pat Other');
  });
});

describe('a preview job that is no longer current sends nothing', () => {
  test('a preview job for a cancelled delivery', async () => {
    await tap('observe_send_start_obs-1');
    await tap('observe_send_cancel_obs-1');
    WA.sendMessage.mockClear();
    const out = await runLast('preview');
    expect(out).toMatchObject({ status: 'noop', reason: 'stale_preview' });
    expect(WA.sendImage).not.toHaveBeenCalled();
    expect(WA.sendInteractiveButtons).not.toHaveBeenCalled();
    expect(WA.sendMessage).not.toHaveBeenCalled();
  });

  test('a superseded preview job (the coach already picked someone else)', async () => {
    const old = await previewForSam();
    const oldJob = mockQueued.find((q) => q.payload.phase === 'preview').payload;
    await repointToPat(old);
    WA.sendImage.mockClear();
    WA.sendInteractiveButtons.mockClear();
    expect(await ObserveSend.processTeacherReport('obs-1', oldJob)).toMatchObject({ status: 'noop', reason: 'stale_preview' });
    expect(WA.sendImage).not.toHaveBeenCalled();
    expect(WA.sendInteractiveButtons).not.toHaveBeenCalled();
  });

  test('a redelivered preview job after the preview completed', async () => {
    await previewForSam();
    const job = mockQueued.find((q) => q.payload.phase === 'preview').payload;
    WA.sendInteractiveButtons.mockClear();
    expect(await ObserveSend.processTeacherReport('obs-1', job)).toMatchObject({ status: 'noop', reason: 'stale_preview' });
    expect(WA.sendInteractiveButtons).not.toHaveBeenCalled();
  });

  test('a preview superseded WHILE it renders does not overwrite the new recipient\'s row or show its buttons', async () => {
    await tap('observe_send_start_obs-1');
    const samJob = queuedPhase('preview').pop().payload;
    mockHero.during = async () => {
      // mid-render, the coach re-points to Pat
      await ObserveSend.handleTeacherDetailsText(COACH, COACH_TO, 'Pat Other +1 555 400 0099',
        { state: 'awaiting_teacher_details', sessionId: 'obs-1' });
    };
    expect(await ObserveSend.processTeacherReport('obs-1', samJob)).toMatchObject({ status: 'noop', reason: 'stale_preview' });
    expect(WA.sendInteractiveButtons).not.toHaveBeenCalled();
    expect(delivery()).toMatchObject({ teacher_phone: PAT, status: 'previewing' });
    expect(delivery().report_kind == null).toBe(true);

    // Pat's own preview then renders and delivers Pat's report, not Sam's
    await runLast('preview');
    await tap(lastButtons().confirm);
    await runLast('deliver');
    expect(fs.readFileSync(imagesTo(PAT)[0][1], 'utf8')).toBe('PNG for Pat Other');
  });
  test('a superseded preview that finishes rendering AFTER the new one never overwrites the new recipient\'s image', async () => {
    await tap('observe_send_start_obs-1');
    const samJob = queuedPhase('preview').pop().payload;
    mockHero.during = async () => {
      // mid-render: re-point to Pat, and Pat's preview completes first
      await ObserveSend.handleTeacherDetailsText(COACH, COACH_TO, 'Pat Other +1 555 400 0099',
        { state: 'awaiting_teacher_details', sessionId: 'obs-1' });
      expect(await runLast('preview')).toMatchObject({ status: 'previewed' });
    };
    expect(await ObserveSend.processTeacherReport('obs-1', samJob)).toMatchObject({ status: 'noop', reason: 'stale_preview' });
    await tap(lastButtons().confirm);
    expect(await runLast('deliver')).toMatchObject({ status: 'sent' });
    expect(fs.readFileSync(imagesTo(PAT)[0][1], 'utf8')).toBe('PNG for Pat Other');
  });
});

describe('the invite tap (Meta)', () => {
  test('each tapping number is its own job identity, so a stranger\'s tap cannot swallow the teacher\'s', async () => {
    await ObserveSend.handleReportTap('15550100777', 'observe_report_obs-1');
    await ObserveSend.handleReportTap('15554000002', 'observe_report_obs-1');
    const [a, b] = queuedPhase('teacher_tap').map((q) => q.payload);
    expect(a.dedupNonce).toBeTruthy();
    expect(a.dedupNonce).not.toBe(b.dedupNonce);
  });
});

describe('button ids', () => {
  test('parseSendButtonId reads the preview id; ids without one parse with previewId null', () => {
    expect(ObserveSend.parseSendButtonId('observe_send_confirm_0b6f0d1e-1111-4222-8333-444455556666.a1b2c3d4e5f6'))
      .toEqual({ action: 'confirm', sessionId: '0b6f0d1e-1111-4222-8333-444455556666', previewId: 'a1b2c3d4e5f6' });
    expect(ObserveSend.parseSendButtonId('observe_send_start_obs-1'))
      .toEqual({ action: 'start', sessionId: 'obs-1', previewId: null });
  });
});
