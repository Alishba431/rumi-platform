'use strict';
/**
 * The report step re-writes analysis_data through an "enhance with the teacher's reflections" LLM pass whose output
 * schema has no lp_fidelity key — the same landmine that once dropped the reflective corpus. The fidelity blob is
 * code-owned (a deterministic score, quoted evidence): it must never be sent through that rewrite and must come out
 * byte-identical. The enhance call runs for real against a fake OpenRouter client.
 */
jest.mock('../../../bot/shared/config/supabase', () => ({ from: jest.fn(() => ({ select: () => ({ eq: () => ({ eq: () => ({ neq: async () => ({ count: 0, error: null }) }) }) }) })) }));
jest.mock('../../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('jsonrepair', () => ({ jsonrepair: (s) => s }), { virtual: true });
jest.mock('dotenv', () => ({ config: () => ({}) }), { virtual: true });

const GPT5MiniService = require('../../../bot/shared/services/gpt5-mini.service');

const LP = {
  status: 'ok', source: 'linked', fidelity_pct: 66.7, band: 'partial',
  moves: [{ move_id: 'm1', verdict: 'executed', evidence: '[00:50] fold the strip', counted: true, credit: 1 }],
};

function fakeOpenAI(answer) {
  const calls = [];
  return { calls, chat: { completions: { create: async (p) => { calls.push(p); return { choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }; } } } };
}

describe('enhanceAnalysisWithReflections keeps lp_fidelity', () => {
  const original = GPT5MiniService.openai;
  afterAll(() => { GPT5MiniService.openai = original; });

  const conversation = { questions: [{ question_number: 1, question: 'What went well?', answer: 'The strips helped.' }] };

  test('the blob is not sent to the rewrite, and comes back identical', async () => {
    const client = fakeOpenAI({ framework: 'fico', executive_summary: 'rewritten' });
    GPT5MiniService.openai = client;
    const out = await GPT5MiniService.enhanceAnalysisWithReflections({ framework: 'fico', lp_fidelity: LP }, '[00:50] t', conversation, {}, null, null);
    expect(out.lp_fidelity).toEqual(LP);
    expect(client.calls[0].messages[1].content).not.toContain('lp_fidelity');
    expect(client.calls[0].messages[1].content).not.toContain('fold the strip');
  });

  test('a rewrite that invents its own lp_fidelity is overruled by the measured one', async () => {
    GPT5MiniService.openai = fakeOpenAI({ framework: 'fico', lp_fidelity: { status: 'ok', fidelity_pct: 100, band: 'high' } });
    const out = await GPT5MiniService.enhanceAnalysisWithReflections({ framework: 'fico', lp_fidelity: LP }, 't', conversation, {}, null, null);
    expect(out.lp_fidelity).toEqual(LP);
  });
});
