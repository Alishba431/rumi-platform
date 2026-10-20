'use strict';
/**
 * A plan Rumi made for the teacher is a lesson_plans row. Fidelity needs its TEXT, which then goes through the same
 * extractor as an uploaded plan (one code path, no moves table). The text is stored on the row when the plan is
 * generated (content.plan_text); older rows only have the delivered PDF, so its text layer is read instead.
 */
const { renderLinkedPlanText, planTextFromRow } = require('../../../bot/shared/services/coaching/fidelity/lesson-plan-text');

const PLAN_BODY = '## 1. LEARNING OBJECTIVES\nPupils add fractions with the same denominator.\n## 4. ENGAGE\nFold paper strips into fifths.';

function fakeDb(row) {
  const reads = [];
  return {
    reads,
    from: (table) => ({
      select: (cols) => ({
        eq: (col, val) => ({
          maybeSingle: async () => { reads.push({ table, cols, col, val }); return { data: row, error: null }; },
        }),
      }),
    }),
  };
}

describe('lesson-plan-text · planTextFromRow', () => {
  test('stored plan text is used, headed by the row\'s topic, grade and subject', () => {
    const text = planTextFromRow({ topic: 'Adding fractions', grade: '4', subject: 'Maths', content: { plan_text: PLAN_BODY } });
    expect(text.startsWith('Topic: Adding fractions\nGrade: 4\nSubject: Maths\n\n')).toBe(true);
    expect(text).toContain('Fold paper strips into fifths.');
  });

  test('a structured content object with no plan_text is flattened to readable lines', () => {
    const text = planTextFromRow({ topic: 'Plants', content: { objectives: ['name the parts of a plant'], activities: [{ step: 'Show a real plant', minutes: 5 }] } });
    expect(text).toContain('objectives: name the parts of a plant');
    expect(text).toContain('Show a real plant');
  });

  test('no usable content → null (the caller then tries the PDF)', () => {
    expect(planTextFromRow({ topic: 'x', content: null })).toBeNull();
    expect(planTextFromRow({ topic: 'x', content: { plan_text: '  ' } })).toBeNull();
    expect(planTextFromRow(null)).toBeNull();
  });
});

describe('lesson-plan-text · renderLinkedPlanText', () => {
  test('reads the row once and returns its stored text without touching the PDF', async () => {
    const db = fakeDb({ id: 'lp-1', topic: 'Adding fractions', grade: '4', subject: 'Maths', content: { plan_text: PLAN_BODY }, pdf_url: 'https://example.com/lp.pdf' });
    let fetched = false;
    const out = await renderLinkedPlanText('lp-1', { db, fetchPdfText: async () => { fetched = true; return 'pdf'; } });
    expect(out.from).toBe('content');
    expect(out.text).toContain('Fold paper strips');
    expect(fetched).toBe(false);
    expect(db.reads[0]).toMatchObject({ table: 'lesson_plans', col: 'id', val: 'lp-1' });
  });

  test('a row without stored text falls back to the delivered PDF\'s text layer', async () => {
    const db = fakeDb({ id: 'lp-2', topic: 'Adding fractions', grade: null, subject: null, content: null, pdf_url: 'https://example.com/lp.pdf' });
    const out = await renderLinkedPlanText('lp-2', { db, fetchPdfText: async (url) => `text of ${url} — ${PLAN_BODY}` });
    expect(out.from).toBe('pdf');
    expect(out.text).toContain('Topic: Adding fractions');
    expect(out.text).toContain('text of https://example.com/lp.pdf');
  });

  test('nothing readable anywhere → null, never a throw', async () => {
    expect(await renderLinkedPlanText('lp-3', { db: fakeDb({ id: 'lp-3', topic: 't', content: null, pdf_url: null }) })).toBeNull();
    expect(await renderLinkedPlanText('lp-4', { db: fakeDb(null) })).toBeNull();
    expect(await renderLinkedPlanText('lp-5', {
      db: fakeDb({ id: 'lp-5', topic: 't', content: null, pdf_url: 'https://example.com/x.pdf' }),
      fetchPdfText: async () => { throw new Error('404'); },
    })).toBeNull();
    expect(await renderLinkedPlanText(null, { db: fakeDb(null) })).toBeNull();
  });
});

describe('lesson-plan-text · planContentForPrompt', () => {
  const { planContentForPrompt } = require('../../../bot/shared/services/coaching/fidelity/lesson-plan-text');

  test('fidelity\'s cached move list never rides into another feature\'s prompt (e.g. a quiz from the plan)', () => {
    const content = { plan_text: 'the plan', objectives: ['o'], fidelity_moves: { plan_hash: 'h', moves: [{ text: 'm' }] } };
    expect(planContentForPrompt(content)).toEqual({ plan_text: 'the plan', objectives: ['o'] });
    expect(content.fidelity_moves).toBeDefined(); // the stored row is not mutated
    expect(planContentForPrompt(null)).toBeNull();
  });

  test('the quiz-from-a-plan path uses it', () => {
    const src = require('fs').readFileSync(require('path').resolve(__dirname, '../../../bot/shared/services/quiz/quiz-orchestrator.service.js'), 'utf8');
    expect(src).toContain('JSON.stringify(planContentForPrompt(lp.content))');
  });
});
