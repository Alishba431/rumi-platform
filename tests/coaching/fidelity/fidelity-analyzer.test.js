'use strict';
/**
 * The fidelity grader call. The LLM is MOCKED (an injected client): the CALL SHAPE and the PARSING are what is
 * under test, not the model. A grading that cannot be trusted (empty, cut off by the token cap, verdicts that name
 * no prescribed move) is retried once and then reported with a reason, never scored — the scorer would read every
 * unjudged move as not_done, a false miss that blames the teacher.
 */
const { analyzeFidelity, DEFAULT_FIDELITY_MODEL } = require('../../../bot/shared/services/coaching/fidelity/fidelity-analyzer');
const { scoreFidelity } = require('../../../bot/shared/services/coaching/fidelity/fidelity-scorer');
const { GRADER_BRIEF, buildUserPrompt } = require('../../../bot/shared/services/coaching/fidelity/grader-prompt');

let hasJsonrepair = true;
try { require.resolve('jsonrepair', { paths: [require.resolve('../../../bot/shared/services/coaching/fidelity/fidelity-analyzer')] }); } catch (_) { hasJsonrepair = false; }

// A fake OpenRouter client: records the params, answers from a queue (or the same answer every time).
function fakeClient(answers, usage = { prompt_tokens: 100, completion_tokens: 50 }) {
  const calls = [];
  const queue = Array.isArray(answers) ? [...answers] : null;
  return {
    calls,
    chat: {
      completions: {
        create: async (p) => {
          calls.push(p);
          const a = queue ? queue.shift() : answers;
          const { content, finish } = typeof a === 'string' ? { content: a, finish: 'stop' } : a;
          return { choices: [{ message: { content }, finish_reason: finish }], usage };
        },
      },
    },
  };
}

const MOVES = [
  { move_id: 'm1', phase: 'explain', type: 'modelling', text: 'Model adding fractions with the same denominator', bucket: 'must_happen', selection: 'none', track_time_on_task: false, prescribed_minutes: null, adjudicable: true },
  { move_id: 'm2', phase: 'exit', type: 'check', text: 'Exit ticket', bucket: 'must_happen', selection: 'choose_one', track_time_on_task: false, prescribed_minutes: null, adjudicable: true },
];
const META = { goal: 'add fractions with the same denominator' };
const TRANSCRIPT = '[05:00] Teacher (EN): One fifth plus two fifths — the bottom number stays the same.';
const GOOD = JSON.stringify({ verdicts: [{ move_id: 'm1', verdict: 'executed', evidence: '[05:00] One fifth…' }, { move_id: 'm2', verdict: 'not_done', evidence: '' }] });
const KNOBS = ['LP_FIDELITY_MODEL', 'LP_FIDELITY_REASONING_EFFORT', 'LP_FIDELITY_MAX_TOKENS', 'LP_FIDELITY_EMPTY_RETRY_EFFORT'];

