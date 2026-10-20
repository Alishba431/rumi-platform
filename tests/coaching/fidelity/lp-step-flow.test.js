'use strict';
/**
 * The teacher coaching flow up to the lesson plan. Before this release the photo question's buttons (Yes / No /
 * Add another / Done) were emitted but never routed, nothing ever asked for the lesson plan, and the plan picker
 * (buildLPSelectionList / handleLPSelection) was dead code — a recording stalled at awaiting_photo.
 *
 * Now: "No photo" or "Done" → the lesson-plan step. With fidelity on the teacher picks one of the plans Rumi made
 * for them, says they'll upload or paste one, or says there is none; with it off they get the original Yes/No.
 * A plan pasted as one message is accepted while the session waits for it.
 *
 * Real: the flow modules, the linker, buildLPSelectionList. Faked: the database and messaging (network), and the
 * job queue (the worker boundary).
 */
const { makeFakeDb } = require('./_fake-db');

let mockDb;
jest.mock('../../../bot/shared/config/supabase', () => new Proxy({}, { get: (_t, k) => mockDb[k] }));
jest.mock('../../../bot/shared/utils/logger', () => ({ logToFile: jest.fn(), logWarn: jest.fn() }));
jest.mock('../../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn(async () => true),
  sendInteractiveMessage: jest.fn(async () => true),
  sendInteractiveButtons: jest.fn(async () => true),
}));
jest.mock('../../../bot/shared/services/coaching/coaching-job-queue.service', () => ({ queueAnalysis: jest.fn(async () => true) }));
jest.mock('../../../bot/shared/services/coaching/fidelity/fidelity-recompute.service', () => ({ recomputeFidelityForSession: jest.fn(async () => ({ recomputed: true })) }));

const WhatsAppService = require('../../../bot/shared/services/whatsapp.service');
const CoachingJobQueueService = require('../../../bot/shared/services/coaching/coaching-job-queue.service');
const { recomputeFidelityForSession } = require('../../../bot/shared/services/coaching/fidelity/fidelity-recompute.service');
const { advanceToLessonPlanStep } = require('../../../bot/shared/services/coaching/lp-coaching/lp-step.service');
const { handleLpListSelection } = require('../../../bot/shared/services/coaching/lp-coaching/lp-list-selection.handler');
const { handlePastedLessonPlan } = require('../../../bot/shared/services/coaching/lp-coaching/lp-text-paste.service');
const { handleCoachingFlowButton } = require('../../../bot/shared/services/coaching/coaching-flow-buttons');
const { getCoachingMessage } = require('../../../bot/shared/config/coaching-messages');

const SID = '11111111-2222-3333-4444-555555555555';
const PLAN = 'Warm-up: recall halves and quarters. Explain adding fractions with paper strips folded into fifths. Model 1/5 + 2/5 on the board. Pairs solve three problems. Exit ticket: 2/6 + 3/6.';

function seed(status = 'awaiting_photo', extra = {}) {
  mockDb = makeFakeDb({
    coaching_sessions: [{ id: SID, user_id: 'u1', status, conversation_state: { current_state: 'AWAITING_PHOTO', classroom_photos: [{ url: 'p1' }] }, users: { preferred_language: 'en' }, ...extra }],
    users: [{ id: 'u1', preferred_language: 'en' }],
    lesson_plans: [
      { id: 'lp-1', user_id: 'u1', topic: 'Adding fractions', grade: '4', type: 'lesson_plan', created_at: '2026-10-01T08:00:00Z' },
      { id: 'lp-2', user_id: 'u1', topic: 'Parts of a plant', grade: '4', type: 'lesson_plan', created_at: '2026-09-30T08:00:00Z' },
      { id: 'pr-1', user_id: 'u1', topic: 'A slide deck', grade: '4', type: 'presentation', created_at: '2026-09-29T08:00:00Z' },
      { id: 'lp-x', user_id: 'someone-else', topic: 'Not yours', grade: '4', type: 'lesson_plan', created_at: '2026-09-29T08:00:00Z' },
    ],
  });
}
const session = () => mockDb.tables.coaching_sessions[0];
const saved = process.env.LP_FIDELITY_ENABLED;

