/**
 * Test Paper Worker
 *
 * Consumes a `testpaper_generate` or `testpaper_revise` job. Each job names
 * ONE test_papers row, already opened in `generating` by the conversation
 * (testpaper-orchestrator.service), whose request carries the source text and
 * the teacher's choices:
 *
 *   generate — write version 1 from the source;
 *   revise   — write the next version from its parent and the teacher's
 *              change request (both stored on the row).
 *
 * Then: store the tree (`ready`), render and send the paper and its answer
 * key, and offer an edit. Any failure marks the row `failed` with a code and
 * tells the teacher in plain words — and a source too thin for a fair paper is
 * told as exactly that, never papered over.
 *
 * Idempotent under at-least-once delivery: a job for a row that is no longer
 * `generating` does nothing. A job queued before the operator switched test
 * papers off (RUMI_FEATURE_TEST_PAPER=off) is closed without a model call.
 * Dispatched from workers/sqs-worker.js.
 */

const WhatsAppService = require('../shared/services/whatsapp.service');
const { logToFile } = require('../shared/utils/logger');
const { FEATURES, isFeatureAvailable } = require('../shared/config/feature-availability');
const Store = require('../shared/services/testpaper/testpaper-store.service');
const Generation = require('../shared/services/testpaper/paper-generation.service');
const Delivery = require('../shared/services/testpaper/testpaper-delivery.service');
const { t } = require('../shared/services/testpaper/testpaper-strings');

function _teacherMessage(error, request, chatLanguage) {
  switch (error.code) {
    case 'INSUFFICIENT_SOURCE':
      return t('insufficient', chatLanguage, { what: request.source_label || 'that material', reason: error.reason });
    case 'TRUNCATED':
      return t('failedTooLong', chatLanguage);
    default:
      return t('failed', chatLanguage);
  }
}

async function _generate(paper, request) {
  return Generation.generateExam({
    grade: request.grade,
    subject: request.subject,
    language: request.language,
    sourceText: request.source_text,
    sourceLabel: request.source_label,
    contentSource: request.content_source,
    questionTypes: request.question_types || [],
    questionCount: request.question_count,
    totalMarks: request.total_marks,
  });
}

async function _revise(paper, request, userId) {
  const parent = paper.edited_from ? await Store.getPaper(paper.edited_from, userId) : null;
  if (!parent || parent.paper.status !== 'ready') {
    const err = new Error('the version this edit starts from is not available');
    err.code = 'NO_PARENT';
    throw err;
  }
  return Generation.revisePaper({
    examJson: parent.paper.exam_json,
    instruction: paper.edit_instruction,
    sourceText: request.source_text,
    sourceLabel: request.source_label,
    grade: request.grade,
    subject: request.subject,
    language: request.language,
  });
}

/**
 * @param {object} job
 * @param {'generate'|'revise'} job.action
 * @param {string} job.paperId
 * @param {string} job.userId
 * @param {string} job.to            facade identifier to deliver to
 * @param {string} [job.chatLanguage]
 */
async function run(job) {
  const { action = 'generate', paperId, userId, to, chatLanguage = 'en' } = job || {};
  const found = await Store.getPaper(paperId, userId);
  if (!found) {
    logToFile('⚠️ test paper job: paper not found for this teacher — skipped', { paperId, userId });
    return { skipped: 'not_found' };
  }
  const { paper } = found;
  let { request } = found;
  if (paper.status !== 'generating') {
    logToFile('⏭️ test paper job: already handled', { paperId, status: paper.status });
    return { skipped: paper.status };
  }
  if (!isFeatureAvailable(FEATURES.find((f) => f.id === 'test_paper'))) {
    await Store.markFailed(paperId, 'SWITCHED_OFF', 'test papers were switched off before this job ran');
    logToFile('⏭️ test paper job: feature switched off — not run', { paperId, action });
    await WhatsAppService.sendMessage(to, t('notReady', chatLanguage));
    return { skipped: 'switched_off' };
  }

  let result;
  try {
    result = action === 'revise' ? await _revise(paper, request, userId) : await _generate(paper, request);
  } catch (error) {
    await Store.markFailed(paperId, error.code || 'UNKNOWN', error.cause || error.message);
    logToFile('❌ test paper job failed', { paperId, action, code: error.code, error: error.message });
    await WhatsAppService.sendMessage(to, _teacherMessage(error, request, chatLanguage));
    return { failed: error.code || 'UNKNOWN' };
  }

  if (action === 'revise' && result.changed === false) {
    // Keeping an identical "version 2" would only make "my papers" lie about
    // what changed. The parent stays the latest version.
    await Store.markFailed(paperId, 'UNCHANGED', result.note);
    await WhatsAppService.sendMessage(to, t('editUnchanged', chatLanguage, { note: result.note }));
    return { unchanged: true };
  }

  if (!request.subject && result.subject) {
    await Store.setSubject(request.id, result.subject);
    request = { ...request, subject: result.subject };
  }

  const totalMarks = Generation.totalMarksOf(result.examJson);
  await Store.markReady(paperId, {
    title: result.title,
    examJson: result.examJson,
    questionCount: result.questionCount,
    totalMarks,
    tokenData: result.tokenData,
  });

  const ready = { ...paper, status: 'ready', title: result.title, exam_json: result.examJson,
    question_count: result.questionCount, total_marks: totalMarks };
  const delivered = await Delivery.deliverPaper({ to, paper: ready, request, chatLanguage });
  return { ready: true, delivered };
}

module.exports = { process: run };
