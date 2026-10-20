/**
 * Two small pieces of debrief bookkeeping.
 *
 * 1. COMPLETION. An observation is done when the form is submitted, the
 *    debrief is coached AND the report reached the teacher. Either order can
 *    finish it, so both the debrief and the send step call
 *    maybeCompleteObservation. The flip is guarded on the current status so a
 *    concurrent cancel is never overwritten. Without it, a coach who did every
 *    step counted zero completed observations.
 *
 * 2. THE DEBRIEF RETRY SWEEP. A transcription outage used to strand debriefs:
 *    the queue's blind retries ran out inside the outage and the row sat
 *    pending forever. The worker now re-queues them on a timer; this is the
 *    pure planner that decides which rows qualify.
 */

jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
const { createFakeSupabase } = require('./_helpers/fake-supabase');
const mockDb = createFakeSupabase({ coaching_sessions: [] });
jest.mock('../../bot/shared/config/supabase', () => mockDb.client);

const { shouldComplete, maybeCompleteObservation } = require('../../bot/shared/services/observe/observe-completion');
const {
  selectDebriefsToRetry, classifyTranscriptionFailure, ERROR_CLASS, MAX_ATTEMPTS, MIN_AGE_MINUTES, MAX_AGE_DAYS,
} = require('../../bot/shared/services/observe/debrief-retry-sweep');

describe('observe completion', () => {
  const done = { status: 'observer_review_complete', debrief_status: 'done', teacher_delivery: { status: 'sent' } };

  test('all three conditions are required', () => {
    expect(shouldComplete(done)).toBe(true);
    expect(shouldComplete({ ...done, status: 'analysis_complete' })).toBe(false);
    expect(shouldComplete({ ...done, debrief_status: 'pending' })).toBe(false);
    expect(shouldComplete({ ...done, teacher_delivery: { status: 'awaiting_teacher_tap' } })).toBe(false);
    expect(shouldComplete({ ...done, teacher_delivery: null })).toBe(false);
    expect(shouldComplete(null)).toBe(false);
  });

  test('flips the row to completed when debrief and delivery are both done', async () => {
    mockDb.tables.coaching_sessions.push({
      id: 's1', status: 'observer_review_complete', debrief_status: 'done',
      analysis_data: { teacher_delivery: { status: 'sent' } },
    });
    expect(await maybeCompleteObservation('s1')).toBe(true);
    expect(mockDb.tables.coaching_sessions.find((r) => r.id === 's1').status).toBe('completed');
  });

  test('leaves a row alone when the report has not gone out, and never throws', async () => {
    mockDb.tables.coaching_sessions.push({
      id: 's2', status: 'observer_review_complete', debrief_status: 'done', analysis_data: {},
    });
    expect(await maybeCompleteObservation('s2')).toBe(false);
    expect(mockDb.tables.coaching_sessions.find((r) => r.id === 's2').status).toBe('observer_review_complete');
    expect(await maybeCompleteObservation('missing')).toBe(false);
  });
});

describe('selectDebriefsToRetry', () => {
  const NOW = Date.parse('2026-09-10T12:00:00Z');
  const ago = (min) => new Date(NOW - min * 60000).toISOString();
  const row = (od = {}, over = {}) => ({
    id: 'r', debrief_status: 'pending', created_at: ago(120),
    observer_debrief: { audio_id: 'm1', recorded_at: ago(90), attempts: 1, ...od }, ...over,
  });

  test('defaults: 6 attempts, 30 minutes apart, inside 28 days', () => {
    expect([MAX_ATTEMPTS, MIN_AGE_MINUTES, MAX_AGE_DAYS]).toEqual([6, 30, 28]);
  });

  test('a stuck pending recording with no transcript is retried', () => {
    expect(selectDebriefsToRetry([row()], NOW)).toHaveLength(1);
  });

  test.each([
    ['not pending', row({}, { debrief_status: 'done' })],
    ['no recording', row({ audio_id: null })],
    ['already transcribed', row({ transcript: 'some words' })],
    ['too fresh — a long transcription may still be running', row({ recorded_at: ago(10) })],
    ['failed too recently', row({ failed_at: ago(5) })],
    ['out of attempts', row({ attempts: 6 })],
    ['past the media lifetime', row({ recorded_at: ago(29 * 24 * 60) })],
    ['the media is gone for good', row({ error_class: 'media_gone' })],
  ])('skipped: %s', (_l, r) => {
    expect(selectDebriefsToRetry([r], NOW)).toHaveLength(0);
  });

  test('reads full rows too (analysis_data.observer_debrief), and tallies media-gone refusals', () => {
    const full = { id: 'f', debrief_status: 'pending', created_at: ago(120), analysis_data: { observer_debrief: { audio_id: 'm', recorded_at: ago(60) } } };
    expect(selectDebriefsToRetry([full], NOW)).toHaveLength(1);
    const tally = {};
    selectDebriefsToRetry([row({ error_class: 'media_gone' }), row({ error_class: 'media_gone' })], NOW, {}, tally);
    expect(tally.mediaGone).toBe(2);
  });
});

describe('classifyTranscriptionFailure', () => {
  test('a 400/404 from the media host is permanent', () => {
    const err = { response: { status: 404 }, config: { url: 'https://graph.facebook.com/v19.0/123' } };
    expect(classifyTranscriptionFailure(err)).toBe(ERROR_CLASS.MEDIA_GONE);
  });

  test('the same status from anywhere else — or anything unknown — is transient (fail open)', () => {
    expect(classifyTranscriptionFailure({ response: { status: 400 }, config: { url: 'https://api.transcriber.example/v1' } })).toBe(ERROR_CLASS.TRANSIENT);
    expect(classifyTranscriptionFailure({ response: { status: 500 }, config: { url: 'https://graph.facebook.com/x' } })).toBe(ERROR_CLASS.TRANSIENT);
    expect(classifyTranscriptionFailure(new Error('Request failed with status code 400'))).toBe(ERROR_CLASS.TRANSIENT);
    expect(classifyTranscriptionFailure(null)).toBe(ERROR_CLASS.TRANSIENT);
  });
});