beforeEach(() => { jest.clearAllMocks(); process.env.LP_FIDELITY_ENABLED = 'true'; });
afterAll(() => { if (saved === undefined) delete process.env.LP_FIDELITY_ENABLED; else process.env.LP_FIDELITY_ENABLED = saved; });

describe('advanceToLessonPlanStep', () => {
  test('fidelity on: a list of the teacher\'s own Rumi-made plans + upload/paste + none; session waits for the plan', async () => {
    seed();
    expect(await advanceToLessonPlanStep({ sessionId: SID, from: 'matrix:@t:local', tapperUserId: 'u1' })).toBe(true);
    const list = WhatsAppService.sendInteractiveMessage.mock.calls[0][1];
    const ids = list.action.sections.flatMap((s) => s.rows.map((r) => r.id));
    expect(ids).toEqual([`lp_select_lp-1_${SID}`, `lp_select_lp-2_${SID}`, `lp_upload_${SID}`, `lp_none_${SID}`]);
    expect(session().status).toBe('awaiting_lesson_plan');
    expect(session().conversation_state).toEqual({ current_state: 'AWAITING_LESSON_PLAN', classroom_photos: [{ url: 'p1' }] });
  });

  test('fidelity off: the original Yes/No question, nothing else changes', async () => {
    seed();
    delete process.env.LP_FIDELITY_ENABLED;
    await advanceToLessonPlanStep({ sessionId: SID, from: '15550001111', tapperUserId: 'u1' });
    expect(WhatsAppService.sendInteractiveMessage).not.toHaveBeenCalled();
    expect(WhatsAppService.sendInteractiveButtons.mock.calls[0][1].buttons.map((b) => b.id)).toEqual([`lessonplan_yes_${SID}`, `lessonplan_no_${SID}`]);
    expect(session().status).toBe('awaiting_lesson_plan');
  });

  test('a refused list falls back to Yes/No; if nothing goes out the session is left where it was', async () => {
    seed();
    WhatsAppService.sendInteractiveMessage.mockResolvedValueOnce(false);
    expect(await advanceToLessonPlanStep({ sessionId: SID, from: 'x', tapperUserId: 'u1' })).toBe(true);
    expect(WhatsAppService.sendInteractiveButtons).toHaveBeenCalled();

    seed();
    WhatsAppService.sendInteractiveMessage.mockResolvedValueOnce(false);
    WhatsAppService.sendInteractiveButtons.mockResolvedValueOnce(false);
    expect(await advanceToLessonPlanStep({ sessionId: SID, from: 'x', tapperUserId: 'u1' })).toBe(false);
    expect(session().status).toBe('awaiting_photo');
  });

  test('a finished or cancelled session is not walked forward by an old button', async () => {
    for (const status of ['completed', 'cancelled', 'failed']) {
      seed(status);
      expect(await advanceToLessonPlanStep({ sessionId: SID, from: 'x', tapperUserId: 'u1' })).toBe(false);
      expect(session().status).toBe(status);
    }
  });

  test('LP_FIDELITY_LIST_LIMIT caps the plans listed (at most 8: a WhatsApp list holds 10 rows with the two options)', async () => {
    seed();
    process.env.LP_FIDELITY_LIST_LIMIT = '1';
    try {
      await advanceToLessonPlanStep({ sessionId: SID, from: 'x', tapperUserId: 'u1' });
    } finally { delete process.env.LP_FIDELITY_LIST_LIMIT; }
    const ids = WhatsAppService.sendInteractiveMessage.mock.calls[0][1].action.sections[0].rows.map((r) => r.id);
    expect(ids).toEqual([`lp_select_lp-1_${SID}`]);
  });
});

