'use strict';
/**
 * The plan → moves extractor. One code path for every plan source: a plan Rumi made (its lesson_plans row rendered
 * to text), an uploaded document, or text the teacher pasted. LLM MOCKED. A plan with no usable text (a scanned
 * image-PDF has no text layer) fails loudly as lp_unparseable so the teacher hears "the plan could not be read",
 * never a phantom empty move list.
 */
const { extractUploadedLp, normalizeMoves, DEFAULT_EXTRACT_MODEL } = require('../../../bot/shared/services/coaching/fidelity/lp-upload-extractor');
const { PHASES } = require('../../../bot/shared/services/coaching/fidelity/fidelity-phases');

function fakeClient(content, usage = { prompt_tokens: 200, completion_tokens: 120 }) {
  const calls = [];
  return { calls, chat: { completions: { create: async (p) => { calls.push(p); return { choices: [{ message: { content } }], usage }; } } } };
}

const LP_TEXT = 'Lesson plan\nSubject English\nTopic Reading comprehension\nDuration 40 minutes\n' +
  '5 min Introduction: greet the pupils, show the picture on page 40, ask what place is shown.\n' +
  '20 min Development: read the passage in groups, answer the guiding questions.\n' +
  '10 min Independent: pupils write answers to two comprehension questions.\n' +
  '5 min Plenary: ask which place they found most interesting.';
const KNOBS = ['LP_FIDELITY_MODEL', 'LP_FIDELITY_EXTRACT_MODEL'];

