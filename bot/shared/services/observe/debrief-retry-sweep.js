/**
 * Self-heal for debrief recordings whose transcription failed.
 *
 * WHY: during a transcription-provider outage, a debrief job with no catch
 * around transcription threw, the queue retried it a few times within minutes
 * — all inside the outage — and dead-lettered it. The row stayed
 * debrief_status='pending' with an audio id and no transcript, the coach had
 * only heard "feedback in a few minutes", and nothing ever retried.
 *
 * This module is the PURE half: given the narrow projection the worker pulls,
 * decide which rows get re-queued. The worker (sqs-worker.js
 * runDebriefRetrySweep) owns the DB read, the per-row Redis lock, the queue
 * call and the log line. processDebriefRecording is idempotent under a
 * re-queue: it reads the audio id from the row, skips re-transcription when a
 * transcript is stored, and only delivers when feedback is stored.
 *
 * Rules (each one is an assertion in the test):
 *   pending only          debrief_status is a closed vocabulary the /observe
 *                         list reads — the sweep never changes it
 *   has audio_id          "later" with no recording is not a failure
 *   no transcript         transcription already succeeded → not this lane
 *   old enough            minAgeMinutes since recorded_at AND since the last
 *                         failed_at — a long transcription may still be live
 *   attempts < max        a provider outage longer than max × the tick is a
 *                         human's problem
 *   inside the ceiling    channel media ids expire (about 30 days on the
 *                         Cloud API); 28 leaves margin
 *   recoverable failure   a recording whose media id is DEAD can never come
 *                         back, however many attempts are left
 */

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

const MAX_ATTEMPTS = 6;
const MIN_AGE_MINUTES = 30;
const MAX_AGE_DAYS = 28;

/** The two classes. `transient` is the fail-open default — see below. */
const ERROR_CLASS = { MEDIA_GONE: 'media_gone', TRANSIENT: 'transient' };

/**
 * The hosts the WhatsApp Cloud API serves media from: the Graph node that
 * resolves a media id, and the CDN hosts that serve the bytes. A 400/404 from
 * one of these means the media id is dead, which is permanent; a 400 from
 * anywhere else — most often the transcription provider rejecting a
 * container — is not. Other channels hand over the bytes at receipt, so they
 * never produce this class.
 */
const MEDIA_HOST_RE = /(^|\.)(graph\.facebook\.com|lookaside\.fbsbx\.com|mmg\.whatsapp\.net|scontent\.whatsapp\.net)$/i;
const PERMANENT_MEDIA_STATUSES = new Set([400, 404]);

function _hostOf(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    return new URL(url).hostname;
  } catch (_) {
    return null;
  }
}

/**
 * Which class of failure this transcription-stage error is.
 *
 * Reads the failing REQUEST, never the message text: the text for a dead media
 * id and for a provider rejecting a mislabelled container is the same string
 * ("Request failed with status code 400"), and only one of the two is
 * permanent.
 *
 * Fail-open: anything unrecognised is `transient`. Mis-reading a retryable
 * failure as permanent loses a debrief for good; the other direction costs one
 * more attempt.
 *
 * @param {Error|any} err
 * @returns {'media_gone'|'transient'}
 */
function classifyTranscriptionFailure(err) {
  if (!err || typeof err !== 'object') return ERROR_CLASS.TRANSIENT;
  const response = err.response;
  const status = Number(response && response.status);
  if (!PERMANENT_MEDIA_STATUSES.has(status)) return ERROR_CLASS.TRANSIENT;

  const url = (err.config && err.config.url)
    || (response && response.config && response.config.url)
    || err.url;
  const host = _hostOf(url);
  if (!host || !MEDIA_HOST_RE.test(host)) return ERROR_CLASS.TRANSIENT;
  return ERROR_CLASS.MEDIA_GONE;
}

function _debriefOf(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.observer_debrief && typeof row.observer_debrief === 'object') return row.observer_debrief;
  if (row.analysis_data && row.analysis_data.observer_debrief
      && typeof row.analysis_data.observer_debrief === 'object') {
    return row.analysis_data.observer_debrief;
  }
  return null;
}

function _ms(iso) {
  const t = Date.parse(iso || '');
  return Number.isNaN(t) ? null : t;
}

/**
 * @param {Array<object>} rows  coaching_sessions rows — either the worker's
 *   narrow projection ({id, debrief_status, created_at, observer_debrief}) or
 *   full rows carrying analysis_data.observer_debrief
 * @param {number} nowMs
 * @param {{minAgeMinutes?: number, maxAttempts?: number, maxAgeDays?: number}} opts
 * @param {object} [tally]  optional counters (why rows were refused), mutated
 *   in place so a tick can say what it skipped instead of a bare zero
 * @returns {Array<object>} the rows to re-queue, input order preserved
 */
function selectDebriefsToRetry(rows, nowMs = Date.now(), opts = {}, tally = {}) {
  const minAgeMinutes = Number.isFinite(opts.minAgeMinutes) ? opts.minAgeMinutes : MIN_AGE_MINUTES;
  const maxAttempts = Number.isFinite(opts.maxAttempts) ? opts.maxAttempts : MAX_ATTEMPTS;
  const maxAgeDays = Number.isFinite(opts.maxAgeDays) ? opts.maxAgeDays : MAX_AGE_DAYS;

  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.debrief_status !== 'pending') continue;
    const od = _debriefOf(row);
    if (!od || !od.audio_id) continue;
    if (od.transcript) continue;
    if (od.error_class === ERROR_CLASS.MEDIA_GONE) {
      tally.mediaGone = (Number(tally.mediaGone) || 0) + 1;
      continue;
    }
    if ((Number(od.attempts) || 0) >= maxAttempts) continue;

    const recorded = _ms(od.recorded_at) ?? _ms(row.created_at);
    if (recorded === null) continue;
    if (nowMs - recorded > maxAgeDays * DAY) continue;

    const lastActivity = Math.max(recorded, _ms(od.failed_at) ?? 0);
    if (nowMs - lastActivity < minAgeMinutes * MINUTE) continue;

    out.push(row);
  }
  return out;
}

module.exports = {
  selectDebriefsToRetry,
  classifyTranscriptionFailure,
  ERROR_CLASS,
  MAX_ATTEMPTS,
  MIN_AGE_MINUTES,
  MAX_AGE_DAYS,
};
