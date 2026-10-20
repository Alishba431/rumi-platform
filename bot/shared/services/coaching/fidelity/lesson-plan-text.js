'use strict';
/**
 * The text of a plan Rumi made for the teacher (a lesson_plans row), for the fidelity extractor.
 *
 * A Rumi-made plan goes through the same plan → moves extractor as an uploaded or pasted one: one code path, no
 * separate moves table. Lesson-plan generation stores the plan's text on the row (content.plan_text); a row made
 * before that, or by a path that stores no text, still has the delivered PDF, so its text layer is read instead.
 * Never throws: no readable text is null, and the session is then graded as having no plan (lp_absent).
 */
const MIN_CHARS = 40;
const MAX_FLATTEN_DEPTH = 4;

function flatten(value, depth = 0) {
  if (value == null || depth > MAX_FLATTEN_DEPTH) return [];
  if (typeof value === 'string' || typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap((v) => flatten(v, depth + 1));
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => {
      const inner = flatten(v, depth + 1);
      if (!inner.length) return [];
      return typeof v === 'object' && !Array.isArray(v) ? [`${k}:`, ...inner] : [`${k}: ${inner.join('; ')}`];
    });
  }
  return [];
}

function header(row) {
  return [
    row.topic ? `Topic: ${row.topic}` : null,
    row.grade ? `Grade: ${row.grade}` : null,
    row.subject ? `Subject: ${row.subject}` : null,
  ].filter(Boolean).join('\n');
}

function withHeader(row, body) {
  const h = header(row);
  return h ? `${h}\n\n${body}` : body;
}

/**
 * @param {object} row lesson_plans row
 * @returns {string|null} the plan's text from its stored content, or null when there is none worth reading
 */
function planTextFromRow(row) {
  if (!row || !row.content) return null;
  const c = row.content;
  let body = null;
  if (typeof c === 'string') body = c;
  else if (typeof c.plan_text === 'string') body = c.plan_text;
  else if (typeof c === 'object') {
    // fidelity_moves is fidelity's own cache of the moves, not plan text.
    const { plan_text: _ignored, fidelity_moves: _moves, ...rest } = c;
    body = flatten(rest).join('\n');
  }
  if (!body || body.trim().length < MIN_CHARS) return null;
  return withHeader(row, body.trim());
}

/**
 * A lesson_plans row's content for another feature's prompt (a quiz from the plan): without fidelity's cached move
 * list, which is fidelity's own bookkeeping, not plan content. The row itself is not changed.
 */
function planContentForPrompt(content) {
  if (!content || typeof content !== 'object') return content || null;
  const { fidelity_moves: _moves, ...rest } = content;
  return rest;
}

// A plan PDF is a few hundred KB; anything far bigger is not a plan, and is not read into memory.
const MAX_PDF_BYTES = 25 * 1024 * 1024;

async function defaultFetchPdfText(url) {
  const axios = require('axios');
  const pdf = require('pdf-parse');
  const res = await axios.get(url, {
    responseType: 'arraybuffer', timeout: 30000, maxContentLength: MAX_PDF_BYTES, maxBodyLength: MAX_PDF_BYTES,
  });
  const parsed = await pdf(Buffer.from(res.data));
  return (parsed.text || '').trim();
}

/**
 * The text layer of a plan PDF on disk, as the content to store on its lesson_plans row — or null when the file has
 * no readable text. Called by lesson-plan generation right after the PDF is delivered.
 * @param {string} pdfPath
 * @returns {Promise<{plan_text:string}|null>}
 */
async function planContentFromPdfFile(pdfPath) {
  try {
    const pdf = require('pdf-parse');
    const parsed = await pdf(require('fs').readFileSync(pdfPath));
    const text = (parsed.text || '').trim();
    return text.length >= MIN_CHARS ? { plan_text: text } : null;
  } catch (e) {
    try { require('../../../utils/logger').logToFile('[lp-fidelity] could not read the plan PDF text (plan stored without it)', { error: e.message }); } catch (_) { /* never fails */ }
    return null;
  }
}

/**
 * @param {string} lessonPlanId lesson_plans.id
 * @param {{db?:object, fetchPdfText?:Function, log?:Function}} deps
 * @returns {Promise<{text:string, from:'content'|'pdf'}|null>}
 */
async function renderLinkedPlanText(lessonPlanId, deps = {}) {
  if (!lessonPlanId) return null;
  const log = deps.log || ((m, d) => { try { require('../../../utils/logger').logToFile(m, d); } catch (_) { /* never fails */ } });
  try {
    const db = deps.db || require('../../../config/supabase');
    const { data: row } = await db
      .from('lesson_plans')
      .select('id, topic, grade, subject, content, pdf_url')
      .eq('id', lessonPlanId)
      .maybeSingle();
    if (!row) return null;

    const stored = planTextFromRow(row);
    if (stored) return { text: stored, from: 'content' };

    if (!row.pdf_url) return null;
    const fetchPdfText = deps.fetchPdfText || defaultFetchPdfText;
    const pdfText = await fetchPdfText(row.pdf_url);
    if (!pdfText || pdfText.trim().length < MIN_CHARS) return null;
    return { text: withHeader(row, pdfText.trim()), from: 'pdf' };
  } catch (e) {
    log('[lp-fidelity] could not read the linked lesson plan', { lessonPlanId, error: e.message });
    return null;
  }
}

module.exports = { renderLinkedPlanText, planTextFromRow, planContentFromPdfFile, planContentForPrompt };