describe('fidelity-analyzer (LLM mocked)', () => {
  const saved = {};
  beforeEach(() => { for (const k of KNOBS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of KNOBS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  test('default grader is google/gemini-3.8-flash, overridable with LP_FIDELITY_MODEL', async () => {
    expect(DEFAULT_FIDELITY_MODEL).toBe('google/gemini-3.8-flash');
    const client = fakeClient(GOOD);
    await analyzeFidelity(MOVES, TRANSCRIPT, META, { client });
    expect(client.calls[0].model).toBe('google/gemini-3.8-flash');

    process.env.LP_FIDELITY_MODEL = 'openai/gpt-5.6-luna';
    const other = fakeClient(GOOD);
    await analyzeFidelity(MOVES, TRANSCRIPT, META, { client: other });
    expect(other.calls[0].model).toBe('openai/gpt-5.6-luna');
  });

  test('the request carries only keys the OSS llm-client passes through (no cost-attribution `job` field)', async () => {
    const client = fakeClient(GOOD);
    await analyzeFidelity(MOVES, TRANSCRIPT, META, { client });
    const p = client.calls[0];
    expect(Object.keys(p)).toEqual(['model', 'temperature', 'messages', 'max_completion_tokens', 'response_format']);
    expect(p.temperature).toBe(0);
    expect(p.response_format).toEqual({ type: 'json_object' });
    expect(p.messages[0]).toEqual({ role: 'system', content: GRADER_BRIEF });
    expect(p.messages[1]).toEqual({ role: 'user', content: buildUserPrompt(META, MOVES, TRANSCRIPT) });
    expect(p.max_completion_tokens).toBe(16000);
  });

  test('the grader is NOT shown the bucket tag (it drives the denominator; hiding it means no gaming the score)', () => {
    const user = buildUserPrompt(META, MOVES, TRANSCRIPT);
    expect(user).toContain('"selection"');
    expect(user).not.toContain('must_happen');
    expect(user).toContain('One fifth plus two fifths');
  });

  test('returns verdicts + narrative + language_note + moderators; never a score', async () => {
    const payload = {
      language_note: 'English',
      verdicts: [{ move_id: 'm1', verdict: 'executed' }, { move_id: 'm2', verdict: 'partial', option_taken: 'short answer' }],
      narrative: 'The teacher modelled the method and started an exit check.',
      moderators: { plan_navigability: 'clear', note: '' },
    };
    const out = await analyzeFidelity(MOVES, TRANSCRIPT, META, { client: fakeClient(JSON.stringify(payload)) });
    expect(out.verdicts).toHaveLength(2);
    expect(out.narrative).toMatch(/exit check/);
    expect(out.moderators.plan_navigability).toBe('clear');
    expect(out).not.toHaveProperty('fidelity_pct');
    expect(out.usage.completion_tokens).toBe(50);
    expect(out.model).toBe('google/gemini-3.8-flash');
  });

  test('verdicts keyed by move_id become the array the scorer reads', async () => {
    const keyed = JSON.stringify({ verdicts: { m1: { verdict: 'executed' }, m2: 'not_done' } });
    const out = await analyzeFidelity(MOVES, TRANSCRIPT, META, { client: fakeClient(keyed) });
    expect(out.verdicts).toEqual([{ move_id: 'm1', verdict: 'executed' }, { move_id: 'm2', verdict: 'not_done' }]);
  });

  (hasJsonrepair ? test : test.skip)('jsonrepair rescues a slightly-malformed payload (trailing comma)', async () => {
    const sloppy = '{ "verdicts": [ { "move_id": "m1", "verdict": "executed", } ], "narrative": "ok", }';
    const out = await analyzeFidelity(MOVES, TRANSCRIPT, META, { client: fakeClient(sloppy) });
    expect(out.verdicts[0].verdict).toBe('executed');
  });

  test('unparseable output → one retry, then a fidelity_unavailable error carrying the reason', async () => {
    const client = fakeClient('this is not json at all <<<');
    const err = await analyzeFidelity(MOVES, TRANSCRIPT, META, { client }).catch((e) => e);
    expect(err.code).toBe('fidelity_unavailable');
    // Strict parse fails outright; jsonrepair (when installed) coerces the text into a non-object. Either way the
    // reason names it and nothing is scored.
    expect(['unparseable_json', 'no_verdicts']).toContain(err.reason);
    expect(client.calls).toHaveLength(2);
  });

  test('an empty answer is retried at the same configuration, then reported as empty_content', async () => {
    const client = fakeClient(['', '']);
    await expect(analyzeFidelity(MOVES, TRANSCRIPT, META, { client })).rejects.toMatchObject({ reason: 'empty_content' });
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]).not.toHaveProperty('reasoning');
  });

  test('an empty first answer that recovers is marked empty_retry', async () => {
    const out = await analyzeFidelity(MOVES, TRANSCRIPT, META, { client: fakeClient(['', GOOD]) });
    expect(out.empty_retry).toBe(true);
  });

  test('cut off by the token cap with a move unjudged → retried, then truncated (never scored)', async () => {
    const half = { content: JSON.stringify({ verdicts: [{ move_id: 'm1', verdict: 'executed' }] }), finish: 'length' };
    const client = fakeClient([half, half]);
    await expect(analyzeFidelity(MOVES, TRANSCRIPT, META, { client })).rejects.toMatchObject({ reason: 'truncated' });
  });

  test('verdicts that name no prescribed move → incomplete_verdicts', async () => {
    const wrong = JSON.stringify({ verdicts: [{ move_id: 'x9', verdict: 'executed' }] });
    await expect(analyzeFidelity(MOVES, TRANSCRIPT, META, { client: fakeClient(wrong) })).rejects.toMatchObject({ reason: 'incomplete_verdicts' });
  });

  test('a stopped answer that leaves a move unjudged is kept, and the gap counted', async () => {
    const one = JSON.stringify({ verdicts: [{ move_id: 'm1', verdict: 'executed' }] });
    const out = await analyzeFidelity(MOVES, TRANSCRIPT, META, { client: fakeClient(one) });
    expect(out.missing_verdicts).toBe(1);
  });

  test('LP_FIDELITY_REASONING_EFFORT and LP_FIDELITY_MAX_TOKENS shape the request; junk is ignored', async () => {
    process.env.LP_FIDELITY_REASONING_EFFORT = 'medium';
    process.env.LP_FIDELITY_MAX_TOKENS = '8000';
    const client = fakeClient(GOOD);
    const out = await analyzeFidelity(MOVES, TRANSCRIPT, META, { client });
    expect(client.calls[0].reasoning).toEqual({ effort: 'medium' });
    expect(client.calls[0].max_completion_tokens).toBe(8000);
    expect(out.reasoning_effort).toBe('medium');

    process.env.LP_FIDELITY_REASONING_EFFORT = 'loud';
    process.env.LP_FIDELITY_MAX_TOKENS = '999999';
    const capped = fakeClient(GOOD);
    await analyzeFidelity(MOVES, TRANSCRIPT, META, { client: capped });
    expect(capped.calls[0]).not.toHaveProperty('reasoning');
    expect(capped.calls[0].max_completion_tokens).toBe(32000);
  });

  test('composes with the scorer: all not_adjudicable → recording_unusable, null pct', async () => {
    const garble = JSON.stringify({
      verdicts: [{ move_id: 'm1', verdict: 'not_adjudicable' }, { move_id: 'm2', verdict: 'not_adjudicable' }],
      moderators: { note: 'recording_unusable' },
    });
    const out = await analyzeFidelity(MOVES, TRANSCRIPT, META, { client: fakeClient(garble) });
    const analysis = scoreFidelity(MOVES, out.verdicts);
    expect(analysis.fidelity_pct).toBeNull();
    expect(analysis.recording_unusable).toBe(true);
  });

  test('composes with the scorer: real verdicts → pct + per-move evidence', async () => {
    const out = await analyzeFidelity(MOVES, TRANSCRIPT, META, { client: fakeClient(GOOD) });
    const analysis = scoreFidelity(MOVES, out.verdicts);
    expect(analysis.fidelity_pct).toBe(50);
    expect(analysis.moves.find((m) => m.move_id === 'm1').evidence).toContain('[05:00]');
  });
});