describe('handleLpListSelection', () => {
  test('a picked plan is linked, the teacher told so, and the analysis queued', async () => {
    seed('awaiting_lesson_plan');
    expect(await handleLpListSelection(`lp_select_lp-1_${SID}`, 'matrix:@t:local')).toBe(true);
    expect(session()).toMatchObject({ linked_lesson_plan_id: 'lp-1', lesson_plan_link_method: 'selected_recent', has_lesson_plan: true });
    expect(WhatsAppService.sendMessage).toHaveBeenCalledWith('matrix:@t:local', getCoachingMessage('lessonPlan_linked', 'en'));
    expect(CoachingJobQueueService.queueAnalysis).toHaveBeenCalledWith(SID, { from: 'matrix:@t:local' });
    expect(session().status).toBe('analysis_started');
  });

  test('a late pick (the analysis already ran) recomputes only the fidelity, instead of re-running everything', async () => {
    seed('conducting_conversation');
    await handleLpListSelection(`lp_select_lp-2_${SID}`, 'x');
    expect(CoachingJobQueueService.queueAnalysis).not.toHaveBeenCalled();
    expect(recomputeFidelityForSession).toHaveBeenCalledWith(SID);
  });

  test('"upload or paste" asks for the document or the text and waits', async () => {
    seed('awaiting_lesson_plan');
    await handleLpListSelection(`lp_upload_${SID}`, 'x');
    expect(session().lesson_plan_link_method).toBe('uploaded');
    expect(WhatsAppService.sendMessage).toHaveBeenCalledWith('x', getCoachingMessage('lessonPlan_request_or_paste', 'en'));
    expect(CoachingJobQueueService.queueAnalysis).not.toHaveBeenCalled();
  });

  test('"no lesson plan" continues without one', async () => {
    seed('awaiting_lesson_plan');
    await handleLpListSelection(`lp_none_${SID}`, 'x');
    expect(session()).toMatchObject({ has_lesson_plan: false, lesson_plan_link_method: 'none' });
    expect(WhatsAppService.sendMessage).toHaveBeenCalledWith('x', getCoachingMessage('lessonPlan_skip', 'en'));
    expect(CoachingJobQueueService.queueAnalysis).toHaveBeenCalled();
  });

  test('a plan id that is not this teacher\'s is not linked', async () => {
    seed('awaiting_lesson_plan');
    await handleLpListSelection(`lp_select_lp-x_${SID}`, 'x');
    expect(session().linked_lesson_plan_id).toBeUndefined();
  });

  test('ids that are not plan-picker rows are not consumed', async () => {
    seed('awaiting_lesson_plan');
    expect(await handleLpListSelection('quiz_class_1', 'x')).toBe(false);
  });
});

describe('handlePastedLessonPlan', () => {
  const user = { id: 'u1' };

  test('a plan pasted as one message while the session waits is stored as the plan and the analysis queued', async () => {
    seed('awaiting_lesson_plan');
    expect(await handlePastedLessonPlan(user, 'x', PLAN)).toBe(true);
    expect(session()).toMatchObject({ lesson_plan_text: PLAN, lesson_plan_link_method: 'pasted', has_lesson_plan: true, lesson_plan_extraction_status: 'completed' });
    expect(session().lesson_plan_excerpt.length).toBeLessThanOrEqual(503);
    expect(WhatsAppService.sendMessage).toHaveBeenCalledWith('x', getCoachingMessage('lessonPlan_pasted', 'en'));
    expect(CoachingJobQueueService.queueAnalysis).toHaveBeenCalledWith(SID, { from: 'x', lpPasted: true });
  });

  test('short replies, no waiting session, or the feature off → not a plan (normal chat continues)', async () => {
    seed('awaiting_lesson_plan');
    expect(await handlePastedLessonPlan(user, 'x', 'no')).toBe(false);
    seed('analysis_complete');
    expect(await handlePastedLessonPlan(user, 'x', PLAN)).toBe(false);
    seed('awaiting_lesson_plan');
    delete process.env.LP_FIDELITY_ENABLED;
    expect(await handlePastedLessonPlan(user, 'x', PLAN)).toBe(false);
  });
});

