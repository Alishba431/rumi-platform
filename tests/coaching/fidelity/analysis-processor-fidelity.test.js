'use strict';
/**
 * The coaching analysis job runs lesson-plan fidelity as a third, non-blocking task beside the pedagogy analysis and
 * the reflective corpus, and persists the result as analysis_data.lp_fidelity.
 *
 * What runs for real: AnalysisProcessorService, the fidelity session inputs, the orchestrator, extractor, grader,
 * scorer, the linked-plan renderer and the FICO applyLpFidelity hook. What is faked: the database and the OpenRouter
 * client (the network), and the services around the job that are not under test (pedagogy LLM, messaging, the
 * reflective conversation that follows).
 */
const { makeFakeDb } = require('./_fake-db');

let mockDb;
const mockLlmCalls = [];
let mockGrade = null;

jest.mock('../../../bot/shared/config/supabase', () => new Proxy({}, { get: (_t, k) => mockDb[k] }));
jest.mock('../../../bot/shared/utils/logger', () => ({ logToFile: jest.fn(), logWarn: jest.fn() }));
jest.mock('../../../bot/shared/services/whatsapp.service', () => ({ sendMessage: jest.fn(async () => true), sendSticker: jest.fn(async () => true) }));
jest.mock('../../../bot/shared/services/coaching/reflective-conversation.service', () => ({ conductReflectiveConversation: jest.fn(async () => {}) }));
jest.mock('../../../bot/shared/services/coaching/report-generator.service', () => ({ fetchAndCompressPriorFeedback: jest.fn(async () => ({ exists: false })) }));
jest.mock('../../../bot/shared/services/coaching/frameworks/framework-selector', () => ({
  selectFramework: jest.fn(async () => require('../../../bot/shared/services/coaching/frameworks/framework-registry').getFramework('fico')),
}));
jest.mock('../../../bot/shared/services/gpt5-mini.service', () => ({
  analyzePedagogy: jest.fn(async () => ({
    analysis: {
      framework: 'fico',
      domains: { lesson_structure: { indicators: [
        { id: '1.1', name: 'Lesson Goal Clarity', score: 3 },
        { id: '1.2', name: 'Fidelity to LP Steps', score: 2, evidence: 'model guess' },
        { id: '1.3', name: 'Materials Use', score: 3 },
        { id: '1.4', name: 'Time Management', score: 3 },
      ] } },
      scores: { overall_marks: 11, overall_max_marks: 84, overall_percentage: 13.1 },
    },
    usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cost: 0 },
  })),
  extractReflectiveCorpus: jest.fn(async () => null),
}));
// The network boundary: OpenRouter. Answers the extractor and the grader by their system prompts.
jest.mock('../../../bot/shared/services/llm-client', () => ({
  getClient: () => ({
    chat: { completions: { create: async (p) => {
      mockLlmCalls.push(p);
      const sys = p.messages[0].content;
      if (sys.startsWith('LESSON PLAN EXTRACTOR')) {
        return { choices: [{ message: { content: JSON.stringify({ goal: 'add fractions', moves: [
          { move_id: 'm1', phase: 'explain', type: 'modelling', text: 'Explain with fraction strips' },
          { move_id: 'm2', phase: 'exit', type: 'check', text: 'Exit ticket' },
        ] }) }, finish_reason: 'stop' }], usage: {} };
      }
      if (sys.startsWith('FIDELITY GRADER')) {
        if (mockGrade instanceof Error) throw mockGrade;
        return { choices: [{ message: { content: JSON.stringify(mockGrade || { verdicts: [
          { move_id: 'm1', verdict: 'executed', evidence: '[00:10] fold the strip' },
          { move_id: 'm2', verdict: 'executed', evidence: '[03:00] one question each' },
        ], narrative: 'Both planned moves happened.' }) }, finish_reason: 'stop' }], usage: {} };
      }
      throw new Error(`unexpected LLM call: ${sys.slice(0, 40)}`);
    } } },
  }),
}));

const AnalysisProcessorService = require('../../../bot/shared/services/coaching/analysis-processor.service');

const STAMPED = '[00:10] Teacher (EN): fold the strip into five\n\n[03:00] Teacher (EN): one question each before you go';
const PLAN = 'Explain adding fractions with paper fraction strips folded into fifths, then an exit ticket with one question each.';

function seed(sessionOver = {}, extra = {}) {
  mockDb = makeFakeDb({
    coaching_sessions: [{
      id: 's1', user_id: 'u1', status: 'analysis_started', transcript_text: STAMPED, transcript_language: 'en',
      audio_duration_seconds: 240, lesson_plan_text: null, linked_lesson_plan_id: null, lesson_plan_link_method: null,
      users: { phone_number: '15550001111', first_name: 'Sam', last_name: 'Teacher', preferred_language: 'en' },
      ...sessionOver,
    }],
    lesson_plans: extra.lesson_plans || [],
  });
}

