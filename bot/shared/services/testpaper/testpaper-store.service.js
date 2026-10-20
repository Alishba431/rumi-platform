'use strict';
/**
 * Where test papers live: the ask (`test_paper_requests`) and every version
 * of the paper made from it (`test_papers`).
 *
 * Two rules shape everything here:
 *
 *   * A ready paper is never rewritten. An edit inserts the next version,
 *     pointing at the one it came from, so "my papers" can always re-send
 *     exactly the paper a teacher printed and handed out — and a failed edit
 *     leaves the working version where it was.
 *
 *   * Every read is owner-checked in the query itself. A paper id travels
 *     through chat (in a button id, a numbered menu); nothing stops a
 *     different teacher's id arriving here, and it must come back as nothing.
 *
 * The paper's PDF is not stored. It is re-rendered from `exam_json` whenever it
 * is sent — rendering is deterministic and takes about a second — so a
 * deployment needs no object storage for this feature, and a re-send can never
 * drift from the stored questions.
 */

const supabase = require('../../config/supabase');
const { logToFile } = require('../../utils/logger');

const REQUEST_COLUMNS = 'id, user_id, source_kind, source_ref, source_label, source_text, subject, grade, '
  + 'language, content_source, question_types, question_count, total_marks, created_at';
const PAPER_COLUMNS = 'id, request_id, version, edited_from, edit_instruction, status, title, exam_json, '
  + 'question_count, total_marks, model, error_code, created_at, ready_at';

/** How many requests "my papers" looks back over. */
const LIST_LIMIT = 10;

async function createRequest(req) {
  const { data, error } = await supabase
    .from('test_paper_requests')
    .insert({
      user_id: req.userId,
      source_kind: req.sourceKind,
      source_ref: req.sourceRef || {},
      source_label: req.sourceLabel || null,
      source_text: req.sourceText,
      subject: req.subject || null,
      grade: req.grade != null && req.grade !== '' ? String(req.grade) : null,
      language: req.language || 'en',
      content_source: req.contentSource || 'unseen',
      question_types: req.questionTypes || [],
      question_count: req.questionCount || null,
      total_marks: req.totalMarks || null,
    })
    .select(REQUEST_COLUMNS)
    .single();
  if (error) throw new Error(`test paper request not saved: ${error.message}`);
  return data;
}

/**
 * Open the next version of a request's paper, in `generating`. The version is
 * the highest number the request has so far plus one; UNIQUE (request_id,
 * version) turns the rare double-tap race into an error rather than two
 * "version 2"s.
 */
async function createPaper({ requestId, editedFrom = null, editInstruction = null }) {
  const { data: last } = await supabase
    .from('test_papers')
    .select('version')
    .eq('request_id', requestId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  const version = (last && Number(last.version)) ? Number(last.version) + 1 : 1;

  const { data, error } = await supabase
    .from('test_papers')
    .insert({
      request_id: requestId,
      version,
      edited_from: editedFrom,
      edit_instruction: editInstruction ? String(editInstruction).slice(0, 2000) : null,
      status: 'generating',
    })
    .select('id, request_id, version, edited_from, status')
    .single();
  if (error) throw new Error(`test paper not opened: ${error.message}`);
  return data;
}

async function markReady(paperId, { title, examJson, questionCount, totalMarks, tokenData = {} }) {
  const { error } = await supabase
    .from('test_papers')
    .update({
      status: 'ready',
      title: title || null,
      exam_json: examJson,
      question_count: questionCount,
      total_marks: totalMarks,
      model: tokenData.model || null,
      input_tokens: tokenData.inputTokens ?? null,
      output_tokens: tokenData.outputTokens ?? null,
      ready_at: new Date().toISOString(),
    })
    .eq('id', paperId)
    .eq('status', 'generating');
  if (error) throw new Error(`test paper not saved: ${error.message}`);
}

/**
 * Record the subject the model read from an upload that came with none. Only
 * ever fills a blank: a subject the teacher's source named is never replaced.
 */
async function setSubject(requestId, subject) {
  if (!requestId || !subject) return;
  const { data: row } = await supabase.from('test_paper_requests').select('subject').eq('id', requestId).maybeSingle();
  if (!row || row.subject) return;
  const { error } = await supabase.from('test_paper_requests').update({ subject: String(subject).slice(0, 80) }).eq('id', requestId);
  if (error) logToFile('⚠️ test paper subject not recorded', { requestId, error: error.message });
}

/** Only an in-flight row can fail; a ready paper keeps its status whatever happens later. */
async function markFailed(paperId, code, detail) {
  const { error } = await supabase
    .from('test_papers')
    .update({
      status: 'failed',
      error_code: code || 'UNKNOWN',
      error_detail: detail ? String(detail).slice(0, 500) : null,
    })
    .eq('id', paperId)
    .eq('status', 'generating');
  if (error) logToFile('⚠️ test paper failure not recorded', { paperId, code, error: error.message });
}

async function _ownedRequest(requestId, userId) {
  const { data } = await supabase
    .from('test_paper_requests')
    .select(REQUEST_COLUMNS)
    .eq('id', requestId)
    .eq('user_id', userId)
    .maybeSingle();
  return data || null;
}

/** A paper and its request — only for the teacher who owns it, else null. */
async function getPaper(paperId, userId) {
  if (!paperId || !userId) return null;
  const { data: paper } = await supabase
    .from('test_papers')
    .select(PAPER_COLUMNS)
    .eq('id', paperId)
    .maybeSingle();
  if (!paper) return null;
  const request = await _ownedRequest(paper.request_id, userId);
  return request ? { paper, request } : null;
}

/** The latest ready version of one request, owner-checked. */
async function latestReady(requestId, userId) {
  const request = await _ownedRequest(requestId, userId);
  if (!request) return null;
  const { data: paper } = await supabase
    .from('test_papers')
    .select(PAPER_COLUMNS)
    .eq('request_id', requestId)
    .eq('status', 'ready')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  return paper ? { paper, request } : null;
}

/**
 * "My papers": the teacher's recent requests, newest first, each shown as its
 * latest READY version. A request whose every attempt failed is left out — it
 * has nothing to re-send.
 */
async function listPapers(userId, limit = LIST_LIMIT) {
  const { data: requests } = await supabase
    .from('test_paper_requests')
    .select('id, source_label, subject, grade, language, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (!requests || !requests.length) return [];

  const { data: papers } = await supabase
    .from('test_papers')
    .select('id, request_id, version, title, question_count, ready_at')
    .in('request_id', requests.map((r) => r.id))
    .eq('status', 'ready');

  const byRequest = new Map();
  for (const p of papers || []) {
    const entry = byRequest.get(p.request_id) || { latest: null, count: 0 };
    entry.count += 1;
    if (!entry.latest || p.version > entry.latest.version) entry.latest = p;
    byRequest.set(p.request_id, entry);
  }

  return requests
    .filter((r) => byRequest.has(r.id))
    .map((r) => {
      const { latest, count } = byRequest.get(r.id);
      return {
        requestId: r.id,
        paperId: latest.id,
        version: latest.version,
        versionCount: count,
        title: latest.title,
        questionCount: latest.question_count,
        sourceLabel: r.source_label,
        subject: r.subject,
        grade: r.grade,
        language: r.language,
        createdAt: r.created_at,
      };
    });
}

module.exports = {
  createRequest, createPaper, markReady, markFailed, setSubject, getPaper, latestReady, listPapers, LIST_LIMIT,
};
