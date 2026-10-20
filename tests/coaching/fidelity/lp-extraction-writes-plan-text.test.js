'use strict';
/**
 * An uploaded plan reaches fidelity only through coaching_sessions.lesson_plan_text — and the extraction worker never
 * wrote it (only a 500-character excerpt and the structured parse), so uploaded-plan fidelity could never fire. The
 * worker now stores the full text, and when the plan finishes reading after the analysis already ran, it asks for the
 * fidelity section to be recomputed against it.
 *
 * The worker runs; storage (R2), the PDF/Word parsers, the structuring LLM and the database are faked.
 */
const { makeFakeDb } = require('./_fake-db');

let mockDb;
const mockPlanText = 'Lesson plan: adding fractions. Warm-up on halves. Explain with fraction strips folded into fifths. Model 1/5 + 2/5. Pairs solve three problems. Exit ticket 2/6 + 3/6. '.repeat(8);

jest.mock('../../../bot/shared/config/supabase', () => new Proxy({}, { get: (_t, k) => mockDb[k] }));
jest.mock('../../../bot/shared/utils/logger', () => ({ logToFile: jest.fn(), logWarn: jest.fn() }));
jest.mock('pdf-parse', () => jest.fn(async () => ({ text: mockPlanText })), { virtual: true });
jest.mock('mammoth', () => ({ extractRawText: jest.fn(async () => ({ value: mockPlanText })) }), { virtual: true });
jest.mock('jsonrepair', () => ({ jsonrepair: (s) => s }), { virtual: true });
jest.mock('dotenv', () => ({ config: () => ({}) }), { virtual: true });
jest.mock('../../../bot/shared/storage/r2', () => ({
  downloadFromR2: jest.fn(async () => Buffer.from('%PDF-1.4 fake')),
  uploadLessonPlanBuffer: jest.fn(), buildR2PublicUrl: jest.fn(),
}));
jest.mock('../../../bot/shared/services/aws-textract.service', () => ({ AWSTextractService: { extractText: jest.fn(async () => '') } }));
jest.mock('../../../bot/shared/services/whatsapp.service', () => ({ sendMessage: jest.fn() }));
jest.mock('../../../bot/shared/services/llm-client', () => ({
  getClient: () => ({ chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({ objectives: ['add fractions'] }) } }] }) } } }),
}));
jest.mock('../../../bot/shared/services/coaching/fidelity/fidelity-recompute.service', () => ({ recomputeFidelityForSession: jest.fn(async () => ({ recomputed: true })) }));

const { recomputeFidelityForSession } = require('../../../bot/shared/services/coaching/fidelity/fidelity-recompute.service');
const Worker = require('../../../bot/workers/lesson-plan-extraction.worker');

function seed(status) {
  mockDb = makeFakeDb({ coaching_sessions: [{ id: 's1', user_id: 'u1', status, lesson_plan_r2_key: 'k', lesson_plan_format: 'pdf', lesson_plan_extraction_status: 'pending' }] });
}
const row = () => mockDb.tables.coaching_sessions[0];
const saved = process.env.LP_FIDELITY_ENABLED;
afterEach(() => { if (saved === undefined) delete process.env.LP_FIDELITY_ENABLED; else process.env.LP_FIDELITY_ENABLED = saved; recomputeFidelityForSession.mockClear(); });

describe('lesson-plan extraction worker', () => {
  test('stores the FULL plan text, not only the excerpt', async () => {
    seed('analyzing');
    await Worker.process({ coachingSessionId: 's1', r2Key: 'k', fileType: 'pdf', userId: 'u1' });
    expect(row().lesson_plan_text).toBe(mockPlanText.trim());
    expect(row().lesson_plan_text.length).toBeGreaterThan(500);
    expect(row().lesson_plan_extraction_status).toBe('completed');
  });

  test('a plan that finished reading after the analysis → fidelity recomputed (feature on)', async () => {
    process.env.LP_FIDELITY_ENABLED = 'true';
    seed('conducting_conversation');
    await Worker.process({ coachingSessionId: 's1', r2Key: 'k', fileType: 'pdf', userId: 'u1' });
    expect(recomputeFidelityForSession).toHaveBeenCalledWith('s1');
  });

  test('feature off → no recompute', async () => {
    delete process.env.LP_FIDELITY_ENABLED;
    seed('conducting_conversation');
    await Worker.process({ coachingSessionId: 's1', r2Key: 'k', fileType: 'pdf', userId: 'u1' });
    expect(recomputeFidelityForSession).not.toHaveBeenCalled();
  });
});
