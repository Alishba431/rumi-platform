'use strict';
/**
 * A stored paper version, delivered: the paper as a PDF, its answer key as a
 * second PDF, then a short follow-up offering an edit.
 *
 * Both PDFs are rendered fresh from the stored `exam_json` every time — on
 * first delivery, on a "my papers" re-send, after an edit — so what arrives is
 * always exactly the stored version and no object storage is needed. Printing
 * uses the repo's html-to-pdf (headless Chromium), which shapes right-to-left
 * scripts properly; the fonts travel inside the HTML.
 *
 * Sends go through the messaging facade only, so the same code delivers on
 * WhatsApp, Matrix (where a worker's sends are relayed through the bot),
 * Slack and Discord. The follow-up uses reply buttons, which every non-Meta
 * channel renders as a numbered menu.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const WhatsAppService = require('../whatsapp.service');
const { logToFile } = require('../../utils/logger');
const Renderer = require('./paper-renderer');
const { t } = require('./testpaper-strings');

/** Printing a long Urdu paper can take a while on a cold browser. */
const PDF_TIMEOUT_MS = 60000;

function _ascii(s, max) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max)
    .replace(/_+$/, '');
}

/**
 * "TestPaper_Math_Numbers_up_to_999_v2.pdf" — ASCII, because not every phone
 * shows other file names. A title in a non-Latin script has no ASCII left, so
 * the source's chapter name stands in (without its leading subject).
 */
function fileNameFor({ subject, title, version, answerKey = false, sourceLabel = '' }) {
  const fromSource = String(sourceLabel || '').replace(/^[^·]*·\s*/, '');
  const name = _ascii(title, 40) || _ascii(fromSource, 40);
  const parts = ['TestPaper', _ascii(Renderer.subjectName(subject), 24) || 'Paper', name].filter(Boolean);
  if (Number(version) > 1) parts.push(`v${Number(version)}`);
  if (answerKey) parts.push('AnswerKey');
  return `${parts.join('_')}.pdf`;
}

function titleOf(paper, request) {
  return paper.title || request.source_label || Renderer.subjectName(request.subject) || 'Test paper';
}

async function _print(html) {
  // eslint-disable-next-line global-require -- Chromium wrapper, loaded only when a paper is printed
  const { htmlToPdf } = require('../../utils/html-to-pdf');
  return htmlToPdf(html, { timeout: PDF_TIMEOUT_MS });
}

/**
 * @param {object} args
 * @param {string} args.to            the facade identifier to send to
 * @param {object} args.paper         a test_papers row (ready)
 * @param {object} args.request       its test_paper_requests row
 * @param {string} [args.chatLanguage] the teacher's chat language, for captions
 * @returns {Promise<boolean>} true when both documents were sent
 */
async function deliverPaper({ to, paper, request, chatLanguage = 'en' }) {
  const title = titleOf(paper, request);
  const common = {
    examJson: paper.exam_json,
    grade: request.grade,
    subject: request.subject,
    language: request.language || 'en',
    chapterTitle: request.source_label && request.source_label !== title ? request.source_label : null,
    version: paper.version,
  };

  let paperPdf;
  let keyPdf;
  try {
    paperPdf = await _print(Renderer.renderPaper(common));
    keyPdf = await _print(Renderer.renderAnswerKey(common));
  } catch (error) {
    // No Chromium on this host is a configuration gap, not a failed paper: the
    // version is stored and a re-send works once the browser is installed.
    logToFile('❌ test paper: PDF printing unavailable', { paperId: paper.id, error: error.message });
    await WhatsAppService.sendMessage(to, t('pdfUnavailable', chatLanguage));
    return false;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testpaper-'));
  const naming = { subject: request.subject, title, version: paper.version, sourceLabel: request.source_label };
  const paperName = fileNameFor(naming);
  const keyName = fileNameFor({ ...naming, answerKey: true });
  const paperPath = path.join(dir, paperName);
  const keyPath = path.join(dir, keyName);

  try {
    fs.writeFileSync(paperPath, paperPdf);
    fs.writeFileSync(keyPath, keyPdf);

    const sentPaper = await WhatsAppService.sendDocument(to, paperPath, paperName,
      t('paperCaption', chatLanguage, { title, version: paper.version }));
    // The version is already stored as ready, so a retried job would skip it:
    // a failed send is told to the teacher, with My papers as the way back.
    if (sentPaper === false) {
      logToFile('❌ test paper: paper document not sent', { paperId: paper.id });
      await WhatsAppService.sendMessage(to, t('sendFailed', chatLanguage));
      return false;
    }
    const sentKey = await WhatsAppService.sendDocument(to, keyPath, keyName, t('keyCaption', chatLanguage, { title }));
    if (sentKey === false) {
      logToFile('❌ test paper: answer key not sent', { paperId: paper.id });
      await WhatsAppService.sendMessage(to, t('sendFailed', chatLanguage));
      return false;
    }

    await WhatsAppService.sendInteractiveButtons(to, {
      body: t('afterDelivery', chatLanguage, { count: paper.question_count, marks: paper.total_marks }),
      buttons: [
        { id: `tp_edit_${paper.id}`, title: t('editButton', chatLanguage) },
        { id: 'tp_new', title: t('newButton', chatLanguage) },
        { id: 'tp_mine', title: t('papersButton', chatLanguage) },
      ],
    });
    logToFile('📝 test paper delivered', { paperId: paper.id, version: paper.version, to });
    return true;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { deliverPaper, fileNameFor, titleOf };
