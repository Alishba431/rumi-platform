/**
 * A coach's observation of a teacher is a coaching_sessions row with
 * user_id = teacher. It is the coach's work, not the teacher's own coaching, so
 * none of the reads that drive what the TEACHER is told or offered may count
 * it: the chat context, "is the teacher busy", the /status list (and its
 * cancel), "when did they last use coaching", the feature count, the quiz
 * nudge's "already did coaching" check and the stale-session reminder's
 * "is the teacher busy". Each read runs for real against the fake database.
 */
const { createFakeSupabase } = require('../observe/_helpers/fake-supabase');
const { mockBotDependency } = require('../_helpers/mock-bot-dependency');

const recent = (minsAgo) => new Date(Date.now() - minsAgo * 60 * 1000).toISOString();
const observation = (over = {}) => ({
  id: 'obs-1', user_id: 't-1', observer_user_id: 'coach-1', observation_type: 'leader_observation',
  status: 'completed', created_at: recent(10),
  analysis_data: { framework: 'teach', scores: { overall_percentage: 38 }, overall_score: { percentage: 38 },
    strengths: ['COACH strength'], growth_opportunities: ['COACH growth area'] },
  ...over,
});
// written before the observe columns existed: no observation_type key at all
const selfSession = (over = {}) => ({
  id: 'self-1', user_id: 't-1', status: 'completed', created_at: recent(30),
  analysis_data: { overall_score: { percentage: 71 } }, ...over,
});

const mockDb = createFakeSupabase({});
jest.mock('../../bot/shared/config/supabase', () => mockDb.client);
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  isAvailable: () => false, get: jest.fn(async () => null), redis: { del: jest.fn(async () => 1) },
}));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn(async () => true), sendInteractiveButtons: jest.fn(async () => true),
}));
jest.mock('../../bot/shared/services/coaching/coaching-job-queue.service', () => ({ queueReport: jest.fn(async () => 'm') }));

// bot-only packages: the root CI job runs before bot/node_modules installs
mockBotDependency('uuid', () => ({ v4: () => '00000000-0000-4000-8000-000000000000' }));

const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const ContextService = require('../../bot/shared/services/context.service');
const TeacherState = require('../../bot/shared/services/teacher-state.service');
const FeatureLinkerService = require('../../bot/shared/services/feature-linker.service');
const FeatureRegistrationService = require('../../bot/shared/services/feature-registration.service');
const QuizSchedulerService = require('../../bot/shared/services/quiz/quiz-scheduler.service');
const { processStaleCoachingSessions } = require('../../bot/workers/stale-session.worker');

function seed(tables) {
  for (const k of Object.keys(mockDb.tables)) delete mockDb.tables[k];
  for (const [k, rows] of Object.entries(tables)) mockDb.tables[k] = rows.map((r) => ({ ...r }));
}

beforeEach(() => jest.clearAllMocks());

describe('chat context (ContextService.getUserFeatureContext)', () => {
  test("the coach's rating and notes never enter the teacher's chat context", async () => {
    seed({ coaching_sessions: [observation()] });
    const block = await ContextService.getUserFeatureContext('t-1', 'how was my coaching?', 'detailed');
    expect(block || '').not.toMatch(/38%|COACH|Coaching Sessions/);
  });

  test('a teacher with no observations gets the same context as before', async () => {
    seed({ coaching_sessions: [selfSession()] });
    const block = await ContextService.getUserFeatureContext('t-1', 'how was my coaching?', 'summary');
    expect(block).toMatch(/Session: 71% score/);
  });
});

