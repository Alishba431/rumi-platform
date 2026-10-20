'use strict';
/**
 * A plan Rumi makes for a teacher must keep its TEXT, or fidelity has nothing to read when the teacher later says
 * "this is the plan I taught". Lesson-plan generation stored only the Gamma URL and the PDF URL (content: null), so
 * a picked Rumi-made plan always graded as "no plan linked". The worker now reads the delivered PDF's text layer and
 * stores it on the row as content.plan_text. Gamma (the network) and the PDF parser are mocked; the worker runs.
 */
const fs = require('fs');

jest.mock('../../../bot/shared/utils/logger', () => ({ logToFile: jest.fn(), logWarn: jest.fn() }));
jest.mock('../../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
jest.mock('pdf-parse', () => jest.fn(async () => ({ text: 'LEARNING OBJECTIVES\nPupils add fractions with the same denominator.\nENGAGE: fold paper strips into fifths.' })), { virtual: true });
jest.mock('../../../bot/shared/services/content.service', () => ({
  generateLessonPlan: jest.fn(async () => ({ gammaUrl: 'https://gamma.example.com/d/1', pdfUrl: 'https://cdn.example.com/lp.pdf' })),
  generatePresentation: jest.fn(),
  downloadPDF: jest.fn(async (url, filename, dir) => {
    const p = require('path').join(dir, filename);
    require('fs').writeFileSync(p, Buffer.from('%PDF-1.4 fake'));
    return p;
  }),
}));
jest.mock('../../../bot/shared/services/whatsapp.service', () => ({ sendDocument: jest.fn(async () => true), sendMessage: jest.fn(async () => true) }));
jest.mock('../../../bot/shared/services/lesson-plan-queue.service', () => ({
  getRequest: jest.fn(async () => null), markProcessing: jest.fn(), markCompleted: jest.fn(), markFailed: jest.fn(),
}));
jest.mock('../../../bot/shared/services/feature-linker.service', () => ({ suggestNext: jest.fn() }));
jest.mock('../../../bot/shared/services/feature-registration.service', () => ({ checkAndTriggerRegistration: jest.fn() }));
jest.mock('../../../bot/shared/database/bot-helpers', () => ({ storeLessonPlan: jest.fn(async () => ({ id: 'lp-1' })) }));

const { storeLessonPlan } = require('../../../bot/shared/database/bot-helpers');
const pdf = require('pdf-parse');

describe('lesson-plan generation keeps the plan text', () => {
  beforeEach(() => { storeLessonPlan.mockClear(); pdf.mockClear(); });

  test('the delivered PDF\'s text is stored as content.plan_text, and the temp file is still cleaned up', async () => {
    const Worker = require('../../../bot/workers/lesson-plan-generation.worker');
    await Worker.process({ requestId: 'r1', userId: 'u1', phoneNumber: 'matrix:@t:local', topic: 'Adding fractions', fullMessage: 'make a plan', language: 'en' });
    expect(storeLessonPlan).toHaveBeenCalledTimes(1);
    const args = storeLessonPlan.mock.calls[0];
    expect(args.slice(0, 5)).toEqual(['u1', 'Adding fractions', 'lesson_plan', 'https://gamma.example.com/d/1', 'https://cdn.example.com/lp.pdf']);
    expect(args[5]).toEqual({ plan_text: expect.stringContaining('fold paper strips into fifths') });
    expect(fs.existsSync(require('path').join(process.env.TEMP_DIR || '/tmp', 'lesson_plan_Adding_fractions.pdf'))).toBe(false);
  });

  test('a PDF that cannot be read still stores the plan (content stays null)', async () => {
    pdf.mockImplementationOnce(async () => { throw new Error('bad xref'); });
    const Worker = require('../../../bot/workers/lesson-plan-generation.worker');
    await Worker.process({ requestId: 'r2', userId: 'u1', phoneNumber: 'matrix:@t:local', topic: 'Plants', fullMessage: 'make a plan', language: 'en' });
    expect(storeLessonPlan).toHaveBeenCalledTimes(1);
    expect(storeLessonPlan.mock.calls[0][5]).toBeNull();
  });
});
