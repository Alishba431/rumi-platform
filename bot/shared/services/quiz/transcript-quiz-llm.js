'use strict';
/**
 * Transcript quiz — the one LLM call shape both passes use.
 *
 * The model comes from the registry job `quiz.transcript`
 * (config/model-registry.js), read at CALL time so a settings change takes
 * effect without a restart: a valid TRANSCRIPT_QUIZ_MODEL wins, a typo is
 * ignored, and with no override the job's default is used — its OpenAI default
 * under LLM_PROVIDER=openai, where OpenRouter ids do not exist. Every call goes
 * through llm-client.getClientForModel — the one place a client is made — so
 * the deployment's LLM_PROVIDER decides where it is sent.
 *
 * Two findings from that eval are encoded here rather than left to luck:
 *   - reasoning models (gpt-5*, gemini-3.5-flash, claude, deepseek) spend
 *     the completion budget on thinking; at 6k tokens they truncated the
 *     JSON on most Urdu transcripts. Everyone gets a large budget and the
 *     reasoning ones are asked for low effort.
 *   - a truncated reply (finish_reason 'length', empty content) is a
 *     different failure from bad JSON and is reported as such.
 */

const { getClientForModel } = require('../llm-client');
const { resolveModelForJob } = require('../../config/model-registry');
const { logToFile } = require('../../utils/logger');
const { repairBackslashes } = require('../../utils/json-tex-backslashes');

const REASONING_RE = /(^|\/)(gpt-5|o[1-9]|gemini-3\.5-flash$|gemini-3-flash|claude|deepseek)/i;

/** The model a call of `job` runs on; an explicit valid `override` wins. */
function modelId(job = 'quiz.transcript', override = null) {
  return resolveModelForJob(job, { model: override || undefined }).model;
}

/**
 * A reply that carries maths (a `$` anywhere) has its TeX backslashes repaired
 * BEFORE parsing: `"$\frac{2}{9}$"` with one backslash is VALID JSON — `\f`
 * is a form feed — so it parses silently into "rac{2}{9}" and the fraction is
 * gone (the author writes stems and options as TeX). A reply with no `$` parses
 * exactly as before.
 */
function extractJson(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON object in reply');
  const body = t.slice(start, end + 1);
  return JSON.parse(body.includes('$') ? repairBackslashes(body) : body);
}

/**
 * A reply the model can simply be asked for again: nothing came back, it was cut
 * off, or it was not a JSON object. A thrown transport/API error is NOT in this
 * set — the client and the fallback ladder own those.
 */
const RETRYABLE = new Set(['EMPTY', 'TRUNCATED', 'BAD_JSON']);
/** One retry. The call is idempotent; it costs a second call only when the first was unusable. */
const MAX_ATTEMPTS = 2;

async function completeJsonOnce({
  prompt, maxTokens, label, model: modelOverride = null, job = null,
}) {
  // A pass that must NOT run on the author's model (the blind solve, which checks
  // the author's keys) names its own model and its own registry job; every other
  // pass runs on the registry job quiz.transcript.
  const jobName = job ? String(job) : 'quiz.transcript';
  const requested = modelId(jobName, modelOverride ? String(modelOverride).trim() : null);
  // Naming the job arms the client with THIS job's registry entry (model-registry.js):
  // a pass that names its own job is billed and failed over as that job instead.
  const { client, model } = getClientForModel(requested, { job: jobName });
  const reasoning = REASONING_RE.test(requested);
  const params = {
    model,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    max_tokens: maxTokens,
    // OpenRouter: returns the priced cost on the usage object (llm-client drops it
    // for a provider that does not understand it).
    usage: { include: true },
  };
  if (reasoning) params.reasoning = { effort: 'low' };
  else params.temperature = 0.4;

  const t0 = Date.now();
  const res = await client.chat.completions.create(params);
  const latencyMs = Date.now() - t0;
  const choice = res?.choices?.[0] || {};
  const raw = choice.message?.content || '';
  const usage = res?.usage || {};
  const costUsd = typeof usage.cost === 'number' ? usage.cost : null;

  if (!raw.trim()) {
    const why = choice.finish_reason === 'length' ? 'truncated' : 'empty';
    logToFile(`⚠️ ${label}: model returned ${why} reply`, { model: requested, finish: choice.finish_reason, usage });
    const err = new Error(`${label}: ${why} reply from ${requested}`);
    err.code = why.toUpperCase();
    err.costUsd = costUsd;
    throw err;
  }
  let json;
  try {
    json = extractJson(raw);
  } catch (e) {
    logToFile(`⚠️ ${label}: unusable JSON`, { model: requested, error: e.message, preview: raw.slice(0, 200) });
    const err = new Error(`${label}: bad JSON from ${requested}: ${e.message}`);
    err.code = 'BAD_JSON';
    err.costUsd = costUsd;
    throw err;
  }
  return { json, model: requested, costUsd, latencyMs, usage };
}

/**
 * The call every quiz pass makes. A reply that came back empty, cut off or
 * unparseable is asked for once more before anything fails: a single
 * `{ "topic":` reply from a model that had answered the same lesson an hour
 * earlier would otherwise fail a teacher's quiz for good, and tell them their
 * lesson could not be read. The cost of every attempt is reported.
 *
 * @param {object} args
 * @param {string} args.prompt      the whole prompt (user turn)
 * @param {number} [args.maxTokens]
 * @param {string} [args.label]     for logs
 * @param {string} [args.model]     a model id for THIS call instead of the job's registry model
 * @param {string} [args.job]       the model-registry job the call is billed and failed over as
 *                                  (default `quiz.transcript`)
 * @returns {Promise<{json:object, model:string, costUsd:number|null, latencyMs:number, usage:object}>}
 */
async function completeJson({
  prompt, maxTokens = 16000, label = 'transcript_quiz', model = null, job = null,
}) {
  let spent = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const out = await completeJsonOnce({
        prompt, maxTokens, label, model, job,
      });
      if (spent != null && out.costUsd != null) out.costUsd += spent;
      else if (spent != null) out.costUsd = spent;
      if (attempt > 1) logToFile(`✅ ${label}: usable reply on attempt ${attempt}`, { model: out.model });
      return out;
    } catch (err) {
      if (!RETRYABLE.has(err && err.code)) throw err;
      if (typeof err.costUsd === 'number') spent = (spent || 0) + err.costUsd;
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        logToFile(`↻ ${label}: retrying after ${err.code}`, { attempt, error: err.message });
      }
    }
  }
  throw lastErr;
}

module.exports = {
  completeJson, modelId, extractJson, REASONING_RE, MAX_ATTEMPTS,
};