describe('teacher state (/status and "is the teacher busy")', () => {
  const inFlight = () => observation({ status: 'analyzing', created_at: recent(5) });

  test('a coach analysing an observation of the teacher does not make the teacher busy', async () => {
    seed({ coaching_sessions: [inFlight()] });
    expect(await TeacherState.probeTeacherBusy('t-1')).toEqual({ busy: false, feature: null, etaSeconds: null });
  });

  test("the teacher's /status list does not offer the coach's observation", async () => {
    seed({ coaching_sessions: [inFlight()] });
    const items = await TeacherState.listActiveResources('t-1');
    expect(items.filter((i) => i.kind === 'coaching')).toEqual([]);
  });

  test("a cancel for a coaching id never cancels the coach's observation", async () => {
    seed({ coaching_sessions: [inFlight()] });
    await TeacherState.cancelResource({ kind: 'coaching', refId: 'obs-1' }, 't-1');
    expect(mockDb.tables.coaching_sessions[0].status).toBe('analyzing');
  });

  test("the teacher's own in-flight session still shows, makes them busy and can be cancelled", async () => {
    seed({ coaching_sessions: [selfSession({ status: 'analyzing', created_at: recent(5) })] });
    expect((await TeacherState.probeTeacherBusy('t-1')).busy).toBe(true);
    expect((await TeacherState.listActiveResources('t-1')).map((i) => i.refId)).toEqual(['self-1']);
    await TeacherState.cancelResource({ kind: 'coaching', refId: 'self-1' }, 't-1');
    expect(mockDb.tables.coaching_sessions[0].status).toBe('cancelled');
  });
});

describe('feature use', () => {
  test('being observed does not count as the teacher having used coaching (feature linker)', async () => {
    seed({ coaching_sessions: [observation()] });
    const h = await FeatureLinkerService._getUserFeatureHistory('t-1');
    expect(h.lastCoachingDaysAgo).toBe(Infinity);
  });

  test("being observed does not count toward the teacher's feature total (registration trigger)", async () => {
    seed({ coaching_sessions: [observation()] });
    expect(await FeatureRegistrationService.countUserFeatures('t-1')).toBe(0);
  });

  test('a teacher with no observations: the feature reads are unchanged', async () => {
    seed({ coaching_sessions: [selfSession()] });
    expect((await FeatureLinkerService._getUserFeatureHistory('t-1')).lastCoachingDaysAgo).toBeLessThan(1);
    expect(await FeatureRegistrationService.countUserFeatures('t-1')).toBe(1);
  });
});

describe('quiz nudge after a lesson plan', () => {
  const lp = { id: 'lp-1', user_id: 't-1', created_at: recent(180), quiz_nudge_sent: false, users: { phone_number: '15550100002' } };

  test("an observation after the lesson plan is not the teacher 'already doing coaching'", async () => {
    seed({ lesson_plans: [lp], coaching_sessions: [observation()], student_lists: [] });
    await QuizSchedulerService._processOneLP(lp);
    expect(mockDb.tables.lesson_plans[0].quiz_nudge_sent).toBe(false);
  });

  test("the teacher's own coaching after the lesson plan still skips the nudge", async () => {
    seed({ lesson_plans: [lp], coaching_sessions: [selfSession()], student_lists: [] });
    await QuizSchedulerService._processOneLP(lp);
    expect(mockDb.tables.lesson_plans[0].quiz_nudge_sent).toBe(true);
  });
});

describe('stale-session reminder', () => {
  const stale = selfSession({ id: 'self-stale', status: 'conducting_conversation', created_at: recent(3 * 60),
    recipient_identifier: '15550100002', conversation_state: { questions_answered: 1 }, reminder_sent_at: null });

  test("a coach's observation being analysed does not hold back the teacher's own reminder", async () => {
    seed({ users: [{ id: 't-1', first_name: 'Sam' }], conversations: [], reading_assessments: [],
      coaching_sessions: [stale, observation({ status: 'analyzing' })] });
    const out = await processStaleCoachingSessions();
    expect(out).toMatchObject({ reminders: 1, skipped: 0 });
    expect(WhatsAppService.sendInteractiveButtons).toHaveBeenCalledWith('15550100002', expect.anything());
  });

  test("the teacher's own other session in analysis still holds it back", async () => {
    seed({ users: [{ id: 't-1', first_name: 'Sam' }], conversations: [], reading_assessments: [],
      coaching_sessions: [stale, selfSession({ id: 'self-2', status: 'analyzing' })] });
    expect(await processStaleCoachingSessions()).toMatchObject({ reminders: 0, skipped: 1 });
  });
});