describe('lp-upload-extractor (LLM mocked)', () => {
  const saved = {};
  beforeEach(() => { for (const k of KNOBS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of KNOBS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  test('calls the extract model in json_object mode with the extraction brief + the plan text', async () => {
    const payload = JSON.stringify({ template: 'UPLOADED', goal: 'read + comprehend', total_minutes: 40,
      moves: [{ move_id: 'm1', phase: 'warm_up', type: 'instruction', text: 'greet + show picture' }] });
    const c = fakeClient(payload);
    const out = await extractUploadedLp(LP_TEXT, { lessonId: 'sess1', client: c });
    const p = c.calls[0];
    expect(DEFAULT_EXTRACT_MODEL).toBe('google/gemini-3.8-flash');
    expect(p.model).toBe('google/gemini-3.8-flash');
    expect(Object.keys(p)).toEqual(['model', 'temperature', 'messages', 'max_completion_tokens', 'response_format']);
    expect(p.response_format).toEqual({ type: 'json_object' });
    expect(p.messages[0].content).toContain('LESSON PLAN EXTRACTOR');
    expect(p.messages[1].content).toContain('Reading comprehension');
    expect(out.goal).toBe('read + comprehend');
    expect(out.moves[0].move_id).toBe('m1');
  });

  test('LP_FIDELITY_EXTRACT_MODEL picks the extractor model on its own; else it follows LP_FIDELITY_MODEL', async () => {
    const payload = JSON.stringify({ moves: [{ text: 'greet' }] });
    process.env.LP_FIDELITY_MODEL = 'openai/gpt-5.6-luna';
    const follows = fakeClient(payload);
    await extractUploadedLp(LP_TEXT, { client: follows });
    expect(follows.calls[0].model).toBe('openai/gpt-5.6-luna');

    process.env.LP_FIDELITY_EXTRACT_MODEL = 'anthropic/claude-haiku-4.5';
    const own = fakeClient(payload);
    await extractUploadedLp(LP_TEXT, { client: own });
    expect(own.calls[0].model).toBe('anthropic/claude-haiku-4.5');
  });

  test('normalises tags: bad phase/bucket/selection → safe defaults; empty-text moves dropped; source recorded', () => {
    const moves = normalizeMoves([
      { text: 'a', phase: 'ENGAGE', bucket: 'core', selection: 'pick' },
      { move_id: 'x', phase: 'exit', bucket: 'optional_extension', selection: 'choose_one', text: 'exit q', adjudicable: false },
      { text: '   ' },
    ], 'pasted');
    expect(moves).toHaveLength(2);
    expect(moves[0]).toMatchObject({ move_id: 'm1', phase: 'explain', bucket: 'must_happen', selection: 'none', source_field: 'pasted' });
    expect(moves[1]).toMatchObject({ move_id: 'x', phase: 'exit', selection: 'choose_one', adjudicable: false });
    expect(normalizeMoves([{ text: 'a' }])[0].source_field).toBe('uploaded');
  });

  test('the phase vocabulary is the one shared list the report reads', () => {
    for (const p of PHASES) expect(normalizeMoves([{ text: 't', phase: p }])[0].phase).toBe(p);
    expect(normalizeMoves([{ text: 't', phase: 'guided_practice' }])[0].phase).toBe('guided');
  });

  test('image-only / empty plan (no text layer) → lp_unparseable, no model call', async () => {
    const c = fakeClient('{}');
    await expect(extractUploadedLp('   ', { client: c })).rejects.toMatchObject({ code: 'lp_unparseable' });
    expect(c.calls).toHaveLength(0);
  });

  test.each([
    ['prose instead of JSON', { content: 'Here are the moves: first the teacher greets…', finish: 'stop' }],
    ['an empty answer', { content: '', finish: 'stop' }],
    ['an answer cut off by the token cap', { content: '{"moves": [{"text": "greet"', finish: 'length' }],
  ])('a bad ANSWER from the model (%s) is extractor_failed — not "the plan could not be read" (review S3)', async (_n, a) => {
    const calls = [];
    const client = { chat: { completions: { create: async (p) => { calls.push(p); return { choices: [{ message: { content: a.content }, finish_reason: a.finish }] }; } } } };
    const err = await extractUploadedLp(LP_TEXT, { client }).catch((e) => e);
    expect(err.code).toBe('extractor_failed');
    expect(calls).toHaveLength(2);
  });

  test('LP_FIDELITY_EXTRACT_MAX_TOKENS sets the extractor\'s cap (default 8000)', async () => {
    const payload = JSON.stringify({ moves: [{ text: 'greet' }] });
    const c1 = fakeClient(payload);
    await extractUploadedLp(LP_TEXT, { client: c1 });
    expect(c1.calls[0].max_completion_tokens).toBe(8000);
    process.env.LP_FIDELITY_EXTRACT_MAX_TOKENS = '12000';
    try {
      const c2 = fakeClient(payload);
      await extractUploadedLp(LP_TEXT, { client: c2 });
      expect(c2.calls[0].max_completion_tokens).toBe(12000);
    } finally { delete process.env.LP_FIDELITY_EXTRACT_MAX_TOKENS; }
  });

  test('model returns zero usable moves → lp_unparseable after a retry', async () => {
    const c = fakeClient(JSON.stringify({ template: 'UPLOADED', moves: [] }));
    await expect(extractUploadedLp(LP_TEXT, { client: c })).rejects.toMatchObject({ code: 'lp_unparseable' });
    expect(c.calls).toHaveLength(2);
  });

  test('composes with the scorer: extracted moves score like any other', async () => {
    const { scoreFidelity } = require('../../../bot/shared/services/coaching/fidelity/fidelity-scorer');
    const payload = JSON.stringify({ template: 'UPLOADED', goal: 'g', total_minutes: 40, moves: [
      { move_id: 'm1', phase: 'warm_up', type: 'instruction', text: 'greet', bucket: 'must_happen' },
      { move_id: 'm2', phase: 'exit', type: 'check', text: 'exit q', bucket: 'must_happen' },
    ] });
    const ext = await extractUploadedLp(LP_TEXT, { client: fakeClient(payload) });
    const analysis = scoreFidelity(ext.moves, [{ move_id: 'm1', verdict: 'executed' }, { move_id: 'm2', verdict: 'not_done' }]);
    expect(analysis.fidelity_pct).toBe(50);
    expect(analysis.prescribed_count).toBe(2);
  });
});