const saved = process.env.LP_FIDELITY_ENABLED;
afterEach(() => { if (saved === undefined) delete process.env.LP_FIDELITY_ENABLED; else process.env.LP_FIDELITY_ENABLED = saved; mockLlmCalls.length = 0; mockGrade = null; });

const persisted = () => mockDb.tables.coaching_sessions[0].analysis_data;
const fidelityCalls = () => mockLlmCalls.filter((p) => /^(LESSON PLAN EXTRACTOR|FIDELITY GRADER)/.test(p.messages[0].content));

describe('analysis job · lesson-plan fidelity', () => {
  test('flag off → analysis_data is exactly what it was before this feature: no lp_fidelity, no fidelity model call', async () => {
    delete process.env.LP_FIDELITY_ENABLED;
    seed({ lesson_plan_text: PLAN, lesson_plan_link_method: 'pasted' });
    await AnalysisProcessorService.processAnalysis('s1', { from: '15550001111' });
    expect(persisted()).not.toHaveProperty('lp_fidelity');
    expect(persisted().domains.lesson_structure.indicators[1]).toMatchObject({ id: '1.2', score: 2, evidence: 'model guess' });
    expect(fidelityCalls()).toHaveLength(0);
  });

  test('pasted plan → lp_fidelity ok, stamped graded_at, and FICO indicator 1.2 replaced by the measurement', async () => {
    process.env.LP_FIDELITY_ENABLED = 'true';
    seed({ lesson_plan_text: PLAN, lesson_plan_link_method: 'pasted' });
    await AnalysisProcessorService.processAnalysis('s1', { from: '15550001111' });
    const lp = persisted().lp_fidelity;
    expect(lp).toMatchObject({ status: 'ok', source: 'pasted', fidelity_pct: 100, band: 'high' });
    expect(typeof lp.graded_at).toBe('string');
    const ind = persisted().domains.lesson_structure.indicators.find((i) => i.id === '1.2');
    expect(ind).toMatchObject({ score: 4, fidelity_derived: true });
    expect(persisted().scores.overall_marks).toBe(13);
    expect(mockDb.tables.coaching_sessions[0].status).toBe('analysis_complete');
  });

  test('a plan Rumi made, linked from the picker → its stored text is the plan graded (source linked)', async () => {
    process.env.LP_FIDELITY_ENABLED = 'true';
    seed({ linked_lesson_plan_id: 'lp-1', lesson_plan_link_method: 'selected_recent' }, {
      lesson_plans: [{ id: 'lp-1', topic: 'Adding fractions', grade: '4', subject: 'Maths', content: { plan_text: PLAN }, pdf_url: null }],
    });
    await AnalysisProcessorService.processAnalysis('s1', { from: '15550001111' });
    expect(persisted().lp_fidelity).toMatchObject({ status: 'ok', source: 'linked', lesson_plan_id: 'lp-1' });
    const extractCall = fidelityCalls().find((p) => p.messages[0].content.startsWith('LESSON PLAN EXTRACTOR'));
    expect(extractCall.messages[1].content).toContain('Topic: Adding fractions');
  });

  test('a transcript with no timings → not assessed, no fidelity model call, the FICO indicator left to the analysis', async () => {
    process.env.LP_FIDELITY_ENABLED = 'true';
    seed({ lesson_plan_text: PLAN, lesson_plan_link_method: 'pasted', transcript_text: 'fold the strip into five one question each before you go' });
    await AnalysisProcessorService.processAnalysis('s1', { from: '15550001111' });
    expect(persisted().lp_fidelity).toMatchObject({ status: 'ok', fidelity_pct: null, unusable_guard: 'no_timestamps' });
    expect(fidelityCalls()).toHaveLength(0);
    expect(persisted().domains.lesson_structure.indicators[1]).toMatchObject({ score: 2, evidence: 'model guess' });
  });

  test('no plan at all → lp_absent persisted (distinguishable from never-ran)', async () => {
    process.env.LP_FIDELITY_ENABLED = 'true';
    seed();
    await AnalysisProcessorService.processAnalysis('s1', { from: '15550001111' });
    expect(persisted().lp_fidelity).toEqual(expect.objectContaining({ status: 'lp_absent' }));
  });

  test('the grader failing never fails the coaching job: fidelity_unavailable is persisted and the analysis completes', async () => {
    process.env.LP_FIDELITY_ENABLED = 'true';
    mockGrade = new Error('upstream 503');
    seed({ lesson_plan_text: PLAN, lesson_plan_link_method: 'pasted' });
    await AnalysisProcessorService.processAnalysis('s1', { from: '15550001111' });
    expect(persisted().lp_fidelity).toMatchObject({ status: 'fidelity_unavailable' });
    expect(mockDb.tables.coaching_sessions[0].status).toBe('analysis_complete');
  });
});