describe('handleCoachingFlowButton (the photo question)', () => {
  const user = { id: 'u1' };

  test('"No photo" and "Done" move to the lesson-plan step', async () => {
    for (const id of [`photo_no_${SID}`, `photo_done_${SID}`]) {
      seed();
      jest.clearAllMocks();
      expect(await handleCoachingFlowButton(id, 'x', user)).toBe(true);
      expect(session().status).toBe('awaiting_lesson_plan');
      expect(WhatsAppService.sendInteractiveMessage).toHaveBeenCalled();
    }
  });

  test('"Yes" / "Add another" ask for the photo and keep collecting', async () => {
    for (const id of [`photo_yes_${SID}`, `photo_more_${SID}`]) {
      seed();
      jest.clearAllMocks();
      expect(await handleCoachingFlowButton(id, 'x', user)).toBe(true);
      expect(session().status).toBe('awaiting_photo');
      expect(session().conversation_state.current_state).toBe('COLLECTING_PHOTOS');
      expect(WhatsAppService.sendMessage).toHaveBeenCalled();
    }
  });

  test('other buttons are not consumed', async () => {
    seed();
    expect(await handleCoachingFlowButton('coaching_confirm_x', 'x', user)).toBe(false);
  });
});

describe('plan picker copy', () => {
  const { buildLPSelectionList } = require('../../../bot/shared/services/coaching/lp-coaching/lp-selection-list.service');
  const rows = (list) => list.listData.action.sections.flatMap((s) => s.rows);

  test('a plan with no grade shows only its date (no "Grade ?")', () => {
    const list = buildLPSelectionList(SID, [{ id: 'lp-1', topic: 'Adding fractions', grade: null, created_at: '2026-10-02T08:00:00Z' }], 'en');
    expect(rows(list)[0].description).toBe('2 Oct');
    const graded = buildLPSelectionList(SID, [{ id: 'lp-1', topic: 'Adding fractions', grade: '4', created_at: '2026-10-02T08:00:00Z' }], 'en');
    expect(rows(graded)[0].description).toBe('Grade 4 • 2 Oct');
  });

  test('the upload row says a plan can also be pasted, and the question says the lesson is compared with it', () => {
    const list = buildLPSelectionList(SID, [{ id: 'lp-1', topic: 'T', grade: '4', created_at: '2026-10-02T08:00:00Z' }], 'en');
    const upload = rows(list).find((r) => r.id === `lp_upload_${SID}`);
    expect(upload.title).toBe('Upload or paste');
    expect(upload.description).toMatch(/paste/i);
    expect(list.listData.body.text).toMatch(/Which lesson plan did you teach/);
  });
});

describe('a pick after a paste (review S1)', () => {
  test('picking a Rumi plan replaces a plan pasted earlier, so the picked plan is the one graded', async () => {
    seed('awaiting_lesson_plan', { lesson_plan_text: 'An earlier pasted plan text that is long enough to be a plan.', lesson_plan_excerpt: 'An earlier…', lesson_plan_word_count: 12, lesson_plan_link_method: 'pasted' });
    await handleLpListSelection(`lp_select_lp-1_${SID}`, 'x');
    expect(session()).toMatchObject({ linked_lesson_plan_id: 'lp-1', lesson_plan_link_method: 'selected_recent', lesson_plan_text: null, lesson_plan_excerpt: null, lesson_plan_word_count: null });
    const { resolveFidelitySources } = require('../../../bot/shared/services/coaching/fidelity/fidelity-orchestrator');
    expect(resolveFidelitySources(session(), { linkedPlanText: 'the picked plan' }).source).toBe('linked');
  });
});
