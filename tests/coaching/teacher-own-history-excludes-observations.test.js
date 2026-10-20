/**
 * The teacher's own coaching history must not include a coach's observation of
 * them. The observation is a coaching_sessions row with user_id = teacher and
 * status 'completed'; its analysis is the coach's rating and the coach's
 * growth areas. Every read that means "this teacher's earlier self-coaching"
 * — the prior-feedback context, the "has a prior session" check behind the
 * prior-feedback marks — leaves it out, so a teacher's report is the same as
 * if they had never been observed.
 */
const { createFakeSupabase } = require('../observe/_helpers/fake-supabase');
const { mockBotDependency } = require('../_helpers/mock-bot-dependency');

const OBSERVATION = {
  id: 'obs-1', user_id: 't-1', observer_user_id: 'coach-1', observation_type: 'leader_observation',
  status: 'completed', created_at: '2026-09-15T09:00:00Z',
  analysis_data: { framework: 'teach', scores: { overall_percentage: 38 },
    growth_opportunities: [{ area: 'COACH-RATED growth area' }], recommendations: ['COACH recommendation'] },
};
// written before the observe columns existed: no observation_type key at all
const PRIOR_SELF = {
  id: 'self-1', user_id: 't-1', status: 'completed', created_at: '2026-09-01T09:00:00Z',
  analysis_data: { scores: { overall_percentage: 71 }, growth_opportunities: [{ area: 'Wait time' }], recommendations: ['Ask open questions'] },
};
const CURRENT = { id: 'self-now', user_id: 't-1', status: 'generating_report', observation_type: null, created_at: '2026-10-01T09:00:00Z' };

const mockDb = createFakeSupabase({ users: [{ id: 't-1', first_name: 'Sam' }], coaching_sessions: [] });
jest.mock('../../bot/shared/config/supabase', () => mockDb.client);
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({ sendMessage: jest.fn(async () => true) }));
const mockRendered = [];
jest.mock('../../bot/shared/services/pdf-report.service', () => ({
  generateClassroomObservationReport: jest.fn(async (reportData) => { mockRendered.push(reportData); return Buffer.from('pdf'); }),
}));

// bot-only packages: the root CI job runs before bot/node_modules installs
mockBotDependency('jsonrepair', () => ({ jsonrepair: (s) => s }));

const ReportGenerator = require('../../bot/shared/services/coaching/report-generator.service');
const GPT5MiniService = require('../../bot/shared/services/gpt5-mini.service');
const { CLASSROOM_MARKS_BASE } = require('../../bot/shared/constants/scoring.constants');

const seed = (...rows) => { mockDb.tables.coaching_sessions = rows.map((r) => ({ ...r })); mockRendered.length = 0; };

// The prior-feedback criterion as the analysis carries it (OECD shape).
const oecdAnalysis = () => ({
  framework: 'oecd',
  scores: { goal1_total: 10, overall_marks: 60 },
  goal1_formative_assessment: { incorporation_of_feedback: { computed_marks: 4, evidence: 'Used last time\'s advice' } },
});

describe('prior feedback context (fetchAndCompressPriorFeedback)', () => {
  test('an observation is not one of the teacher\'s prior sessions', async () => {
    seed(OBSERVATION, CURRENT);
    const out = await ReportGenerator.fetchAndCompressPriorFeedback('t-1', 'self-now');
    expect(out).toEqual({ exists: false, summary: null, sessionCount: 0 });
  });

  test('the coach\'s growth areas never reach the teacher\'s prior-feedback context', async () => {
    seed(PRIOR_SELF, OBSERVATION, CURRENT);
    const out = await ReportGenerator.fetchAndCompressPriorFeedback('t-1', 'self-now');
    expect(out.sessionCount).toBe(1);
    expect(JSON.stringify(out.summary)).not.toMatch(/COACH/);
  });

  test('a teacher with no observations gets the same prior feedback as before', async () => {
    seed(PRIOR_SELF, CURRENT);
    const out = await ReportGenerator.fetchAndCompressPriorFeedback('t-1', 'self-now');
    expect(out).toMatchObject({ exists: true, sessionCount: 1, compressed: false });
    expect(out.summary[0]).toMatchObject({ growth_areas: [{ area: 'Wait time' }], recommendations: ['Ask open questions'] });
  });

  test('the legacy single-session read (fetchPriorSession) skips the observation too', async () => {
    seed(PRIOR_SELF, OBSERVATION, CURRENT);
    const out = await ReportGenerator.fetchPriorSession('t-1', 'self-now');
    expect(out && out.id).toBe('self-1');
  });
});

describe('"has a prior session" behind the prior-feedback marks', () => {
  test('transformAnalysisToReportData: being observed does not make this the teacher\'s second session', async () => {
    seed(OBSERVATION, CURRENT);
    const data = await ReportGenerator.transformAnalysisToReportData(CURRENT, 'Sam', oecdAnalysis());
    expect(data.priorFeedback.isFirstObservation).toBe(true);
  });

  test('generatePDFReport: the report transformer is told there is no prior session', async () => {
    seed(OBSERVATION, CURRENT);
    await ReportGenerator.generatePDFReport(CURRENT, 'Sam', oecdAnalysis());
    expect(mockRendered[0].priorFeedback.isFirstObservation).toBe(true);
  });

  test('enhanceAnalysisWithReflections: the max marks do not add the prior-feedback 5', async () => {
    seed(OBSERVATION, CURRENT);
    const enhanced = { scores: { overall_marks: 60, max_marks: CLASSROOM_MARKS_BASE }, debrief_reflection: {} };
    GPT5MiniService.openai = { chat: { completions: { create: jest.fn(async () => ({
      choices: [{ message: { content: JSON.stringify(enhanced) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })) } } };
    const out = await GPT5MiniService.enhanceAnalysisWithReflections(
      { scores: {} }, 'T: Hello.', { questions: [{ question_number: 1, question: 'Q?', answer: 'A.' }] }, {}, 't-1', 'self-now');
    expect(out.scores.max_marks_with_debrief).toBe(CLASSROOM_MARKS_BASE + 15);
  });

  test('a teacher with an earlier self-coaching session still gets the prior-feedback marks', async () => {
    seed(PRIOR_SELF, CURRENT);
    const data = await ReportGenerator.transformAnalysisToReportData(CURRENT, 'Sam', oecdAnalysis());
    expect(data.priorFeedback).toMatchObject({ isFirstObservation: false, score: 4, maxScore: 5 });
    await ReportGenerator.generatePDFReport(CURRENT, 'Sam', oecdAnalysis());
    expect(mockRendered[0].priorFeedback.isFirstObservation).toBe(false);
  });
});
