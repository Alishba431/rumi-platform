'use strict';
/**
 * Extract the prescribed move list from a lesson plan's TEXT — whatever its source: a plan Rumi made for the teacher
 * (its stored text), an uploaded document, or text pasted into the chat. Free-form plan text → fidelity-moves-v1
 * objects, so the grader and the scorer are identical downstream. The LLM assigns the tags (there are no field paths
 * in a teacher's document); normalizeMoves clamps them. json_object mode, jsonrepair-tolerant, injectable client.
 *
 * An image-only PDF (a scanned or photographed plan) has no text layer, so there is nothing to read here: require
 * usable text and fail loudly with lp_unparseable rather than return a phantom empty list.
 *
 * Model: LP_FIDELITY_EXTRACT_MODEL, else LP_FIDELITY_MODEL, else the default grader model — one var drives both
 * unless a deployment wants a cheaper extractor.
 */
const { UPLOAD_EXTRACTION_BRIEF, buildUploadPrompt } = require('./upload-extractor-prompt');
const { canonicalPhase } = require('./fidelity-phases');

const DEFAULT_EXTRACT_MODEL = 'google/gemini-3.8-flash';
const MIN_PLAN_CHARS = 40;
const BUCKETS = new Set(['must_happen', 'adaptive_set', 'optional_extension']);
const SELECTIONS = new Set(['none', 'choose_one', 'per_group']);
const SOURCES = new Set(['linked', 'uploaded', 'pasted']);

let _jsonrepair = null;
try { _jsonrepair = require('jsonrepair').jsonrepair; } catch (_) { /* strict parse fallback */ }
function safeJsonParse(content) {
  try { return JSON.parse(content); } catch (e) {
    if (!_jsonrepair) throw e;
    return JSON.parse(_jsonrepair(content));
  }
}

function extractModel() {
  return process.env.LP_FIDELITY_EXTRACT_MODEL || process.env.LP_FIDELITY_MODEL || DEFAULT_EXTRACT_MODEL;
}

// Defensively normalise the LLM's move objects — never let a malformed tag reach the scorer.
function normalizeMoves(moves, source = 'uploaded') {
  const sourceField = SOURCES.has(source) ? source : 'uploaded';
  return (moves || []).map((m, i) => ({
    move_id: m.move_id || `m${i + 1}`,
    phase: canonicalPhase(m.phase) || 'explain',
    type: m.type || 'instruction',
    text: (m.text || '').trim(),
    source_field: sourceField,
    bucket: BUCKETS.has(m.bucket) ? m.bucket : 'must_happen',
    selection: SELECTIONS.has(m.selection) ? m.selection : 'none',
    track_time_on_task: m.track_time_on_task === true,
    prescribed_minutes: Number.isFinite(m.prescribed_minutes) ? m.prescribed_minutes : null,
    adjudicable: m.adjudicable !== false,
    observable_in_photo: m.observable_in_photo === true,
  })).filter((m) => m.text.length > 0);
}

const DEFAULT_EXTRACT_MAX_TOKENS = 8000;
const MAX_TOKENS_CEILING = 32000;

/** LP_FIDELITY_EXTRACT_MAX_TOKENS, default 8000, at most 32000. */
function extractMaxTokens() {
  const n = Math.floor(Number(process.env.LP_FIDELITY_EXTRACT_MAX_TOKENS));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_TOKENS_CEILING) : DEFAULT_EXTRACT_MAX_TOKENS;
}

function extractorFailed(message) {
  const err = new Error(`extractor_failed: ${message}`);
  err.code = 'extractor_failed';
  return err;
}

function unparseable(message, cause) {
  const err = new Error(`lp_unparseable: ${message}`);
  err.code = 'lp_unparseable';
  if (cause) err.cause = cause;
  return err;
}

/**
 * @param {string} lpText  the plan's text (must have a real text layer)
 * @param {{lessonId?:string, source?:'linked'|'uploaded'|'pasted', client?:object, model?:string, maxTokens?:number}} opts
 * @returns {Promise<{template:'UPLOADED', goal, total_minutes, moves, usage, model}>}
 */
async function extractUploadedLp(lpText, opts = {}) {
  if (!lpText || String(lpText).trim().length < MIN_PLAN_CHARS) {
    throw unparseable('the plan has no usable text (a scanned image-PDF has no text layer)');
  }
  const model = opts.model || extractModel();
  const client = opts.client || require('../../llm-client').getClient();
  const user = buildUploadPrompt(lpText, opts.lessonId);

  // Two different failures, two different messages for the teacher: a plan with no teaching moves in it is "the plan
  // could not be read" (lp_unparseable); a bad ANSWER from the model — prose, broken JSON, empty, cut off by the
  // token cap — is our failure, "the check couldn't run" (extractor_failed).
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await client.chat.completions.create({
      model,
      temperature: 0,
      messages: [{ role: 'system', content: UPLOAD_EXTRACTION_BRIEF }, { role: 'user', content: user }],
      max_completion_tokens: opts.maxTokens || extractMaxTokens(),
      response_format: { type: 'json_object' },
    });
    const choice = response.choices && response.choices[0];
    const content = (choice && choice.message && choice.message.content) || '';
    const finishReason = (choice && choice.finish_reason) || null;
    if (!String(content).trim()) { lastErr = extractorFailed('empty answer'); continue; }
    if (finishReason === 'length') { lastErr = extractorFailed('answer cut off by the token cap'); continue; }
    let parsed;
    try { parsed = safeJsonParse(content); } catch (e) { lastErr = extractorFailed(`unparseable answer: ${e.message}`); continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.moves)) {
      lastErr = extractorFailed('answer has no moves list');
      continue;
    }
    const moves = normalizeMoves(parsed.moves, opts.source);
    if (moves.length === 0) { lastErr = unparseable('the extractor found no teaching moves in the plan'); continue; }
    return {
      template: 'UPLOADED',
      goal: parsed.goal || null,
      total_minutes: Number.isFinite(parsed.total_minutes) ? parsed.total_minutes : null,
      moves,
      usage: response.usage || {},
      model,
    };
  }
  throw lastErr;
}

module.exports = { extractUploadedLp, normalizeMoves, DEFAULT_EXTRACT_MODEL, MIN_PLAN_CHARS };
