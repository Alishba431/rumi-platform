/**
 * A coach's observation of a teacher is stored as a coaching_sessions row owned
 * by the observed teacher (user_id = teacher, status 'completed'), and its
 * analysis_data.scores.overall_percentage is the COACH's rating. The teacher's
 * own hero report draws its sparkline from loadTrendData(user_id), so that
 * rating must never become a point on it: a teacher never sees a coach's score.
 */
const { createFakeSupabase } = require('../observe/_helpers/fake-supabase');

const SELF_1 = { id: 'self-1', user_id: 't-1', status: 'completed', observation_type: null,
  created_at: '2026-09-01T09:00:00Z', analysis_data: { scores: { overall_percentage: 71 } } };
const OBSERVATION = { id: 'obs-1', user_id: 't-1', observer_user_id: 'coach-1', observation_type: 'leader_observation',
  status: 'completed', created_at: '2026-09-15T09:00:00Z', analysis_data: { framework: 'teach', scores: { overall_percentage: 38 } } };
const SELF_2 = { id: 'self-2', user_id: 't-1', status: 'completed', observation_type: null,
  created_at: '2026-10-01T09:00:00Z', analysis_data: { scores: { overall_percentage: 74 } } };

const mockDb = createFakeSupabase({ coaching_sessions: [] });
jest.mock('../../bot/shared/config/supabase', () => mockDb.client);
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
const { loadTrendData } = require('../../bot/shared/services/coaching/coaching-trend.service');

const seed = (...rows) => { mockDb.tables.coaching_sessions = rows.map((r) => ({ ...r })); };

describe('loadTrendData leaves coach observations out of the teacher\'s own trend', () => {
  test("the coach's observation rating is not part of the teacher's own score trend", async () => {
    seed(SELF_1, OBSERVATION, SELF_2);
    const trend = await loadTrendData('t-1', { limit: 12, locale: 'en' });
    expect(trend.map((p) => p.pct)).toEqual([71, 74]);
  });

  test('an observation does not take one of the newest-N slots either', async () => {
    seed(SELF_1, OBSERVATION, SELF_2);
    const trend = await loadTrendData('t-1', { limit: 2, locale: 'en' });
    expect(trend.map((p) => p.pct)).toEqual([71, 74]);
  });

  test('a teacher who has only been observed has no trend', async () => {
    seed(OBSERVATION);
    expect(await loadTrendData('t-1', { limit: 12, locale: 'en' })).toEqual([]);
  });

  test('a teacher with no observations gets exactly the trend they got before', async () => {
    // rows written before the observe columns existed carry no observation_type key at all
    const legacy = [SELF_1, SELF_2].map(({ observation_type, ...r }) => r);
    seed(...legacy);
    const trend = await loadTrendData('t-1', { limit: 12, locale: 'en' });
    expect(trend.map((p) => [p.pct, p.date])).toEqual([[71, SELF_1.created_at], [74, SELF_2.created_at]]);
  });
});
