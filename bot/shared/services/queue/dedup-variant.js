/**
 * The part of a coaching job's dedup identity beyond `${sessionId}-${jobType}`.
 *
 * Most coaching jobs run once per session, so session + type is the whole
 * identity and both drivers dedupe on it. A few run several times per session
 * on purpose — an observation's teacher report is rendered as a preview for
 * the coach and later delivered (payload.phase), and each debrief recording is
 * its own job (payload.dedupNonce). Without this the later job is dropped as a
 * duplicate of the earlier one.
 *
 * Shared by sqs-queue.service.js and bullmq-queue.service.js so the two drivers
 * can never disagree about what counts as "the same job". The result uses only
 * [A-Za-z0-9_-]: BullMQ receipt handles are colon-delimited and SQS dedup ids
 * have a restricted alphabet.
 *
 * @param {object} payload
 * @returns {string} '' when the job has no variant
 */
function dedupVariant(payload = {}) {
  const parts = [payload && payload.phase, payload && payload.dedupNonce]
    .filter((p) => p !== undefined && p !== null && String(p).trim() !== '')
    .map((p) => String(p).replace(/[^A-Za-z0-9_-]/g, '_'));
  return parts.join('-');
}

module.exports = { dedupVariant };
